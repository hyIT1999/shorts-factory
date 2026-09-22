/**
 * Deterministic provider for tests and development (ASSET_PROVIDER=mock).
 * By default returns two real PNG candidates per scene — landscape first,
 * portrait second — so selection logic is exercised. Behaviour can be
 * overridden to simulate "no results", search errors or download errors.
 */
import type { AssetBody, AssetProvider } from '../provider.js';
import type { AssetCandidate, AssetQuery } from '../types.js';
import { renderPlaceholderPng } from './placeholder.js';

export interface MockAssetProviderOptions {
  /** Replace search results (return [] for "no candidates", throw to simulate an error). */
  search?: (query: AssetQuery) => AssetCandidate[] | Promise<AssetCandidate[]>;
  /** Replace open() (throw to simulate a failed download). */
  open?: (candidate: AssetCandidate) => AssetBody | Promise<AssetBody>;
}

export function defaultMockCandidates(query: AssetQuery): AssetCandidate[] {
  const base = { provider: 'mock', kind: 'image' as const, url: null, durationSec: null, mimeType: 'image/png' };
  return [
    {
      ...base,
      externalId: `mock-${query.sceneIndex}-landscape`,
      width: 1920,
      height: 1080,
      metadata: { query: query.text },
    },
    {
      ...base,
      externalId: `mock-${query.sceneIndex}-portrait`,
      width: 1080,
      height: 1920,
      metadata: { query: query.text },
    },
  ];
}

export class MockAssetProvider implements AssetProvider {
  readonly name = 'mock';
  readonly searches: AssetQuery[] = [];

  constructor(private readonly options: MockAssetProviderOptions = {}) {}

  async search(query: AssetQuery): Promise<AssetCandidate[]> {
    this.searches.push(query);
    return this.options.search ? this.options.search(query) : defaultMockCandidates(query);
  }

  async open(candidate: AssetCandidate): Promise<AssetBody> {
    if (this.options.open) {
      return this.options.open(candidate);
    }
    return renderPlaceholderPng(candidate.externalId ?? 'mock', candidate.width, candidate.height);
  }
}
