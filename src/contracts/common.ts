/**
 * Provider-neutral primitives shared by every contract.
 * Nothing in this file may reference a provider SDK type.
 */

export const PROVIDER_IDS = ['openai', 'anthropic', 'gemini'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** A client-supplied JSON Schema document. Opaque to the service; Ajv owns it. */
export type JsonSchemaObject = { [key: string]: unknown };

export const OUTPUT_FORMATS = ['text', 'markdown', 'json'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/**
 * Deliberately includes 'unknown'. Mapping an unrecognised provider stop-code
 * to 'stop' is how truncated output gets published as if it were complete.
 */
export const FINISH_REASONS = [
  'stop',
  'length',
  'content_filter',
  'refusal',
  'tool_calls',
  'unknown',
] as const;
export type FinishReason = (typeof FINISH_REASONS)[number];

export const ERROR_CODES = [
  // client / transport
  'AUTH_MISSING',
  'AUTH_INVALID',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'VALIDATION_FAILED',
  'CREDENTIALS_IN_PAYLOAD',
  'NOT_FOUND',
  // resolution / capability
  'PROVIDER_UNKNOWN',
  'PROVIDER_NOT_CONFIGURED',
  'MODEL_REQUIRED',
  'MODEL_NOT_ALLOWED',
  'OUTPUT_FORMAT_UNSUPPORTED',
  'OPTION_UNSUPPORTED',
  'INVALID_JSON_SCHEMA',
  'FALLBACK_INVALID',
  // provider outcome
  'PROVIDER_AUTH_FAILED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_BAD_REQUEST',
  'PROVIDER_MODEL_NOT_FOUND',
  'PROVIDER_TIMEOUT',
  'OUTPUT_UNPARSEABLE',
  'OUTPUT_VALIDATION_FAILED',
  'OUTPUT_TRUNCATED',
  'MODEL_REFUSED',
  'TIMEOUT',
  // server
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Usage is normalised as an object with explicit nulls.
 * `null` means "the provider did not report this metric".
 * `0` means "the provider reported zero". The distinction is load-bearing.
 */
export interface NormalizedUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
}

export const EMPTY_USAGE: NormalizedUsage = {
  input_tokens: null,
  output_tokens: null,
  total_tokens: null,
  cached_input_tokens: null,
  reasoning_tokens: null,
};

export type WarningCode =
  | 'OPTION_IGNORED'
  | 'OPTION_CLAMPED'
  | 'OPTION_DEFAULTED'
  | 'SCHEMA_KEYWORD_DROPPED'
  | 'SCHEMA_MODIFIED'
  | 'FALLBACK_USED';

export interface Warning {
  code: WarningCode;
  message: string;
  field?: string;
}
