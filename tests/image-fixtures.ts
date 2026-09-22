/**
 * Byte-level image fixtures for tests: files whose headers are valid for the
 * header parser (lib/assets/image-info.ts) without being real, decodable
 * pictures. Real images come from renderPlaceholderPng.
 */
import { crc32 } from 'node:zlib';

const u16be = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32be = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u32le = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

/** Only the PNG signature and IHDR chunk: enough for the header parser, not a full image. */
export function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const typeAndData = Buffer.concat([Buffer.from('IHDR', 'ascii'), ihdr]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32be(13), typeAndData, u32be(crc32(typeAndData))]);
}

export interface JpegOptions {
  progressive?: boolean;
  /** Bytes of APP2 segments placed before the frame header (split into ≤ 60 000-byte segments). */
  paddingBytes?: number;
  /** Insert 0xFF fill bytes before the frame header marker. */
  fill?: boolean;
}

function segment(marker: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xff, marker]), u16be(payload.length + 2), payload]);
}

/** A structurally valid JPEG (SOI, APP0, optional padding, DQT, SOF, SOS, EOI) with the given frame size; not decodable. */
export function syntheticJpeg(width: number, height: number, options: JpegOptions = {}): Buffer {
  const parts = [Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'))];
  let padding = options.paddingBytes ?? 0;
  while (padding > 0) {
    const size = Math.min(padding, 60_000);
    parts.push(segment(0xe2, Buffer.alloc(size)));
    padding -= size;
  }
  parts.push(segment(0xdb, Buffer.alloc(65)));
  if (options.fill) {
    parts.push(Buffer.from([0xff, 0xff]));
  }
  const sof = Buffer.alloc(9);
  sof[0] = 8; // precision
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1; // one component
  sof[6] = 1;
  sof[7] = 0x11;
  sof[8] = 0;
  parts.push(segment(options.progressive ? 0xc2 : 0xc0, sof));
  parts.push(segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/** A JPEG whose scan starts before any frame header (invalid). */
export function jpegWithoutFrameHeader(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0xff, 0xd9])]);
}

export type WebpKind = 'VP8 ' | 'VP8L' | 'VP8X';

/** A WebP container whose first chunk carries the given canvas size (no real image data). */
export function syntheticWebp(kind: WebpKind, width: number, height: number): Buffer {
  const data = Buffer.alloc(16);
  if (kind === 'VP8 ') {
    data[3] = 0x9d;
    data[4] = 0x01;
    data[5] = 0x2a;
    data.writeUInt16LE(width, 6);
    data.writeUInt16LE(height, 8);
  } else if (kind === 'VP8L') {
    data[0] = 0x2f;
    data.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  } else {
    data.writeUIntLE(width - 1, 4, 3);
    data.writeUIntLE(height - 1, 7, 3);
  }
  const chunk = Buffer.concat([Buffer.from(kind, 'ascii'), u32le(data.length), data]);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), u32le(4 + chunk.length), Buffer.from('WEBP', 'ascii'), chunk]);
}
