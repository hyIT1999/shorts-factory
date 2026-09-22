import { z } from 'zod';
import { ResearchSchema, type Research } from '../../lib/ai/schemas/research.js';
import { ScriptSchema } from '../../lib/ai/schemas/script.js';
import { projectDirs, type LocalAssetStorage } from '../../lib/assets/storage.js';
import { getPrisma } from '../../lib/db/prisma.js';
import { ProjectStatus, VideoStatus, JobType } from '../../lib/generated/prisma/client.js';
import { createJob } from '../../lib/jobs/create-job.js';
import { getCompletedJobResult } from '../../lib/jobs/results.js';
import { ApiError } from '../http/errors.js';

const projectSummarySelect = {
  id: true,
  title: true,
  topic: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

const jobSummarySelect = {
  id: true,
  videoId: true,
  type: true,
  status: true,
  attempts: true,
  error: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
} as const;

export const ACTIVE_STATUSES: ProjectStatus[] = [ProjectStatus.QUEUED, ProjectStatus.PROCESSING];

function projectNotFound(): ApiError {
  return new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found');
}

export function createProject(input: { title: string; topic: string }) {
  return getPrisma().project.create({
    data: { title: input.title, topic: input.topic, status: ProjectStatus.DRAFT },
    select: projectSummarySelect,
  });
}

export function listProjects() {
  return getPrisma().project.findMany({
    orderBy: { createdAt: 'desc' },
    select: projectSummarySelect,
  });
}

export async function getProjectDetail(id: string) {
  const project = await getPrisma().project.findUnique({
    where: { id },
    select: {
      ...projectSummarySelect,
      videos: {
        orderBy: { version: 'desc' },
        select: {
          id: true,
          version: true,
          status: true,
          title: true,
          description: true,
          duration: true,
          outputPath: true,
          createdAt: true,
          updatedAt: true,
          scriptJson: true,
          scenes: {
            orderBy: { index: 'asc' },
            select: {
              id: true,
              index: true,
              text: true,
              duration: true,
              visualPrompt: true,
              visualType: true,
              startTime: true,
              endTime: true,
              subtitleEmphasisJson: true,
              selectedAsset: { select: { provider: true, status: true, metadataJson: true } },
            },
          },
        },
      },
      jobs: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: jobSummarySelect,
      },
    },
  });
  if (!project) {
    throw projectNotFound();
  }

  const researchByVideo = new Map<string, Research>();
  for (const video of project.videos) {
    const research = ResearchSchema.safeParse(await getCompletedJobResult(video.id, JobType.RESEARCH));
    if (research.success) {
      researchByVideo.set(video.id, research.data);
    }
  }

  // Expose validated, parsed results only — never raw JSON columns.
  return {
    ...project,
    videos: project.videos.map(({ scriptJson, scenes, ...video }) => ({
      ...video,
      research: researchByVideo.get(video.id) ?? null,
      script: parseJson(scriptJson, ScriptSchema),
      scenes: scenes.map(({ subtitleEmphasisJson, selectedAsset, ...scene }) => ({
        ...scene,
        subtitleEmphasis: parseJson(subtitleEmphasisJson, emphasisSchema) ?? [],
        visual: sceneVisual(selectedAsset),
      })),
    })),
  };
}

const emphasisSchema = z.array(z.string());
const visualMetadataSchema = z.looseObject({
  fallback: z.boolean().optional(),
  attribution: z.string().optional(),
  pageUrl: z.string().optional(),
});

export interface SceneVisual {
  provider: string;
  /** True when the primary provider had nothing and a placeholder image is used. */
  fallback: boolean;
  /** Credit line required by stock providers ("Photo by … on Pexels"), null for generated images. */
  credit: string | null;
  /** Public page of the photo (https only), null when there is none. */
  creditUrl: string | null;
}

/** What the UI shows about a scene's selected image; never the raw metadata or local paths. */
function sceneVisual(asset: { provider: string; status: string; metadataJson: string | null } | null): SceneVisual | null {
  if (!asset || asset.status !== 'READY') {
    return null;
  }
  const metadata = parseJson(asset.metadataJson, visualMetadataSchema);
  const pageUrl = metadata?.pageUrl;
  return {
    provider: asset.provider,
    fallback: metadata?.fallback === true,
    credit: metadata?.attribution ?? null,
    creditUrl: pageUrl && /^https:\/\//i.test(pageUrl) ? pageUrl : null,
  };
}

function parseJson<T>(json: string | null, schema: z.ZodType<T>): T | null {
  if (!json) {
    return null;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface DeleteProjectResult {
  deleted: true;
  id: string;
  /** false when a directory could not be removed (it is logged; `npm run data:sweep` picks it up). */
  filesRemoved: boolean;
}

/**
 * Deletes a project: its database records (cascade) and then its files under
 * assets/, audio/, renders/ and tmp/render/. A project whose pipeline is
 * QUEUED or PROCESSING is refused (409): abort the job or wait, otherwise the
 * worker would keep writing files for a project that no longer exists.
 */
export async function deleteProject(id: string, storage: LocalAssetStorage): Promise<DeleteProjectResult> {
  let dirs: string[];
  try {
    dirs = projectDirs(id);
  } catch {
    throw projectNotFound(); // Ids are cuids; anything else cannot be a project.
  }
  const prisma = getPrisma();
  const { count } = await prisma.project.deleteMany({ where: { id, status: { notIn: ACTIVE_STATUSES } } });
  if (count === 0) {
    const existing = await prisma.project.findUnique({ where: { id }, select: { status: true } });
    if (!existing) {
      throw projectNotFound();
    }
    throw new ApiError(409, 'PROJECT_ACTIVE', 'The project has a pipeline running; abort it or wait for it to finish before deleting.');
  }
  let filesRemoved = true;
  for (const dir of dirs) {
    try {
      await storage.removeDir(dir);
    } catch (error) {
      filesRemoved = false;
      console.warn(`Could not remove ${dir} of deleted project ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { deleted: true, id, filesRemoved };
}

/**
 * Starts a generation pipeline: creates the next Video version and the first
 * RESEARCH job. Does not run the pipeline — the worker picks the job up.
 */
export function startGeneration(projectId: string) {
  return getPrisma().$transaction(async (tx) => {
    // Compare-and-set: only one request can move the project into QUEUED.
    // The write comes first on purpose: a SQLite transaction that reads before
    // writing can fail with SQLITE_BUSY when a worker commits in between.
    const { count } = await tx.project.updateMany({
      where: { id: projectId, status: { notIn: ACTIVE_STATUSES } },
      data: { status: ProjectStatus.QUEUED },
    });
    if (count === 0) {
      const exists = await tx.project.count({ where: { id: projectId } });
      if (exists === 0) {
        throw projectNotFound();
      }
      throw new ApiError(
        409,
        'GENERATION_ALREADY_ACTIVE',
        'A generation pipeline is already active for this project.',
      );
    }

    const project = await tx.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { title: true, topic: true },
    });

    const latest = await tx.video.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const video = await tx.video.create({
      data: {
        projectId,
        version: (latest?.version ?? 0) + 1,
        status: VideoStatus.QUEUED,
        title: project.title,
      },
      select: { id: true },
    });

    const job = await createJob(tx, JobType.RESEARCH, {
      projectId,
      videoId: video.id,
      topic: project.topic,
      title: project.title,
    });

    return { projectId, videoId: video.id, jobId: job.id, status: ProjectStatus.QUEUED };
  });
}
