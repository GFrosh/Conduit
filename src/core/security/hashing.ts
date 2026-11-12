import { createHash } from 'node:crypto';

/** SHA-256 hex digest. Service secrets are compared as digests, never as text. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;

/** A 64-char hex secret is treated as an already-computed digest. */
export function normalizeSecret(secret: string): string {
  return SHA256_HEX.test(secret) ? secret.toLowerCase() : hashSecret(secret);
}
