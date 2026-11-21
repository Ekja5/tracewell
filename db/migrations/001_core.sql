-- Tracewell Case Logistics: core schema.
-- Every business table carries tenant_id and is protected by FORCE ROW LEVEL SECURITY
-- keyed on the transaction-local setting app.tenant_id (see bottom of file).

CREATE TABLE system_settings (key text PRIMARY KEY, value jsonb NOT NULL);

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE territories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL
);

CREATE TABLE parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('distributor','manufacturer','hospital')),
  source_system text, source_id text,
  UNIQUE (tenant_id, name)
);

CREATE TABLE facilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('hospital','warehouse')),
  timezone text NOT NULL,
  territory_id uuid REFERENCES territories(id),
  party_id uuid REFERENCES parties(id),
  UNIQUE (tenant_id, code)
);

-- Versioned receiving / processing policy per facility. Latest approved effective version applies.
CREATE TABLE facility_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  facility_id uuid NOT NULL REFERENCES facilities(id),
  version int NOT NULL,
  tray_due_hours_before numeric NOT NULL,
  implant_due_hours_before numeric NOT NULL,
  requires_release_decision boolean NOT NULL DEFAULT true,
  required_evidence text[] NOT NULL DEFAULT '{}',
  receiving_notes text,
  effective_from timestamptz NOT NULL,
  approved_by text NOT NULL,
  UNIQUE (facility_id, version)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','ops_manager','inventory_coordinator','scheduler','rep','warehouse','courier','hospital_receiving','hospital_spd','finance','quality_manager')),
  facility_id uuid REFERENCES facilities(id),
  territory_id uuid REFERENCES territories(id),
  phone_hint text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role IN ('hospital_receiving','hospital_spd')) = (facility_id IS NOT NULL))
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('warehouse','trunk','consignment','hospital_receiving','hospital_spd','in_transit','quarantine','consumed','wasted','missing','returns')),
  facility_id uuid REFERENCES facilities(id),
  holder_user_id uuid REFERENCES users(id),
  allocatable boolean NOT NULL,
  UNIQUE (tenant_id, code)
);

CREATE TABLE travel_estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  from_location_id uuid NOT NULL REFERENCES locations(id),
  to_facility_id uuid NOT NULL REFERENCES facilities(id),
  minutes int NOT NULL CHECK (minutes > 0),
  courier_cost_cents int NOT NULL CHECK (courier_cost_cents >= 0),
  basis text NOT NULL DEFAULT 'Seeded estimate (synthetic); not live traffic or courier quote',
  UNIQUE (from_location_id, to_facility_id)
);

CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('catalog','packages','opening_balances')),
  filename text NOT NULL,
  source_system text NOT NULL,
  file_sha256 text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('dry_run','commit')),
  mapping jsonb NOT NULL,
  report jsonb NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL
);

CREATE TABLE import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  batch_id uuid NOT NULL REFERENCES import_batches(id),
  row_number int NOT NULL,
  source_id text,
  row_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted','duplicate_in_file','already_imported','conflict','error')),
  errors jsonb NOT NULL DEFAULT '[]',
  raw jsonb NOT NULL,
  entity_id uuid
);

-- Idempotency anchor for imports: one committed row per (kind, source system, source id).
CREATE TABLE import_row_keys (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL,
  source_system text NOT NULL,
  source_id text NOT NULL,
  row_hash text NOT NULL,
  first_batch_id uuid NOT NULL REFERENCES import_batches(id),
  entity_id uuid,
  PRIMARY KEY (tenant_id, kind, source_system, source_id)
);

CREATE TABLE catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  manufacturer_party_id uuid REFERENCES parties(id),
  ref text NOT NULL,
  description text NOT NULL,
  item_type text NOT NULL CHECK (item_type IN ('implant','instrument','tray','disposable')),
  tracking text NOT NULL CHECK (tracking IN ('serial','lot')),
  unit_gtin text,
  size text,
  product_line text,
  uom text NOT NULL DEFAULT 'EA',
  source_system text, source_id text,
  import_batch_id uuid REFERENCES import_batches(id),
  UNIQUE (tenant_id, ref),
  UNIQUE (tenant_id, unit_gtin)
);

-- Package configurations: a package GTIN maps to an explicit number of units. Never inferred.
CREATE TABLE packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  gtin text NOT NULL,
  level text NOT NULL CHECK (level IN ('each','inner','case')),
  units_per_package int NOT NULL CHECK (units_per_package > 0),
  uom text NOT NULL,
  source_system text, source_id text,
  import_batch_id uuid REFERENCES import_batches(id),
  UNIQUE (tenant_id, gtin)
);

