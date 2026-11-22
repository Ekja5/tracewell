-- Operations command center: planning settings, transfer requests, corporate loaners, par levels,
-- and the identifiers records carried in the system they came from.

-- One row per tenant. Nothing here is specific to one manufacturer: the planning window, the allocation
-- rule and the loaner source are settings.
CREATE TABLE ops_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  planning_window_hours int NOT NULL DEFAULT 72 CHECK (planning_window_hours BETWEEN 24 AND 336),
  allocation_rule text NOT NULL DEFAULT 'first_entered' CHECK (allocation_rule IN ('first_entered','earliest_surgery')),
  loaner_source_name text,                 -- e.g. "Corporate loaner desk"; null = loaners not set up
  loaner_transit_hours int NOT NULL DEFAULT 24 CHECK (loaner_transit_hours BETWEEN 1 AND 240),
  loaner_cutoff_local time NOT NULL DEFAULT '15:00',   -- requests after this ship the next business day
  loaner_timezone text NOT NULL DEFAULT 'America/New_York',
  loaner_return_days int NOT NULL DEFAULT 3 CHECK (loaner_return_days BETWEEN 1 AND 60),
  expiry_warning_days int NOT NULL DEFAULT 60 CHECK (expiry_warning_days BETWEEN 7 AND 365),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz
);

-- A request to take a specific unit from whoever holds it. The unit is held for the case from the moment
-- of the request (so nobody else is promised it); nothing moves until the holder accepts.
CREATE TABLE transfer_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  ref text NOT NULL,
  case_id uuid NOT NULL REFERENCES cases(id),
  requirement_id uuid NOT NULL REFERENCES case_requirements(id),
  stock_item_id uuid NOT NULL REFERENCES stock_items(id),
  from_location_id uuid NOT NULL REFERENCES locations(id),
  owner_party_id uuid NOT NULL REFERENCES parties(id),
  to_facility_id uuid NOT NULL REFERENCES facilities(id),
  status text NOT NULL CHECK (status IN ('requested','accepted','declined','cancelled')),
  owner_user_id uuid NOT NULL REFERENCES users(id),      -- who is responsible for seeing it through
  approver_user_id uuid REFERENCES users(id),            -- who must agree to give the unit up (null = warehouse team)
  pickup_by text NOT NULL,                               -- who collects it
  pickup_at timestamptz NOT NULL,                        -- when it leaves
  receiver text NOT NULL,                                -- who checks it in at the destination
  required_by timestamptz NOT NULL,
  donor_check jsonb NOT NULL DEFAULT '[]',               -- the giving side's own upcoming cases, as seen at request time
  note text,
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL,
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text,
  reservation_id uuid REFERENCES reservations(id),
  shipment_id uuid REFERENCES shipments(id),
  UNIQUE (tenant_id, ref)
);
CREATE INDEX transfer_requests_case ON transfer_requests(tenant_id, case_id);
CREATE INDEX transfer_requests_open ON transfer_requests(tenant_id, status);

-- A loaner asked for from the configured outside source, tracked from request to return.
CREATE TABLE loaner_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  ref text NOT NULL,
  case_id uuid NOT NULL REFERENCES cases(id),
  requirement_id uuid REFERENCES case_requirements(id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  qty int NOT NULL CHECK (qty > 0),
  status text NOT NULL CHECK (status IN ('requested','confirmed','shipped','received','returned','cancelled')),
  source_name text NOT NULL,
  request_by timestamptz NOT NULL,          -- the latest moment the request could be placed and still arrive in time
  needed_by timestamptz NOT NULL,
  expected_arrival timestamptz,
  source_confirmation text,                 -- the source's own order / confirmation number
  inbound_tracking text,
  return_tracking text,
  due_back date,
  stock_item_id uuid REFERENCES stock_items(id),
  received_location_id uuid REFERENCES locations(id),
  reservation_id uuid REFERENCES reservations(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL,
  UNIQUE (tenant_id, ref)
);
CREATE INDEX loaner_requests_case ON loaner_requests(tenant_id, case_id);
CREATE TABLE loaner_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  loaner_id uuid NOT NULL REFERENCES loaner_requests(id),
  event text NOT NULL CHECK (event IN ('requested','confirmed','shipped','received','returned','cancelled','note')),
  detail text,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX loaner_events_loaner ON loaner_events(loaner_id, occurred_at);
CREATE TRIGGER loaner_events_append_only BEFORE UPDATE OR DELETE ON loaner_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- The quantity a location is meant to hold of an item.
CREATE TABLE par_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  par_qty int NOT NULL CHECK (par_qty >= 0),
  set_by uuid NOT NULL REFERENCES users(id),
  set_at timestamptz NOT NULL,
  UNIQUE (tenant_id, location_id, catalog_item_id)
);

-- The identifier a record had in the system it was brought over from (kept so people can search by the number they know).
CREATE TABLE external_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  entity_type text NOT NULL CHECK (entity_type IN ('case','facility','catalog_item','user','location')),
  entity_id uuid NOT NULL,
  system text NOT NULL,
  external_id text NOT NULL,
  upload_row_id uuid REFERENCES upload_rows(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_type, system, external_id)
);
CREATE INDEX external_refs_entity ON external_refs(tenant_id, entity_type, entity_id);

-- Which system an uploaded file was exported from (shown on the run; labels the previous-system IDs it carries).
ALTER TABLE upload_runs ADD COLUMN source_system text;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_settings','transfer_requests','loaner_requests','loaner_events','par_levels','external_refs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)$p$, t);
  END LOOP;
END $$;
