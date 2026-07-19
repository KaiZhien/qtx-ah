-- ===========================================================================
-- Manufacturing: device registry (spec §5.2/§6.2). Ten-status lifecycle
-- vocabulary + traceability spine (device_variant, device, device_status_history,
-- status_transition) for the read-only registry port (Task 13, Week 2 demo).
-- Full CRUD/import/status-change lands Week 3 (spec §17 roadmap).
--
-- Belongs to the new `qtx-ops-platform` project (see the sibling
-- 20260718000000_platform_rbac.sql header for why this directory holds both the
-- new platform schema and the pre-existing DLMS migrations side by side).
-- Carries the platform_ token so __tests__/integration/setup.ts picks it up;
-- committing this file does nothing by itself until applied via the Supabase
-- MCP/CLI to the cloud project.
--
-- pg_trgm and app_user already exist as of 20260718000000_platform_rbac.sql —
-- not recreated here.
-- ===========================================================================

-- ── Vocabularies (spec §6.3) ────────────────────────────────────────────────
-- Ported shape (deliberately lighter than the standard table convention: no
-- created_at/created_by/deleted_at/version — there is no runtime writer to
-- attribute or version beyond the admin-console updated_by stamp).
CREATE TABLE status_option (
  code        text PRIMARY KEY,
  label_en    text NOT NULL,
  label_zh    text NOT NULL,
  is_initial  boolean NOT NULL DEFAULT false,
  is_terminal boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  updated_by  uuid REFERENCES app_user(id)
);
COMMENT ON TABLE status_option IS
  'Admin-editable device-status vocabulary (spec §5.2 lifecycle). Adding a value is a row INSERT — no migration needed.';
COMMENT ON COLUMN status_option.is_initial IS
  'Creation-only: nothing transitions into it. Seeded true for in_production.';
COMMENT ON COLUMN status_option.is_terminal IS
  'Transition sink: no onward transitions. Seeded true for retired and scrapped.';

CREATE TABLE phase_option (
  code        text PRIMARY KEY,
  label_en    text NOT NULL,
  label_zh    text NOT NULL,
  is_initial  boolean NOT NULL DEFAULT false,
  is_terminal boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  updated_by  uuid REFERENCES app_user(id)
);
COMMENT ON TABLE phase_option IS
  'Ported legacy manufacturing-phase vocabulary (DLMS supabase/seed.sql: Production/Validation/Rework/Pilot/EOL). Same column shape as status_option; phase has no transition graph today so is_initial/is_terminal are carried for consistency only.';

