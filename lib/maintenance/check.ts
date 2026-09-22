/**
 * Consistency check between the database and the files under data/: what a
 * user would otherwise discover as "COMPLETED but no video", a corrupt asset,
 * or directories nobody owns. Read-only; `npm run data:check`.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { LocalAssetStorage } from '../assets/storage.js';
import { getPrisma } from '../db/prisma.js';
import { AssetStatus, VideoStatus } from '../generated/prisma/client.js';
import { files, listDataDirs } from './scan.js';

export type DataIssueCode =
  | 'VIDEO_WITHOUT_OUTPUT'
  | 'OUTPUT_FILE_MISSING'
  | 'ASSET_FILE_MISSING'
  | 'ASSET_SIZE_MISMATCH'
  | 'ASSET_CHECKSUM_MISMATCH'
  | 'ASSET_STUCK'
  | 'ORPHAN_DIR'
  | 'TEMP_FILE';

export interface DataIssue {
  code: DataIssueCode;
  /** Video or asset id when the issue is about a row. */
  id?: string;
  /** Relative path when the issue is about a file or directory. */
  path?: string;
  detail: string;
}

export interface CheckReport {
  issues: DataIssue[];
  counts: { videos: number; readyAssets: number; dirs: number };
}

/** Candidates older than this that never became READY or FAILED are stuck (a worker died mid-download). */
const STUCK_ASSET_MS = 60 * 60_000;

async function sha256Of(absolutePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(absolutePath), hash);
  return hash.digest('hex');
}

/** Absolute path of a stored relative path, or null when it is not a valid storage path. */
function resolveOrNull(storage: LocalAssetStorage, relativePath: string): string | null {
  try {
    return storage.resolve(relativePath);
  } catch {
    return null;
  }
}

/** The sha256 recorded in Asset.metadataJson, if any. */
function storedSha256(metadataJson: string | null): string | null {
  try {
    const metadata = metadataJson ? (JSON.parse(metadataJson) as Record<string, unknown>) : {};
    return typeof metadata['sha256'] === 'string' ? metadata['sha256'] : null;
  } catch {
    return null;
  }
}

export async function checkData(storage: LocalAssetStorage, now: Date = new Date()): Promise<CheckReport> {
  const prisma = getPrisma();
  const issues: DataIssue[] = [];

  const videos = await prisma.video.findMany({ select: { id: true, projectId: true, status: true, outputPath: true } });
  for (const video of videos) {
    if (!video.outputPath) {
      if (video.status === VideoStatus.COMPLETED) {
        issues.push({ code: 'VIDEO_WITHOUT_OUTPUT', id: video.id, detail: `Video ${video.id} is COMPLETED but has no rendered file` });
      }
      continue;
    }
    const absolute = resolveOrNull(storage, video.outputPath);
    const info = absolute ? await stat(absolute).catch(() => null) : null;
    if (!info?.isFile() || info.size === 0) {
      issues.push({ code: 'OUTPUT_FILE_MISSING', id: video.id, path: video.outputPath, detail: `Video ${video.id}: ${video.outputPath} is missing or empty` });
    }
  }

  const ready = await prisma.asset.findMany({
    where: { status: AssetStatus.READY },
    select: { id: true, videoId: true, type: true, localPath: true, sizeBytes: true, metadataJson: true },
  });
  for (const asset of ready) {
    const label = `${asset.type} asset ${asset.id}`;
    if (!asset.localPath) {
      issues.push({ code: 'ASSET_FILE_MISSING', id: asset.id, detail: `${label} is READY but has no file path` });
      continue;
    }
    const absolute = resolveOrNull(storage, asset.localPath);
    const info = absolute ? await stat(absolute).catch(() => null) : null;
    if (!absolute || !info?.isFile()) {
      issues.push({ code: 'ASSET_FILE_MISSING', id: asset.id, path: asset.localPath, detail: `${label}: ${asset.localPath} is missing` });
      continue;
    }
    if (asset.sizeBytes !== null && info.size !== asset.sizeBytes) {
      issues.push({ code: 'ASSET_SIZE_MISMATCH', id: asset.id, path: asset.localPath, detail: `${label}: ${info.size} bytes on disk, ${asset.sizeBytes} in the database` });
      continue;
    }
    const expectedSha = storedSha256(asset.metadataJson);
    if (expectedSha && (await sha256Of(absolute)) !== expectedSha) {
      issues.push({ code: 'ASSET_CHECKSUM_MISMATCH', id: asset.id, path: asset.localPath, detail: `${label}: ${asset.localPath} does not match its checksum` });
    }
  }

  const stuck = await prisma.asset.findMany({
    where: { status: { in: [AssetStatus.DISCOVERED, AssetStatus.DOWNLOADING] }, createdAt: { lt: new Date(now.getTime() - STUCK_ASSET_MS) } },
    select: { id: true, status: true, type: true },
  });
  for (const asset of stuck) {
    issues.push({ code: 'ASSET_STUCK', id: asset.id, detail: `${asset.type} asset ${asset.id} has been ${asset.status} for more than an hour` });
  }

  const projectIds = new Set((await prisma.project.findMany({ select: { id: true } })).map((p) => p.id));
  const videoIds = new Set(videos.map((v) => v.id));
  const dirs = await listDataDirs(storage);
  for (const dir of dirs) {
    if (!projectIds.has(dir.projectId) || !videoIds.has(dir.videoId)) {
      issues.push({ code: 'ORPHAN_DIR', path: dir.relativeDir, detail: `${dir.relativeDir} belongs to no project/video in the database` });
      continue;
    }
    if (dir.kind === 'assets' || dir.kind === 'audio') {
      for (const name of await files(storage, dir.relativeDir)) {
        if (name.endsWith('.tmp')) {
          issues.push({ code: 'TEMP_FILE', path: `${dir.relativeDir}/${name}`, detail: `${dir.relativeDir}/${name} is a leftover temporary file` });
        }
      }
    }
  }

  return { issues, counts: { videos: videos.length, readyAssets: ready.length, dirs: dirs.length } };
}
