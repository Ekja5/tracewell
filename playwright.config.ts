import { defineConfig, devices } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';

const env: Record<string, string> = {};
for (const f of ['.env', '.env.example']) if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !(m[1] in env)) env[m[1]] = m[2]; }
const TEST_DB = process.env.TEST_DATABASE_URL ?? env.TEST_DATABASE_URL;
process.env.E2E_DATABASE_URL = TEST_DB;

export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 120000,
  expect: { timeout: 10000 },
  globalSetup: './tests/e2e/global-setup.ts',
  use: { baseURL: 'http://127.0.0.1:3101', trace: 'off', screenshot: 'only-on-failure' },
  outputDir: 'test-results/e2e-artifacts',
  webServer: {
    command: 'npx vite build --logLevel warn && npx tsx src/server/index.ts',
    url: 'http://127.0.0.1:3101/api/health',
    reuseExistingServer: false,
    timeout: 120000,
    env: { PORT: '3101', DATABASE_URL: TEST_DB, DEMO_LOGIN_SHORTCUTS: 'true', DEMO_CLOCK: 'true', NODE_ENV: 'test', ACCESS_LOG: 'off' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
