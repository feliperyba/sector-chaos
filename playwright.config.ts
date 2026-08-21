import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  timeout: 120000,
  retries: 1,
  use: {
    baseURL:
      process.env.E2E_CLIENT_URL ||
      (process.env.E2E_DOCKER ? 'http://localhost:8080' : 'http://localhost:5173'),
    trace: 'on-first-retry',
  },
  webServer: process.env.E2E_DOCKER
    ? undefined
    : {
        command: 'pnpm dev',
        port: 5173,
        reuseExistingServer: true,
      },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
