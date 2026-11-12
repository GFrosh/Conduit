import { performance } from 'node:perf_hooks';
import { toAppError, AppError } from '../errors/AppError.js';
import { buildPrompt } from '../prompt/buildPrompt.js';
import { negotiateOptions } from './negotiateOptions.js';
import { normalizeResponse } from './normalizeResponse.js';
import { planCandidates, type FallbackConfig } from './fallback.js';
import type { ProviderResolutionConfig } from './resolveProvider.js';
import { DEFAULT_RETRY_POLICY, executeWithRetry, type RetryPolicy } from './retry.js';
import type { SchemaValidator } from '../validation/schema-validator.js';
import { EMPTY_USAGE, type ErrorCode, type Warning } from '../../contracts/common.js';
import type { ProviderRegistry } from '../../contracts/provider.js';
import type { GenerationResponse, NormalizedGenerationOptions } from '../../contracts/generation.js';
import type { ProcessingRequest } from '../../contracts/request.js';
import type { AttemptSummary, ProcessingSuccessResponse } from '../../contracts/response.js';

export interface OrchestratorDeps {
  registry: ProviderRegistry;
  resolution: ProviderResolutionConfig;
  schemaValidator: SchemaValidator;
  defaultTimeoutMs: number;
  serviceVersion: string;
  retryPolicy?: Partial<RetryPolicy>;
  fallback?: FallbackConfig;
  now?: () => number;
}

export interface ProcessInput {
  request: ProcessingRequest;
  requestId: string;
  startedAt?: number;
  /** Aborted when the client disconnects, so abandoned work stops early. */
  signal?: AbortSignal;
}

export interface Orchestrator {
  process(input: ProcessInput): Promise<ProcessingSuccessResponse>;
  resolve(providerName: string | undefined, model: string | undefined): { provider: string; model: string };
}

/**
 * Only these can plausibly be fixed by running the same request elsewhere.
 * A malformed request, an unsupported option, or a schema the client supplied
 * will fail identically at every provider: failing over would only burn budget.
 */
const FAILOVER_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_AUTH_FAILED',
  'PROVIDER_MODEL_NOT_FOUND',
  'OUTPUT_UNPARSEABLE',
  'OUTPUT_VALIDATION_FAILED',
  'OUTPUT_TRUNCATED',
  'MODEL_REFUSED',
]);

export function canFailover(error: AppError): boolean {
  return FAILOVER_CODES.has(error.code);
}

const DEFAULT_FALLBACK: FallbackConfig = { enabled: false, providers: [], maxAttempts: 1 };

/**
 * The provider-independent pipeline. It knows nothing about any client
 * application, and it imports no provider implementation — only the port.
 */
