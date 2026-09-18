import 'dotenv/config';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Shared Prisma client for the API server and background workers.
 *
 * Only server-side code may import this module. The Angular frontend
 * talks to the API over HTTP and never touches the database directly.
 */
function createPrismaClient(): PrismaClient {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');
  }
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}

let client: PrismaClient | undefined;

/** Returns the lazily created Prisma client singleton. */
export function getPrisma(): PrismaClient {
  client ??= createPrismaClient();
  return client;
}