-- A trackable identity: one row per serial, or one row per (item, lot) for lot-controlled stock.
CREATE TABLE stock_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  lot_number text,
  serial_number text,
  expiry_date date,
  is_serial boolean NOT NULL,
  data_source text NOT NULL CHECK (data_source IN ('label','import','reviewed_entry','seed')),
  import_batch_id uuid REFERENCES import_batches(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (is_serial = (serial_number IS NOT NULL)),
  CHECK (serial_number IS NOT NULL OR lot_number IS NOT NULL)
);
CREATE UNIQUE INDEX stock_items_serial_uq ON stock_items(tenant_id, catalog_item_id, serial_number) WHERE serial_number IS NOT NULL;
CREATE UNIQUE INDEX stock_items_lot_uq ON stock_items(tenant_id, catalog_item_id, lot_number) WHERE serial_number IS NULL;

CREATE TABLE tray_manifest_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  tray_catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  version int NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','approved','retired')),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  UNIQUE (tray_catalog_item_id, version)
);
CREATE TABLE tray_manifest_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  manifest_version_id uuid NOT NULL REFERENCES tray_manifest_versions(id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  qty int NOT NULL CHECK (qty > 0),
  required boolean NOT NULL DEFAULT true
);
-- A tray instance is a serialized stock item; its contents are described by manifests and
-- verifications only, never as separate ledger balances (no double counting).
CREATE TABLE tray_instances (
  stock_item_id uuid PRIMARY KEY REFERENCES stock_items(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  manifest_version_id uuid NOT NULL REFERENCES tray_manifest_versions(id)
);

CREATE TABLE preference_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  surgeon_ref text NOT NULL,
  procedure text NOT NULL,
  UNIQUE (tenant_id, code)
);
CREATE TABLE preference_card_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  card_id uuid NOT NULL REFERENCES preference_cards(id),
  version int NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','approved','superseded')),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  change_note text,
  UNIQUE (card_id, version),
  CHECK (status = 'draft' OR approved_by IS NOT NULL)
);
CREATE TABLE preference_card_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  card_version_id uuid NOT NULL REFERENCES preference_card_versions(id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  qty int NOT NULL CHECK (qty > 0),
  mandatory boolean NOT NULL,
  backup_for_line_id uuid REFERENCES preference_card_lines(id),
  note text,
  CHECK (NOT (mandatory AND backup_for_line_id IS NOT NULL))
);

CREATE TABLE cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  case_ref text NOT NULL,
  facility_id uuid NOT NULL REFERENCES facilities(id),
  procedure text NOT NULL,
  surgeon_ref text NOT NULL,
  scheduled_start timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('scheduled','cancelled','completed','closed')),
  urgent boolean NOT NULL DEFAULT false,
  rep_user_id uuid REFERENCES users(id),
  preference_card_version_id uuid REFERENCES preference_card_versions(id),
  version int NOT NULL DEFAULT 1,
  completed_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, case_ref)
);
CREATE TABLE case_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  case_id uuid NOT NULL REFERENCES cases(id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  qty int NOT NULL CHECK (qty > 0),
  mandatory boolean NOT NULL,
  source_card_line_id uuid REFERENCES preference_card_lines(id),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE quality_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  stock_item_id uuid NOT NULL REFERENCES stock_items(id),
  recall_id uuid,
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','released')),
  placed_by uuid NOT NULL REFERENCES users(id),
  placed_at timestamptz NOT NULL,
  released_by uuid REFERENCES users(id),
  released_at timestamptz
);
CREATE UNIQUE INDEX quality_holds_active_uq ON quality_holds(stock_item_id, recall_id) WHERE status='active';

