/**
 * RENDER against a real (test) database: input validation, subtitle
 * staleness, the FFmpeg flow with a fake ffmpeg/ffprobe runner (no FFmpeg
 * needed), atomic output, cleanup, the pipeline stage and the re-run API.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { AIClient } from '../lib/ai/client.js';
import { MockAIProvider } from '../lib/ai/providers/mock.js';
import type { LocalAssetStorage } from '../lib/assets/storage.js';
import { getPrisma } from '../lib/db/prisma.js';
import { ProcessStartError, runProcess, type ProcessResult, type ProcessRunner } from '../lib/ffmpeg/process.js';
import { JobStatus, JobType } from '../lib/generated/prisma/client.js';
import { processNextJob } from '../lib/jobs/process-job.js';
import type { JobContext } from '../lib/jobs/types.js';
import { REQUIRED_ENCODERS, REQUIRED_FILTERS } from '../lib/render/command.js';
import { RenderError } from '../lib/render/errors.js';
import { promoteOutput } from '../lib/render/output.js';
import { renderVideo } from '../lib/render/service.js';
import { FONT_FILE, RenderResultSchema, type RenderServices } from '../lib/render/types.js';
import { buildVideoSubtitles } from '../lib/subtitles/service.js';
import { VoiceError } from '../lib/voice/errors.js';
import { MockVoiceProvider, type MockVoiceOptions } from '../lib/voice/providers/mock.js';
import { encodeWav } from '../lib/voice/wav.js';
import {
  createProjectWithGeneration,
  createTestAssetServices,
  createTestRenderServices,
  createTestVoiceServices,
  makeTempDir,
  migrateTestDb,
  removeTestDb,
  request,
  resetDb,
  startTestServer,
  type TestServer,
} from './helpers.js';
import { pngHeader } from './image-fixtures.js';

const quiet = (): void => {};

before(migrateTestDb);
after(removeTestDb);
beforeEach(resetDb);

function rendersWith(code: string, pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof RenderError, `expected RenderError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    if (pattern) {
      assert.match(error.message, pattern);
    }
    return true;
  };
}

/** Recursive list of files (relative, POSIX) under a directory; [] when missing. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(path.join(dir, entry.name)).map((file) => `${entry.name}/${file}`)
      : [entry.name],
  );
}

/** Everything under a directory, directories included, so an empty leftover shows up as "name/". */
function entriesUnder(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? [`${entry.name}/`, ...entriesUnder(path.join(dir, entry.name)).map((child) => `${entry.name}/${child}`)]
      : [entry.name],
  );
}

/** The strongest cleanup assertion: data/tmp itself is gone. */
function noTmp(p: Prepared, label = ''): void {
  assert.deepEqual(entriesUnder(path.join(p.storage.root, 'tmp')), [], `${label}: nothing is left under data/tmp`);
  assert.equal(existsSync(path.join(p.storage.root, 'tmp')), false, `${label}: data/tmp is removed`);
}

/** The font RENDER ships with; the checks parse it, so a placeholder string would be rejected. */
const BUNDLED_FONT = readFileSync(path.resolve('templates/documentary/fonts/BeVietnamPro-Bold.ttf'));

function fontsDir(font: 'real' | 'missing' | 'junk' = 'real'): string {
  const dir = makeTempDir('sf-fonts-');
  if (font !== 'missing') {
    writeFileSync(path.join(dir, FONT_FILE), font === 'real' ? BUNDLED_FONT : 'not a font');
  }
  return dir;
}

interface Expected {
  durationMs: number;
  frames: number;
}

interface FakeOptions {
  missing?: 'ffmpeg' | 'ffprobe';
  encoders?: readonly string[];
  exitCode?: number;
  stderr?: string;
  timeout?: boolean;
  noOutput?: boolean;
  output?: string;
  probeExitCode?: number;
  probe?: (expected: Expected) => unknown;
}

interface FakeCall {
  command: string;
  args: string[];
  cwd: string | undefined;
  /** For the render call: what the working directory contained. */
  ass?: string;
  font?: boolean;
}

const done = (stdout = ''): ProcessResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

function goodProbe(expected: Expected) {
  return {
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, pix_fmt: 'yuv420p', r_frame_rate: '30/1', avg_frame_rate: '30/1', nb_frames: String(expected.frames) },
      { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
    ],
    format: { duration: ((expected.durationMs + 21) / 1000).toFixed(6) },
  };
}

