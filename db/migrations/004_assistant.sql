-- Third pass: "Ask operations" assistant, reviewable action drafts, field-rep quick notes.
-- Also allows the same catalog number from two manufacturers (real-world collision) within a tenant.

ALTER TABLE catalog_items DROP CONSTRAINT catalog_items_tenant_id_ref_key;
CREATE UNIQUE INDEX catalog_items_mfr_ref_uq ON catalog_items(tenant_id, manufacturer_party_id, ref);
CREATE INDEX catalog_items_ref_ci ON catalog_items(tenant_id, lower(ref));

-- The distributor's home time zone, used to interpret "before 3 today" for distributor staff.
ALTER TABLE tenants ADD COLUMN timezone text NOT NULL DEFAULT 'America/Chicago';

CREATE TABLE assistant_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  -- Carried through follow-ups: case, facility, catalog item, manufacturer, package GTIN, stock unit.
  context jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE assistant_messages (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL REFERENCES assistant_conversations(id),
  role text NOT NULL CHECK (role IN ('user','assistant')),
  text text NOT NULL,
  -- Server-produced, typed tool results shown as cards (facts, sources, caveats). The model never writes these.
  cards jsonb NOT NULL DEFAULT '[]',
  mode text,
  checked_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX assistant_messages_conv ON assistant_messages(conversation_id, id);

-- One row per model request (or demo/no-model answer) for cost and reliability tracking.
CREATE TABLE assistant_usage (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  conversation_id uuid REFERENCES assistant_conversations(id),
  mode text NOT NULL CHECK (mode IN ('provider','demo','unavailable')),
  provider text, model text,
  input_tokens int, output_tokens int, cache_read_tokens int,
  tool_calls int NOT NULL DEFAULT 0,
  latency_ms int NOT NULL,
  status text NOT NULL CHECK (status IN ('ok','error','timeout','refused')),
  error text,
  created_at timestamptz NOT NULL
);

-- Reviewable drafts created from an answer. Executed only on explicit confirmation, through the
-- existing application services, with every check repeated at confirmation time.
CREATE TABLE assistant_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  created_by uuid NOT NULL REFERENCES users(id),
  conversation_id uuid REFERENCES assistant_conversations(id),
  kind text NOT NULL CHECK (kind IN ('assign_followup','transfer','message')),
  status text NOT NULL CHECK (status IN ('draft','confirmed','stale','discarded')),
  payload jsonb NOT NULL,
  -- What the draft was based on (e.g. unit availability) so confirmation can explain what changed.
  basis jsonb NOT NULL DEFAULT '{}',
  result jsonb,
  case_id uuid REFERENCES cases(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  confirmed_by uuid REFERENCES users(id),
  confirmed_at timestamptz
);

-- Field-rep quick notes: original text kept verbatim; structured draft reviewed by the rep before approval.
CREATE TABLE handoff_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  client_note_id text NOT NULL,
  case_id uuid NOT NULL REFERENCES cases(id),
  author_user_id uuid NOT NULL REFERENCES users(id),
  original_text text NOT NULL,
  structured jsonb NOT NULL,
  questions jsonb NOT NULL DEFAULT '[]',
  extraction_mode text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','approved','discarded')),
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  approved_at timestamptz,
  discrepancy_id uuid REFERENCES discrepancies(id),
  UNIQUE (tenant_id, client_note_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assistant_conversations','assistant_messages','assistant_usage','assistant_drafts','handoff_notes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)$p$, t);
  END LOOP;
END $$;
