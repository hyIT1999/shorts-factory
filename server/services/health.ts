import { statfs } from 'node:fs/promises';
import type { LocalAssetStorage } from '../../lib/assets/storage.js';
import { getPrisma } from '../../lib/db/prisma.js';
import { JobStatus } from '../../lib/generated/prisma/client.js';
import { DEFAULT_STALE_MS } from '../../lib/jobs/heartbeat.js';
import { listWorkerPresence, WORKER_PRESENCE_STALE_MS } from '../../lib/jobs/worker-presence.js';

export interface HealthReport {
  status: 'ok' | 'degraded';
  time: string;
  queue: {
    pending: number;
    running: number;
    /** Age of the longest-running job, or null when nothing runs. */
    oldestRunningSec: number | null;
    /** RUNNING jobs whose heartbeat is stale (their worker is probably dead). */
    staleRunning: number;
  };
  workers: { id: string; host: string; pid: number; lastSeenSec: number }[];
  disk: { dataDir: string; freeBytes: number | null; minFreeBytes: number };
  checks: { worker: 'ok' | 'none'; disk: 'ok' | 'low' | 'unknown'; jobs: 'ok' | 'stale' };
}

export interface HealthOptions {
  minFreeBytes: number;
  workerStaleMs?: number;
  jobStaleMs?: number;
  now?: Date;
}

export async function getHealth(storage: LocalAssetStorage, options: HealthOptions): Promise<HealthReport> {
  const prisma = getPrisma();
  const now = options.now ?? new Date();
  const jobStaleMs = options.jobStaleMs ?? DEFAULT_STALE_MS;

  const [pending, running, oldest, staleRunning, workers] = await Promise.all([
    prisma.job.count({ where: { status: JobStatus.PENDING } }),
    prisma.job.count({ where: { status: JobStatus.RUNNING } }),
    prisma.job.findFirst({ where: { status: JobStatus.RUNNING }, orderBy: { startedAt: 'asc' }, select: { startedAt: true } }),
    prisma.job.count({
      where: {
        status: JobStatus.RUNNING,
        OR: [{ heartbeatAt: { lt: new Date(now.getTime() - jobStaleMs) } }, { heartbeatAt: null, startedAt: { lt: new Date(now.getTime() - jobStaleMs) } }],
      },
    }),
    listWorkerPresence(new Date(now.getTime() - (options.workerStaleMs ?? WORKER_PRESENCE_STALE_MS))),
  ]);

  let freeBytes: number | null;
  try {
    const info = await statfs(storage.root);
    freeBytes = Number(info.bavail) * Number(info.bsize);
  } catch {
    freeBytes = null; // Not supported on this platform or volume.
  }

  const checks: HealthReport['checks'] = {
    worker: workers.length > 0 ? 'ok' : 'none',
    disk: freeBytes === null ? 'unknown' : freeBytes < options.minFreeBytes ? 'low' : 'ok',
    jobs: staleRunning > 0 ? 'stale' : 'ok',
  };
  return {
    status: checks.worker === 'ok' && checks.disk !== 'low' && checks.jobs === 'ok' ? 'ok' : 'degraded',
    time: now.toISOString(),
    queue: {
      pending,
      running,
      oldestRunningSec: oldest?.startedAt ? Math.max(0, Math.round((now.getTime() - oldest.startedAt.getTime()) / 1000)) : null,
      staleRunning,
    },
    workers: workers.map((w) => ({ id: w.id, host: w.host, pid: w.pid, lastSeenSec: Math.max(0, Math.round((now.getTime() - w.lastSeen.getTime()) / 1000)) })),
    disk: { dataDir: storage.root, freeBytes, minFreeBytes: options.minFreeBytes },
    checks,
  };
}
