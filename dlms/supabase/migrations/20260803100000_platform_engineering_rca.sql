-- ===========================================================================
-- Engineering deepening (1/2): failure investigations / RCA records.
--
-- Spec §6.3 entity inventory:
--   failure_investigation (ref `FI-`, device/repair FKs nullable, description,
--   containment, root_cause, corrective_action, status, eng_change FK when
--   escalated)
--
-- ── Naming: `eng_change` landed as `eco` ───────────────────────────────────
-- The spec models change management as ONE `eng_change` row with a stage
-- (request → order). 20260720100000_platform_engineering.sql deliberately split
-- that into two tables, `ecr` and `eco` (see that migration's header). So the
-- spec's "eng_change FK when escalated" is `eco_id` here, and it points at the
-- ORDER, not the request: escalation is the moment an investigation concludes
-- the design itself must change, which is exactly what an ECO is. An FI that
-- only wants to *propose* a change links nothing — someone raises an ECR.
--
-- ── FK availability ────────────────────────────────────────────────────────
-- Every FK target is already live at this timestamp: device (20260719000001),
-- repair (20260720110000), eco (20260720100000), app_user (20260718000000). No
-- deferred plain-uuid columns are needed here.
--
-- House conventions (spec §6): uuid PK; the human ref is unique DATA, never a
-- PK; created_at/created_by/updated_at/updated_by; soft delete via deleted_at;
-- `version` integer optimistic-lock counter bumped by the write path, not a
-- trigger; fn_attach_audit on every mutable table; RLS deny-via-REST with NO
-- policies and NOT FORCE (owner pool + service_role are the only writers and
-- both bypass RLS — see 20260720000000_platform_rls.sql).
-- ===========================================================================

-- ── fi_no human key (spec §6.4) ────────────────────────────────────────────
-- Copies the REP- pattern from 20260720110000_platform_maintenance.sql verbatim:
-- a dedicated sequence supplies the numeric part and a BEFORE INSERT trigger
-- formats FI-YYYY-NNNN. The sequence is globally monotonic — NOT reset each
-- Jan 1 — so the year in the string is a readable prefix and the sequence alone
-- guarantees uniqueness. A true per-year reset would mean either DDL
-- (ALTER SEQUENCE RESTART) inside a trigger, which is non-transactional and
-- races two inserts across midnight on Dec 31, or a counter table with its own
-- lock contention; `repair` made the same trade and the UNIQUE column below is
-- the invariant that actually matters. Gaps from rolled-back INSERTs are
-- expected and fine (sequences do not roll back).
CREATE SEQUENCE fi_no_seq;

CREATE TABLE failure_investigation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fi_no text NOT NULL UNIQUE,            -- FI-YYYY-NNNN, trigger-assigned (below)
  title text NOT NULL,
  severity text NOT NULL DEFAULT 'normal'
    CHECK (severity IN ('low','normal','high','critical')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','investigating','root_cause_identified',
                      'corrective_action','closed','cancelled')),

  -- The 8D-compressed narrative. All bilingual free text, preserved verbatim.
  description text,                      -- what failed, and how it presented
  containment text,                      -- what stopped the bleeding meanwhile
  root_cause text,                       -- precondition for root_cause_identified
  corrective_action text,                -- precondition for corrective_action

  -- All three subject links are NULLABLE and independent: a failure may be
  -- reported against a device, against a repair that uncovered it, or stand
  -- alone (a batch/process failure with no single device yet).
  device_id uuid REFERENCES device(id),
  repair_id uuid REFERENCES repair(id),
  -- Escalation target. Set when the investigation concludes a design change is
  -- required; see the header for why this is the ECO and not the ECR.
  eco_id uuid REFERENCES eco(id),

  reported_by uuid REFERENCES app_user(id),
  assigned_to uuid REFERENCES app_user(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,                 -- stamped when status becomes closed/cancelled

  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);

COMMENT ON TABLE failure_investigation IS
  'Failure investigation / RCA record (spec §6.3). Six-state lifecycle open → investigating → root_cause_identified → corrective_action → closed (+ cancelled from open/investigating only). The transition GRAPH and its preconditions live in the pure TS domain modules/engineering/domain/failureStatus.ts (fail-closed); the CHECK here only fences the column to the known vocabulary. Never hard-deleted (use deleted_at).';
COMMENT ON COLUMN failure_investigation.fi_no IS
  'Human reference FI-YYYY-NNNN, assigned by trg_fi_assign_no from fi_no_seq. UNIQUE; never a PK (the uuid id is identity). See spec §6.4.';
