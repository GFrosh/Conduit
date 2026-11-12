import type { FastifyPluginAsync } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { buildOpenApiDocument } from '../../contracts/openapi.js';

export interface DocsRouteOptions {
  version: string;
  routePrefix: string;
}

/**
 * Human-readable documentation. Registered from a static document rather than a
 * transform of live route schemas, so what is published is exactly the reviewed
 * contract file — no accidental exposure of internal route shapes.
 */
export const docsRoutes: FastifyPluginAsync<DocsRouteOptions> = async (app, options) => {
  await app.register(swagger, {
    mode: 'static',
    specification: {
      document: buildOpenApiDocument({ version: options.version }) as never,
    },
  });

  await app.register(swaggerUi, {
    routePrefix: options.routePrefix,
    uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: true },
    staticCSP: true,
  });
};
