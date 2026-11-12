import { describe, expect, it, vi } from 'vitest';
import { createOpenAIAdapter, mapOpenAIStopReason } from '../../../src/providers/openai/adapter.js';
import { AppError } from '../../../src/core/errors/AppError.js';
import { generationRequest, jsonRequest, FakeSdkError } from '../../helpers/provider-fixtures.js';
import type { GenerationResponse } from '../../../src/contracts/generation.js';

interface FakeResponse {
  output_text?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: { type: string }[];
  usage?: Record<string, unknown> | null;
  id?: string;
  model?: string;
}

function adapterWith(responder: (body: unknown, opts: unknown) => Promise<FakeResponse>) {
  const create = vi.fn(responder);
  const client = { responses: { create } } as never;
  return { adapter: createOpenAIAdapter({ apiKey: 'sk-test-not-real', maxOutputTokens: 4096, client }), create };
}

const okResponse = (overrides: Partial<FakeResponse> = {}): FakeResponse => ({
  output_text: 'Generated text.',
  status: 'completed',
  output: [{ type: 'message' }],
  usage: {
    input_tokens: 120,
    output_tokens: 45,
    total_tokens: 165,
    input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 5 },
  },
  id: 'resp_123',
  model: 'test-model-echo',
  ...overrides,
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }
  throw new Error(`expected ${code}`);
}

