import type { AssetCandidate, AssetQuery } from './types.js';

/** Bytes of an asset: a buffer (generated) or a stream (downloaded). */
export type AssetBody = Uint8Array | ReadableStream<Uint8Array>;

/**
 * A source of scene visuals (placeholder, mock, and later stock providers).
 * The ASSETS worker depends only on this interface.
 */
export interface AssetProvider {
  readonly name: string;
  /** Finds candidates for a scene; an empty array means "nothing found". */
  search(query: AssetQuery): Promise<AssetCandidate[]>;
  /** Returns the bytes of a candidate (generated, or downloaded via download.ts). */
  open(candidate: AssetCandidate): Promise<AssetBody>;
}
