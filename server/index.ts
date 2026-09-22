import { LocalAssetStorage } from '../lib/assets/storage.js';
import { enableWal } from '../lib/db/prisma.js';
import { createApp } from './app.js';
import { env } from './config/env.js';

await enableWal();

const app = createApp({
  storage: new LocalAssetStorage(env.DATA_DIR),
  apiToken: env.API_TOKEN,
  rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
  minFreeBytes: env.HEALTH_MIN_FREE_MB * 1024 * 1024,
});

app.listen(env.PORT, env.HOST, () => {
  const auth = env.API_TOKEN ? 'API token required' : 'no API token (keep it on localhost or behind an authenticating proxy)';
  console.log(`Shorts Factory API listening on http://${env.HOST}:${env.PORT} (${auth})`);
});
