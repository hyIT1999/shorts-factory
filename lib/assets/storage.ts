/**
 * Local file storage rooted at data/. The database only ever stores paths
 * relative to this root (POSIX separators); absolute paths are resolved at
 * runtime with `resolve()`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { AssetBody } from './provider.js';
import { AssetError } from './types.js';

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

/** True for the ids this app generates (cuids) and nothing else; the only things allowed in paths. */
export function isSafeSegment(id: string): boolean {
  return SAFE_SEGMENT.test(id);
}

export interface StoredFile {
  /** Relative POSIX path inside the storage root, e.g. "assets/p/v/scene-01.png". */
  localPath: string;
  sizeBytes: number;
  sha256: string;
}

function videoDir(kind: 'assets' | 'audio' | 'renders' | 'tmp/render', projectId: string, videoId: string): string {
  for (const id of [projectId, videoId]) {
    if (!SAFE_SEGMENT.test(id)) {
      throw new AssetError('INVALID_PATH', `Unsafe id for an asset path: "${id}"`);
    }
  }
  return `${kind}/${projectId}/${videoId}`;
}

/** Directory (relative) for a video's visual assets. Ids must be simple identifiers. */
export function assetDir(projectId: string, videoId: string): string {
  return videoDir('assets', projectId, videoId);
}

/** Directory (relative) for a video's narration audio. */
export function audioDir(projectId: string, videoId: string): string {
  return videoDir('audio', projectId, videoId);
}

/** Directory (relative) for a video's final render (video.mp4). */
export function renderDir(projectId: string, videoId: string): string {
  return videoDir('renders', projectId, videoId);
}

/** Parent of every per-job render working directory. */
export const RENDER_TMP_ROOT = 'tmp/render';

/** Parent of a video's per-job render working directories. */
export function renderWorkRoot(projectId: string, videoId: string): string {
  return videoDir(RENDER_TMP_ROOT, projectId, videoId);
}

/** The kinds of per-video directories the pipeline writes: <kind>/<projectId>/<videoId>. */
export const DATA_KINDS = ['assets', 'audio', 'renders', RENDER_TMP_ROOT] as const;
export type DataKind = (typeof DATA_KINDS)[number];

/** Every directory (relative) that can hold a project's files, for deletion and sweeps. */
export function projectDirs(projectId: string): string[] {
  if (!SAFE_SEGMENT.test(projectId)) {
    throw new AssetError('INVALID_PATH', `Unsafe id for an asset path: "${projectId}"`);
  }
  return DATA_KINDS.map((kind) => `${kind}/${projectId}`);
}

/** Working directory (relative) of one render job: tmp/render/<p>/<v>/<jobId>. */
export function renderWorkDir(projectId: string, videoId: string, jobId: string): string {
  if (!SAFE_SEGMENT.test(jobId)) {
    throw new AssetError('INVALID_PATH', `Unsafe id for a render path: "${jobId}"`);
  }
  return `${renderWorkRoot(projectId, videoId)}/${jobId}`;
}

/** "scene-01" for index 0. */
export function sceneFileBase(sceneIndex: number): string {
  return `scene-${String(sceneIndex + 1).padStart(2, '0')}`;
}

export class LocalAssetStorage {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Validates a relative path and returns it normalized (POSIX). Throws INVALID_PATH otherwise. */
  normalize(relativePath: string): string {
    if (
      !relativePath ||
      relativePath.includes('\0') ||
      path.isAbsolute(relativePath) ||
      path.win32.isAbsolute(relativePath) ||
      /^[A-Za-z]:/.test(relativePath)
    ) {
      throw new AssetError('INVALID_PATH', `Not a relative storage path: "${relativePath}"`);
    }
    const segments = relativePath.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
    if (segments.length === 0 || segments.includes('..')) {
      throw new AssetError('INVALID_PATH', `Path escapes the storage root: "${relativePath}"`);
    }
    return segments.join('/');
  }

  /** Absolute path for a stored relative path; never outside the root. */
  resolve(relativePath: string): string {
    const absolute = path.resolve(this.root, this.normalize(relativePath));
    const relative = path.relative(this.root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new AssetError('INVALID_PATH', `Path escapes the storage root: "${relativePath}"`);
    }
    return absolute;
  }

  /**
   * Writes `body` to a temporary file next to the target and renames it into
   * place, so readers never see a partial file. The temp file is removed on error.
   */
  async writeAtomic(relativePath: string, body: AssetBody, options: { maxBytes?: number } = {}): Promise<StoredFile> {
    const localPath = this.normalize(relativePath);
    const target = this.resolve(localPath);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const temp = `${target}.${randomUUID()}.tmp`;
    const hash = createHash('sha256');
    let sizeBytes = 0;

    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        if (sizeBytes > maxBytes) {
          callback(new AssetError('STORAGE_ERROR', `File exceeds the ${maxBytes} byte limit`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await mkdir(path.dirname(target), { recursive: true });
      const source =
        body instanceof Uint8Array ? Readable.from([Buffer.from(body)]) : Readable.fromWeb(body as NodeReadableStream<Uint8Array>);
      await pipeline(source, meter, createWriteStream(temp, { flags: 'wx' }));
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      if (error instanceof AssetError) {
        throw error;
      }
      throw new AssetError('STORAGE_ERROR', `Could not write ${localPath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return { localPath, sizeBytes, sha256: hash.digest('hex') };
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      return (await stat(this.resolve(relativePath))).isFile();
    } catch {
      return false;
    }
  }

  /** Reads a stored file. */
  async read(relativePath: string): Promise<Buffer> {
    return readFile(this.resolve(relativePath));
  }

  /** Relative paths of the files directly inside a directory ([] when missing). */
  async list(relativeDir: string): Promise<string[]> {
    const dir = this.normalize(relativeDir);
    try {
      const entries = await readdir(this.resolve(dir), { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => `${dir}/${e.name}`).sort();
    } catch {
      return [];
    }
  }

  /** Removes one file inside the root (no-op when missing). */
  async remove(relativePath: string): Promise<void> {
    await rm(this.resolve(relativePath), { force: true });
  }

  /** Removes a directory tree inside the root (no-op when missing). */
  async removeDir(relativePath: string): Promise<void> {
    await rm(this.resolve(relativePath), { recursive: true, force: true });
  }
}
