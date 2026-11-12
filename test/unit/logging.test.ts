import { describe, expect, it } from 'vitest';
import { buildRequestLogLine } from '../../src/core/observability/request-log.js';
import { redactSecretText } from '../../src/core/security/redaction.js';

const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  total_tokens: 15,
  cached_input_tokens: null,
  reasoning_tokens: null,
};

describe('structured request log line', () => {
  it('carries exactly the operational fields', () => {
    const line = buildRequestLogLine({
      requestId: 'req_abc',
      clientId: 'nc-prod',
      method: 'POST',
      route: '/v1/process',
      statusCode: 200,
      durationMs: 412,
      context: {
        provider: 'openai',
        model: 'm-1',
        usage: USAGE,
        attempts: 1,
        fallbackUsed: false,
        finishReason: 'stop',
      },
      instructionsChars: 40,
      contentChars: 1_200,
      contextChars: 0,
    });

    expect(line).toMatchObject({
      request_id: 'req_abc',
      client_id: 'nc-prod',
      provider: 'openai',
      model: 'm-1',
      status: 200,
      duration_ms: 412,
      success: true,
      attempts: 1,
      fallback_used: false,
      finish_reason: 'stop',
      usage: USAGE,
    });
    expect(line.input_chars).toEqual({ instructions: 40, content: 1_200, context: 0 });
    expect(line.sample).toBeUndefined();
  });

  it('records the normalized error code on failure and nothing else from the error', () => {
    const line = buildRequestLogLine({
      requestId: 'req_err',
      method: 'POST',
      route: '/v1/process',
      statusCode: 502,
      durationMs: 900,
      context: { provider: 'openai', errorCode: 'PROVIDER_UNAVAILABLE' },
    });
    expect(line.success).toBe(false);
    expect(line.error_code).toBe('PROVIDER_UNAVAILABLE');
    expect(JSON.stringify(line)).not.toContain('stack');
  });

  it('omits usage entirely when the provider reported nothing', () => {
    const line = buildRequestLogLine({
      requestId: 'req_u',
      method: 'POST',
      route: '/v1/process',
      statusCode: 200,
      durationMs: 10,
      context: {
        usage: {
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
          cached_input_tokens: null,
          reasoning_tokens: null,
        },
      },
    });
    expect(line.usage).toBeUndefined();
  });
});

describe('secret redaction', () => {
  it('masks provider-shaped keys, bearer tokens and long opaque blobs', () => {
    const text = 'key sk-live-abcdefghijklmnop and gsk_ABCDEFGH12345678 and Bearer abcdefghijklmnop';
    const redacted = redactSecretText(text);
    expect(redacted).not.toContain('sk-live-abcdefghijklmnop');
    expect(redacted).not.toContain('gsk_ABCDEFGH12345678');
    expect(redacted).not.toContain('abcdefghijklmnop');
    expect(redacted).toContain('[redacted]');
  });

  it('truncates rather than logging an unbounded value', () => {
    expect(redactSecretText('x'.repeat(1_000)).length).toBeLessThanOrEqual(320);
  });
});
