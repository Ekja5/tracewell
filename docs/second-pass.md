# Second development pass: findings, changes, verification

All data is synthetic. "Simulated" integrations remain labeled as such. Logistics decisions stay separate from clinical and sterile-processing authority: only hospital staff record release, and nothing infers sterility.

## How the baseline was taken

1. Before any edits, a first-build database was dumped (`tests/fixtures/first-build-schema001.sql`) for the upgrade test.
2. `scripts/exercise.ts` ran the six required workflows through the real HTTP API, as separate role accounts, against an isolated database (`tracewell_exercise`). It records what the screen data says and what the database recorded. Output before changes: [`docs/exercise/baseline.md`](exercise/baseline.md). After: [`docs/exercise/after.md`](exercise/after.md). Rerun with `npx tsx scripts/exercise.ts`.
3. Desktop and iPhone-13 screens were inspected with Playwright (Chromium emulation), and a load fixture measured the hot paths ([`perf/before.md`](perf/before.md), [`perf/after.md`](perf/after.md)).

## What the baseline showed (most consequential first)

| # | Finding | Kind |
|---|---|---|
| 1 | **Lost usage.** When the server refused a synced event (for example, the case was reassigned while the phone was offline), the phone was told "needs review" but nothing was stored server-side. The usage existed only on the phone. | Lost usage |
| 2 | **False readiness risk.** A tray verification from a *previous* visit to the same hospital still counted after the tray left and came back. | False readiness |
| 3 | **Stale cutoffs.** Moving a case did not update stored shipment `due_by`, so the pick queue sorted by the old deadline (2 h late in the exercise). | Incorrect inventory timing |
| 4 | **Unauthorized visibility.** A hospital user could read `/api/integrations` (other hospitals' case refs in the outbox) and preference cards. Found later in this pass: outbound shipments showed the receiving hospital's case ref. | Data visibility |
| 5 | **No ownership.** Blockers named a role ("Ops manager"), not a person. Nothing could be assigned or acknowledged, and there was no history for the next shift. | Friction → calls/texts |
| 6 | **Receiving hours ignored.** A deadline of "1:00 AM" was shown for a hospital whose receiving desk closes at 3 PM. | Wrong deadline |
| 7 | **Race loser told only "0 available".** The rescue screen closed the dialog and kept the stale list. | Friction |
| 8 | **Phone:** each item took scan + tap. A serialized rescan synced into a confusing "ledger does not show…" review item. There was no way to remove or correct an entry. | Friction / data quality |
| 9 | **Finance:** a partial PO was flagged "disputed" with no remaining balance. Held lines showed no owner, age or missing evidence. Price changes left only appended text. New lines after a packet was sent were never billed. | Money left uncollected |
| 10 | **Alerts:** one row per event, never closed, no escalation. | Noise |
| 11 | **Board took 7.4 s** for 600 cases (≈25 queries per case). | Performance |

Additional defect found by the new upgrade test: the migration's backfills ran under forced row-level security as the table owner and **silently updated zero rows**. A real upgrade would have left old facilities with no receiving hours. Fixed and covered.

## Five most important improvements shipped

1. **Every at-risk case has a named owner, a deadline and a next action, workable from the board.** Each blocker becomes a persisted *issue* with owner (person), act-by time in the facility's time zone (clipped to the receiving desk's hours), acknowledgment (distinct from resolution), assignment, notes, and a full history. Issues follow one subject through its stages (missing instrument → awaiting re-verify → awaiting hospital release) and change owner by stage. They close **only** when records clear them, and escalate once when the act-by passes. A shift-handoff page shows what is open, who has the next move, and what was already tried.
2. **No field usage is ever lost or double-posted, and the rep can fix mistakes.** Refused sync events go to a server quarantine plus an ops exception. Serialized rescans are rejected (on the phone first, the server as backstop) without posting stock or billing. Lot-controlled repeats count as additional units. "Remove" works for never-sent entries; "Correct" voids a confirmed line with a linked ledger reversal and voids the draft charge. After a packet is sent, the line is refused and directed to a Finance credit.
3. **Readiness and deadlines are right.** Tray verifications must postdate the latest arrival. Deadlines respect facility receiving hours. Moving a case updates stored shipment cutoffs and issue deadlines, and alerts the people who own those items. Stale evidence ("opening import 40 days ago, never physically scanned") stays visible even on ready units.
4. **Finance has a queue it can clear.** Every held line shows amount (or "unknown"), reason, owner, age and the missing evidence, with resolve/no-charge/assign on the line. Price changes are kept as history with approver. Partial POs show the exact outstanding balance (multiple POs per packet allowed). Lifecycle stages run usage → prepared → sent → PO partial/full → disputed → credited → accepted. Totals open their records, and supplemental packets bill lines recorded after a packet was sent.
5. **Trustworthy exact-item answers, fast.** The item finder (catalog number or GTIN) shows usable quantity, location, custodian and why each unit is not usable. Evidence badges distinguish "Received and checked here 5 min ago" from "Counted here 26 h ago" and "Never physically scanned (opening import)". Arrival estimates account for receiving hours (overnight transfers land at next opening). The race loser is told who reserved the unit, for which case, and the next eligible unit, with the list refreshed. The board loads ~8.7× faster on the load fixture.

