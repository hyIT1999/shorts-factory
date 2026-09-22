/**
 * Pexels stock photos (https://www.pexels.com/api/): ASSET_PROVIDER=pexels with
 * PEXELS_API_KEY. One search per scene (portrait orientation, the scene's
 * keywords). The photo is fetched from Pexels' image CDN with a request for the
 * render size (the CDN crops on the fly, as Pexels' own "portrait" size does)
 * and is checked and, if still too big, normalized locally either way
 * (lib/assets/service.ts). Photos only: RENDER composes still images, so video
 * clips stay out of scope.
 *
 * Rate limits (200 requests/hour and 20 000/month on the free plan) come back
 * as HTTP 429 with X-Ratelimit-Reset; those, 5xx and network errors are retried
 * with the shared backoff (lib/retry.ts) and then reported as PROVIDER_ERROR.
 * Attribution (photographer, page URL, license) is kept in the asset metadata:
 * Pexels asks for a credit and a link wherever a photo is shown.
 */
import { z } from 'zod';
import { isRetryableHttpStatus, NO_RETRY, parseRetryAfterHeader, withRetry, type RetryPolicy } from '../../retry.js';
import { openRemote, type FetchFn } from '../download.js';
import type { AssetBody, AssetProvider } from '../provider.js';
import { AssetError, type AssetCandidate, type AssetQuery } from '../types.js';

export const PEXELS_SEARCH_URL = 'https://api.pexels.com/v1/search';
/** Hosts a candidate URL may point to (openRemote refuses anything else). */
export const PEXELS_IMAGE_HOSTS: readonly string[] = ['images.pexels.com'];
export const PEXELS_LICENSE_URL = 'https://www.pexels.com/license/';
export const DEFAULT_PEXELS_PER_PAGE = 15;
export const MAX_PEXELS_PER_PAGE = 80;
export const DEFAULT_PEXELS_TIMEOUT_MS = 20_000;
export const DEFAULT_PEXELS_DOWNLOAD_TIMEOUT_MS = 60_000;
/** Downloads larger than this are refused (originals are 2–15 MB; the CDN crop is far smaller). */
export const MAX_PEXELS_PHOTO_BYTES = 30 * 1024 * 1024;
/** Photos whose short side is below this would be upscaled too much for 1080×1920. */
export const MIN_PEXELS_SHORT_SIDE = 720;
/** Query parameters that ask Pexels' CDN for the render size (its own "portrait" size uses the same ones). */
export const PEXELS_CROP_PARAMS: Readonly<Record<string, string>> = { auto: 'compress', cs: 'tinysrgb', fit: 'crop', w: '1080', h: '1920' };
/** Fewer remaining requests than this are logged, so an operator sees the hourly limit coming. */
const RATE_LIMIT_WARN_BELOW = 20;

const PhotoSchema = z.looseObject({
  id: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  url: z.string(),
  photographer: z.string().default(''),
  photographer_url: z.string().default(''),
  alt: z.string().nullish(),
  avg_color: z.string().nullish(),
  src: z.looseObject({ original: z.string().min(1) }),
});
const SearchResponseSchema = z.looseObject({ photos: z.array(PhotoSchema).default([]) });
type Photo = z.infer<typeof PhotoSchema>;
type SearchResponse = z.infer<typeof SearchResponseSchema>;

export interface PexelsProviderOptions {
  apiKey: string;
  fetch?: FetchFn;
  /** Backoff for 429/5xx/network errors (default: none; the worker passes retryPolicyFromEnv). */
  retry?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Results per search, 1–80 (default 15; the best MAX_CANDIDATES_PER_SCENE of them are kept). */
  perPage?: number;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
  minShortSide?: number;
  log?: (message: string) => void;
}

function mimeTypeFromUrl(url: string): string {
  let pathname = '';
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    // keep the default
  }
  if (pathname.endsWith('.png')) {
    return 'image/png';
  }
  if (pathname.endsWith('.webp')) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

/** Milliseconds until the rate-limit window resets, from X-Ratelimit-Reset (a Unix timestamp in seconds). */
export function rateLimitResetMs(headers: Headers, now: number = Date.now()): number | undefined {
  const raw = headers.get('x-ratelimit-reset')?.trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  const ms = value > 1_000_000_000 ? value * 1000 - now : value * 1000;
  return ms > 0 ? ms : undefined;
}

function httpError(response: Response): AssetError {
  const status = response.status;
  if (status === 401 || status === 403) {
    return new AssetError('PROVIDER_ERROR', `Pexels rejected the API key (HTTP ${status}); check PEXELS_API_KEY`);
  }
  const retryAfterMs = parseRetryAfterHeader(response.headers.get('retry-after')) ?? rateLimitResetMs(response.headers);
  const hint = retryAfterMs !== undefined ? { retryAfterMs } : {};
  if (status === 429) {
    return new AssetError('PROVIDER_ERROR', 'Pexels rate limit reached (HTTP 429)', { retryable: true, ...hint });
  }
  return new AssetError('PROVIDER_ERROR', `Pexels search failed (HTTP ${status})`, { retryable: isRetryableHttpStatus(status), ...hint });
}

