import { GoogleGenAI, FinishReason as GeminiFinishReason } from '@google/genai';
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
import {
  GEMINI_UNSUPPORTED_KEYWORDS,
  shapeSchemaForGemini,
  shapingWarnings,
} from '../shared/schema-shaping.js';

interface GeminiClient {
  models: {
    generateContent: (params: {
      model: string;
      contents: unknown;
      config?: Record<string, unknown>;
    }) => Promise<GeminiRawResponse>;
  };
}

interface GeminiRawResponse {
  text?: string;
  candidates?: ReadonlyArray<{
    content?: { parts?: ReadonlyArray<{ text?: string }> };
    finishReason?: string;
    finishMessage?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  responseId?: string;
  modelVersion?: string;
}

export interface GeminiAdapterConfig {
  apiKey: string;
  maxOutputTokens: number;
  client?: GeminiClient;
}

/**
 * Gemini translation notes (verified against @google/genai 3.1):
 *  - the system channel is `config.systemInstruction`, not a message role;
 *  - generation settings live under `config` (`maxOutputTokens`, `topP`);
 *  - structured output uses `responseMimeType: 'application/json'` plus
 *    `responseSchema`, which accepts only a JSON-Schema SUBSET. Unsupported
 *    keywords are stripped and reported rather than silently ignored;
 *  - a prompt-level block arrives as `promptFeedback.blockReason` with NO
 *    candidates, so an empty candidate list is not necessarily a transport error;
 *  - usage is `promptTokenCount` / `candidatesTokenCount` / `totalTokenCount`.
 */
export function mapGeminiFinishReason(
  finishReason: string | undefined,
  blockReason: string | undefined,
): FinishReason {
  if (blockReason) return 'content_filter';
  switch (finishReason) {
    case GeminiFinishReason.STOP:
      return 'stop';
    case GeminiFinishReason.MAX_TOKENS:
      return 'length';
    case GeminiFinishReason.SAFETY:
    case GeminiFinishReason.PROHIBITED_CONTENT:
    case GeminiFinishReason.BLOCKLIST:
    case GeminiFinishReason.SPII:
    case GeminiFinishReason.IMAGE_SAFETY:
    case GeminiFinishReason.RECITATION:
      return 'content_filter';
    case GeminiFinishReason.MALFORMED_FUNCTION_CALL:
      return 'tool_calls';
    case GeminiFinishReason.FINISH_REASON_UNSPECIFIED:
    case GeminiFinishReason.OTHER:
    case undefined:
      return 'unknown';
    default:
      return 'unknown';
  }
}

function normalizeUsage(usage: GeminiRawResponse['usageMetadata']): NormalizedUsage {
  if (!usage) return EMPTY_USAGE;
  return {
    input_tokens: typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : null,
    output_tokens: typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : null,
    total_tokens: typeof usage.totalTokenCount === 'number' ? usage.totalTokenCount : null,
    cached_input_tokens:
      typeof usage.cachedContentTokenCount === 'number' ? usage.cachedContentTokenCount : null,
    reasoning_tokens: typeof usage.thoughtsTokenCount === 'number' ? usage.thoughtsTokenCount : null,
  };
}

function extractText(response: GeminiRawResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const fromParts = parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
  if (fromParts.length > 0) return fromParts;
  return typeof response.text === 'string' ? response.text : '';
}

export function createGeminiAdapter(config: GeminiAdapterConfig): ProviderAdapter {
  const client: GeminiClient =
    config.client ??
    (new GoogleGenAI({ apiKey: config.apiKey }) as unknown as GeminiClient);

  const capabilities: ProviderCapabilities = {
    structuredOutput: 'json_schema',
    supportedOptions: ['temperature', 'top_p', 'max_output_tokens'],
    unenforcedSchemaKeywords: [...GEMINI_UNSUPPORTED_KEYWORDS],
    needsClosedSchemas: false,
    maxSchemaBytes: 64 * 1024,
    maxOutputTokens: config.maxOutputTokens,
    supportsSystemChannel: true,
    temperature: true,
    topP: true,
    jsonNative: true,
    promptCaching: true,
    streaming: false,
    requiresMaxTokens: false,
  };

  return {
    id: 'gemini',
    capabilities,

    async generate(request: GenerationRequest, signal: AbortSignal): Promise<GenerationResponse> {
      const warnings: Warning[] = [];

      // Already out of budget: do not spend a provider call we know is void.
      if (signal.aborted) throw new AppError('PROVIDER_TIMEOUT');

      const config_: Record<string, unknown> = {
        systemInstruction: request.prompt.system,
        abortSignal: signal,
      };
      if (request.options.maxOutputTokens !== undefined) {
        config_.maxOutputTokens = request.options.maxOutputTokens;
      }
      if (request.options.temperature !== undefined) {
        config_.temperature = request.options.temperature;
      }
      if (request.options.topP !== undefined) {
        config_.topP = request.options.topP;
      }

      if (request.output.kind === 'json') {
        const shaped = shapeGeminiOutputSchema(request.output.schema);
        if (shaped.schema) {
          config_.responseMimeType = 'application/json';
          config_.responseSchema = shaped.schema;
        } else {
          // Refs (or an unshapable schema): ask for JSON without a schema and
          // let the core's validation be authoritative.
          config_.responseMimeType = 'application/json';
          warnings.push({
            code: 'SCHEMA_MODIFIED',
            field: 'output.schema',
            message:
              'This schema uses $ref, which Gemini cannot accept as responseSchema. JSON mode was used without a schema and the response was validated by the service instead.',
          });
        }
        warnings.push(...shaped.warnings);
      }

      try {
        const response = await client.models.generateContent({
          model: request.model,
          contents: [{ role: 'user', parts: [{ text: request.prompt.user }] }],
          config: config_,
        });

        const finishReason = mapGeminiFinishReason(
          response.candidates?.[0]?.finishReason,
          response.promptFeedback?.blockReason,
        );

        return {
          text: extractText(response),
          finishReason,
          usage: normalizeUsage(response.usageMetadata),
          providerRequestId: response.responseId ?? null,
          modelEcho: response.modelVersion ?? request.model,
          warnings,
        };
      } catch (error) {
        if (signal.aborted) throw new AppError('PROVIDER_TIMEOUT', undefined, { cause: error });
        throw toProviderError(mapStatus(readStatus(error), readMessage(error), readHeaders(error)), error);
      }
    },
  };
}

function shapeGeminiOutputSchema(schema: Record<string, unknown>): {
  schema: Record<string, unknown> | null;
  warnings: Warning[];
} {
  const shaped = shapeSchemaForGemini(schema);
  return {
    schema: shaped.schema as Record<string, unknown> | null,
    warnings: shapingWarnings(shaped.droppedKeywords, 'gemini'),
  };
}
