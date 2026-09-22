import { Router } from 'express';
import { z } from 'zod';
import type { LocalAssetStorage } from '../../lib/assets/storage.js';
import {
  createProject,
  deleteProject,
  getProjectDetail,
  listProjects,
  startGeneration,
} from '../services/projects.js';

const createProjectSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  topic: z.string().trim().min(1, 'Topic is required').max(500),
});

export function createProjectsRouter(storage: LocalAssetStorage): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const input = createProjectSchema.parse(req.body);
    res.status(201).json(await createProject(input));
  });

  router.get('/', async (_req, res) => {
    res.json(await listProjects());
  });

  router.get('/:id', async (req, res) => {
    res.json(await getProjectDetail(req.params.id));
  });

  /** Removes the project, its database records and its files (assets, audio, renders, tmp). */
  router.delete('/:id', async (req, res) => {
    res.json(await deleteProject(req.params.id, storage));
  });

  router.post('/:id/generate', async (req, res) => {
    res.status(202).json(await startGeneration(req.params.id));
  });

  return router;
}
