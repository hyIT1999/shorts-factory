/**
 * A model of what libass 0.17 draws for one Dialogue text, used by the tests as
 * an oracle for the ASS escaping: libassVisibleText(escapeAssText(s)) === s.
 *
 * It deliberately lives outside lib/: the render path must not depend on a
 * model of libass, because a mistake here would then fail renders that are
 * perfectly fine. In the tests it costs nothing and catches regressions.
 *
 * The three rules it mirrors, from the libass sources:
 *  - ass_render.c parse_events: "{" starts an override block only when some "}"
 *    follows later in the same event; the block, braces included, is not drawn.
 *  - ass_parse.c ass_get_next_char: "\N" and "\n" are line breaks (we set
 *    WrapStyle 2), "\h" is a non-breaking space, "\{" and "\}" are literal
 *    braces; every other backslash is drawn as a backslash.
 *  - ass_shaper.c is_harfbuzz_ignorable: default-ignorable code points are
 *    skipped before a font is chosen, so they draw nothing at all.
 */
const NBSP = String.fromCharCode(0xa0);

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

/** The characters a viewer sees, with line breaks as "\n". */
export function libassVisibleText(dialogue: string): string {
  let visible = '';
  let at = 0;
  while (at < dialogue.length) {
    const char = dialogue[at];
    if (char === '{') {
      const close = dialogue.indexOf('}', at + 1);
      if (close !== -1) {
        at = close + 1;
        continue;
      }
    }
    if (char === '\\') {
      const next = dialogue[at + 1];
      if (next === 'N' || next === 'n') {
        visible += '\n';
        at += 2;
        continue;
      }
      if (next === 'h') {
        visible += NBSP;
        at += 2;
        continue;
      }
      if (next === '{' || next === '}') {
        visible += next;
        at += 2;
        continue;
      }
    }
    const codePoint = dialogue.codePointAt(at) ?? 0;
    const glyph = String.fromCodePoint(codePoint);
    at += glyph.length;
    if (!isIgnorable(codePoint)) {
      visible += glyph;
    }
  }
  return visible;
}
