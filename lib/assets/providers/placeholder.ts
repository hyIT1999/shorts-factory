/**
 * Offline, free provider: generates a deterministic 1080×1920 PNG per scene
 * (a vertical gradient whose colors come from a hash of the scene prompt).
 * Also used as the fallback when another provider finds nothing or fails.
 */
import { createHash } from 'node:crypto';
import { encodePng, type Rgb } from '../png.js';
import type { AssetBody, AssetProvider } from '../provider.js';
import type { AssetCandidate, AssetQuery } from '../types.js';

export const PLACEHOLDER_WIDTH = 1080;
export const PLACEHOLDER_HEIGHT = 1920;

function seedFor(query: Pick<AssetQuery, 'sceneIndex' | 'visualPrompt'>): string {
  return createHash('sha256').update(`${query.sceneIndex}\n${query.visualPrompt}`).digest('hex').slice(0, 12);
}

/** Two dark-ish colors derived from the seed (keeps the documentary mood). */
function colorsFor(seed: string): [Rgb, Rgb] {
  const byte = (i: number) => parseInt(seed.slice(i * 2, i * 2 + 2), 16);
  const top: Rgb = [20 + (byte(0) % 90), 20 + (byte(1) % 90), 40 + (byte(2) % 110)];
  const bottom: Rgb = [byte(3) % 40, byte(4) % 40, byte(5) % 60];
  return [top, bottom];
}

export function renderPlaceholderPng(seed: string, width = PLACEHOLDER_WIDTH, height = PLACEHOLDER_HEIGHT): Buffer {
  const [top, bottom] = colorsFor(seed);
  return encodePng(width, height, (y) => {
    const t = height > 1 ? y / (height - 1) : 0;
    const mix = (from: number, to: number) => Math.round(from + (to - from) * t);
    return [mix(top[0], bottom[0]), mix(top[1], bottom[1]), mix(top[2], bottom[2])];
  });
}

export class PlaceholderAssetProvider implements AssetProvider {
  readonly name = 'placeholder';

  async search(query: AssetQuery): Promise<AssetCandidate[]> {
    return [
      {
        provider: this.name,
        externalId: null,
        kind: 'image',
        url: null,
        width: PLACEHOLDER_WIDTH,
        height: PLACEHOLDER_HEIGHT,
        durationSec: null,
        mimeType: 'image/png',
        metadata: { seed: seedFor(query), generated: true },
      },
    ];
  }

  async open(candidate: AssetCandidate): Promise<AssetBody> {
    const seed = typeof candidate.metadata['seed'] === 'string' ? candidate.metadata['seed'] : 'placeholder';
    return renderPlaceholderPng(seed, candidate.width, candidate.height);
  }
}
