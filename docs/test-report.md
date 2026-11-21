# Test report

**What this is:** evidence of tested behavior in this environment. It is not a certification, validation package or proof of regulatory compliance.

## Environment where the tests ran

- Linux container, Node 22.23, PostgreSQL 16 (local cluster, non-superuser app role `orthoapp`, so row-level security was active), Chromium via Playwright 1.63.
- Demo date fixed to `2026-11-21` for deterministic fixtures. The test database (`tracewell_test`) is re-seeded per test group, and the dev database is never touched.
- Command: `npm run test:all` (typecheck, integration, e2e). Final full run on the committed code: **`typecheck=0 integration=0 e2e=0`: typecheck clean, 32/32 integration tests passed (2 files), 11/11 browser steps passed.** Machine-readable output is in `test-results/integration.json` and `test-results/e2e.log`.

## Acceptance outcomes → tests

| Required outcome | Test (file › name) | Result |
|---|---|---|
| Two simultaneous reservations of the last unit produce exactly one success | `acceptance.test.ts` › Concurrency › serialized unit (2 parallel transactions); lot-controlled last unit (5 parallel); two users via HTTP rescue endpoint | Pass |
| Moving a case reveals downstream conflicts; canceling releases reservations | › Case changes › move reveals conflicts and alerts owners; move past expiry releases; cancel releases all | Pass |
| Delivered tray missing a required instrument stays blocked; rep cannot record hospital release | › Rescue…/tray › courier scan alone not ready; missing instrument blocks; rep (403), other hospital (403/404), SPD before re-verification (409), ops cannot "resolve" by note (409); then replacement → re-verify → SPD release → ready. E2E steps 4–7 | Pass |
| Package of five cannot silently change stock by one or twenty-five | › Closeout › package scan → needs review, unit count null, no stock change; explicit 2 units → −2; package-level import converts 1 BX = 5 units; unknown level not guessed; conflicting lot expiry rejected | Pass |
| Expired, held and already reserved units excluded with visible reasons | › Rescue › excludes expired / held / reserved / hospital-owned with reasons; "closer" flag; exact item only. E2E step 2 | Pass |
| Replaying an import, offline scan or ERP ack creates no duplicate movement, charge or replenishment | › replaying an import; offline sync replay; ERP ack replay (with injected failure and retry) | Pass |
| Recall activated while offline blocks new allocation; later report of prior use stays in audit and creates a review task | › Recall while a device is offline (second-person verify; reserve/rescue/pick blocked; late sync recorded with `usage.sync_offline` audit, `late_usage_review` task, critical exception; completed case traced). E2E step 10 | Pass |
| Opened-unused chargeable under one agreement, review under another; neither recorded as implanted | › opened-unused (St. Brigid v3 → $2,150 draft; Prairie Valley → review; no movement to consumed; condition "opened") | Pass |
| A finance credit corrects the charge without returning the consumed implant to stock | › finance credit (net reduced, credit idempotent, zero new movements, unit still in CONSUMED); duplicate packet prevented; PO mismatch and duplicate PO refused | Pass |
| A facility cannot discover another facility's cases (search, guessed URLs, exports, notifications) | › Facility and tenant isolation (facility) and second test (cross-tenant API, search, guessed IDs, exports, inventory, RLS with no WHERE clause, background job scoping, CSRF). E2E step 11 | Pass |
| Ledger rebuild matches displayed balances after transfers, returns, adjustments and corrections | › Ledger integrity (transfer, return, reversal, double reversal refused, blind count + second-person approval, rebuild matches, UPDATE/DELETE rejected by triggers, API reconcile) | Pass |
| GS1 parsing with published examples | `gs1.test.ts`: GS1 example GTIN 09506000134352 check digit; HRI and raw `]d2`/GS forms; wedge placeholders; date rules; bad check digit; HIBCC/ISBT/unknown detection; AI 30 count not converted; **differential test against `gs1-barcode-parser-mod`** | 10/10 pass |
| Desktop and mobile browser flows | `tests/e2e/demo-story.spec.ts`: the full ten-minute demo across 9 roles; the rep step runs on an **iPhone 13 profile with real network offline mode**, reloads offline from the service-worker shell plus IndexedDB, queues 3 events, syncs on reconnect, checks for no horizontal overflow, then submits closeout | 11/11 pass |

## Defects found by the tests and fixed during this build

- Reps could not open shipments leaving their own trunk for another territory's case (rescue transfer). Fixed in `getVisibleShipment`.
- A conflicting lot expiry in an import aborted the whole batch. It is now a row-level error.
- Static asset routing broke after a rebuild (wildcard disabled). Fixed.
- The phone closeout page overflowed horizontally (long raw barcodes), which made mobile browsers zoom out so taps missed. Wrapping fixed, and an e2e assertion was added.
- Missing parameter in the replenishment insert, and recall query column collisions (`ref`). Fixed.

## Not verified (no physical hardware or external systems available)

- Real keyboard-wedge scanners (GS/FNC1 transmission settings vary by model), real camera DataMatrix decoding (`BarcodeDetector` was not exercised; it is unavailable in iOS Safari), real iPhones and Android devices, MDM-managed storage behavior, and iOS storage eviction.
- Real labels from manufacturers (only synthetic and GS1 example GTINs were used). HIBCC parsing is intentionally not implemented.
- Any real ERP, CRM, hospital scheduling or procurement system. All are simulated.
- Load, performance and long-running worker behavior; multi-instance deployment (login lockout is in-memory).
- Accessibility was built in (labels, focus styles, status text, 44 px+ targets) but **not audited** with a screen reader or automated a11y tooling.
