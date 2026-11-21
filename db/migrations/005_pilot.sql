-- Fourth pass: distributor pilot. Spreadsheet uploads (CSV/Excel) with saved column mappings,
-- inventory snapshots as OBSERVATIONS (never silent ledger edits), reconciliation with decision
-- history, and pilot evaluation records (predictions vs verified outcomes).

-- The raw file is kept so any answer can be traced back to the exact row the coordinator uploaded.
CREATE TABLE upload_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  filename text NOT NULL,
  content_sha256 text NOT NULL,
  size_bytes int NOT NULL,
  content bytea NOT NULL,
  sheets jsonb NOT NULL,            -- [{name, rows, headerRow, headers}]
  uploaded_by uuid NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL,
  UNIQUE (tenant_id, content_sha256)
);

-- One committed interpretation of one worksheet.
CREATE TABLE upload_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  file_id uuid NOT NULL REFERENCES upload_files(id),
  worksheet text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('inventory','schedule','requirements')),
  mapping jsonb NOT NULL,
  header_row int NOT NULL,
  -- When the source system produced the file (stated by the coordinator), distinct from upload time.
  exported_at timestamptz NOT NULL,
  -- inventory only: 'complete' = lists everything at the covered locations; 'partial' = missing rows mean nothing.
  coverage text CHECK (coverage IN ('complete','partial')),
  covered_location_ids uuid[] NOT NULL DEFAULT '{}',
  counts jsonb NOT NULL DEFAULT '{}',
  summary jsonb NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  -- Re-uploading the same file for the same worksheet and purpose returns the first run.
  UNIQUE (tenant_id, file_id, worksheet, kind)
);

CREATE TABLE upload_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  run_id uuid NOT NULL REFERENCES upload_runs(id),
  row_number int NOT NULL,          -- the row number the coordinator sees in Excel
  raw jsonb NOT NULL,               -- header -> cell text exactly as read
  interpreted jsonb NOT NULL DEFAULT '{}',
  outcome text NOT NULL CHECK (outcome IN ('accepted','held','skipped')),
  reason_code text,
  message text NOT NULL DEFAULT '', -- plain-English result or correction
  entity jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL,
  UNIQUE (run_id, row_number)
);
CREATE INDEX upload_rows_run ON upload_rows(tenant_id, run_id, outcome);

CREATE TABLE column_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL,
  header_signature text NOT NULL,   -- normalized header list; tomorrow's file with the same columns reuses it
  worksheet text,
  mapping jsonb NOT NULL,
  options jsonb NOT NULL DEFAULT '{}',
  saved_by uuid NOT NULL REFERENCES users(id),
  saved_at timestamptz NOT NULL,
  UNIQUE (tenant_id, kind, header_signature)
);

-- "St. Mary's" in the spreadsheet means this facility/location/manufacturer: decided once by a person.
CREATE TABLE name_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('facility','location','manufacturer')),
  alias_norm text NOT NULL,
  alias_text text NOT NULL,
  target_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, kind, alias_norm)
);

-- Box/pack to single-unit conversions. A row quantity in boxes is only converted with a VERIFIED entry.
CREATE TABLE uom_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  uom_norm text NOT NULL,
  units_per int CHECK (units_per > 0),          -- null until someone states it
  proposed_from text,               -- e.g. "inventory_monday.xlsx row 7 (Units per box = 5)"
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (catalog_item_id, uom_norm)
);

-- What a spreadsheet SAID was on hand. An observation is evidence, not a stock movement.
CREATE TABLE balance_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  run_id uuid NOT NULL REFERENCES upload_runs(id),
  row_id uuid NOT NULL REFERENCES upload_rows(id),
  stock_item_id uuid NOT NULL REFERENCES stock_items(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  owner_party_id uuid NOT NULL REFERENCES parties(id),
  observed_qty int NOT NULL CHECK (observed_qty >= 0),
  exported_at timestamptz NOT NULL,
  role text NOT NULL CHECK (role IN ('opening','snapshot','stale')),
  ledger_qty int NOT NULL,                       -- system balance at the moment of upload
  previous_observation_id uuid REFERENCES balance_observations(id),
  created_at timestamptz NOT NULL
);
CREATE INDEX balance_obs_key ON balance_observations(tenant_id, stock_item_id, location_id, exported_at DESC);

