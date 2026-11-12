import type { GenerationRequest } from '../../src/contracts/generation.js';

/** A provider-neutral request used by every adapter test, so differences in
 *  output can only come from the adapter, never from the input. */
export function generationRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    provider: 'openai',
    model: 'test-model',
    prompt: { system: 'Summarise the article.', user: '<<<CONTENT:n1>>>\nBody text.\n<<<END_CONTENT:n1>>>' },
    output: { kind: 'text', format: 'text' },
    options: {},
    deadlineAt: Date.now() + 30_000,
    requestId: 'req_test',
    ...overrides,
  };
}

export function jsonRequest(schema: Record<string, unknown> = { type: 'object' }): GenerationRequest {
  return generationRequest({ output: { kind: 'json', schema, validate: true } });
}

/** Mimics an SDK/HTTP error closely enough for the shared mapper. */
export class FakeSdkError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'FakeSdkError';
    this.status = status;
    this.headers = headers;
  }
}
