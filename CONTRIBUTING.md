# Contributing

## Ground rules

1. **The core never learns about a provider.** No vendor SDK import in `src/core/**` or
   `src/contracts/**`. ESLint enforces this; do not add a disable comment to get around it.
2. **The service never learns about a client.** No client name, prompt, editorial voice, or output
   schema in `src/`. Instructions, context, and content arrive per request.
3. **No hardcoded model identifiers.** Model names are deployment configuration.
4. **Contracts before implementation.** Change the Zod schema and its inferred type, then the code that
   satisfies it. Never hand-write a type that duplicates a schema.
5. **`npm run verify` must pass.** `typecheck && lint && test`. A red gate is not a review comment, it is
   a blocker.

---

## Development workflow

```bash
npm ci
cp .env.example .env
npm run dev            # tsx watch, pretty logs, PROVIDER_MODE=mock by default
```

Mock mode needs no credentials and makes no network calls — use it for everything except exercising a
real vendor.

Before opening a pull request:

```bash
npm run format
npm run verify
npm run build           # catches emit-only problems the noEmit check misses
```

---

## Code conventions

### Types and validation

- Zod schema first; the TypeScript type is `z.infer<typeof schema>`. One definition, never two.
- Request and response objects use `.strict()`. That strictness is what rejects credentials in a
  payload — do not relax it to accept a stray field.
- Prefer a discriminated union over a bag of optional fields (`output`, `result`).
- `null` and `undefined` mean different things. `usage.input_tokens: null` means "the provider did not
  report it". Do not substitute `0` or `undefined`.

### Errors

- Throw `AppError` with a `code`, never `new Error` from a module that can be reached by a request.
- New code? Add it to `ERROR_CODES` (and `DEFAULT_STATUS`, `DEFAULT_MESSAGES`, `RETRYABLE` if
  applicable). The `Record<ErrorCode, …>` types make a missing entry a compile error, so this cannot be
  forgotten silently.
- Messages are written for an API consumer. No vendor text, no stack traces, no internal hostnames.
- Adapters translate *every* SDK fault. A raw error escaping an adapter is a bug, and it surfaces as
  `INTERNAL` (500), not as a provider fault.

### Async and time

- Every outbound call takes an `AbortSignal`. No unbounded await exists in the codebase.
- Deadlines, not timeouts-in-isolation: compute the remaining budget and pass it down.
- Only `src/core/process/retry.ts` retries. Adapters set `maxRetries: 0` on their SDK.
- Inject `now` and id generators where determinism matters — do not call `Date.now()` deep inside logic
  that tests need to pin.

### Logging

- Structured fields only; no string interpolation into messages.
- Never log: provider keys, client keys, authorization headers, raw content, raw instructions, vendor
  error bodies.
- Log `request_id`, `provider`, `model`, `duration_ms`, `success`, `error_code`, `usage`.
- The pino redaction list in `src/core/observability/logger.ts` is a safety net, not a licence to log
  secrets.

### Imports

- ESM with `.js` extensions in relative specifiers (NodeNext resolution).
- `import type` for type-only imports (`verbatimModuleSyntax` is on).

---

## Testing expectations

A change is not complete until its failure modes are tested, not just its happy path.

| Change | Minimum tests |
| --- | --- |
| New provider adapter | Wire shape per request variant, usage mapping incl. unreported fields, every HTTP status → code, unknown stop reason, abort handling, credential redaction; add to a parity suite |
| New error code | Status mapping, message presence, retryability, and one HTTP test through the endpoint |
| Orchestrator change | Ordering assertion plus a failure case (truncation, refusal, deadline) |
| Validation change | A rejected request and an accepted one, with the exact error code |
| Security-relevant change | A test that would fail if the control were removed — e.g. assert the secret does **not** appear in captured logs |
| Config change | Accepted value, default, and the boot-failure case |

Rules:

- **Never weaken an assertion to make a test pass.** If the test is right, the code is wrong. Several
  defects in this codebase were found exactly this way (credential-guard false positive on
  `max_output_tokens`, error-handler registration order, `Retry-After` parsing).
- Prefer a real collaborator to a broad mock. Adapters are tested with SDK-shaped fakes, not
  `vi.mock('openai')`, so the wire shape is exercised.
- No test may reach the network. Live probes belong in `test/live/` and must skip cleanly without
  credentials.
- Assert on codes and shapes, not on prose. Message text is a presentation detail.

---

## Review checklist

- [ ] `npm run verify` and `npm run build` both green
- [ ] No new dependency without a justification in the PR description
- [ ] No vendor SDK reachable from `core` or `contracts`
- [ ] No model identifier added to `src/`
- [ ] New public surface documented in `docs/API.md` and reflected in `src/contracts/openapi.ts`
- [ ] New env var in `.env.example` **and** `docs/ENVIRONMENT.md`
- [ ] Error paths return the shared envelope
- [ ] Anything security-relevant has a test that fails if removed
- [ ] `docs/SECURITY.md` updated if the threat model changed

---

## Commit messages

Conventional-commit style, imperative, one concern per commit:

```
feat(providers): add Mistral adapter
fix(retry): honour Retry-After from provider headers
docs(api): document OUTPUT_TRUNCATED
test(security): assert client keys never reach logs
```

The body explains *why* when the diff cannot. Reference the error code or module affected.

---

## Reporting a security issue

Do not open a public issue. Send a minimal reproduction to the maintainers privately. Do not include real
provider keys or real client content; redact both and note that you have done so.
