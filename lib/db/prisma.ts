import 'dotenv/config';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient, type Prisma } from '../generated/prisma/client.js';

/** Either the root client or an interactive-transaction client. */
export type Db = PrismaClient | Prisma.TransactionClient;

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
  // `timeout` is SQLite's busy timeout: when the API and a worker write at the
  // same time, the second writer waits for the lock instead of failing.
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url, timeout: 5000 }) });
}

let client: PrismaClient | undefined;

/** Returns the lazily created Prisma client singleton. */
export function getPrisma(): PrismaClient {
  client ??= createPrismaClient();
  return client;
}

/**
 * Switches the database to WAL mode so readers (API) are not blocked while a
 * writer (worker) holds the lock. The setting is persisted in the database file.
 */
export async function enableWal(): Promise<void> {
  const prisma = getPrisma();
  const [current] = await prisma.$queryRawUnsafe<{ journal_mode: string }[]>('PRAGMA journal_mode;');
  // Changing the mode needs an exclusive lock, so only do it when necessary.
  if (current?.journal_mode.toLowerCase() !== 'wal') {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
  }
}
