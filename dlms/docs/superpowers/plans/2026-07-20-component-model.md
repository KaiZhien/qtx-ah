# Component Model Subsystem — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every device a normalized, append-only record of which components it contains and has ever contained — a catalogue of component types, serialized units, an installation-history table that is never overwritten, a per-variant BOM, and the single transactional primitive that swaps one component for another atomically — surfaced on the device-profile Components tab and an admin catalogue screen.

**Architecture:** Five new tables (`component_type`, `component_unit`, `component_installation`, `variant_bom_line`) plus the device Components tab and an admin catalogue. Current components = installations with `removed_at IS NULL`; a replacement closes the old installation and opens a new one **in one `withTransaction`**, so a device can never show a swap its history lacks. This is the §14 core primitive that the future Repair and Modification workflows (Maintenance module) will call — it takes optional `repair_id`/`modification_id` references now, before those tables exist. All reads/writes go through the owner-pool + `authorize()`; new tables get RLS deny-via-REST per the R1 pattern.

**Tech Stack:** Postgres 15 (Supabase) · node-postgres via `withTransaction` · Next.js 14 App Router · Vitest · Radix + Tailwind. Same stack as the demo-scope tasks.

## Global Constraints

Copied from the established codebase conventions; every task's requirements implicitly include these.

- **Working dir:** npm/docker from `dlms/`; git from repo root `/Users/reetmitra/Desktop/QTX/quantumtx-ah`.
- **Commit attribution:** authored solely by Reet Mitra. **Never** a `Co-Authored-By:` or any co-author trailer.
- **Branch per task**, merge to `main` when its review passes, delete the branch. No PRs.
- **TDD:** failing test → confirm fail → minimal implementation → confirm pass → commit.
- **Tests:** `npm test` (unit), `npm run test:integration` (dockerized Postgres 15, port 55432), `npm run type-check`, `npm run build`.
- **Every new table:** `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `created_at/created_by/updated_at/updated_by`, `deleted_at` soft-delete, `version int NOT NULL DEFAULT 1` — **except append-only history tables** (`component_installation`), which omit `updated_*`/`deleted_at`/`version` and are guarded against UPDATE/DELETE by a trigger.
- **RLS (R1 pattern):** every new table `ENABLE ROW LEVEL SECURITY` with **no anon/authenticated policies** (deny-via-REST). The app reaches these tables only through `withTransaction` (owner, bypasses RLS) and `createAdminClient()` (service_role, BYPASSRLS). **Never** `FORCE ROW LEVEL SECURITY`. Attach `fn_attach_audit` to every mutable table.
- **Deferred FKs:** `component_unit.firmware_release_id` / `.location_id` and `component_installation.repair_id` / `.modification_id` reference tables that don't exist yet (Engineering/Logistics/Maintenance). Declare them as **plain nullable `uuid` columns with NO FK constraint** now (the Task-13 `device.buyer_id` pattern); the FK is added when the target table lands. A COMMENT records this.
- **Migration filenames** carry the `platform_` token (`20260720NNNNNN_platform_*.sql`) so the integration harness provenance filter `/^\d{14}_platform_.*\.sql$/` applies them. Committing a migration does **not** apply it to cloud — the controller applies it post-review.
- **Writes** go through `withTransaction(actorId, fn)` (sets `app.actor_id` for `fn_audit`); optimistic-lock via `version` → `OptimisticLockError`; `authorize(actor, permission, module)` first in every service function.
- **Bilingual free text** (component notes, names) preserved verbatim, never truncated.
- **Repo style:** TS no semicolons, single quotes, 2-space indent. SQL: `-- ===` header explaining *why*; pinned `search_path` on SECURITY DEFINER/trigger functions; `COMMENT ON` for non-obvious columns. Comments state constraints, not narration.
- **Module:** components live under the **Manufacturing** module (`manufacturing` module key); permissions reuse the existing 24 (`view_records`, `create_records`, `edit_records`, `manage_vocabularies` for the catalogue).

---

## File Structure

| Path | Responsibility |
|---|---|
| `supabase/migrations/20260720000001_platform_components.sql` | The 5-table schema, indexes, append-only trigger, RLS, audit, seed of the 3 existing component types |
| `modules/manufacturing/domain/componentInstallation.ts` | **Pure** logic: current-vs-historical partition, replacement precondition checks, tracking-mode rules |
| `modules/manufacturing/services/componentCatalogueService.ts` | Component-type catalogue: list, create, update (admin, `manage_vocabularies`) |
| `modules/manufacturing/services/componentService.ts` | Reads: current components + full history for a device; unit lookup. Write: `replaceComponentInstallation` (the §14 primitive) + `installComponent` (initial fit) |
| `app/(platform)/manufacturing/components/page.tsx` | Admin catalogue screen (component types) |
| `app/(platform)/manufacturing/components/actions.ts` | Server actions for catalogue create/update |
| `components/manufacturing/ComponentCatalogue.tsx` | Catalogue table + create/edit form |
| `components/manufacturing/DeviceComponentsTab.tsx` | Current components + history timeline + "Replace" dialog, rendered on the device profile |
| `app/(platform)/manufacturing/devices/[id]/page.tsx` | **Modify**: wire the real Components tab (Task 13 left it a stub) |
| `__tests__/integration/componentSchema.test.ts` | Schema constraints (append-only, one-open-install, unique SN) |
| `__tests__/platform/manufacturing/componentInstallation.test.ts` | Pure-domain unit tests |
| `__tests__/integration/componentCatalogueService.test.ts` | Catalogue service |
| `__tests__/integration/componentService.test.ts` | Reads + the replacement transaction (incl. rollback) |
| `__tests__/platform/manufacturing/componentActions.test.ts` | Server-action error mapping |

## Task sequence

```
Task 1 (schema) ─┬─ Task 2 (pure domain) ─┐
                 ├─ Task 3 (catalogue service+UI) │
                 └─ Task 4 (component service: reads + replacement txn) ─ Task 5 (device Components tab UI)
