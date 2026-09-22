import { z } from 'zod';

/**
 * Output of the RESEARCH stage. Stored in the RESEARCH Job.resultJson.
 *
 * The Shorts fields (visualIdea, hookFact, curiosityScore, visualScore) are optional so results
 * stored before they existed still parse; toStrictJsonSchema marks every property as required, so
 * the AI always returns them.
 */
export const ResearchSchema = z.strictObject({
  topic: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(1200),
  /** The most surprising accurate fact, suitable for the first 3 seconds. */
  hookFact: z.string().trim().min(1).max(300).optional(),
  /** Facts ordered by storytelling importance: most surprising first, context last. */
  facts: z
    .array(
      z.strictObject({
        claim: z.string().trim().min(1).max(300),
        explanation: z.string().trim().min(1).max(600),
        /** established = widely accepted; debated = hypothesis / ongoing research. */
        confidence: z.enum(['established', 'debated']),
        /** Real-world footage or images that could illustrate the fact. */
        visualIdea: z.string().trim().min(1).max(400).optional(),
      }),
    )
    .min(3)
    .max(8),
  /** Shorts potential, 1-10. */
  curiosityScore: z.number().int().min(1).max(10).optional(),
  visualScore: z.number().int().min(1).max(10).optional(),
  /** Only sources the model is confident exist; empty is valid (no web access yet). */
  sources: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1).max(200),
        url: z.url({ protocol: /^https?$/ }),
      }),
    )
    .max(10),
});

export type Research = z.infer<typeof ResearchSchema>;
