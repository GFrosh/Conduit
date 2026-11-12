import { defineConfig } from 'vitest/config';

/**
 * Opt-in configuration for real-provider integration tests.
 * Run with: npm run test:live   (requires API keys and *_TEST_MODEL variables)
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/live/**/*.test.ts'],
    globals: false,
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
});