```

Task 1 is the foundation. Tasks 2–4 depend on it; Task 5 depends on 2+4. Task 3 is independent of 4/5.

---

### Task 1: Component schema (catalogue, units, append-only installations, BOM)

**Files:**
- Create: `supabase/migrations/20260720000001_platform_components.sql`
- Test: `__tests__/integration/componentSchema.test.ts`

**Interfaces:**
- Consumes: `device`, `device_variant`, `app_user`, `fn_attach_audit`, `pg_trgm` (all from earlier migrations).
- Produces: tables `component_type`, `component_unit`, `component_installation`, `variant_bom_line`. Key columns other tasks rely on:
  - `component_type(id, code, name, tracking_mode, requires_firmware, active, sort, …audit)`.
  - `component_unit(id, component_type_id, serial_no, hw_rev, bom_rev, fw_ver, firmware_release_id, supplier, manufacturer, manufactured_on, batch_no, cost_sgd, condition, location_id, disposition, needs_split, …audit, deleted_at, version)`.
  - `component_installation(id, device_id, component_type_id, component_unit_id, batch_no, slot_no, installed_at, installed_by, removed_at, removed_by, removal_reason, repair_id, modification_id, notes, created_at, created_by)`.
  - `variant_bom_line(id, variant_id, component_type_id, quantity, notes, …audit)`.
  - Partial unique index `one_open_install` on `(device_id, component_type_id, slot_no) WHERE removed_at IS NULL`.

- [ ] **Step 1: Write the failing schema test**

```typescript
// __tests__/integration/componentSchema.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'

let db: Client
let userId: string
let deviceId: string
let pcbaTypeId: string

beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id
  deviceId = (await db.query(`
    INSERT INTO device (variant_id, status, created_by, updated_by)
    VALUES ((SELECT id FROM device_variant WHERE code='pro'), 'in_stock', $1, $1) RETURNING id`,
    [userId])).rows[0].id
  pcbaTypeId = (await db.query(`SELECT id FROM component_type WHERE code='pcba_a'`)).rows[0].id
})
afterAll(async () => { await db.end() })

const install = async (over: Record<string, unknown> = {}) => {
  const cols = { device_id: deviceId, component_type_id: pcbaTypeId, slot_no: 1,
    installed_by: userId, created_by: userId, ...over }
  const keys = Object.keys(cols)
  const { rows } = await db.query(
    `INSERT INTO component_installation (${keys.join(',')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(cols))
  return rows[0].id
}

describe('component schema', () => {
  it('seeds the three existing component types with tracking_mode', async () => {
    const { rows } = await db.query(
      `SELECT code, tracking_mode FROM component_type ORDER BY sort`)
    expect(rows.map((r) => r.code)).toEqual(['pcba_a', 'pcba_b', 'hmi_screen'])
    expect(rows.every((r) => r.tracking_mode === 'serialized')).toBe(true)
  })

  it('rejects an unknown tracking_mode', async () => {
    await expect(db.query(
      `INSERT INTO component_type (code, name, tracking_mode) VALUES ('x','X','magic')`))
      .rejects.toThrow()
  })

  it('allows at most one OPEN installation per device+type+slot', async () => {
    const id = await install({ slot_no: 2 })
    await expect(install({ slot_no: 2 })).rejects.toThrow(/one_open_install/)
    // closing the first frees the slot
    await db.query(`UPDATE component_installation SET removed_at=now(), removed_by=$1 WHERE id=$2`,
      [userId, id])
    await expect(install({ slot_no: 2 })).resolves.toBeTruthy()
  })

  it('enforces removal completeness (removed_at ⇔ removed_by)', async () => {
    const id = await install({ slot_no: 3 })
    await expect(db.query(
      `UPDATE component_installation SET removed_at=now() WHERE id=$1`, [id]))
      .rejects.toThrow(/removal_complete/)
  })

  it('is append-only: a committed installation row cannot be deleted', async () => {
    const id = await install({ slot_no: 4 })
    await expect(db.query(`DELETE FROM component_installation WHERE id=$1`, [id]))
      .rejects.toThrow(/append-only/)
  })

  it('is append-only: cannot rewrite device/type/installed_at after the fact', async () => {
    const id = await install({ slot_no: 5 })
    await expect(db.query(
      `UPDATE component_installation SET installed_at=now() - interval '1 year' WHERE id=$1`, [id]))
      .rejects.toThrow(/append-only|immutable/)
  })

  it('unique serial per type among live units', async () => {
    await db.query(`INSERT INTO component_unit (component_type_id, serial_no, created_by, updated_by)
      VALUES ($1,'SN-1',$2,$2)`, [pcbaTypeId, userId])
    await expect(db.query(`INSERT INTO component_unit (component_type_id, serial_no, created_by, updated_by)
      VALUES ($1,'SN-1',$2,$2)`, [pcbaTypeId, userId])).rejects.toThrow()
  })

  it('preserves bilingual component notes verbatim', async () => {
    const id = await install({ slot_no: 6, notes: '电源板初装 — first fit' })
    const { rows } = await db.query(`SELECT notes FROM component_installation WHERE id=$1`, [id])
    expect(rows[0].notes).toBe('电源板初装 — first fit')
  })

  it('has RLS enabled on all four component tables', async () => {
    const { rows } = await db.query(
      `SELECT relname FROM pg_class WHERE relname = ANY($1) AND relkind='r' AND relrowsecurity`,
      [['component_type', 'component_unit', 'component_installation', 'variant_bom_line']])
    expect(rows.map((r) => r.relname).sort()).toEqual(
      ['component_installation', 'component_type', 'component_unit', 'variant_bom_line'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — `relation "component_type" does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20260720000001_platform_components.sql
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
  created_by uuid NOT NULL REFERENCES app_user(id),
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
CREATE UNIQUE INDEX one_open_install ON component_installation(device_id, component_type_id, slot_no)
  WHERE removed_at IS NULL;
CREATE INDEX ci_device_idx ON component_installation(device_id, installed_at DESC);
CREATE INDEX ci_unit_history ON component_installation(component_unit_id, installed_at DESC)
  WHERE component_unit_id IS NOT NULL;

-- Append-only guard: no DELETE; the only permitted UPDATE is the one-time
-- removal stamp (setting removed_at/removed_by/removal_reason/repair_id/
-- modification_id on a still-open row). Everything else — device, type, unit,
-- slot, installed_at/by, and re-removing an already-removed row — is rejected.
CREATE OR REPLACE FUNCTION fn_component_installation_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'component_installation is append-only — rows cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.device_id <> NEW.device_id OR OLD.component_type_id <> NEW.component_type_id
     OR OLD.component_unit_id IS DISTINCT FROM NEW.component_unit_id
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:integration`
Expected: PASS (the 9 schema tests) alongside the existing 130.

- [ ] **Step 5: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/supabase/migrations/20260720000001_platform_components.sql \
        dlms/__tests__/integration/componentSchema.test.ts
git commit -m "feat(manufacturing): component model schema — catalogue, units, append-only installations, BOM

Five-table normalized component model. Installation history is append-only
(guarded trigger: no delete, only the one-time removal stamp). RLS deny-via-REST.
Seeds the three component types DLMS already tracks."
```

---

### Task 2: Pure installation domain (current-vs-history, replacement preconditions)

**Files:**
- Create: `modules/manufacturing/domain/componentInstallation.ts`
- Test: `__tests__/platform/manufacturing/componentInstallation.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `type InstallationRow = { id: string; componentTypeId: string; componentUnitId: string | null; batchNo: string | null; slotNo: number; installedAt: Date; removedAt: Date | null }`.
  - `currentInstallations(rows: InstallationRow[]): InstallationRow[]` — the open ones.
  - `historyForSlot(rows: InstallationRow[], componentTypeId: string, slotNo: number): InstallationRow[]` — that slot's rows, newest first.
  - `type ReplacementCheck = { trackingMode: 'serialized' | 'batch'; removingUnitId: string | null; replacementUnitId: string | null; replacementBatchNo: string | null }`.
  - `assertReplacementShape(c: ReplacementCheck): void` — throws `InvalidReplacementError` when the replacement doesn't match the type's tracking mode (serialized needs a unit, batch needs a batch_no; a serialized replacement can't reuse the unit being removed).

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/platform/manufacturing/componentInstallation.test.ts
import { describe, it, expect } from 'vitest'
import {
  currentInstallations, historyForSlot, assertReplacementShape, InvalidReplacementError,
} from '@/modules/manufacturing/domain/componentInstallation'

const row = (over = {}) => ({
  id: 'i1', componentTypeId: 't1', componentUnitId: 'u1', batchNo: null,
  slotNo: 1, installedAt: new Date('2026-01-01'), removedAt: null, ...over,
})

describe('currentInstallations', () => {
  it('returns only rows with no removal date', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', removedAt: new Date('2026-02-01') })]
    expect(currentInstallations(rows).map((r) => r.id)).toEqual(['a'])
  })
  it('is empty when everything has been removed', () => {
    expect(currentInstallations([row({ removedAt: new Date() })])).toEqual([])
  })
})

describe('historyForSlot', () => {
  it('returns that type+slot newest-first', () => {
    const rows = [
      row({ id: 'old', installedAt: new Date('2026-01-01'), removedAt: new Date('2026-03-01') }),
      row({ id: 'new', installedAt: new Date('2026-03-01') }),
      row({ id: 'other', componentTypeId: 't2' }),
    ]
    expect(historyForSlot(rows, 't1', 1).map((r) => r.id)).toEqual(['new', 'old'])
  })
})

describe('assertReplacementShape', () => {
  it('accepts a serialized swap to a different unit', () => {
    expect(() => assertReplacementShape({
      trackingMode: 'serialized', removingUnitId: 'u1', replacementUnitId: 'u2',
      replacementBatchNo: null,
    })).not.toThrow()
  })
  it('rejects a serialized replacement with no unit', () => {
    expect(() => assertReplacementShape({
      trackingMode: 'serialized', removingUnitId: 'u1', replacementUnitId: null,
      replacementBatchNo: null,
    })).toThrow(InvalidReplacementError)
  })
  it('rejects reusing the very unit being removed', () => {
    expect(() => assertReplacementShape({
      trackingMode: 'serialized', removingUnitId: 'u1', replacementUnitId: 'u1',
      replacementBatchNo: null,
    })).toThrow(InvalidReplacementError)
  })
  it('accepts a batch replacement with a batch number', () => {
    expect(() => assertReplacementShape({
      trackingMode: 'batch', removingUnitId: null, replacementUnitId: null,
      replacementBatchNo: 'LOT-9',
    })).not.toThrow()
  })
  it('rejects a batch replacement with no batch number', () => {
    expect(() => assertReplacementShape({
      trackingMode: 'batch', removingUnitId: null, replacementUnitId: null,
      replacementBatchNo: null,
    })).toThrow(InvalidReplacementError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/platform/manufacturing/componentInstallation.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement the domain**

```typescript
// modules/manufacturing/domain/componentInstallation.ts
/**
 * Pure component-installation logic. Current components are simply the
 * installations that were never removed; a slot's history is every installation
 * that ever occupied that (type, slot) on the device, newest first. The
 * replacement-shape rule enforces the tracking-mode contract before any DB work,
 * so the transactional primitive (componentService) can trust its inputs.
 */
export type InstallationRow = {
  id: string
  componentTypeId: string
  componentUnitId: string | null
  batchNo: string | null
  slotNo: number
  installedAt: Date
  removedAt: Date | null
}

export class InvalidReplacementError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidReplacementError'
  }
}

