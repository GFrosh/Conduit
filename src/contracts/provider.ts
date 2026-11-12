import type { ProviderId } from './common.js';
import type {
  GenerationRequest,
  GenerationResponse,
  ProviderCapabilities,
} from './generation.js';

/**
 * The single port between core and providers.
 *
 * Contract for implementors:
 *  - may throw AppError only;
 *  - must honour the AbortSignal;
 *  - must NOT retry (retry lives in core so it has one budget for all providers);
 *  - must NOT parse structured output (core owns parsing and validation);
 *  - must NOT transform an unrecognised stop-code into 'stop'.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  generate(request: GenerationRequest, signal: AbortSignal): Promise<GenerationResponse>;
}

export interface ProviderRegistry {
  register(adapter: ProviderAdapter): void;
  has(id: string): boolean;
  get(id: string): ProviderAdapter | undefined;
  require(id: string): ProviderAdapter;
  list(): ProviderAdapter[];
}
