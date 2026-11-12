import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { loadConfig, type AppConfig } from './config/env.js';
import { buildLoggerOptions, type LogStream } from './core/observability/logger.js';
import { createOrchestrator, type Orchestrator } from './core/process/orchestrator.js';
import { createSchemaValidator } from './core/validation/schema-validator.js';
import { createProviderRegistry } from './providers/registry.js';
import { createAdapters } from './providers/factory.js';
import { registerRequestContext } from './http/plugins/request-context.js';
import { registerClientSignal } from './http/plugins/client-signal.js';
import { registerCredentialGuard } from './http/plugins/credential-guard.js';
import { registerRateLimit } from './http/plugins/rate-limit.js';
import { registerRequestLogger } from './http/plugins/request-logger.js';
import { registerErrorHandler } from './http/plugins/error-handler.js';
import { healthRoutes } from './http/routes/health.route.js';
import { processRoutes } from './http/routes/process.route.js';
import { providersRoutes } from './http/routes/providers.route.js';
import { openApiRoutes } from './http/routes/openapi.route.js';
import { docsRoutes } from './http/routes/docs.route.js';
import type { ProviderAdapter, ProviderRegistry } from './contracts/provider.js';
import type { ProviderResolutionConfig } from './core/process/resolveProvider.js';

export interface BuildAppOptions {
  config?: AppConfig;
  /** Injected adapters (tests, or live adapters in a later phase). */
  adapters?: ProviderAdapter[];
  env?: Record<string, string | undefined>;
  /** Capture destination for structured logs (tests, or a custom sink). */
  logStream?: LogStream;
}

export interface BuiltApp {
  app: FastifyInstance;
  config: AppConfig;
  registry: ProviderRegistry;
  orchestrator: Orchestrator;
  resolution: ProviderResolutionConfig;
}

/** Never authenticated: probes and the public contract. */
const PUBLIC_PATHS = ['/health', '/ready', '/openapi.json'];

export function buildResolutionConfig(config: AppConfig): ProviderResolutionConfig {
  const providers: ProviderResolutionConfig['providers'] = {};
  for (const entry of config.providers) {
    providers[entry.id] = {
      ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
    };
  }
  return { defaultProvider: config.defaultProvider, providers };
}

/**
 * Composition root. The only place that decides which adapters exist for which
 * provider ids; everything downstream sees the port.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const config = options.config ?? loadConfig(options.env ?? process.env);

  const app = Fastify({
    logger: buildLoggerOptions(config, options.logStream),
    bodyLimit: config.maxBodyBytes,
    // One structured line per request is emitted by our own hook; Fastify's
    // built-in request/response lines would duplicate it.
    disableRequestLogging: true,
    trustProxy: false,
    // Keep-alive is bounded so a client cannot hold an idle socket forever.
    keepAliveTimeout: 72_000,
    connectionTimeout: 30_000,
    requestTimeout: config.requestTimeoutMs + 5_000,
    ajv: { customOptions: { allErrors: false } },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const registry = createProviderRegistry();
  for (const adapter of options.adapters ?? createAdapters(config)) {
    registry.register(adapter);
  }

  const resolution = buildResolutionConfig(config);
  const schemaValidator = createSchemaValidator();

  const orchestrator = createOrchestrator({
    registry,
    resolution,
    schemaValidator,
    defaultTimeoutMs: config.requestTimeoutMs,
    serviceVersion: config.serviceVersion,
    fallback: config.fallback,
  });

  // Order matters: identity → client signal → credential rejection → rate limit.
  // Rate limiting keys off the authenticated client, so it must come after auth.
  registerRequestContext(app, { enabled: config.auth.enabled, keys: config.auth.keys }, PUBLIC_PATHS);
  registerClientSignal(app);
  registerCredentialGuard(app);
  // Must be installed before routes: encapsulated contexts inherit the handler
  // that exists at registration time, not the one set afterwards.
  registerErrorHandler(app);
  await registerRateLimit(app, config.rateLimit);
  registerRequestLogger(app, {
    logContent: config.logging.content,
    logInstructions: config.logging.instructions,
    sampleRate: config.logging.sampleRate,
  });

  const startedAt = Date.now();
  await app.register(healthRoutes, {
    serviceVersion: config.serviceVersion,
    startedAt,
    readyCheck: () => {
      const count = registry.list().length;
      if (count === 0) return { ready: false, providers: 0, reason: 'no_providers_registered' };
      if (!registry.has(config.defaultProvider)) {
        return { ready: false, providers: count, reason: 'default_provider_unavailable' };
      }
      return { ready: true, providers: count };
    },
  });

  await app.register(openApiRoutes, {
    version: config.serviceVersion,
    ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
  });

  await app.register(providersRoutes, { registry, resolution });
  await app.register(processRoutes, { orchestrator });

  // Interactive docs are a development affordance, not a production surface.
  if (config.docs.enabled) {
    await app.register(docsRoutes, { version: config.serviceVersion, routePrefix: '/docs' });
  }

  return { app, config, registry, orchestrator, resolution };
}