CREATE TABLE shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  ref text NOT NULL,
  case_id uuid REFERENCES cases(id),
  from_location_id uuid NOT NULL REFERENCES locations(id),
  to_location_id uuid NOT NULL REFERENCES locations(id),
  kind text NOT NULL CHECK (kind IN ('case_delivery','rescue_transfer','replenishment','return')),
  status text NOT NULL CHECK (status IN ('planned','picked','packed','dispatched','delivered','received','closed','rejected','cancelled')),
  courier_name text,
  due_by timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  idempotency_key text,
  UNIQUE (tenant_id, ref),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  case_id uuid NOT NULL REFERENCES cases(id),
  requirement_id uuid REFERENCES case_requirements(id),
  stock_item_id uuid NOT NULL REFERENCES stock_items(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  owner_party_id uuid NOT NULL REFERENCES parties(id),
  qty int NOT NULL CHECK (qty > 0),
  is_serial boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('active','released','consumed')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  released_at timestamptz,
  release_reason text,
  idempotency_key text,
  UNIQUE (tenant_id, idempotency_key)
);
-- Hard guarantee: a serialized unit can hold at most one active reservation.
CREATE UNIQUE INDEX reservations_serial_active_uq ON reservations(tenant_id, stock_item_id) WHERE status='active' AND is_serial;

CREATE TABLE shipment_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  shipment_id uuid NOT NULL REFERENCES shipments(id),
  stock_item_id uuid NOT NULL REFERENCES stock_items(id),
  owner_party_id uuid NOT NULL REFERENCES parties(id),
  reservation_id uuid REFERENCES reservations(id),
  qty_expected int NOT NULL CHECK (qty_expected > 0),
  qty_picked int NOT NULL DEFAULT 0,
  qty_dispatched int NOT NULL DEFAULT 0,
  qty_received int NOT NULL DEFAULT 0,
  received_condition text
);

CREATE TABLE inventory_movements (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  stock_item_id uuid NOT NULL REFERENCES stock_items(id),
  qty int NOT NULL CHECK (qty > 0),
  owner_party_id uuid NOT NULL REFERENCES parties(id),
  from_location_id uuid REFERENCES locations(id),
  from_condition text,
  to_location_id uuid REFERENCES locations(id),
  to_condition text,
  movement_type text NOT NULL CHECK (movement_type IN ('opening_balance','receipt','transfer','dispatch','receive','consume','return','adjustment','condition_change','quarantine','reversal','correction','disposition')),
  shipment_id uuid REFERENCES shipments(id),
  case_id uuid REFERENCES cases(id),
  usage_event_id uuid,
  import_batch_id uuid REFERENCES import_batches(id),
  count_session_id uuid,
  reverses_movement_id bigint UNIQUE REFERENCES inventory_movements(id),
  reason text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  db_created_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text,
  UNIQUE (tenant_id, idempotency_key),
  CHECK (from_location_id IS NOT NULL OR to_location_id IS NOT NULL),
  CHECK (to_condition IS NULL OR to_condition IN ('sealed','opened','damaged','used'))
);
CREATE INDEX inv_mov_stock ON inventory_movements(tenant_id, stock_item_id);

-- Projection of the ledger, maintained in the same transaction as each movement.
CREATE TABLE stock_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  stock_item_id uuid NOT NULL REFERENCES stock_items(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  owner_party_id uuid NOT NULL REFERENCES parties(id),
  condition text NOT NULL CHECK (condition IN ('sealed','opened','damaged','used')),
  qty int NOT NULL CHECK (qty >= 0),
  last_movement_id bigint,
  UNIQUE (stock_item_id, location_id, owner_party_id, condition)
);

CREATE TABLE custody_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  shipment_id uuid NOT NULL REFERENCES shipments(id),
  event_type text NOT NULL CHECK (event_type IN ('picked','packed','dispatched','courier_scan','delivered','received','rejected','closed')),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  from_location_id uuid REFERENCES locations(id),
  to_location_id uuid REFERENCES locations(id),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  ack_state text NOT NULL CHECK (ack_state IN ('pending','acknowledged','disputed','not_required')),
  ack_by uuid REFERENCES users(id),
  ack_at timestamptz,
  notes text
);

CREATE TABLE tray_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  tray_stock_item_id uuid NOT NULL REFERENCES stock_items(id),
  manifest_version_id uuid NOT NULL REFERENCES tray_manifest_versions(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  shipment_id uuid REFERENCES shipments(id),
  case_id uuid REFERENCES cases(id),
  seal_intact boolean NOT NULL,
  result text NOT NULL CHECK (result IN ('complete','incomplete')),
  verified_by uuid NOT NULL REFERENCES users(id),
  verified_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  supersedes_id uuid REFERENCES tray_verifications(id)
);
CREATE TABLE tray_verification_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  verification_id uuid NOT NULL REFERENCES tray_verifications(id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  expected_qty int NOT NULL,
  actual_qty int NOT NULL CHECK (actual_qty >= 0),
  required boolean NOT NULL
);