Also: hospital users lose access to integrations/preference cards; other facilities' case refs are redacted on outbound shipments; alerts are grouped per issue (repeat counter), updated when the case moves, and closed when resolved.

## Before and after

| Workflow | Before (baseline) | Change | After (verified) |
|---|---|---|---|
| 4 p.m. move, who owns what | Next action "Pick, pack and dispatch", owner **"Warehouse"**; not assignable | Persisted issues with named owners; move re-syncs issues | Owner **"Sam Okafor"**; explanation sentence with act-by; owners after move: Pat Rivera, Riley Novak, Sam Okafor; 2 deadline changes recorded (exercise §1; test A) |
| 4 p.m. move, stored cutoff | Shipment `due_by` **2 h stale**; pick queue wrong | `moveCase` updates open shipments | Stored = recomputed (exercise §1; test A) |
| 4 p.m. move, who is told | Rep + ops only | Owners' grouped alerts updated ("earlier by 120 min") | Warehouse owner alerted, one alert row with repeat counter (test A) |
| Scheduler move input | UTC datetime | Facility-local entry | Facility time zone shown on the form |
| Two reps, one unit | 409 "Only 0 unit(s) available…" | Recheck at confirm; who/when/next option; list refresh | "Riley Novak reserved it for SYN-1001 … Next eligible …" with `heldBy`/`nextEligible` (exercise §2; test B; alt-dataset lot race) |
| Tray missing instrument | Owner "Ops manager"; no assign/ack | Issue lifecycle, stage owners, ack ≠ resolve | Owner Morgan Hale → ack keeps status "acknowledged" while case stays blocked → after re-verify the owner becomes Robin Shah (SPD) → resolved on release, alerts closed (exercise §3; test C; e2e) |
| Returning tray, old verification | Counted (false-ready risk) | Must postdate latest arrival | Blocker "predates this delivery" (test C) |
| Offline usage rejected by server | **Not persisted** | Sync quarantine + exception | "Held on the server for ops review; not lost", persisted (exercise §4; test D) |
| Serialized rescan | Synced, then review item "Ledger does not show…" | Phone pre-check + server reject | "Already recorded…not saved again"; 0 movements, 0 charges (test D; e2e) |
| Phone actions per item | 2 (scan + Record tap) | Fast scan auto-records clean unit labels | **1 scan per item**; disposition chosen once (e2e demo step 8) |
| Correct a wrong line | Not possible | Remove (pending) / Correct (void + reversal) | Stock restored by reversal, charge void, ledger reconciles (test D; e2e) |
| Missing price → partial PO | PO → **"disputed"**, outstanding **not shown**; no price history | Line queue, history, partial PO accounting | Owner/age/missing evidence shown; PO → `po_partial`, remaining balance $3,210.00 shown after the partial PO and a $100 credit (exercise §5) / exact per-line (test E); 2nd PO → `po_matched`; credit: 0 movements, implant stays consumed |
| Hospital A → B data | `/api/integrations` and cards **leaked** | Permission gates, export filter intersect, redaction | All probes "no Hospital B data" (exercise §6; tests F + acceptance) |
| Board load, 600 cases | 7,391 ms median (13,655 ms first) | Batch prefetch + 24 indexes | **854 ms** median (6,602 ms first load, one-time issue creation) |
| Upgrade from first build | — | Migration 002/003, RLS-safe backfill | All rows preserved; ledgers reconcile; RLS forced again (migration test) |

## Verification summary

- Integration (real PostgreSQL): **54/54** across 5 files: first-build acceptance (22), second-pass workflows (11), independent alternate dataset (9), first-build upgrade (2), GS1 parser (10).
- Browser (Playwright, Chromium; iPhone 13 emulation for phone flows; real network-offline mode): **15/15**, including the 11-step demo story and 4 new flows.
- Load (isolated fixture, 48.8k stock units, 600 upcoming cases): see table above and [`perf/after.md`](perf/after.md).

## Still unverified (requires hardware, customer systems or people)

- Physical iPhones and Android phones (Safari storage eviction, background behavior), real keyboard-wedge scanners (GS/FNC1 configuration), camera DataMatrix decoding (`BarcodeDetector` was not exercised, and it is unavailable on iOS Safari). All scanning in tests used the in-app simulator; offline tests used browser-emulated offline mode.
- Real ERP, hospital scheduling or procurement integrations. All are simulated.
- Multi-instance API deployment and load from concurrent users (benchmarks are single-process, without HTTP).
- Accessibility with screen readers.
- Usability with real reps and coordinators; the step counts above are measured in the UI, not user-timed.
