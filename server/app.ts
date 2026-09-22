import express, { type Express } from 'express';
import { LocalAssetStorage } from '../lib/assets/storage.js';
import { apiTokenGuard } from './http/auth.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { rateLimit } from './http/rate-limit.js';
import { createHealthRouter } from './routes/health.js';
import { jobsRouter } from './routes/jobs.js';
import { createProjectsRouter } from './routes/projects.js';
import { settingsRouter } from './routes/settings.js';
import { createVideosRouter } from './routes/videos.js';

/** 5 GB: below this the health check reports the storage volume as low. */
export const DEFAULT_MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;

export interface AppOptions {
  /** Storage root for rendered videos and project cleanup (default: DATA_DIR or "data"). */
  storage?: LocalAssetStorage;
  /** Required on every /api request except /api/health when set (see http/auth.ts). */
  apiToken?: string;
  /** Mutating requests per client per minute; 0 or unset disables the limit. */
  rateLimitPerMinute?: number;
  /** Free space on the storage volume below which /api/health reports "degraded". */
  minFreeBytes?: number;
}

export function createApp(options: AppOptions = {}): Express {
  const storage = options.storage ?? new LocalAssetStorage(process.env['DATA_DIR']?.trim() || 'data');
  const app = express();

  // nginx on the same machine forwards the client address; anything else is not trusted.
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  app.use(express.json());
  app.use('/api', apiTokenGuard(options.apiToken));
  app.use('/api', rateLimit(options.rateLimitPerMinute ?? 0));

  app.use('/api/health', createHealthRouter(storage, { minFreeBytes: options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES }));
  app.use('/api/projects', createProjectsRouter(storage));
  app.use('/api/jobs', jobsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/videos', createVideosRouter(storage));

  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  return app;
}
