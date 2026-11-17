import { z } from 'zod';
import { PROVIDER_IDS, isProviderId, type ProviderId } from '../contracts/common.js';
import { normalizeSecret } from '../core/security/hashing.js';
import { LIMITS } from './limits.js';

const DEFAULT_MODEL_ENV: Record<ProviderId, 'DEFAULT_MODEL_OPENAI' | 'DEFAULT_MODEL_ANTHROPIC' | 'DEFAULT_MODEL_GEMINI'> = {
  openai: 'DEFAULT_MODEL_OPENAI',
  anthropic: 'DEFAULT_MODEL_ANTHROPIC',
  gemini: 'DEFAULT_MODEL_GEMINI',
};

const MAX_TOKENS_ENV: Record<
  ProviderId,
  'MAX_OUTPUT_TOKENS_OPENAI' | 'MAX_OUTPUT_TOKENS_ANTHROPIC' | 'MAX_OUTPUT_TOKENS_GEMINI'
> = {
  openai: 'MAX_OUTPUT_TOKENS_OPENAI',
  anthropic: 'MAX_OUTPUT_TOKENS_ANTHROPIC',
  gemini: 'MAX_OUTPUT_TOKENS_GEMINI',
};

const API_KEY_ENV: Record<ProviderId, 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY' | 'GEMINI_API_KEY'> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

const booleanish = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const optionalTrimmed = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  });

const optionalBooleanString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
);

const optionalNumber = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
  });

const providerIdSchema = z.enum(PROVIDER_IDS);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    // 0 is valid: the OS assigns an ephemeral port (used by the test harness).
    PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    APP_VERSION: z.string().min(1).default('0.0.0'),

    PROVIDER_MODE: z.enum(['mock', 'live']).default('mock'),
    ENABLED_PROVIDERS: z
      .string()
      .default('openai,anthropic,gemini')
      .transform((value) =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      )
      .pipe(z.array(providerIdSchema).min(1, 'ENABLED_PROVIDERS must list at least one provider')),
    DEFAULT_PROVIDER: z.string().min(1, 'DEFAULT_PROVIDER is required'),

    MAX_OUTPUT_TOKENS_OPENAI: optionalNumber,
    MAX_OUTPUT_TOKENS_ANTHROPIC: optionalNumber,
    MAX_OUTPUT_TOKENS_GEMINI: optionalNumber,

    DEFAULT_MODEL_OPENAI: optionalTrimmed,
    DEFAULT_MODEL_ANTHROPIC: optionalTrimmed,
    DEFAULT_MODEL_GEMINI: optionalTrimmed,

    OPENAI_API_KEY: optionalTrimmed,
    ANTHROPIC_API_KEY: optionalTrimmed,
    GEMINI_API_KEY: optionalTrimmed,

    REQUEST_TIMEOUT_MS: z.coerce.number().int().min(LIMITS.minTimeoutMs).max(600_000).default(60_000),
    MAX_BODY_BYTES: z.coerce.number().int().min(1_024).max(64 * 1024 * 1024).default(1_048_576),

    AUTH_ENABLED: booleanish.default(true),
    SERVICE_API_KEYS: z.string().default(''),

    RATE_LIMIT_ENABLED: booleanish.default(true),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000_000).default(60),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    RATE_LIMIT_PER_CLIENT: optionalBooleanString,

    FALLBACK_ENABLED: booleanish.default(false),
    FALLBACK_PROVIDERS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ),
    FALLBACK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(4).default(2),

    LOG_CONTENT: booleanish.default(false),
    LOG_INSTRUCTIONS: booleanish.default(false),
    LOG_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),

    DOCS_ENABLED: optionalBooleanString,
    PUBLIC_BASE_URL: optionalTrimmed,
  })
  .superRefine((env, ctx) => {
    if (!env.ENABLED_PROVIDERS.includes(env.DEFAULT_PROVIDER as ProviderId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEFAULT_PROVIDER'],
        message: `DEFAULT_PROVIDER '${env.DEFAULT_PROVIDER}' is not present in ENABLED_PROVIDERS.`,
      });
    }
    if (env.AUTH_ENABLED && env.SERVICE_API_KEYS.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['SERVICE_API_KEYS'],
        message: 'SERVICE_API_KEYS must be set when AUTH_ENABLED=true.',
      });
    }
    if (env.AUTH_ENABLED) {
      const seen = new Set<string>();
      for (const entry of env.SERVICE_API_KEYS.split(',')) {
        const trimmed = entry.trim();
        if (trimmed.length === 0) continue;
        const separator = trimmed.indexOf(':');
        if (separator <= 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['SERVICE_API_KEYS'],
            message: 'Each key must use the form <key-id>:<secret>.',
          });
          return;
        }
        const id = trimmed.slice(0, separator);
        const secret = trimmed.slice(separator + 1);
        if (secret.length < 8) {
          ctx.addIssue({
            code: 'custom',
            path: ['SERVICE_API_KEYS'],
            message: `Secret for key '${id}' must be at least 8 characters.`,
          });
          return;
        }
        if (seen.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['SERVICE_API_KEYS'],
            message: `Duplicate key id '${id}'.`,
          });
          return;
        }
        seen.add(id);
      }
    }
    for (const id of env.FALLBACK_PROVIDERS) {
      if (!isProviderId(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['FALLBACK_PROVIDERS'],
          message: `'${id}' is not a known provider.`,
        });
        return;
      }
      if (!env.ENABLED_PROVIDERS.includes(id as ProviderId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['FALLBACK_PROVIDERS'],
          message: `Fallback provider '${id}' is not present in ENABLED_PROVIDERS.`,
        });
        return;
      }
    }
    if (new Set(env.FALLBACK_PROVIDERS).size !== env.FALLBACK_PROVIDERS.length) {
      ctx.addIssue({ code: 'custom', path: ['FALLBACK_PROVIDERS'], message: 'Fallback providers must be unique.' });
    }

    if (env.PROVIDER_MODE === 'live') {
      const missing = env.ENABLED_PROVIDERS.filter((id) => !env[API_KEY_ENV[id]]);
      if (missing.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['PROVIDER_MODE'],
          message: `PROVIDER_MODE=live requires credentials for: ${missing.join(', ')}.`,
        });
      }
    }
  });

