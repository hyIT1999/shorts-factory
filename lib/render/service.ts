/**
 * RENDER stage orchestration (Phase A): scene images + scene WAVs +
 * SubtitleResult → one 1080×1920 H.264/AAC MP4 with burned-in subtitles.
 *
 * Everything is read again from the database on every run (no AI, no TTS), so
 * RENDER can be retried on its own. Work happens in a per-job directory
 * (data/tmp/render/<p>/<v>/<jobId>) that is always removed; the output is
 * checked with ffprobe and only then renamed over renders/<p>/<v>/video.mp4.
 * The job engine stores that path in Video.outputPath in the same transaction
 * that marks the job COMPLETED. A failure never touches the previous output.
 */
import { copyFile, mkdir, readdir, readFile, rm, rmdir, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RENDER_TMP_ROOT, renderDir, renderWorkDir, renderWorkRoot } from '../assets/storage.js';
import { parseProbeJson, parseToolList, parseVersion } from '../ffmpeg/probe.js';
import { ProcessStartError, type ProcessOptions, type ProcessResult } from '../ffmpeg/process.js';
import type { SubtitleResult } from '../subtitles/types.js';
import { buildAss } from './ass.js';
import {
  ASS_FILE,
  buildRenderCommand,
  FONTS_SUBDIR,
  OUTPUT_FILE,
  PROBE_ARGS,
  REQUIRED_ENCODERS,
  REQUIRED_FILTERS,
  TEMP_OUTPUT_FILE,
} from './command.js';
import { RenderError } from './errors.js';
import { checkFont, parseFontFile, type FontFile } from './font.js';
import { loadRenderInput } from './input.js';
import { resolveMotionPresets } from './motion.js';
import { promoteOutput, validateProbe } from './output.js';
import { loadSubtitles } from './subtitles.js';
import { sceneFrameCounts } from './timeline.js';
import {
  FONT_FAMILY,
  FONT_FILE,
  MAX_OUTPUT_BYTES,
  MIN_FREE_DISK_BYTES,
  MOTION_OFF,
  RENDER_SPEC,
  RenderResultSchema,
  TOOL_TIMEOUT_MS,
  type RenderResult,
  type RenderServices,
} from './types.js';

export interface RenderJobInput {
  projectId: string;
  videoId: string;
  jobId: string;
}

export type RenderLog = (message: string) => void;

type Tool = 'ffmpeg' | 'ffprobe';

const MAX_STDERR_IN_MESSAGE = 500;

/** Runs ffmpeg/ffprobe; a missing or unstartable binary becomes a domain error. */
async function runTool(services: RenderServices, tool: Tool, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  const command = tool === 'ffmpeg' ? services.ffmpegPath : services.ffprobePath;
  try {
    return await services.runner(command, args, options);
  } catch (error) {
    if (error instanceof ProcessStartError) {
      throw new RenderError(
        tool === 'ffmpeg' ? 'RENDER_FFMPEG_NOT_FOUND' : 'RENDER_FFPROBE_NOT_FOUND',
        `${tool} could not be started (${error.code}); install FFmpeg or set ${tool === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'}`,
      );
    }
    throw error;
  }
}

/** Absolute paths never leave the worker: the working directory and the storage root become "…". */
function hidePathsIn(text: string, hidePaths: readonly string[]): string {
  let safe = text;
  for (const hidden of hidePaths) {
    safe = safe.split(hidden).join('…');
  }
  return safe;
}

/** The last lines of stderr, without absolute paths, short enough for Job.error. */
function stderrTail(stderr: string, hidePaths: readonly string[]): string {
  const lines = hidePathsIn(stderr, hidePaths)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-10)
    .join(' | ');
  return lines.length > MAX_STDERR_IN_MESSAGE ? lines.slice(-MAX_STDERR_IN_MESSAGE) : lines;
}

