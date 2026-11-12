# Security and reliability review — AI Processing Engine

Scope: the service as it can be deployed today (Phase 3). This is an honest
assessment, not a compliance claim. Every "verified" line below is backed by a
test in this repository; every limitation is a real, known gap.

## 1. Trust boundaries

```
client app ──(Bearer client key)──▶ HTTP layer ──▶ orchestrator ──(provider key)──▶ vendor API
             untrusted                       trusted            trusted              untrusted
```

Three distinct secrets exist and are never interchangeable:

| Secret | Lives | Never |
|---|---|---|
| Client API key | client app ⇄ this service | accepted in a request body; written to logs |
| Provider API key | this service only, from env | exposed to a client, echoed in a response, logged |
| Contract/JSON payload | per request | trusted as instruction (see §5) |

## 2. Authentication

- `Authorization: Bearer <key>` on every endpoint except `GET /health`,
  `GET /ready`, `GET /openapi.json`.
- Keys are configured as `SERVICE_API_KEYS=<key-id>:<secret>,...`. The service
  stores and compares **SHA-256 digests**, never the plaintext. A 64-hex secret
  is treated as a pre-computed digest, so deployments can avoid distributing
  plaintext to the running process at all.
- Comparison uses `timingSafeEqual` and iterates all configured keys without an
  early return, so response timing does not reveal which key a guess is near.
- Missing → `AUTH_MISSING` (401). Malformed (wrong scheme, empty token, more than
  two space-separated parts) or non-matching → `AUTH_INVALID` (401). Both use the
  same envelope as every other error.
- Each key maps to a `keyId` (`client_id`), which is the unit for rate limiting,
  audit logs, and future per-client quotas. Adding a client is a config change,
  not a code change.

**Verified:** 401 for no header, wrong secret, wrong scheme, empty token, bare
token, and `Bearer <key> extra`; two different keys authenticate as two
different clients; no key material appears in captured logs.

## 3. Rate limiting

In-process, per replica, reset on restart. Deliberately no Redis: the request was
"no unnecessary infrastructure", and the failure mode of the in-memory choice is
under-counting across replicas, which is a capacity problem, not a security hole.

- Default 60 requests / 60 s, configurable via `RATE_LIMIT_MAX` /
  `RATE_LIMIT_WINDOW_MS`.
- Keyed by authenticated `client_id` when auth is on (`RATE_LIMIT_PER_CLIENT`,
  default true), so clients behind one NAT/proxy do not share a bucket and one
  client cannot exhaust another's budget. Falls back to IP when unauthenticated.
- `/health`, `/ready`, `/openapi.json` are exempt so a limiter never causes a
  failed liveness probe.
- Over limit → `429 RATE_LIMITED` + `Retry-After`, normalized envelope. The body
  never contains the limit, the window, or bucket state.

**Known gap:** with N replicas a client effectively gets up to N × limit. If you
need a hard global cap, that requires a shared store — explicitly out of scope
here, and it would need a new dependency.

## 4. Request limits and timeouts

| Control | Value | Where |
|---|---|---|
| Body size | `MAX_BODY_BYTES` (default 1 MiB) | Fastify parser → `413` |
| Instructions | 16 000 chars | Zod → `400` |
| Content | 200 000 chars | Zod → `400` |
| Context | 100 000 chars / depth 8 / 2 000 keys | Zod + budget check → `400` |
| JSON schema | 64 KiB, depth 16, no remote `$ref` | Ajv pre-check → `400` |
| `max_output_tokens` | ≤ 32 000, then clamped to provider ceiling | negotiation |
| Execution timeout | `REQUEST_TIMEOUT_MS` (default 60 s), per-request `timeout_ms` may lower it, never raise it | `AbortSignal` |

Every timeout path terminates in an `AbortSignal` handed to the provider SDK, so
a slow vendor cannot outlive the request budget. Socket-level guards
(`connectionTimeout`, `keepAliveTimeout`, `requestTimeout`) prevent a client from
holding a connection open indefinitely.

**Verified:** oversized body → 413; 16 001-char instructions → 400; over-nested
context → 400; `timeout_ms: 10` → 400 rather than silent clamping; a 3 s provider
against a 1 s deadline → 504.

