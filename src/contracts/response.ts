import { z } from 'zod';
import {
  EMPTY_USAGE,
  ERROR_CODES,
  FINISH_REASONS,
  PROVIDER_IDS,
  type ErrorCode,
  type NormalizedUsage,
} from './common.js';
import type { JsonValue } from './common.js';

export const normalizedUsageSchema = z.object({
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  total_tokens: z.number().int().nullable(),
  cached_input_tokens: z.number().int().nullable(),
  reasoning_tokens: z.number().int().nullable(),
});

export const warningSchema = z.object({
  code: z.enum([
    'OPTION_IGNORED',
    'OPTION_CLAMPED',
    'OPTION_DEFAULTED',
    'SCHEMA_KEYWORD_DROPPED',
    'FALLBACK_USED',
    'SCHEMA_MODIFIED',
  ]),
  message: z.string(),
  field: z.string().optional(),
});

/**
 * `result` is a discriminated union, not a string. For JSON output, `data` is
 * the parsed object itself — never a JSON-encoded string nested in JSON.
 */
export const processResultSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('markdown'), text: z.string() }),
  z.object({ type: z.literal('json'), data: z.unknown() }),
]);

export const attemptSummarySchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  model: z.string(),
  outcome: z.enum(['success', 'failed', 'skipped']),
  error_code: z.enum(ERROR_CODES).optional(),
  duration_ms: z.number().int().nonnegative(),
});

export const processingSuccessResponseSchema = z.object({
  success: z.literal(true),
  request_id: z.string(),
  provider: z.enum(PROVIDER_IDS),
  model: z.string(),
  result: processResultSchema,
  usage: normalizedUsageSchema,
  duration_ms: z.number().int().nonnegative(),
  meta: z.object({
    finish_reason: z.enum(FINISH_REASONS),
    fallback_used: z.boolean(),
    attempts: z.array(attemptSummarySchema),
    warnings: z.array(warningSchema),
    provider_request_id: z.string().nullable(),
    client_request_id: z.string().optional(),
    service_version: z.string(),
    timings: z.object({
      provider_ms: z.number().int().nonnegative(),
      validation_ms: z.number().int().nonnegative().nullable(),
    }),
  }),
});

export const processingErrorResponseSchema = z.object({
  success: z.literal(false),
  request_id: z.string(),
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    retryable: z.boolean(),
    details: z.unknown().optional(),
    attempted: z
      .array(
        z.object({
          provider: z.enum(PROVIDER_IDS),
          model: z.string(),
          code: z.enum(ERROR_CODES),
        }),
      )
      .optional(),
  }),
});

export type ProcessResult = z.infer<typeof processResultSchema>;
export type AttemptSummary = z.infer<typeof attemptSummarySchema>;
export type ProcessingSuccessResponse = z.infer<typeof processingSuccessResponseSchema>;
export type ProcessingErrorResponse = z.infer<typeof processingErrorResponseSchema>;
export type ProcessingResponse = ProcessingSuccessResponse | ProcessingErrorResponse;

export type { ErrorCode, NormalizedUsage, JsonValue };
export { EMPTY_USAGE };
