# Provider integrations: behaviour, limits, and what is deliberately not done

Scope: Phase 2 (OpenAI, Anthropic, Google Gemini adapters). Everything below
describes the adapters that implement `ProviderAdapter`
(`src/contracts/provider.ts`). No model identifier appears in source: all model
names arrive per request or from `DEFAULT_MODEL_*`.

Pinned SDKs (verified against their own typings in this repository):

| Provider | SDK | Version | Entry point used |
|---|---|---|---|
| OpenAI | `openai` | 7.55.0 | `client.responses.create` |
| Anthropic | `@anthropic-ai/sdk` | 1.8.0 | `client.messages.create` |
| Gemini | `@google/genai` | 3.1.0 | `client.models.generateContent` |

## 1. Capability matrix (as reported by `GET /v1/providers`)

| Trait | OpenAI | Anthropic | Gemini |
|---|---|---|---|
| `structured_output` | `json_schema` | `json_schema` | `json_schema` |
| Native schema enforcement | strict mode (`strict: true`) | `output_config.format` | `responseSchema` |
| Requires `max_tokens` | no | **yes** | no |
| System channel | `instructions` | top-level `system` | `systemInstruction` |
| `temperature` / `top_p` | yes / yes | yes / yes | yes / yes |
| Reports `total_tokens` | yes | **no** (stays `null`) | yes |
| Structured-output refusal signal | `refusal` output item | `stop_reason: "refusal"` | `finishReason` / `blockReason` |

## 2. OpenAI

- **Wire shape.** `instructions` carries the instruction channel; `input` carries
  the delimited user channel. Temperature and `top_p` are forwarded only when set
  — an omitted option is omitted from the request, never defaulted by us.
- **Structured output.** `text.format = { type: 'json_schema', name, schema, strict: true }`.
  Strict mode requires closed objects (`additionalProperties: false`, all
  properties required), so the schema is closed on a copy and a `SCHEMA_MODIFIED`
  warning is emitted. Post-hoc validation always runs against the client's
  **original** schema, so closing can only ever strengthen the check.
- **Finish reasons.** `status: 'incomplete'` with `max_output_tokens` →
  `length`; `content_filter` → `content_filter`; a `refusal` output item →
  `refusal`; `failed`/`cancelled`/unknown → `unknown`. Nothing unknown is ever
  reported as `stop`.
- **Usage.** `input_tokens`, `output_tokens`, `total_tokens`,
  `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`.
  Absent metrics are `null`.
- **Timeout.** The request's `AbortSignal` is passed straight to the SDK, and
  `maxRetries: 0` is set so the SDK cannot retry behind the service's back.

## 3. Anthropic

- **Wire shape.** The system channel is a separate top-level `system` parameter,
  not a message. There is exactly one `user` message containing the delimited
  payload. Roles are not interchangeable with OpenAI's.
- **`max_tokens` is mandatory.** When the request omits `max_output_tokens`, the
  adapter supplies `min(capability max, configured default)` and emits an
  `OPTION_DEFAULTED` warning, so the effective cap is visible in the response
  rather than silently guessed.
- **Structured output.** `output_config.format = { type: 'json_schema', schema }`.
  The older top-level `output_format` field is not used.
- **Documented platform limits.** Anthropic reports an error when a schema is too
  complex to compile; published limits include a maximum number of optional
  parameters and union-typed parameters, and the platform injects
  `additionalProperties: false` and reorders `required` before optional fields.
  Consequence for clients: a schema that is legal JSON Schema can still be
  rejected by Anthropic. The service surfaces that as a provider error; it does
  not quietly rewrite the schema to make it fit. `enum` casing is not guaranteed
  to be preserved, which is another reason post-hoc validation against the
  original schema is authoritative.
- **Refusals arrive with HTTP 200.** `stop_reason: 'refusal'` is mapped to
  `refusal`, and the core turns that into `MODEL_REFUSED` — never a 200 with
  partial content. `stop_reason: 'max_tokens'` → `length` → `OUTPUT_TRUNCATED`.
- **Usage.** `input_tokens`, `output_tokens`, and `cache_read_input_tokens`
  (→ `cached_input_tokens`). There is **no** total in the response, so
  `total_tokens` is `null`. It is not computed as input + output: a derived
  number presented as provider-reported usage would be a lie.

## 4. Google Gemini

- **Wire shape.** `systemInstruction` carries the instruction channel;
  `contents` holds one `user` turn. `config.abortSignal` carries the deadline.
