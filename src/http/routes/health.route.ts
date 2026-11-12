import type { FastifyPluginAsync } from 'fastify';

export interface HealthRouteOptions {
  serviceVersion: string;
  startedAt: number;
  readyCheck: () => { ready: boolean; providers: number; reason?: string };
}

/**
 * Liveness and readiness. Deliberately exposes no environment values, no
 * credentials, no hostnames, no provider endpoint details.
 */
export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (app, options) => {
  app.get('/health', async () => ({
    status: 'ok',
    version: options.serviceVersion,
    uptime_s: Math.max(0, Math.floor((Date.now() - options.startedAt) / 1000)),
  }));

  app.get('/ready', async (_request, reply) => {
    const check = options.readyCheck();
    const body = {
      status: check.ready ? 'ready' : 'not_ready',
      version: options.serviceVersion,
      checks: {
        providers_registered: check.providers,
        ...(check.reason ? { reason: check.reason } : {}),
      },
    };
    return reply.status(check.ready ? 200 : 503).send(body);
  });
};
