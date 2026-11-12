import { describe, expect, it } from 'vitest';
import { createOpenAIAdapter } from '../../../src/providers/openai/adapter.js';
import { createAnthropicAdapter } from '../../../src/providers/anthropic/adapter.js';
import { createGeminiAdapter } from '../../../src/providers/gemini/adapter.js';
import { createOrchestrator } from '../../../src/core/process/orchestrator.js';
import { createProviderRegistry } from '../../../src/providers/registry.js';
import { createSchemaValidator } from '../../../src/core/validation/schema-validator.js';
import { AppError } from '../../../src/core/errors/AppError.js';
import { jsonRequest, generationRequest, FakeSdkError } from '../../helpers/provider-fixtures.js';
import type { ProviderAdapter } from '../../../src/contracts/provider.js';

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: { title: { type: 'string' } },
} as const;

/** Counts SDK calls so "no internal retry" is observable, not assumed. */
function countingOpenAI(text: string) {
  const calls: unknown[] = [];
  const adapter = createOpenAIAdapter({
    apiKey: 'sk-test-not-real',
    maxOutputTokens: 1024,
    client: {
      responses: {
        create: async (body: unknown) => {
          calls.push(body);
          return { output_text: text, status: 'completed', output: [{ type: 'message' }], usage: null, id: 'r', model: 'm' };
        },
      },
    } as never,
  });
  return { adapter, calls };
}

function countingAnthropic(text: string) {
  const calls: unknown[] = [];
  const adapter = createAnthropicAdapter({
    apiKey: 'sk-ant-test-not-real',
    defaultMaxTokens: 512,
    client: {
      messages: {
        create: async (body: unknown) => {
          calls.push(body);
          return { id: 'msg', model: 'm', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    } as never,
  });
  return { adapter, calls };
}

function countingGemini(text: string) {
  const calls: unknown[] = [];
  const adapter = createGeminiAdapter({
    apiKey: 'test-not-real',
    maxOutputTokens: 512,
    client: {
      models: {
        generateContent: async (body: unknown) => {
          calls.push(body);
          return {
            text,
            candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
            responseId: 'g',
            modelVersion: 'm',
          };
        },
      },
    } as never,
  });
  return { adapter, calls };
}

function orchestratorFor(adapter: ProviderAdapter) {
  const registry = createProviderRegistry();
  registry.register(adapter);
  return createOrchestrator({
    registry,
    resolution: {
      defaultProvider: 'openai',
      providers: { openai: {}, anthropic: {}, gemini: {} },
    },
    schemaValidator: createSchemaValidator(),
    defaultTimeoutMs: 5_000,
    serviceVersion: 'test',
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, minAttemptMs: 1 },
  });
}

describe('no adapter retries internally', () => {
  it('attempts each provider exactly once per generate() call', async () => {
    const openai = countingOpenAI('{"title":"a"}');
    const anthropic = countingAnthropic('{"title":"a"}');
    const gemini = countingGemini('{"title":"a"}');

    await openai.adapter.generate(jsonRequest(schema), new AbortController().signal);
    await anthropic.adapter.generate(jsonRequest(schema), new AbortController().signal);
    await gemini.adapter.generate(jsonRequest(schema), new AbortController().signal);

    expect(openai.calls).toHaveLength(1);
    expect(anthropic.calls).toHaveLength(1);
    expect(gemini.calls).toHaveLength(1);
  });
});

describe('structured output is never silently repaired', () => {
  const adapters = [
    ['openai', countingOpenAI],
    ['anthropic', countingAnthropic],
    ['gemini', countingGemini],
  ] as const;

  it.each(adapters)(
    '%s: rejects markdown-fenced JSON instead of stripping the fence',
    async (id, make) => {
      const { adapter } = make('```json\n{"title":"a"}\n```');
      const orchestrator = orchestratorFor(adapter);
      await expect(
        orchestrator.process({
          request: {
            ...jsonRequest(schema),
            provider: id,
            instructions: 'x',
            content: { type: 'text', text: 'y' },
          } as never,
          requestId: `req_fence_${id}`,
        }),
      ).rejects.toMatchObject({ code: 'OUTPUT_UNPARSEABLE' });
    },
  );

  it.each(adapters)(
    '%s: rejects JSON that violates the requested schema',
    async (id, make) => {
      const { adapter } = make('{"headline":"wrong key"}');
      const orchestrator = orchestratorFor(adapter);
      await expect(
        orchestrator.process({
          request: {
            ...jsonRequest(schema),
            provider: id,
            instructions: 'x',
            content: { type: 'text', text: 'y' },
          } as never,
          requestId: `req_schema_${id}`,
        }),
      ).rejects.toMatchObject({ code: 'OUTPUT_VALIDATION_FAILED' });
    },
  );
});

describe('provider faults surface as normalized provider errors, never INTERNAL', () => {
  it('maps an unexpected thrown value to a provider error', async () => {
    const adapter = createOpenAIAdapter({
      apiKey: 'sk-test-not-real',
      maxOutputTokens: 256,
      client: {
        responses: {
          create: async () => {
            throw new Error('socket hang up');
          },
        },
      } as never,
    });
    await expect(adapter.generate(generationRequest(), new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('turns a pre-aborted signal into PROVIDER_TIMEOUT without calling the SDK', async () => {
    let called = false;
    const adapter = createAnthropicAdapter({
      apiKey: 'sk-ant-test-not-real',
      defaultMaxTokens: 256,
      client: {
        messages: {
          create: async () => {
            called = true;
            throw new Error('should not be reached');
          },
        },
      } as never,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.generate(generationRequest(), controller.signal)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
    expect(called).toBe(false);
  });

  it('keeps the provider message out of the public error surface', async () => {
    const adapter = createGeminiAdapter({
      apiKey: 'test-not-real',
      maxOutputTokens: 256,
      client: {
        models: {
          generateContent: async () => {
            throw new FakeSdkError(400, 'API key not valid. Please pass a valid API key.');
          },
        },
      } as never,
    });
    const error = (await adapter.generate(generationRequest(), new AbortController().signal).catch((e: AppError) => e)) as AppError;
    expect(error.code).toBe('PROVIDER_BAD_REQUEST');
    expect(error.message).not.toContain('API key not valid');
    expect(JSON.stringify(error)).not.toContain('stack');
  });
});
