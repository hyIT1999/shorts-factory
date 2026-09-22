/**
 * Minimal TrueType/OpenType reader: just enough to tell whether the bundled
 * font really is the one the ASS styles ask for, and which characters it can
 * draw. Everything is bounds checked, so a truncated or foreign file fails with
 * RENDER_FONT_MISSING instead of throwing something unexpected at the worker.
 *
 * Missing glyphs are only ever a warning: libass falls back to a system font
 * for them (Windows DirectWrite), which is better than refusing to render a
 * whole video because the narration contains an emoji.
 */
import { RenderError } from './errors.js';

export interface FontFile {
  /** Typographic family (name ID 16) when present, else the family name (ID 1). */
  family: string;
  /** Typographic subfamily (name ID 17) when present, else the style name (ID 2). */
  subfamily: string;
  /** OS/2 usWeightClass (400 = regular, 700 = bold); 0 when there is no OS/2 table. */
  weight: number;
  bold: boolean;
  /** Glyph id for a code point (0 = cannot draw it); null when no cmap was usable. */
  glyphFor: ((codePoint: number) => number) | null;
}

type Lookup = (codePoint: number) => number;

const SFNT_VERSIONS = new Set([0x00010000, 0x74727565 /* "true" */, 0x4f54544f /* "OTTO" */]);
const MAC_PLATFORM = 1;
const WINDOWS_PLATFORM = 3;
const ENGLISH_US = 0x409;
/** Minimum usWeightClass still rendered as bold without libass synthesising it. */
const BOLD_WEIGHT = 600;
const MAX_LISTED_CHARACTERS = 8;

const invalid = (label: string, why: string) => new RenderError('RENDER_FONT_MISSING', `Font ${label} ${why}`);

function u16(bytes: Buffer, label: string, at: number): number {
  if (at < 0 || at + 2 > bytes.length) {
    throw invalid(label, 'is truncated');
  }
  return bytes.readUInt16BE(at);
}

function u32(bytes: Buffer, label: string, at: number): number {
  if (at < 0 || at + 4 > bytes.length) {
    throw invalid(label, 'is truncated');
  }
  return bytes.readUInt32BE(at);
}

/** Offsets of the tables we read, by their four-character tag. */
function readTableDirectory(bytes: Buffer, label: string): Map<string, { offset: number; length: number }> {
  const version = u32(bytes, label, 0);
  if (!SFNT_VERSIONS.has(version)) {
    throw invalid(label, 'is not a TrueType/OpenType font file');
  }
  const tables = new Map<string, { offset: number; length: number }>();
  const count = u16(bytes, label, 4);
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    const tag = bytes.subarray(record, record + 4).toString('latin1');
    const offset = u32(bytes, label, record + 8);
    const length = u32(bytes, label, record + 12);
    if (tag.length === 4 && offset + length <= bytes.length) {
      tables.set(tag, { offset, length });
    }
  }
  return tables;
}

/** Name records are UTF-16BE, except the legacy Macintosh ones. */
function decodeName(bytes: Buffer, platformId: number, at: number, length: number): string {
  const raw = bytes.subarray(at, at + length);
  if (platformId === MAC_PLATFORM) {
    return raw.toString('latin1');
  }
  let text = '';
  for (let i = 0; i + 1 < raw.length; i += 2) {
    text += String.fromCharCode(raw.readUInt16BE(i));
  }
  return text;
}

