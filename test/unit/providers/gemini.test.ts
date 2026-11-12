import { describe, expect, it, vi } from 'vitest';
import { createGeminiAdapter, mapGeminiFinishReason } from '../../../src/providers/gemini/adapter.js';
import { AppError } from '../../../src/core/errors/AppError.js';
import { generationRequest, jsonRequest, FakeSdkError } from '../../helpers/provider-fixtures.js';

function adapterWith(responder: (params: unknown) => Promise<unknown>) {
  const generateContent = vi.fn(responder);
  const client = { models: { generateContent } } as never;
  return {
    adapter: createGeminiAdapter({ apiKey: 'gemini-test-key', maxOutputTokens: 4096, client }),
    generateContent,
  };
}

const okResponse = (overrides: Record<string, unknown> = {}) => ({
  text: 'Generated text.',
  candidates: [
    { content: { parts: [{ text: 'Generated text.' }], role: 'model' }, finishReason: 'STOP' },
  ],
  usageMetadata: {
    promptTokenCount: 300,
    candidatesTokenCount: 80,
    totalTokenCount: 380,
    cachedContentTokenCount: 10,
    thoughtsTokenCount: 12,
  },
  responseId: 'gem_123',
  modelVersion: 'gemini-echo',
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

describe('gemini adapter', () => {
  it('declares its identity and the keywords it cannot enforce', () => {
    const { adapter } = adapterWith(async () => okResponse());
    expect(adapter.id).toBe('gemini');
    expect(adapter.capabilities.unenforcedSchemaKeywords).toContain('maxLength');
    expect(adapter.capabilities.unenforcedSchemaKeywords).toContain('minProperties');
  });

  it('uses systemInstruction and a single user turn', async () => {
    const { adapter, generateContent } = adapterWith(async () => okResponse());
    await adapter.generate(generationRequest(), new AbortController().signal);

    const params = generateContent.mock.calls[0]![0] as {
      model: string;
      contents: { role: string; parts: { text: string }[] }[];
      config: Record<string, unknown>;
    };
    expect(params.model).toBe('test-model');
    expect(params.config.systemInstruction).toBe('Summarise the article.');
    expect(params.contents).toHaveLength(1);
    expect(params.contents[0]!.role).toBe('user');
    expect(params.contents[0]!.parts[0]!.text).toContain('Body text.');
  });

  it('maps generation options onto Gemini config names', async () => {
    const { adapter, generateContent } = adapterWith(async () => okResponse());
    await adapter.generate(
      generationRequest({ options: { temperature: 0.5, topP: 0.7, maxOutputTokens: 900 } }),
      new AbortController().signal,
    );
    const params = generateContent.mock.calls[0]![0] as { config: Record<string, unknown> };
    expect(params.config.temperature).toBe(0.5);
    expect(params.config.topP).toBe(0.7);
    expect(params.config.maxOutputTokens).toBe(900);
  });

  it('forwards the abort signal to the SDK', async () => {
    const { adapter, generateContent } = adapterWith(async () => okResponse());
    const controller = new AbortController();
    await adapter.generate(generationRequest(), controller.signal);
    const params = generateContent.mock.calls[0]![0] as { config: Record<string, unknown> };
    expect(params.config.abortSignal).toBe(controller.signal);
  });

  it('uses responseMimeType + responseSchema and strips unsupported keywords', async () => {
    const { adapter, generateContent } = adapterWith(async () => okResponse({ text: '{"title":"T"}' }));
    const response = await adapter.generate(
      jsonRequest({
        type: 'object',
        properties: { title: { type: 'string', maxLength: 200, description: 'the title' } },
        required: ['title'],
        additionalProperties: false,
      }),
      new AbortController().signal,
    );

    const params = generateContent.mock.calls[0]![0] as { config: Record<string, unknown> };
    expect(params.config.responseMimeType).toBe('application/json');
    const schema = params.config.responseSchema as Record<string, unknown>;
    expect(response.warnings.map((w) => w.code)).toContain('SCHEMA_KEYWORD_DROPPED');

    const serialized = JSON.stringify(schema);
    expect(serialized).not.toContain('maxLength');
    expect(serialized).not.toContain('additionalProperties');
    // Supported keywords survive.
    expect(serialized).toContain('description');
    expect((schema.properties as Record<string, Record<string, unknown>>).title!.type).toBe('string');
  });

  it('falls back to JSON mode without a schema when the schema uses $ref', async () => {
    const { adapter, generateContent } = adapterWith(async () => okResponse({ text: '{"a":"b"}' }));
    const response = await adapter.generate(
      jsonRequest({ type: 'object', properties: { a: { $ref: '#/$defs/x' } } }),
      new AbortController().signal,
    );

    const params = generateContent.mock.calls[0]![0] as { config: Record<string, unknown> };
    expect(params.config.responseMimeType).toBe('application/json');
    expect(params.config.responseSchema).toBeUndefined();
    expect(response.warnings.map((w) => w.code)).toContain('SCHEMA_MODIFIED');
  });

  it('normalizes usage including cached and thinking tokens', async () => {
    const { adapter } = adapterWith(async () => okResponse());
    const response = await adapter.generate(generationRequest(), new AbortController().signal);
    expect(response.usage).toEqual({
      input_tokens: 300,
      output_tokens: 80,
      total_tokens: 380,
      cached_input_tokens: 10,
      reasoning_tokens: 12,
    });
  });

  it('returns nulls when usageMetadata is missing', async () => {
    const { adapter } = adapterWith(async () => okResponse({ usageMetadata: undefined }));
    const response = await adapter.generate(generationRequest(), new AbortController().signal);
    expect(response.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cached_input_tokens: null,
      reasoning_tokens: null,
    });
  });

  it('joins multi-part candidate text', async () => {
    const { adapter } = adapterWith(async () => ({
      candidates: [{ content: { parts: [{ text: 'A' }, { text: 'B' }] }, finishReason: 'STOP' }],
    }));
    const response = await adapter.generate(generationRequest(), new AbortController().signal);
    expect(response.text).toBe('AB');
  });

  it.each([
    ['STOP', undefined, 'stop'],
    ['MAX_TOKENS', undefined, 'length'],
    ['SAFETY', undefined, 'content_filter'],
    ['RECITATION', undefined, 'content_filter'],
    ['PROHIBITED_CONTENT', undefined, 'content_filter'],
    ['MALFORMED_FUNCTION_CALL', undefined, 'tool_calls'],
    [undefined, 'SAFETY', 'content_filter'],
    ['OTHER', undefined, 'unknown'],
    [undefined, undefined, 'unknown'],
  ])('maps finishReason=%s blockReason=%s to %s', (finishReason, blockReason, expected) => {
    expect(mapGeminiFinishReason(finishReason as string, blockReason as string)).toBe(expected);
  });

  it('treats a prompt-level block (no candidates) as a content filter', async () => {
    const { adapter } = adapterWith(async () => ({
      promptFeedback: { blockReason: 'SAFETY' },
      candidates: undefined,
    }));
    const response = await adapter.generate(generationRequest(), new AbortController().signal);
    expect(response.finishReason).toBe('content_filter');
    expect(response.text).toBe('');
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
      throw new FakeSdkError(status, 'gemini says no');
    });
    await expectCode(adapter.generate(generationRequest(), new AbortController().signal), code);
  });

  it('maps an aborted signal to PROVIDER_TIMEOUT', async () => {
    const controller = new AbortController();
    const { adapter } = adapterWith(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    await expectCode(adapter.generate(generationRequest(), controller.signal), 'PROVIDER_TIMEOUT');
  });

  it('does not retry internally', async () => {
    const { adapter, generateContent } = adapterWith(async () => {
      throw new FakeSdkError(503, 'unavailable');
    });
    await expectCode(adapter.generate(generationRequest(), new AbortController().signal), 'PROVIDER_UNAVAILABLE');
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});
