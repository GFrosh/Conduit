# API Reference

Base URL: `https://<your-host>` · Version prefix: `/v1` · Content type: `application/json`

The machine-readable contract is authoritative and always available at **`GET /openapi.json`**
(OpenAPI 3.1, generated from the same Zod schemas the server validates with). This document is the
prose companion, with complete examples.

---

## Authentication

Every endpoint except the public probes requires a client API key:

```
Authorization: Bearer <client-key>
```

| Situation | Response |
| --- | --- |
| Header absent | `401` `AUTH_MISSING` |
| Header malformed (wrong scheme, empty token, extra parts) | `401` `AUTH_INVALID` |
| Key not recognised | `401` `AUTH_INVALID` |
| Provider credential (`apiKey`, `token`, `secret`, …) in the body | `400` `CREDENTIALS_IN_PAYLOAD` |

Keys are configured server-side as `SERVICE_API_KEYS=<key-id>:<secret>,…`. The service stores only
SHA-256 digests and compares in constant time. Provider credentials are server configuration and are
**never** accepted from a client.

Public (unauthenticated): `GET /health`, `GET /ready`, `GET /openapi.json`.

---

## `POST /v1/process`

Runs the supplied instructions over the supplied content and returns a normalized result.

### Request fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `provider` | string | no | Provider id. Defaults to the deployment's `DEFAULT_PROVIDER` |
| `model` | string | no | Provider-specific model id. Defaults to that provider's configured default |
| `instructions` | string | **yes** | 1–16 000 chars. The task itself. Sent in the instruction channel |
| `context` | string \| object | no | Supporting material. ≤100 000 chars, depth ≤8, ≤2 000 keys |
| `content` | `{ type: 'text', text }` | **yes** | The material to process. 1–200 000 chars |
| `output` | object | no | `{ format: 'text' }` (default), `{ format: 'markdown' }`, or `{ format: 'json', schema, schema_name?, validate? }` |
| `options` | object | no | `temperature` 0–2, `top_p` 0–1, `max_output_tokens` 1–32 000, `timeout_ms` 1 000–600 000, `on_unsupported_option`: `reject` (default) \| `ignore` |
| `fallback` | object | no | `{ enabled: true, providers: [...], model_overrides?, on? }` — opt-in failover |
| `metadata` | object | no | `{ client_request_id }`, echoed back for correlation |

The body is **strict**: an unknown top-level field is rejected rather than ignored.

### Response fields (success)

| Field | Type | Notes |
| --- | --- | --- |
| `success` | `true` | |
| `request_id` | string | Echo the `x-request-id` you sent (if well formed), else server-generated |
| `provider` | string | The provider that **actually** served the request |
| `model` | string | The model id actually used |
| `result` | object | `{ type: 'text', text }`, `{ type: 'markdown', text }`, or `{ type: 'json', data }` |
| `usage` | object | `input_tokens`, `output_tokens`, `total_tokens`, `cached_input_tokens`, `reasoning_tokens`. `null` = provider did not report it; `0` = reported zero |
| `duration_ms` | integer | Whole request |
| `meta.finish_reason` | enum | `stop` \| `length` \| `content_filter` \| `refusal` \| `tool_calls` \| `unknown` |
| `meta.fallback_used` | boolean | |
| `meta.attempts` | array | `{ provider, model, outcome, error_code?, duration_ms }` |
| `meta.warnings` | array | `{ code, message, field? }` |
| `meta.provider_request_id` | string \| null | Vendor correlation id, when offered |
| `meta.client_request_id` | string? | Echo of `metadata.client_request_id` |
| `meta.service_version` | string | |
| `meta.timings` | object | `{ provider_ms, validation_ms }` |

—

### Example 1 — plain text summary

```bash
curl -s https://api.example.com/v1/process \
  -H "Authorization: Bearer $CLIENT_KEY" \
  -H "content-type: application/json" \
  -H "x-request-id: nc-2026-11-11-0001" \
  -d @- <<'JSON'
{
  "provider": "openai",
  "model": "your-configured-model",
  "instructions": "Summarise the content in three factual sentences. Do not add opinions.",
  "context": { "publication": "daily", "region": "West Africa" },
  "content": { "type": "text", "text": "Full article body goes here..." },
  "output": { "format": "text" },
  "options": { "temperature": 0.2, "max_output_tokens": 400, "timeout_ms": 30000 },
  "metadata": { "client_request_id": "nc-2026-11-11-0001" }
}
JSON
```

```json
{
  "success": true,
  "request_id": "nc-2026-11-11-0001",
  "provider": "openai",
  "model": "your-configured-model",
  "result": {
    "type": "text",
    "text": "The article reports a regional transport agreement signed on Monday. It covers four corridors and a phased tariff schedule. Implementation begins next quarter."
  },
  "usage": {
    "input_tokens": 812,
    "output_tokens": 96,
    "total_tokens": 908,
    "cached_input_tokens": 0,
    "reasoning_tokens": null
  },
  "duration_ms": 1843,
  "meta": {
    "finish_reason": "stop",
    "fallback_used": false,
    "attempts": [
      { "provider": "openai", "model": "your-configured-model", "outcome": "success", "duration_ms": 1811 }
    ],
    "warnings": [],
    "provider_request_id": "resp_0f3c...",
    "client_request_id": "nc-2026-11-11-0001",
    "service_version": "0.1.0",
    "timings": { "provider_ms": 1811, "validation_ms": null }
  }
}
```

### Example 2 — structured JSON with schema enforcement

