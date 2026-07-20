-- ===========================================================================
-- Engineering module (spec §4/§6.3): change management (ECR/ECO) + firmware
-- release registry. Basic scope — working CRUD and a simple per-entity status
-- flow, NOT the full approvals engine (that arrives with the `approval`/outbox
-- tables later, spec §5.5).
--
-- Spec §6.3 models change management as one `eng_change` row with a stage
-- (request→order). This migration instead lands the two as SEPARATE tables
-- (`ecr`, `eco`) per the Engineering-basic task: an ECO optionally references
-- the ECR it realises (eco.ecr_id). The status flows are the smaller ones the
-- task specifies (ECR: draft→submitted→accepted/rejected; ECO: draft→submitted
-- →approved→implemented, +rejected) and are enforced fail-closed both by the
-- CHECK constraints here and by the pure domain (modules/engineering/domain).
--
-- Sorts LAST of the platform migrations (timestamp 20260720100000), so device /
-- device_variant / component_type / component_unit (from 20260719000001 and
-- 20260720000001) all already exist — every FK target below is live, including
-- the deferred component_unit.firmware_release_id FK this migration lands.
--
-- House conventions (spec §6): uuid PK default gen_random_uuid(); business keys
-- (ecr_no/eco_no) are unique-when-live DATA, never PKs; created_at/created_by/
-- updated_at/updated_by; soft delete via deleted_at (no hard deletes); version
-- integer optimistic-lock counter bumped by the write path, not a trigger;
-- fn_attach_audit on every mutable table. RLS deny-via-REST + NO FORCE, exactly
-- as 20260720000000_platform_rls.sql / _components establish (owner pool +
-- service_role are the only writers and both bypass RLS; enabling RLS with zero
-- policies makes PostgREST deny anon/authenticated).
-- ===========================================================================

-- Human reference-number sequences (spec §6.4: per-record refs are formatted
-- from a sequence, never used as a PK). Monotonic, no per-year reset — a gap
-- from a rolled-back INSERT is fine (sequences do not roll back), and the year
-- prefix keeps refs readable without a reset job. Consumed by the column
-- DEFAULT below so the write service never has to construct or collide on them.
CREATE SEQUENCE ecr_no_seq;
CREATE SEQUENCE eco_no_seq;

-- ── ECR: Engineering Change Request ─────────────────────────────────────────
CREATE TABLE ecr (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ecr_no text NOT NULL
    DEFAULT ('ECR-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('ecr_no_seq')::text, 4, '0')),
  title text NOT NULL,
  description text,                      -- bilingual free text, preserved verbatim
  reason text,                          -- why the change is requested
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'accepted', 'rejected')),
  device_id uuid REFERENCES device(id),           -- optional: the device this change concerns
  variant_id uuid REFERENCES device_variant(id),  -- optional: the variant this change concerns
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE ecr IS
  'Engineering Change Request (spec §4). Basic status flow draft→submitted→accepted/rejected, enforced by the CHECK here and modules/engineering/domain/ecrStatus.ts. device_id/variant_id are optional linkage to the record the change concerns.';
COMMENT ON COLUMN ecr.ecr_no IS
  'Human reference (ECR-YYYY-NNNN) from ecr_no_seq via the column DEFAULT. Unique-when-live (ecr_no_unique). Never a primary key (spec §6.4).';
COMMENT ON COLUMN ecr.version IS
  'Optimistic-lock counter (spec §6.4). Bumped explicitly by the write path (modules/engineering/services), not a trigger — matching device.version.';