export type RawEnv = z.infer<typeof envSchema>;

export interface ProviderRuntimeConfig {
  id: ProviderId;
  defaultModel?: string;
  apiKey?: string;
  /** Deployment ceiling for a single response, per provider. */
  maxOutputTokens?: number;
}

export interface AuthKeyConfig {
  id: string;
  /** SHA-256 hex digest of the presented secret. Digests are never logged. */
  secretHash: string;
}

export interface AppConfig {
  nodeEnv: RawEnv['NODE_ENV'];
  host: string;
  port: number;
  logLevel: RawEnv['LOG_LEVEL'];
  serviceVersion: string;
  providerMode: RawEnv['PROVIDER_MODE'];
  enabledProviders: ProviderId[];
  defaultProvider: string;
  providers: ProviderRuntimeConfig[];
  requestTimeoutMs: number;
  maxBodyBytes: number;
  auth: { enabled: boolean; keys: AuthKeyConfig[] };
  rateLimit: { enabled: boolean; max: number; windowMs: number; perClient: boolean };
  fallback: { enabled: boolean; providers: ProviderId[]; maxAttempts: number };
  logging: { content: boolean; instructions: boolean; sampleRate: number };
  docs: { enabled: boolean };
  publicBaseUrl?: string;
}

export class ConfigurationError extends Error {
  readonly issues: { path: string; message: string }[];
  constructor(issues: { path: string; message: string }[]) {
    super(`Invalid configuration: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

/** Pure: no process.env access, so tests can exercise it directly. */
export function loadConfig(source: NodeJS.ProcessEnv | Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  const env = parsed.data;

  const modelFor = (id: ProviderId): string | undefined => env[DEFAULT_MODEL_ENV[id]];
  const apiKeyFor = (id: ProviderId): string | undefined => env[API_KEY_ENV[id]];
  const maxTokensFor = (id: ProviderId): number | undefined => env[MAX_TOKENS_ENV[id]];

  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    serviceVersion: env.APP_VERSION,
    providerMode: env.PROVIDER_MODE,
    enabledProviders: env.ENABLED_PROVIDERS,
    defaultProvider: env.DEFAULT_PROVIDER,
    providers: env.ENABLED_PROVIDERS.map((id) => ({
      id,
      defaultModel: modelFor(id),
      apiKey: apiKeyFor(id),
      maxOutputTokens: maxTokensFor(id),
    })),
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    maxBodyBytes: env.MAX_BODY_BYTES,
    auth: {
      enabled: env.AUTH_ENABLED,
      keys: env.AUTH_ENABLED ? parseApiKeys(env.SERVICE_API_KEYS) : [],
    },
    rateLimit: {
      enabled: env.RATE_LIMIT_ENABLED,
      max: env.RATE_LIMIT_MAX,
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      perClient: env.RATE_LIMIT_PER_CLIENT ?? env.AUTH_ENABLED,
    },
    fallback: {
      enabled: env.FALLBACK_ENABLED,
      providers: env.FALLBACK_PROVIDERS as ProviderId[],
      maxAttempts: env.FALLBACK_MAX_ATTEMPTS,
    },
    logging: {
      content: env.LOG_CONTENT,
      instructions: env.LOG_INSTRUCTIONS,
      sampleRate: env.LOG_SAMPLE_RATE,
    },
    docs: {
      // Interactive UI off in production unless explicitly enabled; the
      // machine-readable document stays available either way.
      enabled: env.DOCS_ENABLED ?? env.NODE_ENV !== 'production',
    },
    ...(env.PUBLIC_BASE_URL ? { publicBaseUrl: env.PUBLIC_BASE_URL } : {}),
  };
}

/** Parses `<key-id>:<secret>[,...]`. Secrets are stored as SHA-256 digests. */
export function parseApiKeys(raw: string): AuthKeyConfig[] {
  const keys: AuthKeyConfig[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    const id = trimmed.slice(0, separator);
    const secret = trimmed.slice(separator + 1);
    keys.push({
      id,
      secretHash: normalizeSecret(secret),
    });
  }
  return keys;
}
