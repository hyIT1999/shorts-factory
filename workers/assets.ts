/**
 * ASSETS stage: selects and stores one local visual per scene (see
 * lib/assets/service.ts). Phase A providers: placeholder (default) and mock;
 * scenes without a usable candidate fall back to a placeholder image.
 */
import { prepareVideoAssets } from '../lib/assets/service.js';
import type { AssetsResult } from '../lib/assets/types.js';
import type { JobHandler } from '../lib/jobs/types.js';

export const assetsHandler: JobHandler = async (_job, payload, { assets }): Promise<AssetsResult> =>
  prepareVideoAssets({ projectId: payload.projectId, videoId: payload.videoId }, assets);
