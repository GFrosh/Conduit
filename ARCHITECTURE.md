# Architecture

This document describes how the AI Processing Engine is put together, why the boundaries sit where
they do, and what each module is allowed to know about.

---

## 1. Design stance

The engine exists to answer one question for many applications: *given instructions, context, and
content, run a task on whichever AI provider is available and answer in one fixed shape.*

Two constraints follow from that, and both are enforced mechanically rather than by convention:

| Constraint | Enforcement |
| --- | --- |
| No vendor coupling in the core | ESLint `no-restricted-imports` forbids `openai`, `@anthropic-ai/sdk`, `@google/genai` in `src/core/**` and `src/contracts/**` |
| No client-specific logic | No prompt text, editorial voice, or output schema exists in `src/`; the only task-related strings are the request fields themselves |

A third constraint is structural: `contracts` may not import from `core`, `http`, or `providers`. It is
the leaf of the dependency graph, which is what lets the orchestrator and every adapter be tested
without HTTP and without a network.

---

## 2. Module responsibilities

```
src/
├── app.ts                     composition root: wires plugins, routes, adapters, orchestrator
├── server.ts                  process entry: config → buildApp → listen → signal handlers
├── config/
│   ├── env.ts                 Zod env schema, AppConfig, fail-fast validation, key hashing
│   └── limits.ts              static budgets (chars, depth, schema size, token ceiling)
├── contracts/                 types + Zod schemas. Imports nothing from the rest of src
│   ├── common.ts              provider ids, output formats, finish reasons, error codes, usage
│   ├── request.ts             ProcessingRequest and its parts (strict objects)
│   ├── response.ts            ProcessingSuccessResponse / ProcessingErrorResponse
│   ├── generation.ts          ProviderCapabilities, GenerationRequest/Response, PromptPlan
│   ├── provider.ts            ProviderAdapter + ProviderRegistry
│   └── openapi.ts             OpenAPI 3.1 document generated from the above schemas
├── core/
│   ├── process/
│   │   ├── resolveProvider.ts provider + model precedence, no substitution
│   │   ├── fallback.ts        candidate planning for opt-in failover
│   │   ├── negotiateOptions.ts capability negotiation, clamping, warnings
│   │   ├── orchestrator.ts    the pipeline
│   │   ├── retry.ts           bounded retry with deadline arithmetic
│   │   └── normalizeResponse.ts result/usage/finish-reason normalization + JSON parsing
│   ├── prompt/buildPrompt.ts  instruction channel vs delimited data channel
│   ├── validation/
│   │   ├── schema-validator.ts Ajv 2020-12, size/depth caps, no remote $ref
│   │   └── context-budget.ts   cost guard for arbitrary context JSON
│   ├── errors/AppError.ts     one error class discriminated by code; client-safe messages
│   ├── observability/         logger redaction + the structured request log line
│   ├── security/              constant-time hashing, secret redaction
│   └── runtime/shutdown.ts    graceful drain with a bounded budget
├── providers/
│   ├── registry.ts            register / has / get / require / list
│   ├── factory.ts             the only place concrete adapters are named
│   ├── shared/                error-mapping, schema-shaping (vendor-neutral helpers)
│   ├── openai/adapter.ts      ProviderAdapter over the OpenAI Responses API
│   ├── anthropic/adapter.ts   ProviderAdapter over Messages
│   ├── gemini/adapter.ts      ProviderAdapter over generateContent
│   └── mock/adapter.ts        deterministic adapter, no network
└── http/
    ├── plugins/               request-context (auth, id), client-signal, credential-guard,
    │                          error-handler, rate-limit, request-logger
    ├── routes/                process, providers, health, openapi, docs
    └── presenters/            response shaping at the edge
```

### What each layer may know

| Layer | May import | Must never know |
| --- | --- | --- |
| `contracts` | itself, Zod | Fastify, any SDK, business logic |
| `core` | `contracts`, `config`, Node built-ins | Fastify types, any vendor SDK, HTTP status codes |
| `providers` | `contracts`, `core/errors`, its own SDK | the orchestrator, HTTP, config parsing |
| `http` | everything above | vendor SDK types |

`core` producing no HTTP status codes is deliberate: `AppError` carries a `code`, and the status mapping
lives in one place (`AppError.DEFAULT_STATUS`). The domain never negotiates with a transport.

---

## 3. Request lifecycle

A `POST /v1/process` passes through these stages in order. Each is a separate function, so it can be
tested and reasoned about alone.

