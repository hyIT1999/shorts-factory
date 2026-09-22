/**
 * Minimal PNG encoder (8-bit RGB, no interlace) using only node:zlib.
 * Enough for deterministic placeholder images that FFmpeg can read later.
 */
import { crc32, deflateSync } from 'node:zlib';

export type Rgb = readonly [number, number, number];

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** Encodes an image whose every row has a single color given by `rowColor(y)`. */
export function encodePng(width: number, height: number, rowColor: (y: number) => Rgb): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // color type: RGB
  // compression, filter and interlace methods stay 0

  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const [r, g, b] = rowColor(y);
    const offset = y * stride; // raw[offset] = 0 → filter "None"
    for (let x = 0; x < width; x++) {
      const p = offset + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
