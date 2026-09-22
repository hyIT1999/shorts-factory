/**
 * RENDER Phase A pure parts (ASS, frame timeline, FFmpeg command, ffprobe
 * validation) and the real process runner (spawned with node, never FFmpeg).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { parseProbeJson, parseToolList, parseVersion, type ProbeInfo } from '../lib/ffmpeg/probe.js';
import { ProcessStartError, runProcess } from '../lib/ffmpeg/process.js';
import { LocalAssetStorage } from '../lib/assets/storage.js';
import { assColor, buildAss, escapeAssText, msToAssTimestamp } from '../lib/render/ass.js';
import { buildRenderCommand, REQUIRED_FILTERS } from '../lib/render/command.js';
import { RenderError } from '../lib/render/errors.js';
import { checkFont, parseFontFile, uncoveredCodePoints } from '../lib/render/font.js';
import { createRenderServicesFromEnv, motionConfigFromEnv } from '../lib/render/index.js';
import { motionPresets, motionSourceSize, panFits, panParameters, resolveMotionPresets, zoompanFilter } from '../lib/render/motion.js';
import { validateProbe } from '../lib/render/output.js';
import { frameAt, sceneFrameCounts } from '../lib/render/timeline.js';
import { MOTION_PRESETS, RenderResultSchema, type MotionPreset } from '../lib/render/types.js';
import { generateSubtitles } from '../lib/subtitles/service.js';
import type { SubtitleResult } from '../lib/subtitles/types.js';
import { makeTempDir, removeTestDb } from './helpers.js';
import { libassVisibleText } from './libass-model.js';

after(removeTestDb);

const WORD_JOINER = String.fromCharCode(0x2060);

function renderError(code: string) {
  return (error: unknown) => error instanceof RenderError && error.code === code;
}

/** Contiguous boundaries from scene durations in ms. */
function boundaries(durationsMs: number[]) {
  let cursor = 0;
  return durationsMs.map((ms) => {
    const scene = { startMs: cursor, endMs: cursor + ms };
    cursor += ms;
    return scene;
  });
}

/** A real SubtitleResult (the SUBTITLES generator), as RENDER receives it. */
function subtitles(scenes: { text: string; ms: number; em?: string[] }[]): SubtitleResult {
  const timed = boundaries(scenes.map((s) => s.ms));
  return generateSubtitles({
    videoId: 'video-1',
    language: 'vi',
    scenes: scenes.map((scene, index) => ({
      id: `scene-${index}`,
      index,
      text: scene.text,
      startMs: timed[index]?.startMs ?? 0,
      endMs: timed[index]?.endMs ?? 0,
      emphasisJson: scene.em ? JSON.stringify(scene.em) : null,
    })),
  });
}

/** What libass would draw for a whole ASS document, captions and lines joined by a space. */
function drawnText(ass: string): string {
  return ass
    .split('\n')
    .filter((line) => line.startsWith('Dialogue: '))
    .map((line) => libassVisibleText(line.split(',').slice(9).join(',')))
    .join(' ')
    .replace(/\n/g, ' ');
}

const LEAVES_MS = [5700, 6600, 6000, 8100, 10200, 5100];
/** The six real Gemini narration lengths of the dev video "mèo". */
const CAT_MS = [6920, 10360, 8120, 15720, 8760, 14000];

describe('ASS timestamps and colours', () => {
  test('milliseconds → H:MM:SS.cc (rounded centiseconds)', () => {
    assert.equal(msToAssTimestamp(0), '0:00:00.00');
    assert.equal(msToAssTimestamp(4), '0:00:00.00');
    assert.equal(msToAssTimestamp(5), '0:00:00.01');
    assert.equal(msToAssTimestamp(999), '0:00:01.00');
    assert.equal(msToAssTimestamp(28_752), '0:00:28.75');
    assert.equal(msToAssTimestamp(61_234), '0:01:01.23');
    assert.equal(msToAssTimestamp(3_723_456), '1:02:03.46');
    assert.throws(() => msToAssTimestamp(-1), renderError('RENDER_SUBTITLES_INVALID'));
    assert.throws(() => msToAssTimestamp(Number.NaN), renderError('RENDER_SUBTITLES_INVALID'));
  });

  test('RGB → ASS &HAABBGGRR (blue first)', () => {
    assert.equal(assColor('#FFD400'), '&H0000D4FF');
    assert.equal(assColor('#ffffff'), '&H00FFFFFF');
    assert.equal(assColor('#000000'), '&H00000000');
    assert.equal(assColor('#123456'), '&H00563412');
    assert.equal(assColor('#000000', 0x80), '&H80000000');
    assert.throws(() => assColor('yellow'), renderError('RENDER_GENERATION_ERROR'));
  });
});

