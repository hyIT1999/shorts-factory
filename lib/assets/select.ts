/**
 * Deterministic candidate ranking (no randomness). Higher score wins; ties keep
 * the provider's original order.
 */
import type { AssetCandidate, AssetQuery } from './types.js';

const TARGET_RATIO = 9 / 16;
const TARGET_HEIGHT = 1920;

export interface RankedCandidate {
  candidate: AssetCandidate;
  score: number;
  /** Position in the provider's result list. */
  providerRank: number;
  duplicate: boolean;
}

/** Stable identity of a candidate for duplicate detection (null when unknown). */
export function candidateKey(candidate: AssetCandidate): string | null {
  return candidate.externalId ? `${candidate.provider}:${candidate.externalId}` : null;
}

export function scoreCandidate(candidate: AssetCandidate, query: AssetQuery): number {
  let score = 0;

  // Kind: the scene's visualType first; otherwise video before image.
  if (candidate.kind === query.preferredKind) {
    score += 40;
  } else {
    score += candidate.kind === 'video' ? 20 : 10;
  }

  // Orientation: portrait, and the closer to 9:16 the better.
  if (candidate.height > candidate.width) {
    score += 20;
    const ratio = candidate.width / candidate.height;
    score += 10 * Math.max(0, 1 - Math.abs(ratio - TARGET_RATIO) / TARGET_RATIO);
  }

  // Resolution, capped at the 1920 px target height.
  score += 10 * (Math.min(candidate.height, TARGET_HEIGHT) / TARGET_HEIGHT);

  // Videos must cover the scene duration.
  if (candidate.kind === 'video' && query.minDurationSec > 0) {
    const covered = (candidate.durationSec ?? 0) / query.minDurationSec;
    score += 15 * Math.min(1, covered);
  }

  return Math.round(score * 1000) / 1000;
}

/**
 * Ranks candidates best-first. Candidates already used by another scene of the
 * same video (by provider + externalId) go last so they are only a last resort.
 */
export function rankCandidates(
  candidates: readonly AssetCandidate[],
  query: AssetQuery,
  usedKeys: ReadonlySet<string> = new Set(),
): RankedCandidate[] {
  return candidates
    .map((candidate, providerRank) => {
      const key = candidateKey(candidate);
      return {
        candidate,
        score: scoreCandidate(candidate, query),
        providerRank,
        duplicate: key !== null && usedKeys.has(key),
      };
    })
    .sort((a, b) => Number(a.duplicate) - Number(b.duplicate) || b.score - a.score || a.providerRank - b.providerRank);
}
