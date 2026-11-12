import { LIMITS } from '../../config/limits.js';
import { AppError } from '../errors/AppError.js';
import type { Warning } from '../../contracts/common.js';
import type {
  GenerationOutput,
  NormalizedGenerationOptions,
  ProviderCapabilities,
} from '../../contracts/generation.js';
import type { GenerationOptions, OutputConfig } from '../../contracts/request.js';

export interface NegotiationResult {
  options: NormalizedGenerationOptions;
  output: GenerationOutput;
  warnings: Warning[];
}

export interface NegotiateInput {
  capabilities: ProviderCapabilities;
  output: OutputConfig;
  options?: GenerationOptions;
  providerLabel: string;
}

type SupportedOption = 'temperature' | 'top_p' | 'max_output_tokens';

/**
 * Applies configured defaults and reconciles them with what the resolved
 * provider can actually honour. Structured output is never downgraded silently:
 * "validated JSON or error" must not become "maybe".
 */
const NO_OPTIONS: GenerationOptions = { on_unsupported_option: 'reject' };

export function negotiateOptions(input: NegotiateInput): NegotiationResult {
  const { capabilities, providerLabel } = input;
  const requested: GenerationOptions = input.options ?? NO_OPTIONS;
  const warnings: Warning[] = [];
  const ignore = requested.on_unsupported_option === 'ignore';

  const support = (option: SupportedOption): void => {
    if (capabilities.supportedOptions.includes(option)) return;
    if (!ignore) {
      throw new AppError('OPTION_UNSUPPORTED', undefined, {
        details: { provider: providerLabel, option, supported: [...capabilities.supportedOptions] },
      });
    }
    warnings.push({
      code: 'OPTION_IGNORED',
      field: option,
      message: `Provider '${providerLabel}' does not support '${option}'; the value was ignored.`,
    });
  };

  const options: NormalizedGenerationOptions = {};

  if (requested.temperature !== undefined) {
    support('temperature');
    if (capabilities.supportedOptions.includes('temperature')) options.temperature = requested.temperature;
  }
  if (requested.top_p !== undefined) {
    support('top_p');
    if (capabilities.supportedOptions.includes('top_p')) options.topP = requested.top_p;
  }
  if (requested.max_output_tokens !== undefined) {
    support('max_output_tokens');
    if (capabilities.supportedOptions.includes('max_output_tokens')) {
      const ceiling = Math.min(capabilities.maxOutputTokens, LIMITS.maxOutputTokens);
      const clamped = Math.min(requested.max_output_tokens, ceiling);
      if (clamped !== requested.max_output_tokens) {
        warnings.push({
          code: 'OPTION_CLAMPED',
          field: 'max_output_tokens',
          message: `max_output_tokens was reduced from ${requested.max_output_tokens} to ${clamped} to respect the provider limit.`,
        });
      }
      options.maxOutputTokens = clamped;
    }
  }

  const output = resolveOutput(input.output, capabilities, providerLabel);
  return { options, output, warnings };
}

function resolveOutput(
  output: OutputConfig,
  capabilities: ProviderCapabilities,
  providerLabel: string,
): GenerationOutput {
  if (output.format === 'text') return { kind: 'text', format: 'text' };
  if (output.format === 'markdown') return { kind: 'text', format: 'markdown' };

  if (capabilities.structuredOutput === 'prompt_only') {
    throw new AppError('OUTPUT_FORMAT_UNSUPPORTED', undefined, {
      details: {
        provider: providerLabel,
        requested: 'json',
        supported: capabilities.structuredOutput,
      },
    });
  }

  return {
    kind: 'json',
    schema: output.schema,
    ...(output.schema_name ? { schemaName: output.schema_name } : {}),
    validate: output.validate,
  };
}
