/**
 * Read-only view of the storage tree the pipeline writes: <kind>/<projectId>/<videoId>.
 * Only directories named like the ids this app generates are considered, so a
 * sweep can never touch the database files or anything a human put there.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { DATA_KINDS, isSafeSegment, type DataKind, type LocalAssetStorage } from '../assets/storage.js';

export interface DataDir {
  kind: DataKind;
  projectId: string;
  videoId: string;
  /** "<kind>/<projectId>/<videoId>" */
  relativeDir: string;
}

/** Names of the directories directly inside a stored directory ([] when it does not exist). */
export async function subdirectories(storage: LocalAssetStorage, relativeDir: string): Promise<string[]> {
  try {
    const entries = await readdir(storage.resolve(relativeDir), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Names of the files directly inside a stored directory ([] when it does not exist). */
export async function files(storage: LocalAssetStorage, relativeDir: string): Promise<string[]> {
  try {
    const entries = await readdir(storage.resolve(relativeDir), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Every <kind>/<projectId>/<videoId> directory whose two ids look like ours. */
export async function listDataDirs(storage: LocalAssetStorage): Promise<DataDir[]> {
  const dirs: DataDir[] = [];
  for (const kind of DATA_KINDS) {
    for (const projectId of await subdirectories(storage, kind)) {
      if (!isSafeSegment(projectId)) {
        continue;
      }
      for (const videoId of await subdirectories(storage, `${kind}/${projectId}`)) {
        if (!isSafeSegment(videoId)) {
          continue;
        }
        dirs.push({ kind, projectId, videoId, relativeDir: `${kind}/${projectId}/${videoId}` });
      }
    }
  }
  return dirs;
}

/** Newest modification time of a directory and its direct children (a running render keeps writing). */
export async function lastTouched(storage: LocalAssetStorage, relativeDir: string): Promise<number> {
  const absolute = storage.resolve(relativeDir);
  try {
    let newest = (await stat(absolute)).mtimeMs;
    for (const entry of await readdir(absolute)) {
      const info = await stat(path.join(absolute, entry)).catch(() => null);
      newest = Math.max(newest, info?.mtimeMs ?? 0);
    }
    return newest;
  } catch {
    return Date.now(); // Unreadable: treat it as busy.
  }
}
