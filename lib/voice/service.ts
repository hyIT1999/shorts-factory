/**
 * VOICE stage orchestration: one narration file per scene.
 *
 * Source of truth: Scene.text (ordered by index), Video.scriptJson.language
 * (fallback Channel DNA), voice from config, tone from Channel DNA. The AI
 * scene timings are only estimates: after all scenes have audio, scene
 * durations/start/end and Video.duration are recomputed from the real audio.
 *
 * Two modes (VoiceServices.mode):
 * - narration (default): ONE TTS request for the whole narration, kept as
 *   audio/<p>/<v>/narration.wav (Asset type "narration"), then cut into the
 *   per-scene WAVs (lib/voice/split.ts). One request per video keeps the
 *   Gemini free tier (10 TTS requests/day/model) usable.
 * - scene: one TTS request per scene, sequentially.
 *
 * Consistency: a file is written atomically before its Asset becomes READY,
 * and Scene.voiceAssetId only ever points at READY assets. Any failure fails
 * the job (no silent fallback); audio already voiced stays READY and is
 * reused from cache on the next run.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { audioDir, sceneFileBase } from '../assets/storage.js';
import { getPrisma } from '../db/prisma.js';
import { AssetStatus, type Asset, type Prisma } from '../generated/prisma/client.js';
import { getChannelDna } from '../settings/channel-dna.js';
import { narrationCacheKey, sceneSplitKey, voiceCacheKey } from './cache.js';
import { VoiceError } from './errors.js';
import type { VoiceServices } from './index.js';
import { assertSpeechCoverage, splitAt, splitNarration, type SplitBoundary } from './split.js';
import { assertVietnamese, estimateSpeechSeconds, normalizeLanguage, normalizeNarration } from './text.js';
import { MAX_SPEED, MIN_SPEED, VoiceJobResultSchema, type VoiceJobResult, type VoiceRequest } from './types.js';
import { parseWav, type WavInfo } from './wav.js';

export const AUDIO_ASSET_TYPE = 'audio';
/** The whole-narration file of narration mode; never linked to a scene. */
export const NARRATION_ASSET_TYPE = 'narration';
export const NARRATION_FILE_BASE = 'narration';
const MIN_AUDIO_SECONDS = 0.3;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

export interface VoiceInput {
  projectId: string;
  videoId: string;
}

export type VoiceLog = (message: string) => void;

interface SceneAudio {
  sceneId: string;
  sceneIndex: number;
  asset: Asset;
  durationSec: number;
  cached: boolean;
  boundary: Pick<SplitBoundary, 'quality' | 'silenceMs'> | null;
}

interface SceneRow {
  id: string;
  index: number;
  text: string;
  voiceAssetId: string | null;
}

/** What both modes share once the video, language and scenes are validated. */
interface VoiceContext {
  input: VoiceInput;
  services: VoiceServices;
  log: VoiceLog;
  dir: string;
  language: string;
  style: string;
  scenes: SceneRow[];
  /** Normalized scene texts, same order as `scenes`. */
  texts: string[];
}

