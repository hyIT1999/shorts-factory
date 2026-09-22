/**
 * Parsers for ffmpeg/ffprobe text output. Only the fields the render stage
 * checks are modelled; unknown fields are ignored.
 */
import { z } from 'zod';

const StreamSchema = z.object({
  index: z.number().int(),
  codec_type: z.string(),
  codec_name: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  pix_fmt: z.string().optional(),
  r_frame_rate: z.string().optional(),
  avg_frame_rate: z.string().optional(),
  /** ffprobe prints counts and durations as strings. */
  nb_frames: z.string().optional(),
  sample_rate: z.string().optional(),
  channels: z.number().int().optional(),
  duration: z.string().optional(),
});

/** `ffprobe -print_format json -show_format -show_streams` output. */
export const ProbeSchema = z.object({
  streams: z.array(StreamSchema),
  format: z.object({
    duration: z.string().optional(),
    size: z.string().optional(),
    format_name: z.string().optional(),
  }),
});

export type ProbeInfo = z.infer<typeof ProbeSchema>;
export type ProbeStream = ProbeInfo['streams'][number];

/** Parsed ffprobe JSON, or null when the output is not what ffprobe prints. */
export function parseProbeJson(stdout: string): ProbeInfo | null {
  try {
    const parsed = ProbeSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Names listed by `ffmpeg -encoders` / `ffmpeg -filters`: each entry line is a
 * short flag column followed by the name. The column is six characters wide for
 * encoders ("V....D") and two ("T.", "..") or three (".S.", before FFmpeg 9)
 * for filters. Legend lines ("V..... = Video") are skipped.
 */
export function parseToolList(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*[A-Z.|]{2,6}\s+([A-Za-z0-9_]+)\s/.exec(line);
    if (match?.[1]) {
      names.add(match[1]);
    }
  }
  return names;
}

/** "ffmpeg version 7.1-full_build-www.gyan.dev Copyright…" → "7.1-full_build-www.gyan.dev". */
export function parseVersion(output: string): string | null {
  return /version\s+(\S+)/.exec(output)?.[1] ?? null;
}
