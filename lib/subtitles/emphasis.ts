/**
 * Emphasis: Scene.subtitleEmphasisJson (a JSON array of phrases copied from
 * the scene text by SCENES) → token ranges → styled spans. Emphasis is
 * decoration only, so problems produce warnings, never failures.
 */
import { normalizeNarration } from '../voice/text.js';
import { coreOf } from './tokenize.js';
import type { SubtitleSpan, SubtitleToken } from './types.js';

export const MAX_EMPHASIS_PER_SCENE = 5;
const MAX_PHRASE_IN_MESSAGE = 60;

/** Token range [from, to) of one matched phrase. */
export interface EmphasisRange {
  from: number;
  to: number;
}

export interface ParsedEmphasis {
  phrases: string[];
  problems: string[];
  /** Stable representation for the input hash. */
  canonical: string[] | string | null;
}

const quote = (phrase: string) =>
  `"${phrase.length > MAX_PHRASE_IN_MESSAGE ? `${phrase.slice(0, MAX_PHRASE_IN_MESSAGE)}…` : phrase}"`;

export function parseEmphasis(json: string | null): ParsedEmphasis {
  if (json === null || json.trim() === '') {
    return { phrases: [], problems: [], canonical: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch {
    return { phrases: [], problems: ['emphasis data is not valid JSON'], canonical: json };
  }
  if (!Array.isArray(raw)) {
    return { phrases: [], problems: ['emphasis data is not a list of phrases'], canonical: json };
  }
  const problems: string[] = [];
  const phrases: string[] = [];
  for (const item of raw) {
    const phrase = typeof item === 'string' ? normalizeNarration(item) : '';
    if (!phrase) {
      problems.push('ignored an empty or non-text emphasis item');
    } else if (phrases.length >= MAX_EMPHASIS_PER_SCENE) {
      problems.push(`ignored emphasis ${quote(phrase)} (more than ${MAX_EMPHASIS_PER_SCENE} phrases)`);
    } else {
      phrases.push(phrase);
    }
  }
  return { phrases, problems, canonical: phrases };
}

/** Comparison key: the word without surrounding punctuation, lowercased; a pure symbol ("%") is kept as is. */
const matchKey = (text: string) => coreOf(text).toLowerCase() || text;

/**
 * Finds each phrase as a run of whole tokens, comparing words without their
 * surrounding punctuation and case-insensitively (diacritics must match).
 * The first occurrence that does not overlap an earlier match wins.
 */
export function matchEmphasis(
  tokens: readonly SubtitleToken[],
  phrases: readonly string[],
): { ranges: EmphasisRange[]; missing: string[] } {
  const words = tokens.map((token) => matchKey(token.text));
  const used = tokens.map(() => false);
  const ranges: EmphasisRange[] = [];
  const missing: string[] = [];

  for (const phrase of phrases) {
    const target = phrase.split(' ').map(matchKey);
    let found = -1;
    for (let start = 0; start + target.length <= words.length && found < 0; start++) {
      if (target.every((word, k) => words[start + k] === word && !used[start + k])) {
        found = start;
      }
    }
    if (found < 0) {
      missing.push(`emphasis ${quote(phrase)} was not found in the scene text`);
      continue;
    }
    used.fill(true, found, found + target.length);
    ranges.push({ from: found, to: found + target.length });
  }
  return { ranges: ranges.sort((a, b) => a.from - b.from), missing };
}

/** Breaking inside an emphasized phrase splits it: mark those positions. */
export function withEmphasisNoBreak(tokens: readonly SubtitleToken[], ranges: readonly EmphasisRange[]): SubtitleToken[] {
  return tokens.map((token) =>
    ranges.some((range) => token.index >= range.from && token.index < range.to - 1)
      ? { ...token, noBreakAfter: true }
      : token,
  );
}

function rangeOf(index: number, ranges: readonly EmphasisRange[]): EmphasisRange | undefined {
  return ranges.find((range) => index >= range.from && index < range.to);
}

/**
 * Spans for one line. Punctuation before the first and after the last word
 * of a phrase stays outside the emphasis ("cá mập," → "cá mập" + ",");
 * the space between two words of the same phrase is emphasized.
 * Joining the span texts always gives the line text.
 */
export function buildSpans(lineTokens: readonly SubtitleToken[], ranges: readonly EmphasisRange[]): SubtitleSpan[] {
  const pieces: SubtitleSpan[] = [];
  lineTokens.forEach((token, position) => {
    const range = rangeOf(token.index, ranges);
    if (position > 0) {
      const previous = rangeOf(token.index - 1, ranges);
      pieces.push({ text: ' ', emphasis: range !== undefined && range === previous });
    }
    if (!range) {
      pieces.push({ text: token.text, emphasis: false });
      return;
    }
    // A pure symbol token ("%") has no core: it is emphasized as a whole.
    const coreStart = token.core ? token.text.indexOf(token.core) : 0;
    const coreEnd = token.core ? coreStart + token.core.length : token.text.length;
    const start = token.index === range.from ? coreStart : 0;
    const end = token.index === range.to - 1 ? coreEnd : token.text.length;
    pieces.push(
      { text: token.text.slice(0, start), emphasis: false },
      { text: token.text.slice(start, end), emphasis: true },
      { text: token.text.slice(end), emphasis: false },
    );
  });

  const spans: SubtitleSpan[] = [];
  for (const piece of pieces) {
    const last = spans.at(-1);
    if (!piece.text) {
      continue;
    }
    if (last && last.emphasis === piece.emphasis) {
      last.text += piece.text;
    } else {
      spans.push({ ...piece });
    }
  }
  return spans;
}