describe('ASS escaping', () => {
  test('braces become libass escapes, so no override block can open', () => {
    assert.equal(escapeAssText('{\\pos(0,0)}hack'), '\\{\\pos(0,0)\\}hack');
    assert.equal(escapeAssText('}{'), '\\}\\{');
    assert.equal(escapeAssText('một { không có cặp'), 'một \\{ không có cặp');
  });

  test('a backslash that would read as \\N, \\n or \\h is separated by an invisible joiner', () => {
    assert.equal(escapeAssText('C:\\New\\hello\\ok'), `C:\\${WORD_JOINER}New\\${WORD_JOINER}hello\\ok`);
    assert.equal(escapeAssText('a\\nb'), `a\\${WORD_JOINER}nb`, 'WrapStyle 2 makes \\n a line break too');
  });

  test('a backslash before a brace needs no joiner: the escape brings its own', () => {
    assert.equal(escapeAssText('\\{'), '\\\\{');
    assert.equal(escapeAssText('\\\\}'), '\\\\\\}');
    assert.ok(!escapeAssText('\\{').includes(WORD_JOINER));
  });

  test('escaped text never ends with a bare backslash', () => {
    assert.equal(escapeAssText('ổ đĩa C:\\'), `ổ đĩa C:\\${WORD_JOINER}`);
    for (const text of ['\\', 'a\\', '\\\\', 'x\\\\', '{\\', 'đi\\']) {
      assert.ok(!escapeAssText(text).endsWith('\\'), text);
    }
  });

  test('control characters become spaces; everything else is kept byte for byte', () => {
    assert.equal(escapeAssText(`a${String.fromCharCode(10)}b${String.fromCharCode(9)}c`), 'a b c');
    assert.equal(escapeAssText('Dialogue: 0,1,2; [x] 50% "q" \'s\''), 'Dialogue: 0,1,2; [x] 50% "q" \'s\'');
    const text = 'Ếch ộp, ốc ửng hồng; đặng đẵng — ừ! Thật ư? “ngẫm nghĩ” 😺';
    assert.equal(escapeAssText(text), text);
  });

  test('libass draws exactly the characters that were written', () => {
    for (const text of [
      '{', '}', '{}', '{\\pos(0,0)}', '\\N', '\\n', '\\h', '\\', '\\\\', '\\\\N', 'a\\', '\\{', '\\}',
      'x{y', 'x}y', '100% {bold}', 'C:\\Windows\\notepad', 'Ếch {ộp}\\Nừ', '😺{\\an8}', '“q” — 50%',
    ]) {
      assert.equal(libassVisibleText(escapeAssText(text)), text, text);
    }
  });

  test('a span ending in a backslash cannot swallow the tag that follows', () => {
    const emphasis = `${escapeAssText('ổ đĩa C:\\')}{\\rEmphasis}nhấn{\\rDefault}`;
    assert.equal(libassVisibleText(emphasis), 'ổ đĩa C:\\nhấn');
    // What the same text produced before the joiner was added: the tag became visible text.
    assert.equal(libassVisibleText('ổ đĩa C:\\{\\rEmphasis}nhấn{\\rDefault}'), 'ổ đĩa C:{\\rEmphasis}nhấn');
  });
});

