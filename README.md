# Tracewell Case Logistics (pilot)

Orthopedic surgical inventory and case-to-cash logistics for U.S. medical device distributors, manufacturer field teams and their hospital partners.

The software answers three questions from persisted records:

- **Ops director:** Which cases in the next 72 hours are at risk, why, who owns the fix, and what is the latest time we can act?
- **Rep:** Where can I get the exact item in time without putting another case at risk?
- **Finance:** Which completed cases still have money outstanding, and what is holding them up?

Everything in this repository is **synthetic**: the distributors, hospitals, people, devices, GTINs, contracts, prices and cases. There are no patient names, MRNs, dates of birth or clinical notes. Case references (`SYN-1001`) are opaque. No incumbent, ERP or CRM system is accessed. Every integration is simulated and labeled as simulated.

## Quick start (one command)

Requirements: Node 22+, and either PostgreSQL 16 binaries on the PATH (`pg_ctl`, `initdb`, `psql`) or Docker.

```bash
npm install
npm start            # starts PostgreSQL if needed, migrates, seeds on first run, builds the PWA, runs API + worker
# open http://127.0.0.1:3001
npm start -- --reset # re-seed the demo data (resets the demo clock to the demo date, 08:00 America/Chicago)
```

`scripts/db-local.sh` uses `DATABASE_URL` if reachable, else `docker compose up -d db`, else creates a local cluster in `.pgdata/` on port 5433. The app connects as a **non-superuser** role (`orthoapp`) so PostgreSQL row-level security is enforced.

Configuration lives in `.env` (copied from `.env.example`). Never commit `.env`.

## Demo accounts (development only)

In development the login page shows one-click buttons for every seeded account. They are disabled when `NODE_ENV=production` regardless of other settings. The password for every synthetic account is `Pilot-Demo-2026!`.

| Role | Email | Home screen |
|---|---|---|
| Operations manager (buyer) | ops@lakeshore.example | 72-hour readiness board |
| Inventory coordinator | inventory@lakeshore.example | Import, counts, usage review |
| Scheduler | scheduler@lakeshore.example | Cases, preference cards |
| Rep, North (St. Brigid) | riley.rep@lakeshore.example | Phone: today's cases (Scan / Handoff / Close case) |
| Rep, East (Prairie Valley) | jordan.rep@lakeshore.example | Phone: today's cases |
| Warehouse | warehouse@lakeshore.example | Pick queue ordered by cutoff |
| Courier | courier@lakeshore.example | Shipments in motion |
| St. Brigid receiving / SPD | receiving@stbrigid.example, spd@stbrigid.example | Board limited to St. Brigid |
| Prairie Valley receiving / SPD | receiving@prairievalley.example, spd@prairievalley.example | Board limited to Prairie Valley |
| Finance | finance@lakeshore.example | Unbilled and disputed cases |
| Quality managers (two, for second-person verification) | quality@lakeshore.example, quality2@lakeshore.example | Holds and recall tasks |
| Admin | admin@lakeshore.example | Everything except hospital-only decisions |
| Second tenant (isolation) | ops@ridgeway.example, receiving@harborpoint.example | Ridgeway's own data only |

## Commands

| Command | What it does |
|---|---|
| `npm start` | One-command local startup (see above) |
| `npm run seed` | Reset and seed the database in `DATABASE_URL` |
| `npm run migrate` | Apply SQL migrations in `db/migrations/` |
| `npm run server` / `npm run worker` | Run API or background worker alone |
| `npm test` | Integration tests (Vitest) against the real PostgreSQL **test** database |
| `npm run test:e2e` | Browser end-to-end tests (Playwright; desktop + iPhone 13 profile, real offline mode) |
| `npm run test:all` | Typecheck + integration + e2e, reports in `test-results/` |
| `npm run typecheck` | TypeScript check |
| `npm run pilot:reset` / `npm run pilot:demo` | Reset to one empty pilot tenant / the same, staged for the ten-minute demo |
| `npm run eval:assistant` | Assistant evaluation in demo mode (no model calls); writes `docs/eval/assistant-eval-demo.json` |
| `npm run eval:assistant:provider` | Same evaluation with the real model (needs `ANTHROPIC_API_KEY`; paid calls) |
| `DEMO_TIME=16:00 npm start -- --reset` | Start the demo at the 4 p.m. planning meeting (see [demo script](docs/demo-script.md)) |
| `npx tsx scripts/exercise.ts` | Re-run the six-workflow exercise against an isolated DB; writes observations (baseline vs after in `docs/exercise/`) |
| `npx tsx src/server/seed/seed-alt.ts` | Load the independent alternate dataset (two other tenants, different zones/cutoffs) into `DATABASE_URL` |
| `npx tsx scripts/load-fixture.ts` | Build the isolated load fixture (`tracewell_load`) and print timings for board, exact-item search and recall trace |

## Documentation

- [Distributor pilot: uploads, reconciliation, Tomorrow board, evaluation](docs/pilot/README.md)
- [Ten-minute pilot demo script](docs/pilot/demo-script.md) · [What to ask a prospect to bring](docs/pilot/data-request.md)
- [Ask operations assistant, quick notes, modes and evaluation](docs/assistant.md)
- [Three-minute assistant demo script](docs/assistant-demo-script.md)
- [Second pass: findings, changes, before/after, verification](docs/second-pass.md)
- [Implementation plan and checkpoint](PLAN.md)
- [Ten-minute demo script (4 p.m. scenario)](docs/demo-script.md)
- [Performance before/after](docs/perf/after.md)
- [Architecture and data model](docs/architecture.md)
- [Test report](docs/test-report.md)
- [Integrations, field ownership and simulated adapters](docs/integrations.md)
- [Offline capture and device limitations](docs/offline.md)
- [Security, privacy and operations](docs/security-privacy.md)
- [Standards applicability matrix](docs/standards-matrix.md)
- [Pilot scorecard](docs/pilot-scorecard.md)
- [Discovery interview guide](docs/interview-guide.md)
- [Known limitations](docs/known-limitations.md)
- [Production-readiness checklist](docs/production-readiness.md)
- [Roadmap (later)](docs/roadmap.md)