/** The best record for each name id (Windows English wins, then any Unicode record). */
function readNames(bytes: Buffer, label: string, table: { offset: number }): Map<number, string> {
  const { offset } = table;
  const count = u16(bytes, label, offset + 2);
  const storage = offset + u16(bytes, label, offset + 4);
  const names = new Map<number, string>();
  const scores = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const record = offset + 6 + i * 12;
    const platformId = u16(bytes, label, record);
    const languageId = u16(bytes, label, record + 4);
    const nameId = u16(bytes, label, record + 6);
    const length = u16(bytes, label, record + 8);
    const at = storage + u16(bytes, label, record + 10);
    if (at + length > bytes.length) {
      continue;
    }
    const score = platformId === WINDOWS_PLATFORM && languageId === ENGLISH_US ? 3 : platformId === WINDOWS_PLATFORM ? 2 : 1;
    if (score <= (scores.get(nameId) ?? 0)) {
      continue;
    }
    const value = decodeName(bytes, platformId, at, length).trim();
    if (value) {
      names.set(nameId, value);
      scores.set(nameId, score);
    }
  }
  return names;
}

/** cmap format 4: segmented mapping of the basic multilingual plane. */
function segmentedLookup(bytes: Buffer, label: string, at: number): Lookup {
  const segments = u16(bytes, label, at + 6) / 2;
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  u16(bytes, label, rangeOffsets + segments * 2 - 2); // bounds check for the whole table
  return (codePoint) => {
    if (codePoint > 0xffff) {
      return 0;
    }
    for (let segment = 0; segment < segments; segment++) {
      if (codePoint > bytes.readUInt16BE(ends + segment * 2)) {
        continue;
      }
      const start = bytes.readUInt16BE(starts + segment * 2);
      if (codePoint < start) {
        return 0;
      }
      const delta = bytes.readInt16BE(deltas + segment * 2);
      const rangeOffset = bytes.readUInt16BE(rangeOffsets + segment * 2);
      if (rangeOffset === 0) {
        return (codePoint + delta) & 0xffff;
      }
      const glyphAt = rangeOffsets + segment * 2 + rangeOffset + (codePoint - start) * 2;
      if (glyphAt + 2 > bytes.length) {
        return 0;
      }
      const glyph = bytes.readUInt16BE(glyphAt);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
}

/** cmap format 12: grouped ranges, the only format that reaches emoji. */
function groupedLookup(bytes: Buffer, label: string, at: number): Lookup {
  const groups = u32(bytes, label, at + 12);
  const base = at + 16;
  if (base + groups * 12 > bytes.length) {
    throw invalid(label, 'has a truncated character map');
  }
  return (codePoint) => {
    let low = 0;
    let high = groups - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const group = base + middle * 12;
      const start = bytes.readUInt32BE(group);
      const end = bytes.readUInt32BE(group + 4);
      if (codePoint < start) {
        high = middle - 1;
      } else if (codePoint > end) {
        low = middle + 1;
      } else {
        return bytes.readUInt32BE(group + 8) + (codePoint - start);
      }
    }
    return 0;
  };
}

/** cmap format 6: one dense range. */
function denseLookup(bytes: Buffer, label: string, at: number): Lookup {
  const first = u16(bytes, label, at + 6);
  const count = u16(bytes, label, at + 8);
  const base = at + 10;
  if (base + count * 2 > bytes.length) {
    throw invalid(label, 'has a truncated character map');
  }
  return (codePoint) => (codePoint < first || codePoint >= first + count ? 0 : bytes.readUInt16BE(base + (codePoint - first) * 2));
}

/** The richest character map in the file (format 12 beats 4 beats 6). */
function readCmap(bytes: Buffer, label: string, table: { offset: number }): Lookup | null {
  const count = u16(bytes, label, table.offset + 2);
  let best: { rank: number; lookup: Lookup } | null = null;
  for (let i = 0; i < count; i++) {
    const record = table.offset + 4 + i * 8;
    const at = table.offset + u32(bytes, label, record + 4);
    if (at + 4 > bytes.length) {
      continue;
    }
    const format = u16(bytes, label, at);
    const rank = format === 12 ? 3 : format === 4 ? 2 : format === 6 ? 1 : 0;
    if (rank === 0 || rank <= (best?.rank ?? 0)) {
      continue;
    }
    const lookup = format === 12 ? groupedLookup(bytes, label, at) : format === 4 ? segmentedLookup(bytes, label, at) : denseLookup(bytes, label, at);
    best = { rank, lookup };
  }
  return best?.lookup ?? null;
}

/** Reads the name, OS/2 and cmap tables. Throws RENDER_FONT_MISSING for anything unusable. */
export function parseFontFile(bytes: Buffer, label: string): FontFile {
  const tables = readTableDirectory(bytes, label);
  const nameTable = tables.get('name');
  if (!nameTable) {
    throw invalid(label, 'has no name table');
  }
  const names = readNames(bytes, label, nameTable);
  const family = names.get(16) ?? names.get(1);
  if (!family) {
    throw invalid(label, 'has no family name');
  }
  const os2 = tables.get('OS/2');
  const head = tables.get('head');
  const weight = os2 ? u16(bytes, label, os2.offset + 4) : 0;
  const bold = os2
    ? (u16(bytes, label, os2.offset + 62) & 0x20) !== 0
    : head
      ? (u16(bytes, label, head.offset + 44) & 0x01) !== 0
      : false;
  const cmap = tables.get('cmap');
  return {
    family,
    subfamily: names.get(17) ?? names.get(2) ?? '',
    weight,
    bold,
    glyphFor: cmap ? readCmap(bytes, label, cmap) : null,
  };
}

/** Code points libass never looks up in a font, so a missing glyph does not matter. */
function isIgnorable(codePoint: number): boolean {
  return (
    codePoint === 0x00ad ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xfff9 && codePoint <= 0xfffb) ||
    (codePoint >= 0x1d173 && codePoint <= 0x1d17a) ||
    (codePoint >= 0xe0000 && codePoint <= 0xe0fff)
  );
}

