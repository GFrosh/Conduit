import { buildApp } from './app.js';
import { ConfigurationError, loadConfig } from './config/env.js';
import { createShutdownHandler } from './core/runtime/shutdown.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error('Configuration validation failed:');
      for (const issue of error.issues) console.error(`  - ${issue.path}: ${issue.message}`);
      process.exit(1);
    }
    throw error;
  }

  const { app } = await buildApp({ config });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error({ err: error }, 'failed to start');
    process.exit(1);
  }

  // Drain in-flight requests, then exit. A second signal forces the exit, so an
  // operator is never locked out by a hung connection.
  const shutdown = createShutdownHandler({ app });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  // An unhandled rejection must not leave a half-dead process holding a port.
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled rejection');
    process.exit(1);
  });
}

void main();
