import 'dotenv/config';
import { z } from 'zod';

/** An empty value in .env means "not set". */
const optionalString = (schema: z.ZodString) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema.optional());

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  /**
   * Bind address. 127.0.0.1 by default: the API is only reachable from this
   * machine (Angular dev proxy, SSH tunnel, or nginx in front of it). Set
   * 0.0.0.0 only together with API_TOKEN or an authenticating reverse proxy.
   */
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  DATABASE_URL: z.string().min(1).default('file:./data/shorts-factory.db'),
  /** Storage root shared with the worker; paths in the database are relative to it. */
  DATA_DIR: z.string().trim().min(1).default('data'),
  /** When set, every /api request except /api/health must carry it (Bearer token or X-API-Key). */
  API_TOKEN: optionalString(z.string().trim().min(16, 'API_TOKEN must be at least 16 characters')),
  /** Mutating requests (POST/PUT/DELETE) allowed per client per minute; 0 disables the limit. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(30),
  /** Free space on DATA_DIR below which /api/health reports "degraded" (MB). */
  HEALTH_MIN_FREE_MB: z.coerce.number().int().min(0).default(5120),
});

export type Env = z.infer<typeof envSchema>;

/** Validated server environment. Fails fast on invalid configuration. */
export const env: Env = envSchema.parse(process.env);
