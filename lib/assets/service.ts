/**
 * ASSETS stage orchestration: for every scene of a video, find candidates,
 * store the selected asset locally and link it to the scene.
 *
 * Idempotency: each run first removes the video's previous assets (DB rows and
 * files) and then recreates them, so a re-run always yields exactly one
 * selected READY asset per scene and no leftovers.
 *
 * Every downloaded image is checked from its header (real format and pixel
 * size, within limits) and, when it is larger than the render size, re-encoded
 * to 1080×1920 JPEG by the normalizer; a candidate that fails either step is
 * marked FAILED and the next one is tried.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { getPrisma } from '../db/prisma.js';
import { AssetStatus, type Asset } from '../generated/prisma/client.js';
import { ImageHeaderError, imageFormatOf, imageLimitViolation, parseImageInfo, readImageInfo, type ImageInfo } from './image-info.js';
import type { AssetServices } from './index.js';
import { needsNormalization, NORMALIZED_EXTENSION, NORMALIZED_HEIGHT, NORMALIZED_MIME_TYPE, NORMALIZED_WIDTH } from './normalize.js';
import type { AssetProvider } from './provider.js';
import { buildAssetQuery } from './query.js';
import { rankCandidates } from './select.js';
import { assetDir, sceneFileBase, type StoredFile } from './storage.js';
import {
  AssetError,
  AssetsResultSchema,
  type AssetCandidate,
  type AssetQuery,
  type AssetsResult,
  type FallbackReason,
} from './types.js';

/** Asset types managed by the ASSETS stage (audio belongs to VOICE). */
export const VISUAL_ASSET_TYPES = ['image', 'video'] as const;

/** At most this many candidates per scene are recorded and tried. */
export const MAX_CANDIDATES_PER_SCENE = 5;
const MAX_ASSET_BYTES = 100 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

export interface PrepareAssetsInput {
  projectId: string;
  videoId: string;
}

export type AssetLog = (message: string) => void;

type SceneResult = AssetsResult['scenes'][number];

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export async function prepareVideoAssets(
  input: PrepareAssetsInput,
  services: AssetServices,
  log: AssetLog = (message) => console.warn(message),
): Promise<AssetsResult> {
  const prisma = getPrisma();
  const dir = assetDir(input.projectId, input.videoId);

  // 1. Remove previous visual assets of this video (rows + files). Audio assets
  //    (type "audio", owned by VOICE) share the Asset table and must survive.
  await prisma.$transaction([
    prisma.scene.updateMany({ where: { videoId: input.videoId }, data: { assetId: null } }),
    prisma.asset.deleteMany({
      where: {
        type: { in: [...VISUAL_ASSET_TYPES] },
        OR: [{ videoId: input.videoId }, { scene: { videoId: input.videoId } }],
      },
    }),
  ]);
  await services.storage.removeDir(dir);

  // 2. Read the scenes.
  const scenes = await prisma.scene.findMany({
    where: { videoId: input.videoId },
    orderBy: { index: 'asc' },
    select: { id: true, index: true, text: true, duration: true, visualPrompt: true, visualType: true, startTime: true, endTime: true },
  });
  if (scenes.length === 0) {
    throw new Error('Video has no scenes; SCENES stage must run first');
  }

  // 3. One selected asset per scene.
  const usedKeys = new Set<string>();
  const results: SceneResult[] = [];
  for (const scene of scenes) {
    const query = buildAssetQuery(scene);
    const fileBase = `${dir}/${sceneFileBase(scene.index)}`;
    const outcome = await tryPrimary(services, query, input.videoId, scene.id, fileBase, usedKeys, log);
    let asset: Asset;
    if ('asset' in outcome) {
      asset = outcome.asset;
    } else if (services.fallbackMode === 'fail') {
      throw noAssetError(services.provider.name, query, outcome);
    } else {
      asset = await storeFallback(services, query, input.videoId, scene.id, fileBase, outcome.reason, outcome.error, log);
    }

    await prisma.scene.update({ where: { id: scene.id }, data: { assetId: asset.id } });
    const key = asset.externalId ? `${asset.provider}:${asset.externalId}` : null;
    if (key) {
      usedKeys.add(key);
    }
    results.push(toResult(scene.index, asset));
  }

  return AssetsResultSchema.parse({ provider: services.provider.name, scenes: results });
}

type NoAsset = { reason: FallbackReason; error?: string };
type PrimaryOutcome = { asset: Asset } | NoAsset;

