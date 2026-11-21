-- Second pass: issue ownership, grouped alerts, usage corrections, sync quarantine, finance history,
-- partial POs, facility receiving hours. Additive only: existing first-build data is preserved.
--
-- Backfills below run as the (non-superuser) table owner. Because tables use FORCE ROW LEVEL SECURITY,
-- an owner's UPDATE/SELECT without app.tenant_id sees zero rows, so RLS is lifted for this migration's
-- transaction only and restored at the end (tested in tests/integration/migration.test.ts).
ALTER TABLE facility_policies NO FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications NO FORCE ROW LEVEL SECURITY;
ALTER TABLE charges NO FORCE ROW LEVEL SECURITY;

-- Facility receiving hours (facility-local wall clock). NULL = always open.
ALTER TABLE facility_policies ADD COLUMN receiving_open time, ADD COLUMN receiving_close time;
UPDATE facility_policies SET receiving_open = '06:00', receiving_close = '20:00' WHERE receiving_open IS NULL AND tray_due_hours_before <= 12;
UPDATE facility_policies SET receiving_open = '07:00', receiving_close = '15:00' WHERE receiving_open IS NULL AND tray_due_hours_before > 12;

-- Owned, trackable issues derived from readiness blockers.
CREATE TABLE case_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  case_id uuid NOT NULL REFERENCES cases(id),
  issue_key text NOT NULL,
  code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical','warning')),
  message text NOT NULL,
  action text,
  link text,
  status text NOT NULL CHECK (status IN ('open','acknowledged','resolved')),
  owner_user_id uuid REFERENCES users(id),
  owner_role text,
  owner_locked boolean NOT NULL DEFAULT false,
  act_by timestamptz,
  required_by timestamptz,
  escalation_level int NOT NULL DEFAULT 0,
  escalated_at timestamptz,
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  resolution text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, case_id, issue_key)
);
CREATE INDEX case_issues_open ON case_issues(tenant_id, status, act_by);
CREATE TABLE issue_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  issue_id uuid NOT NULL REFERENCES case_issues(id),
  kind text NOT NULL CHECK (kind IN ('opened','assigned','acknowledged','note','escalated','deadline_changed','updated','resolved','reopened')),
  actor_user_id uuid REFERENCES users(id),
  at timestamptz NOT NULL,
  detail text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX issue_events_issue ON issue_events(issue_id, at);
CREATE TRIGGER issue_events_append_only BEFORE UPDATE OR DELETE ON issue_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Grouped, closable alerts.
ALTER TABLE notifications ADD COLUMN issue_id uuid REFERENCES case_issues(id),
  ADD COLUMN repeat_count int NOT NULL DEFAULT 1,
  ADD COLUMN last_at timestamptz,
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  ADD COLUMN closed_reason text;
UPDATE notifications SET last_at = created_at WHERE last_at IS NULL;

-- Usage corrections (void with linked ledger reversal) and reviewer quantity.
ALTER TABLE usage_events DROP CONSTRAINT usage_events_status_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_status_check CHECK (status IN ('recorded','needs_review','rejected','voided'));
ALTER TABLE usage_events ADD COLUMN voided_by uuid REFERENCES users(id), ADD COLUMN voided_at timestamptz, ADD COLUMN void_reason text;

-- Anything a device sent that could not be stored as a usage event is kept here, never dropped.
CREATE TABLE sync_quarantine (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  client_event_id text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  payload jsonb NOT NULL,
  reason text NOT NULL,
  received_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution text,
  UNIQUE (tenant_id, client_event_id)
);

-- Finance: owners, voids, price history, partial POs.
ALTER TABLE charges DROP CONSTRAINT charges_status_check;
ALTER TABLE charges ADD CONSTRAINT charges_status_check CHECK (status IN ('draft','review','no_charge','exception','void'));
ALTER TABLE charges ADD COLUMN owner_user_id uuid REFERENCES users(id);
ALTER TABLE replenishments DROP CONSTRAINT replenishments_status_check;
ALTER TABLE replenishments ADD CONSTRAINT replenishments_status_check CHECK (status IN ('open','done','not_required','review','void'));
ALTER TABLE billing_packets DROP CONSTRAINT billing_packets_status_check;
ALTER TABLE billing_packets ADD CONSTRAINT billing_packets_status_check CHECK (status IN ('draft','queued_to_erp','erp_received_simulated','po_partial','po_matched','disputed','accepted','void'));
ALTER TABLE billing_packets ADD COLUMN sent_at timestamptz;
ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_match_status_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_match_status_check CHECK (match_status IN ('matched','partial','mismatch'));
CREATE TABLE charge_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  charge_id uuid NOT NULL REFERENCES charges(id),
  kind text NOT NULL CHECK (kind IN ('derived','price_set','resolved_charge','resolved_no_charge','assigned','packeted','po_applied','credited','voided','approved')),
  from_status text, to_status text,
  from_price_cents int, to_price_cents int,
  amount_cents int,
  reason text,
  actor_user_id uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  at timestamptz NOT NULL
);
CREATE INDEX charge_events_charge ON charge_events(charge_id, at);
CREATE TRIGGER charge_events_append_only BEFORE UPDATE OR DELETE ON charge_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- Backfill history for first-build charges.
INSERT INTO charge_events(tenant_id, charge_id, kind, to_status, to_price_cents, amount_cents, reason, at)
  SELECT tenant_id, id, 'derived', status, unit_price_cents, amount_cents, rationale, created_at FROM charges;

-- Row-level security for new tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['case_issues','issue_events','sync_quarantine','charge_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)$p$, t);
  END LOOP;
END $$;

-- Packets: one open draft per case/type (duplicate prevention), supplemental packets allowed after sending.
DROP INDEX billing_packets_one_active;
CREATE UNIQUE INDEX billing_packets_one_draft ON billing_packets(tenant_id, case_id, packet_type) WHERE status = 'draft';

ALTER TABLE facility_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE charges FORCE ROW LEVEL SECURITY;
