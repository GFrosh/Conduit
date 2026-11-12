import OpenAI from 'openai';
import { AppError } from '../../core/errors/AppError.js';
import { EMPTY_USAGE } from '../../contracts/common.js';
import type { FinishReason, NormalizedUsage, Warning } from '../../contracts/common.js';
import type {
  GenerationRequest,
  GenerationResponse,
  ProviderCapabilities,
} from '../../contracts/generation.js';
import type { ProviderAdapter } from '../../contracts/provider.js';
import {
  mapStatus,
  readHeaders,
  readMessage,
  readStatus,
  toProviderError,
} from '../shared/error-mapping.js';
import { closeSchemaForStrict } from '../shared/schema-shaping.js';

export interface OpenAIAdapterConfig {
  apiKey: string;
  maxOutputTokens: number;
  /** Injectable for tests; production passes a real client. */
  client?: Pick<OpenAI, 'responses'>;
}

/**
 * Declared from the SDK surface actually used here, not from guesswork about
 * per-model limits. Numeric ceilings come from deployment config.
 */
/**
 * Declared from the SDK surface actually used here, not from guesses about
 * per-model limits. Numeric ceilings come from deployment configuration.
 */
export const OPENAI_TRAITS = {
  structuredOutput: 'json_schema',
  supportsSystemChannel: true,
  temperature: true,
  topP: true,
  jsonNative: true,
  promptCaching: true,
  streaming: false,
  requiresMaxTokens: false,
} as const;

function normalizeUsage(usage: OpenAI.Responses.ResponseUsage | undefined | null): NormalizedUsage {
  if (!usage) return EMPTY_USAGE;
  return {
    input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
    output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
    total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : null,
    cached_input_tokens:
      typeof usage.input_tokens_details?.cached_tokens === 'number'
        ? usage.input_tokens_details.cached_tokens
        : null,
    reasoning_tokens:
      typeof usage.output_tokens_details?.reasoning_tokens === 'number'
        ? usage.output_tokens_details.reasoning_tokens
        : null,
  };
}

/**
 * Maps the Responses API's status/incomplete_details pair. OpenAI does not use a
 * single stop_reason field: a truncated response is `status: 'incomplete'` with
 * an explicit reason, and a refusal is an output item of type 'refusal'.
 */
export function mapOpenAIStopReason(response: {
  status?: string | null;
  incomplete_details?: { reason?: string | null } | null;
  output?: ReadonlyArray<{ type?: string }> | null;
}): FinishReason {
  const hasRefusal = (response.output ?? []).some((item) => item.type === 'refusal');
  if (hasRefusal) return 'refusal';

  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason;
    if (reason === 'max_output_tokens' || reason === 'max_messages' || reason === 'steered') {
      return reason === 'steered' ? 'unknown' : 'length';
    }
    if (reason === 'content_filter') return 'content_filter';
    return 'unknown';
  }
  if (response.status === 'completed') return 'stop';
  if (response.status === 'failed' || response.status === 'cancelled') return 'unknown';
  return 'unknown';
}

export function createOpenAIAdapter(config: OpenAIAdapterConfig): ProviderAdapter {
  const client =
    config.client ??
    new OpenAI({
      apiKey: config.apiKey,
      // Retries live in core with one shared budget; the SDK must not add its own.
      maxRetries: 0,
    });

  const capabilities: ProviderCapabilities = {
    ...OPENAI_TRAITS,
    supportedOptions: ['temperature', 'top_p', 'max_output_tokens'],
    unenforcedSchemaKeywords: [],
    needsClosedSchemas: true,
    maxSchemaBytes: 64 * 1024,
    maxOutputTokens: config.maxOutputTokens,
  };

  return {
    id: 'openai',
    capabilities,

    async generate(request: GenerationRequest, signal: AbortSignal): Promise<GenerationResponse> {
      const warnings: Warning[] = [];

      // Already out of budget: do not spend a provider call we know is void.
      if (signal.aborted) throw new AppError('PROVIDER_TIMEOUT');

      let textFormat: OpenAI.Responses.ResponseFormatTextJSONSchemaConfig | undefined;
      if (request.output.kind === 'json') {
        const { schema, modified } = closeSchemaForStrict(request.output.schema);
        if (modified) {
          warnings.push({
            code: 'SCHEMA_MODIFIED',
            field: 'output.schema',
            message:
              "The schema was closed for OpenAI strict mode (additionalProperties:false and every property marked required). Your original schema is still what the response is validated against.",
          });
        }
        textFormat = {
          type: 'json_schema',
          name: request.output.schemaName ?? 'structured_output',
          schema,
          strict: true,
        };
      }

      try {
        const response = await client.responses.create(
          {
            model: request.model,
            instructions: request.prompt.system,
            input: request.prompt.user,
            ...(request.options.maxOutputTokens !== undefined
              ? { max_output_tokens: request.options.maxOutputTokens }
              : {}),
            ...(request.options.temperature !== undefined
              ? { temperature: request.options.temperature }
              : {}),
            ...(request.options.topP !== undefined ? { top_p: request.options.topP } : {}),
            ...(textFormat ? { text: { format: textFormat } } : {}),
          },
          { signal },
        );

        return {
          text: typeof response.output_text === 'string' ? response.output_text : '',
          finishReason: mapOpenAIStopReason(response),
          usage: normalizeUsage(response.usage),
          providerRequestId: response.id ?? null,
          modelEcho: response.model ?? request.model,
          warnings,
        };
      } catch (error) {
        if (signal.aborted) throw new AppError('PROVIDER_TIMEOUT', undefined, { cause: error });
        throw toProviderError(mapStatus(readStatus(error), readMessage(error), readHeaders(error)), error);
      }
    },
  };
}
