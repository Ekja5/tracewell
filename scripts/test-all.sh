#!/usr/bin/env bash
# Runs typecheck, integration tests (real PostgreSQL test DB) and browser end-to-end tests; writes reports to test-results/.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-results
bash scripts/db-local.sh
set -a; source .env; set +a
npx tsx -e "import('./src/server/migrate.ts').then(m=>m.migrate(process.env.TEST_DATABASE_URL))"
echo "== typecheck"; npx tsc --noEmit -p tsconfig.json; TC=$?
echo "== integration"; npx vitest run --reporter=default --reporter=json --outputFile=test-results/integration.json; IT=$?
echo "== e2e"; npx playwright test --trace off --reporter=list,json 2>&1 | tee test-results/e2e.log; E2E=${PIPESTATUS[0]}
echo "typecheck=$TC integration=$IT e2e=$E2E"
[ $TC -eq 0 ] && [ $IT -eq 0 ] && [ $E2E -eq 0 ]
