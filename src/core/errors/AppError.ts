import type { ErrorCode } from '../../contracts/common.js';

export interface AppErrorOptions {
  status?: number;
  retryable?: boolean;
  details?: unknown;
  cause?: unknown;
}

/**
 * One error class for the whole service, discriminated by `code`.
 * A hierarchy of 20 subclasses would express the same 30 string codes with
 * more ceremony and worse stack traces.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, options: AppErrorOptions = {}) {
    super(message ?? DEFAULT_MESSAGES[code], { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.details = options.details;
  }

  static isAppError(value: unknown): value is AppError {
    return value instanceof AppError;
  }
}

/** Client-safe messages only. Provider text never reaches a client. */
const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  AUTH_MISSING: 'Authentication credentials were not provided.',
  AUTH_INVALID: 'Authentication credentials are invalid.',
  RATE_LIMITED: 'Too many requests. Please retry later.',
  PAYLOAD_TOO_LARGE: 'Request body exceeds the configured size limit.',
  VALIDATION_FAILED: 'The request did not satisfy the API contract.',
  CREDENTIALS_IN_PAYLOAD: 'Provider credentials must not be supplied in the request payload.',
  NOT_FOUND: 'The requested resource does not exist.',
  PROVIDER_UNKNOWN: 'The requested provider is not recognised.',
  PROVIDER_NOT_CONFIGURED: 'The requested provider is not available in this deployment.',
  MODEL_REQUIRED: 'No model was supplied and no default model is configured for this provider.',
  MODEL_NOT_ALLOWED: 'The requested model is not permitted in this deployment.',
  OUTPUT_FORMAT_UNSUPPORTED: 'The resolved provider cannot satisfy the requested output format.',
  OPTION_UNSUPPORTED: 'The resolved provider does not support a requested generation option.',
  INVALID_JSON_SCHEMA: 'The supplied JSON schema is not valid.',
  FALLBACK_INVALID: 'The supplied fallback policy is not valid.',
  PROVIDER_AUTH_FAILED: 'The service could not authenticate with the AI provider.',
  PROVIDER_RATE_LIMITED: 'The AI provider is rate limiting this service.',
  PROVIDER_UNAVAILABLE: 'The AI provider is currently unavailable.',
  PROVIDER_BAD_REQUEST: 'The AI provider rejected the generated request.',
  PROVIDER_MODEL_NOT_FOUND: 'The AI provider does not recognise the requested model.',
  PROVIDER_TIMEOUT: 'The AI provider did not respond within the allotted time.',
  OUTPUT_UNPARSEABLE: 'The provider response could not be parsed as structured output.',
  OUTPUT_VALIDATION_FAILED: 'The provider response did not satisfy the requested JSON schema.',
  OUTPUT_TRUNCATED: 'The provider stopped before the response was complete.',
  MODEL_REFUSED: 'The model refused to produce a response for this request.',
  TIMEOUT: 'The request exceeded its execution deadline.',
  INTERNAL: 'An unexpected internal error occurred.',
};

/** 502 for PROVIDER_AUTH_FAILED: our credential is bad, not the caller's. */
const DEFAULT_STATUS: Record<ErrorCode, number> = {
  AUTH_MISSING: 401,
  AUTH_INVALID: 401,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  VALIDATION_FAILED: 400,
  CREDENTIALS_IN_PAYLOAD: 400,
  NOT_FOUND: 404,
  PROVIDER_UNKNOWN: 400,
  PROVIDER_NOT_CONFIGURED: 503,
  MODEL_REQUIRED: 400,
  MODEL_NOT_ALLOWED: 400,
  OUTPUT_FORMAT_UNSUPPORTED: 422,
  OPTION_UNSUPPORTED: 400,
  INVALID_JSON_SCHEMA: 400,
  FALLBACK_INVALID: 400,
  PROVIDER_AUTH_FAILED: 502,
  PROVIDER_RATE_LIMITED: 503,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_BAD_REQUEST: 502,
  PROVIDER_MODEL_NOT_FOUND: 400,
  PROVIDER_TIMEOUT: 504,
  OUTPUT_UNPARSEABLE: 502,
  OUTPUT_VALIDATION_FAILED: 502,
  OUTPUT_TRUNCATED: 502,
  MODEL_REFUSED: 422,
  TIMEOUT: 504,
  INTERNAL: 500,
};

const RETRYABLE = new Set<ErrorCode>([
  'RATE_LIMITED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'TIMEOUT',
  'INTERNAL',
]);

export function toAppError(value: unknown): AppError {
  if (AppError.isAppError(value)) return value;
  return new AppError('INTERNAL', undefined, { cause: value });
}
