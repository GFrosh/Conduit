import { loadConfig, type AppConfig } from '../../src/config/env.js';

export const TEST_ENV: Record<string, string | undefined> = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '0',
  LOG_LEVEL: 'silent',
  APP_VERSION: 'test',
  PROVIDER_MODE: 'mock',
  ENABLED_PROVIDERS: 'openai,anthropic,gemini',
  DEFAULT_PROVIDER: 'openai',
  DEFAULT_MODEL_OPENAI: 'model-alpha',
  DEFAULT_MODEL_ANTHROPIC: 'model-beta',
  DEFAULT_MODEL_GEMINI: 'model-gamma',
  AUTH_ENABLED: 'true',
  SERVICE_API_KEYS: 'test-key:supersecret-test',
  RATE_LIMIT_ENABLED: 'false',
  REQUEST_TIMEOUT_MS: '5000',
  MAX_BODY_BYTES: '1048576',
};

export const TEST_TOKEN = 'supersecret-test';
export const AUTH_HEADER = { authorization: `Bearer ${TEST_TOKEN}` };

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig({ ...TEST_ENV, ...overrides });
}

export const VALID_BODY = {
  instructions: 'Summarise the supplied article in three sentences.',
  content: { type: 'text', text: 'A short article body used for testing.' },
};
