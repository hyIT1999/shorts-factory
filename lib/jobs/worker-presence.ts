/**
 * "Is a worker alive?" for the health check, independent of jobs: each worker
 * writes a small presence row (Setting key "worker.<id>") when it starts and
 * every WORKER_PRESENCE_MS while it polls, and removes it on a clean stop. A
 * worker that died leaves a row whose lastSeen stops moving; the health check
 * ignores rows older than WORKER_PRESENCE_STALE_MS and prunes very old ones.
 */
import { getPrisma } from '../db/prisma.js';

const KEY_PREFIX = 'worker.';
export const WORKER_PRESENCE_MS = 30_000;
/** Three missed presence writes. */
export const WORKER_PRESENCE_STALE_MS = 90_000;
const PRUNE_AFTER_MS = 24 * 60 * 60_000;

export interface WorkerPresence {
  id: string;
  host: string;
  pid: number;
  lastSeen: Date;
}

export async function recordWorkerPresence(workerId: string, info: { host: string; pid: number }, now: Date = new Date()): Promise<void> {
  const key = KEY_PREFIX + workerId;
  const value = JSON.stringify({ lastSeen: now.toISOString(), host: info.host, pid: info.pid });
  await getPrisma().setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

export async function clearWorkerPresence(workerId: string): Promise<void> {
  await getPrisma().setting.deleteMany({ where: { key: KEY_PREFIX + workerId } });
}

/** Workers seen since `since`; rows untouched for a day are removed along the way. */
export async function listWorkerPresence(since: Date): Promise<WorkerPresence[]> {
  const prisma = getPrisma();
  await prisma.setting.deleteMany({
    where: { key: { startsWith: KEY_PREFIX }, updatedAt: { lt: new Date(since.getTime() - PRUNE_AFTER_MS) } },
  });
  const rows = await prisma.setting.findMany({ where: { key: { startsWith: KEY_PREFIX } }, select: { key: true, value: true } });
  const workers: WorkerPresence[] = [];
  for (const row of rows) {
    let parsed: { lastSeen?: unknown; host?: unknown; pid?: unknown };
    try {
      parsed = JSON.parse(row.value) as typeof parsed;
    } catch {
      continue;
    }
    const lastSeen = typeof parsed.lastSeen === 'string' ? new Date(parsed.lastSeen) : null;
    if (!lastSeen || Number.isNaN(lastSeen.getTime()) || lastSeen < since) {
      continue;
    }
    workers.push({
      id: row.key.slice(KEY_PREFIX.length),
      host: typeof parsed.host === 'string' ? parsed.host : '',
      pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
      lastSeen,
    });
  }
  return workers.sort((a, b) => a.id.localeCompare(b.id));
}
