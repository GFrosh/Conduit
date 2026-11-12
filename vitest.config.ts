import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Live provider probes need real credentials and cost money: they are opt-in
    // via `npm run test:live` and are never part of the normal CI pipeline.
    exclude: ['node_modules/**', 'dist/**', 'test/live/**'],
    globals: false,
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 10_000,
  },
});