describe('openai adapter', () => {
  it('declares its identity and capabilities', () => {
    const { adapter } = adapterWith(async () => okResponse());
    expect(adapter.id).toBe('openai');
    expect(adapter.capabilities.structuredOutput).toBe('json_schema');
    expect(adapter.capabilities.supportedOptions).toContain('temperature');
    expect(adapter.capabilities.maxOutputTokens).toBe(4096);
  });

  it('sends instructions through the system channel and content as user input', async () => {
    const { adapter, create } = adapterWith(async () => okResponse());
    await adapter.generate(generationRequest(), new AbortController().signal);

    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.instructions).toBe('Summarise the article.');
    expect(String(body.input)).toContain('Body text.');
    expect(body.instructions).not.toContain('Body text.');
    expect(body.model).toBe('test-model');
  });

  it('maps sampling options onto OpenAI parameter names', async () => {
    const { adapter, create } = adapterWith(async () => okResponse());
    await adapter.generate(
      generationRequest({ options: { temperature: 0.3, topP: 0.9, maxOutputTokens: 512 } }),
      new AbortController().signal,
    );
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.temperature).toBe(0.3);
    expect(body.top_p).toBe(0.9);
    expect(body.max_output_tokens).toBe(512);
  });

  it('omits unsupported-by-request options entirely', async () => {
    const { adapter, create } = adapterWith(async () => okResponse());
    await adapter.generate(generationRequest({ options: {} }), new AbortController().signal);
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('text');
  });

  it('requests native strict structured output and reports schema closing', async () => {
    const { adapter, create } = adapterWith(async () => okResponse({ output_text: '{"title":"T"}' }));
    const response = await adapter.generate(
      jsonRequest({ type: 'object', properties: { title: { type: 'string' } } }),
      new AbortController().signal,
    );

    const body = create.mock.calls[0]![0] as { text: { format: Record<string, unknown> } };
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.strict).toBe(true);
    expect((body.text.format.schema as Record<string, unknown>).additionalProperties).toBe(false);
    expect((body.text.format.schema as Record<string, unknown>).required).toEqual(['title']);

    expect(response.warnings.map((w) => w.code)).toContain('SCHEMA_MODIFIED');
    expect(response.text).toBe('{"title":"T"}');
  });

  it('uses the supplied schema name and defaults one when absent', async () => {
    const { adapter, create } = adapterWith(async () => okResponse());
    await adapter.generate(
      generationRequest({ output: { kind: 'json', schema: { type: 'object' }, schemaName: 'article_v1', validate: true } }),
      new AbortController().signal,
    );
    expect((create.mock.calls[0]![0] as { text: { format: { name: string } } }).text.format.name).toBe('article_v1');

    await adapter.generate(jsonRequest(), new AbortController().signal);
    expect((create.mock.calls[1]![0] as { text: { format: { name: string } } }).text.format.name).toBe(
      'structured_output',
    );
  });

  it('normalizes usage including cached and reasoning tokens', async () => {
    const { adapter } = adapterWith(async () => okResponse());
    const response = await adapter.generate(generationRequest(), new AbortController().signal);
    expect(response.usage).toEqual({
      input_tokens: 120,
      output_tokens: 45,
      total_tokens: 165,
      cached_input_tokens: 20,
      reasoning_tokens: 5,
    });
  });

  it('represents absent usage as null rather than zero', async () => {
    const { adapter } = adapterWith(async () => okResponse({ usage: null }));
    const response = await adapter.generate(generationRequest(), new AbortController().signal);
    expect(response.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cached_input_tokens: null,
      reasoning_tokens: null,
    });
  });

  it('reports the provider echo and request id', async () => {
    const { adapter } = adapterWith(async () => okResponse());
    const response = await adapter.generate(generationRequest(), new AbortController().signal);
    expect(response.modelEcho).toBe('test-model-echo');
    expect(response.providerRequestId).toBe('resp_123');
  });

  it.each([
    [{ status: 'completed', output: [{ type: 'message' }] }, 'stop'],
    [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 'length'],
    [{ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, 'content_filter'],
    [{ status: 'incomplete', incomplete_details: { reason: 'weird_reason' } }, 'unknown'],
    [{ status: 'failed' }, 'unknown'],
    [{ status: 'completed', output: [{ type: 'refusal' }] }, 'refusal'],
    [{ status: 'completed', output: [{ type: 'message' }, { type: 'refusal' }] }, 'refusal'],
  ])('maps response status %j to %s', (fixture, expected) => {
    expect(mapOpenAIStopReason(fixture as never)).toBe(expected);
  });

  it('propagates truncation as a mapped finish reason, not as success', async () => {
    const { adapter } = adapterWith(async () =>
      okResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    );
    const response: GenerationResponse = await adapter.generate(generationRequest(), new AbortController().signal);
    expect(response.finishReason).toBe('length');
  });

  it.each([
    [401, 'PROVIDER_AUTH_FAILED'],
    [403, 'PROVIDER_AUTH_FAILED'],
    [429, 'PROVIDER_RATE_LIMITED'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [503, 'PROVIDER_UNAVAILABLE'],
    [400, 'PROVIDER_BAD_REQUEST'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const { adapter } = adapterWith(async () => {
      throw new FakeSdkError(status, 'provider said something');
    });
    const error = await expectCode(adapter.generate(generationRequest(), new AbortController().signal), code);
    expect(error.code).toBe(code);
  });

  it('maps an unknown-model error to a distinct code', async () => {
    const { adapter } = adapterWith(async () => {
      throw new FakeSdkError(404, 'The model `nope` does not exist');
    });
    await expectCode(adapter.generate(generationRequest(), new AbortController().signal), 'PROVIDER_MODEL_NOT_FOUND');
  });

  it('exposes retry-after from the provider headers', async () => {
    const { adapter } = adapterWith(async () => {
      throw new FakeSdkError(429, 'slow down', { 'retry-after': '2' });
    });
    const error = await expectCode(adapter.generate(generationRequest(), new AbortController().signal), 'PROVIDER_RATE_LIMITED');
    expect((error.details as { retry_after_ms: number }).retry_after_ms).toBe(2000);
  });

  it('redacts credential-shaped text out of provider messages', async () => {
    const { adapter } = adapterWith(async () => {
      throw new FakeSdkError(400, 'Incorrect API key provided: sk-live-abcdefghijklmnop');
    });
    const error = await expectCode(adapter.generate(generationRequest(), new AbortController().signal), 'PROVIDER_BAD_REQUEST');
    expect(JSON.stringify(error.details)).not.toContain('sk-live-abcdefghijklmnop');
  });

  it('converts an aborted signal into PROVIDER_TIMEOUT', async () => {
    const controller = new AbortController();
    const { adapter } = adapterWith(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    const error = await expectCode(adapter.generate(generationRequest(), controller.signal), 'PROVIDER_TIMEOUT');
    expect(error.status).toBe(504);
  });

  it('never retries internally', async () => {
    const { adapter, create } = adapterWith(async () => {
      throw new FakeSdkError(503, 'unavailable');
    });
    await expectCode(adapter.generate(generationRequest(), new AbortController().signal), 'PROVIDER_UNAVAILABLE');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
