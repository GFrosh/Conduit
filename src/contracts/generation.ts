import type {
  FinishReason,
  JsonSchemaObject,
  NormalizedUsage,
  ProviderId,
  Warning,
} from './common.js';

/**
 * Two channels, never merged:
 *  - `system` carries task instructions plus the service's channel policy.
 *  - `user` carries context and content, delimited and treated as untrusted data.
 */
export interface PromptPlan {
  system: string;
  user: string;
}

/**
 * How a provider can be asked for structured output, in decreasing order of
 * strength. Prompt-only is a real capability state, not an error.
 */
export type StructuredOutputMode =
  | 'json_schema_strict'
  | 'json_schema'
  | 'json_object'
  | 'prompt_only';

export interface ProviderCapabilities {
  readonly structuredOutput: StructuredOutputMode;
  readonly supportedOptions: readonly ('temperature' | 'top_p' | 'max_output_tokens')[];
  /** Keywords this provider silently ignores; surfaced to the client as warnings. */
  readonly unenforcedSchemaKeywords: readonly string[];
  /** True when the provider requires additionalProperties:false / fully-required objects. */
  readonly needsClosedSchemas: boolean;
  readonly maxSchemaBytes: number;
  readonly maxOutputTokens: number;
  readonly supportsSystemChannel: boolean;
  /** Informational traits, surfaced by GET /v1/providers. Optional by design. */
  readonly temperature?: boolean;
  readonly topP?: boolean;
  readonly tools?: boolean;
  readonly jsonNative?: boolean;
  readonly promptCaching?: boolean;
  readonly streaming?: boolean;
  readonly reasoningControls?: boolean;
  /** True when the provider REQUIRES max_tokens on every request. */
  readonly requiresMaxTokens?: boolean;
}

export type GenerationOutput =
  | { kind: 'text'; format: 'text' | 'markdown' }
  | {
      kind: 'json';
      schema: JsonSchemaObject;
      schemaName?: string;
      validate: boolean;
    };

export interface NormalizedGenerationOptions {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
}

/** The provider-neutral request. No SDK type may appear here. */
export interface GenerationRequest {
  provider: ProviderId;
  model: string;
  prompt: PromptPlan;
  output: GenerationOutput;
  options: NormalizedGenerationOptions;
  /** Epoch ms by which the provider call must have settled. */
  deadlineAt: number;
  /** Deterministic nonce used to delimit untrusted payloads. */
  requestId: string;
}

/** The provider-neutral response. Adapters return raw text; core parses it. */
export interface GenerationResponse {
  text: string;
  finishReason: FinishReason;
  usage: NormalizedUsage;
  providerRequestId: string | null;
  /** What the provider says it actually ran; may differ from the requested model. */
  modelEcho: string;
  warnings: Warning[];
}
