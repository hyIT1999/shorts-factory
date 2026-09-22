/**
 * SubtitleResult → ASS (Advanced SubStation Alpha) document, burned in by
 * FFmpeg's libass `ass` filter. Pure and deterministic. The subtitle text only
 * ever goes into this file, never into a command line or filtergraph.
 *
 * Layout comes from SUBTITLES: each SubtitleLine becomes one visual line joined
 * with the hard break \N, and WrapStyle 2 disables libass's own wrapping, so a
 * caption never turns into a third line. Emphasis spans switch to the
 * "Emphasis" style and back with \r.
 */
import type { SubtitleResult } from '../subtitles/types.js';
import { RenderError } from './errors.js';
import { FONT_FAMILY, RENDER_SPEC } from './types.js';

export interface AssStyle {
  fontFamily: string;
  fontSize: number;
  /** "#RRGGBB" */
  primaryColor: string;
  emphasisColor: string;
  outlineColor: string;
  outlineWidth: number;
  shadow: number;
  /** Left/right margins in pixels (PlayRes coordinates). */
  marginHorizontal: number;
  /** Vertical centre of a two-line caption, as a share of the frame height. */
  centerY: number;
}

export const DEFAULT_ASS_STYLE: AssStyle = {
  fontFamily: FONT_FAMILY,
  fontSize: 66,
  primaryColor: '#FFFFFF',
  emphasisColor: '#FFD400',
  outlineColor: '#000000',
  outlineWidth: 5,
  shadow: 2,
  marginHorizontal: 90,
  centerY: 0.66,
};

/** Approximate libass line height relative to the font size (used only to place the caption). */
const LINE_HEIGHT_RATIO = 1.25;
/** Semi-transparent black drop shadow (ASS alpha 0x80). */
const SHADOW_COLOR = '&H80000000';
/**
 * U+2060 WORD JOINER. libass marks the default-ignorable code points as skipped
 * (ass_shaper.c) before it picks a font, so this one is never looked up, draws
 * nothing and takes no width, even though the bundled font has no glyph for it.
 */
const WORD_JOINER = String.fromCharCode(0x2060);
/** Right after a bare backslash, libass reads these as \N, \n or \h (ass_parse.c). */
const ESCAPE_TRIGGERS = new Set(['N', 'n', 'h']);

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Milliseconds → ASS timestamp "H:MM:SS.cc" (centiseconds, rounded). */
export function msToAssTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RenderError('RENDER_SUBTITLES_INVALID', `Invalid subtitle time: ${ms}`);
  }
  const cs = Math.round(ms / 10);
  const hours = Math.floor(cs / 360_000);
  const minutes = Math.floor(cs / 6000) % 60;
  const seconds = Math.floor(cs / 100) % 60;
  return `${hours}:${pad2(minutes)}:${pad2(seconds)}.${pad2(cs % 100)}`;
}

/**
 * "#RRGGBB" → ASS colour "&HAABBGGRR". ASS stores blue first, so #FFD400
 * (yellow) is &H0000D4FF, not &H00FFD400. Alpha 0 is opaque.
 */
export function assColor(hex: string, alpha = 0): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) {
    throw new RenderError('RENDER_GENERATION_ERROR', `Invalid colour "${hex}"`);
  }
  const [, red, green, blue] = match;
  return `&H${alpha.toString(16).padStart(2, '0')}${blue}${green}${red}`.toUpperCase();
}

/**
 * Makes subtitle text inert in ASS without changing a single visible character:
 * - control characters (never expected after SUBTITLES) become spaces;
 * - { and } become the libass escapes \{ and \}, which draw the brace itself.
 *   Every { has to be escaped, not just the ones that look like a tag: libass
 *   opens an override block at any { that has some } later in the event, and
 *   that search ignores escaping (ass_render.c parse_events);
 * - a literal backslash that would pair with the next character into \N, \n or
 *   \h gets an invisible word joiner after it, and so does a trailing one. The
 *   result is therefore safe to concatenate with {\rEmphasis}, \N or the next
 *   span. A backslash before a brace needs nothing: the escape's own backslash
 *   already separates the two.
 * Vietnamese letters, emoji and everything else are kept as they are.
 */
export function escapeAssText(text: string): string {
  let safe = '';
  let bareBackslash = false;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      safe += ' ';
      bareBackslash = false;
      continue;
    }
    if (char === '{' || char === '}') {
      safe += `\\${char}`;
      bareBackslash = false;
      continue;
    }
    if (bareBackslash && ESCAPE_TRIGGERS.has(char)) {
      safe += WORD_JOINER;
    }
    safe += char;
    bareBackslash = char === '\\';
  }
  return bareBackslash ? safe + WORD_JOINER : safe;
}

function styleLine(name: string, style: AssStyle, primary: string): string {
  const { height } = RENDER_SPEC;
  const marginV = Math.round(height - (height * style.centerY + style.fontSize * LINE_HEIGHT_RATIO));
  return [
    `Style: ${name}`,
    style.fontFamily,
    style.fontSize,
    assColor(primary),
    assColor(style.emphasisColor),
    assColor(style.outlineColor),
    SHADOW_COLOR,
    -1, // bold
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    1, // outline + drop shadow
    style.outlineWidth,
    style.shadow,
    2, // bottom centre
    style.marginHorizontal,
    style.marginHorizontal,
    marginV,
    1,
  ].join(',');
}

/** Checks the timeline RENDER relies on: sorted, contiguous from 0, non-empty after rounding. */
function assertRenderableTiming(result: SubtitleResult): void {
  let cursor = 0;
  for (const segment of result.segments) {
    const start = Math.round(segment.startMs / 10);
    const end = Math.round(segment.endMs / 10);
    if (segment.startMs !== cursor || segment.endMs <= segment.startMs || end <= start) {
      throw new RenderError('RENDER_SUBTITLES_INVALID', `Subtitle segment ${segment.id} has an invalid time range`);
    }
    cursor = segment.endMs;
  }
  if (cursor !== result.durationMs) {
    throw new RenderError('RENDER_SUBTITLES_INVALID', 'Subtitles do not cover the whole video');
  }
}

function dialogueText(segment: SubtitleResult['segments'][number]): string {
  return segment.lines
    .map((line) =>
      line.spans
        .map((span) => (span.emphasis ? `{\\rEmphasis}${escapeAssText(span.text)}{\\rDefault}` : escapeAssText(span.text)))
        .join(''),
    )
    .join('\\N');
}

export function buildAss(result: SubtitleResult, style: AssStyle = DEFAULT_ASS_STYLE): string {
  assertRenderableTiming(result);
  const lines = [
    '[Script Info]',
    `; Shorts Factory subtitles (${result.algorithm}, input ${result.inputHash})`,
    'ScriptType: v4.00+',
    `PlayResX: ${RENDER_SPEC.width}`,
    `PlayResY: ${RENDER_SPEC.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    styleLine('Default', style, style.primaryColor),
    styleLine('Emphasis', style, style.emphasisColor),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...result.segments.map(
      (segment) =>
        `Dialogue: 0,${msToAssTimestamp(segment.startMs)},${msToAssTimestamp(segment.endMs)},Default,,0,0,0,,${dialogueText(segment)}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