CREATE TABLE discrepancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  shipment_id uuid REFERENCES shipments(id),
  case_id uuid REFERENCES cases(id),
  tray_stock_item_id uuid REFERENCES stock_items(id),
  stock_item_id uuid REFERENCES stock_items(id),
  catalog_item_id uuid REFERENCES catalog_items(id),
  kind text NOT NULL CHECK (kind IN ('short','over','unexpected_unit','broken_seal','missing_instrument','rejected_delivery','count_variance','disputed_observation')),
  qty int,
  detail text NOT NULL,
  status text NOT NULL CHECK (status IN ('open','resolved')),
  reported_by uuid NOT NULL REFERENCES users(id),
  reported_at timestamptz NOT NULL,
  resolution text,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz
);

-- Hospital release decisions. Recorded only by authorized hospital personnel of that facility.
-- The software records the decision and the evidence references the hospital supplies;
-- it never infers sterilization or issues clinical clearance.
CREATE TABLE release_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  case_id uuid NOT NULL REFERENCES cases(id),
  facility_id uuid NOT NULL REFERENCES facilities(id),
  tray_stock_item_id uuid REFERENCES stock_items(id),
  decision text NOT NULL CHECK (decision IN ('released','not_released')),
  evidence jsonb NOT NULL,
  statement text NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL
);

CREATE TABLE usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  case_id uuid NOT NULL REFERENCES cases(id),
  client_event_id text NOT NULL,
  catalog_item_id uuid REFERENCES catalog_items(id),
  stock_item_id uuid REFERENCES stock_items(id),
  disposition text NOT NULL CHECK (disposition IN ('implanted','opened_unused','wasted','damaged','returned_sealed','missing')),
  qty_units int CHECK (qty_units > 0), -- units as captured; NULL when a package label was scanned without an explicit unit count
  reviewed_qty_units int CHECK (reviewed_qty_units > 0), -- unit count entered by a reviewer
  package_gtin text,
  units_per_package int,
  entry_method text NOT NULL CHECK (entry_method IN ('scanner','camera','manual','simulator')),
  raw_scan text,
  scan_format text,
  parsed jsonb,
  status text NOT NULL CHECK (status IN ('recorded','needs_review','rejected')),
  review_reason text,
  recorded_offline boolean NOT NULL DEFAULT false,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  UNIQUE (tenant_id, client_event_id),
  CHECK (status <> 'recorded' OR coalesce(reviewed_qty_units, qty_units) IS NOT NULL)
);

CREATE TABLE instrument_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  case_id uuid NOT NULL REFERENCES cases(id),
  tray_stock_item_id uuid NOT NULL REFERENCES stock_items(id),
  status text NOT NULL CHECK (status IN ('awaiting_return','returned','missing_items')),
  note text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL,
  client_event_id text,
  UNIQUE (tenant_id, client_event_id)
);

CREATE TABLE contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  facility_id uuid NOT NULL REFERENCES facilities(id),
  name text NOT NULL
);
CREATE TABLE contract_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  contract_id uuid NOT NULL REFERENCES contracts(id),
  version int NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  approved_by text NOT NULL,
  UNIQUE (contract_id, version)
);
CREATE TABLE contract_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  contract_version_id uuid NOT NULL REFERENCES contract_versions(id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  unit_price_cents int NOT NULL CHECK (unit_price_cents >= 0),
  price_date date NOT NULL,
  UNIQUE (contract_version_id, catalog_item_id)
);
CREATE TABLE contract_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  contract_version_id uuid NOT NULL REFERENCES contract_versions(id),
  disposition text NOT NULL,
  charge_action text NOT NULL CHECK (charge_action IN ('charge','no_charge','review')),
  replenish_action text NOT NULL CHECK (replenish_action IN ('replace','none','review')),
  billing_mode text NOT NULL CHECK (billing_mode IN ('bill_only','bill_and_replace')),
  rule_text text NOT NULL,
  UNIQUE (contract_version_id, disposition)
);

