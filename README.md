# AI Processing Engine

A standalone, provider-agnostic AI processing microservice. Clients send instructions, optional
context, and the content to process over HTTP; the engine selects an AI provider, executes the task,
and returns a normalized response that is identical in shape regardless of which provider served it.

The service contains **no application prompts and no business logic**. Every task-specific detail —
what to do, what voice to write in, what output schema to satisfy — arrives in the request. Naija
Chronoscope can be one client of this service; so can any other application, without a code change.

---

## Contents

- [Project overview](#project-overview)
- [Architecture summary](#architecture-summary)
- [Technology stack](#technology-stack)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Environment configuration](#environment-configuration)
- [Development commands](#development-commands)
- [Testing](#testing)
- [Production build](#production-build)
- [Deployment](#deployment)
- [Further reading](#further-reading)

---

## Project overview

| Property | Value |
| --- | --- |
| Kind | Stateless HTTP microservice |
| Interface | `POST /v1/process`, plus `/v1/providers`, `/health`, `/ready`, `/openapi.json` |
| Providers | OpenAI, Anthropic, Google Gemini (independent adapters, one interface) |
| Auth | Bearer client API keys, server-side only for provider credentials |
| State | None. No database, no cache, no queue, no session store |
| Runtime | Node.js ≥ 22, ESM |
| Tests | 19 files / 278 tests, no network required |

**Core principles, enforced rather than aspirational:**

1. **Provider agnosticism** — adapters implement one `ProviderAdapter` interface; the orchestrator
   cannot import a vendor SDK (ESLint blocks it).
2. **Instruction agnosticism** — no prompt text, editorial rule, or output format lives in `src/`.
3. **Contract-driven** — request, response, error, and provider interfaces are typed and validated; the
   OpenAPI document is generated from the same schemas used at runtime.
4. **Stateless** — every request carries everything needed to serve it.
5. **Separation of concerns** — HTTP, validation, orchestration, provider resolution, adapters, and
   normalization are separate modules with one-directional dependencies.
6. **Extensibility** — adding a provider touches `src/providers/<name>/` and one factory function.
7. **Security by default** — provider credentials never cross the trust boundary; client
   credentials are hashed and compared in constant time.

---

## Architecture summary

```
HTTP (Fastify)
  │  request id · bearer auth · client-disconnect signal · credential guard
  │  rate limit · body limit
  ▼
Routes ──► Orchestrator (src/core/process)
             │  1 resolve provider + model
             │  2 plan optional fallback candidates
             │  3 negotiate options against declared capabilities
             │  4 validate client JSON Schema (Ajv, no remote $ref)
             │  5 build prompt (instruction channel vs data channel)
             │  6 execute with retry + deadline budget
             │  7 normalize result, usage, finish reason
             │  8 parse and validate structured output
             ▼
          ProviderAdapter  ←  one implementation per vendor
          (openai | anthropic | gemini | mock)
```

Dependency direction is strictly one way: `http → core → contracts ← providers`. `contracts` imports
nothing from `core`, `http`, or `providers`; `core` never imports `http` or a vendor SDK. There are no
circular dependencies (verified by an import-graph audit, see `ARCHITECTURE.md`).

Full detail: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Technology stack

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js ≥ 22 | `AbortSignal.any`, native `fetch`, stable ESM |
| Language | TypeScript 5.9 (strict + `noUncheckedIndexedAccess`) | Contracts are types before they are code |
| HTTP | Fastify 5 | Schema-first validation, encapsulated plugins, low overhead |
| Validation | Zod 4 + `fastify-type-provider-zod` | One schema per concept; TS types inferred, never duplicated |
| JSON Schema | Ajv 8 (draft 2020-12) | Client-supplied schemas are not Zod schemas; Ajv validates them |
| Providers | `openai`, `@anthropic-ai/sdk`, `@google/genai` | Official SDKs, pinned |
| Tests | Vitest 3 | Fast, ESM-native, same runner for unit and HTTP tests |
| Logs | pino | Structured JSON with redaction paths |
| Lint/format | ESLint 9 (flat) + Prettier 3 | Includes the layering rule that blocks SDK imports into `core` |
| Docs | `@fastify/swagger` + Swagger UI, OpenAPI 3.1 | Contract generated from runtime schemas |

No database, no cache server, no message broker, no container orchestration assumptions.

---

## Prerequisites

- Node.js ≥ 22.0.0 (`node --version`)
- npm ≥ 10 (ships with Node 22)
- One provider API key per provider you intend to enable — **only** when running in live mode
- Optional: Docker 24+ for container builds

---

## Installation

```bash
git clone <repository-url> ai-processing-engine
cd ai-processing-engine
npm ci                 # exact, lockfile-pinned install

cp .env.example .env   # then edit
```

`.env` is git-ignored. `.env.example` contains placeholders only and is safe to commit.

The service **fails fast at boot** if configuration is invalid: a missing client key while
`AUTH_ENABLED=true`, a `DEFAULT_PROVIDER` not present in `ENABLED_PROVIDERS`, a malformed key entry, or
(live mode) a missing provider credential. Every issue is printed with its variable name; no partial
start-up is possible.

Run the default mock configuration — no credentials, no network, no cost:

```bash
npm run dev
curl -s localhost:3000/health
```

---

## Environment configuration

Every variable is validated by a Zod schema at boot (`src/config/env.ts`). The complete reference,
including defaults and failure modes, is in **[docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)**.

The minimum needed to process a request locally:

```dotenv
PROVIDER_MODE=live
ENABLED_PROVIDERS=openai,anthropic,gemini
DEFAULT_PROVIDER=openai
DEFAULT_MODEL_OPENAI=<a model id you have access to>
OPENAI_API_KEY=sk-...
SERVICE_API_KEYS=demo-key:change-me-please
```

Two deliberate omissions:

- **Model identifiers are never hardcoded.** `DEFAULT_MODEL_*` is deployment configuration; a request
  that omits `model` while the corresponding default is unset fails with `MODEL_REQUIRED`.
- **Provider credentials are never accepted from clients.** The request schema is strict; a body
  carrying `apiKey` is rejected with `CREDENTIALS_IN_PAYLOAD` before validation runs.

---

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | `tsx` watch mode against `src/server.ts`, pino-pretty logs |
| `npm run build` | Compile `src/` to `dist/` (`tsconfig.build.json`) |
| `npm start` | Run the compiled build |
| `npm run typecheck` | `tsc --noEmit` across `src/` and `test/` |
| `npm run lint` | ESLint, including the layering/SDK-import rule |
| `npm run lint:fix` | ESLint with `--fix` |
| `npm run format` / `format:check` | Prettier write / verify |
| `npm test` | Full Vitest suite (unit + HTTP integration) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:live` | Opt-in live provider probes (needs credentials, excluded from CI) |
| `npm run verify` | `typecheck && lint && test` — the gate before any commit |

---

## Testing

```bash
npm run verify
```

Expected output shape (2026-11-11):

```
Test Files  19 passed (19)
     Tests  278 passed (278)
```

Coverage by area:

| File | What it pins |
| --- | --- |
| `test/unit/providers/{openai,anthropic,gemini}.test.ts` | Wire shape per SDK, finish reasons, usage mapping, HTTP → error-code mapping, credential redaction |
| `test/unit/providers/parity.test.ts` | One request through all three adapters → identical output shape |
| `test/unit/orchestrator.test.ts` | Pipeline order, option negotiation, truncation/refusal, determinism |
| `test/unit/fallback.test.ts` | Candidate planning, opt-in rules, bounded attempts, code allow-list |
| `test/unit/retry.test.ts` | Retryable classification, backoff caps, `Retry-After`, deadline arithmetic |
| `test/unit/prompt.test.ts` | Instruction/data channel split, nonce delimiters, context budget |
| `test/unit/request.validation.test.ts` | Strict schema, credential rejection, length caps |
| `test/unit/openapi.test.ts` | Documented statuses equal implemented codes |
| `test/integration/http.test.ts` | End-to-end HTTP: success, all contract errors, health/readiness |
| `test/integration/security.test.ts` | Auth matrix, 429, body/timeout limits, log leakage |
| `test/unit/shutdown.test.ts` | Graceful drain, forced exit, idempotent signals |

No test requires network access. Live probes in `test/live/` skip unless both a provider key and its
`*_TEST_MODEL` are set.

---

## Production build

```bash
npm ci
npm run verify
npm run build          # dist/server.js + dist/**/*.js
NODE_ENV=production node dist/server.js
```

The build output contains no tests, no `tsconfig` and no dev dependencies in the runtime path.
`dist/` includes source maps for post-incident debugging; disable with `"sourceMap": false` in
`tsconfig.build.json` if your policy forbids shipping them.

---

## Deployment

The service is a single stateless container behind any HTTP load balancer. It assumes no particular
hosting provider.

### Container

```bash
docker build -t ai-processing-engine:0.1.0 .
docker run --rm -p 3000:3000 --env-file .env.production ai-processing-engine:0.1.0
```

The image is multi-stage (`node:22-alpine`), runs as `node` (non-root), uses `tini` so `SIGTERM`
reaches the process, and ships a `HEALTHCHECK` on `/health`.

### Operating requirements

| Requirement | Detail |
| --- | --- |
| Graceful shutdown | `SIGTERM` drains in-flight requests for up to 15 s, then exits. A second signal exits immediately |
| Liveness probe | `GET /health` → `200` while the process is alive |
| Readiness probe | `GET /ready` → `200` when a provider is registered and the default is available; `503` otherwise |
| Termination grace | Grant ≥ 20 s so the drain budget completes before `SIGKILL` |
| Scale-out | Horizontal by default. Rate limits are **per instance** |
| Secrets | Inject `*_API_KEY` and `SERVICE_API_KEYS` from your secret manager; never bake into the image |
| Egress | Outbound HTTPS to `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com` |
| Ingress | TLS termination in front of the service; the service itself speaks plain HTTP |

### Startup sequence

1. Configuration parsed and validated — invalid config exits `1` with the offending variable named.
2. Providers registered; live mode requires a credential per enabled provider.
3. Server listens on `HOST:PORT`.
4. `/ready` turns green once the registry contains the default provider.

Full instructions, including a Compose example and platform-agnostic notes, are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Further reading

| Document | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Module responsibilities, request lifecycle, resolution, orchestration, normalization, error handling |
| [PROVIDERS.md](PROVIDERS.md) | Provider setup, capabilities, differences, and how to add a provider |
| [docs/API.md](docs/API.md) | Processing endpoint with complete request/response examples |
| [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) | Every environment variable, default, and failure mode |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, controls, residual risk, safe-debugging strategy |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production startup, probes, scaling, rollback |
| [docs/PROVIDER-LIMITATIONS.md](docs/PROVIDER-LIMITATIONS.md) | Verified per-provider constraints and schema behaviour |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Conventions, testing expectations, review checklist |
