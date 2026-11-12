import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../../src/contracts/openapi.js';
import { ERROR_CODES } from '../../src/contracts/common.js';

type Json = Record<string, unknown>;

/** Typed read of a nested path, so the assertions stay `any`-free. */
function at(root: unknown, ...path: string[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function obj(root: unknown, ...path: string[]): Json {
  const value = at(root, ...path);
  return value && typeof value === 'object' ? (value as Json) : {};
}

function arr(root: unknown, ...path: string[]): unknown[] {
  const value = at(root, ...path);
  return Array.isArray(value) ? value : [];
}

const doc = buildOpenApiDocument({ version: '0.3.0' });

describe('OpenAPI document', () => {
  it('declares OpenAPI 3.1 with bearer authentication', () => {
    expect(at(doc, 'openapi')).toBe('3.1.0');
    expect(obj(doc, 'components', 'securitySchemes', 'clientApiKey')).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(at(doc, 'security')).toEqual([{ clientApiKey: [] }]);
  });

  it('documents every supported endpoint', () => {
    expect(Object.keys(obj(doc, 'paths')).sort()).toEqual([
      '/health',
      '/openapi.json',
      '/ready',
      '/v1/process',
      '/v1/providers',
    ]);
  });

  it('marks probes and the contract public', () => {
    for (const path of ['/health', '/ready', '/openapi.json']) {
      expect(at(doc, 'paths', path, 'get', 'security'), path).toEqual([]);
    }
  });

  it('documents the full request schema', () => {
    const properties = obj(doc, 'components', 'schemas', 'ProcessingRequest', 'properties');
    for (const field of ['provider', 'model', 'instructions', 'context', 'content', 'output', 'options', 'fallback', 'metadata']) {
      expect(properties[field], field).toBeDefined();
    }
  });

  it('lists every error status the service can return', () => {
    const responses = obj(doc, 'paths', '/v1/process', 'post', 'responses');
    for (const status of ['200', '400', '401', '413', '422', '429', '500', '502', '503', '504']) {
      expect(responses[status], status).toBeDefined();
    }
  });

  it('publishes the complete error-code taxonomy', () => {
    expect(at(doc, 'components', 'schemas', 'ErrorCode', 'enum')).toEqual([...ERROR_CODES]);
  });

  it('ships practical request examples', () => {
    const examples = obj(doc, 'paths', '/v1/process', 'post', 'requestBody', 'content', 'application/json');
    const names = Object.keys(obj(examples, 'examples'));
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const name of names) {
      const value = obj(examples, 'examples', name, 'value');
      expect(typeof value.instructions, name).toBe('string');
      expect(value.content, name).toBeDefined();
    }
  });

  it('documents rate limits, auth and provider selection', () => {
    const description = at(doc, 'info', 'description');
    expect(typeof description).toBe('string');
    for (const section of ['Authentication', 'Provider and model selection', 'Rate limits']) {
      expect(description as string).toContain(section);
    }
  });

  it('documents the fallback example without hardcoding a provider model', () => {
    const serialised = JSON.stringify(doc);
    expect(serialised).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    expect(serialised).not.toMatch(/gpt-4|claude-3|gemini-1\.5/);
    expect(serialised).toContain('MODEL_ID_FOR_THIS_DEPLOYMENT');
    expect(arr(doc, 'paths').length).toBe(0); // paths is an object, not an array
  });
});
