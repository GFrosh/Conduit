import { describe, expect, it, vi } from 'vitest';
import {
  createAnthropicAdapter,
  mapAnthropicStopReason,
} from '../../../src/providers/anthropic/adapter.js';
import { AppError } from '../../../src/core/errors/AppError.js';
import { generationRequest, jsonRequest, FakeSdkError } from '../../helpers/provider-fixtures.js';

function adapterWith(responder: (body: unknown, opts: unknown) => Promise<unknown>) {
  const create = vi.fn(responder);
  const client = { messages: { create } } as never;
  return {
    adapter: createAnthropicAdapter({ apiKey: 'sk-ant-test', defaultMaxTokens: 2048, client }),
    create,
  };
}

const okMessage = (overrides: Record<string, unknown> = {}) => ({
  id: 'msg_123',
  model: 'claude-echo',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'Generated text.' }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 200,
    output_tokens: 60,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 0,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
  },
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

describe('anthropic adapter', () => {
  it('declares its identity and Anthropic-specific traits', () => {
    const { adapter } = adapterWith(async () => okMessage());
    expect(adapter.id).toBe('anthropic');
    expect(adapter.capabilities.structuredOutput).toBe('json_schema');
    expect(adapter.capabilities.requiresMaxTokens).toBe(true);
  });

  it('uses the system parameter and a single user message', async () => {
    const { adapter, create } = adapterWith(async () => okMessage());
    await adapter.generate(generationRequest(), new AbortController().signal);

    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.system).toBe('Summarise the article.');
    expect(body.system).not.toContain('Body text.');
    const messages = body.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toContain('Body text.');
  });

  it('always supplies max_tokens and reports the default as a warning', async () => {
    const { adapter, create } = adapterWith(async () => okMessage());
    const response = await adapter.generate(generationRequest({ options: {} }), new AbortController().signal);

    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.max_tokens).toBe(2048);
    expect(response.warnings.map((w) => w.code)).toContain('OPTION_DEFAULTED');
  });

  it('honours an explicit max_output_tokens without a warning', async () => {
    const { adapter, create } = adapterWith(async () => okMessage());
    const response = await adapter.generate(
      generationRequest({ options: { maxOutputTokens: 700 } }),
      new AbortController().signal,
    );
    expect((create.mock.calls[0]![0] as Record<string, unknown>).max_tokens).toBe(700);
    expect(response.warnings).toHaveLength(0);
  });

  it('maps temperature and top_p to Anthropic parameter names', async () => {
    const { adapter, create } = adapterWith(async () => okMessage());
    await adapter.generate(
      generationRequest({ options: { temperature: 0.2, topP: 0.8 } }),
      new AbortController().signal,
    );
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.8);
  });

  it('requests structured output through output_config.format', async () => {
    const { adapter, create } = adapterWith(async () =>
      okMessage({ content: [{ type: 'text', text: '{"title":"T"}' }] }),
    );
    const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };
    await adapter.generate(jsonRequest(schema), new AbortController().signal);

    const body = create.mock.calls[0]![0] as {
      output_config?: { format?: { type: string; schema: unknown } };
      response_format?: unknown;
    };
    expect(body.output_config?.format?.type).toBe('json_schema');
    expect(body.output_config?.format?.schema).toEqual(schema);
    // Anthropic does not accept OpenAI's parameter names.
    expect(body.response_format).toBeUndefined();
  });

  it('concatenates multiple text blocks and ignores non-text blocks', async () => {
    const { adapter } = adapterWith(async () =>
      okMessage({
        content: [
          { type: 'thinking', thinking: 'pondering' },
          { type: 'text', text: 'Part one. ' },
          { type: 'text', text: 'Part two.' },
        ],
      }),
    );
    const response = await adapter.generate(generationRequest(), new AbortController().signal);
    expect(response.text).toBe('Part one. Part two.');
  });

  it('normalizes usage and leaves total_tokens null (Anthropic reports none)', async () => {
    const { adapter } = adapterWith(async () => okMessage());
    const response = await adapter.generate(generationRequest(), new AbortController().signal);
    expect(response.usage).toEqual({
      input_tokens: 200,
      output_tokens: 60,
      total_tokens: null,
      cached_input_tokens: 40,
      reasoning_tokens: null,
    });
  });

  it('returns nulls for a missing usage object', async () => {
    const { adapter } = adapterWith(async () => okMessage({ usage: null }));
    const response = await adapter.generate(generationRequest(), new AbortController().signal);
    expect(response.usage.total_tokens).toBeNull();
    expect(response.usage.input_tokens).toBeNull();
  });

  it.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['max_tokens', 'length'],
    ['model_context_window_exceeded', 'length'],
    ['tool_use', 'tool_calls'],
    ['refusal', 'refusal'],
    ['pause_turn', 'unknown'],
    [null, 'unknown'],
    ['something_new', 'unknown'],
  ])('maps stop_reason %s to %s', (stopReason, expected) => {
    expect(mapAnthropicStopReason(stopReason as string)).toBe(expected);
  });

  it('surfaces a refusal that arrived with HTTP 200', async () => {
    const { adapter } = adapterWith(async () => okMessage({ stop_reason: 'refusal', content: [] }));
    const response = await adapter.generate(generationRequest(), new AbortController().signal);
    expect(response.finishReason).toBe('refusal');
  });

  it.each([
    [401, 'PROVIDER_AUTH_FAILED'],
    [403, 'PROVIDER_AUTH_FAILED'],
    [429, 'PROVIDER_RATE_LIMITED'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [529, 'PROVIDER_UNAVAILABLE'],
    [400, 'PROVIDER_BAD_REQUEST'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const { adapter } = adapterWith(async () => {
      throw new FakeSdkError(status, 'anthropic says no');
    });
    await expectCode(adapter.generate(generationRequest(), new AbortController().signal), code);
  });

  it('distinguishes an unknown model from a generic bad request', async () => {
    const { adapter } = adapterWith(async () => {
      throw new FakeSdkError(404, 'model: nope-not-real not found');
    });
    await expectCode(adapter.generate(generationRequest(), new AbortController().signal), 'PROVIDER_MODEL_NOT_FOUND');
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
    const { adapter, create } = adapterWith(async () => {
      throw new FakeSdkError(503, 'overloaded');
    });
    await expectCode(adapter.generate(generationRequest(), new AbortController().signal), 'PROVIDER_UNAVAILABLE');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
