-- ===========================================================================
-- Component model (spec §10–11). The normalized, append-only record of which
-- components each device contains and has ever contained. component_installation
-- is the heart: current components = rows with removed_at IS NULL; a replacement
-- closes the old row and opens a new one in ONE transaction (§14). Serialized
-- units get one row per physical part; batch parts reference a type + batch_no.
--
-- Deferred FKs: firmware_release_id / location_id / repair_id / modification_id
-- reference tables from modules not built yet (Engineering/Logistics/Maintenance)
-- — declared as plain nullable uuid (the device.buyer_id pattern); the FK is
-- added when the target table lands.
--
-- RLS deny-via-REST + no FORCE, per 20260720000000_platform_rls.sql.
-- ===========================================================================

CREATE TABLE component_type (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  tracking_mode text NOT NULL CHECK (tracking_mode IN ('serialized','batch')),
  requires_firmware boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_user(id),  -- nullable: this migration's own seed below runs
                                             -- before platform_seed.sql bootstraps app_user (see
                                             -- __tests__/integration/setup.ts — migrations loop,
                                             -- THEN seed), matching the same reasoning as
                                             -- role.created_by in 20260718000000_platform_rbac.sql.
                                             -- On the real cloud target the Super Admin already
                                             -- exists by the time this migration applies, so the
                                             -- seed below still attributes correctly there.
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE component_type IS
  'Admin-managed component catalogue (spec §11). tracking_mode splits serialized parts (one component_unit row per physical unit) from batch/commodity parts (installation references type + batch_no, no unit row).';

CREATE TABLE component_unit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component_type_id uuid NOT NULL REFERENCES component_type(id),
  serial_no text NOT NULL,
  hw_rev text, bom_rev text, fw_ver text,
  firmware_release_id uuid,              -- deferred FK → firmware_release (Engineering, week 6)
  supplier text, manufacturer text, manufactured_on date,
  batch_no text, cost_sgd numeric(12,2), condition text,
  location_id uuid,                      -- deferred FK → stock_location (Logistics, week 8)
  disposition text NOT NULL DEFAULT 'in_stock'
    CHECK (disposition IN ('in_stock','installed','removed','quarantine','scrapped')),
  needs_split boolean NOT NULL DEFAULT false,
  serial_no_normalized text,             -- trigger-maintained, search
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);
COMMENT ON COLUMN component_unit.firmware_release_id IS
  'Deferred FK → firmware_release (Engineering module, not built yet). Plain nullable uuid; FK added when that table lands.';
COMMENT ON COLUMN component_unit.location_id IS
  'Deferred FK → stock_location (Logistics module, not built yet). Plain nullable uuid; FK added when that table lands.';
CREATE UNIQUE INDEX component_unit_sn ON component_unit(component_type_id, serial_no)
  WHERE deleted_at IS NULL;
CREATE INDEX component_unit_sn_trgm ON component_unit USING gin (serial_no_normalized gin_trgm_ops);
CREATE INDEX component_unit_type_idx ON component_unit(component_type_id) WHERE deleted_at IS NULL;

-- Mirrors device_sn_normalized: lowercase, strip spaces+hyphens (matches the
-- component search needle the read service builds).
CREATE OR REPLACE FUNCTION fn_component_unit_normalize()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.serial_no_normalized := lower(regexp_replace(coalesce(NEW.serial_no,''), '[\s-]', '', 'g'));
  RETURN NEW;
END $$;
CREATE TRIGGER trg_component_unit_normalize BEFORE INSERT OR UPDATE ON component_unit
  FOR EACH ROW EXECUTE FUNCTION fn_component_unit_normalize();

CREATE TABLE component_installation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES device(id),
  component_type_id uuid NOT NULL REFERENCES component_type(id),
  component_unit_id uuid REFERENCES component_unit(id),  -- NULL for batch parts
  batch_no text,                                          -- set for batch parts
  slot_no integer NOT NULL DEFAULT 1,
  installed_at timestamptz NOT NULL DEFAULT now(),
  installed_by uuid NOT NULL REFERENCES app_user(id),
  removed_at timestamptz,
  removed_by uuid REFERENCES app_user(id),
  removal_reason text,
  repair_id uuid,                        -- deferred FK → repair (Maintenance, week 7)
  modification_id uuid,                  -- deferred FK → modification (Maintenance, week 8)
  notes text,                            -- bilingual, verbatim
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id),
  CONSTRAINT removal_complete CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
  -- serialized parts carry a unit; batch parts carry a batch_no; never both-null
  CONSTRAINT unit_or_batch CHECK (component_unit_id IS NOT NULL OR batch_no IS NOT NULL)
);
COMMENT ON TABLE component_installation IS
  'APPEND-ONLY installation history (spec §11/§14). Current components = removed_at IS NULL. Never overwritten except the one-time removal stamp; guarded by fn_component_installation_guard.';
