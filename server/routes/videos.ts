import { Router } from 'express';
import { z } from 'zod';
import type { LocalAssetStorage } from '../../lib/assets/storage.js';
import { ApiError } from '../http/errors.js';
import { getVideoOutput, RERUN_STAGES, rerunStage } from '../services/videos.js';

const rerunSchema = z.object({ stage: z.enum(RERUN_STAGES) });

export function createVideosRouter(storage: LocalAssetStorage): Router {
  const router = Router();

  router.post('/:videoId/rerun', async (req, res) => {
    const { stage } = rerunSchema.parse(req.body);
    res.status(202).json(await rerunStage(req.params.videoId, stage));
  });

  /**
   * The rendered MP4, streamed with Range support so browsers can seek.
   * `?download=1` asks the browser to save it instead of playing it. The file
   * name is built from ids, never from user text.
   */
  router.get('/:videoId/output', async (req, res, next) => {
    const output = await getVideoOutput(req.params.videoId, storage);
    const disposition = req.query['download'] === '1' ? 'attachment' : 'inline';
    res.sendFile(
      output.absolutePath,
      {
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Disposition': `${disposition}; filename="${output.filename}"`,
          'X-Content-Type-Options': 'nosniff',
        },
        dotfiles: 'deny',
        cacheControl: false,
      },
      (error?: Error) => {
        if (!error) {
          return;
        }
        if (res.headersSent) {
          res.end();
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        next(code === 'ENOENT' ? new ApiError(404, 'OUTPUT_MISSING', 'The rendered video file is missing; re-run RENDER.') : error);
      },
    );
  });

  return router;
}
