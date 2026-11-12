import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError } from '../../core/errors/AppError.js';
import { checkContextBudget } from '../../core/validation/context-budget.js';
import { processingRequestSchema } from '../../contracts/request.js';
import {
  processingErrorResponseSchema,
  processingSuccessResponseSchema,
} from '../../contracts/response.js';
import { presentSuccess } from '../presenters/response.presenter.js';
import type { Orchestrator } from '../../core/process/orchestrator.js';

export interface ProcessRouteOptions {
  orchestrator: Orchestrator;
}

export const processRoutes: FastifyPluginAsync<ProcessRouteOptions> = async (app, options) => {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.post(
    '/v1/process',
    {
      schema: {
        summary: 'Execute a provider-agnostic AI processing task',
        description:
          'Runs the supplied instructions over the supplied content using the resolved provider. ' +
          'The service contains no application-specific prompts: everything task-related arrives in the request.',
        body: processingRequestSchema,
        response: {
          200: processingSuccessResponseSchema,
          400: processingErrorResponseSchema,
          401: processingErrorResponseSchema,
          413: processingErrorResponseSchema,
          422: processingErrorResponseSchema,
          429: processingErrorResponseSchema,
          500: processingErrorResponseSchema,
          502: processingErrorResponseSchema,
          503: processingErrorResponseSchema,
          504: processingErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const budget = checkContextBudget(request.body.context);
      if (budget) {
        throw new AppError('VALIDATION_FAILED', undefined, {
          details: {
            reason: `context exceeds the allowed ${budget.reason} budget`,
            depth: budget.depth,
            keys: budget.keys,
          },
        });
      }

      // Shape only by default: lengths prove the payload arrived and was bounded
      // without recording a single character of the article.
      request.logShape = {
        instructionsChars: request.body.instructions.length,
        contentChars: request.body.content.text.length,
        contextChars:
          typeof request.body.context === 'string'
            ? request.body.context.length
            : request.body.context
              ? JSON.stringify(request.body.context).length
              : 0,
      };
      // Held on the request but only emitted when the operator opted in AND the
      // sampling decision selected this request (see request-logger.ts).
      request.logInstructions = request.body.instructions;
      request.logContent = request.body.content.text;

      const startedAt = Date.now();
      const result = await options.orchestrator.process({
        request: request.body,
        requestId: request.requestId,
        startedAt,
        ...(request.clientSignal ? { signal: request.clientSignal } : {}),
      });

      request.logContext = {
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        attempts: result.meta.attempts.length,
        fallbackUsed: result.meta.fallback_used,
        finishReason: result.meta.finish_reason,
      };

      return presentSuccess(result);
    },
  );
};
