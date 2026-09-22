/**
 * Segment timing without word timestamps: a scene's real (audio) duration is
 * shared out in proportion to token weights (syllables + pauses after
 * punctuation). Boundaries come from cumulative weights, in integer
 * milliseconds, so segments never drift, never overlap or leave gaps, and the
 * last one ends exactly at the scene end.
 */
import { PAUSE_WEIGHT, type SubtitleToken } from './types.js';

/** Seconds (as stored on Scene/Video) → integer milliseconds. */
export function toMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

/** Spoken weight of each token; the scene's final pause is not counted. */
export function tokenWeights(tokens: readonly SubtitleToken[]): number[] {
  return tokens.map(
    (token, i) => token.syllableWeight + (i === tokens.length - 1 ? 0 : PAUSE_WEIGHT[token.boundaryAfter]),
  );
}

/** prefix[k] = sum of weights[0..k). */
export function prefixSums(weights: readonly number[]): number[] {
  const prefix = [0];
  for (const weight of weights) {
    prefix.push((prefix.at(-1) ?? 0) + weight);
  }
  return prefix;
}

export interface TokenRange {
  from: number;
  to: number;
}

/** Start/end (ms) of consecutive token ranges covering a scene. */
export function allocateTimes(
  startMs: number,
  endMs: number,
  weights: readonly number[],
  ranges: readonly TokenRange[],
): { startMs: number; endMs: number }[] {
  const prefix = prefixSums(weights);
  const total = prefix.at(-1) ?? 0;
  const duration = endMs - startMs;
  let cursor = startMs;
  return ranges.map((range, i) => {
    // Every token weighs at least 0.5, so total > 0.
    const boundary =
      i === ranges.length - 1 ? endMs : startMs + Math.round((duration * (prefix[range.to] ?? total)) / total);
    const times = { startMs: cursor, endMs: boundary };
    cursor = boundary;
    return times;
  });
}
