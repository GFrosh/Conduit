import Anthropic from '@anthropic-ai/sdk';
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
  readHeaders,
  readMessage,
  readStatus,
  mapStatus,
  toProviderError,
} from '../shared/error-mapping.js';

type AnthropicClient = Pick<InstanceType<typeof Anthropic>, 'messages'>;

export interface AnthropicAdapterConfig {
  apiKey: string;
  defaultMaxTokens: number;
  client?: AnthropicClient;
}

/**
 * Anthropic-specific translation notes (verified against @anthropic-ai/sdk 1.8):
 *  - `max_tokens` is REQUIRED on every request; the adapter defaults it.
 *  - there is no `total_tokens`; summing input+output would disagree with billing
 *    once cache reads are involved, so the field stays null.
 *  - truncation is `stop_reason: 'max_tokens'`; refusals arrive with HTTP 200 as
 *    `stop_reason: 'refusal'`, so status alone is never a success signal.
 *  - structured output is `output_config.format` (JSONOutputFormat), not a
 *    `response_format` or `text.format` field.
 */
export function mapAnthropicStopReason(stopReason: string | null | undefined): FinishReason {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
    case null:
    case undefined:
      return 'unknown';
    default:
      return 'unknown';
  }
}

function normalizeUsage(usage: Anthropic.Messages.Usage | undefined | null): NormalizedUsage {
  if (!usage) return EMPTY_USAGE;
  return {
    input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
    output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
    // Anthropic reports no total. Not estimated, deliberately.
    total_tokens: null,
    cached_input_tokens:
      typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : null,
    reasoning_tokens: null,
  };
}

export function createAnthropicAdapter(config: AnthropicAdapterConfig): ProviderAdapter {
  const client = config.client ?? new Anthropic({ apiKey: config.apiKey, maxRetries: 0 });

  const capabilities: ProviderCapabilities = {
    structuredOutput: 'json_schema',
    supportedOptions: ['temperature', 'top_p', 'max_output_tokens'],
    unenforcedSchemaKeywords: [],
    // Anthropic performs required-before-optional reordering in its helpers; we
    // send the schema as supplied and let post-hoc validation be authoritative.
    needsClosedSchemas: false,
    maxSchemaBytes: 64 * 1024,
    maxOutputTokens: config.defaultMaxTokens,
    supportsSystemChannel: true,
    temperature: true,
    topP: true,
    jsonNative: true,
    promptCaching: true,
    streaming: false,
    requiresMaxTokens: true,
  };

  return {
    id: 'anthropic',
    capabilities,

    async generate(request: GenerationRequest, signal: AbortSignal): Promise<GenerationResponse> {
      const warnings: Warning[] = [];

      // Already out of budget: do not spend a provider call we know is void.
      if (signal.aborted) throw new AppError('PROVIDER_TIMEOUT');

      let maxTokens = request.options.maxOutputTokens;
      if (maxTokens === undefined) {
        maxTokens = Math.min(capabilities.maxOutputTokens, config.defaultMaxTokens);
        warnings.push({
          code: 'OPTION_DEFAULTED',
          field: 'max_output_tokens',
          message: `Anthropic requires max_tokens on every request; it was set to ${maxTokens}.`,
        });
      }

      try {
        const message = await client.messages.create(
          {
            model: request.model,
            max_tokens: maxTokens,
            system: request.prompt.system,
            messages: [{ role: 'user', content: request.prompt.user }],
            ...(request.options.temperature !== undefined
              ? { temperature: request.options.temperature }
              : {}),
            ...(request.options.topP !== undefined ? { top_p: request.options.topP } : {}),
            ...(request.output.kind === 'json'
              ? {
                  output_config: {
                    format: { type: 'json_schema' as const, schema: request.output.schema },
                  },
                }
              : {}),
          },
          { signal },
        );

        const text = message.content
          .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');

        return {
          text,
          finishReason: mapAnthropicStopReason(message.stop_reason),
          usage: normalizeUsage(message.usage),
          providerRequestId: message.id ?? null,
          modelEcho: message.model ?? request.model,
          warnings,
        };
      } catch (error) {
        if (signal.aborted) throw new AppError('PROVIDER_TIMEOUT', undefined, { cause: error });
        throw toProviderError(mapStatus(readStatus(error), readMessage(error), readHeaders(error)), error);
      }
    },
  };
}
