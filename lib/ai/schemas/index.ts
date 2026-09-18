import { z } from 'zod';

/**
 * Zod schemas for validating AI inputs and outputs.
 *
 * TODO: Add the script schema (hook, scenes, narration, visual prompts, CTA)
 * once script generation is implemented. Do not trust raw model output:
 * every AI response must be parsed with a schema from this folder.
 */

/** A user-supplied topic for a new short. */
export const topicSchema = z.string().trim().min(3).max(500);

export type Topic = z.infer<typeof topicSchema>;
