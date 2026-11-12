import { describe, expect, it } from 'vitest';
import { planCandidates, type FallbackConfig } from '../../src/core/process/fallback.js';
import { createOrchestrator, canFailover } from '../../src/core/process/orchestrator.js';
import { createProviderRegistry } from '../../src/providers/registry.js';
import { createMockProviderAdapter } from '../../src/providers/mock/adapter.js';
import { createSchemaValidator } from '../../src/core/validation/schema-validator.js';
import { AppError } from '../../src/core/errors/AppError.js';
import { EMPTY_USAGE } from '../../src/contracts/common.js';
import type { ProcessingRequest } from '../../src/contracts/request.js';

const RESOLUTION = {
  defaultProvider: 'openai',
  providers: {
    openai: { defaultModel: 'model-openai' },
    anthropic: { defaultModel: 'model-anthropic' },
    gemini: { defaultModel: 'model-gemini' },
  },
};

const OFF: FallbackConfig = { enabled: false, providers: [], maxAttempts: 1 };
const ON: FallbackConfig = { enabled: true, providers: ['anthropic', 'gemini'], maxAttempts: 2 };

function request(overrides: Partial<ProcessingRequest> = {}): ProcessingRequest {
  return {
    instructions: 'Summarise the article.',
    content: { type: 'text', text: 'Body.' },
    output: { format: 'text' },
    ...overrides,
  } as ProcessingRequest;
}

function registryWith(...ids: ('openai' | 'anthropic' | 'gemini')[]) {
  const registry = createProviderRegistry();
  for (const id of ids) registry.register(createMockProviderAdapter({ id }));
  return registry;
}

describe('fallback planning', () => {
  it('plans exactly one candidate when the request does not opt in', () => {
    const plan = planCandidates({
      request: request({ provider: 'openai' }),
      resolution: RESOLUTION,
      registry: registryWith('openai', 'anthropic'),
      fallback: ON,
    });
    expect(plan.candidates).toHaveLength(1);
    expect(plan.fallbackEnabled).toBe(false);
  });

  it('rejects an explicit fallback when the deployment disables it', () => {
    expect(() =>
      planCandidates({
        request: request({ provider: 'openai', fallback: { enabled: true, providers: ['anthropic'] } }),
        resolution: RESOLUTION,
        registry: registryWith('openai', 'anthropic'),
        fallback: OFF,
      }),
    ).toThrow(AppError);
  });

  it('refuses a policy that lists the primary provider as its own fallback', () => {
    try {
      planCandidates({
        request: request({ provider: 'openai', fallback: { enabled: true, providers: ['openai'] } }),
        resolution: RESOLUTION,
        registry: registryWith('openai'),
        fallback: ON,
      });
      throw new Error('expected FALLBACK_INVALID');
    } catch (error) {
      expect((error as AppError).code).toBe('FALLBACK_INVALID');
      expect(JSON.stringify((error as AppError).details)).toContain('must not also appear');
    }
  });

  it('orders candidates primary-first and caps the list at maxAttempts', () => {
    const plan = planCandidates({
      request: request({ provider: 'openai', fallback: { enabled: true, providers: ['gemini', 'anthropic'] } }),
      resolution: RESOLUTION,
      registry: registryWith('openai', 'anthropic', 'gemini'),
      fallback: { enabled: true, providers: [], maxAttempts: 2 },
    });
    expect(plan.candidates.map((entry) => entry.provider)).toEqual(['openai', 'gemini']);
  });

  it('skips a fallback provider that is not configured instead of pretending it exists', () => {
    const plan = planCandidates({
      request: request({ provider: 'openai', fallback: { enabled: true, providers: ['gemini', 'anthropic'] } }),
      resolution: RESOLUTION,
      registry: registryWith('openai', 'anthropic'),
      fallback: ON,
    });
    expect(plan.candidates.map((candidate) => candidate.provider)).toEqual(['openai', 'anthropic']);
  });

  it('honours a per-provider model override', () => {
    const plan = planCandidates({
      request: request({
        provider: 'openai',
        fallback: { enabled: true, providers: ['anthropic'], model_overrides: { anthropic: 'override-model' } },
      }),
      resolution: RESOLUTION,
      registry: registryWith('openai', 'anthropic'),
      fallback: ON,
    });
    expect(plan.candidates[1]?.model).toBe('override-model');
  });
});

describe('fallback execution', () => {
  function build(fallback: FallbackConfig, failing: ('openai' | 'anthropic')[]) {
    const registry = createProviderRegistry();
    for (const id of ['openai', 'anthropic'] as const) {
      registry.register(
        createMockProviderAdapter({
          id,
          respond: failing.includes(id)
            ? () => {
                throw new AppError('PROVIDER_UNAVAILABLE');
              }
            : () => ({
                text: `answered by ${id}`,
                finishReason: 'stop',
                usage: EMPTY_USAGE,
                providerRequestId: null,
                modelEcho: `model-${id}`,
                warnings: [],
              }),
        }),
      );
    }
    return createOrchestrator({
      registry,
      resolution: RESOLUTION,
      schemaValidator: createSchemaValidator(),
      defaultTimeoutMs: 5_000,
      serviceVersion: 'test',
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, minAttemptMs: 1 },
      fallback,
    });
  }

  it('reports the provider that actually processed the request', async () => {
    const orchestrator = build({ enabled: true, providers: ['anthropic'], maxAttempts: 2 }, ['openai']);
    const response = await orchestrator.process({
      request: request({ provider: 'openai', fallback: { enabled: true, providers: ['anthropic'] } }),
      requestId: 'req_fb_1',
      startedAt: Date.now(),
    });
    expect(response.provider).toBe('anthropic');
    expect(response.meta.fallback_used).toBe(true);
    expect(response.meta.warnings.map((warning) => warning.code)).toContain('FALLBACK_USED');
    expect(response.result).toEqual({ type: 'text', text: 'answered by anthropic' });
  });

  it('never replaces an explicit provider when no fallback was requested', async () => {
    const orchestrator = build({ enabled: true, providers: ['anthropic'], maxAttempts: 2 }, ['openai']);
    await expect(
      orchestrator.process({ request: request({ provider: 'openai' }), requestId: 'req_fb_2', startedAt: Date.now() }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('stops after the bounded candidate list instead of walking every provider', async () => {
    const orchestrator = build({ enabled: true, providers: ['anthropic'], maxAttempts: 2 }, ['openai', 'anthropic']);
    const error = (await orchestrator
      .process({
        request: request({ provider: 'openai', fallback: { enabled: true, providers: ['anthropic'] } }),
        requestId: 'req_fb_3',
        startedAt: Date.now(),
      })
      .catch((thrown: AppError) => thrown)) as AppError & { attempts?: unknown[] };
    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.attempts).toHaveLength(2);
  });

  it('does not fail over on a deterministic client-side verdict', async () => {
    expect(canFailover(new AppError('VALIDATION_FAILED'))).toBe(false);
    expect(canFailover(new AppError('OPTION_UNSUPPORTED'))).toBe(false);
    expect(canFailover(new AppError('INVALID_JSON_SCHEMA'))).toBe(false);
    expect(canFailover(new AppError('PROVIDER_UNAVAILABLE'))).toBe(true);
    expect(canFailover(new AppError('MODEL_REFUSED'))).toBe(true);
  });
});
