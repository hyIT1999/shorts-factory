/**
 * SCRIPT stage: writes the Shorts voice-over script from the research and the
 * Channel DNA. Saved to Video.scriptJson (and Job.resultJson).
 */
import { getPrisma } from '../lib/db/prisma.js';
import { JobType } from '../lib/generated/prisma/client.js';
import { buildScriptPrompt } from '../lib/ai/prompts/script.js';
import { ResearchSchema } from '../lib/ai/schemas/research.js';
import { ScriptDraftSchema, ScriptSchema, type Script } from '../lib/ai/schemas/script.js';
import { getCompletedJobResult } from '../lib/jobs/results.js';
import type { JobHandler } from '../lib/jobs/types.js';
import { getChannelDna, parseDurationRange } from '../lib/settings/channel-dna.js';

export const scriptHandler: JobHandler = async (_job, payload, { ai }): Promise<Script> => {
  const rawResearch = await getCompletedJobResult(payload.videoId, JobType.RESEARCH);
  if (rawResearch === null) {
    throw new Error('No completed RESEARCH result found for this video');
  }
  const research = ResearchSchema.parse(rawResearch);
  const dna = await getChannelDna();

  const draft = await ai.generateStructured({
    ...buildScriptPrompt({
      topic: payload.topic,
      research,
      dna,
      duration: parseDurationRange(dna.averageDuration),
    }),
    schema: ScriptDraftSchema,
    schemaName: 'script',
  });

  // Scenes come from the SCENES stage; sources come from research, never from the script model.
  const script = ScriptSchema.parse({ ...draft, scenes: [], sources: research.sources });

  await getPrisma().video.update({
    where: { id: payload.videoId },
    data: { scriptJson: JSON.stringify(script), title: script.title },
  });
  return script;
};