interface ModeResult {
  results: SceneAudio[];
  apiCalls: number;
  /** Asset ids to keep besides the scene audio (the narration file). */
  extraKeep: string[];
  /** Scene.voiceAssetId updates still to be written (narration mode writes them with the timing). */
  links: { sceneId: string; assetId: string }[];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

function parseMetadata(asset: Asset): Record<string, unknown> {
  try {
    return asset.metadataJson ? (JSON.parse(asset.metadataJson) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Real audio must exist and be plausible for the text (catches empty, truncated or runaway audio). */
export function assertPlausibleDuration(info: WavInfo, text: string, sceneIndex: number, speed: number, label?: string): void {
  const expected = estimateSpeechSeconds(text) / speed;
  const min = Math.max(MIN_AUDIO_SECONDS, expected * 0.25);
  const max = expected * 4 + 2;
  if (info.durationSec < min || info.durationSec > max) {
    throw new VoiceError(
      'INVALID_AUDIO',
      `${label ?? `Scene ${sceneIndex + 1}`} audio lasts ${info.durationSec.toFixed(2)}s, expected ${min.toFixed(1)}–${max.toFixed(1)}s for its text`,
    );
  }
}

export async function synthesizeVideoVoice(
  input: VoiceInput,
  services: VoiceServices,
  log: VoiceLog = (message) => console.log(message),
): Promise<VoiceJobResult> {
  const prisma = getPrisma();
  const { provider } = services;
  const dir = audioDir(input.projectId, input.videoId);

  if (!(services.speed >= MIN_SPEED && services.speed <= MAX_SPEED)) {
    throw new VoiceError('VOICE_CONFIG', `Voice speed must be between ${MIN_SPEED} and ${MAX_SPEED}`);
  }

  // 1. Language (script, then Channel DNA) and delivery style (Channel DNA tone).
  const video = await prisma.video.findUniqueOrThrow({ where: { id: input.videoId }, select: { scriptJson: true } });
  const dna = await getChannelDna();
  let scriptLanguage: unknown;
  try {
    scriptLanguage = video.scriptJson ? (JSON.parse(video.scriptJson) as Record<string, unknown>)['language'] : undefined;
  } catch {
    scriptLanguage = undefined;
  }
  const language = normalizeLanguage(typeof scriptLanguage === 'string' && scriptLanguage.trim() ? scriptLanguage : dna.language);
  if (!/^[a-z]{2,3}$/.test(language) || (provider.supportedLanguages && !provider.supportedLanguages.has(language))) {
    throw new VoiceError('VOICE_UNSUPPORTED_LANGUAGE', `Language "${language}" is not supported by the ${provider.name} voice provider`);
  }
  const style = dna.tone;

  // 2. Scenes, strictly ordered and validated.
  const scenes = await prisma.scene.findMany({
    where: { videoId: input.videoId },
    orderBy: { index: 'asc' },
    select: { id: true, index: true, text: true, voiceAssetId: true },
  });
  if (scenes.length === 0) {
    throw new Error('Video has no scenes; SCENES stage must run first');
  }
  scenes.forEach((scene, position) => {
    if (scene.index !== position) {
      throw new Error(`Scene indexes must be contiguous from 0 (found ${scene.index} at position ${position})`);
    }
  });
  const texts = scenes.map((scene) => normalizeNarration(scene.text));
  texts.forEach((text, i) => {
    if (!text) {
      throw new VoiceError('EMPTY_TEXT', `Scene ${i + 1} has no narration text`);
    }
  });
  if (language === 'vi') {
    assertVietnamese(texts.join(' '));
  }

  // 3. Audio per scene, by one request for the narration or one per scene.
  const ctx: VoiceContext = { input, services, log, dir, language, style, scenes, texts };
  const { results, apiCalls, extraKeep, links } = services.mode === 'scene' ? await voiceByScene(ctx) : await voiceByNarration(ctx);

  // 4. Timing from real audio: contiguous scenes, Video.duration = total (one transaction with the links).
  let cursor = 0;
  const timed = results.map((r) => {
    const durationSec = round3(r.durationSec);
    const startTime = cursor;
    cursor = round3(cursor + durationSec);
    return { ...r, durationSec, startTime, endTime: cursor };
  });
  const total = cursor;
  await prisma.$transaction([
    ...links.map((l) => prisma.scene.update({ where: { id: l.sceneId }, data: { voiceAssetId: l.assetId } })),
    ...timed.map((t) =>
      prisma.scene.update({ where: { id: t.sceneId }, data: { duration: t.durationSec, startTime: t.startTime, endTime: t.endTime } }),
    ),
    prisma.video.update({ where: { id: input.videoId }, data: { duration: total } }),
  ]);

  // 5. Remove stale audio rows and files of this video.
  await cleanupStaleAudio(input.videoId, dir, new Set([...results.map((r) => r.asset.id), ...extraKeep]), services);

  const boundaries = timed.map((t) => t.boundary).filter((b): b is NonNullable<typeof b> => b !== null);
  const boundarySummary =
    services.mode === 'narration' && boundaries.length > 0
      ? `, boundaries: ${(['detected', 'relaxed', 'estimated'] as const)
          .map((q) => [q, boundaries.filter((b) => b.quality === q).length] as const)
          .filter(([, n]) => n > 0)
          .map(([q, n]) => `${n} ${q}`)
          .join(', ')}`
      : '';
  log(
    `VOICE done: ${results.length} scenes, ${total.toFixed(2)}s, ${apiCalls} TTS call(s) (${services.mode} mode), ` +
      `${results.filter((r) => r.cached).length} cached${boundarySummary}`,
  );
  return VoiceJobResultSchema.parse({
    provider: provider.name,
    model: provider.model,
    videoId: input.videoId,
    durationSec: total,
    mode: services.mode,
    ttsCalls: apiCalls,
    scenes: timed.map((t) => ({
      sceneIndex: t.sceneIndex,
      sceneId: t.sceneId,
      audioAssetId: t.asset.id,
      localPath: t.asset.localPath,
      durationSec: t.durationSec,
      startTime: t.startTime,
      endTime: t.endTime,
      cached: t.cached,
      words: null,
      boundary: t.boundary,
    })),
  });
}

/** Scene mode: one audio file per scene, sequentially (free-tier friendly). */
async function voiceByScene(ctx: VoiceContext): Promise<ModeResult> {
  const { services, scenes, texts, language, style, log } = ctx;
  const { provider } = services;
  const prisma = getPrisma();
  const results: SceneAudio[] = [];
  let apiCalls = 0;
  for (const [i, scene] of scenes.entries()) {
    const text = texts[i] ?? '';
    const request: VoiceRequest = { text, language, voice: services.voice, speed: services.speed, style, sceneIndex: scene.index };
    const cacheKey = voiceCacheKey({
      provider: provider.name,
      model: provider.model,
      voice: request.voice,
      language,
      speed: request.speed,
      style,
      text,
    });

    const reused = await reuseCached(scene.voiceAssetId, cacheKey, services);
    if (reused) {
      results.push({ sceneId: scene.id, sceneIndex: scene.index, asset: reused.asset, durationSec: reused.durationSec, cached: true, boundary: null });
      continue;
    }

    if (apiCalls > 0 && services.requestDelayMs > 0) {
      await sleep(services.requestDelayMs);
    }
    apiCalls++;
    log(`VOICE scene ${scene.index + 1}/${scenes.length}: synthesizing with ${provider.name} (${provider.model})`);
    const { asset, durationSec } = await synthesizeScene(ctx, request, cacheKey);
    await prisma.scene.update({ where: { id: scene.id }, data: { voiceAssetId: asset.id } });
    results.push({ sceneId: scene.id, sceneIndex: scene.index, asset, durationSec, cached: false, boundary: null });
  }
  return { results, apiCalls, extraKeep: [], links: [] };
}

/**
 * Narration mode: the whole narration in one request (cached by all scene
 * texts), then per-scene files cut from it (cached by the narration's sha256).
 * Scene links are written together with the timing, so a failed run leaves
 * the previous scene audio and timing untouched.
 */
async function voiceByNarration(ctx: VoiceContext): Promise<ModeResult> {
  const { services, scenes, texts, language, style, log, input } = ctx;
  const { provider } = services;
  const request: VoiceRequest = {
    text: texts.join('\n\n'),
    language,
    voice: services.voice,
    speed: services.speed,
    style,
    sceneIndex: 0,
    paragraphs: texts,
  };
  const cacheKey = narrationCacheKey({
    provider: provider.name,
    model: provider.model,
    voice: request.voice,
    language,
    speed: request.speed,
    style,
    texts,
  });

  // 1. The narration file: reuse or synthesize (the only TTS call).
  let apiCalls = 0;
  let narration = await reuseNarration(input.videoId, cacheKey, services);
  if (narration) {
    log(`VOICE narration: reusing cached audio (${narration.info.durationSec.toFixed(2)}s)`);
  } else {
    apiCalls = 1;
    log(`VOICE narration: synthesizing ${scenes.length} scenes in one request with ${provider.name} (${provider.model})`);
    narration = await synthesizeNarration(ctx, request, cacheKey);
  }

  // 2. Per-scene files: reuse the ones cut from this very narration, cut the rest.
  const narrationSha = String(parseMetadata(narration.asset)['sha256'] ?? '');
  const keys = scenes.map((scene) => sceneSplitKey(narrationSha, scene.index, scenes.length));
  const reused = await Promise.all(scenes.map((scene, i) => reuseCached(scene.voiceAssetId, keys[i] ?? '', services)));
  const results: SceneAudio[] = [];
  const links: { sceneId: string; assetId: string }[] = [];
  const write = reused.map((hit) => hit === null);
  if (write.some(Boolean)) {
    const cut = await cutNarration(ctx, narration, request, keys, write);
    for (const [i, scene] of scenes.entries()) {
      const hit = reused[i];
      const piece = cut[i];
      if (hit) {
        results.push({ sceneId: scene.id, sceneIndex: scene.index, asset: hit.asset, durationSec: hit.durationSec, cached: true, boundary: piece?.boundary ?? null });
      } else if (piece?.asset) {
        results.push({ sceneId: scene.id, sceneIndex: scene.index, asset: piece.asset, durationSec: piece.durationSec, cached: false, boundary: piece.boundary });
        links.push({ sceneId: scene.id, assetId: piece.asset.id });
      }
    }
  } else {
    const stored = parseMetadata(narration.asset)['boundaries'];
    const boundaries = Array.isArray(stored) ? (stored as Pick<SplitBoundary, 'quality' | 'silenceMs'>[]) : [];
    for (const [i, scene] of scenes.entries()) {
      const hit = reused[i];
      if (hit) {
        results.push({ sceneId: scene.id, sceneIndex: scene.index, asset: hit.asset, durationSec: hit.durationSec, cached: true, boundary: boundaries[i] ?? null });
      }
    }
  }
  // cutNarration returns one piece per scene; keep the invariant explicit.
  if (results.length !== scenes.length) {
    throw new VoiceError('INVALID_AUDIO', 'Narration split produced a different number of scenes');
  }
  return { results, apiCalls, extraKeep: [narration.asset.id], links };
}

interface NarrationAudio {
  asset: Asset;
  file: Uint8Array;
  info: WavInfo;
  boundariesSec: readonly number[] | null;
}

/** The video's READY narration when it matches the cache key and the file is intact. */
async function reuseNarration(videoId: string, cacheKey: string, services: VoiceServices): Promise<NarrationAudio | null> {
  const assets = await getPrisma().asset.findMany({
    where: { videoId, type: NARRATION_ASSET_TYPE, status: AssetStatus.READY },
    orderBy: { createdAt: 'desc' },
  });
  for (const asset of assets) {
    const metadata = parseMetadata(asset);
    if (metadata['cacheKey'] !== cacheKey || !asset.localPath) {
      continue;
    }
    try {
      const file = await services.storage.read(asset.localPath);
      if (sha256(file) !== metadata['sha256']) {
        continue;
      }
      const stored = metadata['boundariesSec'];
      const boundariesSec = Array.isArray(stored) && stored.every((v) => typeof v === 'number') ? (stored as number[]) : null;
      return { asset, file, info: parseWav(file), boundariesSec };
    } catch {
      continue;
    }
  }
  return null;
}

/** DOWNLOADING → (synthesize, validate, atomic write) → READY narration; FAILED + rethrow on error. */
async function synthesizeNarration(ctx: VoiceContext, request: VoiceRequest, cacheKey: string): Promise<NarrationAudio> {
  const { services, input, dir } = ctx;
  const { provider } = services;
  const prisma = getPrisma();
  const baseMetadata = {
    provider: provider.name,
    model: provider.model,
    voice: request.voice,
    language: request.language,
    speed: request.speed,
    style: request.style ?? null,
    cacheKey,
    mode: 'narration',
    sceneCount: request.paragraphs?.length ?? 0,
  };
  const asset = await prisma.asset.create({
    data: {
      videoId: input.videoId,
      type: NARRATION_ASSET_TYPE,
      provider: provider.name,
      status: AssetStatus.DOWNLOADING,
      mimeType: 'audio/wav',
      metadataJson: JSON.stringify(baseMetadata),
    },
  });
  try {
    const result = await provider.synthesize(request);
    const info = parseWav(result.audio);
    assertPlausibleDuration(info, request.text, 0, request.speed, 'Narration');
    // Audio that must be cut by detection has to contain speech; providers that know the exact
    // boundaries (silent/mock) may return anything, including pure silence.
    if (!result.boundariesSec) {
      assertSpeechCoverage(result.audio, estimateSpeechSeconds(request.text) / request.speed);
    }
    const boundariesSec = result.boundariesSec ?? null;
    if (boundariesSec && boundariesSec.length !== (request.paragraphs?.length ?? 0) - 1) {
      throw new VoiceError('INVALID_AUDIO', 'Provider returned the wrong number of narration boundaries');
    }
    const stored = await services.storage.writeAtomic(`${dir}/${NARRATION_FILE_BASE}.wav`, result.audio, { maxBytes: MAX_AUDIO_BYTES });
    const metadata = {
      ...baseMetadata,
      ...result.metadata,
      sha256: stored.sha256,
      sampleRate: info.sampleRate,
      channels: info.channels,
      durationSec: info.durationSec,
      boundariesSec,
    };
    const ready = await prisma.asset.update({
      where: { id: asset.id },
      data: {
        status: AssetStatus.READY,
        localPath: stored.localPath,
        sizeBytes: stored.sizeBytes,
        duration: info.durationSec,
        metadataJson: JSON.stringify(metadata),
      },
    });
    return { asset: ready, file: result.audio, info, boundariesSec };
  } catch (error) {
    await markFailed(asset.id, baseMetadata, error);
    throw error;
  }
}

interface CutScene {
  /** Absent for scenes that were not written (their cached file is kept). */
  asset?: Asset;
  durationSec: number;
  boundary: Pick<SplitBoundary, 'quality' | 'silenceMs'> | null;
}

/**
 * Cuts the narration (the cuts depend on each other, so the whole narration
 * is split) and writes a READY asset for every scene in `write`. A split
 * failure marks the narration FAILED so the next run synthesizes it again
 * instead of failing forever on cache.
 */
async function cutNarration(
  ctx: VoiceContext,
  narration: NarrationAudio,
  request: VoiceRequest,
  keys: readonly string[],
  write: readonly boolean[],
): Promise<CutScene[]> {
  const { services, scenes, texts, input, dir, log } = ctx;
  const { provider } = services;
  const prisma = getPrisma();

  let segments: Buffer[];
  let boundaries: SplitBoundary[];
  try {
    if (narration.boundariesSec) {
      segments = splitAt(narration.file, narration.boundariesSec);
      boundaries = narration.boundariesSec.map((sec, index) => ({ index, quality: 'detected' as const, silenceMs: 0, cutSec: sec }));
    } else {
      ({ segments, boundaries } = splitNarration(narration.file, texts));
    }
    segments.forEach((segment, i) => assertPlausibleDuration(parseWav(segment), texts[i] ?? '', i, request.speed));
  } catch (error) {
    await markFailed(narration.asset.id, parseMetadata(narration.asset), error);
    throw error;
  }
  for (const b of boundaries) {
    if (b.quality !== 'detected') {
      log(
        `VOICE warning: boundary between scenes ${b.index + 1} and ${b.index + 2} is ${b.quality}` +
          (b.silenceMs > 0 ? ` (pause ${b.silenceMs} ms)` : ' (no pause found; cut at the text estimate)'),
      );
    }
  }
  // Remember how the cuts were found next to the narration (for re-runs served from cache).
  await prisma.asset.update({
    where: { id: narration.asset.id },
    data: {
      metadataJson: JSON.stringify({
        ...parseMetadata(narration.asset),
        boundaries: boundaries.map((b) => ({ quality: b.quality, silenceMs: b.silenceMs })),
      }),
    },
  });

  const cut: CutScene[] = [];
  for (const [i, scene] of scenes.entries()) {
    const segment = segments[i];
    if (!segment) {
      throw new VoiceError('INVALID_AUDIO', `Narration split produced no audio for scene ${scene.index + 1}`);
    }
    const info = parseWav(segment);
    const boundary = boundaries[i];
    const boundaryMeta = boundary ? { quality: boundary.quality, silenceMs: boundary.silenceMs } : null;
    if (!write[i]) {
      cut.push({ durationSec: info.durationSec, boundary: boundaryMeta });
      continue;
    }
    const metadata = {
      provider: provider.name,
      model: provider.model,
      voice: request.voice,
      language: request.language,
      speed: request.speed,
      style: request.style ?? null,
      cacheKey: keys[i],
      sceneIndex: scene.index,
      narrationAssetId: narration.asset.id,
      boundary: boundaryMeta,
    };
    const stored = await services.storage.writeAtomic(`${dir}/${sceneFileBase(scene.index)}.wav`, segment, { maxBytes: MAX_AUDIO_BYTES });
    const asset = await prisma.asset.create({
      data: {
        videoId: input.videoId,
        type: AUDIO_ASSET_TYPE,
        provider: provider.name,
        status: AssetStatus.READY,
        mimeType: 'audio/wav',
        localPath: stored.localPath,
        sizeBytes: stored.sizeBytes,
        duration: info.durationSec,
        metadataJson: JSON.stringify({
          ...metadata,
          sha256: stored.sha256,
          sampleRate: info.sampleRate,
          channels: info.channels,
          durationSec: info.durationSec,
          words: null,
        }),
      },
    });
    cut.push({ asset, durationSec: info.durationSec, boundary: metadata.boundary });
  }
  return cut;
}

async function markFailed(assetId: string, metadata: Record<string, unknown>, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  await getPrisma().asset.update({
    where: { id: assetId },
    data: { status: AssetStatus.FAILED, metadataJson: JSON.stringify({ ...metadata, error: message }) },
  });
}

/** Returns the scene's current audio when it is READY, matches the cache key and the file is intact. */
async function reuseCached(
  voiceAssetId: string | null,
  cacheKey: string,
  services: VoiceServices,
): Promise<{ asset: Asset; durationSec: number } | null> {
  if (!voiceAssetId) {
    return null;
  }
  const asset = await getPrisma().asset.findUnique({ where: { id: voiceAssetId } });
  if (!asset || asset.type !== AUDIO_ASSET_TYPE || asset.status !== AssetStatus.READY || !asset.localPath) {
    return null;
  }
  const metadata = parseMetadata(asset);
  if (metadata['cacheKey'] !== cacheKey) {
    return null;
  }
  try {
    const file = await services.storage.read(asset.localPath);
    if (sha256(file) !== metadata['sha256']) {
      return null;
    }
    return { asset, durationSec: parseWav(file).durationSec };
  } catch {
    return null;
  }
}

/** DISCOVERED → DOWNLOADING → (synthesize, validate, atomic write) → READY; FAILED + rethrow on error. */
async function synthesizeScene(ctx: VoiceContext, request: VoiceRequest, cacheKey: string): Promise<{ asset: Asset; durationSec: number }> {
  const { services, input, dir } = ctx;
  const prisma = getPrisma();
  const { provider } = services;
  const baseMetadata = {
    provider: provider.name,
    model: provider.model,
    voice: request.voice,
    language: request.language,
    speed: request.speed,
    style: request.style ?? null,
    cacheKey,
    sceneIndex: request.sceneIndex,
  };
  const asset = await prisma.asset.create({
    data: {
      videoId: input.videoId,
      type: AUDIO_ASSET_TYPE,
      provider: provider.name,
      status: AssetStatus.DOWNLOADING,
      mimeType: 'audio/wav',
      metadataJson: JSON.stringify(baseMetadata),
    },
  });

  try {
    const result = await provider.synthesize(request);
    const info = parseWav(result.audio);
    assertPlausibleDuration(info, request.text, request.sceneIndex, request.speed);
    const stored = await services.storage.writeAtomic(`${dir}/${sceneFileBase(request.sceneIndex)}.wav`, result.audio, {
      maxBytes: MAX_AUDIO_BYTES,
    });
    const metadata = {
      ...baseMetadata,
      ...result.metadata,
      sha256: stored.sha256,
      sampleRate: info.sampleRate,
      channels: info.channels,
      durationSec: info.durationSec,
      words: result.words,
    };
    const ready = await prisma.asset.update({
      where: { id: asset.id },
      data: {
        status: AssetStatus.READY,
        localPath: stored.localPath,
        sizeBytes: stored.sizeBytes,
        duration: info.durationSec,
        metadataJson: JSON.stringify(metadata),
      },
    });
    return { asset: ready, durationSec: info.durationSec };
  } catch (error) {
    await markFailed(asset.id, baseMetadata, error);
    throw error;
  }
}

/** Deletes this video's audio/narration rows and files that are not used any more. */
async function cleanupStaleAudio(videoId: string, dir: string, keepIds: ReadonlySet<string>, services: VoiceServices): Promise<void> {
  const prisma = getPrisma();
  const where: Prisma.AssetWhereInput = { videoId, type: { in: [AUDIO_ASSET_TYPE, NARRATION_ASSET_TYPE] }, id: { notIn: [...keepIds] } };
  await prisma.asset.deleteMany({ where });
  const kept = await prisma.asset.findMany({ where: { id: { in: [...keepIds] } }, select: { localPath: true } });
  const keepPaths = new Set(kept.map((a) => a.localPath));
  for (const file of await services.storage.list(dir)) {
    if (!keepPaths.has(file)) {
      await services.storage.remove(file);
    }
  }
}