function toCandidate(photo: Photo): AssetCandidate {
  let url = photo.src.original;
  try {
    const source = new URL(photo.src.original);
    for (const [key, value] of Object.entries(PEXELS_CROP_PARAMS)) {
      source.searchParams.set(key, value);
    }
    url = source.toString();
  } catch {
    // not a URL: openRemote rejects it and the next candidate is tried
  }
  const photographer = photo.photographer.trim();
  return {
    provider: 'pexels',
    externalId: String(photo.id),
    kind: 'image',
    url,
    width: photo.width,
    height: photo.height,
    durationSec: null,
    mimeType: mimeTypeFromUrl(photo.src.original),
    metadata: {
      pageUrl: photo.url,
      photographer,
      photographerUrl: photo.photographer_url,
      alt: photo.alt ?? null,
      avgColor: photo.avg_color ?? null,
      originalUrl: photo.src.original,
      license: 'Pexels License',
      licenseUrl: PEXELS_LICENSE_URL,
      attribution: photographer ? `Photo by ${photographer} on Pexels` : 'Photo from Pexels',
    },
  };
}

export class PexelsAssetProvider implements AssetProvider {
  readonly name = 'pexels';
  private readonly fetchFn: FetchFn;
  private readonly retry: RetryPolicy;
  private readonly perPage: number;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly minShortSide: number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: PexelsProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new AssetError('CONFIG', 'Pexels needs an API key (PEXELS_API_KEY)');
    }
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.retry = options.retry ?? NO_RETRY;
    this.perPage = Math.min(MAX_PEXELS_PER_PAGE, Math.max(1, Math.floor(options.perPage ?? DEFAULT_PEXELS_PER_PAGE)));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PEXELS_TIMEOUT_MS;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_PEXELS_DOWNLOAD_TIMEOUT_MS;
    this.minShortSide = options.minShortSide ?? MIN_PEXELS_SHORT_SIDE;
    this.log = options.log ?? (() => undefined);
  }

  async search(query: AssetQuery): Promise<AssetCandidate[]> {
    const text = query.text.trim();
    if (!text) {
      return []; // nothing to search for; the caller falls back
    }
    const url = new URL(PEXELS_SEARCH_URL);
    url.searchParams.set('query', text);
    url.searchParams.set('orientation', 'portrait');
    url.searchParams.set('per_page', String(this.perPage));
    url.searchParams.set('page', '1');

    const payload = await withRetry(() => this.request(url.toString()), {
      policy: this.retry,
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      ...(this.options.random ? { random: this.options.random } : {}),
      onRetry: ({ attempt, attempts, delayMs, error }) =>
        this.log(
          `Pexels search "${text}" failed (attempt ${attempt}/${attempts}): ${error instanceof Error ? error.message : String(error)}; ` +
            `retrying in ${Math.round(delayMs / 1000)} s`,
        ),
    });

    const seen = new Set<number>();
    const candidates: AssetCandidate[] = [];
    for (const photo of payload.photos) {
      if (seen.has(photo.id) || Math.min(photo.width, photo.height) < this.minShortSide) {
        continue;
      }
      seen.add(photo.id);
      candidates.push(toCandidate(photo));
    }
    return candidates;
  }

  async open(candidate: AssetCandidate): Promise<AssetBody> {
    if (!candidate.url) {
      throw new AssetError('DOWNLOAD_FAILED', 'Pexels candidate has no URL');
    }
    const remote = await openRemote(candidate.url, {
      allowedHosts: PEXELS_IMAGE_HOSTS,
      maxBytes: MAX_PEXELS_PHOTO_BYTES,
      timeoutMs: this.downloadTimeoutMs,
      fetch: this.fetchFn,
    });
    return remote.body;
  }

  private async request(url: string): Promise<SearchResponse> {
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: { Authorization: this.options.apiKey, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new AssetError('PROVIDER_ERROR', timedOut ? 'Pexels search timed out' : 'Could not reach the Pexels API (network error)', {
        retryable: true,
      });
    }
    this.noteRateLimit(response.headers);
    if (!response.ok) {
      throw httpError(response);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new AssetError('PROVIDER_ERROR', 'Pexels returned invalid JSON');
    }
    const parsed = SearchResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new AssetError('PROVIDER_ERROR', 'Pexels returned an unexpected response');
    }
    return parsed.data;
  }

  private noteRateLimit(headers: Headers): void {
    const raw = headers.get('x-ratelimit-remaining')?.trim();
    if (!raw || !/^\d+$/.test(raw)) {
      return;
    }
    const remaining = Number(raw);
    if (remaining < RATE_LIMIT_WARN_BELOW) {
      const limit = headers.get('x-ratelimit-limit');
      this.log(`Pexels: ${remaining} request(s) left${limit ? ` of ${limit}` : ''} in the current rate-limit window`);
    }
  }
}
