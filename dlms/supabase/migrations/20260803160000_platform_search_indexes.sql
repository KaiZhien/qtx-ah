-- ---------------------------------------------------------------------------
-- Global search + dashboard indexes (spec §8.4, §8.5)
--
-- INDEX-ONLY. This migration creates no table, no column and no trigger: every
-- object it touches already exists on `main`. That is deliberate — global search
-- and the dashboards READ from every module, and the modules themselves are
-- being built in parallel. Creating a table here would collide with the agent
-- that owns it.
--
-- Consequently there is no RLS statement below and that is not an omission: RLS
-- is a property of a TABLE, and every table indexed here already carries
-- `ENABLE ROW LEVEL SECURITY` with no anon/authenticated policy from its own
-- migration (20260720000000_platform_rls.sql and each module's). An index
-- inherits its table's policies; it cannot widen them.
--
-- WHY TRIGRAM AND NOT OPENSEARCH: spec D3, CONFIRMED. At this scale (a fleet in
-- the thousands, not millions) `pg_trgm` on normalized columns is the whole
-- answer, and it keeps search inside the same transaction and the same
-- permission model as every other read.
--
-- pg_trgm is already installed — it is the accepted `pg_trgm`-in-public advisor
-- WARN recorded in PROGRESS.md's carried findings, and 20260719000001_platform_
-- devices.sql already relies on it for device_sn_trgm.
--
-- ── THE TWO NORMALIZATION FAMILIES ─────────────────────────────────────────
-- These expressions are TRANSCRIBED FROM modules/shared/search/domain/
-- searchQuery.ts and must stay identical to it. A Postgres expression index is
-- only used when the query's expression matches it CHARACTER FOR CHARACTER after
-- parsing — change `normalizeRef` in TypeScript without changing the matching
-- expression here and nothing breaks loudly: every search silently becomes a
-- sequential scan over every table in every group, on every keystroke.
--
--   ref family  → lower(translate(col, ' -', ''))
--                 Lowercase, drop spaces and hyphens. Matches what
--                 fn_device_normalize and fn_component_unit_normalize already
--                 store, which is why device/component need no index here.
--                 `translate(x, ' -', '')` deletes both characters because the
--                 `to` string is shorter than the `from` string.
--
--   name family → the raw column with gin_trgm_ops, queried with ILIKE.
--                 gin_trgm_ops supports ILIKE directly, so no expression is
--                 needed and separators survive — "Acme Corp" stays two words.
--                 This is the shape task_title_trgm already uses.
--
-- Both `lower` and `translate` are IMMUTABLE, which is what makes them legal in
-- an index expression.
-- ---------------------------------------------------------------------------

-- ── Search: reference family ───────────────────────────────────────────────
-- device.device_sn_normalized and component_unit.serial_no_normalized already
-- carry `device_sn_trgm` / `component_unit_sn_trgm` from their own migrations;
-- searching them needs no new index. Everything else does.

CREATE INDEX IF NOT EXISTS sales_invoice_no_trgm ON sales_invoice
  USING gin (lower(translate(invoice_no, ' -', '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS delivery_order_no_trgm ON delivery_order
  USING gin (lower(translate(do_no, ' -', '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS repair_no_trgm ON repair
  USING gin (lower(translate(repair_no, ' -', '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS modification_no_trgm ON modification
  USING gin (lower(translate(modification_no, ' -', '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS ecr_no_trgm ON ecr
  USING gin (lower(translate(ecr_no, ' -', '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS eco_no_trgm ON eco
  USING gin (lower(translate(eco_no, ' -', '')) gin_trgm_ops);

-- failure_investigation.fi_no (spec §8.4 "FI refs") — agent ENGINEERING's table.
--
-- GUARDED, because this migration and the one creating that table land from two
-- different branches and nothing guarantees the order. An unguarded CREATE INDEX
-- on a missing relation fails the whole migration; skipping quietly is the wrong
-- failure mode too, so it RAISES A NOTICE naming exactly what to do.
--
-- Their `fi_no_lower_idx` is a BTREE on `lower(fi_no)` for exact/prefix lookup.
-- This is a TRIGRAM index on a different expression, serving partial match. The
-- two do not collide and neither makes the other redundant.
DO $$
BEGIN
  IF to_regclass('public.failure_investigation') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS failure_investigation_no_trgm ON failure_investigation
      USING gin (lower(translate(fi_no, ' -', '')) gin_trgm_ops);
  ELSE
    RAISE NOTICE 'Skipped failure_investigation_no_trgm: table not present yet. '
      'Re-run this statement after the Engineering failure/RCA migration applies, '
      'or global search falls back to a sequential scan for FI- refs.';
  END IF;
END $$;

-- ── Search: name family ────────────────────────────────────────────────────
-- task.title already has task_title_trgm (20260719000000_platform_tasks.sql).

CREATE INDEX IF NOT EXISTS buyer_name_trgm ON buyer USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS app_user_full_name_trgm ON app_user USING gin (full_name gin_trgm_ops);

-- app_user.email is UNIQUE (a btree), which serves equality but not the partial
-- match spec §8.4 asks for. The admin-only People group searches both.
CREATE INDEX IF NOT EXISTS app_user_email_trgm ON app_user USING gin (email gin_trgm_ops);

-- ── Dashboards (spec §8.5) ─────────────────────────────────────────────────
-- "materialized-view-free — direct indexed queries with 60 s server cache".
-- These are the indexes those direct queries need; the ported stats_daily
-- pattern stays unbuilt unless one of them proves slow, per the spec.

-- "Deliveries due this week": filters on ship_date within a window, per status.
CREATE INDEX IF NOT EXISTS delivery_order_ship_date_idx ON delivery_order (ship_date)
  WHERE deleted_at IS NULL;

-- "Invoices unpaid": status + due_date drives both the count and the overdue split.
-- sales_invoice_status_idx exists but carries no date, so the ordering still sorts.
CREATE INDEX IF NOT EXISTS sales_invoice_status_due_idx ON sales_invoice (status, due_date)
  WHERE deleted_at IS NULL;

-- "Active repairs by state with days-in-state aging": the aging clock is the most
-- recent status change, so the widget reads repair_status_history per repair.
-- rsh_repair covers (repair_id, changed_at DESC) already; this covers the reverse
-- access path — the whole recent window across all repairs.
CREATE INDEX IF NOT EXISTS rsh_changed_at_idx ON repair_status_history (changed_at DESC);

-- "Imports awaiting confirm": a tiny, highly selective set.
CREATE INDEX IF NOT EXISTS import_batch_status_idx ON import_batch (status);

-- "My approvals pending" / the approvals widget: pending rows by module.
CREATE INDEX IF NOT EXISTS approval_status_module_idx ON approval (status, module)
  WHERE deleted_at IS NULL;

-- "Devices by variant" (pipeline funnel's second axis). device already indexes
-- status; variant_id is only reachable through the FK today.
CREATE INDEX IF NOT EXISTS device_variant_idx ON device (variant_id)
  WHERE deleted_at IS NULL;

-- "User activity" — most-recently-active users first. Partial: a user who has
-- never logged in is not activity.
CREATE INDEX IF NOT EXISTS app_user_last_login_idx ON app_user (last_login_at DESC)
  WHERE last_login_at IS NOT NULL;

-- "Recent activity on my records" reads audit_log by actor; audit_log_actor_idx
-- (actor_id, occurred_at DESC) already covers it exactly. No index needed.
-- "Failed logins" reads auth_event by (event_type, occurred_at DESC);
-- auth_event_type_idx already covers it exactly. No index needed.

COMMENT ON INDEX sales_invoice_no_trgm IS
  'Global search, reference family (spec §8.4). The expression is transcribed from normalizeRef() in modules/shared/search/domain/searchQuery.ts — the two must stay character-identical or the planner stops using this index and every search sequentially scans the table.';
COMMENT ON INDEX buyer_name_trgm IS
  'Global search, name family (spec §8.4). Indexes the RAW column because gin_trgm_ops supports ILIKE directly and buyer names must keep their word boundaries — folding "Acme Corp" to "acmecorp" would make a two-word search worse, not better.';
