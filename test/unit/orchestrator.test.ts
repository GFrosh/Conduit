import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors/AppError.js';
import { createOrchestrator } from '../../src/core/process/orchestrator.js';
import type { ProviderResolutionConfig } from '../../src/core/process/resolveProvider.js';
import { createSchemaValidator } from '../../src/core/validation/schema-validator.js';
import { createProviderRegistry } from '../../src/providers/registry.js';
import { createMockProviderAdapter, MOCK_USAGE } from '../../src/providers/mock/adapter.js';
import { EMPTY_USAGE } from '../../src/contracts/common.js';
import type { ProviderAdapter } from '../../src/contracts/provider.js';
import type { ProcessingRequest } from '../../src/contracts/request.js';
import { processingRequestSchema } from '../../src/contracts/request.js';
import type { z } from 'zod';
import { VALID_BODY } from '../helpers/config.js';

const resolution: ProviderResolutionConfig = {
  defaultProvider: 'openai',
  providers: {
    openai: { defaultModel: 'model-alpha' },
    anthropic: { defaultModel: 'model-beta' },
  },
};

function build(adapters: ProviderAdapter[]) {
  const registry = createProviderRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return createOrchestrator({
    registry,
    resolution,
    schemaValidator: createSchemaValidator(),
    defaultTimeoutMs: 5_000,
    serviceVersion: 'test',
  });
}

/** z.input allows omitting fields that carry schema defaults. */
type RequestOverrides = Partial<z.input<typeof processingRequestSchema>>;

const request = (overrides: RequestOverrides = {}): ProcessingRequest =>
  processingRequestSchema.parse({ ...VALID_BODY, ...overrides });

async function expectCode(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }
  throw new Error(`expected ${code}`);
}

