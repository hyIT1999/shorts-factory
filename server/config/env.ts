import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).default('file:./data/shorts-factory.db'),
});

export type Env = z.infer<typeof envSchema>;

/** Validated server environment. Fails fast on invalid configuration. */
export const env: Env = envSchema.parse(process.env);
