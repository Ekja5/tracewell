# Architecture and data model

## Shape

A modular monolith, chosen to keep pilot infrastructure small.

```
Browser PWA (React, Vite)  ──HTTPS/JSON──►  API server (Fastify, TypeScript)  ──►  PostgreSQL 16 (authoritative)
  ├─ service worker (app shell)               ├─ domain modules (src/server/domain)        ▲
  └─ IndexedDB offline queue                  └─ auth, permissions, audit                  │
                                              Background worker (src/worker) ──────────────┘
                                                 outbox delivery → mock ERP (simulated), cutoff alerts
```

| Path | Responsibility |
|---|---|
| `db/migrations/001_core.sql` | Schema, constraints, append-only triggers, serialized-unit trigger, row-level security policies |
| `src/server/domain/inventory.ts` | The ledger: `applyMovement` (the only way stock changes), reversals, reservations with locking, ledger rebuild and reconciliation |
| `src/server/domain/imports.ts` | CSV templates, mapping suggestions, validation, duplicate and replay detection, dry run, commit, reconciliation report |
| `src/server/domain/cases.ts` | Cases from approved preference cards; move, cancel and requirement changes with conflict analysis and alerts; **readiness derivation** |
| `src/server/domain/rescue.ts` | Exact-item rescue ranking, exclusion reasons, affected-case preview, atomic reserve plus transfer |
| `src/server/domain/shipments.ts` | Pick, pack, dispatch, courier events, receive (partial, unexpected, broken seal), reject, tray verification, discrepancies, custody acknowledgment, hospital release |
| `src/server/domain/closeout.ts` | Usage capture shared by online and offline sync: GS1 parsing, package handling, dispositions, hold escalation, review |
| `src/server/domain/billing.ts` | Contract-rule charge derivation, replenishment, packets, PO matching, credits, finance worklist, documents |
| `src/server/domain/recall.ts` | Recall entry, second-person verification, match preview, activation (holds and tasks), quarantine, disposition, closure |
| `src/server/domain/counts.ts` | Blind cycle counts, variance, approval by a second person, adjustments |
| `src/server/domain/erp.ts` | Outbox processing, mock ERP adapter, idempotent acknowledgments, integration status |
| `src/server/domain/metrics.ts` | Scorecard metrics with definitions and drill-down rows |
| `src/shared/gs1.ts` | GS1 element-string parser (browser and server), HIBCC and ISBT detection |
| `src/web` | PWA pages per role; `lib/offline.ts` holds the durable queue |

## Tenancy and access control

- Every business table carries `tenant_id`. Every request and every worker job runs inside `withTenant(tenantId)`, which sets the transaction-local `app.tenant_id`. **FORCE ROW LEVEL SECURITY** policies filter on that setting, so a missing `WHERE` clause cannot leak another tenant's rows. With no tenant set, queries return nothing (tested). The app connects as a non-superuser role.
- Within a tenant, the server enforces permissions by role (`src/server/perms.ts`). It also scopes by facility (hospital users see only their facility's cases, shipments, stock, exports and notifications) and by territory (reps see their territory, their assigned cases, and shipments touching their own trunk).
- Out-of-scope records return **404, not 403**, so guessed IDs do not reveal that a record exists.
- Onboarding another distributor means inserting a tenant plus its own users, facilities and catalog. No code changes are needed. The seed includes a second tenant (Ridgeway) to prove isolation.

## Inventory model

Each of these is a separate table or column:

| Concept | Where |
|---|---|
| Catalog item | `catalog_items` (ref, unit GTIN/DI, item type, tracking `serial`/`lot`, source provenance) |
| Package / UOM | `packages` (package GTIN → explicit `units_per_package`; conversion is never inferred) |
| Lot or serial identity | `stock_items` (one row per serial, or per item+lot; `data_source` = label / import / reviewed entry / seed) |
| Owner | `parties` (distributor, manufacturer consignment, hospital), on every balance and movement |
| Custodian / physical location | `locations` (warehouse, trunk with holder, consignment, hospital receiving, in-transit, quarantine, terminal buckets) |
| Stock condition | `sealed` / `opened` / `damaged` / `used`, on balances and movements |
| Quality hold | `quality_holds` (blocks allocation, picking and dispatch everywhere; does not move stock) |
| Reservation | `reservations` (case + requirement; a partial unique index allows one active reservation per serialized unit) |
| Financial disposition | `usage_events.disposition` → `charges`, `replenishments`, `credits` (credits never touch inventory) |

**Ledger.** `inventory_movements` is append-only, enforced by a trigger. Each row records who acted, `occurred_at` (what the actor reports), `recorded_at` (when the server received it, on the app clock), `db_created_at` (database wall clock) and a reason. Corrections are new rows linked by `reverses_movement_id` (unique, so a movement can be reversed once). `stock_balances` is a projection updated in the same transaction. The source row is locked `FOR UPDATE`, and a `CHECK (qty >= 0)` plus a deferred trigger guarantees that no serial ever has a quantity above 1. `ledgerReconciliation()` rebuilds balances from the ledger alone and compares them with the projection; the inventory page shows the result.

**Availability** = sealed on-hand at an allocatable location − active reservations, and zero if a hold exists. In-transit stock sits at the in-transit location, linked to its shipment.

**Trays.** A tray instance is a serialized stock item with a versioned manifest (`tray_manifest_versions` / `lines`). Moving a tray moves one unit. Its contents are described only by manifests and `tray_verifications` (expected vs actual per line), so contents are never double-counted.

**Concurrency and idempotency.** The system uses row locks, unique constraints and idempotency keys:
- movements: `(tenant, idempotency_key)`
- reservations: `idempotency_key`
- transfers: `shipments.idempotency_key`
- offline events: `usage_events.client_event_id`
- charges and replenishments: unique per usage event
- packets: one active per case and type
- credits: `idempotency_key`
- ERP acks: `(external_doc_ref, ack_type)`
- imports: `import_row_keys(kind, source_system, source_id, row_hash)`

Case edits use optimistic version checks.

## Readiness derivation (no status flags)

`caseReadiness()` evaluates every active mandatory requirement against records:

1. It looks for a reservation covering the quantity.
2. It checks for a hold and for expiry before the planned use date (facility-local).
3. It checks where the ledger says the unit is.
   - **At the facility:** for trays, the latest verification at that facility must be complete with no open discrepancy. If the facility policy requires it, a hospital release decision must also be recorded after that verification.
   - **In transit:** if the courier reported delivery without a hospital receipt, the blocker reads *"courier delivered; not received"*.
   - **Elsewhere:** the act-by time is the required-by time minus the seeded travel estimate.

It also flags stale simulated schedule feeds and open discrepancies. Each blocker carries a plain-English message, an owner, a required-by time and an act-by time. Required-by times come from the versioned `facility_policies`.

## Time

All timestamps are `timestamptz`. The UI renders them in the facility's time zone. The seed pins an application clock offset (`system_settings.clock_offset_ms`) so the demo date is deterministic. Without `DEMO_CLOCK`, run the seed with `DEMO_DATE` set to the real current date, or reset the offset to 0.

## Data-flow summary

CSV import → catalog, packages, opening balances (ledger) → cases from approved cards → reservations → shipments and custody → receiving, verification, hospital release → usage (online or offline) → movements, charges and replenishment → packet → outbox → mock ERP ack. Recall → holds and tasks across every location, reservations, shipments and completed-usage references.
