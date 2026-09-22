/**
 * SCENES stage: splits the script into timed scenes with visual prompts.
 * AI timings are normalized deterministically before Scene rows are written.
 */
import { getPrisma } from '../lib/db/prisma.js';
import { buildScenesPrompt } from '../lib/ai/prompts/scenes.js';
import {
  AiScenesSchema,
  NormalizedScenesSchema,
  normalizeScenes,
  type NormalizedScene,
} from '../lib/ai/schemas/scenes.js';
import { ScriptSchema } from '../lib/ai/schemas/script.js';
import type { JobHandler } from '../lib/jobs/types.js';
import { getChannelDna } from '../lib/settings/channel-dna.js';

export const scenesHandler: JobHandler = async (
  _job,
  payload,
  { ai },
): Promise<{ scenes: NormalizedScene[] }> => {
  const prisma = getPrisma();

  const video = await prisma.video.findUniqueOrThrow({
    where: { id: payload.videoId },
    select: { scriptJson: true },
  });
  if (!video.scriptJson) {
    throw new Error('Video has no script; SCRIPT stage must run first');
  }
  const script = ScriptSchema.parse(JSON.parse(video.scriptJson));
  const dna = await getChannelDna();

  const proposal = await ai.generateStructured({
    ...buildScenesPrompt({ script, dna }),
    schema: AiScenesSchema,
    schemaName: 'scenes',
  });

  const scenes = NormalizedScenesSchema.parse(normalizeScenes(proposal.scenes, script.targetDuration));
  const totalDuration = scenes.at(-1)?.endTime ?? 0;

  // Replace scenes from any previous attempt so the stage is idempotent.
  await prisma.$transaction(async (tx) => {
    await tx.scene.deleteMany({ where: { videoId: payload.videoId } });
    await tx.scene.createMany({
      data: scenes.map((scene) => ({
        videoId: payload.videoId,
        index: scene.index,
        text: scene.text,
        duration: scene.duration,
        visualPrompt: scene.visualPrompt,
        visualType: scene.visualType,
        startTime: scene.startTime,
        endTime: scene.endTime,
        subtitleEmphasisJson: JSON.stringify(scene.subtitleEmphasis),
      })),
    });
    await tx.video.update({ where: { id: payload.videoId }, data: { duration: totalDuration } });
  });

  return { scenes };
};
