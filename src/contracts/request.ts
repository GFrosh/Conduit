import { z } from 'zod';
import { LIMITS } from '../config/limits.js';
import { PROVIDER_IDS, type JsonValue } from './common.js';

/** Recursive JSON value schema. Context may be a string or arbitrary JSON. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonSchemaObjectSchema = z.record(z.string(), z.unknown());

export const contentInputSchema = z
  .object({
    type: z.literal('text'),
    text: z.string().min(1).max(LIMITS.maxContentChars),
  })
  .strict();

export const contextInputSchema = z.union([
  z.string().max(LIMITS.maxContextChars),
  z.record(z.string(), jsonValueSchema),
]);

export const outputConfigSchema = z.discriminatedUnion('format', [
  z.object({ format: z.literal('text') }).strict(),
  z.object({ format: z.literal('markdown') }).strict(),
  z
    .object({
      format: z.literal('json'),
      schema: jsonSchemaObjectSchema,
      schema_name: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,64}$/)
        .optional(),
      validate: z.boolean().default(true),
    })
    .strict(),
]);

export const generationOptionsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_output_tokens: z.number().int().min(1).max(LIMITS.maxOutputTokens).optional(),
    timeout_ms: z.number().int().min(LIMITS.minTimeoutMs).max(600_000).optional(),
    /** How to treat an option the resolved provider cannot honour. */
    on_unsupported_option: z.enum(['reject', 'ignore']).default('reject'),
  })
  .strict();

export const fallbackPolicySchema = z
  .object({
    enabled: z.literal(true),
    providers: z
      .array(z.enum(PROVIDER_IDS))
      .min(1)
      .max(2)
      .refine((list) => new Set(list).size === list.length, 'providers must be unique'),
    // partialRecord: only the overrides actually supplied must be present.
    model_overrides: z
      .partialRecord(z.enum(PROVIDER_IDS), z.string().min(1).max(200))
      .optional(),
    on: z.array(z.string()).optional(),
  })
  .strict();

/**
 * `.strict()` on every object is intentional: it is the enforcement point for
 * "credentials are never accepted in a request payload". A body carrying
 * `apiKey` fails validation instead of being silently ignored.
 */
export const processingRequestSchema = z
  .object({
    /**
     * Kept as a string, not z.enum(PROVIDER_IDS), so an unknown provider yields
     * the domain error PROVIDER_UNKNOWN (400) with the known list attached,
     * rather than a generic VALIDATION_FAILED. Resolution owns this decision.
     */
    provider: z.string().min(1).max(64).optional(),
    model: z.string().min(1).max(200).optional(),
    instructions: z.string().min(1).max(LIMITS.maxInstructionsChars),
    context: contextInputSchema.optional(),
    content: contentInputSchema,
    output: outputConfigSchema.default({ format: 'text' }),
    options: generationOptionsSchema.optional(),
    fallback: fallbackPolicySchema.optional(),
    metadata: z
      .object({ client_request_id: z.string().max(128).optional() })
      .strict()
      .optional(),
  })
  .strict();

export type ContentInput = z.infer<typeof contentInputSchema>;
export type ContextInput = z.infer<typeof contextInputSchema>;
export type OutputConfig = z.infer<typeof outputConfigSchema>;
export type GenerationOptions = z.infer<typeof generationOptionsSchema>;
export type FallbackPolicy = z.infer<typeof fallbackPolicySchema>;
export type ProcessingRequest = z.infer<typeof processingRequestSchema>;
