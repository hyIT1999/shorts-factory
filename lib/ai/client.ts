/**
 * AI client (NOT IMPLEMENTED — STEP 1 placeholder).
 *
 * TODO: Provide a single, provider-agnostic entry point for LLM calls used by
 * the research, script and scene workers.
 * - Read the API key from AI_API_KEY on the server/worker side only.
 * - Accept a prompt (from lib/ai/prompts) and a Zod schema (from
 *   lib/ai/schemas), and return output validated against that schema.
 * - Handle retries and surface provider errors to the calling job.
 *
 * The Angular frontend must never import this module or see API keys.
 */
export {};
