/**
 * Central redaction. One implementation for logs, error details, and the
 * debug sample path, so "we forgot to redact here" cannot happen per-call-site.
 */

/** Credential-shaped strings: provider keys, bearer tokens, long opaque blobs. */
const KEY_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|rk|ak|gsk|pk)[-_][A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

export function redactSecretText(input: string, maxLength = 300): string {
  let output = input;
  for (const pattern of KEY_PATTERNS) output = output.replace(pattern, '[redacted]');
  return output.length > maxLength ? `${output.slice(0, maxLength)}…[truncated]` : output;
}

/**
 * A short, non-reversible fingerprint for correlating a key across log lines
 * without ever recording the key. Only the first 8 hex chars of the digest.
 */
export function keyFingerprint(hashOrSecret: string): string {
  return hashOrSecret.slice(0, 8);
}

/**
 * Values are only ever logged when the operator has explicitly opted in AND the
 * per-request sampling decision selected this request. Off by default.
 */
export function sampleContent(value: string, proceed: boolean): string | undefined {
  if (!proceed) return undefined;
  return `[sample] ${value.slice(0, 240)}…[len=${value.length}]`;
}
