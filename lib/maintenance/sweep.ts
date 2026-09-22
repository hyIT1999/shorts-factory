/**
 * Storage sweep (`npm run data:sweep`, dry-run unless --apply):
 *   1. directories of projects/videos that no longer exist (orphans);
 *   2. render working directories nobody touched for longer than a render may last;
 *   3. retention: files of video versions that are not the latest of their project
 *      and older than `retentionDays` (their Asset rows go too and outputPath is
 *      cleared, so the database never points at deleted files).
 * The latest version of every project is never touched, whatever its age or
 * status: it is what re-runs and the UI work with. Only directories named like
 * our ids under assets/, audio/, renders/ and tmp/render/ are ever removed.
 */
import type { LocalAssetStorage } from '../assets/storage.js';
import { RENDER_TMP_ROOT } from '../assets/storage.js';
import { getPrisma } from '../db/prisma.js';
import { DEFAULT_RENDER_TIMEOUT_MS } from '../render/types.js';
import { lastTouched, listDataDirs, subdirectories } from './scan.js';

export type SweepActionKind = 'ORPHAN_DIR' | 'STALE_TMP' | 'OLD_VERSION_FILES' | 'OLD_VERSION_ROWS';

export interface SweepAction {
  kind: SweepActionKind;
  /** Relative directory, or the video id for OLD_VERSION_ROWS. */
  target: string;
  applied: boolean;
  error?: string;
}

export interface SweepOptions {
  /** true: report only (default for the CLI). */
  dryRun: boolean;
  /** Files of non-latest versions older than this are removed. */
  retentionDays: number;
  /** A tmp/render job directory untouched for longer than this (plus a margin) is abandoned. */
  renderTimeoutMs?: number;
  now?: Date;
  log?: (message: string) => void;
}

export interface SweepReport {
  dryRun: boolean;
  actions: SweepAction[];
}

/** Same margin as the render service uses for its own sweep. */
const ABANDONED_MARGIN_MS = 600_000;
const DAY_MS = 24 * 60 * 60_000;

export async function sweepData(storage: LocalAssetStorage, options: SweepOptions): Promise<SweepReport> {
  const prisma = getPrisma();
  const now = options.now ?? new Date();
  const actions: SweepAction[] = [];

  const act = async (kind: SweepActionKind, target: string, run: () => Promise<unknown>): Promise<void> => {
    const action: SweepAction = { kind, target, applied: false };
    if (!options.dryRun) {
      try {
        await run();
        action.applied = true;
      } catch (error) {
        action.error = error instanceof Error ? error.message : String(error);
      }
    }
    actions.push(action);
    options.log?.(`${options.dryRun ? '[dry-run] ' : ''}${kind} ${target}${action.error ? ` FAILED: ${action.error}` : ''}`);
  };

  const projectIds = new Set((await prisma.project.findMany({ select: { id: true } })).map((p) => p.id));
  const videos = await prisma.video.findMany({ select: { id: true, projectId: true, version: true, createdAt: true } });
  const videoIds = new Set(videos.map((v) => v.id));
  const latestVersion = new Map<string, number>();
  for (const video of videos) {
    latestVersion.set(video.projectId, Math.max(latestVersion.get(video.projectId) ?? 0, video.version));
  }

  // 1. Orphans: directories whose project or video is gone.
  const dirs = await listDataDirs(storage);
  for (const dir of dirs) {
    if (!projectIds.has(dir.projectId) || !videoIds.has(dir.videoId)) {
      await act('ORPHAN_DIR', dir.relativeDir, () => storage.removeDir(dir.relativeDir));
    }
  }

  // 2. Abandoned render working directories of existing videos.
  const abandonedBefore = now.getTime() - ((options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS) + ABANDONED_MARGIN_MS);
  for (const dir of dirs) {
    if (dir.kind !== RENDER_TMP_ROOT || !projectIds.has(dir.projectId) || !videoIds.has(dir.videoId)) {
      continue;
    }
    for (const jobId of await subdirectories(storage, dir.relativeDir)) {
      const workDir = `${dir.relativeDir}/${jobId}`;
      if ((await lastTouched(storage, workDir)) < abandonedBefore) {
        await act('STALE_TMP', workDir, () => storage.removeDir(workDir));
      }
    }
  }

  // 3. Retention for old, non-latest versions.
  const cutoff = new Date(now.getTime() - options.retentionDays * DAY_MS);
  const present = new Set(dirs.map((d) => d.relativeDir));
  for (const video of videos) {
    if (video.version === latestVersion.get(video.projectId) || video.createdAt >= cutoff) {
      continue;
    }
    let hadFiles = false;
    for (const kind of ['assets', 'audio', 'renders'] as const) {
      const dir = `${kind}/${video.projectId}/${video.id}`;
      if (present.has(dir)) {
        hadFiles = true;
        await act('OLD_VERSION_FILES', dir, () => storage.removeDir(dir));
      }
    }
    if (hadFiles) {
      await act('OLD_VERSION_ROWS', video.id, () =>
        prisma.$transaction([
          prisma.asset.deleteMany({ where: { videoId: video.id } }),
          prisma.video.update({ where: { id: video.id }, data: { outputPath: null } }),
        ]),
      );
    }
  }

  return { dryRun: options.dryRun, actions };
}
