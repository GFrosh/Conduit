import { z } from 'zod';
import {
  ERROR_CODES,
  OUTPUT_FORMATS,
  PROVIDER_IDS,
} from './common.js';
import { processingRequestSchema } from './request.js';
import { processingErrorResponseSchema, processingSuccessResponseSchema } from './response.js';

const json = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }) as Record<string, unknown>;

const jsonOut = (schema: z.ZodType): Record<string, unknown> => {
  const generated = z.toJSONSchema(schema, { io: 'output', target: 'draft-2020-12' }) as Record<string, unknown>;
  delete generated.$schema;
  return generated;
};

const requestShape = (() => {
  const generated = json(processingRequestSchema);
  delete generated.$schema;
  return generated;
})();

const errorExample = {
  success: false,
  request_id: 'req_7f3c1e2a-4b7c-4a1e-9c5b-2d8f0a6e1b3c',
  error: {
    code: 'VALIDATION_FAILED',
    message: 'The request did not satisfy the API contract.',
    retryable: false,
    details: { issues: [{ path: '/instructions', message: 'Too small: expected string to have >=1 characters' }] },
  },
};

const successExample = {
  success: true,
  request_id: 'req_7f3c1e2a-4b7c-4a1e-9c5b-2d8f0a6e1b3c',
  provider: 'openai',
  model: 'the-actual-model-echoed-by-the-provider',
  result: { type: 'text', text: 'A three-sentence summary of the supplied article.' },
  usage: {
    input_tokens: 812,
    output_tokens: 96,
    total_tokens: 908,
    cached_input_tokens: 0,
    reasoning_tokens: null,
  },
  duration_ms: 1843,
  meta: {
    finish_reason: 'stop',
    fallback_used: false,
    attempts: [{ provider: 'openai', model: 'the-actual-model', outcome: 'success', duration_ms: 1791 }],
    warnings: [],
    provider_request_id: 'resp_provider_side_id',
    client_request_id: 'nc-2026-11-11-0001',
    service_version: '0.3.0',
    timings: { provider_ms: 1791, validation_ms: 0 },
  },
};

const errorResponse = (description: string, codes: readonly string[]) => ({
  description,
  content: {
    'application/json': {
      schema: jsonOut(processingErrorResponseSchema),
      example: { ...errorExample, error: { ...errorExample.error, code: codes[0] ?? 'INTERNAL' } },
    },
  },
});

