/**
 * Structural limits. These are properties of the service, not of a deployment,
 * so they live in code rather than environment variables.
 */
export const LIMITS = {
  maxInstructionsChars: 16_000,
  maxContentChars: 200_000,
  maxContextChars: 100_000,
  maxContextDepth: 8,
  maxContextKeys: 2_000,
  maxSchemaBytes: 64 * 1024,
  maxSchemaDepth: 16,
  /** Hard ceiling on a single request's max_output_tokens, regardless of provider. */
  maxOutputTokens: 32_000,
  minTimeoutMs: 1_000,
  maxRequestIdLength: 64,
} as const;
