/**
 * Splits one narration WAV (all scenes read in a single TTS request) into one
 * WAV per scene. Pure: 16-bit PCM in, WAV buffers out; no IO, no ffmpeg, no
 * randomness, so the same input always yields byte-identical output.
 *
 * Scene boundaries are pauses in the speech. Candidate pauses are silent
 * runs found by short-time energy; the N−1 cuts are chosen by dynamic
 * programming so that each scene's length matches what its text predicts
 * (subtitle token weights), preferring long, clear pauses. When no pause is
 * found where one is needed, the lowest-energy spot near the predicted
 * position is used and the boundary is reported as "estimated".
 *
 * Cuts sit near the END of a pause: the pause stays at the tail of the scene
 * that ends, and the next scene starts about 80 ms before its first word.
 * Subtitles spread a scene's audio evenly over its words, so leading silence
 * would make captions appear before the speech. Pauses longer than 500 ms are
 * shortened (the middle is dropped) to keep the video tight.
 */
import { tokenize } from '../subtitles/tokenize.js';
import { tokenWeights } from '../subtitles/timing.js';
import { VoiceError } from './errors.js';
import type { BoundaryQuality } from './types.js';
import { sliceWav, wavSamples, type WavFormat } from './wav.js';

/** Bump when the algorithm or its constants change: cached per-scene cuts are then redone. */
export const SPLIT_VERSION = 1;

export interface SplitBoundary {
  /** Boundary between scene k and k+1 (index k). */
  index: number;
  quality: BoundaryQuality;
  /** Length of the pause found in the narration (0 when estimated). */
  silenceMs: number;
  /** Where the next scene starts, in seconds of the original narration. */
  cutSec: number;
}

export interface SplitResult {
  /** One complete WAV per paragraph, in order. */
  segments: Buffer[];
  boundaries: SplitBoundary[];
}

/** A silent stretch of the narration; level 0 = clear pause, 1 = quieter-threshold pause, 2 = estimated spot. */
export interface SilenceRun {
  startFrame: number;
  endFrame: number;
  level: 0 | 1 | 2;
}

const ANALYSIS_MS = 10;
const THRESHOLD_BELOW_PEAK_DB = 35;
const THRESHOLD_MIN_DB = -60;
const THRESHOLD_MAX_DB = -40;
const RELAXED_THRESHOLD_DB = 6;
const MIN_RUN_MS = 150;
const MIN_RELAXED_RUN_MS = 60;
const EDGE_MS = 300;
const ESTIMATE_WINDOW_MS = 1000;
const ESTIMATE_SPAN_MS = 50;
const ESTIMATE_DRIFT_DB_PER_FRAME = 0.1;

/** Spoken-weight units for the pause between two paragraphs. */
const PARAGRAPH_PAUSE_WEIGHT = 2.5;
const SIGMA_MIN_SEC = 0.35;
const SIGMA_RATIO = 0.15;
const MIN_SEGMENT_SEC = 0.3;
const MIN_SEGMENT_RATIO = 0.4;
const MAX_SEGMENT_RATIO = 2.5;
const REWARD_MAX = 2;
const REWARD_FULL_MS = 800;
const LEVEL_PENALTY = [0, 1, 3] as const;

const LEAD_IN_MS = 80;
const MAX_TAIL_MS = 420;

/** Rate-consistency window for segments with enough words: seconds-per-weight vs the whole narration. */
const RATE_MIN_RATIO = 0.55;
const RATE_MAX_RATIO = 1.8;
const RATE_CHECK_MIN_WEIGHT = 6;

/** Spoken weight of a paragraph (syllables + punctuation pauses, as SUBTITLES times them). */
export function paragraphWeight(text: string): number {
  const weights = tokenWeights(tokenize(text));
  return Math.max(0.5, weights.reduce((sum, w) => sum + w, 0));
}

function msToFrames(ms: number, sampleRate: number): number {
  return Math.round((ms * sampleRate) / 1000);
}

