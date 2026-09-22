import { stat } from 'node:fs/promises';
import type { LocalAssetStorage } from '../../lib/assets/storage.js';
import { getPrisma } from '../../lib/db/prisma.js';
import { JobStatus, JobType, ProjectStatus, VideoStatus } from '../../lib/generated/prisma/client.js';
import { createJob } from '../../lib/jobs/create-job.js';
import { ApiError } from '../http/errors.js';
import { ACTIVE_STATUSES } from './projects.js';

/**
 * Stages that can be re-run on their own. They rebuild their output from what
 * earlier stages left in the database and never call the script/scene AI:
 * ASSETS replaces the visuals, VOICE re-uses cached narration and only
 * synthesizes scenes whose text or voice settings changed, SUBTITLES and
 * RENDER are deterministic.
 */
export const RERUN_STAGES = ['ASSETS', 'VOICE', 'SUBTITLES', 'RENDER'] as const;
export type RerunStage = (typeof RERUN_STAGES)[number];

/** The stage whose completed result a re-run reads. */
const PREREQUISITE: Record<RerunStage, JobType> = {
  ASSETS: JobType.SCENES,
  VOICE: JobType.ASSETS,
  SUBTITLES: JobType.VOICE,
  RENDER: JobType.SUBTITLES,
};

function videoNotFound(): ApiError {
  return new ApiError(404, 'VIDEO_NOT_FOUND', 'Video not found');
}

/**
 * Re-queues a stage for the latest video of a project, e.g. after VOICE hit a
 * rate limit or RENDER failed (FFmpeg missing, file locked…). Earlier stages
 * are not re-run: their results in the database are reused. The pipeline then
 * continues from that stage as usual and ends COMPLETED or FAILED.
 */
export async function rerunStage(videoId: string, stage: RerunStage) {
  const prisma = getPrisma();
  const video = await prisma.video.findUnique({ where: { id: videoId }, select: { projectId: true } });
  if (!video) {
    throw videoNotFound();
  }
  const { projectId } = video;

  return prisma.$transaction(async (tx) => {
    // Compare-and-set first (as in startGeneration): only one request can queue work.
    const { count } = await tx.project.updateMany({
      where: { id: projectId, status: { notIn: ACTIVE_STATUSES } },
      data: { status: ProjectStatus.QUEUED },
    });
    if (count === 0) {
      throw new ApiError(409, 'GENERATION_ALREADY_ACTIVE', 'A generation pipeline is already active for this project.');
    }
    const latest = await tx.video.findFirst({ where: { projectId }, orderBy: { version: 'desc' }, select: { id: true } });
    if (latest?.id !== videoId) {
      throw new ApiError(409, 'NOT_LATEST_VIDEO', 'Only the latest video of a project can be re-run.');
    }
    const prerequisite = PREREQUISITE[stage];
    const ready = await tx.job.count({ where: { videoId, type: prerequisite, status: JobStatus.COMPLETED } });
    if (ready === 0) {
      throw new ApiError(409, 'STAGE_NOT_READY', `${prerequisite} must be completed before ${stage} can run again.`);
    }

    await tx.video.update({ where: { id: videoId }, data: { status: VideoStatus.QUEUED } });
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { title: true, topic: true } });
    const job = await createJob(tx, JobType[stage], { projectId, videoId, topic: project.topic, title: project.title });
    return { projectId, videoId, jobId: job.id, stage, status: ProjectStatus.QUEUED };
  });
}

export interface VideoOutput {
  /** Absolute path inside the storage root (validated by LocalAssetStorage). */
  absolutePath: string;
  /** Built from ids only: "<projectId>-v<version>.mp4". */
  filename: string;
  sizeBytes: number;
}

/** The rendered file of a video, or a 404 that says why there is none. */
export async function getVideoOutput(videoId: string, storage: LocalAssetStorage): Promise<VideoOutput> {
  const video = await getPrisma().video.findUnique({
    where: { id: videoId },
    select: { projectId: true, version: true, outputPath: true },
  });
  if (!video) {
    throw videoNotFound();
  }
  if (!video.outputPath) {
    throw new ApiError(404, 'OUTPUT_NOT_READY', 'This video has not been rendered yet.');
  }
  let absolutePath: string;
  try {
    absolutePath = storage.resolve(video.outputPath);
  } catch {
    throw new ApiError(404, 'OUTPUT_MISSING', 'The rendered video path is invalid; re-run RENDER.');
  }
  const info = await stat(absolutePath).catch(() => null);
  if (!info?.isFile()) {
    throw new ApiError(404, 'OUTPUT_MISSING', 'The rendered video file is missing; re-run RENDER.');
  }
  return { absolutePath, filename: `${video.projectId}-v${video.version}.mp4`, sizeBytes: info.size };
}
