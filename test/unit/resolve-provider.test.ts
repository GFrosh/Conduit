import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors/AppError.js';
import { resolveProvider, type ProviderResolutionConfig } from '../../src/core/process/resolveProvider.js';
import { createProviderRegistry } from '../../src/providers/registry.js';
import { createMockProviderAdapter } from '../../src/providers/mock/adapter.js';

const resolution: ProviderResolutionConfig = {
  defaultProvider: 'openai',
  providers: {
    openai: { defaultModel: 'model-alpha' },
    anthropic: { defaultModel: 'model-beta' },
    gemini: { defaultModel: 'model-gamma', allowedModels: ['model-gamma'] },
  },
};

function registryWith(ids: ('openai' | 'anthropic' | 'gemini')[]) {
  const registry = createProviderRegistry();
  for (const id of ids) registry.register(createMockProviderAdapter({ id }));
  return registry;
}

const fullRegistry = () => registryWith(['openai', 'anthropic', 'gemini']);

function expectCode(fn: () => unknown, code: string): AppError {
  try {
    fn();
  } catch (error) {
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }
  throw new Error(`expected ${code}`);
}

describe('provider resolution', () => {
  it('uses the explicit provider over the default', () => {
    expect(resolveProvider({ provider: 'anthropic' }, resolution, fullRegistry()).provider).toBe('anthropic');
  });

  it('falls back to the configured default provider', () => {
    expect(resolveProvider({}, resolution, fullRegistry()).provider).toBe('openai');
  });

  it('uses the explicit model over the provider default', () => {
    const target = resolveProvider({ provider: 'openai', model: 'explicit-model' }, resolution, fullRegistry());
    expect(target.model).toBe('explicit-model');
  });

  it('uses the default model configured for the resolved provider', () => {
    expect(resolveProvider({ provider: 'anthropic' }, resolution, fullRegistry()).model).toBe('model-beta');
  });

  it('rejects an unknown provider id', () => {
    const error = expectCode(() => resolveProvider({ provider: 'cohere' }, resolution, fullRegistry()), 'PROVIDER_UNKNOWN');
    expect(error.status).toBe(400);
    expect((error.details as { known: string[] }).known).toEqual(['openai', 'anthropic', 'gemini']);
  });

  it('rejects a known but unavailable provider without substituting another', () => {
    const registry = registryWith(['openai']);
    const error = expectCode(() => resolveProvider({ provider: 'gemini' }, resolution, registry), 'PROVIDER_NOT_CONFIGURED');
    expect(error.status).toBe(503);
    expect((error.details as { available: string[] }).available).toEqual(['openai']);
  });

  it('never silently substitutes when the default provider is unavailable', () => {
    const registry = registryWith(['anthropic']);
    expectCode(() => resolveProvider({}, resolution, registry), 'PROVIDER_NOT_CONFIGURED');
  });

  it('requires a model when none is configured', () => {
    const noDefault: ProviderResolutionConfig = { defaultProvider: 'openai', providers: { openai: {} } };
    const error = expectCode(() => resolveProvider({}, noDefault, fullRegistry()), 'MODEL_REQUIRED');
    expect(error.status).toBe(400);
  });

  it('accepts an explicit model even when no default is configured', () => {
    const noDefault: ProviderResolutionConfig = { defaultProvider: 'openai', providers: { openai: {} } };
    expect(resolveProvider({ model: 'chosen' }, noDefault, fullRegistry()).model).toBe('chosen');
  });

  it('enforces the model allowlist', () => {
    expectCode(() => resolveProvider({ provider: 'gemini', model: 'expensive' }, resolution, fullRegistry()), 'MODEL_NOT_ALLOWED');
    expect(resolveProvider({ provider: 'gemini', model: 'model-gamma' }, resolution, fullRegistry()).model).toBe('model-gamma');
  });

  it('ignores whitespace-only configured models', () => {
    const blank: ProviderResolutionConfig = { defaultProvider: 'openai', providers: { openai: { defaultModel: '  ' } } };
    expectCode(() => resolveProvider({}, blank, fullRegistry()), 'MODEL_REQUIRED');
  });
});