/** Per-frame RMS level in dBFS (mono mean of the channels). */
export function frameLevelsDb(samples: Int16Array, format: WavFormat, frameMs = ANALYSIS_MS): Float64Array {
  const { channels } = format;
  const frameLen = msToFrames(frameMs, format.sampleRate);
  const totalFrames = Math.floor(samples.length / channels);
  const count = Math.max(1, Math.floor(totalFrames / frameLen));
  const levels = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    let sum = 0;
    const start = f * frameLen * channels;
    const end = Math.min(samples.length, start + frameLen * channels);
    for (let i = start; i < end; i += channels) {
      let mono = 0;
      for (let c = 0; c < channels; c++) {
        mono += samples[i + c] ?? 0;
      }
      mono /= channels;
      sum += mono * mono;
    }
    const rms = Math.sqrt(sum / Math.max(1, (end - start) / channels)) / 32768;
    levels[f] = rms > 0 ? 20 * Math.log10(rms) : -120;
  }
  return levels;
}

function percentile(values: Float64Array, p: number): number {
  const sorted = Float64Array.from(values).sort();
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[index] ?? -120;
}

function runsBelow(levels: Float64Array, threshold: number, minFrames: number, edgeFrames: number, level: 0 | 1): SilenceRun[] {
  const runs: SilenceRun[] = [];
  let start = -1;
  for (let f = 0; f <= levels.length; f++) {
    const silent = f < levels.length && (levels[f] ?? 0) < threshold;
    if (silent && start < 0) {
      start = f;
    } else if (!silent && start >= 0) {
      if (f - start >= minFrames && start >= edgeFrames && f <= levels.length - edgeFrames) {
        runs.push({ startFrame: start, endFrame: f, level });
      }
      start = -1;
    }
  }
  return runs;
}

/**
 * Silent stretches (in analysis frames) at two strictness levels. A level-1
 * run that contains a level-0 run is dropped in favour of the clearer one.
 */
export function detectSilences(levels: Float64Array): SilenceRun[] {
  const threshold = Math.min(THRESHOLD_MAX_DB, Math.max(THRESHOLD_MIN_DB, percentile(levels, 0.95) - THRESHOLD_BELOW_PEAK_DB));
  const edge = Math.round(EDGE_MS / ANALYSIS_MS);
  const clear = runsBelow(levels, threshold, Math.round(MIN_RUN_MS / ANALYSIS_MS), edge, 0);
  const relaxed = runsBelow(levels, threshold + RELAXED_THRESHOLD_DB, Math.round(MIN_RELAXED_RUN_MS / ANALYSIS_MS), edge, 1).filter(
    (run) => !clear.some((c) => c.startFrame >= run.startFrame && c.endFrame <= run.endFrame),
  );
  return [...clear, ...relaxed].sort((a, b) => a.startFrame - b.startFrame || a.level - b.level);
}

interface Candidate extends SilenceRun {
  /** Where the next segment would start (analysis frames). */
  cutFrame: number;
  reward: number;
}

interface Choice {
  candidate: Candidate;
  quality: BoundaryQuality;
}

/**
 * Lowest-energy short window near an expected position, used when no pause
 * was found there. Energy is weighted by distance so that, in speech with no
 * real dip, the spot stays close to where the text predicts the boundary.
 */
