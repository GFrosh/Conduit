import type { FastifyInstance } from 'fastify';
import { buildRequestLogLine, sampleFor, type LogContext } from '../../core/observability/request-log.js';

export interface RequestLoggerOptions {
  logContent: boolean;
  logInstructions: boolean;
  sampleRate: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    logContext?: LogContext;
    logShape?: { instructionsChars: number; contentChars: number; contextChars: number };
    logInstructions?: string;
    logContent?: string;
  }
}

/**
 * One structured line per request. Registered as `onResponse` so it fires for
 * successes, thrown errors, and rate-limited rejections alike.
 */
export function registerRequestLogger(app: FastifyInstance, options: RequestLoggerOptions): void {
  app.addHook('onResponse', async (request, reply) => {
    const sampled = options.sampleRate > 0 && Math.random() < options.sampleRate;

    const line = buildRequestLogLine({
      requestId: request.requestId || '',
      ...(request.identity ? { clientId: request.identity.keyId } : {}),
      method: request.method,
      route: request.routeOptions?.url ?? request.url.split('?')[0] ?? request.url,
      statusCode: reply.statusCode,
      durationMs: Math.max(0, Math.round(reply.elapsedTime)),
      context: request.logContext ?? {},
      ...(request.logShape
        ? {
            instructionsChars: request.logShape.instructionsChars,
            contentChars: request.logShape.contentChars,
            contextChars: request.logShape.contextChars,
          }
        : {}),
      ...(request.logInstructions
        ? { instructionsSample: sampleFor(request.logInstructions, options.logInstructions, sampled) }
        : {}),
      ...(request.logContent
        ? { contentSample: sampleFor(request.logContent, options.logContent, sampled) }
        : {}),
    });

    if (line.status >= 500) request.log.error(line, line.msg);
    else if (line.status >= 400) request.log.warn(line, line.msg);
    else request.log.info(line, line.msg);
  });
}
