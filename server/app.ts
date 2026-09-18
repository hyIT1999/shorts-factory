import express, { type Express } from 'express';
import { healthRouter } from './routes/health.js';

export function createApp(): Express {
  const app = express();

  app.use(express.json());

  app.use('/api/health', healthRouter);

  // TODO (later step): mount /api/projects, /api/settings, etc.

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}
