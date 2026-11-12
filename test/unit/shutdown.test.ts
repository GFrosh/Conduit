import { describe, expect, it, vi } from 'vitest';
import { createShutdownHandler } from '../../src/core/runtime/shutdown.js';

/**
 * Graceful shutdown is deployment behaviour, not a detail: if it is wrong the
 * container either drops in-flight requests or hangs until SIGKILL. These tests
 * drive the real handler with a stubbed app so both branches are pinned.
 */

function stubApp(close: () => Promise<void>) {
  return {
    close: vi.fn(close),
    log: { info: vi.fn(), error: vi.fn() },
  };
}

describe('createShutdownHandler', () => {
  it('closes the server and exits zero on a clean drain', async () => {
    const app = stubApp(async () => undefined);
    const exit = vi.fn();
    const shutdown = createShutdownHandler({ app, exit });

    const result = await shutdown('SIGTERM');

    expect(app.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBe('SIGTERM');
    expect(app.log.error).not.toHaveBeenCalled();
  });

  it('forces a non-zero exit when the drain exceeds its budget', async () => {
    // Never resolves: simulates a request that will not finish.
    const app = stubApp(() => new Promise<void>(() => undefined));
    const exit = vi.fn();
    const shutdown = createShutdownHandler({ app, timeoutMs: 20, exit });

    const result = await shutdown('SIGTERM');

    expect(result.timedOut).toBe(true);
    expect(exit).toHaveBeenCalledWith(1);
    expect(app.log.error).toHaveBeenCalled();
  });

  it('forces a non-zero exit when closing throws', async () => {
    const app = stubApp(async () => {
      throw new Error('boom');
    });
    const exit = vi.fn();
    const shutdown = createShutdownHandler({ app, exit });

    const result = await shutdown('SIGINT');

    expect(exit).toHaveBeenCalledWith(1);
    expect(result.timedOut).toBe(false);
  });

  it('does not start a second drain when signalled again', async () => {
    let release: (() => void) | undefined;
    const app = stubApp(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const exit = vi.fn();
    const shutdown = createShutdownHandler({ app, timeoutMs: 5_000, exit });

    const first = shutdown('SIGTERM');
    const second = shutdown('SIGTERM');

    // The repeat signal is an operator telling us to stop waiting.
    expect(exit).toHaveBeenCalledWith(1);
    expect(app.close).toHaveBeenCalledTimes(1);

    release?.();
    await Promise.all([first, second]);
  });
});
