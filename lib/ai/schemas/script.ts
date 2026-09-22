import { z } from 'zod';
import { ResearchSchema } from './research.js';

/** What the AI returns for the SCRIPT stage. */
export const ScriptDraftSchema = z.strictObject({
  title: z.string().trim().min(1).max(100),
  /** Opening line spoken in the first seconds. */
  hook: z.string().trim().min(1).max(200),
  /** The complete voice-over from hook to CTA, as it will be read aloud. */
  narration: z.string().trim().min(1).max(1500),
  language: z.string().trim().min(2).max(10),
  targetDuration: z.number().int().min(30).max(60),
  cta: z.string().trim().min(1).max(150),
});

/**
 * The stored script (Video.scriptJson). `scenes` stays empty: the SCENES stage
 * produces the scene breakdown. `sources` are copied from the research by the
 * application, never written by the script model.
 */
export const ScriptSchema = ScriptDraftSchema.extend({
  scenes: z.array(z.unknown()).max(0),
  sources: ResearchSchema.shape.sources,
});

export type ScriptDraft = z.infer<typeof ScriptDraftSchema>;
export type Script = z.infer<typeof ScriptSchema>;