describe('buildAss', () => {
  const scenes = [
    { text: 'Khi mùa thu đến, ngày ngắn lại và cây ngừng quá trình quang hợp khiến chất diệp lục màu xanh biến mất.', ms: 6600, em: ['quá trình quang hợp', 'chất diệp lục'] },
    { text: 'Hãy bấm đăng ký kênh để khám phá thêm nhiều điều kỳ diệu của tự nhiên nhé!', ms: 5100, em: ['đăng ký kênh'] },
  ];

  test('header, styles and one Dialogue per segment with shared boundaries', () => {
    const result = subtitles(scenes);
    const ass = buildAss(result);
    const lines = ass.split('\n');
    assert.ok(lines.includes('PlayResX: 1080'));
    assert.ok(lines.includes('PlayResY: 1920'));
    assert.ok(lines.includes('WrapStyle: 2'), 'libass never wraps on its own');
    assert.ok(lines.includes('Style: Default,Be Vietnam Pro,66,&H00FFFFFF,&H0000D4FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,90,90,570,1'));
    assert.ok(lines.includes('Style: Emphasis,Be Vietnam Pro,66,&H0000D4FF,&H0000D4FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,90,90,570,1'));
    const dialogues = lines.filter((line) => line.startsWith('Dialogue: '));
    assert.equal(dialogues.length, result.segments.length);
    const times = dialogues.map((line) => line.split(',').slice(1, 3));
    times.forEach(([, end], i) => {
      if (i + 1 < times.length) {
        assert.equal(times[i + 1]?.[0], end, 'next caption starts exactly where this one ends');
      }
    });
    assert.equal(times[0]?.[0], '0:00:00.00');
    assert.equal(times.at(-1)?.[1], '0:00:11.70');
  });

  test('two lines use \\N; emphasis switches styles; text stays Vietnamese', () => {
    const ass = buildAss(subtitles(scenes));
    assert.ok(ass.includes('Dialogue: 0,0:00:00.00,0:00:02.24,Default,,0,0,0,,Khi mùa thu đến,\\Nngày ngắn lại'));
    assert.ok(ass.includes('và cây ngừng\\N{\\rEmphasis}quá trình quang hợp{\\rDefault}'));
    assert.ok(ass.includes('khiến {\\rEmphasis}chất diệp lục{\\rDefault}\\Nmàu xanh biến mất.'));
    assert.ok(!/\\N[^,]*\\N/.test(ass.split('\n').filter((l) => l.startsWith('Dialogue')).join('\n')), 'at most two lines');
  });

  test('user text cannot inject ASS tags', () => {
    const ass = buildAss(subtitles([{ text: 'Mở {\\pos(0,0)} và C:\\New\\hello xem sao.', ms: 3000 }]));
    const dialogue = ass.split('\n').find((line) => line.startsWith('Dialogue')) ?? '';
    const text = dialogue.split(',').slice(9).join(',');
    assert.deepEqual(text.match(/(?<!\\)\{[^}]*\}/g), null, 'not one override block survives');
    assert.ok(text.includes('\\{\\pos(0,0)\\}'), text);
    assert.ok(text.includes(`C:\\${WORD_JOINER}New\\${WORD_JOINER}hello`));
  });

  test('special characters reach the screen exactly as written', () => {
    const source = 'Mở {\\pos(0,0)} rồi gõ C:\\New\\hello và 50% “ừ” — 😺 nhé.';
    const drawn = drawnText(buildAss(subtitles([{ text: source, ms: 6000, em: ['gõ'] }])));
    assert.equal(drawn, source);
  });

  test('deterministic', () => {
    assert.equal(buildAss(subtitles(scenes)), buildAss(subtitles(scenes)));
  });

  test('rejects timelines RENDER cannot burn', () => {
    const result = subtitles(scenes);
    const gap = structuredClone(result);
    const second = gap.segments[1];
    if (second) {
      second.startMs += 10;
    }
    assert.throws(() => buildAss(gap), renderError('RENDER_SUBTITLES_INVALID'));
    assert.throws(() => buildAss({ ...result, durationMs: result.durationMs + 100 }), renderError('RENDER_SUBTITLES_INVALID'));
  });
});

describe('bundled font', () => {
  const FONT_PATH = path.resolve('templates/documentary/fonts/BeVietnamPro-Bold.ttf');
  const bytes = readFileSync(FONT_PATH);
  const font = parseFontFile(bytes, 'BeVietnamPro-Bold.ttf');

  test('is Be Vietnam Pro Bold', () => {
    assert.equal(font.family, 'Be Vietnam Pro');
    assert.equal(font.subfamily, 'Bold');
    assert.equal(font.weight, 700);
    assert.equal(font.bold, true);
  });

  test('covers Vietnamese in NFC and NFD; emoji and CJK are not covered', () => {
    const text = 'Ếch ộp, ốc ửng hồng; đặng đẵng — ừ! Thật ư? “ngẫm nghĩ” 0123456789 50% (x) \\';
    assert.deepEqual(uncoveredCodePoints(font, [text]), []);
    assert.deepEqual(uncoveredCodePoints(font, [text.normalize('NFD')]), []);
    assert.deepEqual(uncoveredCodePoints(font, ['😺 日本']), [0x65e5, 0x672c, 0x1f63a]);
  });

  test('missing glyphs and a wrong family only warn', () => {
    assert.deepEqual(checkFont(font, 'Be Vietnam Pro', ['Ếch ộp'], 'font'), []);
    const missing = checkFont(font, 'Be Vietnam Pro', ['Mèo 😺'], 'font');
    assert.equal(missing.length, 1);
    assert.match(missing[0] ?? '', /cannot draw 1 character/);
    assert.match(checkFont({ ...font, family: 'Arial' }, 'Be Vietnam Pro', ['Mèo'], 'font')[0] ?? '', /not "Be Vietnam Pro"/);
    assert.match(checkFont({ ...font, glyphFor: null }, 'Be Vietnam Pro', ['Mèo'], 'font')[0] ?? '', /coverage could not be checked/);
  });

  test('a file that is not a usable font is rejected', () => {
    for (const bad of [Buffer.from('test font bytes'), Buffer.alloc(0), Buffer.alloc(200), bytes.subarray(0, 200)]) {
      assert.throws(() => parseFontFile(bad, 'bad.ttf'), renderError('RENDER_FONT_MISSING'));
    }
  });
});

