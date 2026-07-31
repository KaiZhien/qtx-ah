-- ===========================================================================
-- Approvals engine, schema half (spec §6.3, BR-4). Two tables:
--
--   `approval`    — one row per request for a second pair of eyes, attaching to
--                   ANY module's record by entity_type + entity_id, carrying an
--                   immutable `snapshot` of exactly what was approved.
--   `app_setting` — the runtime-knob store (spec §3.1 "system settings"), whose
--                   first tenant is the Finance approval threshold. It does not
--                   exist yet: no table, no seed, no reader.
--
-- WHY THE SNAPSHOT IS THE WHOLE POINT. An approval authorises a specific STATE,
-- not an entity id. Without a snapshot, "invoice X is approved" survives someone
-- editing invoice X's total afterwards, and the engine becomes theatre: the
-- second pair of eyes agreed to numbers that are no longer the numbers being
-- acted on. So `snapshot jsonb NOT NULL` records what the approver saw, it is
-- immutable (trg_approval_guard below), and every consumer re-checks it against
-- current state at the moment it acts. The CHECK fences it to a NON-EMPTY OBJECT
-- for the same reason: `{}` and `null` compare equal to everything, so a
-- degenerate snapshot would make the re-check pass vacuously — the exact failure
-- the column exists to prevent, wearing the column's own name.
--
-- WHY entity_type + entity_id CARRY NO FOREIGN KEY. Same reason task_link's pair
-- does not (20260719000000_platform_tasks.sql): the point of one approvals engine
-- is that it attaches to any module's record — sales_invoice today, eco and repair
-- next, whatever week 8 adds after — and a FK can only point at one table. Spec
-- §6.1/§6.3 names this the shared mechanism for task_link, approval, file,
-- notification and audit_log alike. The cost is real and accepted: nothing at the
-- database level stops an approval naming a row that does not exist, so the
-- service is what validates the target on the way in.
--
-- WHY `module` IS STORED EVEN THOUGH IT IS DERIVABLE FROM `kind` TODAY. With three
-- kinds it is a pure function (eco→engineering, invoice→finance,
-- repair_signoff→maintenance), and a denormalised column that can drift usually
-- earns its keep only by saving a join. This one is not about a join — it is about
-- the QUEUE. The approvals queue is scoped by the actor's module access as well as
-- by `approve_requests` (a manager who can enter Finance but not Engineering must
-- not see ECO requests), so module is a WHERE clause on THIS table, and the
-- alternative is a CASE over `kind` restated in every query that reads the queue.
-- More decisively: the module is a property of the ENTITY, not of the kind. The day
-- an invoice-shaped approval hangs off a Logistics record — or any kind spans two
-- modules — a kind→module mapping in code becomes a lie while a stored column stays
-- true. task_link stored its module for exactly this shape of reason; this follows
-- it. There is deliberately NO CHECK tying kind to module: that would make every
-- new kind a schema migration, which is the same trap outbox.aggregate_type's
-- comment refuses. The service derives and validates the pair.
--
-- WHY A REJECTED REQUEST IS RE-REQUESTED, NEVER REOPENED. `approved` and `rejected`
-- are terminal (spec §6.4 lists `approval` post-decision among the immutable history
-- tables). The decision trail has to stay readable: "this was rejected on the 3rd for
-- these numbers, re-requested on the 5th with those" is evidence; a single row that
-- flipped state twice is not. That is why the one-pending index below is PARTIAL —
-- a total unique constraint on (entity_type, entity_id, kind) would make a rejected
-- request un-re-requestable forever — and why trg_approval_guard refuses a second
-- decision rather than trusting every call site to remember.
--
-- SEEDING ORDER, the hazard that has bitten this directory before. Migrations are
-- applied BEFORE supabase/seed/platform_seed.sql (see __tests__/integration/setup.ts:
-- the migration loop, THEN the seed), and that seed is what populates `role` and the
-- bootstrap app_user. A migration-embedded seed that JOINS either one inserts ZERO
-- ROWS, silently, on any database built from scratch. This migration takes the
-- CHEAPER of the two escapes already in the directory: app_setting.created_by is
-- nullable (component_type.created_by's precedent, 20260720000001_platform_components.sql)
-- and the attribution is a SCALAR SUBSELECT inside VALUES rather than a join, so the
-- row lands either way — attributed on the cloud project, where the Super Admin has
-- long existed, and unattributed on a from-scratch database. The heavier escape —
-- an idempotent function called from both the migration and the seed
-- (fn_seed_system_actor, 20260731000000_platform_outbox.sql) — is not needed here
-- because nothing about this row is NOT NULL against a seeded table.
--
-- ONE CONSEQUENCE WORTH STATING: app_setting is the first AUDITED text-keyed table
-- in this schema. fn_audit reads (new_values->>'id')::uuid for audit_log.row_id, so
-- every app_setting trail row carries row_id NULL and is found by table_name plus
-- new_values->>'key' instead. That is a supported outcome — row_id is nullable and
-- fn_audit is shape-agnostic (20260718000001_platform_audit.sql) — but that column's
-- COMMENT claimed no text-keyed table existed, so this migration corrects it below.
-- The trail stays cheap to query without audit_log_row_idx: there are a handful of
-- settings rows, not a table's worth.
--
-- Belongs to the `qtx-ops-platform` project (see the sibling
-- 20260718000000_platform_rbac.sql header for why this directory holds both the new
-- platform schema and the pre-existing DLMS migrations side by side). Carries the
-- platform_ token so __tests__/integration/setup.ts picks it up; committing this file
-- does nothing by itself until applied via the Supabase MCP/CLI to the cloud project.
-- app_user and fn_attach_audit already exist as of the earlier platform_* migrations.
-- ===========================================================================

-- ── app_setting (spec §6.3 Platform: "key PK, value jsonb") ─────────────────
CREATE TABLE app_setting (
  key   text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_user(id),  -- nullable for the same reason as
                                            -- component_type.created_by: this migration's own
                                            -- seed below runs BEFORE platform_seed.sql bootstraps
                                            -- app_user, so the attribution subselect resolves to
                                            -- NULL on a from-scratch database. On the cloud target
                                            -- the Super Admin already exists when this applies.
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  version    integer NOT NULL DEFAULT 1,
  -- 'null'::jsonb passes NOT NULL. A knob whose value is JSON null is a knob that is
  -- not set, which is indistinguishable at the reader from a bug — and readers must
  -- already handle an ABSENT key, so there is exactly one way to say "unset".
  CONSTRAINT app_setting_value_not_json_null CHECK (jsonb_typeof(value) <> 'null')
);
COMMENT ON TABLE app_setting IS
  'Runtime knobs, keyed by name (spec §6.3): finance_approval_threshold_sgd, export_retention_days, and whatever later needs a value an admin can change WITHOUT a deploy. Audited on purpose — "who raised the approval threshold, and when?" is exactly the question an auditor asks, and the answer has to be in audit_log rather than in someone''s memory. Deliberately exempt from the deleted_at half of the table convention: a setting is a key→value knob, not a record with a lifecycle. Retiring one means the code that reads it is gone, which is a migration; a nullable deleted_at on a table whose only read is `WHERE key = $1` is an invitation to a reader that forgets the filter and silently honours a retired knob.';
COMMENT ON COLUMN app_setting.key IS
  'Stable snake_case identifier, referenced by name from the code that reads the knob. CHECKed to that shape so a console typo ("Finance Threshold") can never become a key nothing will ever look up.';
COMMENT ON COLUMN app_setting.value IS
  'jsonb so a knob can be a number, a string, a flag or a small object without a schema change (spec §14 also earmarks this table for feature flags — "simple app_setting-backed flags ... kill switch without deploy"). Scalar knobs are stored as bare JSON scalars: the finance threshold is the number 5000, not {"amount": 5000}, because the key already says _sgd.';
COMMENT ON COLUMN app_setting.version IS
  'Optimistic-lock counter (spec §6.4). Not incremented by any trigger — the service layer sets version = version + 1 explicitly on UPDATE, matching this platform''s convention. It matters here despite the tiny row count: two admins editing the threshold from the settings console at once is precisely the collision it arbitrates.';

-- ── approval (spec §6.3 Platform) ───────────────────────────────────────────
CREATE TABLE approval (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,   -- 'sales_invoice' | 'eco' | 'repair' | ... (no FK — see header)
  entity_id   uuid NOT NULL,
  module      text NOT NULL CHECK (module IN
              ('engineering','finance','logistics','manufacturing','maintenance','tasks','admin')),
  kind        text NOT NULL CHECK (kind IN ('eco','invoice','repair_signoff')),
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','rejected')),
  snapshot    jsonb NOT NULL,
  requested_by  uuid NOT NULL REFERENCES app_user(id),
  decided_by    uuid REFERENCES app_user(id),
  decided_at    timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  deleted_at timestamptz,
  version    integer NOT NULL DEFAULT 1,
  -- See the header: an empty or non-object snapshot compares equal to everything, so it
  -- would make the consumer's re-check pass vacuously instead of catching drift.
  CONSTRAINT approval_snapshot_authorises_something CHECK (
    jsonb_typeof(snapshot) = 'object' AND snapshot <> '{}'::jsonb),
  -- A decision is atomic: either both stamps are set or neither is (mirrors
  -- modification_signoff_complete).
  CONSTRAINT approval_decision_complete CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  -- …and the stamps agree with the status, in BOTH directions: no decided row without a
  -- decision, and no pending row wearing one.
  CONSTRAINT approval_decided_iff_not_pending CHECK ((status = 'pending') = (decided_at IS NULL)),
  -- A rejection nobody can act on is worse than no rejection: the requester is left
  -- guessing what to change. Stated here as well as in the service (which owes the
  -- friendly message) for the same reason task.blocked_needs_reason is — it is an
  -- invariant of the ROW, not a rule of a transition graph, so it belongs where it
  -- cannot be forgotten by a new call site.
  CONSTRAINT approval_rejection_needs_note CHECK (
    status <> 'rejected' OR (decision_note IS NOT NULL AND char_length(decision_note) > 0))
);
COMMENT ON TABLE approval IS
  'One approval request (spec §6.3), polymorphic over every module''s records. Three kinds today (spec BR-4): Engineering Change Orders, Finance records at or above app_setting.finance_approval_threshold_sgd, and repair sign-off. pending → approved | rejected, both terminal: a rejected request is re-requested as a NEW row, never reopened, so the decision trail stays readable. Never hard-deleted (use deleted_at).';
COMMENT ON COLUMN approval.entity_type IS
  'The target table''s name. Deliberately unconstrained and deliberately un-FK''d — see this migration''s header. A CHECK listing today''s targets would make every new consumer a schema migration, which is the trap outbox.aggregate_type''s comment refuses; the service validates the target on the way in.';
COMMENT ON COLUMN approval.module IS
  'Denormalized owning module. Stored so the approvals queue can be scoped to the actor''s module access in ONE query, without a CASE over `kind` restated at every call site — and because the module is a property of the ENTITY, so it stays true the day a kind spans two of them. Same reasoning as task_link.module.';
COMMENT ON COLUMN approval.snapshot IS
  'Immutable record of WHAT was approved — the entity''s decision-relevant state at request time, not merely its id (spec §6.3: "what was approved, immutable"). The consumer re-checks it against current state before acting and refuses when they diverge; without that, editing an entity after approval silently rides an approval granted for different numbers. Fenced to a non-empty object because `{}`/`null` would make that re-check vacuously true.';
COMMENT ON COLUMN approval.requested_by IS
  'Who asked. NOT NULL because the pure domain reads it to enforce that nobody decides their own request — a NULL requester would make that rule silently inapplicable. Distinct from created_by, which is the audit-convention stamp for whoever wrote the ROW: they are the same person today, and are not required to be, because spec §5.5 puts approvals on the same outbox mechanism whose drain writes as an automation principal.';
COMMENT ON COLUMN approval.decision_note IS
  'Free text. REQUIRED on a rejection (CHECK above), optional on an approval — an approval says "these numbers are fine", which needs no elaboration, while a rejection has to tell the requester what to change.';
COMMENT ON COLUMN approval.version IS
  'Optimistic-lock counter (spec §6.4). Not incremented by any trigger — the service layer sets version = version + 1 explicitly on UPDATE, matching this platform''s convention (see modules/maintenance/services/repairService.ts).';

-- THE DOUBLE-CLICK GUARD, and the reason it is PARTIAL. At most one LIVE request per
-- (entity_type, entity_id, kind): two pending approvals for the same invoice would let
-- one be approved and the other rejected, and nothing would say which governs. Partial
-- on status = 'pending' because decided rows must accumulate — a total unique constraint
-- would make a rejected request un-re-requestable forever, which is the exact opposite of
-- "a rejected request is re-requested as a new row".
--   deleted_at IS NULL is in the predicate for the mirror-image reason: a soft-deleted
-- pending request must not block a fresh one, or a mistaken request would wedge the
-- record permanently with no route back short of manual SQL.
CREATE UNIQUE INDEX approval_one_pending_idx ON approval (entity_type, entity_id, kind)
  WHERE status = 'pending' AND deleted_at IS NULL;

-- The queue's ONLY query shape: pending requests, newest first. Partial so it stays
-- proportional to the OPEN backlog rather than to history — decided approvals accumulate
-- forever (they are the decision trail) and must not make the queue's index grow with
-- them. `id DESC` rides along for keyset pagination, the platform's list convention
-- (modification_keyset_idx).
CREATE INDEX approval_queue_idx ON approval (created_at DESC, id DESC)
  WHERE status = 'pending' AND deleted_at IS NULL;

-- "What approvals does this record have?" — the record panel, and approvalService's
-- getApprovalFor(entityType, entityId, kind), which every consumer calls before acting.
-- Mirrors task_link_entity_idx.
CREATE INDEX approval_entity_idx ON approval (entity_type, entity_id) WHERE deleted_at IS NULL;

-- "My requests" on the personal dashboard (spec §12 Home), and cover for the FK: an
-- unindexed referencing column turns every app_user delete into a sequential scan.
CREATE INDEX approval_requested_by_idx ON approval (requested_by) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- trg_approval_guard — what was approved, and the decision, are immutable.
--
-- Spec §6.4 lists `approval` post-decision among the tables "guarded by triggers
-- rejecting UPDATE/DELETE". This is the guard, narrowed to the columns that carry
-- meaning, and shaped after fn_task_comment_guard (20260719000000_platform_tasks.sql).
--
-- Two rules, and they are different:
--   1. The SUBJECT of an approval — which record, which kind, who asked, and above all
--      the snapshot — is immutable from the moment the request exists, not merely once
--      it is decided. Editing the snapshot of a PENDING request is the sharper attack:
--      the approver reads one set of numbers in the queue and stamps another.
--   2. The DECISION is immutable once made. Both terminal states are final; re-deciding
--      would erase the trail rather than extend it. Re-request instead.
-- Everything else stays writable, deliberately: updated_at/updated_by/version so the
-- optimistic-lock convention works, and deleted_at so a decided approval can still be
-- soft-deleted (retention/cleanup) without disabling a trigger.
--
-- UPDATE only, not DELETE. Hard deletes are already off the table by convention
-- (deleted_at exists and the services soft-delete), and blocking DELETE outright buys
-- nothing here while making every test teardown and every botched-import unwind require
-- ALTER TABLE ... DISABLE TRIGGER — a cost componentService.test.ts already pays for
-- component_installation and which nothing about this table justifies repeating.
--
-- No SECURITY DEFINER: this function needs no privilege its caller lacks (it reads only
-- OLD/NEW), and the siblings reserve SECURITY DEFINER for functions that genuinely need
-- owner rights — fn_audit writing audit_log, fn_resolve_actor reading RLS'd tables.
-- SET search_path is applied regardless, the way fn_task_comment_guard and
-- fn_modification_assign_no do.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_approval_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.entity_type   IS DISTINCT FROM OLD.entity_type
     OR NEW.entity_id   IS DISTINCT FROM OLD.entity_id
     OR NEW.kind        IS DISTINCT FROM OLD.kind
     OR NEW.module      IS DISTINCT FROM OLD.module
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.snapshot    IS DISTINCT FROM OLD.snapshot
     OR NEW.created_at  IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'approval %: the record under approval, its kind, its requester and its snapshot are immutable — the snapshot is what the approver agreed to, so changing it would authorise something nobody reviewed. Raise a NEW request instead.',
      OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status <> 'pending'
     AND (NEW.status        IS DISTINCT FROM OLD.status
          OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
          OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
          OR NEW.decision_note IS DISTINCT FROM OLD.decision_note) THEN
    RAISE EXCEPTION
      'approval % is already %: a decision is final (spec 6.4). A rejected request is re-requested as a NEW row, never reopened, so the decision trail stays readable.',
      OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;
COMMENT ON FUNCTION fn_approval_guard() IS
  'Enforces the two immutability rules of spec §6.3/§6.4 on `approval`: the subject of a request (entity, kind, requester, snapshot, creation time) never changes, and a decision, once made, is final. Leaves updated_*/version/deleted_at writable so the optimistic-lock and soft-delete conventions still work.';

CREATE TRIGGER trg_approval_guard BEFORE UPDATE ON approval
  FOR EACH ROW EXECUTE FUNCTION fn_approval_guard();

-- EXECUTE defaults to PUBLIC, so revoking from `anon` alone would be a NO-OP — anon
-- would keep the privilege through PUBLIC. Revoke the PUBLIC default plus the explicit
-- grantees this repo's bootstrap hands out (20250101000008_grants.sql runs ALTER DEFAULT
-- PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role, so both
-- roles receive a real grant on a Supabase project even though the bare test container
-- shows none). No re-grant: a trigger function is invoked by the trigger machinery, whose
-- privilege check happens at CREATE TRIGGER time, so nothing needs EXECUTE at fire time.
REVOKE EXECUTE ON FUNCTION fn_approval_guard() FROM PUBLIC, anon, authenticated;

