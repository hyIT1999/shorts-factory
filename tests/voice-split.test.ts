/**
 * Narration splitter on synthetic PCM: tone bursts stand for speech, quiet
 * stretches for pauses. Everything is deterministic (seeded noise), so the
 * expected cut positions can be asserted to the millisecond.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { VoiceError } from '../lib/voice/errors.js';
import { assertConsistentRate, assertSpeechCoverage, detectSilences, frameLevelsDb, paragraphWeight, speechCoverage, splitAt, splitNarration } from '../lib/voice/split.js';
import { encodeWav, parseWav, wavSamples } from '../lib/voice/wav.js';

const RATE = 24_000;

/** Deterministic noise floor at about −70 dBFS. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000 - 0.5;
  };
}

interface Piece {
  ms: number;
  /** true = tone (speech), false = near-silence (pause). */
  speech: boolean;
}

/** Builds a mono WAV from alternating pieces; speech is a 220 Hz sine at amplitude 8000 with a noise floor. */
function synth(pieces: readonly Piece[], sampleRate = RATE, channels = 1): Buffer {
  const random = lcg(42);
  const totalFrames = pieces.reduce((sum, p) => sum + Math.round((p.ms * sampleRate) / 1000), 0);
  const samples = new Int16Array(totalFrames * channels);
  let frame = 0;
  for (const piece of pieces) {
    const frames = Math.round((piece.ms * sampleRate) / 1000);
    for (let i = 0; i < frames; i++, frame++) {
      const t = frame / sampleRate;
      const noise = random() * 20;
      const value = piece.speech ? 8000 * Math.sin(2 * Math.PI * 220 * t) + noise : noise;
      for (let c = 0; c < channels; c++) {
        samples[frame * channels + c] = Math.round(value);
      }
    }
  }
  return encodeWav(new Uint8Array(samples.buffer), { sampleRate, channels, bitsPerSample: 16 });
}

/** Speech of `ms` per paragraph, separated by pauses of `pauseMs`. */
function narration(speechMs: readonly number[], pauseMs: readonly number[], sampleRate = RATE, channels = 1): Buffer {
  const pieces: Piece[] = [];
  speechMs.forEach((ms, i) => {
    pieces.push({ ms, speech: true });
    const pause = pauseMs[i];
    if (pause !== undefined) {
      pieces.push({ ms: pause, speech: false });
    }
  });
  return synth(pieces, sampleRate, channels);
}

/** A paragraph of `words` monosyllables ending with a full stop. */
const para = (words: number): string => `${Array.from({ length: words }, (_, i) => `từ${i}`).join(' ')}.`;

const durationsMs = (segments: readonly Buffer[]): number[] => segments.map((s) => Math.round(parseWav(s).durationSec * 1000));

describe('paragraphWeight', () => {
  test('grows with the number of syllables and punctuation pauses', () => {
    assert.ok(paragraphWeight(para(10)) > paragraphWeight(para(5)));
    assert.ok(paragraphWeight('Một, hai. Ba') > paragraphWeight('Một hai ba'));
    assert.ok(paragraphWeight('') >= 0.5);
  });
});

describe('detectSilences', () => {
  test('finds the pauses between tone bursts, not the edges', () => {
    const wav = narration([2000, 2000, 2000], [400, 300]);
    const { format, samples } = wavSamples(wav);
    const runs = detectSilences(frameLevelsDb(samples, format));
    const clear = runs.filter((r) => r.level === 0);
    assert.equal(clear.length, 2);
    assert.deepEqual(
      clear.map((r) => [r.startFrame * 10, r.endFrame * 10]),
      [
        [2000, 2400],
        [4400, 4700],
      ],
    );
  });

  test('a pause shorter than 150 ms is only a relaxed candidate; under 60 ms none', () => {
    const wav = narration([2000, 2000, 2000], [100, 40]);
    const { format, samples } = wavSamples(wav);
    const runs = detectSilences(frameLevelsDb(samples, format));
    assert.deepEqual(
      runs.map((r) => r.level),
      [1],
    );
  });
});

