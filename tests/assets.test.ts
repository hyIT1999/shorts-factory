/**
 * Unit tests for lib/assets (no database, no network).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { crc32, inflateSync } from 'node:zlib';
import { openRemote, type FetchFn } from '../lib/assets/download.js';
import { createAssetProviderFromEnv, createAssetServicesFromEnv } from '../lib/assets/index.js';
import { MockAssetProvider } from '../lib/assets/providers/mock.js';
import { PlaceholderAssetProvider, renderPlaceholderPng } from '../lib/assets/providers/placeholder.js';
import { buildAssetQuery, extractKeywords, MAX_KEYWORDS } from '../lib/assets/query.js';
import { rankCandidates } from '../lib/assets/select.js';
import { assetDir, LocalAssetStorage, sceneFileBase } from '../lib/assets/storage.js';
import { AssetError, type AssetCandidate, type AssetQuery } from '../lib/assets/types.js';

const tempDirs: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sf-assets-unit-'));
  tempDirs.push(dir);
  return dir;
}
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function expectAssetError(promise: Promise<unknown> | (() => unknown), code: AssetError['code']): Promise<void> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    assert.ok(error instanceof AssetError, `expected AssetError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return;
  }
  assert.fail('expected an AssetError');
}

/** Parses a PNG, verifying signature, chunk CRCs and IDAT size. */
function parsePng(png: Buffer) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  let offset = 8;
  const chunks: { type: string; data: Buffer }[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crc = png.readUInt32BE(offset + 8 + length);
    assert.equal(crc, crc32(png.subarray(offset + 4, offset + 8 + length)), `CRC of ${type}`);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  const ihdr = chunks[0]!.data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  return { width, height, bitDepth: ihdr[8], colorType: ihdr[9], rawLength: raw.length };
}

const SHARK_PROMPT =
  'Cinematic underwater shot of a dark ocean abyss with a silhouette of a ancient shark swimming, dark documentary style, moody cinematic lighting';

function query(overrides: Partial<AssetQuery> = {}): AssetQuery {
  return { ...buildAssetQuery({ index: 0, duration: 5, visualPrompt: SHARK_PROMPT, visualType: 'video' }), ...overrides };
}

function candidate(overrides: Partial<AssetCandidate>): AssetCandidate {
  return {
    provider: 'test',
    externalId: 'x',
    kind: 'image',
    url: null,
    width: 1080,
    height: 1920,
    durationSec: null,
    mimeType: 'image/png',
    metadata: {},
    ...overrides,
  };
}

describe('placeholder PNG', () => {
  test('is a valid 1080×1920 RGB PNG', () => {
    const info = parsePng(renderPlaceholderPng('abc123abc123'));
    assert.equal(info.width, 1080);
    assert.equal(info.height, 1920);
    assert.equal(info.bitDepth, 8);
    assert.equal(info.colorType, 2);
    assert.equal(info.rawLength, 1920 * (1 + 1080 * 3));
  });

  test('is deterministic per scene and differs between scenes', async () => {
    const provider = new PlaceholderAssetProvider();
    const [a1] = await provider.search(query());
    const [a2] = await provider.search(query());
    const [b] = await provider.search(query({ sceneIndex: 1 }));
    assert.ok(a1 && a2 && b);
    assert.deepEqual(a1, a2);
    assert.equal(a1.kind, 'image');
    assert.equal(a1.mimeType, 'image/png');
    assert.equal(a1.url, null);
    assert.equal(a1.externalId, null);
    assert.ok(Buffer.from((await provider.open(a1)) as Uint8Array).equals(Buffer.from((await provider.open(a2)) as Uint8Array)));
    assert.ok(!Buffer.from((await provider.open(a1)) as Uint8Array).equals(Buffer.from((await provider.open(b)) as Uint8Array)));
  });
});