-- Audit on both tables (spec §6). app_setting is audited precisely because a settings
-- change is invisible everywhere else: nothing in the UI records that the approval
-- threshold moved from 5,000 to 50,000 last Tuesday.
SELECT fn_attach_audit(t) FROM unnest(ARRAY['approval','app_setting']) AS t;

-- Corrects a claim that this migration falsifies: audit_log.row_id's comment said
-- "there are no text-keyed tables in this schema". app_setting is the first AUDITED one
-- (status_option/phase_option are text-keyed but carry no audit trigger), so its trail
-- rows carry row_id NULL by design rather than by accident.
COMMENT ON COLUMN audit_log.row_id IS
  'Identity of the audited row, when it has one. NULL for composite-keyed tables and for text-keyed ones: fn_audit reads (new_values->>''id'')::uuid, and app_setting (20260802000000_platform_approvals.sql) is keyed on `key`. Its trail is therefore found by table_name plus new_values->>''key'', not through audit_log_row_idx — cheap, because that table holds a handful of knobs rather than a table''s worth of records.';

-- RLS deny-via-REST (R1 pattern, per 20260720000000_platform_rls.sql): the app reaches
-- these only via the owner pool (withTransaction) / service_role, both of which bypass
-- RLS; no anon/authenticated policy = PostgREST denies all. NOT FORCE (FORCE would also
-- gate the owner connection and fn_audit's SECURITY DEFINER writes — the one path this
-- must leave alone).
ALTER TABLE approval    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_setting ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements follow, by design — see above.

