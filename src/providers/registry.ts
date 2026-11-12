import { AppError } from '../core/errors/AppError.js';
import type { ProviderId } from '../contracts/common.js';
import type { ProviderAdapter, ProviderRegistry } from '../contracts/provider.js';

export function createProviderRegistry(): ProviderRegistry {
  const adapters = new Map<ProviderId, ProviderAdapter>();

  return {
    register(adapter) {
      if (adapters.has(adapter.id)) {
        throw new AppError('INTERNAL', `Provider '${adapter.id}' is already registered.`);
      }
      adapters.set(adapter.id, adapter);
    },
    has(id) {
      return adapters.has(id as ProviderId);
    },
    get(id) {
      return adapters.get(id as ProviderId);
    },
    require(id) {
      const adapter = adapters.get(id as ProviderId);
      if (!adapter) {
        throw new AppError('PROVIDER_UNKNOWN', undefined, {
          details: { requested: id, known: [...adapters.keys()] },
        });
      }
      return adapter;
    },
    list() {
      return [...adapters.values()];
    },
  };
}
