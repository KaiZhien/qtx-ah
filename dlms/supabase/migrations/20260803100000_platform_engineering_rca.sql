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

-- ── root_cause_option vocabulary ───────────────────────────────────────────
-- Spec §6.3 asks for "vocabulary tables over enums wherever admins may extend",
-- and spec §8.5 asks the Maintenance dashboard for "repairs by root cause
-- (30/90 d)". That widget is UNBUILDABLE against free text: `repair` carries
-- only fault_description and diagnosis, both prose, and no root-cause column at
-- all. Rather than bolt one onto `repair`, the classification lives here —
-- failure_investigation already owns root-cause analysis AND already carries a
-- nullable repair FK, so the widget's join is simply
--     repair → failure_investigation.repair_id
--            → failure_investigation.root_cause_id
--            → root_cause_option.code
-- and `repair` gains nothing.
--
-- Shaped after modification_type (20260801000000_platform_modifications.sql),
-- NOT after status_option: nothing stores a root-cause code inline, so this gets
-- the house uuid PK, `code` is unique DATA, and the full audit + version shape.
--
-- NOTHING IN CODE BRANCHES ON THESE CODES. The lifecycle only asks "is a cause
-- classified at all" (root_cause_id IS NOT NULL) — see
-- modules/engineering/domain/failureStatus.ts. That matters: prod vocabulary has
-- drifted from seed on this project before (CLAUDE.md documents the trap), and
-- an admin adding "ESD damage" tomorrow must just work.
CREATE TABLE root_cause_option (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,   -- soft-disable, per spec §6.3 Vocabularies
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_user(id),  -- nullable for the same reason as
                                             -- modification_type.created_by: this migration's
                                             -- own seed below runs BEFORE platform_seed.sql
                                             -- bootstraps app_user on a from-scratch database
                                             -- (see __tests__/integration/setup.ts), so the
                                             -- attribution subselect returns NULL there. On the
                                             -- cloud target the Super Admin already exists.
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE root_cause_option IS
  'Extensible root-cause vocabulary (spec §6.3). A TABLE, not an enum: adding "ESD damage" is a row INSERT, never a migration, and no application code branches on a code. Retiring one is `active = false` — never a delete, because closed investigations still reference it. This is what makes spec §8.5''s "repairs by root cause" widget possible: group failure_investigation.root_cause_id, join here for the label. NO ADMIN SCREEN EXISTS YET — there is no /admin route over this table, so today an eleventh cause is added by SQL. The schema is what makes the console a later afternoon''s work rather than a migration; it is not evidence that the console is there.';
COMMENT ON COLUMN root_cause_option.active IS
  'Soft-disable. An inactive cause disappears from the picker but stays resolvable on records that already use it.';
COMMENT ON COLUMN root_cause_option.code IS
  'Stable machine key, unique. Business DATA, never a primary key (spec §6.4) — so renaming a code never orphans an investigation.';

CREATE INDEX root_cause_option_sort_idx ON root_cause_option(sort) WHERE deleted_at IS NULL;

-- Starter vocabulary, deliberately small and generic. The point of the table is
-- that this list is the Super Admin's to extend.
INSERT INTO root_cause_option (code, name, sort, created_by)
SELECT v.code, v.name, v.sort,
       (SELECT id FROM app_user WHERE email='reetmitra8@gmail.com')
FROM (VALUES
  ('component_failure', 'Component Failure',            1),
  ('workmanship',       'Workmanship / Assembly',       2),
  ('design',            'Design Deficiency',            3),
  ('firmware',          'Firmware / Software',          4),
  ('supplier',          'Supplier / Incoming Quality',  5),
  ('user_error',        'User Error / Misuse',          6),
  ('environmental',     'Environmental / External',     7),
  ('wear',              'Normal Wear',                  8),
  ('no_fault_found',    'No Fault Found',               9),
  ('other',             'Other',                       99)
) AS v(code, name, sort);

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

  -- THE classification (spec §8.5's dashboard axis). Nullable until the
  -- investigation actually identifies one; setting it is the precondition for
  -- reaching root_cause_identified.
  root_cause_id uuid REFERENCES root_cause_option(id),

  -- The 8D-compressed narrative. All bilingual free text, preserved verbatim.
  description text,                      -- what failed, and how it presented
  containment text,                      -- what stopped the bleeding meanwhile
  root_cause text,                       -- prose elaboration of root_cause_id, optional
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
  'Current state only. root_cause_identified requires root_cause_id to be SET, corrective_action requires a non-empty corrective_action, and closed re-checks BOTH (they stay editable while the investigation is live) — all enforced in failureStatus.ts, not here. Cancelling requires a note, which lands in failure_status_history.';
COMMENT ON COLUMN failure_investigation.root_cause_id IS
  'The STRUCTURED cause (root_cause_option), and the reason spec §8.5''s "repairs by root cause" widget is buildable: group on this, join through repair_id. Setting it is what the lifecycle checks — never the prose in root_cause — so the dashboard can never be defeated by someone typing a paragraph.';
COMMENT ON COLUMN failure_investigation.root_cause IS
  'Free-text elaboration of root_cause_id (evidence, the 5-whys chain). Optional and NOT a lifecycle precondition — the classification is.';
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
-- The §8.5 dashboard shape: group by cause over a rolling window.
CREATE INDEX fi_root_cause_idx ON failure_investigation(root_cause_id, opened_at DESC)
  WHERE deleted_at IS NULL AND root_cause_id IS NOT NULL;
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
  'FI status-change log, mirroring repair_status_history. Written in the SAME transaction as each status change (and as the row''s creation), so the timeline can never disagree with failure_investigation.status. APPEND-ONLY BY CONVENTION, NOT BY ENFORCEMENT: nothing in the service ever UPDATEs or DELETEs a row here, and fn_audit trails any write that did, but there is no refusing trigger of the fn_task_comment_guard / fn_component_installation_guard kind. Its two structural siblings repair_status_history and modification_status_history are in exactly the same position, so guarding this one alone would buy a third of the protection and a new inconsistency; the guard belongs to all three at once, in one migration. Do not read "append-only" here as a database guarantee — see the carried findings in docs/superpowers/PROGRESS.md.';
CREATE INDEX fsh_failure ON failure_status_history(failure_id, changed_at DESC);

-- Audit on both tables (history is append-only in practice — its INSERT is
-- exactly the event worth trailing). fn_audit is shape-agnostic.
SELECT fn_attach_audit(t) FROM unnest(ARRAY[
  'root_cause_option','failure_investigation','failure_status_history'
]) AS t;

-- RLS deny-via-REST (R1 pattern, per 20260720000000_platform_rls.sql): the app
-- reaches these only via the owner pool (withTransaction) / service_role, both
-- of which bypass RLS; enabling RLS with ZERO policies makes PostgREST deny
-- every anon/authenticated verb. NOT FORCE — FORCE would also gate the owner
-- connection and fn_audit's SECURITY DEFINER writes.
ALTER TABLE root_cause_option      ENABLE ROW LEVEL SECURITY;
ALTER TABLE failure_investigation  ENABLE ROW LEVEL SECURITY;
ALTER TABLE failure_status_history ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements follow, by design — see above.

REVOKE EXECUTE ON FUNCTION fn_fi_assign_no() FROM PUBLIC, anon, authenticated;
