-- ===========================================================================
-- Maintenance: modifications (spec §6.3). A modification is the SECOND thing
-- besides a repair that can change what a device is made of — a hardware
-- upgrade, an ECO retrofit, a field fix — and like a repair it can cause
-- component_installation rows (spec ERD: `modification ||--o{
-- component_installation : causes`). It walks
--   requested → approved → completed → closed
-- (+ cancelled from requested/approved), and closed is reachable ONLY via
-- sign-off. The transition GRAPH will live in a pure TS domain
-- (modules/maintenance/domain/modificationStatus.ts, fail-closed), exactly as
-- repair's does; the `status` column here only holds the current state and a
-- CHECK constraint fences that value to the known vocabulary.
--
-- WHY THOSE FIVE STATES AND NOT MORE. Spec §6.3 gives this record three actor
-- stamps — requested_by, approved_by, completed_by — plus a sign-off, and
-- that is precisely the lifecycle: somebody asks, somebody authorises, somebody
-- does the work, somebody with sign_off_repairs accepts it. One state per stamp
-- (`requested`/`approved`/`completed`), one terminal for the accepted result
-- (`closed`), one sink for everything that stops early (`cancelled`).
--   * `completed` is this table's `awaiting_sign_off`: the work is done and the
--     record is waiting to be accepted. Repair names that state for the wait;
--     here the spec names the column completed_on/completed_by, so the state
--     takes the spec's word. They are the same position in the graph.
--   * `closed` exists as a SEPARATE state, rather than letting sign-off merely
--     stamp signed_off_by/at on a `completed` row, for the reason repair
--     already established: sign-off is a transition, so "has this been
--     accepted?" is answerable from `status` alone and a signed-off record is
--     terminal rather than still editable.
--   * NO `rejected`. ecr/eco carry one because their draft→submitted step is a
--     document review with two symmetric outcomes. Here a request that is not
--     approved simply stops, and `cancelled` already means "stopped before
--     completion" — a second terminal differing only in wording would be a
--     state the graph has to route into and nobody can leave, for no gain.
--     The service requires a note on cancel (repair's convention), which is
--     where "why" is recorded.
--   * NO `in_progress`. Nothing in spec §6.3 distinguishes approved-but-not-
--     started from approved-and-underway — there is no started_on column to
--     stamp — so it would be a state with no fact behind it.
-- Task 2 builds the fail-closed graph over exactly this set. Adding a state
-- here without a transition there creates a state nobody can leave.
--
-- ONE DEVIATION FROM THE SPEC'S COLUMN NAME, forced by an earlier sibling.
-- Spec §6.3 models change management as a single `eng_change` row with a stage
-- (request→order) and gives modification an `eng_change` FK. That table does
-- not exist: 20260720100000_platform_engineering.sql deliberately landed the
-- two halves as SEPARATE tables (`ecr`, `eco`) — see its header. The retrofit-
-- spawning side of the ERD's `eng_change ||--o{ modification` is the ORDER (an
-- ECR is a request for a change, an ECO is the authorised change that gets
-- retrofitted into fielded devices), so the column below is `eco_id
-- REFERENCES eco(id)`. Naming it eng_change_id while it pointed at `eco` would
-- describe a table this schema does not have.
--
-- This migration also LANDS the deferred FK component_installation.modification_id
-- → modification(id) that 20260720000001_platform_components.sql declared as a
-- plain nullable uuid (see that column's comment), exactly as the sibling
-- 20260720110000_platform_maintenance.sql did for repair_id when `repair` landed.
--
-- Belongs to the `qtx-ops-platform` project (see the sibling
-- 20260718000000_platform_rbac.sql header for why this directory holds both the
-- new platform schema and the pre-existing DLMS migrations side by side).
-- Carries the platform_ token so __tests__/integration/setup.ts picks it up;
-- committing this file does nothing by itself until applied via the Supabase
-- MCP/CLI to the cloud project. app_user, device, component_installation, eco,
-- repair and fn_attach_audit all already exist as of the earlier platform_*
-- migrations.
-- ===========================================================================

-- ── modification_type vocabulary (spec §6.3: "vocabulary tables over enums
--    wherever admins may extend ... modification types") ─────────────────────
-- Shaped after component_type (20260720000001_platform_components.sql), NOT
-- after status_option: those two vocabularies differ on purpose. status_option
-- is code-PK because device.status stores the code INLINE and status_transition
-- is keyed on it, so the code has to be the join value. Nothing stores a
-- modification type inline — modification.modification_type_id is an ordinary
-- uuid FK like every other reference on that row — so this table gets the house
-- uuid PK, its `code` is unique DATA, and it carries the full audit-columns +
-- version shape every mutable platform table has.
CREATE TABLE modification_type (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,   -- soft-disable, per spec §6.3 Vocabularies
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_user(id),  -- nullable for the same reason as
                                             -- component_type.created_by: this migration's own
                                             -- seed below runs BEFORE platform_seed.sql bootstraps
                                             -- app_user (see __tests__/integration/setup.ts —
                                             -- migrations loop, THEN seed), so the attribution
                                             -- subselect returns NULL on a from-scratch database.
                                             -- On the cloud target the Super Admin already exists
                                             -- when this applies, so the seed attributes correctly
                                             -- there.
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE modification_type IS
  'Admin-extensible modification-type vocabulary (spec §6.3). A TABLE, not an enum: adding "Battery pack swap" is a row INSERT through the admin console, never a migration. Retiring one is `active = false` (soft-disable) — never a delete, because historical modification rows still reference it.';
COMMENT ON COLUMN modification_type.active IS
  'Soft-disable (spec §6.3 Vocabularies: "All admin-editable, soft-disable via active"). An inactive type disappears from the create form but stays resolvable on records that already use it.';
COMMENT ON COLUMN modification_type.code IS
  'Stable machine key, unique. Business DATA, never a primary key (spec §6.4) — the uuid id is identity, so renaming a code never orphans a modification row.';

-- The only query shape this vocabulary has: the create-form dropdown, in sort order.
CREATE INDEX modification_type_sort_idx ON modification_type(sort) WHERE deleted_at IS NULL;

-- ── modification_no human key (spec §6.4) ───────────────────────────────────
-- Mirrors repair_no exactly (20260720110000_platform_maintenance.sql): a
-- dedicated sequence supplies the numeric part and a BEFORE INSERT trigger
-- formats MOD-YYYY-NNNN. Globally monotonic, not reset each Jan 1 — the year in
-- the string is the readable prefix, the sequence guarantees uniqueness. A true
-- per-year reset is deferred (basic scope); the UNIQUE column below is the
-- invariant that matters.
CREATE SEQUENCE modification_no_seq;

CREATE TABLE modification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  modification_no text NOT NULL UNIQUE,  -- MOD-YYYY-NNNN, trigger-assigned (see below)
  device_id uuid NOT NULL REFERENCES device(id),
  modification_type_id uuid NOT NULL REFERENCES modification_type(id),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','approved','completed','closed','cancelled')),
  requested_on date,                     -- when it was asked for; nullable (backfilled records)
  completed_on date,                     -- when the work was finished
  requested_by uuid REFERENCES app_user(id),
  approved_by uuid REFERENCES app_user(id),
  completed_by uuid REFERENCES app_user(id),
  reason text,                           -- why the change is wanted; bilingual, verbatim
  description text,                      -- what is being done; bilingual, verbatim
  previous_configuration text,           -- free text, NOT a component reference — see comment below
  new_configuration text,
  eco_id uuid REFERENCES eco(id),        -- optional: the ECO this retrofit realises (see header)
  repair_id uuid REFERENCES repair(id),  -- optional: the repair this modification arose from
  cost_sgd numeric(12,2),                -- nullable: unknown / not costed
  signed_off_by uuid REFERENCES app_user(id),
  signed_off_at timestamptz,
  closed_at timestamptz,                 -- set when status becomes closed/cancelled
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  -- sign-off is atomic: either both the actor and the timestamp are stamped, or
  -- neither is. Mirrors repair_signoff_complete / component_installation's
  -- removal_complete.
  CONSTRAINT modification_signoff_complete
    CHECK ((signed_off_by IS NULL) = (signed_off_at IS NULL))
);
COMMENT ON TABLE modification IS
  'Device modification record (spec §6.3): the second thing besides a repair that can cause a component change. Lifecycle requested → approved → completed → closed (+ cancelled), with sign-off (permission sign_off_repairs) the only route to closed. Never hard-deleted (use deleted_at).';
COMMENT ON COLUMN modification.status IS
  'Current workflow state only. Legal moves live in the pure TS domain (modules/maintenance/domain/modificationStatus.ts, fail-closed); the CHECK here just fences the value to the known vocabulary. completed → closed is reachable ONLY via sign-off, never the ordinary status-change path — the same rule repair.status states for awaiting_sign_off → closed. See this migration''s header for why the set is exactly these five.';
COMMENT ON COLUMN modification.modification_type_id IS
  'FK to the admin-extensible modification_type vocabulary — deliberately not an enum, so a Super Admin adding a type never needs a migration (spec §6.3).';
COMMENT ON COLUMN modification.previous_configuration IS
  'Free-text snapshot of what the device was before the change (spec §6.3 "prev/new configuration text"). Deliberately narrative and NOT a component reference: component_installation is the structured record of what actually moved, and this column is the engineer''s description of the change — including for modifications that swap no parts at all (a firmware or setting change). The two are complementary; this one is never parsed.';
COMMENT ON COLUMN modification.new_configuration IS
  'Free-text snapshot of the resulting configuration. See previous_configuration — narrative, never parsed, never a substitute for the component_installation rows a physical swap writes.';
COMMENT ON COLUMN modification.eco_id IS
  'Optional link to the Engineering Change Order this modification retrofits into a fielded device (spec ERD: eng_change ||--o{ modification "spawns retrofit"). Points at `eco`, not a spec-§6.3 `eng_change` table, because 20260720100000_platform_engineering.sql split that entity into ecr/eco — see this migration''s header. AUTOMATIC spawning of retrofit modifications from an approved ECO waits on the approvals engine; this FK only records the link.';
COMMENT ON COLUMN modification.repair_id IS
  'Optional link to the repair that occasioned this modification (e.g. a fault whose fix was an upgrade rather than a like-for-like swap). Independent of component_installation.repair_id / .modification_id, which attribute individual component swaps.';
COMMENT ON COLUMN modification.cost_sgd IS
  'Modification cost in SGD; nullable when unknown or not costed (mirrors repair.cost_sgd).';
COMMENT ON COLUMN modification.closed_at IS
  'Event stamp for reaching a terminal state (closed via sign-off, or cancelled). Distinct from completed_on, which is a user-supplied DATE describing when the work was done and may precede the record being accepted. Mirrors repair.closed_at.';
COMMENT ON COLUMN modification.version IS
  'Optimistic-lock counter (spec §6.4). Not incremented by any trigger — the service layer sets version = version + 1 explicitly on UPDATE, matching this platform''s convention (see modules/maintenance/services/repairService.ts).';
COMMENT ON COLUMN modification.modification_no IS
  'Human-facing reference MOD-YYYY-NNNN, assigned by trg_modification_assign_no. UNIQUE; never a PK (the uuid id is identity). See spec §6.4.';

CREATE INDEX modification_device_idx ON modification(device_id) WHERE deleted_at IS NULL;
CREATE INDEX modification_status_idx ON modification(status) WHERE deleted_at IS NULL;
CREATE INDEX modification_keyset_idx ON modification(created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX modification_type_fk_idx ON modification(modification_type_id) WHERE deleted_at IS NULL;
CREATE INDEX modification_eco_idx ON modification(eco_id) WHERE eco_id IS NOT NULL;
CREATE INDEX modification_repair_idx ON modification(repair_id) WHERE repair_id IS NOT NULL;

-- Assigns modification_no on insert when the caller didn't supply one (the
-- service never does). Runs BEFORE INSERT so the NOT NULL column is populated in
-- time. Byte-for-byte the shape of fn_repair_assign_no().
CREATE OR REPLACE FUNCTION fn_modification_assign_no()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.modification_no IS NULL THEN
    NEW.modification_no := 'MOD-' || to_char(now(), 'YYYY') || '-'
                           || lpad(nextval('modification_no_seq')::text, 4, '0');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_modification_assign_no BEFORE INSERT ON modification
  FOR EACH ROW EXECUTE FUNCTION fn_modification_assign_no();

-- ── repair.parts_replaced ───────────────────────────────────────────────────
-- A CLAIM, not a fact. Nothing in this migration verifies it; the verification
-- is a sign-off precondition landing with the §14 replacement wiring.
ALTER TABLE repair ADD COLUMN parts_replaced boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN repair.parts_replaced IS
  'The technician''s ASSERTION that this repair involved a component change. It is a claim about the world, not a derived fact — the schema does not and cannot check it here. A sign-off precondition (spec §5.4) requires the claim be BACKED: when parts_replaced is true, at least one component_installation must reference this repair before it can be signed off. That closes the failure mode that matters in a device registry — a technician says a board was swapped, signs off, and the component record never changed. Defaults false so every repair opened before the flag existed reads as "no claim made", which the precondition treats as nothing to verify.';

-- ── Land the deferred FK from the components migration ──────────────────────
-- 20260720000001_platform_components.sql declared component_installation.
-- modification_id as a plain nullable uuid because modification didn't exist yet
-- (see that column's COMMENT). Now it does — attach the real constraint, exactly
-- as 20260720110000_platform_maintenance.sql did for repair_id.
ALTER TABLE component_installation
  ADD CONSTRAINT component_installation_modification_fk
  FOREIGN KEY (modification_id) REFERENCES modification(id);

-- Audit on both new tables (spec §6). The vocabulary is audited as well as the
-- record: a modification type going inactive, or being renamed, changes how every
-- record that references it reads, and that is worth a trail.
SELECT fn_attach_audit(t) FROM unnest(ARRAY['modification','modification_type']) AS t;

-- RLS deny-via-REST (R1 pattern, per 20260720000000_platform_rls.sql): the app
-- reaches these only via the owner pool (withTransaction) / service_role, both of
-- which bypass RLS; no anon/authenticated policy = PostgREST denies all. NOT FORCE
-- (FORCE would also gate the owner connection and fn_audit's SECURITY DEFINER
-- writes — the one path this must leave alone).
ALTER TABLE modification      ENABLE ROW LEVEL SECURITY;
ALTER TABLE modification_type ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements follow, by design — see above.

REVOKE EXECUTE ON FUNCTION fn_modification_assign_no() FROM PUBLIC, anon, authenticated;

-- Starter vocabulary. Deliberately small and generic: these are the kinds of
-- change the fielded fleet actually sees, and the point of the table is that the
-- list is the Super Admin's to extend — adding a type is a row INSERT through the
-- admin console, never a migration. Nothing in code branches on these codes.
INSERT INTO modification_type (code, name, sort, created_by)
SELECT v.code, v.name, v.sort,
       (SELECT id FROM app_user WHERE email='reetmitra8@gmail.com')
FROM (VALUES
  ('hardware_upgrade', 'Hardware Upgrade',            1),
  ('firmware_update',  'Firmware Update',             2),
  ('eco_retrofit',     'ECO Retrofit',                3),
  ('field_fix',        'Field Fix / Workaround',      4),
  ('cosmetic',         'Cosmetic / Labelling Change', 5)
) AS v(code, name, sort);
