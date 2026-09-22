import { z } from 'zod';

export const MIN_SCENE_SECONDS = 2;
export const MAX_SCENE_SECONDS = 8;
export const MIN_SCENES = 5;
export const MAX_SCENES = 10;

/** Phrases that mean the visual would contain rendered text, which we never want. */
const TEXT_OVERLAY_PATTERN = /\b(text overlays?|on-screen text|captions?|subtitles?|typography|lettering)\b/i;

const visualPrompt = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine((value) => !TEXT_OVERLAY_PATTERN.test(value), {
    message: 'visualPrompt must describe visuals only, not text overlays or subtitles',
  });

const sceneFields = {
  text: z.string().trim().min(1).max(400),
  visualPrompt,
  visualType: z.enum(['video', 'image']),
  subtitleEmphasis: z.array(z.string().trim().min(1).max(60)).max(5),
};

/** What the AI returns for the SCENES stage. Timings are only proposals. */
export const AiScenesSchema = z.strictObject({
  scenes: z
    .array(
      z.strictObject({
        index: z.number().int().min(0).max(20),
        ...sceneFields,
        duration: z.number().min(0.5).max(20),
        startTime: z.number().min(0),
        endTime: z.number().min(0),
      }),
    )
    .min(MIN_SCENES)
    .max(MAX_SCENES),
});

export type AiScenes = z.infer<typeof AiScenesSchema>;
export type AiScene = AiScenes['scenes'][number];

const EPSILON = 1e-6;

/** Scenes after deterministic timing normalization (what is saved to the database). */
export const NormalizedScenesSchema = z
  .array(
    z.strictObject({
      index: z.number().int().min(0),
      ...sceneFields,
      duration: z.number().min(MIN_SCENE_SECONDS).max(MAX_SCENE_SECONDS),
      startTime: z.number().min(0),
      endTime: z.number().positive(),
    }),
  )
  .min(MIN_SCENES)
  .max(MAX_SCENES)
  .superRefine((scenes, ctx) => {
    let expectedStart = 0;
    scenes.forEach((scene, i) => {
      if (scene.index !== i) {
        ctx.addIssue({ code: 'custom', path: [i, 'index'], message: `index must be ${i}` });
      }
      if (Math.abs(scene.startTime - expectedStart) > EPSILON) {
        ctx.addIssue({ code: 'custom', path: [i, 'startTime'], message: 'scenes must be sequential without gaps or overlaps' });
      }
      if (scene.endTime <= scene.startTime || Math.abs(scene.endTime - scene.startTime - scene.duration) > EPSILON) {
        ctx.addIssue({ code: 'custom', path: [i, 'endTime'], message: 'endTime must equal startTime + duration' });
      }
      expectedStart = scene.endTime;
    });
  });

export type NormalizedScene = z.infer<typeof NormalizedScenesSchema>[number];

/** Durations are computed in tenths of a second to avoid floating point drift. */
const TENTHS = 10;
const MIN_TENTHS = MIN_SCENE_SECONDS * TENTHS;
const MAX_TENTHS = MAX_SCENE_SECONDS * TENTHS;
const TOLERANCE = 0.1;
const MAX_ROUNDS = 5;

const clampTenths = (value: number): number => Math.min(MAX_TENTHS, Math.max(MIN_TENTHS, Math.round(value)));

/**
 * Deterministically fixes AI-proposed timings:
 * 1. keep the AI order and re-index from 0;
 * 2. clamp each duration to [2, 8] s (0.1 s precision);
 * 3. if the total is more than 10% away from `targetDuration`, scale the
 *    scenes that are not at a limit (a few rounds), re-clamping each time;
 *    if the target is unreachable within the limits, the closest total is kept;
 * 4. assign contiguous startTime/endTime starting at 0.
 * The AI's own startTime/endTime values are ignored.
 */
export function normalizeScenes(scenes: readonly AiScene[], targetDuration: number): NormalizedScene[] {
  const target = targetDuration * TENTHS;
  let durations = scenes.map((scene) => clampTenths(scene.duration * TENTHS));

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const total = durations.reduce((sum, d) => sum + d, 0);
    if (Math.abs(total - target) <= target * TOLERANCE) {
      break;
    }
    const growing = total < target;
    const adjustable = durations.filter((d) => (growing ? d < MAX_TENTHS : d > MIN_TENTHS));
    if (adjustable.length === 0) {
      break;
    }
    const fixed = total - adjustable.reduce((sum, d) => sum + d, 0);
    const factor = (target - fixed) / (total - fixed);
    durations = durations.map((d) =>
      (growing ? d < MAX_TENTHS : d > MIN_TENTHS) ? clampTenths(d * factor) : d,
    );
  }

  let cursor = 0;
  return scenes.map((scene, index) => {
    const duration = durations[index] ?? MIN_TENTHS;
    const startTime = cursor;
    cursor += duration;
    return {
      index,
      text: scene.text,
      visualPrompt: scene.visualPrompt,
      visualType: scene.visualType,
      subtitleEmphasis: scene.subtitleEmphasis,
      duration: duration / TENTHS,
      startTime: startTime / TENTHS,
      endTime: cursor / TENTHS,
    };
  });
}
