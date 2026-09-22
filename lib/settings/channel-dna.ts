/**
 * Channel DNA: the single user's channel defaults (tone, audience, style…).
 * Stored in the Setting table as one row per field, key "channelDna.<field>".
 * Never stores credentials.
 */
import { z } from 'zod';
import { getPrisma, type Db } from '../db/prisma.js';

const field = z.string().trim().min(1).max(100);

export const ChannelDnaSchema = z.strictObject({
  niche: field,
  targetAudience: field,
  language: field,
  tone: field,
  averageDuration: field,
  hookStyle: field,
  ctaStyle: field,
  visualStyle: field,
  subtitleStyle: field,
  voice: field,
  musicStyle: field,
});

export type ChannelDna = z.infer<typeof ChannelDnaSchema>;
type ChannelDnaField = keyof ChannelDna;

export const DEFAULT_CHANNEL_DNA: ChannelDna = {
  niche: 'Science',
  targetAudience: '18-30',
  language: 'vi',
  tone: 'Curious / mysterious',
  averageDuration: '40-55',
  hookStyle: 'Question',
  ctaStyle: 'Short',
  visualStyle: 'Dark documentary',
  subtitleStyle: 'White with yellow emphasis',
  voice: 'Male / Deep',
  musicStyle: 'Cinematic',
};

const FIELDS = Object.keys(DEFAULT_CHANNEL_DNA) as ChannelDnaField[];
const KEY_PREFIX = 'channelDna.';

/** Reads the Channel DNA, falling back to defaults for missing or invalid values. */
export async function getChannelDna(db: Db = getPrisma()): Promise<ChannelDna> {
  const rows = await db.setting.findMany({
    where: { key: { in: FIELDS.map((name) => KEY_PREFIX + name) } },
    select: { key: true, value: true },
  });
  const stored = new Map(rows.map((row) => [row.key.slice(KEY_PREFIX.length), row.value]));

  const dna = { ...DEFAULT_CHANNEL_DNA };
  for (const name of FIELDS) {
    const parsed = field.safeParse(stored.get(name));
    if (parsed.success) {
      dna[name] = parsed.data;
    }
  }
  return dna;
}

/** Saves a full, validated Channel DNA. */
export async function saveChannelDna(input: unknown): Promise<ChannelDna> {
  const dna = ChannelDnaSchema.parse(input);
  const prisma = getPrisma();
  await prisma.$transaction(
    FIELDS.map((name) =>
      prisma.setting.upsert({
        where: { key: KEY_PREFIX + name },
        create: { key: KEY_PREFIX + name, value: dna[name] },
        update: { value: dna[name] },
      }),
    ),
  );
  return dna;
}

/** Parses "40-55" (or "45") into a duration range in seconds, clamped to 30–60. */
export function parseDurationRange(value: string): { min: number; max: number } {
  const numbers = (value.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const clamp = (n: number) => Math.min(60, Math.max(30, Math.round(n)));
  const [first, second] = numbers;
  if (first === undefined) {
    return { min: 40, max: 55 };
  }
  const a = clamp(first);
  const b = clamp(second ?? first);
  return { min: Math.min(a, b), max: Math.max(a, b) };
}