/** Simulates ffmpeg/ffprobe: preflight listings, the render (writes the temp output) and the probe. */
function fakeFfmpeg(expected: Expected, options: FakeOptions = {}): { runner: ProcessRunner; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const encoders = options.encoders ?? REQUIRED_ENCODERS;
  const runner: ProcessRunner = async (command, args, processOptions) => {
    const call: FakeCall = { command, args: [...args], cwd: processOptions.cwd };
    calls.push(call);
    const tool = path.basename(command).startsWith('ffprobe') ? 'ffprobe' : 'ffmpeg';
    if (options.missing === tool) {
      throw new ProcessStartError('ENOENT', `Could not start ${command} (ENOENT)`);
    }
    if (args.includes('-version')) {
      return done(`${tool} version 7.1-test Copyright (c) 2000-2024 the FFmpeg developers`);
    }
    if (args.includes('-encoders')) {
      return done(['Encoders:', ' V..... = Video', ' ------', ...encoders.map((name) => ` V....D ${name.padEnd(20)} test encoder`)].join('\n'));
    }
    if (args.includes('-filters')) {
      return done(['Filters:', '  T.. = Timeline support', ...REQUIRED_FILTERS.map((name) => ` ... ${name.padEnd(17)} V->V       test filter`)].join('\n'));
    }
    const cwd = processOptions.cwd ?? '.';
    if (tool === 'ffprobe') {
      if (options.probeExitCode) {
        return { exitCode: options.probeExitCode, stdout: '', stderr: 'Invalid data found when processing input', timedOut: false };
      }
      return done(JSON.stringify((options.probe ?? goodProbe)(expected)));
    }
    call.ass = readFileSync(path.join(cwd, 'subtitles.ass'), 'utf8');
    call.font = existsSync(path.join(cwd, 'fonts', FONT_FILE));
    if (options.timeout) {
      return { exitCode: null, stdout: '', stderr: '', timedOut: true };
    }
    if (options.exitCode) {
      return { exitCode: options.exitCode, stdout: '', stderr: options.stderr ?? 'Conversion failed!', timedOut: false };
    }
    if (!options.noOutput) {
      writeFileSync(path.join(cwd, 'video.tmp.mp4'), options.output ?? 'fake mp4 bytes');
    }
    return done();
  };
  return { runner, calls };
}

interface Prepared {
  projectId: string;
  videoId: string;
  jobId: string;
  storage: LocalAssetStorage;
  ctx: JobContext;
  ai: MockAIProvider;
  expected: Expected;
}

function context(voiceOptions: MockVoiceOptions = {}): { ctx: JobContext; ai: MockAIProvider } {
  const ai = new MockAIProvider();
  const assets = createTestAssetServices();
  return {
    ai,
    ctx: {
      ai: new AIClient(ai),
      assets,
      voice: createTestVoiceServices(new MockVoiceProvider(voiceOptions), assets.storage),
      render: createTestRenderServices(assets.storage),
    },
  };
}

async function runUntil(ctx: JobContext, stop?: JobType): Promise<void> {
  const prisma = getPrisma();
  for (;;) {
    const pending = await prisma.job.findFirst({ where: { status: JobStatus.PENDING } });
    if (!pending || pending.type === stop) {
      return;
    }
    await processNextJob(quiet, ctx);
  }
}

/** A real pipeline (mock AI, mock voice, placeholder images) stopped just before RENDER. */
async function prepared(): Promise<Prepared> {
  const { ctx, ai } = context();
  const gen = await createProjectWithGeneration('Tại sao con người lại mơ?', 'Tại sao con người lại mơ?');
  await runUntil(ctx, JobType.RENDER);
  const prisma = getPrisma();
  const job = await prisma.job.findFirstOrThrow({ where: { videoId: gen.videoId, type: JobType.RENDER, status: JobStatus.PENDING } });
  const video = await prisma.video.findUniqueOrThrow({ where: { id: gen.videoId } });
  const durationMs = Math.round((video.duration ?? 0) * 1000);
  return {
    projectId: gen.projectId,
    videoId: gen.videoId,
    jobId: job.id,
    storage: ctx.assets.storage,
    ctx,
    ai,
    expected: { durationMs, frames: Math.round((durationMs * 30) / 1000) },
  };
}

function ffmpegServices(p: Prepared, runner: ProcessRunner, overrides: Partial<RenderServices> = {}): RenderServices {
  return createTestRenderServices(p.storage, { provider: 'ffmpeg', runner, fontsDir: fontsDir(), ...overrides });
}

const render = (p: Prepared, services: RenderServices, jobId = p.jobId) =>
  renderVideo({ projectId: p.projectId, videoId: p.videoId, jobId }, services, quiet);

