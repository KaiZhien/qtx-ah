-- ===========================================================================
-- Maintenance: usage records (spec §6.3). A usage_record is one observation of
-- a device's own session counter on a date — an ODOMETER READING, not an
-- increment. Two rows of 500 and 620 describe 120 sessions between them; no row
-- ever stores "120".
--
-- Spec §6.3 defines the entity as: device FK, recorded_on, cumulative_sessions
-- (int >= 0), source (manual/import/api), entered_by, note; APPEND-ONLY; latest
-- = max(recorded_on); NON-MONOTONIC ALLOWED WITH WARNING (counters reset).
--
-- ── WHY THERE IS NO `is_reset` COLUMN ──────────────────────────────────────
-- The non-monotonic rule is the interesting part of this entity, and the
-- obvious-looking implementation — compute "is this lower than the last one?"
-- on INSERT and store the answer — is wrong in a way that is worth spelling out
-- here, because the next person to look at this table will think of it.
--
--   1. This table is APPEND-ONLY and the trigger below enforces it absolutely.
--      A stored flag could therefore never be corrected. A derived value that is
--      guaranteed to go stale, in a table that forbids fixing it, is a bug with
--      a schema around it.
--   2. The flag is not a fact about a row. It is a fact about a row's PLACE IN A
--      SEQUENCE — it depends entirely on the reading chronologically before it.
--      Readings genuinely arrive out of order: a technician backfills a paper
--      logbook, or an import lands historical rows after the manual ones. A
--      BACKDATED append re-sorts the series and can put a reset flag onto a row
--      that never had one while taking it off a row that did — with neither row
--      being written. That is unrepresentable in a stored column, and the
--      append-only rule means it cannot even be repaired after the fact.
--
-- So this table stores only what was OBSERVED (a date and a counter value), and
-- every interpretation — reset detection, segments, cumulative-since-reset,
-- lifetime lower bound — is derived at read time by the pure domain
-- modules/maintenance/domain/usageReadings.ts, whose header carries the same
-- argument for the code half. Adding a denormalized flag here silently breaks
-- the backdating case and cannot be undone once rows exist.
--
-- ── WHY NO UNIQUE (device_id, recorded_on) ─────────────────────────────────
-- Two readings on ONE date are legal and meaningful: the before-and-after pair
-- around a service action that resets the counter is exactly that shape, and it
-- is the case this entity exists to record. The domain's chronological order
-- breaks a same-date tie on created_at so the pair still reads in entry order.
--
-- ── WHY NO version / updated_at / deleted_at ───────────────────────────────
-- All three describe a mutable row. This one never mutates: there is nothing to
-- lock optimistically, nothing to stamp on update, and a soft-delete flag would
-- be a mutation the guard below refuses anyway. Same shape as
-- repair_status_history / modification_status_history, which are append-only for
-- the same reason. A correction is a NEW reading, which is also the honest
-- record — the wrong number really was written down on that date.
--
-- Belongs to the `qtx-ops-platform` project (see the sibling
-- 20260718000000_platform_rbac.sql header for why this directory holds both the
-- new platform schema and the pre-existing DLMS migrations side by side).
-- Carries the platform_ token so __tests__/integration/setup.ts picks it up;
-- committing this file does nothing by itself until applied via the Supabase
-- MCP/CLI to the cloud project. app_user, device and fn_attach_audit all
-- already exist as of the earlier platform_* migrations.
-- ===========================================================================

CREATE TABLE usage_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES device(id),
  recorded_on date NOT NULL,
  cumulative_sessions integer NOT NULL CHECK (cumulative_sessions >= 0),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','api')),
  entered_by uuid REFERENCES app_user(id),
  note text,                             -- bilingual free text, preserved verbatim
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id)
);

COMMENT ON TABLE usage_record IS
  'APPEND-ONLY log of device session-counter readings (spec §6.3). One row = one observation of the counter on a date. Latest = max(recorded_on). A reading LOWER than the previous one is accepted (the physical counter was reset) and flagged at READ time by modules/maintenance/domain/usageReadings.ts — deliberately never stored; see this migration''s header. Rows are immutable: no UPDATE, no DELETE, no soft-delete (fn_usage_record_guard). A correction is a new reading.';
COMMENT ON COLUMN usage_record.cumulative_sessions IS
  'The counter value the machine DISPLAYED on recorded_on — an odometer, not an increment. Non-negative (a counter cannot read below zero). Permitted to be LOWER than the previous reading: spec §6.3 accepts a non-monotonic series with a warning, because counters reset on board swaps, service actions and firmware re-flashes. Refusing it would make a device whose counter was legitimately replaced impossible to keep records for.';
COMMENT ON COLUMN usage_record.recorded_on IS
  'The date the counter was READ, supplied by the person reading it — deliberately distinct from created_at, which is when the row was appended. A backdated reading (a logbook entered months later) has recorded_on in the past and created_at now, and re-sorts the derived series. That divergence is precisely why the reset flag is not stored.';
COMMENT ON COLUMN usage_record.source IS
  'How the reading arrived (spec §6.3): manual entry, bulk import, or a device API. Fenced by a CHECK rather than a vocabulary table — unlike modification_type these are not values an admin extends, they are the three code paths that can write this table, and a fourth would be a code change, not a row.';
COMMENT ON COLUMN usage_record.entered_by IS
  'Who supplied the reading, which is NOT always who created the row (spec §6.3 names both). A technician reads the counter in the field and an administrator types it in later: entered_by is the technician, created_by is the administrator. Defaults to the acting user when the service is not told otherwise. Nullable for imported rows whose source system named nobody.';
