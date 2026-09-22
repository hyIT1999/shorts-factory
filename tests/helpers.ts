/**
 * Test helpers: every test file (node:test runs each in its own process) gets
 * a throwaway SQLite database under data/, migrated with `prisma migrate
 * deploy`, and removed afterwards. The dev database is never touched.
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { AssetServices } from '../lib/assets/index.js';
import type { AssetProvider } from '../lib/assets/provider.js';
import { PlaceholderAssetProvider } from '../lib/assets/providers/placeholder.js';
import { LocalAssetStorage } from '../lib/assets/storage.js';
import { getPrisma } from '../lib/db/prisma.js';
import { runProcess } from '../lib/ffmpeg/process.js';
import type { RenderServices } from '../lib/render/types.js';
import type { VoiceServices } from '../lib/voice/index.js';
import type { VoiceProvider } from '../lib/voice/provider.js';
import { SilentVoiceProvider } from '../lib/voice/providers/silent.js';
import { createApp, type AppOptions } from '../server/app.js';
import { createProject, startGeneration } from '../server/services/projects.js';

export const TEST_DB_FILE = `data/test-${process.pid}.db`;
export const TEST_DATABASE_URL = `file:./${TEST_DB_FILE}`;

// getPrisma() creates its client lazily, so overriding here (after dotenv has
// loaded .env) makes every query in this process use the test database.
process.env['DATABASE_URL'] = TEST_DATABASE_URL;

export function migrateTestDb(): void {
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'ignore',
  });
}

export async function resetDb(): Promise<void> {
  const prisma = getPrisma();
  await prisma.$transaction([
    prisma.job.deleteMany(),
    prisma.asset.deleteMany(),
    prisma.scene.deleteMany(),
    prisma.video.deleteMany(),
    prisma.project.deleteMany(),
    prisma.setting.deleteMany(),
  ]);
}

const tempDirs: string[] = [];

/** A fresh temporary directory (removed by removeTestDb). */
export function makeTempDir(prefix = 'sf-test-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Asset services writing into a temporary storage root instead of data/. */
export function createTestAssetServices(provider: AssetProvider = new PlaceholderAssetProvider()): AssetServices {
  return { provider, fallback: new PlaceholderAssetProvider(), storage: new LocalAssetStorage(makeTempDir('sf-assets-')) };
}

/**
 * Render services for tests: the mock provider by default (validates inputs,
 * writes no video, never needs FFmpeg). Pass the storage shared with ASSETS
 * and VOICE, as the worker does.
 */
export function createTestRenderServices(storage: LocalAssetStorage, overrides: Partial<RenderServices> = {}): RenderServices {
  return {
    provider: 'mock',
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    timeoutMs: 60_000,
    fontsDir: makeTempDir('sf-fonts-'),
    storage,
    runner: runProcess,
    ...overrides,
  };
}

/** Voice services (silent provider, narration mode by default) writing into a temporary storage root. */
export function createTestVoiceServices(
  provider: VoiceProvider = new SilentVoiceProvider(),
  storage: LocalAssetStorage = new LocalAssetStorage(makeTempDir('sf-voice-')),
  overrides: Partial<VoiceServices> = {},
): VoiceServices {
  return { provider, voice: 'test-voice', speed: 1, mode: 'narration', requestDelayMs: 0, storage, ...overrides };
}

export async function removeTestDb(): Promise<void> {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  await getPrisma().$disconnect();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(`${TEST_DB_FILE}${suffix}`, { force: true });
  }
}

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Starts the API on a random port; without an explicit storage it uses a temporary root, never data/. */
export async function startTestServer(options: AppOptions = {}): Promise<TestServer> {
  const server: Server = await new Promise((resolve) => {
    const s = createApp({ storage: new LocalAssetStorage(makeTempDir('sf-server-')), ...options }).listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export interface JsonResponse<T> {
  status: number;
  body: T;
}

export async function request<T>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  rawBody?: string,
): Promise<JsonResponse<T>> {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (rawBody !== undefined) {
    init.body = rawBody;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, init);
  return { status: res.status, body: (await res.json()) as T };
}

/** Creates a project directly in the database and starts a generation for it. */
export async function createProjectWithGeneration(title: string, topic: string) {
  const project = await createProject({ title, topic });
  return startGeneration(project.id);
}