export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const now = deps.now ?? (() => performance.timeOrigin + performance.now());
  const fallback = deps.fallback ?? DEFAULT_FALLBACK;

  return {
    resolve(providerName, model) {
      const plan = planCandidates({
        request: {
          instructions: '',
          content: { type: 'text', text: '' },
          ...(providerName !== undefined ? { provider: providerName } : {}),
          ...(model !== undefined ? { model } : {}),
        } as ProcessingRequest,
        resolution: deps.resolution,
        registry: deps.registry,
        fallback,
      });
      return { provider: plan.primary.provider, model: plan.primary.model };
    },

    async process(input) {
      const startedAt = input.startedAt ?? now();
      const { request, requestId } = input;
      const attempts: AttemptSummary[] = [];

      let plan;
      try {
        plan = planCandidates({
          request,
          resolution: deps.resolution,
          registry: deps.registry,
          fallback,
        });
      } catch (error) {
        throw Object.assign(toAppError(error), { attempts });
      }

      const timeoutMs = Math.min(
        request.options?.timeout_ms ?? deps.defaultTimeoutMs,
        deps.defaultTimeoutMs,
      );
      const deadlineAt = startedAt + timeoutMs;

      const prompt = buildPrompt({
        requestId,
        instructions: request.instructions,
        content: request.content,
        ...(request.context !== undefined ? { context: request.context } : {}),
      });

      const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...(deps.retryPolicy ?? {}) };

      let lastError: AppError | undefined;
      let providerStarted: number | null = null;

      for (let index = 0; index < plan.candidates.length; index += 1) {
        const candidate = plan.candidates[index];
        if (!candidate) break;

        if (input.signal?.aborted) {
          throw Object.assign(
            new AppError('TIMEOUT', undefined, { details: { reason: 'client_disconnected' } }),
            { attempts },
          );
        }
        if (now() >= deadlineAt) {
          lastError = new AppError('TIMEOUT');
          break;
        }

        // Capabilities differ per provider, so options are reconciled per
        // candidate: an option dropped for one provider is not dropped for all.
        const negotiated = negotiateOptions({
          capabilities: candidate.adapter.capabilities,
          output: request.output,
          options: request.options,
          providerLabel: candidate.provider,
        });

        if (negotiated.output.kind === 'json') {
          deps.schemaValidator.assertValidSchema(negotiated.output.schema);
        }

        const options: NormalizedGenerationOptions = negotiated.options;
        const generationRequest = {
          provider: candidate.provider,
          model: candidate.model,
          prompt,
          output: negotiated.output,
          options,
          deadlineAt,
          requestId,
        } as const;

        providerStarted ??= now();
        const attemptStarted = now();

        let generation: GenerationResponse;
        try {
          generation = await executeWithRetry<GenerationResponse>({
            policy,
            deadlineAt,
            now,
            ...(input.signal ? { externalSignal: input.signal } : {}),
            operation: (signal) => candidate.adapter.generate({ ...generationRequest }, signal),
            onFailure: (error, context) => {
              attempts.push({
                provider: candidate.provider,
                model: candidate.model,
                outcome: context.abortedByDeadline ? 'skipped' : 'failed',
                error_code: error.code,
                duration_ms: Math.max(0, Math.round(now() - attemptStarted)),
              });
            },
          });
        } catch (error) {
          const appError = toAppError(error);
          if (appError.code === 'TIMEOUT' && appError.details && input.signal?.aborted) {
            throw Object.assign(appError, { attempts });
          }
          lastError = appError;
          if (!canFailover(appError)) throw Object.assign(appError, { attempts });
          if (index === plan.candidates.length - 1) throw Object.assign(appError, { attempts });
          continue;
        }

        const providerMs = Math.max(0, Math.round(now() - (providerStarted ?? attemptStarted)));
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          outcome: 'success',
          duration_ms: Math.max(0, Math.round(now() - attemptStarted)),
        });

        const validationStarted = now();
        let normalized;
        try {
          normalized = normalizeResponse({
            generation,
            output: negotiated.output,
            schemaValidator: deps.schemaValidator,
          });
        } catch (error) {
          const appError = toAppError(error);
          attempts[attempts.length - 1] = {
            provider: candidate.provider,
            model: candidate.model,
            outcome: 'failed',
            error_code: appError.code,
            duration_ms: Math.max(0, Math.round(now() - attemptStarted)),
          };
          lastError = appError;
          if (canFailover(appError) && index < plan.candidates.length - 1) continue;
          throw Object.assign(appError, { attempts });
        }

        const validationMs =
          negotiated.output.kind === 'json'
            ? Math.max(0, Math.round(now() - validationStarted))
            : null;

        const fallbackUsed = index > 0;
        const warnings: Warning[] = [...negotiated.warnings, ...normalized.warnings];
        if (fallbackUsed) {
          warnings.push({
            code: 'FALLBACK_USED',
            field: 'provider',
            message: `The requested provider did not complete the request; it was processed by '${candidate.provider}' under the fallback policy.`,
          });
        }

        return {
          success: true,
          request_id: requestId,
          provider: candidate.provider,
          model: generation.modelEcho || candidate.model,
          result: normalized.result,
          usage: generation.usage ?? EMPTY_USAGE,
          duration_ms: Math.max(0, Math.round(now() - startedAt)),
          meta: {
            finish_reason: normalized.finishReason,
            fallback_used: fallbackUsed,
            attempts,
            warnings,
            provider_request_id: generation.providerRequestId,
            ...(request.metadata?.client_request_id
              ? { client_request_id: request.metadata.client_request_id }
              : {}),
            service_version: deps.serviceVersion,
            timings: { provider_ms: providerMs, validation_ms: validationMs },
          },
        };
      }

      throw Object.assign(lastError ?? new AppError('INTERNAL'), { attempts });
    },
  };
}