describe('RENDER with FFmpeg (fake runner)', () => {
  test('valid input → validated MP4 promoted to renders/<p>/<v>/video.mp4; Video.outputPath is left to the job engine', async () => {
    const p = await prepared();
    const fake = fakeFfmpeg(p.expected);
    const result = await render(p, ffmpegServices(p, fake.runner));

    RenderResultSchema.parse(result);
    const outputPath = `renders/${p.projectId}/${p.videoId}/video.mp4`;
    assert.equal(result.provider, 'ffmpeg');
    assert.equal(result.outputPath, outputPath);
    assert.equal(result.durationMs, p.expected.durationMs);
    assert.equal(result.frames, p.expected.frames);
    assert.equal(result.probedDurationMs, p.expected.durationMs + 21);
    assert.equal(result.fileSize, 'fake mp4 bytes'.length);
    assert.equal(result.ffmpegVersion, '7.1-test');
    assert.deepEqual([result.width, result.height, result.fps, result.videoCodec, result.pixelFormat, result.audioCodec, result.audioBitrate], [1080, 1920, 30, 'h264', 'yuv420p', 'aac', '192k']);

    assert.equal(readFileSync(p.storage.resolve(outputPath), 'utf8'), 'fake mp4 bytes');
    assert.equal(
      (await getPrisma().video.findUniqueOrThrow({ where: { id: p.videoId } })).outputPath,
      null,
      'the service never writes Video.outputPath; the job engine does, in the transaction that completes the job',
    );
    noTmp(p, 'after a successful render');
    assert.deepEqual(filesUnder(path.join(p.storage.root, 'renders')), [`${p.projectId}/${p.videoId}/video.mp4`]);

    const renderCall = fake.calls.find((call) => call.args.includes('-filter_complex'));
    assert.ok(renderCall);
    assert.equal(renderCall.cwd, p.storage.resolve(`tmp/render/${p.projectId}/${p.videoId}/${p.jobId}`));
    assert.equal(renderCall.font, true, 'the bundled font was copied next to the ASS file');
    assert.match(renderCall.ass ?? '', /\{\\rEmphasis\}/);
    assert.match(renderCall.ass ?? '', /Bạn có bao giờ tự hỏi/);
    const images = renderCall.args.filter((arg) => arg.endsWith('.png'));
    assert.ok(images.length > 0 && images.every((image) => path.isAbsolute(image) && existsSync(image)));
    assert.ok(!renderCall.args.some((arg) => arg.includes('Bạn có')), 'subtitle text never reaches the command line');
  });

  test('Ken Burns motion: zoompan chains reach ffmpeg and the presets are recorded in the result', async () => {
    const p = await prepared();
    const fake = fakeFfmpeg(p.expected);
    const result = await render(p, ffmpegServices(p, fake.runner, { motion: { mode: 'kenburns', scale: 2, preset: 'auto' } }));
    const scenes = await getPrisma().scene.count({ where: { videoId: p.videoId } });
    assert.equal(result.motion, 'kenburns');
    assert.equal(result.motionScale, 2);
    assert.equal(result.motionPresets.length, scenes);
    for (let k = 1; k < result.motionPresets.length; k++) {
      assert.notEqual(result.motionPresets[k], result.motionPresets[k - 1], 'no preset twice in a row');
    }
    const renderCall = fake.calls.find((call) => call.args.includes('-filter_complex'));
    assert.ok(renderCall);
    const graph = renderCall.args[renderCall.args.indexOf('-filter_complex') + 1] ?? '';
    assert.equal((graph.match(/zoompan=/g) ?? []).length, scenes, 'one zoompan per scene');
    assert.doesNotMatch(graph, /loop=loop=/);
    assert.match(graph, /scale=2160:3840:force_original_aspect_ratio=increase:flags=lanczos/);
    assert.match(graph, /format=yuv444p,zoompan=/);
    assert.equal(RenderResultSchema.parse(JSON.parse(JSON.stringify(result))).motionPresets.length, scenes, 'round-trips through resultJson');

    const forced = await render(p, ffmpegServices(p, fakeFfmpeg(p.expected).runner, { motion: { mode: 'kenburns', scale: 1, preset: 'pan-up' } }), 'jobForced');
    assert.ok(forced.motionPresets.every((preset) => preset === 'pan-up'), forced.motionPresets.join(','));
    assert.equal(forced.motionScale, 1);

    const still = await render(p, ffmpegServices(p, fakeFfmpeg(p.expected).runner), 'jobStill');
    assert.deepEqual([still.motion, still.motionScale, still.motionPresets], ['off', 1, []]);
    noTmp(p);
  });

  test('re-rendering replaces video.mp4 without leftovers; the toolchain is checked once', async () => {
    const p = await prepared();
    const first = fakeFfmpeg(p.expected, { output: 'first render' });
    const services = ffmpegServices(p, first.runner);
    await render(p, services, 'jobA');
    await render(p, services, 'jobB');
    assert.equal(first.calls.filter((call) => call.args.includes('-version') && !call.command.includes('ffprobe')).length, 1);
    assert.deepEqual(filesUnder(path.join(p.storage.root, 'renders')), [`${p.projectId}/${p.videoId}/video.mp4`]);
    noTmp(p);

    const second = fakeFfmpeg(p.expected, { output: 'second render' });
    const result = await render(p, ffmpegServices(p, second.runner), 'jobC');
    assert.equal(readFileSync(p.storage.resolve(result.outputPath ?? ''), 'utf8'), 'second render');
  });

  test('a failed render keeps the previous video and Video.outputPath, and cleans up', async () => {
    const p = await prepared();
    const ok = await render(p, ffmpegServices(p, fakeFfmpeg(p.expected, { output: 'v1' }).runner));
    // What the job engine writes when the first render's job completes.
    await getPrisma().video.update({ where: { id: p.videoId }, data: { outputPath: ok.outputPath } });
    const failing = fakeFfmpeg(p.expected, { exitCode: 1, stderr: `Error opening input file ${p.storage.root}${path.sep}assets${path.sep}x.png\nConversion failed!` });
    await assert.rejects(render(p, ffmpegServices(p, failing.runner), 'job2'), (error: unknown) => {
      rendersWith('RENDER_FFMPEG_FAILED', /FFmpeg failed \(exit 1\).*Conversion failed!/)(error);
      assert.ok(!(error as Error).message.includes(p.storage.root), 'no absolute paths in Job.error');
      return true;
    });
    assert.equal(readFileSync(p.storage.resolve(ok.outputPath ?? ''), 'utf8'), 'v1');
    assert.equal((await getPrisma().video.findUniqueOrThrow({ where: { id: p.videoId } })).outputPath, ok.outputPath);
    noTmp(p);
  });

  test('environment and process failures map to domain errors and never set outputPath', async () => {
    const p = await prepared();
    const cases: [string, RenderServices, RegExp?][] = [
      ['RENDER_FFMPEG_NOT_FOUND', ffmpegServices(p, fakeFfmpeg(p.expected, { missing: 'ffmpeg' }).runner), /FFMPEG_PATH/],
      ['RENDER_FFPROBE_NOT_FOUND', ffmpegServices(p, fakeFfmpeg(p.expected, { missing: 'ffprobe' }).runner), /FFPROBE_PATH/],
      ['RENDER_FFMPEG_UNSUPPORTED', ffmpegServices(p, fakeFfmpeg(p.expected, { encoders: ['aac'] }).runner), /libx264/],
      ['RENDER_FONT_MISSING', ffmpegServices(p, fakeFfmpeg(p.expected).runner, { fontsDir: fontsDir('missing') }), /BeVietnamPro-Bold\.ttf/],
      ['RENDER_FONT_MISSING', ffmpegServices(p, fakeFfmpeg(p.expected).runner, { fontsDir: fontsDir('junk') }), /TrueType\/OpenType/],
      ['RENDER_TIMEOUT', ffmpegServices(p, fakeFfmpeg(p.expected, { timeout: true }).runner)],
      ['RENDER_STORAGE_ERROR', ffmpegServices(p, fakeFfmpeg(p.expected, { exitCode: 1, stderr: 'video.tmp.mp4: No space left on device' }).runner), /disk space/],
      ['RENDER_OUTPUT_INVALID', ffmpegServices(p, fakeFfmpeg(p.expected, { noOutput: true }).runner), /no video file/],
      ['RENDER_OUTPUT_INVALID', ffmpegServices(p, fakeFfmpeg(p.expected, { probeExitCode: 1 }).runner), /ffprobe/],
      [
        'RENDER_OUTPUT_INVALID',
        ffmpegServices(p, fakeFfmpeg(p.expected, { probe: (e) => ({ ...goodProbe(e), streams: [{ ...goodProbe(e).streams[0], width: 1920, height: 1080 }, goodProbe(e).streams[1]] }) }).runner),
        /1920×1080/,
      ],
      ['RENDER_OUTPUT_INVALID', ffmpegServices(p, fakeFfmpeg(p.expected, { probe: (e) => goodProbe({ ...e, durationMs: e.durationMs + 500 }) }).runner), /expected/],
    ];
    for (const [code, services, pattern] of cases) {
      await assert.rejects(render(p, services), rendersWith(code, pattern), code);
      assert.equal((await getPrisma().video.findUniqueOrThrow({ where: { id: p.videoId } })).outputPath, null, code);
      assert.ok(!existsSync(p.storage.resolve(`renders/${p.projectId}/${p.videoId}/video.mp4`)), `${code}: nothing promoted`);
      noTmp(p, code);
    }
  });

  test('a real missing ffmpeg binary is RENDER_FFMPEG_NOT_FOUND (real spawn)', async () => {
    const p = await prepared();
    const missing = path.join(makeTempDir('sf-no-ffmpeg-'), 'ffmpeg.exe');
    const services = ffmpegServices(p, runProcess, { ffmpegPath: missing, ffprobePath: missing });
    await assert.rejects(render(p, services), rendersWith('RENDER_FFMPEG_NOT_FOUND', /ENOENT/));
  });

  test('promotion retries while the old file is locked and gives up without touching it', async () => {
    const dir = makeTempDir('sf-promote-');
    const from = path.join(dir, 'video.tmp.mp4');
    const to = path.join(dir, 'out', 'video.mp4');
    writeFileSync(from, 'new');
    let attempts = 0;
    const locked = (times: number) => async (a: string, b: string) => {
      attempts++;
      if (attempts <= times) {
        throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      }
      const { rename } = await import('node:fs/promises');
      await rename(a, b);
    };
    await promoteOutput(from, to, { rename: locked(2), delayMs: 1 });
    assert.equal(readFileSync(to, 'utf8'), 'new');

    writeFileSync(from, 'newer');
    attempts = 0;
    await assert.rejects(promoteOutput(from, to, { rename: locked(99), delayMs: 1, attempts: 3 }), rendersWith('RENDER_STORAGE_ERROR', /in use/));
    assert.equal(readFileSync(to, 'utf8'), 'new', 'the previous video is kept');
    assert.equal(attempts, 3);
  });
});

