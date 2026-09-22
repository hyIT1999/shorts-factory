/**
 * FFmpeg argument builder (pure). One process renders the whole video:
 *   each image → scaled/cropped once to 1080×1920 → repeated for exactly its
 *   frame count (loop filter), or, with motion on, supersampled and moved by
 *   zoompan for exactly its frame count → concat → subtitles (libass) → H.264;
 *   each WAV → 48 kHz stereo → concat (sample-exact) → AAC.
 * Input paths are separate argv entries (no quoting or escaping needed). The
 * filtergraph contains only numbers, fixed relative names resolved from the
 * working directory (cwd) and zoompan's own variable names: no absolute path,
 * drive colon, backslash or user text ever appears in it.
 */
import { RenderError } from './errors.js';
import { assertMotionScale, MOTION_SOURCE_PIXEL_FORMAT, motionSourceSize, zoompanFilter } from './motion.js';
import { RENDER_SPEC, type MotionPreset, type RenderScene } from './types.js';

export const ASS_FILE = 'subtitles.ass';
export const FONTS_SUBDIR = 'fonts';
export const TEMP_OUTPUT_FILE = 'video.tmp.mp4';
export const OUTPUT_FILE = 'video.mp4';

export interface RenderCommand {
  args: string[];
  filterComplex: string;
}

export interface RenderCommandMotion {
  /** Supersampling factor of the source before zoompan (1–3). */
  scale: number;
  /** One resolved preset per scene (lib/render/motion.ts). */
  presets: readonly MotionPreset[];
}

export interface RenderCommandOptions {
  /** Encoder threads (RENDER_THREADS); unset or 0 = FFmpeg's default, all cores. */
  threads?: number;
  /** Ken Burns motion; unset = still images (the Phase A chain). */
  motion?: RenderCommandMotion;
}

const COLOR = 'out_color_matrix=bt709:out_range=tv';

/** Still image: scaled/cropped once, then repeated for exactly `frameCount` frames. */
function stillChain(k: number, frameCount: number): string {
  const { width, height, fps, pixelFormat } = RENDER_SPEC;
  // An image input has the demuxer's default 1/25 time base, where N/30 is not an
  // integer and setpts truncates (colliding frames, every scene too short).
  // In a 1/30 time base, frame N is exactly pts N.
  return (
    `[${k}:v]scale=${width}:${height}:force_original_aspect_ratio=increase:${COLOR},` +
    `crop=${width}:${height},setsar=1,format=${pixelFormat},` +
    `loop=loop=${frameCount - 1}:size=1:start=0,settb=1/${fps},setpts=N[v${k}]`
  );
}

/** Moving image: supersampled, then zoompan emits exactly `frameCount` frames at the output size. */
function motionChain(k: number, frameCount: number, preset: MotionPreset, scale: number): string {
  const { fps, pixelFormat } = RENDER_SPEC;
  const source = motionSourceSize(scale);
  return (
    `[${k}:v]scale=${source.width}:${source.height}:force_original_aspect_ratio=increase:flags=lanczos:${COLOR},` +
    `crop=${source.width}:${source.height},setsar=1,format=${MOTION_SOURCE_PIXEL_FORMAT},` +
    `${zoompanFilter(preset, frameCount, scale)},format=${pixelFormat},settb=1/${fps},setpts=N[v${k}]`
  );
}

export function buildRenderCommand(
  scenes: readonly Pick<RenderScene, 'imagePath' | 'audioPath'>[],
  frames: readonly number[],
  options: RenderCommandOptions = {},
): RenderCommand {
  const count = scenes.length;
  if (count === 0 || frames.length !== count || frames.some((f) => !Number.isInteger(f) || f < 1)) {
    throw new RenderError('RENDER_GENERATION_ERROR', 'Render command needs one positive frame count per scene');
  }
  const motion = options.motion;
  if (motion) {
    assertMotionScale(motion.scale);
    if (motion.presets.length !== count) {
      throw new RenderError('RENDER_GENERATION_ERROR', 'Render command needs one motion preset per scene');
    }
  }
  const { pixelFormat, fps, audioSampleRate } = RENDER_SPEC;

  const videoChains = frames.map((frameCount, k) =>
    motion ? motionChain(k, frameCount, motion.presets[k] ?? 'zoom-in', motion.scale) : stillChain(k, frameCount),
  );
  const audioChains = scenes.map(
    (_, k) => `[${count + k}:a]aresample=${audioSampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo[a${k}]`,
  );
  const labels = (prefix: string) => scenes.map((_, k) => `[${prefix}${k}]`).join('');
  const filterComplex = [
    ...videoChains,
    ...audioChains,
    `${labels('v')}concat=n=${count}:v=1:a=0,ass=filename=${ASS_FILE}:fontsdir=${FONTS_SUBDIR}[vout]`,
    `${labels('a')}concat=n=${count}:v=0:a=1[aout]`,
  ].join(';');

  // -loglevel warning: libass reports font fallbacks and missing glyphs at this level, and the
  // service keeps those lines in the result (the render still succeeds).
  const args = [
    '-nostdin',
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'warning',
    '-y',
    ...scenes.flatMap((scene) => ['-i', scene.imagePath]),
    ...scenes.flatMap((scene) => ['-i', scene.audioPath]),
    '-filter_complex',
    filterComplex,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    RENDER_SPEC.videoEncoder,
    '-preset',
    RENDER_SPEC.preset,
    '-crf',
    String(RENDER_SPEC.crf),
    '-pix_fmt',
    pixelFormat,
    '-r',
    String(fps),
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-c:a',
    RENDER_SPEC.audioCodec,
    '-b:a',
    RENDER_SPEC.audioBitrate,
    '-ar',
    String(audioSampleRate),
    '-ac',
    String(RENDER_SPEC.audioChannels),
    '-movflags',
    '+faststart',
    ...(options.threads && options.threads > 0 ? ['-threads', String(options.threads)] : []),
    TEMP_OUTPUT_FILE,
  ];
  return { args, filterComplex };
}

/** ffprobe arguments for the rendered file (relative to the working directory). */
export const PROBE_ARGS: readonly string[] = [
  '-v',
  'error',
  '-print_format',
  'json',
  '-show_format',
  '-show_streams',
  TEMP_OUTPUT_FILE,
];

export const REQUIRED_ENCODERS: readonly string[] = [RENDER_SPEC.videoEncoder, RENDER_SPEC.audioCodec];
export const REQUIRED_FILTERS: readonly string[] = [
  'ass',
  'scale',
  'crop',
  'setsar',
  'format',
  'loop',
  'zoompan',
  'settb',
  'setpts',
  'concat',
  'aresample',
  'aformat',
];
