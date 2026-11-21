# Implementation plan and checkpoint

## Repository inspection (start of work)

The working directory was empty: no git repository, no source, no conventions to preserve. Per the brief, the default stack was used: a TypeScript full-stack web app, PostgreSQL, a responsive PWA and a background worker, as a modular monolith. Node 22 and PostgreSQL 16 binaries were available; Docker's daemon was not, so `scripts/db-local.sh` falls back to a local cluster.

## Plan (as recorded before building)

1. **Schema first** (`db/migrations/001_core.sql`): tenant-scoped tables with forced row-level security; catalog, package/UOM, stock identity (lot or serial), owner, location, condition, quality hold, reservation and financial disposition as separate concepts; append-only movement ledger with linked reversals; balances projection; custody events; tray manifests and verifications; usage, charges, replenishment, credits; recalls; counts; outbox; audit log.
2. **First continuous workflow** through domain modules, in order: import → cases from approved preference cards → readiness board → exact-item rescue → pick/pack/dispatch/receive/verify/release → phone closeout with GS1 parsing → contract-derived charges and packet → recall.
3. **Seed** a coherent synthetic demo story by running the real workflows with a controllable application clock, so history, ledger and audit agree.
4. **API + PWA** with role-based home screens, offline queue in IndexedDB, service-worker app shell.
5. **Verification:** integration tests against a real PostgreSQL test database for every listed acceptance outcome; Playwright end-to-end tests for desktop and iPhone flows; parser tests with published-style vectors and a differential check against an independent parser.
6. **Documents:** setup, demo script, architecture, test report, standards matrix, security/privacy, scorecard, interview guide, limitations, production checklist, roadmap.

## Status checkpoint

All planned steps are implemented. See `docs/test-report.md` for exactly what ran and passed.

Commands to reproduce from a clean checkout:

```bash
npm install
npm run test:all     # typecheck + 32 integration tests + 11-step browser demo story
npm start            # run the app at http://127.0.0.1:3001
```

Next unfinished work (beyond the pilot acceptance criteria) is tracked in `docs/production-readiness.md` and `docs/known-limitations.md`.

## Second pass checkpoint

Baseline exercise → fixes → re-exercise, documented in `docs/second-pass.md`. Reproduce:

```bash
npm run test:all                      # typecheck + 54 integration + 15 browser tests
npx tsx scripts/exercise.ts           # six-workflow exercise (compare docs/exercise/baseline.md vs after.md)
npx tsx scripts/load-fixture.ts       # load fixture timings (docs/perf/)
DEMO_TIME=16:00 npm start -- --reset  # demo at 4 p.m.
```
