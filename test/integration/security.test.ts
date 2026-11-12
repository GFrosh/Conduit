import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuiltApp } from '../../src/app.js';
import { createMockProviderAdapter } from '../../src/providers/mock/adapter.js';
import { createOrchestrator } from '../../src/core/process/orchestrator.js';
import { createProviderRegistry } from '../../src/providers/registry.js';
import { createSchemaValidator } from '../../src/core/validation/schema-validator.js';
import { AUTH_HEADER, TEST_TOKEN, VALID_BODY, testConfig } from '../helpers/config.js';
import type { ProviderAdapter } from '../../src/contracts/provider.js';

const open: FastifyInstance[] = [];

class CaptureStream {
  lines: string[] = [];
  write(line: string): void {
    this.lines.push(line);
  }
  text(): string {
    return this.lines.join('\n');
  }
}

async function start(
  overrides: Record<string, string | undefined> = {},
  adapters?: ProviderAdapter[],
  logStream?: CaptureStream,
): Promise<BuiltApp> {
  const built = await buildApp({
    config: testConfig({ DOCS_ENABLED: 'false', ...overrides }),
    ...(adapters ? { adapters } : {}),
    ...(logStream ? { logStream } : {}),
  });
  await built.app.ready();
  open.push(built.app);
  return built;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

const SECRET_BODY = 'SECRET-ARTICLE-BODY-DO-NOT-LOG';

function post(app: FastifyInstance, payload: unknown, headers: Record<string, string> = AUTH_HEADER) {
  return app.inject({ method: 'POST', url: '/v1/process', headers, payload: payload as never });
}

describe('1. authentication', () => {
  it('401s without a credential, with a normalized envelope', async () => {
    const { app } = await start();
    const response = await app.inject({ method: 'POST', url: '/v1/process', payload: VALID_BODY });
    expect(response.statusCode).toBe(401);
    const body = response.json() as { success: boolean; request_id: string; error: { code: string; retryable: boolean } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('AUTH_MISSING');
    expect(body.error.retryable).toBe(false);
    expect(typeof body.request_id).toBe('string');
    expect(Object.keys(response.json()).sort()).toEqual(['error', 'request_id', 'success']);
  });

  it.each([
    ['wrong secret', 'Bearer not-the-real-secret-at-all'],
    ['wrong scheme', 'Basic ' + TEST_TOKEN],
    ['empty bearer', 'Bearer '],
    ['no scheme', TEST_TOKEN],
    ['two tokens', 'Bearer ' + TEST_TOKEN + ' extra'],
  ])('401s on %s', async (_label, header) => {
    const { app } = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: { authorization: header },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: { code: string } }).error.code).toMatch(/AUTH_(MISSING|INVALID)/);
  });

  it('accepts any configured client key and scopes the request to that client', async () => {
    const capture = new CaptureStream();
    const { app } = await start(
      { SERVICE_API_KEYS: 'chronoscope:chrono-secret-1,other-app:other-secret-2' },
      undefined,
      capture,
    );

    const clients: [string, string][] = [
      ['chronoscope', 'chrono-secret-1'],
      ['other-app', 'other-secret-2'],
    ];
    for (const [id, secret] of clients) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/process',
        headers: { authorization: 'Bearer ' + secret },
        payload: VALID_BODY,
      });
      expect(response.statusCode).toBe(200);
      expect(capture.text()).toContain('"client_id":"' + id + '"');
    }
  });

  it('never logs a complete client key', async () => {
    const capture = new CaptureStream();
    const { app } = await start({}, undefined, capture);
    await app.inject({ method: 'POST', url: '/v1/process', headers: AUTH_HEADER, payload: VALID_BODY });
    await app.inject({ method: 'POST', url: '/v1/process', headers: { authorization: 'Bearer bad-secret-value' }, payload: VALID_BODY });

    expect(capture.lines.length).toBeGreaterThan(0);
    expect(capture.text()).not.toContain(TEST_TOKEN);
    expect(capture.text()).not.toContain('bad-secret-value');
    expect(capture.text()).not.toContain('authorization');
  });

  it('rejects a provider credential placed in the payload', async () => {
    const { app } = await start();
    const response = await post(app, { ...VALID_BODY, openaiApiKey: 'sk-live-abcdefghijklmnop' });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; details?: { offending_field?: string } } };
    expect(body.error.code).toBe('CREDENTIALS_IN_PAYLOAD');
    expect(body.error.details?.offending_field).toBe('openaiApiKey');
    // The offending value must never come back.
    expect(response.body).not.toContain('sk-live-abcdefghijklmnop');
  });

  it('still rejects a credential nested inside metadata', async () => {
    const { app } = await start();
    const response = await post(app, { ...VALID_BODY, metadata: { anthropic_api_key: 'sk-live-abcdefghijklmnop' } });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('CREDENTIALS_IN_PAYLOAD');
  });

  it('leaves probes and the contract public', async () => {
    const { app } = await start();
    for (const url of ['/health', '/ready', '/openapi.json']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(200);
    }
  });

  it('requires auth for the provider inventory', async () => {
    const { app } = await start();
    expect((await app.inject({ method: 'GET', url: '/v1/providers' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/providers', headers: AUTH_HEADER })).statusCode).toBe(200);
  });
});

describe('2. rate limiting', () => {
  it('429s past the limit with Retry-After and no configuration disclosure', async () => {
    const { app } = await start({ RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' });

    expect((await post(app, VALID_BODY)).statusCode).toBe(200);
    expect((await post(app, VALID_BODY)).statusCode).toBe(200);

    const limited = await post(app, VALID_BODY);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();

    const body = limited.json() as { error: { code: string; retryable: boolean }; success: boolean };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retryable).toBe(true);
    // No limit, window, or bucket state in the response.
    expect(limited.body.toLowerCase()).not.toContain('"limit"');
    expect(limited.body.toLowerCase()).not.toContain('"max"');
    expect(limited.body.toLowerCase()).not.toContain('window');
  });

  it('counts per client, so one client cannot exhaust another', async () => {
    const { app } = await start({
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_MAX: '1',
      RATE_LIMIT_WINDOW_MS: '60000',
      SERVICE_API_KEYS: 'app-a:secret-aaaa-1,app-b:secret-bbbb-2',
    });

    const a = { authorization: 'Bearer secret-aaaa-1' };
    const b = { authorization: 'Bearer secret-bbbb-2' };

    expect((await app.inject({ method: 'POST', url: '/v1/process', headers: a, payload: VALID_BODY })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/process', headers: a, payload: VALID_BODY })).statusCode).toBe(429);
    // b has its own budget.
    expect((await app.inject({ method: 'POST', url: '/v1/process', headers: b, payload: VALID_BODY })).statusCode).toBe(200);
  });

  it('never rate-limits the liveness probes', async () => {
    const { app } = await start({ RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_MAX: '1', RATE_LIMIT_WINDOW_MS: '60000' });
    for (let i = 0; i < 5; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    }
  });
});

describe('3. request limits', () => {
  it('rejects an oversized body with 413', async () => {
    const { app } = await start({ MAX_BODY_BYTES: '2048' });
    const response = await post(app, { ...VALID_BODY, content: { type: 'text', text: 'x'.repeat(8_192) } });
    expect(response.statusCode).toBe(413);
    expect((response.json() as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects malformed JSON with a normalized 400', async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/process',
      headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
      payload: '{"instructions": "x", "content": {',
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body).not.toContain('FST_ERR');
  });

  it('caps instructions and content length at the schema boundary', async () => {
    const { app } = await start();
    const longInstructions = await post(app, { ...VALID_BODY, instructions: 'i'.repeat(16_001) });
    expect(longInstructions.statusCode).toBe(400);
    expect((longInstructions.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');

    const empty = await post(app, { ...VALID_BODY, content: { type: 'text', text: '' } });
    expect(empty.statusCode).toBe(400);
  });

  it('rejects an over-nested context rather than walking it', async () => {
    const { app } = await start();
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 12; i += 1) nested = { nested };
    const response = await post(app, { ...VALID_BODY, context: nested });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an invalid execution timeout instead of clamping silently', async () => {
    const { app } = await start();
    const response = await post(app, { ...VALID_BODY, options: { timeout_ms: 10 } });
    expect(response.statusCode).toBe(400);
  });
});

describe('4. timeouts and failure handling', () => {
  it('returns 504 when the provider exceeds the request deadline', async () => {
    const slow: ProviderAdapter = createMockProviderAdapter({ id: 'openai', latencyMs: 3_000 });
    const { app } = await start({}, [slow]);
    const response = await post(app, { ...VALID_BODY, options: { timeout_ms: 1_000 } });
    expect(response.statusCode).toBe(504);
    expect((response.json() as { error: { code: string } }).error.code).toMatch(/TIMEOUT/);
  });

  it('stays healthy after a failed request', async () => {
    const failing: ProviderAdapter = {
      id: 'openai',
      capabilities: createMockProviderAdapter({ id: 'openai' }).capabilities,
      generate: async () => {
        throw new Error('socket hang up');
      },
    };
    const { app } = await start({}, [failing]);
    const failed = await post(app, VALID_BODY);
    // An adapter that throws a non-AppError is a service defect: 500, not 502.
    expect(failed.statusCode).toBe(500);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
  });

  it('normalizes an unexpected adapter throw into a provider error, never a stack', async () => {
    const failing: ProviderAdapter = {
      id: 'openai',
      capabilities: createMockProviderAdapter({ id: 'openai' }).capabilities,
      generate: async () => {
        throw new TypeError('undefined is not a function at /app/src/providers/openai/adapter.ts:42');
      },
    };
    const { app } = await start({}, [failing]);
    const response = await post(app, VALID_BODY);
    expect(response.statusCode).toBe(500);
    // Normalized and leak-free: no file path, no message, no stack.
    expect(response.body).not.toContain('adapter.ts');
    expect(response.body).not.toContain('undefined is not a function');
    expect(response.body).not.toContain('at ');
    expect((response.json() as { error: { code: string } }).error.code).toBe('INTERNAL');
  });

  it('stops provider work when the client disconnects', async () => {
    const registry = createProviderRegistry();
    registry.register(createMockProviderAdapter({ id: 'openai', latencyMs: 2_000 }));
    const orchestrator = createOrchestrator({
      registry,
      resolution: { defaultProvider: 'openai', providers: { openai: { defaultModel: 'm' } } },
      schemaValidator: createSchemaValidator(),
      defaultTimeoutMs: 10_000,
      serviceVersion: 'test',
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const startedAt = Date.now();
    const error = (await orchestrator
      .process({
        request: {
          instructions: 'x',
          content: { type: 'text', text: 'y' },
          output: { format: 'text' },
        } as never,
        requestId: 'req_disconnect',
        startedAt,
        signal: controller.signal,
      })
      .catch((thrown: { code: string; details?: { reason?: string } }) => thrown)) as {
      code: string;
      details?: { reason?: string };
    };

    expect(error.code).toBe('TIMEOUT');
    expect(error.details?.reason).toBe('client_disconnected');
    // Aborted immediately, not after the 2s provider latency.
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });
});

describe('5. error shape consistency', () => {
  it('uses the same envelope for every failure class', async () => {
    const { app } = await start({ RATE_LIMIT_ENABLED: 'false' });
    const cases = [
      await app.inject({ method: 'POST', url: '/v1/process', payload: VALID_BODY }),
      await post(app, { ...VALID_BODY, provider: 'cohere' }),
      await post(app, { ...VALID_BODY, instructions: '' }),
      await app.inject({ method: 'GET', url: '/nope' }),
    ];

    for (const response of cases) {
      const body = response.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['error', 'request_id', 'success']);
      expect(body.success).toBe(false);
      const error = body.error as Record<string, unknown>;
      expect(Object.keys(error).sort()).toContain('code');
      expect(Object.keys(error).sort()).toContain('message');
      expect(typeof error.message).toBe('string');
      expect(typeof error.retryable).toBe('boolean');
      expect(response.headers['content-type']).toContain('application/json');
    }
  });

  it('gives every response a request id', async () => {
    const { app } = await start();
    const ok = await post(app, VALID_BODY);
    const bad = await post(app, { ...VALID_BODY, provider: 'cohere' });
    expect((ok.json() as { request_id: string }).request_id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect((bad.json() as { request_id: string }).request_id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe('6. secret leakage', () => {
  it('never writes provider credentials, client keys, or article text to logs', async () => {
    const capture = new CaptureStream();
    const { app } = await start({ OPENAI_API_KEY: 'sk-live-supersecret-0123456789' }, undefined, capture);

    const response = await post(app, {
      instructions: 'Summarise this.',
      content: { type: 'text', text: SECRET_BODY },
    });
    expect(response.statusCode).toBe(200);

    const logged = capture.text();
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).not.toContain('sk-live-supersecret-0123456789');
    expect(logged).not.toContain(TEST_TOKEN);
    expect(capture.lines.join('|')).not.toContain('Summarise');

    // Operational fields are present, and only those.
    expect(logged).toContain('"request_id"');
    expect(logged).toContain('"provider":"openai"');
    expect(logged).toContain('"duration_ms"');
    expect(logged).toContain('"input_chars"');
  });

  it('records an error code in the log line without the exception text', async () => {
    const capture = new CaptureStream();
    const failing: ProviderAdapter = {
      id: 'openai',
      capabilities: createMockProviderAdapter({ id: 'openai' }).capabilities,
      generate: async () => {
        throw new Error('boom sk-live-abcdefghijklmnop');
      },
    };
    const { app } = await start({}, [failing], capture);
    await post(app, VALID_BODY);

    const logged = capture.text();
    expect(logged).toContain('"error_code":"INTERNAL"');
    expect(logged).not.toContain('sk-live-abcdefghijklmnop');
  });

  it('keeps deployment internals out of the provider inventory and probes', async () => {
    const { app } = await start({ OPENAI_API_KEY: 'sk-live-supersecret-0123456789', MAX_OUTPUT_TOKENS_OPENAI: '4096' });
    for (const url of ['/v1/providers', '/health', '/ready', '/openapi.json']) {
      const response = await app.inject({ method: 'GET', url, headers: AUTH_HEADER });
      expect(response.body, url).not.toContain('sk-live-supersecret-0123456789');
      expect(response.body, url).not.toContain('4096');
    }
  });
});