## 5. Prompt injection boundaries

The service keeps three channels separate, and the separation is structural, not
a request to the model:

- **Instructions** → the system/developer channel (`instructions` on OpenAI,
  `system` on Anthropic, `systemInstruction` on Gemini).
- **Context** and **content** → the user channel only, each wrapped in
  `<<<CONTEXT:{nonce}>>>` / `<<<CONTENT:{nonce}>>>` markers.
- A service-owned channel policy (task-independent) states that delimited text is
  data and that any instruction-like text inside it must be ignored.

The nonce is derived from the request id and is regenerated if the payload
already contains it, so a payload cannot forge the closing marker and break out
into the instruction channel. This is the classic tag-breakout defence.

**This does not eliminate prompt injection, and no honest design can.** What it
does is remove the cheap attacks: no delimiter forgery, no silent channel
collapse, no provider-specific "just concatenate everything" path. Residual
risks are in §10.

## 6. Logging and safe debugging

One structured line per request, emitted from `onResponse` so successes,
failures, and 429s all produce it:

`request_id`, `client_id`, `method`, `route`, `status`, `duration_ms`,
`success`, `provider`, `model`, `error_code`, `attempts`, `fallback_used`,
`finish_reason`, `usage`, `input_chars`.

Never logged: provider keys, client keys, authorization headers, payload bodies,
provider error text, stack traces. Pino `redact` is configured as a second net
(`req.headers.authorization`, `*.secret*`, `*.provider_message`, `*.details`,
`*.text`, `*.result`).

**Safe debugging strategy**

1. Start from the `request_id` — it is on every response (success and error) and
   every log line, and it is the support handle.
2. `input_chars` proves the payload arrived and was bounded without recording a
   character of it.
3. `error_code` + `attempts` tells you whether the provider failed once or
   repeatedly, and whether fallback ran.
4. `usage` (absent when the provider reported nothing) bounds cost per request.
5. Only when content itself must be inspected: set `LOG_INSTRUCTIONS=true`
   and/or `LOG_CONTENT=true` **plus** a non-zero `LOG_SAMPLE_RATE` (e.g. `0.01`).
   Samples are redacted of key-shaped strings, truncated to 240 chars, and tagged
   `[sample]`. Both flags default to false; sampling defaults to 0.
6. Turn the flags off after the investigation — they are not a standing setting.

## 7. Failure handling

| Situation | Behaviour |
|---|---|
| Vendor timeout | `PROVIDER_TIMEOUT` → 504; attempted once per policy layer |
| Transient (429, 5xx, timeout) | ≤ 3 attempts, full-jitter backoff, `Retry-After` honoured and capped |
| Deterministic (401, 400, unknown model, schema, validation) | never retried — asking again cannot change the answer |
| Client disconnects | `AbortController` fires, provider call aborted, `TIMEOUT` with `reason: client_disconnected` |
| Unexpected throw inside an adapter | normalized to `INTERNAL` (500) and logged; the process stays up |
| Rate limited | 429, no provider call |

The classification choice is deliberate: adapters translate every SDK fault into
an `AppError`, so a non-`AppError` escaping one means *our* code broke. Reporting
that as "provider unavailable" would send an operator to debug a healthy vendor.

**Verified:** server still answers `/health` and `/ready` after a failing
request; a `TypeError` with a file path in it never reaches the client body;
disconnect aborts within the test budget instead of waiting out provider latency.

## 8. Fallback policy

Disabled by default (`FALLBACK_ENABLED=false`). A request opts in with a
`fallback` block; both conditions are required.

- Order is always: explicit/primary provider first, then `providers[]` in
  declared order.
- The primary provider may **not** appear in its own fallback list, and a
  fallback-enabled request against a deployment with fallback off is rejected
  (`FALLBACK_INVALID`) rather than served as if the policy had been honoured.
- Total candidates are capped (`FALLBACK_MAX_ATTEMPTS`, default 2), so a single
  request can never walk every provider.
- Failover only on codes that another provider could plausibly fix: unavailable,
  timeout, rate-limited, auth-failed, model-not-found, and unusable output.
  Validation errors, unsupported options, and invalid schemas fail immediately.
