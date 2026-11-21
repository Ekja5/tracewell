# Test report

**What this is:** evidence of tested behavior in this environment. It is not certification, validation or proof of regulatory compliance.

## Environment

- Linux container, 4 vCPU (Xeon @ 2.1 GHz), 17 GB RAM, Node 22.23, PostgreSQL 16 (local cluster). The app connects as a **non-superuser** role, so row-level security is active in every test. Chromium via Playwright 1.63.
- Integration tests use a dedicated test database, re-seeded per test group. The upgrade test restores a first-build dump into its own database. The load fixture uses its own database.
- Command: `npm run test:all`. Final run on the committed code: **`typecheck=0 integration=0 e2e=0`**, with 54/54 integration tests (5 files) and 15/15 browser tests.

## Integration tests (real PostgreSQL), 54

| File | Tests | Covers |
|---|---|---|
| `acceptance.test.ts` | 22 | First-build acceptance criteria (last-unit races, case move/cancel, tray blocking, package scans, exclusion reasons, import/offline/ERP replay, offline recall, opened-unused, credits, facility and tenant isolation, ledger rebuild). Now also: outbound-shipment case-ref redaction. |
| `second-pass.test.ts` | 11 | 4 p.m. move updates stored cutoffs, issue deadlines, owners' grouped alerts and receiving-hours clipping; ack ≠ resolution; one escalation per missed deadline; handoff history; race loser told who won and next option; stale tray verification not counted; one issue follows the tray through stages and owners and closes itself; offline implanted + opened-unused with recall in between posts exactly once and reaches Quality; serialized rescan rejected without posting; lot repeats are units; refused events quarantined; correction reverses stock and voids the charge, refused after the packet is sent; missing price → history → partial PO → outstanding → credit (no stock change) → remaining PO; billing reconciles to dispositions; hospital access to integrations, cards, other-facility issues, handoff and export filters. |
| `alt-dataset.test.ts` | 9 | Independent dataset (two other tenants, overlapping catalog numbers, Denver/Los Angeles, different cutoffs and receiving hours, remote depot, expired lot, canceled case, serialized and lot stock), discovered by query only: tenant isolation of identical catalog numbers; facility-zone deadlines; overnight transfer received at next opening; expiry and already-reserved exclusions; canceled case has no reservations or open issues; lot race never over-allocates; duplicate import posts nothing; partial shipment; offline retries post once; contract correction and billing-vs-rule reconciliation; recall across warehouse, remote depot and in-transit, isolated from the other tenant; ledgers reconcile. |
| `migration.test.ts` | 2 | Restores a first-build dump, applies migrations 002–003 as the non-superuser owner: every row preserved; backfills applied (this test caught backfills silently updating zero rows under forced RLS); RLS re-forced; old data reconciles and derives issues. |
| `gs1.test.ts` | 10 | GS1 parsing vectors, HIBCC/ISBT detection, differential check against `gs1-barcode-parser-mod`. |

## Browser tests (Playwright, Chromium), 15

- `demo-story.spec.ts` (11 steps): the first-build ten-minute story across 9 roles. The rep step runs on an **iPhone 13 profile** in **browser-emulated offline mode**, with fast scan, the duplicate-rescan catch and sync on reconnect.
- `second-pass.spec.ts` (4):
  - ops assigns an issue from the board, the owner acknowledges from the board, and handoff shows the history;
  - finance resolves a cannot-price line in the queue, sends the packet, records a partial PO, and opens the outstanding total's records;
  - an iPhone rep corrects a confirmed line and re-records it with one tap and one scan (no horizontal overflow);
  - the iPhone item finder shows usable stock, custodian and evidence freshness.

Scanning in browser tests uses the **in-app scan simulator**, not a physical scanner or camera.

## Load fixture

Fixture: 48.8k stock units, 53.8k movements, 600 cases in the 72 h window, 5,000 historical usage events, 30 hospitals. Single process, domain calls without HTTP. Full tables: [`perf/before.md`](perf/before.md) and [`perf/after.md`](perf/after.md).

| Operation | Before (median) | After (median) |
|---|---|---|
| Readiness board, 600 cases, steady state | 7,391 ms | 854 ms |
| Board first load (creates ~3,000 issues once) | 13,655 ms | 6,602 ms |
| Exact-item search | 144 ms | 117 ms |
| Exact-item rescue ranking | 250 ms | 224 ms |
| Lot recall trace | 10 ms | 7 ms |

## Not verified

- Physical iPhone/Android devices.
- Real wedge scanners and camera decoding.
- Real ERP, scheduling or procurement systems.
- Multi-user concurrent load over HTTP and multi-instance deployment.
- Screen-reader accessibility.
- Timed usability sessions with real users.
