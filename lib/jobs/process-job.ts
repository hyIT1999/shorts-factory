import { ZodError } from 'zod';
import { AIError } from '../ai/errors.js';
import { killActiveProcesses } from '../ffmpeg/process.js';
import { JobType } from '../generated/prisma/client.js';
import { RenderResultSchema } from '../render/types.js';
import { researchHandler } from '../../workers/research.js';
import { scriptHandler } from '../../workers/script.js';
import { scenesHandler } from '../../workers/scenes.js';
import { assetsHandler } from '../../workers/assets.js';
import { voiceHandler } from '../../workers/voice.js';
import { subtitlesHandler } from '../../workers/subtitles.js';
import { renderHandler } from '../../workers/render.js';
import { claimNextJob } from './claim-job.js';
import { completeJob, type CompletedVideoUpdate } from './complete-job.js';
import { failJob } from './fail-job.js';
import { DEFAULT_HEARTBEAT_MS, startHeartbeat, type HeartbeatHandle } from './heartbeat.js';
import { requeueJob } from './requeue-job.js';
import {
  jobPayloadSchema,
  type ClaimedJob,
  type JobContext,
  type JobHandler,
  type JobLogger,
} from './types.js';

const handlers: Record<JobType, JobHandler> = {
  [JobType.RESEARCH]: researchHandler,
  [JobType.SCRIPT]: scriptHandler,
  [JobType.SCENES]: scenesHandler,
  [JobType.ASSETS]: assetsHandler,
  [JobType.VOICE]: voiceHandler,
  [JobType.SUBTITLES]: subtitlesHandler,
  [JobType.RENDER]: renderHandler,
};

function parsePayload(job: ClaimedJob) {
  let raw: unknown;
  try {
    raw = JSON.parse(job.payloadJson ?? 'null');
  } catch {
    throw new Error('Invalid job payload: not valid JSON');
  }
  const parsed = jobPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid job payload: ${details}`);
  }
  return parsed.data;
}

const MAX_ISSUES_IN_MESSAGE = 5;
const MAX_REQUEUE_REASON_LENGTH = 200;

/** A short, safe message for Job.error (shown in the UI). */
function errorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    const issues = error.issues
      .slice(0, MAX_ISSUES_IN_MESSAGE)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return `Validation failed: ${issues}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * What a stage result changes on the Video row, written in the same
 * transaction as the job completion: a RENDER's promoted output path.
 */
export function videoUpdateFor(job: Pick<ClaimedJob, 'type'>, result: unknown): CompletedVideoUpdate | undefined {
  if (job.type !== JobType.RENDER) {
    return undefined;
  }
  const parsed = RenderResultSchema.safeParse(result);
  return parsed.success && parsed.data.outputPath !== null ? { outputPath: parsed.data.outputPath } : undefined;
}

/** Heartbeat for a claimed job; when the job stops being ours, its external processes are stopped. */
function beginHeartbeat(job: ClaimedJob, ctx: JobContext, log: JobLogger): HeartbeatHandle | null {
  if (!ctx.workerId) {
    return null;
  }
  return startHeartbeat(job.id, ctx.workerId, {
    intervalMs: ctx.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    log,
    onLost: () => {
      const killed = killActiveProcesses();
      log(`Job ${job.id} [${job.type}] is no longer ours (cancelled or recovered elsewhere); stopped ${killed} external process(es)`);
    },
  });
}

/** Runs one claimed job through its handler and records the outcome. */
export async function processJob(job: ClaimedJob, log: JobLogger, ctx: JobContext): Promise<void> {
  log(`Processing ${job.type}...`);
  const heartbeat = beginHeartbeat(job, ctx, log);
  try {
    const payload = parsePayload(job);
    const result = await handlers[job.type](job, payload, ctx);
    const next = await completeJob(job, payload, result, videoUpdateFor(job, result));
    log(`Completed job ${job.id}`);
    log(next ? `Created next job ${next.id} [${next.type}]` : `Pipeline completed for project ${payload.projectId}`);
  } catch (error) {
    const message = errorMessage(error);
    if (ctx.isShuttingDown?.()) {
      // The worker is stopping (its ffmpeg was killed, or the handler was cut short): not the job's fault.
      const reason = `worker stopped while running ${job.type} (${message.slice(0, MAX_REQUEUE_REASON_LENGTH)})`;
      try {
        const requeued = await requeueJob(job, reason, ctx.workerId);
        log(requeued ? `Requeued job ${job.id} [${job.type}]: worker is stopping` : `Job ${job.id} was no longer RUNNING; nothing to requeue`);
      } catch (requeueError) {
        log(`Could not requeue job ${job.id}: ${requeueError instanceof Error ? requeueError.message : String(requeueError)}`);
      }
      return;
    }
    log(`Failed job ${job.id} [${job.type}]: ${message}`);
    // AIError messages are already complete; stacks help for unexpected errors.
    if (!(error instanceof AIError) && error instanceof Error && error.stack) {
      log(error.stack);
    }
    try {
      if (!(await failJob(job, message))) {
        log(`Job ${job.id} is no longer RUNNING (cancelled, recovered elsewhere or deleted); failure not recorded`);
      }
    } catch (failError) {
      log(`Could not mark job ${job.id} as FAILED: ${failError instanceof Error ? failError.message : String(failError)}`);
    }
  } finally {
    heartbeat?.stop();
  }
}

/**
 * Claims and processes the next pending job.
 * Returns false when there was nothing to do, so the caller can sleep.
 */
export async function processNextJob(log: JobLogger, ctx: JobContext): Promise<boolean> {
  const job = await claimNextJob(ctx.workerId);
  if (!job) {
    return false;
  }
  log(`Claimed job ${job.id} [${job.type}]`);
  await processJob(job, log, ctx);
  return true;
}