COMMENT ON COLUMN component_installation.repair_id IS
  'Deferred FK → repair (Maintenance module, not built yet). The §14 replacement primitive accepts it now so the Repair workflow can attribute a swap once that table exists.';
COMMENT ON COLUMN component_installation.modification_id IS
  'Deferred FK → modification (Maintenance module, not built yet). Plain nullable uuid; FK added when that table lands.';
CREATE UNIQUE INDEX one_open_install ON component_installation(device_id, component_type_id, slot_no)
  WHERE removed_at IS NULL;
CREATE INDEX ci_device_idx ON component_installation(device_id, installed_at DESC);
CREATE INDEX ci_unit_history ON component_installation(component_unit_id, installed_at DESC)
  WHERE component_unit_id IS NOT NULL;

-- Append-only guard: no DELETE; the only permitted UPDATE is the one-time
-- removal stamp (setting removed_at/removed_by/removal_reason/repair_id/
-- modification_id on a still-open row). Everything else — device, type, unit,
-- batch_no, slot, installed_at/by, and re-removing an already-removed row —
-- is rejected. batch_no is frozen alongside component_unit_id because for a
-- batch-tracked installation (component_unit_id IS NULL) batch_no IS the
-- "what was installed" fact — the same role component_unit_id plays for a
-- serialized part.
CREATE OR REPLACE FUNCTION fn_component_installation_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'component_installation is append-only — rows cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.device_id <> NEW.device_id OR OLD.component_type_id <> NEW.component_type_id
     OR OLD.component_unit_id IS DISTINCT FROM NEW.component_unit_id
     OR OLD.batch_no IS DISTINCT FROM NEW.batch_no
     OR OLD.slot_no <> NEW.slot_no OR OLD.installed_at <> NEW.installed_at
     OR OLD.installed_by <> NEW.installed_by OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'component_installation is append-only — identity and install facts are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'component_installation is append-only — an already-removed row is frozen'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_component_installation_guard BEFORE UPDATE OR DELETE ON component_installation
  FOR EACH ROW EXECUTE FUNCTION fn_component_installation_guard();

CREATE TABLE variant_bom_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES device_variant(id),
  component_type_id uuid NOT NULL REFERENCES component_type(id),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT bom_line_unique UNIQUE (variant_id, component_type_id)
);
COMMENT ON TABLE variant_bom_line IS
  'Flat per-variant bill of materials (spec §6.3 / D17): one line per component type per variant, with quantity. No nested sub-assemblies.';

-- Audit on the mutable tables (installation is audited too — its INSERT and the
-- one-time removal UPDATE are exactly the events worth trailing).
SELECT fn_attach_audit(t) FROM unnest(ARRAY[
  'component_type','component_unit','component_installation','variant_bom_line'
]) AS t;

-- RLS deny-via-REST (R1 pattern): app reaches these only via the owner pool /
-- service_role; no anon/authenticated policy = PostgREST denies all. NOT FORCE.
ALTER TABLE component_type          ENABLE ROW LEVEL SECURITY;
ALTER TABLE component_unit          ENABLE ROW LEVEL SECURITY;
ALTER TABLE component_installation  ENABLE ROW LEVEL SECURITY;
ALTER TABLE variant_bom_line        ENABLE ROW LEVEL SECURITY;

REVOKE EXECUTE ON FUNCTION fn_component_unit_normalize() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_component_installation_guard() FROM PUBLIC, anon, authenticated;

-- Seed the three component types DLMS already tracks (the PCBA-A/B + screen
-- columns on the legacy device row), all serialized. Data migration of legacy
-- values into component_unit/installation rows is a later task; this only
-- establishes the catalogue so new records can reference it.
INSERT INTO component_type (code, name, tracking_mode, requires_firmware, sort, created_by)
SELECT v.code, v.name, 'serialized', v.rf, v.sort,
       (SELECT id FROM app_user WHERE email='reetmitra8@gmail.com')
FROM (VALUES
  ('pcba_a',     'PCBA-A (Amplifier Board)',  true,  1),
  ('pcba_b',     'PCBA-B (Accessory Board)',  true,  2),
  ('hmi_screen', 'HMI Screen',                false, 3)
) AS v(code, name, rf, sort);
