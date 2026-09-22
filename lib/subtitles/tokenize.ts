/**
 * Deterministic tokenizer for subtitle segmentation. Text is split on
 * whitespace only; punctuation stays attached to its word, so joining the
 * tokens with single spaces rebuilds the (normalized) narration exactly.
 * Letters are matched with Unicode properties (\p{L}\p{M}), never \w, so
 * Vietnamese diacritics are handled like any other letter.
 */
import { SubtitleError } from './errors.js';
import { MAX_SCENE_CHARS, type BoundaryType, type SubtitleToken } from './types.js';

const LEADING_NON_WORD = /^[^\p{L}\p{M}\p{N}]+/u;
const TRAILING_NON_WORD = /[^\p{L}\p{M}\p{N}]+$/u;
const TRAILING_CLOSERS = /[)\]}"'”’»]+$/u;
const NUMBER = /^\p{N}[\p{N}.,]*$/u;
const LATIN_VOWEL_GROUPS = /[aeiouy]+/g;

const SENTENCE_END = new Set(['.', '?', '!', '…']);
const CLAUSE_END = new Set([';', ':', '—', '–']);
const DASHES = new Set(['-', '—', '–']);

/** Abbreviations whose final dot does not end a sentence. */
const ABBREVIATIONS = new Set(['tp.', 'ts.', 'gs.', 'pgs.', 'ths.', 'bs.', 'mr.', 'mrs.', 'ms.', 'dr.', 'st.', 'vs.', 'tr.', 'etc.']);
/** "v.v.", "e.g.", "U.S.": single letters each followed by a dot. */
const DOTTED_INITIALS = /^(?:\p{L}\.){2,}$/u;

/** Words that start a new phrase: breaking before them keeps phrases whole. */
export const CONNECTORS: ReadonlySet<string> = new Set([
  'và', 'nhưng', 'mà', 'để', 'khi', 'vì', 'nên', 'thì', 'nếu', 'rằng', 'của', 'với', 'cùng', 'hoặc', 'hay',
  'như', 'từ', 'trong', 'khiến', 'giúp',
]);

/** Function words that should not end a segment or a line. */
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  ...CONNECTORS,
  'là', 'các', 'những', 'một', 'cho', 'ở', 'tại', 'về', 'bởi', 'bằng', 'do', 'đến', 'tới', 'sẽ', 'đã', 'đang',
  'được', 'bị', 'rất', 'cũng',
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'from', 'by', 'at', 'is', 'are',
]);

/** Units that must stay on the same segment/line as the number before them. */
const UNITS: ReadonlySet<string> = new Set([
  'kg', 'g', 'mg', 'km', 'm', 'cm', 'mm', 'nm', 'ha', 'l', 'ml', 'lít', 'mét', 'độ', 'triệu', 'tỷ', 'tỉ', 'nghìn',
  'ngàn', 'trăm', 'vạn', 'đồng', 'usd', 'vnd', 'đô', 'giờ', 'phút', 'giây', 'ngày', 'tuần', 'tháng', 'năm', 'lần',
  'tuổi', 'người', 'loài', 'con', 'km/h', 'm/s', 'mph', 'm²', 'km²',
]);

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '“': '”', '«': '»' };
const CLOSERS = new Set(Object.values(OPENERS));

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Length in code points (what a viewer perceives as characters, for NFC text). */
export function charLength(text: string): number {
  let length = text.length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // A surrogate pair is one code point.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        length--;
        i++;
      }
    }
  }
  return length;
}

/** C0 (0x00–0x1F), DEL (0x7F) and C1 (0x80–0x9F) control characters. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** Word without leading/trailing punctuation or symbols. */
export function coreOf(text: string): string {
  return text.replace(LEADING_NON_WORD, '').replace(TRAILING_NON_WORD, '');
}

/** Vietnamese letters decompose to a base letter + combining marks (except đ). */
function hasDiacritics(word: string): boolean {
  return /\p{Mn}/u.test(word.normalize('NFD')) || /[đĐ]/.test(word);
}

/**
 * Rough spoken length: a Vietnamese word is one syllable; longer Latin words
 * (English, scientific terms) count vowel groups; numbers count digits (1–4);
 * emoji and symbols count half a syllable.
 */