describe('RENDER cleanup and font checks', () => {
  test('a file that is not a font fails before ffmpeg is started', async () => {
    const p = await prepared();
    const fake = fakeFfmpeg(p.expected);
    await assert.rejects(
      render(p, ffmpegServices(p, fake.runner, { fontsDir: fontsDir('junk') })),
      rendersWith('RENDER_FONT_MISSING', /TrueType\/OpenType/),
    );
    assert.ok(!fake.calls.some((call) => call.args.includes('-filter_complex')), 'no render was started');
    noTmp(p, 'after a font failure');
  });

  test('a character the bundled font cannot draw only warns', async () => {
    const p = await prepared();
    const prisma = getPrisma();
    await prisma.scene.updateMany({ where: { videoId: p.videoId, index: 0 }, data: { text: 'Mèo 😺 nằm ngủ trên mái nhà ấm áp.' } });
    const fresh = await buildVideoSubtitles({ videoId: p.videoId });
    await prisma.job.updateMany({ where: { videoId: p.videoId, type: JobType.SUBTITLES }, data: { resultJson: JSON.stringify(fresh) } });

    const logs: string[] = [];
    const result = await renderVideo(
      { projectId: p.projectId, videoId: p.videoId, jobId: p.jobId },
      ffmpegServices(p, fakeFfmpeg(p.expected).runner),
      (message) => logs.push(message),
    );
    assert.equal(result.provider, 'ffmpeg');
    assert.ok(logs.some((line) => /cannot draw 1 character.*😺/.test(line)), logs.join('\n'));
  });

  test('a promotion that fails cleans up and leaves renders/ untouched', async () => {
    const p = await prepared();
    const ok = await render(p, ffmpegServices(p, fakeFfmpeg(p.expected, { output: 'v1' }).runner));
    await getPrisma().video.update({ where: { id: p.videoId }, data: { outputPath: ok.outputPath } });
    // A directory in the output's place makes the rename fail the way a locked file does.
    const target = p.storage.resolve(ok.outputPath ?? '');
    rmSync(target);
    mkdirSync(target);
    writeFileSync(path.join(target, 'keep.txt'), 'x');

    await assert.rejects(render(p, ffmpegServices(p, fakeFfmpeg(p.expected, { output: 'v2' }).runner), 'job2'), rendersWith('RENDER_STORAGE_ERROR'));
    noTmp(p, 'after a failed promotion');
    assert.equal(readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'x', 'cleanup never touches renders/');
    assert.equal((await getPrisma().video.findUniqueOrThrow({ where: { id: p.videoId } })).outputPath, ok.outputPath);
  });

  test('a working directory left behind for this video by a killed worker is removed', async () => {
    const p = await prepared();
    const crashed = p.storage.resolve(`tmp/render/${p.projectId}/${p.videoId}/crashed-job`);
    mkdirSync(crashed, { recursive: true });
    writeFileSync(path.join(crashed, 'video.tmp.mp4'), 'half written');

    await render(p, ffmpegServices(p, fakeFfmpeg(p.expected).runner));
    noTmp(p, 'after rendering over a crashed job');
  });

  test("another video's working directory is swept only once it is abandoned", async () => {
    const p = await prepared();
    const live = p.storage.resolve(`tmp/render/${p.projectId}/other-video/live-job`);
    const abandoned = p.storage.resolve(`tmp/render/${p.projectId}/other-video/dead-job`);
    for (const dir of [live, abandoned]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'video.tmp.mp4'), 'work in progress');
    }
    // Older than the render timeout plus its safety margin, so no live render can look like this.
    const longAgo = new Date(Date.now() - 80 * 60_000);
    utimesSync(path.join(abandoned, 'video.tmp.mp4'), longAgo, longAgo);
    utimesSync(abandoned, longAgo, longAgo);

    await render(p, ffmpegServices(p, fakeFfmpeg(p.expected).runner));
    assert.equal(existsSync(abandoned), false, 'the abandoned directory is swept');
    assert.equal(existsSync(path.join(live, 'video.tmp.mp4')), true, 'a render running in another worker is left alone');
    assert.equal(existsSync(p.storage.resolve(`tmp/render/${p.projectId}/${p.videoId}`)), false, 'this job leaves nothing of its own');
  });
});

