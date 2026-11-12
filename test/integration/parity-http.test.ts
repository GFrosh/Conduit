import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuiltApp } from '../../src/app.js';
import { createOpenAIAdapter } from '../../src/providers/openai/adapter.js';
import { createAnthropicAdapter } from '../../src/providers/anthropic/adapter.js';
import { createGeminiAdapter } from '../../src/providers/gemini/adapter.js';
import { AUTH_HEADER, testConfig } from '../helpers/config.js';
import type { ProviderAdapter } from '../../src/contracts/provider.js';

const open: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

const ANSWER = JSON.stringify({ title: 'Engine parity', tags: ['openai', 'anthropic', 'gemini'] });

/** The same logical answer, expressed in each provider's own wire format. */
function liveStyleAdapters(): ProviderAdapter[] {
  return [
    createOpenAIAdapter({
      apiKey: 'sk-test-not-real',
      maxOutputTokens: 1024,
      client: {
        responses: {
          create: async () => ({
            output_text: ANSWER,
            status: 'completed',
            output: [{ type: 'message' }],
            usage: { input_tokens: 40, output_tokens: 20, total_tokens: 60 },
            id: 'resp_http',
            model: 'gpt-echo',
          }),
        },
      } as never,
    }),
    createAnthropicAdapter({
      apiKey: 'sk-ant-test-not-real',
      defaultMaxTokens: 1024,
      client: {
        messages: {
          create: async () => ({
            id: 'msg_http',
            model: 'claude-echo',
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'text', text: '{"title":"Engine parity",' },
              { type: 'text', text:'"tags":["openai","anthropic","gemini"]}' },
            ],
            stop_reason: 'end_turn',
            // Anthropic reports no total_tokens: it must stay null, not guessed.
            usage: { input_tokens: 40, output_tokens: 20 },
          }),
        },
      } as never,
    }),
    createGeminiAdapter({
      apiKey: 'test-not-real',
      maxOutputTokens: 1024,
      client: {
        models: {
          generateContent: async () => ({
            candidates: [
              { content: { parts: [{ text: ANSWER }], role: 'model' }, finishReason: 'STOP' },
            ],
            usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 20, totalTokenCount: 60 },
            responseId: 'gem_http',
            modelVersion: 'gemini-echo',
          }),
        },
      } as never,
    }),
  ];
}

async function start(): Promise<BuiltApp> {
  const built = await buildApp({ config: testConfig(), adapters: liveStyleAdapters() });
  await built.app.ready();
  open.push(built.app);
  return built;
}

const body = (provider: string) => ({
  provider,
  model: `model-for-${provider}`,
  instructions: 'Summarise the article and return JSON.',
  content: { type: 'text', text: 'An article body about an AI processing engine.' },
  output: {
    format: 'json',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'tags'],
      properties: {
        title: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  options: { temperature: 0.2, max_output_tokens: 512 },
});

describe('POST /v1/process across all three live adapters', () => {
  it('returns one consistent contract for the identical request', async () => {
    const { app } = await start();
    const seen: Record<string, unknown>[] = [];

    for (const provider of ['openai', 'anthropic', 'gemini']) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/process',
        headers: AUTH_HEADER,
        payload: body(provider),
      });

      expect(response.statusCode).toBe(200);
      const json = response.json() as Record<string, unknown>;
      seen.push(json);

      expect(json.success).toBe(true);
      expect(json.provider).toBe(provider);
      // Parsed object, on every provider, never a JSON string inside JSON.
      expect(json.result).toEqual({
        type: 'json',
        data: { title: 'Engine parity', tags: ['openai', 'anthropic', 'gemini'] },
      });
      expect(typeof json.request_id).toBe('string');
      expect(typeof json.duration_ms).toBe('number');
      expect(json.meta).toMatchObject({ finish_reason: 'stop', fallback_used: false });
    }

    // Identical top-level keys: only the values differ per provider.
    const keys = seen.map((json) => Object.keys(json).sort().join(','));
    expect(new Set(keys).size).toBe(1);

    // usage is normalized, and Anthropic's absent total is null rather than invented.
    expect(seen.map((json) => (json.usage as Record<string, number | null>).input_tokens)).toEqual([40, 40, 40]);
    expect(seen.map((json) => (json.usage as Record<string, number | null>).output_tokens)).toEqual([20, 20, 20]);
    expect(seen.map((json) => (json.usage as Record<string, number | null>).total_tokens)).toEqual([60, null, 60]);
  });

  it('reports each provider model echo truthfully', async () => {
    const { app } = await start();
    const echoes: string[] = [];
    for (const provider of ['openai', 'anthropic', 'gemini']) {
      const response = await app.inject({ method: 'POST', url: '/v1/process', headers: AUTH_HEADER, payload: body(provider) });
      echoes.push((response.json() as { model: string }).model);
    }
    expect(echoes).toEqual(['gpt-echo', 'claude-echo', 'gemini-echo']);
  });

  it('never accepts a provider credential in the request body', async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: AUTH_HEADER,
      payload: { ...body('openai'), apiKey: 'sk-should-never-be-here' },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('CREDENTIALS_IN_PAYLOAD');
  });
});
