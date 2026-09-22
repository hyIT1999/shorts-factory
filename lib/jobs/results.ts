import { getPrisma, type Db } from '../db/prisma.js';
import { JobStatus, type JobType } from '../generated/prisma/client.js';

/**
 * Returns the parsed resultJson of the most recent COMPLETED job of `type` for
 * a video, or null when there is none. Callers validate it with a Zod schema.
 */
export async function getCompletedJobResult(
  videoId: string,
  type: JobType,
  db: Db = getPrisma(),
): Promise<unknown> {
  const job = await db.job.findFirst({
    where: { videoId, type, status: JobStatus.COMPLETED },
    orderBy: { completedAt: 'desc' },
    select: { resultJson: true },
  });
  if (!job?.resultJson) {
    return null;
  }
  try {
    return JSON.parse(job.resultJson) as unknown;
  } catch {
    return null;
  }
}
