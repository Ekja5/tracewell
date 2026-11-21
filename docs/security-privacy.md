# Security, privacy and operations

Status key: **Implemented** = in this codebase · **Tested** = covered by an automated test · **Deployment** = must be done by whoever runs production.

## Controls

| Control | Status | Notes |
|---|---|---|
| Authentication (local accounts, bcrypt hashes, HttpOnly SameSite=Lax session cookie, 12 h expiry, server-side revocation at sign-out) | Implemented | Login lockout after 5 failures for 5 min (in-memory; per instance). |
| Demo login shortcuts | Implemented, **development only** | `/api/auth/demo-*` return 404 whenever `NODE_ENV=production`. |
| Production identity (SSO via OIDC/SAML, MFA, SCIM deprovisioning) | **Deployment** | Replace local accounts with the customer IdP. Keep the role and facility mapping in the app. |
| Tenant isolation (FORCE RLS keyed to a transaction-local tenant, non-superuser DB role) | Implemented, **Tested** | API, search, guessed IDs, exports, inventory, background jobs. |
| Facility and territory least privilege | Implemented, **Tested** | Cases, search, URLs, shipments, exports, notifications. |
| Role permissions on every API route (server side) | Implemented, partly tested | Rep refused hospital release; counter refused self-approval; same-user recall verification refused. |
| CSRF defense (custom header on state-changing requests) | Implemented, **Tested** | |
| Security headers (CSP, nosniff, frame deny, no-store on API) | Implemented | |
| Append-only ledger, audit, verification, release, credit, ERP-ack tables | Implemented, **Tested** | DB triggers reject UPDATE and DELETE. |
| Idempotency for imports, offline events, transfers, credits, ERP acks | Implemented, **Tested** | |
| Secrets out of source control | Implemented | `.env` is git-ignored; `.env.example` has local-only placeholders. |
| Sensitive data kept out of logs | Implemented | The access log records method, route pattern, status and duration only: no bodies, query strings or cookies. Errors log code and message only. |
| Encryption in transit (TLS) | **Deployment** | Terminate TLS at a load balancer or proxy; set `secure` cookies (automatic when `NODE_ENV=production`). |
| Encryption at rest (database, backups) | **Deployment** | Use managed PostgreSQL with storage encryption and KMS-managed keys. |
| Offline device storage encryption | **Not implemented** | IndexedDB is not encrypted by the app. Rely on managed devices (MDM, device passcode, full-disk encryption). See `offline.md`. |
| Rate limiting at the edge, WAF | **Deployment** | |
| Dependency and container scanning | **Deployment** | Run `npm audit` and an SCA tool in CI. |

## Backups and restoration (deployment runbook)

1. Use managed PostgreSQL with point-in-time recovery (WAL archiving), keeping at least 35 days, plus daily snapshots copied to a separate account or region.
2. **Restore test every quarter:** restore to a fresh instance, run `npm run migrate`, run `GET /api/ledger/reconcile` for each tenant (it must report `matches: true`), and spot-check audit continuity.
3. Recovery targets for the pilot: RPO ≤ 15 min, RTO ≤ 4 h. Confirm these with the customer.
4. Because the ledger is append-only, a restore never "fixes" history. Post-restore corrections are new reversal or correction movements.

## Retention

The pilot default is to retain everything (ledger, audit, usage, recalls). Before production, agree retention per record type with the customer. Recall and traceability records typically need multi-year retention that follows the manufacturer's device-life obligations. Implement archival (partitioned audit tables) rather than deletion.

## Access reviews

Each quarter, the customer administrator exports the user list (role, facility, territory, last login) and attests to it. Remove leavers the same day through IdP deprovisioning once SSO is in place. Hospital users must be sponsored by the hospital.

## Incident response (outline)

1. Detect: alerts on authentication anomalies, 5xx rates, outbox dead letters and RLS errors.
2. Contain: revoke sessions (`update sessions set revoked_at=now()`), disable accounts, rotate DB credentials.
3. Assess: use the audit log (actor, occurred and recorded times), ledger and access logs.
4. Notify: per contract and applicable law. If ePHI were ever involved, follow HIPAA breach notification timelines (no ePHI is expected in the pilot).
5. Recover and review: write a root-cause report and a control change.

## Privacy

- The pilot uses synthetic, opaque case references only. The schema has **no fields** for patient name, MRN, date of birth or clinical notes.
- Data flows: hospital schedule (future) → case time and facility; rep and hospital users → custody, usage and release records; finance → PO and acceptance references; simulated ERP ← draft packet lines (item, lot/serial, qty, price; no patient data).
- **Before enabling real patient-linked data:**
  1. Complete a privacy review and data-flow diagram.
  2. Confirm whether the deployment handles ePHI.
  3. Execute BAAs with covered entities and subprocessors (hosting, logging, email).
  4. Perform a HIPAA risk analysis.
  5. Enable encryption at rest.
  6. Restrict exports.
  7. Add audit-log review procedures.
- Even an opaque real-world case ID can be linkable when combined with date, facility and surgeon. Treat it as potentially identifying until reviewed.
