import type { FastifyInstance } from 'fastify';
import { AppError, toAppError } from '../../core/errors/AppError.js';
import type { AttemptSummary, ProcessingErrorResponse } from '../../contracts/response.js';
import { redactSecretText } from '../../core/security/redaction.js';

const CREDENTIALISH = /(api[_-]?key|apikey|token|secret|credential|password|authorization)/i;

interface ValidationIssue {
  instancePath?: string;
  message?: string;
}

/**
 * Fastify's validation error carries instancePaths (e.g. "/openaiApiKey"), not
 * the payload itself, so the offending key is recovered from those paths.
 */
function findCredentialInPaths(issues: ValidationIssue[]): string | null {
  for (const issue of issues) {
    const segments = (issue.instancePath ?? '').split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && CREDENTIALISH.test(last)) return last;
  }
  return null;
}

function findCredentialKey(payload: unknown, depth = 0): string | null {
  if (depth > 4 || payload === null || typeof payload !== 'object') return null;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (CREDENTIALISH.test(key)) return key;
    const nested = findCredentialKey(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function readValidation(error: unknown): ValidationIssue[] | null {
  if (error === null || typeof error !== 'object') return null;
  const value = (error as { validation?: unknown }).validation;
  return Array.isArray(value) ? (value as ValidationIssue[]) : null;
}

function readStatus(error: unknown): number {
  if (error !== null && typeof error === 'object') {
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number') return status;
  }
  return 500;
}

/**
 * Maps a schema violation onto the domain taxonomy. Unknown keys that look like
 * credentials get their own code, so a client is told precisely why the request
 * was rejected instead of receiving a generic message.
 */
export function mapValidationError(error: unknown): AppError {
  const issues = readValidation(error);
  if (issues) {
    const credentialKey = findCredentialInPaths(issues) ?? findCredentialKey(error);
    if (credentialKey) {
      return new AppError('CREDENTIALS_IN_PAYLOAD', undefined, {
        details: { offending_field: credentialKey },
      });
    }
    return new AppError('VALIDATION_FAILED', undefined, {
      details: {
        issues: issues.slice(0, 10).map((issue) => ({
          path: issue.instancePath || '/',
          message: issue.message ?? 'invalid',
        })),
      },
    });
  }
  return new AppError('VALIDATION_FAILED');
}

/**
 * Error details are client-facing. Provider text reaches them only after
 * redaction, and a stack or a cause never does.
 */
function publicDetails(details: unknown): unknown {
  if (details === null || typeof details !== 'object') return redactSecretText(String(details));
  if (Array.isArray(details)) return details.map(publicDetails);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (key === 'stack' || key === 'cause') continue;
    out[key] = typeof value === 'string' ? redactSecretText(value) : publicDetails(value);
  }
  return out;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const statusCode = readStatus(error);

    let appError: AppError;
    if (readValidation(error) !== null) {
      appError = mapValidationError(error);
    } else if (AppError.isAppError(error)) {
      appError = error;
    } else if (statusCode === 413) {
      appError = new AppError('PAYLOAD_TOO_LARGE');
    } else if (statusCode === 429) {
      appError = new AppError('RATE_LIMITED');
    } else if (statusCode === 404) {
      appError = new AppError('NOT_FOUND');
    } else if (statusCode < 500) {
      appError = new AppError('VALIDATION_FAILED');
    } else {
      appError = toAppError(error);
    }

    // Full detail stays server-side; nothing provider-specific reaches the client.
    request.log.error(
      { err: { name: appError.name, code: appError.code, message: appError.message } },
      'request failed',
    );

    // The completion log line is built by the request logger; all this handler
    // contributes is the normalized code, so a 500 without a code is impossible.
    request.logContext = {
      ...(request.logContext ?? {}),
      errorCode: appError.code,
    };

    const attempted = (appError as AppError & { attempts?: AttemptSummary[] }).attempts;

    const body: ProcessingErrorResponse = {
      success: false,
      request_id: request.requestId ?? '',
      error: {
        code: appError.code,
        message: appError.message,
        retryable: appError.retryable,
        ...(appError.details !== undefined ? { details: publicDetails(appError.details) } : {}),
        ...(attempted && attempted.length > 0
          ? {
              attempted: attempted.map((item) => ({
                provider: item.provider,
                model: item.model,
                code: item.error_code ?? 'INTERNAL',
              })),
            }
          : {}),
      },
    };

    void reply.status(appError.status).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const notFound = new AppError('NOT_FOUND');
    void reply.status(notFound.status).send({
      success: false,
      request_id: request.requestId ?? '',
      error: { code: notFound.code, message: notFound.message, retryable: notFound.retryable },
    } satisfies ProcessingErrorResponse);
  });
}
