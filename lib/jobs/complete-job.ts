import { getPrisma } from '../db/prisma.js';
import {
  JobStatus,
  ProjectStatus,
  VideoStatus,
  type Job,
} from '../generated/prisma/client.js';
import { createJob } from './create-job.js';
import { nextJobType, type ClaimedJob, type JobPayload } from './types.js';

/** Video columns a stage result changes (RENDER: the promoted file), written with the job completion. */
export interface CompletedVideoUpdate {
  outputPath: string;
}

/**
 * Marks a RUNNING job COMPLETED, stores its result and, in the same
 * transaction, applies `videoUpdate` to the video and either enqueues the next
 * pipeline job or (after the last stage) marks the video and project
 * COMPLETED. Nothing is written when the job is no longer RUNNING (cancelled
 * through the API or recovered by another worker): the result is discarded.
 *
 * Returns the newly created next job, or null when the pipeline finished.
 */
export async function completeJob(
  job: ClaimedJob,
  payload: JobPayload,
  result: unknown,
  videoUpdate?: CompletedVideoUpdate,
): Promise<Job | null> {
  return getPrisma().$transaction(async (tx) => {
    const { count } = await tx.job.updateMany({
      where: { id: job.id, status: JobStatus.RUNNING },
      data: {
        status: JobStatus.COMPLETED,
        resultJson: JSON.stringify(result ?? null),
        completedAt: new Date(),
        error: null,
      },
    });
    if (count === 0) {
      throw new Error(`Job ${job.id} is no longer RUNNING (cancelled or recovered elsewhere); result discarded.`);
    }

    const next = nextJobType(job.type);
    if (next) {
      if (videoUpdate) {
        await tx.video.update({ where: { id: payload.videoId }, data: videoUpdate });
      }
      return createJob(tx, next, payload);
    }

    await tx.video.update({
      where: { id: payload.videoId },
      data: { ...videoUpdate, status: VideoStatus.COMPLETED },
    });
    await tx.project.update({
      where: { id: payload.projectId },
      data: { status: ProjectStatus.COMPLETED },
    });
    return null;
  });
}
