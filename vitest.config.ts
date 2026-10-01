import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'],
      reporter: ['text', 'html', 'json-summary'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
});
