import type { FastifyPluginAsync } from 'fastify';
import type { ProviderRegistry } from '../../contracts/provider.js';
import type { ProviderResolutionConfig } from '../../core/process/resolveProvider.js';

export interface ProvidersRouteOptions {
  registry: ProviderRegistry;
  resolution: ProviderResolutionConfig;
}

/**
 * Capability disclosure only. No keys, no base URLs, no SDK versions.
 * This is what lets a client discover WHY a request failed instead of guessing.
 */
export const providersRoutes: FastifyPluginAsync<ProvidersRouteOptions> = async (app, options) => {
  app.get('/v1/providers', async () => ({
    default_provider: options.resolution.defaultProvider,
    providers: options.registry.list().map((adapter) => {
      const settings = options.resolution.providers[adapter.id];
      return {
        id: adapter.id,
        default_model: settings?.defaultModel ?? null,
        allowed_models: settings?.allowedModels ?? null,
        capabilities: {
          structured_output: adapter.capabilities.structuredOutput,
          supported_options: [...adapter.capabilities.supportedOptions],
          unenforced_schema_keywords: [...adapter.capabilities.unenforcedSchemaKeywords],
          supports_system_channel: adapter.capabilities.supportsSystemChannel,
          max_output_tokens: adapter.capabilities.maxOutputTokens,
        },
      };
    }),
  }));
};
