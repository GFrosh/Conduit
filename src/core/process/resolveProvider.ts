import { AppError } from '../errors/AppError.js';
import { PROVIDER_IDS, isProviderId, type ProviderId } from '../../contracts/common.js';
import type { ProviderAdapter, ProviderRegistry } from '../../contracts/provider.js';
/**
 * The minimum a caller must supply to resolve a target. ProcessingRequest
 * satisfies it structurally, so callers never need a cast.
 */
export interface ProviderSelection {
  provider?: string;
  model?: string;
}

export interface ProviderSettings {
  defaultModel?: string;
  allowedModels?: readonly string[];
}

export interface ProviderResolutionConfig {
  defaultProvider: string;
  providers: Partial<Record<ProviderId, ProviderSettings>>;
}

export interface ResolvedTarget {
  provider: ProviderId;
  model: string;
  adapter: ProviderAdapter;
}

/**
 * Deterministic resolution:
 *   provider precedence: explicit request → configured default
 *   model precedence:    explicit request → provider's configured default
 * An explicitly requested provider is never substituted.
 */
export function resolveProvider(
  request: ProviderSelection,
  config: ProviderResolutionConfig,
  registry: ProviderRegistry,
): ResolvedTarget {
  const requestedProvider = request.provider;

  if (requestedProvider !== undefined && !isProviderId(requestedProvider)) {
    throw new AppError('PROVIDER_UNKNOWN', undefined, {
      details: { requested: requestedProvider, known: [...PROVIDER_IDS] },
    });
  }

  const providerId: ProviderId = requestedProvider ?? (config.defaultProvider as ProviderId);

  const adapter = registry.get(providerId);
  if (!adapter) {
    // Known provider, not enabled in this deployment → 503. Never fall back.
    throw new AppError('PROVIDER_NOT_CONFIGURED', undefined, {
      details: {
        provider: providerId,
        available: registry.list().map((item) => item.id),
      },
    });
  }

  const settings = config.providers[providerId];
  const configuredModel = settings?.defaultModel?.trim();
  const model = request.model ?? (configuredModel ? configuredModel : undefined);

  if (!model) {
    throw new AppError('MODEL_REQUIRED', undefined, { details: { provider: providerId } });
  }

  const allowlist = settings?.allowedModels;
  if (allowlist && allowlist.length > 0 && !allowlist.includes(model)) {
    throw new AppError('MODEL_NOT_ALLOWED', undefined, {
      details: { provider: providerId, model },
    });
  }

  return { provider: providerId, model, adapter };
}
