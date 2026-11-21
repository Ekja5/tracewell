import { defineConfig } from 'vitest/config';
import { existsSync, readFileSync } from 'node:fs';

const env: Record<string, string> = {};
for (const f of ['.env', '.env.example']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !(m[1] in env)) env[m[1]] = m[2]; }
}
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    // Integration tests run against a real PostgreSQL test database (never the dev DB).
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? env.TEST_DATABASE_URL, ACCESS_LOG: 'off', DEMO_DATE: '2026-11-21', DEMO_LOGIN_SHORTCUTS: 'true', NODE_ENV: 'test' },
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 180000,
  },
});