```
 1  HTTP parser          body limit → 413 PAYLOAD_TOO_LARGE
 2  request-context      request id (client-supplied if well formed, else generated)
                         bearer auth → 401 AUTH_MISSING / AUTH_INVALID
 3  client-signal        AbortSignal bound to socket close
 4  credential-guard     scans the payload for credential-shaped keys → 400 CREDENTIALS_IN_PAYLOAD
 5  rate-limit           429 RATE_LIMITED, keyed by client id, Retry-After
 6  schema validation    Zod, strict objects → 400 VALIDATION_FAILED
 7  context budget       depth + key count → 400 VALIDATION_FAILED
 8  resolveProvider      provider precedence, model precedence, allowed models
 9  planCandidates       primary first, opt-in fallback candidates, bounded
10  negotiateOptions     per candidate: temperature / top_p / max_output_tokens
11  assertValidSchema    size, depth, no remote $ref, Ajv compile
12  buildPrompt          instruction channel + nonce-delimited data channel
13  executeWithRetry     deadline budget, per-attempt abort, retry classification
14  adapter.generate     vendor SDK call, response mapped to GenResponse
15  normalizeResponse    text/markdown, or strict JSON.parse + Ajv validate
16  presenter            contract-shaped success payload
17  request-logger       one structured line: ids, provider, timing, usage, error code
```

Failures at any stage produce an `AppError`; the error handler renders the same envelope in every case,
so a client parses one shape whatever went wrong.

---

## 4. Provider resolution

Resolution is a pure function of the request and the deployment configuration, with no I/O and no
substitution.

**Provider:**

1. `request.provider`, if present.
2. Otherwise `DEFAULT_PROVIDER`.
3. An unrecognised id → `PROVIDER_UNKNOWN` (400) with the known list in `details`.
4. A known but unregistered id → `PROVIDER_NOT_CONFIGURED` (503) with the available list.

There is deliberately no "fall back to whatever is available". Silent substitution makes billing,
latency, and output style unpredictable, and hides configuration errors. Failover exists, but only as
an explicit opt-in (see §6).

**Model:**

1. `request.model`, if present — checked against `allowed_models` when that list is configured
   (`MODEL_NOT_ALLOWED` otherwise).
2. Otherwise the provider's `DEFAULT_MODEL_<PROVIDER>`.
3. Neither available → `MODEL_REQUIRED` (400).

No model identifier appears anywhere in `src/`. A grep for `gpt-`, `claude-`, or `gemini-` returns zero
matches outside tests, because a model name is a deployment fact that changes on the vendor's schedule.

---

## 5. Processing orchestration

`createOrchestrator(deps)` receives its collaborators rather than importing them: registry, resolution
config, schema validator, default timeout, service version, fallback config, and injectable `now`/id
generators. That is what makes the pipeline deterministic under test — a fixed clock yields a fixed
`duration_ms`.

Two rules the orchestrator enforces and adapters rely on:

- **Adapters never retry.** Backoff belongs in one place, with one deadline; a retrying adapter would
  multiply attempts and blow the budget.
- **Adapters never parse structured output.** They return text. Parsing, validation, and the decision
  to report `OUTPUT_UNPARSEABLE` vs `OUTPUT_VALIDATION_FAILED` happen in core, so all three providers
  behave identically.

Time budget: `timeoutMs = min(request.options.timeout_ms ?? default, default)`. A client may lower the
budget, never raise it. The remaining budget is passed down as an `AbortSignal.any([deadline, attempt,
clientDisconnect])`.

---

## 6. Fallback

Off unless both the deployment enables it (`FALLBACK_ENABLED`) and the request opts in
(`fallback.enabled: true`). When it runs:

- Candidates are `[primary, ...declared]`, deduplicated, capped at `FALLBACK_MAX_ATTEMPTS` (default 2).
- A provider without a configured model or credential is skipped, not guessed.
- Failover is allowed only for codes another provider could plausibly fix: `PROVIDER_UNAVAILABLE`,
  `PROVIDER_TIMEOUT`, `PROVIDER_RATE_LIMITED`, `PROVIDER_AUTH_FAILED`, `PROVIDER_MODEL_NOT_FOUND`, and
  unusable output. Validation errors, unsupported options, and invalid schemas fail immediately — they
  are not provider problems.
- The response reports the provider that actually answered, with `fallback_used: true` and a
  `FALLBACK_USED` warning, so a client is never misled about provenance.

---

## 7. Response normalization

One success shape, one error shape, three providers.

