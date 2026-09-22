/**
 * Line wrapping for a 1080×1920 caption: one line when the text fits,
 * otherwise exactly one break at a space. Words are never cut; a single word
 * longer than a line (e.g. a URL) is allowed on a line of its own.
 */
import { charLength } from './tokenize.js';
import { MAX_CHARS_PER_LINE, type BoundaryType, type SubtitleToken } from './types.js';

/** Preference for where the line break falls (lower is better). */
const LINE_BREAK_COST: Record<BoundaryType, number> = { SENTENCE: 0, CLAUSE: 1, COMMA: 2, CONNECTOR: 3, NONE: 6 };
const LINE_NO_BREAK_COST = 20;
const LINE_FUNCTION_WORD_COST = 6;
const EPSILON = 1e-9;

/** charPrefix[k] = characters (code points) of tokens[0..k), spaces excluded. */
export function charPrefix(tokens: readonly SubtitleToken[]): number[] {
  const prefix = [0];
  for (const token of tokens) {
    prefix.push((prefix.at(-1) ?? 0) + charLength(token.text));
  }
  return prefix;
}

/** Characters of tokens[from..to) joined by single spaces. */
export function joinedLength(prefix: readonly number[], from: number, to: number): number {
  return (prefix[to] ?? 0) - (prefix[from] ?? 0) + (to - from - 1);
}

/**
 * Where to break tokens[from..to) into lines: returns `to` when it fits on
 * one line, the index of the first token of line 2, or -1 when it cannot be
 * shown in two lines. Among valid breaks, prefers balanced lines, breaks
 * after punctuation or before a connector, and avoids splitting a unit
 * (emphasis, brackets, number + unit) or ending a line with a function word.
 * Ties go to the earlier break.
 */
export function chooseLineBreak(
  tokens: readonly SubtitleToken[],
  prefix: readonly number[],
  from: number,
  to: number,
  maxChars: number = MAX_CHARS_PER_LINE,
): number {
  const fits = (a: number, b: number) => b - a === 1 || joinedLength(prefix, a, b) <= maxChars;
  if (to <= from) {
    return -1;
  }
  if (fits(from, to)) {
    return to;
  }
  let best = -1;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let k = from + 1; k < to; k++) {
    if (!fits(from, k) || !fits(k, to)) {
      continue;
    }
    const last = tokens[k - 1] as SubtitleToken;
    const cost =
      Math.abs(joinedLength(prefix, from, k) - joinedLength(prefix, k, to)) +
      LINE_BREAK_COST[last.boundaryAfter] +
      (last.noBreakAfter ? LINE_NO_BREAK_COST : 0) +
      (last.functionWord ? LINE_FUNCTION_WORD_COST : 0);
    if (cost < bestCost - EPSILON) {
      bestCost = cost;
      best = k;
    }
  }
  return best;
}

/** The tokens of each line (1 or 2 lines), or null when they do not fit in two lines. */
export function wrapSegment(
  tokens: readonly SubtitleToken[],
  maxChars: number = MAX_CHARS_PER_LINE,
): SubtitleToken[][] | null {
  const split = chooseLineBreak(tokens, charPrefix(tokens), 0, tokens.length, maxChars);
  if (split < 0) {
    return null;
  }
  return split === tokens.length ? [[...tokens]] : [tokens.slice(0, split), tokens.slice(split)];
}