- **Structured output.** `responseMimeType: 'application/json'` plus
  `responseSchema`. Gemini accepts only a subset of JSON Schema, and silently
  ignores keywords such as `minLength`, `maxLength`, `minProperties`,
  `maxProperties`, `uniqueItems`, `contains`, `pattern`, `not`, `$defs`.
  Those keywords are stripped before sending and reported as
  `SCHEMA_KEYWORD_DROPPED` warnings naming exactly what the provider will not
  enforce. The service still validates the answer against the full schema.
- **`$ref` is not accepted in `responseSchema`.** A schema containing `$ref`
  cannot be shaped safely, so the adapter falls back to JSON mode *without* a
  schema and emits `SCHEMA_MODIFIED`; correctness then rests entirely on the
  service's own validation. Local `$ref` resolution is deliberately not
  implemented in this phase.
- **Finish reasons.** `STOP` → `stop`; `MAX_TOKENS` → `length`;
  `SAFETY`, `PROHIBITED_CONTENT`, `BLOCKLIST`, `SPII`, `IMAGE_SAFETY`,
  `RECITATION` → `content_filter`; `MALFORMED_FUNCTION_CALL` → `tool_calls`;
  anything else → `unknown`. A prompt-level `promptFeedback.blockReason` is
  mapped to `content_filter` even when no candidate exists.
- **Usage.** `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`,
  `cachedContentTokenCount` (→ `cached_input_tokens`), `thoughtsTokenCount`
  (→ `reasoning_tokens`). Gemini's total can legitimately differ from
  input + output (thinking tokens), which is exactly why the provider's own
  total is used when present instead of being recomputed.

## 5. Shared behaviour

**Error normalization.** Status → code mapping lives in one place
(`src/providers/shared/error-mapping.ts`) and is identical for all three:
401/403 → `PROVIDER_AUTH_FAILED`; 404 with a model hint → `PROVIDER_MODEL_NOT_FOUND`;
429 → `PROVIDER_RATE_LIMITED` (with `retry_after_ms` when the provider sent
`Retry-After`); 408 → `PROVIDER_TIMEOUT`; other 4xx → `PROVIDER_BAD_REQUEST`;
5xx and anything unrecognized → `PROVIDER_UNAVAILABLE`. A provider fault never
becomes `INTERNAL`, because that would blame the service for the provider's
answer. Messages are redacted (credential-shaped strings and long opaque tokens
are masked) and stack traces are never included.

**Retry.** Adapters never retry. Retry is a core concern (`src/core/process/retry.ts`)
so one budget governs every provider: at most 3 attempts, full-jitter
exponential backoff capped at 4 s, `Retry-After` honoured but capped, and any
retry that cannot finish before the request deadline is skipped so the request
fails with `TIMEOUT` (504) instead of overrunning. Auth failures, bad requests,
unknown models, schema errors, and output-validation failures are never retried.

**Structured output.** One code path for everyone: adapters return raw text;
core parses with a strict `JSON.parse` (no fence stripping, no "find the first
brace" heuristics), validates against the requested schema, and returns
`{ type: 'json', data }` with a real parsed object. Unparseable → 502
`OUTPUT_UNPARSEABLE`; schema-violating → 502 `OUTPUT_VALIDATION_FAILED`.
No automatic correction pass is implemented, so there is no possible generation
loop; if one is added later it must be bounded and configurable.

## 6. Known limitations of this phase

1. **No live verification.** No provider credentials were available in this
   environment, so every adapter is exercised against SDK-shaped fakes and
   `npm run test:live` was not executed against the real APIs. Typings were read
   from the pinned SDKs, not from memory, but real-world behaviour (quota errors,
   exact refusal payloads) is unconfirmed until a live run happens.
2. **Streaming is not implemented** for any provider.
3. **Tool/function calling, images, and audio** are rejected by the contract
   (`content.type` is `text` only in v1); adapters do not translate them.
4. **`$ref` schemas on Gemini** degrade to JSON-without-schema (see §4).
5. **Anthropic schema complexity errors** are surfaced, not worked around.
6. **`top_k`, `seed`, `stop`, presence/frequency penalties, system-cache
   controls** and other provider-specific knobs are not in the neutral option
   set. `on_unsupported_option: 'ignore'` is refused at the schema level for
   structured output, but unknown option names simply cannot be expressed.
7. **Prompt-level injection defence is a mitigation, not a guarantee.** Content
   and context are wrapped in nonce-tagged delimiters with a channel policy that
   names them as data; a hostile payload can still try to argue its way out.
   Untrusted-content handling remains a defence-in-depth measure.
8. **Adapters assume `modelEcho` is meaningful.** If a provider omits the model
   in its response, the requested model is echoed back; that echo is the
   service's, not the provider's, claim.