function estimatedRun(levels: Float64Array, expectedFrame: number): SilenceRun {
  const span = Math.max(1, Math.round(ESTIMATE_SPAN_MS / ANALYSIS_MS));
  const window = Math.round(ESTIMATE_WINDOW_MS / ANALYSIS_MS);
  const lo = Math.max(0, expectedFrame - window);
  const hi = Math.max(lo, Math.min(levels.length - span, expectedFrame + window));
  let best = Math.min(hi, Math.max(lo, expectedFrame));
  let bestScore = Number.POSITIVE_INFINITY;
  for (let f = lo; f <= hi; f++) {
    let sum = 0;
    for (let i = 0; i < span; i++) {
      sum += levels[f + i] ?? 0;
    }
    // Mean level in dB plus 0.1 dB per 10 ms away from the expectation (1 s away costs 10 dB).
    const score = sum / span + ESTIMATE_DRIFT_DB_PER_FRAME * Math.abs(f - expectedFrame);
    if (score < bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return { startFrame: best, endFrame: best + span, level: 2 };
}

/**
 * Chooses N−1 boundaries among the silent runs by dynamic programming over
 * segment lengths: score = pause reward − ((length − expected) / σ)² − level
 * penalty. Ties go to the earliest candidate. `weights` has one spoken weight
 * per paragraph; `totalFrames` is the narration length in analysis frames.
 */
export function chooseBoundaries(runs: readonly SilenceRun[], weights: readonly number[], levels: Float64Array): Choice[] {
  const n = weights.length;
  const totalFrames = levels.length;
  if (n <= 1) {
    return [];
  }
  const framesPerSec = 1000 / ANALYSIS_MS;
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const rate = totalFrames / (totalWeight + (n - 1) * PARAGRAPH_PAUSE_WEIGHT);
  const expected = weights.map((w, k) => (k === n - 1 ? w : w + PARAGRAPH_PAUSE_WEIGHT) * rate);

  // Estimated spots near each expected absolute position complete the candidate set.
  const estimates: SilenceRun[] = [];
  let cursor = 0;
  for (let k = 0; k < n - 1; k++) {
    cursor += expected[k] ?? 0;
    estimates.push(estimatedRun(levels, Math.round(cursor)));
  }
  const candidates: Candidate[] = [...runs, ...estimates]
    .map((run) => ({
      ...run,
      cutFrame: run.level === 2 ? run.startFrame : Math.max(run.startFrame, run.endFrame - Math.round(LEAD_IN_MS / ANALYSIS_MS)),
      reward: run.level === 2 ? 0 : (REWARD_MAX * Math.min((run.endFrame - run.startFrame) * ANALYSIS_MS, REWARD_FULL_MS)) / REWARD_FULL_MS,
    }))
    .sort((a, b) => a.cutFrame - b.cutFrame || a.level - b.level);

  const segmentCost = (k: number, lengthFrames: number): number => {
    const e = expected[k] ?? 1;
    const minLen = Math.max(MIN_SEGMENT_SEC * framesPerSec, MIN_SEGMENT_RATIO * e);
    const maxLen = MAX_SEGMENT_RATIO * e;
    if (lengthFrames < minLen || lengthFrames > maxLen) {
      return Number.POSITIVE_INFINITY;
    }
    const sigma = Math.max(SIGMA_MIN_SEC * framesPerSec, SIGMA_RATIO * e);
    return ((lengthFrames - e) / sigma) ** 2;
  };

  // best[k][c]: best score with boundary k placed at candidate c; back[k][c]: previous candidate.
  const C = candidates.length;
  const best: Float64Array[] = [];
  const back: Int32Array[] = [];
  for (let k = 0; k < n - 1; k++) {
    const scores = new Float64Array(C).fill(Number.NEGATIVE_INFINITY);
    const prev = new Int32Array(C).fill(-1);
    for (let c = 0; c < C; c++) {
      const cand = candidates[c];
      if (!cand) {
        continue;
      }
      const gain = cand.reward - LEVEL_PENALTY[cand.level];
      if (k === 0) {
        const cost = segmentCost(0, cand.cutFrame);
        scores[c] = gain - cost;
        continue;
      }
      const previous = best[k - 1];
      for (let p = 0; p < c; p++) {
        const from = candidates[p];
        const base = previous?.[p];
        if (!from || base === undefined || base === Number.NEGATIVE_INFINITY || from.cutFrame >= cand.cutFrame) {
          continue;
        }
        const score = base + gain - segmentCost(k, cand.cutFrame - from.cutFrame);
        if (score > (scores[c] ?? Number.NEGATIVE_INFINITY)) {
          scores[c] = score;
          prev[c] = p;
        }
      }
    }
    best.push(scores);
    back.push(prev);
  }

  // Close with the last segment's cost, then backtrack.
  const last = best[n - 2];
  let endChoice = -1;
  let endScore = Number.NEGATIVE_INFINITY;
  for (let c = 0; c < C; c++) {
    const cand = candidates[c];
    const base = last?.[c];
    if (!cand || base === undefined || base === Number.NEGATIVE_INFINITY) {
      continue;
    }
    const score = base - segmentCost(n - 1, totalFrames - cand.cutFrame);
    if (score > endScore) {
      endScore = score;
      endChoice = c;
    }
  }
  if (endChoice < 0) {
    throw new VoiceError('INVALID_AUDIO', `Could not split the narration into ${n} scenes: no cut layout fits the text`);
  }
  const chosen: Candidate[] = [];
  for (let k = n - 2, c = endChoice; k >= 0; k--) {
    const cand = candidates[c];
    if (!cand) {
      break;
    }
    chosen.unshift(cand);
    c = back[k]?.[c] ?? -1;
  }
  const quality: BoundaryQuality[] = ['detected', 'relaxed', 'estimated'];
  return chosen.map((candidate) => ({ candidate, quality: quality[candidate.level] ?? 'estimated' }));
}

/** Whole-millisecond length in sample frames (24 samples per ms at 24 kHz). */
function floorToMs(frames: number, sampleRate: number): number {
  const ms = Math.floor((frames * 1000) / sampleRate);
  return msToFrames(ms, sampleRate);
}

function cutSegments(samples: Int16Array, format: WavFormat, ranges: readonly { start: number; end: number }[]): Buffer[] {
  const totalFrames = Math.floor(samples.length / format.channels);
  return ranges.map(({ start, end }) => {
    const length = floorToMs(Math.min(end, totalFrames) - start, format.sampleRate);
    return sliceWav(samples, format, start, start + length);
  });
}

/**
 * Splits a narration whose paragraph boundaries are unknown. Throws
 * INVALID_AUDIO when no layout fits or a segment's speaking rate is far from
 * the narration's overall rate (a cut most likely landed inside a word).
 */
export function splitNarration(wav: Uint8Array, paragraphs: readonly string[]): SplitResult {
  const { format, samples } = wavSamples(wav);
  const n = paragraphs.length;
  const totalFrames = Math.floor(samples.length / format.channels);
  if (n <= 1) {
    return { segments: cutSegments(samples, format, [{ start: 0, end: totalFrames }]), boundaries: [] };
  }
  const levels = frameLevelsDb(samples, format);
  const weights = paragraphs.map(paragraphWeight);
  const choices = chooseBoundaries(detectSilences(levels), weights, levels);

  const analysisFrames = msToFrames(ANALYSIS_MS, format.sampleRate);
  const ranges: { start: number; end: number }[] = [];
  const boundaries: SplitBoundary[] = [];
  let start = 0;
  choices.forEach((choice, k) => {
    const { candidate } = choice;
    const nextStart = candidate.cutFrame * analysisFrames;
    const pauseStart = candidate.startFrame * analysisFrames;
    // The ending scene keeps at most MAX_TAIL_MS of the pause; the rest (up to the lead-in) is dropped.
    const end = candidate.level === 2 ? nextStart : Math.min(nextStart, pauseStart + msToFrames(MAX_TAIL_MS, format.sampleRate));
    ranges.push({ start, end: Math.max(end, start + 1) });
    boundaries.push({
      index: k,
      quality: choice.quality,
      silenceMs: candidate.level === 2 ? 0 : (candidate.endFrame - candidate.startFrame) * ANALYSIS_MS,
      cutSec: nextStart / format.sampleRate,
    });
    start = nextStart;
  });
  ranges.push({ start, end: totalFrames });

  const segments = cutSegments(samples, format, ranges);
  assertConsistentRate(segments, format, weights, totalFrames);
  return { segments, boundaries };
}

/** Splits at boundaries the provider knows exactly (seconds); nothing is trimmed. */
export function splitAt(wav: Uint8Array, boundariesSec: readonly number[]): Buffer[] {
  const { format, samples } = wavSamples(wav);
  const totalFrames = Math.floor(samples.length / format.channels);
  const cuts = boundariesSec.map((sec) => Math.min(totalFrames, Math.max(0, Math.round(sec * format.sampleRate))));
  const ranges: { start: number; end: number }[] = [];
  let start = 0;
  for (const cut of cuts) {
    if (cut < start) {
      throw new VoiceError('INVALID_AUDIO', 'Narration boundaries must be increasing');
    }
    ranges.push({ start, end: cut });
    start = cut;
  }
  ranges.push({ start, end: totalFrames });
  return cutSegments(samples, format, ranges);
}

/** Every segment with enough words must be spoken at roughly the narration's overall rate. */
export function assertConsistentRate(segments: readonly Buffer[], format: WavFormat, weights: readonly number[], totalFrames: number): void {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const overall = totalFrames / format.sampleRate / totalWeight;
  segments.forEach((segment, k) => {
    const weight = weights[k] ?? 0;
    if (weight < RATE_CHECK_MIN_WEIGHT) {
      return;
    }
    const seconds = (segment.length - 44) / (format.channels * 2) / format.sampleRate;
    const ratio = seconds / weight / overall;
    if (ratio < RATE_MIN_RATIO || ratio > RATE_MAX_RATIO) {
      throw new VoiceError(
        'INVALID_AUDIO',
        `Could not split the narration reliably: scene ${k + 1} would last ${seconds.toFixed(2)}s for its text ` +
          `(${(ratio * 100).toFixed(0)}% of the narration's speaking rate)`,
      );
    }
  });
}

/** Speech coverage limits: a narration whose audio is mostly silence was truncated by the provider. */
const MIN_SPEECH_RATIO = 0.4;
const MAX_TRAILING_SILENCE_SEC = 4;
const SPEECH_THRESHOLD_DB = -50;

export interface SpeechCoverage {
  /** Seconds of frames above the speech threshold. */
  speechSec: number;
  /** Silence at the very end of the narration. */
  trailingSilenceSec: number;
  totalSec: number;
}

/** How much of the narration actually contains speech (energy above a fixed floor). */
export function speechCoverage(wav: Uint8Array): SpeechCoverage {
  const { format, samples } = wavSamples(wav);
  const levels = frameLevelsDb(samples, format);
  let speech = 0;
  let lastSpeech = -1;
  for (let f = 0; f < levels.length; f++) {
    if ((levels[f] ?? -120) > SPEECH_THRESHOLD_DB) {
      speech++;
      lastSpeech = f;
    }
  }
  return {
    speechSec: (speech * ANALYSIS_MS) / 1000,
    trailingSilenceSec: ((levels.length - 1 - lastSpeech) * ANALYSIS_MS) / 1000,
    totalSec: (levels.length * ANALYSIS_MS) / 1000,
  };
}

/**
 * Rejects a narration that the provider cut short: far less speech than the
 * text needs, or a long silent tail (observed with Gemini TTS: about one
 * sentence read, then a minute of silence). Cutting such audio into scenes
 * would produce mute scenes that pass every later check.
 */
export function assertSpeechCoverage(wav: Uint8Array, expectedSpeechSec: number): SpeechCoverage {
  const coverage = speechCoverage(wav);
  const ratio = coverage.speechSec / Math.max(0.1, expectedSpeechSec);
  if (ratio < MIN_SPEECH_RATIO) {
    throw new VoiceError(
      'INVALID_AUDIO',
      `Narration audio is mostly silent: ${coverage.speechSec.toFixed(1)}s of speech in ${coverage.totalSec.toFixed(1)}s, ` +
        `expected about ${expectedSpeechSec.toFixed(0)}s for the text (the provider cut the narration short)`,
    );
  }
  if (coverage.trailingSilenceSec > MAX_TRAILING_SILENCE_SEC) {
    throw new VoiceError(
      'INVALID_AUDIO',
      `Narration audio ends with ${coverage.trailingSilenceSec.toFixed(1)}s of silence (the provider cut the narration short)`,
    );
  }
  return coverage;
}
