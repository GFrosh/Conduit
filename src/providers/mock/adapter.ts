import { AppError } from '../../core/errors/AppError.js';
import { EMPTY_USAGE, type ProviderId } from '../../contracts/common.js';
import type {
  GenerationRequest,
  GenerationResponse,
  ProviderCapabilities,
} from '../../contracts/generation.js';
import type { ProviderAdapter } from '../../contracts/provider.js';

export interface MockRespondContext {
  request: GenerationRequest;
}

export type MockResponder = (context: MockRespondContext) => GenerationResponse | Promise<GenerationResponse>;

export interface MockAdapterOptions {
  id: ProviderId;
  capabilities?: Partial<ProviderCapabilities>;
  /** Overrides the deterministic default answer. */
  respond?: MockResponder;
  /** Artificial latency, to exercise deadlines. Honours the abort signal. */
  latencyMs?: number;
}

/** Deterministic, provider-neutral defaults. No network, no SDK, no cost. */
export const DEFAULT_MOCK_CAPABILITIES: ProviderCapabilities = {
  structuredOutput: 'json_schema_strict',
  supportedOptions: ['temperature', 'top_p', 'max_output_tokens'],
  unenforcedSchemaKeywords: [],
  needsClosedSchemas: true,
  maxSchemaBytes: 64 * 1024,
  maxOutputTokens: 16_384,
  supportsSystemChannel: true,
};

export const MOCK_USAGE = {
  ...EMPTY_USAGE,
  input_tokens: 11,
  output_tokens: 7,
  total_tokens: 18,
};

function defaultResponse(request: GenerationRequest): GenerationResponse {
  const text =
    request.output.kind === 'json'
      ? JSON.stringify({ mock: true, provider: request.provider, model: request.model })
      : `Mock response from ${request.provider} (${request.model}).`;

  return {
    text,
    finishReason: 'stop',
    usage: MOCK_USAGE,
    providerRequestId: `mock_${request.requestId}`,
    modelEcho: request.model,
    warnings: [],
  };
}

export interface MockProviderAdapter extends ProviderAdapter {
  readonly calls: GenerationRequest[];
  readonly signals: AbortSignal[];
}

export function createMockProviderAdapter(options: MockAdapterOptions): MockProviderAdapter {
  const calls: GenerationRequest[] = [];
  const signals: AbortSignal[] = [];
  const capabilities: ProviderCapabilities = {
    ...DEFAULT_MOCK_CAPABILITIES,
    ...options.capabilities,
  };

  return {
    id: options.id,
    capabilities,
    calls,
    signals,
    async generate(request, signal) {
      calls.push(request);
      signals.push(signal);

      if (options.latencyMs && options.latencyMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            resolve();
          }, options.latencyMs);
          const onAbort = (): void => {
            cleanup();
            reject(new AppError('PROVIDER_TIMEOUT'));
          };
          const cleanup = (): void => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }

      if (signal.aborted) throw new AppError('PROVIDER_TIMEOUT');

      return options.respond ? options.respond({ request }) : defaultResponse(request);
    },
  };
}