CREATE TABLE billing_packets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  case_id uuid NOT NULL REFERENCES cases(id),
  packet_type text NOT NULL CHECK (packet_type IN ('bill_only','bill_and_replace')),
  status text NOT NULL CHECK (status IN ('draft','queued_to_erp','erp_received_simulated','po_matched','disputed','accepted','void')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX billing_packets_one_active ON billing_packets(tenant_id, case_id, packet_type) WHERE status <> 'void';

CREATE TABLE charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  case_id uuid NOT NULL REFERENCES cases(id),
  usage_event_id uuid NOT NULL REFERENCES usage_events(id),
  packet_id uuid REFERENCES billing_packets(id),
  catalog_item_id uuid REFERENCES catalog_items(id),
  contract_version_id uuid REFERENCES contract_versions(id),
  rule_id uuid REFERENCES contract_rules(id),
  qty int NOT NULL,
  unit_price_cents int,
  amount_cents int,
  price_date date,
  status text NOT NULL CHECK (status IN ('draft','review','no_charge','exception')),
  rationale text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (usage_event_id)
);
CREATE TABLE replenishments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  case_id uuid NOT NULL REFERENCES cases(id),
  usage_event_id uuid NOT NULL UNIQUE REFERENCES usage_events(id),
  catalog_item_id uuid REFERENCES catalog_items(id),
  qty int NOT NULL,
  action text NOT NULL CHECK (action IN ('replace','none','review')),
  status text NOT NULL CHECK (status IN ('open','done','not_required','review')),
  rationale text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  charge_id uuid NOT NULL REFERENCES charges(id),
  amount_cents int NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  packet_id uuid NOT NULL REFERENCES billing_packets(id),
  po_number text NOT NULL,
  entered_by uuid NOT NULL REFERENCES users(id),
  entered_at timestamptz NOT NULL,
  match_status text NOT NULL CHECK (match_status IN ('matched','mismatch')),
  match_detail jsonb NOT NULL,
  UNIQUE (tenant_id, po_number)
);
CREATE TABLE purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  po_id uuid NOT NULL REFERENCES purchase_orders(id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  qty int NOT NULL,
  unit_price_cents int NOT NULL
);

CREATE TABLE recalls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  ref text NOT NULL,
  manufacturer_party_id uuid NOT NULL REFERENCES parties(id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  scope_type text NOT NULL CHECK (scope_type IN ('lot','serial')),
  scope_values text[] NOT NULL CHECK (cardinality(scope_values) > 0),
  manufacturer_notice_ref text NOT NULL,
  description text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','verified','active','closed')),
  entered_by uuid NOT NULL REFERENCES users(id),
  entered_at timestamptz NOT NULL,
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  activated_by uuid REFERENCES users(id),
  activated_at timestamptz,
  closed_by uuid REFERENCES users(id),
  closed_at timestamptz,
  closure_evidence text,
  UNIQUE (tenant_id, ref),
  CHECK (verified_by IS NULL OR verified_by <> entered_by)
);
ALTER TABLE quality_holds ADD CONSTRAINT quality_holds_recall_fk FOREIGN KEY (recall_id) REFERENCES recalls(id);
CREATE TABLE recall_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  recall_id uuid NOT NULL REFERENCES recalls(id),
  task_type text NOT NULL CHECK (task_type IN ('acknowledge_and_quarantine','open_case_alert','completed_case_trace','late_usage_review','return_in_transit')),
  stock_item_id uuid REFERENCES stock_items(id),
  location_id uuid REFERENCES locations(id),
  case_id uuid REFERENCES cases(id),
  usage_event_id uuid REFERENCES usage_events(id),
  owner_user_id uuid REFERENCES users(id),
  qty int,
  status text NOT NULL CHECK (status IN ('open','acknowledged','quarantined','dispositioned','closed')),
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz,
  disposition text,
  dispositioned_by uuid REFERENCES users(id),
  dispositioned_at timestamptz,
  detail text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE count_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  status text NOT NULL CHECK (status IN ('open','submitted','approved','rejected')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  submitted_by uuid REFERENCES users(id),
  submitted_at timestamptz,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text
);
CREATE TABLE count_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  session_id uuid NOT NULL REFERENCES count_sessions(id),
  stock_item_id uuid NOT NULL REFERENCES stock_items(id),
  owner_party_id uuid NOT NULL REFERENCES parties(id),
  counted_qty int NOT NULL CHECK (counted_qty >= 0),
  expected_qty int,
  counted_at timestamptz NOT NULL,
  UNIQUE (session_id, stock_item_id, owner_party_id)
);

CREATE TABLE exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  title text NOT NULL,
  detail text NOT NULL,
  case_id uuid REFERENCES cases(id),
  facility_id uuid REFERENCES facilities(id),
  ref_table text, ref_id text,
  owner_role text,
  owner_user_id uuid REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('open','resolved')),
  created_at timestamptz NOT NULL,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  resolution text,
  dedupe_key text,
  UNIQUE (tenant_id, dedupe_key)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  case_id uuid REFERENCES cases(id),
  facility_id uuid REFERENCES facilities(id),
  kind text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL,
  read_at timestamptz,
  dedupe_key text,
  UNIQUE (tenant_id, user_id, dedupe_key)
);

