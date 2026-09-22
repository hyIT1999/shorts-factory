import { retryPolicyFromEnv } from '../retry.js';
import { createImageNormalizerFromEnv, type ImageNormalizer } from './normalize.js';
import type { AssetProvider } from './provider.js';
import { MockAssetProvider } from './providers/mock.js';
import { DEFAULT_PEXELS_PER_PAGE, MAX_PEXELS_PER_PAGE, PexelsAssetProvider } from './providers/pexels.js';
import { PlaceholderAssetProvider } from './providers/placeholder.js';
import { LocalAssetStorage } from './storage.js';
import { AssetError } from './types.js';

/** What happens to a scene the primary provider cannot serve: a placeholder image, or the job fails. */
export type AssetFallbackMode = 'placeholder' | 'fail';

/** Everything the ASSETS stage needs, injected through JobContext. */
export interface AssetServices {
  /** Primary provider (search + open). */
  provider: AssetProvider;
  /** Used when the primary provider finds nothing or fails (unless fallbackMode is "fail"). */
  fallback: AssetProvider;
  /** Local storage rooted at data/ (or DATA_DIR). */
  storage: LocalAssetStorage;
  /** Re-encodes oversized images to the render size; without it images are stored as downloaded. */
  normalizer?: ImageNormalizer;
  /** Default "placeholder". */
  fallbackMode?: AssetFallbackMode;
}

export const ASSET_PROVIDER_NAMES = ['placeholder', 'mock', 'pexels'] as const;

/** ASSET_SEARCH_LIMIT: results requested per stock search (default 15). */
function searchLimitFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env['ASSET_SEARCH_LIMIT']?.trim();
  if (!raw) {
    return DEFAULT_PEXELS_PER_PAGE;
  }
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PEXELS_PER_PAGE) {
    throw new AssetError('CONFIG', `ASSET_SEARCH_LIMIT must be a whole number between 1 and ${MAX_PEXELS_PER_PAGE}`);
  }
  return limit;
}

/** ASSET_FALLBACK: "placeholder" (default) or "fail". */
export function fallbackModeFromEnv(env: NodeJS.ProcessEnv = process.env): AssetFallbackMode {
  const mode = (env['ASSET_FALLBACK'] ?? 'placeholder').trim().toLowerCase() || 'placeholder';
  if (mode !== 'placeholder' && mode !== 'fail') {
    throw new AssetError('CONFIG', `Unknown ASSET_FALLBACK "${mode}" (use "placeholder" or "fail")`);
  }
  return mode;
}

/**
 * ASSET_PROVIDER: "placeholder" (default), "mock" (tests/dev) or "pexels"
 * (needs PEXELS_API_KEY; retries follow PROVIDER_RETRY_*).
 */
export function createAssetProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = (message) => console.warn(message),
): AssetProvider {
  const name = (env['ASSET_PROVIDER'] ?? 'placeholder').trim().toLowerCase() || 'placeholder';
  switch (name) {
    case 'placeholder':
      return new PlaceholderAssetProvider();
    case 'mock':
      return new MockAssetProvider();
    case 'pexels': {
      const apiKey = env['PEXELS_API_KEY']?.trim();
      if (!apiKey) {
        throw new AssetError('CONFIG', 'ASSET_PROVIDER=pexels needs PEXELS_API_KEY (https://www.pexels.com/api/)');
      }
      return new PexelsAssetProvider({ apiKey, retry: retryPolicyFromEnv(env), perPage: searchLimitFromEnv(env), log });
    }
    default:
      throw new AssetError('CONFIG', `Unknown ASSET_PROVIDER "${name}" (use "placeholder", "mock" or "pexels")`);
  }
}

/** DATA_DIR (default "data", relative to the working directory) is the storage root. */
export function createStorageFromEnv(env: NodeJS.ProcessEnv = process.env): LocalAssetStorage {
  return new LocalAssetStorage(env['DATA_DIR']?.trim() || 'data');
}

/**
 * Storage from DATA_DIR, the provider from ASSET_PROVIDER, the ffmpeg from
 * FFMPEG_PATH to normalize oversized images, and ASSET_FALLBACK.
 */
export function createAssetServicesFromEnv(env: NodeJS.ProcessEnv = process.env): AssetServices {
  return {
    provider: createAssetProviderFromEnv(env),
    fallback: new PlaceholderAssetProvider(),
    storage: createStorageFromEnv(env),
    normalizer: createImageNormalizerFromEnv(env),
    fallbackMode: fallbackModeFromEnv(env),
  };
}
