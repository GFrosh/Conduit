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
 * Uses the raw socket's `close` event because `request.raw.on('aborted')` is
 * deprecated and does not fire for every HTTP/2 or keep-alive teardown. The
 * listener is removed on response completion to avoid retaining the request.
 */
export function registerClientSignal(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const controller = new AbortController();
    request.clientSignal = controller.signal;

    const onClose = (): void => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    request.raw.once('close', onClose);

    reply.raw.once('finish', () => request.raw.off('close', onClose));
  });
}