const MAX_WARNINGS = 20;
const MAX_WARNING_LENGTH = 300;
/** libass reports missing glyphs and font fallbacks with these words: the caption was drawn with another font. */
const FONT_FALLBACK = /fontselect|glyph|fallback/i;
/** Expected chatter, not a problem: a plain WAV header carries no channel mask, so FFmpeg "guesses" mono/stereo. */
const BENIGN_WARNINGS = [/Guessed Channel Layout/i];

/** Distinct lines FFmpeg printed (at -loglevel warning) during a render that succeeded, without absolute paths. */
function stderrWarnings(stderr: string, hidePaths: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of hidePathsIn(stderr, hidePaths).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || seen.has(line) || BENIGN_WARNINGS.some((pattern) => pattern.test(line))) {
      continue;
    }
    seen.add(line.length > MAX_WARNING_LENGTH ? `${line.slice(0, MAX_WARNING_LENGTH)}…` : line);
    if (seen.size >= MAX_WARNINGS) {
      break;
    }
  }
  return [...seen];
}

/** Checks (once per services object) that ffmpeg and ffprobe run and support what RENDER needs. */
async function verifyToolchain(services: RenderServices): Promise<{ ffmpegVersion: string | null }> {
  const options = { timeoutMs: Math.min(services.timeoutMs, TOOL_TIMEOUT_MS) };
  const version = await runTool(services, 'ffmpeg', ['-version'], options);
  if (version.exitCode !== 0) {
    throw new RenderError('RENDER_FFMPEG_NOT_FOUND', `"${services.ffmpegPath} -version" failed; FFMPEG_PATH is not a working ffmpeg`);
  }
  const probeVersion = await runTool(services, 'ffprobe', ['-version'], options);
  if (probeVersion.exitCode !== 0) {
    throw new RenderError('RENDER_FFPROBE_NOT_FOUND', `"${services.ffprobePath} -version" failed; FFPROBE_PATH is not a working ffprobe`);
  }
  const encoders = parseToolList((await runTool(services, 'ffmpeg', ['-hide_banner', '-encoders'], options)).stdout);
  const filters = parseToolList((await runTool(services, 'ffmpeg', ['-hide_banner', '-filters'], options)).stdout);
  const missing = [...REQUIRED_ENCODERS.filter((name) => !encoders.has(name)), ...REQUIRED_FILTERS.filter((name) => !filters.has(name))];
  if (missing.length > 0) {
    throw new RenderError(
      'RENDER_FFMPEG_UNSUPPORTED',
      `This FFmpeg build lacks: ${missing.join(', ')} (use a "full"/"gpl" build with libx264 and libass)`,
    );
  }
  return { ffmpegVersion: parseVersion(version.stdout) };
}

const toolchains = new WeakMap<RenderServices, Promise<{ ffmpegVersion: string | null }>>();

function toolchainFor(services: RenderServices): Promise<{ ffmpegVersion: string | null }> {
  let pending = toolchains.get(services);
  if (!pending) {
    pending = verifyToolchain(services);
    toolchains.set(services, pending);
    // A failed check is retried by the next job (e.g. after installing FFmpeg).
    pending.catch(() => toolchains.delete(services));
  }
  return pending;
}

const fonts = new WeakMap<RenderServices, Promise<FontFile>>();

async function loadFont(services: RenderServices): Promise<FontFile> {
  const where = path.relative(process.cwd(), services.fontsDir) || '.';
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(services.fontsDir, FONT_FILE));
  } catch {
    throw new RenderError(
      'RENDER_FONT_MISSING',
      `Bundled font ${FONT_FILE} not found in ${where}; add Be Vietnam Pro Bold (SIL OFL) there`,
    );
  }
  return parseFontFile(bytes, FONT_FILE);
}

/** Reads and parses the bundled font once per services object (like the toolchain check). */
function fontFor(services: RenderServices): Promise<FontFile> {
  let pending = fonts.get(services);
  if (!pending) {
    pending = loadFont(services);
    fonts.set(services, pending);
    // A failed read is retried by the next job (e.g. once the font is put there).
    pending.catch(() => fonts.delete(services));
  }
  return pending;
}