describe('frame timeline', () => {
  test('frames come from absolute boundaries: the leaves video has exactly 1251 frames', () => {
    const frames = sceneFrameCounts(boundaries(LEAVES_MS), 41_700);
    assert.deepEqual(frames, [171, 198, 180, 243, 306, 153]);
    assert.equal(frames.reduce((a, b) => a + b, 0), frameAt(41_700));
  });

  test('no cumulative drift with real Gemini durations (per-scene rounding would add 2 frames)', () => {
    const total = CAT_MS.reduce((a, b) => a + b, 0);
    const frames = sceneFrameCounts(boundaries(CAT_MS), total);
    assert.equal(frames.reduce((a, b) => a + b, 0), 1916);
    assert.equal(frameAt(total), 1916);
    const perScene = CAT_MS.reduce((sum, ms) => sum + Math.ceil((ms * 30) / 1000), 0);
    assert.equal(perScene, 1918, 'what -loop 1 -t per scene would produce');
  });

  test('the last boundary follows Video.duration; a scene shorter than a frame fails', () => {
    assert.equal(sceneFrameCounts(boundaries([1000, 1000]), 2001).reduce((a, b) => a + b, 0), frameAt(2001));
    assert.throws(() => sceneFrameCounts(boundaries([10, 1000]), 1010), renderError('RENDER_INVALID_SCENE'));
  });
});

