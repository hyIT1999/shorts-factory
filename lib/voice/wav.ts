/**
 * Minimal WAV (RIFF, PCM 16-bit) encoder and validating parser.
 * Duration is always computed from the actual PCM byte count.
 */
import { VoiceError } from './errors.js';

export interface WavFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export interface WavInfo extends WavFormat {
  dataBytes: number;
  durationSec: number;
}

/** WavInfo plus where the PCM payload starts inside the file. */
export interface WavData extends WavInfo {
  dataOffset: number;
}

const HEADER_BYTES = 44;
const PCM_FORMAT = 1;

/** Wraps raw little-endian PCM samples in a WAV container. */
export function encodeWav(pcm: Uint8Array, format: WavFormat = { sampleRate: 24_000, channels: 1, bitsPerSample: 16 }): Buffer {
  const { sampleRate, channels, bitsPerSample } = format;
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(PCM_FORMAT, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

function invalid(message: string): VoiceError {
  return new VoiceError('INVALID_AUDIO', `Invalid WAV audio: ${message}`);
}

/** Validates a PCM 16-bit WAV file and returns its format and real duration. */
export function parseWav(input: Uint8Array): WavInfo {
  const data = parseWavData(input);
  return { sampleRate: data.sampleRate, channels: data.channels, bitsPerSample: data.bitsPerSample, dataBytes: data.dataBytes, durationSec: data.durationSec };
}

/** parseWav plus the byte offset of the PCM payload (for reading or cutting samples). */
export function parseWavData(input: Uint8Array): WavData {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < HEADER_BYTES || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw invalid('missing RIFF/WAVE header');
  }

  let format: WavFormat | undefined;
  let dataBytes: number | undefined;
  let dataOffset = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) {
        throw invalid('truncated fmt chunk');
      }
      if (buf.readUInt16LE(body) !== PCM_FORMAT) {
        throw invalid('not PCM');
      }
      format = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (body + size > buf.length) {
        throw invalid('data chunk is truncated');
      }
      dataBytes = size;
      dataOffset = body;
      break;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (!format) {
    throw invalid('missing fmt chunk');
  }
  if (format.bitsPerSample !== 16) {
    throw invalid(`expected 16-bit samples, got ${format.bitsPerSample}`);
  }
  if (format.channels < 1 || format.channels > 2 || format.sampleRate < 8_000 || format.sampleRate > 96_000) {
    throw invalid(`unsupported format ${format.channels} ch @ ${format.sampleRate} Hz`);
  }
  if (dataBytes === undefined) {
    throw invalid('missing data chunk');
  }
  const blockAlign = format.channels * 2;
  if (dataBytes % blockAlign !== 0) {
    throw invalid('data size is not a whole number of samples');
  }
  return { ...format, dataBytes, dataOffset, durationSec: dataBytes / blockAlign / format.sampleRate };
}

/**
 * Interleaved 16-bit samples of a WAV file, copied into their own buffer
 * (file bytes may sit at an odd offset inside a pooled Buffer).
 */
export function wavSamples(input: Uint8Array): { format: WavFormat; samples: Int16Array } {
  const info = parseWavData(input);
  const bytes = new Uint8Array(info.dataBytes);
  bytes.set(input.subarray(info.dataOffset, info.dataOffset + info.dataBytes));
  return {
    format: { sampleRate: info.sampleRate, channels: info.channels, bitsPerSample: info.bitsPerSample },
    samples: new Int16Array(bytes.buffer, 0, info.dataBytes / 2),
  };
}

/** Wraps a range of interleaved 16-bit samples (frame = one sample per channel) back into a WAV file. */
export function sliceWav(samples: Int16Array, format: WavFormat, startFrame: number, endFrame: number): Buffer {
  const start = startFrame * format.channels;
  const end = endFrame * format.channels;
  const pcm = new Uint8Array(samples.buffer, samples.byteOffset + start * 2, (end - start) * 2);
  return encodeWav(pcm, format);
}
