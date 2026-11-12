# Providers

Three providers ship with the engine, each behind the same `ProviderAdapter` interface, each in its own
directory, each owning its own SDK.

| Provider | id | SDK (pinned) | API surface used |
| --- | --- | --- | --- |
| OpenAI | `openai` | `openai@7.55.0` | `client.responses.create` |
| Anthropic | `anthropic` | `@anthropic-ai/sdk@1.8.0` | `client.messages.create` |
| Google Gemini | `gemini` | `@google/genai@3.1.0` | `client.models.generateContent` |
| Mock | *any enabled id* | none | deterministic, in-process, no network |

---

## 1. Configuration

### Enable a provider

```dotenv
ENABLED_PROVIDERS=openai,anthropic,gemini
DEFAULT_PROVIDER=openai
PROVIDER_MODE=live
```

`ENABLED_PROVIDERS` is the deployment's allow-list. A provider not listed here is not registered, so a
request naming it receives `PROVIDER_NOT_CONFIGURED` (503) — not a silent substitution.

### Credentials

```dotenv
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
```

Read from the environment at boot, held in the adapter, never logged, never returned, and never accepted
from a request. In live mode a missing credential for an enabled provider **fails the boot** with the
provider named; the service cannot start half-configured and fail at the first request instead.

### Default models

```dotenv
DEFAULT_MODEL_OPENAI=<model id>
DEFAULT_MODEL_ANTHROPIC=<model id>
DEFAULT_MODEL_GEMINI=<model id>
MAX_OUTPUT_TOKENS_OPENAI=
MAX_OUTPUT_TOKENS_ANTHROPIC=
MAX_OUTPUT_TOKENS_GEMINI=
```

Left empty in `.env.example` on purpose. No model identifier is hardcoded anywhere in `src/`: a model
name is a deployment fact that changes on the vendor's release schedule, and pinning one in code would
make the service lie about what it is calling. A request that omits `model` while the resolved
provider's default is unset fails with `MODEL_REQUIRED` (400).

`MAX_OUTPUT_TOKENS_*` is the deployment's ceiling for that provider, not the model's documented limit
(the service cannot know which model you configured). When unset, adapters use a conservative default
(OpenAI 16 384, Anthropic 8 192, Gemini 8 192). A request asking for more is clamped with an
`OPTION_CLAMPED` warning.

### Verify the wiring

```bash
curl -s localhost:3000/v1/providers -H "Authorization: Bearer $KEY" | jq
```

Returns ids, default models, allowed models, and declared capabilities. No keys, no endpoints, no SDK
versions.

---

## 2. Capability differences

These are real and are handled explicitly rather than averaged away.

| Capability | OpenAI | Anthropic | Gemini |
| --- | --- | --- | --- |
| System / developer instructions | `instructions` (top level) | top-level `system` | `systemInstruction` |
| Structured output | `text.format` `json_schema`, `strict: true` | `output_config.format` `json_schema` | `responseMimeType` + `responseSchema` |
| Requires `max_tokens` | no | **yes** — supplied from `MAX_OUTPUT_TOKENS_*` or the 8 192 default, with `OPTION_DEFAULTED` | no |
| `temperature` | yes | yes (0–1) | yes |
| `top_p` | yes | yes | yes |
| Reports `total_tokens` | yes | **no** — `null`, never derived | yes |
| Cache / reasoning token detail | `cached_tokens`, reasoning tokens | cache read/write | `cachedContentTokenCount`, `thoughtsTokenCount` |
| Schema keywords silently dropped | — (must be closed) | range/length/format/`$ref` limits | `minLength`, `maxLength`, `minProperties`, `maxProperties`, `uniqueItems`, `contains`, `pattern`, `not`, `$defs` |
| Refusal signal | `status: incomplete`, reason `refusal` | `stop_reason: "refusal"` on HTTP 200 | `finishReason` / `blockReason` |
| Retries inside SDK | disabled (`maxRetries: 0`) | disabled | disabled |

### How each difference is expressed

- **Anthropic's mandatory `max_tokens`** is injected, and the client is told via an `OPTION_DEFAULTED`
  warning — otherwise a caller would believe the value came from their request.
- **Anthropic's missing `total_tokens`** stays `null`. Deriving it would fabricate a number the provider
  did not report.
- **Anthropic's `stop_reason: "refusal"`** arrives with HTTP 200. It is mapped to a terminal
  `MODEL_REFUSED` error, not a successful empty response.