describe('FFmpeg command', () => {
  const scenes = [
    { imagePath: 'C:\\Users\\A B\\shorts factory\\data\\assets\\p\\v\\scene-01.png', audioPath: 'C:\\Users\\A B\\shorts factory\\data\\audio\\p\\v\\scene-01.wav' },
    { imagePath: 'C:\\Users\\A B\\shorts factory\\data\\assets\\p\\v\\scene-02.png', audioPath: 'C:\\Users\\A B\\shorts factory\\data\\audio\\p\\v\\scene-02.wav' },
  ];

  test('paths with drive letters and spaces are separate, untouched arguments', () => {
    const { args } = buildRenderCommand(scenes, [171, 198]);
    const inputs = args.flatMap((arg, i) => (arg === '-i' ? [args[i + 1]] : []));
    assert.deepEqual(inputs, [scenes[0]?.imagePath, scenes[1]?.imagePath, scenes[0]?.audioPath, scenes[1]?.audioPath]);
    assert.ok(!args.includes('-loop'), 'images are repeated by the loop filter, not -loop 1 -t');
  });

  test('the filtergraph has exact frame counts and no paths or text', () => {
    const { filterComplex } = buildRenderCommand(scenes, [171, 198]);
    assert.match(filterComplex, /\[0:v\]scale=1080:1920:force_original_aspect_ratio=increase:[^;]*crop=1080:1920,setsar=1,format=yuv420p,loop=loop=170:size=1:start=0,settb=1\/30,setpts=N\[v0\]/);
    assert.match(filterComplex, /loop=loop=197:size=1:start=0/);
    assert.match(filterComplex, /\[v0\]\[v1\]concat=n=2:v=1:a=0,ass=filename=subtitles\.ass:fontsdir=fonts\[vout\]/);
    assert.match(filterComplex, /\[2:a\]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo\[a0\]/);
    assert.match(filterComplex, /\[a0\]\[a1\]concat=n=2:v=0:a=1\[aout\]/);
    assert.doesNotMatch(filterComplex, /[A-Za-z]:\\|\\|Users|shorts factory/);
  });

  test('fixed Phase A output parameters', () => {
    const { args } = buildRenderCommand(scenes, [171, 198]);
    const joined = args.join(' ');
    for (const expected of [
      '-c:v libx264',
      '-preset veryfast',
      '-crf 20',
      '-pix_fmt yuv420p',
      '-r 30',
      '-c:a aac',
      '-b:a 192k',
      '-ar 48000',
      '-ac 2',
      '-movflags +faststart',
      '-nostdin',
    ]) {
      assert.ok(joined.includes(expected), expected);
    }
    assert.equal(args.at(-1), 'video.tmp.mp4');
    assert.ok(joined.includes('-loglevel warning'), 'libass font warnings are kept');
    assert.ok(!args.includes('-threads'), 'FFmpeg picks the thread count unless RENDER_THREADS is set');
    assert.ok(buildRenderCommand(scenes, [171, 198], { threads: 2 }).args.join(' ').includes('-threads 2 video.tmp.mp4'));
    assert.throws(() => buildRenderCommand(scenes, [171]), renderError('RENDER_GENERATION_ERROR'));
    assert.throws(() => buildRenderCommand(scenes, [171, 0]), renderError('RENDER_GENERATION_ERROR'));
  });

  test('with motion: one zoompan per scene (no loop), supersampled 4:4:4 source, back to yuv420p', () => {
    const presets: MotionPreset[] = ['zoom-in', 'pan-down'];
    const { filterComplex, args } = buildRenderCommand(scenes, [171, 198], { motion: { scale: 2, presets } });
    assert.match(
      filterComplex,
      /^\[0:v\]scale=2160:3840:force_original_aspect_ratio=increase:flags=lanczos:out_color_matrix=bt709:out_range=tv,crop=2160:3840,setsar=1,format=yuv444p,zoompan=z='1\+0\.1\*on\/170':x='iw\/2-\(iw\/zoom\/2\)':y='ih\/2-\(ih\/zoom\/2\)':d=171:s=1080x1920:fps=30,format=yuv420p,settb=1\/30,setpts=N\[v0\];/,
    );
    assert.match(filterComplex, /\[1:v\][^;]*zoompan=z='1\.055':x='iw\/2-\(iw\/zoom\/2\)':y='1\*on':d=198:s=1080x1920:fps=30,format=yuv420p,settb=1\/30,setpts=N\[v1\]/);
    assert.doesNotMatch(filterComplex, /loop=/);
    assert.match(filterComplex, /\[v0\]\[v1\]concat=n=2:v=1:a=0,ass=filename=subtitles\.ass:fontsdir=fonts\[vout\]/);
    assert.match(filterComplex, /\[a0\]\[a1\]concat=n=2:v=0:a=1\[aout\]/);
    assert.doesNotMatch(filterComplex, /[A-Za-z]:\\|\\|Users|shorts factory/);
    assert.deepEqual(
      args.filter((arg) => arg.endsWith('.png')),
      [scenes[0]?.imagePath, scenes[1]?.imagePath],
    );
    // Motion off (or absent) is byte-for-byte the still chain.
    assert.equal(buildRenderCommand(scenes, [171, 198], {}).filterComplex, buildRenderCommand(scenes, [171, 198]).filterComplex);
    assert.match(buildRenderCommand(scenes, [171, 198]).filterComplex, /loop=loop=170/);
    assert.throws(() => buildRenderCommand(scenes, [171, 198], { motion: { scale: 2, presets: ['zoom-in'] } }), renderError('RENDER_GENERATION_ERROR'));
    assert.throws(() => buildRenderCommand(scenes, [171, 198], { motion: { scale: 0, presets } }), renderError('RENDER_GENERATION_ERROR'));
    assert.ok(REQUIRED_FILTERS.includes('zoompan') && REQUIRED_FILTERS.includes('loop'), 'preflight checks both chains');
  });
});