/** The document is generated from the same Zod schemas the server validates with. */
export function buildOpenApiDocument(info: { version: string; serverUrl?: string }): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'AI Processing Engine',
      version: info.version,
      description: [
        'A provider-agnostic AI processing service. The service holds no application logic:',
        'instructions, context, content, and the expected output shape all arrive in the request,',
        'and any client application can reuse the same endpoint unchanged.',
        '',
        '### Authentication',
        'Every endpoint except `GET /health`, `GET /ready` and `GET /openapi.json` requires',
        '`Authorization: Bearer <client-api-key>`. Keys are issued per client application and are',
        'compared server-side in constant time against SHA-256 digests. Provider credentials',
        '(OpenAI/Anthropic/Gemini keys) are configured on the server and are **never** accepted in',
        'a request body; a body containing such a field is rejected with `CREDENTIALS_IN_PAYLOAD`.',
        '',
        '### Provider and model selection',
        '1. `provider` in the request, else the deployment default provider.',
        '2. `model` in the request, else the deployment default model for that provider.',
        'An explicitly requested provider is **never** silently replaced. If it is unknown the call',
        'fails with `PROVIDER_UNKNOWN`; if it is known but not enabled here, with',
        '`PROVIDER_NOT_CONFIGURED`. Fallback runs only when the request opts in *and* the deployment',
        'allows it, and the response always reports the provider that actually answered.',
        '',
        '### Rate limits',
        'A per-client (or per-IP when unauthenticated) token bucket is enforced. Exceeding it returns',
        '`429 RATE_LIMITED` with a `Retry-After` header. The configured limit and window are not',
        'disclosed in responses.',
      ].join('\n'),
    },
    ...(info.serverUrl ? { servers: [{ url: info.serverUrl }] } : {}),
    tags: [
      { name: 'Processing', description: 'Execute a task with the resolved provider.' },
      { name: 'Providers', description: 'Inspect registered providers and their capabilities.' },
      { name: 'Operations', description: 'Liveness, readiness and the machine-readable contract.' },
    ],
    components: {
      securitySchemes: {
        clientApiKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'opaque-client-key',
          description: 'Per-client API key. Send as `Authorization: Bearer <key>`.',
        },
      },
      schemas: {
        ProcessingRequest: {
          ...requestShape,
          description:
            'Everything task-specific arrives here. Unknown top-level properties are rejected (`.strict()`), which is also how provider credentials in a payload are refused.',
        },
        ProcessingSuccessResponse: jsonOut(processingSuccessResponseSchema),
        ProcessingErrorResponse: jsonOut(processingErrorResponseSchema),
        ErrorCode: { type: 'string', enum: [...ERROR_CODES] },
        ProviderId: { type: 'string', enum: [...PROVIDER_IDS] },
        OutputFormat: { type: 'string', enum: [...OUTPUT_FORMATS] },
        NormalizedUsage: {
          type: 'object',
          description:
            'Usage normalized across providers. `null` means the provider did not report the metric; `0` means it reported zero. The difference is intentional.',
          required: ['input_tokens', 'output_tokens', 'total_tokens', 'cached_input_tokens', 'reasoning_tokens'],
          properties: {
            input_tokens: { type: ['integer', 'null'] },
            output_tokens: { type: ['integer', 'null'] },
            total_tokens: { type: ['integer', 'null'] },
            cached_input_tokens: { type: ['integer', 'null'] },
            reasoning_tokens: { type: ['integer', 'null'] },
          },
        },
      },
    },
    security: [{ clientApiKey: [] }],
    paths: {
      '/v1/process': {
        post: {
          tags: ['Processing'],
          summary: 'Execute a provider-agnostic AI processing task',
          description: [
            'Runs the supplied `instructions` over the supplied `content`, with optional `context`.',
            '',
            'The instruction channel and the data channel are kept separate: instructions are sent as',
            'system/developer content, while `context` and `content` are wrapped in randomized',
            'delimiters and labelled as data. Instructions from the client are always the highest',
            'authority *within the request*; text inside the data channel cannot change the task.',
            'This materially raises the cost of an injection attack but does not eliminate it.',
            '',
            '`result` is a parsed object for `output.format=json`, never a JSON-encoded string nested',
            'in JSON. Truncation, refusal, unparseable output and schema violations are errors, not',
            'partial successes.',
          ].join('\n'),
          operationId: 'processRequest',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ProcessingRequest' },
                examples: {
                  textSummary: {
                    summary: 'Plain text output (the common case)',
                    value: {
                      provider: 'openai',
                      model: 'MODEL_ID_FOR_THIS_DEPLOYMENT',
                      instructions: 'Summarise the supplied article in exactly three sentences.',
                      context: { publication: 'example-daily', section: 'technology' },
                      content: {
                        type: 'text',
                        text: 'The article body to be processed goes here.',
                      },
                      options: { temperature: 0.2, max_output_tokens: 400, timeout_ms: 30000 },
                      metadata: { client_request_id: 'nc-2026-11-11-0001' },
                    },
                  },
                  structuredJson: {
                    summary: 'Schema-validated JSON output',
                    value: {
                      instructions: 'Extract a headline and topic tags from the article.',
                      content: { type: 'text', text: 'The article body to be processed goes here.' },
                      output: {
                        format: 'json',
                        schema_name: 'article_extract',
                        schema: {
                          type: 'object',
                          additionalProperties: false,
                          required: ['headline', 'tags'],
                          properties: {
                            headline: { type: 'string' },
                            tags: { type: 'array', items: { type: 'string' } },
                          },
                        },
                      },
                    },
                  },
                  markdown: {
                    summary: 'Markdown output',
                    value: {
                      instructions: 'Rewrite the article as a bulleted brief.',
                      content: { type: 'text', text: 'The article body to be processed goes here.' },
                      output: { format: 'markdown' },
                    },
                  },
                  explicitFallback: {
                    summary: 'Opt into fallback (only honoured when the deployment enables it)',
                    value: {
                      provider: 'openai',
                      model: 'MODEL_ID_FOR_THIS_DEPLOYMENT',
                      instructions: 'Summarise the supplied article.',
                      content: { type: 'text', text: 'The article body to be processed goes here.' },
                      fallback: { enabled: true, providers: ['anthropic'], model_overrides: { anthropic: 'MODEL_ID_FOR_THIS_DEPLOYMENT' } },
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Processed successfully. `provider` and `model` echo what actually answered.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ProcessingSuccessResponse' },
                  example: successExample,
                },
              },
            },
            400: errorResponse('Malformed request, invalid schema, unknown provider or unsupported option.', ['VALIDATION_FAILED', 'CREDENTIALS_IN_PAYLOAD', 'PROVIDER_UNKNOWN', 'OPTION_UNSUPPORTED', 'INVALID_JSON_SCHEMA', 'FALLBACK_INVALID']),
            401: errorResponse('Missing, malformed or invalid client credential.', ['AUTH_MISSING', 'AUTH_INVALID']),
            413: errorResponse('Request body exceeds the configured size limit.', ['PAYLOAD_TOO_LARGE']),
            422: errorResponse('The resolved provider cannot satisfy the requested output format, or the model refused.', ['OUTPUT_FORMAT_UNSUPPORTED', 'MODEL_REFUSED']),
            429: errorResponse('Client rate limit exceeded. Honour `Retry-After`.', ['RATE_LIMITED']),
            500: errorResponse('Unexpected server fault. The request ID is the support handle.', ['INTERNAL']),
            502: errorResponse('The provider failed or returned unusable output.', ['PROVIDER_AUTH_FAILED', 'PROVIDER_BAD_REQUEST', 'OUTPUT_UNPARSEABLE', 'OUTPUT_VALIDATION_FAILED', 'OUTPUT_TRUNCATED']),
            503: errorResponse('Provider unavailable, rate limiting us, or not configured in this deployment.', ['PROVIDER_UNAVAILABLE', 'PROVIDER_RATE_LIMITED', 'PROVIDER_NOT_CONFIGURED']),
            504: errorResponse('Execution deadline exceeded, including provider timeouts.', ['TIMEOUT', 'PROVIDER_TIMEOUT']),
          },
        },
      },
      '/v1/providers': {
        get: {
          tags: ['Providers'],
          summary: 'List registered providers and their capabilities',
          description:
            'Reports provider identifiers and capability traits only. Credentials, endpoints and per-provider token ceilings from the deployment configuration are never exposed.',
          operationId: 'listProviders',
          responses: { 200: { description: 'Registered providers.' }, 401: errorResponse('Missing or invalid credential.', ['AUTH_MISSING', 'AUTH_INVALID']) },
        },
      },
      '/health': {
        get: {
          tags: ['Operations'],
          summary: 'Liveness probe',
          security: [],
          description: 'Returns liveness only. No environment values, credentials, or infrastructure details.',
          operationId: 'health',
          responses: { 200: { description: 'The process is alive.' } },
        },
      },
      '/ready': {
        get: {
          tags: ['Operations'],
          summary: 'Readiness probe',
          security: [],
          description: 'Reports whether a usable provider set is registered. Returns 503 when not ready.',
          operationId: 'ready',
          responses: { 200: { description: 'Ready to serve.' }, 503: { description: 'Not ready.' } },
        },
      },
      '/openapi.json': {
        get: {
          tags: ['Operations'],
          summary: 'This document',
          security: [],
          operationId: 'openapi',
          responses: { 200: { description: 'The OpenAPI 3.1 description of this service.' } },
        },
      },
    },
  };
}
