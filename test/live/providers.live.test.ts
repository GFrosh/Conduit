import { describe, expect, it } from 'vitest';
import { createOpenAIAdapter } from '../../src/providers/openai/adapter.js';
import { createAnthropicAdapter } from '../../src/providers/anthropic/adapter.js';
import { createGeminiAdapter } from '../../src/providers/gemini/adapter.js';
import type { ProviderAdapter } from '../../src/contracts/provider.js';
import type { GenerationRequest } from '../../src/contracts/generation.js';

/**
 * Optional live integration tests. They NEVER run in the normal CI pipeline:
 *  - they live in test/live/, which vitest.config.ts excludes;
 *  - they are run with `npm run test:live`;
 *  - each case skips unless BOTH its API key and its model are set.
 *
 * Model identifiers are read from the environment on purpose: this repository
 * does not hardcode provider model names anywhere.
 */
interface LiveTarget {
  label: string;
  apiKey: string | undefined;
  model: string | undefined;
  build: (apiKey: string) => ProviderAdapter;
}

const TARGETS: LiveTarget[] = [
  {
    label: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_TEST_MODEL,
    build: (apiKey) => createOpenAIAdapter({ apiKey, maxOutputTokens: 256 }),
  },
  {
    label: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_TEST_MODEL,
    build: (apiKey) => createAnthropicAdapter({ apiKey, defaultMaxTokens: 256 }),
  },
  {
    label: 'gemini',
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_TEST_MODEL,
    build: (apiKey) => createGeminiAdapter({ apiKey, maxOutputTokens: 256 }),
  },
];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: { title: { type: 'string' } },
};

function liveRequest(model: string, json: boolean): GenerationRequest {
  return {
    provider: 'openai',
    model,
    prompt: {
      system: 'You are a terse assistant. Answer with a single short sentence.',
      user: '<<<CONTENT:abc123>>>Say hello.<<<END_CONTENT:abc123>>>',
    },
    output: json
      ? { kind: 'json', schema: SCHEMA, schemaName: 'live_probe', validate: true }
      : { kind: 'text', format: 'text' },
    options: { maxOutputTokens: 64 },
    deadlineAt: Date.now() + 60_000,
    requestId: 'req_live_probe',
  };
}

describe('live provider probes (opt-in)', () => {
  for (const target of TARGETS) {
    const enabled = Boolean(target.apiKey && target.model);
    const skip = enabled ? false : `set the API key and ${target.label.toUpperCase()}_TEST_MODEL to run`;

    it.skipIf(skip)(`${target.label}: text generation returns normalized usage`, async () => {
      const adapter = target.build(target.apiKey as string);
      const response = await adapter.generate(liveRequest(target.model as string, false), AbortSignal.timeout(60_000));
      expect(response.text.length).toBeGreaterThan(0);
      expect(response.finishReason).toBe('stop');
      expect(response.usage.input_tokens).toBeGreaterThan(0);
      expect(response.usage.output_tokens).toBeGreaterThan(0);
      expect(typeof response.modelEcho).toBe('string');
    });

    it.skipIf(skip)(`${target.label}: native structured output honours the schema`, async () => {
      const adapter = target.build(target.apiKey as string);
      const response = await adapter.generate(liveRequest(target.model as string, true), AbortSignal.timeout(60_000));
      const parsed = JSON.parse(response.text) as { title?: unknown };
      expect(typeof parsed.title).toBe('string');
    });
  }
});