describe('RENDER input validation (mock provider)', () => {
  const mock = (p: Prepared) => createTestRenderServices(p.storage);

  test('mock: validates everything, writes no video and leaves Video.outputPath empty', async () => {
    const p = await prepared();
    const result = await render(p, mock(p));
    RenderResultSchema.parse(result);
    assert.deepEqual([result.provider, result.outputPath, result.fileSize, result.probedDurationMs], ['mock', null, null, null]);
    assert.equal((await getPrisma().video.findUniqueOrThrow({ where: { id: p.videoId } })).outputPath, null);
    assert.deepEqual(filesUnder(path.join(p.storage.root, 'renders')), []);
    noTmp(p);
  });

  test('scene, visual, audio and timing problems', async () => {
    const prisma = getPrisma();
    const scene = (p: Prepared, index: number) =>
      prisma.scene.findFirstOrThrow({ where: { videoId: p.videoId, index }, include: { selectedAsset: true, voiceAsset: true } });
    const cases: [string, RegExp, (p: Prepared) => Promise<unknown>][] = [
      ['RENDER_INVALID_SCENE', /no scenes/, (p) => prisma.scene.deleteMany({ where: { videoId: p.videoId } })],
      ['RENDER_INVALID_VIDEO', /no duration/, (p) => prisma.video.update({ where: { id: p.videoId }, data: { duration: null } })],
      ['RENDER_MISSING_VISUAL_ASSET', /no visual asset/, (p) => prisma.scene.updateMany({ where: { videoId: p.videoId, index: 0 }, data: { assetId: null } })],
      ['RENDER_MISSING_VISUAL_ASSET', /missing/, async (p) => {
        const s = await scene(p, 1);
        const { rm } = await import('node:fs/promises');
        await rm(p.storage.resolve(s.selectedAsset?.localPath ?? ''));
      }],
      ['RENDER_MISSING_VISUAL_ASSET', /only images/, async (p) => {
        const s = await scene(p, 0);
        await prisma.asset.update({ where: { id: s.assetId ?? '' }, data: { type: 'video' } });
      }],
      ['RENDER_INVALID_IMAGE', /Scene 2 image is not a valid PNG, JPEG or WebP/, async (p) => {
        const s = await scene(p, 1);
        writeFileSync(p.storage.resolve(s.selectedAsset?.localPath ?? ''), 'GIF89a not one of the supported image formats');
      }],
      ['RENDER_INVALID_IMAGE', /Scene 3 image 20000×20000 px exceeds 12000 px per side/, async (p) => {
        const s = await scene(p, 2);
        writeFileSync(p.storage.resolve(s.selectedAsset?.localPath ?? ''), pngHeader(20_000, 20_000));
      }],
      ['RENDER_MISSING_AUDIO_ASSET', /VOICE must complete/, (p) => prisma.scene.updateMany({ where: { videoId: p.videoId, index: 2 }, data: { voiceAssetId: null } })],
      ['RENDER_MISSING_AUDIO_ASSET', /checksum/, async (p) => {
        const s = await scene(p, 0);
        writeFileSync(p.storage.resolve(s.voiceAsset?.localPath ?? ''), encodeWav(Buffer.alloc(4800)));
      }],
      ['RENDER_INVALID_SCENE', /audio lasts 1000 ms/, async (p) => {
        const s = await scene(p, 0);
        const wav = encodeWav(Buffer.alloc(48_000));
        writeFileSync(p.storage.resolve(s.voiceAsset?.localPath ?? ''), wav);
        const metadata = JSON.parse(s.voiceAsset?.metadataJson ?? '{}') as Record<string, unknown>;
        metadata['sha256'] = createHash('sha256').update(wav).digest('hex');
        await prisma.asset.update({ where: { id: s.voiceAssetId ?? '' }, data: { metadataJson: JSON.stringify(metadata) } });
      }],
      ['RENDER_INVALID_SCENE', /does not start where/, (p) => prisma.scene.updateMany({ where: { videoId: p.videoId, index: 1 }, data: { startTime: 0.5 } })],
      ['RENDER_INVALID_SCENE', /Video.duration/, async (p) => {
        const video = await prisma.video.findUniqueOrThrow({ where: { id: p.videoId } });
        await prisma.video.update({ where: { id: p.videoId }, data: { duration: (video.duration ?? 0) + 1 } });
      }],
    ];
    for (const [code, pattern, corrupt] of cases) {
      await resetDb();
      const p = await prepared();
      await corrupt(p);
      await assert.rejects(render(p, mock(p)), rendersWith(code, pattern), `${code} ${pattern}`);
    }
  });

  test('subtitles: missing, invalid (old placeholder) or stale', async () => {
    const prisma = getPrisma();
    const cases: [string, (p: Prepared) => Promise<unknown>][] = [
      ['RENDER_SUBTITLES_MISSING', (p) => prisma.job.deleteMany({ where: { videoId: p.videoId, type: JobType.SUBTITLES } })],
      ['RENDER_SUBTITLES_INVALID', (p) => prisma.job.updateMany({ where: { videoId: p.videoId, type: JobType.SUBTITLES }, data: { resultJson: '{"format":"ASS","path":null}' } })],
      ['RENDER_SUBTITLES_STALE', async (p) => {
        const s = await prisma.scene.findFirstOrThrow({ where: { videoId: p.videoId, index: 0 } });
        await prisma.scene.update({ where: { id: s.id }, data: { text: `${s.text} Thật thú vị.` } });
      }],
      ['RENDER_SUBTITLES_STALE', (p) => prisma.scene.updateMany({ where: { videoId: p.videoId, index: 1 }, data: { subtitleEmphasisJson: '["não"]' } })],
      ['RENDER_SUBTITLES_STALE', (p) => prisma.scene.updateMany({ where: { videoId: p.videoId, index: 0 }, data: { text: 'Ban co biet vi sao con nguoi lai mo khong va giac mo den tu dau?' } })],
    ];
    for (const [code, corrupt] of cases) {
      await resetDb();
      const p = await prepared();
      await corrupt(p);
      await assert.rejects(render(p, mock(p)), rendersWith(code), code);
    }
  });
});