-- ── Traceability spine (spec §6.2, verbatim plus the pcba_a_sn_legacy/customer
--    additions noted below) ─────────────────────────────────────────────────
CREATE TABLE device_variant (          -- Basic, Pro, future rows — never a schema change
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,           -- 'basic' | 'pro' | ...
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- survives migration verbatim
  device_sn text,                       -- unique when present (legacy rows may lack it)
  variant_id uuid NOT NULL REFERENCES device_variant(id),
  status text NOT NULL REFERENCES status_option(code),
  phase text REFERENCES phase_option(code),   -- legacy manufacturing phase, ported vocab
  -- buyer(id) doesn't exist until the Post-sales/Finance schema lands (spec §17,
  -- week 8) — column is reserved now (deviation #2, see migration report) so no
  -- later ADD COLUMN is needed; the FK constraint is added once buyer exists.
  buyer_id uuid,                        -- set at/after delivery
  build_date date, ship_date date, delivered_date date,
  product_name text, model_no text, destination text,
  customer text,                        -- deviation #1 (see migration report): required by the
                                         -- read-service SELECT/DeviceListItem.customer but absent
                                         -- from the spec §6.2 snippet as authored
  remarks text,                         -- bilingual free text, preserved verbatim
  -- Legacy PCBA-A serial, carried verbatim from DLMS where it is the de-facto
  -- device identity (device_sn is often blank) and may hold a range or list,
  -- e.g. "EE-02A-2603-0001 to 0015". Preserved rather than parsed: see
  -- needs_data_review and scripts/migrate_demo.ts. The normalized component
  -- model (week 4) supersedes it; it is never the basis of new records.
  pcba_a_sn_legacy text,
  device_sn_normalized text,            -- trigger-maintained, search (fn_device_normalize)
  needs_data_review boolean NOT NULL DEFAULT false,  -- legacy ranged-serial flag
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE device IS
  'System of record for the device registry (spec §6.2). Never hard-deleted (use deleted_at). Full write path (create/edit/status-change) lands Week 3 — this task is read-only.';
COMMENT ON COLUMN device.device_sn IS
  'Intended primary key going forward; often blank on migrated legacy rows (see pcba_a_sn_legacy). Unique when present (device_sn_unique, partial on deleted_at IS NULL).';
COMMENT ON COLUMN device.pcba_a_sn_legacy IS
  'Legacy PCBA-A serial, carried verbatim from DLMS where it is the de-facto device identity (device_sn is often blank) and may hold a range or list, e.g. "EE-02A-2603-0001 to 0015". Preserved rather than parsed — see needs_data_review. Superseded by the normalized component model (week 4); never the basis of new records.';
COMMENT ON COLUMN device.needs_data_review IS
  'True for legacy rows whose identity is a ranged/listed serial (pcba_a_sn_legacy) that was preserved verbatim rather than split. Surfaced as a "needs review" chip in the registry UI; a week-3+ cleanup queue works these off as tasks (spec risk R-5).';
COMMENT ON COLUMN device.remarks IS
  'Bilingual free text (English/Chinese), preserved verbatim. Never truncated.';
COMMENT ON COLUMN device.version IS
  'Optimistic-lock counter (spec §6.4). Not incremented by any trigger — the write path (Week 3) sets it explicitly on UPDATE, matching this platform''s established convention (see modules/shared/tasks/services/taskService.ts).';
COMMENT ON COLUMN device.buyer_id IS
  'References the future buyer table (Post-sales/Finance, spec §17 week 8), which does not exist yet — no FK constraint until then. Reserved now so populating it during data migration does not require a later ADD COLUMN.';

CREATE UNIQUE INDEX device_sn_unique ON device(device_sn)
  WHERE device_sn IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX device_status_idx ON device(status) WHERE deleted_at IS NULL;
CREATE INDEX device_variant_idx ON device(variant_id);
CREATE INDEX device_sn_trgm ON device USING gin (device_sn_normalized gin_trgm_ops); -- partial match
CREATE INDEX device_pcba_a_legacy_trgm ON device USING gin (pcba_a_sn_legacy gin_trgm_ops);

-- Maintains device_sn_normalized: lowercased, whitespace/hyphens stripped, so
-- "QTX-P-00412" and a search for "00412" or "qtx-p-00412" normalize to the same
-- comparable form the read service's LIKE-based partial/case-insensitive search
-- relies on (modules/manufacturing/services/deviceReadService.ts).
CREATE OR REPLACE FUNCTION fn_device_normalize()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.device_sn_normalized := CASE WHEN NEW.device_sn IS NOT NULL
    THEN lower(regexp_replace(NEW.device_sn, '[\s-]', '', 'g'))
    ELSE NULL END;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_device_normalize BEFORE INSERT OR UPDATE ON device
  FOR EACH ROW EXECUTE FUNCTION fn_device_normalize();

CREATE TABLE device_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES device(id),
  from_status text, to_status text NOT NULL,
  reason text,                          -- required per status_transition.requires_reason
  changed_by uuid NOT NULL REFERENCES app_user(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE device_status_history IS
  'Full status-change log (spec §6.2). The device row carries only the current status for querying; this table is the audit-grade history the Status history tab renders.';
CREATE INDEX dsh_device ON device_status_history(device_id, changed_at DESC);

CREATE TABLE status_transition (       -- fail-closed workflow, admin-editable
  from_status text NOT NULL REFERENCES status_option(code),
  to_status   text NOT NULL REFERENCES status_option(code),
  requires_reason boolean NOT NULL DEFAULT false,
  task_template_key text,              -- handoff task to spawn (nullable)
  notify_roles text[],
  PRIMARY KEY (from_status, to_status)
);
COMMENT ON TABLE status_transition IS
  'Fail-closed device status graph (spec §5.2): no row = forbidden move. Enforced by the Week 3 write path; stored now so this migration is the single source of truth for the graph from day one.';
COMMENT ON COLUMN status_transition.task_template_key IS
  'Handoff task template to spawn on this transition (e.g. ready_for_delivery → shipped spawns "logistics_prepare_delivery"). Stored now; Week 3+ automation reads it — no consumer yet.';

SELECT fn_attach_audit(t) FROM unnest(ARRAY['device','device_status_history']) AS t;

-- ── Seed: the ten-status lifecycle (spec §5.2 state diagram) ────────────────
-- in_stock / under_repair / shipped carry the EXACT labels the live DLMS
-- database already uses for those three statuses (CLAUDE.md: prod vocab codes
-- drifted from dlms/supabase/seed.sql to "In Stock"/"Under Repair"/"Shipped") so
-- Task 14's migration can map the legacy device.status values onto these codes
-- 1:1 by label.
INSERT INTO status_option (code, label_en, label_zh, is_initial, is_terminal, sort_order) VALUES
  ('in_production',      'In Production',      '生产中',   true,  false, 1),
  ('quality_check',      'Quality Check',       '品质检验', false, false, 2),
  ('in_stock',           'In Stock',            '库存',     false, false, 3),
  ('ready_for_delivery',  'Ready for Delivery',  '待发货',   false, false, 4),
  ('shipped',            'Shipped',             '已发货',   false, false, 5),
  ('delivered',          'Delivered',           '已送达',   false, false, 6),
  ('active',             'Active',              '使用中',   false, false, 7),
  ('under_repair',       'Under Repair',        '维修中',   false, false, 8),
  ('returned',           'Returned',            '已退回',   false, false, 9),
  ('retired',            'Retired',             '已退役',   false, true,  10),
  ('scrapped',           'Scrapped',            '已报废',   false, true,  11);

-- Ported from the legacy DLMS phase_option seed (dlms/supabase/seed.sql), same
-- codes translated to this schema's snake_case convention. Not exercised by
-- any test in this task (device.phase is nullable and untested here) but seeded
-- now so Task 14's migration has somewhere to map legacy phase values.
INSERT INTO phase_option (code, label_en, label_zh, sort_order) VALUES
  ('production',   'Production',  '量产', 1),
  ('validation',   'Validation',  '验证', 2),
  ('rework',       'Rework',      '返工', 3),
  ('pilot',        'Pilot',       '试点', 4),
  ('end_of_life',  'End of Life', '停产', 5);

INSERT INTO device_variant (code, name) VALUES
  ('basic', 'Basic'),
  ('pro',   'Pro');

-- Seed status_transition for exactly the arrows in the spec §5.2 diagram (14
-- edges). ready_for_delivery → shipped additionally carries task_template_key —
-- week-3 automation reads it, week 2 only stores it. requires_reason is set on
-- the three transition kinds spec §5.2 calls out by name: QC → rework,
-- (any) → Returned, and Returned → Scrapped.
INSERT INTO status_transition (from_status, to_status, requires_reason, task_template_key) VALUES
  ('in_production',     'quality_check',      false, NULL),
  ('quality_check',     'in_production',      true,  NULL),  -- rework
  ('quality_check',     'in_stock',           false, NULL),
  ('in_stock',          'ready_for_delivery', false, NULL),
  ('ready_for_delivery','shipped',            false, 'logistics_prepare_delivery'),
  ('shipped',           'delivered',          false, NULL),
  ('delivered',         'active',             false, NULL),
  ('active',            'under_repair',       false, NULL),
  ('under_repair',      'active',             false, NULL),  -- repair signed off
  ('active',            'returned',           true,  NULL),
  ('returned',          'in_stock',           false, NULL),  -- refurbished
  ('returned',          'under_repair',       false, NULL),
  ('active',            'retired',            false, NULL),
  ('returned',          'scrapped',           true,  NULL);
