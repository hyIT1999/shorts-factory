/**
 * SUBTITLES stage (Phase A): deterministic captions from the database, no AI,
 * no network, no files.
 *
 * Source of truth: Scene.text (normalized exactly like VOICE), the real scene
 * timings written by VOICE (Scene.startTime/endTime/duration, Video.duration),
 * Scene.subtitleEmphasisJson, and the script language (fallback Channel DNA).
 * The result is returned as the job result (Job.resultJson); RENDER builds the
 * styled subtitle file from it later.
 */
import { createHash } from 'node:crypto';
import { getPrisma } from '../db/prisma.js';
import { getChannelDna } from '../settings/channel-dna.js';
import { VoiceError } from '../voice/errors.js';
import { assertVietnamese, normalizeLanguage, normalizeNarration, vietnameseMarkedRatio } from '../voice/text.js';
import { buildSpans, matchEmphasis, parseEmphasis, withEmphasisNoBreak } from './emphasis.js';
import { SubtitleError, type SubtitleWarningCode } from './errors.js';
import { segmentScene } from './segment.js';
import { allocateTimes, tokenWeights } from './timing.js';
import { charLength, tokenize, validateSceneText } from './tokenize.js';
import {
  MAX_CHARS_PER_LINE,
  MAX_LINES,
  MAX_SCENES,
  MAX_SEGMENTS,
  MIN_SEGMENT_MS,
  SUBTITLE_ALGORITHM,
  SUPPORTED_LANGUAGES,
  SubtitleResultSchema,
  type SubtitleInput,
  type SubtitleResult,
  type SubtitleSegment,
  type SubtitleWarning,
} from './types.js';
import { assertResultInvariants, orderScenes, sceneTimingsMs } from './validate.js';

/**
 * Pure generation from prepared input (normalized texts, ms timings, scenes
 * in index order). Same input → byte-identical result.
 */
export function generateSubtitles(input: SubtitleInput): SubtitleResult {
  if (input.scenes.length === 0 || input.scenes.length > MAX_SCENES) {
    throw new SubtitleError('SUBTITLE_GENERATION_ERROR', `Subtitles need 1 to ${MAX_SCENES} scenes (got ${input.scenes.length})`);
  }
  const segments: SubtitleSegment[] = [];
  const warnings: SubtitleWarning[] = [];
  const hashScenes: unknown[] = [];
  const warn = (code: SubtitleWarningCode, sceneIndex: number, message: string) =>
    warnings.push({ code, sceneIndex, message: `Scene ${sceneIndex + 1}: ${message}` });

  for (const scene of input.scenes) {
    validateSceneText(scene.text, scene.index);
    const emphasis = parseEmphasis(scene.emphasisJson);
    const scanned = tokenize(scene.text);
    const { ranges, missing } = matchEmphasis(scanned, emphasis.phrases);
    for (const problem of [...emphasis.problems, ...missing]) {
      warn('SUBTITLE_INVALID_EMPHASIS', scene.index, problem);
    }
    const tokens = withEmphasisNoBreak(scanned, ranges);
    const weights = tokenWeights(tokens);
    const plan = segmentScene(tokens, scene.endMs - scene.startMs, weights);
    if (plan.short) {
      warn('SUBTITLE_SHORT_SCENE', scene.index, `lasts less than ${MIN_SEGMENT_MS} ms and is shown as one caption`);
    }
    const times = allocateTimes(scene.startMs, scene.endMs, weights, plan.segments);

    plan.segments.forEach((segment, k) => {
      const lines = segment.lines.map((lineTokens) => {
        const text = lineTokens.map((token) => token.text).join(' ');
        if (charLength(text) > MAX_CHARS_PER_LINE) {
          warn('SUBTITLE_LINE_OVERFLOW', scene.index, `"${text.slice(0, 60)}" is longer than ${MAX_CHARS_PER_LINE} characters and was kept on its own line`);
        }
        return { text, spans: buildSpans(lineTokens, ranges) };
      });
      const time = times[k] ?? { startMs: scene.startMs, endMs: scene.endMs };
      segments.push({
        id: `${scene.index}.${k}`,
        sceneId: scene.id,
        sceneIndex: scene.index,
        indexInScene: k,
        startMs: time.startMs,
        endMs: time.endMs,
        text: tokens.slice(segment.from, segment.to).map((token) => token.text).join(' '),
        wordRange: [segment.from, segment.to],
        lines,
      });
    });
    hashScenes.push([scene.id, scene.index, scene.text, scene.startMs, scene.endMs, emphasis.canonical]);
    if (segments.length > MAX_SEGMENTS) {
      throw new SubtitleError('SUBTITLE_GENERATION_ERROR', `Subtitles need more than ${MAX_SEGMENTS} segments; the narration is too long`);
    }
  }

  const layout = { maxLines: MAX_LINES, maxCharsPerLine: MAX_CHARS_PER_LINE } as const;
  const canonicalInput = JSON.stringify([SUBTITLE_ALGORITHM, [layout.maxLines, layout.maxCharsPerLine], input.language, hashScenes]);
  const result = {
    version: 1,
    algorithm: SUBTITLE_ALGORITHM,
    videoId: input.videoId,
    language: input.language,
    durationMs: input.scenes.at(-1)?.endMs ?? 0,
    inputHash: createHash('sha256').update(canonicalInput).digest('hex'),
    timing: 'segment',
    layout,
    segments,
    warnings,
  };

  const parsed = SubtitleResultSchema.safeParse(result);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SubtitleError(
      'SUBTITLE_GENERATION_ERROR',
      `Subtitle result is invalid: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'unknown error'}`,
    );
  }
  assertResultInvariants(parsed.data, input);
  return parsed.data;
}

