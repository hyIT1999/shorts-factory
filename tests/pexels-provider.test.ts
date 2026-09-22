/**
 * Pexels provider unit tests with a fake fetch: request shape, candidate
 * mapping, filtering, retries on 429/5xx, error mapping, downloads and the
 * configuration factories. No network.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { FetchFn } from '../lib/assets/download.js';
import { createAssetProviderFromEnv, createAssetServicesFromEnv, fallbackModeFromEnv } from '../lib/assets/index.js';
import { PEXELS_SEARCH_URL, PexelsAssetProvider, rateLimitResetMs, type PexelsProviderOptions } from '../lib/assets/providers/pexels.js';
import { buildAssetQuery } from '../lib/assets/query.js';
import { AssetError, type AssetCandidate } from '../lib/assets/types.js';

interface Call {
  url: string;
  init: RequestInit;
}

function photo(id: number, width = 3000, height = 4500, extra: Record<string, unknown> = {}) {
  return {
    id,
    width,
    height,
    url: `https://www.pexels.com/photo/${id}/`,
    photographer: `Photographer ${id}`,
    photographer_url: `https://www.pexels.com/@p${id}`,
    alt: `Alt ${id}`,
    avg_color: '#123456',
    src: {
      original: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg`,
      portrait: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800`,
    },
    liked: false,
    ...extra,
  };
}

function fakeFetch(responses: Array<() => Response>): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) {
      throw new Error('unexpected fetch');
    }
    return next();
  };
  return { fetch, calls };
}

const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}): (() => Response) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function provider(fetch: FetchFn, options: Partial<PexelsProviderOptions> = {}): PexelsAssetProvider {
  return new PexelsAssetProvider({ apiKey: 'test-key', fetch, ...options });
}

const assetError =
  (code: AssetError['code'], pattern = /./, retryable?: boolean) =>
  (error: unknown): boolean =>
    error instanceof AssetError &&
    error.code === code &&
    pattern.test(error.message) &&
    (retryable === undefined || error.retryable === retryable);

const query = buildAssetQuery({ index: 0, duration: 5, visualPrompt: 'Cinematic shot of ancient Rome colosseum at sunset', visualType: 'image' });

describe('PexelsAssetProvider.search', () => {
  test('sends one authenticated portrait search and maps photos to candidates', async () => {
    const png = photo(2, 2000, 3000, { src: { original: 'https://images.pexels.com/photos/2/pexels-photo-2.png' } });
    const { fetch, calls } = fakeFetch([json({ page: 1, per_page: 15, photos: [photo(1), png], total_results: 2 })]);
    const candidates = await provider(fetch, { perPage: 15 }).search(query);

    assert.equal(calls.length, 1);
    const url = new URL(calls[0]?.url ?? '');
    assert.equal(`${url.origin}${url.pathname}`, PEXELS_SEARCH_URL);
    assert.equal(url.searchParams.get('query'), 'ancient rome colosseum sunset');
    assert.equal(url.searchParams.get('orientation'), 'portrait');
    assert.equal(url.searchParams.get('per_page'), '15');
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'test-key');
    assert.equal(calls[0]?.init.redirect, 'error');

    assert.equal(candidates.length, 2);
    const [first, second] = candidates;
    assert.deepEqual(
      [first?.provider, first?.externalId, first?.kind, first?.width, first?.height, first?.durationSec, first?.mimeType],
      ['pexels', '1', 'image', 3000, 4500, null, 'image/jpeg'],
    );
    const download = new URL(first?.url ?? '');
    assert.equal(download.hostname, 'images.pexels.com');
    assert.equal(download.pathname, '/photos/1/pexels-photo-1.jpeg');
    assert.deepEqual(
      ['fit', 'w', 'h', 'auto'].map((k) => download.searchParams.get(k)),
      ['crop', '1080', '1920', 'compress'],
    );
    assert.equal(first?.metadata['attribution'], 'Photo by Photographer 1 on Pexels');
    assert.equal(first?.metadata['pageUrl'], 'https://www.pexels.com/photo/1/');
    assert.equal(first?.metadata['photographerUrl'], 'https://www.pexels.com/@p1');
    assert.equal(first?.metadata['license'], 'Pexels License');
    assert.equal(first?.metadata['alt'], 'Alt 1');
    assert.equal(second?.mimeType, 'image/png');
  });

  test('drops photos that are too small or repeated, and searches nothing for an empty prompt', async () => {
    const { fetch, calls } = fakeFetch([json({ photos: [photo(1, 500, 900), photo(2), photo(2), photo(3, 900, 700)] })]);
    const p = provider(fetch);
    const found = await p.search(query);
    assert.deepEqual(
      found.map((c) => c.externalId),
      ['2'],
    );
    assert.deepEqual(await p.search(buildAssetQuery({ index: 1, duration: 3, visualPrompt: '', visualType: 'image' })), []);
    assert.equal(calls.length, 1);
  });

  test('retries 429 (Retry-After) and 5xx following the policy, but not 401 or 400', async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };
    const retry = { attempts: 3, baseDelayMs: 1000, maxDelayMs: 10_000 };

    let f = fakeFetch([json({ error: 'slow down' }, 429, { 'retry-after': '2' }), json({}, 503), json({ photos: [photo(7)] })]);
    const found = await provider(f.fetch, { retry, sleep, random: () => 0.5 }).search(query);
    assert.deepEqual(
      found.map((c) => c.externalId),
      ['7'],
    );
    assert.equal(f.calls.length, 3);
    assert.deepEqual(sleeps, [2000, 3000]);

    f = fakeFetch([json({}, 429), json({}, 429), json({}, 429)]);
    await assert.rejects(provider(f.fetch, { retry, sleep }).search(query), assetError('PROVIDER_ERROR', /429/, true));
    assert.equal(f.calls.length, 3);

    for (const status of [401, 400]) {
      f = fakeFetch([json({}, status)]);
      await assert.rejects(provider(f.fetch, { retry, sleep }).search(query), assetError('PROVIDER_ERROR', new RegExp(String(status)), false));
      assert.equal(f.calls.length, 1, `HTTP ${status} is not retried`);
    }
  });

  test('network errors and timeouts are retryable; bad responses are not', async () => {
    const network: FetchFn = async () => {
      throw new TypeError('fetch failed');
    };
    await assert.rejects(provider(network).search(query), assetError('PROVIDER_ERROR', /network error/, true));
    const timeout: FetchFn = async () => {
      const error = new Error('aborted');
      error.name = 'TimeoutError';
      throw error;
    };
    await assert.rejects(provider(timeout).search(query), assetError('PROVIDER_ERROR', /timed out/, true));
    const html: FetchFn = async () => new Response('<html>', { status: 200 });
    await assert.rejects(provider(html).search(query), assetError('PROVIDER_ERROR', /invalid JSON/, false));
    const shape: FetchFn = async () => new Response(JSON.stringify({ photos: 'nope' }), { status: 200 });
    await assert.rejects(provider(shape).search(query), assetError('PROVIDER_ERROR', /unexpected response/, false));
    const empty: FetchFn = async () => new Response(JSON.stringify({ total_results: 0 }), { status: 200 });
    assert.deepEqual(await provider(empty).search(query), []);
  });

  test('logs when the rate-limit window is nearly used up', async () => {
    const logs: string[] = [];
    const { fetch } = fakeFetch([json({ photos: [] }, 200, { 'x-ratelimit-limit': '200', 'x-ratelimit-remaining': '3' })]);
    await provider(fetch, { log: (m) => logs.push(m) }).search(query);
    assert.match(logs.join('\n'), /3 request\(s\) left of 200/);
    const quiet = fakeFetch([json({ photos: [] }, 200, { 'x-ratelimit-limit': '200', 'x-ratelimit-remaining': '150' })]);
    logs.length = 0;
    await provider(quiet.fetch, { log: (m) => logs.push(m) }).search(query);
    assert.deepEqual(logs, []);
  });

  test('rateLimitResetMs reads a Unix timestamp or seconds', () => {
    const now = 1_700_000_000_000;
    assert.equal(rateLimitResetMs(new Headers({ 'x-ratelimit-reset': '1700000030' }), now), 30_000);
    assert.equal(rateLimitResetMs(new Headers({ 'x-ratelimit-reset': '45' }), now), 45_000);
    assert.equal(rateLimitResetMs(new Headers({ 'x-ratelimit-reset': '1699999990' }), now), undefined);
    assert.equal(rateLimitResetMs(new Headers({}), now), undefined);
    assert.equal(rateLimitResetMs(new Headers({ 'x-ratelimit-reset': 'soon' }), now), undefined);
  });
});

describe('PexelsAssetProvider.open', () => {
  const candidate = (url: string | null): AssetCandidate => ({
    provider: 'pexels',
    externalId: '1',
    kind: 'image',
    url,
    width: 3000,
    height: 4500,
    durationSec: null,
    mimeType: 'image/jpeg',
    metadata: {},
  });

  test('downloads from images.pexels.com only, over https, without following redirects', async () => {
    const { fetch, calls } = fakeFetch([
      () => new Response('jpegbytes', { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '9' } }),
    ]);
    const body = await provider(fetch).open(candidate('https://images.pexels.com/photos/1/pexels-photo-1.jpeg?fit=crop&w=1080&h=1920'));
    assert.equal(await new Response(body as ReadableStream<Uint8Array>).text(), 'jpegbytes');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init.redirect, 'error');

    await assert.rejects(provider(fetch).open(candidate('https://evil.example.com/x.jpg')), assetError('DOWNLOAD_FAILED', /not allowed/));
    await assert.rejects(provider(fetch).open(candidate('http://images.pexels.com/x.jpg')), assetError('DOWNLOAD_FAILED', /https/));
    await assert.rejects(provider(fetch).open(candidate(null)), assetError('DOWNLOAD_FAILED', /no URL/));
    assert.equal(calls.length, 1, 'refused downloads never reach the network');
  });
});

describe('configuration', () => {
  test('ASSET_PROVIDER=pexels needs PEXELS_API_KEY and a sane ASSET_SEARCH_LIMIT', () => {
    assert.throws(() => createAssetProviderFromEnv({ ASSET_PROVIDER: 'pexels' }), assetError('CONFIG', /PEXELS_API_KEY/));
    assert.ok(createAssetProviderFromEnv({ ASSET_PROVIDER: 'pexels', PEXELS_API_KEY: 'k' }) instanceof PexelsAssetProvider);
    assert.ok(createAssetProviderFromEnv({ ASSET_PROVIDER: ' Pexels ', PEXELS_API_KEY: 'k', ASSET_SEARCH_LIMIT: '30' }) instanceof PexelsAssetProvider);
    assert.throws(
      () => createAssetProviderFromEnv({ ASSET_PROVIDER: 'pexels', PEXELS_API_KEY: 'k', ASSET_SEARCH_LIMIT: '500' }),
      assetError('CONFIG', /ASSET_SEARCH_LIMIT/),
    );
    assert.throws(() => new PexelsAssetProvider({ apiKey: '  ' }), assetError('CONFIG'));
  });

  test('ASSET_FALLBACK and the normalizer come from the environment', () => {
    assert.equal(fallbackModeFromEnv({}), 'placeholder');
    assert.equal(fallbackModeFromEnv({ ASSET_FALLBACK: ' FAIL ' }), 'fail');
    assert.throws(() => fallbackModeFromEnv({ ASSET_FALLBACK: 'retry' }), assetError('CONFIG', /ASSET_FALLBACK/));
    const services = createAssetServicesFromEnv({ ASSET_PROVIDER: 'mock', ASSET_FALLBACK: 'fail', DATA_DIR: 'data' });
    assert.equal(services.normalizer?.name, 'ffmpeg');
    assert.equal(services.fallbackMode, 'fail');
    assert.equal(createAssetServicesFromEnv({ ASSET_PROVIDER: 'mock' }).fallbackMode, 'placeholder');
  });
});