describe('Ken Burns motion', () => {
  const isZoom = (preset: MotionPreset): boolean => preset === 'zoom-in' || preset === 'zoom-out';

  test('presets are deterministic per video, alternate zoom and pan, and never repeat consecutively', () => {
    const presets = motionPresets('video-1', 12);
    assert.deepEqual(motionPresets('video-1', 12), presets);
    assert.equal(presets.length, 12);
    assert.ok(presets.every((preset) => MOTION_PRESETS.includes(preset)));
    for (let k = 1; k < presets.length; k++) {
      const current = presets[k];
      const previous = presets[k - 1];
      assert.ok(current && previous);
      assert.notEqual(current, previous);
      assert.notEqual(isZoom(current), isZoom(previous), 'zoom and pan alternate');
    }
    const sequence = presets.join(',');
    const others = ['video-2', 'video-3', 'video-4', 'video-5', 'video-6'].map((id) => motionPresets(id, 12).join(','));
    assert.ok(
      others.some((other) => other !== sequence),
      'other videos get other sequences',
    );
    assert.deepEqual(motionPresets('video-1', 3, 'pan-down'), ['pan-down', 'pan-down', 'pan-down']);
    assert.deepEqual(motionPresets('video-1', 0), []);
  });

  test('zoompan expressions: zooms centred over 1.00–1.10, pans by whole source pixels with a zoom that leaves room', () => {
    assert.equal(zoompanFilter('zoom-in', 90, 2), "zoompan=z='1+0.1*on/89':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=90:s=1080x1920:fps=30");
    assert.equal(zoompanFilter('zoom-out', 90, 2), "zoompan=z='1.1-0.1*on/89':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=90:s=1080x1920:fps=30");
    assert.match(zoompanFilter('zoom-in', 1, 1), /z='1\+0\.1\*on\/1'/, 'a one-frame scene divides by 1, not 0');
    assert.equal(zoompanFilter('pan-right', 90, 2), "zoompan=z='1.091':x='2*on':y='ih/2-(ih/zoom/2)':d=90:s=1080x1920:fps=30");
    assert.equal(zoompanFilter('pan-left', 90, 2), "zoompan=z='1.091':x='178-2*on':y='ih/2-(ih/zoom/2)':d=90:s=1080x1920:fps=30");
    assert.equal(zoompanFilter('pan-down', 150, 2), "zoompan=z='1.041':x='iw/2-(iw/zoom/2)':y='1*on':d=150:s=1080x1920:fps=30");
    assert.equal(zoompanFilter('pan-up', 150, 2), "zoompan=z='1.041':x='iw/2-(iw/zoom/2)':y='149-1*on':d=150:s=1080x1920:fps=30");
    assert.deepEqual(motionSourceSize(2), { width: 2160, height: 3840 });
    assert.throws(() => motionSourceSize(4), renderError('RENDER_GENERATION_ERROR'));
    assert.throws(() => motionSourceSize(1.5), renderError('RENDER_GENERATION_ERROR'));
    assert.throws(() => zoompanFilter('zoom-in', 0, 2), renderError('RENDER_GENERATION_ERROR'));
  });

  test('a pan never reaches the edge: axis − floor(axis / zoom) ≥ travel + 2 for every length and scale', () => {
    for (const scale of [1, 2, 3]) {
      const { width, height } = motionSourceSize(scale);
      for (const axis of [width, height]) {
        for (let frames = 1; frames <= 600; frames++) {
          const { step, travel, zoom } = panParameters(frames, scale, axis);
          assert.equal(travel, step * (frames - 1));
          assert.ok(axis - Math.floor(axis / zoom) >= travel + 2, `frames ${frames} scale ${scale} axis ${axis}: zoom ${zoom}`);
          assert.equal(zoom, Math.round(zoom * 1000) / 1000, 'three decimals');
          assert.ok(zoom >= 1 && zoom < 2.5, `zoom ${zoom}`);
        }
      }
    }
    assert.equal(panParameters(119, 2, 2160).step, 2, 'short scenes pan 2 px/frame');
    assert.equal(panParameters(120, 2, 2160).step, 1, 'longer scenes pan 1 px/frame');
    assert.equal(panParameters(60, 1, 1080).step, 1, 'at scale 1 always 1 px/frame');
  });

  test('scenes too long to pan across zoom instead, so the cycle still alternates', () => {
    const scale = 2;
    const frames = [90, 90, 90, 90, 900, 900, 90, 90];
    const raw = motionPresets('video-7', frames.length);
    const resolved = resolveMotionPresets('video-7', frames, scale);
    assert.equal(resolved.length, frames.length);
    for (const [k, preset] of resolved.entries()) {
      const rawPreset = raw[k];
      assert.ok(rawPreset);
      if (isZoom(rawPreset)) {
        assert.equal(preset, rawPreset);
        continue;
      }
      const axis = rawPreset === 'pan-left' || rawPreset === 'pan-right' ? 2160 : 3840;
      if (panFits(frames[k] ?? 1, scale, axis)) {
        assert.equal(preset, rawPreset);
      } else {
        assert.equal(preset, rawPreset === 'pan-left' || rawPreset === 'pan-up' ? 'zoom-out' : 'zoom-in');
      }
    }
    // 900 frames (30 s) at 1 px/frame: 899 px is more than a quarter of 2160 but less than a quarter of 3840.
    assert.equal(panFits(900, 2, 2160), false);
    assert.equal(panFits(900, 2, 3840), true);
    assert.equal(panFits(541, 2, 2160), true);
    assert.equal(panFits(542, 2, 2160), false);
    assert.deepEqual(resolveMotionPresets('video-7', [900, 900], scale, 'pan-right'), ['zoom-in', 'zoom-in']);
    assert.deepEqual(resolveMotionPresets('video-7', [900, 900], scale, 'pan-left'), ['zoom-out', 'zoom-out']);
    assert.deepEqual(resolveMotionPresets('video-7', [900, 900], scale, 'pan-up'), ['pan-up', 'pan-up']);
  });

  test('a RenderResult written before Phase C1 still parses, with motion off', () => {
    const legacy = {
      version: 1,
      provider: 'mock',
      videoId: 'v',
      outputPath: null,
      durationMs: 1000,
      frames: 30,
      probedDurationMs: null,
      width: 1080,
      height: 1920,
      fps: 30,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      audioCodec: 'aac',
      audioBitrate: '192k',
      fileSize: null,
      ffmpegVersion: null,
      subtitleVersion: 1,
      subtitleInputHash: 'a'.repeat(64),
      subtitleSegments: 1,
      renderedAt: '2026-09-21T00:00:00.000Z',
    };
    const parsed = RenderResultSchema.parse(legacy);
    assert.deepEqual([parsed.motion, parsed.motionScale, parsed.motionPresets, parsed.warnings], ['off', 1, [], []]);
    assert.throws(() => RenderResultSchema.parse({ ...legacy, motion: 'off', motionPresets: ['zoom-in'] }));
    assert.throws(() => RenderResultSchema.parse({ ...legacy, motion: 'kenburns', motionScale: 4 }));
    assert.equal(RenderResultSchema.parse({ ...legacy, motion: 'kenburns', motionScale: 2, motionPresets: ['pan-up'] }).motionPresets[0], 'pan-up');
  });

  test('configuration from the environment', () => {
    assert.deepEqual(motionConfigFromEnv({}), { mode: 'kenburns', scale: 2, preset: 'auto' });
    assert.deepEqual(motionConfigFromEnv({ RENDER_MOTION: ' OFF ', RENDER_MOTION_SCALE: '1', RENDER_MOTION_PRESET: 'Pan-Left' }), { mode: 'off', scale: 1, preset: 'pan-left' });
    for (const env of [{ RENDER_MOTION: 'spin' }, { RENDER_MOTION_SCALE: '4' }, { RENDER_MOTION_SCALE: '1.5' }, { RENDER_MOTION_SCALE: 'x' }, { RENDER_MOTION_PRESET: 'shake' }]) {
      assert.throws(() => motionConfigFromEnv(env), renderError('RENDER_CONFIG'), JSON.stringify(env));
    }
    const storage = new LocalAssetStorage(makeTempDir('sf-render-env-'));
    const services = createRenderServicesFromEnv(storage, { RENDER_PROVIDER: 'mock', RENDER_MOTION: 'kenburns', RENDER_MOTION_SCALE: '3' });
    assert.deepEqual(services.motion, { mode: 'kenburns', scale: 3, preset: 'auto' });
    assert.equal(createRenderServicesFromEnv(storage, { RENDER_PROVIDER: 'mock', RENDER_MOTION: 'off' }).motion?.mode, 'off');
  });
});

