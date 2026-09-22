import type { Db } from '../db/prisma.js';
import { JobStatus, type Job, type JobType } from '../generated/prisma/client.js';
import type { JobPayload } from './types.js';

/** Thrown when the video already has a PENDING or RUNNING job: at most one active job per video, always. */
export class ActiveJobConflictError extends Error {
  constructor(
    readonly videoId: string,
    readonly activeJobId: string,
    readonly activeType: JobType,
  ) {
    super(`Video ${videoId} already has an active ${activeType} job (${activeJobId})`);
    this.name = 'ActiveJobConflictError';
  }
}

/**
 * Creates a PENDING job. Pass a transaction client to create it atomically with
 * other writes: the check below then runs under SQLite's write lock, so two
 * jobs can never be active for the same video. The project status is the
 * user-facing lock; this is the safety net behind it (a stuck job that was
 * reset by hand, a future bug) so two workers never render the same video.
 */
export async function createJob(db: Db, type: JobType, payload: JobPayload): Promise<Job> {
  const active = await db.job.findFirst({
    where: { videoId: payload.videoId, status: { in: [JobStatus.PENDING, JobStatus.RUNNING] } },
    select: { id: true, type: true },
  });
  if (active) {
    throw new ActiveJobConflictError(payload.videoId, active.id, active.type);
  }
  return db.job.create({
    data: {
      projectId: payload.projectId,
      videoId: payload.videoId,
      type,
      status: JobStatus.PENDING,
      payloadJson: JSON.stringify(payload),
    },
  });
}
