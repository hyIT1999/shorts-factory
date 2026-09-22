import { Router } from 'express';
import { abortJob, getJob } from '../services/jobs.js';

export const jobsRouter = Router();

jobsRouter.get('/:id', async (req, res) => {
  res.json(await getJob(req.params.id));
});

/** Cancels a PENDING or RUNNING job (its video and project become FAILED, ready for a re-run). */
jobsRouter.post('/:id/abort', async (req, res) => {
  res.json(await abortJob(req.params.id));
});
