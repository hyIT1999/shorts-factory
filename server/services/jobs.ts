import { getPrisma } from '../../lib/db/prisma.js';
import { JobStatus, ProjectStatus, VideoStatus } from '../../lib/generated/prisma/client.js';
import { ApiError } from '../http/errors.js';

/** Public job fields. payloadJson/resultJson/workerId are intentionally not exposed. */
const jobSummarySelect = {
  id: true,
  type: true,
  status: true,
  attempts: true,
  error: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
} as const;

function jobNotFound(): ApiError {
  return new ApiError(404, 'JOB_NOT_FOUND', 'Job not found');
}

/** Public job status. */
export async function getJob(id: string) {
  const job = await getPrisma().job.findUnique({ where: { id }, select: jobSummarySelect });
  if (!job) {
    throw jobNotFound();
  }
  return job;
}

/**
 * Cancels a PENDING or RUNNING job and stops its pipeline: the job becomes
 * CANCELLED, its video and project FAILED, so the stage can be re-run or the
 * project generated again. A RUNNING job's worker notices at its next
 * heartbeat, kills its external processes (ffmpeg) and discards the result.
 * Nothing changes for a job that already ended (409).
 */
export async function abortJob(id: string) {
  return getPrisma().$transaction(async (tx) => {
    const { count } = await tx.job.updateMany({
      where: { id, status: { in: [JobStatus.PENDING, JobStatus.RUNNING] } },
      data: { status: JobStatus.CANCELLED, completedAt: new Date(), error: 'Cancelled through the API' },
    });
    if (count === 0) {
      const existing = await tx.job.findUnique({ where: { id }, select: { status: true } });
      if (!existing) {
        throw jobNotFound();
      }
      throw new ApiError(409, 'JOB_NOT_ACTIVE', `Job is ${existing.status} and cannot be cancelled.`);
    }
    const job = await tx.job.findUniqueOrThrow({ where: { id }, select: { ...jobSummarySelect, projectId: true, videoId: true } });
    if (job.videoId) {
      await tx.video.updateMany({ where: { id: job.videoId }, data: { status: VideoStatus.FAILED } });
    }
    await tx.project.updateMany({ where: { id: job.projectId }, data: { status: ProjectStatus.FAILED } });
    return tx.job.findUniqueOrThrow({ where: { id }, select: jobSummarySelect });
  });
}
