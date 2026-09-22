/**
 * Splits one scene into subtitle segments with a deterministic dynamic
 * program: every segment must fit in two lines; among all valid splits the
 * one with the lowest total cost wins (segment length close to 2.2 s, breaks
 * at punctuation or before connectors, no split units, no dangling function
 * words). Segments never cross the scene boundary.
 */
import { prefixSums, type TokenRange } from './timing.js';
import {
  MAX_CHARS_PER_LINE,
  MAX_LINES,
  MAX_SEGMENT_SEC,
  MIN_SEGMENT_MS,
  TARGET_SEGMENT_SEC,
  type BoundaryType,
  type SubtitleToken,
} from './types.js';
import { charPrefix, chooseLineBreak, joinedLength, wrapSegment } from './wrap.js';

const DURATION_SCALE_SEC = 0.8;
const TOO_SHORT_COST = 100;
const TOO_LONG_COST = 30;
const BREAK_COST: Record<BoundaryType, number> = { SENTENCE: 0, CLAUSE: 1, COMMA: 2, CONNECTOR: 5, NONE: 10 };
const NO_BREAK_COST = 60;
const FUNCTION_WORD_END_COST = 8;
const INNER_SENTENCE_COST = 15;
const EPSILON = 1e-9;

/** A line holds at most this many one-letter words, so a segment at most MAX_LINES × that. */
const MAX_SEGMENT_TOKENS = MAX_LINES * Math.floor((MAX_CHARS_PER_LINE + 1) / 2);

export interface SceneSegment extends TokenRange {
  lines: SubtitleToken[][];
}

export interface SceneSegmentation {
  segments: SceneSegment[];
  /** The scene is shorter than MIN_SEGMENT_MS (kept as one segment when it fits). */
  short: boolean;
}

export function segmentScene(
  tokens: readonly SubtitleToken[],
  durationMs: number,
  weights: readonly number[],
): SceneSegmentation {
  const n = tokens.length;
  const short = durationMs < MIN_SEGMENT_MS;
  if (short) {
    const lines = wrapSegment(tokens);
    if (lines) {
      return { segments: [{ from: 0, to: n, lines }], short };
    }
  }

  const prefix = prefixSums(weights);
  const totalWeight = prefix[n] ?? 1;
  const durationSec = durationMs / 1000;
  const sentencesBefore = [0];
  tokens.forEach((token, i) => sentencesBefore.push((sentencesBefore[i] ?? 0) + (token.boundaryAfter === 'SENTENCE' ? 1 : 0)));

  const cost = (from: number, to: number): number => {
    const seconds = (durationSec * ((prefix[to] ?? 0) - (prefix[from] ?? 0))) / totalWeight;
    let total = ((seconds - TARGET_SEGMENT_SEC) / DURATION_SCALE_SEC) ** 2;
    if (seconds * 1000 < MIN_SEGMENT_MS) {
      total += TOO_SHORT_COST;
    }
    if (seconds > MAX_SEGMENT_SEC) {
      total += TOO_LONG_COST;
    }
    if (to < n) {
      const last = tokens[to - 1] as SubtitleToken;
      total += BREAK_COST[last.boundaryAfter];
      total += last.noBreakAfter ? NO_BREAK_COST : 0;
      total += last.functionWord ? FUNCTION_WORD_END_COST : 0;
    }
    // Sentence ends inside the segment (its own last token excluded).
    total += ((sentencesBefore[to - 1] ?? 0) - (sentencesBefore[from] ?? 0)) * INNER_SENTENCE_COST;
    return total;
  };

  const chars = charPrefix(tokens);
  // longBefore[k] = tokens in [0..k) longer than a line (they may overflow on their own line).
  const longBefore = [0];
  tokens.forEach((token, i) =>
    longBefore.push((longBefore[i] ?? 0) + (joinedLength(chars, i, i + 1) > MAX_CHARS_PER_LINE ? 1 : 0)),
  );
  const twoLines = MAX_LINES * MAX_CHARS_PER_LINE + 1;

  const best: number[] = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
  const previous: number[] = new Array<number>(n + 1).fill(-1);
  const lineBreak: number[] = new Array<number>(n + 1).fill(-1);
  best[0] = 0;
  for (let to = 1; to <= n; to++) {
    // Ascending `from` + strict improvement: on ties the earlier break wins.
    for (let from = Math.max(0, to - MAX_SEGMENT_TOKENS); from < to; from++) {
      const base = best[from] ?? Number.POSITIVE_INFINITY;
      if (base === Number.POSITIVE_INFINITY) {
        continue;
      }
      // Too long for two lines unless an over-long word sits on a line of its own.
      if (joinedLength(chars, from, to) > twoLines && (longBefore[to] ?? 0) === (longBefore[from] ?? 0)) {
        continue;
      }
      const split = chooseLineBreak(tokens, chars, from, to);
      if (split < 0) {
        continue;
      }
      const candidate = base + cost(from, to);
      if (candidate < (best[to] ?? Number.POSITIVE_INFINITY) - EPSILON) {
        best[to] = candidate;
        previous[to] = from;
        lineBreak[to] = split;
      }
    }
  }

  const segments: SceneSegment[] = [];
  for (let to = n; to > 0; to = previous[to] ?? 0) {
    const from = previous[to] ?? 0;
    const split = lineBreak[to] ?? to;
    const lines = split === to ? [tokens.slice(from, to)] : [tokens.slice(from, split), tokens.slice(split, to)];
    segments.unshift({ from, to, lines });
  }
  return { segments, short };
}
