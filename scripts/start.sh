#!/usr/bin/env bash
# One-command local startup: database, migrations, seed (first run or --reset), web build, API server and worker.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env
[ -d node_modules ] || npm install
bash scripts/db-local.sh
npx tsx src/server/migrate.ts
set -a; source .env; set +a
SEEDED=$(psql "$DATABASE_URL" -qtAc "select count(*) from tenants" 2>/dev/null || echo 0)
if [ "${1:-}" = "--reset" ] || [ "$SEEDED" = "0" ]; then npx tsx src/server/seed/seed.ts; fi
npx vite build --logLevel warn
echo "[start] open http://127.0.0.1:${PORT:-3001}  (Ctrl+C to stop)"
exec npx concurrently -k -n api,worker -c blue,magenta "npx tsx src/server/index.ts" "npx tsx src/worker/index.ts"
