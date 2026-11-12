import { describe, expect, it } from 'vitest';
import { processingRequestSchema } from '../../src/contracts/request.js';
import { LIMITS } from '../../src/config/limits.js';
import { VALID_BODY } from '../helpers/config.js';

describe('processingRequestSchema', () => {
  it('accepts a minimal request and applies defaults', () => {
    const parsed = processingRequestSchema.parse(VALID_BODY);
    expect(parsed.output).toEqual({ format: 'text' });
    expect(parsed.options).toBeUndefined();
    expect(parsed.provider).toBeUndefined();
    expect(parsed.model).toBeUndefined();
  });

  it('accepts provider and model independently', () => {
    const parsed = processingRequestSchema.parse({ ...VALID_BODY, provider: 'gemini', model: 'x-1' });
    expect(parsed.provider).toBe('gemini');
    expect(parsed.model).toBe('x-1');
  });

  it('accepts a provider without a model', () => {
    expect(processingRequestSchema.parse({ ...VALID_BODY, provider: 'anthropic' }).model).toBeUndefined();
  });

  it('accepts a model without a provider', () => {
    expect(processingRequestSchema.parse({ ...VALID_BODY, model: 'x-1' }).provider).toBeUndefined();
  });

  it('accepts string and object context', () => {
    expect(processingRequestSchema.parse({ ...VALID_BODY, context: 'plain text' }).context).toBe('plain text');
    const obj = { a: 1, b: [true, null, 'x'], c: { d: 'e' } };
    expect(processingRequestSchema.parse({ ...VALID_BODY, context: obj }).context).toEqual(obj);
  });

  it('requires instructions', () => {
    const result = processingRequestSchema.safeParse({ content: VALID_BODY.content });
    expect(result.success).toBe(false);
  });

  it('requires content.text', () => {
    const result = processingRequestSchema.safeParse({ instructions: 'x', content: { type: 'text' } });
    expect(result.success).toBe(false);
  });

  it('rejects non-text content types in v1', () => {
    const result = processingRequestSchema.safeParse({
      instructions: 'x',
      content: { type: 'image', url: 'https://example.com/a.png' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown top-level keys (strict payload)', () => {
    const result = processingRequestSchema.safeParse({ ...VALID_BODY, apiKey: 'sk-live-should-never-arrive' });
    expect(result.success).toBe(false);
  });

  it('rejects instructions beyond the limit', () => {
    const result = processingRequestSchema.safeParse({
      ...VALID_BODY,
      instructions: 'x'.repeat(LIMITS.maxInstructionsChars + 1),
    });
    expect(result.success).toBe(false);
  });

  it('enforces temperature and top_p bounds', () => {
    expect(processingRequestSchema.safeParse({ ...VALID_BODY, options: { temperature: 2.1 } }).success).toBe(false);
    expect(processingRequestSchema.safeParse({ ...VALID_BODY, options: { temperature: -0.1 } }).success).toBe(false);
    expect(processingRequestSchema.safeParse({ ...VALID_BODY, options: { top_p: 1.5 } }).success).toBe(false);
    expect(processingRequestSchema.safeParse({ ...VALID_BODY, options: { temperature: 0.2 } }).success).toBe(true);
  });

  it('defaults on_unsupported_option to reject', () => {
    const parsed = processingRequestSchema.parse({ ...VALID_BODY, options: { temperature: 0.5 } });
    expect(parsed.options?.on_unsupported_option).toBe('reject');
  });

  it('defaults output.validate to true for json output', () => {
    const parsed = processingRequestSchema.parse({
      ...VALID_BODY,
      output: { format: 'json', schema: { type: 'object' } },
    });
    expect(parsed.output).toMatchObject({ format: 'json', validate: true });
  });

  it('rejects a json output without a schema', () => {
    expect(processingRequestSchema.safeParse({ ...VALID_BODY, output: { format: 'json' } }).success).toBe(false);
  });

  it('rejects duplicate fallback providers', () => {
    const result = processingRequestSchema.safeParse({
      ...VALID_BODY,
      fallback: { enabled: true, providers: ['anthropic', 'anthropic'] },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid fallback policy', () => {
    const parsed = processingRequestSchema.parse({
      ...VALID_BODY,
      fallback: { enabled: true, providers: ['anthropic', 'gemini'], model_overrides: { gemini: 'x' } },
    });
    expect(parsed.fallback?.providers).toEqual(['anthropic', 'gemini']);
  });

  it('infers TypeScript types from the schema', () => {
    const parsed = processingRequestSchema.parse({ ...VALID_BODY, model: 'm' });
    const model: string | undefined = parsed.model;
    expect(model).toBe('m');
  });
});
