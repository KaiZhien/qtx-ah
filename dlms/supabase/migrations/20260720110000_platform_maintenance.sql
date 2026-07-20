-- ===========================================================================
-- Maintenance: repairs (spec §5.3 — the six-state repair workflow). A repair is
-- opened against a device, walks the lifecycle
--   reported → in_diagnosis → in_repair → testing → awaiting_sign_off → closed
-- (+ cancelled from reported/in_diagnosis; testing → in_repair on a failed test;
-- in_diagnosis → closed "no fault found"), and on sign-off returns the device to
-- service. The transition GRAPH is encoded in a pure TS domain
-- (modules/maintenance/domain/repairStatus.ts, fail-closed); the `status` column
-- here only holds the current state, and a CHECK constraint keeps that value
-- inside the known vocabulary.
--
-- This migration also LANDS the deferred FK component_installation.repair_id →
-- repair(id) that 20260720000001_platform_components.sql declared as a plain
-- nullable uuid (see that column's comment): the §14 component-replacement
-- primitive already accepts a repairId; now it references a real table.
--
-- Belongs to the new `qtx-ops-platform` project (see the sibling
-- 20260718000000_platform_rbac.sql header for why this directory holds both the
-- new platform schema and the pre-existing DLMS migrations side by side).
-- Carries the platform_ token so __tests__/integration/setup.ts picks it up;
-- committing this file does nothing by itself until applied via the Supabase
-- MCP/CLI to the cloud project. app_user, device, component_installation,
-- fn_attach_audit all already exist as of the earlier platform_* migrations.
-- ===========================================================================

-- ── repair_no human key (spec §6.4: per-year sequence, formatted in a trigger) ─
-- A dedicated sequence supplies the numeric part; a BEFORE INSERT trigger formats
-- REP-YYYY-NNNN. The sequence is globally monotonic (not reset each Jan 1) — the
-- year in the string is the readable prefix, the sequence guarantees uniqueness.
-- A true per-year reset is deferred (basic scope); the UNIQUE column below is the
-- invariant that matters.
CREATE SEQUENCE repair_no_seq;

CREATE TABLE repair (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_no text NOT NULL UNIQUE,        -- REP-YYYY-NNNN, trigger-assigned (see below)
  device_id uuid NOT NULL REFERENCES device(id),
  status text NOT NULL DEFAULT 'reported'
    CHECK (status IN ('reported','in_diagnosis','in_repair','testing',
                      'awaiting_sign_off','closed','cancelled')),
  fault_description text,                -- bilingual free text, preserved verbatim
  diagnosis text,
  corrective_action text,
  testing_notes text,                    -- sign-off precondition: must be present to close
  warranty_flag boolean NOT NULL DEFAULT false,
  warranty_justification text,
  cost_sgd numeric(12,2),                -- nullable: unknown / not costed
  reported_by uuid REFERENCES app_user(id),
  assigned_to uuid REFERENCES app_user(id),
  signed_off_by uuid REFERENCES app_user(id),
  signed_off_at timestamptz,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,                 -- set when status becomes closed/cancelled
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  -- sign-off is atomic: either both the actor and the timestamp are stamped, or
  -- neither is. Mirrors component_installation's removal_complete guard.
  CONSTRAINT repair_signoff_complete CHECK ((signed_off_by IS NULL) = (signed_off_at IS NULL))
);
COMMENT ON TABLE repair IS
  'Six-state repair workflow (spec §5.3). Opened against a device; sign-off (permission sign_off_repairs) closes it and returns the device Under Repair → Active. Never hard-deleted (use deleted_at).';
COMMENT ON COLUMN repair.status IS
  'Current workflow state only. Legal moves live in the pure TS domain (modules/maintenance/domain/repairStatus.ts, fail-closed); the CHECK here just fences the value to the known vocabulary. awaiting_sign_off → closed is reachable ONLY via sign-off, never the ordinary status-change path.';
COMMENT ON COLUMN repair.testing_notes IS
  'Free-text test results. Non-empty testing_notes is a hard precondition for sign-off (spec §5.3): a repair cannot be signed off until testing is recorded.';
COMMENT ON COLUMN repair.cost_sgd IS
  'Repair cost in SGD; nullable when unknown or not costed (spec §5.3).';
COMMENT ON COLUMN repair.version IS
  'Optimistic-lock counter (spec §6.4). Not incremented by any trigger — the service layer sets version = version + 1 explicitly on UPDATE, matching this platform''s convention (see modules/manufacturing/services/deviceWriteService.ts).';
COMMENT ON COLUMN repair.repair_no IS
  'Human-facing reference REP-YYYY-NNNN, assigned by trg_repair_assign_no. UNIQUE; never a PK (the uuid id is identity). See spec §6.4.';

CREATE INDEX repair_device_idx ON repair(device_id) WHERE deleted_at IS NULL;
CREATE INDEX repair_status_idx ON repair(status) WHERE deleted_at IS NULL;
CREATE INDEX repair_keyset_idx ON repair(created_at DESC, id DESC) WHERE deleted_at IS NULL;

-- Assigns repair_no on insert when the caller didn't supply one (the service
-- never does). Runs BEFORE INSERT so the NOT NULL column is populated in time.
CREATE OR REPLACE FUNCTION fn_repair_assign_no()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.repair_no IS NULL THEN
    NEW.repair_no := 'REP-' || to_char(now(), 'YYYY') || '-'
                     || lpad(nextval('repair_no_seq')::text, 4, '0');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_repair_assign_no BEFORE INSERT ON repair
  FOR EACH ROW EXECUTE FUNCTION fn_repair_assign_no();

-- Append-only status log — mirrors device_status_history (spec §6.2). The repair
-- row carries only the current status for querying; this is the audit-grade
-- timeline the repair detail page renders. Each row also timestamps a state
-- change, the raw material for future downtime reporting (out of basic scope).
CREATE TABLE repair_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_id uuid NOT NULL REFERENCES repair(id),
  from_status text, to_status text NOT NULL,
  note text,                             -- required for cancelled (service-enforced); free text otherwise
  changed_by uuid NOT NULL REFERENCES app_user(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE repair_status_history IS
  'Append-only repair status-change log (spec §5.3/§6.2), mirroring device_status_history. Written in the same transaction as each repair status change / sign-off / creation.';
CREATE INDEX rsh_repair ON repair_status_history(repair_id, changed_at DESC);

-- ── Land the deferred FK from the components migration ──────────────────────
-- 20260720000001_platform_components.sql declared component_installation.repair_id
-- as a plain nullable uuid because repair didn't exist yet (see that column's
-- COMMENT). Now it does — attach the real constraint.
ALTER TABLE component_installation
  ADD CONSTRAINT component_installation_repair_fk
  FOREIGN KEY (repair_id) REFERENCES repair(id);

-- Audit on both mutable tables (history is append-only in practice — its INSERT
-- is exactly the event worth trailing).
SELECT fn_attach_audit(t) FROM unnest(ARRAY['repair','repair_status_history']) AS t;

-- RLS deny-via-REST (R1 pattern, per 20260720000000_platform_rls.sql): the app
-- reaches these only via the owner pool (withTransaction) / service_role, both of
-- which bypass RLS; no anon/authenticated policy = PostgREST denies all. NOT FORCE
-- (FORCE would also gate the owner connection and fn_audit's SECURITY DEFINER
-- writes — the one path this must leave alone).
ALTER TABLE repair                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_status_history  ENABLE ROW LEVEL SECURITY;

REVOKE EXECUTE ON FUNCTION fn_repair_assign_no() FROM PUBLIC, anon, authenticated;