describe('RENDER in the pipeline', () => {
  test('mock: VOICE → SUBTITLES → RENDER completes the project with a typed result', async () => {
    const { ctx } = context();
    const gen = await createProjectWithGeneration('Tại sao con người lại mơ?', 'Tại sao con người lại mơ?');
    await runUntil(ctx);
    const prisma = getPrisma();
    const job = await prisma.job.findFirstOrThrow({ where: { type: JobType.RENDER } });
    assert.equal(job.status, JobStatus.COMPLETED);
    const result = RenderResultSchema.parse(JSON.parse(job.resultJson ?? ''));
    assert.equal(result.provider, 'mock');
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'COMPLETED');
  });

  test('ffmpeg (fake): the RENDER job stores the result and the output path', async () => {
    const p = await prepared();
    p.ctx.render = ffmpegServices(p, fakeFfmpeg(p.expected).runner);
    await runUntil(p.ctx);
    const prisma = getPrisma();
    const job = await prisma.job.findFirstOrThrow({ where: { type: JobType.RENDER } });
    assert.equal(job.status, JobStatus.COMPLETED);
    const result = RenderResultSchema.parse(JSON.parse(job.resultJson ?? ''));
    const video = await prisma.video.findUniqueOrThrow({ where: { id: p.videoId } });
    assert.equal(video.outputPath, result.outputPath);
    assert.equal(video.status, 'COMPLETED');
    assert.doesNotMatch(job.resultJson ?? '', /[A-Za-z]:\\\\|"\/[^/]/, 'no absolute paths');
  });

  test('a RENDER failure fails the job, video and project and leaves no output', async () => {
    const p = await prepared();
    p.ctx.render = ffmpegServices(p, fakeFfmpeg(p.expected, { missing: 'ffmpeg' }).runner);
    await runUntil(p.ctx);
    const prisma = getPrisma();
    const job = await prisma.job.findFirstOrThrow({ where: { type: JobType.RENDER } });
    assert.equal(job.status, JobStatus.FAILED);
    assert.match(job.error ?? '', /ffmpeg could not be started \(ENOENT\)/);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: p.videoId } });
    assert.deepEqual([video.status, video.outputPath], ['FAILED', null]);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: p.projectId } })).status, 'FAILED');
  });
});