export function syllableWeight(core: string): number {
  if (!core) {
    return 0.5;
  }
  if (NUMBER.test(core)) {
    const digits = core.replace(/[.,]/g, '').length;
    return Math.min(4, Math.max(1, digits));
  }
  if (!/\p{L}/u.test(core)) {
    return 0.5;
  }
  if (charLength(core) <= 4 || hasDiacritics(core)) {
    return 1;
  }
  return Math.max(1, core.toLowerCase().match(LATIN_VOWEL_GROUPS)?.length ?? 1);
}

function punctuationBoundary(text: string): BoundaryType | null {
  const trimmed = text.replace(TRAILING_CLOSERS, '');
  if (DASHES.has(trimmed)) {
    return 'CLAUSE';
  }
  const last = [...trimmed].at(-1) ?? '';
  if (SENTENCE_END.has(last)) {
    const lower = trimmed.toLowerCase();
    return last === '.' && (ABBREVIATIONS.has(lower) || DOTTED_INITIALS.test(trimmed)) ? null : 'SENTENCE';
  }
  if (CLAUSE_END.has(last)) {
    return 'CLAUSE';
  }
  return last === ',' ? 'COMMA' : null;
}

function isNumberFollowedByUnit(token: string, next: string | undefined): boolean {
  // "400," ends a clause: only a bare number is glued to its unit.
  if (next === undefined || !NUMBER.test(token) || !/\p{N}$/u.test(token)) {
    return false;
  }
  const lower = next.toLowerCase();
  return lower.startsWith('%') || lower.startsWith('°') || UNITS.has(coreOf(lower));
}

/**
 * Marks the positions inside a bracket or quote pair (only pairs that close
 * later in the scene) as "no break". Straight double quotes toggle.
 */
function groupedPositions(texts: readonly string[]): boolean[] {
  const inside = texts.map(() => false);
  const stack: { closer: string; token: number }[] = [];
  texts.forEach((text, tokenIndex) => {
    for (const char of text) {
      const top = stack.at(-1);
      const closer = OPENERS[char];
      if (char === '"') {
        if (top?.closer === '"') {
          stack.pop();
          inside.fill(true, top.token, tokenIndex);
        } else {
          stack.push({ closer: '"', token: tokenIndex });
        }
      } else if (closer !== undefined) {
        stack.push({ closer, token: tokenIndex });
      } else if (CLOSERS.has(char) && top?.closer === char) {
        stack.pop();
        inside.fill(true, top.token, tokenIndex);
      }
    }
  });
  return inside;
}

/** Splits normalized narration into tokens with boundary and weight metadata. */
export function tokenize(text: string): SubtitleToken[] {
  const texts = text.split(/\s+/).filter((part) => part.length > 0);
  const grouped = groupedPositions(texts);
  return texts.map((tokenText, index) => {
    const next = texts[index + 1];
    const core = coreOf(tokenText);
    const boundary =
      punctuationBoundary(tokenText) ?? (next !== undefined && CONNECTORS.has(coreOf(next).toLowerCase()) ? 'CONNECTOR' : 'NONE');
    return {
      text: tokenText,
      index,
      core,
      syllableWeight: syllableWeight(core),
      boundaryAfter: boundary,
      noBreakAfter: (grouped[index] ?? false) || isNumberFollowedByUnit(tokenText, next),
      // A function word ("của", "và"…) with nothing after it should not end a line or segment.
      functionWord: core === tokenText && FUNCTION_WORDS.has(core.toLowerCase()),
    };
  });
}

/**
 * Validates one normalized scene text. Content is never changed here: text
 * that cannot be shown safely fails the job instead.
 */
export function validateSceneText(text: string, sceneIndex: number): string {
  const scene = `Scene ${sceneIndex + 1}`;
  if (!text) {
    throw new SubtitleError('SUBTITLE_EMPTY_TEXT', `${scene} has no narration text`);
  }
  if (charLength(text) > MAX_SCENE_CHARS) {
    throw new SubtitleError('SUBTITLE_INVALID_TEXT', `${scene} text is longer than ${MAX_SCENE_CHARS} characters`);
  }
  if (hasControlCharacter(text)) {
    throw new SubtitleError('SUBTITLE_INVALID_TEXT', `${scene} text contains control characters`);
  }
  if (LONE_SURROGATE.test(text)) {
    throw new SubtitleError('SUBTITLE_INVALID_TEXT', `${scene} text contains invalid Unicode`);
  }
  return text;
}