describe('splitNarration', () => {
  test('cuts three paragraphs at their pauses; lengths are whole milliseconds', () => {
    // Speech proportional to the text (10, 15, 8 words ≈ 3.0, 4.5, 2.4 s).
    const wav = narration([3000, 4500, 2400], [400, 350]);
    const { segments, boundaries } = splitNarration(wav, [para(10), para(15), para(8)]);
    assert.equal(segments.length, 3);
    assert.deepEqual(
      boundaries.map((b) => b.quality),
      ['detected', 'detected'],
    );
    assert.deepEqual(
      boundaries.map((b) => b.silenceMs),
      [400, 350],
    );
    // Next scene starts 80 ms before its speech: 3400 − 80 = 3320 ms and 3400 + 4500 + 350 − 80 = 8170 ms.
    assert.deepEqual(
      boundaries.map((b) => Math.round(b.cutSec * 1000)),
      [3320, 8170],
    );
    // Scene 1 keeps the whole 400 ms pause minus the 80 ms lead-in (3320 ms); scene 2: 8170 − 3320 = 4850; scene 3: rest.
    assert.deepEqual(durationsMs(segments), [3320, 4850, 2480]);
    for (const segment of segments) {
      const info = parseWav(segment);
      assert.equal((info.dataBytes / 2) % 24, 0, 'whole-millisecond length');
    }
  });

  test('a long pause is shortened to at most 500 ms and the total shrinks accordingly', () => {
    const wav = narration([3000, 3000], [2000]);
    const { segments, boundaries } = splitNarration(wav, [para(10), para(10)]);
    assert.equal(boundaries[0]?.silenceMs, 2000);
    // Scene 1: 3000 speech + 420 tail; scene 2: 80 lead-in + 3000 speech.
    assert.deepEqual(durationsMs(segments), [3420, 3080]);
  });

  test('a long pause inside a paragraph is not chosen when the text says the cut is elsewhere', () => {
    // Paragraph 1 has a 600 ms mid-sentence breath after 1 s; the real boundary is after 4 s.
    const wav = synth([
      { ms: 1000, speech: true },
      { ms: 600, speech: false },
      { ms: 3000, speech: true },
      { ms: 400, speech: false },
      { ms: 4000, speech: true },
    ]);
    const { boundaries } = splitNarration(wav, [para(13), para(13)]);
    assert.equal(Math.round((boundaries[0]?.cutSec ?? 0) * 1000), 1000 + 600 + 3000 + 400 - 80);
    assert.equal(boundaries[0]?.quality, 'detected');
  });

  test('falls back to an estimated boundary when there is no pause, and reports it', () => {
    const wav = synth([{ ms: 6000, speech: true }]);
    const { segments, boundaries } = splitNarration(wav, [para(10), para(10)]);
    assert.equal(boundaries[0]?.quality, 'estimated');
    assert.equal(boundaries[0]?.silenceMs, 0);
    const [a, b] = durationsMs(segments);
    assert.ok(a !== undefined && b !== undefined && a + b <= 6000 && a > 2000 && b > 2000, `${a} + ${b}`);
  });

  test('uses a short pause as a relaxed boundary when no clear pause exists', () => {
    const wav = narration([3000, 3000], [100]);
    const { boundaries } = splitNarration(wav, [para(10), para(10)]);
    assert.equal(boundaries[0]?.quality, 'relaxed');
    assert.equal(boundaries[0]?.silenceMs, 100);
  });

  test('a single paragraph is returned whole (floored to a millisecond)', () => {
    const wav = narration([1234.5], []);
    const { segments, boundaries } = splitNarration(wav, [para(4)]);
    assert.deepEqual(boundaries, []);
    assert.deepEqual(durationsMs(segments), [1234]);
  });

  test('prefers an estimated cut near the text prediction over a pause that contradicts the text', () => {
    // The only pause splits the audio in half, but the text says 8 words vs 40.
    const wav = narration([4000, 4000], [400]);
    const { boundaries, segments } = splitNarration(wav, [para(8), para(40)]);
    assert.equal(boundaries[0]?.quality, 'estimated');
    const [a] = durationsMs(segments);
    assert.ok(a !== undefined && a > 1000 && a < 2500, `${a}`);
  });

  test('assertConsistentRate rejects a scene spoken far faster or slower than the narration', () => {
    const format = { sampleRate: RATE, channels: 1, bitsPerSample: 16 };
    const segments = splitAt(narration([4000, 4000], [0]), [4]);
    const weights = [paragraphWeight(para(8)), paragraphWeight(para(40))];
    assert.throws(
      () => assertConsistentRate(segments, format, weights, 8000 * 24),
      (error: unknown) => error instanceof VoiceError && error.code === 'INVALID_AUDIO' && /reliably/.test(error.message),
    );
    assert.doesNotThrow(() => assertConsistentRate(segments, format, [10, 10], 8000 * 24));
  });

  test('handles stereo and non-24 kHz sources', () => {
    const stereo = narration([3000, 3000], [400], RATE, 2);
    const s = splitNarration(stereo, [para(10), para(10)]);
    assert.deepEqual(durationsMs(s.segments), [3320, 3080]);
    assert.equal(parseWav(s.segments[0] ?? new Uint8Array()).channels, 2);

    // 22.05 kHz: a 10 ms analysis frame is 220.5 samples, so cuts land within a few ms of the
    // 24 kHz positions; each file is still a whole number of milliseconds to within half a sample.
    const wav22 = narration([3000, 3000], [400], 22_050);
    const r = splitNarration(wav22, [para(10), para(10)]);
    const info = parseWav(r.segments[0] ?? new Uint8Array());
    assert.equal(info.sampleRate, 22_050);
    assert.ok(Math.abs(info.durationSec * 1000 - 3320) < 10, `${info.durationSec}`);
    const ms = info.durationSec * 1000;
    assert.ok(Math.abs(ms - Math.round(ms)) < 0.03, `${ms} is not a whole millisecond`);
  });

  test('is deterministic', () => {
    const wav = narration([3000, 4500, 2400], [400, 350]);
    const a = splitNarration(wav, [para(10), para(15), para(8)]);
    const b = splitNarration(wav, [para(10), para(15), para(8)]);
    a.segments.forEach((segment, i) => assert.ok(segment.equals(b.segments[i] ?? Buffer.alloc(0))));
    assert.deepEqual(a.boundaries, b.boundaries);
  });
});