describe('re-run API (RENDER / SUBTITLES without AI or TTS)', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  const rerun = (videoId: string, stage: string) =>
    request<{ stage?: string; status?: string; jobId?: string; error?: { code: string } }>(server.baseUrl, 'POST', `/api/videos/${videoId}/rerun`, { stage });

  async function countJobs(videoId: string) {
    const jobs = await getPrisma().job.groupBy({ by: ['type'], where: { videoId }, _count: { _all: true } });
    return Object.fromEntries(jobs.map((row) => [row.type, row._count._all]));
  }

  test('RENDER failed → re-run RENDER only: no AI call, no other stage, project COMPLETED', async () => {
    const p = await prepared();
    p.ctx.render = ffmpegServices(p, fakeFfmpeg(p.expected, { missing: 'ffmpeg' }).runner);
    await runUntil(p.ctx);
    const aiCalls = p.ai.calls.length;

    const res = await rerun(p.videoId, 'RENDER');
    assert.equal(res.status, 202);
    assert.deepEqual([res.body.stage, res.body.status], ['RENDER', 'QUEUED']);
    const prisma = getPrisma();
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: p.projectId } })).status, 'QUEUED');

    p.ctx.render = ffmpegServices(p, fakeFfmpeg(p.expected).runner);
    await runUntil(p.ctx);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: p.projectId } })).status, 'COMPLETED');
    const video = await prisma.video.findUniqueOrThrow({ where: { id: p.videoId } });
    assert.deepEqual([video.status, video.outputPath], ['COMPLETED', `renders/${p.projectId}/${p.videoId}/video.mp4`]);
    assert.deepEqual(await countJobs(p.videoId), { RESEARCH: 1, SCRIPT: 1, SCENES: 1, ASSETS: 1, VOICE: 1, SUBTITLES: 1, RENDER: 2 });
    assert.equal(p.ai.calls.length, aiCalls, 'no AI call');
  });

  test('re-run SUBTITLES continues to RENDER', async () => {
    const p = await prepared();
    await runUntil(p.ctx);
    const res = await rerun(p.videoId, 'SUBTITLES');
    assert.equal(res.status, 202);
    await runUntil(p.ctx);
    assert.deepEqual(await countJobs(p.videoId), { RESEARCH: 1, SCRIPT: 1, SCENES: 1, ASSETS: 1, VOICE: 1, SUBTITLES: 2, RENDER: 2 });
    assert.equal((await getPrisma().project.findUniqueOrThrow({ where: { id: p.projectId } })).status, 'COMPLETED');
  });

  test('guards: unknown video, invalid stage, active project, missing prerequisite, older video', async () => {
    assert.equal((await rerun('missing-video', 'RENDER')).body.error?.code, 'VIDEO_NOT_FOUND');

    const p = await prepared();
    const invalid = await rerun(p.videoId, 'SCRIPT');
    assert.deepEqual([invalid.status, invalid.body.error?.code], [400, 'VALIDATION_ERROR'], 'AI stages cannot be re-run');
    const active = await rerun(p.videoId, 'RENDER');
    assert.deepEqual([active.status, active.body.error?.code], [409, 'GENERATION_ALREADY_ACTIVE'], 'RENDER is still pending');
    await runUntil(p.ctx);

    const prisma = getPrisma();
    await prisma.video.create({ data: { projectId: p.projectId, version: 2, status: 'DRAFT' } });
    const older = await rerun(p.videoId, 'RENDER');
    assert.deepEqual([older.status, older.body.error?.code], [409, 'NOT_LATEST_VIDEO']);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: p.projectId } })).status, 'COMPLETED', 'rolled back');

    await resetDb();
    const { ctx } = context({ fail: () => new VoiceError('VOICE_RATE_LIMIT', 'Gemini TTS rate limit or quota exceeded (HTTP 429)') });
    const gen = await createProjectWithGeneration('Tại sao con người lại mơ?', 'Tại sao con người lại mơ?');
    await runUntil(ctx);
    for (const stage of ['RENDER', 'SUBTITLES']) {
      const notReady = await rerun(gen.videoId, stage);
      assert.deepEqual([notReady.status, notReady.body.error?.code], [409, 'STAGE_NOT_READY'], stage);
    }
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'FAILED');
    // ASSETS did complete, so VOICE itself can be re-run after the rate limit.
    const voiceAgain = await rerun(gen.videoId, 'VOICE');
    assert.deepEqual([voiceAgain.status, voiceAgain.body.stage], [202, 'VOICE']);
  });

  test('VOICE failed on a rate limit → re-run VOICE re-uses the cached scenes and finishes the pipeline', async () => {
    let limited = true;
    const { ctx } = context({
      fail: (r) => (limited && r.sceneIndex === 2 ? new VoiceError('VOICE_RATE_LIMIT', 'Gemini TTS rate limit or quota exceeded (HTTP 429)') : undefined),
    });
    const gen = await createProjectWithGeneration('Tại sao con người lại mơ?', 'Tại sao con người lại mơ?');
    await runUntil(ctx);
    const prisma = getPrisma();
    assert.equal((await prisma.job.findFirstOrThrow({ where: { type: JobType.VOICE } })).status, JobStatus.FAILED);
    const calls = (ctx.voice.provider as MockVoiceProvider).calls;
    assert.equal(calls.length, 3, 'scenes 1-2 synthesized, scene 3 rate limited');

    limited = false;
    const res = await rerun(gen.videoId, 'VOICE');
    assert.deepEqual([res.status, res.body.stage], [202, 'VOICE']);
    await runUntil(ctx);
    assert.equal(calls.length, 3 + 5, 'the two cached scenes are not synthesized again');
    assert.deepEqual(await countJobs(gen.videoId), { RESEARCH: 1, SCRIPT: 1, SCENES: 1, ASSETS: 1, VOICE: 2, SUBTITLES: 1, RENDER: 1 });
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'COMPLETED');
  });

  test('re-run ASSETS rebuilds the visuals and continues through VOICE (cached), SUBTITLES and RENDER', async () => {
    const p = await prepared();
    await runUntil(p.ctx);
    const voiceCalls = (p.ctx.voice.provider as MockVoiceProvider).calls.length;
    const aiCalls = p.ai.calls.length;
    const res = await rerun(p.videoId, 'ASSETS');
    assert.equal(res.status, 202);
    await runUntil(p.ctx);
    assert.deepEqual(await countJobs(p.videoId), { RESEARCH: 1, SCRIPT: 1, SCENES: 1, ASSETS: 2, VOICE: 2, SUBTITLES: 2, RENDER: 2 });
    assert.equal((p.ctx.voice.provider as MockVoiceProvider).calls.length, voiceCalls, 'narration comes from the cache');
    assert.equal(p.ai.calls.length, aiCalls, 'no AI call');
    assert.equal((await getPrisma().project.findUniqueOrThrow({ where: { id: p.projectId } })).status, 'COMPLETED');
  });

  test('simultaneous re-run requests queue exactly one job', async () => {
    const p = await prepared();
    await runUntil(p.ctx);
    const results = await Promise.all([rerun(p.videoId, 'RENDER'), rerun(p.videoId, 'RENDER'), rerun(p.videoId, 'SUBTITLES')]);
    assert.deepEqual(
      results.map((r) => r.status).sort(),
      [202, 409, 409],
    );
    assert.equal(await getPrisma().job.count({ where: { videoId: p.videoId, status: JobStatus.PENDING } }), 1);
  });
});
