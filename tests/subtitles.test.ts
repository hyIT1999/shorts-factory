/**
 * SUBTITLES Phase A: pure functions (tokenize, wrap, emphasis, segmentation,
 * timing) and generateSubtitles, without a database.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildSpans, matchEmphasis, parseEmphasis } from '../lib/subtitles/emphasis.js';
import { SubtitleError } from '../lib/subtitles/errors.js';
import { generateSubtitles } from '../lib/subtitles/service.js';
import { segmentScene } from '../lib/subtitles/segment.js';
import { allocateTimes, toMs, tokenWeights } from '../lib/subtitles/timing.js';
import { charLength, syllableWeight, tokenize, validateSceneText } from '../lib/subtitles/tokenize.js';
import {
  MAX_CHARS_PER_LINE,
  MIN_SEGMENT_MS,
  SubtitleResultSchema,
  type SubtitleInput,
  type SubtitleResult,
} from '../lib/subtitles/types.js';
import { orderScenes } from '../lib/subtitles/validate.js';
import { wrapSegment } from '../lib/subtitles/wrap.js';

interface SceneSpec {
  text: string;
  ms: number;
  em?: unknown;
}

/** Contiguous scenes from 0; `em` is serialized like Scene.subtitleEmphasisJson (strings are kept raw). */
function makeInput(scenes: SceneSpec[], language = 'vi'): SubtitleInput {
  let cursor = 0;
  return {
    videoId: 'video-1',
    language,
    scenes: scenes.map((scene, index) => {
      const startMs = cursor;
      cursor += scene.ms;
      return {
        id: `scene-${index}`,
        index,
        text: scene.text,
        startMs,
        endMs: cursor,
        emphasisJson: scene.em === undefined ? null : typeof scene.em === 'string' ? scene.em : JSON.stringify(scene.em),
      };
    }),
  };
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof SubtitleError && error.code === code;
}

/** Structural checks every result must pass (independent of the implementation's own invariants). */
function assertWellFormed(result: SubtitleResult, input: SubtitleInput): void {
  SubtitleResultSchema.parse(result);
  let cursor = 0;
  for (const segment of result.segments) {
    assert.ok(Number.isInteger(segment.startMs) && Number.isInteger(segment.endMs), 'integer milliseconds');
    assert.equal(segment.startMs, cursor, `segment ${segment.id} starts where the previous one ends`);
    assert.ok(segment.endMs > segment.startMs, `segment ${segment.id} has a duration`);
    cursor = segment.endMs;
    const scene = input.scenes[segment.sceneIndex];
    assert.ok(scene, 'segment belongs to a scene');
    assert.ok(segment.startMs >= scene.startMs && segment.endMs <= scene.endMs, 'segment stays inside its scene');
    assert.ok(segment.lines.length >= 1 && segment.lines.length <= 2);
    assert.equal(segment.lines.map((line) => line.text).join(' '), segment.text);
    for (const line of segment.lines) {
      assert.equal(line.spans.map((span) => span.text).join(''), line.text);
      assert.ok(charLength(line.text) <= MAX_CHARS_PER_LINE || !line.text.includes(' '), `line "${line.text}" fits`);
    }
    assert.equal(segment.words, undefined, 'no word timings in Phase A');
  }
  assert.equal(cursor, result.durationMs);
  for (const scene of input.scenes) {
    const own = result.segments.filter((segment) => segment.sceneIndex === scene.index);
    assert.equal(own.map((segment) => segment.text).join(' '), scene.text, `scene ${scene.index} text is rebuilt exactly`);
    assert.equal(own[0]?.startMs, scene.startMs);
    assert.equal(own.at(-1)?.endMs, scene.endMs);
  }
}

const emphasized = (result: SubtitleResult) =>
  result.segments.flatMap((segment) => segment.lines.flatMap((line) => line.spans.filter((s) => s.emphasis).map((s) => s.text)));