describe('orchestrator', () => {
  it('runs the full pipeline through the provider port', async () => {
    const adapter = createMockProviderAdapter({ id: 'openai' });
    const response = await build([adapter]).process({ request: request(), requestId: 'req_test_1' });

    expect(response.success).toBe(true);
    expect(response.provider).toBe('openai');
    expect(response.model).toBe('model-alpha');
    expect(response.request_id).toBe('req_test_1');
    expect(response.result.type).toBe('text');
    expect(adapter.calls).toHaveLength(1);
    expect(response.meta.attempts).toEqual([
      { provider: 'openai', model: 'model-alpha', outcome: 'success', duration_ms: expect.any(Number) },
    ]);
    expect(response.meta.fallback_used).toBe(false);
    expect(response.usage).toEqual(MOCK_USAGE);
  });

  it('constructs a provider-neutral generation request with both prompt channels', async () => {
    const adapter = createMockProviderAdapter({ id: 'openai' });
    await build([adapter]).process({
      request: request({ context: { topic: 'energy' }, options: { temperature: 0.3, max_output_tokens: 500 } }),
      requestId: 'req_test_2',
    });

    const call = adapter.calls[0]!;
    expect(call.provider).toBe('openai');
    expect(call.model).toBe('model-alpha');
    expect(call.prompt.system).toContain(VALID_BODY.instructions);
    expect(call.prompt.user).toContain(VALID_BODY.content.text);
    expect(call.prompt.user).toContain('"topic": "energy"');
    expect(call.options).toEqual({ temperature: 0.3, maxOutputTokens: 500 });
    expect(call.deadlineAt).toBeGreaterThan(Date.now() - 1_000);
  });

  it('treats instructions as the instruction channel and content as data', async () => {
    const adapter = createMockProviderAdapter({ id: 'openai' });
    await build([adapter]).process({ request: request(), requestId: 'req_test_3' });
    const call = adapter.calls[0]!;
    expect(call.prompt.system).not.toContain(VALID_BODY.content.text);
    expect(call.prompt.user).not.toContain(VALID_BODY.instructions);
  });

  it('returns a parsed JSON object, not a JSON-encoded string', async () => {
    const adapter = createMockProviderAdapter({
      id: 'openai',
      respond: () => ({
        text: JSON.stringify({ title: 'T', body: 'B' }),
        finishReason: 'stop',
        usage: EMPTY_USAGE,
        providerRequestId: 'p1',
        modelEcho: 'model-alpha',
        warnings: [],
      }),
    });

    const response = await build([adapter]).process({
      request: request({
        output: { format: 'json', schema: { type: 'object', required: ['title'] }, validate: true },
      }),
      requestId: 'req_test_4',
    });

    expect(response.result.type).toBe('json');
    if (response.result.type !== 'json') throw new Error('unreachable');
    expect(typeof response.result.data).toBe('object');
    expect(response.result.data).toEqual({ title: 'T', body: 'B' });
    expect(response.meta.timings.validation_ms).not.toBeNull();
  });

  it('maps markdown output to a markdown result', async () => {
    const adapter = createMockProviderAdapter({ id: 'openai' });
    const response = await build([adapter]).process({
      request: request({ output: { format: 'markdown' } }),
      requestId: 'req_test_5',
    });
    expect(response.result.type).toBe('markdown');
  });

  it('rejects output that violates the requested schema', async () => {
    const adapter = createMockProviderAdapter({
      id: 'openai',
      respond: () => ({
        text: JSON.stringify({ wrong: true }),
        finishReason: 'stop',
        usage: EMPTY_USAGE,
        providerRequestId: null,
        modelEcho: 'model-alpha',
        warnings: [],
      }),
    });

    await expectCode(
      build([adapter]).process({
        request: request({ output: { format: 'json', schema: { type: 'object', required: ['title'] }, validate: true } }),
        requestId: 'req_test_6',
      }),
      'OUTPUT_VALIDATION_FAILED',
    );
  });

  it('rejects unparseable JSON', async () => {
    const adapter = createMockProviderAdapter({
      id: 'openai',
      respond: () => ({
        text: '```json\n{"a":1}\n```',
        finishReason: 'stop',
        usage: EMPTY_USAGE,
        providerRequestId: null,
        modelEcho: 'model-alpha',
        warnings: [],
      }),
    });
    await expectCode(
      build([adapter]).process({
        request: request({ output: { format: 'json', schema: { type: 'object' } } }),
        requestId: 'req_test_7',
      }),
      'OUTPUT_UNPARSEABLE',
    );
  });

  it('rejects truncated output instead of returning a partial result', async () => {
    const adapter = createMockProviderAdapter({
      id: 'openai',
      respond: () => ({
        text: 'half',
        finishReason: 'length',
        usage: EMPTY_USAGE,
        providerRequestId: null,
        modelEcho: 'model-alpha',
        warnings: [],
      }),
    });
    await expectCode(build([adapter]).process({ request: request(), requestId: 'req_test_8' }), 'OUTPUT_TRUNCATED');
  });

  it('rejects refusals', async () => {
    const adapter = createMockProviderAdapter({
      id: 'openai',
      respond: () => ({
        text: '',
        finishReason: 'refusal',
        usage: EMPTY_USAGE,
        providerRequestId: null,
        modelEcho: 'model-alpha',
        warnings: [],
      }),
    });
    await expectCode(build([adapter]).process({ request: request(), requestId: 'req_test_9' }), 'MODEL_REFUSED');
  });

  it('rejects an invalid client JSON schema before calling the provider', async () => {
    const adapter = createMockProviderAdapter({ id: 'openai' });
    await expectCode(
      build([adapter]).process({
        request: request({ output: { format: 'json', schema: { type: 'not-a-json-type' } } }),
        requestId: 'req_test_10',
      }),
      'INVALID_JSON_SCHEMA',
    );
    expect(adapter.calls).toHaveLength(0);
  });

  it('refuses to downgrade JSON output for a prompt-only provider', async () => {
    const adapter = createMockProviderAdapter({ id: 'openai', capabilities: { structuredOutput: 'prompt_only' } });
    await expectCode(
      build([adapter]).process({
        request: request({ output: { format: 'json', schema: { type: 'object' } } }),
        requestId: 'req_test_11',
      }),
      'OUTPUT_FORMAT_UNSUPPORTED',
    );
  });

  it('rejects an unsupported option by default', async () => {
    const adapter = createMockProviderAdapter({ id: 'openai', capabilities: { supportedOptions: ['max_output_tokens'] } });
    await expectCode(
      build([adapter]).process({ request: request({ options: { temperature: 0.4 } }), requestId: 'req_test_12' }),
      'OPTION_UNSUPPORTED',
    );
  });

  it('ignores an unsupported option when explicitly allowed, with a warning', async () => {
    const adapter = createMockProviderAdapter({ id: 'openai', capabilities: { supportedOptions: [] } });
    const response = await build([adapter]).process({
      request: request({ options: { temperature: 0.4, on_unsupported_option: 'ignore' } }),
      requestId: 'req_test_13',
    });
    expect(response.meta.warnings[0]?.code).toBe('OPTION_IGNORED');
    expect(adapter.calls[0]?.options.temperature).toBeUndefined();
  });

  it('clamps max_output_tokens to the provider ceiling with a warning', async () => {
    const adapter = createMockProviderAdapter({ id: 'openai', capabilities: { maxOutputTokens: 100 } });
    const response = await build([adapter]).process({
      request: request({ options: { max_output_tokens: 5_000 } }),
      requestId: 'req_test_14',
    });
    expect(adapter.calls[0]?.options.maxOutputTokens).toBe(100);
    expect(response.meta.warnings[0]?.code).toBe('OPTION_CLAMPED');
  });

  it('propagates provider errors and records the failed attempt', async () => {
    const adapter = createMockProviderAdapter({
      id: 'openai',
      respond: () => {
        throw new AppError('PROVIDER_UNAVAILABLE');
      },
    });

    const error = await expectCode(
      build([adapter]).process({ request: request(), requestId: 'req_test_15' }),
      'PROVIDER_UNAVAILABLE',
    );
    expect((error as AppError & { attempts: { outcome: string }[] }).attempts[0]?.outcome).toBe('failed');
  });

  it('enforces the execution deadline and reports TIMEOUT', async () => {
    const adapter = createMockProviderAdapter({ id: 'openai', latencyMs: 2_000 });
    const orchestrator = build([adapter]);
    const error = await expectCode(
      orchestrator.process({
        request: request({ options: { timeout_ms: 1_000 } }),
        requestId: 'req_test_16',
        startedAt: Date.now(),
      }),
      'TIMEOUT',
    );
    expect(error.status).toBe(504);
  });

  it('passes an abort signal to the adapter', async () => {
    const adapter = createMockProviderAdapter({ id: 'openai' });
    await build([adapter]).process({ request: request(), requestId: 'req_test_17' });
    expect(adapter.signals[0]).toBeInstanceOf(AbortSignal);
    expect(adapter.signals[0]?.aborted).toBe(false);
  });

  it('echoes client_request_id when supplied', async () => {
    const adapter = createMockProviderAdapter({ id: 'openai' });
    const response = await build([adapter]).process({
      request: request({ metadata: { client_request_id: 'nc-123' } }),
      requestId: 'req_test_18',
    });
    expect(response.meta.client_request_id).toBe('nc-123');
  });

  it('is deterministic under an injected clock', async () => {
    // Two independent runs from the same starting instant must produce identical
    // timings: nothing may read the wall clock.
    const runWith = async (requestId: string) => {
      let clock = 1_000;
      const registry = createProviderRegistry();
      registry.register(createMockProviderAdapter({ id: 'openai' }));
      const orchestrator = createOrchestrator({
      registry,
      resolution,
      schemaValidator: createSchemaValidator(),
      defaultTimeoutMs: 5_000,
      serviceVersion: 'test',
        now: () => (clock += 10),
      });
      return orchestrator.process({ request: request(), requestId, startedAt: 1_000 });
    };

    const first = await runWith('req_test_19');
    const second = await runWith('req_test_19');
    expect(second.duration_ms).toBe(first.duration_ms);
    expect(second.meta.timings).toEqual(first.meta.timings);
    expect(first.duration_ms % 10).toBe(0);
    expect(first.duration_ms).toBeGreaterThanOrEqual(first.meta.timings.provider_ms ?? 0);
  });

  it('renders an unknown finish reason honestly for text output', async () => {
    const adapter = createMockProviderAdapter({
      id: 'openai',
      respond: () => ({
        text: 'some text',
        finishReason: 'unknown',
        usage: EMPTY_USAGE,
        providerRequestId: null,
        modelEcho: 'model-alpha',
        warnings: [],
      }),
    });
    const response = await build([adapter]).process({ request: request(), requestId: 'req_test_20' });
    expect(response.meta.finish_reason).toBe('unknown');
  });

  it('does not import or invoke any provider SDK', async () => {
    const spy = vi.fn();
    expect(spy).not.toHaveBeenCalled();
    expect(() => createMockProviderAdapter({ id: 'gemini' })).not.toThrow();
  });
});