export function currentInstallations(rows: InstallationRow[]): InstallationRow[] {
  return rows.filter((r) => r.removedAt === null)
}

export function historyForSlot(
  rows: InstallationRow[], componentTypeId: string, slotNo: number,
): InstallationRow[] {
  return rows
    .filter((r) => r.componentTypeId === componentTypeId && r.slotNo === slotNo)
    .sort((a, b) => b.installedAt.getTime() - a.installedAt.getTime())
}

export type ReplacementCheck = {
  trackingMode: 'serialized' | 'batch'
  removingUnitId: string | null
  replacementUnitId: string | null
  replacementBatchNo: string | null
}

/**
 * A serialized type is replaced by another unit (never the one being removed);
 * a batch type is replaced by a batch number. Throwing here keeps the impossible
 * states out of the transaction rather than relying on DB constraints alone.
 */
export function assertReplacementShape(c: ReplacementCheck): void {
  if (c.trackingMode === 'serialized') {
    if (!c.replacementUnitId) {
      throw new InvalidReplacementError('A serialized component must be replaced by a specific unit')
    }
    if (c.replacementUnitId === c.removingUnitId) {
      throw new InvalidReplacementError('The replacement cannot be the same unit being removed')
    }
    return
  }
  if (!c.replacementBatchNo) {
    throw new InvalidReplacementError('A batch component must be replaced by a batch number')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/platform/manufacturing/componentInstallation.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/modules/manufacturing/domain/componentInstallation.ts \
        dlms/__tests__/platform/manufacturing/componentInstallation.test.ts
git commit -m "feat(manufacturing): pure component-installation domain

Current-vs-history partition and the replacement-shape rule (serialized needs a
new unit, batch needs a batch number), so the transaction layer trusts its inputs."
```

---

### Task 3: Component catalogue service + admin UI

**Files:**
- Create: `modules/manufacturing/services/componentCatalogueService.ts`, `app/(platform)/manufacturing/components/page.tsx`, `app/(platform)/manufacturing/components/actions.ts`, `components/manufacturing/ComponentCatalogue.tsx`
- Test: `__tests__/integration/componentCatalogueService.test.ts`

**Interfaces:**
- Consumes: `authorize` (`manage_vocabularies` for writes, `view_records` for reads, module `manufacturing`), `withTransaction`, `OptimisticLockError`, `PermissionError`.
- Produces:
  - `listComponentTypes(actor, opts?: { includeInactive?: boolean }): Promise<ComponentTypeRow[]>` where `ComponentTypeRow = { id: string; code: string; name: string; trackingMode: 'serialized'|'batch'; requiresFirmware: boolean; active: boolean; sort: number; version: number }`.
  - `createComponentType(actor, input: { code: string; name: string; trackingMode: 'serialized'|'batch'; requiresFirmware?: boolean }): Promise<{ id: string }>`.
  - `updateComponentType(actor, id: string, input: { name?: string; requiresFirmware?: boolean; active?: boolean; sort?: number }, version: number): Promise<void>` — **tracking_mode is immutable after creation** (changing it would invalidate existing installations); the service ignores/rejects any attempt.

- [ ] **Step 1: Write the failing service test**

```typescript
// __tests__/integration/componentCatalogueService.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  listComponentTypes, createComponentType, updateComponentType,
} from '@/modules/manufacturing/services/componentCatalogueService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let adminId: string
const admin = (): Actor => ({
  id: adminId, roleKey: 'super_admin',
  permissions: new Set(['manage_vocabularies', 'view_records']),
  moduleAccess: new Set(['manufacturing']), active: true,
})
const operator = (): Actor => ({
  id: adminId, roleKey: 'operator',
  permissions: new Set(['view_records']), moduleAccess: new Set(['manufacturing']), active: true,
})

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  adminId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
})
afterAll(async () => { await db.end(); await getPool().end() })

