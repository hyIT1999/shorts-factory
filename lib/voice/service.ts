/**
 * VOICE stage orchestration: one narration file per scene.
 *
 * Source of truth: Scene.text (ordered by index), Video.scriptJson.language
 * (fallback Channel DNA), voice from config, tone from Channel DNA. The AI
 * scene timings are only estimates: after all scenes have audio, scene
 * durations/start/end and Video.duration are recomputed from the real audio.
 *
 * Consistency: a file is written atomically before its Asset becomes READY,
 * and Scene.voiceAssetId only ever points at READY assets. Any failure fails
 * the job (no silent fallback); scenes already voiced stay READY and are
 * reused from cache on the next run.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { audioDir, sceneFileBase } from '../assets/storage.js';
import { getPrisma } from '../db/prisma.js';
import { AssetStatus, type Asset } from '../generated/prisma/client.js';
import { getChannelDna } from '../settings/channel-dna.js';
import { voiceCacheKey } from './cache.js';
import { VoiceError } from './errors.js';
import type { VoiceServices } from './index.js';
import { assertVietnamese, estimateSpeechSeconds, normalizeLanguage, normalizeNarration } from './text.js';
import { MAX_SPEED, MIN_SPEED, VoiceJobResultSchema, type VoiceJobResult, type VoiceRequest } from './types.js';
import { parseWav, type WavInfo } from './wav.js';

export const AUDIO_ASSET_TYPE = 'audio';
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
export function assertPlausibleDuration(info: WavInfo, text: string, sceneIndex: number, speed: number): void {
  const expected = estimateSpeechSeconds(text) / speed;
  const min = Math.max(MIN_AUDIO_SECONDS, expected * 0.25);
  const max = expected * 4 + 2;
  if (info.durationSec < min || info.durationSec > max) {
    throw new VoiceError(
      'INVALID_AUDIO',
      `Scene ${sceneIndex + 1} audio lasts ${info.durationSec.toFixed(2)}s, expected ${min.toFixed(1)}–${max.toFixed(1)}s for its text`,
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

  // 3. One audio file per scene, sequentially (free-tier friendly).
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
      results.push({ sceneId: scene.id, sceneIndex: scene.index, asset: reused.asset, durationSec: reused.durationSec, cached: true });
      continue;
    }

    if (apiCalls > 0 && services.requestDelayMs > 0) {
      await sleep(services.requestDelayMs);
    }
    apiCalls++;
    log(`VOICE scene ${scene.index + 1}/${scenes.length}: synthesizing with ${provider.name} (${provider.model})`);
    const { asset, durationSec } = await synthesizeScene(input, dir, request, cacheKey, services);
    await prisma.scene.update({ where: { id: scene.id }, data: { voiceAssetId: asset.id } });
    results.push({ sceneId: scene.id, sceneIndex: scene.index, asset, durationSec, cached: false });
  }

  // 4. Timing from real audio: contiguous scenes, Video.duration = total.
  let cursor = 0;
  const timed = results.map((r) => {
    const durationSec = round3(r.durationSec);
    const startTime = cursor;
    cursor = round3(cursor + durationSec);
    return { ...r, durationSec, startTime, endTime: cursor };
  });
  const total = cursor;
  await prisma.$transaction([
    ...timed.map((t) =>
      prisma.scene.update({ where: { id: t.sceneId }, data: { duration: t.durationSec, startTime: t.startTime, endTime: t.endTime } }),
    ),
    prisma.video.update({ where: { id: input.videoId }, data: { duration: total } }),
  ]);

  // 5. Remove stale audio rows and files of this video.
  await cleanupStaleAudio(input.videoId, dir, new Set(results.map((r) => r.asset.id)), services);

  log(`VOICE done: ${results.length} scenes, ${total.toFixed(2)}s, ${apiCalls} TTS call(s), ${results.length - apiCalls} cached`);
  return VoiceJobResultSchema.parse({
    provider: provider.name,
    model: provider.model,
    videoId: input.videoId,
    durationSec: total,
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
    })),
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
async function synthesizeScene(
  input: VoiceInput,
  dir: string,
  request: VoiceRequest,
  cacheKey: string,
  services: VoiceServices,
): Promise<{ asset: Asset; durationSec: number }> {
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
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await prisma.asset.update({
      where: { id: asset.id },
      data: { status: AssetStatus.FAILED, metadataJson: JSON.stringify({ ...baseMetadata, error: message }) },
    });
    throw error;
  }
}

/** Deletes this video's audio rows and files that no scene uses any more. */
async function cleanupStaleAudio(videoId: string, dir: string, keepIds: ReadonlySet<string>, services: VoiceServices): Promise<void> {
  const prisma = getPrisma();
  await prisma.asset.deleteMany({ where: { videoId, type: AUDIO_ASSET_TYPE, id: { notIn: [...keepIds] } } });
  const kept = await prisma.asset.findMany({ where: { id: { in: [...keepIds] } }, select: { localPath: true } });
  const keepPaths = new Set(kept.map((a) => a.localPath));
  for (const file of await services.storage.list(dir)) {
    if (!keepPaths.has(file)) {
      await services.storage.remove(file);
    }
  }
}