COMMENT ON COLUMN usage_record.created_by IS
  'The actor whose transaction appended this row. Never null — every append has an authenticated writer (permission log_usage_service).';

-- The two query shapes this table has: "this device's readings, newest first"
-- (the profile Usage tab and the whole-series derivation) and "recent readings
-- across the fleet" (the maintenance module surface). recorded_on leads the
-- device index because max(recorded_on) is the spec's definition of "latest";
-- created_at is the same tiebreak the domain's chronological order applies.
CREATE INDEX usage_record_device_idx
  ON usage_record(device_id, recorded_on DESC, created_at DESC);
CREATE INDEX usage_record_keyset_idx ON usage_record(created_at DESC, id DESC);

-- ── Append-only guard ──────────────────────────────────────────────────────
-- Stricter than component_installation's guard, which permits one mutation (the
-- one-time removal stamp). This table permits NONE: an observation of a counter
-- on a date is a historical fact, and spec §6.4 lists usage_record among the
-- immutable history tables. There is no legitimate edit — a mis-typed reading is
-- corrected by appending the right one, which also preserves the true record
-- that the wrong number was written down.
--
-- ERRCODE 23514 (check_violation) matches the sibling guards so an application
-- layer that classifies Postgres errors sees one shape for "immutability
-- refused", not a per-table taxonomy.
CREATE OR REPLACE FUNCTION fn_usage_record_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'usage_record is append-only — readings cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'usage_record is append-only — a recorded reading is immutable'
    USING ERRCODE = '23514';
END $$;
CREATE TRIGGER trg_usage_record_guard BEFORE UPDATE OR DELETE ON usage_record
  FOR EACH ROW EXECUTE FUNCTION fn_usage_record_guard();
COMMENT ON TRIGGER trg_usage_record_guard ON usage_record IS
  'Enforces spec §6.4 immutability. Rejects every UPDATE and every DELETE outright — unlike component_installation''s guard, which allows the one-time removal stamp. Do not relax this to "allow editing the note": the note is part of the observation.';

-- ── Insert guard: recorded_on may not be in the future ─────────────────────
-- A future reading is not a policy choice, it is a DOMAIN IMPOSSIBILITY: nobody
-- read a counter tomorrow. On a table where every other integrity mechanism has
-- been given up — no UPDATE, no DELETE, no soft-delete — validation on the way
-- IN is the only one left, so the rule has to live here.
--
-- WHAT ONE BAD ROW COSTS, and why this is worth a trigger rather than a comment:
-- `recorded_on` defines "latest" (spec §6.3: latest = max(recorded_on)). A row
-- dated 2030 becomes the latest reading permanently. It pins
-- daysSinceLastReading at 0 forever, so the device never ages out of any
-- staleness view; it makes every genuine reading recorded between now and 2030
-- classify as a counter reset, because each is lower than the bogus one; and it
-- cannot be corrected, because the guard above refuses UPDATE and DELETE.
-- Recovery would mean DISABLE TRIGGER — deliberately breaking the invariant this
-- table exists to hold. The only affordable moment is before the row lands.
--
-- WHY A TRIGGER AND NOT A CHECK CONSTRAINT: a CHECK must be IMMUTABLE, and
-- current_date is STABLE (it depends on the transaction timestamp). Postgres
-- accepts `CHECK (recorded_on <= current_date)` in some forms but the constraint
-- is then only evaluated on write and is a documented footgun for dump/restore,
-- which re-validates. A BEFORE INSERT trigger says exactly what is meant.
--
-- WHY IN THE DATABASE AND NOT ONLY IN THE SERVICE: the `source` CHECK above
-- already anticipates `import` and `api` writers that do not exist yet. Those
-- will not come through recordUsage's Zod schema. A rule that only the current
-- writer honours is a rule the next writer breaks.
CREATE OR REPLACE FUNCTION fn_usage_record_insert_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.recorded_on > current_date THEN
    RAISE EXCEPTION
      'usage_record.recorded_on cannot be in the future (got %, today is %)',
      NEW.recorded_on, current_date
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_usage_record_insert_guard BEFORE INSERT ON usage_record
  FOR EACH ROW EXECUTE FUNCTION fn_usage_record_insert_guard();
COMMENT ON TRIGGER trg_usage_record_insert_guard ON usage_record IS
  'Refuses a future recorded_on. The last line of defence on an append-only table: a future-dated row permanently owns max(recorded_on), pins the staleness age at 0, makes every later genuine reading look like a counter reset, and cannot be corrected because UPDATE and DELETE are both refused. Binds the import/api writers the source CHECK anticipates, not just recordUsage.';

-- Audit the INSERT — the only event this table has, and exactly the one worth
-- trailing. fn_audit is shape-agnostic (audit_log.row_id/new_values are
-- nullable), so a table with no version/updated_at columns attaches cleanly.
SELECT fn_attach_audit('usage_record');

-- RLS deny-via-REST (R1 pattern, per 20260720000000_platform_rls.sql): the app
-- reaches this only via the owner pool (withTransaction) / service_role, both of
-- which bypass RLS; no anon/authenticated policy = PostgREST denies all. NOT FORCE
-- (FORCE would also gate the owner connection and fn_audit's SECURITY DEFINER
-- writes — the one path this must leave alone).
ALTER TABLE usage_record ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements follow, by design — see above.

REVOKE EXECUTE ON FUNCTION fn_usage_record_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_usage_record_insert_guard() FROM PUBLIC, anon, authenticated;
