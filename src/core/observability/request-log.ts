import type { NormalizedUsage } from '../../contracts/common.js';
import { redactSecretText, sampleContent } from '../security/redaction.js';

export interface LogContext {
  provider?: string;
  model?: string;
  usage?: NormalizedUsage | null;
  errorCode?: string;
  attempts?: number;
  fallbackUsed?: boolean;
  finishReason?: string;
}

export interface RequestLogInput {
  requestId: string;
  clientId?: string;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
  context: LogContext;
  /** Only non-identifying shape information is recorded by default. */
  instructionsChars?: number;
  contentChars?: number;
  contextChars?: number;
  instructionsSample?: string;
  contentSample?: string;
}

export interface StructuredLogLine {
  msg: string;
  request_id: string;
  client_id?: string;
  method: string;
  route: string;
  status: number;
  duration_ms: number;
  success: boolean;
  provider?: string;
  model?: string;
  error_code?: string;
  attempts?: number;
  fallback_used?: boolean;
  finish_reason?: string;
  usage?: NormalizedUsage;
  input_chars?: { instructions: number; content: number; context: number };
  sample?: { instructions?: string; content?: string };
}

/**
 * Builds the single completion log line. Deliberately additive-only: every field
 * is chosen here, so a route cannot accidentally attach a header, a body, or a
 * provider payload. Payload text appears ONLY when the operator opted in and the
 * per-request sampling decision selected this request.
 */
export function buildRequestLogLine(input: RequestLogInput): StructuredLogLine {
  const { context } = input;
  const line: StructuredLogLine = {
    msg: input.statusCode < 500 ? 'request completed' : 'request failed',
    request_id: input.requestId,
    method: input.method,
    route: input.route,
    status: input.statusCode,
    duration_ms: input.durationMs,
    success: input.statusCode < 400,
  };

  if (input.clientId) line.client_id = input.clientId;
  if (context.provider) line.provider = context.provider;
  if (context.model) line.model = context.model;
  if (context.errorCode) line.error_code = context.errorCode;
  if (context.attempts !== undefined) line.attempts = context.attempts;
  if (context.fallbackUsed !== undefined) line.fallback_used = context.fallbackUsed;
  if (context.finishReason) line.finish_reason = context.finishReason;
  // Null usage means the provider reported nothing: it is omitted, never zero-filled.
  if (context.usage && Object.values(context.usage).some((value) => value !== null)) {
    line.usage = context.usage;
  }

  if (
    input.instructionsChars !== undefined &&
    input.contentChars !== undefined &&
    input.contextChars !== undefined
  ) {
    line.input_chars = {
      instructions: input.instructionsChars,
      content: input.contentChars,
      context: input.contextChars,
    };
  }

  const sample: { instructions?: string; content?: string } = {};
  if (input.instructionsSample) sample.instructions = input.instructionsSample;
  if (input.contentSample) sample.content = input.contentSample;
  if (Object.keys(sample).length > 0) line.sample = sample;

  return line;
}

/** Applies the opt-in sampling flags. Both default to off. */
export function sampleFor(
  value: string,
  enabled: boolean,
  sampled: boolean,
): string | undefined {
  if (!enabled || !sampled) return undefined;
  return sampleContent(redactSecretText(value, 240), true);
}
