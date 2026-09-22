/**
 * Liveness of a RUNNING job. While a worker processes a job it refreshes
 * Job.heartbeatAt every `intervalMs`; a job whose heartbeat is older than the
 * stale threshold belongs to a worker that died (see recover-jobs.ts). Each
 * refresh is conditional on the job still being RUNNING and owned by this
 * worker, so it also tells the worker when its job was cancelled (abort API)
 * or handed to someone else, and the worker can stop its external processes.
 */
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { getPrisma } from '../db/prisma.js';
import { JobStatus } from '../generated/prisma/client.js';
import type { JobLogger } from './types.js';

export const DEFAULT_HEARTBEAT_MS = 15_000;
/** 8 missed heartbeats: long enough for a busy machine, short enough for an unattended batch. */
export const DEFAULT_STALE_MS = 120_000;
const MIN_HEARTBEAT_MS = 1_000;

export interface HeartbeatConfig {
  intervalMs: number;
  staleMs: number;
}

/** JOB_HEARTBEAT_MS (default 15000, at least 1000) and JOB_STALE_MS (default 120000, at least 2 × interval). */
export function heartbeatConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HeartbeatConfig {
  const read = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (!raw) {
      return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < MIN_HEARTBEAT_MS) {
      throw new Error(`${name} must be a whole number of milliseconds (at least ${MIN_HEARTBEAT_MS})`);
    }
    return value;
  };
  const intervalMs = read('JOB_HEARTBEAT_MS', DEFAULT_HEARTBEAT_MS);
  const staleMs = read('JOB_STALE_MS', DEFAULT_STALE_MS);
  if (staleMs < 2 * intervalMs) {
    throw new Error('JOB_STALE_MS must be at least twice JOB_HEARTBEAT_MS');
  }
  return { intervalMs, staleMs };
}

/** "host-pid-xxxxxx": unique per worker process, readable in Job.workerId and logs. */
export function newWorkerId(): string {
  return `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
}

/** Refreshes the heartbeat; false when the job is no longer this worker's RUNNING job. */
export async function beatJob(jobId: string, workerId: string): Promise<boolean> {
  const { count } = await getPrisma().job.updateMany({
    where: { id: jobId, status: JobStatus.RUNNING, workerId },
    data: { heartbeatAt: new Date() },
  });
  return count === 1;
}

export interface HeartbeatOptions {
  intervalMs: number;
  /** Runs once when the job stopped being this worker's RUNNING job (cancelled or recovered elsewhere). */
  onLost: () => void;
  log?: JobLogger;
}

export interface HeartbeatHandle {
  stop(): void;
}

/**
 * Starts the periodic heartbeat for a claimed job. A failed refresh (busy
 * database) is only logged; the next tick tries again. The timer never keeps
 * the process alive on its own.
 */
export function startHeartbeat(jobId: string, workerId: string, options: HeartbeatOptions): HeartbeatHandle {
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(() => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    beatJob(jobId, workerId)
      .then((alive) => {
        if (!alive && !stopped) {
          stopped = true;
          clearInterval(timer);
          options.onLost();
        }
      })
      .catch((error: unknown) => {
        options.log?.(`Heartbeat for job ${jobId} failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        inFlight = false;
      });
  }, options.intervalMs);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