/** Distinct code points of `texts` the font cannot draw (empty when it has no usable cmap). */
export function uncoveredCodePoints(font: FontFile, texts: Iterable<string>): number[] {
  const { glyphFor } = font;
  if (!glyphFor) {
    return [];
  }
  const seen = new Set<number>();
  const missing = new Set<number>();
  for (const text of texts) {
    for (const char of text) {
      const codePoint = char.codePointAt(0) ?? 0;
      if (seen.has(codePoint)) {
        continue;
      }
      seen.add(codePoint);
      if (codePoint === 0x20 || isIgnorable(codePoint)) {
        continue;
      }
      if (glyphFor(codePoint) === 0) {
        missing.add(codePoint);
      }
    }
  }
  return [...missing].sort((a, b) => a - b);
}

/**
 * What is wrong with the bundled font for these subtitles, as human-readable
 * warnings. Nothing here fails a render: libass still draws the text, using a
 * system font where the bundled one has no glyph.
 */
export function checkFont(font: FontFile, expectedFamily: string, texts: Iterable<string>, label: string): string[] {
  const warnings: string[] = [];
  const normalize = (value: string) => value.trim().toLowerCase();
  if (normalize(font.family) !== normalize(expectedFamily)) {
    warnings.push(`${label} is "${font.family}", not "${expectedFamily}"; libass will draw the subtitles with a system font`);
  } else if (font.weight > 0 && font.weight < BOLD_WEIGHT && !font.bold) {
    warnings.push(`${label} has weight ${font.weight}, not a bold face; libass will synthesise the bold look`);
  }
  if (!font.glyphFor) {
    warnings.push(`${label} has no usable character map; glyph coverage could not be checked`);
    return warnings;
  }
  const missing = uncoveredCodePoints(font, texts);
  if (missing.length > 0) {
    const listed = missing.slice(0, MAX_LISTED_CHARACTERS).map((codePoint) => String.fromCodePoint(codePoint)).join(' ');
    const rest = missing.length > MAX_LISTED_CHARACTERS ? `, +${missing.length - MAX_LISTED_CHARACTERS} more` : '';
    warnings.push(`${label} cannot draw ${missing.length} character(s) used in the subtitles (${listed}${rest}); they fall back to a system font`);
  }
  return warnings;
}