async function resolveLanguage(scriptJson: string | null): Promise<string> {
  let scriptLanguage: unknown;
  try {
    scriptLanguage = scriptJson ? (JSON.parse(scriptJson) as Record<string, unknown>)['language'] : undefined;
  } catch {
    scriptLanguage = undefined;
  }
  const language = normalizeLanguage(
    typeof scriptLanguage === 'string' && scriptLanguage.trim() ? scriptLanguage : (await getChannelDna()).language,
  );
  if (!SUPPORTED_LANGUAGES.has(language)) {
    throw new SubtitleError('SUBTITLE_UNSUPPORTED_LANGUAGE', `Subtitles support only ${[...SUPPORTED_LANGUAGES].join(' and ')} (got "${language}")`);
  }
  return language;
}

/** Reuses the VOICE check so unaccented Vietnamese never reaches the screen. */
function assertVietnameseSubtitles(text: string): void {
  try {
    assertVietnamese(text);
  } catch (error) {
    if (error instanceof VoiceError && error.code === 'TEXT_NOT_VIETNAMESE') {
      throw new SubtitleError(
        'SUBTITLE_TEXT_NOT_VIETNAMESE',
        `Narration is marked as Vietnamese but only ${Math.round(vietnameseMarkedRatio(text) * 100)}% of words have diacritics`,
      );
    }
    throw error;
  }
}

export async function buildVideoSubtitles(input: { videoId: string }): Promise<SubtitleResult> {
  const prisma = getPrisma();
  const video = await prisma.video.findUniqueOrThrow({
    where: { id: input.videoId },
    select: { scriptJson: true, duration: true },
  });
  const rows = await prisma.scene.findMany({
    where: { videoId: input.videoId },
    orderBy: { index: 'asc' },
    select: {
      id: true,
      index: true,
      text: true,
      duration: true,
      startTime: true,
      endTime: true,
      subtitleEmphasisJson: true,
      voiceAssetId: true,
      voiceAsset: { select: { status: true, type: true } },
    },
  });

  const scenes = orderScenes(rows);
  const timings = sceneTimingsMs(scenes, video.duration);
  const texts = scenes.map((scene) => validateSceneText(normalizeNarration(scene.text), scene.index));
  const language = await resolveLanguage(video.scriptJson);
  if (language === 'vi') {
    assertVietnameseSubtitles(texts.join(' '));
  }

  return generateSubtitles({
    videoId: input.videoId,
    language,
    scenes: scenes.map((scene, i) => ({
      id: scene.id,
      index: scene.index,
      text: texts[i] ?? '',
      startMs: timings[i]?.startMs ?? 0,
      endMs: timings[i]?.endMs ?? 0,
      emphasisJson: scene.subtitleEmphasisJson,
    })),
  });
}