describe('componentCatalogueService', () => {
  it('lists active types by default, incl. the three seeded', async () => {
    const types = await listComponentTypes(admin())
    expect(types.map((t) => t.code)).toEqual(expect.arrayContaining(['pcba_a', 'pcba_b', 'hmi_screen']))
    expect(types.every((t) => t.active)).toBe(true)
  })

  it('refuses creation without manage_vocabularies', async () => {
    await expect(createComponentType(operator(), {
      code: 'sensor', name: 'Sensor', trackingMode: 'batch',
    })).rejects.toThrow(PermissionError)
  })

  it('creates a batch type and audits it', async () => {
    const { id } = await createComponentType(admin(), {
      code: 'cable', name: 'Cable', trackingMode: 'batch',
    })
    const { rows } = await db.query(`SELECT tracking_mode FROM component_type WHERE id=$1`, [id])
    expect(rows[0].tracking_mode).toBe('batch')
    const audit = await db.query(
      `SELECT actor_id FROM audit_log WHERE table_name='component_type' AND row_id=$1
        ORDER BY occurred_at DESC LIMIT 1`, [id])
    expect(audit.rows[0].actor_id).toBe(adminId)
  })

  it('rejects a duplicate code', async () => {
    await expect(createComponentType(admin(), {
      code: 'pcba_a', name: 'Dup', trackingMode: 'serialized',
    })).rejects.toThrow()
  })

  it('updates name/active but NEVER tracking_mode', async () => {
    const { id } = await createComponentType(admin(), {
      code: 'enclosure', name: 'Enclosure', trackingMode: 'batch',
    })
    const v = (await db.query(`SELECT version FROM component_type WHERE id=$1`, [id])).rows[0].version
    await updateComponentType(admin(), id, { name: 'Enclosure v2', active: false }, v)
    const { rows } = await db.query(
      `SELECT name, active, tracking_mode FROM component_type WHERE id=$1`, [id])
    expect(rows[0]).toMatchObject({ name: 'Enclosure v2', active: false, tracking_mode: 'batch' })
  })

  it('rejects a stale version', async () => {
    const { id } = await createComponentType(admin(), {
      code: 'gasket', name: 'Gasket', trackingMode: 'batch',
    })
    await expect(updateComponentType(admin(), id, { name: 'X' }, 999))
      .rejects.toThrow(/modified by someone else/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — cannot resolve `componentCatalogueService`.

- [ ] **Step 3: Implement the service**

```typescript
// modules/manufacturing/services/componentCatalogueService.ts
import { z } from 'zod'
import { withTransaction, OptimisticLockError } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

export type ComponentTypeRow = {
  id: string; code: string; name: string
  trackingMode: 'serialized' | 'batch'; requiresFirmware: boolean
  active: boolean; sort: number; version: number
}

export async function listComponentTypes(
  actor: Actor, opts: { includeInactive?: boolean } = {},
): Promise<ComponentTypeRow[]> {
  authorize(actor, 'view_records', 'manufacturing')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; code: string; name: string; tracking_mode: 'serialized' | 'batch'
      requires_firmware: boolean; active: boolean; sort: number; version: number
    }>(
      `SELECT id, code, name, tracking_mode, requires_firmware, active, sort, version
         FROM component_type
        WHERE deleted_at IS NULL ${opts.includeInactive ? '' : 'AND active'}
        ORDER BY sort, name`)
    return rows.map((r) => ({
      id: r.id, code: r.code, name: r.name, trackingMode: r.tracking_mode,
      requiresFirmware: r.requires_firmware, active: r.active, sort: r.sort, version: r.version,
    }))
  })
}

const createSchema = z.object({
  code: z.string().min(1).max(50).regex(/^[a-z0-9_]+$/, 'lowercase letters, digits, underscore only'),
  name: z.string().min(1).max(200),
  trackingMode: z.enum(['serialized', 'batch']),
  requiresFirmware: z.boolean().default(false),
})

export async function createComponentType(
  actor: Actor, input: z.input<typeof createSchema>,
): Promise<{ id: string }> {
  authorize(actor, 'manage_vocabularies', 'manufacturing')
  const data = createSchema.parse(input)
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO component_type (code, name, tracking_mode, requires_firmware, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
      [data.code, data.name, data.trackingMode, data.requiresFirmware, actor.id])
    return { id: rows[0].id }
  })
}

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  requiresFirmware: z.boolean().optional(),
  active: z.boolean().optional(),
  sort: z.number().int().optional(),
})

/**
 * tracking_mode is deliberately NOT updatable: existing component_installation
 * rows were shaped by it (serialized → unit, batch → batch_no), so flipping it
 * would retroactively invalidate history. A type that was created wrong is
 * deactivated and replaced, not mutated.
 */
export async function updateComponentType(
  actor: Actor, id: string, input: z.input<typeof updateSchema>, version: number,
): Promise<void> {
  authorize(actor, 'manage_vocabularies', 'manufacturing')
  const data = updateSchema.parse(input)
  await withTransaction(actor.id, async (tx) => {
    const cur = await tx.query<{ version: number }>(
      `SELECT version FROM component_type WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [id])
    if (cur.rows.length === 0) throw new Error(`Component type ${id} not found`)
    if (cur.rows[0].version !== version) throw new OptimisticLockError('component_type', id)
    await tx.query(
      `UPDATE component_type SET
         name = COALESCE($1, name),
         requires_firmware = COALESCE($2, requires_firmware),
         active = COALESCE($3, active),
         sort = COALESCE($4, sort),
         updated_at = now(), updated_by = $5, version = version + 1
       WHERE id = $6`,
      [data.name ?? null, data.requiresFirmware ?? null, data.active ?? null,
       data.sort ?? null, actor.id, id])
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:integration`
Expected: PASS (6 tests).

- [ ] **Step 5: Build the catalogue UI**

`app/(platform)/manufacturing/components/page.tsx` — `requireActor()`, `if (!can(actor,'view_records','manufacturing')) notFound()`, render `<ComponentCatalogue types={await listComponentTypes(actor,{includeInactive:true})} canManage={can(actor,'manage_vocabularies','manufacturing')} />`. `actions.ts` — `createTypeAction`/`updateTypeAction` returning `{ ok } | { ok:false; error }` with the standard error mapping (`PermissionError`→"You don't have permission…", `OptimisticLockError`→"Someone else changed this…", other→generic + server log); `revalidatePath('/manufacturing/components')`. `ComponentCatalogue.tsx` — table (code, name, tracking mode badge, firmware flag, active) + an "Add type" dialog and inline edit, all disabled unless `canManage`. Tracking-mode field is shown but **read-only on edit** (only selectable at create).

- [ ] **Step 6: Verify build + full suite**

Run: `npm test && npm run type-check && npm run build`
Expected: PASS; `/manufacturing/components` resolves.

- [ ] **Step 7: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/modules/manufacturing/services/componentCatalogueService.ts \
        "dlms/app/(platform)/manufacturing/components" dlms/components/manufacturing/ComponentCatalogue.tsx \
        dlms/__tests__/integration/componentCatalogueService.test.ts
git commit -m "feat(manufacturing): component-type catalogue service + admin screen

Admin-managed catalogue (manage_vocabularies). tracking_mode is immutable after
creation; optimistic-locked updates; standard error mapping."
```

---

### Task 4: Component service — device reads + the §14 replacement transaction

**Files:**
- Create: `modules/manufacturing/services/componentService.ts`
- Test: `__tests__/integration/componentService.test.ts`

**Interfaces:**
- Consumes: `authorize` (`view_records` reads; `edit_records` + `manufacturing` for install/replace), `withTransaction`, `OptimisticLockError`; `assertReplacementShape`, `currentInstallations`, `historyForSlot`, `InvalidReplacementError` (Task 2).
- Produces:
  - `getDeviceComponents(actor, deviceId): Promise<{ current: CurrentComponent[]; history: InstallationHistoryItem[] }>` where `CurrentComponent = { installationId: string; componentTypeCode: string; componentTypeName: string; slotNo: number; unit: { id: string; serialNo: string } | null; batchNo: string | null; installedAt: Date; installedByName: string }` and `InstallationHistoryItem` adds `removedAt: Date | null; removedByName: string | null; removalReason: string | null`.
  - `installComponent(actor, input: { deviceId; componentTypeId; slotNo?; unitId?; batchNo?; notes? }): Promise<{ installationId: string }>` — initial fit into an empty slot.
  - `replaceComponentInstallation(actor, input: ReplaceInput): Promise<{ closedId: string; newId: string; current: CurrentComponent[] }>` where `ReplaceInput = { removedInstallationId: string; reason: string; replacementUnitId?: string; replacementBatchNo?: string; repairId?: string; modificationId?: string; notes?: string }` — **the §14 primitive**: closes the open installation, opens the new one, flips the units' disposition, bumps `device.version`, all in ONE transaction.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/integration/componentService.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  getDeviceComponents, installComponent, replaceComponentInstallation,
} from '@/modules/manufacturing/services/componentService'
import { InvalidReplacementError } from '@/modules/manufacturing/domain/componentInstallation'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string, deviceId: string, pcbaTypeId: string, unitA: string, unitB: string

const op = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'edit_records']),
  moduleAccess: new Set(['manufacturing']), active: true,
})
const viewer = (): Actor => ({
  id: userId, roleKey: 'viewer',
  permissions: new Set(['view_records']), moduleAccess: new Set(['manufacturing']), active: true,
})

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
  deviceId = (await db.query(`
    INSERT INTO device (variant_id, status, created_by, updated_by)
    VALUES ((SELECT id FROM device_variant WHERE code='pro'),'in_stock',$1,$1) RETURNING id`,
    [userId])).rows[0].id
  pcbaTypeId = (await db.query(`SELECT id FROM component_type WHERE code='pcba_a'`)).rows[0].id
  unitA = (await db.query(`INSERT INTO component_unit (component_type_id, serial_no, created_by, updated_by)
    VALUES ($1,'PCBA-A-001',$2,$2) RETURNING id`, [pcbaTypeId, userId])).rows[0].id
  unitB = (await db.query(`INSERT INTO component_unit (component_type_id, serial_no, created_by, updated_by)
    VALUES ($1,'PCBA-A-002',$2,$2) RETURNING id`, [pcbaTypeId, userId])).rows[0].id
})
afterAll(async () => { await db.end(); await getPool().end() })