- **Gemini's dropped keywords** are reported per-field as `SCHEMA_IGNORED`/`SCHEMA_KEYWORD_IGNORED`
  warnings, because silently weakening validation would be a correctness bug the caller cannot see.
  Validation of the *response* still uses the full original schema, so a dropped constraint is not a
  lost guarantee — only a lost early-warning inside the model.
- **Schema `$ref`** handling differs: the OpenAI adapter inlines local `$ref`s; the Gemini adapter falls
  back to JSON mode without a schema and warns. Both are covered by tests.
- **OpenAI strict mode requires a closed schema.** A copy is closed (`additionalProperties: false`,
  everything required) for the wire request and a `SCHEMA_MODIFIED` warning is emitted; the response is
  validated against the caller's original schema.

`docs/PROVIDER-LIMITATIONS.md` records the underlying vendor documentation for each of these.

---

## 3. Adding another provider

Four files, no changes to the orchestrator, HTTP layer, or contracts.

### Step 1 — declare the id

```ts
// src/contracts/common.ts
export const PROVIDER_IDS = ['openai', 'anthropic', 'gemini', 'mistral'] as const;
```

The `ProviderId` union, request validation, response schema, and OpenAPI enum all follow from this one
edit. `ERROR_CODES` are unchanged: they describe behaviour, not vendors.

### Step 2 — write the adapter

```ts
// src/providers/mistral/adapter.ts
import type { ProviderAdapter } from '../../contracts/provider.js';
import type { GenerationRequest, GenerationResponse } from '../../contracts/generation.js';
import { AppError } from '../../core/errors/AppError.js';
import { mapStatus, readStatus, readMessage, toProviderError } from '../shared/error-mapping.js';

export interface MistralAdapterConfig { apiKey: string; maxOutputTokens: number; client?: Mistral }

export function createMistralAdapter(config: MistralAdapterConfig): ProviderAdapter {
  const client = config.client ?? new Mistral({ apiKey: config.apiKey, maxRetries: 0 });

  return {
    id: 'mistral',
    capabilities: {
      structuredOutput: 'json_schema',      // or 'json_object' | 'prompt_only'
      supportedOptions: ['temperature', 'top_p', 'max_output_tokens'],
      unenforcedSchemaKeywords: [],
      needsClosedSchemas: false,
      maxSchemaBytes: 64 * 1024,
      maxOutputTokens: config.maxOutputTokens,
      supportsSystemChannel: true,
    },
    async generate(request: GenerationRequest, signal: AbortSignal): Promise<GenerationResponse> {
      if (signal.aborted) throw new AppError('PROVIDER_TIMEOUT');
      // ...map request.prompt / request.output / request.options onto the SDK...
      // ...return { text, usage, finishReason, modelEcho, providerRequestId }...
    },
  };
}
```

The adapter contract, stated in `src/contracts/provider.ts`:

- may throw `AppError` only, and must honour the `AbortSignal`;
- must **not** retry (core owns retry and the deadline);
- must **not** parse structured output (core owns parsing and validation);
- must **not** translate an unrecognised stop code to `stop` — use `unknown`.

### Step 3 — register it

```ts
// src/providers/factory.ts
case 'mistral':
  return createMistralAdapter({ apiKey: entry.apiKey, maxOutputTokens: entry.maxOutputTokens ?? 8_192 });
```

### Step 4 — add configuration

```ts
// src/config/env.ts — inside envSchema
MISTRAL_API_KEY: optionalTrimmed,
DEFAULT_MODEL_MISTRAL: optionalTrimmed,
MAX_OUTPUT_TOKENS_MISTRAL: optionalNumber,
```

Plus the three `*_ENV` maps (`API_KEY_ENV`, `DEFAULT_MODEL_ENV`, `MAX_TOKENS_ENV`) and the live-mode
credential check, which iterates `ENABLED_PROVIDERS` already.

### Step 5 — test it

Copy `test/unit/providers/openai.test.ts`. The parity suites (`parity.test.ts`,
`test/integration/parity-http.test.ts`) already iterate provider adapters; add the new one to their
arrays and the new provider is held to the same contract as the other three without new assertions.

### Checklist

- [ ] Id added to `PROVIDER_IDS`
- [ ] `generate` honours `AbortSignal` and throws only `AppError`
- [ ] No retry logic inside the adapter
- [ ] Usage mapped, unreported fields left `null`
- [ ] Unknown stop codes map to `unknown`
- [ ] Error mapping covers 401/403, 404, 429, 408, 4xx, 5xx
- [ ] `capabilities` accurate, including `unenforcedSchemaKeywords`
- [ ] No model identifier hardcoded
- [ ] Factory case added, `never` exhaustiveness still compiles
- [ ] Added to parity suites
- [ ] `npm run verify` green