describe('LocalAssetStorage', () => {
  test('writes atomically and returns a relative POSIX path', async () => {
    const root = tempRoot();
    const storage = new LocalAssetStorage(root);
    const stored = await storage.writeAtomic('assets/p1/v1/scene-01.png', Buffer.from('hello'));
    assert.equal(stored.localPath, 'assets/p1/v1/scene-01.png');
    assert.equal(stored.sizeBytes, 5);
    assert.match(stored.sha256, /^[0-9a-f]{64}$/);
    assert.equal(path.isAbsolute(stored.localPath), false);
    assert.equal(readFileSync(storage.resolve(stored.localPath), 'utf8'), 'hello');
    assert.equal(storage.resolve(stored.localPath), path.join(root, 'assets', 'p1', 'v1', 'scene-01.png'));
    assert.deepEqual(readdirSync(path.join(root, 'assets/p1/v1')), ['scene-01.png'], 'no temp files left');
    assert.equal(await storage.exists('assets/p1/v1/scene-01.png'), true);
  });

  test('normalizes backslashes and "." segments', async () => {
    const storage = new LocalAssetStorage(tempRoot());
    const stored = await storage.writeAtomic('assets\\a\\.\\b.png', Buffer.from('x'));
    assert.equal(stored.localPath, 'assets/a/b.png');
  });

  test('rejects path traversal and absolute paths', async () => {
    const storage = new LocalAssetStorage(tempRoot());
    for (const bad of ['../x.png', 'assets/../../x.png', '/etc/passwd', 'C:\\Windows\\x.png', 'C:x.png', '\\\\server\\share\\x', '', '..']) {
      await expectAssetError(() => storage.resolve(bad), 'INVALID_PATH');
      await expectAssetError(storage.writeAtomic(bad, Buffer.from('x')), 'INVALID_PATH');
    }
    await expectAssetError(() => assetDir('../p', 'v'), 'INVALID_PATH');
    await expectAssetError(() => assetDir('p', 'v/../../x'), 'INVALID_PATH');
    assert.equal(assetDir('p1', 'v_2-x'), 'assets/p1/v_2-x');
    assert.equal(sceneFileBase(0), 'scene-01');
    assert.equal(sceneFileBase(9), 'scene-10');
  });

  test('a failing stream leaves the previous file intact and no temp file', async () => {
    const root = tempRoot();
    const storage = new LocalAssetStorage(root);
    await storage.writeAtomic('assets/p/v/scene-01.png', Buffer.from('old content'));
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
        controller.error(new Error('connection reset'));
      },
    });
    await expectAssetError(storage.writeAtomic('assets/p/v/scene-01.png', failing), 'STORAGE_ERROR');
    assert.equal(readFileSync(path.join(root, 'assets/p/v/scene-01.png'), 'utf8'), 'old content');
    assert.deepEqual(readdirSync(path.join(root, 'assets/p/v')), ['scene-01.png']);
  });

  test('enforces maxBytes while streaming', async () => {
    const root = tempRoot();
    const storage = new LocalAssetStorage(root);
    await expectAssetError(storage.writeAtomic('assets/big.bin', Buffer.alloc(100), { maxBytes: 10 }), 'STORAGE_ERROR');
    assert.deepEqual(readdirSync(path.join(root, 'assets')), []);
  });

  test('removeDir only removes inside the root', async () => {
    const root = tempRoot();
    const outside = path.join(path.dirname(root), `${path.basename(root)}-sibling.txt`);
    writeFileSync(outside, 'keep');
    const storage = new LocalAssetStorage(root);
    await storage.writeAtomic('assets/p/v/a.png', Buffer.from('x'));
    await storage.removeDir('assets/p/v');
    assert.equal(await storage.exists('assets/p/v/a.png'), false);
    await expectAssetError(storage.removeDir(`../${path.basename(outside)}`), 'INVALID_PATH');
    assert.equal(readFileSync(outside, 'utf8'), 'keep');
    rmSync(outside);
  });
});

describe('provider selection', () => {
  test('createAssetProviderFromEnv', () => {
    assert.ok(createAssetProviderFromEnv({}) instanceof PlaceholderAssetProvider);
    assert.ok(createAssetProviderFromEnv({ ASSET_PROVIDER: 'placeholder' }) instanceof PlaceholderAssetProvider);
    assert.ok(createAssetProviderFromEnv({ ASSET_PROVIDER: ' Mock ' }) instanceof MockAssetProvider);
    assert.throws(
      () => createAssetProviderFromEnv({ ASSET_PROVIDER: 'unsplash' }),
      (error: unknown) => error instanceof AssetError && error.code === 'CONFIG' && /Unknown ASSET_PROVIDER "unsplash"/.test(error.message),
    );
  });

  test('createAssetServicesFromEnv uses DATA_DIR (default data/) as storage root', () => {
    assert.equal(createAssetServicesFromEnv({}).storage.root, path.resolve('data'));
    const root = tempRoot();
    const services = createAssetServicesFromEnv({ DATA_DIR: root, ASSET_PROVIDER: 'mock' });
    assert.equal(services.storage.root, path.resolve(root));
    assert.equal(services.provider.name, 'mock');
    assert.equal(services.fallback.name, 'placeholder');
  });
});

describe('query transformation', () => {
  test('keeps subject keywords and drops style/camera words', () => {
    assert.deepEqual(extractKeywords(SHARK_PROMPT), ['underwater', 'ocean', 'abyss', 'silhouette', 'ancient', 'shark']);
    assert.deepEqual(
      extractKeywords("Extreme close up of a shark's sharp rows of teeth inside its mouth, dark ominous lighting, documentary style"),
      ['shark', 'sharp', 'rows', 'teeth', 'inside', 'mouth'],
    );
    assert.deepEqual(extractKeywords('Time-lapse of a dark bedroom as night passes, slow camera push'), [
      'bedroom',
      'night',
      'passes',
    ]);
    assert.deepEqual(extractKeywords('Close-up, slow-motion shot of a hand-drawn map'), ['hand-drawn', 'map']);
  });

  test('deduplicates, caps the length and handles empty prompts', () => {
    assert.deepEqual(extractKeywords('shark shark SHARK ocean, ocean'), ['shark', 'ocean']);
    assert.equal(extractKeywords('one two three four five six seven eight nine').length, MAX_KEYWORDS);
    assert.deepEqual(extractKeywords(''), []);
    assert.deepEqual(extractKeywords('cinematic moody dramatic lighting, 4k'), []);
  });

  test('buildAssetQuery maps scene fields', () => {
    const q = buildAssetQuery({ index: 3, duration: 6.5, visualPrompt: SHARK_PROMPT, visualType: 'image' });
    assert.equal(q.sceneIndex, 3);
    assert.equal(q.preferredKind, 'image');
    assert.equal(q.minDurationSec, 6.5);
    assert.equal(q.text, 'underwater ocean abyss silhouette ancient shark');
    assert.equal(q.orientation, 'portrait');
    assert.equal(buildAssetQuery({ index: 0, duration: null, visualPrompt: null, visualType: null }).preferredKind, 'video');
  });
});

