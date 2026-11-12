# Environment Variables

All variables are parsed and validated by a Zod schema at boot (`src/config/env.ts`). An invalid value
stops start-up with exit code `1` and names the variable — the process never runs half-configured.

Booleans accept `true/false`, `1/0`, `yes/no`, `on/off` (case-insensitive).

---

## Runtime

| Variable | Default | Validation | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` | Logger output mode, docs default |
| `HOST` | `0.0.0.0` | non-empty string | Bind address |
| `PORT` | `3000` | 0–65535 | Bind port |
| `LOG_LEVEL` | `info` | `fatal`…`trace`, `silent` | pino level |
| `APP_VERSION` | `0.0.0` | non-empty string | Reported in `meta.service_version` and `/health` |

## Provider wiring

| Variable | Default | Validation | Purpose |
| --- | --- | --- | --- |
| `PROVIDER_MODE` | `mock` | `mock` \| `live` | `mock` registers deterministic adapters (no network, no keys). `live` registers real adapters and **requires** a credential for each enabled provider |
| `ENABLED_PROVIDERS` | `openai,anthropic,gemini` | comma-separated ids, ≥1 | The deployment's allow-list; unlisted providers are not registered |
| `DEFAULT_PROVIDER` | — **required** | must appear in `ENABLED_PROVIDERS` | Provider used when a request omits `provider` |
| `DEFAULT_MODEL_OPENAI` / `_ANTHROPIC` / `_GEMINI` | empty | optional string | Default model per provider. Empty ⇒ a request omitting `model` fails with `MODEL_REQUIRED` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | empty | optional string | Provider credentials. Required for every enabled provider when `PROVIDER_MODE=live` |
| `MAX_OUTPUT_TOKENS_OPENAI` / `_ANTHROPIC` / `_GEMINI` | empty | optional positive integer | Deployment ceiling per provider. Unset ⇒ adapter default (OpenAI 16 384, Anthropic 8 192, Gemini 8 192) |

No model identifier is hardcoded in `src/`. All three `DEFAULT_MODEL_*` are intentionally empty in
`.env.example`.

## Request handling

| Variable | Default | Validation | Purpose |
| --- | --- | --- | --- |
| `REQUEST_TIMEOUT_MS` | `60000` | 1 000–600 000 | Whole-request budget. A request's `options.timeout_ms` may lower it, never raise it |
| `MAX_BODY_BYTES` | `1048576` | 1 024–67 108 864 | Framework body limit; exceeded ⇒ `413 PAYLOAD_TOO_LARGE` |

## Authentication

| Variable | Default | Validation | Purpose |
| --- | --- | --- | --- |
| `AUTH_ENABLED` | `true` | boolean | Disable only for isolated local testing |
| `SERVICE_API_KEYS` | `''` | `<key-id>:<secret>` pairs, unique ids, secret ≥8 chars | Client credentials. A 64-hex secret is treated as a pre-computed SHA-256 digest, so plaintext need never reach the process |

Required when `AUTH_ENABLED=true`; empty or malformed ⇒ boot failure.

## Rate limiting

| Variable | Default | Validation | Purpose |
| --- | --- | --- | --- |
| `RATE_LIMIT_ENABLED` | `true` | boolean | |
| `RATE_LIMIT_MAX` | `60` | 1–1 000 000 | Requests per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 1 000–3 600 000 | Window length |
| `RATE_LIMIT_PER_CLIENT` | `AUTH_ENABLED` | boolean | Key by authenticated client id (IP fallback) instead of IP |

Limits are **per process instance**. With N replicas the effective ceiling is N × `RATE_LIMIT_MAX`.
Nothing about the limits is exposed in responses beyond `Retry-After`.

## Fallback

| Variable | Default | Validation | Purpose |
| --- | --- | --- | --- |
| `FALLBACK_ENABLED` | `false` | boolean | Master switch. A request's `fallback` block is rejected (`FALLBACK_INVALID`) while this is false |
| `FALLBACK_PROVIDERS` | empty | comma-separated ids, each in `ENABLED_PROVIDERS`, unique | Default failover order when a request enables fallback without naming providers |
| `FALLBACK_MAX_ATTEMPTS` | `2` | 1–4 | Ceiling on providers tried per request, including the primary |

## Logging

| Variable | Default | Validation | Purpose |
| --- | --- | --- | --- |
| `LOG_CONTENT` | `false` | boolean | Permit content sampling. Effective only with `LOG_SAMPLE_RATE > 0` |
| `LOG_INSTRUCTIONS` | `false` | boolean | Permit instruction sampling. Same gating |
| `LOG_SAMPLE_RATE` | `0` | 0–1 | Fraction of requests eligible for sampling |

Content and instructions are never logged by default; samples are key-redacted and truncated to 240
characters.

## Documentation surface

| Variable | Default | Validation | Purpose |
| --- | --- | --- | --- |
| `DOCS_ENABLED` | `NODE_ENV !== 'production'` | boolean | Serve Swagger UI at `/docs`. `/openapi.json` is always available |
| `PUBLIC_BASE_URL` | empty | optional URL | `servers[]` entry in the OpenAPI document, for clients behind a gateway |

## Live integration tests only

| Variable | Purpose |
| --- | --- |
| `OPENAI_TEST_MODEL`, `ANTHROPIC_TEST_MODEL`, `GEMINI_TEST_MODEL` | Model used by `npm run test:live`. Each probe skips unless both its key and this value are set |

---

## Minimal production set

```dotenv
NODE_ENV=production
PORT=3000
PROVIDER_MODE=live
ENABLED_PROVIDERS=openai,anthropic
DEFAULT_PROVIDER=openai
DEFAULT_MODEL_OPENAI=<model id>
DEFAULT_MODEL_ANTHROPIC=<model id>
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
AUTH_ENABLED=true
SERVICE_API_KEYS=nc:<32+ char secret>,other-app:<32+ char secret>
REQUEST_TIMEOUT_MS=60000
RATE_LIMIT_MAX=60
```

## Boot failures you will actually hit

| Message | Cause |
| --- | --- |
| `DEFAULT_PROVIDER '<x>' is not present in ENABLED_PROVIDERS.` | Default not in the allow-list |
| `PROVIDER_MODE=live requires credentials for: <ids>.` | Missing provider key |
| `SERVICE_API_KEYS must contain at least one '<key-id>:<secret>' entry when AUTH_ENABLED=true.` | Auth on, no keys |
| `Duplicate API key id '<id>'.` | Same key id twice |
| `Secret for key '<id>' must be at least 8 characters.` | Trivially short secret |
