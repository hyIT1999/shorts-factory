import { getPrisma } from '../db/prisma.js';
import { JobStatus, ProjectStatus, VideoStatus } from '../generated/prisma/client.js';
import type { ClaimedJob } from './types.js';

const MAX_ERROR_LENGTH = 1000;

/**
 * Marks a RUNNING job FAILED and stops its pipeline: the related video and
 * project become FAILED and no next job is created.
 *
 * Returns false, and changes nothing, when the job is no longer RUNNING: it
 * was cancelled through the API, recovered by another worker, or deleted with
 * its project while this worker was busy with it.
 */
export async function failJob(job: ClaimedJob, message: string): Promise<boolean> {
  return getPrisma().$transaction(async (tx) => {
    const { count } = await tx.job.updateMany({
      where: { id: job.id, status: JobStatus.RUNNING },
      data: {
        status: JobStatus.FAILED,
        error: message.slice(0, MAX_ERROR_LENGTH),
        completedAt: new Date(),
      },
    });
    if (count === 0) {
      return false;
    }
    if (job.videoId) {
      await tx.video.updateMany({
        where: { id: job.videoId },
        data: { status: VideoStatus.FAILED },
      });
    }
    await tx.project.updateMany({
      where: { id: job.projectId },
      data: { status: ProjectStatus.FAILED },
    });
    return true;
  });
}
