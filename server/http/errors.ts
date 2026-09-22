import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ActiveJobConflictError } from '../../lib/jobs/create-job.js';

/** An error with a known HTTP status and a stable machine-readable code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

function body(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

function isJsonParseError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    (err as { type: unknown }).type === 'entity.parse.failed'
  );
}

/** 404 for unknown /api routes. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json(body('NOT_FOUND', 'Route not found'));
};

/** Maps errors to the consistent `{ error: { code, message } }` shape. Never leaks stack traces. */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json(body(err.code, err.message));
    return;
  }
  if (err instanceof ZodError) {
    const message = err.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    res.status(400).json(body('VALIDATION_ERROR', message));
    return;
  }
  if (err instanceof ActiveJobConflictError) {
    // The project status guards against this; the job engine's own check is the safety net.
    res.status(409).json(body('JOB_ALREADY_ACTIVE', 'This video already has a pending or running job.'));
    return;
  }
  if (isJsonParseError(err)) {
    res.status(400).json(body('INVALID_JSON', 'Request body is not valid JSON'));
    return;
  }

  console.error(`Unhandled error on ${req.method} ${req.originalUrl}`, err);
  res.status(500).json(body('INTERNAL_ERROR', 'Unexpected server error'));
};
