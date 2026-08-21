import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    exclude: [
      'tests/e2e/**',
      'tests/helpers/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/_archived/**',
    ],
  },
});
