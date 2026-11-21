# Integrations

**Every integration in the pilot is simulated or not connected, and the interface labels them that way.** Live connections are hard-disabled (`config.liveIntegrationsEnabled = false`, and a database check forbids `simulated AND live_enabled`). Enable a live adapter only when all of these exist: credentials issued by the customer, approved field mappings, a permission model for the integration user, and written acceptance criteria with test data.

No private APIs, proprietary systems or incumbent products are accessed or imitated. Some target agencies publicly describe using Redspot alongside SAP or Salesforce. Those are treated as **possible import or integration boundaries only**: CSV import/export today, adapters later if a customer provides access and requirements.

## What ships

| Integration | Mode | What it does |
|---|---|---|
| CSV import (catalog, packages, opening balances) | Real | Templates, mapping preview, row errors, duplicate detection, dry run, commit, reconciliation, provenance (source system, source ID, batch, file SHA-256) |
| CSV export (cases, balances, ledger, usage report) | Real | Scoped to the caller's tenant and facility; audited |
| Mock ERP adapter | **SIMULATED** | The outbox stores the draft packet. The worker delivers it with retry and backoff (max 5 attempts, then dead letter plus a finance exception). The mock returns a document reference and an idempotent acknowledgment (`erp_acks` unique on reference and type). The packet moves to *ERP received (simulated)*. It is **never** marked paid. The Integrations page can inject failures and replay an ack. |
| Hospital OR schedule feeds (per facility) | **SIMULATED** | Shows "last successful sync". A stale feed appears as a readiness warning. The seed includes one unresolved difference (case time). |
| SAP ERP, Salesforce | **NOT CONNECTED** (placeholders) | Listed so the boundary is visible. Nothing is implemented. |

## Field ownership (system of record)

| Field | Owner |
|---|---|
| Case scheduled start, facility, procedure | Hospital scheduling system (via a future feed). Tracewell holds a copy and shows feed freshness. |
| Case requirements | Tracewell (from the human-approved preference card version) |
| Catalog, GTIN/DI, package configurations | Manufacturer price/catalog file, imported with provenance |
| Opening balances | Legacy system or spreadsheet at cutover, then the **Tracewell ledger** |
| Stock location, custody, condition, holds, reservations | Tracewell ledger |
| Hospital release decision and processing evidence | Hospital personnel (recorded in Tracewell, not inferred) |
| Draft charges, replenishment actions, packet contents | Tracewell (derived from versioned contract rules) |
| Contract terms and prices | Customer contract (entered or imported into Tracewell) |
| Customer PO number and lines | Customer, entered by finance |
| Invoice number, payment status, customer master | ERP. Tracewell never sets these. |

## Adding a real adapter later

Implement a function with the same contract as `mockErpReceive` (payload in; external reference or error out), keep the outbox, attempt log and idempotent ack table, and add an inbound webhook that calls `ingestAck`. Map each field above explicitly, and keep the adapter disabled until its acceptance tests pass against the customer's sandbox.
