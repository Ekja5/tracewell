# Production-readiness checklist

Status: ✅ implemented in this repo · 🧪 covered by automated tests · ⬜ deployment or customer work outstanding

## Identity and access
- ✅🧪 Tenant isolation via forced RLS and a non-superuser DB role
- ✅🧪 Role, facility and territory least privilege; 404 on out-of-scope IDs
- ✅ Demo shortcuts disabled in production
- ⬜ SSO (OIDC/SAML) with MFA via the customer IdP; SCIM or just-in-time deprovisioning
- ⬜ Hospital-user sponsorship and quarterly access review procedure
- ⬜ Distributed rate limiting and lockout (replace in-memory)

## Data protection
- ✅ No patient identifiers in the schema; synthetic opaque case refs
- ✅ Secrets via environment only; `.env` ignored
- ⬜ TLS everywhere; HSTS at the edge
- ⬜ Encryption at rest (managed PostgreSQL with KMS), encrypted backups
- ⬜ Privacy review, data-flow sign-off, BAAs **before** any patient-linked data
- ⬜ MDM policy for field devices (passcode, encryption, remote wipe)

## Records and audit
- ✅🧪 Append-only ledger, audit, verifications, releases, credits, acks (DB triggers)
- ✅🧪 Reasons on moves, cancellations, reviews, credits; second-person recall verification and count approval
- ⬜ Part 11 e-signature implementation, if a manufacturer uses the system for predicate-rule records
- ⬜ Retention schedule and archival (partitioning) agreed with the customer
- ⬜ Audit-log review procedure

## Reliability and operations
- ✅ Migrations, deterministic seed, one-command startup, worker with per-tenant transactions
- ✅🧪 Idempotency keys and outbox retry with dead-letter exceptions
- ⬜ Managed PostgreSQL with PITR; quarterly restore test including `ledger/reconcile`
- ⬜ Health checks, metrics, alerting (5xx, outbox dead letters, stale feeds, sync backlog)
- ⬜ Run API and worker as separate services; at least 2 API replicas; graceful shutdown
- ⬜ Load test the readiness board and rescue search at expected volumes
- ⬜ CI: typecheck, integration tests on PostgreSQL, e2e, `npm audit`/SCA, container scan

## Integrations
- ✅🧪 CSV import/export with provenance; mock ERP outbox/ack
- ⬜ For each live adapter: credentials, field mappings, integration-user permissions, sandbox acceptance tests. Live is disabled until then.

## Field validation
- ⬜ Test with customers' actual scanners (GS/FNC1 config), phones, labels (including HIBCC share), and MDM
- ⬜ Accessibility audit (screen reader, contrast, keyboard paths)
- ⬜ Usability sessions with reps (one-handed phone use) and receiving desks
- ⬜ Hospital sign-off on receiving policies, required evidence fields and who may record release
- ⬜ Collect the baseline per `pilot-scorecard.md` before go-live

## Regulatory and contract (see `standards-matrix.md`)
- ⬜ Intended-use statement reviewed by regulatory counsel
- ⬜ Manufacturer CSA assessment if used within a QMS
- ⬜ Customer SOPs for recall execution, count approval and usage review