describe('splitAt', () => {
  test('cuts exactly at the given seconds and keeps every sample', () => {
    const wav = narration([1000, 2000, 500], [0, 0]);
    const segments = splitAt(wav, [1, 3]);
    assert.deepEqual(durationsMs(segments), [1000, 2000, 500]);
    const total = segments.reduce((sum, s) => sum + parseWav(s).dataBytes, 0);
    assert.equal(total, parseWav(wav).dataBytes);
  });

  test('rejects decreasing boundaries', () => {
    const wav = narration([3000], []);
    assert.throws(() => splitAt(wav, [2, 1]), (error: unknown) => error instanceof VoiceError && error.code === 'INVALID_AUDIO');
  });
});

describe('speech coverage', () => {
  test('measures speech and trailing silence', () => {
    const c = speechCoverage(synth([{ ms: 3000, speech: true }, { ms: 500, speech: false }, { ms: 2000, speech: true }, { ms: 1500, speech: false }]));
    assert.equal(c.totalSec, 7);
    assert.ok(Math.abs(c.speechSec - 5) < 0.1, `${c.speechSec}`);
    assert.ok(Math.abs(c.trailingSilenceSec - 1.5) < 0.05, `${c.trailingSilenceSec}`);
  });

  test('accepts a normal narration and rejects one the provider cut short', () => {
    const good = narration([3000, 4500, 2400], [400, 350]);
    assert.doesNotThrow(() => assertSpeechCoverage(good, 10));
    // One sentence read, then a minute of silence (observed with Gemini TTS).
    const truncated = synth([{ ms: 6000, speech: true }, { ms: 60_000, speech: false }]);
    assert.throws(
      () => assertSpeechCoverage(truncated, 40),
      (error: unknown) => error instanceof VoiceError && error.code === 'INVALID_AUDIO' && /mostly silent/.test(error.message),
    );
    // Enough speech overall but a long silent tail.
    const tail = synth([{ ms: 8000, speech: true }, { ms: 6000, speech: false }]);
    assert.throws(
      () => assertSpeechCoverage(tail, 8),
      (error: unknown) => error instanceof VoiceError && error.code === 'INVALID_AUDIO' && /ends with/.test(error.message),
    );
  });
});
