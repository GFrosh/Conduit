import type { FastifyInstance } from 'fastify';
import { AppError } from '../../core/errors/AppError.js';

/**
 * Keys that can only mean "a credential the client is trying to hand us".
 * Matching is done per word segment, not on raw substrings: `max_output_tokens`
 * is a legitimate sampling option and must never be mistaken for a token field.
 */
const DENY_SEGMENTS: ReadonlySet<string> = new Set([
  'token',
  'secret',
  'password',
  'credential',
  'credentials',
  'authorization',
  'bearer',
  'apikey',
]);

/** Splits `apiKey`, `api_key`, `api-key`, `anthropicApiKey` into lowercase words. */
function segmentsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

export function isCredentialKey(key: string): boolean {
  const segments = segmentsOf(key);
  const joined = segments.join('');
  if (joined.includes('apikey')) return true;
  return segments.some((segment) => DENY_SEGMENTS.has(segment));
}

/**
 * A client must never be able to send a provider credential. Schema `.strict()`
 * already rejects unknown keys, but this guard names the real problem and runs
 * before validation so the operator sees CREDENTIALS_IN_PAYLOAD, not a generic
 * VALIDATION_FAILED.
 */
export function findCredentialField(payload: unknown, depth = 0): string | null {
  if (depth > 4 || payload === null || typeof payload !== 'object') return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findCredentialField(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    // Matched at any depth: a credential inside `metadata` is still a credential.
    if (isCredentialKey(key)) return key;
    const nested = findCredentialField(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

export function registerCredentialGuard(app: FastifyInstance): void {
  app.addHook('preValidation', async (request) => {
    if (request.is404) return;
    const offending = findCredentialField(request.body);
    if (offending) {
      throw new AppError('CREDENTIALS_IN_PAYLOAD', undefined, {
        details: { offending_field: offending },
      });
    }
  });
}
