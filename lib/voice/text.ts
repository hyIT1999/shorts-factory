/**
 * Light narration normalization and validation. Normalization never changes
 * meaning: it only trims, collapses whitespace and applies Unicode NFC. In
 * particular VOICE never adds Vietnamese diacritics — text without them is
 * rejected so the problem is fixed upstream (SCRIPT).
 */
import { VoiceError } from './errors.js';

export function normalizeNarration(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** "vi-VN" → "vi". */
export function normalizeLanguage(language: string): string {
  return language.trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

/** Letters that only exist with Vietnamese diacritics (plus đ). */
const VIETNAMESE_MARKED = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

/** Below this many words the diacritic check is not meaningful. */
const MIN_WORDS_FOR_CHECK = 8;
/** Real Vietnamese has diacritics on roughly half of its syllables; unaccented text has ~0. */
const MIN_MARKED_WORD_RATIO = 0.15;

export function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => /\p{L}/u.test(w));
}

/** Share of words carrying at least one Vietnamese diacritic. */
export function vietnameseMarkedRatio(text: string): number {
  const list = words(text.normalize('NFC'));
  if (list.length === 0) {
    return 0;
  }
  return list.filter((w) => VIETNAMESE_MARKED.test(w)).length / list.length;
}

/**
 * Throws TEXT_NOT_VIETNAMESE when a (long enough) Vietnamese narration has
 * almost no diacritics, e.g. "Ban co biet vi sao bach tuoc…".
 */
export function assertVietnamese(narration: string): void {
  const count = words(narration).length;
  if (count < MIN_WORDS_FOR_CHECK) {
    return;
  }
  const ratio = vietnameseMarkedRatio(narration);
  if (ratio < MIN_MARKED_WORD_RATIO) {
    throw new VoiceError(
      'TEXT_NOT_VIETNAMESE',
      `Narration is marked as Vietnamese but only ${Math.round(ratio * 100)}% of words have diacritics (text without accents cannot be voiced correctly)`,
    );
  }
}

/** Rough speaking time used only as a sanity check / by the silent provider (~3.3 words/s). */
export function estimateSpeechSeconds(text: string): number {
  return Math.max(0.5, words(text).length * 0.3);
}
