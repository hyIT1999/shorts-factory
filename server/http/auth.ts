/**
 * Optional shared-secret authentication for the API. Single-user tool: there
 * are no accounts, only one token (API_TOKEN) that every request must carry
 * once it is configured. The health check stays open for uptime monitors.
 * The video output route also accepts `?token=` because a <video> element
 * cannot send headers.
 */
import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

const OUTPUT_ROUTE = /^\/videos\/[^/]+\/output$/;

function sameToken(candidate: string | undefined, expected: Buffer): boolean {
  if (!candidate) {
    return false;
  }
  const actual = Buffer.from(candidate);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Passes every request through when no token is configured. */
export function apiTokenGuard(token: string | undefined): RequestHandler {
  if (!token) {
    return (_req, _res, next) => next();
  }
  const expected = Buffer.from(token);
  return (req, res, next) => {
    if (req.path === '/health') {
      next();
      return;
    }
    const authorization = req.get('authorization');
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : undefined;
    const apiKey = req.get('x-api-key');
    const query = req.query['token'];
    const fromQuery = req.method === 'GET' && OUTPUT_ROUTE.test(req.path) && typeof query === 'string' ? query : undefined;
    if (sameToken(bearer, expected) || sameToken(apiKey, expected) || sameToken(fromQuery, expected)) {
      next();
      return;
    }
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer')
      .json({ error: { code: 'UNAUTHORIZED', message: 'A valid API token is required (Authorization: Bearer <token> or X-API-Key).' } });
  };
}