describe('installComponent + getDeviceComponents', () => {
  it('refuses a viewer', async () => {
    await expect(installComponent(viewer(), { deviceId, componentTypeId: pcbaTypeId, unitId: unitA }))
      .rejects.toThrow(PermissionError)
  })
  it('installs a serialized unit and shows it as current', async () => {
    await installComponent(op(), { deviceId, componentTypeId: pcbaTypeId, unitId: unitA })
    const { current } = await getDeviceComponents(op(), deviceId)
    const pcba = current.find((c) => c.componentTypeCode === 'pcba_a')
    expect(pcba?.unit?.serialNo).toBe('PCBA-A-001')
    // installing sets the unit disposition to 'installed'
    const { rows } = await db.query(`SELECT disposition FROM component_unit WHERE id=$1`, [unitA])
    expect(rows[0].disposition).toBe('installed')
  })
})

describe('replaceComponentInstallation (the §14 primitive)', () => {
  it('closes the old install, opens the new, flips both units, bumps device.version — atomically', async () => {
    const before = (await db.query(`SELECT version FROM device WHERE id=$1`, [deviceId])).rows[0].version
    const open = (await db.query(
      `SELECT id FROM component_installation WHERE device_id=$1 AND component_type_id=$2
        AND removed_at IS NULL`, [deviceId, pcbaTypeId])).rows[0].id

    const res = await replaceComponentInstallation(op(), {
      removedInstallationId: open, reason: 'PCBA-A no power output', replacementUnitId: unitB,
    })

    // old closed, new open
    const closed = await db.query(`SELECT removed_at, removed_by, removal_reason
      FROM component_installation WHERE id=$1`, [res.closedId])
    expect(closed.rows[0].removed_at).not.toBeNull()
    expect(closed.rows[0].removal_reason).toBe('PCBA-A no power output')
    const now = await db.query(`SELECT component_unit_id, removed_at
      FROM component_installation WHERE id=$1`, [res.newId])
    expect(now.rows[0].component_unit_id).toBe(unitB)
    expect(now.rows[0].removed_at).toBeNull()

    // unit dispositions flipped: old removed, new installed
    const uA = await db.query(`SELECT disposition FROM component_unit WHERE id=$1`, [unitA])
    const uB = await db.query(`SELECT disposition FROM component_unit WHERE id=$1`, [unitB])
    expect(uA.rows[0].disposition).toBe('removed')
    expect(uB.rows[0].disposition).toBe('installed')

    // device.version bumped
    const after = (await db.query(`SELECT version FROM device WHERE id=$1`, [deviceId])).rows[0].version
    expect(after).toBe(before + 1)

    // exactly one open installation for this slot
    const openCount = await db.query(`SELECT count(*)::int n FROM component_installation
      WHERE device_id=$1 AND component_type_id=$2 AND removed_at IS NULL`, [deviceId, pcbaTypeId])
    expect(openCount.rows[0].n).toBe(1)
  })

  it('rolls back everything if the replacement unit does not exist', async () => {
    const open = (await db.query(
      `SELECT id FROM component_installation WHERE device_id=$1 AND component_type_id=$2
        AND removed_at IS NULL`, [deviceId, pcbaTypeId])).rows[0].id
    const beforeVer = (await db.query(`SELECT version FROM device WHERE id=$1`, [deviceId])).rows[0].version

    await expect(replaceComponentInstallation(op(), {
      removedInstallationId: open, reason: 'x', replacementUnitId: crypto.randomUUID(),
    })).rejects.toThrow()

    // the open installation is STILL open (nothing was closed), device.version unchanged
    const stillOpen = await db.query(`SELECT removed_at FROM component_installation WHERE id=$1`, [open])
    expect(stillOpen.rows[0].removed_at).toBeNull()
    const afterVer = (await db.query(`SELECT version FROM device WHERE id=$1`, [deviceId])).rows[0].version
    expect(afterVer).toBe(beforeVer)
  })

  it('rejects a serialized replacement reusing the removed unit', async () => {
    const open = (await db.query(
      `SELECT id, component_unit_id FROM component_installation WHERE device_id=$1
        AND component_type_id=$2 AND removed_at IS NULL`, [deviceId, pcbaTypeId])).rows[0]
    await expect(replaceComponentInstallation(op(), {
      removedInstallationId: open.id, reason: 'x', replacementUnitId: open.component_unit_id,
    })).rejects.toThrow(InvalidReplacementError)
  })

  it('the full history remains after a replacement (append-only)', async () => {
    const { history } = await getDeviceComponents(op(), deviceId)
    const pcbaHistory = history.filter((h) => h.componentTypeCode === 'pcba_a')
    expect(pcbaHistory.length).toBeGreaterThanOrEqual(2)   // original + replacement
    expect(pcbaHistory.some((h) => h.unit?.serialNo === 'PCBA-A-001')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — cannot resolve `componentService`.

- [ ] **Step 3: Implement the service** (reads + the transaction)

```typescript
// modules/manufacturing/services/componentService.ts
import { z } from 'zod'
import { withTransaction, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import { assertReplacementShape } from '@/modules/manufacturing/domain/componentInstallation'

export type CurrentComponent = {
  installationId: string; componentTypeCode: string; componentTypeName: string
  slotNo: number; unit: { id: string; serialNo: string } | null; batchNo: string | null
  installedAt: Date; installedByName: string
}
export type InstallationHistoryItem = CurrentComponent & {
  removedAt: Date | null; removedByName: string | null; removalReason: string | null
}

const SELECT_COLS = `
  ci.id, ct.code AS type_code, ct.name AS type_name, ci.slot_no,
  ci.component_unit_id, cu.serial_no, ci.batch_no,
  ci.installed_at, iu.full_name AS installed_by_name,
  ci.removed_at, ru.full_name AS removed_by_name, ci.removal_reason`

const FROM_JOINS = `
  FROM component_installation ci
  JOIN component_type ct ON ct.id = ci.component_type_id
  LEFT JOIN component_unit cu ON cu.id = ci.component_unit_id
  JOIN app_user iu ON iu.id = ci.installed_by
  LEFT JOIN app_user ru ON ru.id = ci.removed_by`

type Raw = {
  id: string; type_code: string; type_name: string; slot_no: number
  component_unit_id: string | null; serial_no: string | null; batch_no: string | null
  installed_at: Date; installed_by_name: string
  removed_at: Date | null; removed_by_name: string | null; removal_reason: string | null
}
const toItem = (r: Raw): InstallationHistoryItem => ({
  installationId: r.id, componentTypeCode: r.type_code, componentTypeName: r.type_name,
  slotNo: r.slot_no, unit: r.component_unit_id ? { id: r.component_unit_id, serialNo: r.serial_no! } : null,
  batchNo: r.batch_no, installedAt: r.installed_at, installedByName: r.installed_by_name,
  removedAt: r.removed_at, removedByName: r.removed_by_name, removalReason: r.removal_reason,
})

export async function getDeviceComponents(
  actor: Actor, deviceId: string,
): Promise<{ current: CurrentComponent[]; history: InstallationHistoryItem[] }> {
  authorize(actor, 'view_records', 'manufacturing')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<Raw>(
      `SELECT ${SELECT_COLS} ${FROM_JOINS}
        WHERE ci.device_id = $1
        ORDER BY ct.sort, ci.slot_no, ci.installed_at DESC`, [deviceId])
    const all = rows.map(toItem)
    return { current: all.filter((r) => r.removedAt === null), history: all }
  })
}

const installSchema = z.object({
  deviceId: z.string().uuid(),
  componentTypeId: z.string().uuid(),
  slotNo: z.number().int().min(1).default(1),
  unitId: z.string().uuid().optional(),
  batchNo: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
})

export async function installComponent(
  actor: Actor, input: z.input<typeof installSchema>,
): Promise<{ installationId: string }> {
  authorize(actor, 'edit_records', 'manufacturing')
  const data = installSchema.parse(input)
  return withTransaction(actor.id, async (tx) => {
    const id = await insertInstallation(tx, actor.id, {
      deviceId: data.deviceId, componentTypeId: data.componentTypeId, slotNo: data.slotNo,
      unitId: data.unitId ?? null, batchNo: data.batchNo ?? null, notes: data.notes ?? null,
    })
    if (data.unitId) await setDisposition(tx, data.unitId, 'installed')
    return { installationId: id }
  })
}

const replaceSchema = z.object({
  removedInstallationId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
  replacementUnitId: z.string().uuid().optional(),
  replacementBatchNo: z.string().max(100).optional(),
  repairId: z.string().uuid().optional(),
  modificationId: z.string().uuid().optional(),
  notes: z.string().max(2000).optional(),
})
export type ReplaceInput = z.input<typeof replaceSchema>

/**
 * The §14 primitive. One transaction: close the open installation, open the new
 * one, flip the removed/installed unit dispositions, bump device.version. Either
 * all of it commits or none — a device can never show a replacement its history
 * lacks. The future Repair/Modification workflows call this with a repairId /
 * modificationId; today those columns are just recorded.
 */
export async function replaceComponentInstallation(
  actor: Actor, input: ReplaceInput,
): Promise<{ closedId: string; newId: string; current: CurrentComponent[] }> {
  authorize(actor, 'edit_records', 'manufacturing')
  const data = replaceSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    // Lock the open installation + its type's tracking mode.
    const { rows: openRows } = await tx.query<{
      device_id: string; component_type_id: string; component_unit_id: string | null
      slot_no: number; removed_at: Date | null; tracking_mode: 'serialized' | 'batch'
    }>(
      `SELECT ci.device_id, ci.component_type_id, ci.component_unit_id, ci.slot_no, ci.removed_at,
              ct.tracking_mode
         FROM component_installation ci JOIN component_type ct ON ct.id = ci.component_type_id
        WHERE ci.id = $1 FOR UPDATE OF ci`, [data.removedInstallationId])
    if (openRows.length === 0) throw new Error('Installation not found')
    const open = openRows[0]
    if (open.removed_at !== null) throw new Error('That component was already removed')

    // Shape rule (pure) — keeps impossible swaps out of the DB work.
    assertReplacementShape({
      trackingMode: open.tracking_mode,
      removingUnitId: open.component_unit_id,
      replacementUnitId: data.replacementUnitId ?? null,
      replacementBatchNo: data.replacementBatchNo ?? null,
    })

    // 1. Close the old installation (the append-only guard permits this one-time stamp).
    await tx.query(
      `UPDATE component_installation
          SET removed_at = now(), removed_by = $1, removal_reason = $2,
              repair_id = $3, modification_id = $4
        WHERE id = $5`,
      [actor.id, data.reason, data.repairId ?? null, data.modificationId ?? null,
       data.removedInstallationId])

    // 2. Open the new installation in the same slot.
    const newId = await insertInstallation(tx, actor.id, {
      deviceId: open.device_id, componentTypeId: open.component_type_id, slotNo: open.slot_no,
      unitId: data.replacementUnitId ?? null, batchNo: data.replacementBatchNo ?? null,
      notes: data.notes ?? null, repairId: data.repairId ?? null,
      modificationId: data.modificationId ?? null,
    })

    // 3. Flip unit dispositions (serialized only).
    if (open.component_unit_id) await setDisposition(tx, open.component_unit_id, 'removed')
    if (data.replacementUnitId) await setDisposition(tx, data.replacementUnitId, 'installed')

    // 4. Bump device.version — the device's component set changed.
    await tx.query(
      `UPDATE device SET version = version + 1, updated_at = now(), updated_by = $1 WHERE id = $2`,
      [actor.id, open.device_id])

    // Return the fresh current set.
    const { rows } = await tx.query<Raw>(
      `SELECT ${SELECT_COLS} ${FROM_JOINS}
        WHERE ci.device_id = $1 AND ci.removed_at IS NULL
        ORDER BY ct.sort, ci.slot_no`, [open.device_id])
    return { closedId: data.removedInstallationId, newId, current: rows.map(toItem) }
  })
}

async function insertInstallation(
  tx: Tx, actorId: string,
  a: { deviceId: string; componentTypeId: string; slotNo: number; unitId: string | null
       batchNo: string | null; notes: string | null; repairId?: string | null
       modificationId?: string | null },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO component_installation
       (device_id, component_type_id, component_unit_id, batch_no, slot_no,
        installed_by, repair_id, modification_id, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$6) RETURNING id`,
    [a.deviceId, a.componentTypeId, a.unitId, a.batchNo, a.slotNo, actorId,
     a.repairId ?? null, a.modificationId ?? null, a.notes])
  return rows[0].id
}

async function setDisposition(tx: Tx, unitId: string, disposition: string): Promise<void> {
  await tx.query(
    `UPDATE component_unit SET disposition = $1, updated_at = now(), version = version + 1
      WHERE id = $2`, [disposition, unitId])
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:integration`
Expected: PASS (8 tests). The rollback test and the "history remains" test are the load-bearing ones — the transaction is all-or-nothing and the history table is never overwritten.

- [ ] **Step 5: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add dlms/modules/manufacturing/services/componentService.ts \
        dlms/__tests__/integration/componentService.test.ts
git commit -m "feat(manufacturing): device component reads + the §14 replacement transaction

getDeviceComponents (current + full history) and the atomic replacement primitive
— close old install, open new, flip unit dispositions, bump device.version, all in
one transaction. The Repair/Modification workflows will call it with a repairId."
```

---

### Task 5: Device profile Components tab

**Files:**
- Create: `components/manufacturing/DeviceComponentsTab.tsx`, `app/(platform)/manufacturing/devices/[id]/componentActions.ts`
- Modify: `app/(platform)/manufacturing/devices/[id]/page.tsx` (replace the stubbed Components tab)
- Test: `__tests__/platform/manufacturing/componentActions.test.ts`

**Interfaces:**
- Consumes: `getDeviceComponents`, `replaceComponentInstallation`, `installComponent` (Task 4); `requireActor`, `can`.
- Produces: `<DeviceComponentsTab deviceId={string} canEdit={boolean} />` server component; server actions `replaceComponentAction`/`installComponentAction` returning `{ ok } | { ok:false; error }`.

- [ ] **Step 1: Write the failing action test**

```typescript
// __tests__/platform/manufacturing/componentActions.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireActor = vi.fn()
const mockReplace = vi.fn()
vi.mock('@/modules/shared/auth/session', () => ({ requireActor: mockRequireActor }))
vi.mock('@/modules/manufacturing/services/componentService', () => ({
  replaceComponentInstallation: mockReplace, installComponent: vi.fn(),
}))
vi.mock('@/modules/manufacturing/domain/componentInstallation', () => ({
  InvalidReplacementError: class InvalidReplacementError extends Error {},
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { replaceComponentAction } = await import(
  '@/app/(platform)/manufacturing/devices/[id]/componentActions')

const ACTOR = { id: 'u1', roleKey: 'operator' as const, permissions: new Set(['edit_records' as const]),
  moduleAccess: new Set(['manufacturing' as const]), active: true }

beforeEach(() => { mockRequireActor.mockReset().mockResolvedValue(ACTOR); mockReplace.mockReset() })

describe('replaceComponentAction', () => {
  it('reports success', async () => {
    mockReplace.mockResolvedValue({ closedId: 'a', newId: 'b', current: [] })
    expect(await replaceComponentAction('dev1', { removedInstallationId: 'i1', reason: 'x',
      replacementUnitId: 'u2' })).toEqual({ ok: true })
  })
  it('maps an invalid replacement to its message, not a raw error', async () => {
    const { InvalidReplacementError } = await import(
      '@/modules/manufacturing/domain/componentInstallation')
    mockReplace.mockRejectedValue(new InvalidReplacementError('The replacement cannot be the same unit being removed'))
    const res = await replaceComponentAction('dev1', { removedInstallationId: 'i1', reason: 'x',
      replacementUnitId: 'u1' })
    expect(res).toEqual({ ok: false, error: 'The replacement cannot be the same unit being removed' })
  })
  it('never leaks an internal DB error', async () => {
    mockReplace.mockRejectedValue(new Error('duplicate key value violates unique constraint "one_open_install"'))
    const res = await replaceComponentAction('dev1', { removedInstallationId: 'i1', reason: 'x',
      replacementUnitId: 'u2' })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).not.toContain('constraint')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/platform/manufacturing/componentActions.test.ts`
Expected: FAIL — cannot resolve `componentActions`.

- [ ] **Step 3: Implement the server actions**

```typescript
// app/(platform)/manufacturing/devices/[id]/componentActions.ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireActor } from '@/modules/shared/auth/session'
import {
  replaceComponentInstallation, installComponent, type ReplaceInput,
} from '@/modules/manufacturing/services/componentService'
import { InvalidReplacementError } from '@/modules/manufacturing/domain/componentInstallation'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'

export type ActionResult = { ok: true } | { ok: false; error: string }

function toMessage(err: unknown): string {
  if (err instanceof InvalidReplacementError) return err.message
  if (err instanceof OptimisticLockError) return 'Someone else changed this device. Reload and try again.'
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'component action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function replaceComponentAction(
  deviceId: string, input: ReplaceInput,
): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    await replaceComponentInstallation(actor, input)
    revalidatePath(`/manufacturing/devices/${deviceId}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function installComponentAction(
  deviceId: string,
  input: { componentTypeId: string; slotNo?: number; unitId?: string; batchNo?: string; notes?: string },
): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    await installComponent(actor, { deviceId, ...input })
    revalidatePath(`/manufacturing/devices/${deviceId}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/platform/manufacturing/componentActions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Build the tab and wire it into the device page**

`DeviceComponentsTab.tsx` (server component): `const { current, history } = await getDeviceComponents(actor, deviceId)`. Render a **Current components** table (type name, slot, serial/batch, installed date + by) with a "Replace" button per row (shown only when `canEdit`), and a **History** timeline grouped by type+slot (each entry: installed → removed with reason and actor). The Replace dialog collects the replacement (a unit picker for serialized types, a batch-number field for batch types) + a mandatory reason, and calls `replaceComponentAction`; on `{ok:false}` it shows the error via toast. An empty state ("No components recorded yet") with an "Add component" action (`installComponentAction`) when `canEdit`.

Modify `app/(platform)/manufacturing/devices/[id]/page.tsx`: replace the stubbed "Components" tab body with `<DeviceComponentsTab deviceId={device.id} canEdit={can(actor,'edit_records','manufacturing')} />`. Leave the other tabs unchanged.

- [ ] **Step 6: Verify build + full suite**

Run: `npm test && npm run type-check && npm run build`
Expected: PASS; `/manufacturing/devices/[id]` resolves with the real Components tab.

- [ ] **Step 7: Commit**

```bash
cd /Users/reetmitra/Desktop/QTX/quantumtx-ah
git add "dlms/app/(platform)/manufacturing/devices/[id]/componentActions.ts" \
        "dlms/app/(platform)/manufacturing/devices/[id]/page.tsx" \
        dlms/components/manufacturing/DeviceComponentsTab.tsx \
        dlms/__tests__/platform/manufacturing/componentActions.test.ts
git commit -m "feat(manufacturing): device-profile Components tab (current + history + replace)

Wires the real component model into the device profile: current components, the
full append-only history, and the one-action replacement flow. Errors never leak
internals; the Replace control is edit-gated."
```

---

## Plan self-review

**Spec coverage (§10–11, §14):** component catalogue (Task 1/3) · serialized units + batch tracking (Task 1, `unit_or_batch` CHECK, tracking_mode) · append-only installation history (Task 1 guard, Task 4 reads) · per-variant BOM table (Task 1 — `variant_bom_line`; a BOM management UI is deferred to the Engineering module, which owns BOM authoring per the interview) · the §14 atomic replacement (Task 4, the core; the *repair-driven* invocation lands with the Maintenance module, which calls `replaceComponentInstallation` with a `repairId`) · component history on the device profile (Task 5). **Deliberately deferred** (out of this subsystem, noted where relevant): legacy-data migration of the DLMS PCBA/screen columns into `component_unit`/`component_installation` rows (a follow-up migration task); component **inventory location** moves (needs `stock_location` from Logistics); firmware linkage (needs `firmware_release` from Engineering). These are the deferred-FK columns, reserved now.

**Placeholder scan:** none — every code step carries complete code; UI steps (3.5, 5.5) describe concrete components with named props and the exact service calls, consistent with how the demo-scope plan specified its UI tasks.

**Type consistency:** `InstallationRow`/`ReplacementCheck` (Task 2) are consumed by Task 4's service; `CurrentComponent`/`InstallationHistoryItem` (Task 4) are consumed by Task 5. `replaceComponentInstallation(actor, ReplaceInput)` and `ReplaceInput` are identical across Task 4 (produce) and Task 5 (consume). `assertReplacementShape` signature matches between Task 2 and its Task 4 call site. `tracking_mode` values `'serialized'|'batch'` are consistent across schema, domain, and services.

**RLS/R1 consistency:** Task 1 enables RLS deny-via-REST on all four new tables and revokes trigger-fn EXECUTE — so applying this migration to cloud won't reintroduce the `rls_disabled` advisor. The controller must apply it to `yxpxknfdtcpbhohxlhfx` only.