```json
{
  "instructions": "Extract a headline, a one-sentence summary, and up to five topical tags.",
  "content": { "type": "text", "text": "Full article body goes here..." },
  "output": {
    "format": "json",
    "schema_name": "article_extract",
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["headline", "summary", "tags"],
      "properties": {
        "headline": { "type": "string", "minLength": 10, "maxLength": 120 },
        "summary": { "type": "string" },
        "tags": { "type": "array", "items": { "type": "string" }, "maxItems": 5 }
      }
    }
  }
}
```

```json
{
  "success": true,
  "request_id": "req_9f2a1c4b",
  "provider": "anthropic",
  "model": "your-configured-model",
  "result": {
    "type": "json",
    "data": {
      "headline": "Four-Nation Transport Pact Signed",
      "summary": "Ministers agreed a phased tariff schedule across four corridors, starting next quarter.",
      "tags": ["transport", "trade", "west-africa", "policy"]
    }
  },
  "usage": {
    "input_tokens": 940,
    "output_tokens": 128,
    "total_tokens": null,
    "cached_input_tokens": 0,
    "reasoning_tokens": null
  },
  "duration_ms": 2210,
  "meta": {
    "finish_reason": "stop",
    "fallback_used": false,
    "attempts": [
      { "provider": "anthropic", "model": "your-configured-model", "outcome": "success", "duration_ms": 2180 }
    ],
    "warnings": [],
    "provider_request_id": "msg_01X...",
    "service_version": "0.1.0",
    "timings": { "provider_ms": 2180, "validation_ms": 3 }
  }
}
```

Note `total_tokens: null` — Anthropic does not report it and the service will not derive it.

`result.data` is the **parsed object**, never a JSON string embedded in JSON. If the model returns
fenced or malformed JSON the request fails with `OUTPUT_UNPARSEABLE`; if it parses but violates the
schema, it fails with `OUTPUT_VALIDATION_FAILED`. Neither is returned as a success.

### Example 3 — explicit failover (opt-in)

```json
{
  "provider": "openai",
  "instructions": "Rewrite the passage in plain English.",
  "content": { "type": "text", "text": "..." },
  "fallback": {
    "enabled": true,
    "providers": ["anthropic", "gemini"],
    "model_overrides": { "anthropic": "your-other-model" }
  }
}
```

Requires `FALLBACK_ENABLED=true` on the server, otherwise `400 FALLBACK_INVALID`. The response reports
the provider that actually answered plus `meta.fallback_used: true` and a `FALLBACK_USED` warning.

### Error response

Identical envelope for every failure:

```json
{
  "success": false,
  "request_id": "req_9f2a1c4b",
  "error": {
    "code": "OUTPUT_VALIDATION_FAILED",
    "message": "The model's structured output did not satisfy the requested schema.",
    "retryable": false,
    "details": { "errors": [{ "path": "/tags", "message": "must NOT have more than 5 items" }] },
    "attempted": [{ "provider": "openai", "model": "your-configured-model", "code": "OUTPUT_VALIDATION_FAILED" }]
  }
}
```

### Status and error codes

| HTTP | Codes |
| --- | --- |
| 200 | success |
| 400 | `VALIDATION_FAILED`, `CREDENTIALS_IN_PAYLOAD`, `PROVIDER_UNKNOWN`, `MODEL_REQUIRED`, `MODEL_NOT_ALLOWED`, `OPTION_UNSUPPORTED`, `INVALID_JSON_SCHEMA`, `FALLBACK_INVALID`, `PROVIDER_MODEL_NOT_FOUND` |
| 401 | `AUTH_MISSING`, `AUTH_INVALID` |
| 404 | `NOT_FOUND` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 422 | `OUTPUT_FORMAT_UNSUPPORTED`, `MODEL_REFUSED` |
| 429 | `RATE_LIMITED` (with `Retry-After`) |
| 500 | `INTERNAL` |
| 502 | `PROVIDER_AUTH_FAILED`, `PROVIDER_BAD_REQUEST`, `OUTPUT_UNPARSEABLE`, `OUTPUT_VALIDATION_FAILED`, `OUTPUT_TRUNCATED` |
| 503 | `PROVIDER_UNAVAILABLE`, `PROVIDER_RATE_LIMITED`, `PROVIDER_NOT_CONFIGURED` |
| 504 | `TIMEOUT`, `PROVIDER_TIMEOUT` |

`error.retryable` is authoritative: retry only when it is `true`, and honour `Retry-After` on 429.

---

## `GET /v1/providers`

Authenticated. What this deployment can do — no keys, no endpoints, no vendor versions.

```json
{
  "default_provider": "openai",
  "providers": [
    {
      "id": "openai",
      "default_model": "your-configured-model",
      "allowed_models": null,
      "capabilities": {
        "structured_output": "json_schema_strict",
        "supported_options": ["temperature", "top_p", "max_output_tokens"],
        "unenforced_schema_keywords": [],
        "supports_system_channel": true,
        "max_output_tokens": 16384
      }
    }
  ]
}
```

---

## `GET /health` (public)

Liveness only. `200` while the process is alive.

```json
{ "status": "ok", "version": "0.1.0", "uptime_s": 4213 }
```

## `GET /ready` (public)

Readiness. `200` when a provider is registered and the default is available; `503` otherwise.

```json
{ "status": "ready", "version": "0.1.0", "checks": { "providers_registered": 3 } }
```

```json
{
  "status": "not_ready",
  "version": "0.1.0",
  "checks": { "providers_registered": 0, "reason": "no_providers_registered" }
}
```

## `GET /openapi.json` (public)

OpenAPI 3.1 document, generated from the runtime schemas. `Cache-Control: public, max-age=300`.

## `GET /docs`

Swagger UI. Development only unless `DOCS_ENABLED=true`.
