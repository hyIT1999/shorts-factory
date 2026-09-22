import { Router } from 'express';
import type { LocalAssetStorage } from '../../lib/assets/storage.js';
import { getHealth } from '../services/health.js';

/**
 * Always answers 200 with `status: "ok" | "degraded"` plus queue, worker and
 * disk details, so an uptime monitor can alert on the body without the API
 * itself counting as down.
 */
export function createHealthRouter(storage: LocalAssetStorage, options: { minFreeBytes: number }): Router {
  const router = Router();
  router.get('/', async (_req, res) => {
    res.json(await getHealth(storage, options));
  });
  return router;
}
