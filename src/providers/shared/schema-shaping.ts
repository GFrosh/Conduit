import type { JsonSchemaObject } from '../../contracts/common.js';
import type { Warning } from '../../contracts/common.js';

/**
 * OpenAI strict mode requires closed objects with every property listed as
 * required. The transformation is applied to a COPY and reported as a warning,
 * because it strengthens the client's schema and must not be silent.
 *
 * Safety property: strengthening the provider constraint cannot make the core's
 * post-hoc validation (run against the ORIGINAL client schema) accept bad data;
 * it can only make the model more exhaustive.
 */
export function closeSchemaForStrict(schema: JsonSchemaObject): {
  schema: JsonSchemaObject;
  modified: boolean;
} {
  let modified = false;

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;

    const input = node as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input)) {
      if (key === 'properties' && value && typeof value === 'object') {
        const props: Record<string, unknown> = {};
        for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
          props[propName] = walk(propSchema);
        }
        output.properties = props;
        continue;
      }
      output[key] = walk(value);
    }

    const isObjectSchema = output.type === 'object' || output.properties !== undefined;
    if (isObjectSchema) {
      if (output.additionalProperties !== false) {
        output.additionalProperties = false;
        modified = true;
      }
      const propertyNames = Object.keys((output.properties as Record<string, unknown>) ?? {});
      if (propertyNames.length > 0) {
        const declared = Array.isArray(output.required) ? (output.required as unknown[]) : [];
        const merged = [
          ...new Set([...declared.filter((v): v is string => typeof v === 'string'), ...propertyNames]),
        ];
        if (merged.length !== declared.length) modified = true;
        output.required = merged;
      }
    }
    return output;
  };

  return { schema: walk(schema) as JsonSchemaObject, modified };
}

/** Keywords Gemini's constrained decoder ignores or rejects outright. */
export const GEMINI_UNSUPPORTED_KEYWORDS = [
  '$schema',
  '$id',
  '$defs',
  'definitions',
  'additionalProperties',
  'patternProperties',
  'unevaluatedProperties',
  'propertyNames',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
  'if',
  'then',
  'else',
  'not',
  'dependentSchemas',
  'dependentRequired',
  'examples',
  'default',
  '$comment',
] as const;

export interface GeminiSchemaShaping {
  schema: JsonSchemaObject | null;
  droppedKeywords: string[];
  reason?: 'unsupported_refs';
}

/**
 * Gemini accepts a JSON-Schema subset. Rather than let the API silently ignore
 * constraints (which turns a guarantee into a hope), unsupported keywords are
 * stripped here and reported. Local $ref resolution is not attempted: a schema
 * that uses refs is sent without responseSchema and relies on post-hoc
 * validation instead.
 */
export function shapeSchemaForGemini(schema: JsonSchemaObject): GeminiSchemaShaping {
  if (containsRef(schema)) {
    return { schema: null, droppedKeywords: [], reason: 'unsupported_refs' };
  }

  const dropped = new Set<string>();

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;

    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if ((GEMINI_UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) {
        dropped.add(key);
        continue;
      }
      if (key === 'properties' && value && typeof value === 'object') {
        const props: Record<string, unknown> = {};
        for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
          props[propName] = walk(propSchema);
        }
        output.properties = props;
        continue;
      }
      output[key] = walk(value);
    }
    return output;
  };

  return { schema: walk(schema) as JsonSchemaObject, droppedKeywords: [...dropped] };
}

function containsRef(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(containsRef);
  if (node === null || typeof node !== 'object') return false;
  return Object.entries(node as Record<string, unknown>).some(
    ([key, value]) => key === '$ref' || containsRef(value),
  );
}

export function shapingWarnings(dropped: string[], providerLabel: string): Warning[] {
  if (dropped.length === 0) return [];
  return [
    {
      code: 'SCHEMA_KEYWORD_DROPPED',
      field: 'output.schema',
      message: `Provider '${providerLabel}' does not enforce these JSON Schema keywords, so they were removed: ${dropped.join(', ')}. The service still validates the response against the original schema.`,
    },
  ];
}