/** The "leaves" video from the dev database (VOICE silent): 6 scenes, 41.7 s. */
const LEAVES: SceneSpec[] = [
  { text: 'Bạn có bao giờ tự hỏi tại sao lá cây lại đổi màu rực rỡ trước khi rụng xuống?', ms: toMs(5.7), em: ['đổi màu rực rỡ', 'rụng xuống'] },
  { text: 'Khi mùa thu đến, ngày ngắn lại và cây ngừng quá trình quang hợp khiến chất diệp lục màu xanh biến mất.', ms: toMs(6.6), em: ['quá trình quang hợp', 'chất diệp lục'] },
  { text: 'Lúc này, các sắc tố vàng và cam vốn bị lấn át suốt mùa hè mới chính thức lộ diện.', ms: toMs(6), em: ['sắc tố vàng và cam', 'lộ diện'] },
  { text: 'Kỳ lạ hơn, màu đỏ và tím rực rỡ lại được tạo ra hoàn toàn mới từ lượng đường còn kẹt lại trong lá dưới ánh nắng.', ms: toMs(8.1), em: ['màu đỏ và tím', 'lượng đường'] },
  { text: 'Tất cả những thay đổi này thực chất là một chiến lược sinh tồn thông minh, khi cây chủ động cắt đứt nguồn nuôi để giữ ẩm và vượt qua mùa đông lạnh giá.', ms: toMs(10.2), em: ['chiến lược sinh tồn', 'mùa đông lạnh giá'] },
  { text: 'Hãy bấm đăng ký kênh để khám phá thêm nhiều điều kỳ diệu của tự nhiên nhé!', ms: toMs(5.1), em: ['đăng ký kênh', 'điều kỳ diệu'] },
];

/** The longest real Gemini scene: 190 characters, 41 syllables, 15.72 s. */
const CAT_LONG: SceneSpec = {
  text: 'Nhờ sở hữu cột sống siêu linh hoạt cùng việc không có xương đòn gắn kết cứng, chúng có thể dễ dàng uốn cong và xoay nửa thân trước rồi nửa thân sau theo các hướng khác nhau trên không trung.',
  ms: 15720,
  em: ['cột sống siêu linh hoạt', 'xoay nửa thân'],
};

describe('tokenize', () => {
  test('splits on whitespace, keeps punctuation attached and rebuilds the text', () => {
    const text = 'Bạn có biết, vì sao bạch tuộc (Octopus) có ba trái tim?';
    const tokens = tokenize(text);
    assert.deepEqual(
      tokens.map((t) => t.text),
      ['Bạn', 'có', 'biết,', 'vì', 'sao', 'bạch', 'tuộc', '(Octopus)', 'có', 'ba', 'trái', 'tim?'],
    );
    assert.equal(tokens.map((t) => t.text).join(' '), text);
    assert.equal(tokens[7]?.core, 'Octopus');
    assert.deepEqual(tokens.map((t) => t.index), [...tokens.keys()]);
  });

  test('detects sentence, clause, comma and connector boundaries', () => {
    const tokens = tokenize('Vì sao? Trời xanh, mây trắng; gió thổi — rồi mưa! Nhưng lá rơi và đất ướt… “Thật đẹp.”');
    const boundary = (word: string) => tokens.find((t) => t.text === word)?.boundaryAfter;
    assert.equal(boundary('sao?'), 'SENTENCE');
    assert.equal(boundary('xanh,'), 'COMMA');
    assert.equal(boundary('trắng;'), 'CLAUSE');
    assert.equal(boundary('—'), 'CLAUSE');
    assert.equal(boundary('mưa!'), 'SENTENCE');
    assert.equal(boundary('rơi'), 'CONNECTOR', 'next word "và" is a connector');
    assert.equal(boundary('ướt…'), 'SENTENCE');
    assert.equal(boundary('đẹp.”'), 'SENTENCE', 'closing quote after the dot');
    assert.equal(boundary('Trời'), 'NONE');
  });

  test('abbreviations, acronyms and dots or commas inside numbers are not sentence ends', () => {
    const tokens = tokenize('Ở TP.HCM có v.v. nhiều DNA, khoảng 4,5 hay 1.000 mẫu năm 2024.');
    const boundary = (word: string) => tokens.find((t) => t.text === word)?.boundaryAfter;
    assert.equal(boundary('TP.HCM'), 'NONE');
    assert.equal(boundary('v.v.'), 'NONE');
    assert.equal(boundary('DNA,'), 'COMMA');
    assert.equal(boundary('4,5'), 'CONNECTOR', 'next word "hay" is a connector');
    assert.equal(boundary('1.000'), 'NONE');
    assert.equal(boundary('2024.'), 'SENTENCE');
    assert.equal(tokenize('Tiến sĩ Dr. Minh')[1]?.boundaryAfter, 'NONE');
  });

  test('syllable weights are deterministic heuristics', () => {
    assert.equal(syllableWeight('mèo'), 1);
    assert.equal(syllableWeight('nghiêng'), 1, 'Vietnamese word with diacritics');
    assert.equal(syllableWeight('trong'), 1, 'short or unaccented Vietnamese word');
    assert.equal(syllableWeight('DNA'), 1);
    assert.equal(syllableWeight('hemocyanin'), 4, 'Latin word: vowel groups');
    assert.equal(syllableWeight('oxygen'), 3);
    assert.equal(syllableWeight('5'), 1);
    assert.equal(syllableWeight('400'), 3);
    assert.equal(syllableWeight('4,5'), 2);
    assert.equal(syllableWeight('1.000'), 4);
    assert.equal(syllableWeight('123456'), 4, 'capped at 4');
    assert.equal(syllableWeight(''), 0.5, 'emoji / symbol');
    const emoji = tokenize(`Mèo ${String.fromCodePoint(0x1f63a)} ngủ`)[1];
    assert.equal(emoji?.core, '');
    assert.equal(emoji?.syllableWeight, 0.5);
  });

  test('a number is glued to its unit', () => {
    const glued = (text: string) => tokenize(text)[0]?.noBreakAfter;
    assert.equal(glued('400 triệu năm'), true);
    assert.equal(glued('50 % dân số'), true);
    assert.equal(glued('4,5 kg thịt'), true);
    assert.equal(glued('1.000 đồng một'), true);
    assert.equal(glued('400, triệu người'), false, 'the comma separates them');
    assert.equal(glued('400 con mèo'), true);
    assert.equal(glued('Mèo 400 con')?.valueOf(), false);
  });

  test('positions inside closed brackets and quotes are no-break; unclosed ones are ignored', () => {
    const tokens = tokenize('Theo (số liệu năm 2024) và "nhiều nhà khoa học" thì đúng');
    const noBreak = tokens.map((t) => t.noBreakAfter);
    // (số liệu năm 2024): after "(số", "liệu", "năm" → inside; after "2024)" → free.
    assert.deepEqual(noBreak.slice(0, 6), [false, true, true, true, false, false]);
    // "nhiều nhà khoa học": inside after "\"nhiều", "nhà", "khoa".
    assert.deepEqual(noBreak.slice(6, 10), [true, true, true, false]);
    assert.ok(tokenize('Theo (số liệu năm 2024 thì đúng').every((t) => !t.noBreakAfter), 'unclosed bracket');
  });

  test('marks bare function words only', () => {
    const tokens = tokenize('Cây của rừng và, là');
    assert.deepEqual(tokens.map((t) => t.functionWord), [false, true, false, false, true]);
  });
});