-- ── Seed: the Finance approval threshold ────────────────────────────────────
-- S$5,000, the figure spec §16 proposes as the starting default. It is a STARTING
-- value and nothing more: the entire reason this row lives in a table rather than in a
-- constant is that a Super Admin retunes it from the settings console (spec §3.1
-- "system settings (finance approval threshold, ...)") without a deploy and without a
-- migration. Code that reads it must read it from here every time — a cached or
-- hardcoded 5000 would make the console lie.
--
-- VALUES with a scalar subselect, NOT `INSERT ... SELECT ... FROM app_user`: the join
-- form matches zero rows and inserts NOTHING, silently, on a database migrated from
-- scratch (migrations run before platform_seed.sql — see this migration's header).
-- The subselect yields NULL there instead, and the row still lands.
-- ON CONFLICT DO NOTHING is the repo norm: re-running this file must not raise, and
-- must never reset a threshold an admin has since changed.
INSERT INTO app_setting (key, value, created_by, updated_by)
VALUES ('finance_approval_threshold_sgd', to_jsonb(5000),
        (SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'),
        (SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'))
ON CONFLICT (key) DO NOTHING;

-- Deliberately the ONLY seeded key. spec §6.3 also names export_retention_days, and §14
-- earmarks feature flags, but neither has a reader yet — seeding a knob nothing consults
-- creates a value that looks authoritative and governs nothing. Each lands with the
-- feature that reads it.