-- A difference between an observation and the ledger. Cause stays open until someone decides with evidence.
CREATE TABLE stock_discrepancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  ref text NOT NULL,
  run_id uuid NOT NULL REFERENCES upload_runs(id),
  observation_id uuid REFERENCES balance_observations(id),
  stock_item_id uuid NOT NULL REFERENCES stock_items(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  owner_party_id uuid NOT NULL REFERENCES parties(id),
  kind text NOT NULL CHECK (kind IN ('quantity','not_listed')),
  ledger_qty int NOT NULL,
  observed_qty int NOT NULL,
  previous_observed_qty int,
  status text NOT NULL CHECK (status IN ('open','resolved','superseded')),
  cause text,
  opened_at timestamptz NOT NULL,
  resolved_at timestamptz,
  UNIQUE (tenant_id, ref)
);
CREATE INDEX stock_disc_open ON stock_discrepancies(tenant_id, status, stock_item_id);

CREATE TABLE discrepancy_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  discrepancy_id uuid NOT NULL REFERENCES stock_discrepancies(id),
  decision text NOT NULL CHECK (decision IN ('accept_observed','keep_system','note','reopen','superseded')),
  cause text CHECK (cause IN ('transfer','use','loss','correction','receipt','unknown')),
  note text NOT NULL DEFAULT '',
  evidence_ref text,
  qty_before int,
  qty_after int,
  movement_id bigint REFERENCES inventory_movements(id),
  decided_by uuid NOT NULL REFERENCES users(id),
  decided_at timestamptz NOT NULL
);

ALTER TABLE inventory_movements ADD COLUMN upload_row_id uuid REFERENCES upload_rows(id);
ALTER TABLE inventory_movements ADD COLUMN stock_discrepancy_id uuid REFERENCES stock_discrepancies(id);
ALTER TABLE cases ADD COLUMN upload_row_id uuid REFERENCES upload_rows(id);
ALTER TABLE case_requirements ADD COLUMN upload_row_id uuid REFERENCES upload_rows(id);
ALTER TABLE stock_items DROP CONSTRAINT stock_items_data_source_check;
ALTER TABLE stock_items ADD CONSTRAINT stock_items_data_source_check CHECK (data_source IN ('label','import','reviewed_entry','seed','upload'));

-- Pilot evaluation. Append-only: a revision is a new row that supersedes the previous one.
CREATE TABLE pilot_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  case_id uuid NOT NULL REFERENCES cases(id),
  source text NOT NULL CHECK (source IN ('existing_process','app')),
  prediction text NOT NULL CHECK (prediction IN ('ready','problem','unknown')),
  detail text NOT NULL DEFAULT '',
  snapshot jsonb NOT NULL DEFAULT '{}',          -- app: the blockers shown at that moment
  supersedes_id uuid REFERENCES pilot_predictions(id),
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL
);
CREATE INDEX pilot_pred_case ON pilot_predictions(tenant_id, case_id, source, recorded_at DESC);

CREATE TABLE pilot_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  case_id uuid NOT NULL REFERENCES cases(id),
  -- Three separate facts: was there really a problem, what was done about it, how did the case go.
  verified_problem text NOT NULL CHECK (verified_problem IN ('yes','no','unknown')),
  problem_detail text NOT NULL DEFAULT '',
  problem_evidence text NOT NULL DEFAULT '',
  intervention text NOT NULL DEFAULT '',
  case_outcome text NOT NULL CHECK (case_outcome IN ('on_time','delayed','cancelled','workaround','unknown')),
  minutes_saved int CHECK (minutes_saved >= 0),
  freight_avoided_cents int CHECK (freight_avoided_cents >= 0),
  savings_evidence text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  supersedes_id uuid REFERENCES pilot_outcomes(id),
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL
);
CREATE INDEX pilot_out_case ON pilot_outcomes(tenant_id, case_id, recorded_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['upload_files','upload_runs','upload_rows','column_mappings','name_aliases','uom_conversions','balance_observations','stock_discrepancies','discrepancy_decisions','pilot_predictions','pilot_outcomes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)$p$, t);
  END LOOP;
END $$;

-- Evidence tables are append-only.
CREATE TRIGGER balance_obs_append_only BEFORE UPDATE OR DELETE ON balance_observations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER disc_decisions_append_only BEFORE UPDATE OR DELETE ON discrepancy_decisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER pilot_pred_append_only BEFORE UPDATE OR DELETE ON pilot_predictions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER pilot_out_append_only BEFORE UPDATE OR DELETE ON pilot_outcomes FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
