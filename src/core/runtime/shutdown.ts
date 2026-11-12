/**
 * Graceful shutdown.
 *
 * Written as a small injectable unit rather than inline in `server.ts` so the
 * behaviour that actually matters at deployment time — bounded drain, forced
 * exit, idempotency — is covered by tests instead of trusted by inspection.
 */

export interface ShutdownResult {
  readonly signal: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

type LogFn = (payload: unknown, message?: string) => void;

/**
 * The slice of Fastify this module needs. Keeping it structural means the unit
 * is testable with a plain object and gains no dependency on the HTTP layer.
 */
export interface ShutdownTarget {
  close(): Promise<void>;
  log: { info: LogFn; error: LogFn };
}

export interface ShutdownHandlerOptions {
  app: ShutdownTarget;
  /**
   * How long to wait for in-flight requests before forcing exit. Deliberately
   * below the 30 s termination grace period most orchestrators grant, so the
   * process leaves on its own terms instead of being SIGKILLed mid-response.
   */
  timeoutMs?: number;
  /** Injection seam for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;

export function createShutdownHandler(
  options: ShutdownHandlerOptions,
): (signal: string) => Promise<ShutdownResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const exit =
    options.exit ??
    ((code: number): void => {
      process.exit(code);
    });

  let inFlight: Promise<ShutdownResult> | null = null;

  const drain = async (signal: string): Promise<ShutdownResult> => {
    const startedAt = Date.now();
    options.app.log.info({ signal, timeout_ms: timeoutMs }, 'shutdown started');

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      // Never hold the event loop open on our own shutdown guard.
      timer.unref?.();
    });

    let outcome: 'closed' | 'failed' | 'timeout';
    try {
      outcome = await Promise.race([options.app.close().then(() => 'closed' as const), deadline]);
    } catch (error) {
      options.app.log.error({ signal, err: error }, 'shutdown failed while closing the server');
      outcome = 'failed';
    } finally {
      if (timer) clearTimeout(timer);
    }

    const durationMs = Date.now() - startedAt;

    if (outcome === 'closed') {
      options.app.log.info({ signal, duration_ms: durationMs }, 'shutdown complete');
      exit(0);
      return { signal, timedOut: false, durationMs };
    }

    options.app.log.error(
      { signal, outcome, timeout_ms: timeoutMs },
      'shutdown did not complete cleanly; forcing exit',
    );
    exit(1);
    return { signal, timedOut: outcome === 'timeout', durationMs };
  };

  return (signal: string): Promise<ShutdownResult> => {
    if (inFlight) {
      // A second signal (or a repeat of the same one) is an operator telling us
      // to stop waiting. Do not start a second drain.
      options.app.log.error({ signal }, 'shutdown already in progress; exiting immediately');
      exit(1);
      return inFlight;
    }
    inFlight = drain(signal);
    return inFlight;
  };
}