CREATE TABLE integration_feeds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  simulated boolean NOT NULL,
  live_enabled boolean NOT NULL DEFAULT false,
  stale_after_minutes int NOT NULL,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  mock_fail_next int NOT NULL DEFAULT 0,
  field_ownership jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, code),
  CHECK (NOT (simulated AND live_enabled))
);
CREATE TABLE sync_differences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  feed_id uuid NOT NULL REFERENCES integration_feeds(id),
  entity text NOT NULL,
  entity_ref text NOT NULL,
  field text NOT NULL,
  our_value text, their_value text,
  status text NOT NULL CHECK (status IN ('open','resolved')),
  created_at timestamptz NOT NULL
);
CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  feed_code text NOT NULL,
  topic text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','delivered','acknowledged','failed','dead')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE TABLE outbox_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outbox_id uuid NOT NULL REFERENCES outbox(id),
  attempted_at timestamptz NOT NULL,
  result text NOT NULL,
  detail jsonb NOT NULL
);
CREATE TABLE erp_acks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outbox_id uuid NOT NULL REFERENCES outbox(id),
  external_doc_ref text NOT NULL,
  ack_type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL,
  UNIQUE (tenant_id, external_doc_ref, ack_type)
);

CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key text NOT NULL,
  endpoint text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  case_id uuid,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  db_created_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  data jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_case ON audit_log(tenant_id, case_id);

-- Append-only enforcement.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only; record a correction or reversal instead', TG_TABLE_NAME; END $$;
CREATE TRIGGER movements_append_only BEFORE UPDATE OR DELETE ON inventory_movements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER verif_append_only BEFORE UPDATE OR DELETE ON tray_verifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER release_append_only BEFORE UPDATE OR DELETE ON release_decisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER credits_append_only BEFORE UPDATE OR DELETE ON credits FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER erp_acks_append_only BEFORE UPDATE OR DELETE ON erp_acks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION custody_ack_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'custody_events is append-only'; END IF;
  IF (NEW.shipment_id, NEW.event_type, NEW.actor_user_id, NEW.from_location_id, NEW.to_location_id, NEW.occurred_at, NEW.recorded_at)
     IS DISTINCT FROM (OLD.shipment_id, OLD.event_type, OLD.actor_user_id, OLD.from_location_id, OLD.to_location_id, OLD.occurred_at, OLD.recorded_at) THEN
    RAISE EXCEPTION 'custody_events: only acknowledgment fields may change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER custody_ack BEFORE UPDATE OR DELETE ON custody_events FOR EACH ROW EXECUTE FUNCTION custody_ack_only();

CREATE FUNCTION usage_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'usage_events cannot be deleted'; END IF;
  IF (NEW.case_id, NEW.client_event_id, NEW.disposition, NEW.qty_units, NEW.raw_scan, NEW.occurred_at, NEW.actor_user_id)
     IS DISTINCT FROM (OLD.case_id, OLD.client_event_id, OLD.disposition, OLD.qty_units, OLD.raw_scan, OLD.occurred_at, OLD.actor_user_id) THEN
    RAISE EXCEPTION 'usage_events: captured facts are immutable; only review fields may change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER usage_guard BEFORE UPDATE OR DELETE ON usage_events FOR EACH ROW EXECUTE FUNCTION usage_no_delete();

-- A serialized unit can never exist in more than one place at once.
CREATE FUNCTION serial_single_unit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total int; ser boolean;
BEGIN
  SELECT is_serial INTO ser FROM stock_items WHERE id = NEW.stock_item_id;
  IF ser THEN
    SELECT coalesce(sum(qty),0) INTO total FROM stock_balances WHERE stock_item_id = NEW.stock_item_id;
    IF total > 1 THEN RAISE EXCEPTION 'serialized unit % would have quantity %', NEW.stock_item_id, total; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER serial_unit_check AFTER INSERT OR UPDATE ON stock_balances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION serial_single_unit();

-- Row-level security on every tenant-scoped table.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
           WHERE table_schema='public' AND column_name='tenant_id'
             AND table_name NOT IN ('users','sessions')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)$p$, t);
  END LOOP;
END $$;
