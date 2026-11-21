import { readFileSync, existsSync } from 'node:fs';

// Minimal .env loader (no secrets are ever logged).
const envPath = new URL('../../.env', import.meta.url);
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const isProd = process.env.NODE_ENV === 'production';
export const config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  port: Number(process.env.PORT ?? 3001),
  isProd,
  // Demo shortcuts are development-only; forced off in production regardless of the flag.
  demoLoginShortcuts: !isProd && process.env.DEMO_LOGIN_SHORTCUTS === 'true',
  demoClock: process.env.DEMO_CLOCK === 'true',
  liveIntegrationsEnabled: false, // hard-disabled for the pilot; see docs/integrations.md
  sessionHours: 12,
};
if (!config.databaseUrl) throw new Error('DATABASE_URL is required (copy .env.example to .env)');
