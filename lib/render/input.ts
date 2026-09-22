/**
 * RENDER inputs from the database. Source of truth: the scene timings written
 * by VOICE (Scene.startTime/endTime/duration, Video.duration), the selected
 * visual (Scene.assetId → READY image) and the narration (Scene.voiceAssetId →
 * READY audio whose WAV length matches the scene). Nothing is recomputed or
 * repaired here: any inconsistency fails the job with a specific code.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { imageLimitViolation, readImageInfo, type ImageInfo } from '../assets/image-info.js';
import type { LocalAssetStorage } from '../assets/storage.js';
import { getPrisma } from '../db/prisma.js';
import { toMs } from '../subtitles/timing.js';
import { parseWav } from '../voice/wav.js';
import { RenderError, type RenderErrorCode } from './errors.js';
import {
  IMAGE_MIME_TYPES,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_RENDER_DURATION_MS,
  MAX_RENDER_SCENES,
  TIMING_TOLERANCE_MS,
  type RenderInput,
  type RenderScene,
} from './types.js';

const assetFields = { type: true, status: true, localPath: true, mimeType: true, metadataJson: true } as const;

interface AssetRow {
  type: string;
  status: string;
  localPath: string | null;
  mimeType: string | null;
  metadataJson: string | null;
}

const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);

/** Absolute path of a stored file that must exist (and not exceed maxBytes). */
async function existingFile(
  storage: LocalAssetStorage,
  localPath: string,
  maxBytes: number,
  code: RenderErrorCode,
  label: string,
): Promise<string> {
  let absolute: string;
  try {
    absolute = storage.resolve(localPath);
  } catch {
    throw new RenderError(code, `${label} has an invalid file path`);
  }
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile() || info.size === 0) {
    throw new RenderError(code, `${label} file is missing`);
  }
  if (info.size > maxBytes) {
    throw new RenderError(code, `${label} file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  }
  return absolute;
}

async function visualPath(asset: AssetRow | null, storage: LocalAssetStorage, label: string): Promise<string> {
  const code = 'RENDER_MISSING_VISUAL_ASSET';
  if (!asset) {
    throw new RenderError(code, `${label} has no visual asset; ASSETS must complete first`);
  }
  if (asset.type !== 'image') {
    throw new RenderError(code, `${label} visual is a ${asset.type}; only images are supported`);
  }
  if (asset.status !== 'READY' || !asset.localPath) {
    throw new RenderError(code, `${label} visual asset is not ready`);
  }
  if (!IMAGE_MIME_TYPES.has(asset.mimeType ?? '')) {
    throw new RenderError(code, `${label} visual has an unsupported type (${asset.mimeType ?? 'unknown'})`);
  }
  const absolute = await existingFile(storage, asset.localPath, MAX_IMAGE_BYTES, code, `${label} image`);

  // The header must describe a real image of a size ffmpeg can decode without
  // exhausting memory (a 20000×20000 PNG would need 1.2 GB per frame).
  let info: ImageInfo;
  try {
    info = await readImageInfo(absolute, { maxBytes: MAX_IMAGE_BYTES });
  } catch {
    throw new RenderError('RENDER_INVALID_IMAGE', `${label} image is not a valid PNG, JPEG or WebP file`);
  }
  const violation = imageLimitViolation(info);
  if (violation) {
    throw new RenderError('RENDER_INVALID_IMAGE', `${label} image ${violation}`);
  }
  return absolute;
}

function storedSha256(asset: AssetRow): string | null {
  try {
    const metadata = asset.metadataJson ? (JSON.parse(asset.metadataJson) as Record<string, unknown>) : {};
    return typeof metadata['sha256'] === 'string' ? metadata['sha256'] : null;
  } catch {
    return null;
  }
}

async function audioPath(asset: AssetRow | null, storage: LocalAssetStorage, label: string, sceneMs: number): Promise<string> {
  const code = 'RENDER_MISSING_AUDIO_ASSET';
  if (!asset) {
    throw new RenderError(code, `${label} has no narration audio; VOICE must complete first`);
  }
  if (asset.type !== 'audio' || asset.status !== 'READY' || !asset.localPath) {
    throw new RenderError(code, `${label} narration audio is not ready`);
  }
  const absolute = await existingFile(storage, asset.localPath, MAX_AUDIO_BYTES, code, `${label} audio`);
  const bytes = await readFile(absolute);
  const expectedSha = storedSha256(asset);
  if (expectedSha && createHash('sha256').update(bytes).digest('hex') !== expectedSha) {
    throw new RenderError(code, `${label} audio file does not match its checksum`);
  }
  let durationMs: number;
  try {
    durationMs = parseWav(bytes).durationSec * 1000;
  } catch {
    throw new RenderError(code, `${label} audio is not a valid WAV file`);
  }
  if (Math.abs(durationMs - sceneMs) > TIMING_TOLERANCE_MS) {
    throw new RenderError(
      'RENDER_INVALID_SCENE',
      `${label} audio lasts ${Math.round(durationMs)} ms but the scene timing says ${sceneMs} ms`,
    );
  }
  return absolute;
}

export async function loadRenderInput(
  ids: { projectId: string; videoId: string },
  storage: LocalAssetStorage,
): Promise<RenderInput> {
  const prisma = getPrisma();
  const video = await prisma.video.findUnique({ where: { id: ids.videoId }, select: { duration: true } });
  if (!video) {
    throw new RenderError('RENDER_INVALID_VIDEO', 'Video not found');
  }
  if (!finite(video.duration) || video.duration <= 0) {
    throw new RenderError('RENDER_INVALID_VIDEO', 'Video has no duration; VOICE must complete first');
  }
  const durationMs = toMs(video.duration);
  if (durationMs > MAX_RENDER_DURATION_MS) {
    throw new RenderError('RENDER_INVALID_VIDEO', `Video lasts ${durationMs / 1000} s; at most ${MAX_RENDER_DURATION_MS / 1000} s can be rendered`);
  }

  const rows = await prisma.scene.findMany({
    where: { videoId: ids.videoId },
    orderBy: { index: 'asc' },
    select: {
      id: true,
      index: true,
      startTime: true,
      endTime: true,
      duration: true,
      selectedAsset: { select: assetFields },
      voiceAsset: { select: assetFields },
    },
  });
  if (rows.length === 0) {
    throw new RenderError('RENDER_INVALID_SCENE', 'Video has no scenes');
  }
  if (rows.length > MAX_RENDER_SCENES) {
    throw new RenderError('RENDER_INVALID_VIDEO', `Video has ${rows.length} scenes; at most ${MAX_RENDER_SCENES} can be rendered`);
  }

  const scenes: RenderScene[] = [];
  let previousEnd = 0;
  for (const [position, row] of rows.entries()) {
    const label = `Scene ${row.index + 1}`;
    if (row.index !== position) {
      throw new RenderError('RENDER_INVALID_SCENE', `Scene indexes must be contiguous from 0 (found ${row.index} at position ${position})`);
    }
    if (!finite(row.startTime) || !finite(row.endTime) || !finite(row.duration)) {
      throw new RenderError('RENDER_INVALID_SCENE', `${label} has no valid timing`);
    }
    const startMs = toMs(row.startTime);
    const endMs = toMs(row.endTime);
    if (startMs !== previousEnd) {
      throw new RenderError(
        'RENDER_INVALID_SCENE',
        position === 0 ? `${label} must start at 0` : `${label} does not start where the previous scene ends`,
      );
    }
    if (endMs <= startMs || Math.abs(toMs(row.duration) - (endMs - startMs)) > TIMING_TOLERANCE_MS) {
      throw new RenderError('RENDER_INVALID_SCENE', `${label} has inconsistent start/end/duration`);
    }
    previousEnd = endMs;

    scenes.push({
      id: row.id,
      index: row.index,
      startMs,
      endMs,
      imagePath: await visualPath(row.selectedAsset, storage, label),
      audioPath: await audioPath(row.voiceAsset, storage, label, endMs - startMs),
    });
  }
  if (Math.abs(previousEnd - durationMs) > TIMING_TOLERANCE_MS) {
    throw new RenderError('RENDER_INVALID_SCENE', 'Scenes do not end at Video.duration');
  }
  return { projectId: ids.projectId, videoId: ids.videoId, durationMs, scenes };
}
