import { Router } from 'express';
import { getChannelDna, saveChannelDna } from '../../lib/settings/channel-dna.js';

export const settingsRouter = Router();

settingsRouter.get('/channel-dna', async (_req, res) => {
  res.json(await getChannelDna());
});

/** Replaces the full Channel DNA (validated with Zod; 400 on invalid input). */
settingsRouter.put('/channel-dna', async (req, res) => {
  res.json(await saveChannelDna(req.body));
});
