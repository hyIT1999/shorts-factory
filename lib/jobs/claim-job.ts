import { getPrisma } from '../db/prisma.js';
import { JobStatus, ProjectStatus, VideoStatus } from '../generated/prisma/client.js';
import type { ClaimedJob } from './types.js';

const CANDIDATE_BATCH = 5;

/**
 * Claims the oldest PENDING job, or returns null when there is none.
 *
 * Safe with several worker processes: the PENDING -> RUNNING transition is a
 * conditional UPDATE (`WHERE id = ? AND status = 'PENDING'`). SQLite serializes
 * writes, so exactly one worker sees `count === 1` for a given job; the others
 * see 0 and move on to the next candidate.
 *
 * The claim records the worker (`workerId`) and a first heartbeat, which the
 * worker keeps refreshing while it processes the job (lib/jobs/heartbeat.ts).
 */
export async function claimNextJob(workerId?: string): Promise<ClaimedJob | null> {
  const prisma = getPrisma();

  const candidates = await prisma.job.findMany({
    where: { status: JobStatus.PENDING },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: CANDIDATE_BATCH,
    select: { id: true },
  });

  for (const { id } of candidates) {
    const claimed = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const { count } = await tx.job.updateMany({
        where: { id, status: JobStatus.PENDING },
        data: {
          status: JobStatus.RUNNING,
          startedAt: now,
          heartbeatAt: now,
          workerId: workerId ?? null,
          attempts: { increment: 1 },
        },
      });
      if (count === 0) {
        return null; // Another worker won this job.
      }

      const job = await tx.job.findUniqueOrThrow({ where: { id } });

      // First job of a generation: move the pipeline from QUEUED to PROCESSING.
      if (job.videoId) {
        await tx.video.updateMany({
          where: { id: job.videoId, status: VideoStatus.QUEUED },
          data: { status: VideoStatus.PROCESSING },
        });
      }
      await tx.project.updateMany({
        where: { id: job.projectId, status: ProjectStatus.QUEUED },
        data: { status: ProjectStatus.PROCESSING },
      });

      return job;
    });

    if (claimed) {
      return claimed;
    }
  }

  return null;
}