describe('ffprobe output', () => {
  function probe(overrides: { video?: Record<string, unknown>; audio?: Record<string, unknown> | null; duration?: string } = {}): ProbeInfo {
    const streams: Record<string, unknown>[] = [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, pix_fmt: 'yuv420p', r_frame_rate: '30/1', avg_frame_rate: '30/1', nb_frames: '1251', ...overrides.video },
    ];
    if (overrides.audio !== null) {
      streams.push({ index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, ...overrides.audio });
    }
    const parsed = parseProbeJson(JSON.stringify({ streams, format: { duration: overrides.duration ?? '41.723000' } }));
    assert.ok(parsed);
    return parsed;
  }
  const expected = { durationMs: 41_700, frames: 1251 };

  test('accepts the Phase A format within the tolerances', () => {
    assert.deepEqual(validateProbe(probe(), expected), { probedDurationMs: 41_723 });
    assert.ok(validateProbe(probe({ duration: '41.790', video: { nb_frames: '1252' } }), expected));
  });

  test('rejects anything else', () => {
    const cases: Parameters<typeof probe>[0][] = [
      { video: { codec_name: 'hevc' } },
      { video: { width: 1920, height: 1080 } },
      { video: { pix_fmt: 'yuv444p' } },
      { video: { r_frame_rate: '25/1', avg_frame_rate: '25/1' } },
      { video: { nb_frames: '1260' } },
      { audio: null },
      { audio: { codec_name: 'mp3' } },
      { audio: { channels: 1 } },
      { duration: '41.850' },
    ];
    for (const overrides of cases) {
      assert.throws(() => validateProbe(probe(overrides), expected), renderError('RENDER_OUTPUT_INVALID'), JSON.stringify(overrides));
    }
    assert.throws(() => validateProbe(null, expected), renderError('RENDER_OUTPUT_INVALID'));
    assert.equal(parseProbeJson('not json'), null);
    assert.equal(parseProbeJson('{"streams": "x"}'), null);
  });

  test('parses -encoders / -filters / -version output', () => {
    const encoders = parseToolList([
      'Encoders:',
      ' V..... = Video',
      ' A..... = Audio',
      ' ------',
      ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)',
      ' A....D aac                  AAC (Advanced Audio Coding)',
    ].join('\r\n'));
    assert.deepEqual([...encoders], ['libx264', 'aac']);
    const filters = parseToolList([
      'Filters:',
      '  T.. = Timeline support',
      '  A = Audio input/output',
      ' ... ass               V->V       Render ASS subtitles onto input video using the libass library.',
      ' T.C scale             V->V       Scale the input video size and/or convert the image format.',
    ].join('\n'));
    assert.deepEqual([...filters], ['ass', 'scale']);
    // FFmpeg 9 prints two flag characters per filter instead of three.
    const ffmpeg9Filters = parseToolList([
      'Filters:',
      '  T.. = Timeline support',
      '  .S. = Slice threading',
      '  ------',
      ' .. ass               V->V       Render ASS subtitles onto input video using the libass library.',
      ' TS scale             V->V       Scale the input video size and/or convert the image format.',
      ' .. settb             V->V       Set timebase for the video output link.',
    ].join('\r\n'));
    assert.deepEqual([...ffmpeg9Filters], ['ass', 'scale', 'settb']);
    assert.equal(parseVersion('ffmpeg version 7.1-full_build-www.gyan.dev Copyright (c) 2000-2024'), '7.1-full_build-www.gyan.dev');
  });
});

