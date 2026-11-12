import Ajv2020Module from 'ajv/dist/2020.js';
import { LIMITS } from '../../config/limits.js';
import { AppError } from '../errors/AppError.js';
import type { JsonSchemaObject } from '../../contracts/common.js';

export interface SchemaValidationError {
  path: string;
  message: string;
}

export type SchemaValidationResult =
  | { ok: true }
  | { ok: false; errors: SchemaValidationError[] };

export interface SchemaValidator {
  assertValidSchema(schema: JsonSchemaObject): void;
  validate(schema: JsonSchemaObject, data: unknown): SchemaValidationResult;
}

type CompiledValidator = ((data: unknown) => boolean) & { errors?: unknown[] | null };
type AjvLike = { compile: (schema: unknown) => CompiledValidator };
type AjvConstructor = new (options?: Record<string, unknown>) => AjvLike;

// The ajv 2020 build ships as CommonJS; NodeNext resolves the default export at
// runtime but not in its typings, so the constructor is asserted here, once.
const Ajv2020 = Ajv2020Module as unknown as AjvConstructor;

function measureDepth(node: unknown, depth = 0): number {
  if (depth > LIMITS.maxSchemaDepth) return depth;
  if (Array.isArray(node)) {
    let max: number = depth;
    for (const item of node) max = Math.max(max, measureDepth(item, depth + 1));
    return max;
  }
  if (node !== null && typeof node === 'object') {
    let max: number = depth;
    for (const child of Object.values(node as Record<string, unknown>)) {
      max = Math.max(max, measureDepth(child, depth + 1));
    }
    return max;
  }
  return depth;
}

function findRemoteRef(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRemoteRef(item);
      if (found) return found;
    }
    return null;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string' && !value.startsWith('#/')) return value;
      const found = findRemoteRef(value);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Owns everything about client-supplied JSON Schema. Zod cannot validate an
 * external schema document; Ajv can. No remote $ref resolution: a client schema
 * would otherwise be an SSRF primitive.
 */
export function createSchemaValidator(): SchemaValidator {
  const ajv = new Ajv2020({
    strict: false,
    allErrors: false,
    validateSchema: true,
    allowUnionTypes: true,
  });

  const compile = (schema: JsonSchemaObject): CompiledValidator => {
    try {
      return ajv.compile(schema);
    } catch (error) {
      throw new AppError('INVALID_JSON_SCHEMA', undefined, {
        cause: error,
        details: { reason: error instanceof Error ? error.message : 'invalid schema' },
      });
    }
  };

  return {
    assertValidSchema(schema) {
      const size = Buffer.byteLength(JSON.stringify(schema), 'utf8');
      if (size > LIMITS.maxSchemaBytes) {
        throw new AppError('INVALID_JSON_SCHEMA', undefined, {
          details: { reason: 'schema too large', limit_bytes: LIMITS.maxSchemaBytes },
        });
      }
      const depth = measureDepth(schema);
      if (depth > LIMITS.maxSchemaDepth) {
        throw new AppError('INVALID_JSON_SCHEMA', undefined, {
          details: { reason: 'schema nested too deeply', limit_depth: LIMITS.maxSchemaDepth },
        });
      }
      const remoteRef = findRemoteRef(schema);
      if (remoteRef) {
        throw new AppError('INVALID_JSON_SCHEMA', undefined, {
          details: { reason: 'remote $ref is not permitted', ref: remoteRef.slice(0, 120) },
        });
      }
      compile(schema);
    },

    validate(schema, data) {
      const validateFn = compile(schema);
      if (validateFn(data)) return { ok: true };
      const raw = (validateFn.errors ?? []) as { instancePath?: unknown; message?: unknown }[];
      const errors = raw.slice(0, 20).map((issue) => ({
        path: typeof issue.instancePath === 'string' && issue.instancePath ? issue.instancePath : '/',
        message: typeof issue.message === 'string' ? issue.message : 'invalid',
      }));
      return { ok: false, errors };
    },
  };
}