CREATE UNIQUE INDEX ecr_no_unique ON ecr(ecr_no) WHERE deleted_at IS NULL;
CREATE INDEX ecr_status_idx ON ecr(status) WHERE deleted_at IS NULL;
CREATE INDEX ecr_created_idx ON ecr(created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX ecr_device_idx ON ecr(device_id) WHERE device_id IS NOT NULL;
CREATE INDEX ecr_variant_idx ON ecr(variant_id) WHERE variant_id IS NOT NULL;

-- ── ECO: Engineering Change Order ───────────────────────────────────────────
CREATE TABLE eco (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  eco_no text NOT NULL
    DEFAULT ('ECO-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('eco_no_seq')::text, 4, '0')),
  title text NOT NULL,
  description text,
  ecr_id uuid REFERENCES ecr(id),       -- optional: the request this order realises
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'implemented', 'rejected')),
  -- Effectivity: when/where the change takes effect (spec §6.3 eng_change:
  -- effectivity_date, effectivity_serial). Free-text serial honours legacy
  -- ranged/listed serials (device.pcba_a_sn_legacy convention).
  effectivity_date date,
  effectivity_serial text,
  effectivity_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE eco IS
  'Engineering Change Order (spec §4/§6.3). Status flow draft→submitted→approved→implemented (+rejected); the submitted→approved step is gated by the approve_requests permission in the write service (spec §3.2/BR-4). eco.ecr_id optionally links the order to its originating request.';
COMMENT ON COLUMN eco.eco_no IS
  'Human reference (ECO-YYYY-NNNN) from eco_no_seq via the column DEFAULT. Unique-when-live (eco_no_unique). Never a primary key.';

CREATE UNIQUE INDEX eco_no_unique ON eco(eco_no) WHERE deleted_at IS NULL;
CREATE INDEX eco_status_idx ON eco(status) WHERE deleted_at IS NULL;
CREATE INDEX eco_created_idx ON eco(created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX eco_ecr_idx ON eco(ecr_id) WHERE ecr_id IS NOT NULL;

-- ── Firmware release registry ───────────────────────────────────────────────
CREATE TABLE firmware_release (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component_type_id uuid NOT NULL REFERENCES component_type(id),
  -- The firmware version STRING (e.g. '1.4.2'). Deliberately NOT named `version`
  -- because that name is reserved for the house optimistic-lock counter below;
  -- spec §6.3's firmware_release.`version` is this business field. Unique per
  -- component type (firmware_release_ver_unique).
  fw_version text NOT NULL,
  release_date date,
  changelog text,                       -- notes / release notes, bilingual verbatim
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'released', 'withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE firmware_release IS
  'Firmware release registry (spec §6.3). One row per (component_type, fw_version). Status flow draft→released→withdrawn (modules/engineering/domain/firmwareStatus.ts). component_unit.firmware_release_id references this table (FK landed below).';
COMMENT ON COLUMN firmware_release.fw_version IS
  'Firmware version string (spec §6.3 firmware_release.version). Renamed from the spec''s `version` to avoid colliding with the house optimistic-lock `version integer` column; unique per component_type.';
COMMENT ON COLUMN firmware_release.version IS
  'Optimistic-lock counter (spec §6.4), NOT the firmware version — see fw_version. Bumped by the write path, not a trigger.';

CREATE UNIQUE INDEX firmware_release_ver_unique
  ON firmware_release(component_type_id, fw_version) WHERE deleted_at IS NULL;
CREATE INDEX firmware_release_type_idx
  ON firmware_release(component_type_id) WHERE deleted_at IS NULL;
CREATE INDEX firmware_release_status_idx ON firmware_release(status) WHERE deleted_at IS NULL;
CREATE INDEX firmware_release_created_idx
  ON firmware_release(created_at DESC, id DESC) WHERE deleted_at IS NULL;

-- Land the deferred FK the components migration reserved (20260720000001_
-- platform_components.sql: "firmware_release_id uuid ... FK added when that
-- table lands"). component_unit already exists with the plain nullable column.
ALTER TABLE component_unit
  ADD CONSTRAINT component_unit_firmware_fk
  FOREIGN KEY (firmware_release_id) REFERENCES firmware_release(id);

-- Audit on every mutable table (spec §6). INSERT + the version-bumping UPDATEs
-- are exactly the events worth trailing.
SELECT fn_attach_audit(t) FROM unnest(ARRAY[
  'ecr', 'eco', 'firmware_release'
]) AS t;

-- RLS deny-via-REST (R1 pattern, see 20260720000000_platform_rls.sql header):
-- the app reaches these tables only via the owner pool (withTransaction) or
-- service_role — both bypass RLS. Enabling RLS with NO policies makes PostgREST
-- deny every anon/authenticated SELECT/INSERT/UPDATE/DELETE. NOT FORCE, so the
-- owner connection and fn_audit's SECURITY DEFINER writes are untouched.
ALTER TABLE ecr              ENABLE ROW LEVEL SECURITY;
ALTER TABLE eco              ENABLE ROW LEVEL SECURITY;
ALTER TABLE firmware_release ENABLE ROW LEVEL SECURITY;

-- No CREATE POLICY statements follow, by design — see header.
