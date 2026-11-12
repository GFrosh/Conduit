import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../core/errors/AppError.js';
import type { AuthKeyConfig } from '../../config/env.js';
import { hashSecret } from '../../core/security/hashing.js';

/**
 * The authenticated caller. `keyId` is the configured client application, not a
 * person: rate limits, quotas, and audit trails key off it, so one client's
 * traffic can never be attributed to another.
 */
export interface RequestIdentity {
  keyId: string;
  /** Short non-reversible digest prefix, safe for logs. */
  keyFingerprint: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    identity?: RequestIdentity;
  }
}

export { hashSecret };

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The request id is either a client-supplied value that matches a strict
 * pattern, or a server-generated UUID. A client cannot inject arbitrary log
 * content this way.
 */
export function resolveRequestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === 'string' && REQUEST_ID_PATTERN.test(value)) return value;
  return `req_${randomUUID()}`;
}

/**
 * Compares the presented secret against every configured digest in constant
 * time. The loop does not return early on mismatch, so response timing does not
 * reveal which configured key (if any) a guess is close to.
 */
export function verifyServiceKey(
  presented: string | undefined,
  keys: readonly AuthKeyConfig[],
): RequestIdentity {
  if (!presented || presented.length === 0) throw new AppError('AUTH_MISSING');

  const digest = Buffer.from(hashSecret(presented), 'hex');
  let matched: AuthKeyConfig | undefined;
  for (const key of keys) {
    const expected = Buffer.from(key.secretHash, 'hex');
    if (expected.length !== digest.length) continue;
    if (timingSafeEqual(expected, digest)) matched = key;
  }
  if (!matched) throw new AppError('AUTH_INVALID');
  return { keyId: matched.id, keyFingerprint: matched.secretHash.slice(0, 8) };
}

export function extractBearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  // Exactly two space-separated parts. "Bearer <key> extra" is malformed, not
  // "Bearer with extra words", so it must fail rather than be silently truncated.
  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2) return undefined;
  const [scheme, token] = parts;
  if (!token || scheme?.toLowerCase() !== 'bearer') return undefined;
  return token.trim();
}

export interface AuthPluginOptions {
  enabled: boolean;
  keys: readonly AuthKeyConfig[];
}

/** Client authentication. Provider credentials never appear on this path. */
export function registerRequestContext(
  app: FastifyInstance,
  options: AuthPluginOptions,
  publicPaths: readonly string[] = [],
): void {
  app.decorateRequest('requestId', '');
  app.decorateRequest('identity', undefined);

  app.addHook('onRequest', async (request) => {
    request.requestId = resolveRequestId(request.headers['x-request-id']);

    // An unmatched route must still produce the standard 404 envelope, so the
    // auth hook steps aside and lets notFoundHandler shape the response.
    if (request.is404) return;

    const path = request.url.split('?')[0] ?? request.url;
    const isPublic = publicPaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    if (!options.enabled || isPublic) return;

    request.identity = verifyServiceKey(extractBearer(request), options.keys);
  });
}
