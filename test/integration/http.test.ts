import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuiltApp } from '../../src/app.js';
import { createMockProviderAdapter } from '../../src/providers/mock/adapter.js';
import { EMPTY_USAGE } from '../../src/contracts/common.js';
import type { ProviderAdapter } from '../../src/contracts/provider.js';
import { AUTH_HEADER, VALID_BODY, testConfig } from '../helpers/config.js';

const open: FastifyInstance[] = [];

async function start(overrides: Record<string, string | undefined> = {}, adapters?: ProviderAdapter[]): Promise<BuiltApp> {
  const built = await buildApp({
    config: testConfig(overrides),
    ...(adapters ? { adapters } : {}),
  });
  await built.app.ready();
  open.push(built.app);
  return built;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

describe('GET /health', () => {
  it('responds without authentication', async () => {
    const { app } = await start();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', version: 'test' });
    expect(typeof response.json().uptime_s).toBe('number');
  });

  it('exposes no environment values or infrastructure details', async () => {
    const { app } = await start();
    const body = (await app.inject({ method: 'GET', url: '/health' })).body;
    for (const forbidden of ['supersecret-test', 'test-key', 'postgres', 'redis', 'OPENAI_API_KEY', '3000']) {
      expect(body).not.toContain(forbidden);
    }
    expect(Object.keys(JSON.parse(body)).sort()).toEqual(['status', 'uptime_s', 'version']);
  });
});

describe('GET /ready', () => {
  it('reports ready when providers are registered and the default is available', async () => {
    const { app } = await start();
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ready',
      version: 'test',
      checks: { providers_registered: 3 },
    });
  });

  it('reports not ready when the default provider is not registered', async () => {
    const built = await start({ DEFAULT_PROVIDER: 'openai' }, [createMockProviderAdapter({ id: 'anthropic' })]);
    const response = await built.app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json().checks.reason).toBe('default_provider_unavailable');
  });
});

