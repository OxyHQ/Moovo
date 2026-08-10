import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/index.ts'],
    },
    // A real-database suite creates and migrates its own throwaway database in
    // `beforeAll`; see `src/db/testDatabase.ts`.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
