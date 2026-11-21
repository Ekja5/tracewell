--
-- PostgreSQL database dump
--

\restrict PvG4mS8gICplQe7tNuJFnVbvDMeEK36YE40rX8vzv9dpb4mZzamxHWiAJZUJdnR

-- Dumped from database version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS '';


--
-- Name: custody_ack_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.custody_ack_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'custody_events is append-only'; END IF;
  IF (NEW.shipment_id, NEW.event_type, NEW.actor_user_id, NEW.from_location_id, NEW.to_location_id, NEW.occurred_at, NEW.recorded_at)
     IS DISTINCT FROM (OLD.shipment_id, OLD.event_type, OLD.actor_user_id, OLD.from_location_id, OLD.to_location_id, OLD.occurred_at, OLD.recorded_at) THEN
    RAISE EXCEPTION 'custody_events: only acknowledgment fields may change';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: forbid_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.forbid_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION '% is append-only; record a correction or reversal instead', TG_TABLE_NAME; END $$;


--
-- Name: serial_single_unit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.serial_single_unit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE total int; ser boolean;
BEGIN
  SELECT is_serial INTO ser FROM stock_items WHERE id = NEW.stock_item_id;
  IF ser THEN
    SELECT coalesce(sum(qty),0) INTO total FROM stock_balances WHERE stock_item_id = NEW.stock_item_id;
    IF total > 1 THEN RAISE EXCEPTION 'serialized unit % would have quantity %', NEW.stock_item_id, total; END IF;
  END IF;
  RETURN NULL;
END $$;


--
-- Name: usage_no_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.usage_no_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'usage_events cannot be deleted'; END IF;
  IF (NEW.case_id, NEW.client_event_id, NEW.disposition, NEW.qty_units, NEW.raw_scan, NEW.occurred_at, NEW.actor_user_id)
     IS DISTINCT FROM (OLD.case_id, OLD.client_event_id, OLD.disposition, OLD.qty_units, OLD.raw_scan, OLD.occurred_at, OLD.actor_user_id) THEN
    RAISE EXCEPTION 'usage_events: captured facts are immutable; only review fields may change';
  END IF;
  RETURN NEW;
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    actor_user_id uuid,
    action text NOT NULL,
    entity text NOT NULL,
    entity_id text,
    case_id uuid,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    db_created_at timestamp with time zone DEFAULT now() NOT NULL,
    reason text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL
);

ALTER TABLE ONLY public.audit_log FORCE ROW LEVEL SECURITY;


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;


--
-- Name: billing_packets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_packets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    case_id uuid NOT NULL,
    packet_type text NOT NULL,
    status text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    accepted_by uuid,
    CONSTRAINT billing_packets_packet_type_check CHECK ((packet_type = ANY (ARRAY['bill_only'::text, 'bill_and_replace'::text]))),
    CONSTRAINT billing_packets_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'queued_to_erp'::text, 'erp_received_simulated'::text, 'po_matched'::text, 'disputed'::text, 'accepted'::text, 'void'::text])))
);

ALTER TABLE ONLY public.billing_packets FORCE ROW LEVEL SECURITY;


--
-- Name: case_requirements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_requirements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    case_id uuid NOT NULL,
    catalog_item_id uuid NOT NULL,
    qty integer NOT NULL,
    mandatory boolean NOT NULL,
    source_card_line_id uuid,
    active boolean DEFAULT true NOT NULL,
    CONSTRAINT case_requirements_qty_check CHECK ((qty > 0))
);

ALTER TABLE ONLY public.case_requirements FORCE ROW LEVEL SECURITY;


--
-- Name: cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    case_ref text NOT NULL,
    facility_id uuid NOT NULL,
    procedure text NOT NULL,
    surgeon_ref text NOT NULL,
    scheduled_start timestamp with time zone NOT NULL,
    status text NOT NULL,
    urgent boolean DEFAULT false NOT NULL,
    rep_user_id uuid,
    preference_card_version_id uuid,
    version integer DEFAULT 1 NOT NULL,
    completed_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cases_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'cancelled'::text, 'completed'::text, 'closed'::text])))
);

ALTER TABLE ONLY public.cases FORCE ROW LEVEL SECURITY;


--
-- Name: catalog_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catalog_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    manufacturer_party_id uuid,
    ref text NOT NULL,
    description text NOT NULL,
    item_type text NOT NULL,
    tracking text NOT NULL,
    unit_gtin text,
    size text,
    product_line text,
    uom text DEFAULT 'EA'::text NOT NULL,
    source_system text,
    source_id text,
    import_batch_id uuid,
    CONSTRAINT catalog_items_item_type_check CHECK ((item_type = ANY (ARRAY['implant'::text, 'instrument'::text, 'tray'::text, 'disposable'::text]))),
    CONSTRAINT catalog_items_tracking_check CHECK ((tracking = ANY (ARRAY['serial'::text, 'lot'::text])))
);

ALTER TABLE ONLY public.catalog_items FORCE ROW LEVEL SECURITY;


--
-- Name: charges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.charges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    case_id uuid NOT NULL,
    usage_event_id uuid NOT NULL,
    packet_id uuid,
    catalog_item_id uuid,
    contract_version_id uuid,
    rule_id uuid,
    qty integer NOT NULL,
    unit_price_cents integer,
    amount_cents integer,
    price_date date,
    status text NOT NULL,
    rationale text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT charges_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'review'::text, 'no_charge'::text, 'exception'::text])))
);

ALTER TABLE ONLY public.charges FORCE ROW LEVEL SECURITY;


--
-- Name: contract_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_prices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    contract_version_id uuid NOT NULL,
    catalog_item_id uuid NOT NULL,
    unit_price_cents integer NOT NULL,
    price_date date NOT NULL,
    CONSTRAINT contract_prices_unit_price_cents_check CHECK ((unit_price_cents >= 0))
);

ALTER TABLE ONLY public.contract_prices FORCE ROW LEVEL SECURITY;


--
-- Name: contract_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    contract_version_id uuid NOT NULL,
    disposition text NOT NULL,
    charge_action text NOT NULL,
    replenish_action text NOT NULL,
    billing_mode text NOT NULL,
    rule_text text NOT NULL,
    CONSTRAINT contract_rules_billing_mode_check CHECK ((billing_mode = ANY (ARRAY['bill_only'::text, 'bill_and_replace'::text]))),
    CONSTRAINT contract_rules_charge_action_check CHECK ((charge_action = ANY (ARRAY['charge'::text, 'no_charge'::text, 'review'::text]))),
    CONSTRAINT contract_rules_replenish_action_check CHECK ((replenish_action = ANY (ARRAY['replace'::text, 'none'::text, 'review'::text])))
);

ALTER TABLE ONLY public.contract_rules FORCE ROW LEVEL SECURITY;


--
-- Name: contract_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    contract_id uuid NOT NULL,
    version integer NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    approved_by text NOT NULL
);

ALTER TABLE ONLY public.contract_versions FORCE ROW LEVEL SECURITY;


--
-- Name: contracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contracts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    facility_id uuid NOT NULL,
    name text NOT NULL
);

ALTER TABLE ONLY public.contracts FORCE ROW LEVEL SECURITY;


--
-- Name: count_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.count_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    session_id uuid NOT NULL,
    stock_item_id uuid NOT NULL,
    owner_party_id uuid NOT NULL,
    counted_qty integer NOT NULL,
    expected_qty integer,
    counted_at timestamp with time zone NOT NULL,
    CONSTRAINT count_lines_counted_qty_check CHECK ((counted_qty >= 0))
);

ALTER TABLE ONLY public.count_lines FORCE ROW LEVEL SECURITY;


--
-- Name: count_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.count_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    location_id uuid NOT NULL,
    status text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    submitted_by uuid,
    submitted_at timestamp with time zone,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    review_note text,
    CONSTRAINT count_sessions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'submitted'::text, 'approved'::text, 'rejected'::text])))
);

ALTER TABLE ONLY public.count_sessions FORCE ROW LEVEL SECURITY;


--
-- Name: credits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    charge_id uuid NOT NULL,
    amount_cents integer NOT NULL,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    idempotency_key text NOT NULL,
    CONSTRAINT credits_amount_cents_check CHECK ((amount_cents > 0))
);

ALTER TABLE ONLY public.credits FORCE ROW LEVEL SECURITY;


--
-- Name: custody_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custody_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    shipment_id uuid NOT NULL,
    event_type text NOT NULL,
    actor_user_id uuid NOT NULL,
    from_location_id uuid,
    to_location_id uuid,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    ack_state text NOT NULL,
    ack_by uuid,
    ack_at timestamp with time zone,
    notes text,
    CONSTRAINT custody_events_ack_state_check CHECK ((ack_state = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'disputed'::text, 'not_required'::text]))),
    CONSTRAINT custody_events_event_type_check CHECK ((event_type = ANY (ARRAY['picked'::text, 'packed'::text, 'dispatched'::text, 'courier_scan'::text, 'delivered'::text, 'received'::text, 'rejected'::text, 'closed'::text])))
);

ALTER TABLE ONLY public.custody_events FORCE ROW LEVEL SECURITY;


--
-- Name: discrepancies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discrepancies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    shipment_id uuid,
    case_id uuid,
    tray_stock_item_id uuid,
    stock_item_id uuid,
    catalog_item_id uuid,
    kind text NOT NULL,
    qty integer,
    detail text NOT NULL,
    status text NOT NULL,
    reported_by uuid NOT NULL,
    reported_at timestamp with time zone NOT NULL,
    resolution text,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    CONSTRAINT discrepancies_kind_check CHECK ((kind = ANY (ARRAY['short'::text, 'over'::text, 'unexpected_unit'::text, 'broken_seal'::text, 'missing_instrument'::text, 'rejected_delivery'::text, 'count_variance'::text, 'disputed_observation'::text]))),
    CONSTRAINT discrepancies_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])))
);

ALTER TABLE ONLY public.discrepancies FORCE ROW LEVEL SECURITY;


--
-- Name: erp_acks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.erp_acks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    outbox_id uuid NOT NULL,
    external_doc_ref text NOT NULL,
    ack_type text NOT NULL,
    payload jsonb NOT NULL,
    received_at timestamp with time zone NOT NULL
);

ALTER TABLE ONLY public.erp_acks FORCE ROW LEVEL SECURITY;


--
-- Name: exceptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exceptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    severity text NOT NULL,
    title text NOT NULL,
    detail text NOT NULL,
    case_id uuid,
    facility_id uuid,
    ref_table text,
    ref_id text,
    owner_role text,
    owner_user_id uuid,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    resolution text,
    dedupe_key text,
    CONSTRAINT exceptions_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text]))),
    CONSTRAINT exceptions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])))
);

ALTER TABLE ONLY public.exceptions FORCE ROW LEVEL SECURITY;


--
-- Name: facilities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.facilities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    timezone text NOT NULL,
    territory_id uuid,
    party_id uuid,
    CONSTRAINT facilities_kind_check CHECK ((kind = ANY (ARRAY['hospital'::text, 'warehouse'::text])))
);

ALTER TABLE ONLY public.facilities FORCE ROW LEVEL SECURITY;


--
-- Name: facility_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.facility_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    facility_id uuid NOT NULL,
    version integer NOT NULL,
    tray_due_hours_before numeric NOT NULL,
    implant_due_hours_before numeric NOT NULL,
    requires_release_decision boolean DEFAULT true NOT NULL,
    required_evidence text[] DEFAULT '{}'::text[] NOT NULL,
    receiving_notes text,
    effective_from timestamp with time zone NOT NULL,
    approved_by text NOT NULL
);

ALTER TABLE ONLY public.facility_policies FORCE ROW LEVEL SECURITY;


--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_keys (
    tenant_id uuid NOT NULL,
    key text NOT NULL,
    endpoint text NOT NULL,
    response jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.idempotency_keys FORCE ROW LEVEL SECURITY;


--
-- Name: import_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    filename text NOT NULL,
    source_system text NOT NULL,
    file_sha256 text NOT NULL,
    mode text NOT NULL,
    mapping jsonb NOT NULL,
    report jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT import_batches_kind_check CHECK ((kind = ANY (ARRAY['catalog'::text, 'packages'::text, 'opening_balances'::text]))),
    CONSTRAINT import_batches_mode_check CHECK ((mode = ANY (ARRAY['dry_run'::text, 'commit'::text])))
);

ALTER TABLE ONLY public.import_batches FORCE ROW LEVEL SECURITY;


--
-- Name: import_row_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_row_keys (
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    source_system text NOT NULL,
    source_id text NOT NULL,
    row_hash text NOT NULL,
    first_batch_id uuid NOT NULL,
    entity_id uuid
);

ALTER TABLE ONLY public.import_row_keys FORCE ROW LEVEL SECURITY;


--
-- Name: import_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_rows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    row_number integer NOT NULL,
    source_id text,
    row_hash text NOT NULL,
    status text NOT NULL,
    errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    raw jsonb NOT NULL,
    entity_id uuid,
    CONSTRAINT import_rows_status_check CHECK ((status = ANY (ARRAY['accepted'::text, 'duplicate_in_file'::text, 'already_imported'::text, 'conflict'::text, 'error'::text])))
);

ALTER TABLE ONLY public.import_rows FORCE ROW LEVEL SECURITY;


--
-- Name: instrument_returns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instrument_returns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    case_id uuid NOT NULL,
    tray_stock_item_id uuid NOT NULL,
    status text NOT NULL,
    note text,
    recorded_by uuid NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    client_event_id text,
    CONSTRAINT instrument_returns_status_check CHECK ((status = ANY (ARRAY['awaiting_return'::text, 'returned'::text, 'missing_items'::text])))
);

ALTER TABLE ONLY public.instrument_returns FORCE ROW LEVEL SECURITY;


--
-- Name: integration_feeds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_feeds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    simulated boolean NOT NULL,
    live_enabled boolean DEFAULT false NOT NULL,
    stale_after_minutes integer NOT NULL,
    last_success_at timestamp with time zone,
    last_attempt_at timestamp with time zone,
    last_error text,
    mock_fail_next integer DEFAULT 0 NOT NULL,
    field_ownership jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT integration_feeds_check CHECK ((NOT (simulated AND live_enabled)))
);

ALTER TABLE ONLY public.integration_feeds FORCE ROW LEVEL SECURITY;


--
-- Name: inventory_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_movements (
    id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    stock_item_id uuid NOT NULL,
    qty integer NOT NULL,
    owner_party_id uuid NOT NULL,
    from_location_id uuid,
    from_condition text,
    to_location_id uuid,
    to_condition text,
    movement_type text NOT NULL,
    shipment_id uuid,
    case_id uuid,
    usage_event_id uuid,
    import_batch_id uuid,
    count_session_id uuid,
    reverses_movement_id bigint,
    reason text NOT NULL,
    actor_user_id uuid NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    db_created_at timestamp with time zone DEFAULT now() NOT NULL,
    idempotency_key text,
    CONSTRAINT inventory_movements_check CHECK (((from_location_id IS NOT NULL) OR (to_location_id IS NOT NULL))),
    CONSTRAINT inventory_movements_movement_type_check CHECK ((movement_type = ANY (ARRAY['opening_balance'::text, 'receipt'::text, 'transfer'::text, 'dispatch'::text, 'receive'::text, 'consume'::text, 'return'::text, 'adjustment'::text, 'condition_change'::text, 'quarantine'::text, 'reversal'::text, 'correction'::text, 'disposition'::text]))),
    CONSTRAINT inventory_movements_qty_check CHECK ((qty > 0)),
    CONSTRAINT inventory_movements_to_condition_check CHECK (((to_condition IS NULL) OR (to_condition = ANY (ARRAY['sealed'::text, 'opened'::text, 'damaged'::text, 'used'::text]))))
);

ALTER TABLE ONLY public.inventory_movements FORCE ROW LEVEL SECURITY;


--
-- Name: inventory_movements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.inventory_movements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inventory_movements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.inventory_movements_id_seq OWNED BY public.inventory_movements.id;


--
-- Name: locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.locations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    facility_id uuid,
    holder_user_id uuid,
    allocatable boolean NOT NULL,
    CONSTRAINT locations_kind_check CHECK ((kind = ANY (ARRAY['warehouse'::text, 'trunk'::text, 'consignment'::text, 'hospital_receiving'::text, 'hospital_spd'::text, 'in_transit'::text, 'quarantine'::text, 'consumed'::text, 'wasted'::text, 'missing'::text, 'returns'::text])))
);

ALTER TABLE ONLY public.locations FORCE ROW LEVEL SECURITY;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    case_id uuid,
    facility_id uuid,
    kind text NOT NULL,
    message text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    read_at timestamp with time zone,
    dedupe_key text
);

ALTER TABLE ONLY public.notifications FORCE ROW LEVEL SECURITY;


--
-- Name: outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    feed_code text NOT NULL,
    topic text NOT NULL,
    aggregate_id uuid NOT NULL,
    payload jsonb NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone NOT NULL,
    last_error text,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'delivered'::text, 'acknowledged'::text, 'failed'::text, 'dead'::text])))
);

ALTER TABLE ONLY public.outbox FORCE ROW LEVEL SECURITY;


--
-- Name: outbox_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    outbox_id uuid NOT NULL,
    attempted_at timestamp with time zone NOT NULL,
    result text NOT NULL,
    detail jsonb NOT NULL
);

ALTER TABLE ONLY public.outbox_attempts FORCE ROW LEVEL SECURITY;


--
-- Name: packages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.packages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    catalog_item_id uuid NOT NULL,
    gtin text NOT NULL,
    level text NOT NULL,
    units_per_package integer NOT NULL,
    uom text NOT NULL,
    source_system text,
    source_id text,
    import_batch_id uuid,
    CONSTRAINT packages_level_check CHECK ((level = ANY (ARRAY['each'::text, 'inner'::text, 'case'::text]))),
    CONSTRAINT packages_units_per_package_check CHECK ((units_per_package > 0))
);

ALTER TABLE ONLY public.packages FORCE ROW LEVEL SECURITY;


--
-- Name: parties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parties (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    source_system text,
    source_id text,
    CONSTRAINT parties_kind_check CHECK ((kind = ANY (ARRAY['distributor'::text, 'manufacturer'::text, 'hospital'::text])))
);

ALTER TABLE ONLY public.parties FORCE ROW LEVEL SECURITY;


--
-- Name: preference_card_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.preference_card_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    card_version_id uuid NOT NULL,
    catalog_item_id uuid NOT NULL,
    qty integer NOT NULL,
    mandatory boolean NOT NULL,
    backup_for_line_id uuid,
    note text,
    CONSTRAINT preference_card_lines_check CHECK ((NOT (mandatory AND (backup_for_line_id IS NOT NULL)))),
    CONSTRAINT preference_card_lines_qty_check CHECK ((qty > 0))
);

ALTER TABLE ONLY public.preference_card_lines FORCE ROW LEVEL SECURITY;


--
-- Name: preference_card_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.preference_card_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    card_id uuid NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    change_note text,
    CONSTRAINT preference_card_versions_check CHECK (((status = 'draft'::text) OR (approved_by IS NOT NULL))),
    CONSTRAINT preference_card_versions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text, 'superseded'::text])))
);

ALTER TABLE ONLY public.preference_card_versions FORCE ROW LEVEL SECURITY;


--
-- Name: preference_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.preference_cards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    code text NOT NULL,
    surgeon_ref text NOT NULL,
    procedure text NOT NULL
);

ALTER TABLE ONLY public.preference_cards FORCE ROW LEVEL SECURITY;


--
-- Name: purchase_order_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_order_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    po_id uuid NOT NULL,
    catalog_item_id uuid NOT NULL,
    qty integer NOT NULL,
    unit_price_cents integer NOT NULL
);

ALTER TABLE ONLY public.purchase_order_lines FORCE ROW LEVEL SECURITY;


--
-- Name: purchase_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    packet_id uuid NOT NULL,
    po_number text NOT NULL,
    entered_by uuid NOT NULL,
    entered_at timestamp with time zone NOT NULL,
    match_status text NOT NULL,
    match_detail jsonb NOT NULL,
    CONSTRAINT purchase_orders_match_status_check CHECK ((match_status = ANY (ARRAY['matched'::text, 'mismatch'::text])))
);

ALTER TABLE ONLY public.purchase_orders FORCE ROW LEVEL SECURITY;


--
-- Name: quality_holds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quality_holds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    stock_item_id uuid NOT NULL,
    recall_id uuid,
    reason text NOT NULL,
    status text NOT NULL,
    placed_by uuid NOT NULL,
    placed_at timestamp with time zone NOT NULL,
    released_by uuid,
    released_at timestamp with time zone,
    CONSTRAINT quality_holds_status_check CHECK ((status = ANY (ARRAY['active'::text, 'released'::text])))
);

ALTER TABLE ONLY public.quality_holds FORCE ROW LEVEL SECURITY;


--
-- Name: recall_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recall_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    recall_id uuid NOT NULL,
    task_type text NOT NULL,
    stock_item_id uuid,
    location_id uuid,
    case_id uuid,
    usage_event_id uuid,
    owner_user_id uuid,
    qty integer,
    status text NOT NULL,
    acknowledged_by uuid,
    acknowledged_at timestamp with time zone,
    disposition text,
    dispositioned_by uuid,
    dispositioned_at timestamp with time zone,
    detail text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT recall_tasks_status_check CHECK ((status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'quarantined'::text, 'dispositioned'::text, 'closed'::text]))),
    CONSTRAINT recall_tasks_task_type_check CHECK ((task_type = ANY (ARRAY['acknowledge_and_quarantine'::text, 'open_case_alert'::text, 'completed_case_trace'::text, 'late_usage_review'::text, 'return_in_transit'::text])))
);

ALTER TABLE ONLY public.recall_tasks FORCE ROW LEVEL SECURITY;


--
-- Name: recalls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recalls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    ref text NOT NULL,
    manufacturer_party_id uuid NOT NULL,
    catalog_item_id uuid NOT NULL,
    scope_type text NOT NULL,
    scope_values text[] NOT NULL,
    manufacturer_notice_ref text NOT NULL,
    description text NOT NULL,
    status text NOT NULL,
    entered_by uuid NOT NULL,
    entered_at timestamp with time zone NOT NULL,
    verified_by uuid,
    verified_at timestamp with time zone,
    activated_by uuid,
    activated_at timestamp with time zone,
    closed_by uuid,
    closed_at timestamp with time zone,
    closure_evidence text,
    CONSTRAINT recalls_check CHECK (((verified_by IS NULL) OR (verified_by <> entered_by))),
    CONSTRAINT recalls_scope_type_check CHECK ((scope_type = ANY (ARRAY['lot'::text, 'serial'::text]))),
    CONSTRAINT recalls_scope_values_check CHECK ((cardinality(scope_values) > 0)),
    CONSTRAINT recalls_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'verified'::text, 'active'::text, 'closed'::text])))
);

ALTER TABLE ONLY public.recalls FORCE ROW LEVEL SECURITY;


--
-- Name: release_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.release_decisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    case_id uuid NOT NULL,
    facility_id uuid NOT NULL,
    tray_stock_item_id uuid,
    decision text NOT NULL,
    evidence jsonb NOT NULL,
    statement text NOT NULL,
    recorded_by uuid NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    CONSTRAINT release_decisions_decision_check CHECK ((decision = ANY (ARRAY['released'::text, 'not_released'::text])))
);

ALTER TABLE ONLY public.release_decisions FORCE ROW LEVEL SECURITY;


--
-- Name: replenishments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.replenishments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    case_id uuid NOT NULL,
    usage_event_id uuid NOT NULL,
    catalog_item_id uuid,
    qty integer NOT NULL,
    action text NOT NULL,
    status text NOT NULL,
    rationale text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT replenishments_action_check CHECK ((action = ANY (ARRAY['replace'::text, 'none'::text, 'review'::text]))),
    CONSTRAINT replenishments_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text, 'not_required'::text, 'review'::text])))
);

ALTER TABLE ONLY public.replenishments FORCE ROW LEVEL SECURITY;


--
-- Name: reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    case_id uuid NOT NULL,
    requirement_id uuid,
    stock_item_id uuid NOT NULL,
    location_id uuid NOT NULL,
    owner_party_id uuid NOT NULL,
    qty integer NOT NULL,
    is_serial boolean NOT NULL,
    status text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    released_at timestamp with time zone,
    release_reason text,
    idempotency_key text,
    CONSTRAINT reservations_qty_check CHECK ((qty > 0)),
    CONSTRAINT reservations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'released'::text, 'consumed'::text])))
);

ALTER TABLE ONLY public.reservations FORCE ROW LEVEL SECURITY;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    token_hash text NOT NULL,
    user_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: shipment_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipment_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    shipment_id uuid NOT NULL,
    stock_item_id uuid NOT NULL,
    owner_party_id uuid NOT NULL,
    reservation_id uuid,
    qty_expected integer NOT NULL,
    qty_picked integer DEFAULT 0 NOT NULL,
    qty_dispatched integer DEFAULT 0 NOT NULL,
    qty_received integer DEFAULT 0 NOT NULL,
    received_condition text,
    CONSTRAINT shipment_lines_qty_expected_check CHECK ((qty_expected > 0))
);

ALTER TABLE ONLY public.shipment_lines FORCE ROW LEVEL SECURITY;


--
-- Name: shipments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    ref text NOT NULL,
    case_id uuid,
    from_location_id uuid NOT NULL,
    to_location_id uuid NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    courier_name text,
    due_by timestamp with time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    idempotency_key text,
    CONSTRAINT shipments_kind_check CHECK ((kind = ANY (ARRAY['case_delivery'::text, 'rescue_transfer'::text, 'replenishment'::text, 'return'::text]))),
    CONSTRAINT shipments_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'picked'::text, 'packed'::text, 'dispatched'::text, 'delivered'::text, 'received'::text, 'closed'::text, 'rejected'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.shipments FORCE ROW LEVEL SECURITY;


--
-- Name: stock_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_balances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    stock_item_id uuid NOT NULL,
    location_id uuid NOT NULL,
    owner_party_id uuid NOT NULL,
    condition text NOT NULL,
    qty integer NOT NULL,
    last_movement_id bigint,
    CONSTRAINT stock_balances_condition_check CHECK ((condition = ANY (ARRAY['sealed'::text, 'opened'::text, 'damaged'::text, 'used'::text]))),
    CONSTRAINT stock_balances_qty_check CHECK ((qty >= 0))
);

ALTER TABLE ONLY public.stock_balances FORCE ROW LEVEL SECURITY;


--
-- Name: stock_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    catalog_item_id uuid NOT NULL,
    lot_number text,
    serial_number text,
    expiry_date date,
    is_serial boolean NOT NULL,
    data_source text NOT NULL,
    import_batch_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stock_items_check CHECK ((is_serial = (serial_number IS NOT NULL))),
    CONSTRAINT stock_items_check1 CHECK (((serial_number IS NOT NULL) OR (lot_number IS NOT NULL))),
    CONSTRAINT stock_items_data_source_check CHECK ((data_source = ANY (ARRAY['label'::text, 'import'::text, 'reviewed_entry'::text, 'seed'::text])))
);

ALTER TABLE ONLY public.stock_items FORCE ROW LEVEL SECURITY;


--
-- Name: sync_differences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_differences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    feed_id uuid NOT NULL,
    entity text NOT NULL,
    entity_ref text NOT NULL,
    field text NOT NULL,
    our_value text,
    their_value text,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT sync_differences_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])))
);

ALTER TABLE ONLY public.sync_differences FORCE ROW LEVEL SECURITY;


--
-- Name: system_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_settings (
    key text NOT NULL,
    value jsonb NOT NULL
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: territories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.territories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL
);

ALTER TABLE ONLY public.territories FORCE ROW LEVEL SECURITY;


--
-- Name: travel_estimates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.travel_estimates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    from_location_id uuid NOT NULL,
    to_facility_id uuid NOT NULL,
    minutes integer NOT NULL,
    courier_cost_cents integer NOT NULL,
    basis text DEFAULT 'Seeded estimate (synthetic); not live traffic or courier quote'::text NOT NULL,
    CONSTRAINT travel_estimates_courier_cost_cents_check CHECK ((courier_cost_cents >= 0)),
    CONSTRAINT travel_estimates_minutes_check CHECK ((minutes > 0))
);

ALTER TABLE ONLY public.travel_estimates FORCE ROW LEVEL SECURITY;


--
-- Name: tray_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tray_instances (
    stock_item_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    manifest_version_id uuid NOT NULL
);

ALTER TABLE ONLY public.tray_instances FORCE ROW LEVEL SECURITY;


--
-- Name: tray_manifest_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tray_manifest_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    manifest_version_id uuid NOT NULL,
    catalog_item_id uuid NOT NULL,
    qty integer NOT NULL,
    required boolean DEFAULT true NOT NULL,
    CONSTRAINT tray_manifest_lines_qty_check CHECK ((qty > 0))
);

ALTER TABLE ONLY public.tray_manifest_lines FORCE ROW LEVEL SECURITY;


--
-- Name: tray_manifest_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tray_manifest_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    tray_catalog_item_id uuid NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    CONSTRAINT tray_manifest_versions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text, 'retired'::text])))
);

ALTER TABLE ONLY public.tray_manifest_versions FORCE ROW LEVEL SECURITY;


--
-- Name: tray_verification_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tray_verification_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    verification_id uuid NOT NULL,
    catalog_item_id uuid NOT NULL,
    expected_qty integer NOT NULL,
    actual_qty integer NOT NULL,
    required boolean NOT NULL,
    CONSTRAINT tray_verification_lines_actual_qty_check CHECK ((actual_qty >= 0))
);

ALTER TABLE ONLY public.tray_verification_lines FORCE ROW LEVEL SECURITY;


--
-- Name: tray_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tray_verifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    tray_stock_item_id uuid NOT NULL,
    manifest_version_id uuid NOT NULL,
    location_id uuid NOT NULL,
    shipment_id uuid,
    case_id uuid,
    seal_intact boolean NOT NULL,
    result text NOT NULL,
    verified_by uuid NOT NULL,
    verified_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    supersedes_id uuid,
    CONSTRAINT tray_verifications_result_check CHECK ((result = ANY (ARRAY['complete'::text, 'incomplete'::text])))
);

ALTER TABLE ONLY public.tray_verifications FORCE ROW LEVEL SECURITY;


--
-- Name: usage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    case_id uuid NOT NULL,
    client_event_id text NOT NULL,
    catalog_item_id uuid,
    stock_item_id uuid,
    disposition text NOT NULL,
    qty_units integer,
    reviewed_qty_units integer,
    package_gtin text,
    units_per_package integer,
    entry_method text NOT NULL,
    raw_scan text,
    scan_format text,
    parsed jsonb,
    status text NOT NULL,
    review_reason text,
    recorded_offline boolean DEFAULT false NOT NULL,
    actor_user_id uuid NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    CONSTRAINT usage_events_check CHECK (((status <> 'recorded'::text) OR (COALESCE(reviewed_qty_units, qty_units) IS NOT NULL))),
    CONSTRAINT usage_events_disposition_check CHECK ((disposition = ANY (ARRAY['implanted'::text, 'opened_unused'::text, 'wasted'::text, 'damaged'::text, 'returned_sealed'::text, 'missing'::text]))),
    CONSTRAINT usage_events_entry_method_check CHECK ((entry_method = ANY (ARRAY['scanner'::text, 'camera'::text, 'manual'::text, 'simulator'::text]))),
    CONSTRAINT usage_events_qty_units_check CHECK ((qty_units > 0)),
    CONSTRAINT usage_events_reviewed_qty_units_check CHECK ((reviewed_qty_units > 0)),
    CONSTRAINT usage_events_status_check CHECK ((status = ANY (ARRAY['recorded'::text, 'needs_review'::text, 'rejected'::text])))
);

ALTER TABLE ONLY public.usage_events FORCE ROW LEVEL SECURITY;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    email text NOT NULL,
    display_name text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL,
    facility_id uuid,
    territory_id uuid,
    phone_hint text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_check CHECK (((role = ANY (ARRAY['hospital_receiving'::text, 'hospital_spd'::text])) = (facility_id IS NOT NULL))),
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'ops_manager'::text, 'inventory_coordinator'::text, 'scheduler'::text, 'rep'::text, 'warehouse'::text, 'courier'::text, 'hospital_receiving'::text, 'hospital_spd'::text, 'finance'::text, 'quality_manager'::text])))
);


--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);


--
-- Name: inventory_movements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements ALTER COLUMN id SET DEFAULT nextval('public.inventory_movements_id_seq'::regclass);


--
-- Data for Name: audit_log; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.audit_log (id, tenant_id, actor_user_id, action, entity, entity_id, case_id, occurred_at, recorded_at, db_created_at, reason, data) FROM stdin;
1	82057f54-4730-4d4a-a86c-16c71dfc5380	96730663-96b5-4d44-919e-f3965640e7a4	import.commit	import_batch	78ba81ba-749c-455c-b70d-bfaf096c90b1	\N	2026-10-12 14:00:00.032+00	2026-10-12 14:00:00.032+00	2026-11-21 21:32:14.778297+00	\N	{"kind": "catalog", "counts": {"accepted": 12}, "filename": "northpoint_catalog_synthetic.csv", "source_system": "NORTHPOINT-PRICEFILE-SIM"}
2	82057f54-4730-4d4a-a86c-16c71dfc5380	96730663-96b5-4d44-919e-f3965640e7a4	import.commit	import_batch	6db9fc8f-8ef6-4982-be8a-c2bac8f4c2d2	\N	2026-10-12 14:00:00.041+00	2026-10-12 14:00:00.041+00	2026-11-21 21:32:14.810453+00	\N	{"kind": "packages", "counts": {"accepted": 1}, "filename": "northpoint_packages_synthetic.csv", "source_system": "NORTHPOINT-PRICEFILE-SIM"}
3	82057f54-4730-4d4a-a86c-16c71dfc5380	96730663-96b5-4d44-919e-f3965640e7a4	import.commit	import_batch	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	2026-10-12 14:00:00.134+00	2026-10-12 14:00:00.134+00	2026-11-21 21:32:14.819048+00	\N	{"kind": "opening_balances", "counts": {"accepted": 26}, "filename": "opening_balances_synthetic.csv", "source_system": "LEGACY-SPREADSHEET-SIM"}
4	82057f54-4730-4d4a-a86c-16c71dfc5380	08a0e020-5111-4efb-896a-155198f3da03	case.create	case	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-10-29 10:30:00.006+00	2026-10-29 10:30:00.006+00	2026-11-21 21:32:14.947204+00	\N	{"case_ref": "SYN-0901", "card_version": 2, "scheduled_start": "2026-10-31T12:30:00.000Z"}
5	82057f54-4730-4d4a-a86c-16c71dfc5380	9bd9ad2b-2664-4d61-ad81-b028e87a533f	shipment.plan	shipment	703b7074-b14c-4d0a-88b6-44158a7fd5f0	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-10-29 10:30:00.039+00	2026-10-29 10:30:00.039+00	2026-11-21 21:32:14.954558+00	\N	{"ref": "SHP-5001", "lines": 4}
6	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.pick	shipment_line	a3c9c49b-ace4-40d8-b46e-54e54a2a1b91	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-10-30 14:30:00.01+00	2026-10-30 14:30:00.01+00	2026-11-21 21:32:14.987753+00	\N	{"qty": 1}
7	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.pick	shipment_line	55935304-8aef-4173-a184-db46111f6f24	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-10-30 14:30:00.019+00	2026-10-30 14:30:00.019+00	2026-11-21 21:32:14.987753+00	\N	{"qty": 1}
8	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.pick	shipment_line	340f2eff-2bb3-49df-8ffa-d2465dd23ddd	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-10-30 14:30:00.031+00	2026-10-30 14:30:00.031+00	2026-11-21 21:32:14.987753+00	\N	{"qty": 1}
9	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.pick	shipment_line	c3b6a19d-ffb2-486e-9ac3-9ade2b50ac64	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-10-30 14:30:00.042+00	2026-10-30 14:30:00.042+00	2026-11-21 21:32:14.987753+00	\N	{"qty": 1}
10	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.dispatch	shipment	703b7074-b14c-4d0a-88b6-44158a7fd5f0	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-10-30 14:30:00.073+00	2026-10-30 14:30:00.073+00	2026-11-21 21:32:14.987753+00	\N	{"ref": "SHP-5001", "partial": false}
11	82057f54-4730-4d4a-a86c-16c71dfc5380	37edafe9-7c57-4171-8bb7-83f26e1f740f	shipment.delivered	shipment	703b7074-b14c-4d0a-88b6-44158a7fd5f0	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-10-30 16:30:00.006+00	2026-10-30 16:30:00.006+00	2026-11-21 21:32:15.070125+00	\N	{}
12	82057f54-4730-4d4a-a86c-16c71dfc5380	ff8b05fb-2d7a-42af-9046-444b2c57f169	shipment.receive	shipment	703b7074-b14c-4d0a-88b6-44158a7fd5f0	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-10-30 17:00:00.016+00	2026-10-30 17:00:00.016+00	2026-11-21 21:32:15.080516+00	\N	{"issues": 0, "complete": true}
13	82057f54-4730-4d4a-a86c-16c71dfc5380	ff8b05fb-2d7a-42af-9046-444b2c57f169	tray.verify	tray	6347b29f-96e5-4886-ac37-66af7c072957	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-10-30 17:00:00.033+00	2026-10-30 17:00:00.033+00	2026-11-21 21:32:15.101787+00	\N	{"result": "complete", "missing": [], "manifest_version": 2}
14	82057f54-4730-4d4a-a86c-16c71dfc5380	703a5c38-b16a-4fa9-bef8-4381b8b2160d	hospital.release_decision	release_decision	92739e72-021a-4c8c-b73f-41de55592375	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-10-30 19:30:00.005+00	2026-10-30 19:30:00.005+00	2026-11-21 21:32:15.115225+00	\N	{"decision": "released", "policy_version": 3}
15	82057f54-4730-4d4a-a86c-16c71dfc5380	ff8b05fb-2d7a-42af-9046-444b2c57f169	shipment.close	shipment	703b7074-b14c-4d0a-88b6-44158a7fd5f0	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-10-30 19:30:00.01+00	2026-10-30 19:30:00.01+00	2026-11-21 21:32:15.115225+00	\N	{}
16	82057f54-4730-4d4a-a86c-16c71dfc5380	679a78ec-76fe-4700-b459-b9f4d0c6dda2	usage.record	usage_event	d13b84c1-a8b8-41ed-9f2e-87b40c9ec823	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-10-31 15:30:00.003+00	2026-10-31 15:30:00.006+00	2026-11-21 21:32:15.130778+00	\N	{"review": [], "status": "recorded", "disposition": "implanted", "raw_scan_present": true}
17	82057f54-4730-4d4a-a86c-16c71dfc5380	679a78ec-76fe-4700-b459-b9f4d0c6dda2	usage.record	usage_event	d646f2ed-d67a-4019-88e5-27e5ff405706	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-10-31 15:30:00.017+00	2026-10-31 15:30:00.02+00	2026-11-21 21:32:15.130778+00	\N	{"review": [], "status": "recorded", "disposition": "implanted", "raw_scan_present": true}
18	82057f54-4730-4d4a-a86c-16c71dfc5380	679a78ec-76fe-4700-b459-b9f4d0c6dda2	usage.record	usage_event	7f774264-ce43-41d3-be09-c017e47d47f2	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-10-31 15:30:00.029+00	2026-10-31 15:30:00.031+00	2026-11-21 21:32:15.130778+00	\N	{"review": [], "status": "recorded", "disposition": "implanted", "raw_scan_present": true}
19	82057f54-4730-4d4a-a86c-16c71dfc5380	679a78ec-76fe-4700-b459-b9f4d0c6dda2	closeout.submit	case	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-10-31 15:54:00.007+00	2026-10-31 15:54:00.007+00	2026-11-21 21:32:15.168737+00	\N	{"pending_review": 0}
20	82057f54-4730-4d4a-a86c-16c71dfc5380	ca201980-0055-472e-aa6d-b430c55ce512	packet.generate	billing_packet	4a429300-39fb-4777-af50-9274c23f229e	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-11-01 14:30:00.004+00	2026-11-01 14:30:00.004+00	2026-11-21 21:32:15.178447+00	\N	{"type": "bill_and_replace", "lines": 3}
21	82057f54-4730-4d4a-a86c-16c71dfc5380	ca201980-0055-472e-aa6d-b430c55ce512	packet.queue_erp	billing_packet	4a429300-39fb-4777-af50-9274c23f229e	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-11-01 14:30:00.012+00	2026-11-01 14:30:00.012+00	2026-11-21 21:32:15.182804+00	\N	{}
22	82057f54-4730-4d4a-a86c-16c71dfc5380	\N	erp.ack	outbox	35fa49f6-4e98-4fc4-8fa7-2e8761de928b	\N	2026-11-01 14:30:00.016+00	2026-11-01 14:30:00.016+00	2026-11-21 21:32:15.19087+00	\N	{"ack_type": "received", "simulated": true, "external_doc_ref": "SIM-ERP-A670C05DDE"}
23	82057f54-4730-4d4a-a86c-16c71dfc5380	ca201980-0055-472e-aa6d-b430c55ce512	po.enter	purchase_order	03d097db-7ce4-43ce-9fac-f81e9a24f283	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-11-04 12:30:00.005+00	2026-11-04 12:30:00.005+00	2026-11-21 21:32:15.19636+00	\N	{"issues": [], "status": "matched"}
24	82057f54-4730-4d4a-a86c-16c71dfc5380	ca201980-0055-472e-aa6d-b430c55ce512	packet.accept	billing_packet	4a429300-39fb-4777-af50-9274c23f229e	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	2026-11-04 12:30:00.008+00	2026-11-04 12:30:00.008+00	2026-11-21 21:32:15.19636+00	\N	{"customer_reference": "SYN-AP-ACK-1"}
25	82057f54-4730-4d4a-a86c-16c71dfc5380	08a0e020-5111-4efb-896a-155198f3da03	case.create	case	555a2002-df45-4f75-a01c-a237a8347b4c	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-07 11:30:00.004+00	2026-11-07 11:30:00.004+00	2026-11-21 21:32:15.205679+00	\N	{"case_ref": "SYN-0902", "card_version": 2, "scheduled_start": "2026-11-09T13:30:00.000Z"}
26	82057f54-4730-4d4a-a86c-16c71dfc5380	9bd9ad2b-2664-4d61-ad81-b028e87a533f	shipment.plan	shipment	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-07 11:30:00.022+00	2026-11-07 11:30:00.022+00	2026-11-21 21:32:15.20962+00	\N	{"ref": "SHP-5002", "lines": 4}
27	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.pick	shipment_line	40f6bf06-8e0b-42e3-a2b2-9d11d188af07	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-09 02:30:00.006+00	2026-11-09 02:30:00.006+00	2026-11-21 21:32:15.228427+00	\N	{"qty": 1}
28	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.pick	shipment_line	ac7d491f-1bd0-417d-af69-d9a701b3f162	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-09 02:30:00.011+00	2026-11-09 02:30:00.011+00	2026-11-21 21:32:15.228427+00	\N	{"qty": 1}
29	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.pick	shipment_line	d0ee40b8-b3f6-456b-944d-8af5260c6fa7	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-09 02:30:00.016+00	2026-11-09 02:30:00.016+00	2026-11-21 21:32:15.228427+00	\N	{"qty": 1}
30	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.pick	shipment_line	f61daaec-ffb8-4994-81c1-fce511c8f45e	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-09 02:30:00.021+00	2026-11-09 02:30:00.021+00	2026-11-21 21:32:15.228427+00	\N	{"qty": 1}
31	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.dispatch	shipment	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-09 02:30:00.038+00	2026-11-09 02:30:00.038+00	2026-11-21 21:32:15.228427+00	\N	{"ref": "SHP-5002", "partial": false}
32	82057f54-4730-4d4a-a86c-16c71dfc5380	37edafe9-7c57-4171-8bb7-83f26e1f740f	shipment.delivered	shipment	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-09 04:30:00.003+00	2026-11-09 04:30:00.003+00	2026-11-21 21:32:15.270779+00	\N	{}
33	82057f54-4730-4d4a-a86c-16c71dfc5380	ff8b05fb-2d7a-42af-9046-444b2c57f169	shipment.receive	shipment	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-09 05:00:00.015+00	2026-11-09 05:00:00.015+00	2026-11-21 21:32:15.280055+00	\N	{"issues": 0, "complete": true}
34	82057f54-4730-4d4a-a86c-16c71dfc5380	ff8b05fb-2d7a-42af-9046-444b2c57f169	tray.verify	tray	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-09 05:00:00.025+00	2026-11-09 05:00:00.025+00	2026-11-21 21:32:15.299753+00	\N	{"result": "complete", "missing": [], "manifest_version": 2}
35	82057f54-4730-4d4a-a86c-16c71dfc5380	703a5c38-b16a-4fa9-bef8-4381b8b2160d	hospital.release_decision	release_decision	baeff7b1-c949-44b3-9741-334b6bbdc820	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-09 07:30:00.003+00	2026-11-09 07:30:00.003+00	2026-11-21 21:32:15.306361+00	\N	{"decision": "released", "policy_version": 3}
36	82057f54-4730-4d4a-a86c-16c71dfc5380	ff8b05fb-2d7a-42af-9046-444b2c57f169	shipment.close	shipment	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-09 07:30:00.005+00	2026-11-09 07:30:00.005+00	2026-11-21 21:32:15.306361+00	\N	{}
37	82057f54-4730-4d4a-a86c-16c71dfc5380	679a78ec-76fe-4700-b459-b9f4d0c6dda2	usage.record	usage_event	ef38dd1e-1795-408b-857c-c4d10c30d45d	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-09 16:30:00.003+00	2026-11-09 16:30:00.005+00	2026-11-21 21:32:15.31639+00	\N	{"review": [], "status": "recorded", "disposition": "implanted", "raw_scan_present": true}
38	82057f54-4730-4d4a-a86c-16c71dfc5380	679a78ec-76fe-4700-b459-b9f4d0c6dda2	usage.record	usage_event	5c6dbf1d-3171-4ab7-8a0e-108f3ab8c170	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-09 16:30:00.014+00	2026-11-09 16:30:00.016+00	2026-11-21 21:32:15.31639+00	\N	{"review": [], "status": "recorded", "disposition": "implanted", "raw_scan_present": true}
39	82057f54-4730-4d4a-a86c-16c71dfc5380	679a78ec-76fe-4700-b459-b9f4d0c6dda2	usage.record	usage_event	e26cebb0-5047-4dec-b57f-9d1f991b7e2f	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-09 16:30:00.023+00	2026-11-09 16:30:00.025+00	2026-11-21 21:32:15.31639+00	\N	{"review": [], "status": "recorded", "disposition": "implanted", "raw_scan_present": true}
40	82057f54-4730-4d4a-a86c-16c71dfc5380	679a78ec-76fe-4700-b459-b9f4d0c6dda2	closeout.submit	case	555a2002-df45-4f75-a01c-a237a8347b4c	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-09 16:54:00.004+00	2026-11-09 16:54:00.004+00	2026-11-21 21:32:15.348687+00	\N	{"pending_review": 0}
41	82057f54-4730-4d4a-a86c-16c71dfc5380	ca201980-0055-472e-aa6d-b430c55ce512	packet.generate	billing_packet	fa4a17bb-a68d-49bf-a794-ee91e6c1a2cf	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-10 15:30:00.002+00	2026-11-10 15:30:00.002+00	2026-11-21 21:32:15.353869+00	\N	{"type": "bill_and_replace", "lines": 3}
42	82057f54-4730-4d4a-a86c-16c71dfc5380	ca201980-0055-472e-aa6d-b430c55ce512	packet.queue_erp	billing_packet	fa4a17bb-a68d-49bf-a794-ee91e6c1a2cf	555a2002-df45-4f75-a01c-a237a8347b4c	2026-11-10 15:30:00.01+00	2026-11-10 15:30:00.01+00	2026-11-21 21:32:15.358658+00	\N	{}
43	82057f54-4730-4d4a-a86c-16c71dfc5380	\N	erp.ack	outbox	db096e8e-0b0d-4601-bf8f-2842261f39de	\N	2026-11-10 15:30:00.014+00	2026-11-10 15:30:00.014+00	2026-11-21 21:32:15.365074+00	\N	{"ack_type": "received", "simulated": true, "external_doc_ref": "SIM-ERP-331EAFF88D"}
44	82057f54-4730-4d4a-a86c-16c71dfc5380	08a0e020-5111-4efb-896a-155198f3da03	case.create	case	964622f1-c4fa-4547-8b0a-2b8334c6d297	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-13 10:30:00.004+00	2026-11-13 10:30:00.004+00	2026-11-21 21:32:15.369834+00	\N	{"case_ref": "SYN-0903", "card_version": 2, "scheduled_start": "2026-11-15T12:30:00.000Z"}
45	82057f54-4730-4d4a-a86c-16c71dfc5380	9bd9ad2b-2664-4d61-ad81-b028e87a533f	shipment.plan	shipment	e6528bef-e34f-4551-9e97-204bee72d399	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-13 10:30:00.018+00	2026-11-13 10:30:00.018+00	2026-11-21 21:32:15.373226+00	\N	{"ref": "SHP-5003", "lines": 3}
46	82057f54-4730-4d4a-a86c-16c71dfc5380	9bd9ad2b-2664-4d61-ad81-b028e87a533f	shipment.plan	shipment	c5c70cc5-9c4d-451a-8b3f-f7339eb110ff	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-13 10:30:00.019+00	2026-11-13 10:30:00.019+00	2026-11-21 21:32:15.373226+00	\N	{"ref": "SHP-5004", "lines": 1}
47	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.pick	shipment_line	d3de0e17-3a38-41bc-a256-ff4ff04cebe7	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-14 04:30:00.006+00	2026-11-14 04:30:00.006+00	2026-11-21 21:32:15.390714+00	\N	{"qty": 1}
48	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.pick	shipment_line	caf2b859-288a-41db-bac2-556aca6c047d	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-14 04:30:00.013+00	2026-11-14 04:30:00.013+00	2026-11-21 21:32:15.390714+00	\N	{"qty": 1}
49	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.pick	shipment_line	78328bf8-3046-44e7-bf2a-bea06474784e	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-14 04:30:00.019+00	2026-11-14 04:30:00.019+00	2026-11-21 21:32:15.390714+00	\N	{"qty": 1}
50	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.dispatch	shipment	e6528bef-e34f-4551-9e97-204bee72d399	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-14 04:30:00.039+00	2026-11-14 04:30:00.039+00	2026-11-21 21:32:15.390714+00	\N	{"ref": "SHP-5003", "partial": false}
51	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.pick	shipment_line	d32c71a0-96e7-4b09-bd22-fea9dd5d7077	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-14 04:30:00.053+00	2026-11-14 04:30:00.053+00	2026-11-21 21:32:15.433938+00	\N	{"qty": 1}
52	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.dispatch	shipment	c5c70cc5-9c4d-451a-8b3f-f7339eb110ff	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-14 04:30:00.07+00	2026-11-14 04:30:00.07+00	2026-11-21 21:32:15.433938+00	\N	{"ref": "SHP-5004", "partial": false}
53	82057f54-4730-4d4a-a86c-16c71dfc5380	37edafe9-7c57-4171-8bb7-83f26e1f740f	shipment.delivered	shipment	e6528bef-e34f-4551-9e97-204bee72d399	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-14 06:30:00.004+00	2026-11-14 06:30:00.004+00	2026-11-21 21:32:15.465255+00	\N	{}
54	82057f54-4730-4d4a-a86c-16c71dfc5380	37edafe9-7c57-4171-8bb7-83f26e1f740f	shipment.delivered	shipment	c5c70cc5-9c4d-451a-8b3f-f7339eb110ff	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-14 06:30:00.012+00	2026-11-14 06:30:00.012+00	2026-11-21 21:32:15.474649+00	\N	{}
55	82057f54-4730-4d4a-a86c-16c71dfc5380	79fe508f-120a-412e-9736-0cf2c80e484e	shipment.receive	shipment	e6528bef-e34f-4551-9e97-204bee72d399	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-14 07:00:00.01+00	2026-11-14 07:00:00.01+00	2026-11-21 21:32:15.483701+00	\N	{"issues": 0, "complete": true}
56	82057f54-4730-4d4a-a86c-16c71dfc5380	79fe508f-120a-412e-9736-0cf2c80e484e	shipment.receive	shipment	c5c70cc5-9c4d-451a-8b3f-f7339eb110ff	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-14 07:00:00.02+00	2026-11-14 07:00:00.02+00	2026-11-21 21:32:15.495452+00	\N	{"issues": 0, "complete": true}
57	82057f54-4730-4d4a-a86c-16c71dfc5380	79fe508f-120a-412e-9736-0cf2c80e484e	tray.verify	tray	6347b29f-96e5-4886-ac37-66af7c072957	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-14 07:00:00.032+00	2026-11-14 07:00:00.032+00	2026-11-21 21:32:15.508271+00	\N	{"result": "complete", "missing": [], "manifest_version": 2}
58	82057f54-4730-4d4a-a86c-16c71dfc5380	4cc78ada-2732-4d58-b120-2e69660af354	hospital.release_decision	release_decision	aba7b87a-ab5d-469e-9853-f6d3220d4a94	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-14 09:30:00.002+00	2026-11-14 09:30:00.002+00	2026-11-21 21:32:15.516205+00	\N	{"decision": "released", "policy_version": 1}
59	82057f54-4730-4d4a-a86c-16c71dfc5380	79fe508f-120a-412e-9736-0cf2c80e484e	shipment.close	shipment	e6528bef-e34f-4551-9e97-204bee72d399	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-14 09:30:00.004+00	2026-11-14 09:30:00.004+00	2026-11-21 21:32:15.516205+00	\N	{}
60	82057f54-4730-4d4a-a86c-16c71dfc5380	79fe508f-120a-412e-9736-0cf2c80e484e	shipment.close	shipment	c5c70cc5-9c4d-451a-8b3f-f7339eb110ff	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-14 09:30:00.008+00	2026-11-14 09:30:00.008+00	2026-11-21 21:32:15.516205+00	\N	{}
61	82057f54-4730-4d4a-a86c-16c71dfc5380	cee93967-cedb-4428-87c4-e090c376edf7	usage.record	usage_event	991ae806-5429-4fc1-8a43-0f5c7bee747e	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-15 15:30:00.002+00	2026-11-15 15:30:00.003+00	2026-11-21 21:32:15.529599+00	\N	{"review": [], "status": "recorded", "disposition": "implanted", "raw_scan_present": true}
62	82057f54-4730-4d4a-a86c-16c71dfc5380	cee93967-cedb-4428-87c4-e090c376edf7	usage.record	usage_event	3a597841-ea78-47f5-b5dd-46f98a8f4d22	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-15 15:30:00.009+00	2026-11-15 15:30:00.01+00	2026-11-21 21:32:15.529599+00	\N	{"review": [], "status": "recorded", "disposition": "implanted", "raw_scan_present": true}
63	82057f54-4730-4d4a-a86c-16c71dfc5380	cee93967-cedb-4428-87c4-e090c376edf7	usage.record	usage_event	27f5b7e7-e6f5-4434-9b0f-7a0806ec0791	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-15 15:30:00.015+00	2026-11-15 15:30:00.016+00	2026-11-21 21:32:15.529599+00	\N	{"review": [], "status": "recorded", "disposition": "implanted", "raw_scan_present": true}
64	82057f54-4730-4d4a-a86c-16c71dfc5380	cee93967-cedb-4428-87c4-e090c376edf7	closeout.submit	case	964622f1-c4fa-4547-8b0a-2b8334c6d297	964622f1-c4fa-4547-8b0a-2b8334c6d297	2026-11-15 15:54:00.003+00	2026-11-15 15:54:00.003+00	2026-11-21 21:32:15.553884+00	\N	{"pending_review": 0}
65	82057f54-4730-4d4a-a86c-16c71dfc5380	9bd9ad2b-2664-4d61-ad81-b028e87a533f	shipment.create	shipment	74c82176-4d43-4aae-9cdd-298a7990fd8d	\N	2026-11-18 21:00:00.003+00	2026-11-18 21:00:00.003+00	2026-11-21 21:32:15.558274+00	\N	{"ref": "RTN-5005", "kind": "return", "note": "Loaner tray return after case"}
66	82057f54-4730-4d4a-a86c-16c71dfc5380	9bd9ad2b-2664-4d61-ad81-b028e87a533f	shipment.pick	shipment_line	4c2cef40-4ad6-4b2d-a421-163c6cf1e48f	\N	2026-11-18 21:00:00.01+00	2026-11-18 21:00:00.01+00	2026-11-21 21:32:15.558274+00	\N	{"qty": 1}
67	82057f54-4730-4d4a-a86c-16c71dfc5380	9bd9ad2b-2664-4d61-ad81-b028e87a533f	shipment.dispatch	shipment	74c82176-4d43-4aae-9cdd-298a7990fd8d	\N	2026-11-18 21:00:00.019+00	2026-11-18 21:00:00.019+00	2026-11-21 21:32:15.558274+00	\N	{"ref": "RTN-5005", "partial": false}
68	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.receive	shipment	74c82176-4d43-4aae-9cdd-298a7990fd8d	\N	2026-11-18 21:00:00.033+00	2026-11-18 21:00:00.033+00	2026-11-21 21:32:15.581689+00	\N	{"issues": 0, "complete": true}
69	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	tray.verify	tray	6347b29f-96e5-4886-ac37-66af7c072957	\N	2026-11-18 21:00:00.044+00	2026-11-18 21:00:00.044+00	2026-11-21 21:32:15.581689+00	\N	{"result": "complete", "missing": [], "manifest_version": 2}
70	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.close	shipment	74c82176-4d43-4aae-9cdd-298a7990fd8d	\N	2026-11-18 21:00:00.046+00	2026-11-18 21:00:00.046+00	2026-11-21 21:32:15.581689+00	\N	{}
71	82057f54-4730-4d4a-a86c-16c71dfc5380	9bd9ad2b-2664-4d61-ad81-b028e87a533f	shipment.create	shipment	d5df80c0-93e8-4961-a305-fd5d1f1c266f	\N	2026-11-18 21:00:00.002+00	2026-11-18 21:00:00.002+00	2026-11-21 21:32:15.608597+00	\N	{"ref": "RTN-5006", "kind": "return", "note": "Loaner tray return after case"}
72	82057f54-4730-4d4a-a86c-16c71dfc5380	9bd9ad2b-2664-4d61-ad81-b028e87a533f	shipment.pick	shipment_line	53846dd2-3313-44ab-bdf3-167b8466c28f	\N	2026-11-18 21:00:00.012+00	2026-11-18 21:00:00.012+00	2026-11-21 21:32:15.608597+00	\N	{"qty": 1}
73	82057f54-4730-4d4a-a86c-16c71dfc5380	9bd9ad2b-2664-4d61-ad81-b028e87a533f	shipment.dispatch	shipment	d5df80c0-93e8-4961-a305-fd5d1f1c266f	\N	2026-11-18 21:00:00.021+00	2026-11-18 21:00:00.021+00	2026-11-21 21:32:15.608597+00	\N	{"ref": "RTN-5006", "partial": false}
74	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.receive	shipment	d5df80c0-93e8-4961-a305-fd5d1f1c266f	\N	2026-11-18 21:00:00.033+00	2026-11-18 21:00:00.033+00	2026-11-21 21:32:15.632501+00	\N	{"issues": 0, "complete": true}
75	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	tray.verify	tray	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	\N	2026-11-18 21:00:00.042+00	2026-11-18 21:00:00.042+00	2026-11-21 21:32:15.632501+00	\N	{"result": "complete", "missing": [], "manifest_version": 2}
76	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	shipment.close	shipment	d5df80c0-93e8-4961-a305-fd5d1f1c266f	\N	2026-11-18 21:00:00.043+00	2026-11-18 21:00:00.043+00	2026-11-21 21:32:15.632501+00	\N	{}
77	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	count.start	count_session	8b29aef8-56de-490a-994d-2ae306d55fdd	\N	2026-11-16 16:00:00.003+00	2026-11-16 16:00:00.003+00	2026-11-21 21:32:15.656794+00	\N	{"location": "WH-MAIN"}
78	82057f54-4730-4d4a-a86c-16c71dfc5380	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	count.submit	count_session	8b29aef8-56de-490a-994d-2ae306d55fdd	\N	2026-11-16 16:00:00.036+00	2026-11-16 16:00:00.036+00	2026-11-21 21:32:15.656794+00	\N	{"variances": 1}
79	82057f54-4730-4d4a-a86c-16c71dfc5380	96730663-96b5-4d44-919e-f3965640e7a4	count.approve	count_session	8b29aef8-56de-490a-994d-2ae306d55fdd	\N	2026-11-16 16:00:00.044+00	2026-11-16 16:00:00.044+00	2026-11-21 21:32:15.656794+00	Recount confirmed 19 screws; one unit unaccounted (synthetic)	{}
80	82057f54-4730-4d4a-a86c-16c71dfc5380	08a0e020-5111-4efb-896a-155198f3da03	case.create	case	ef2f1403-819a-4666-9d27-319fe05abcb4	ef2f1403-819a-4666-9d27-319fe05abcb4	2026-11-20 12:00:00.006+00	2026-11-20 12:00:00.006+00	2026-11-21 21:32:15.707926+00	\N	{"case_ref": "SYN-1003", "card_version": 2, "scheduled_start": "2026-11-24T16:00:00.000Z"}
81	82057f54-4730-4d4a-a86c-16c71dfc5380	08a0e020-5111-4efb-896a-155198f3da03	case.create	case	bc5e78aa-c3bc-485a-b1e9-128710ceefe2	bc5e78aa-c3bc-485a-b1e9-128710ceefe2	2026-11-20 12:00:00.013+00	2026-11-20 12:00:00.013+00	2026-11-21 21:32:15.715992+00	\N	{"case_ref": "SYN-1001", "card_version": 2, "scheduled_start": "2026-11-22T13:30:00.000Z"}
82	82057f54-4730-4d4a-a86c-16c71dfc5380	08a0e020-5111-4efb-896a-155198f3da03	case.create	case	a1debd32-5f14-4fbd-9b06-bfd21d0192cc	a1debd32-5f14-4fbd-9b06-bfd21d0192cc	2026-11-20 12:00:00.029+00	2026-11-20 12:00:00.029+00	2026-11-21 21:32:15.73157+00	\N	{"case_ref": "SYN-1002", "card_version": 2, "scheduled_start": "2026-11-22T18:00:00.000Z"}
\.


--
-- Data for Name: billing_packets; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.billing_packets (id, tenant_id, case_id, packet_type, status, created_by, created_at, accepted_at, accepted_by) FROM stdin;
4a429300-39fb-4777-af50-9274c23f229e	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	bill_and_replace	accepted	ca201980-0055-472e-aa6d-b430c55ce512	2026-11-01 14:30:00.003+00	2026-11-04 12:30:00.007+00	ca201980-0055-472e-aa6d-b430c55ce512
fa4a17bb-a68d-49bf-a794-ee91e6c1a2cf	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	bill_and_replace	erp_received_simulated	ca201980-0055-472e-aa6d-b430c55ce512	2026-11-10 15:30:00.001+00	\N	\N
\.


--
-- Data for Name: case_requirements; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.case_requirements (id, tenant_id, case_id, catalog_item_id, qty, mandatory, source_card_line_id, active) FROM stdin;
6a56b0d2-0cca-4899-82fb-5062f808b4d1	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	1	t	4b90eb1c-0120-41aa-8f7b-ada09a6b490d	t
0b3f527f-848c-4f35-9716-c9f8da3ab176	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	7d11617a-4813-4b5c-90f0-19626f5db56f	1	t	637af985-62c1-4371-ac26-94750b20c8fc	t
456278a9-82a2-47dc-975e-c6dffe575d01	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	1	t	195f15a8-5f37-4df4-b9d9-84fcbbba7443	t
c34966c1-81b7-4a7a-8e9b-b6365919ef1d	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	b3c5ddcf-836f-4ccd-9f35-22d68099e076	1	t	727f1293-911b-4275-aa59-7d40ac16d23f	t
243bdeb5-aa1c-4b98-9bcc-3f644aa820f4	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	d4bf7ed4-74a1-41d5-9480-5748c241727e	1	f	10762058-8eef-4dc6-ba99-f90bca11e784	t
20f5659e-337c-48ab-85e2-2b4ddd5cbca1	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	f4e893f7-831e-40dd-89ce-1f79e2c1c9b0	1	f	4bdcba2b-927a-4398-9a32-4427c3adc310	t
a49b689c-2bb1-4983-83ad-d3a49fd04928	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	1	t	4b90eb1c-0120-41aa-8f7b-ada09a6b490d	t
2777fa29-6d84-4583-8be2-20496897652a	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	7d11617a-4813-4b5c-90f0-19626f5db56f	1	t	637af985-62c1-4371-ac26-94750b20c8fc	t
be4aceec-c686-4f15-b895-3dfdfbddbbb2	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	1	t	195f15a8-5f37-4df4-b9d9-84fcbbba7443	t
f81d4690-f3fe-4b07-8238-a7d315fee27a	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	b3c5ddcf-836f-4ccd-9f35-22d68099e076	1	t	727f1293-911b-4275-aa59-7d40ac16d23f	t
6d2a7b70-391c-4c9d-8352-669b209dfd10	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	d4bf7ed4-74a1-41d5-9480-5748c241727e	1	f	10762058-8eef-4dc6-ba99-f90bca11e784	t
e1e7bc8c-a3b8-41a6-a4d0-d0ac68c10195	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	f4e893f7-831e-40dd-89ce-1f79e2c1c9b0	1	f	4bdcba2b-927a-4398-9a32-4427c3adc310	t
76b1e4c0-35f1-40ad-97ad-f48e721f1f88	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	1	t	4b90eb1c-0120-41aa-8f7b-ada09a6b490d	t
1105906a-0adf-4d90-83da-5130e743c8bd	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	7d11617a-4813-4b5c-90f0-19626f5db56f	1	t	637af985-62c1-4371-ac26-94750b20c8fc	t
0f1540ed-1426-4eb3-8d70-3ef62b4ae975	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	1	t	195f15a8-5f37-4df4-b9d9-84fcbbba7443	t
704b9c60-08a2-4b9b-91d5-8dee1cc990dc	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	b3c5ddcf-836f-4ccd-9f35-22d68099e076	1	t	727f1293-911b-4275-aa59-7d40ac16d23f	t
ad2a9a5e-8907-4c07-a79d-207aa4e652e3	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	d4bf7ed4-74a1-41d5-9480-5748c241727e	1	f	10762058-8eef-4dc6-ba99-f90bca11e784	t
8e017ff7-6ade-4dba-a6c5-68d83eccfb96	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	f4e893f7-831e-40dd-89ce-1f79e2c1c9b0	1	f	4bdcba2b-927a-4398-9a32-4427c3adc310	t
b1cdf81e-0856-4ade-8492-bee8f371cd45	82057f54-4730-4d4a-a86c-16c71dfc5380	ef2f1403-819a-4666-9d27-319fe05abcb4	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	1	t	4b90eb1c-0120-41aa-8f7b-ada09a6b490d	t
e2fbb5ac-ad50-4157-980c-218e0b95602e	82057f54-4730-4d4a-a86c-16c71dfc5380	ef2f1403-819a-4666-9d27-319fe05abcb4	7d11617a-4813-4b5c-90f0-19626f5db56f	1	t	637af985-62c1-4371-ac26-94750b20c8fc	t
e0fab8d8-9864-4fbd-b523-5c682377baac	82057f54-4730-4d4a-a86c-16c71dfc5380	ef2f1403-819a-4666-9d27-319fe05abcb4	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	1	t	195f15a8-5f37-4df4-b9d9-84fcbbba7443	t
3a5a9bf9-c27b-468c-b58c-8d42d3db27a4	82057f54-4730-4d4a-a86c-16c71dfc5380	ef2f1403-819a-4666-9d27-319fe05abcb4	b3c5ddcf-836f-4ccd-9f35-22d68099e076	1	t	727f1293-911b-4275-aa59-7d40ac16d23f	t
8e718197-296b-458e-bc94-e4708fa712cc	82057f54-4730-4d4a-a86c-16c71dfc5380	ef2f1403-819a-4666-9d27-319fe05abcb4	d4bf7ed4-74a1-41d5-9480-5748c241727e	1	f	10762058-8eef-4dc6-ba99-f90bca11e784	t
a34d8df9-3971-48bc-9190-0b612fa2e4ca	82057f54-4730-4d4a-a86c-16c71dfc5380	ef2f1403-819a-4666-9d27-319fe05abcb4	f4e893f7-831e-40dd-89ce-1f79e2c1c9b0	1	f	4bdcba2b-927a-4398-9a32-4427c3adc310	t
67767a27-ba92-4826-a2ca-b82c4538ec94	82057f54-4730-4d4a-a86c-16c71dfc5380	bc5e78aa-c3bc-485a-b1e9-128710ceefe2	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	1	t	4b90eb1c-0120-41aa-8f7b-ada09a6b490d	t
8d840c69-ee31-4b91-85ea-586d1e179834	82057f54-4730-4d4a-a86c-16c71dfc5380	bc5e78aa-c3bc-485a-b1e9-128710ceefe2	7d11617a-4813-4b5c-90f0-19626f5db56f	1	t	637af985-62c1-4371-ac26-94750b20c8fc	t
47fa3a52-0323-4c5b-bf84-7fa559087882	82057f54-4730-4d4a-a86c-16c71dfc5380	bc5e78aa-c3bc-485a-b1e9-128710ceefe2	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	1	t	195f15a8-5f37-4df4-b9d9-84fcbbba7443	t
1f9cdf5f-53ca-42bb-9b7e-55f0e63e3923	82057f54-4730-4d4a-a86c-16c71dfc5380	bc5e78aa-c3bc-485a-b1e9-128710ceefe2	b3c5ddcf-836f-4ccd-9f35-22d68099e076	1	t	727f1293-911b-4275-aa59-7d40ac16d23f	t
d201bf74-b56a-49d8-833e-2cc43c40bf11	82057f54-4730-4d4a-a86c-16c71dfc5380	bc5e78aa-c3bc-485a-b1e9-128710ceefe2	d4bf7ed4-74a1-41d5-9480-5748c241727e	1	f	10762058-8eef-4dc6-ba99-f90bca11e784	t
ba64fe0e-e553-43cf-806e-dafe600a3d3c	82057f54-4730-4d4a-a86c-16c71dfc5380	bc5e78aa-c3bc-485a-b1e9-128710ceefe2	f4e893f7-831e-40dd-89ce-1f79e2c1c9b0	1	f	4bdcba2b-927a-4398-9a32-4427c3adc310	t
00cbc81a-9553-496a-918d-c658a8d862d6	82057f54-4730-4d4a-a86c-16c71dfc5380	a1debd32-5f14-4fbd-9b06-bfd21d0192cc	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	1	t	4b90eb1c-0120-41aa-8f7b-ada09a6b490d	t
940c5059-49ba-4a86-a5df-db6d4aabd746	82057f54-4730-4d4a-a86c-16c71dfc5380	a1debd32-5f14-4fbd-9b06-bfd21d0192cc	7d11617a-4813-4b5c-90f0-19626f5db56f	1	t	637af985-62c1-4371-ac26-94750b20c8fc	t
908f462a-94e2-44ac-a57c-b5c8e44ff68a	82057f54-4730-4d4a-a86c-16c71dfc5380	a1debd32-5f14-4fbd-9b06-bfd21d0192cc	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	1	t	195f15a8-5f37-4df4-b9d9-84fcbbba7443	t
1ee66e3f-923f-4778-9b53-075f23b39fc2	82057f54-4730-4d4a-a86c-16c71dfc5380	a1debd32-5f14-4fbd-9b06-bfd21d0192cc	b3c5ddcf-836f-4ccd-9f35-22d68099e076	1	t	727f1293-911b-4275-aa59-7d40ac16d23f	t
ace9943f-b9f9-4bcc-97d1-abfa2af05f50	82057f54-4730-4d4a-a86c-16c71dfc5380	a1debd32-5f14-4fbd-9b06-bfd21d0192cc	d4bf7ed4-74a1-41d5-9480-5748c241727e	1	f	10762058-8eef-4dc6-ba99-f90bca11e784	t
497c46f2-53b5-422c-a38d-5c78364da766	82057f54-4730-4d4a-a86c-16c71dfc5380	a1debd32-5f14-4fbd-9b06-bfd21d0192cc	f4e893f7-831e-40dd-89ce-1f79e2c1c9b0	1	f	4bdcba2b-927a-4398-9a32-4427c3adc310	t
\.


--
-- Data for Name: cases; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cases (id, tenant_id, case_ref, facility_id, procedure, surgeon_ref, scheduled_start, status, urgent, rep_user_id, preference_card_version_id, version, completed_at, created_by, created_at) FROM stdin;
a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	82057f54-4730-4d4a-a86c-16c71dfc5380	SYN-0901	61d14381-fb23-4f39-91d4-3901a30558b1	Total knee arthroplasty, primary, left	Surgeon S-104 (synthetic)	2026-10-31 12:30:00+00	closed	f	679a78ec-76fe-4700-b459-b9f4d0c6dda2	af012a71-1416-4254-b9e6-d9e25a61f521	2	2026-10-31 15:54:00.006+00	08a0e020-5111-4efb-896a-155198f3da03	2026-10-29 10:30:00.002+00
555a2002-df45-4f75-a01c-a237a8347b4c	82057f54-4730-4d4a-a86c-16c71dfc5380	SYN-0902	61d14381-fb23-4f39-91d4-3901a30558b1	Total knee arthroplasty, primary, left	Surgeon S-104 (synthetic)	2026-11-09 13:30:00+00	completed	f	679a78ec-76fe-4700-b459-b9f4d0c6dda2	af012a71-1416-4254-b9e6-d9e25a61f521	2	2026-11-09 16:54:00.004+00	08a0e020-5111-4efb-896a-155198f3da03	2026-11-07 11:30:00.002+00
964622f1-c4fa-4547-8b0a-2b8334c6d297	82057f54-4730-4d4a-a86c-16c71dfc5380	SYN-0903	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	Total knee arthroplasty, primary, left	Surgeon S-104 (synthetic)	2026-11-15 12:30:00+00	completed	f	cee93967-cedb-4428-87c4-e090c376edf7	af012a71-1416-4254-b9e6-d9e25a61f521	2	2026-11-15 15:54:00.002+00	08a0e020-5111-4efb-896a-155198f3da03	2026-11-13 10:30:00.002+00
ef2f1403-819a-4666-9d27-319fe05abcb4	82057f54-4730-4d4a-a86c-16c71dfc5380	SYN-1003	61d14381-fb23-4f39-91d4-3901a30558b1	Total knee arthroplasty, primary, left	Surgeon S-104 (synthetic)	2026-11-24 16:00:00+00	scheduled	f	679a78ec-76fe-4700-b459-b9f4d0c6dda2	af012a71-1416-4254-b9e6-d9e25a61f521	1	\N	08a0e020-5111-4efb-896a-155198f3da03	2026-11-20 12:00:00.004+00
bc5e78aa-c3bc-485a-b1e9-128710ceefe2	82057f54-4730-4d4a-a86c-16c71dfc5380	SYN-1001	61d14381-fb23-4f39-91d4-3901a30558b1	Total knee arthroplasty, primary, left	Surgeon S-104 (synthetic)	2026-11-22 13:30:00+00	scheduled	f	679a78ec-76fe-4700-b459-b9f4d0c6dda2	af012a71-1416-4254-b9e6-d9e25a61f521	1	\N	08a0e020-5111-4efb-896a-155198f3da03	2026-11-20 12:00:00.012+00
a1debd32-5f14-4fbd-9b06-bfd21d0192cc	82057f54-4730-4d4a-a86c-16c71dfc5380	SYN-1002	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	Total knee arthroplasty, primary, left	Surgeon S-104 (synthetic)	2026-11-22 18:00:00+00	scheduled	f	cee93967-cedb-4428-87c4-e090c376edf7	af012a71-1416-4254-b9e6-d9e25a61f521	1	\N	08a0e020-5111-4efb-896a-155198f3da03	2026-11-20 12:00:00.027+00
50832ff3-928d-44f2-927d-03c39f993248	bdc0230c-75cb-47f1-bc8b-f13ddb1aa1b8	RDG-2001	346ce5f9-2e84-4d97-a571-227b24b82026	Lumbar fusion	Surgeon R-9 (synthetic)	2026-11-22 20:00:00+00	scheduled	f	\N	ef9c0086-53e3-4854-8766-cef8ff8a21de	1	\N	\N	2026-11-21 21:32:15.747129+00
\.


--
-- Data for Name: catalog_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.catalog_items (id, tenant_id, manufacturer_party_id, ref, description, item_type, tracking, unit_gtin, size, product_line, uom, source_system, source_id, import_batch_id) FROM stdin;
b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	82057f54-4730-4d4a-a86c-16c71dfc5380	5d3da139-ddf6-430f-95f9-8705a4ce752b	NP-INS-4-10	Meridian tibial insert, size 4, 10 mm	implant	serial	00614141001019	4 / 10mm	Meridian Knee System (synthetic)	EA	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1001	78ba81ba-749c-455c-b70d-bfaf096c90b1
d4bf7ed4-74a1-41d5-9480-5748c241727e	82057f54-4730-4d4a-a86c-16c71dfc5380	5d3da139-ddf6-430f-95f9-8705a4ce752b	NP-INS-4-12	Meridian tibial insert, size 4, 12 mm	implant	serial	00614141001026	4 / 12mm	Meridian Knee System (synthetic)	EA	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1002	78ba81ba-749c-455c-b70d-bfaf096c90b1
7d11617a-4813-4b5c-90f0-19626f5db56f	82057f54-4730-4d4a-a86c-16c71dfc5380	5d3da139-ddf6-430f-95f9-8705a4ce752b	NP-FEM-4L	Meridian femoral component, size 4, left	implant	serial	00614141002016	4 L	Meridian Knee System (synthetic)	EA	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1003	78ba81ba-749c-455c-b70d-bfaf096c90b1
f4e893f7-831e-40dd-89ce-1f79e2c1c9b0	82057f54-4730-4d4a-a86c-16c71dfc5380	5d3da139-ddf6-430f-95f9-8705a4ce752b	NP-FEM-5L	Meridian femoral component, size 5, left	implant	serial	00614141002023	5 L	Meridian Knee System (synthetic)	EA	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1004	78ba81ba-749c-455c-b70d-bfaf096c90b1
4fc32bd5-e912-411b-a0aa-b819ebf07aa6	82057f54-4730-4d4a-a86c-16c71dfc5380	5d3da139-ddf6-430f-95f9-8705a4ce752b	NP-TIB-4	Meridian tibial baseplate, size 4	implant	serial	00614141003013	4	Meridian Knee System (synthetic)	EA	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1005	78ba81ba-749c-455c-b70d-bfaf096c90b1
2d9010d1-af1c-479e-9bd8-9467cfc17ab4	82057f54-4730-4d4a-a86c-16c71dfc5380	5d3da139-ddf6-430f-95f9-8705a4ce752b	NP-SCR-650	Cancellous bone screw 6.5 x 40 mm	implant	lot	00614141004010	6.5x40	Meridian Knee System (synthetic)	EA	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1006	78ba81ba-749c-455c-b70d-bfaf096c90b1
b3c5ddcf-836f-4ccd-9f35-22d68099e076	82057f54-4730-4d4a-a86c-16c71dfc5380	5d3da139-ddf6-430f-95f9-8705a4ce752b	NP-TRAY-KNEE	Meridian knee instrument tray (loaner)	tray	serial	00614141009015	\N	Meridian Knee System (synthetic)	EA	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1101	78ba81ba-749c-455c-b70d-bfaf096c90b1
d2f797b4-ed84-42fe-b2c9-48700f255658	82057f54-4730-4d4a-a86c-16c71dfc5380	5d3da139-ddf6-430f-95f9-8705a4ce752b	NP-INST-SIZER	Femoral sizer	instrument	serial	00614141005017	\N	Meridian Knee System (synthetic)	EA	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1201	78ba81ba-749c-455c-b70d-bfaf096c90b1
c38378c9-90b2-41f5-857b-73bbc8c4966b	82057f54-4730-4d4a-a86c-16c71dfc5380	5d3da139-ddf6-430f-95f9-8705a4ce752b	NP-INST-CUT4	Femoral 4-in-1 cutting block, size 4	instrument	serial	00614141005024	4	Meridian Knee System (synthetic)	EA	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1202	78ba81ba-749c-455c-b70d-bfaf096c90b1
2716dd30-563b-4203-a4a1-dfa1ce9174c0	82057f54-4730-4d4a-a86c-16c71dfc5380	5d3da139-ddf6-430f-95f9-8705a4ce752b	NP-INST-TIBGUIDE	Tibial resection guide	instrument	serial	00614141005031	\N	Meridian Knee System (synthetic)	EA	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1203	78ba81ba-749c-455c-b70d-bfaf096c90b1
b8ef96ac-a20b-40bf-b9e0-0852fe52e052	82057f54-4730-4d4a-a86c-16c71dfc5380	5d3da139-ddf6-430f-95f9-8705a4ce752b	NP-INST-IMPACT	Femoral impactor	instrument	serial	00614141005048	\N	Meridian Knee System (synthetic)	EA	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1204	78ba81ba-749c-455c-b70d-bfaf096c90b1
dc00b586-b2ac-4152-a76a-1dcb42105b72	82057f54-4730-4d4a-a86c-16c71dfc5380	5d3da139-ddf6-430f-95f9-8705a4ce752b	NP-INST-TRIAL4	Trial set, size 4	instrument	serial	00614141005055	4	Meridian Knee System (synthetic)	EA	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1205	78ba81ba-749c-455c-b70d-bfaf096c90b1
b464f5cc-c551-4718-a0dd-526bd2e48ca1	bdc0230c-75cb-47f1-bc8b-f13ddb1aa1b8	88141981-f0dc-4b72-acb3-d4a7111fcb54	RW-CAGE-10	Interbody cage 10 mm (synthetic)	implant	serial	00614142000011	\N	\N	EA	\N	\N	\N
\.


--
-- Data for Name: charges; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.charges (id, tenant_id, case_id, usage_event_id, packet_id, catalog_item_id, contract_version_id, rule_id, qty, unit_price_cents, amount_cents, price_date, status, rationale, created_at) FROM stdin;
563a4387-f654-4e3f-96ed-1da09cb1c11e	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	d13b84c1-a8b8-41ed-9f2e-87b40c9ec823	4a429300-39fb-4777-af50-9274c23f229e	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	9f515a91-beb9-42b5-8346-4043f93044d4	361358d9-36cd-4b6c-b84d-d6e7d8cbba82	1	118000	118000	2026-01-01	draft	St. Brigid Implant Consignment Agreement (synthetic) v3: Consigned implant placed: bill at contract price and replace to consignment (s.2.1). Price $1180.00 effective 2026-01-01.	2026-10-31 15:30:00.014+00
e53058e9-6f49-456b-8079-76fcaf65cb4a	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	d646f2ed-d67a-4019-88e5-27e5ff405706	4a429300-39fb-4777-af50-9274c23f229e	7d11617a-4813-4b5c-90f0-19626f5db56f	9f515a91-beb9-42b5-8346-4043f93044d4	361358d9-36cd-4b6c-b84d-d6e7d8cbba82	1	345000	345000	2026-01-01	draft	St. Brigid Implant Consignment Agreement (synthetic) v3: Consigned implant placed: bill at contract price and replace to consignment (s.2.1). Price $3450.00 effective 2026-01-01.	2026-10-31 15:30:00.026+00
4095d76e-8247-45c1-9193-3e4e44f337f7	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	7f774264-ce43-41d3-be09-c017e47d47f2	4a429300-39fb-4777-af50-9274c23f229e	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	9f515a91-beb9-42b5-8346-4043f93044d4	361358d9-36cd-4b6c-b84d-d6e7d8cbba82	1	215000	215000	2026-01-01	draft	St. Brigid Implant Consignment Agreement (synthetic) v3: Consigned implant placed: bill at contract price and replace to consignment (s.2.1). Price $2150.00 effective 2026-01-01.	2026-10-31 15:30:00.036+00
be3e77d0-7c04-48d6-a880-7d66891a9835	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	ef38dd1e-1795-408b-857c-c4d10c30d45d	fa4a17bb-a68d-49bf-a794-ee91e6c1a2cf	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	9f515a91-beb9-42b5-8346-4043f93044d4	361358d9-36cd-4b6c-b84d-d6e7d8cbba82	1	118000	118000	2026-01-01	draft	St. Brigid Implant Consignment Agreement (synthetic) v3: Consigned implant placed: bill at contract price and replace to consignment (s.2.1). Price $1180.00 effective 2026-01-01.	2026-11-09 16:30:00.012+00
8dab4bda-3df7-4fa1-b0d5-f51e30fc27c7	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	5c6dbf1d-3171-4ab7-8a0e-108f3ab8c170	fa4a17bb-a68d-49bf-a794-ee91e6c1a2cf	7d11617a-4813-4b5c-90f0-19626f5db56f	9f515a91-beb9-42b5-8346-4043f93044d4	361358d9-36cd-4b6c-b84d-d6e7d8cbba82	1	345000	345000	2026-01-01	draft	St. Brigid Implant Consignment Agreement (synthetic) v3: Consigned implant placed: bill at contract price and replace to consignment (s.2.1). Price $3450.00 effective 2026-01-01.	2026-11-09 16:30:00.021+00
d47546e1-39f6-4e56-92f4-78d085bff23f	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	e26cebb0-5047-4dec-b57f-9d1f991b7e2f	fa4a17bb-a68d-49bf-a794-ee91e6c1a2cf	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	9f515a91-beb9-42b5-8346-4043f93044d4	361358d9-36cd-4b6c-b84d-d6e7d8cbba82	1	215000	215000	2026-01-01	draft	St. Brigid Implant Consignment Agreement (synthetic) v3: Consigned implant placed: bill at contract price and replace to consignment (s.2.1). Price $2150.00 effective 2026-01-01.	2026-11-09 16:30:00.029+00
e1f777a1-6a0b-4221-baaf-ddf1e807a027	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	991ae806-5429-4fc1-8a43-0f5c7bee747e	\N	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	98cd8b14-657f-43ed-9880-11cefe5ff39a	558dc951-1452-4392-8947-5c584ac2171d	1	112500	112500	2026-01-01	draft	Prairie Valley Purchase Agreement (synthetic) v1: Purchased stock used: bill only; no replenishment (s.3.1). Price $1125.00 effective 2026-01-01.	2026-11-15 15:30:00.007+00
bfe1de7f-70ab-4a22-b3eb-7aedfe940424	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	3a597841-ea78-47f5-b5dd-46f98a8f4d22	\N	7d11617a-4813-4b5c-90f0-19626f5db56f	98cd8b14-657f-43ed-9880-11cefe5ff39a	558dc951-1452-4392-8947-5c584ac2171d	1	331000	331000	2026-01-01	draft	Prairie Valley Purchase Agreement (synthetic) v1: Purchased stock used: bill only; no replenishment (s.3.1). Price $3310.00 effective 2026-01-01.	2026-11-15 15:30:00.014+00
b24955e7-1b7e-401d-a19e-deba7059f3b3	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	27f5b7e7-e6f5-4434-9b0f-7a0806ec0791	\N	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	98cd8b14-657f-43ed-9880-11cefe5ff39a	558dc951-1452-4392-8947-5c584ac2171d	1	\N	\N	\N	exception	Prairie Valley Purchase Agreement (synthetic) v1 has no price for NP-TIB-4. Missing price is a finance exception; nothing was guessed.	2026-11-15 15:30:00.022+00
\.


--
-- Data for Name: contract_prices; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.contract_prices (id, tenant_id, contract_version_id, catalog_item_id, unit_price_cents, price_date) FROM stdin;
47833317-6925-434d-a498-48e163e581db	82057f54-4730-4d4a-a86c-16c71dfc5380	9f515a91-beb9-42b5-8346-4043f93044d4	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	118000	2026-01-01
38e0dff7-582e-4809-8627-9403601ac647	82057f54-4730-4d4a-a86c-16c71dfc5380	9f515a91-beb9-42b5-8346-4043f93044d4	d4bf7ed4-74a1-41d5-9480-5748c241727e	118000	2026-01-01
fe42671a-63f6-4224-83e9-9427e1bddf25	82057f54-4730-4d4a-a86c-16c71dfc5380	9f515a91-beb9-42b5-8346-4043f93044d4	7d11617a-4813-4b5c-90f0-19626f5db56f	345000	2026-01-01
cd724df9-27da-4de0-b3bc-c411fb84e1e2	82057f54-4730-4d4a-a86c-16c71dfc5380	9f515a91-beb9-42b5-8346-4043f93044d4	f4e893f7-831e-40dd-89ce-1f79e2c1c9b0	345000	2026-01-01
9f982ab8-a36f-4447-989a-18031969d4ec	82057f54-4730-4d4a-a86c-16c71dfc5380	9f515a91-beb9-42b5-8346-4043f93044d4	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	215000	2026-01-01
1df0152c-b361-4d98-a0fe-a6a6708dd7f4	82057f54-4730-4d4a-a86c-16c71dfc5380	9f515a91-beb9-42b5-8346-4043f93044d4	2d9010d1-af1c-479e-9bd8-9467cfc17ab4	8500	2026-01-01
3c70bef0-0ba1-4054-bfcb-5b23825ae547	82057f54-4730-4d4a-a86c-16c71dfc5380	98cd8b14-657f-43ed-9880-11cefe5ff39a	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	112500	2026-01-01
516e74b3-58fe-460f-8e15-38b5cc286bee	82057f54-4730-4d4a-a86c-16c71dfc5380	98cd8b14-657f-43ed-9880-11cefe5ff39a	7d11617a-4813-4b5c-90f0-19626f5db56f	331000	2026-01-01
80524a7a-5734-41e4-bf49-84b018adbbe4	82057f54-4730-4d4a-a86c-16c71dfc5380	98cd8b14-657f-43ed-9880-11cefe5ff39a	f4e893f7-831e-40dd-89ce-1f79e2c1c9b0	331000	2026-01-01
74ab82ec-3435-479f-83ff-3df8647cec1f	82057f54-4730-4d4a-a86c-16c71dfc5380	98cd8b14-657f-43ed-9880-11cefe5ff39a	2d9010d1-af1c-479e-9bd8-9467cfc17ab4	8000	2026-01-01
\.


--
-- Data for Name: contract_rules; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.contract_rules (id, tenant_id, contract_version_id, disposition, charge_action, replenish_action, billing_mode, rule_text) FROM stdin;
361358d9-36cd-4b6c-b84d-d6e7d8cbba82	82057f54-4730-4d4a-a86c-16c71dfc5380	9f515a91-beb9-42b5-8346-4043f93044d4	implanted	charge	replace	bill_and_replace	Consigned implant placed: bill at contract price and replace to consignment (s.2.1).
17a55148-9224-4d93-b8f8-c613a426e79c	82057f54-4730-4d4a-a86c-16c71dfc5380	9f515a91-beb9-42b5-8346-4043f93044d4	opened_unused	charge	replace	bill_and_replace	Opened but unused implant is chargeable and replaced (s.2.4).
e1aba66a-1817-4b90-a56a-7c749442d9db	82057f54-4730-4d4a-a86c-16c71dfc5380	9f515a91-beb9-42b5-8346-4043f93044d4	wasted	charge	replace	bill_and_replace	Wasted implant is chargeable (s.2.4).
387dc047-d1b5-4b68-b016-725b14f03ae4	82057f54-4730-4d4a-a86c-16c71dfc5380	9f515a91-beb9-42b5-8346-4043f93044d4	damaged	review	review	bill_and_replace	Damaged product requires joint review (s.2.6).
fe19ee02-cb11-4238-93d2-c95aea7efa42	82057f54-4730-4d4a-a86c-16c71dfc5380	9f515a91-beb9-42b5-8346-4043f93044d4	returned_sealed	no_charge	none	bill_and_replace	Returned sealed: no charge (s.2.2).
56eaaa2c-2fd3-44ed-93fe-7372f37398f3	82057f54-4730-4d4a-a86c-16c71dfc5380	9f515a91-beb9-42b5-8346-4043f93044d4	missing	review	review	bill_and_replace	Missing product requires investigation before billing (s.2.7).
558dc951-1452-4392-8947-5c584ac2171d	82057f54-4730-4d4a-a86c-16c71dfc5380	98cd8b14-657f-43ed-9880-11cefe5ff39a	implanted	charge	none	bill_only	Purchased stock used: bill only; no replenishment (s.3.1).
c8bd36ab-c5a9-49c6-be9e-555857dd09c9	82057f54-4730-4d4a-a86c-16c71dfc5380	98cd8b14-657f-43ed-9880-11cefe5ff39a	opened_unused	review	review	bill_only	Opened-unused requires distributor and hospital review before any charge (s.4.2).
574b60f7-84e7-4ffe-8995-e26a465effde	82057f54-4730-4d4a-a86c-16c71dfc5380	98cd8b14-657f-43ed-9880-11cefe5ff39a	wasted	review	review	bill_only	Waste requires review (s.4.2).
e18e12a2-5f68-41dd-b545-613403b2c91c	82057f54-4730-4d4a-a86c-16c71dfc5380	98cd8b14-657f-43ed-9880-11cefe5ff39a	damaged	review	review	bill_only	Damage requires review (s.4.3).
391a651f-a17e-429f-a6b9-a6d2c5ca2868	82057f54-4730-4d4a-a86c-16c71dfc5380	98cd8b14-657f-43ed-9880-11cefe5ff39a	returned_sealed	no_charge	none	bill_only	Returned sealed: no charge.
71126070-cb30-4f4f-ab17-52b5961236e5	82057f54-4730-4d4a-a86c-16c71dfc5380	98cd8b14-657f-43ed-9880-11cefe5ff39a	missing	review	review	bill_only	Missing requires review.
\.


--
-- Data for Name: contract_versions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.contract_versions (id, tenant_id, contract_id, version, effective_from, effective_to, approved_by) FROM stdin;
9f515a91-beb9-42b5-8346-4043f93044d4	82057f54-4730-4d4a-a86c-16c71dfc5380	b0b9ed01-b101-496e-bcc8-5c66e4fce5ca	3	2026-01-01	\N	Contracts desk (synthetic)
98cd8b14-657f-43ed-9880-11cefe5ff39a	82057f54-4730-4d4a-a86c-16c71dfc5380	88f292ea-65d7-40b6-bf1f-b3b695601725	1	2026-01-01	\N	Contracts desk (synthetic)
\.


--
-- Data for Name: contracts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.contracts (id, tenant_id, facility_id, name) FROM stdin;
b0b9ed01-b101-496e-bcc8-5c66e4fce5ca	82057f54-4730-4d4a-a86c-16c71dfc5380	61d14381-fb23-4f39-91d4-3901a30558b1	St. Brigid Implant Consignment Agreement (synthetic)
88f292ea-65d7-40b6-bf1f-b3b695601725	82057f54-4730-4d4a-a86c-16c71dfc5380	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	Prairie Valley Purchase Agreement (synthetic)
\.


--
-- Data for Name: count_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.count_lines (id, tenant_id, session_id, stock_item_id, owner_party_id, counted_qty, expected_qty, counted_at) FROM stdin;
3f846cf6-4e09-4567-885f-9c5671d13843	82057f54-4730-4d4a-a86c-16c71dfc5380	8b29aef8-56de-490a-994d-2ae306d55fdd	04902ff1-e22b-4581-ba3e-75b973dac0cc	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	1	1	2026-11-16 16:00:00.005+00
4caa0e41-fb96-4d1a-8934-64f763bd0006	82057f54-4730-4d4a-a86c-16c71dfc5380	8b29aef8-56de-490a-994d-2ae306d55fdd	2f2a2461-7243-4478-bbb7-df4497433379	5d3da139-ddf6-430f-95f9-8705a4ce752b	1	1	2026-11-16 16:00:00.009+00
0d7c88b5-e7cd-4d3e-bc12-77aaccd1c89f	82057f54-4730-4d4a-a86c-16c71dfc5380	8b29aef8-56de-490a-994d-2ae306d55fdd	5190a5bb-ff49-4543-8b3b-e9a4df561a7b	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	1	1	2026-11-16 16:00:00.011+00
79ff1fd6-91d8-4d2a-9f3f-4ee787c3a847	82057f54-4730-4d4a-a86c-16c71dfc5380	8b29aef8-56de-490a-994d-2ae306d55fdd	524e48bc-002b-41f5-bb86-f331d2bd97dd	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	1	1	2026-11-16 16:00:00.012+00
b3dd8cd9-a1e4-4902-b072-3b657fc156aa	82057f54-4730-4d4a-a86c-16c71dfc5380	8b29aef8-56de-490a-994d-2ae306d55fdd	6347b29f-96e5-4886-ac37-66af7c072957	5d3da139-ddf6-430f-95f9-8705a4ce752b	1	1	2026-11-16 16:00:00.015+00
fc4c52e7-d492-4224-8208-3c15d28ded9e	82057f54-4730-4d4a-a86c-16c71dfc5380	8b29aef8-56de-490a-994d-2ae306d55fdd	7103687d-adc4-4ebe-8137-4dcc005ddf40	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	19	20	2026-11-16 16:00:00.017+00
3106395c-40be-4c90-b722-cf8d4b3b9b6e	82057f54-4730-4d4a-a86c-16c71dfc5380	8b29aef8-56de-490a-994d-2ae306d55fdd	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	5d3da139-ddf6-430f-95f9-8705a4ce752b	1	1	2026-11-16 16:00:00.019+00
66cf0aae-13d7-4a4f-80d3-4bcd93e2a1a5	82057f54-4730-4d4a-a86c-16c71dfc5380	8b29aef8-56de-490a-994d-2ae306d55fdd	b60d87e3-525b-43da-b493-50b08d9535cf	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	1	1	2026-11-16 16:00:00.021+00
c04e6da4-0b66-463c-9fc5-74a122b9363a	82057f54-4730-4d4a-a86c-16c71dfc5380	8b29aef8-56de-490a-994d-2ae306d55fdd	e8921336-a648-428d-a737-50fd8c8dcd49	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	1	1	2026-11-16 16:00:00.028+00
\.


--
-- Data for Name: count_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.count_sessions (id, tenant_id, location_id, status, created_by, created_at, submitted_by, submitted_at, reviewed_by, reviewed_at, review_note) FROM stdin;
8b29aef8-56de-490a-994d-2ae306d55fdd	82057f54-4730-4d4a-a86c-16c71dfc5380	241007a7-e552-4c9d-903e-dd625ca691fe	approved	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-16 16:00:00.002+00	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-16 16:00:00.035+00	96730663-96b5-4d44-919e-f3965640e7a4	2026-11-16 16:00:00.043+00	Recount confirmed 19 screws; one unit unaccounted (synthetic)
\.


--
-- Data for Name: credits; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.credits (id, tenant_id, charge_id, amount_cents, reason, created_by, created_at, idempotency_key) FROM stdin;
\.


--
-- Data for Name: custody_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.custody_events (id, tenant_id, shipment_id, event_type, actor_user_id, from_location_id, to_location_id, occurred_at, recorded_at, ack_state, ack_by, ack_at, notes) FROM stdin;
058f8d45-9aea-452d-a992-864c77a553d6	82057f54-4730-4d4a-a86c-16c71dfc5380	703b7074-b14c-4d0a-88b6-44158a7fd5f0	packed	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	241007a7-e552-4c9d-903e-dd625ca691fe	\N	2026-10-30 14:30:00.049+00	2026-10-30 14:30:00.049+00	not_required	\N	\N	\N
a91ece1a-2f7a-4d80-bde4-2747ae957735	82057f54-4730-4d4a-a86c-16c71dfc5380	703b7074-b14c-4d0a-88b6-44158a7fd5f0	dispatched	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	241007a7-e552-4c9d-903e-dd625ca691fe	c93683f7-5db8-40f9-a4fb-839e2a79bb54	2026-10-30 14:30:00.072+00	2026-10-30 14:30:00.072+00	acknowledged	37edafe9-7c57-4171-8bb7-83f26e1f740f	2026-10-30 16:30:00.003+00	\N
61511f41-8df1-4f7a-9532-951b44d23d7d	82057f54-4730-4d4a-a86c-16c71dfc5380	703b7074-b14c-4d0a-88b6-44158a7fd5f0	delivered	37edafe9-7c57-4171-8bb7-83f26e1f740f	\N	2dd920a2-792c-4540-bc80-6a1b1185f37a	2026-10-30 16:30:00.004+00	2026-10-30 16:30:00.004+00	acknowledged	ff8b05fb-2d7a-42af-9046-444b2c57f169	2026-10-30 17:00:00.015+00	\N
dd02e78d-61aa-4b4e-8bbe-868f826d2ad5	82057f54-4730-4d4a-a86c-16c71dfc5380	703b7074-b14c-4d0a-88b6-44158a7fd5f0	received	ff8b05fb-2d7a-42af-9046-444b2c57f169	c93683f7-5db8-40f9-a4fb-839e2a79bb54	2dd920a2-792c-4540-bc80-6a1b1185f37a	2026-10-30 17:00:00.009+00	2026-10-30 17:00:00.016+00	acknowledged	ff8b05fb-2d7a-42af-9046-444b2c57f169	2026-10-30 17:00:00.016+00	Received as expected
6a8f3046-1d69-40d4-92a0-2aeb653213fa	82057f54-4730-4d4a-a86c-16c71dfc5380	703b7074-b14c-4d0a-88b6-44158a7fd5f0	closed	ff8b05fb-2d7a-42af-9046-444b2c57f169	\N	2dd920a2-792c-4540-bc80-6a1b1185f37a	2026-10-30 19:30:00.009+00	2026-10-30 19:30:00.009+00	acknowledged	ff8b05fb-2d7a-42af-9046-444b2c57f169	2026-10-30 19:30:00.009+00	\N
9f85fd10-01a7-4b91-9a9a-a4bb0331b310	82057f54-4730-4d4a-a86c-16c71dfc5380	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	packed	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	241007a7-e552-4c9d-903e-dd625ca691fe	\N	2026-11-09 02:30:00.026+00	2026-11-09 02:30:00.026+00	not_required	\N	\N	\N
06323262-8366-428d-a176-4c9e905ce6b2	82057f54-4730-4d4a-a86c-16c71dfc5380	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	dispatched	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	241007a7-e552-4c9d-903e-dd625ca691fe	c93683f7-5db8-40f9-a4fb-839e2a79bb54	2026-11-09 02:30:00.038+00	2026-11-09 02:30:00.038+00	acknowledged	37edafe9-7c57-4171-8bb7-83f26e1f740f	2026-11-09 04:30:00.002+00	\N
664db1ff-258e-4190-a941-5013ac0a57e0	82057f54-4730-4d4a-a86c-16c71dfc5380	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	delivered	37edafe9-7c57-4171-8bb7-83f26e1f740f	\N	2dd920a2-792c-4540-bc80-6a1b1185f37a	2026-11-09 04:30:00.002+00	2026-11-09 04:30:00.002+00	acknowledged	ff8b05fb-2d7a-42af-9046-444b2c57f169	2026-11-09 05:00:00.014+00	\N
8859284b-749a-4ca2-8058-b82345fe8ab7	82057f54-4730-4d4a-a86c-16c71dfc5380	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	received	ff8b05fb-2d7a-42af-9046-444b2c57f169	c93683f7-5db8-40f9-a4fb-839e2a79bb54	2dd920a2-792c-4540-bc80-6a1b1185f37a	2026-11-09 05:00:00.006+00	2026-11-09 05:00:00.015+00	acknowledged	ff8b05fb-2d7a-42af-9046-444b2c57f169	2026-11-09 05:00:00.015+00	Received as expected
03b74ad5-d84e-476b-9f81-0edf4c98916b	82057f54-4730-4d4a-a86c-16c71dfc5380	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	closed	ff8b05fb-2d7a-42af-9046-444b2c57f169	\N	2dd920a2-792c-4540-bc80-6a1b1185f37a	2026-11-09 07:30:00.004+00	2026-11-09 07:30:00.004+00	acknowledged	ff8b05fb-2d7a-42af-9046-444b2c57f169	2026-11-09 07:30:00.004+00	\N
cd151c72-b1e1-4f5b-b741-300fa62726c9	82057f54-4730-4d4a-a86c-16c71dfc5380	e6528bef-e34f-4551-9e97-204bee72d399	packed	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	241007a7-e552-4c9d-903e-dd625ca691fe	\N	2026-11-14 04:30:00.023+00	2026-11-14 04:30:00.023+00	not_required	\N	\N	\N
94c1c2b7-daff-4ead-a5f5-4340a7857988	82057f54-4730-4d4a-a86c-16c71dfc5380	c5c70cc5-9c4d-451a-8b3f-f7339eb110ff	packed	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2dd920a2-792c-4540-bc80-6a1b1185f37a	\N	2026-11-14 04:30:00.058+00	2026-11-14 04:30:00.058+00	not_required	\N	\N	\N
bd502537-19c9-404e-bbaa-964740137105	82057f54-4730-4d4a-a86c-16c71dfc5380	e6528bef-e34f-4551-9e97-204bee72d399	dispatched	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	241007a7-e552-4c9d-903e-dd625ca691fe	c93683f7-5db8-40f9-a4fb-839e2a79bb54	2026-11-14 04:30:00.039+00	2026-11-14 04:30:00.039+00	acknowledged	37edafe9-7c57-4171-8bb7-83f26e1f740f	2026-11-14 06:30:00.002+00	\N
a3d0b3f0-a6d4-4783-a842-91d036c829ee	82057f54-4730-4d4a-a86c-16c71dfc5380	c5c70cc5-9c4d-451a-8b3f-f7339eb110ff	dispatched	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2dd920a2-792c-4540-bc80-6a1b1185f37a	c93683f7-5db8-40f9-a4fb-839e2a79bb54	2026-11-14 04:30:00.07+00	2026-11-14 04:30:00.07+00	acknowledged	37edafe9-7c57-4171-8bb7-83f26e1f740f	2026-11-14 06:30:00.011+00	\N
6611df2e-ea72-44df-ac27-76de0896ebf6	82057f54-4730-4d4a-a86c-16c71dfc5380	e6528bef-e34f-4551-9e97-204bee72d399	delivered	37edafe9-7c57-4171-8bb7-83f26e1f740f	\N	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	2026-11-14 06:30:00.002+00	2026-11-14 06:30:00.002+00	acknowledged	79fe508f-120a-412e-9736-0cf2c80e484e	2026-11-14 07:00:00.009+00	\N
8f457256-6f33-4c72-9da1-6a1af39f109c	82057f54-4730-4d4a-a86c-16c71dfc5380	e6528bef-e34f-4551-9e97-204bee72d399	received	79fe508f-120a-412e-9736-0cf2c80e484e	c93683f7-5db8-40f9-a4fb-839e2a79bb54	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	2026-11-14 07:00:00.005+00	2026-11-14 07:00:00.009+00	acknowledged	79fe508f-120a-412e-9736-0cf2c80e484e	2026-11-14 07:00:00.009+00	Received as expected
fdd7a945-e5cb-4edf-800e-7a53f28bc6bf	82057f54-4730-4d4a-a86c-16c71dfc5380	c5c70cc5-9c4d-451a-8b3f-f7339eb110ff	delivered	37edafe9-7c57-4171-8bb7-83f26e1f740f	\N	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	2026-11-14 06:30:00.011+00	2026-11-14 06:30:00.011+00	acknowledged	79fe508f-120a-412e-9736-0cf2c80e484e	2026-11-14 07:00:00.02+00	\N
7f1a8efe-b9f6-45f1-9125-7db6008a8cb4	82057f54-4730-4d4a-a86c-16c71dfc5380	c5c70cc5-9c4d-451a-8b3f-f7339eb110ff	received	79fe508f-120a-412e-9736-0cf2c80e484e	c93683f7-5db8-40f9-a4fb-839e2a79bb54	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	2026-11-14 07:00:00.018+00	2026-11-14 07:00:00.02+00	acknowledged	79fe508f-120a-412e-9736-0cf2c80e484e	2026-11-14 07:00:00.02+00	Received as expected
9a87cbb5-d751-444c-93d8-0bb932712395	82057f54-4730-4d4a-a86c-16c71dfc5380	e6528bef-e34f-4551-9e97-204bee72d399	closed	79fe508f-120a-412e-9736-0cf2c80e484e	\N	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	2026-11-14 09:30:00.004+00	2026-11-14 09:30:00.004+00	acknowledged	79fe508f-120a-412e-9736-0cf2c80e484e	2026-11-14 09:30:00.004+00	\N
144a8867-b0ab-428b-a1d0-90837d855e57	82057f54-4730-4d4a-a86c-16c71dfc5380	c5c70cc5-9c4d-451a-8b3f-f7339eb110ff	closed	79fe508f-120a-412e-9736-0cf2c80e484e	\N	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	2026-11-14 09:30:00.007+00	2026-11-14 09:30:00.007+00	acknowledged	79fe508f-120a-412e-9736-0cf2c80e484e	2026-11-14 09:30:00.007+00	\N
7b5073eb-395e-4ff4-a0ce-76671881b57a	82057f54-4730-4d4a-a86c-16c71dfc5380	74c82176-4d43-4aae-9cdd-298a7990fd8d	dispatched	9bd9ad2b-2664-4d61-ad81-b028e87a533f	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	c93683f7-5db8-40f9-a4fb-839e2a79bb54	2026-11-18 21:00:00.018+00	2026-11-18 21:00:00.018+00	acknowledged	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-18 21:00:00.033+00	\N
8287d305-d287-457d-b52f-b1db8d263e4d	82057f54-4730-4d4a-a86c-16c71dfc5380	74c82176-4d43-4aae-9cdd-298a7990fd8d	received	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	c93683f7-5db8-40f9-a4fb-839e2a79bb54	241007a7-e552-4c9d-903e-dd625ca691fe	2026-11-18 21:00:00.03+00	2026-11-18 21:00:00.033+00	acknowledged	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-18 21:00:00.033+00	Received as expected
3b40061e-771f-45e2-a427-f324759ce341	82057f54-4730-4d4a-a86c-16c71dfc5380	74c82176-4d43-4aae-9cdd-298a7990fd8d	closed	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	\N	241007a7-e552-4c9d-903e-dd625ca691fe	2026-11-18 21:00:00.045+00	2026-11-18 21:00:00.045+00	acknowledged	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-18 21:00:00.045+00	\N
b842f8e3-beb0-47e7-9f48-6af2607ae760	82057f54-4730-4d4a-a86c-16c71dfc5380	d5df80c0-93e8-4961-a305-fd5d1f1c266f	dispatched	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2dd920a2-792c-4540-bc80-6a1b1185f37a	c93683f7-5db8-40f9-a4fb-839e2a79bb54	2026-11-18 21:00:00.02+00	2026-11-18 21:00:00.02+00	acknowledged	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-18 21:00:00.032+00	\N
11eee1e4-db5d-46bb-9ce5-fe87b6495cc9	82057f54-4730-4d4a-a86c-16c71dfc5380	d5df80c0-93e8-4961-a305-fd5d1f1c266f	received	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	c93683f7-5db8-40f9-a4fb-839e2a79bb54	241007a7-e552-4c9d-903e-dd625ca691fe	2026-11-18 21:00:00.031+00	2026-11-18 21:00:00.033+00	acknowledged	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-18 21:00:00.033+00	Received as expected
d30b5ff6-7f8b-4662-9ce4-ceeb8bea372e	82057f54-4730-4d4a-a86c-16c71dfc5380	d5df80c0-93e8-4961-a305-fd5d1f1c266f	closed	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	\N	241007a7-e552-4c9d-903e-dd625ca691fe	2026-11-18 21:00:00.043+00	2026-11-18 21:00:00.043+00	acknowledged	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-18 21:00:00.043+00	\N
\.


--
-- Data for Name: discrepancies; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.discrepancies (id, tenant_id, shipment_id, case_id, tray_stock_item_id, stock_item_id, catalog_item_id, kind, qty, detail, status, reported_by, reported_at, resolution, resolved_by, resolved_at) FROM stdin;
\.


--
-- Data for Name: erp_acks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.erp_acks (id, tenant_id, outbox_id, external_doc_ref, ack_type, payload, received_at) FROM stdin;
a7216340-9ac0-4f04-ba5f-f029d4c21ebb	82057f54-4730-4d4a-a86c-16c71dfc5380	35fa49f6-4e98-4fc4-8fa7-2e8761de928b	SIM-ERP-A670C05DDE	received	{"message": "Simulated ERP stored the draft billing document. Not an invoice, not payment.", "accepted": true, "external_doc_ref": "SIM-ERP-A670C05DDE"}	2026-11-01 14:30:00.015+00
1730f8ae-5b9b-4538-936f-8a70afc3416f	82057f54-4730-4d4a-a86c-16c71dfc5380	db096e8e-0b0d-4601-bf8f-2842261f39de	SIM-ERP-331EAFF88D	received	{"message": "Simulated ERP stored the draft billing document. Not an invoice, not payment.", "accepted": true, "external_doc_ref": "SIM-ERP-331EAFF88D"}	2026-11-10 15:30:00.013+00
\.


--
-- Data for Name: exceptions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.exceptions (id, tenant_id, kind, severity, title, detail, case_id, facility_id, ref_table, ref_id, owner_role, owner_user_id, status, created_at, resolved_by, resolved_at, resolution, dedupe_key) FROM stdin;
d7ab6273-7c19-4b6c-911f-d5d5ebdd11a8	82057f54-4730-4d4a-a86c-16c71dfc5380	finance_exception	critical	SYN-0903: charge cannot be priced	Prairie Valley Purchase Agreement (synthetic) v1 has no price for NP-TIB-4. Missing price is a finance exception; nothing was guessed.	964622f1-c4fa-4547-8b0a-2b8334c6d297	\N	charges	b24955e7-1b7e-401d-a19e-deba7059f3b3	finance	\N	open	2026-11-15 15:30:00.022+00	\N	\N	\N	charge:b24955e7-1b7e-401d-a19e-deba7059f3b3
8304932d-aaf1-49a1-8da7-6d95c4d2fb85	82057f54-4730-4d4a-a86c-16c71dfc5380	count_variance	warning	Count variance at session 8b29aef8	1 line(s) differ from the ledger. Review before approving adjustments.	\N	\N	count_sessions	8b29aef8-56de-490a-994d-2ae306d55fdd	inventory_coordinator	\N	resolved	2026-11-16 16:00:00.036+00	96730663-96b5-4d44-919e-f3965640e7a4	2026-11-16 16:00:00.043+00	Recount confirmed 19 screws; one unit unaccounted (synthetic)	cntvar:8b29aef8-56de-490a-994d-2ae306d55fdd
\.


--
-- Data for Name: facilities; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.facilities (id, tenant_id, code, name, kind, timezone, territory_id, party_id) FROM stdin;
6fa799b7-1b16-461f-8723-063edb00435a	82057f54-4730-4d4a-a86c-16c71dfc5380	WH	Lakeshore Central Warehouse	warehouse	America/Chicago	b82a7fc8-4f6a-4f9f-a11a-e305d2a7dff8	1b9d9abc-9dd9-441e-9ce3-66639e62ade9
61d14381-fb23-4f39-91d4-3901a30558b1	82057f54-4730-4d4a-a86c-16c71dfc5380	SBR	St. Brigid Regional Medical Center (synthetic)	hospital	America/Chicago	b82a7fc8-4f6a-4f9f-a11a-e305d2a7dff8	4b25c513-cb3d-47b0-bd34-39668e64dd34
2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	82057f54-4730-4d4a-a86c-16c71dfc5380	PVS	Prairie Valley Surgical Hospital (synthetic)	hospital	America/Indiana/Indianapolis	f54a6002-3a27-4e7e-bb26-7cce6461523a	f3506c6e-4e5e-4567-866c-679ddf43adaf
346ce5f9-2e84-4d97-a571-227b24b82026	bdc0230c-75cb-47f1-bc8b-f13ddb1aa1b8	HPM	Harbor Point Medical (synthetic)	hospital	America/New_York	\N	\N
\.


--
-- Data for Name: facility_policies; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.facility_policies (id, tenant_id, facility_id, version, tray_due_hours_before, implant_due_hours_before, requires_release_decision, required_evidence, receiving_notes, effective_from, approved_by) FROM stdin;
1df87e61-a93b-4583-bc23-5c99335b727d	82057f54-4730-4d4a-a86c-16c71dfc5380	61d14381-fb23-4f39-91d4-3901a30558b1	3	12	2	t	{hospital_processing_record_ref}	Loaner trays due by 19:30 the evening before; SPD records release after decontamination and processing per hospital procedure.	2026-01-01 00:00:00+00	SBR Perioperative Services (synthetic)
f09f2b98-6f5a-43a6-84d6-bf2351f66803	82057f54-4730-4d4a-a86c-16c71dfc5380	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	1	24	12	t	{hospital_processing_record_ref,loaner_count_sheet_ref}	Loaner trays and implants must arrive one full day before surgery; hospital count sheet reference required.	2026-01-01 00:00:00+00	PVS Materials Management (synthetic)
6acdccb2-5fb7-4271-86f8-574f31f0863d	bdc0230c-75cb-47f1-bc8b-f13ddb1aa1b8	346ce5f9-2e84-4d97-a571-227b24b82026	1	12	2	t	{}	\N	2026-01-01 00:00:00+00	HPM (synthetic)
\.


--
-- Data for Name: idempotency_keys; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.idempotency_keys (tenant_id, key, endpoint, response, created_at) FROM stdin;
\.


--
-- Data for Name: import_batches; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.import_batches (id, tenant_id, kind, filename, source_system, file_sha256, mode, mapping, report, created_by, created_at) FROM stdin;
78ba81ba-749c-455c-b70d-bfaf096c90b1	82057f54-4730-4d4a-a86c-16c71dfc5380	catalog	northpoint_catalog_synthetic.csv	NORTHPOINT-PRICEFILE-SIM	a40fb0202e060d97d5ffddbdb45a1bfd0558649acb9f184e7a56883dcc62d4ba	commit	{"ref": "ref", "uom": "uom", "size": "size", "tracking": "tracking", "item_type": "item_type", "source_id": "source_id", "unit_gtin": "unit_gtin", "description": "description", "manufacturer": "manufacturer", "product_line": "product_line"}	{"kind": "catalog", "mode": "commit", "counts": {"accepted": 12}, "headers": ["source_id", "manufacturer", "ref", "description", "item_type", "tracking", "unit_gtin", "size", "product_line", "uom"], "mapping": {"ref": "ref", "uom": "uom", "size": "size", "tracking": "tracking", "item_type": "item_type", "source_id": "source_id", "unit_gtin": "unit_gtin", "description": "description", "manufacturer": "manufacturer", "product_line": "product_line"}, "batch_id": "78ba81ba-749c-455c-b70d-bfaf096c90b1", "filename": "northpoint_catalog_synthetic.csv", "committed": true, "rows_read": 12, "file_sha256": "a40fb0202e060d97d5ffddbdb45a1bfd0558649acb9f184e7a56883dcc62d4ba", "source_system": "NORTHPOINT-PRICEFILE-SIM", "reconciliation": null, "missing_required_mappings": []}	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.011+00
6db9fc8f-8ef6-4982-be8a-c2bac8f4c2d2	82057f54-4730-4d4a-a86c-16c71dfc5380	packages	northpoint_packages_synthetic.csv	NORTHPOINT-PRICEFILE-SIM	0c41e72a5309c20becfc8bae1cb0fec75f76f757804faae332a1d76cc46498c2	commit	{"uom": "uom", "level": "level", "item_ref": "item_ref", "source_id": "source_id", "package_gtin": "package_gtin", "units_per_package": "units_per_package"}	{"kind": "packages", "mode": "commit", "counts": {"accepted": 1}, "headers": ["source_id", "item_ref", "package_gtin", "level", "units_per_package", "uom"], "mapping": {"uom": "uom", "level": "level", "item_ref": "item_ref", "source_id": "source_id", "package_gtin": "package_gtin", "units_per_package": "units_per_package"}, "batch_id": "6db9fc8f-8ef6-4982-be8a-c2bac8f4c2d2", "filename": "northpoint_packages_synthetic.csv", "committed": true, "rows_read": 1, "file_sha256": "0c41e72a5309c20becfc8bae1cb0fec75f76f757804faae332a1d76cc46498c2", "source_system": "NORTHPOINT-PRICEFILE-SIM", "reconciliation": null, "missing_required_mappings": []}	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.038+00
ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	opening_balances_synthetic.csv	LEGACY-SPREADSHEET-SIM	94954b94f9edafa948ebf6e5cd557c44e24ddfe0f755e128d633c9be69500e46	commit	{"lot": "lot", "uom": "uom", "owner": "owner", "expiry": "expiry", "serial": "serial", "item_ref": "item_ref", "quantity": "quantity", "source_id": "source_id", "location_code": "location_code", "package_level": "package_level"}	{"kind": "opening_balances", "mode": "commit", "counts": {"accepted": 26}, "headers": ["source_id", "owner", "location_code", "item_ref", "lot", "serial", "expiry", "package_level", "quantity", "uom"], "mapping": {"lot": "lot", "uom": "uom", "owner": "owner", "expiry": "expiry", "serial": "serial", "item_ref": "item_ref", "quantity": "quantity", "source_id": "source_id", "location_code": "location_code", "package_level": "package_level"}, "batch_id": "ae4de74e-5036-4d05-8fc8-c69ddb70ea8a", "filename": "opening_balances_synthetic.csv", "committed": true, "rows_read": 26, "file_sha256": "94954b94f9edafa948ebf6e5cd557c44e24ddfe0f755e128d633c9be69500e46", "source_system": "LEGACY-SPREADSHEET-SIM", "reconciliation": {"by_location": [{"after": 1, "before": 0, "location": "PVS-CONSIGN"}, {"after": 2, "before": 0, "location": "SBR-CONSIGN"}, {"after": 3, "before": 0, "location": "TRUNK-JORDAN"}, {"after": 6, "before": 0, "location": "TRUNK-RILEY"}, {"after": 37, "before": 0, "location": "WH-MAIN"}], "accepted_units": 49, "ledger_matches": true, "committed_units": 49, "units_posted_to_ledger": 49}, "missing_required_mappings": []}	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.062+00
\.


--
-- Data for Name: import_row_keys; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.import_row_keys (tenant_id, kind, source_system, source_id, row_hash, first_batch_id, entity_id) FROM stdin;
82057f54-4730-4d4a-a86c-16c71dfc5380	catalog	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1001	54641825c200845ed90887bb94e2c37b829af2ddb31149cea5379cf08c33f8e2	78ba81ba-749c-455c-b70d-bfaf096c90b1	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445
82057f54-4730-4d4a-a86c-16c71dfc5380	catalog	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1002	b6618408d4e36aac3c16562e9f7d3b81f9979c3fc9696897da45826175e78d0a	78ba81ba-749c-455c-b70d-bfaf096c90b1	d4bf7ed4-74a1-41d5-9480-5748c241727e
82057f54-4730-4d4a-a86c-16c71dfc5380	catalog	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1003	69cc33641f7c25b99386bbefef1055b4121cbb8289c728c8062c7924861124ef	78ba81ba-749c-455c-b70d-bfaf096c90b1	7d11617a-4813-4b5c-90f0-19626f5db56f
82057f54-4730-4d4a-a86c-16c71dfc5380	catalog	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1004	f4703238cd9a7165f8efb41ade0eecb1cdd4354921b1406d54f294fa403e1414	78ba81ba-749c-455c-b70d-bfaf096c90b1	f4e893f7-831e-40dd-89ce-1f79e2c1c9b0
82057f54-4730-4d4a-a86c-16c71dfc5380	catalog	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1005	675a4d42e45f37cddd6fe0c1a9a42ff0681ec3d11469a0fa09790ccc03f6cb6b	78ba81ba-749c-455c-b70d-bfaf096c90b1	4fc32bd5-e912-411b-a0aa-b819ebf07aa6
82057f54-4730-4d4a-a86c-16c71dfc5380	catalog	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1006	055a53bc46511a73c61542a2bbc3b04209bf08615e4ded5c87e501fb6b9a82ba	78ba81ba-749c-455c-b70d-bfaf096c90b1	2d9010d1-af1c-479e-9bd8-9467cfc17ab4
82057f54-4730-4d4a-a86c-16c71dfc5380	catalog	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1101	d2f1bf821e0641d9f6dcd49388ad3c90b58d7d3e2a386e0a1543df415306b49f	78ba81ba-749c-455c-b70d-bfaf096c90b1	b3c5ddcf-836f-4ccd-9f35-22d68099e076
82057f54-4730-4d4a-a86c-16c71dfc5380	catalog	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1201	880ff5dc1687fecf58dd083b7cd08f976e603c900ec6b225e027f7a61be22a9c	78ba81ba-749c-455c-b70d-bfaf096c90b1	d2f797b4-ed84-42fe-b2c9-48700f255658
82057f54-4730-4d4a-a86c-16c71dfc5380	catalog	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1202	b9a277698f8f809d458bb84c6c7a500fc8ef7cc62cdfe4ce51c32db7a5254c26	78ba81ba-749c-455c-b70d-bfaf096c90b1	c38378c9-90b2-41f5-857b-73bbc8c4966b
82057f54-4730-4d4a-a86c-16c71dfc5380	catalog	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1203	4ee795c2d93463a92f914179f384fc439db9841320443464b0890c0ab7f95088	78ba81ba-749c-455c-b70d-bfaf096c90b1	2716dd30-563b-4203-a4a1-dfa1ce9174c0
82057f54-4730-4d4a-a86c-16c71dfc5380	catalog	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1204	b5cbc01a952576cee66a72f45850d0f626bf65445d1868ae2cbaf02ef5e9321d	78ba81ba-749c-455c-b70d-bfaf096c90b1	b8ef96ac-a20b-40bf-b9e0-0852fe52e052
82057f54-4730-4d4a-a86c-16c71dfc5380	catalog	NORTHPOINT-PRICEFILE-SIM	NP-MAT-1205	625f2b0eab53ccceb24df278cc848b7bb7732e57d7f784d1d2beea69b5c662c1	78ba81ba-749c-455c-b70d-bfaf096c90b1	dc00b586-b2ac-4152-a76a-1dcb42105b72
82057f54-4730-4d4a-a86c-16c71dfc5380	packages	NORTHPOINT-PRICEFILE-SIM	PK-1006-5	63999fac3d007ec04516fca0abdfe1b8aba78073e88b3f41362e4574188f406c	6db9fc8f-8ef6-4982-be8a-c2bac8f4c2d2	da45b39a-946c-4856-93d0-afccb21c3901
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-001	4e42e66e10ed76a3cdd7f52ae5a60191082569d4d15c8874f8da9cda6df57b8e	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	04902ff1-e22b-4581-ba3e-75b973dac0cc
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-002	c6c40036a480b8d538f142867dc1f92c789564977a47686c05770dc6c64756b7	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	ef74907e-f311-4535-a50e-a8b3c411b7fc
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-003	101d7f0a9a8be9d4a2706f7de1629099e9b36744926cb54d8ce06cd0b8404d50	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	5a6e5a60-4ef3-4333-bfa0-199a9297343d
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-004	af3819b8991865753d021e7396d872ddf3fb1ac485a78d1eaa3e99937e418757	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	c7d5bde7-b708-444f-8f7c-8e98b4829886
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-005	94918df69485caa621890769596856a86f593e2bfa321ef7dd55b5b5a81e1344	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	524e48bc-002b-41f5-bb86-f331d2bd97dd
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-006	3dc0865e480bb115f8dfddae0cfca39b07674c439c1326beb248c330f08dcd1c	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	4dd05f15-7329-433d-aacd-2ebc86ee4e44
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-007	4814460b47cb64cd20420e4db92f87344a3e9ca7841e4b9d28f2c8e6edaa57e6	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	5190a5bb-ff49-4543-8b3b-e9a4df561a7b
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-008	8a184484c378dd7c4fd7326d948a8cffb686a79b233155864206a92d7b59fa0d	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	bd227725-c45a-4003-9ecf-aa30624a2d85
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-009	879999111c0caa1740d096e90d1847a79a9e3bccb69b186674f6be3045331046	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	36abd8b0-9299-486e-8a8e-b086703afef8
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-010	de31e29ab2190c3c7fc9b2985795e9ce08b6f79a23ab8b47c066d055876ca34b	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	4ef0a46d-e8ff-4c36-8d88-f7e9f789b804
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-011	d7d3b7d6c026ec2be6cc685540123a3d436392dd9728db92a210595de6418c1f	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	e8921336-a648-428d-a737-50fd8c8dcd49
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-012	472f3a241b452583af5b9c54ffb24ed8e8d3c7ef2a2a9014e1023d0fe78a6b6b	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	b60d87e3-525b-43da-b493-50b08d9535cf
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-013	d1ef100a5046d57bdfd8ad7811cc499163ff0cd869a8340d2f8232f8c650bd4c	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	f6c15774-458d-4b23-8516-5334b95ef36f
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-014	fb0bea03968f0654c6cded79056b0a7e04a82d058345492dadbf49d04f038633	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	eb949393-b146-40b3-9e5e-6135546fdc2d
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-015	639ae2073f20141c9b1bb75889a63c7ad5a61f2eee2d06371d5097dc4deab5b2	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	7103687d-adc4-4ebe-8137-4dcc005ddf40
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-016	693da22e85018572f3933f81d78df431c307244b85d6d92f3101c92bffd0e873	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	7103687d-adc4-4ebe-8137-4dcc005ddf40
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-017	9a64f17ee86076b9360b14d162f245417b994159b792c916bde4252ec3fb211e	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	6347b29f-96e5-4886-ac37-66af7c072957
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-018	cc7c699af858e45a88c861af9844ba28832a6c80a8b2c3f30600b0938211d2bc	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-019	0e5a915a501f328a235e0f8a24053d4ef3b39e1ea1754b976944ba5bf331aad0	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2f2a2461-7243-4478-bbb7-df4497433379
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-020	20d80e963ab4e3cf287f9af4d424ae510b56a0fdcb3e3e86dcc0b1f68ca463e0	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	7b804cd3-400b-401d-a270-8f439e96370a
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-021	847dd7382a8129d1aa2f0686de8a92b61ab5a7d2213b8dea3355c95240a5bbe3	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	bb2e661b-b202-47a4-8c71-b06f6d0bee8a
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-022	546fe307da0bdfba1a041774f2d04490c1906a8d8260fa9a526d29e8fa7d4488	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	bfeb5892-4fb4-465f-b784-24df21fed08a
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-023	00bf107b2ee12b5deeec968648e49a355fbf5fa446340734680c662c5deab9f2	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	6b82bbc6-7246-48d8-92b8-f6ba4f755942
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-024	8336681770cca138c8360051fa4d4b1faad556cbd0f7ecb4b6a4b546c1dd367f	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	b489a089-d976-4558-8d3e-bc1185e293f9
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-025	51512d2f0d7a6781d19f95dc511cf129d756d5f6a2ac19e35d36fef642bface3	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	27b8d558-7603-49ca-ab67-890a836a9fa1
82057f54-4730-4d4a-a86c-16c71dfc5380	opening_balances	LEGACY-SPREADSHEET-SIM	OB-026	a8444dbcaaeec2e95ed0215545aa95d6b7560524ed03603e1096a884e519d24a	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	c28c3811-bd2d-4fb8-a390-b815162fba25
\.


--
-- Data for Name: import_rows; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.import_rows (id, tenant_id, batch_id, row_number, source_id, row_hash, status, errors, raw, entity_id) FROM stdin;
e691d7a8-9c50-4fd6-a58a-391d402c0bb7	82057f54-4730-4d4a-a86c-16c71dfc5380	78ba81ba-749c-455c-b70d-bfaf096c90b1	2	NP-MAT-1001	54641825c200845ed90887bb94e2c37b829af2ddb31149cea5379cf08c33f8e2	accepted	[]	{"ref": "NP-INS-4-10", "uom": "EA", "size": "4 / 10mm", "tracking": "serial", "item_type": "implant", "source_id": "NP-MAT-1001", "unit_gtin": "00614141001019", "description": "Meridian tibial insert, size 4, 10 mm", "manufacturer": "Northpoint Ortho Devices (synthetic)", "product_line": "Meridian Knee System (synthetic)"}	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445
841d4c6b-847d-4a29-94be-2948b9d78fd2	82057f54-4730-4d4a-a86c-16c71dfc5380	78ba81ba-749c-455c-b70d-bfaf096c90b1	3	NP-MAT-1002	b6618408d4e36aac3c16562e9f7d3b81f9979c3fc9696897da45826175e78d0a	accepted	[]	{"ref": "NP-INS-4-12", "uom": "EA", "size": "4 / 12mm", "tracking": "serial", "item_type": "implant", "source_id": "NP-MAT-1002", "unit_gtin": "00614141001026", "description": "Meridian tibial insert, size 4, 12 mm", "manufacturer": "Northpoint Ortho Devices (synthetic)", "product_line": "Meridian Knee System (synthetic)"}	d4bf7ed4-74a1-41d5-9480-5748c241727e
4ecd148d-23a7-42ed-8eae-11f4b82e427c	82057f54-4730-4d4a-a86c-16c71dfc5380	78ba81ba-749c-455c-b70d-bfaf096c90b1	4	NP-MAT-1003	69cc33641f7c25b99386bbefef1055b4121cbb8289c728c8062c7924861124ef	accepted	[]	{"ref": "NP-FEM-4L", "uom": "EA", "size": "4 L", "tracking": "serial", "item_type": "implant", "source_id": "NP-MAT-1003", "unit_gtin": "00614141002016", "description": "Meridian femoral component, size 4, left", "manufacturer": "Northpoint Ortho Devices (synthetic)", "product_line": "Meridian Knee System (synthetic)"}	7d11617a-4813-4b5c-90f0-19626f5db56f
eccdd433-a0a6-4a47-99f3-98f354314f31	82057f54-4730-4d4a-a86c-16c71dfc5380	78ba81ba-749c-455c-b70d-bfaf096c90b1	5	NP-MAT-1004	f4703238cd9a7165f8efb41ade0eecb1cdd4354921b1406d54f294fa403e1414	accepted	[]	{"ref": "NP-FEM-5L", "uom": "EA", "size": "5 L", "tracking": "serial", "item_type": "implant", "source_id": "NP-MAT-1004", "unit_gtin": "00614141002023", "description": "Meridian femoral component, size 5, left", "manufacturer": "Northpoint Ortho Devices (synthetic)", "product_line": "Meridian Knee System (synthetic)"}	f4e893f7-831e-40dd-89ce-1f79e2c1c9b0
0fca29f8-ff79-451e-be5a-a744dceed98b	82057f54-4730-4d4a-a86c-16c71dfc5380	78ba81ba-749c-455c-b70d-bfaf096c90b1	6	NP-MAT-1005	675a4d42e45f37cddd6fe0c1a9a42ff0681ec3d11469a0fa09790ccc03f6cb6b	accepted	[]	{"ref": "NP-TIB-4", "uom": "EA", "size": "4", "tracking": "serial", "item_type": "implant", "source_id": "NP-MAT-1005", "unit_gtin": "00614141003013", "description": "Meridian tibial baseplate, size 4", "manufacturer": "Northpoint Ortho Devices (synthetic)", "product_line": "Meridian Knee System (synthetic)"}	4fc32bd5-e912-411b-a0aa-b819ebf07aa6
2683d029-903a-4452-b2bb-ac6a38c44604	82057f54-4730-4d4a-a86c-16c71dfc5380	78ba81ba-749c-455c-b70d-bfaf096c90b1	7	NP-MAT-1006	055a53bc46511a73c61542a2bbc3b04209bf08615e4ded5c87e501fb6b9a82ba	accepted	[]	{"ref": "NP-SCR-650", "uom": "EA", "size": "6.5x40", "tracking": "lot", "item_type": "implant", "source_id": "NP-MAT-1006", "unit_gtin": "00614141004010", "description": "Cancellous bone screw 6.5 x 40 mm", "manufacturer": "Northpoint Ortho Devices (synthetic)", "product_line": "Meridian Knee System (synthetic)"}	2d9010d1-af1c-479e-9bd8-9467cfc17ab4
4f5b6422-7164-4411-b19c-d897f2960b50	82057f54-4730-4d4a-a86c-16c71dfc5380	78ba81ba-749c-455c-b70d-bfaf096c90b1	8	NP-MAT-1101	d2f1bf821e0641d9f6dcd49388ad3c90b58d7d3e2a386e0a1543df415306b49f	accepted	[]	{"ref": "NP-TRAY-KNEE", "uom": "EA", "size": "", "tracking": "serial", "item_type": "tray", "source_id": "NP-MAT-1101", "unit_gtin": "00614141009015", "description": "Meridian knee instrument tray (loaner)", "manufacturer": "Northpoint Ortho Devices (synthetic)", "product_line": "Meridian Knee System (synthetic)"}	b3c5ddcf-836f-4ccd-9f35-22d68099e076
35f69835-aafd-4c7a-aafa-bac4dd7361c7	82057f54-4730-4d4a-a86c-16c71dfc5380	78ba81ba-749c-455c-b70d-bfaf096c90b1	9	NP-MAT-1201	880ff5dc1687fecf58dd083b7cd08f976e603c900ec6b225e027f7a61be22a9c	accepted	[]	{"ref": "NP-INST-SIZER", "uom": "EA", "size": "", "tracking": "serial", "item_type": "instrument", "source_id": "NP-MAT-1201", "unit_gtin": "00614141005017", "description": "Femoral sizer", "manufacturer": "Northpoint Ortho Devices (synthetic)", "product_line": "Meridian Knee System (synthetic)"}	d2f797b4-ed84-42fe-b2c9-48700f255658
4ddb0800-3287-4f11-abd5-0552d119195f	82057f54-4730-4d4a-a86c-16c71dfc5380	78ba81ba-749c-455c-b70d-bfaf096c90b1	10	NP-MAT-1202	b9a277698f8f809d458bb84c6c7a500fc8ef7cc62cdfe4ce51c32db7a5254c26	accepted	[]	{"ref": "NP-INST-CUT4", "uom": "EA", "size": "4", "tracking": "serial", "item_type": "instrument", "source_id": "NP-MAT-1202", "unit_gtin": "00614141005024", "description": "Femoral 4-in-1 cutting block, size 4", "manufacturer": "Northpoint Ortho Devices (synthetic)", "product_line": "Meridian Knee System (synthetic)"}	c38378c9-90b2-41f5-857b-73bbc8c4966b
16848f48-3edb-426e-885d-07c47bcc4afa	82057f54-4730-4d4a-a86c-16c71dfc5380	78ba81ba-749c-455c-b70d-bfaf096c90b1	11	NP-MAT-1203	4ee795c2d93463a92f914179f384fc439db9841320443464b0890c0ab7f95088	accepted	[]	{"ref": "NP-INST-TIBGUIDE", "uom": "EA", "size": "", "tracking": "serial", "item_type": "instrument", "source_id": "NP-MAT-1203", "unit_gtin": "00614141005031", "description": "Tibial resection guide", "manufacturer": "Northpoint Ortho Devices (synthetic)", "product_line": "Meridian Knee System (synthetic)"}	2716dd30-563b-4203-a4a1-dfa1ce9174c0
24600386-e69f-46ed-86c7-c63edbd2f8e4	82057f54-4730-4d4a-a86c-16c71dfc5380	78ba81ba-749c-455c-b70d-bfaf096c90b1	12	NP-MAT-1204	b5cbc01a952576cee66a72f45850d0f626bf65445d1868ae2cbaf02ef5e9321d	accepted	[]	{"ref": "NP-INST-IMPACT", "uom": "EA", "size": "", "tracking": "serial", "item_type": "instrument", "source_id": "NP-MAT-1204", "unit_gtin": "00614141005048", "description": "Femoral impactor", "manufacturer": "Northpoint Ortho Devices (synthetic)", "product_line": "Meridian Knee System (synthetic)"}	b8ef96ac-a20b-40bf-b9e0-0852fe52e052
21ea7626-b6b9-40cd-953e-84189e31dc7b	82057f54-4730-4d4a-a86c-16c71dfc5380	78ba81ba-749c-455c-b70d-bfaf096c90b1	13	NP-MAT-1205	625f2b0eab53ccceb24df278cc848b7bb7732e57d7f784d1d2beea69b5c662c1	accepted	[]	{"ref": "NP-INST-TRIAL4", "uom": "EA", "size": "4", "tracking": "serial", "item_type": "instrument", "source_id": "NP-MAT-1205", "unit_gtin": "00614141005055", "description": "Trial set, size 4", "manufacturer": "Northpoint Ortho Devices (synthetic)", "product_line": "Meridian Knee System (synthetic)"}	dc00b586-b2ac-4152-a76a-1dcb42105b72
e9499dd3-87ee-4073-beb6-d3fba7e328af	82057f54-4730-4d4a-a86c-16c71dfc5380	6db9fc8f-8ef6-4982-be8a-c2bac8f4c2d2	2	PK-1006-5	63999fac3d007ec04516fca0abdfe1b8aba78073e88b3f41362e4574188f406c	accepted	[]	{"uom": "BX", "level": "inner", "item_ref": "NP-SCR-650", "source_id": "PK-1006-5", "package_gtin": "10614141004017", "units_per_package": "5"}	da45b39a-946c-4856-93d0-afccb21c3901
f3c1736b-add9-48db-9947-4140463dafc1	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2	OB-001	4e42e66e10ed76a3cdd7f52ae5a60191082569d4d15c8874f8da9cda6df57b8e	accepted	[]	{"lot": "L26C014", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2027-12-26", "serial": "INS-0001", "item_ref": "NP-INS-4-10", "quantity": "1", "source_id": "OB-001", "location_code": "WH-MAIN", "package_level": "each"}	04902ff1-e22b-4581-ba3e-75b973dac0cc
27159cd9-db2e-4804-97f8-f90f3797e903	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	3	OB-002	c6c40036a480b8d538f142867dc1f92c789564977a47686c05770dc6c64756b7	accepted	[]	{"lot": "L26C014", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2027-12-26", "serial": "INS-0002", "item_ref": "NP-INS-4-10", "quantity": "1", "source_id": "OB-002", "location_code": "TRUNK-JORDAN", "package_level": "each"}	ef74907e-f311-4535-a50e-a8b3c411b7fc
448fa604-5bdd-40fb-87fe-8256b8436570	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	4	OB-003	101d7f0a9a8be9d4a2706f7de1629099e9b36744926cb54d8ce06cd0b8404d50	accepted	[]	{"lot": "L26C014", "uom": "EA", "owner": "Prairie Valley Surgical Hospital (synthetic)", "expiry": "2027-12-26", "serial": "INS-0003", "item_ref": "NP-INS-4-10", "quantity": "1", "source_id": "OB-003", "location_code": "PVS-CONSIGN", "package_level": "each"}	5a6e5a60-4ef3-4333-bfa0-199a9297343d
c27acb6d-c6ef-482a-9369-0184342f5be4	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	5	OB-004	af3819b8991865753d021e7396d872ddf3fb1ac485a78d1eaa3e99937e418757	accepted	[]	{"lot": "L25K201", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2026-11-20", "serial": "INS-0004", "item_ref": "NP-INS-4-10", "quantity": "1", "source_id": "OB-004", "location_code": "TRUNK-RILEY", "package_level": "each"}	c7d5bde7-b708-444f-8f7c-8e98b4829886
1b94872b-0704-4d7a-82a2-cc05561dbb13	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	6	OB-005	94918df69485caa621890769596856a86f593e2bfa321ef7dd55b5b5a81e1344	accepted	[]	{"lot": "L26A003", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2027-09-17", "serial": "INS-0006", "item_ref": "NP-INS-4-10", "quantity": "1", "source_id": "OB-005", "location_code": "WH-MAIN", "package_level": "each"}	524e48bc-002b-41f5-bb86-f331d2bd97dd
855afb7e-c9f4-450a-b9b2-fb50b5151bc4	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	7	OB-006	3dc0865e480bb115f8dfddae0cfca39b07674c439c1326beb248c330f08dcd1c	accepted	[]	{"lot": "L26A003", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2027-09-17", "serial": "INS-0007", "item_ref": "NP-INS-4-10", "quantity": "1", "source_id": "OB-006", "location_code": "WH-MAIN", "package_level": "each"}	4dd05f15-7329-433d-aacd-2ebc86ee4e44
b53b619f-7c04-4ab6-97b1-9ddbfc639a05	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	8	OB-007	4814460b47cb64cd20420e4db92f87344a3e9ca7841e4b9d28f2c8e6edaa57e6	accepted	[]	{"lot": "L26C020", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2028-01-15", "serial": "INS12-0001", "item_ref": "NP-INS-4-12", "quantity": "1", "source_id": "OB-007", "location_code": "WH-MAIN", "package_level": "each"}	5190a5bb-ff49-4543-8b3b-e9a4df561a7b
3a7c81ef-dc0d-4ddd-8799-95ced626a7ac	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	9	OB-008	8a184484c378dd7c4fd7326d948a8cffb686a79b233155864206a92d7b59fa0d	accepted	[]	{"lot": "L26B110", "uom": "EA", "owner": "Northpoint Ortho Devices (synthetic)", "expiry": "2028-04-04", "serial": "FEM4L-0101", "item_ref": "NP-FEM-4L", "quantity": "1", "source_id": "OB-008", "location_code": "SBR-CONSIGN", "package_level": "each"}	bd227725-c45a-4003-9ecf-aa30624a2d85
2f691b47-31a5-4191-a6c5-a0af7a61bd01	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	10	OB-009	879999111c0caa1740d096e90d1847a79a9e3bccb69b186674f6be3045331046	accepted	[]	{"lot": "L26B210", "uom": "EA", "owner": "Northpoint Ortho Devices (synthetic)", "expiry": "2028-04-04", "serial": "TIB4-0201", "item_ref": "NP-TIB-4", "quantity": "1", "source_id": "OB-009", "location_code": "SBR-CONSIGN", "package_level": "each"}	36abd8b0-9299-486e-8a8e-b086703afef8
bbe986e8-c452-4b04-a65e-29dce3a2d968	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	11	OB-010	de31e29ab2190c3c7fc9b2985795e9ce08b6f79a23ab8b47c066d055876ca34b	accepted	[]	{"lot": "L26B110", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2028-04-04", "serial": "FEM4L-0102", "item_ref": "NP-FEM-4L", "quantity": "1", "source_id": "OB-010", "location_code": "WH-MAIN", "package_level": "each"}	4ef0a46d-e8ff-4c36-8d88-f7e9f789b804
33f7a6f3-20d4-44ef-9233-df54f759433d	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	12	OB-011	d7d3b7d6c026ec2be6cc685540123a3d436392dd9728db92a210595de6418c1f	accepted	[]	{"lot": "L26B111", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2028-04-04", "serial": "FEM5L-0301", "item_ref": "NP-FEM-5L", "quantity": "1", "source_id": "OB-011", "location_code": "WH-MAIN", "package_level": "each"}	e8921336-a648-428d-a737-50fd8c8dcd49
e86ff99e-c47b-436d-a967-d56c6dfd0207	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	13	OB-012	472f3a241b452583af5b9c54ffb24ed8e8d3c7ef2a2a9014e1023d0fe78a6b6b	accepted	[]	{"lot": "L26B111", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2028-04-04", "serial": "FEM5L-0302", "item_ref": "NP-FEM-5L", "quantity": "1", "source_id": "OB-012", "location_code": "WH-MAIN", "package_level": "each"}	b60d87e3-525b-43da-b493-50b08d9535cf
cd091b11-9555-48c1-9adc-06d1bb3d4e9f	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	14	OB-013	d1ef100a5046d57bdfd8ad7811cc499163ff0cd869a8340d2f8232f8c650bd4c	accepted	[]	{"lot": "L26B210", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2028-04-04", "serial": "TIB4-0202", "item_ref": "NP-TIB-4", "quantity": "1", "source_id": "OB-013", "location_code": "WH-MAIN", "package_level": "each"}	f6c15774-458d-4b23-8516-5334b95ef36f
33c61976-9b88-4f53-b616-4adb825ace04	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	15	OB-014	fb0bea03968f0654c6cded79056b0a7e04a82d058345492dadbf49d04f038633	accepted	[]	{"lot": "L26B210", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2028-04-04", "serial": "TIB4-0203", "item_ref": "NP-TIB-4", "quantity": "1", "source_id": "OB-014", "location_code": "WH-MAIN", "package_level": "each"}	eb949393-b146-40b3-9e5e-6135546fdc2d
5aea2339-33e0-4eae-bf70-e24e9e95035f	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	16	OB-015	639ae2073f20141c9b1bb75889a63c7ad5a61f2eee2d06371d5097dc4deab5b2	accepted	[]	{"lot": "S26B088", "uom": "BX", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2028-10-21", "serial": "", "item_ref": "NP-SCR-650", "quantity": "4", "source_id": "OB-015", "location_code": "WH-MAIN", "package_level": "inner"}	7103687d-adc4-4ebe-8137-4dcc005ddf40
0c1693a0-dec5-44c0-8cc6-4bff63d835ba	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	17	OB-016	693da22e85018572f3933f81d78df431c307244b85d6d92f3101c92bffd0e873	accepted	[]	{"lot": "S26B088", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2028-10-21", "serial": "", "item_ref": "NP-SCR-650", "quantity": "5", "source_id": "OB-016", "location_code": "TRUNK-RILEY", "package_level": "each"}	7103687d-adc4-4ebe-8137-4dcc005ddf40
f869e6ce-773f-4b2b-b2e2-ff1e95f74531	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	18	OB-017	9a64f17ee86076b9360b14d162f245417b994159b792c916bde4252ec3fb211e	accepted	[]	{"lot": "T-LOANER", "uom": "EA", "owner": "Northpoint Ortho Devices (synthetic)", "expiry": "", "serial": "TRY-K-001", "item_ref": "NP-TRAY-KNEE", "quantity": "1", "source_id": "OB-017", "location_code": "WH-MAIN", "package_level": "each"}	6347b29f-96e5-4886-ac37-66af7c072957
f8e75232-aac9-415b-ad03-71daefc0eb84	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	19	OB-018	cc7c699af858e45a88c861af9844ba28832a6c80a8b2c3f30600b0938211d2bc	accepted	[]	{"lot": "T-LOANER", "uom": "EA", "owner": "Northpoint Ortho Devices (synthetic)", "expiry": "", "serial": "TRY-K-002", "item_ref": "NP-TRAY-KNEE", "quantity": "1", "source_id": "OB-018", "location_code": "WH-MAIN", "package_level": "each"}	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b
75e6ac5e-c3d8-4eda-8e31-ee58c66de92f	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	20	OB-019	0e5a915a501f328a235e0f8a24053d4ef3b39e1ea1754b976944ba5bf331aad0	accepted	[]	{"lot": "I-LOOSE", "uom": "EA", "owner": "Northpoint Ortho Devices (synthetic)", "expiry": "", "serial": "SZ-0207", "item_ref": "NP-INST-SIZER", "quantity": "1", "source_id": "OB-019", "location_code": "WH-MAIN", "package_level": "each"}	2f2a2461-7243-4478-bbb7-df4497433379
53aa5dd4-91e9-4fdc-847e-7c3020781aef	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	21	OB-020	20d80e963ab4e3cf287f9af4d424ae510b56a0fdcb3e3e86dcc0b1f68ca463e0	accepted	[]	{"lot": "L26C030", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2028-02-14", "serial": "INS-0010", "item_ref": "NP-INS-4-10", "quantity": "1", "source_id": "OB-020", "location_code": "WH-MAIN", "package_level": "each"}	7b804cd3-400b-401d-a270-8f439e96370a
81264db8-43fc-4b34-bfed-b2d834a73bca	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	22	OB-021	847dd7382a8129d1aa2f0686de8a92b61ab5a7d2213b8dea3355c95240a5bbe3	accepted	[]	{"lot": "L26C030", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2028-02-14", "serial": "INS-0011", "item_ref": "NP-INS-4-10", "quantity": "1", "source_id": "OB-021", "location_code": "WH-MAIN", "package_level": "each"}	bb2e661b-b202-47a4-8c71-b06f6d0bee8a
dbac2ca4-472b-4234-bcc1-69a978f9c57a	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	23	OB-022	546fe307da0bdfba1a041774f2d04490c1906a8d8260fa9a526d29e8fa7d4488	accepted	[]	{"lot": "L26B110", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2028-04-04", "serial": "FEM4L-0103", "item_ref": "NP-FEM-4L", "quantity": "1", "source_id": "OB-022", "location_code": "WH-MAIN", "package_level": "each"}	bfeb5892-4fb4-465f-b784-24df21fed08a
085895f2-448a-486e-b710-fab4bde4f943	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	24	OB-023	00bf107b2ee12b5deeec968648e49a355fbf5fa446340734680c662c5deab9f2	accepted	[]	{"lot": "L26B210", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2028-04-04", "serial": "TIB4-0204", "item_ref": "NP-TIB-4", "quantity": "1", "source_id": "OB-023", "location_code": "WH-MAIN", "package_level": "each"}	6b82bbc6-7246-48d8-92b8-f6ba4f755942
e767072b-1635-4f13-99e6-bf87122e8675	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	25	OB-024	8336681770cca138c8360051fa4d4b1faad556cbd0f7ecb4b6a4b546c1dd367f	accepted	[]	{"lot": "L26B110", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2028-04-04", "serial": "FEM4L-0104", "item_ref": "NP-FEM-4L", "quantity": "1", "source_id": "OB-024", "location_code": "TRUNK-JORDAN", "package_level": "each"}	b489a089-d976-4558-8d3e-bc1185e293f9
a8d6846b-01e0-4775-af14-ee0051b8db5b	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	26	OB-025	51512d2f0d7a6781d19f95dc511cf129d756d5f6a2ac19e35d36fef642bface3	accepted	[]	{"lot": "L26B210", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2028-04-04", "serial": "TIB4-0205", "item_ref": "NP-TIB-4", "quantity": "1", "source_id": "OB-025", "location_code": "TRUNK-JORDAN", "package_level": "each"}	27b8d558-7603-49ca-ab67-890a836a9fa1
abb25aaf-02dd-47ee-93a9-5a6b5a898e5c	82057f54-4730-4d4a-a86c-16c71dfc5380	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	27	OB-026	a8444dbcaaeec2e95ed0215545aa95d6b7560524ed03603e1096a884e519d24a	accepted	[]	{"lot": "L26B110", "uom": "EA", "owner": "Lakeshore Orthopedic Partners (synthetic)", "expiry": "2028-04-04", "serial": "FEM4L-0105", "item_ref": "NP-FEM-4L", "quantity": "1", "source_id": "OB-026", "location_code": "WH-MAIN", "package_level": "each"}	c28c3811-bd2d-4fb8-a390-b815162fba25
\.


--
-- Data for Name: instrument_returns; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.instrument_returns (id, tenant_id, case_id, tray_stock_item_id, status, note, recorded_by, recorded_at, client_event_id) FROM stdin;
0574c7a3-7e64-4515-9e3c-eadb71a68ed7	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	6347b29f-96e5-4886-ac37-66af7c072957	awaiting_return	\N	679a78ec-76fe-4700-b459-b9f4d0c6dda2	2026-10-31 15:54:00.005+00	\N
17e5f61f-306b-4e42-94e4-c8895d6bed29	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	awaiting_return	\N	679a78ec-76fe-4700-b459-b9f4d0c6dda2	2026-11-09 16:54:00.004+00	\N
f9472152-5653-487e-a9c3-0b8c2c0a1dff	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	6347b29f-96e5-4886-ac37-66af7c072957	awaiting_return	\N	cee93967-cedb-4428-87c4-e090c376edf7	2026-11-15 15:54:00.002+00	\N
\.


--
-- Data for Name: integration_feeds; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.integration_feeds (id, tenant_id, code, name, simulated, live_enabled, stale_after_minutes, last_success_at, last_attempt_at, last_error, mock_fail_next, field_ownership) FROM stdin;
806f45af-f0fd-4471-a7e3-e71beb53042b	82057f54-4730-4d4a-a86c-16c71dfc5380	sched-SBR	St. Brigid OR schedule feed (SIMULATED)	t	f	240	2026-11-21 13:40:00+00	\N	\N	0	{"case.rep": "Tracewell", "case.requirements": "Tracewell (approved preference card)", "case.scheduled_start": "Hospital scheduling system"}
a16c5213-3d22-4912-82af-a2d9f53ca359	82057f54-4730-4d4a-a86c-16c71dfc5380	sched-PVS	Prairie Valley OR schedule feed (SIMULATED)	t	f	240	2026-11-21 05:00:00+00	\N	\N	0	{"case.rep": "Tracewell", "case.requirements": "Tracewell (approved preference card)", "case.scheduled_start": "Hospital scheduling system"}
b8c79c9e-9e93-429f-8798-20bd491f611e	82057f54-4730-4d4a-a86c-16c71dfc5380	sap-future	SAP ERP adapter (NOT CONNECTED - future)	f	f	1440	\N	\N	\N	0	{}
df158a1a-b288-47b7-b375-eef1be97beea	82057f54-4730-4d4a-a86c-16c71dfc5380	sfdc-future	Salesforce adapter (NOT CONNECTED - future)	f	f	1440	\N	\N	\N	0	{}
f2366273-d548-4f44-a397-f8018a8c8249	82057f54-4730-4d4a-a86c-16c71dfc5380	erp-mock	Mock ERP adapter (SIMULATED)	t	f	1440	2026-11-10 15:30:00.014+00	2026-11-10 15:30:00.014+00	\N	0	{"po_number": "Customer / entered by finance", "invoice_number": "ERP", "payment_status": "ERP (never set by Tracewell)", "customer_master": "ERP", "billing_packet.lines": "Tracewell (draft)"}
\.


--
-- Data for Name: inventory_movements; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.inventory_movements (id, tenant_id, stock_item_id, qty, owner_party_id, from_location_id, from_condition, to_location_id, to_condition, movement_type, shipment_id, case_id, usage_event_id, import_batch_id, count_session_id, reverses_movement_id, reason, actor_user_id, occurred_at, recorded_at, db_created_at, idempotency_key) FROM stdin;
1	82057f54-4730-4d4a-a86c-16c71dfc5380	04902ff1-e22b-4581-ba3e-75b973dac0cc	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-001	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.066+00	2026-10-12 14:00:00.066+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-001
2	82057f54-4730-4d4a-a86c-16c71dfc5380	ef74907e-f311-4535-a50e-a8b3c411b7fc	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	77a7aee8-8b25-4d85-8409-df3cddee5d55	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-002	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.071+00	2026-10-12 14:00:00.071+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-002
3	82057f54-4730-4d4a-a86c-16c71dfc5380	5a6e5a60-4ef3-4333-bfa0-199a9297343d	1	f3506c6e-4e5e-4567-866c-679ddf43adaf	\N	\N	d8861e84-bb5d-4b80-9cad-a2568ef1fdd3	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-003	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.074+00	2026-10-12 14:00:00.074+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-003
4	82057f54-4730-4d4a-a86c-16c71dfc5380	c7d5bde7-b708-444f-8f7c-8e98b4829886	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	b23f2359-decb-4d53-93f3-bb8302fc166d	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-004	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.078+00	2026-10-12 14:00:00.078+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-004
5	82057f54-4730-4d4a-a86c-16c71dfc5380	524e48bc-002b-41f5-bb86-f331d2bd97dd	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-005	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.08+00	2026-10-12 14:00:00.08+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-005
6	82057f54-4730-4d4a-a86c-16c71dfc5380	4dd05f15-7329-433d-aacd-2ebc86ee4e44	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-006	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.082+00	2026-10-12 14:00:00.082+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-006
7	82057f54-4730-4d4a-a86c-16c71dfc5380	5190a5bb-ff49-4543-8b3b-e9a4df561a7b	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-007	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.085+00	2026-10-12 14:00:00.085+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-007
8	82057f54-4730-4d4a-a86c-16c71dfc5380	bd227725-c45a-4003-9ecf-aa30624a2d85	1	5d3da139-ddf6-430f-95f9-8705a4ce752b	\N	\N	a8cd43ec-3428-4c61-8cde-f343d65d11f6	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-008	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.086+00	2026-10-12 14:00:00.086+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-008
9	82057f54-4730-4d4a-a86c-16c71dfc5380	36abd8b0-9299-486e-8a8e-b086703afef8	1	5d3da139-ddf6-430f-95f9-8705a4ce752b	\N	\N	a8cd43ec-3428-4c61-8cde-f343d65d11f6	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-009	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.087+00	2026-10-12 14:00:00.087+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-009
10	82057f54-4730-4d4a-a86c-16c71dfc5380	4ef0a46d-e8ff-4c36-8d88-f7e9f789b804	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-010	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.088+00	2026-10-12 14:00:00.088+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-010
11	82057f54-4730-4d4a-a86c-16c71dfc5380	e8921336-a648-428d-a737-50fd8c8dcd49	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-011	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.09+00	2026-10-12 14:00:00.09+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-011
12	82057f54-4730-4d4a-a86c-16c71dfc5380	b60d87e3-525b-43da-b493-50b08d9535cf	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-012	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.091+00	2026-10-12 14:00:00.091+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-012
13	82057f54-4730-4d4a-a86c-16c71dfc5380	f6c15774-458d-4b23-8516-5334b95ef36f	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-013	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.092+00	2026-10-12 14:00:00.092+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-013
14	82057f54-4730-4d4a-a86c-16c71dfc5380	eb949393-b146-40b3-9e5e-6135546fdc2d	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-014	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.093+00	2026-10-12 14:00:00.093+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-014
15	82057f54-4730-4d4a-a86c-16c71dfc5380	7103687d-adc4-4ebe-8137-4dcc005ddf40	20	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-015 (4 BX x 5 = 20 units)	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.094+00	2026-10-12 14:00:00.094+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-015
16	82057f54-4730-4d4a-a86c-16c71dfc5380	7103687d-adc4-4ebe-8137-4dcc005ddf40	5	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	b23f2359-decb-4d53-93f3-bb8302fc166d	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-016	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.095+00	2026-10-12 14:00:00.095+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-016
17	82057f54-4730-4d4a-a86c-16c71dfc5380	6347b29f-96e5-4886-ac37-66af7c072957	1	5d3da139-ddf6-430f-95f9-8705a4ce752b	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-017	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.098+00	2026-10-12 14:00:00.098+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-017
18	82057f54-4730-4d4a-a86c-16c71dfc5380	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	1	5d3da139-ddf6-430f-95f9-8705a4ce752b	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-018	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.101+00	2026-10-12 14:00:00.101+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-018
19	82057f54-4730-4d4a-a86c-16c71dfc5380	2f2a2461-7243-4478-bbb7-df4497433379	1	5d3da139-ddf6-430f-95f9-8705a4ce752b	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-019	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.104+00	2026-10-12 14:00:00.104+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-019
20	82057f54-4730-4d4a-a86c-16c71dfc5380	7b804cd3-400b-401d-a270-8f439e96370a	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-020	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.105+00	2026-10-12 14:00:00.105+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-020
21	82057f54-4730-4d4a-a86c-16c71dfc5380	bb2e661b-b202-47a4-8c71-b06f6d0bee8a	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-021	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.106+00	2026-10-12 14:00:00.106+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-021
22	82057f54-4730-4d4a-a86c-16c71dfc5380	bfeb5892-4fb4-465f-b784-24df21fed08a	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-022	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.108+00	2026-10-12 14:00:00.108+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-022
23	82057f54-4730-4d4a-a86c-16c71dfc5380	6b82bbc6-7246-48d8-92b8-f6ba4f755942	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-023	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.109+00	2026-10-12 14:00:00.109+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-023
24	82057f54-4730-4d4a-a86c-16c71dfc5380	b489a089-d976-4558-8d3e-bc1185e293f9	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	77a7aee8-8b25-4d85-8409-df3cddee5d55	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-024	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.113+00	2026-10-12 14:00:00.113+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-024
25	82057f54-4730-4d4a-a86c-16c71dfc5380	27b8d558-7603-49ca-ab67-890a836a9fa1	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	77a7aee8-8b25-4d85-8409-df3cddee5d55	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-025	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.116+00	2026-10-12 14:00:00.116+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-025
26	82057f54-4730-4d4a-a86c-16c71dfc5380	c28c3811-bd2d-4fb8-a390-b815162fba25	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	\N	\N	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	opening_balance	\N	\N	\N	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	\N	\N	Opening balance import LEGACY-SPREADSHEET-SIM:OB-026	96730663-96b5-4d44-919e-f3965640e7a4	2026-10-12 14:00:00.12+00	2026-10-12 14:00:00.12+00	2026-11-21 21:32:14.819048+00	import:opening_balances:LEGACY-SPREADSHEET-SIM:OB-026
27	82057f54-4730-4d4a-a86c-16c71dfc5380	6347b29f-96e5-4886-ac37-66af7c072957	1	5d3da139-ddf6-430f-95f9-8705a4ce752b	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	dispatch	703b7074-b14c-4d0a-88b6-44158a7fd5f0	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	\N	\N	\N	\N	Dispatched on SHP-5001	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-10-30 14:30:00.062+00	2026-10-30 14:30:00.062+00	2026-11-21 21:32:14.987753+00	dispatch:a3c9c49b-ace4-40d8-b46e-54e54a2a1b91
28	82057f54-4730-4d4a-a86c-16c71dfc5380	4ef0a46d-e8ff-4c36-8d88-f7e9f789b804	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	dispatch	703b7074-b14c-4d0a-88b6-44158a7fd5f0	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	\N	\N	\N	\N	Dispatched on SHP-5001	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-10-30 14:30:00.065+00	2026-10-30 14:30:00.065+00	2026-11-21 21:32:14.987753+00	dispatch:55935304-8aef-4173-a184-db46111f6f24
29	82057f54-4730-4d4a-a86c-16c71dfc5380	7b804cd3-400b-401d-a270-8f439e96370a	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	dispatch	703b7074-b14c-4d0a-88b6-44158a7fd5f0	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	\N	\N	\N	\N	Dispatched on SHP-5001	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-10-30 14:30:00.069+00	2026-10-30 14:30:00.069+00	2026-11-21 21:32:14.987753+00	dispatch:340f2eff-2bb3-49df-8ffa-d2465dd23ddd
30	82057f54-4730-4d4a-a86c-16c71dfc5380	f6c15774-458d-4b23-8516-5334b95ef36f	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	dispatch	703b7074-b14c-4d0a-88b6-44158a7fd5f0	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	\N	\N	\N	\N	Dispatched on SHP-5001	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-10-30 14:30:00.071+00	2026-10-30 14:30:00.071+00	2026-11-21 21:32:14.987753+00	dispatch:c3b6a19d-ffb2-486e-9ac3-9ade2b50ac64
31	82057f54-4730-4d4a-a86c-16c71dfc5380	6347b29f-96e5-4886-ac37-66af7c072957	1	5d3da139-ddf6-430f-95f9-8705a4ce752b	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	2dd920a2-792c-4540-bc80-6a1b1185f37a	sealed	receive	703b7074-b14c-4d0a-88b6-44158a7fd5f0	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	\N	\N	\N	\N	Received on SHP-5001	ff8b05fb-2d7a-42af-9046-444b2c57f169	2026-10-30 17:00:00.009+00	2026-10-30 17:00:00.01+00	2026-11-21 21:32:15.080516+00	receive:a3c9c49b-ace4-40d8-b46e-54e54a2a1b91:1
32	82057f54-4730-4d4a-a86c-16c71dfc5380	4ef0a46d-e8ff-4c36-8d88-f7e9f789b804	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	2dd920a2-792c-4540-bc80-6a1b1185f37a	sealed	receive	703b7074-b14c-4d0a-88b6-44158a7fd5f0	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	\N	\N	\N	\N	Received on SHP-5001	ff8b05fb-2d7a-42af-9046-444b2c57f169	2026-10-30 17:00:00.009+00	2026-10-30 17:00:00.011+00	2026-11-21 21:32:15.080516+00	receive:55935304-8aef-4173-a184-db46111f6f24:1
33	82057f54-4730-4d4a-a86c-16c71dfc5380	7b804cd3-400b-401d-a270-8f439e96370a	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	2dd920a2-792c-4540-bc80-6a1b1185f37a	sealed	receive	703b7074-b14c-4d0a-88b6-44158a7fd5f0	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	\N	\N	\N	\N	Received on SHP-5001	ff8b05fb-2d7a-42af-9046-444b2c57f169	2026-10-30 17:00:00.009+00	2026-10-30 17:00:00.012+00	2026-11-21 21:32:15.080516+00	receive:340f2eff-2bb3-49df-8ffa-d2465dd23ddd:1
34	82057f54-4730-4d4a-a86c-16c71dfc5380	f6c15774-458d-4b23-8516-5334b95ef36f	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	2dd920a2-792c-4540-bc80-6a1b1185f37a	sealed	receive	703b7074-b14c-4d0a-88b6-44158a7fd5f0	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	\N	\N	\N	\N	Received on SHP-5001	ff8b05fb-2d7a-42af-9046-444b2c57f169	2026-10-30 17:00:00.009+00	2026-10-30 17:00:00.013+00	2026-11-21 21:32:15.080516+00	receive:c3b6a19d-ffb2-486e-9ac3-9ade2b50ac64:1
35	82057f54-4730-4d4a-a86c-16c71dfc5380	7b804cd3-400b-401d-a270-8f439e96370a	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	2dd920a2-792c-4540-bc80-6a1b1185f37a	sealed	c10806b8-a9b3-49ea-a281-a5754e694282	used	consume	\N	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	d13b84c1-a8b8-41ed-9f2e-87b40c9ec823	\N	\N	\N	Implanted in case SYN-0901	679a78ec-76fe-4700-b459-b9f4d0c6dda2	2026-10-31 15:30:00.003+00	2026-10-31 15:30:00.008+00	2026-11-21 21:32:15.130778+00	usage:d13b84c1-a8b8-41ed-9f2e-87b40c9ec823
36	82057f54-4730-4d4a-a86c-16c71dfc5380	4ef0a46d-e8ff-4c36-8d88-f7e9f789b804	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	2dd920a2-792c-4540-bc80-6a1b1185f37a	sealed	c10806b8-a9b3-49ea-a281-a5754e694282	used	consume	\N	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	d646f2ed-d67a-4019-88e5-27e5ff405706	\N	\N	\N	Implanted in case SYN-0901	679a78ec-76fe-4700-b459-b9f4d0c6dda2	2026-10-31 15:30:00.017+00	2026-10-31 15:30:00.021+00	2026-11-21 21:32:15.130778+00	usage:d646f2ed-d67a-4019-88e5-27e5ff405706
37	82057f54-4730-4d4a-a86c-16c71dfc5380	f6c15774-458d-4b23-8516-5334b95ef36f	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	2dd920a2-792c-4540-bc80-6a1b1185f37a	sealed	c10806b8-a9b3-49ea-a281-a5754e694282	used	consume	\N	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	7f774264-ce43-41d3-be09-c017e47d47f2	\N	\N	\N	Implanted in case SYN-0901	679a78ec-76fe-4700-b459-b9f4d0c6dda2	2026-10-31 15:30:00.029+00	2026-10-31 15:30:00.032+00	2026-11-21 21:32:15.130778+00	usage:7f774264-ce43-41d3-be09-c017e47d47f2
38	82057f54-4730-4d4a-a86c-16c71dfc5380	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	1	5d3da139-ddf6-430f-95f9-8705a4ce752b	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	dispatch	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	555a2002-df45-4f75-a01c-a237a8347b4c	\N	\N	\N	\N	Dispatched on SHP-5002	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-09 02:30:00.033+00	2026-11-09 02:30:00.033+00	2026-11-21 21:32:15.228427+00	dispatch:40f6bf06-8e0b-42e3-a2b2-9d11d188af07
39	82057f54-4730-4d4a-a86c-16c71dfc5380	bfeb5892-4fb4-465f-b784-24df21fed08a	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	dispatch	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	555a2002-df45-4f75-a01c-a237a8347b4c	\N	\N	\N	\N	Dispatched on SHP-5002	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-09 02:30:00.035+00	2026-11-09 02:30:00.035+00	2026-11-21 21:32:15.228427+00	dispatch:ac7d491f-1bd0-417d-af69-d9a701b3f162
40	82057f54-4730-4d4a-a86c-16c71dfc5380	bb2e661b-b202-47a4-8c71-b06f6d0bee8a	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	dispatch	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	555a2002-df45-4f75-a01c-a237a8347b4c	\N	\N	\N	\N	Dispatched on SHP-5002	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-09 02:30:00.036+00	2026-11-09 02:30:00.036+00	2026-11-21 21:32:15.228427+00	dispatch:d0ee40b8-b3f6-456b-944d-8af5260c6fa7
41	82057f54-4730-4d4a-a86c-16c71dfc5380	eb949393-b146-40b3-9e5e-6135546fdc2d	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	dispatch	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	555a2002-df45-4f75-a01c-a237a8347b4c	\N	\N	\N	\N	Dispatched on SHP-5002	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-09 02:30:00.037+00	2026-11-09 02:30:00.037+00	2026-11-21 21:32:15.228427+00	dispatch:f61daaec-ffb8-4994-81c1-fce511c8f45e
42	82057f54-4730-4d4a-a86c-16c71dfc5380	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	1	5d3da139-ddf6-430f-95f9-8705a4ce752b	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	2dd920a2-792c-4540-bc80-6a1b1185f37a	sealed	receive	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	555a2002-df45-4f75-a01c-a237a8347b4c	\N	\N	\N	\N	Received on SHP-5002	ff8b05fb-2d7a-42af-9046-444b2c57f169	2026-11-09 05:00:00.006+00	2026-11-09 05:00:00.006+00	2026-11-21 21:32:15.280055+00	receive:40f6bf06-8e0b-42e3-a2b2-9d11d188af07:1
43	82057f54-4730-4d4a-a86c-16c71dfc5380	bfeb5892-4fb4-465f-b784-24df21fed08a	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	2dd920a2-792c-4540-bc80-6a1b1185f37a	sealed	receive	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	555a2002-df45-4f75-a01c-a237a8347b4c	\N	\N	\N	\N	Received on SHP-5002	ff8b05fb-2d7a-42af-9046-444b2c57f169	2026-11-09 05:00:00.006+00	2026-11-09 05:00:00.008+00	2026-11-21 21:32:15.280055+00	receive:ac7d491f-1bd0-417d-af69-d9a701b3f162:1
44	82057f54-4730-4d4a-a86c-16c71dfc5380	bb2e661b-b202-47a4-8c71-b06f6d0bee8a	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	2dd920a2-792c-4540-bc80-6a1b1185f37a	sealed	receive	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	555a2002-df45-4f75-a01c-a237a8347b4c	\N	\N	\N	\N	Received on SHP-5002	ff8b05fb-2d7a-42af-9046-444b2c57f169	2026-11-09 05:00:00.006+00	2026-11-09 05:00:00.009+00	2026-11-21 21:32:15.280055+00	receive:d0ee40b8-b3f6-456b-944d-8af5260c6fa7:1
45	82057f54-4730-4d4a-a86c-16c71dfc5380	eb949393-b146-40b3-9e5e-6135546fdc2d	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	2dd920a2-792c-4540-bc80-6a1b1185f37a	sealed	receive	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	555a2002-df45-4f75-a01c-a237a8347b4c	\N	\N	\N	\N	Received on SHP-5002	ff8b05fb-2d7a-42af-9046-444b2c57f169	2026-11-09 05:00:00.006+00	2026-11-09 05:00:00.011+00	2026-11-21 21:32:15.280055+00	receive:f61daaec-ffb8-4994-81c1-fce511c8f45e:1
46	82057f54-4730-4d4a-a86c-16c71dfc5380	bb2e661b-b202-47a4-8c71-b06f6d0bee8a	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	2dd920a2-792c-4540-bc80-6a1b1185f37a	sealed	c10806b8-a9b3-49ea-a281-a5754e694282	used	consume	\N	555a2002-df45-4f75-a01c-a237a8347b4c	ef38dd1e-1795-408b-857c-c4d10c30d45d	\N	\N	\N	Implanted in case SYN-0902	679a78ec-76fe-4700-b459-b9f4d0c6dda2	2026-11-09 16:30:00.003+00	2026-11-09 16:30:00.007+00	2026-11-21 21:32:15.31639+00	usage:ef38dd1e-1795-408b-857c-c4d10c30d45d
47	82057f54-4730-4d4a-a86c-16c71dfc5380	bfeb5892-4fb4-465f-b784-24df21fed08a	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	2dd920a2-792c-4540-bc80-6a1b1185f37a	sealed	c10806b8-a9b3-49ea-a281-a5754e694282	used	consume	\N	555a2002-df45-4f75-a01c-a237a8347b4c	5c6dbf1d-3171-4ab7-8a0e-108f3ab8c170	\N	\N	\N	Implanted in case SYN-0902	679a78ec-76fe-4700-b459-b9f4d0c6dda2	2026-11-09 16:30:00.014+00	2026-11-09 16:30:00.017+00	2026-11-21 21:32:15.31639+00	usage:5c6dbf1d-3171-4ab7-8a0e-108f3ab8c170
48	82057f54-4730-4d4a-a86c-16c71dfc5380	eb949393-b146-40b3-9e5e-6135546fdc2d	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	2dd920a2-792c-4540-bc80-6a1b1185f37a	sealed	c10806b8-a9b3-49ea-a281-a5754e694282	used	consume	\N	555a2002-df45-4f75-a01c-a237a8347b4c	e26cebb0-5047-4dec-b57f-9d1f991b7e2f	\N	\N	\N	Implanted in case SYN-0902	679a78ec-76fe-4700-b459-b9f4d0c6dda2	2026-11-09 16:30:00.023+00	2026-11-09 16:30:00.026+00	2026-11-21 21:32:15.31639+00	usage:e26cebb0-5047-4dec-b57f-9d1f991b7e2f
49	82057f54-4730-4d4a-a86c-16c71dfc5380	c28c3811-bd2d-4fb8-a390-b815162fba25	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	dispatch	e6528bef-e34f-4551-9e97-204bee72d399	964622f1-c4fa-4547-8b0a-2b8334c6d297	\N	\N	\N	\N	Dispatched on SHP-5003	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-14 04:30:00.029+00	2026-11-14 04:30:00.029+00	2026-11-21 21:32:15.390714+00	dispatch:d3de0e17-3a38-41bc-a256-ff4ff04cebe7
50	82057f54-4730-4d4a-a86c-16c71dfc5380	4dd05f15-7329-433d-aacd-2ebc86ee4e44	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	dispatch	e6528bef-e34f-4551-9e97-204bee72d399	964622f1-c4fa-4547-8b0a-2b8334c6d297	\N	\N	\N	\N	Dispatched on SHP-5003	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-14 04:30:00.033+00	2026-11-14 04:30:00.033+00	2026-11-21 21:32:15.390714+00	dispatch:caf2b859-288a-41db-bac2-556aca6c047d
51	82057f54-4730-4d4a-a86c-16c71dfc5380	6b82bbc6-7246-48d8-92b8-f6ba4f755942	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	dispatch	e6528bef-e34f-4551-9e97-204bee72d399	964622f1-c4fa-4547-8b0a-2b8334c6d297	\N	\N	\N	\N	Dispatched on SHP-5003	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-14 04:30:00.036+00	2026-11-14 04:30:00.036+00	2026-11-21 21:32:15.390714+00	dispatch:78328bf8-3046-44e7-bf2a-bea06474784e
52	82057f54-4730-4d4a-a86c-16c71dfc5380	6347b29f-96e5-4886-ac37-66af7c072957	1	5d3da139-ddf6-430f-95f9-8705a4ce752b	2dd920a2-792c-4540-bc80-6a1b1185f37a	sealed	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	dispatch	c5c70cc5-9c4d-451a-8b3f-f7339eb110ff	964622f1-c4fa-4547-8b0a-2b8334c6d297	\N	\N	\N	\N	Dispatched on SHP-5004	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-14 04:30:00.067+00	2026-11-14 04:30:00.067+00	2026-11-21 21:32:15.433938+00	dispatch:d32c71a0-96e7-4b09-bd22-fea9dd5d7077
53	82057f54-4730-4d4a-a86c-16c71dfc5380	c28c3811-bd2d-4fb8-a390-b815162fba25	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	sealed	receive	e6528bef-e34f-4551-9e97-204bee72d399	964622f1-c4fa-4547-8b0a-2b8334c6d297	\N	\N	\N	\N	Received on SHP-5003	79fe508f-120a-412e-9736-0cf2c80e484e	2026-11-14 07:00:00.005+00	2026-11-14 07:00:00.005+00	2026-11-21 21:32:15.483701+00	receive:d3de0e17-3a38-41bc-a256-ff4ff04cebe7:1
54	82057f54-4730-4d4a-a86c-16c71dfc5380	4dd05f15-7329-433d-aacd-2ebc86ee4e44	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	sealed	receive	e6528bef-e34f-4551-9e97-204bee72d399	964622f1-c4fa-4547-8b0a-2b8334c6d297	\N	\N	\N	\N	Received on SHP-5003	79fe508f-120a-412e-9736-0cf2c80e484e	2026-11-14 07:00:00.005+00	2026-11-14 07:00:00.007+00	2026-11-21 21:32:15.483701+00	receive:caf2b859-288a-41db-bac2-556aca6c047d:1
55	82057f54-4730-4d4a-a86c-16c71dfc5380	6b82bbc6-7246-48d8-92b8-f6ba4f755942	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	sealed	receive	e6528bef-e34f-4551-9e97-204bee72d399	964622f1-c4fa-4547-8b0a-2b8334c6d297	\N	\N	\N	\N	Received on SHP-5003	79fe508f-120a-412e-9736-0cf2c80e484e	2026-11-14 07:00:00.005+00	2026-11-14 07:00:00.008+00	2026-11-21 21:32:15.483701+00	receive:78328bf8-3046-44e7-bf2a-bea06474784e:1
56	82057f54-4730-4d4a-a86c-16c71dfc5380	6347b29f-96e5-4886-ac37-66af7c072957	1	5d3da139-ddf6-430f-95f9-8705a4ce752b	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	sealed	receive	c5c70cc5-9c4d-451a-8b3f-f7339eb110ff	964622f1-c4fa-4547-8b0a-2b8334c6d297	\N	\N	\N	\N	Received on SHP-5004	79fe508f-120a-412e-9736-0cf2c80e484e	2026-11-14 07:00:00.018+00	2026-11-14 07:00:00.018+00	2026-11-21 21:32:15.495452+00	receive:d32c71a0-96e7-4b09-bd22-fea9dd5d7077:1
57	82057f54-4730-4d4a-a86c-16c71dfc5380	4dd05f15-7329-433d-aacd-2ebc86ee4e44	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	sealed	c10806b8-a9b3-49ea-a281-a5754e694282	used	consume	\N	964622f1-c4fa-4547-8b0a-2b8334c6d297	991ae806-5429-4fc1-8a43-0f5c7bee747e	\N	\N	\N	Implanted in case SYN-0903	cee93967-cedb-4428-87c4-e090c376edf7	2026-11-15 15:30:00.002+00	2026-11-15 15:30:00.004+00	2026-11-21 21:32:15.529599+00	usage:991ae806-5429-4fc1-8a43-0f5c7bee747e
58	82057f54-4730-4d4a-a86c-16c71dfc5380	c28c3811-bd2d-4fb8-a390-b815162fba25	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	sealed	c10806b8-a9b3-49ea-a281-a5754e694282	used	consume	\N	964622f1-c4fa-4547-8b0a-2b8334c6d297	3a597841-ea78-47f5-b5dd-46f98a8f4d22	\N	\N	\N	Implanted in case SYN-0903	cee93967-cedb-4428-87c4-e090c376edf7	2026-11-15 15:30:00.009+00	2026-11-15 15:30:00.011+00	2026-11-21 21:32:15.529599+00	usage:3a597841-ea78-47f5-b5dd-46f98a8f4d22
59	82057f54-4730-4d4a-a86c-16c71dfc5380	6b82bbc6-7246-48d8-92b8-f6ba4f755942	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	sealed	c10806b8-a9b3-49ea-a281-a5754e694282	used	consume	\N	964622f1-c4fa-4547-8b0a-2b8334c6d297	27f5b7e7-e6f5-4434-9b0f-7a0806ec0791	\N	\N	\N	Implanted in case SYN-0903	cee93967-cedb-4428-87c4-e090c376edf7	2026-11-15 15:30:00.015+00	2026-11-15 15:30:00.017+00	2026-11-21 21:32:15.529599+00	usage:27f5b7e7-e6f5-4434-9b0f-7a0806ec0791
60	82057f54-4730-4d4a-a86c-16c71dfc5380	6347b29f-96e5-4886-ac37-66af7c072957	1	5d3da139-ddf6-430f-95f9-8705a4ce752b	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	sealed	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	dispatch	74c82176-4d43-4aae-9cdd-298a7990fd8d	\N	\N	\N	\N	\N	Dispatched on RTN-5005	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-18 21:00:00.017+00	2026-11-18 21:00:00.017+00	2026-11-21 21:32:15.558274+00	dispatch:4c2cef40-4ad6-4b2d-a421-163c6cf1e48f
61	82057f54-4730-4d4a-a86c-16c71dfc5380	6347b29f-96e5-4886-ac37-66af7c072957	1	5d3da139-ddf6-430f-95f9-8705a4ce752b	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	receive	74c82176-4d43-4aae-9cdd-298a7990fd8d	\N	\N	\N	\N	\N	Received on RTN-5005	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-18 21:00:00.03+00	2026-11-18 21:00:00.031+00	2026-11-21 21:32:15.581689+00	receive:4c2cef40-4ad6-4b2d-a421-163c6cf1e48f:1
62	82057f54-4730-4d4a-a86c-16c71dfc5380	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	1	5d3da139-ddf6-430f-95f9-8705a4ce752b	2dd920a2-792c-4540-bc80-6a1b1185f37a	sealed	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	dispatch	d5df80c0-93e8-4961-a305-fd5d1f1c266f	\N	\N	\N	\N	\N	Dispatched on RTN-5006	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-18 21:00:00.019+00	2026-11-18 21:00:00.019+00	2026-11-21 21:32:15.608597+00	dispatch:53846dd2-3313-44ab-bdf3-167b8466c28f
63	82057f54-4730-4d4a-a86c-16c71dfc5380	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	1	5d3da139-ddf6-430f-95f9-8705a4ce752b	c93683f7-5db8-40f9-a4fb-839e2a79bb54	sealed	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	receive	d5df80c0-93e8-4961-a305-fd5d1f1c266f	\N	\N	\N	\N	\N	Received on RTN-5006	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-18 21:00:00.031+00	2026-11-18 21:00:00.031+00	2026-11-21 21:32:15.632501+00	receive:53846dd2-3313-44ab-bdf3-167b8466c28f:1
64	82057f54-4730-4d4a-a86c-16c71dfc5380	7103687d-adc4-4ebe-8137-4dcc005ddf40	1	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	241007a7-e552-4c9d-903e-dd625ca691fe	sealed	\N	\N	adjustment	\N	\N	\N	\N	8b29aef8-56de-490a-994d-2ae306d55fdd	\N	Approved cycle count adjustment (-1): Recount confirmed 19 screws; one unit unaccounted (synthetic)	96730663-96b5-4d44-919e-f3965640e7a4	2026-11-16 16:00:00.041+00	2026-11-16 16:00:00.041+00	2026-11-21 21:32:15.656794+00	count:fc4c52e7-d492-4224-8208-3c15d28ded9e
\.


--
-- Data for Name: locations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.locations (id, tenant_id, code, name, kind, facility_id, holder_user_id, allocatable) FROM stdin;
241007a7-e552-4c9d-903e-dd625ca691fe	82057f54-4730-4d4a-a86c-16c71dfc5380	WH-MAIN	Central warehouse, main stock	warehouse	6fa799b7-1b16-461f-8723-063edb00435a	\N	t
4b185ebc-25d9-4436-a72b-f59da32f7fa1	82057f54-4730-4d4a-a86c-16c71dfc5380	WH-QUAR	Warehouse quarantine cage	quarantine	6fa799b7-1b16-461f-8723-063edb00435a	\N	f
6123d691-c0ba-4b6d-a36e-43d23dd295c1	82057f54-4730-4d4a-a86c-16c71dfc5380	RETURNS	Returns to manufacturer	returns	6fa799b7-1b16-461f-8723-063edb00435a	\N	f
c93683f7-5db8-40f9-a4fb-839e2a79bb54	82057f54-4730-4d4a-a86c-16c71dfc5380	IN-TRANSIT	In transit (courier / rep custody)	in_transit	\N	\N	f
c10806b8-a9b3-49ea-a281-a5754e694282	82057f54-4730-4d4a-a86c-16c71dfc5380	CONSUMED	Implanted / consumed	consumed	\N	\N	f
5a870f87-2b4b-44ef-bb2e-6acccdb05687	82057f54-4730-4d4a-a86c-16c71dfc5380	WASTED	Wasted (opened, not implanted)	wasted	\N	\N	f
8a8b4b0f-a407-4107-a50c-97f5e8f56f6e	82057f54-4730-4d4a-a86c-16c71dfc5380	MISSING	Missing - under investigation	missing	\N	\N	f
b23f2359-decb-4d53-93f3-bb8302fc166d	82057f54-4730-4d4a-a86c-16c71dfc5380	TRUNK-RILEY	Riley Novak trunk stock	trunk	\N	679a78ec-76fe-4700-b459-b9f4d0c6dda2	t
77a7aee8-8b25-4d85-8409-df3cddee5d55	82057f54-4730-4d4a-a86c-16c71dfc5380	TRUNK-JORDAN	Jordan Ames trunk stock	trunk	\N	cee93967-cedb-4428-87c4-e090c376edf7	t
2dd920a2-792c-4540-bc80-6a1b1185f37a	82057f54-4730-4d4a-a86c-16c71dfc5380	SBR-RECV	St. Brigid receiving / SPD intake	hospital_receiving	61d14381-fb23-4f39-91d4-3901a30558b1	\N	t
a8cd43ec-3428-4c61-8cde-f343d65d11f6	82057f54-4730-4d4a-a86c-16c71dfc5380	SBR-CONSIGN	St. Brigid consignment cabinet	consignment	61d14381-fb23-4f39-91d4-3901a30558b1	\N	t
a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	82057f54-4730-4d4a-a86c-16c71dfc5380	PVS-RECV	Prairie Valley receiving	hospital_receiving	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	\N	t
d8861e84-bb5d-4b80-9cad-a2568ef1fdd3	82057f54-4730-4d4a-a86c-16c71dfc5380	PVS-CONSIGN	Prairie Valley consignment (hospital-owned)	consignment	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	\N	t
9d8089d9-053a-4d6a-b0f4-1b5c9565a19f	bdc0230c-75cb-47f1-bc8b-f13ddb1aa1b8	RW-WH	Ridgeway warehouse	warehouse	\N	\N	t
7875d4f1-977d-4a93-8228-849bcde27683	bdc0230c-75cb-47f1-bc8b-f13ddb1aa1b8	RW-TRANSIT	In transit	in_transit	\N	\N	f
3ad64232-d9cc-49f2-bb60-88aa950d6ad6	bdc0230c-75cb-47f1-bc8b-f13ddb1aa1b8	RW-CONSUMED	Consumed	consumed	\N	\N	f
6da5ad57-08d2-4962-825d-c3cc72ff48a9	bdc0230c-75cb-47f1-bc8b-f13ddb1aa1b8	HPM-RECV	Harbor Point receiving	hospital_receiving	346ce5f9-2e84-4d97-a571-227b24b82026	\N	t
\.


--
-- Data for Name: notifications; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notifications (id, tenant_id, user_id, case_id, facility_id, kind, message, created_at, read_at, dedupe_key) FROM stdin;
0c021516-aa7f-4fe9-9b8e-68d522452641	82057f54-4730-4d4a-a86c-16c71dfc5380	679a78ec-76fe-4700-b459-b9f4d0c6dda2	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	61d14381-fb23-4f39-91d4-3901a30558b1	case_assigned	Case SYN-0901 assigned at St. Brigid Regional Medical Center (synthetic)	2026-10-29 10:30:00.006+00	\N	assign:a7db2c99-3cc1-467e-9896-2dd3bf1a32fa
6f526811-a42b-450f-8f3d-a2661a31fabc	82057f54-4730-4d4a-a86c-16c71dfc5380	ff8b05fb-2d7a-42af-9046-444b2c57f169	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	61d14381-fb23-4f39-91d4-3901a30558b1	delivery	SHP-5001 delivered to receiving for case SYN-0901; please check in and verify.	2026-10-30 16:30:00.005+00	\N	delivered:703b7074-b14c-4d0a-88b6-44158a7fd5f0
1cceb9dc-1372-40eb-80bd-a72eeca4fa92	82057f54-4730-4d4a-a86c-16c71dfc5380	679a78ec-76fe-4700-b459-b9f4d0c6dda2	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	61d14381-fb23-4f39-91d4-3901a30558b1	release	St. Brigid Regional Medical Center (synthetic) recorded "released" for case SYN-0901	2026-10-30 19:30:00.006+00	\N	rel:92739e72-021a-4c8c-b73f-41de55592375
b660bbb8-c174-47f4-9bea-ae41bfdd3c51	82057f54-4730-4d4a-a86c-16c71dfc5380	ca201980-0055-472e-aa6d-b430c55ce512	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	61d14381-fb23-4f39-91d4-3901a30558b1	closeout	Closeout submitted for SYN-0901	2026-10-31 15:54:00.008+00	\N	closeout:a7db2c99-3cc1-467e-9896-2dd3bf1a32fa
5f52de9e-5757-41eb-b50a-c7b04b388608	82057f54-4730-4d4a-a86c-16c71dfc5380	679a78ec-76fe-4700-b459-b9f4d0c6dda2	555a2002-df45-4f75-a01c-a237a8347b4c	61d14381-fb23-4f39-91d4-3901a30558b1	case_assigned	Case SYN-0902 assigned at St. Brigid Regional Medical Center (synthetic)	2026-11-07 11:30:00.004+00	\N	assign:555a2002-df45-4f75-a01c-a237a8347b4c
0538da20-9fb5-46d2-8020-8d9be10079ec	82057f54-4730-4d4a-a86c-16c71dfc5380	ff8b05fb-2d7a-42af-9046-444b2c57f169	555a2002-df45-4f75-a01c-a237a8347b4c	61d14381-fb23-4f39-91d4-3901a30558b1	delivery	SHP-5002 delivered to receiving for case SYN-0902; please check in and verify.	2026-11-09 04:30:00.003+00	\N	delivered:8b65b15d-d2b7-48f3-b8a5-fad100a73cdb
4ffe310d-72a4-4eda-9412-7bbd6f6cdd39	82057f54-4730-4d4a-a86c-16c71dfc5380	679a78ec-76fe-4700-b459-b9f4d0c6dda2	555a2002-df45-4f75-a01c-a237a8347b4c	61d14381-fb23-4f39-91d4-3901a30558b1	release	St. Brigid Regional Medical Center (synthetic) recorded "released" for case SYN-0902	2026-11-09 07:30:00.003+00	\N	rel:baeff7b1-c949-44b3-9741-334b6bbdc820
21b7968e-2db2-42bf-80fb-ec04ce37122e	82057f54-4730-4d4a-a86c-16c71dfc5380	ca201980-0055-472e-aa6d-b430c55ce512	555a2002-df45-4f75-a01c-a237a8347b4c	61d14381-fb23-4f39-91d4-3901a30558b1	closeout	Closeout submitted for SYN-0902	2026-11-09 16:54:00.005+00	\N	closeout:555a2002-df45-4f75-a01c-a237a8347b4c
fd6b71ec-e78c-40ab-8184-bde810697282	82057f54-4730-4d4a-a86c-16c71dfc5380	cee93967-cedb-4428-87c4-e090c376edf7	964622f1-c4fa-4547-8b0a-2b8334c6d297	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	case_assigned	Case SYN-0903 assigned at Prairie Valley Surgical Hospital (synthetic)	2026-11-13 10:30:00.004+00	\N	assign:964622f1-c4fa-4547-8b0a-2b8334c6d297
3a1a7d93-8ba5-4269-8abe-709f645380dc	82057f54-4730-4d4a-a86c-16c71dfc5380	79fe508f-120a-412e-9736-0cf2c80e484e	964622f1-c4fa-4547-8b0a-2b8334c6d297	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	delivery	SHP-5003 delivered to receiving for case SYN-0903; please check in and verify.	2026-11-14 06:30:00.003+00	\N	delivered:e6528bef-e34f-4551-9e97-204bee72d399
de744dc0-b0f2-408d-ab8d-f40abc6e83f4	82057f54-4730-4d4a-a86c-16c71dfc5380	79fe508f-120a-412e-9736-0cf2c80e484e	964622f1-c4fa-4547-8b0a-2b8334c6d297	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	delivery	SHP-5004 delivered to receiving for case SYN-0903; please check in and verify.	2026-11-14 06:30:00.012+00	\N	delivered:c5c70cc5-9c4d-451a-8b3f-f7339eb110ff
2d7df68e-59f3-4398-ab81-8d9fade1f204	82057f54-4730-4d4a-a86c-16c71dfc5380	cee93967-cedb-4428-87c4-e090c376edf7	964622f1-c4fa-4547-8b0a-2b8334c6d297	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	release	Prairie Valley Surgical Hospital (synthetic) recorded "released" for case SYN-0903	2026-11-14 09:30:00.002+00	\N	rel:aba7b87a-ab5d-469e-9853-f6d3220d4a94
ea15fa21-30d9-4407-b4ce-a6c277bec35f	82057f54-4730-4d4a-a86c-16c71dfc5380	ca201980-0055-472e-aa6d-b430c55ce512	964622f1-c4fa-4547-8b0a-2b8334c6d297	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	closeout	Closeout submitted for SYN-0903	2026-11-15 15:54:00.003+00	\N	closeout:964622f1-c4fa-4547-8b0a-2b8334c6d297
bdb411ba-321b-4c93-866e-1fac260f4eaa	82057f54-4730-4d4a-a86c-16c71dfc5380	679a78ec-76fe-4700-b459-b9f4d0c6dda2	ef2f1403-819a-4666-9d27-319fe05abcb4	61d14381-fb23-4f39-91d4-3901a30558b1	case_assigned	Case SYN-1003 assigned at St. Brigid Regional Medical Center (synthetic)	2026-11-20 12:00:00.006+00	\N	assign:ef2f1403-819a-4666-9d27-319fe05abcb4
9946c5be-53ca-439e-adbe-dc6e8b6dd0e7	82057f54-4730-4d4a-a86c-16c71dfc5380	679a78ec-76fe-4700-b459-b9f4d0c6dda2	bc5e78aa-c3bc-485a-b1e9-128710ceefe2	61d14381-fb23-4f39-91d4-3901a30558b1	case_assigned	Case SYN-1001 assigned at St. Brigid Regional Medical Center (synthetic)	2026-11-20 12:00:00.013+00	\N	assign:bc5e78aa-c3bc-485a-b1e9-128710ceefe2
306be8bf-388f-4095-92f5-b5795d50cfdf	82057f54-4730-4d4a-a86c-16c71dfc5380	cee93967-cedb-4428-87c4-e090c376edf7	a1debd32-5f14-4fbd-9b06-bfd21d0192cc	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	case_assigned	Case SYN-1002 assigned at Prairie Valley Surgical Hospital (synthetic)	2026-11-20 12:00:00.029+00	\N	assign:a1debd32-5f14-4fbd-9b06-bfd21d0192cc
\.


--
-- Data for Name: outbox; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.outbox (id, tenant_id, feed_code, topic, aggregate_id, payload, idempotency_key, status, attempts, next_attempt_at, last_error, created_at) FROM stdin;
35fa49f6-4e98-4fc4-8fa7-2e8761de928b	82057f54-4730-4d4a-a86c-16c71dfc5380	erp-mock	billing_packet.created	4a429300-39fb-4777-af50-9274c23f229e	{"lines": [{"lot": "L26C030", "qty": 1, "ref": "NP-INS-4-10", "serial": "INS-0010", "amount_cents": 118000, "unit_price_cents": 118000}, {"lot": "L26B110", "qty": 1, "ref": "NP-FEM-4L", "serial": "FEM4L-0102", "amount_cents": 345000, "unit_price_cents": 345000}, {"lot": "L26B210", "qty": 1, "ref": "NP-TIB-4", "serial": "TIB4-0202", "amount_cents": 215000, "unit_price_cents": 215000}], "case_ref": "SYN-0901", "net_cents": 678000, "packet_id": "4a429300-39fb-4777-af50-9274c23f229e", "packet_type": "bill_and_replace"}	packet:4a429300-39fb-4777-af50-9274c23f229e	acknowledged	1	2026-11-01 14:30:00.011+00	\N	2026-11-01 14:30:00.011+00
db096e8e-0b0d-4601-bf8f-2842261f39de	82057f54-4730-4d4a-a86c-16c71dfc5380	erp-mock	billing_packet.created	fa4a17bb-a68d-49bf-a794-ee91e6c1a2cf	{"lines": [{"lot": "L26C030", "qty": 1, "ref": "NP-INS-4-10", "serial": "INS-0011", "amount_cents": 118000, "unit_price_cents": 118000}, {"lot": "L26B110", "qty": 1, "ref": "NP-FEM-4L", "serial": "FEM4L-0103", "amount_cents": 345000, "unit_price_cents": 345000}, {"lot": "L26B210", "qty": 1, "ref": "NP-TIB-4", "serial": "TIB4-0203", "amount_cents": 215000, "unit_price_cents": 215000}], "case_ref": "SYN-0902", "net_cents": 678000, "packet_id": "fa4a17bb-a68d-49bf-a794-ee91e6c1a2cf", "packet_type": "bill_and_replace"}	packet:fa4a17bb-a68d-49bf-a794-ee91e6c1a2cf	acknowledged	1	2026-11-10 15:30:00.01+00	\N	2026-11-10 15:30:00.01+00
\.


--
-- Data for Name: outbox_attempts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.outbox_attempts (id, tenant_id, outbox_id, attempted_at, result, detail) FROM stdin;
98f4a8a4-842c-492d-bb0c-817551f2589d	82057f54-4730-4d4a-a86c-16c71dfc5380	35fa49f6-4e98-4fc4-8fa7-2e8761de928b	2026-11-01 14:30:00.014+00	delivered	{"message": "Simulated ERP stored the draft billing document. Not an invoice, not payment.", "accepted": true, "external_doc_ref": "SIM-ERP-A670C05DDE"}
21365def-42a4-4357-b934-68f63f8500b1	82057f54-4730-4d4a-a86c-16c71dfc5380	db096e8e-0b0d-4601-bf8f-2842261f39de	2026-11-10 15:30:00.012+00	delivered	{"message": "Simulated ERP stored the draft billing document. Not an invoice, not payment.", "accepted": true, "external_doc_ref": "SIM-ERP-331EAFF88D"}
\.


--
-- Data for Name: packages; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.packages (id, tenant_id, catalog_item_id, gtin, level, units_per_package, uom, source_system, source_id, import_batch_id) FROM stdin;
da45b39a-946c-4856-93d0-afccb21c3901	82057f54-4730-4d4a-a86c-16c71dfc5380	2d9010d1-af1c-479e-9bd8-9467cfc17ab4	10614141004017	inner	5	BX	NORTHPOINT-PRICEFILE-SIM	PK-1006-5	6db9fc8f-8ef6-4982-be8a-c2bac8f4c2d2
\.


--
-- Data for Name: parties; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.parties (id, tenant_id, name, kind, source_system, source_id) FROM stdin;
1b9d9abc-9dd9-441e-9ce3-66639e62ade9	82057f54-4730-4d4a-a86c-16c71dfc5380	Lakeshore Orthopedic Partners (synthetic)	distributor	\N	\N
5d3da139-ddf6-430f-95f9-8705a4ce752b	82057f54-4730-4d4a-a86c-16c71dfc5380	Northpoint Ortho Devices (synthetic)	manufacturer	\N	\N
4b25c513-cb3d-47b0-bd34-39668e64dd34	82057f54-4730-4d4a-a86c-16c71dfc5380	St. Brigid Regional Medical Center (synthetic)	hospital	\N	\N
f3506c6e-4e5e-4567-866c-679ddf43adaf	82057f54-4730-4d4a-a86c-16c71dfc5380	Prairie Valley Surgical Hospital (synthetic)	hospital	\N	\N
e2344977-ad3b-48c1-bd61-92da6d1b1155	bdc0230c-75cb-47f1-bc8b-f13ddb1aa1b8	Ridgeway Surgical Supply (synthetic)	distributor	\N	\N
88141981-f0dc-4b72-acb3-d4a7111fcb54	bdc0230c-75cb-47f1-bc8b-f13ddb1aa1b8	Other Spine Co (synthetic)	manufacturer	\N	\N
\.


--
-- Data for Name: preference_card_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.preference_card_lines (id, tenant_id, card_version_id, catalog_item_id, qty, mandatory, backup_for_line_id, note) FROM stdin;
3673104a-a504-411b-8327-368c0816bf03	82057f54-4730-4d4a-a86c-16c71dfc5380	5ced635f-eeb3-4d1f-81e7-7eaa49c5badd	d4bf7ed4-74a1-41d5-9480-5748c241727e	1	t	\N	\N
f268d88a-d916-4b43-a813-2a8d5d73b402	82057f54-4730-4d4a-a86c-16c71dfc5380	5ced635f-eeb3-4d1f-81e7-7eaa49c5badd	7d11617a-4813-4b5c-90f0-19626f5db56f	1	t	\N	\N
36f02806-8bed-44e2-9c44-e3c7d0d64d07	82057f54-4730-4d4a-a86c-16c71dfc5380	5ced635f-eeb3-4d1f-81e7-7eaa49c5badd	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	1	t	\N	\N
cb288207-3c1f-433b-a140-c74d2c4b84d2	82057f54-4730-4d4a-a86c-16c71dfc5380	5ced635f-eeb3-4d1f-81e7-7eaa49c5badd	b3c5ddcf-836f-4ccd-9f35-22d68099e076	1	t	\N	\N
4b90eb1c-0120-41aa-8f7b-ada09a6b490d	82057f54-4730-4d4a-a86c-16c71dfc5380	af012a71-1416-4254-b9e6-d9e25a61f521	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	1	t	\N	\N
637af985-62c1-4371-ac26-94750b20c8fc	82057f54-4730-4d4a-a86c-16c71dfc5380	af012a71-1416-4254-b9e6-d9e25a61f521	7d11617a-4813-4b5c-90f0-19626f5db56f	1	t	\N	\N
195f15a8-5f37-4df4-b9d9-84fcbbba7443	82057f54-4730-4d4a-a86c-16c71dfc5380	af012a71-1416-4254-b9e6-d9e25a61f521	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	1	t	\N	\N
727f1293-911b-4275-aa59-7d40ac16d23f	82057f54-4730-4d4a-a86c-16c71dfc5380	af012a71-1416-4254-b9e6-d9e25a61f521	b3c5ddcf-836f-4ccd-9f35-22d68099e076	1	t	\N	\N
10762058-8eef-4dc6-ba99-f90bca11e784	82057f54-4730-4d4a-a86c-16c71dfc5380	af012a71-1416-4254-b9e6-d9e25a61f521	d4bf7ed4-74a1-41d5-9480-5748c241727e	1	f	4b90eb1c-0120-41aa-8f7b-ada09a6b490d	\N
4bdcba2b-927a-4398-9a32-4427c3adc310	82057f54-4730-4d4a-a86c-16c71dfc5380	af012a71-1416-4254-b9e6-d9e25a61f521	f4e893f7-831e-40dd-89ce-1f79e2c1c9b0	1	f	637af985-62c1-4371-ac26-94750b20c8fc	\N
02cb7e78-1d15-4a46-8604-0eb6026cbadb	bdc0230c-75cb-47f1-bc8b-f13ddb1aa1b8	ef9c0086-53e3-4854-8766-cef8ff8a21de	b464f5cc-c551-4718-a0dd-526bd2e48ca1	1	t	\N	\N
\.


--
-- Data for Name: preference_card_versions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.preference_card_versions (id, tenant_id, card_id, version, status, approved_by, approved_at, change_note) FROM stdin;
5ced635f-eeb3-4d1f-81e7-7eaa49c5badd	82057f54-4730-4d4a-a86c-16c71dfc5380	93cd1399-6647-4577-8906-cf395b3cca47	1	superseded	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-10-12 14:00:00.152+00	Initial card
af012a71-1416-4254-b9e6-d9e25a61f521	82057f54-4730-4d4a-a86c-16c71dfc5380	93cd1399-6647-4577-8906-cf395b3cca47	2	approved	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-10-12 14:00:00.153+00	Surgeon office confirmed 10 mm insert as primary; 12 mm as backup
d215332f-346c-424c-ad0f-1a0e0ad87932	82057f54-4730-4d4a-a86c-16c71dfc5380	93cd1399-6647-4577-8906-cf395b3cca47	3	draft	\N	\N	Proposed: add 2 bone screws (awaiting approval)
ef9c0086-53e3-4854-8766-cef8ff8a21de	bdc0230c-75cb-47f1-bc8b-f13ddb1aa1b8	5f26100a-5cbf-4124-9d6d-af2a9f18d66e	1	approved	6036f218-b42b-4b37-a0ea-9568c11d4562	2026-11-21 14:00:00.003+00	\N
\.


--
-- Data for Name: preference_cards; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.preference_cards (id, tenant_id, code, surgeon_ref, procedure) FROM stdin;
93cd1399-6647-4577-8906-cf395b3cca47	82057f54-4730-4d4a-a86c-16c71dfc5380	PC-KNEE-S104	Surgeon S-104 (synthetic)	Total knee arthroplasty, primary, left
5f26100a-5cbf-4124-9d6d-af2a9f18d66e	bdc0230c-75cb-47f1-bc8b-f13ddb1aa1b8	RW-PC-1	Surgeon R-9 (synthetic)	Lumbar fusion
\.


--
-- Data for Name: purchase_order_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.purchase_order_lines (id, tenant_id, po_id, catalog_item_id, qty, unit_price_cents) FROM stdin;
667c5a99-b0f2-4f2e-b780-cec7302a7c16	82057f54-4730-4d4a-a86c-16c71dfc5380	03d097db-7ce4-43ce-9fac-f81e9a24f283	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	1	215000
46a3a972-df27-496b-b3ec-8608501ff44b	82057f54-4730-4d4a-a86c-16c71dfc5380	03d097db-7ce4-43ce-9fac-f81e9a24f283	7d11617a-4813-4b5c-90f0-19626f5db56f	1	345000
c256a779-64e6-4a86-a452-35390a66559f	82057f54-4730-4d4a-a86c-16c71dfc5380	03d097db-7ce4-43ce-9fac-f81e9a24f283	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	1	118000
\.


--
-- Data for Name: purchase_orders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.purchase_orders (id, tenant_id, packet_id, po_number, entered_by, entered_at, match_status, match_detail) FROM stdin;
03d097db-7ce4-43ce-9fac-f81e9a24f283	82057f54-4730-4d4a-a86c-16c71dfc5380	4a429300-39fb-4777-af50-9274c23f229e	SYN-PO-70001	ca201980-0055-472e-aa6d-b430c55ce512	2026-11-04 12:30:00.004+00	matched	{"issues": []}
\.


--
-- Data for Name: quality_holds; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.quality_holds (id, tenant_id, stock_item_id, recall_id, reason, status, placed_by, placed_at, released_by, released_at) FROM stdin;
3d9753af-982b-4301-86c8-660f1af01b66	82057f54-4730-4d4a-a86c-16c71dfc5380	524e48bc-002b-41f5-bb86-f331d2bd97dd	\N	Packaging damage investigation QH-0042 (synthetic)	active	2087cb4c-c6f4-4939-9f1a-e9a6978536e2	2026-11-20 12:00:00.002+00	\N	\N
\.


--
-- Data for Name: recall_tasks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.recall_tasks (id, tenant_id, recall_id, task_type, stock_item_id, location_id, case_id, usage_event_id, owner_user_id, qty, status, acknowledged_by, acknowledged_at, disposition, dispositioned_by, dispositioned_at, detail, created_at) FROM stdin;
\.


--
-- Data for Name: recalls; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.recalls (id, tenant_id, ref, manufacturer_party_id, catalog_item_id, scope_type, scope_values, manufacturer_notice_ref, description, status, entered_by, entered_at, verified_by, verified_at, activated_by, activated_at, closed_by, closed_at, closure_evidence) FROM stdin;
\.


--
-- Data for Name: release_decisions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.release_decisions (id, tenant_id, case_id, facility_id, tray_stock_item_id, decision, evidence, statement, recorded_by, recorded_at) FROM stdin;
92739e72-021a-4c8c-b73f-41de55592375	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	61d14381-fb23-4f39-91d4-3901a30558b1	6347b29f-96e5-4886-ac37-66af7c072957	released	{"loaner_count_sheet_ref": "SYN-CS-1", "hospital_processing_record_ref": "SYN-LOAD-101"}	Release decision recorded by authorized hospital personnel. Tracewell stores this decision and the evidence references provided; it does not determine sterility or provide clinical clearance.	703a5c38-b16a-4fa9-bef8-4381b8b2160d	2026-10-30 19:30:00.004+00
baeff7b1-c949-44b3-9741-334b6bbdc820	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	61d14381-fb23-4f39-91d4-3901a30558b1	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	released	{"loaner_count_sheet_ref": "SYN-CS-2", "hospital_processing_record_ref": "SYN-LOAD-202"}	Release decision recorded by authorized hospital personnel. Tracewell stores this decision and the evidence references provided; it does not determine sterility or provide clinical clearance.	703a5c38-b16a-4fa9-bef8-4381b8b2160d	2026-11-09 07:30:00.002+00
aba7b87a-ab5d-469e-9853-f6d3220d4a94	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	6347b29f-96e5-4886-ac37-66af7c072957	released	{"loaner_count_sheet_ref": "SYN-CS-3", "hospital_processing_record_ref": "SYN-LOAD-303"}	Release decision recorded by authorized hospital personnel. Tracewell stores this decision and the evidence references provided; it does not determine sterility or provide clinical clearance.	4cc78ada-2732-4d58-b120-2e69660af354	2026-11-14 09:30:00.002+00
\.


--
-- Data for Name: replenishments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.replenishments (id, tenant_id, case_id, usage_event_id, catalog_item_id, qty, action, status, rationale, created_at) FROM stdin;
4b71b2d4-adfb-4cd8-9056-80f3ba662c60	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	d13b84c1-a8b8-41ed-9f2e-87b40c9ec823	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	1	replace	open	Bill and replace: replenishment "replace" for implanted	2026-10-31 15:30:00.015+00
3c747c49-b1da-40cf-aeb5-49112507333a	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	d646f2ed-d67a-4019-88e5-27e5ff405706	7d11617a-4813-4b5c-90f0-19626f5db56f	1	replace	open	Bill and replace: replenishment "replace" for implanted	2026-10-31 15:30:00.026+00
8b4e1f29-6cf9-4704-9b0e-6bc1e423830c	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	7f774264-ce43-41d3-be09-c017e47d47f2	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	1	replace	open	Bill and replace: replenishment "replace" for implanted	2026-10-31 15:30:00.036+00
fb6fff24-eab2-4d44-a3d9-c11d5af6796c	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	ef38dd1e-1795-408b-857c-c4d10c30d45d	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	1	replace	open	Bill and replace: replenishment "replace" for implanted	2026-11-09 16:30:00.012+00
6b4ec8f0-f4b1-4c8c-b059-0e4dc649d819	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	5c6dbf1d-3171-4ab7-8a0e-108f3ab8c170	7d11617a-4813-4b5c-90f0-19626f5db56f	1	replace	open	Bill and replace: replenishment "replace" for implanted	2026-11-09 16:30:00.021+00
e9ca3a6c-6f09-490b-8b1b-e6d19ee6cb15	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	e26cebb0-5047-4dec-b57f-9d1f991b7e2f	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	1	replace	open	Bill and replace: replenishment "replace" for implanted	2026-11-09 16:30:00.03+00
bb466a46-dc48-4c19-b276-aa7d169c2d6e	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	991ae806-5429-4fc1-8a43-0f5c7bee747e	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	1	none	not_required	Bill only: replenishment "none" for implanted	2026-11-15 15:30:00.008+00
c0792429-41fe-4cf7-af07-b9297aafc67d	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	3a597841-ea78-47f5-b5dd-46f98a8f4d22	7d11617a-4813-4b5c-90f0-19626f5db56f	1	none	not_required	Bill only: replenishment "none" for implanted	2026-11-15 15:30:00.014+00
84104f9a-930e-457d-930a-90e388b2f57c	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	27f5b7e7-e6f5-4434-9b0f-7a0806ec0791	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	1	none	not_required	Bill only: replenishment "none" for implanted	2026-11-15 15:30:00.022+00
\.


--
-- Data for Name: reservations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.reservations (id, tenant_id, case_id, requirement_id, stock_item_id, location_id, owner_party_id, qty, is_serial, status, created_by, created_at, released_at, release_reason, idempotency_key) FROM stdin;
edb38fea-53de-48a4-9da5-bf57f8c8a3ac	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	76b1e4c0-35f1-40ad-97ad-f48e721f1f88	4dd05f15-7329-433d-aacd-2ebc86ee4e44	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	1	t	consumed	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-13 10:30:00.007+00	2026-11-15 15:30:00.004+00	Closeout: implanted	\N
49a31ba4-73de-40b9-a851-1a48e5896c50	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	1105906a-0adf-4d90-83da-5130e743c8bd	c28c3811-bd2d-4fb8-a390-b815162fba25	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	1	t	consumed	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-13 10:30:00.01+00	2026-11-15 15:30:00.011+00	Closeout: implanted	\N
50d60098-af7b-4413-9ea8-a54fa0525b76	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	6a56b0d2-0cca-4899-82fb-5062f808b4d1	7b804cd3-400b-401d-a270-8f439e96370a	2dd920a2-792c-4540-bc80-6a1b1185f37a	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	1	t	consumed	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-10-29 10:30:00.016+00	2026-10-31 15:30:00.009+00	Closeout: implanted	\N
ae6bad3e-75a9-4107-95e2-b29af907bdbd	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	0b3f527f-848c-4f35-9716-c9f8da3ab176	4ef0a46d-e8ff-4c36-8d88-f7e9f789b804	2dd920a2-792c-4540-bc80-6a1b1185f37a	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	1	t	consumed	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-10-29 10:30:00.023+00	2026-10-31 15:30:00.022+00	Closeout: implanted	\N
dfbab087-dd43-490f-9b21-9786230832ea	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	456278a9-82a2-47dc-975e-c6dffe575d01	f6c15774-458d-4b23-8516-5334b95ef36f	2dd920a2-792c-4540-bc80-6a1b1185f37a	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	1	t	consumed	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-10-29 10:30:00.027+00	2026-10-31 15:30:00.033+00	Closeout: implanted	\N
553d5a4b-8beb-4e8f-a711-dd2bcbc43dad	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	c34966c1-81b7-4a7a-8e9b-b6365919ef1d	6347b29f-96e5-4886-ac37-66af7c072957	2dd920a2-792c-4540-bc80-6a1b1185f37a	5d3da139-ddf6-430f-95f9-8705a4ce752b	1	t	released	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-10-29 10:30:00.03+00	2026-10-31 15:54:00.004+00	Case completed; tray awaiting return and reprocessing	\N
528a6b10-79cc-4a3a-b5ff-2bb0f5fd880e	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	0f1540ed-1426-4eb3-8d70-3ef62b4ae975	6b82bbc6-7246-48d8-92b8-f6ba4f755942	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	1	t	consumed	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-13 10:30:00.012+00	2026-11-15 15:30:00.018+00	Closeout: implanted	\N
69687539-5255-4789-a8f1-69d06e72bab8	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	704b9c60-08a2-4b9b-91d5-8dee1cc990dc	6347b29f-96e5-4886-ac37-66af7c072957	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	5d3da139-ddf6-430f-95f9-8705a4ce752b	1	t	released	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-13 10:30:00.014+00	2026-11-15 15:54:00.002+00	Case completed; tray awaiting return and reprocessing	\N
92d1a93e-a0b8-40cd-9ed3-97f93054d4bc	82057f54-4730-4d4a-a86c-16c71dfc5380	ef2f1403-819a-4666-9d27-319fe05abcb4	b1cdf81e-0856-4ade-8492-bee8f371cd45	04902ff1-e22b-4581-ba3e-75b973dac0cc	241007a7-e552-4c9d-903e-dd625ca691fe	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	1	t	active	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-20 12:00:00.009+00	\N	\N	\N
972b146a-ab01-472d-a46f-439be5d3f521	82057f54-4730-4d4a-a86c-16c71dfc5380	bc5e78aa-c3bc-485a-b1e9-128710ceefe2	8d840c69-ee31-4b91-85ea-586d1e179834	bd227725-c45a-4003-9ecf-aa30624a2d85	a8cd43ec-3428-4c61-8cde-f343d65d11f6	5d3da139-ddf6-430f-95f9-8705a4ce752b	1	t	active	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-20 12:00:00.018+00	\N	\N	\N
0801a8e0-7c2a-40be-8398-c0f48ab5daf0	82057f54-4730-4d4a-a86c-16c71dfc5380	bc5e78aa-c3bc-485a-b1e9-128710ceefe2	47fa3a52-0323-4c5b-bf84-7fa559087882	36abd8b0-9299-486e-8a8e-b086703afef8	a8cd43ec-3428-4c61-8cde-f343d65d11f6	5d3da139-ddf6-430f-95f9-8705a4ce752b	1	t	active	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-20 12:00:00.022+00	\N	\N	\N
585abc39-da42-4baa-9e92-309aa5774a36	82057f54-4730-4d4a-a86c-16c71dfc5380	bc5e78aa-c3bc-485a-b1e9-128710ceefe2	1f9cdf5f-53ca-42bb-9b7e-55f0e63e3923	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	241007a7-e552-4c9d-903e-dd625ca691fe	5d3da139-ddf6-430f-95f9-8705a4ce752b	1	t	active	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-20 12:00:00.024+00	\N	\N	\N
68980fce-3411-4a85-a566-38cc78eee236	82057f54-4730-4d4a-a86c-16c71dfc5380	a1debd32-5f14-4fbd-9b06-bfd21d0192cc	940c5059-49ba-4a86-a5df-db6d4aabd746	b489a089-d976-4558-8d3e-bc1185e293f9	77a7aee8-8b25-4d85-8409-df3cddee5d55	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	1	t	active	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-20 12:00:00.032+00	\N	\N	\N
fe96ebc1-a318-4233-95da-07ee9922cd66	82057f54-4730-4d4a-a86c-16c71dfc5380	a1debd32-5f14-4fbd-9b06-bfd21d0192cc	00cbc81a-9553-496a-918d-c658a8d862d6	5a6e5a60-4ef3-4333-bfa0-199a9297343d	d8861e84-bb5d-4b80-9cad-a2568ef1fdd3	f3506c6e-4e5e-4567-866c-679ddf43adaf	1	t	active	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-20 12:00:00.034+00	\N	\N	\N
b0ed6cf4-2465-46c6-92ee-5467707112db	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	a49b689c-2bb1-4983-83ad-d3a49fd04928	bb2e661b-b202-47a4-8c71-b06f6d0bee8a	2dd920a2-792c-4540-bc80-6a1b1185f37a	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	1	t	consumed	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-07 11:30:00.01+00	2026-11-09 16:30:00.009+00	Closeout: implanted	\N
bf7a1f55-05a7-4269-88bc-b6360b4ff487	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	2777fa29-6d84-4583-8be2-20496897652a	bfeb5892-4fb4-465f-b784-24df21fed08a	2dd920a2-792c-4540-bc80-6a1b1185f37a	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	1	t	consumed	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-07 11:30:00.013+00	2026-11-09 16:30:00.018+00	Closeout: implanted	\N
deeca6c9-802f-420c-bf74-618391a84672	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	be4aceec-c686-4f15-b895-3dfdfbddbbb2	eb949393-b146-40b3-9e5e-6135546fdc2d	2dd920a2-792c-4540-bc80-6a1b1185f37a	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	1	t	consumed	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-07 11:30:00.015+00	2026-11-09 16:30:00.027+00	Closeout: implanted	\N
2c7b8369-eada-472c-a2a1-9e8b5fedc1c5	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	f81d4690-f3fe-4b07-8238-a7d315fee27a	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	2dd920a2-792c-4540-bc80-6a1b1185f37a	5d3da139-ddf6-430f-95f9-8705a4ce752b	1	t	released	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-07 11:30:00.017+00	2026-11-09 16:54:00.003+00	Case completed; tray awaiting return and reprocessing	\N
2dc6b0ff-ee4d-4967-aee5-8e4135d52505	82057f54-4730-4d4a-a86c-16c71dfc5380	a1debd32-5f14-4fbd-9b06-bfd21d0192cc	908f462a-94e2-44ac-a57c-b5c8e44ff68a	27b8d558-7603-49ca-ab67-890a836a9fa1	77a7aee8-8b25-4d85-8409-df3cddee5d55	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	1	t	active	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-20 12:00:00.036+00	\N	\N	\N
36b47594-ce41-4d4b-98a4-a97852a8d002	82057f54-4730-4d4a-a86c-16c71dfc5380	a1debd32-5f14-4fbd-9b06-bfd21d0192cc	1ee66e3f-923f-4778-9b53-075f23b39fc2	6347b29f-96e5-4886-ac37-66af7c072957	241007a7-e552-4c9d-903e-dd625ca691fe	5d3da139-ddf6-430f-95f9-8705a4ce752b	1	t	active	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-20 12:00:00.039+00	\N	\N	\N
\.


--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.schema_migrations (name, applied_at) FROM stdin;
001_core.sql	2026-11-21 21:32:14.431658+00
\.


--
-- Data for Name: sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sessions (token_hash, user_id, tenant_id, created_at, expires_at, revoked_at) FROM stdin;
\.


--
-- Data for Name: shipment_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.shipment_lines (id, tenant_id, shipment_id, stock_item_id, owner_party_id, reservation_id, qty_expected, qty_picked, qty_dispatched, qty_received, received_condition) FROM stdin;
4c2cef40-4ad6-4b2d-a421-163c6cf1e48f	82057f54-4730-4d4a-a86c-16c71dfc5380	74c82176-4d43-4aae-9cdd-298a7990fd8d	6347b29f-96e5-4886-ac37-66af7c072957	5d3da139-ddf6-430f-95f9-8705a4ce752b	\N	1	1	1	1	sealed
53846dd2-3313-44ab-bdf3-167b8466c28f	82057f54-4730-4d4a-a86c-16c71dfc5380	d5df80c0-93e8-4961-a305-fd5d1f1c266f	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	5d3da139-ddf6-430f-95f9-8705a4ce752b	\N	1	1	1	1	sealed
a3c9c49b-ace4-40d8-b46e-54e54a2a1b91	82057f54-4730-4d4a-a86c-16c71dfc5380	703b7074-b14c-4d0a-88b6-44158a7fd5f0	6347b29f-96e5-4886-ac37-66af7c072957	5d3da139-ddf6-430f-95f9-8705a4ce752b	553d5a4b-8beb-4e8f-a711-dd2bcbc43dad	1	1	1	1	sealed
55935304-8aef-4173-a184-db46111f6f24	82057f54-4730-4d4a-a86c-16c71dfc5380	703b7074-b14c-4d0a-88b6-44158a7fd5f0	4ef0a46d-e8ff-4c36-8d88-f7e9f789b804	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	ae6bad3e-75a9-4107-95e2-b29af907bdbd	1	1	1	1	sealed
340f2eff-2bb3-49df-8ffa-d2465dd23ddd	82057f54-4730-4d4a-a86c-16c71dfc5380	703b7074-b14c-4d0a-88b6-44158a7fd5f0	7b804cd3-400b-401d-a270-8f439e96370a	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	50d60098-af7b-4413-9ea8-a54fa0525b76	1	1	1	1	sealed
c3b6a19d-ffb2-486e-9ac3-9ade2b50ac64	82057f54-4730-4d4a-a86c-16c71dfc5380	703b7074-b14c-4d0a-88b6-44158a7fd5f0	f6c15774-458d-4b23-8516-5334b95ef36f	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	dfbab087-dd43-490f-9b21-9786230832ea	1	1	1	1	sealed
40f6bf06-8e0b-42e3-a2b2-9d11d188af07	82057f54-4730-4d4a-a86c-16c71dfc5380	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	5d3da139-ddf6-430f-95f9-8705a4ce752b	2c7b8369-eada-472c-a2a1-9e8b5fedc1c5	1	1	1	1	sealed
ac7d491f-1bd0-417d-af69-d9a701b3f162	82057f54-4730-4d4a-a86c-16c71dfc5380	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	bfeb5892-4fb4-465f-b784-24df21fed08a	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	bf7a1f55-05a7-4269-88bc-b6360b4ff487	1	1	1	1	sealed
d0ee40b8-b3f6-456b-944d-8af5260c6fa7	82057f54-4730-4d4a-a86c-16c71dfc5380	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	bb2e661b-b202-47a4-8c71-b06f6d0bee8a	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	b0ed6cf4-2465-46c6-92ee-5467707112db	1	1	1	1	sealed
f61daaec-ffb8-4994-81c1-fce511c8f45e	82057f54-4730-4d4a-a86c-16c71dfc5380	8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	eb949393-b146-40b3-9e5e-6135546fdc2d	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	deeca6c9-802f-420c-bf74-618391a84672	1	1	1	1	sealed
d3de0e17-3a38-41bc-a256-ff4ff04cebe7	82057f54-4730-4d4a-a86c-16c71dfc5380	e6528bef-e34f-4551-9e97-204bee72d399	c28c3811-bd2d-4fb8-a390-b815162fba25	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	49a31ba4-73de-40b9-a851-1a48e5896c50	1	1	1	1	sealed
caf2b859-288a-41db-bac2-556aca6c047d	82057f54-4730-4d4a-a86c-16c71dfc5380	e6528bef-e34f-4551-9e97-204bee72d399	4dd05f15-7329-433d-aacd-2ebc86ee4e44	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	edb38fea-53de-48a4-9da5-bf57f8c8a3ac	1	1	1	1	sealed
78328bf8-3046-44e7-bf2a-bea06474784e	82057f54-4730-4d4a-a86c-16c71dfc5380	e6528bef-e34f-4551-9e97-204bee72d399	6b82bbc6-7246-48d8-92b8-f6ba4f755942	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	528a6b10-79cc-4a3a-b5ff-2bb0f5fd880e	1	1	1	1	sealed
d32c71a0-96e7-4b09-bd22-fea9dd5d7077	82057f54-4730-4d4a-a86c-16c71dfc5380	c5c70cc5-9c4d-451a-8b3f-f7339eb110ff	6347b29f-96e5-4886-ac37-66af7c072957	5d3da139-ddf6-430f-95f9-8705a4ce752b	69687539-5255-4789-a8f1-69d06e72bab8	1	1	1	1	sealed
\.


--
-- Data for Name: shipments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.shipments (id, tenant_id, ref, case_id, from_location_id, to_location_id, kind, status, courier_name, due_by, created_by, created_at, idempotency_key) FROM stdin;
703b7074-b14c-4d0a-88b6-44158a7fd5f0	82057f54-4730-4d4a-a86c-16c71dfc5380	SHP-5001	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	241007a7-e552-4c9d-903e-dd625ca691fe	2dd920a2-792c-4540-bc80-6a1b1185f37a	case_delivery	closed	Synthetic Courier Co.	2026-10-31 00:30:00+00	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-10-29 10:30:00.036+00	\N
8b65b15d-d2b7-48f3-b8a5-fad100a73cdb	82057f54-4730-4d4a-a86c-16c71dfc5380	SHP-5002	555a2002-df45-4f75-a01c-a237a8347b4c	241007a7-e552-4c9d-903e-dd625ca691fe	2dd920a2-792c-4540-bc80-6a1b1185f37a	case_delivery	closed	Synthetic Courier Co.	2026-11-09 01:30:00+00	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-07 11:30:00.02+00	\N
e6528bef-e34f-4551-9e97-204bee72d399	82057f54-4730-4d4a-a86c-16c71dfc5380	SHP-5003	964622f1-c4fa-4547-8b0a-2b8334c6d297	241007a7-e552-4c9d-903e-dd625ca691fe	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	case_delivery	closed	Synthetic Courier Co.	2026-11-15 00:30:00+00	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-13 10:30:00.017+00	\N
c5c70cc5-9c4d-451a-8b3f-f7339eb110ff	82057f54-4730-4d4a-a86c-16c71dfc5380	SHP-5004	964622f1-c4fa-4547-8b0a-2b8334c6d297	2dd920a2-792c-4540-bc80-6a1b1185f37a	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	case_delivery	closed	Synthetic Courier Co.	2026-11-14 12:30:00+00	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-13 10:30:00.018+00	\N
74c82176-4d43-4aae-9cdd-298a7990fd8d	82057f54-4730-4d4a-a86c-16c71dfc5380	RTN-5005	\N	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	241007a7-e552-4c9d-903e-dd625ca691fe	return	closed	Synthetic Courier Co.	\N	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-18 21:00:00.003+00	\N
d5df80c0-93e8-4961-a305-fd5d1f1c266f	82057f54-4730-4d4a-a86c-16c71dfc5380	RTN-5006	\N	2dd920a2-792c-4540-bc80-6a1b1185f37a	241007a7-e552-4c9d-903e-dd625ca691fe	return	closed	Synthetic Courier Co.	\N	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-11-18 21:00:00.002+00	\N
\.


--
-- Data for Name: stock_balances; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_balances (id, tenant_id, stock_item_id, location_id, owner_party_id, condition, qty, last_movement_id) FROM stdin;
10fdaef5-e02b-4cf0-9dca-dd261d17640b	82057f54-4730-4d4a-a86c-16c71dfc5380	04902ff1-e22b-4581-ba3e-75b973dac0cc	241007a7-e552-4c9d-903e-dd625ca691fe	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	1	1
9ac86a09-5352-4fee-aa5d-43286fa30354	82057f54-4730-4d4a-a86c-16c71dfc5380	ef74907e-f311-4535-a50e-a8b3c411b7fc	77a7aee8-8b25-4d85-8409-df3cddee5d55	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	1	2
c27730d7-28a1-46b5-9535-938eb92d7648	82057f54-4730-4d4a-a86c-16c71dfc5380	5a6e5a60-4ef3-4333-bfa0-199a9297343d	d8861e84-bb5d-4b80-9cad-a2568ef1fdd3	f3506c6e-4e5e-4567-866c-679ddf43adaf	sealed	1	3
a3d45fb1-5df2-46a2-a883-ab6446ea1c77	82057f54-4730-4d4a-a86c-16c71dfc5380	c7d5bde7-b708-444f-8f7c-8e98b4829886	b23f2359-decb-4d53-93f3-bb8302fc166d	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	1	4
42493338-6838-46cc-8e6a-f7f62183ba60	82057f54-4730-4d4a-a86c-16c71dfc5380	524e48bc-002b-41f5-bb86-f331d2bd97dd	241007a7-e552-4c9d-903e-dd625ca691fe	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	1	5
b683551b-08a6-4989-b2a9-1d5622bad6b5	82057f54-4730-4d4a-a86c-16c71dfc5380	5190a5bb-ff49-4543-8b3b-e9a4df561a7b	241007a7-e552-4c9d-903e-dd625ca691fe	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	1	7
ed46e824-9bb1-4180-9603-118298b1d00a	82057f54-4730-4d4a-a86c-16c71dfc5380	bd227725-c45a-4003-9ecf-aa30624a2d85	a8cd43ec-3428-4c61-8cde-f343d65d11f6	5d3da139-ddf6-430f-95f9-8705a4ce752b	sealed	1	8
103b8516-1dc5-4609-b560-0142ca30df8b	82057f54-4730-4d4a-a86c-16c71dfc5380	36abd8b0-9299-486e-8a8e-b086703afef8	a8cd43ec-3428-4c61-8cde-f343d65d11f6	5d3da139-ddf6-430f-95f9-8705a4ce752b	sealed	1	9
2d7e2c8b-7493-4c18-8c5d-042e0ae802f3	82057f54-4730-4d4a-a86c-16c71dfc5380	e8921336-a648-428d-a737-50fd8c8dcd49	241007a7-e552-4c9d-903e-dd625ca691fe	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	1	11
678a693f-ca08-4851-903a-9b5e22948c30	82057f54-4730-4d4a-a86c-16c71dfc5380	b60d87e3-525b-43da-b493-50b08d9535cf	241007a7-e552-4c9d-903e-dd625ca691fe	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	1	12
8882c0d4-0178-465d-950b-a702c7db6e31	82057f54-4730-4d4a-a86c-16c71dfc5380	7103687d-adc4-4ebe-8137-4dcc005ddf40	b23f2359-decb-4d53-93f3-bb8302fc166d	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	5	16
3cae2810-2afe-4aae-ade4-82ef7e4b9827	82057f54-4730-4d4a-a86c-16c71dfc5380	2f2a2461-7243-4478-bbb7-df4497433379	241007a7-e552-4c9d-903e-dd625ca691fe	5d3da139-ddf6-430f-95f9-8705a4ce752b	sealed	1	19
224746c8-1f0e-4e6c-af05-2030cfcca086	82057f54-4730-4d4a-a86c-16c71dfc5380	b489a089-d976-4558-8d3e-bc1185e293f9	77a7aee8-8b25-4d85-8409-df3cddee5d55	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	1	24
d9406ae7-8b27-4ec3-8afe-221f12cad023	82057f54-4730-4d4a-a86c-16c71dfc5380	27b8d558-7603-49ca-ab67-890a836a9fa1	77a7aee8-8b25-4d85-8409-df3cddee5d55	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	1	25
155889cf-f677-4281-8647-9fb00b2ddbde	82057f54-4730-4d4a-a86c-16c71dfc5380	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	2dd920a2-792c-4540-bc80-6a1b1185f37a	5d3da139-ddf6-430f-95f9-8705a4ce752b	sealed	0	62
65e2710b-4218-47a0-b0a6-b9f2c95e9845	82057f54-4730-4d4a-a86c-16c71dfc5380	4ef0a46d-e8ff-4c36-8d88-f7e9f789b804	241007a7-e552-4c9d-903e-dd625ca691fe	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	28
ed3191c5-dd9f-4fcc-9d46-956bcddedac1	82057f54-4730-4d4a-a86c-16c71dfc5380	7b804cd3-400b-401d-a270-8f439e96370a	241007a7-e552-4c9d-903e-dd625ca691fe	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	29
2eaa7243-759a-41a0-9cac-083325f078e5	82057f54-4730-4d4a-a86c-16c71dfc5380	f6c15774-458d-4b23-8516-5334b95ef36f	241007a7-e552-4c9d-903e-dd625ca691fe	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	30
f48a4f33-875d-4877-9fcd-d8cfd98cd1e8	82057f54-4730-4d4a-a86c-16c71dfc5380	4dd05f15-7329-433d-aacd-2ebc86ee4e44	c93683f7-5db8-40f9-a4fb-839e2a79bb54	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	54
a772f21f-ef2e-4f98-9800-a756d8fce3df	82057f54-4730-4d4a-a86c-16c71dfc5380	4ef0a46d-e8ff-4c36-8d88-f7e9f789b804	c93683f7-5db8-40f9-a4fb-839e2a79bb54	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	32
92f03b8b-b2e7-4f3b-8c22-0eeb0f4c3484	82057f54-4730-4d4a-a86c-16c71dfc5380	7b804cd3-400b-401d-a270-8f439e96370a	c93683f7-5db8-40f9-a4fb-839e2a79bb54	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	33
65b83567-1dcb-4244-bbbd-2701993ecbce	82057f54-4730-4d4a-a86c-16c71dfc5380	f6c15774-458d-4b23-8516-5334b95ef36f	c93683f7-5db8-40f9-a4fb-839e2a79bb54	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	34
7c85ad3c-d66f-45ec-927c-ade636df3835	82057f54-4730-4d4a-a86c-16c71dfc5380	7b804cd3-400b-401d-a270-8f439e96370a	2dd920a2-792c-4540-bc80-6a1b1185f37a	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	35
ffcab4bb-c2d1-483a-9dc0-462e7db2dcc2	82057f54-4730-4d4a-a86c-16c71dfc5380	7b804cd3-400b-401d-a270-8f439e96370a	c10806b8-a9b3-49ea-a281-a5754e694282	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	used	1	35
205a9dd2-f0eb-41ea-89db-93ebd6df4b96	82057f54-4730-4d4a-a86c-16c71dfc5380	4ef0a46d-e8ff-4c36-8d88-f7e9f789b804	2dd920a2-792c-4540-bc80-6a1b1185f37a	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	36
c161f2e1-cd39-4ee3-8662-c292c38453bb	82057f54-4730-4d4a-a86c-16c71dfc5380	4ef0a46d-e8ff-4c36-8d88-f7e9f789b804	c10806b8-a9b3-49ea-a281-a5754e694282	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	used	1	36
34cabb91-e423-4321-b10e-661214d08069	82057f54-4730-4d4a-a86c-16c71dfc5380	f6c15774-458d-4b23-8516-5334b95ef36f	2dd920a2-792c-4540-bc80-6a1b1185f37a	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	37
54adcc85-2e31-4173-8e6e-debdb7bdbbee	82057f54-4730-4d4a-a86c-16c71dfc5380	f6c15774-458d-4b23-8516-5334b95ef36f	c10806b8-a9b3-49ea-a281-a5754e694282	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	used	1	37
907ac38f-2925-462f-9ba3-c4d769878719	82057f54-4730-4d4a-a86c-16c71dfc5380	7103687d-adc4-4ebe-8137-4dcc005ddf40	241007a7-e552-4c9d-903e-dd625ca691fe	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	19	64
48bb1305-fd9b-495c-80c7-b1debd7eb15a	82057f54-4730-4d4a-a86c-16c71dfc5380	bfeb5892-4fb4-465f-b784-24df21fed08a	241007a7-e552-4c9d-903e-dd625ca691fe	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	39
63630845-8496-45ec-abb8-0821df0d2200	82057f54-4730-4d4a-a86c-16c71dfc5380	bb2e661b-b202-47a4-8c71-b06f6d0bee8a	241007a7-e552-4c9d-903e-dd625ca691fe	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	40
a944d17e-7093-43da-bb44-096a952edfa2	82057f54-4730-4d4a-a86c-16c71dfc5380	eb949393-b146-40b3-9e5e-6135546fdc2d	241007a7-e552-4c9d-903e-dd625ca691fe	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	41
8813cb0d-00ac-4c4e-90c9-6977ac1175ca	82057f54-4730-4d4a-a86c-16c71dfc5380	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	c93683f7-5db8-40f9-a4fb-839e2a79bb54	5d3da139-ddf6-430f-95f9-8705a4ce752b	sealed	0	63
32ce73e8-e6f2-4da1-8703-acd8e4a91680	82057f54-4730-4d4a-a86c-16c71dfc5380	bfeb5892-4fb4-465f-b784-24df21fed08a	c93683f7-5db8-40f9-a4fb-839e2a79bb54	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	43
82ea13a9-2a82-4975-af93-214914a91447	82057f54-4730-4d4a-a86c-16c71dfc5380	bb2e661b-b202-47a4-8c71-b06f6d0bee8a	c93683f7-5db8-40f9-a4fb-839e2a79bb54	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	44
e32759d9-29da-48d8-87f2-ff506e058243	82057f54-4730-4d4a-a86c-16c71dfc5380	eb949393-b146-40b3-9e5e-6135546fdc2d	c93683f7-5db8-40f9-a4fb-839e2a79bb54	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	45
e121ff76-a814-43b7-9acb-2d4282abf8eb	82057f54-4730-4d4a-a86c-16c71dfc5380	bb2e661b-b202-47a4-8c71-b06f6d0bee8a	2dd920a2-792c-4540-bc80-6a1b1185f37a	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	46
0feccd99-9d16-406e-a109-70d4d7315f11	82057f54-4730-4d4a-a86c-16c71dfc5380	bb2e661b-b202-47a4-8c71-b06f6d0bee8a	c10806b8-a9b3-49ea-a281-a5754e694282	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	used	1	46
f5e0616a-3712-4906-9ef4-0a9c602824cf	82057f54-4730-4d4a-a86c-16c71dfc5380	bfeb5892-4fb4-465f-b784-24df21fed08a	2dd920a2-792c-4540-bc80-6a1b1185f37a	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	47
6e97a407-7208-4e8f-b008-7966a97230f8	82057f54-4730-4d4a-a86c-16c71dfc5380	bfeb5892-4fb4-465f-b784-24df21fed08a	c10806b8-a9b3-49ea-a281-a5754e694282	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	used	1	47
29c00996-d080-4a77-b60d-583a63aa1cc9	82057f54-4730-4d4a-a86c-16c71dfc5380	eb949393-b146-40b3-9e5e-6135546fdc2d	2dd920a2-792c-4540-bc80-6a1b1185f37a	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	48
8bf7f4cc-5364-44b0-8aa6-a2de8dd07f46	82057f54-4730-4d4a-a86c-16c71dfc5380	eb949393-b146-40b3-9e5e-6135546fdc2d	c10806b8-a9b3-49ea-a281-a5754e694282	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	used	1	48
7440f6aa-92f6-4e06-bc16-81a04a8f9531	82057f54-4730-4d4a-a86c-16c71dfc5380	c28c3811-bd2d-4fb8-a390-b815162fba25	241007a7-e552-4c9d-903e-dd625ca691fe	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	49
f21a9e33-1fa2-4038-b693-42087ff8ef0d	82057f54-4730-4d4a-a86c-16c71dfc5380	4dd05f15-7329-433d-aacd-2ebc86ee4e44	241007a7-e552-4c9d-903e-dd625ca691fe	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	50
575c7a48-5624-4b99-ac39-b41be2f936d6	82057f54-4730-4d4a-a86c-16c71dfc5380	6b82bbc6-7246-48d8-92b8-f6ba4f755942	241007a7-e552-4c9d-903e-dd625ca691fe	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	51
23f73fc6-2bfe-459a-98b2-13fb201037e8	82057f54-4730-4d4a-a86c-16c71dfc5380	6347b29f-96e5-4886-ac37-66af7c072957	2dd920a2-792c-4540-bc80-6a1b1185f37a	5d3da139-ddf6-430f-95f9-8705a4ce752b	sealed	0	52
bcc03be0-d248-46ac-9990-22105a7ea82e	82057f54-4730-4d4a-a86c-16c71dfc5380	4dd05f15-7329-433d-aacd-2ebc86ee4e44	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	57
c0155c82-6c82-4f9c-a1d4-de20eedd78f5	82057f54-4730-4d4a-a86c-16c71dfc5380	c28c3811-bd2d-4fb8-a390-b815162fba25	c93683f7-5db8-40f9-a4fb-839e2a79bb54	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	53
145fdc7d-9670-4ae7-ae0c-7b05eae704fa	82057f54-4730-4d4a-a86c-16c71dfc5380	6b82bbc6-7246-48d8-92b8-f6ba4f755942	c93683f7-5db8-40f9-a4fb-839e2a79bb54	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	55
2dff2edb-484e-4e89-bfb2-f21833d4ab8b	82057f54-4730-4d4a-a86c-16c71dfc5380	6347b29f-96e5-4886-ac37-66af7c072957	c93683f7-5db8-40f9-a4fb-839e2a79bb54	5d3da139-ddf6-430f-95f9-8705a4ce752b	sealed	0	61
003bdd13-b5fd-4f49-937d-f3154afc2ed3	82057f54-4730-4d4a-a86c-16c71dfc5380	4dd05f15-7329-433d-aacd-2ebc86ee4e44	c10806b8-a9b3-49ea-a281-a5754e694282	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	used	1	57
f0fb2092-5b6b-4841-aef3-a22e8efb147a	82057f54-4730-4d4a-a86c-16c71dfc5380	c28c3811-bd2d-4fb8-a390-b815162fba25	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	58
b17cbb03-1ebc-48ed-9986-08841d8b9ce8	82057f54-4730-4d4a-a86c-16c71dfc5380	c28c3811-bd2d-4fb8-a390-b815162fba25	c10806b8-a9b3-49ea-a281-a5754e694282	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	used	1	58
84cfd1a7-9163-443f-bf62-7678a3effdaf	82057f54-4730-4d4a-a86c-16c71dfc5380	6b82bbc6-7246-48d8-92b8-f6ba4f755942	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	sealed	0	59
5c929a7a-93f1-4f9f-993e-086ee4ad6830	82057f54-4730-4d4a-a86c-16c71dfc5380	6b82bbc6-7246-48d8-92b8-f6ba4f755942	c10806b8-a9b3-49ea-a281-a5754e694282	1b9d9abc-9dd9-441e-9ce3-66639e62ade9	used	1	59
9e0e4e9f-d3e3-4f9c-a099-eec7526aeabf	82057f54-4730-4d4a-a86c-16c71dfc5380	6347b29f-96e5-4886-ac37-66af7c072957	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	5d3da139-ddf6-430f-95f9-8705a4ce752b	sealed	0	60
6056d8de-8d03-4755-a6be-620487082978	82057f54-4730-4d4a-a86c-16c71dfc5380	6347b29f-96e5-4886-ac37-66af7c072957	241007a7-e552-4c9d-903e-dd625ca691fe	5d3da139-ddf6-430f-95f9-8705a4ce752b	sealed	1	61
06948916-5901-4957-87bd-a159b3d8c75a	82057f54-4730-4d4a-a86c-16c71dfc5380	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	241007a7-e552-4c9d-903e-dd625ca691fe	5d3da139-ddf6-430f-95f9-8705a4ce752b	sealed	1	63
\.


--
-- Data for Name: stock_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_items (id, tenant_id, catalog_item_id, lot_number, serial_number, expiry_date, is_serial, data_source, import_batch_id, created_at) FROM stdin;
04902ff1-e22b-4581-ba3e-75b973dac0cc	82057f54-4730-4d4a-a86c-16c71dfc5380	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	L26C014	INS-0001	2027-12-26	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
ef74907e-f311-4535-a50e-a8b3c411b7fc	82057f54-4730-4d4a-a86c-16c71dfc5380	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	L26C014	INS-0002	2027-12-26	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
5a6e5a60-4ef3-4333-bfa0-199a9297343d	82057f54-4730-4d4a-a86c-16c71dfc5380	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	L26C014	INS-0003	2027-12-26	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
c7d5bde7-b708-444f-8f7c-8e98b4829886	82057f54-4730-4d4a-a86c-16c71dfc5380	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	L25K201	INS-0004	2026-11-20	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
524e48bc-002b-41f5-bb86-f331d2bd97dd	82057f54-4730-4d4a-a86c-16c71dfc5380	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	L26A003	INS-0006	2027-09-17	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
4dd05f15-7329-433d-aacd-2ebc86ee4e44	82057f54-4730-4d4a-a86c-16c71dfc5380	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	L26A003	INS-0007	2027-09-17	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
5190a5bb-ff49-4543-8b3b-e9a4df561a7b	82057f54-4730-4d4a-a86c-16c71dfc5380	d4bf7ed4-74a1-41d5-9480-5748c241727e	L26C020	INS12-0001	2028-01-15	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
bd227725-c45a-4003-9ecf-aa30624a2d85	82057f54-4730-4d4a-a86c-16c71dfc5380	7d11617a-4813-4b5c-90f0-19626f5db56f	L26B110	FEM4L-0101	2028-04-04	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
36abd8b0-9299-486e-8a8e-b086703afef8	82057f54-4730-4d4a-a86c-16c71dfc5380	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	L26B210	TIB4-0201	2028-04-04	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
4ef0a46d-e8ff-4c36-8d88-f7e9f789b804	82057f54-4730-4d4a-a86c-16c71dfc5380	7d11617a-4813-4b5c-90f0-19626f5db56f	L26B110	FEM4L-0102	2028-04-04	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
e8921336-a648-428d-a737-50fd8c8dcd49	82057f54-4730-4d4a-a86c-16c71dfc5380	f4e893f7-831e-40dd-89ce-1f79e2c1c9b0	L26B111	FEM5L-0301	2028-04-04	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
b60d87e3-525b-43da-b493-50b08d9535cf	82057f54-4730-4d4a-a86c-16c71dfc5380	f4e893f7-831e-40dd-89ce-1f79e2c1c9b0	L26B111	FEM5L-0302	2028-04-04	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
f6c15774-458d-4b23-8516-5334b95ef36f	82057f54-4730-4d4a-a86c-16c71dfc5380	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	L26B210	TIB4-0202	2028-04-04	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
eb949393-b146-40b3-9e5e-6135546fdc2d	82057f54-4730-4d4a-a86c-16c71dfc5380	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	L26B210	TIB4-0203	2028-04-04	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
7103687d-adc4-4ebe-8137-4dcc005ddf40	82057f54-4730-4d4a-a86c-16c71dfc5380	2d9010d1-af1c-479e-9bd8-9467cfc17ab4	S26B088	\N	2028-10-21	f	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
6347b29f-96e5-4886-ac37-66af7c072957	82057f54-4730-4d4a-a86c-16c71dfc5380	b3c5ddcf-836f-4ccd-9f35-22d68099e076	T-LOANER	TRY-K-001	\N	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	82057f54-4730-4d4a-a86c-16c71dfc5380	b3c5ddcf-836f-4ccd-9f35-22d68099e076	T-LOANER	TRY-K-002	\N	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
2f2a2461-7243-4478-bbb7-df4497433379	82057f54-4730-4d4a-a86c-16c71dfc5380	d2f797b4-ed84-42fe-b2c9-48700f255658	I-LOOSE	SZ-0207	\N	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
7b804cd3-400b-401d-a270-8f439e96370a	82057f54-4730-4d4a-a86c-16c71dfc5380	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	L26C030	INS-0010	2028-02-14	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
bb2e661b-b202-47a4-8c71-b06f6d0bee8a	82057f54-4730-4d4a-a86c-16c71dfc5380	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	L26C030	INS-0011	2028-02-14	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
bfeb5892-4fb4-465f-b784-24df21fed08a	82057f54-4730-4d4a-a86c-16c71dfc5380	7d11617a-4813-4b5c-90f0-19626f5db56f	L26B110	FEM4L-0103	2028-04-04	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
6b82bbc6-7246-48d8-92b8-f6ba4f755942	82057f54-4730-4d4a-a86c-16c71dfc5380	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	L26B210	TIB4-0204	2028-04-04	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
b489a089-d976-4558-8d3e-bc1185e293f9	82057f54-4730-4d4a-a86c-16c71dfc5380	7d11617a-4813-4b5c-90f0-19626f5db56f	L26B110	FEM4L-0104	2028-04-04	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
27b8d558-7603-49ca-ab67-890a836a9fa1	82057f54-4730-4d4a-a86c-16c71dfc5380	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	L26B210	TIB4-0205	2028-04-04	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
c28c3811-bd2d-4fb8-a390-b815162fba25	82057f54-4730-4d4a-a86c-16c71dfc5380	7d11617a-4813-4b5c-90f0-19626f5db56f	L26B110	FEM4L-0105	2028-04-04	t	import	ae4de74e-5036-4d05-8fc8-c69ddb70ea8a	2026-11-21 21:32:14.819048+00
\.


--
-- Data for Name: sync_differences; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sync_differences (id, tenant_id, feed_id, entity, entity_ref, field, our_value, their_value, status, created_at) FROM stdin;
96b6cadf-48a1-489a-8056-3eef5010d547	82057f54-4730-4d4a-a86c-16c71dfc5380	a16c5213-3d22-4912-82af-a2d9f53ca359	case	SYN-1002	scheduled_start	13:00 EST	13:30 EST (last feed message, 9 h old)	open	2026-11-20 12:00:00.04+00
\.


--
-- Data for Name: system_settings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.system_settings (key, value) FROM stdin;
clock_offset_ms	-27135746
\.


--
-- Data for Name: tenants; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tenants (id, slug, name, created_at) FROM stdin;
82057f54-4730-4d4a-a86c-16c71dfc5380	lakeshore	Lakeshore Orthopedic Partners (synthetic)	2026-11-21 21:32:14.746683+00
bdc0230c-75cb-47f1-bc8b-f13ddb1aa1b8	ridgeway	Ridgeway Surgical Supply (synthetic)	2026-11-21 21:32:15.746836+00
\.


--
-- Data for Name: territories; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.territories (id, tenant_id, name) FROM stdin;
b82a7fc8-4f6a-4f9f-a11a-e305d2a7dff8	82057f54-4730-4d4a-a86c-16c71dfc5380	North (Chicago metro)
f54a6002-3a27-4e7e-bb26-7cce6461523a	82057f54-4730-4d4a-a86c-16c71dfc5380	East (Indiana)
\.


--
-- Data for Name: travel_estimates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.travel_estimates (id, tenant_id, from_location_id, to_facility_id, minutes, courier_cost_cents, basis) FROM stdin;
429a56ab-5760-4043-9fa1-b58c9255d254	82057f54-4730-4d4a-a86c-16c71dfc5380	241007a7-e552-4c9d-903e-dd625ca691fe	61d14381-fb23-4f39-91d4-3901a30558b1	55	4500	Seeded estimate (synthetic); not live traffic or courier quote
b7781088-e4ef-4a8c-950d-783b04058127	82057f54-4730-4d4a-a86c-16c71dfc5380	241007a7-e552-4c9d-903e-dd625ca691fe	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	150	12000	Seeded estimate (synthetic); not live traffic or courier quote
fded860f-4ac7-4613-b681-be48a645107a	82057f54-4730-4d4a-a86c-16c71dfc5380	b23f2359-decb-4d53-93f3-bb8302fc166d	61d14381-fb23-4f39-91d4-3901a30558b1	25	1800	Seeded estimate (synthetic); not live traffic or courier quote
db10e53f-06bf-4725-8eef-2f1d644d21a0	82057f54-4730-4d4a-a86c-16c71dfc5380	b23f2359-decb-4d53-93f3-bb8302fc166d	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	170	9500	Seeded estimate (synthetic); not live traffic or courier quote
458b75c4-0521-4b27-bd66-88fd465c95cc	82057f54-4730-4d4a-a86c-16c71dfc5380	77a7aee8-8b25-4d85-8409-df3cddee5d55	61d14381-fb23-4f39-91d4-3901a30558b1	95	3500	Seeded estimate (synthetic); not live traffic or courier quote
31360a65-5d78-4991-a5f3-e90dc1407dde	82057f54-4730-4d4a-a86c-16c71dfc5380	77a7aee8-8b25-4d85-8409-df3cddee5d55	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	30	1200	Seeded estimate (synthetic); not live traffic or courier quote
121e1e58-466c-4355-a1ad-32ba6827aabe	82057f54-4730-4d4a-a86c-16c71dfc5380	a8cd43ec-3428-4c61-8cde-f343d65d11f6	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	160	12500	Seeded estimate (synthetic); not live traffic or courier quote
3b0f9d78-467e-42ca-a7ae-d0edca83b1f2	82057f54-4730-4d4a-a86c-16c71dfc5380	d8861e84-bb5d-4b80-9cad-a2568ef1fdd3	61d14381-fb23-4f39-91d4-3901a30558b1	140	11500	Seeded estimate (synthetic); not live traffic or courier quote
e5ce7fe8-fbcb-4662-96ea-0bd48911b672	82057f54-4730-4d4a-a86c-16c71dfc5380	2dd920a2-792c-4540-bc80-6a1b1185f37a	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	160	12500	Seeded estimate (synthetic); not live traffic or courier quote
bed056d5-32d5-478e-b088-5006141d48b5	82057f54-4730-4d4a-a86c-16c71dfc5380	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	61d14381-fb23-4f39-91d4-3901a30558b1	140	11500	Seeded estimate (synthetic); not live traffic or courier quote
\.


--
-- Data for Name: tray_instances; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tray_instances (stock_item_id, tenant_id, manifest_version_id) FROM stdin;
6347b29f-96e5-4886-ac37-66af7c072957	82057f54-4730-4d4a-a86c-16c71dfc5380	34787028-e1a3-450b-9506-b293285e95f9
7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	82057f54-4730-4d4a-a86c-16c71dfc5380	34787028-e1a3-450b-9506-b293285e95f9
\.


--
-- Data for Name: tray_manifest_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tray_manifest_lines (id, tenant_id, manifest_version_id, catalog_item_id, qty, required) FROM stdin;
8b70715e-ae09-4cab-b0f1-50018147ab8e	82057f54-4730-4d4a-a86c-16c71dfc5380	dbdcafe0-c83d-411b-b8d5-c1cc21797132	d2f797b4-ed84-42fe-b2c9-48700f255658	1	t
56bfe9d5-fc30-41bf-8b54-4ffde394b022	82057f54-4730-4d4a-a86c-16c71dfc5380	dbdcafe0-c83d-411b-b8d5-c1cc21797132	c38378c9-90b2-41f5-857b-73bbc8c4966b	1	t
a98fa805-fca8-4bad-9a0f-4a9ca9b6ca61	82057f54-4730-4d4a-a86c-16c71dfc5380	dbdcafe0-c83d-411b-b8d5-c1cc21797132	2716dd30-563b-4203-a4a1-dfa1ce9174c0	1	t
8a1f18b5-6cc2-4567-8e0f-beefbfdbc514	82057f54-4730-4d4a-a86c-16c71dfc5380	dbdcafe0-c83d-411b-b8d5-c1cc21797132	b8ef96ac-a20b-40bf-b9e0-0852fe52e052	1	t
7a1ba1a3-e1d0-4135-b4e6-330df93d4b22	82057f54-4730-4d4a-a86c-16c71dfc5380	34787028-e1a3-450b-9506-b293285e95f9	d2f797b4-ed84-42fe-b2c9-48700f255658	1	t
59191ba8-e549-4ac6-af6b-ba94cc2f185a	82057f54-4730-4d4a-a86c-16c71dfc5380	34787028-e1a3-450b-9506-b293285e95f9	c38378c9-90b2-41f5-857b-73bbc8c4966b	1	t
95e5b11e-9d13-4993-89fb-3397eb2f4b5c	82057f54-4730-4d4a-a86c-16c71dfc5380	34787028-e1a3-450b-9506-b293285e95f9	2716dd30-563b-4203-a4a1-dfa1ce9174c0	1	t
c6cd5494-62d6-426e-b145-35a5a8c24b69	82057f54-4730-4d4a-a86c-16c71dfc5380	34787028-e1a3-450b-9506-b293285e95f9	b8ef96ac-a20b-40bf-b9e0-0852fe52e052	1	t
a32391c2-0223-4e9f-9903-8e3a7a4d0d4b	82057f54-4730-4d4a-a86c-16c71dfc5380	34787028-e1a3-450b-9506-b293285e95f9	dc00b586-b2ac-4152-a76a-1dcb42105b72	1	t
\.


--
-- Data for Name: tray_manifest_versions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tray_manifest_versions (id, tenant_id, tray_catalog_item_id, version, status, approved_by, approved_at) FROM stdin;
dbdcafe0-c83d-411b-b8d5-c1cc21797132	82057f54-4730-4d4a-a86c-16c71dfc5380	b3c5ddcf-836f-4ccd-9f35-22d68099e076	1	retired	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-10-12 14:00:00.141+00
34787028-e1a3-450b-9506-b293285e95f9	82057f54-4730-4d4a-a86c-16c71dfc5380	b3c5ddcf-836f-4ccd-9f35-22d68099e076	2	approved	9bd9ad2b-2664-4d61-ad81-b028e87a533f	2026-10-12 14:00:00.143+00
\.


--
-- Data for Name: tray_verification_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tray_verification_lines (id, tenant_id, verification_id, catalog_item_id, expected_qty, actual_qty, required) FROM stdin;
38405c6a-5262-49e9-b4a8-357d9ac9a8b9	82057f54-4730-4d4a-a86c-16c71dfc5380	de7a68cf-de41-4b01-8ff0-c15f3cfb749e	c38378c9-90b2-41f5-857b-73bbc8c4966b	1	1	t
1b2cb880-8114-4897-aaa9-236406b60c3e	82057f54-4730-4d4a-a86c-16c71dfc5380	de7a68cf-de41-4b01-8ff0-c15f3cfb749e	b8ef96ac-a20b-40bf-b9e0-0852fe52e052	1	1	t
172e12b9-d1a3-4f8f-a71c-1c77d2a129d8	82057f54-4730-4d4a-a86c-16c71dfc5380	de7a68cf-de41-4b01-8ff0-c15f3cfb749e	d2f797b4-ed84-42fe-b2c9-48700f255658	1	1	t
75c2c4b0-2021-420a-a3ec-975637b14132	82057f54-4730-4d4a-a86c-16c71dfc5380	de7a68cf-de41-4b01-8ff0-c15f3cfb749e	2716dd30-563b-4203-a4a1-dfa1ce9174c0	1	1	t
00e3860b-3341-4aea-b173-ab3730ab6a68	82057f54-4730-4d4a-a86c-16c71dfc5380	de7a68cf-de41-4b01-8ff0-c15f3cfb749e	dc00b586-b2ac-4152-a76a-1dcb42105b72	1	1	t
cfad7c31-df44-4e6b-92e8-4190c21e41f6	82057f54-4730-4d4a-a86c-16c71dfc5380	c7aab3e3-1b04-4b3e-ab62-8975cd4ca5b5	c38378c9-90b2-41f5-857b-73bbc8c4966b	1	1	t
ffb0152f-b229-443b-99a5-d3b724d33eb2	82057f54-4730-4d4a-a86c-16c71dfc5380	c7aab3e3-1b04-4b3e-ab62-8975cd4ca5b5	b8ef96ac-a20b-40bf-b9e0-0852fe52e052	1	1	t
e4d68714-c4b8-4e99-9fb6-cfee9d641218	82057f54-4730-4d4a-a86c-16c71dfc5380	c7aab3e3-1b04-4b3e-ab62-8975cd4ca5b5	d2f797b4-ed84-42fe-b2c9-48700f255658	1	1	t
b1345099-0d97-4cb3-87ca-f4d366b8e28c	82057f54-4730-4d4a-a86c-16c71dfc5380	c7aab3e3-1b04-4b3e-ab62-8975cd4ca5b5	2716dd30-563b-4203-a4a1-dfa1ce9174c0	1	1	t
241941b1-06bb-4542-a7b4-48946720a721	82057f54-4730-4d4a-a86c-16c71dfc5380	c7aab3e3-1b04-4b3e-ab62-8975cd4ca5b5	dc00b586-b2ac-4152-a76a-1dcb42105b72	1	1	t
5ffdebfb-1282-4a89-a586-d4009aa05c6a	82057f54-4730-4d4a-a86c-16c71dfc5380	0301bb9e-acf4-4752-bc6c-dd5b61888506	c38378c9-90b2-41f5-857b-73bbc8c4966b	1	1	t
07622a71-235c-4659-8792-3e511c9612be	82057f54-4730-4d4a-a86c-16c71dfc5380	0301bb9e-acf4-4752-bc6c-dd5b61888506	b8ef96ac-a20b-40bf-b9e0-0852fe52e052	1	1	t
42f48932-f0ef-48c7-bc50-b5ff5b9099cf	82057f54-4730-4d4a-a86c-16c71dfc5380	0301bb9e-acf4-4752-bc6c-dd5b61888506	d2f797b4-ed84-42fe-b2c9-48700f255658	1	1	t
72bdc92b-9c59-4c32-aa8a-6e948b4a0236	82057f54-4730-4d4a-a86c-16c71dfc5380	0301bb9e-acf4-4752-bc6c-dd5b61888506	2716dd30-563b-4203-a4a1-dfa1ce9174c0	1	1	t
18350dca-f6cf-457b-8811-b99aba0acfa6	82057f54-4730-4d4a-a86c-16c71dfc5380	0301bb9e-acf4-4752-bc6c-dd5b61888506	dc00b586-b2ac-4152-a76a-1dcb42105b72	1	1	t
6918ceec-cf78-4cc4-95e1-a78940980f2d	82057f54-4730-4d4a-a86c-16c71dfc5380	0dd03925-0b7d-4e76-aff3-bc85e7fb21f9	c38378c9-90b2-41f5-857b-73bbc8c4966b	1	1	t
aab2d36f-b2c0-493a-b098-3dd4337275b2	82057f54-4730-4d4a-a86c-16c71dfc5380	0dd03925-0b7d-4e76-aff3-bc85e7fb21f9	b8ef96ac-a20b-40bf-b9e0-0852fe52e052	1	1	t
4609b9db-fdc4-43f2-8cdf-269aae6dd1cd	82057f54-4730-4d4a-a86c-16c71dfc5380	0dd03925-0b7d-4e76-aff3-bc85e7fb21f9	d2f797b4-ed84-42fe-b2c9-48700f255658	1	1	t
f9bcaa65-5810-4f77-9588-ce6a62e9b7a3	82057f54-4730-4d4a-a86c-16c71dfc5380	0dd03925-0b7d-4e76-aff3-bc85e7fb21f9	2716dd30-563b-4203-a4a1-dfa1ce9174c0	1	1	t
9e406b33-012e-4ea1-b568-82c0d32f656b	82057f54-4730-4d4a-a86c-16c71dfc5380	0dd03925-0b7d-4e76-aff3-bc85e7fb21f9	dc00b586-b2ac-4152-a76a-1dcb42105b72	1	1	t
556417c5-6e08-4b01-af13-5af4177f369b	82057f54-4730-4d4a-a86c-16c71dfc5380	f4943e73-e9b1-4b80-952e-9157088c26bb	c38378c9-90b2-41f5-857b-73bbc8c4966b	1	1	t
5ff794c6-c52b-449f-bbc7-c121b59b883c	82057f54-4730-4d4a-a86c-16c71dfc5380	f4943e73-e9b1-4b80-952e-9157088c26bb	b8ef96ac-a20b-40bf-b9e0-0852fe52e052	1	1	t
16c4f45d-62bd-4e23-b1fe-9d33d152d5df	82057f54-4730-4d4a-a86c-16c71dfc5380	f4943e73-e9b1-4b80-952e-9157088c26bb	d2f797b4-ed84-42fe-b2c9-48700f255658	1	1	t
79143415-d000-438d-b28e-6f7fffc66ee6	82057f54-4730-4d4a-a86c-16c71dfc5380	f4943e73-e9b1-4b80-952e-9157088c26bb	2716dd30-563b-4203-a4a1-dfa1ce9174c0	1	1	t
3b3eb986-860a-4d7a-8250-a035d7fc5d47	82057f54-4730-4d4a-a86c-16c71dfc5380	f4943e73-e9b1-4b80-952e-9157088c26bb	dc00b586-b2ac-4152-a76a-1dcb42105b72	1	1	t
\.


--
-- Data for Name: tray_verifications; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tray_verifications (id, tenant_id, tray_stock_item_id, manifest_version_id, location_id, shipment_id, case_id, seal_intact, result, verified_by, verified_at, recorded_at, supersedes_id) FROM stdin;
de7a68cf-de41-4b01-8ff0-c15f3cfb749e	82057f54-4730-4d4a-a86c-16c71dfc5380	6347b29f-96e5-4886-ac37-66af7c072957	34787028-e1a3-450b-9506-b293285e95f9	2dd920a2-792c-4540-bc80-6a1b1185f37a	\N	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	t	complete	ff8b05fb-2d7a-42af-9046-444b2c57f169	2026-10-30 17:00:00.028+00	2026-10-30 17:00:00.028+00	\N
c7aab3e3-1b04-4b3e-ab62-8975cd4ca5b5	82057f54-4730-4d4a-a86c-16c71dfc5380	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	34787028-e1a3-450b-9506-b293285e95f9	2dd920a2-792c-4540-bc80-6a1b1185f37a	\N	555a2002-df45-4f75-a01c-a237a8347b4c	t	complete	ff8b05fb-2d7a-42af-9046-444b2c57f169	2026-11-09 05:00:00.023+00	2026-11-09 05:00:00.023+00	\N
0301bb9e-acf4-4752-bc6c-dd5b61888506	82057f54-4730-4d4a-a86c-16c71dfc5380	6347b29f-96e5-4886-ac37-66af7c072957	34787028-e1a3-450b-9506-b293285e95f9	a012ca09-e3b3-42bb-ad07-7f8a19aaf4bd	\N	964622f1-c4fa-4547-8b0a-2b8334c6d297	t	complete	79fe508f-120a-412e-9736-0cf2c80e484e	2026-11-14 07:00:00.031+00	2026-11-14 07:00:00.031+00	de7a68cf-de41-4b01-8ff0-c15f3cfb749e
0dd03925-0b7d-4e76-aff3-bc85e7fb21f9	82057f54-4730-4d4a-a86c-16c71dfc5380	6347b29f-96e5-4886-ac37-66af7c072957	34787028-e1a3-450b-9506-b293285e95f9	241007a7-e552-4c9d-903e-dd625ca691fe	\N	\N	t	complete	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-18 21:00:00.042+00	2026-11-18 21:00:00.042+00	0301bb9e-acf4-4752-bc6c-dd5b61888506
f4943e73-e9b1-4b80-952e-9157088c26bb	82057f54-4730-4d4a-a86c-16c71dfc5380	7d1a77fd-fbf8-45a8-a7e2-28a81166fb6b	34787028-e1a3-450b-9506-b293285e95f9	241007a7-e552-4c9d-903e-dd625ca691fe	\N	\N	t	complete	f9cb6410-00b4-4cbc-a33a-7f982dea9e24	2026-11-18 21:00:00.04+00	2026-11-18 21:00:00.04+00	c7aab3e3-1b04-4b3e-ab62-8975cd4ca5b5
\.


--
-- Data for Name: usage_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.usage_events (id, tenant_id, case_id, client_event_id, catalog_item_id, stock_item_id, disposition, qty_units, reviewed_qty_units, package_gtin, units_per_package, entry_method, raw_scan, scan_format, parsed, status, review_reason, recorded_offline, actor_user_id, occurred_at, recorded_at, reviewed_by, reviewed_at) FROM stdin;
d13b84c1-a8b8-41ed-9f2e-87b40c9ec823	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	seed-SYN-0901-INS-0010	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	7b804cd3-400b-401d-a270-8f439e96370a	implanted	1	\N	\N	\N	scanner	]d201006141410010191728021410L26C03021INS-0010	GS1	{"ok": true, "lot": "L26C030", "gtin": "00614141001019", "errors": [], "expiry": "2028-02-14", "format": "GS1", "serial": "INS-0010", "elements": [{"ai": "01", "value": "00614141001019"}, {"ai": "17", "value": "280214"}, {"ai": "10", "value": "L26C030"}, {"ai": "21", "value": "INS-0010"}]}	recorded	\N	f	679a78ec-76fe-4700-b459-b9f4d0c6dda2	2026-10-31 15:30:00.003+00	2026-10-31 15:30:00.006+00	\N	\N
d646f2ed-d67a-4019-88e5-27e5ff405706	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	seed-SYN-0901-FEM4L-0102	7d11617a-4813-4b5c-90f0-19626f5db56f	4ef0a46d-e8ff-4c36-8d88-f7e9f789b804	implanted	1	\N	\N	\N	scanner	]d201006141410020161728040410L26B11021FEM4L-0102	GS1	{"ok": true, "lot": "L26B110", "gtin": "00614141002016", "errors": [], "expiry": "2028-04-04", "format": "GS1", "serial": "FEM4L-0102", "elements": [{"ai": "01", "value": "00614141002016"}, {"ai": "17", "value": "280404"}, {"ai": "10", "value": "L26B110"}, {"ai": "21", "value": "FEM4L-0102"}]}	recorded	\N	f	679a78ec-76fe-4700-b459-b9f4d0c6dda2	2026-10-31 15:30:00.017+00	2026-10-31 15:30:00.019+00	\N	\N
7f774264-ce43-41d3-be09-c017e47d47f2	82057f54-4730-4d4a-a86c-16c71dfc5380	a7db2c99-3cc1-467e-9896-2dd3bf1a32fa	seed-SYN-0901-TIB4-0202	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	f6c15774-458d-4b23-8516-5334b95ef36f	implanted	1	\N	\N	\N	scanner	]d201006141410030131728040410L26B21021TIB4-0202	GS1	{"ok": true, "lot": "L26B210", "gtin": "00614141003013", "errors": [], "expiry": "2028-04-04", "format": "GS1", "serial": "TIB4-0202", "elements": [{"ai": "01", "value": "00614141003013"}, {"ai": "17", "value": "280404"}, {"ai": "10", "value": "L26B210"}, {"ai": "21", "value": "TIB4-0202"}]}	recorded	\N	f	679a78ec-76fe-4700-b459-b9f4d0c6dda2	2026-10-31 15:30:00.029+00	2026-10-31 15:30:00.03+00	\N	\N
ef38dd1e-1795-408b-857c-c4d10c30d45d	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	seed-SYN-0902-INS-0011	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	bb2e661b-b202-47a4-8c71-b06f6d0bee8a	implanted	1	\N	\N	\N	scanner	]d201006141410010191728021410L26C03021INS-0011	GS1	{"ok": true, "lot": "L26C030", "gtin": "00614141001019", "errors": [], "expiry": "2028-02-14", "format": "GS1", "serial": "INS-0011", "elements": [{"ai": "01", "value": "00614141001019"}, {"ai": "17", "value": "280214"}, {"ai": "10", "value": "L26C030"}, {"ai": "21", "value": "INS-0011"}]}	recorded	\N	f	679a78ec-76fe-4700-b459-b9f4d0c6dda2	2026-11-09 16:30:00.003+00	2026-11-09 16:30:00.004+00	\N	\N
5c6dbf1d-3171-4ab7-8a0e-108f3ab8c170	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	seed-SYN-0902-FEM4L-0103	7d11617a-4813-4b5c-90f0-19626f5db56f	bfeb5892-4fb4-465f-b784-24df21fed08a	implanted	1	\N	\N	\N	scanner	]d201006141410020161728040410L26B11021FEM4L-0103	GS1	{"ok": true, "lot": "L26B110", "gtin": "00614141002016", "errors": [], "expiry": "2028-04-04", "format": "GS1", "serial": "FEM4L-0103", "elements": [{"ai": "01", "value": "00614141002016"}, {"ai": "17", "value": "280404"}, {"ai": "10", "value": "L26B110"}, {"ai": "21", "value": "FEM4L-0103"}]}	recorded	\N	f	679a78ec-76fe-4700-b459-b9f4d0c6dda2	2026-11-09 16:30:00.014+00	2026-11-09 16:30:00.015+00	\N	\N
e26cebb0-5047-4dec-b57f-9d1f991b7e2f	82057f54-4730-4d4a-a86c-16c71dfc5380	555a2002-df45-4f75-a01c-a237a8347b4c	seed-SYN-0902-TIB4-0203	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	eb949393-b146-40b3-9e5e-6135546fdc2d	implanted	1	\N	\N	\N	scanner	]d201006141410030131728040410L26B21021TIB4-0203	GS1	{"ok": true, "lot": "L26B210", "gtin": "00614141003013", "errors": [], "expiry": "2028-04-04", "format": "GS1", "serial": "TIB4-0203", "elements": [{"ai": "01", "value": "00614141003013"}, {"ai": "17", "value": "280404"}, {"ai": "10", "value": "L26B210"}, {"ai": "21", "value": "TIB4-0203"}]}	recorded	\N	f	679a78ec-76fe-4700-b459-b9f4d0c6dda2	2026-11-09 16:30:00.023+00	2026-11-09 16:30:00.024+00	\N	\N
991ae806-5429-4fc1-8a43-0f5c7bee747e	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	seed-SYN-0903-INS-0007	b7ecd92b-dd2f-42e1-8df4-2703b4b7b445	4dd05f15-7329-433d-aacd-2ebc86ee4e44	implanted	1	\N	\N	\N	scanner	]d201006141410010191727091710L26A00321INS-0007	GS1	{"ok": true, "lot": "L26A003", "gtin": "00614141001019", "errors": [], "expiry": "2027-09-17", "format": "GS1", "serial": "INS-0007", "elements": [{"ai": "01", "value": "00614141001019"}, {"ai": "17", "value": "270917"}, {"ai": "10", "value": "L26A003"}, {"ai": "21", "value": "INS-0007"}]}	recorded	\N	f	cee93967-cedb-4428-87c4-e090c376edf7	2026-11-15 15:30:00.002+00	2026-11-15 15:30:00.003+00	\N	\N
3a597841-ea78-47f5-b5dd-46f98a8f4d22	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	seed-SYN-0903-FEM4L-0105	7d11617a-4813-4b5c-90f0-19626f5db56f	c28c3811-bd2d-4fb8-a390-b815162fba25	implanted	1	\N	\N	\N	scanner	]d201006141410020161728040410L26B11021FEM4L-0105	GS1	{"ok": true, "lot": "L26B110", "gtin": "00614141002016", "errors": [], "expiry": "2028-04-04", "format": "GS1", "serial": "FEM4L-0105", "elements": [{"ai": "01", "value": "00614141002016"}, {"ai": "17", "value": "280404"}, {"ai": "10", "value": "L26B110"}, {"ai": "21", "value": "FEM4L-0105"}]}	recorded	\N	f	cee93967-cedb-4428-87c4-e090c376edf7	2026-11-15 15:30:00.009+00	2026-11-15 15:30:00.01+00	\N	\N
27f5b7e7-e6f5-4434-9b0f-7a0806ec0791	82057f54-4730-4d4a-a86c-16c71dfc5380	964622f1-c4fa-4547-8b0a-2b8334c6d297	seed-SYN-0903-TIB4-0204	4fc32bd5-e912-411b-a0aa-b819ebf07aa6	6b82bbc6-7246-48d8-92b8-f6ba4f755942	implanted	1	\N	\N	\N	scanner	]d201006141410030131728040410L26B21021TIB4-0204	GS1	{"ok": true, "lot": "L26B210", "gtin": "00614141003013", "errors": [], "expiry": "2028-04-04", "format": "GS1", "serial": "TIB4-0204", "elements": [{"ai": "01", "value": "00614141003013"}, {"ai": "17", "value": "280404"}, {"ai": "10", "value": "L26B210"}, {"ai": "21", "value": "TIB4-0204"}]}	recorded	\N	f	cee93967-cedb-4428-87c4-e090c376edf7	2026-11-15 15:30:00.015+00	2026-11-15 15:30:00.016+00	\N	\N
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, tenant_id, email, display_name, password_hash, role, facility_id, territory_id, phone_hint, active, created_at) FROM stdin;
9bd9ad2b-2664-4d61-ad81-b028e87a533f	82057f54-4730-4d4a-a86c-16c71dfc5380	ops@lakeshore.example	Morgan Hale	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	ops_manager	\N	\N	\N	t	2026-11-21 21:32:14.749729+00
96730663-96b5-4d44-919e-f3965640e7a4	82057f54-4730-4d4a-a86c-16c71dfc5380	inventory@lakeshore.example	Casey Lin	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	inventory_coordinator	\N	\N	\N	t	2026-11-21 21:32:14.749729+00
08a0e020-5111-4efb-896a-155198f3da03	82057f54-4730-4d4a-a86c-16c71dfc5380	scheduler@lakeshore.example	Pat Rivera	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	scheduler	\N	\N	\N	t	2026-11-21 21:32:14.749729+00
679a78ec-76fe-4700-b459-b9f4d0c6dda2	82057f54-4730-4d4a-a86c-16c71dfc5380	riley.rep@lakeshore.example	Riley Novak	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	rep	\N	b82a7fc8-4f6a-4f9f-a11a-e305d2a7dff8	\N	t	2026-11-21 21:32:14.749729+00
cee93967-cedb-4428-87c4-e090c376edf7	82057f54-4730-4d4a-a86c-16c71dfc5380	jordan.rep@lakeshore.example	Jordan Ames	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	rep	\N	f54a6002-3a27-4e7e-bb26-7cce6461523a	\N	t	2026-11-21 21:32:14.749729+00
f9cb6410-00b4-4cbc-a33a-7f982dea9e24	82057f54-4730-4d4a-a86c-16c71dfc5380	warehouse@lakeshore.example	Sam Okafor	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	warehouse	\N	\N	\N	t	2026-11-21 21:32:14.749729+00
37edafe9-7c57-4171-8bb7-83f26e1f740f	82057f54-4730-4d4a-a86c-16c71dfc5380	courier@lakeshore.example	Dana Ruiz (courier)	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	courier	\N	\N	\N	t	2026-11-21 21:32:14.749729+00
ff8b05fb-2d7a-42af-9046-444b2c57f169	82057f54-4730-4d4a-a86c-16c71dfc5380	receiving@stbrigid.example	Alex Byrne (SBR receiving)	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	hospital_receiving	61d14381-fb23-4f39-91d4-3901a30558b1	\N	\N	t	2026-11-21 21:32:14.749729+00
703a5c38-b16a-4fa9-bef8-4381b8b2160d	82057f54-4730-4d4a-a86c-16c71dfc5380	spd@stbrigid.example	Robin Shah (SBR SPD)	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	hospital_spd	61d14381-fb23-4f39-91d4-3901a30558b1	\N	\N	t	2026-11-21 21:32:14.749729+00
79fe508f-120a-412e-9736-0cf2c80e484e	82057f54-4730-4d4a-a86c-16c71dfc5380	receiving@prairievalley.example	Taylor Quinn (PVS receiving)	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	hospital_receiving	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	\N	\N	t	2026-11-21 21:32:14.749729+00
4cc78ada-2732-4d58-b120-2e69660af354	82057f54-4730-4d4a-a86c-16c71dfc5380	spd@prairievalley.example	Jamie Cole (PVS SPD)	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	hospital_spd	2e0ce16e-f5c1-4d6f-a602-d73d338b4a3b	\N	\N	t	2026-11-21 21:32:14.749729+00
ca201980-0055-472e-aa6d-b430c55ce512	82057f54-4730-4d4a-a86c-16c71dfc5380	finance@lakeshore.example	Avery Brooks	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	finance	\N	\N	\N	t	2026-11-21 21:32:14.749729+00
2087cb4c-c6f4-4939-9f1a-e9a6978536e2	82057f54-4730-4d4a-a86c-16c71dfc5380	quality@lakeshore.example	Quinn Mercer	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	quality_manager	\N	\N	\N	t	2026-11-21 21:32:14.749729+00
86b3b8d5-f840-47fc-b268-7bc8f7595114	82057f54-4730-4d4a-a86c-16c71dfc5380	quality2@lakeshore.example	Val Ortega	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	quality_manager	\N	\N	\N	t	2026-11-21 21:32:14.749729+00
94490609-def7-4b8a-8e0a-e1a3fe7360c2	82057f54-4730-4d4a-a86c-16c71dfc5380	admin@lakeshore.example	Lee Admin	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	admin	\N	\N	\N	t	2026-11-21 21:32:14.749729+00
6036f218-b42b-4b37-a0ea-9568c11d4562	bdc0230c-75cb-47f1-bc8b-f13ddb1aa1b8	ops@ridgeway.example	Kai Ridgeway Ops	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	ops_manager	\N	\N	\N	t	2026-11-21 21:32:15.747129+00
b64f6aea-951e-498e-a357-79ac76a73f4b	bdc0230c-75cb-47f1-bc8b-f13ddb1aa1b8	rep@ridgeway.example	Noor Ridgeway Rep	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	rep	\N	\N	\N	t	2026-11-21 21:32:15.747129+00
0593e456-713f-499c-a351-2a783d0df458	bdc0230c-75cb-47f1-bc8b-f13ddb1aa1b8	receiving@harborpoint.example	Harbor Point Receiving	$2b$10$tL4GZ0nzL8V8it.T49eCZ.uQSnKTg7P2uTuzqoqYl.xUJVc/oHmzi	hospital_receiving	346ce5f9-2e84-4d97-a571-227b24b82026	\N	\N	t	2026-11-21 21:32:15.747129+00
\.


--
-- Name: audit_log_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.audit_log_id_seq', 82, true);


--
-- Name: inventory_movements_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.inventory_movements_id_seq', 64, true);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: billing_packets billing_packets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_packets
    ADD CONSTRAINT billing_packets_pkey PRIMARY KEY (id);


--
-- Name: case_requirements case_requirements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_requirements
    ADD CONSTRAINT case_requirements_pkey PRIMARY KEY (id);


--
-- Name: cases cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_pkey PRIMARY KEY (id);


--
-- Name: cases cases_tenant_id_case_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_tenant_id_case_ref_key UNIQUE (tenant_id, case_ref);


--
-- Name: catalog_items catalog_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_items
    ADD CONSTRAINT catalog_items_pkey PRIMARY KEY (id);


--
-- Name: catalog_items catalog_items_tenant_id_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_items
    ADD CONSTRAINT catalog_items_tenant_id_ref_key UNIQUE (tenant_id, ref);


--
-- Name: catalog_items catalog_items_tenant_id_unit_gtin_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_items
    ADD CONSTRAINT catalog_items_tenant_id_unit_gtin_key UNIQUE (tenant_id, unit_gtin);


--
-- Name: charges charges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.charges
    ADD CONSTRAINT charges_pkey PRIMARY KEY (id);


--
-- Name: charges charges_usage_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.charges
    ADD CONSTRAINT charges_usage_event_id_key UNIQUE (usage_event_id);


--
-- Name: contract_prices contract_prices_contract_version_id_catalog_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_prices
    ADD CONSTRAINT contract_prices_contract_version_id_catalog_item_id_key UNIQUE (contract_version_id, catalog_item_id);


--
-- Name: contract_prices contract_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_prices
    ADD CONSTRAINT contract_prices_pkey PRIMARY KEY (id);


--
-- Name: contract_rules contract_rules_contract_version_id_disposition_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_rules
    ADD CONSTRAINT contract_rules_contract_version_id_disposition_key UNIQUE (contract_version_id, disposition);


--
-- Name: contract_rules contract_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_rules
    ADD CONSTRAINT contract_rules_pkey PRIMARY KEY (id);


--
-- Name: contract_versions contract_versions_contract_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_versions
    ADD CONSTRAINT contract_versions_contract_id_version_key UNIQUE (contract_id, version);


--
-- Name: contract_versions contract_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_versions
    ADD CONSTRAINT contract_versions_pkey PRIMARY KEY (id);


--
-- Name: contracts contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_pkey PRIMARY KEY (id);


--
-- Name: count_lines count_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.count_lines
    ADD CONSTRAINT count_lines_pkey PRIMARY KEY (id);


--
-- Name: count_lines count_lines_session_id_stock_item_id_owner_party_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.count_lines
    ADD CONSTRAINT count_lines_session_id_stock_item_id_owner_party_id_key UNIQUE (session_id, stock_item_id, owner_party_id);


--
-- Name: count_sessions count_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.count_sessions
    ADD CONSTRAINT count_sessions_pkey PRIMARY KEY (id);


--
-- Name: credits credits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credits
    ADD CONSTRAINT credits_pkey PRIMARY KEY (id);


--
-- Name: credits credits_tenant_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credits
    ADD CONSTRAINT credits_tenant_id_idempotency_key_key UNIQUE (tenant_id, idempotency_key);


--
-- Name: custody_events custody_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_events
    ADD CONSTRAINT custody_events_pkey PRIMARY KEY (id);


--
-- Name: discrepancies discrepancies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discrepancies
    ADD CONSTRAINT discrepancies_pkey PRIMARY KEY (id);


--
-- Name: erp_acks erp_acks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erp_acks
    ADD CONSTRAINT erp_acks_pkey PRIMARY KEY (id);


--
-- Name: erp_acks erp_acks_tenant_id_external_doc_ref_ack_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erp_acks
    ADD CONSTRAINT erp_acks_tenant_id_external_doc_ref_ack_type_key UNIQUE (tenant_id, external_doc_ref, ack_type);


--
-- Name: exceptions exceptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exceptions
    ADD CONSTRAINT exceptions_pkey PRIMARY KEY (id);


--
-- Name: exceptions exceptions_tenant_id_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exceptions
    ADD CONSTRAINT exceptions_tenant_id_dedupe_key_key UNIQUE (tenant_id, dedupe_key);


--
-- Name: facilities facilities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facilities
    ADD CONSTRAINT facilities_pkey PRIMARY KEY (id);


--
-- Name: facilities facilities_tenant_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facilities
    ADD CONSTRAINT facilities_tenant_id_code_key UNIQUE (tenant_id, code);


--
-- Name: facility_policies facility_policies_facility_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_policies
    ADD CONSTRAINT facility_policies_facility_id_version_key UNIQUE (facility_id, version);


--
-- Name: facility_policies facility_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_policies
    ADD CONSTRAINT facility_policies_pkey PRIMARY KEY (id);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (tenant_id, key);


--
-- Name: import_batches import_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_pkey PRIMARY KEY (id);


--
-- Name: import_row_keys import_row_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_row_keys
    ADD CONSTRAINT import_row_keys_pkey PRIMARY KEY (tenant_id, kind, source_system, source_id);


--
-- Name: import_rows import_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_rows
    ADD CONSTRAINT import_rows_pkey PRIMARY KEY (id);


--
-- Name: instrument_returns instrument_returns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instrument_returns
    ADD CONSTRAINT instrument_returns_pkey PRIMARY KEY (id);


--
-- Name: instrument_returns instrument_returns_tenant_id_client_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instrument_returns
    ADD CONSTRAINT instrument_returns_tenant_id_client_event_id_key UNIQUE (tenant_id, client_event_id);


--
-- Name: integration_feeds integration_feeds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_feeds
    ADD CONSTRAINT integration_feeds_pkey PRIMARY KEY (id);


--
-- Name: integration_feeds integration_feeds_tenant_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_feeds
    ADD CONSTRAINT integration_feeds_tenant_id_code_key UNIQUE (tenant_id, code);


--
-- Name: inventory_movements inventory_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_pkey PRIMARY KEY (id);


--
-- Name: inventory_movements inventory_movements_reverses_movement_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_reverses_movement_id_key UNIQUE (reverses_movement_id);


--
-- Name: inventory_movements inventory_movements_tenant_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_tenant_id_idempotency_key_key UNIQUE (tenant_id, idempotency_key);


--
-- Name: locations locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_pkey PRIMARY KEY (id);


--
-- Name: locations locations_tenant_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_tenant_id_code_key UNIQUE (tenant_id, code);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_tenant_id_user_id_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_tenant_id_user_id_dedupe_key_key UNIQUE (tenant_id, user_id, dedupe_key);


--
-- Name: outbox_attempts outbox_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_attempts
    ADD CONSTRAINT outbox_attempts_pkey PRIMARY KEY (id);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);


--
-- Name: outbox outbox_tenant_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_tenant_id_idempotency_key_key UNIQUE (tenant_id, idempotency_key);


--
-- Name: packages packages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packages
    ADD CONSTRAINT packages_pkey PRIMARY KEY (id);


--
-- Name: packages packages_tenant_id_gtin_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packages
    ADD CONSTRAINT packages_tenant_id_gtin_key UNIQUE (tenant_id, gtin);


--
-- Name: parties parties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parties
    ADD CONSTRAINT parties_pkey PRIMARY KEY (id);


--
-- Name: parties parties_tenant_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parties
    ADD CONSTRAINT parties_tenant_id_name_key UNIQUE (tenant_id, name);


--
-- Name: preference_card_lines preference_card_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preference_card_lines
    ADD CONSTRAINT preference_card_lines_pkey PRIMARY KEY (id);


--
-- Name: preference_card_versions preference_card_versions_card_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preference_card_versions
    ADD CONSTRAINT preference_card_versions_card_id_version_key UNIQUE (card_id, version);


--
-- Name: preference_card_versions preference_card_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preference_card_versions
    ADD CONSTRAINT preference_card_versions_pkey PRIMARY KEY (id);


--
-- Name: preference_cards preference_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preference_cards
    ADD CONSTRAINT preference_cards_pkey PRIMARY KEY (id);


--
-- Name: preference_cards preference_cards_tenant_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preference_cards
    ADD CONSTRAINT preference_cards_tenant_id_code_key UNIQUE (tenant_id, code);


--
-- Name: purchase_order_lines purchase_order_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_lines
    ADD CONSTRAINT purchase_order_lines_pkey PRIMARY KEY (id);


--
-- Name: purchase_orders purchase_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);


--
-- Name: purchase_orders purchase_orders_tenant_id_po_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_tenant_id_po_number_key UNIQUE (tenant_id, po_number);


--
-- Name: quality_holds quality_holds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_holds
    ADD CONSTRAINT quality_holds_pkey PRIMARY KEY (id);


--
-- Name: recall_tasks recall_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_tasks
    ADD CONSTRAINT recall_tasks_pkey PRIMARY KEY (id);


--
-- Name: recalls recalls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recalls
    ADD CONSTRAINT recalls_pkey PRIMARY KEY (id);


--
-- Name: recalls recalls_tenant_id_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recalls
    ADD CONSTRAINT recalls_tenant_id_ref_key UNIQUE (tenant_id, ref);


--
-- Name: release_decisions release_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.release_decisions
    ADD CONSTRAINT release_decisions_pkey PRIMARY KEY (id);


--
-- Name: replenishments replenishments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replenishments
    ADD CONSTRAINT replenishments_pkey PRIMARY KEY (id);


--
-- Name: replenishments replenishments_usage_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replenishments
    ADD CONSTRAINT replenishments_usage_event_id_key UNIQUE (usage_event_id);


--
-- Name: reservations reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_pkey PRIMARY KEY (id);


--
-- Name: reservations reservations_tenant_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_tenant_id_idempotency_key_key UNIQUE (tenant_id, idempotency_key);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (name);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (token_hash);


--
-- Name: shipment_lines shipment_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_lines
    ADD CONSTRAINT shipment_lines_pkey PRIMARY KEY (id);


--
-- Name: shipments shipments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_pkey PRIMARY KEY (id);


--
-- Name: shipments shipments_tenant_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_tenant_id_idempotency_key_key UNIQUE (tenant_id, idempotency_key);


--
-- Name: shipments shipments_tenant_id_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_tenant_id_ref_key UNIQUE (tenant_id, ref);


--
-- Name: stock_balances stock_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_balances
    ADD CONSTRAINT stock_balances_pkey PRIMARY KEY (id);


--
-- Name: stock_balances stock_balances_stock_item_id_location_id_owner_party_id_con_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_balances
    ADD CONSTRAINT stock_balances_stock_item_id_location_id_owner_party_id_con_key UNIQUE (stock_item_id, location_id, owner_party_id, condition);


--
-- Name: stock_items stock_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_items
    ADD CONSTRAINT stock_items_pkey PRIMARY KEY (id);


--
-- Name: sync_differences sync_differences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_differences
    ADD CONSTRAINT sync_differences_pkey PRIMARY KEY (id);


--
-- Name: system_settings system_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (key);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_slug_key UNIQUE (slug);


--
-- Name: territories territories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.territories
    ADD CONSTRAINT territories_pkey PRIMARY KEY (id);


--
-- Name: travel_estimates travel_estimates_from_location_id_to_facility_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.travel_estimates
    ADD CONSTRAINT travel_estimates_from_location_id_to_facility_id_key UNIQUE (from_location_id, to_facility_id);


--
-- Name: travel_estimates travel_estimates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.travel_estimates
    ADD CONSTRAINT travel_estimates_pkey PRIMARY KEY (id);


--
-- Name: tray_instances tray_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_instances
    ADD CONSTRAINT tray_instances_pkey PRIMARY KEY (stock_item_id);


--
-- Name: tray_manifest_lines tray_manifest_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_manifest_lines
    ADD CONSTRAINT tray_manifest_lines_pkey PRIMARY KEY (id);


--
-- Name: tray_manifest_versions tray_manifest_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_manifest_versions
    ADD CONSTRAINT tray_manifest_versions_pkey PRIMARY KEY (id);


--
-- Name: tray_manifest_versions tray_manifest_versions_tray_catalog_item_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_manifest_versions
    ADD CONSTRAINT tray_manifest_versions_tray_catalog_item_id_version_key UNIQUE (tray_catalog_item_id, version);


--
-- Name: tray_verification_lines tray_verification_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_verification_lines
    ADD CONSTRAINT tray_verification_lines_pkey PRIMARY KEY (id);


--
-- Name: tray_verifications tray_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_verifications
    ADD CONSTRAINT tray_verifications_pkey PRIMARY KEY (id);


--
-- Name: usage_events usage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_events
    ADD CONSTRAINT usage_events_pkey PRIMARY KEY (id);


--
-- Name: usage_events usage_events_tenant_id_client_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_events
    ADD CONSTRAINT usage_events_tenant_id_client_event_id_key UNIQUE (tenant_id, client_event_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: audit_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_case ON public.audit_log USING btree (tenant_id, case_id);


--
-- Name: billing_packets_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX billing_packets_one_active ON public.billing_packets USING btree (tenant_id, case_id, packet_type) WHERE (status <> 'void'::text);


--
-- Name: inv_mov_stock; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inv_mov_stock ON public.inventory_movements USING btree (tenant_id, stock_item_id);


--
-- Name: quality_holds_active_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quality_holds_active_uq ON public.quality_holds USING btree (stock_item_id, recall_id) WHERE (status = 'active'::text);


--
-- Name: reservations_serial_active_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX reservations_serial_active_uq ON public.reservations USING btree (tenant_id, stock_item_id) WHERE ((status = 'active'::text) AND is_serial);


--
-- Name: stock_items_lot_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX stock_items_lot_uq ON public.stock_items USING btree (tenant_id, catalog_item_id, lot_number) WHERE (serial_number IS NULL);


--
-- Name: stock_items_serial_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX stock_items_serial_uq ON public.stock_items USING btree (tenant_id, catalog_item_id, serial_number) WHERE (serial_number IS NOT NULL);


--
-- Name: audit_log audit_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_append_only BEFORE DELETE OR UPDATE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();


--
-- Name: credits credits_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER credits_append_only BEFORE DELETE OR UPDATE ON public.credits FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();


--
-- Name: custody_events custody_ack; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER custody_ack BEFORE DELETE OR UPDATE ON public.custody_events FOR EACH ROW EXECUTE FUNCTION public.custody_ack_only();


--
-- Name: erp_acks erp_acks_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erp_acks_append_only BEFORE DELETE OR UPDATE ON public.erp_acks FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();


--
-- Name: inventory_movements movements_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER movements_append_only BEFORE DELETE OR UPDATE ON public.inventory_movements FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();


--
-- Name: release_decisions release_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER release_append_only BEFORE DELETE OR UPDATE ON public.release_decisions FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();


--
-- Name: stock_balances serial_unit_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER serial_unit_check AFTER INSERT OR UPDATE ON public.stock_balances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.serial_single_unit();


--
-- Name: usage_events usage_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER usage_guard BEFORE DELETE OR UPDATE ON public.usage_events FOR EACH ROW EXECUTE FUNCTION public.usage_no_delete();


--
-- Name: tray_verifications verif_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER verif_append_only BEFORE DELETE OR UPDATE ON public.tray_verifications FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();


--
-- Name: audit_log audit_log_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);


--
-- Name: audit_log audit_log_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: billing_packets billing_packets_accepted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_packets
    ADD CONSTRAINT billing_packets_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES public.users(id);


--
-- Name: billing_packets billing_packets_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_packets
    ADD CONSTRAINT billing_packets_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id);


--
-- Name: billing_packets billing_packets_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_packets
    ADD CONSTRAINT billing_packets_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: billing_packets billing_packets_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_packets
    ADD CONSTRAINT billing_packets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: case_requirements case_requirements_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_requirements
    ADD CONSTRAINT case_requirements_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id);


--
-- Name: case_requirements case_requirements_catalog_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_requirements
    ADD CONSTRAINT case_requirements_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id);


--
-- Name: case_requirements case_requirements_source_card_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_requirements
    ADD CONSTRAINT case_requirements_source_card_line_id_fkey FOREIGN KEY (source_card_line_id) REFERENCES public.preference_card_lines(id);


--
-- Name: case_requirements case_requirements_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_requirements
    ADD CONSTRAINT case_requirements_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: cases cases_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: cases cases_facility_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_facility_id_fkey FOREIGN KEY (facility_id) REFERENCES public.facilities(id);


--
-- Name: cases cases_preference_card_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_preference_card_version_id_fkey FOREIGN KEY (preference_card_version_id) REFERENCES public.preference_card_versions(id);


--
-- Name: cases cases_rep_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_rep_user_id_fkey FOREIGN KEY (rep_user_id) REFERENCES public.users(id);


--
-- Name: cases cases_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: catalog_items catalog_items_import_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_items
    ADD CONSTRAINT catalog_items_import_batch_id_fkey FOREIGN KEY (import_batch_id) REFERENCES public.import_batches(id);


--
-- Name: catalog_items catalog_items_manufacturer_party_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_items
    ADD CONSTRAINT catalog_items_manufacturer_party_id_fkey FOREIGN KEY (manufacturer_party_id) REFERENCES public.parties(id);


--
-- Name: catalog_items catalog_items_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_items
    ADD CONSTRAINT catalog_items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: charges charges_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.charges
    ADD CONSTRAINT charges_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id);


--
-- Name: charges charges_catalog_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.charges
    ADD CONSTRAINT charges_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id);


--
-- Name: charges charges_contract_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.charges
    ADD CONSTRAINT charges_contract_version_id_fkey FOREIGN KEY (contract_version_id) REFERENCES public.contract_versions(id);


--
-- Name: charges charges_packet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.charges
    ADD CONSTRAINT charges_packet_id_fkey FOREIGN KEY (packet_id) REFERENCES public.billing_packets(id);


--
-- Name: charges charges_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.charges
    ADD CONSTRAINT charges_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.contract_rules(id);


--
-- Name: charges charges_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.charges
    ADD CONSTRAINT charges_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: charges charges_usage_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.charges
    ADD CONSTRAINT charges_usage_event_id_fkey FOREIGN KEY (usage_event_id) REFERENCES public.usage_events(id);


--
-- Name: contract_prices contract_prices_catalog_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_prices
    ADD CONSTRAINT contract_prices_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id);


--
-- Name: contract_prices contract_prices_contract_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_prices
    ADD CONSTRAINT contract_prices_contract_version_id_fkey FOREIGN KEY (contract_version_id) REFERENCES public.contract_versions(id);


--
-- Name: contract_prices contract_prices_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_prices
    ADD CONSTRAINT contract_prices_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: contract_rules contract_rules_contract_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_rules
    ADD CONSTRAINT contract_rules_contract_version_id_fkey FOREIGN KEY (contract_version_id) REFERENCES public.contract_versions(id);


--
-- Name: contract_rules contract_rules_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_rules
    ADD CONSTRAINT contract_rules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: contract_versions contract_versions_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_versions
    ADD CONSTRAINT contract_versions_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id);


--
-- Name: contract_versions contract_versions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_versions
    ADD CONSTRAINT contract_versions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: contracts contracts_facility_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_facility_id_fkey FOREIGN KEY (facility_id) REFERENCES public.facilities(id);


--
-- Name: contracts contracts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: count_lines count_lines_owner_party_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.count_lines
    ADD CONSTRAINT count_lines_owner_party_id_fkey FOREIGN KEY (owner_party_id) REFERENCES public.parties(id);


--
-- Name: count_lines count_lines_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.count_lines
    ADD CONSTRAINT count_lines_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.count_sessions(id);


--
-- Name: count_lines count_lines_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.count_lines
    ADD CONSTRAINT count_lines_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES public.stock_items(id);


--
-- Name: count_lines count_lines_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.count_lines
    ADD CONSTRAINT count_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: count_sessions count_sessions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.count_sessions
    ADD CONSTRAINT count_sessions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: count_sessions count_sessions_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.count_sessions
    ADD CONSTRAINT count_sessions_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.locations(id);


--
-- Name: count_sessions count_sessions_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.count_sessions
    ADD CONSTRAINT count_sessions_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);


--
-- Name: count_sessions count_sessions_submitted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.count_sessions
    ADD CONSTRAINT count_sessions_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.users(id);


--
-- Name: count_sessions count_sessions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.count_sessions
    ADD CONSTRAINT count_sessions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: credits credits_charge_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credits
    ADD CONSTRAINT credits_charge_id_fkey FOREIGN KEY (charge_id) REFERENCES public.charges(id);


--
-- Name: credits credits_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credits
    ADD CONSTRAINT credits_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: credits credits_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credits
    ADD CONSTRAINT credits_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: custody_events custody_events_ack_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_events
    ADD CONSTRAINT custody_events_ack_by_fkey FOREIGN KEY (ack_by) REFERENCES public.users(id);


--
-- Name: custody_events custody_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_events
    ADD CONSTRAINT custody_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);


--
-- Name: custody_events custody_events_from_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_events
    ADD CONSTRAINT custody_events_from_location_id_fkey FOREIGN KEY (from_location_id) REFERENCES public.locations(id);


--
-- Name: custody_events custody_events_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_events
    ADD CONSTRAINT custody_events_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES public.shipments(id);


--
-- Name: custody_events custody_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_events
    ADD CONSTRAINT custody_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: custody_events custody_events_to_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_events
    ADD CONSTRAINT custody_events_to_location_id_fkey FOREIGN KEY (to_location_id) REFERENCES public.locations(id);


--
-- Name: discrepancies discrepancies_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discrepancies
    ADD CONSTRAINT discrepancies_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id);


--
-- Name: discrepancies discrepancies_catalog_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discrepancies
    ADD CONSTRAINT discrepancies_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id);


--
-- Name: discrepancies discrepancies_reported_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discrepancies
    ADD CONSTRAINT discrepancies_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES public.users(id);


--
-- Name: discrepancies discrepancies_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discrepancies
    ADD CONSTRAINT discrepancies_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: discrepancies discrepancies_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discrepancies
    ADD CONSTRAINT discrepancies_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES public.shipments(id);


--
-- Name: discrepancies discrepancies_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discrepancies
    ADD CONSTRAINT discrepancies_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES public.stock_items(id);


--
-- Name: discrepancies discrepancies_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discrepancies
    ADD CONSTRAINT discrepancies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: discrepancies discrepancies_tray_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discrepancies
    ADD CONSTRAINT discrepancies_tray_stock_item_id_fkey FOREIGN KEY (tray_stock_item_id) REFERENCES public.stock_items(id);


--
-- Name: erp_acks erp_acks_outbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erp_acks
    ADD CONSTRAINT erp_acks_outbox_id_fkey FOREIGN KEY (outbox_id) REFERENCES public.outbox(id);


--
-- Name: erp_acks erp_acks_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erp_acks
    ADD CONSTRAINT erp_acks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: exceptions exceptions_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exceptions
    ADD CONSTRAINT exceptions_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id);


--
-- Name: exceptions exceptions_facility_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exceptions
    ADD CONSTRAINT exceptions_facility_id_fkey FOREIGN KEY (facility_id) REFERENCES public.facilities(id);


--
-- Name: exceptions exceptions_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exceptions
    ADD CONSTRAINT exceptions_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);


--
-- Name: exceptions exceptions_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exceptions
    ADD CONSTRAINT exceptions_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: exceptions exceptions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exceptions
    ADD CONSTRAINT exceptions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: facilities facilities_party_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facilities
    ADD CONSTRAINT facilities_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.parties(id);


--
-- Name: facilities facilities_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facilities
    ADD CONSTRAINT facilities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: facilities facilities_territory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facilities
    ADD CONSTRAINT facilities_territory_id_fkey FOREIGN KEY (territory_id) REFERENCES public.territories(id);


--
-- Name: facility_policies facility_policies_facility_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_policies
    ADD CONSTRAINT facility_policies_facility_id_fkey FOREIGN KEY (facility_id) REFERENCES public.facilities(id);


--
-- Name: facility_policies facility_policies_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facility_policies
    ADD CONSTRAINT facility_policies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: idempotency_keys idempotency_keys_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: import_batches import_batches_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: import_batches import_batches_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: import_row_keys import_row_keys_first_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_row_keys
    ADD CONSTRAINT import_row_keys_first_batch_id_fkey FOREIGN KEY (first_batch_id) REFERENCES public.import_batches(id);


--
-- Name: import_row_keys import_row_keys_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_row_keys
    ADD CONSTRAINT import_row_keys_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: import_rows import_rows_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_rows
    ADD CONSTRAINT import_rows_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.import_batches(id);


--
-- Name: import_rows import_rows_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_rows
    ADD CONSTRAINT import_rows_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: instrument_returns instrument_returns_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instrument_returns
    ADD CONSTRAINT instrument_returns_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id);


--
-- Name: instrument_returns instrument_returns_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instrument_returns
    ADD CONSTRAINT instrument_returns_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.users(id);


--
-- Name: instrument_returns instrument_returns_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instrument_returns
    ADD CONSTRAINT instrument_returns_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: instrument_returns instrument_returns_tray_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instrument_returns
    ADD CONSTRAINT instrument_returns_tray_stock_item_id_fkey FOREIGN KEY (tray_stock_item_id) REFERENCES public.stock_items(id);


--
-- Name: integration_feeds integration_feeds_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_feeds
    ADD CONSTRAINT integration_feeds_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: inventory_movements inventory_movements_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);


--
-- Name: inventory_movements inventory_movements_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id);


--
-- Name: inventory_movements inventory_movements_from_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_from_location_id_fkey FOREIGN KEY (from_location_id) REFERENCES public.locations(id);


--
-- Name: inventory_movements inventory_movements_import_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_import_batch_id_fkey FOREIGN KEY (import_batch_id) REFERENCES public.import_batches(id);


--
-- Name: inventory_movements inventory_movements_owner_party_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_owner_party_id_fkey FOREIGN KEY (owner_party_id) REFERENCES public.parties(id);


--
-- Name: inventory_movements inventory_movements_reverses_movement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_reverses_movement_id_fkey FOREIGN KEY (reverses_movement_id) REFERENCES public.inventory_movements(id);


--
-- Name: inventory_movements inventory_movements_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES public.shipments(id);


--
-- Name: inventory_movements inventory_movements_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES public.stock_items(id);


--
-- Name: inventory_movements inventory_movements_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: inventory_movements inventory_movements_to_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_to_location_id_fkey FOREIGN KEY (to_location_id) REFERENCES public.locations(id);


--
-- Name: locations locations_facility_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_facility_id_fkey FOREIGN KEY (facility_id) REFERENCES public.facilities(id);


--
-- Name: locations locations_holder_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_holder_user_id_fkey FOREIGN KEY (holder_user_id) REFERENCES public.users(id);


--
-- Name: locations locations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: notifications notifications_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id);


--
-- Name: notifications notifications_facility_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_facility_id_fkey FOREIGN KEY (facility_id) REFERENCES public.facilities(id);


--
-- Name: notifications notifications_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: outbox_attempts outbox_attempts_outbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_attempts
    ADD CONSTRAINT outbox_attempts_outbox_id_fkey FOREIGN KEY (outbox_id) REFERENCES public.outbox(id);


--
-- Name: outbox_attempts outbox_attempts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_attempts
    ADD CONSTRAINT outbox_attempts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: outbox outbox_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: packages packages_catalog_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packages
    ADD CONSTRAINT packages_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id);


--
-- Name: packages packages_import_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packages
    ADD CONSTRAINT packages_import_batch_id_fkey FOREIGN KEY (import_batch_id) REFERENCES public.import_batches(id);


--
-- Name: packages packages_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packages
    ADD CONSTRAINT packages_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: parties parties_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parties
    ADD CONSTRAINT parties_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: preference_card_lines preference_card_lines_backup_for_line_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preference_card_lines
    ADD CONSTRAINT preference_card_lines_backup_for_line_id_fkey FOREIGN KEY (backup_for_line_id) REFERENCES public.preference_card_lines(id);


--
-- Name: preference_card_lines preference_card_lines_card_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preference_card_lines
    ADD CONSTRAINT preference_card_lines_card_version_id_fkey FOREIGN KEY (card_version_id) REFERENCES public.preference_card_versions(id);


--
-- Name: preference_card_lines preference_card_lines_catalog_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preference_card_lines
    ADD CONSTRAINT preference_card_lines_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id);


--
-- Name: preference_card_lines preference_card_lines_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preference_card_lines
    ADD CONSTRAINT preference_card_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: preference_card_versions preference_card_versions_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preference_card_versions
    ADD CONSTRAINT preference_card_versions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: preference_card_versions preference_card_versions_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preference_card_versions
    ADD CONSTRAINT preference_card_versions_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.preference_cards(id);


--
-- Name: preference_card_versions preference_card_versions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preference_card_versions
    ADD CONSTRAINT preference_card_versions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: preference_cards preference_cards_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preference_cards
    ADD CONSTRAINT preference_cards_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: purchase_order_lines purchase_order_lines_catalog_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_lines
    ADD CONSTRAINT purchase_order_lines_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id);


--
-- Name: purchase_order_lines purchase_order_lines_po_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_lines
    ADD CONSTRAINT purchase_order_lines_po_id_fkey FOREIGN KEY (po_id) REFERENCES public.purchase_orders(id);


--
-- Name: purchase_order_lines purchase_order_lines_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_lines
    ADD CONSTRAINT purchase_order_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: purchase_orders purchase_orders_entered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_entered_by_fkey FOREIGN KEY (entered_by) REFERENCES public.users(id);


--
-- Name: purchase_orders purchase_orders_packet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_packet_id_fkey FOREIGN KEY (packet_id) REFERENCES public.billing_packets(id);


--
-- Name: purchase_orders purchase_orders_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: quality_holds quality_holds_placed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_holds
    ADD CONSTRAINT quality_holds_placed_by_fkey FOREIGN KEY (placed_by) REFERENCES public.users(id);


--
-- Name: quality_holds quality_holds_recall_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_holds
    ADD CONSTRAINT quality_holds_recall_fk FOREIGN KEY (recall_id) REFERENCES public.recalls(id);


--
-- Name: quality_holds quality_holds_released_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_holds
    ADD CONSTRAINT quality_holds_released_by_fkey FOREIGN KEY (released_by) REFERENCES public.users(id);


--
-- Name: quality_holds quality_holds_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_holds
    ADD CONSTRAINT quality_holds_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES public.stock_items(id);


--
-- Name: quality_holds quality_holds_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_holds
    ADD CONSTRAINT quality_holds_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: recall_tasks recall_tasks_acknowledged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_tasks
    ADD CONSTRAINT recall_tasks_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES public.users(id);


--
-- Name: recall_tasks recall_tasks_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_tasks
    ADD CONSTRAINT recall_tasks_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id);


--
-- Name: recall_tasks recall_tasks_dispositioned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_tasks
    ADD CONSTRAINT recall_tasks_dispositioned_by_fkey FOREIGN KEY (dispositioned_by) REFERENCES public.users(id);


--
-- Name: recall_tasks recall_tasks_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_tasks
    ADD CONSTRAINT recall_tasks_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.locations(id);


--
-- Name: recall_tasks recall_tasks_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_tasks
    ADD CONSTRAINT recall_tasks_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);


--
-- Name: recall_tasks recall_tasks_recall_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_tasks
    ADD CONSTRAINT recall_tasks_recall_id_fkey FOREIGN KEY (recall_id) REFERENCES public.recalls(id);


--
-- Name: recall_tasks recall_tasks_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_tasks
    ADD CONSTRAINT recall_tasks_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES public.stock_items(id);


--
-- Name: recall_tasks recall_tasks_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_tasks
    ADD CONSTRAINT recall_tasks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: recall_tasks recall_tasks_usage_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_tasks
    ADD CONSTRAINT recall_tasks_usage_event_id_fkey FOREIGN KEY (usage_event_id) REFERENCES public.usage_events(id);


--
-- Name: recalls recalls_activated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recalls
    ADD CONSTRAINT recalls_activated_by_fkey FOREIGN KEY (activated_by) REFERENCES public.users(id);


--
-- Name: recalls recalls_catalog_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recalls
    ADD CONSTRAINT recalls_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id);


--
-- Name: recalls recalls_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recalls
    ADD CONSTRAINT recalls_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.users(id);


--
-- Name: recalls recalls_entered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recalls
    ADD CONSTRAINT recalls_entered_by_fkey FOREIGN KEY (entered_by) REFERENCES public.users(id);


--
-- Name: recalls recalls_manufacturer_party_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recalls
    ADD CONSTRAINT recalls_manufacturer_party_id_fkey FOREIGN KEY (manufacturer_party_id) REFERENCES public.parties(id);


--
-- Name: recalls recalls_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recalls
    ADD CONSTRAINT recalls_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: recalls recalls_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recalls
    ADD CONSTRAINT recalls_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id);


--
-- Name: release_decisions release_decisions_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.release_decisions
    ADD CONSTRAINT release_decisions_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id);


--
-- Name: release_decisions release_decisions_facility_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.release_decisions
    ADD CONSTRAINT release_decisions_facility_id_fkey FOREIGN KEY (facility_id) REFERENCES public.facilities(id);


--
-- Name: release_decisions release_decisions_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.release_decisions
    ADD CONSTRAINT release_decisions_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.users(id);


--
-- Name: release_decisions release_decisions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.release_decisions
    ADD CONSTRAINT release_decisions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: release_decisions release_decisions_tray_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.release_decisions
    ADD CONSTRAINT release_decisions_tray_stock_item_id_fkey FOREIGN KEY (tray_stock_item_id) REFERENCES public.stock_items(id);


--
-- Name: replenishments replenishments_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replenishments
    ADD CONSTRAINT replenishments_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id);


--
-- Name: replenishments replenishments_catalog_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replenishments
    ADD CONSTRAINT replenishments_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id);


--
-- Name: replenishments replenishments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replenishments
    ADD CONSTRAINT replenishments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: replenishments replenishments_usage_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replenishments
    ADD CONSTRAINT replenishments_usage_event_id_fkey FOREIGN KEY (usage_event_id) REFERENCES public.usage_events(id);


--
-- Name: reservations reservations_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id);


--
-- Name: reservations reservations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: reservations reservations_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.locations(id);


--
-- Name: reservations reservations_owner_party_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_owner_party_id_fkey FOREIGN KEY (owner_party_id) REFERENCES public.parties(id);


--
-- Name: reservations reservations_requirement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_requirement_id_fkey FOREIGN KEY (requirement_id) REFERENCES public.case_requirements(id);


--
-- Name: reservations reservations_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES public.stock_items(id);


--
-- Name: reservations reservations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: sessions sessions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: shipment_lines shipment_lines_owner_party_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_lines
    ADD CONSTRAINT shipment_lines_owner_party_id_fkey FOREIGN KEY (owner_party_id) REFERENCES public.parties(id);


--
-- Name: shipment_lines shipment_lines_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_lines
    ADD CONSTRAINT shipment_lines_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: shipment_lines shipment_lines_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_lines
    ADD CONSTRAINT shipment_lines_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES public.shipments(id);


--
-- Name: shipment_lines shipment_lines_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_lines
    ADD CONSTRAINT shipment_lines_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES public.stock_items(id);


--
-- Name: shipment_lines shipment_lines_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_lines
    ADD CONSTRAINT shipment_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: shipments shipments_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id);


--
-- Name: shipments shipments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: shipments shipments_from_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_from_location_id_fkey FOREIGN KEY (from_location_id) REFERENCES public.locations(id);


--
-- Name: shipments shipments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: shipments shipments_to_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipments
    ADD CONSTRAINT shipments_to_location_id_fkey FOREIGN KEY (to_location_id) REFERENCES public.locations(id);


--
-- Name: stock_balances stock_balances_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_balances
    ADD CONSTRAINT stock_balances_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.locations(id);


--
-- Name: stock_balances stock_balances_owner_party_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_balances
    ADD CONSTRAINT stock_balances_owner_party_id_fkey FOREIGN KEY (owner_party_id) REFERENCES public.parties(id);


--
-- Name: stock_balances stock_balances_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_balances
    ADD CONSTRAINT stock_balances_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES public.stock_items(id);


--
-- Name: stock_balances stock_balances_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_balances
    ADD CONSTRAINT stock_balances_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: stock_items stock_items_catalog_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_items
    ADD CONSTRAINT stock_items_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id);


--
-- Name: stock_items stock_items_import_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_items
    ADD CONSTRAINT stock_items_import_batch_id_fkey FOREIGN KEY (import_batch_id) REFERENCES public.import_batches(id);


--
-- Name: stock_items stock_items_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_items
    ADD CONSTRAINT stock_items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: sync_differences sync_differences_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_differences
    ADD CONSTRAINT sync_differences_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.integration_feeds(id);


--
-- Name: sync_differences sync_differences_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_differences
    ADD CONSTRAINT sync_differences_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: territories territories_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.territories
    ADD CONSTRAINT territories_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: travel_estimates travel_estimates_from_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.travel_estimates
    ADD CONSTRAINT travel_estimates_from_location_id_fkey FOREIGN KEY (from_location_id) REFERENCES public.locations(id);


--
-- Name: travel_estimates travel_estimates_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.travel_estimates
    ADD CONSTRAINT travel_estimates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: travel_estimates travel_estimates_to_facility_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.travel_estimates
    ADD CONSTRAINT travel_estimates_to_facility_id_fkey FOREIGN KEY (to_facility_id) REFERENCES public.facilities(id);


--
-- Name: tray_instances tray_instances_manifest_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_instances
    ADD CONSTRAINT tray_instances_manifest_version_id_fkey FOREIGN KEY (manifest_version_id) REFERENCES public.tray_manifest_versions(id);


--
-- Name: tray_instances tray_instances_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_instances
    ADD CONSTRAINT tray_instances_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES public.stock_items(id);


--
-- Name: tray_instances tray_instances_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_instances
    ADD CONSTRAINT tray_instances_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: tray_manifest_lines tray_manifest_lines_catalog_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_manifest_lines
    ADD CONSTRAINT tray_manifest_lines_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id);


--
-- Name: tray_manifest_lines tray_manifest_lines_manifest_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_manifest_lines
    ADD CONSTRAINT tray_manifest_lines_manifest_version_id_fkey FOREIGN KEY (manifest_version_id) REFERENCES public.tray_manifest_versions(id);


--
-- Name: tray_manifest_lines tray_manifest_lines_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_manifest_lines
    ADD CONSTRAINT tray_manifest_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: tray_manifest_versions tray_manifest_versions_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_manifest_versions
    ADD CONSTRAINT tray_manifest_versions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: tray_manifest_versions tray_manifest_versions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_manifest_versions
    ADD CONSTRAINT tray_manifest_versions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: tray_manifest_versions tray_manifest_versions_tray_catalog_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_manifest_versions
    ADD CONSTRAINT tray_manifest_versions_tray_catalog_item_id_fkey FOREIGN KEY (tray_catalog_item_id) REFERENCES public.catalog_items(id);


--
-- Name: tray_verification_lines tray_verification_lines_catalog_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_verification_lines
    ADD CONSTRAINT tray_verification_lines_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id);


--
-- Name: tray_verification_lines tray_verification_lines_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_verification_lines
    ADD CONSTRAINT tray_verification_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: tray_verification_lines tray_verification_lines_verification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_verification_lines
    ADD CONSTRAINT tray_verification_lines_verification_id_fkey FOREIGN KEY (verification_id) REFERENCES public.tray_verifications(id);


--
-- Name: tray_verifications tray_verifications_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_verifications
    ADD CONSTRAINT tray_verifications_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id);


--
-- Name: tray_verifications tray_verifications_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_verifications
    ADD CONSTRAINT tray_verifications_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.locations(id);


--
-- Name: tray_verifications tray_verifications_manifest_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_verifications
    ADD CONSTRAINT tray_verifications_manifest_version_id_fkey FOREIGN KEY (manifest_version_id) REFERENCES public.tray_manifest_versions(id);


--
-- Name: tray_verifications tray_verifications_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_verifications
    ADD CONSTRAINT tray_verifications_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES public.shipments(id);


--
-- Name: tray_verifications tray_verifications_supersedes_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_verifications
    ADD CONSTRAINT tray_verifications_supersedes_id_fkey FOREIGN KEY (supersedes_id) REFERENCES public.tray_verifications(id);


--
-- Name: tray_verifications tray_verifications_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_verifications
    ADD CONSTRAINT tray_verifications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: tray_verifications tray_verifications_tray_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_verifications
    ADD CONSTRAINT tray_verifications_tray_stock_item_id_fkey FOREIGN KEY (tray_stock_item_id) REFERENCES public.stock_items(id);


--
-- Name: tray_verifications tray_verifications_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tray_verifications
    ADD CONSTRAINT tray_verifications_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id);


--
-- Name: usage_events usage_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_events
    ADD CONSTRAINT usage_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);


--
-- Name: usage_events usage_events_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_events
    ADD CONSTRAINT usage_events_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id);


--
-- Name: usage_events usage_events_catalog_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_events
    ADD CONSTRAINT usage_events_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id);


--
-- Name: usage_events usage_events_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_events
    ADD CONSTRAINT usage_events_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);


--
-- Name: usage_events usage_events_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_events
    ADD CONSTRAINT usage_events_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES public.stock_items(id);


--
-- Name: usage_events usage_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_events
    ADD CONSTRAINT usage_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: users users_facility_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_facility_id_fkey FOREIGN KEY (facility_id) REFERENCES public.facilities(id);


--
-- Name: users users_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: users users_territory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_territory_id_fkey FOREIGN KEY (territory_id) REFERENCES public.territories(id);


--
-- Name: audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_packets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_packets ENABLE ROW LEVEL SECURITY;

--
-- Name: case_requirements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.case_requirements ENABLE ROW LEVEL SECURITY;

--
-- Name: cases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cases ENABLE ROW LEVEL SECURITY;

--
-- Name: catalog_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.catalog_items ENABLE ROW LEVEL SECURITY;

--
-- Name: charges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.charges ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_prices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contract_prices ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contract_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contract_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: contracts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;

--
-- Name: count_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.count_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: count_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.count_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: credits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credits ENABLE ROW LEVEL SECURITY;

--
-- Name: custody_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.custody_events ENABLE ROW LEVEL SECURITY;

--
-- Name: discrepancies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.discrepancies ENABLE ROW LEVEL SECURITY;

--
-- Name: erp_acks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.erp_acks ENABLE ROW LEVEL SECURITY;

--
-- Name: exceptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.exceptions ENABLE ROW LEVEL SECURITY;

--
-- Name: facilities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.facilities ENABLE ROW LEVEL SECURITY;

--
-- Name: facility_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.facility_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: idempotency_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: import_batches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;

--
-- Name: import_row_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.import_row_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: import_rows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.import_rows ENABLE ROW LEVEL SECURITY;

--
-- Name: instrument_returns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.instrument_returns ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_feeds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_feeds ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;

--
-- Name: locations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: outbox; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.outbox ENABLE ROW LEVEL SECURITY;

--
-- Name: outbox_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.outbox_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: packages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.packages ENABLE ROW LEVEL SECURITY;

--
-- Name: parties; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.parties ENABLE ROW LEVEL SECURITY;

--
-- Name: preference_card_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.preference_card_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: preference_card_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.preference_card_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: preference_cards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.preference_cards ENABLE ROW LEVEL SECURITY;

--
-- Name: purchase_order_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.purchase_order_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: purchase_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: quality_holds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quality_holds ENABLE ROW LEVEL SECURITY;

--
-- Name: recall_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recall_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: recalls; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recalls ENABLE ROW LEVEL SECURITY;

--
-- Name: release_decisions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.release_decisions ENABLE ROW LEVEL SECURITY;

--
-- Name: replenishments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.replenishments ENABLE ROW LEVEL SECURITY;

--
-- Name: reservations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;

--
-- Name: shipment_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shipment_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: shipments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shipments ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_balances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_balances ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_items ENABLE ROW LEVEL SECURITY;

--
-- Name: sync_differences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sync_differences ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.audit_log USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: billing_packets tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.billing_packets USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: case_requirements tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.case_requirements USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: cases tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.cases USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: catalog_items tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.catalog_items USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: charges tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.charges USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: contract_prices tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.contract_prices USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: contract_rules tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.contract_rules USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: contract_versions tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.contract_versions USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: contracts tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.contracts USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: count_lines tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.count_lines USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: count_sessions tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.count_sessions USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: credits tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.credits USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: custody_events tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.custody_events USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: discrepancies tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.discrepancies USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: erp_acks tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.erp_acks USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: exceptions tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.exceptions USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: facilities tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.facilities USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: facility_policies tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.facility_policies USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: idempotency_keys tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.idempotency_keys USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: import_batches tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.import_batches USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: import_row_keys tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.import_row_keys USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: import_rows tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.import_rows USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: instrument_returns tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.instrument_returns USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: integration_feeds tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.integration_feeds USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: inventory_movements tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.inventory_movements USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: locations tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.locations USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: notifications tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.notifications USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: outbox tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.outbox USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: outbox_attempts tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.outbox_attempts USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: packages tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.packages USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: parties tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.parties USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: preference_card_lines tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.preference_card_lines USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: preference_card_versions tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.preference_card_versions USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: preference_cards tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.preference_cards USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: purchase_order_lines tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.purchase_order_lines USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: purchase_orders tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.purchase_orders USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: quality_holds tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.quality_holds USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: recall_tasks tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.recall_tasks USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: recalls tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.recalls USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: release_decisions tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.release_decisions USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: replenishments tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.replenishments USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: reservations tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.reservations USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: shipment_lines tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.shipment_lines USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: shipments tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.shipments USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: stock_balances tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.stock_balances USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: stock_items tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.stock_items USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: sync_differences tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.sync_differences USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: territories tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.territories USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: travel_estimates tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.travel_estimates USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: tray_instances tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.tray_instances USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: tray_manifest_lines tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.tray_manifest_lines USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: tray_manifest_versions tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.tray_manifest_versions USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: tray_verification_lines tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.tray_verification_lines USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: tray_verifications tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.tray_verifications USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: usage_events tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.usage_events USING ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid));


--
-- Name: territories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.territories ENABLE ROW LEVEL SECURITY;

--
-- Name: travel_estimates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.travel_estimates ENABLE ROW LEVEL SECURITY;

--
-- Name: tray_instances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tray_instances ENABLE ROW LEVEL SECURITY;

--
-- Name: tray_manifest_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tray_manifest_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: tray_manifest_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tray_manifest_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: tray_verification_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tray_verification_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: tray_verifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tray_verifications ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict PvG4mS8gICplQe7tNuJFnVbvDMeEK36YE40rX8vzv9dpb4mZzamxHWiAJZUJdnR

