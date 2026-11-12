import { AppError } from '../errors/AppError.js';
import type { FinishReason, NormalizedUsage, Warning } from '../../contracts/common.js';
import type { GenerationOutput, GenerationResponse } from '../../contracts/generation.js';
import type { ProcessResult } from '../../contracts/response.js';
import type { SchemaValidator } from '../validation/schema-validator.js';

export interface NormalizeInput {
  generation: GenerationResponse;
  output: GenerationOutput;
  schemaValidator: SchemaValidator;
}

export interface NormalizeOutput {
  result: ProcessResult;
  finishReason: FinishReason;
  usage: NormalizedUsage;
  warnings: Warning[];
}

/**
 * Turns a provider answer into a public result. Truncation and refusal are
 * errors, not partial successes: publishing half a validated article is worse
 * than failing.
 */
export function normalizeResponse(input: NormalizeInput): NormalizeOutput {
  const { generation, output } = input;

  assertComplete(generation.finishReason, output);

  if (output.kind === 'text') {
    return {
      result:
        output.format === 'markdown'
          ? { type: 'markdown', text: generation.text }
          : { type: 'text', text: generation.text },
      finishReason: generation.finishReason,
      usage: generation.usage,
      warnings: generation.warnings,
    };
  }

  const trimmed = generation.text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    // Deliberately no markdown-fence stripping and no first-brace heuristics:
    // that would mask a provider regression as success.
    throw new AppError('OUTPUT_UNPARSEABLE', undefined, {
      cause: error,
      details: { provider_text_preview: trimmed.slice(0, 200) },
    });
  }

  if (output.validate) {
    const validation = input.schemaValidator.validate(output.schema, parsed);
    if (!validation.ok) {
      throw new AppError('OUTPUT_VALIDATION_FAILED', undefined, {
        details: { errors: validation.errors },
      });
    }
  }

  return {
    result: { type: 'json', data: parsed },
    finishReason: generation.finishReason,
    usage: generation.usage,
    warnings: generation.warnings,
  };
}

function assertComplete(finishReason: FinishReason, output: GenerationOutput): void {
  if (finishReason === 'length') {
    throw new AppError('OUTPUT_TRUNCATED', undefined, { details: { finish_reason: finishReason } });
  }
  if (finishReason === 'refusal' || finishReason === 'content_filter') {
    throw new AppError('MODEL_REFUSED', undefined, { details: { finish_reason: finishReason } });
  }
  if (finishReason === 'tool_calls') {
    throw new AppError('OUTPUT_UNPARSEABLE', undefined, {
      details: { finish_reason: finishReason, reason: 'model returned tool calls instead of content' },
    });
  }
  if (finishReason === 'unknown' && output.kind === 'json') {
    throw new AppError('OUTPUT_UNPARSEABLE', undefined, {
      details: { finish_reason: finishReason, reason: 'completion could not be verified' },
    });
  }
}
