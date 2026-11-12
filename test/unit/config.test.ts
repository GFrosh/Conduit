import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig, parseApiKeys } from '../../src/config/env.js';
import { hashSecret } from '../../src/core/security/hashing.js';
import { TEST_ENV } from '../helpers/config.js';

describe('configuration validation', () => {
  it('loads a complete environment', () => {
    const config = loadConfig(TEST_ENV);
    expect(config.port).toBe(0);
    expect(config.defaultProvider).toBe('openai');
    expect(config.providers.map((p) => p.id)).toEqual(['openai', 'anthropic', 'gemini']);
    expect(config.providers.find((p) => p.id === 'anthropic')?.defaultModel).toBe('model-beta');
  });

  it('treats empty default models as unset rather than empty strings', () => {
    const config = loadConfig({ ...TEST_ENV, DEFAULT_MODEL_OPENAI: '   ' });
    expect(config.providers.find((p) => p.id === 'openai')?.defaultModel).toBeUndefined();
  });

  it('fails when the default provider is not enabled', () => {
    expect(() => loadConfig({ ...TEST_ENV, DEFAULT_PROVIDER: 'gemini', ENABLED_PROVIDERS: 'openai' })).toThrow(
      ConfigurationError,
    );
    try {
      loadConfig({ ...TEST_ENV, DEFAULT_PROVIDER: 'gemini', ENABLED_PROVIDERS: 'openai' });
    } catch (error) {
      expect((error as ConfigurationError).issues[0]?.path).toBe('DEFAULT_PROVIDER');
    }
  });

  it('fails when an unknown provider id is enabled', () => {
    expect(() => loadConfig({ ...TEST_ENV, ENABLED_PROVIDERS: 'openai,not-a-provider' })).toThrow(ConfigurationError);
  });

  it('fails when auth is enabled without keys', () => {
    expect(() => loadConfig({ ...TEST_ENV, SERVICE_API_KEYS: '' })).toThrow(ConfigurationError);
  });

  it('fails on a malformed api key entry', () => {
    expect(() => loadConfig({ ...TEST_ENV, SERVICE_API_KEYS: 'no-separator' })).toThrow(ConfigurationError);
  });

  it('fails on a short api key secret', () => {
    expect(() => loadConfig({ ...TEST_ENV, SERVICE_API_KEYS: 'id:short' })).toThrow(ConfigurationError);
  });

  it('fails on duplicate key ids', () => {
    expect(() =>
      loadConfig({ ...TEST_ENV, SERVICE_API_KEYS: 'id:secreteight,id:anothersecret' }),
    ).toThrow(ConfigurationError);
  });

  it('rejects live mode without provider credentials', () => {
    expect(() => loadConfig({ ...TEST_ENV, PROVIDER_MODE: 'live' })).toThrow(ConfigurationError);
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ ...TEST_ENV, PORT: '99999' })).toThrow(ConfigurationError);
  });

  it('rejects a non-boolean flag', () => {
    expect(() => loadConfig({ ...TEST_ENV, AUTH_ENABLED: 'yes' })).toThrow(ConfigurationError);
  });

  it('stores service secrets as digests, never plaintext', () => {
    const keys = parseApiKeys('key-1:supersecret-test');
    expect(keys[0]?.secretHash).toBe(hashSecret('supersecret-test'));
    expect(keys[0]?.secretHash).not.toContain('supersecret-test');
  });

  it('accepts a pre-computed digest as-is', () => {
    const digest = hashSecret('anything');
    expect(parseApiKeys(`key-1:${digest}`)[0]?.secretHash).toBe(digest);
  });
});