| Concern | Normalization |
| --- | --- |
| Text | `{ type: 'text', text }` or `{ type: 'markdown', text }` |
| JSON | `{ type: 'json', data }` — the parsed object, never a JSON string nested in JSON |
| Usage | `input_tokens`, `output_tokens`, `total_tokens`, `cached_input_tokens`, `reasoning_tokens`; **`null` means the provider did not report it**, `0` means it reported zero. `total_tokens` is never derived from the parts |
| Finish reason | `stop` / `length` / `content_filter` / `refusal` / `tool_calls` / `unknown`; an unrecognised vendor stop code maps to `unknown`, never to `stop` |
| Truncation / refusal | `finish_reason: length` → `OUTPUT_TRUNCATED`; `refusal` → `MODEL_REFUSED`. A truncated answer is never returned as a 200 success |
| Warnings | `OPTION_CLAMPED`, `OPTION_IGNORED`, `OPTION_DEFAULTED`, `SCHEMA_KEYWORD_DROPPED`, `SCHEMA_MODIFIED`, `FALLBACK_USED` |

Structured output is a hard contract: `JSON.parse` with no fence stripping, then Ajv against the
client's original schema. A fenced or malformed response is `OUTPUT_UNPARSEABLE`; a well-formed but
non-conforming one is `OUTPUT_VALIDATION_FAILED`. Neither is ever returned as success, and there is no
automatic correction pass (see `docs/PROVIDER-LIMITATIONS.md` for the reasoning).

---

## 8. Error handling

A single `AppError` class discriminated by `code` — not a subclass hierarchy. One class means the error
handler has one shape to render, and adding a code is a one-line change.

- **Client-safe messages.** `DEFAULT_MESSAGES` are written for API consumers. Vendor text never reaches
  a response body; it is logged (redacted) and, where useful, summarized into `details`.
- **Status mapping in one table.** `PROVIDER_AUTH_FAILED` → 502 (our credential, their rejection),
  `PROVIDER_MODEL_NOT_FOUND` → 400 (the client asked for a model that does not exist), `TIMEOUT` → 504,
  `INTERNAL` → 500.
- **Retryability is data.** `RETRYABLE` is a code set, so `error.retryable` is answerable without the
  handler knowing what happened.
- **Non-`AppError` escaping an adapter is `INTERNAL` (500), not `PROVIDER_UNAVAILABLE` (503).** Adapters
  are responsible for translating every SDK fault; an untranslated throw means our code broke, and
  blaming the vendor would send an operator to the wrong dashboard.
- **Two acquisition paths for credentials in the body:** a pre-validation scan (catches it even when the
  rest of the body is invalid) and `.strict()` schema rejection (the backstop).

---

## 9. Known complexity and simplification opportunities

Audited deliberately, not overlooked:

1. **`fallback.ts` is the most intricate module** (~130 lines, 10 tests). It is justified by the
   requirement that failover never silently overrides an explicit provider. If failover is declared out
   of scope, deleting this module and two call sites in the orchestrator removes real complexity with no
   loss to the core contract.
2. **Two JSON-Schema libraries.** Zod validates the *request*; Ajv validates the *client-supplied schema
   and the parsed output*. Zod cannot express "validate this arbitrary schema document", so both are
   necessary — but it is worth knowing there are two.
3. **`shared/schema-shaping.ts` carries per-provider quirks** (OpenAI strict closure, Gemini keyword
   stripping). It is shared to avoid triplicating traversal code, not because the rules are the same.
4. **`meta.timings.provider_ms` vs top-level `duration_ms`** can look redundant. They measure different
   things (vendor call vs whole request including validation); the deterministic-clock test pins the
   distinction.
5. **`providers` route reads `resolution` config directly.** A `ProviderDescriptor` returned by the
   adapter would be cleaner, but would push deployment config into adapters. Current split is the lesser
   evil.

---

## 10. Verification performed for this audit

| Check | Method | Result |
| --- | --- | --- |
| Circular dependencies | import-graph DFS over 51 source files | **0 cycles** |
| Layering violations | graph edges `core→http/providers`, `contracts→*` | **0** |
| SDK isolation | grep for vendor imports | 3 hits, all inside `src/providers/*/adapter.ts` |
| Hardcoded model ids | grep `gpt-`, `claude-`, `gemini-` in `src/` | **0** |
| Application-specific terms | grep `naija\|chronoscope\|editorial\|newsroom` | **0** |
| Type safety | `tsc --noEmit` (strict, `noUncheckedIndexedAccess`) | clean |
| Lint | ESLint 9 flat config | clean |
| Build | `tsc -p tsconfig.build.json` | clean |
| Tests | Vitest, 19 files | 278 passing |
