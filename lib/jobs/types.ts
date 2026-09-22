import { z } from 'zod';
import type { AIClient } from '../ai/client.js';
import type { AssetServices } from '../assets/index.js';
import type { RenderServices } from '../render/types.js';
import type { VoiceServices } from '../voice/index.js';
import { JobType, type Job } from '../generated/prisma/client.js';

/** The fixed pipeline order. Each successful job enqueues the next type. */
export const PIPELINE: readonly JobType[] = [
  JobType.RESEARCH,
  JobType.SCRIPT,
  JobType.SCENES,
  JobType.ASSETS,
  JobType.VOICE,
  JobType.SUBTITLES,
  JobType.RENDER,
];

/** Returns the job type that follows `type`, or null after the last stage. */
export function nextJobType(type: JobType): JobType | null {
  const index = PIPELINE.indexOf(type);
  return PIPELINE[index + 1] ?? null;
}

/** Payload carried by every pipeline job (stored in Job.payloadJson). */
export const jobPayloadSchema = z.object({
  projectId: z.string().min(1),
  videoId: z.string().min(1),
  topic: z.string().min(1),
  title: z.string().min(1),
});

export type JobPayload = z.infer<typeof jobPayloadSchema>;

/** A job that has been claimed by this worker (status RUNNING). */
export type ClaimedJob = Job;

/** Dependencies handed to every handler (injected so tests can use a mock AI). */
export interface JobContext {
  ai: AIClient;
  assets: AssetServices;
  voice: VoiceServices;
  render: RenderServices;
  /** Identifies this worker process in Job.workerId; without it no heartbeat is sent (unit tests). */
  workerId?: string;
  /** Heartbeat interval while a job runs (default: lib/jobs/heartbeat.ts). */
  heartbeatMs?: number;
  /** True once the worker is shutting down: the current job is requeued instead of failed. */
  isShuttingDown?: () => boolean;
}

/**
 * A pipeline stage implementation. Returns the value stored in Job.resultJson.
 * Throwing marks the job (and its video/project) as FAILED.
 */
export type JobHandler = (job: ClaimedJob, payload: JobPayload, ctx: JobContext) => Promise<unknown>;

/** Minimal logger so the worker controls output and tests can stay quiet. */
export type JobLogger = (message: string) => void;
