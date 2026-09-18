/**
 * Background worker entry point (NOT IMPLEMENTED — STEP 1 placeholder).
 *
 * Future responsibility:
 * 1. Poll the database for PENDING jobs (see lib/jobs).
 * 2. Atomically claim one job (PENDING -> RUNNING).
 * 3. Dispatch it by JobType to the matching worker module:
 *      RESEARCH  -> workers/research.ts
 *      SCRIPT    -> workers/script.ts
 *      SCENES    -> workers/scenes.ts
 *      ASSETS    -> workers/assets.ts
 *      VOICE     -> workers/voice.ts
 *      SUBTITLES -> workers/subtitles.ts
 *      RENDER    -> workers/render.ts
 * 4. Mark the job COMPLETED or FAILED and enqueue the next pipeline step.
 *
 * The worker runs as a separate Node process from the API server so long
 * tasks (AI calls, downloads, FFmpeg) never block HTTP requests.
 *
 * TODO: Implement the claim/dispatch loop once lib/jobs exists.
 */
console.log('Shorts Factory worker: not implemented yet (STEP 1 bootstrap).');