describe('process runner (real spawn, node as the child program)', () => {
  const node = process.execPath;

  test('success, exit code and output', async () => {
    const ok = await runProcess(node, ['-e', 'process.stdout.write("ok"); process.stderr.write("warn")'], { timeoutMs: 20_000 });
    assert.deepEqual(ok, { exitCode: 0, stdout: 'ok', stderr: 'warn', timedOut: false });
    const failed = await runProcess(node, ['-e', 'console.error("boom"); process.exit(3)'], { timeoutMs: 20_000 });
    assert.equal(failed.exitCode, 3);
    assert.match(failed.stderr, /boom/);
  });

  test('arguments with spaces and quotes arrive intact; cwd may contain spaces', async () => {
    const dir = makeTempDir('sf render dir ');
    const tricky = 'a b "c" d\\e ; & | %PATH%';
    const result = await runProcess(
      node,
      ['-e', 'require("fs").writeFileSync("marker.txt", "x"); process.stdout.write(process.argv[1] ?? "")', tricky],
      { cwd: dir, timeoutMs: 20_000 },
    );
    assert.equal(result.stdout, tricky);
    assert.ok(existsSync(path.join(dir, 'marker.txt')), 'ran in the requested working directory');
  });

  test('a process that runs too long is killed', async () => {
    const started = Date.now();
    const result = await runProcess(node, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 300 });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
    assert.ok(Date.now() - started < 10_000);
  });

  test('a missing program is a ProcessStartError (ENOENT), not a crash', async () => {
    const missing = path.join(makeTempDir('sf-missing-'), 'ffmpeg.exe');
    await assert.rejects(runProcess(missing, ['-version'], { timeoutMs: 5000 }), (error: unknown) => {
      assert.ok(error instanceof ProcessStartError);
      assert.equal(error.code, 'ENOENT');
      return true;
    });
  });

  test('stderr keeps only its tail', async () => {
    const result = await runProcess(
      node,
      ['-e', 'process.stderr.write("x".repeat(200000) + "END")'],
      { timeoutMs: 20_000, maxStderrBytes: 1024 },
    );
    assert.equal(result.stderr.length, 1024);
    assert.ok(result.stderr.endsWith('END'));
  });
});