COMMENT ON COLUMN failure_investigation.status IS
  'Current state only. root_cause_identified requires a non-empty root_cause, corrective_action requires a non-empty corrective_action, and closed re-checks BOTH (they stay editable while the investigation is live) — all enforced in failureStatus.ts, not here. Cancelling requires a note, which lands in failure_status_history.';
COMMENT ON COLUMN failure_investigation.eco_id IS
  'Spec §6.3''s "eng_change FK when escalated". Points at the change ORDER (eco), because this codebase split eng_change into ecr + eco (see 20260720100000_platform_engineering.sql). NULL until the investigation escalates.';
COMMENT ON COLUMN failure_investigation.repair_id IS
  'Optional: the repair that surfaced this failure. Independent of device_id — a repair-linked FI usually also names the device, but neither implies the other.';
COMMENT ON COLUMN failure_investigation.version IS
  'Optimistic-lock counter (spec §6.4). Set explicitly by the write path (version = version + 1), never by a trigger — matching device.version and repair.version.';

CREATE INDEX fi_status_idx ON failure_investigation(status) WHERE deleted_at IS NULL;
CREATE INDEX fi_severity_idx ON failure_investigation(severity) WHERE deleted_at IS NULL;
CREATE INDEX fi_device_idx ON failure_investigation(device_id) WHERE device_id IS NOT NULL;
CREATE INDEX fi_repair_idx ON failure_investigation(repair_id) WHERE repair_id IS NOT NULL;
CREATE INDEX fi_eco_idx ON failure_investigation(eco_id) WHERE eco_id IS NOT NULL;
CREATE INDEX fi_keyset_idx ON failure_investigation(created_at DESC, id DESC) WHERE deleted_at IS NULL;
-- Ref lookup for the list search and (later) global search: the read service
-- matches on lower(fi_no), so index the same expression.
CREATE INDEX fi_no_lower_idx ON failure_investigation(lower(fi_no)) WHERE deleted_at IS NULL;

-- Assigns fi_no on insert when the caller didn't supply one (the service never
-- does). BEFORE INSERT so the NOT NULL column is populated in time.
CREATE OR REPLACE FUNCTION fn_fi_assign_no()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.fi_no IS NULL THEN
    NEW.fi_no := 'FI-' || to_char(now(), 'YYYY') || '-'
                 || lpad(nextval('fi_no_seq')::text, 4, '0');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_fi_assign_no BEFORE INSERT ON failure_investigation
  FOR EACH ROW EXECUTE FUNCTION fn_fi_assign_no();

-- Append-only status log, mirroring repair_status_history / device_status_history
-- (spec §6.2). The FI row carries only the current status for querying; this is
-- the audit-grade timeline the detail page renders, and it is also the ONLY
-- place a cancellation reason can live (the FI row has no note column, by
-- design — a note belongs to the transition, not to the record).
CREATE TABLE failure_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  failure_id uuid NOT NULL REFERENCES failure_investigation(id),
  from_status text, to_status text NOT NULL,
  note text,                             -- required for cancelled (service-enforced)
  changed_by uuid NOT NULL REFERENCES app_user(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE failure_status_history IS
  'Append-only FI status-change log, mirroring repair_status_history. Written in the SAME transaction as each status change (and as the row''s creation), so the timeline can never disagree with failure_investigation.status.';
CREATE INDEX fsh_failure ON failure_status_history(failure_id, changed_at DESC);

-- Audit on both tables (history is append-only in practice — its INSERT is
-- exactly the event worth trailing). fn_audit is shape-agnostic.
SELECT fn_attach_audit(t) FROM unnest(ARRAY[
  'failure_investigation','failure_status_history'
]) AS t;

-- RLS deny-via-REST (R1 pattern, per 20260720000000_platform_rls.sql): the app
-- reaches these only via the owner pool (withTransaction) / service_role, both
-- of which bypass RLS; enabling RLS with ZERO policies makes PostgREST deny
-- every anon/authenticated verb. NOT FORCE — FORCE would also gate the owner
-- connection and fn_audit's SECURITY DEFINER writes.
ALTER TABLE failure_investigation  ENABLE ROW LEVEL SECURITY;
ALTER TABLE failure_status_history ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements follow, by design — see above.

REVOKE EXECUTE ON FUNCTION fn_fi_assign_no() FROM PUBLIC, anon, authenticated;
