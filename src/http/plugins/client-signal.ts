import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Aborted when the client disconnects, so abandoned provider calls stop. */
    clientSignal?: AbortSignal;
  }
}

/**
 * Client-disconnect propagation.
 *
 * Uses the request's `aborted` event so a normally completed request body is
 * not mistaken for a disconnected client. The listener is removed on response
 * completion to avoid retaining the request.
 */
export function registerClientSignal(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const controller = new AbortController();
    request.clientSignal = controller.signal;

    const onAborted = (): void => controller.abort();
    request.raw.once('aborted', onAborted);

    reply.raw.once('finish', () => request.raw.off('aborted', onAborted));
  });
}
