import { AppError } from '../core/errors/AppError.js';
import type { ProviderId } from '../contracts/common.js';
import type { ProviderAdapter } from '../contracts/provider.js';
import type { AppConfig, ProviderRuntimeConfig } from '../config/env.js';
import { createMockProviderAdapter } from './mock/adapter.js';
import { createOpenAIAdapter } from './openai/adapter.js';
import { createAnthropicAdapter } from './anthropic/adapter.js';
import { createGeminiAdapter } from './gemini/adapter.js';

/**
 * The only place in the service that knows concrete adapters exist.
 * Everything downstream receives ProviderAdapter and cannot tell them apart.
 */
export function createAdapters(config: AppConfig): ProviderAdapter[] {
  if (config.providerMode === 'mock') {
    return config.enabledProviders.map((id: ProviderId) => createMockProviderAdapter({ id }));
  }

  return config.providers.map((entry: ProviderRuntimeConfig) => createLiveAdapter(entry));
}

function createLiveAdapter(entry: ProviderRuntimeConfig): ProviderAdapter {
  if (!entry.apiKey) {
    throw new AppError('PROVIDER_NOT_CONFIGURED', undefined, {
      details: { provider: entry.id, reason: 'missing credential' },
    });
  }

  switch (entry.id) {
    case 'openai':
      return createOpenAIAdapter({
        apiKey: entry.apiKey,
        maxOutputTokens: entry.maxOutputTokens ?? 16_384,
      });
    case 'anthropic':
      return createAnthropicAdapter({
        apiKey: entry.apiKey,
        defaultMaxTokens: entry.maxOutputTokens ?? 8_192,
      });
    case 'gemini':
      return createGeminiAdapter({
        apiKey: entry.apiKey,
        maxOutputTokens: entry.maxOutputTokens ?? 8_192,
      });
    default: {
      const exhaustive: never = entry.id;
      throw new AppError('PROVIDER_UNKNOWN', undefined, { details: { provider: exhaustive } });
    }
  }
}
