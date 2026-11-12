import { describe, expect, it } from 'vitest';
import { findCredentialField, isCredentialKey } from '../../src/http/plugins/credential-guard.js';

describe('credential guard', () => {
  it('recognizes credential-shaped field names', () => {
    for (const key of ['apiKey', 'api_key', 'API-KEY', 'apikey', 'anthropicApiKey', 'access_token', 'openaiToken', 'client_secret', 'password', 'authorization', 'credentials']) {
      expect(isCredentialKey(key), key).toBe(true);
    }
  });

  it('does not mistake legitimate contract fields for credentials', () => {
    // Regression: `max_output_tokens` contains the substring "token" and was
    // rejected before this rule became segment-based.
    for (const key of ['max_output_tokens', 'maxOutputTokens', 'top_p', 'temperature', 'instructions', 'schema_name', 'timeout_ms', 'provider', 'model']) {
      expect(isCredentialKey(key), key).toBe(false);
    }
  });

  it('finds a credential nested in metadata', () => {
    expect(findCredentialField({ instructions: 'x', metadata: { openai_api_key: 'sk-live-abc' } })).toBe('openai_api_key');
  });

  it('finds a credential inside an array of objects', () => {
    expect(findCredentialField({ content: { type: 'text', text: 'x' }, extra: [{ apiKey: 'sk-live-abc' }] })).toBe('apiKey');
  });

  it('passes ordinary payloads through', () => {
    expect(
      findCredentialField({
        provider: 'openai',
        model: 'm',
        instructions: 'Summarise.',
        content: { type: 'text', text: 'Body' },
        output: { format: 'json', schema: { type: 'object' } },
        options: { temperature: 0.4, max_output_tokens: 512, timeout_ms: 5000 },
      }),
    ).toBeNull();
  });

  it('does not scan unbounded recursion', () => {
    let deep: Record<string, unknown> = { apiKey: 'sk-live-abc' };
    for (let i = 0; i < 10; i += 1) deep = { nested: deep };
    expect(findCredentialField(deep)).toBeNull();
  });
});