describe('POST /v1/process — authentication', () => {
  it('rejects a request without credentials', async () => {
    const { app } = await start();
    const response = await app.inject({ method: 'POST', url: '/v1/process', payload: VALID_BODY });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_MISSING');
    expect(response.json().success).toBe(false);
    expect(typeof response.json().request_id).toBe('string');
  });

  it('rejects an invalid credential', async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: { authorization: 'Bearer wrong-secret-value' },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_INVALID');
  });

  it('rejects a malformed authorization header', async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: { authorization: 'supersecret-test' },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /v1/process — success paths', () => {
  it('processes a text request end to end', async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: AUTH_HEADER,
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.provider).toBe('openai');
    expect(body.model).toBe('model-alpha');
    expect(body.result.type).toBe('text');
    expect(typeof body.result.text).toBe('string');
    expect(body.usage).toEqual({ input_tokens: 11, output_tokens: 7, total_tokens: 18, cached_input_tokens: null, reasoning_tokens: null });
    expect(body.meta.fallback_used).toBe(false);
    expect(body.meta.attempts).toHaveLength(1);
  });

  it('does not treat a normally completed socket request as a client disconnect', async () => {
    const { app } = await start();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/v1/process`, {
      method: 'POST',
      headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
  });

  it('honours an explicit provider and model', async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: AUTH_HEADER,
      payload: { ...VALID_BODY, provider: 'gemini', model: 'model-gamma' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().provider).toBe('gemini');
    expect(response.json().model).toBe('model-gamma');
  });

  it('returns a parsed JSON object when JSON output is requested', async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: AUTH_HEADER,
      payload: {
        ...VALID_BODY,
        output: {
          format: 'json',
          schema: {
            type: 'object',
            properties: { mock: { type: 'boolean' } },
            required: ['mock'],
          },
          schema_name: 'mock_output',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.result.type).toBe('json');
    expect(typeof body.result.data).toBe('object');
    expect(body.result.data.mock).toBe(true);
  });

  it('echoes a valid client request id', async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: { ...AUTH_HEADER, 'x-request-id': 'client-req-0001' },
      payload: VALID_BODY,
    });
    expect(response.json().request_id).toBe('client-req-0001');
  });

  it('generates a request id when the header is unsafe', async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: { ...AUTH_HEADER, 'x-request-id': 'bad id with spaces!' },
      payload: VALID_BODY,
    });
    expect(response.json().request_id).toMatch(/^req_/);
  });
});

describe('POST /v1/process — contract enforcement', () => {
  it('rejects a body missing instructions', async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: AUTH_HEADER,
      payload: { content: VALID_BODY.content },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects provider credentials supplied in the payload', async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: AUTH_HEADER,
      payload: { ...VALID_BODY, openaiApiKey: 'sk-should-never-be-accepted' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('CREDENTIALS_IN_PAYLOAD');
  });

  it('rejects an unknown provider', async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: AUTH_HEADER,
      payload: { ...VALID_BODY, provider: 'cohere' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('PROVIDER_UNKNOWN');
    expect(response.json().error.details.known).toEqual(['openai', 'anthropic', 'gemini']);
  });

  it('rejects a provider that is known but not enabled, without substituting', async () => {
    const built = await start({ DEFAULT_PROVIDER: 'openai' }, [createMockProviderAdapter({ id: 'openai' })]);
    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: AUTH_HEADER,
      payload: { ...VALID_BODY, provider: 'gemini' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(response.json().error.details.available).toEqual(['openai']);
  });

  it('rejects a request when no model can be resolved', async () => {
    const built = await start({ DEFAULT_MODEL_OPENAI: '' });
    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: AUTH_HEADER,
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('MODEL_REQUIRED');
  });

  it('enforces the body size limit', async () => {
    const built = await start({ MAX_BODY_BYTES: '1024' });
    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: AUTH_HEADER,
      payload: { ...VALID_BODY, content: { type: 'text', text: 'x'.repeat(4_000) } },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects a context object nested beyond the budget', async () => {
    const { app } = await start();
    let nested: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 12; i += 1) nested = { child: nested };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: AUTH_HEADER,
      payload: { ...VALID_BODY, context: nested },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
    expect(response.json().error.details.reason).toContain('depth');
  });

  it('rejects an invalid client JSON schema', async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: AUTH_HEADER,
      payload: { ...VALID_BODY, output: { format: 'json', schema: { type: 'nonsense-type' } } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_JSON_SCHEMA');
  });

  it('rejects a remote $ref in a client schema', async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: AUTH_HEADER,
      payload: {
        ...VALID_BODY,
        output: { format: 'json', schema: { $ref: 'https://evil.example.com/schema.json' } },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_JSON_SCHEMA');
  });

  it('does not leak provider internals in an error body', async () => {
    const failing = createMockProviderAdapter({
      id: 'openai',
      respond: () => {
        throw new Error('upstream said: invalid api key sk-live-secret');
      },
    });
    const built = await start({}, [failing]);
    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: AUTH_HEADER,
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error.code).toBe('INTERNAL');
    expect(JSON.stringify(body)).not.toContain('sk-live-secret');
    expect(JSON.stringify(body)).not.toContain('upstream said');
  });
});

describe('POST /v1/process — provider failures', () => {
  it('returns 504 on deadline exhaustion', async () => {
    const slow = createMockProviderAdapter({ id: 'openai', latencyMs: 2_000 });
    const built = await start({ REQUEST_TIMEOUT_MS: '1000' }, [slow]);
    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: AUTH_HEADER,
      payload: { ...VALID_BODY, options: { timeout_ms: 1_000 } },
    });
    expect(response.statusCode).toBe(504);
    expect(response.json().error.code).toBe('TIMEOUT');
  });

  it('returns 422 when the model refuses', async () => {
    const refusing = createMockProviderAdapter({
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
    const built = await start({}, [refusing]);
    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: AUTH_HEADER,
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('MODEL_REFUSED');
  });

  it('returns 502 when structured output cannot be parsed', async () => {
    const messy = createMockProviderAdapter({
      id: 'openai',
      respond: () => ({
        text: 'Sure! Here is your JSON: not-really-json',
        finishReason: 'stop',
        usage: EMPTY_USAGE,
        providerRequestId: null,
        modelEcho: 'model-alpha',
        warnings: [],
      }),
    });
    const built = await start({}, [messy]);
    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: AUTH_HEADER,
      payload: { ...VALID_BODY, output: { format: 'json', schema: { type: 'object' } } },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('OUTPUT_UNPARSEABLE');
  });
});

describe('GET /v1/providers', () => {
  it('discloses capabilities without credentials', async () => {
    const { app } = await start();
    const response = await app.inject({ method: 'GET', url: '/v1/providers', headers: AUTH_HEADER });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.default_provider).toBe('openai');
    expect(body.providers).toHaveLength(3);
    expect(body.providers[0].capabilities.structured_output).toBe('json_schema_strict');
    expect(body.body ?? response.body).not.toContain('supersecret-test');
  });

  it('requires authentication', async () => {
    const { app } = await start();
    expect((await app.inject({ method: 'GET', url: '/v1/providers' })).statusCode).toBe(401);
  });
});

describe('unknown routes', () => {
  it('returns the standardised error envelope', async () => {
    const { app } = await start();
    const response = await app.inject({ method: 'GET', url: '/v2/nope' });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(typeof body.request_id).toBe('string');
  });
});