describe('deterministic selection', () => {
  test('prefers the scene kind, portrait orientation and resolution', () => {
    const candidates = [
      candidate({ externalId: 'landscape-video', kind: 'video', width: 1920, height: 1080, durationSec: 10 }),
      candidate({ externalId: 'portrait-image', kind: 'image' }),
      candidate({ externalId: 'portrait-video', kind: 'video', durationSec: 10 }),
      candidate({ externalId: 'small-portrait-video', kind: 'video', width: 360, height: 640, durationSec: 10 }),
    ];
    const ranked = rankCandidates(candidates, query({ preferredKind: 'video' }));
    assert.deepEqual(
      ranked.map((r) => r.candidate.externalId),
      ['portrait-video', 'small-portrait-video', 'landscape-video', 'portrait-image'],
    );
    const forImage = rankCandidates(candidates, query({ preferredKind: 'image' }));
    assert.equal(forImage[0]?.candidate.externalId, 'portrait-image');
  });

  test('a video long enough for the scene beats a short one', () => {
    const ranked = rankCandidates(
      [candidate({ externalId: 'short', kind: 'video', durationSec: 2 }), candidate({ externalId: 'long', kind: 'video', durationSec: 8 })],
      query({ minDurationSec: 6 }),
    );
    assert.equal(ranked[0]?.candidate.externalId, 'long');
  });

  test('duplicates within the video go last; ties keep provider order; output is stable', () => {
    const candidates = [candidate({ externalId: 'a' }), candidate({ externalId: 'b' }), candidate({ externalId: 'c' })];
    const ranked = rankCandidates(candidates, query(), new Set(['test:a']));
    assert.deepEqual(ranked.map((r) => r.candidate.externalId), ['b', 'c', 'a']);
    assert.equal(ranked[2]?.duplicate, true);
    assert.deepEqual(rankCandidates(candidates, query()), rankCandidates(candidates, query()));
  });
});

describe('openRemote', () => {
  const ok = (headers: Record<string, string>, body = 'data'): FetchFn => async () => new Response(body, { status: 200, headers });

  test('returns a stream for an allowed https image', async () => {
    const remote = await openRemote('https://images.pexels.com/x.jpg', {
      allowedHosts: ['pexels.com'],
      maxBytes: 100,
      fetch: ok({ 'content-type': 'image/jpeg; charset=binary', 'content-length': '4' }),
    });
    assert.equal(remote.mimeType, 'image/jpeg');
    assert.equal(remote.contentLength, 4);
    assert.equal(await new Response(remote.body).text(), 'data');
  });

  test('rejects unsafe or unexpected downloads', async () => {
    const opts = { allowedHosts: ['pexels.com'], maxBytes: 100 };
    const fetchImage = ok({ 'content-type': 'image/jpeg' });
    await expectAssetError(openRemote('http://images.pexels.com/x.jpg', { ...opts, fetch: fetchImage }), 'DOWNLOAD_FAILED');
    await expectAssetError(openRemote('https://evil.example.com/x.jpg', { ...opts, fetch: fetchImage }), 'DOWNLOAD_FAILED');
    await expectAssetError(openRemote('https://notpexels.com/x.jpg', { ...opts, fetch: fetchImage }), 'DOWNLOAD_FAILED');
    await expectAssetError(openRemote('not a url', { ...opts, fetch: fetchImage }), 'DOWNLOAD_FAILED');
    await expectAssetError(openRemote('https://pexels.com/x', { ...opts, fetch: ok({ 'content-type': 'text/html' }) }), 'DOWNLOAD_FAILED');
    await expectAssetError(
      openRemote('https://pexels.com/x', { ...opts, fetch: ok({ 'content-type': 'video/mp4', 'content-length': '5000' }) }),
      'DOWNLOAD_FAILED',
    );
    await expectAssetError(
      openRemote('https://pexels.com/x', { ...opts, fetch: async () => new Response('nope', { status: 404 }) }),
      'DOWNLOAD_FAILED',
    );
  });

  test('times out', async () => {
    const hanging: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    await expectAssetError(
      openRemote('https://pexels.com/x', { allowedHosts: ['pexels.com'], maxBytes: 10, timeoutMs: 5, fetch: hanging }),
      'DOWNLOAD_FAILED',
    );
  });
});
