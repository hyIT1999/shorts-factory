/**
 * A small fixed-window limiter for mutating requests (POST/PUT/DELETE): each
 * generate or re-run spends AI/TTS quota and disk, so a runaway client or a
 * script that found the port must not be able to queue hundreds of them.
 * In-memory, per client address, no dependency; reads are never limited.
 */
import type { RequestHandler } from 'express';

const WINDOW_MS = 60_000;
const MAX_TRACKED_CLIENTS = 10_000;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `perMinute` ≤ 0 disables the limit. */
export function rateLimit(perMinute: number): RequestHandler {
  if (perMinute <= 0) {
    return (_req, _res, next) => next();
  }
  const hits = new Map<string, number[]>();
  return (req, res, next) => {
    if (READ_METHODS.has(req.method)) {
      next();
      return;
    }
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const recent = (hits.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
    if (recent.length >= perMinute) {
      hits.set(key, recent);
      const retryAfterSec = Math.max(1, Math.ceil(((recent[0] ?? now) + WINDOW_MS - now) / 1000));
      res
        .status(429)
        .set('Retry-After', String(retryAfterSec))
        .json({ error: { code: 'RATE_LIMITED', message: `Too many requests; try again in ${retryAfterSec} s.` } });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > MAX_TRACKED_CLIENTS) {
      const oldest = hits.keys().next().value;
      if (oldest !== undefined) {
        hits.delete(oldest);
      }
    }
    next();
  };
}