/** The job error for ASSET_FALLBACK=fail: says which scene, why, and what to do. */
function noAssetError(provider: string, query: AssetQuery, outcome: NoAsset): AssetError {
  const detail = outcome.error ? `: ${outcome.error}` : '';
  const why: Record<FallbackReason, string> = {
    NO_CANDIDATES: `${provider} found nothing for "${query.text}"`,
    PROVIDER_ERROR: `${provider} search failed${detail}`,
    DOWNLOAD_FAILED: `no ${provider} result could be downloaded${detail}`,
    INVALID_IMAGE: `no ${provider} result was a usable image${detail}`,
  };
  return new AssetError(
    outcome.reason,
    `Scene ${query.sceneIndex + 1}: ${why[outcome.reason]} (ASSET_FALLBACK=fail: fix the cause and re-run ASSETS, or use ASSET_FALLBACK=placeholder)`,
  );
}

/** Search, record candidates, and store the best one that can be fetched and verified. */
async function tryPrimary(
  services: AssetServices,
  query: AssetQuery,
  videoId: string,
  sceneId: string,
  fileBase: string,
  usedKeys: ReadonlySet<string>,
  log: AssetLog,
): Promise<PrimaryOutcome> {
  let candidates: AssetCandidate[];
  try {
    candidates = await services.provider.search(query);
  } catch (error) {
    log(`Asset search failed for scene ${query.sceneIndex} (${services.provider.name}): ${errorText(error)}`);
    return { reason: 'PROVIDER_ERROR', error: errorText(error) };
  }
  if (candidates.length === 0) {
    return { reason: 'NO_CANDIDATES' };
  }

  const prisma = getPrisma();
  const ranked = rankCandidates(candidates, query, usedKeys).slice(0, MAX_CANDIDATES_PER_SCENE);
  const rows = [];
  for (const [rank, entry] of ranked.entries()) {
    const metadata = { ...entry.candidate.metadata, query: query.text, keywords: query.keywords, score: entry.score, rank, fallback: false };
    const row = await prisma.asset.create({ data: candidateRow(entry.candidate, videoId, sceneId, metadata) });
    rows.push({ row, candidate: entry.candidate, metadata });
  }

  let last: NoAsset | undefined;
  for (const { row, candidate, metadata } of rows) {
    try {
      return { asset: await storeCandidate(services.provider, services, candidate, row.id, fileBase, metadata) };
    } catch (error) {
      if (error instanceof AssetError && error.code === 'CONFIG') {
        throw error; // misconfiguration (e.g. no ffmpeg): no candidate can do better
      }
      const message = errorText(error);
      last = { reason: error instanceof AssetError && error.code === 'INVALID_IMAGE' ? 'INVALID_IMAGE' : 'DOWNLOAD_FAILED', error: message };
      log(`Asset ${candidate.provider}:${candidate.externalId ?? '-'} failed for scene ${query.sceneIndex}: ${message}`);
      await prisma.asset.update({
        where: { id: row.id },
        data: { status: AssetStatus.FAILED, metadataJson: JSON.stringify({ ...metadata, error: message }) },
      });
    }
  }
  return last ?? { reason: 'DOWNLOAD_FAILED' };
}

/** Placeholder asset for a scene whose primary provider produced nothing usable. Errors here are fatal. */
async function storeFallback(
  services: AssetServices,
  query: AssetQuery,
  videoId: string,
  sceneId: string,
  fileBase: string,
  reason: FallbackReason,
  error: string | undefined,
  log: AssetLog,
): Promise<Asset> {
  log(`Scene ${query.sceneIndex}: using ${services.fallback.name} fallback (${reason})`);
  const [candidate] = await services.fallback.search(query);
  if (!candidate) {
    throw new AssetError('PROVIDER_ERROR', `Fallback provider "${services.fallback.name}" returned no asset`);
  }
  const metadata = {
    ...candidate.metadata,
    query: query.text,
    keywords: query.keywords,
    fallback: true,
    fallbackReason: reason,
    ...(error ? { error } : {}),
  };
  const row = await getPrisma().asset.create({ data: candidateRow(candidate, videoId, sceneId, metadata) });
  return storeCandidate(services.fallback, services, candidate, row.id, fileBase, metadata);
}

/** What ends up on disk for a candidate, after verification and optional normalization. */
interface StoredVisual {
  file: StoredFile;
  width: number;
  height: number;
  mimeType: string;
  /** Extra metadata (normalization details). */
  details: Record<string, unknown>;
}

/** DOWNLOADING → (open + atomic write + image check/normalization) → READY. Throws on failure (caller decides). */
async function storeCandidate(
  provider: AssetProvider,
  services: AssetServices,
  candidate: AssetCandidate,
  assetId: string,
  fileBase: string,
  metadata: Record<string, unknown>,
): Promise<Asset> {
  const extension = EXTENSIONS[candidate.mimeType];
  if (!extension) {
    throw new AssetError('DOWNLOAD_FAILED', `Unsupported asset type "${candidate.mimeType}"`);
  }
  const prisma = getPrisma();
  await prisma.asset.update({ where: { id: assetId }, data: { status: AssetStatus.DOWNLOADING } });

  const body = await provider.open(candidate);
  const downloaded = await services.storage.writeAtomic(`${fileBase}.${extension}`, body, { maxBytes: MAX_ASSET_BYTES });
  let stored: StoredVisual = { file: downloaded, width: candidate.width, height: candidate.height, mimeType: candidate.mimeType, details: {} };
  if (candidate.kind === 'image') {
    try {
      stored = await checkAndNormalizeImage(services, candidate, downloaded, fileBase);
    } catch (error) {
      await services.storage.remove(downloaded.localPath);
      throw error;
    }
  }

  return prisma.asset.update({
    where: { id: assetId },
    data: {
      status: AssetStatus.READY,
      localPath: stored.file.localPath,
      sizeBytes: stored.file.sizeBytes,
      mimeType: stored.mimeType,
      width: stored.width,
      height: stored.height,
      metadataJson: JSON.stringify({ ...metadata, ...stored.details, sha256: stored.file.sha256 }),
    },
  });
}