/** The text of every subtitle line, for the glyph coverage check. */
function* subtitleTexts(subtitles: SubtitleResult): Iterable<string> {
  for (const segment of subtitles.segments) {
    for (const line of segment.lines) {
      yield line.text;
    }
  }
}

/** A render is killed at its own timeout, so a working directory older than this was abandoned. */
const ABANDONED_WORK_DIR_MARGIN_MS = 600_000;

/** Removes a stored directory tree, retrying while Windows still holds a handle. */
async function removeTree(services: RenderServices, relativeDir: string): Promise<boolean> {
  try {
    await rm(services.storage.resolve(relativeDir), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

/** Names of the directories directly inside a stored directory ([] when it does not exist). */
async function listSubdirectories(services: RenderServices, relativeDir: string): Promise<string[]> {
  try {
    const entries = await readdir(services.storage.resolve(relativeDir), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Newest modification time in a working directory: a running render keeps writing video.tmp.mp4. */
async function lastTouched(services: RenderServices, relativeDir: string): Promise<number> {
  const absolute = services.storage.resolve(relativeDir);
  try {
    let newest = (await stat(absolute)).mtimeMs;
    for (const entry of await readdir(absolute)) {
      const info = await stat(path.join(absolute, entry)).catch(() => null);
      newest = Math.max(newest, info?.mtimeMs ?? 0);
    }
    return newest;
  } catch {
    return Date.now(); // Unreadable: treat it as busy and leave it alone.
  }
}

/**
 * Removes per-job working directories of *other* videos that a killed worker
 * left behind (this video's own are removed just before its render starts). A
 * directory only counts as abandoned once nothing inside it has been touched
 * for longer than a render may last, so a render in another worker is safe.
 */
async function sweepAbandonedWorkDirs(services: RenderServices, job: RenderJobInput, log: RenderLog): Promise<void> {
  const deadline = Date.now() - (services.timeoutMs + ABANDONED_WORK_DIR_MARGIN_MS);
  const mine = renderWorkRoot(job.projectId, job.videoId);
  for (const project of await listSubdirectories(services, RENDER_TMP_ROOT)) {
    for (const video of await listSubdirectories(services, `${RENDER_TMP_ROOT}/${project}`)) {
      const root = `${RENDER_TMP_ROOT}/${project}/${video}`;
      if (root === mine) {
        continue;
      }
      for (const jobId of await listSubdirectories(services, root)) {
        const dir = `${root}/${jobId}`;
        if ((await lastTouched(services, dir)) < deadline && (await removeTree(services, dir))) {
          log(`RENDER: removed an abandoned working directory (${dir})`);
        }
      }
    }
  }
}

/**
 * Always-run cleanup: this job's working directory, then every parent that
 * became empty, up to data/tmp. The parents are only ever removed with rmdir,
 * so a directory still holding another job's work cannot be lost, and nothing
 * outside data/tmp is touched. Never throws: it runs in a finally and must not
 * replace the error that got us there.
 */
async function cleanupWorkDir(services: RenderServices, job: RenderJobInput, log: RenderLog): Promise<void> {
  try {
    const workDir = renderWorkDir(job.projectId, job.videoId, job.jobId);
    if (!(await removeTree(services, workDir))) {
      log(`RENDER warning: the working directory ${workDir} could not be removed; the next render of this video removes it`);
      return;
    }
    const workRoot = renderWorkRoot(job.projectId, job.videoId);
    for (const dir of [workRoot, path.posix.dirname(workRoot), RENDER_TMP_ROOT, path.posix.dirname(RENDER_TMP_ROOT)]) {
      try {
        await rmdir(services.storage.resolve(dir));
      } catch {
        return; // Not empty: another job, possibly in another worker, still needs it.
      }
    }
  } catch {
    // Cleanup is best effort; the next render of this video tries again.
  }
}

function storageError(error: unknown, action: string): RenderError {
  if (error instanceof RenderError) {
    return error;
  }
  const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
  return new RenderError(
    'RENDER_STORAGE_ERROR',
    code === 'ENOSPC' ? `Not enough disk space to ${action}` : `Could not ${action} (${code})`,
  );
}

async function assertFreeSpace(directory: string): Promise<void> {
  let free: number;
  try {
    const info = await statfs(directory);
    free = Number(info.bavail) * Number(info.bsize);
  } catch {
    return; // Not supported / not measurable: rely on ENOSPC handling instead.
  }
  if (free < MIN_FREE_DISK_BYTES) {
    throw new RenderError(
      'RENDER_STORAGE_ERROR',
      `Only ${Math.floor(free / 1024 / 1024)} MB of free disk space; rendering needs at least ${MIN_FREE_DISK_BYTES / 1024 / 1024} MB`,
    );
  }
}

function finalize(result: RenderResult): RenderResult {
  const parsed = RenderResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new RenderError('RENDER_GENERATION_ERROR', `Render result is invalid: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
  }
  return parsed.data;
}

export async function renderVideo(
  job: RenderJobInput,
  services: RenderServices,
  log: RenderLog = (message) => console.log(message),
): Promise<RenderResult> {
  // 1. Inputs and subtitles, all validated (no AI, no TTS, nothing rewritten).
  const input = await loadRenderInput(job, services.storage);
  const subtitles = await loadSubtitles(job.videoId, input.durationMs);

  // 2. Frame timeline from absolute boundaries, motion presets, ASS document and FFmpeg command.
  const frames = sceneFrameCounts(input.scenes, input.durationMs);
  const totalFrames = frames.reduce((sum, count) => sum + count, 0);
  const ass = buildAss(subtitles);
  const motion = services.motion ?? MOTION_OFF;
  const presets = motion.mode === 'kenburns' ? resolveMotionPresets(job.videoId, frames, motion.scale, motion.preset) : [];
  const command = buildRenderCommand(input.scenes, frames, {
    threads: services.threads,
    ...(motion.mode === 'kenburns' ? { motion: { scale: motion.scale, presets } } : {}),
  });
  const motionSummary = motion.mode === 'kenburns' ? `Ken Burns ×${motion.scale} (${presets.join(', ')})` : 'still images';
  const base = {
    version: 1,
    videoId: job.videoId,
    durationMs: input.durationMs,
    frames: totalFrames,
    width: RENDER_SPEC.width,
    height: RENDER_SPEC.height,
    fps: RENDER_SPEC.fps,
    videoCodec: RENDER_SPEC.videoCodec,
    pixelFormat: RENDER_SPEC.pixelFormat,
    audioCodec: RENDER_SPEC.audioCodec,
    audioBitrate: RENDER_SPEC.audioBitrate,
    subtitleVersion: subtitles.version,
    subtitleInputHash: subtitles.inputHash,
    subtitleSegments: subtitles.segments.length,
    motion: motion.mode,
    motionScale: motion.mode === 'kenburns' ? motion.scale : 1,
    motionPresets: presets,
  } as const;

  if (services.provider === 'mock') {
    log(
      `RENDER (mock): ${input.scenes.length} scenes, ${totalFrames} frames, ${subtitles.segments.length} subtitle segments, ${motionSummary}; no video written`,
    );
    return finalize({
      ...base,
      provider: 'mock',
      outputPath: null,
      probedDurationMs: null,
      fileSize: null,
      ffmpegVersion: null,
      renderedAt: new Date().toISOString(),
      warnings: [],
    });
  }

  // 3. Environment: working ffmpeg/ffprobe with the needed codecs/filters, bundled font, disk space.
  const { ffmpegVersion } = await toolchainFor(services);
  const fontFile = path.join(services.fontsDir, FONT_FILE);
  const font = await fontFor(services);
  const fontWarnings = checkFont(font, FONT_FAMILY, subtitleTexts(subtitles), FONT_FILE);
  for (const warning of fontWarnings) {
    log(`RENDER warning: ${warning}`);
  }
  await assertFreeSpace(services.storage.root);

  // 4. Per-job working directory (stale ones of this video are removed first).
  const workRoot = renderWorkRoot(job.projectId, job.videoId);
  const workDir = services.storage.resolve(renderWorkDir(job.projectId, job.videoId, job.jobId));
  const hidePaths = [workDir, services.storage.root];
  try {
    try {
      if (!(await removeTree(services, workRoot))) {
        log(`RENDER warning: an older working directory of this video could not be removed (${workRoot})`);
      }
      await sweepAbandonedWorkDirs(services, job, log).catch(() => undefined);
      await mkdir(path.join(workDir, FONTS_SUBDIR), { recursive: true });
      await writeFile(path.join(workDir, ASS_FILE), ass, 'utf8');
      await copyFile(fontFile, path.join(workDir, FONTS_SUBDIR, FONT_FILE));
    } catch (error) {
      throw storageError(error, 'prepare the render directory');
    }

    // 5. Render.
    log(`RENDER: ${input.scenes.length} scenes, ${totalFrames} frames, ${motionSummary}`);
    const started = Date.now();
    const rendered = await runTool(services, 'ffmpeg', command.args, { cwd: workDir, timeoutMs: services.timeoutMs });
    if (rendered.timedOut) {
      throw new RenderError('RENDER_TIMEOUT', `FFmpeg did not finish within ${Math.round(services.timeoutMs / 1000)} s and was stopped`);
    }
    if (rendered.exitCode !== 0) {
      const detail = stderrTail(rendered.stderr, hidePaths);
      if (/no space left on device|ENOSPC/i.test(rendered.stderr)) {
        throw new RenderError('RENDER_STORAGE_ERROR', `Not enough disk space to render the video: ${detail}`);
      }
      throw new RenderError('RENDER_FFMPEG_FAILED', `FFmpeg failed (exit ${rendered.exitCode ?? 'killed'}): ${detail || 'no error output'}`);
    }
    // FFmpeg ran at -loglevel warning: what it printed anyway is worth keeping with the result.
    const ffmpegWarnings = stderrWarnings(rendered.stderr, hidePaths);
    for (const warning of ffmpegWarnings) {
      log(`RENDER warning (${FONT_FALLBACK.test(warning) ? 'font' : 'ffmpeg'}): ${warning}`);
    }

    // 6. Validate the output with ffprobe before accepting it.
    const tempOutput = path.join(workDir, TEMP_OUTPUT_FILE);
    const size = await stat(tempOutput).then((info) => (info.isFile() ? info.size : 0), () => 0);
    if (size === 0) {
      throw new RenderError('RENDER_OUTPUT_INVALID', 'FFmpeg finished but produced no video file');
    }
    if (size > MAX_OUTPUT_BYTES) {
      throw new RenderError('RENDER_OUTPUT_INVALID', `Rendered video is larger than ${MAX_OUTPUT_BYTES / 1024 / 1024} MB`);
    }
    const probed = await runTool(services, 'ffprobe', PROBE_ARGS, { cwd: workDir, timeoutMs: Math.min(services.timeoutMs, TOOL_TIMEOUT_MS) });
    if (probed.timedOut || probed.exitCode !== 0) {
      throw new RenderError('RENDER_OUTPUT_INVALID', `ffprobe could not read the rendered video: ${stderrTail(probed.stderr, hidePaths) || 'no output'}`);
    }
    const { probedDurationMs } = validateProbe(parseProbeJson(probed.stdout), { durationMs: input.durationMs, frames: totalFrames });

    // 7. Atomic promotion. Video.outputPath is written by the job engine together
    //    with the job result (lib/jobs/process-job.ts), never here.
    const outputPath = `${renderDir(job.projectId, job.videoId)}/${OUTPUT_FILE}`;
    await promoteOutput(tempOutput, services.storage.resolve(outputPath));

    log(`RENDER done: ${outputPath} (${totalFrames} frames, ${(size / 1024 / 1024).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
    return finalize({
      ...base,
      provider: 'ffmpeg',
      outputPath,
      probedDurationMs,
      fileSize: size,
      ffmpegVersion,
      renderedAt: new Date().toISOString(),
      warnings: [...fontWarnings, ...ffmpegWarnings],
    });
  } finally {
    await cleanupWorkDir(services, job, log);
  }
}