- The response always reports the provider that actually answered, with
  `fallback_used: true` and a `FALLBACK_USED` warning.

## 9. API documentation

`GET /openapi.json` (OpenAPI 3.1, public) is generated from the same Zod schemas
the server validates with, so the document cannot drift from the contract. It
covers auth, request/response schemas, provider & model selection, output
formats, options, the complete error-code enum, rate limits, probes, and five
working examples. `GET /docs` serves interactive UI, disabled in production
unless `DOCS_ENABLED=true`. Neither contains credentials, endpoints, or
per-provider token ceilings.

## 10. Unresolved risks (read before deploying)

1. **Prompt injection is mitigated, not solved.** A sufficiently persuasive
   payload may still steer the model into producing wrong or malicious *output*.
   The channel separation and nonce delimiters raise the cost; they do not
   guarantee compliance. Treat generated text as untrusted downstream, and do not
   give this service's output authority over money, publishing, or access.
2. **No live-provider verification.** All three adapters are exercised against
   SDK-shaped fakes. No real API call was made in this environment, so real-world
   quota, refusal, and safety-block payloads are unconfirmed until `npm run test:live`.
3. **Rate limiting is per replica.** N replicas ≈ N × the configured limit
   (§3). A global cap needs a shared store.
4. **No request-level cost budget.** `max_output_tokens` bounds one response, but
   there is no per-client daily/monthly spend cap. A compromised key can still
   consume real money at the configured rate limit.
5. **Key rotation requires a restart.** Keys load from env at boot; there is no
   reload endpoint and no expiry field. Rotation = deploy a new key, then remove
   the old one.
6. **No audit trail beyond logs.** No persistence of who processed what, so
   forensic review is limited to the log retention window.
7. **Client disconnects are best-effort.** The abort is derived from the socket
   `close`/`finish` events; behind some proxies a disconnect may surface late, so
   an abandoned call can still complete and be billed.
8. **`trustProxy: false`.** If deployed behind a load balancer, the rate limiter's
   IP fallback sees the proxy address. Client-id keying avoids this once auth is
   on, which is the recommended configuration.
9. **JSON-schema validation is requested-scope only.** `additionalProperties` and
   keyword handling differ per provider (documented in `PROVIDER-LIMITATIONS.md`);
   the service's own post-validation is authoritative, so a provider that
   "accepts" a loose schema cannot cause a bad payload to be returned as success.
10. **No supply-chain pinning beyond lockfile.** SDK versions are pinned; there is
    no SBOM or signed-artifact step.

## 11. Test coverage of the security surface

`test/integration/security.test.ts` covers, by name:

- auth: missing / wrong secret / wrong scheme / empty / bare / extra token;
  two clients mapped to two identities; no key in logs; credential in payload
  (top level and nested); public probes.
- rate limiting: 429 + `Retry-After`, no config disclosure, per-client isolation,
  probes exempt.
- limits: oversized body (413), malformed JSON (400), instruction/content caps,
  over-nested context, invalid timeout.
- failure handling: provider timeout (504), server healthy after a failure,
  stack-free normalization, disconnect abort.
- consistency: identical envelope across 401/400/404/422/429/5xx, request id on
  every response.
- leakage: no provider key, client key, or article text in logs; error text kept
  out; deployment internals absent from `/v1/providers` and probes.

## 12. Deployment checklist

1. `NODE_ENV=production`, `AUTH_ENABLED=true`, `SERVICE_API_KEYS` set per client.
2. `PROVIDER_MODE=live` with provider keys present (boot fails otherwise).
3. Set an explicit `DEFAULT_MODEL_*` per provider; nothing is hardcoded.
4. Keep `FALLBACK_ENABLED=false` unless you have decided the order deliberately.
5. `RATE_LIMIT_ENABLED=true`; size `RATE_LIMIT_MAX` for the replica count.
6. Leave `LOG_CONTENT` / `LOG_INSTRUCTIONS` false; `DOCS_ENABLED` false.
7. Terminate TLS in front of the service — the service itself speaks HTTP and
   does not implement TLS.
8. Point `MAX_BODY_BYTES` and `REQUEST_TIMEOUT_MS` at your real payload profile;
   defaults are safe, not tuned.
