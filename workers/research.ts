/**
 * RESEARCH stage: gathers structured background facts for the topic with AI.
 * The model has no web access yet, so sources may be empty.
 * Result is stored in Job.resultJson by the job engine.
 */
import { buildResearchPrompt } from '../lib/ai/prompts/research.js';
import { ResearchSchema, type Research } from '../lib/ai/schemas/research.js';
import type { JobHandler } from '../lib/jobs/types.js';

export const researchHandler: JobHandler = async (_job, payload, { ai }): Promise<Research> => {
  return ai.generateStructured({
    ...buildResearchPrompt({ topic: payload.topic }),
    schema: ResearchSchema,
    schemaName: 'research',
  });
};
