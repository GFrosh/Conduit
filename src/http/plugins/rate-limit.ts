import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../core/errors/AppError.js';

export interface RateLimitOptions {
  enabled: boolean;
  max: number;
  windowMs: number;
  perClient: boolean;
}

/**
 * In-process limiter: one counter set per replica, reset on restart. That is a
 * deliberate trade for zero extra infrastructure, and it is why the limit is
 * keyed by client id rather than IP when authentication is on — behind a proxy
 * every client would otherwise share one bucket.
 *
 * The rejection body never states the limit or the window; only that a retry
 * may succeed, plus the standard Retry-After header.
 */
export async function registerRateLimit(app: FastifyInstance, options: RateLimitOptions): Promise<void> {
  if (!options.enabled) return;

  await app.register(rateLimit, {
    global: true,
    max: options.max,
    timeWindow: options.windowMs,
    allowList: (request) => {
      const path = request.url.split('?')[0] ?? request.url;
      return path === '/health' || path === '/ready' || path === '/openapi.json';
    },
    keyGenerator: (request) =>
      options.perClient
        ? (request.identity?.keyId ?? request.ip)
        : request.ip,
    // Throwing the domain error keeps ONE error envelope: the shared handler
    // shapes the body and the plugin still sets Retry-After itself.
    errorResponseBuilder: (_request, context) =>
      new AppError('RATE_LIMITED', undefined, {
        details: { retry_after_s: Math.max(1, Math.ceil(context.ttl / 1000)) },
      }),
  });
}
