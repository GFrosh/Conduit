import type { FastifyServerOptions } from 'fastify';
import type { AppConfig } from '../../config/env.js';

/**
 * Redaction is centralised here so no route can accidentally log a credential
 * or an unpublished article body.
 */
export interface LogStream {
  write(line: string): void;
}

export function buildLoggerOptions(
  config: Pick<AppConfig, 'nodeEnv' | 'logLevel'>,
  stream?: LogStream,
): FastifyServerOptions['logger'] {
  const redactPaths = [
    'req.headers.authorization',
    'req.headers["x-api-key"]',
    'req.headers.cookie',
    'res.headers["set-cookie"]',
    '*.apiKey',
    '*.api_key',
    '*.authorization',
    '*.secret',
    '*.secretHash',
    '*.instructions',
    '*.content',
    '*.context',
    '*.prompt',
    '*.text',
    '*.result',
    'req.headers["x-client-key"]',
    '*.secretHash',
    '*.provider_message',
    '*.details',
  ];

  const level = config.logLevel === 'silent' ? 'info' : config.logLevel;
  const base = { level, redact: { paths: redactPaths, censor: '[redacted]' } };

  // A capture stream keeps the same redaction pipeline in tests, so what the
  // assertions inspect is exactly what production would emit.
  if (stream) return { ...base, stream };

  if (config.nodeEnv === 'test' || config.logLevel === 'silent') return false;

  return {
    ...base,
    ...(config.nodeEnv === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
      : {}),
  };
}
