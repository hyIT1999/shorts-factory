import { z } from 'zod';

export type AssetKind = 'image' | 'video';

/** What ASSETS asks a provider for, built deterministically from a scene. */
export interface AssetQuery {
  sceneIndex: number;
  /** The scene's visualType; video is preferred over image when they differ. */
  preferredKind: AssetKind;
  /** Short search keywords derived from the visualPrompt. */
  keywords: string[];
  /** Keywords joined with spaces (what a stock search API would receive). */
  text: string;
  /** Original visual prompt (used by generators such as the placeholder). */
  visualPrompt: string;
  /** A video should last at least this long to cover the scene. */
  minDurationSec: number;
  orientation: 'portrait';
  width: number;
  height: number;
}

/** A provider result before anything is stored. */
export interface AssetCandidate {
  provider: string;
  externalId: string | null;
  kind: AssetKind;
  /** Remote source URL (stock providers); null for generated assets. */
  url: string | null;
  width: number;
  height: number;
  durationSec: number | null;
  mimeType: string;
  /** Provider-specific extras (license, author, page URL, seed…). */
  metadata: Record<string, unknown>;
}

/**
 * Why a scene got no usable asset from the primary provider: nothing found,
 * the search failed, nothing could be downloaded, or nothing downloaded was a
 * valid image within the size limits.
 */
export type FallbackReason = 'NO_CANDIDATES' | 'PROVIDER_ERROR' | 'DOWNLOAD_FAILED' | 'INVALID_IMAGE';

/** Contract of the ASSETS Job.resultJson (paths are relative to data/). */
export const AssetsResultSchema = z.strictObject({
  provider: z.string().min(1),
  scenes: z
    .array(
      z.strictObject({
        sceneIndex: z.number().int().min(0),
        assetId: z.string().min(1),
        kind: z.enum(['image', 'video']),
        localPath: z
          .string()
          .min(1)
          .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.includes('\\') && !p.split('/').includes('..'), {
            message: 'localPath must be a relative POSIX path inside data/',
          }),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        durationSec: z.number().positive().nullable(),
        fallback: z.boolean(),
        source: z.strictObject({
          provider: z.string().min(1),
          externalId: z.string().nullable(),
          url: z.string().nullable(),
        }),
      }),
    )
    .min(1),
});

export type AssetsResult = z.infer<typeof AssetsResultSchema>;

export type AssetErrorCode =
  | 'CONFIG'
  | 'PROVIDER_ERROR'
  | 'NO_CANDIDATES'
  | 'DOWNLOAD_FAILED'
  | 'INVALID_IMAGE'
  | 'INVALID_PATH'
  | 'STORAGE_ERROR';

export interface AssetErrorOptions {
  /** A transient failure (rate limit, 5xx, timeout) worth retrying (lib/retry.ts). */
  retryable?: boolean;
  /** Provider hint (Retry-After / rate-limit reset) in milliseconds. */
  retryAfterMs?: number;
}

export class AssetError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    readonly code: AssetErrorCode,
    message: string,
    options: AssetErrorOptions = {},
  ) {
    super(message);
    this.name = 'AssetError';
    this.retryable = options.retryable ?? false;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}