/**
 * Verifies a downloaded image from its header (real format, size limits) and,
 * when it is bigger than the render size or heavy, replaces it with a
 * normalized 1080×1920 JPEG. Throws INVALID_IMAGE (the caller removes the download).
 */
async function checkAndNormalizeImage(
  services: AssetServices,
  candidate: AssetCandidate,
  downloaded: StoredFile,
  fileBase: string,
): Promise<StoredVisual> {
  const absolute = services.storage.resolve(downloaded.localPath);
  let info: ImageInfo;
  try {
    info = await readImageInfo(absolute);
  } catch (error) {
    throw new AssetError('INVALID_IMAGE', `Not a usable image: ${errorText(error)}`);
  }
  if (imageFormatOf(candidate.mimeType) !== info.format) {
    throw new AssetError('INVALID_IMAGE', `Provider declared ${candidate.mimeType} but the file is a ${info.format.toUpperCase()}`);
  }
  const violation = imageLimitViolation(info);
  if (violation) {
    throw new AssetError('INVALID_IMAGE', `Image ${violation}`);
  }
  if (!services.normalizer || !needsNormalization(info, downloaded.sizeBytes)) {
    return { file: downloaded, width: info.width, height: info.height, mimeType: candidate.mimeType, details: {} };
  }

  const temp = `${absolute}.${randomUUID()}.normalized`;
  try {
    await services.normalizer.normalize(absolute, temp);
    const bytes = await readFile(temp);
    let result: ImageInfo;
    try {
      result = parseImageInfo(bytes);
    } catch (error) {
      throw new AssetError('INVALID_IMAGE', `Normalized image is not a valid file: ${error instanceof ImageHeaderError ? error.message : errorText(error)}`);
    }
    if (result.format !== 'jpeg' || result.width !== NORMALIZED_WIDTH || result.height !== NORMALIZED_HEIGHT) {
      throw new AssetError(
        'INVALID_IMAGE',
        `Normalized image is ${result.width}×${result.height} ${result.format}, expected ${NORMALIZED_WIDTH}×${NORMALIZED_HEIGHT} jpeg`,
      );
    }
    const file = await services.storage.writeAtomic(`${fileBase}.${NORMALIZED_EXTENSION}`, bytes, { maxBytes: MAX_ASSET_BYTES });
    if (file.localPath !== downloaded.localPath) {
      await services.storage.remove(downloaded.localPath);
    }
    return {
      file,
      width: NORMALIZED_WIDTH,
      height: NORMALIZED_HEIGHT,
      mimeType: NORMALIZED_MIME_TYPE,
      details: {
        normalized: { tool: services.normalizer.name, width: NORMALIZED_WIDTH, height: NORMALIZED_HEIGHT },
        original: { width: info.width, height: info.height, mimeType: candidate.mimeType, sizeBytes: downloaded.sizeBytes, sha256: downloaded.sha256 },
      },
    };
  } finally {
    await rm(temp, { force: true });
  }
}

function candidateRow(candidate: AssetCandidate, videoId: string, sceneId: string, metadata: Record<string, unknown>) {
  return {
    videoId,
    sceneId,
    status: AssetStatus.DISCOVERED,
    type: candidate.kind,
    provider: candidate.provider,
    externalId: candidate.externalId,
    url: candidate.url,
    width: candidate.width,
    height: candidate.height,
    duration: candidate.durationSec,
    mimeType: candidate.mimeType,
    metadataJson: JSON.stringify(metadata),
  };
}

function toResult(sceneIndex: number, asset: Asset): SceneResult {
  const metadata = asset.metadataJson ? (JSON.parse(asset.metadataJson) as Record<string, unknown>) : {};
  return {
    sceneIndex,
    assetId: asset.id,
    kind: asset.type === 'video' ? 'video' : 'image',
    localPath: asset.localPath ?? '',
    width: asset.width ?? 0,
    height: asset.height ?? 0,
    durationSec: asset.duration,
    fallback: metadata['fallback'] === true,
    source: { provider: asset.provider, externalId: asset.externalId, url: asset.url },
  };
}
