import type { FastifyPluginAsync } from 'fastify';
import { buildOpenApiDocument } from '../../contracts/openapi.js';

export interface OpenApiRouteOptions {
  version: string;
  /** Absolute base URL advertised in `servers`, when the operator set one. */
  publicBaseUrl?: string;
}

/**
 * The machine-readable contract, served unauthenticated so a consumer can
 * generate a client before holding a key. It contains no deployment secrets:
 * provider credentials, endpoints and token ceilings are never in the document.
 */
export const openApiRoutes: FastifyPluginAsync<OpenApiRouteOptions> = async (app, options) => {
  const document = buildOpenApiDocument({
    version: options.version,
    ...(options.publicBaseUrl ? { serverUrl: options.publicBaseUrl } : {}),
  });

  app.get('/openapi.json', { schema: { hide: true } }, async (_request, reply) => {
    return reply
      .header('cache-control', 'public, max-age=300')
      .type('application/json; charset=utf-8')
      .send(document);
  });
};
