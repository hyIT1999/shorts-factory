/**
 * Recovery of jobs left RUNNING by a worker that died (crash, out of memory,
 * kill -9, reboot). A job counts as abandoned once nothing has refreshed its
 * heartbeat for `staleMs` (jobs claimed before heartbeats existed are judged
 * by startedAt). Such a job goes back to PENDING while it has attempts left,
 * so an unattended pipeline resumes on its own after a restart; otherwise it
 * fails like any other job, which also fails its video and project so they
 * can be re-run or re-generated instead of staying PROCESSING forever.
 *
 * Every transition is a conditional update that repeats the stale check, so a
 * worker that is merely slow (its heartbeat arrives in between) keeps its job.
 */
import { getPrisma } from '../db/prisma.js';
import { JobStatus, ProjectStatus, VideoStatus, type JobType, type Prisma } from '../generated/prisma/client.js';
import type { JobLogger } from './types.js';

/** A job is given up after this many claims (the crash may be caused by the job itself). */
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface RecoveryOptions {
  /** A RUNNING job without a heartbeat for this long is abandoned. */
  staleMs: number;
  maxAttempts?: number;
  now?: Date;
  log?: JobLogger;
}

export interface RecoveredJob {
  id: string;
  type: JobType;
  projectId: string;
  videoId: string | null;
  attempts: number;
  workerId: string | null;
  outcome: 'requeued' | 'failed';
}

function staleCondition(threshold: Date): Prisma.JobWhereInput {
  return {
    status: JobStatus.RUNNING,
    OR: [
      { heartbeatAt: { lt: threshold } },
      { heartbeatAt: null, startedAt: { lt: threshold } },
      { heartbeatAt: null, startedAt: null, createdAt: { lt: threshold } },
    ],
  };
}

export async function recoverAbandonedJobs(options: RecoveryOptions): Promise<RecoveredJob[]> {
  const prisma = getPrisma();
  const now = options.now ?? new Date();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const stale = staleCondition(new Date(now.getTime() - options.staleMs));

  const candidates = await prisma.job.findMany({
    where: stale,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, type: true, projectId: true, videoId: true, attempts: true, workerId: true },
  });

  const recovered: RecoveredJob[] = [];
  for (const job of candidates) {
    const worker = job.workerId ?? 'an unknown worker';
    const outcome: RecoveredJob['outcome'] = job.attempts < maxAttempts ? 'requeued' : 'failed';
    const done = await prisma.$transaction(async (tx) => {
      const { count } = await tx.job.updateMany({
        where: { id: job.id, ...stale },
        data:
          outcome === 'requeued'
            ? {
                status: JobStatus.PENDING,
                workerId: null,
                heartbeatAt: null,
                error: `Requeued after ${worker} stopped responding (attempt ${job.attempts} of ${maxAttempts})`,
              }
            : {
                status: JobStatus.FAILED,
                completedAt: now,
                error: `${worker} stopped responding; giving up after ${job.attempts} attempts`,
              },
      });
      if (count === 0) {
        return false; // The worker came back (or someone else recovered it first).
      }
      if (outcome === 'failed') {
        if (job.videoId) {
          await tx.video.updateMany({ where: { id: job.videoId }, data: { status: VideoStatus.FAILED } });
        }
        await tx.project.updateMany({ where: { id: job.projectId }, data: { status: ProjectStatus.FAILED } });
      }
      return true;
    });
    if (!done) {
      continue;
    }
    recovered.push({ ...job, outcome });
    options.log?.(
      outcome === 'requeued'
        ? `Recovered job ${job.id} [${job.type}] abandoned by ${worker}: back to PENDING (attempt ${job.attempts} of ${maxAttempts})`
        : `Recovered job ${job.id} [${job.type}] abandoned by ${worker}: FAILED after ${job.attempts} attempts`,
    );
  }
  return recovered;
}
