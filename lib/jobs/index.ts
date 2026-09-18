/**
 * Job helpers (NOT IMPLEMENTED — STEP 1 placeholder).
 *
 * TODO: Database-backed job queue on top of the Prisma `Job` model:
 * - enqueue(projectId, type, payload) creates a PENDING job.
 * - claimNext() atomically moves the oldest PENDING job to RUNNING,
 *   sets startedAt and increments attempts.
 * - complete(jobId, result) / fail(jobId, error) finalize a job.
 *
 * No Redis/BullMQ: SQLite is the queue for this single-user tool.
 */
export {};