describe('text validation', () => {
  test('empty, control characters, invalid Unicode and oversized text are rejected', () => {
    assert.throws(() => validateSceneText('', 0), errorCode('SUBTITLE_EMPTY_TEXT'));
    assert.throws(() => validateSceneText(`Mèo${String.fromCharCode(7)} ngủ`, 0), errorCode('SUBTITLE_INVALID_TEXT'));
    assert.throws(() => validateSceneText(`Mèo${String.fromCharCode(0x7f)}`, 0), errorCode('SUBTITLE_INVALID_TEXT'));
    assert.throws(() => validateSceneText(`Mèo${String.fromCharCode(0x85)}`, 0), errorCode('SUBTITLE_INVALID_TEXT'));
    assert.throws(() => validateSceneText(`Mèo ${String.fromCharCode(0xd800)} ngủ`, 0), errorCode('SUBTITLE_INVALID_TEXT'));
    assert.throws(() => validateSceneText('mèo '.repeat(300).trim(), 2), /Scene 3 text is longer than 1000/);
    assert.equal(validateSceneText('Mèo ngủ 😺', 0), 'Mèo ngủ 😺');
  });
});

describe('line wrapping', () => {
  const lines = (text: string) => wrapSegment(tokenize(text))?.map((line) => line.map((t) => t.text).join(' '));

  test('one line up to 22 characters, two lines above', () => {
    assert.deepEqual(lines('Khi mùa thu đến'), ['Khi mùa thu đến']);
    const exactly22 = 'Mèo luôn tiếp đất bằng';
    assert.equal(charLength(exactly22), 22);
    assert.deepEqual(lines(exactly22), [exactly22]);
    const twentyThree = 'Mèo luôn tiếp đất nhanh';
    assert.equal(charLength(twentyThree), 23);
    assert.equal(lines(twentyThree)?.length, 2);
  });

  test('prefers balanced lines, breaks after a comma and never splits a word', () => {
    assert.deepEqual(lines('khiến chất diệp lục màu xanh biến mất.'), ['khiến chất diệp lục', 'màu xanh biến mất.']);
    assert.deepEqual(lines('Khi mùa thu đến, ngày ngắn lại'), ['Khi mùa thu đến,', 'ngày ngắn lại']);
    const text = 'Tổ tiên của chúng đã bơi lội';
    const wrapped = lines(text) ?? [];
    assert.equal(wrapped.join(' '), text, 'lines rebuild the text: words are whole');
  });

  test('a word longer than a line stays whole on its own line; too much text does not fit', () => {
    assert.deepEqual(lines('https://example.com/a/very/long/path'), ['https://example.com/a/very/long/path']);
    assert.deepEqual(lines('Xem https://example.com/a/very/long/path'), ['Xem', 'https://example.com/a/very/long/path']);
    assert.equal(lines('Một câu rất dài không thể nào xếp vừa trong hai dòng phụ đề ngắn'), undefined);
  });
});

