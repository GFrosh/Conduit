import { describe, expect, it } from 'vitest';
import { createOpenAIAdapter } from '../../../src/providers/openai/adapter.js';
import { createAnthropicAdapter } from '../../../src/providers/anthropic/adapter.js';
import { createGeminiAdapter } from '../../../src/providers/gemini/adapter.js';
import { createProviderRegistry } from '../../../src/providers/registry.js';
import { createOrchestrator } from '../../../src/core/process/orchestrator.js';
import { createSchemaValidator } from '../../../src/core/validation/schema-validator.js';
import { AppError } from '../../../src/core/errors/AppError.js';
import { FakeSdkError } from '../../helpers/provider-fixtures.js';
import type { ProcessingRequest } from '../../../src/contracts/request.js';
import type { ProviderAdapter } from '../../../src/contracts/provider.js';

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'tags'],
  properties: {
    title: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * Three adapters, three different wire formats, one identical answer. The point
 * of this suite is that EVERYTHING below `ProviderAdapter.generate` is shared:
 * the same orchestrator instance, the same request, the same assertions.
 */
function adapters(answer: { text: string }, options: { status?: number } = {}): ProviderAdapter[] {
  const fail = (): never => {
    throw new FakeSdkError(options.status ?? 500, 'provider exploded');
  };

  return [
    createOpenAIAdapter({
      apiKey: 'sk-test-not-real',
      maxOutputTokens: 1024,
      client: {
        responses: {
          create: async () =>
            options.status
              ? fail()
              : {
                  output_text: answer.text,
                  status: 'completed',
                  output: [{ type: 'message' }],
                  usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
                  id: 'resp_parity',
                  model: 'echo-model',
                },
        },
      } as never,
    }),
    createAnthropicAdapter({
      apiKey: 'sk-ant-test-not-real',
      defaultMaxTokens: 1024,
      client: {
        messages: {
          create: async () =>
            options.status
              ? fail()
              : {
                  id: 'msg_parity',
                  model: 'echo-model',
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'text', text: answer.text }],
                  stop_reason: 'end_turn',
                  usage: { input_tokens: 12, output_tokens: 8 },
                },
        },
      } as never,
    }),
    createGeminiAdapter({
      apiKey: 'test-not-real',
      maxOutputTokens: 1024,
      client: {
        models: {
          generateContent: async () =>
            options.status
              ? fail()
              : {
                  candidates: [
                    { content: { parts: [{ text: answer.text }], role: 'model' }, finishReason: 'STOP' },
                  ],
                  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
                  responseId: 'gem_parity',
                  modelVersion: 'echo-model',
                },
        },
      } as never,
    }),
  ];
}

function orchestratorWith(list: ProviderAdapter[]) {
  const registry = createProviderRegistry();
  for (const adapter of list) registry.register(adapter);
  return createOrchestrator({
    registry,
    resolution: {
      defaultProvider: 'openai',
      providers: { openai: {}, anthropic: {}, gemini: {} },
    },
    schemaValidator: createSchemaValidator(),
    defaultTimeoutMs: 5_000,
    serviceVersion: 'test',
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, minAttemptMs: 1 },
  });
}

const PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;

function requestFor(
  provider: string,
  output?: NonNullable<ProcessingRequest['output']>,
): ProcessingRequest & { output: NonNullable<ProcessingRequest['output']> } {
  return {
    provider,
    model: `model-for-${provider}`,
    instructions: 'Summarise the article.',
    content: { type: 'text', text: 'An article body.' },
    output: output ?? { format: 'text' },
  };
}

describe('the same request runs through all three providers unchanged', () => {
  it('returns an identical response contract for text output', async () => {
    const orchestrator = orchestratorWith(adapters({ text: 'A summary.' }));

    const responses = [];
    for (const provider of PROVIDERS) {
      responses.push(await orchestrator.process({ request: requestFor(provider), requestId: `req_${provider}` }));
    }

    const shapes = responses.map((response) => Object.keys(response).sort());
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);

    const metaShapes = responses.map((response) => Object.keys(response.meta).sort());
    expect(metaShapes[1]).toEqual(metaShapes[0]);
    expect(metaShapes[2]).toEqual(metaShapes[0]);

    for (const response of responses) {
      expect(response.success).toBe(true);
      expect(response.result).toEqual({ type: 'text', text: 'A summary.' });
      expect(response.model).toBe('echo-model');
      expect(response.usage.input_tokens).toBe(12);
      expect(response.usage.output_tokens).toBe(8);
      expect(typeof response.duration_ms).toBe('number');
      expect(response.meta.finish_reason).toBe('stop');
    }

    // The provider label is the ONLY field that differs.
    expect(responses.map((response) => response.provider)).toEqual([...PROVIDERS]);
  });

  it('returns the same parsed object for JSON output on every provider', async () => {
    const payload = JSON.stringify({ title: 'Headline', tags: ['a', 'b'] });
    const orchestrator = orchestratorWith(adapters({ text: payload }));
    const output = { format: 'json' as const, schema: JSON_SCHEMA, validate: true };

    for (const provider of PROVIDERS) {
      const response = await orchestrator.process({
        request: requestFor(provider, output),
        requestId: `req_json_${provider}`,
      });
      // Parsed object, never a JSON-encoded string nested inside JSON.
      expect(response.result).toEqual({ type: 'json', data: { title: 'Headline', tags: ['a', 'b'] } });
      expect(response.meta.finish_reason).toBe('stop');
    }
  });

  it('normalizes the same underlying fault to the same error code everywhere', async () => {
    const orchestrator = orchestratorWith(adapters({ text: '' }, { status: 503 }));
    const codes: string[] = [];
    const statuses: number[] = [];

    for (const provider of PROVIDERS) {
      const error = (await orchestrator
        .process({ request: requestFor(provider), requestId: `req_err_${provider}` })
        .catch((thrown: AppError) => thrown)) as AppError;
      codes.push(error.code);
      statuses.push(error.status);
      expect(AppError.isAppError(error)).toBe(true);
    }

    expect(codes).toEqual(['PROVIDER_UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'PROVIDER_UNAVAILABLE']);
    // 503 from the status map: the provider is unavailable, not the request
    expect(statuses).toEqual([503, 503, 503]);
  });

  it('keeps provider selection explicit: no request silently lands elsewhere', async () => {
    const orchestrator = orchestratorWith(adapters({ text: 'ok' }));
    const response = await orchestrator.process({ request: requestFor('gemini'), requestId: 'req_explicit' });
    expect(response.provider).toBe('gemini');
    expect(response.meta.fallback_used).toBe(false);
  });
});
