import { AppError } from '../errors/AppError.js';
import { isProviderId, type ProviderId } from '../../contracts/common.js';
import type { ProviderAdapter, ProviderRegistry } from '../../contracts/provider.js';
import { resolveProvider, type ProviderResolutionConfig } from './resolveProvider.js';
import type { ProcessingRequest } from '../../contracts/request.js';

export interface FallbackConfig {
  enabled: boolean;
  /** Deployment-level default order, used when a request enables fallback without naming providers. */
  providers: ProviderId[];
  /** Hard ceiling on total providers tried, including the primary one. */
  maxAttempts: number;
}

export interface Candidate {
  provider: ProviderId;
  model: string;
  adapter: ProviderAdapter;
}

export interface CandidatePlan {
  primary: Candidate;
  /** Primary first, then fallbacks in the declared order. Always length >= 1. */
  candidates: Candidate[];
  fallbackEnabled: boolean;
}

/**
 * Builds the bounded candidate list.
 *
 * Rules, in order:
 *  1. The primary provider is resolved exactly as before (explicit, else default).
 *  2. Without an explicit fallback block, the list is exactly [primary] — fallback
 *     is never inferred from a failure.
 *  3. A request may only enable fallback when the deployment permits it;
 *     otherwise the request is rejected (FALLBACK_INVALID), never quietly served
 *     by the primary alone while appearing to have honoured the policy.
 *  4. The list is capped at `maxAttempts`, so no request can walk every provider.
 *  5. A candidate with no resolvable model is skipped rather than guessed.
 */
export function planCandidates(input: {
  request: ProcessingRequest;
  resolution: ProviderResolutionConfig;
  registry: ProviderRegistry;
  fallback: FallbackConfig;
}): CandidatePlan {
  const { request, resolution, registry, fallback } = input;
  const primary = resolveProvider(request, resolution, registry);
  const single: CandidatePlan = { primary, candidates: [primary], fallbackEnabled: false };

  const policy = request.fallback;
  if (!policy) return single;

  if (!fallback.enabled) {
    throw new AppError('FALLBACK_INVALID', undefined, {
      details: { reason: 'fallback is disabled in this deployment' },
    });
  }

  if (policy.providers.includes(primary.provider)) {
    throw new AppError('FALLBACK_INVALID', undefined, {
      details: {
        reason: 'the requested provider must not also appear in the fallback list',
        provider: primary.provider,
      },
    });
  }

  const declared = policy.providers.length > 0 ? policy.providers : fallback.providers;
  if (declared.length === 0) {
    throw new AppError('FALLBACK_INVALID', undefined, {
      details: { reason: 'no fallback providers are configured' },
    });
  }

  const limit = Math.min(fallback.maxAttempts, 1 + declared.length);
  const candidates: Candidate[] = [primary];
  const skipped: { provider: string; reason: string }[] = [];

  for (const id of declared) {
    if (candidates.length >= limit) break;
    if (!isProviderId(id)) {
      throw new AppError('FALLBACK_INVALID', undefined, {
        details: { reason: 'unknown provider in fallback list', provider: id },
      });
    }
    if (candidates.some((candidate) => candidate.provider === id)) continue;

    const adapter = registry.get(id);
    if (!adapter) {
      skipped.push({ provider: id, reason: 'not configured in this deployment' });
      continue;
    }

    const model =
      policy.model_overrides?.[id]?.trim() ||
      resolution.providers[id]?.defaultModel?.trim() ||
      undefined;
    if (!model) {
      skipped.push({ provider: id, reason: 'no model available' });
      continue;
    }

    candidates.push({ provider: id, model, adapter });
  }

  if (candidates.length === 1) {
    throw new AppError('FALLBACK_INVALID', undefined, {
      details: { reason: 'no usable fallback provider', skipped },
    });
  }

  return { primary, candidates, fallbackEnabled: true };
}