describe('emphasis', () => {
  test('parses the stored JSON leniently', () => {
    assert.deepEqual(parseEmphasis(null), { phrases: [], problems: [], canonical: null });
    assert.deepEqual(parseEmphasis('[]').phrases, []);
    assert.equal(parseEmphasis('not json').problems.length, 1);
    assert.equal(parseEmphasis('{"a":1}').problems.length, 1);
    const mixed = parseEmphasis('[1, "  cá   mập ", ""]');
    assert.deepEqual(mixed.phrases, ['cá mập']);
    assert.equal(mixed.problems.length, 2);
    assert.equal(parseEmphasis(JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f'])).phrases.length, 5);
  });

  test('matches whole words case-insensitively, ignoring punctuation but not diacritics', () => {
    const tokens = tokenize('Cá mập, loài cá mập cổ đại, đã xuất hiện.');
    const { ranges, missing } = matchEmphasis(tokens, ['CÁ MẬP', 'cá mập', 'ca map', 'cổ đại', 'mập cổ']);
    assert.deepEqual(ranges, [
      { from: 0, to: 2 },
      { from: 3, to: 5 },
      { from: 5, to: 7 },
    ]);
    assert.equal(missing.length, 2, '"ca map" (no diacritics) and the overlapping "mập cổ"');
  });

  test('spans keep punctuation outside the emphasis and rebuild the line', () => {
    const tokens = tokenize('"Cá mập," loài săn mồi');
    const { ranges } = matchEmphasis(tokens, ['cá mập']);
    assert.deepEqual(buildSpans(tokens, ranges), [
      { text: '"', emphasis: false },
      { text: 'Cá mập', emphasis: true },
      { text: '," loài săn mồi', emphasis: false },
    ]);
    const percent = tokenize('Vì 50 % dân số');
    assert.deepEqual(buildSpans(percent, matchEmphasis(percent, ['50 %']).ranges), [
      { text: 'Vì ', emphasis: false },
      { text: '50 %', emphasis: true },
      { text: ' dân số', emphasis: false },
    ]);
  });

  test('scene results: normal, none, not found, malformed, multiple', () => {
    const scene = { text: 'Mèo luôn hạ cánh bằng bốn chân khi ngã từ trên cao.', ms: 4000 };
    const normal = generateSubtitles(makeInput([{ ...scene, em: ['hạ cánh', 'bốn chân'] }]));
    assert.deepEqual(emphasized(normal), ['hạ cánh', 'bốn chân']);
    assert.deepEqual(normal.warnings, []);

    const none = generateSubtitles(makeInput([scene]));
    assert.deepEqual(emphasized(none), []);
    assert.deepEqual(none.warnings, []);

    const notFound = generateSubtitles(makeInput([{ ...scene, em: ['bay lượn'] }]));
    assert.deepEqual(emphasized(notFound), []);
    assert.deepEqual(notFound.warnings.map((w) => [w.code, w.sceneIndex]), [['SUBTITLE_INVALID_EMPHASIS', 0]]);

    const malformed = generateSubtitles(makeInput([{ ...scene, em: '["hạ cánh"' }]));
    assert.equal(malformed.warnings[0]?.code, 'SUBTITLE_INVALID_EMPHASIS');
    assert.equal(malformed.segments.map((s) => s.text).join(' '), scene.text, 'the job still succeeds');
  });

  test('a phrase split across lines or segments stays emphasized in every part', () => {
    const result = generateSubtitles(makeInput([CAT_LONG]));
    const words = emphasized(result).join(' ').split(' ');
    assert.deepEqual(words, ['cột', 'sống', 'siêu', 'linh', 'hoạt', 'xoay', 'nửa', 'thân']);

    const longPhrase = 'một chiến lược sinh tồn vô cùng thông minh của các loài cây';
    const crossing = generateSubtitles(makeInput([{ text: `Đây là ${longPhrase}.`, ms: 6000, em: [longPhrase] }]));
    assert.ok(crossing.segments.length >= 2, 'the phrase does not fit in one segment');
    assert.equal(emphasized(crossing).join(' '), longPhrase);
  });

  test('segmentation avoids breaking inside an emphasized phrase when it can', () => {
    const text = 'Loài vật này có khả năng tự tái tạo lại toàn bộ chiếc đuôi đã bị đứt rời.';
    const phrase = 'tái tạo lại toàn bộ';
    const result = generateSubtitles(makeInput([{ text, ms: 5000, em: [phrase] }]));
    assert.ok(result.segments.some((segment) => segment.lines.some((line) => line.text.includes(phrase))));
  });
});

describe('segmentation', () => {
  const texts = (spec: SceneSpec) => generateSubtitles(makeInput([spec])).segments.map((s) => s.text);

  test('a short sentence is one segment', () => {
    assert.deepEqual(texts({ text: 'Vì sao?', ms: 1200 }), ['Vì sao?']);
  });

  test('a long sentence without punctuation is split into readable segments', () => {
    const text = 'Loài cá này có thể sống sót dưới đáy đại dương sâu thẳm hàng nghìn mét nơi ánh sáng mặt trời không bao giờ chiếu tới được';
    const input = makeInput([{ text, ms: 11000 }]);
    const result = generateSubtitles(input);
    assertWellFormed(result, input);
    assert.ok(result.segments.length >= 4);
    for (const segment of result.segments) {
      const duration = segment.endMs - segment.startMs;
      assert.ok(duration >= MIN_SEGMENT_MS && duration <= 4000, `${duration} ms`);
    }
  });

  test('prefers commas and sentence ends as breaks', () => {
    assert.deepEqual(texts({ text: 'Vì sao? Vì trời xanh! Thật thú vị.', ms: 4500 }), ['Vì sao?', 'Vì trời xanh!', 'Thật thú vị.']);
    const commas = texts({
      text: 'Mỗi mùa thu đến, lá cây dần ngả vàng, sau đó chuyển đỏ rực, rồi khô héo dần, cuối cùng rơi xuống đất.',
      ms: 10000,
    });
    assert.deepEqual(commas, ['Mỗi mùa thu đến,', 'lá cây dần ngả vàng,', 'sau đó chuyển đỏ rực,', 'rồi khô héo dần,', 'cuối cùng rơi xuống đất.']);
  });

  test('numbers, units and percentages stay together', () => {
    const text = 'Chúng xuất hiện từ khoảng 400 triệu năm trước, nặng tới 4,5 kg, chiếm 50 % số loài và giá 1.000 đồng.';
    const result = generateSubtitles(makeInput([{ text, ms: 9000 }]));
    const lines = result.segments.flatMap((s) => s.lines.map((l) => l.text));
    for (const unit of ['400 triệu', '4,5 kg', '50 %', '1.000 đồng']) {
      assert.ok(lines.some((line) => line.includes(unit)), `"${unit}" is on one line: ${lines.join(' | ')}`);
    }
  });

  test('keeps short bracketed and quoted groups together', () => {
    const result = generateSubtitles(makeInput([{ text: 'Các nhà khoa học (theo NASA) gọi đó là "hiện tượng tán xạ" của ánh sáng.', ms: 6000 }]));
    const lines = result.segments.flatMap((s) => s.lines.map((l) => l.text));
    assert.ok(lines.some((line) => line.includes('(theo NASA)')), lines.join(' | '));
    assert.ok(lines.some((line) => line.includes('"hiện tượng tán xạ"')), lines.join(' | '));
  });

  test('URLs, mixed English and emoji are kept verbatim; long words overflow with a warning', () => {
    const cat = String.fromCodePoint(0x1f63a);
    const text = `Hemocyanin là một protein chứa đồng ${cat} xem thêm tại https://example.com/octopus/hearts/blue-blood nhé.`;
    const input = makeInput([{ text, ms: 8000 }]);
    const result = generateSubtitles(input);
    assertWellFormed(result, input);
    const lines = result.segments.flatMap((s) => s.lines.map((l) => l.text));
    assert.ok(lines.includes('https://example.com/octopus/hearts/blue-blood'), 'the URL is alone on its line');
    assert.deepEqual(result.warnings.map((w) => w.code), ['SUBTITLE_LINE_OVERFLOW']);
    assert.ok(result.segments.some((s) => s.text.includes(cat)));
  });

  test('the longest real scene (190 chars, 41 syllables, 15.72 s) gives 2-line, ~2 s segments', () => {
    const input = makeInput([CAT_LONG]);
    const result = generateSubtitles(input);
    assertWellFormed(result, input);
    assert.ok(result.segments.length >= 5 && result.segments.length <= 9, `${result.segments.length} segments`);
    for (const segment of result.segments) {
      const duration = segment.endMs - segment.startMs;
      assert.ok(duration >= 1500 && duration <= 3500, `${segment.id}: ${duration} ms`);
    }
    assert.deepEqual(result.warnings, []);
  });

  test('a scene shorter than 800 ms is one segment with a warning', () => {
    const result = generateSubtitles(makeInput([{ text: 'Đúng vậy!', ms: 600 }]));
    assert.equal(result.segments.length, 1);
    assert.deepEqual(result.warnings.map((w) => [w.code, w.sceneIndex]), [['SUBTITLE_SHORT_SCENE', 0]]);
  });

  test('segments never cross a scene boundary', () => {
    const input = makeInput([
      { text: 'Câu một rất ngắn.', ms: 1500 },
      { text: 'Câu hai cũng ngắn thôi.', ms: 1700 },
    ]);
    const result = generateSubtitles(input);
    assertWellFormed(result, input);
    assert.deepEqual(result.segments.map((s) => [s.sceneIndex, s.startMs, s.endMs]), [
      [0, 0, 1500],
      [1, 1500, 3200],
    ]);
  });

  test('segmentScene always covers the tokens in order', () => {
    const tokens = tokenize(CAT_LONG.text);
    const plan = segmentScene(tokens, CAT_LONG.ms, tokenWeights(tokens));
    assert.equal(plan.segments[0]?.from, 0);
    assert.equal(plan.segments.at(-1)?.to, tokens.length);
    plan.segments.forEach((segment, i) => assert.equal(segment.from, plan.segments[i - 1]?.to ?? 0));
  });
});

describe('timing', () => {
  test('boundaries come from cumulative weights; the last one is exact', () => {
    assert.deepEqual(
      allocateTimes(1000, 4000, [1, 1, 1, 1, 1, 1], [
        { from: 0, to: 2 },
        { from: 2, to: 3 },
        { from: 3, to: 6 },
      ]),
      [
        { startMs: 1000, endMs: 2000 },
        { startMs: 2000, endMs: 2500 },
        { startMs: 2500, endMs: 4000 },
      ],
    );
    assert.deepEqual(allocateTimes(0, 1000, [1, 1, 1], [{ from: 0, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 3 }]), [
      { startMs: 0, endMs: 333 },
      { startMs: 333, endMs: 667 },
      { startMs: 667, endMs: 1000 },
    ]);
  });

  test('pauses after punctuation count, the final one does not', () => {
    const weights = tokenWeights(tokenize('Mèo, chó; gà. Vịt'));
    assert.deepEqual(weights, [1.7, 2, 2.5, 1]);
    assert.deepEqual(tokenWeights(tokenize('Hết.')), [1]);
  });

  test('decimal seconds (5.7 s, 6.6 s…) become exact integer milliseconds', () => {
    assert.equal(toMs(5.7), 5700);
    assert.equal(toMs(5.7 + 6.6), 12300);
    assert.equal(toMs(41.7), 41700);
    const input = makeInput(LEAVES);
    const result = generateSubtitles(input);
    assertWellFormed(result, input);
    assert.equal(result.durationMs, 41700);
    assert.equal(result.segments[0]?.startMs, 0);
    assert.equal(result.segments.at(-1)?.endMs, 41700);
    assert.deepEqual(
      input.scenes.map((scene) => scene.endMs),
      [5700, 12300, 18300, 26400, 36600, 41700],
    );
  });

  test('the dev "leaves" video: real timings, readable segments, every emphasis found', () => {
    const input = makeInput(LEAVES);
    const result = generateSubtitles(input);
    assert.deepEqual(result.warnings, []);
    assert.equal(emphasized(result).length >= 12, true);
    for (const segment of result.segments) {
      assert.ok(segment.endMs - segment.startMs >= MIN_SEGMENT_MS, `${segment.id} lasts at least 800 ms`);
    }
    const scene1 = result.segments.filter((s) => s.sceneIndex === 1).map((s) => s.lines.map((l) => l.text));
    assert.deepEqual(scene1, [
      ['Khi mùa thu đến,', 'ngày ngắn lại'],
      ['và cây ngừng', 'quá trình quang hợp'],
      ['khiến chất diệp lục', 'màu xanh biến mất.'],
    ]);
  });
});

describe('Vietnamese text', () => {
  test('diacritics and punctuation are preserved byte for byte', () => {
    const text = 'Ếch, ốc, ổi, ửng hồng; đặng đẵng — ừ! Thật ư? Ẩm ướt… “ngẫm nghĩ”.';
    const input = makeInput([{ text, ms: 6000 }]);
    const result = generateSubtitles(input);
    assertWellFormed(result, input);
    assert.equal(result.segments.map((s) => s.text).join(' '), text);
    assert.equal(Buffer.from(result.segments.map((s) => s.text).join(' ')).equals(Buffer.from(text)), true);
  });
});

describe('determinism and input hash', () => {
  test('same input → byte-identical result and hash', () => {
    const first = generateSubtitles(makeInput([...LEAVES, CAT_LONG]));
    const second = generateSubtitles(makeInput([...LEAVES, CAT_LONG]));
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.match(first.inputHash, /^[0-9a-f]{64}$/);
  });

  test('the hash changes with text, timing or emphasis', () => {
    const base = generateSubtitles(makeInput(LEAVES)).inputHash;
    const changed = (patch: Partial<SceneSpec>) =>
      generateSubtitles(makeInput([{ ...(LEAVES[0] as SceneSpec), ...patch }, ...LEAVES.slice(1)])).inputHash;
    assert.notEqual(changed({ text: 'Bạn có bao giờ tự hỏi tại sao lá cây đổi màu?' }), base);
    assert.notEqual(changed({ ms: 5800 }), base);
    assert.notEqual(changed({ em: ['rụng xuống'] }), base);
    assert.equal(changed({}), base);
  });
});

describe('result contract', () => {
  test('results pass the Zod schema; the old placeholder result does not', () => {
    const input = makeInput(LEAVES);
    const result = generateSubtitles(input);
    assertWellFormed(result, input);
    assert.equal(result.version, 1);
    assert.equal(result.algorithm, 'proportional-v1');
    assert.equal(result.timing, 'segment');
    assert.deepEqual(result.layout, { maxLines: 2, maxCharsPerLine: 22 });
    assert.equal(result.segments[0]?.id, '0.0');
    assert.deepEqual(result.segments[0]?.wordRange[0], 0);
    assert.equal(SubtitleResultSchema.safeParse({ format: 'ASS', path: null }).success, false);
  });

  test('limits: at most 20 scenes and 300 segments', () => {
    const scenes = Array.from({ length: 21 }, () => ({ text: 'Mèo ngủ.', ms: 1000 }));
    assert.throws(() => generateSubtitles(makeInput(scenes)), errorCode('SUBTITLE_GENERATION_ERROR'));
    const long = { text: `${CAT_LONG.text} `.repeat(5).trim(), ms: 80000 };
    assert.throws(
      () => generateSubtitles(makeInput(Array.from({ length: 20 }, () => long))),
      errorCode('SUBTITLE_GENERATION_ERROR'),
    );
  });

  test('scene order is validated: gaps and duplicates are rejected', () => {
    assert.deepEqual(orderScenes([{ index: 1 }, { index: 0 }]).map((s) => s.index), [0, 1]);
    assert.throws(() => orderScenes([]), errorCode('SUBTITLE_INVALID_SCENE'));
    assert.throws(() => orderScenes([{ index: 0 }, { index: 2 }]), errorCode('SUBTITLE_INVALID_SCENE'));
    assert.throws(() => orderScenes([{ index: 0 }, { index: 0 }]), errorCode('SUBTITLE_INVALID_SCENE'));
  });
});
