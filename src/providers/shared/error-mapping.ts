import { AppError } from '../../core/errors/AppError.js';
import type { ErrorCode } from '../../contracts/common.js';

/**
 * Shared translation of provider HTTP semantics into the service taxonomy.
 * Each adapter supplies its own SDK error classes; the status->code table lives
 * here so the three adapters cannot drift apart.
 */
export interface MappedProviderError {
  code: ErrorCode;
  status?: number;
  retryAfterMs?: number;
  detail?: string;
}

const MODEL_HINTS = /\bmodel\b|model_not_found|invalid model|does not exist/i;

/** Normalises `Retry-After` (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value * 1000);
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const record = headers as Record<string, unknown> & { get?: (key: string) => unknown };
  if (typeof record.get === 'function') {
    const value = record.get(name);
    if (typeof value === 'string') return value;
  }
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name.toLowerCase() && typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Status-based mapping. Anything unrecognised becomes PROVIDER_UNAVAILABLE for
 * 5xx and PROVIDER_BAD_REQUEST below 500 — never INTERNAL, so a provider fault
 * is never reported as a bug in this service.
 */
export function mapStatus(status: number | undefined, message: string, headers?: unknown): MappedProviderError {
  const retryAfterMs = parseRetryAfter(readHeader(headers, 'retry-after'));

  if (status === 401 || status === 403) {
    return { code: 'PROVIDER_AUTH_FAILED', ...(status ? { status } : {}), detail: message };
  }
  if (status === 404 && MODEL_HINTS.test(message)) {
    return { code: 'PROVIDER_MODEL_NOT_FOUND', status, detail: message };
  }
  if (status === 404) return { code: 'PROVIDER_BAD_REQUEST', status, detail: message };
  if (status === 429) {
    return {
      code: 'PROVIDER_RATE_LIMITED',
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      detail: message,
    };
  }
  if (status === 408) return { code: 'PROVIDER_TIMEOUT', detail: message };
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    return { code: MODEL_HINTS.test(message) ? 'PROVIDER_MODEL_NOT_FOUND' : 'PROVIDER_BAD_REQUEST', ...(status ? { status } : {}), detail: message };
  }
  if (status !== undefined && status >= 500) {
    return {
      code: 'PROVIDER_UNAVAILABLE',
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      detail: message,
    };
  }
  return { code: 'PROVIDER_UNAVAILABLE', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), detail: message };
}

/** Builds the single error type the core understands. */
export function toProviderError(mapped: MappedProviderError, cause?: unknown): AppError {
  return new AppError(mapped.code, undefined, {
    cause,
    details: {
      ...(mapped.detail ? { provider_message: redact(mapped.detail) } : {}),
      ...(mapped.retryAfterMs !== undefined ? { retry_after_ms: Math.round(mapped.retryAfterMs) } : {}),
    },
  });
}

/** Trims provider text and removes anything that looks like a credential. */
export function redact(text: string, maxLength = 300): string {
  return text
    .replace(/\b(sk|rk|ak|gsk|api)[-_][A-Za-z0-9_-]{8,}/g, '[redacted-key]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted-token]')
    .slice(0, maxLength);
}

/** Reads a numeric status from an SDK error without assuming its class. */
export function readStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const candidate = (error as { status?: unknown; statusCode?: unknown; code?: unknown });
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  if (typeof candidate.code === 'number') return candidate.code;
  return undefined;
}

/**
 * Reads the response headers off an SDK/HTTP error so Retry-After survives the
 * trip into the normalized error. Never returns the raw header object itself.
 */
export function readHeaders(error: unknown): Record<string, string> | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const headers = (error as { headers?: unknown }).headers;
  return headers && typeof headers === 'object' ? (headers as Record<string, string>) : undefined;
}

export function readMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error !== null && typeof error === 'object') {
    const candidate = (error as { message?: unknown }).message;
    if (typeof candidate === 'string') return candidate;
  }
  return 'provider request failed';
}
