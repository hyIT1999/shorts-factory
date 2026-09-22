import { getPrisma } from '../db/prisma.js';
import { JobStatus } from '../generated/prisma/client.js';
import type { ClaimedJob } from './types.js';

/**
 * Puts this worker's RUNNING job back to PENDING because the worker is
 * shutting down (not because the job failed): the claim is undone, including
 * its attempt, so another worker (or this one after a restart) resumes the
 * pipeline. Returns false when the job was no longer ours to give back.
 */
export async function requeueJob(job: ClaimedJob, reason: string, workerId?: string): Promise<boolean> {
  const { count } = await getPrisma().job.updateMany({
    where: { id: job.id, status: JobStatus.RUNNING, ...(workerId ? { workerId } : {}) },
    data: {
      status: JobStatus.PENDING,
      workerId: null,
      heartbeatAt: null,
      attempts: { decrement: 1 },
      error: `Requeued: ${reason}`,
    },
  });
  return count === 1;
}
