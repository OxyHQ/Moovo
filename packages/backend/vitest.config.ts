import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    /**
     * A real MongoDB replica set for the whole suite — see `vitest.globalSetup.ts`
     * for why the moderation writes must not be tested against a mocked model.
     */
    globalSetup: ['./vitest.globalSetup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/index.ts'],
    },
    // The replica set takes a while to come up on a cold cache.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
