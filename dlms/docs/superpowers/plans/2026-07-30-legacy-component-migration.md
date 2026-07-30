# Legacy Component-Data Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Back-fill the normalized component model — `component_unit` + `component_installation` — from the legacy DLMS `device` table's wide PCBA/screen columns, onto the platform devices `scripts/migrate_demo.ts` already created.

**Architecture:** The same shape as `scripts/migrate_demo.ts`, which this is the sibling of: a **pure mapper** in `modules/manufacturing/domain/` that turns one legacy device row into component drafts and is exhaustively unit-tested, plus a **runner** in `scripts/` that reads the legacy project over a read-only connection and writes only to the platform project. Reconciliation lives in the existing `scripts/reconcile.ts` and exits non-zero on mismatch. The runner is idempotent — both target tables have unique indexes, and every insert is `ON CONFLICT DO NOTHING` — so a re-run after fixing data adds only what is missing.

**Tech Stack:** TypeScript, node-postgres, Vitest (unit + dockerized-PG integration), `tsx` for script execution.

**What this is not.** It does not create devices — `migrate_demo.ts` does that, and it must have run first. It does not touch the bulk-import subsystem, and it does not read spreadsheets. A legacy device with no platform counterpart is **reported, never created**.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Spec §15 is the contract** (`dlms/docs/superpowers/specs/2026-07-17-ops-platform-design.md`, the "PCBA-A/B, screen columns" row): *one unit + one open installation per populated group, `installed_at = device.created_at`, revisions/fw carried verbatim. Ranged serials → single unit, verbatim SN, `needs_split=true` + admin cleanup queue.* Marked CONFIRMED, with the rider **"cutover never blocks on cleansing."**
- **Never split a ranged serial.** `"EE-02A-2603-0001 to 0015"` becomes **one** `component_unit` with that exact string as its `serial_no` and `needs_split = true`. This is the deliberate opposite of the bulk importer, which expands ranges — and the difference is the point: the importer is told about devices that do not exist yet, so expanding invents nothing; this migration back-fills components onto devices whose identity was already decided by `migrate_demo.ts`, which itself refused to split (`needs_data_review`). Splitting here would invent component identities the business never assigned *and* disagree with the device row it hangs off.
- **Never guess, never synthesize.** No invented serial numbers. An unmappable value is carried verbatim and flagged, or reported — never silently dropped and never coerced.
- **Read-only against legacy.** The runner opens the legacy pool from `LEGACY_DATABASE_URL` and issues only `SELECT`. Every write goes to `DATABASE_URL`. Follow `migrate_demo.ts`'s structure exactly.
- **Idempotent.** `component_unit_sn` is `UNIQUE(component_type_id, serial_no) WHERE deleted_at IS NULL`; `one_open_install` is `UNIQUE(device_id, component_type_id, slot_no) WHERE removed_at IS NULL`. Every insert is `ON CONFLICT DO NOTHING`, and counts sum `rowCount`, not the number of rows attempted — so a re-run reports what it newly wrote, not what it re-attempted. `migrate_demo.ts:294-299` explains why that distinction matters and is the precedent.
- **Audit triggers stay ON.** This is the one place this script deliberately differs from `migrate_demo.ts`, which suppresses them with `SET LOCAL session_replication_role = 'replica'` because it copies the legacy `audit_log` verbatim and must not double-write. Components have **no** legacy audit history — they never existed as rows in DLMS — so their creation is genuine new platform history and must be attributed to the migration actor like any other write. Do not copy the suppression.
- **`component_installation` is append-only**, guarded by `fn_component_installation_guard`, which rejects `DELETE` and any `UPDATE` other than the one-time removal stamp. The runner only ever `INSERT`s.
- TDD: write the failing test, run it, watch it fail, then implement.
- Pure domain modules (`modules/manufacturing/domain/`) do no I/O: no DB, no `fetch`, no file access, no reading the clock. `installed_at` is passed in, never derived from `now()`.
- No imports from `dlms/lib/domain/` or `dlms/lib/services/` — frozen legacy app behind a module boundary.
- **Commit attribution:** every commit is authored solely by Reet Mitra. **Never** add a `Co-Authored-By` or any co-author trailer (CLAUDE.md hard rule).
- **Verification before any completion claim:** `cd dlms && npm test`, `npm run test:integration`, `npx tsc --noEmit`. Paste real output.
- **Integration-test gotcha:** `npm run test:integration -- <name>` does **not** filter — the argument lands on the trailing `docker compose down`, which errors and leaves the container running, poisoning later runs with stale-data failures in unrelated files. Run it bare, or bring the container up and use `npx vitest run --config vitest.integration.config.ts <file>`. Clear a stale container with `cd dlms && docker compose -f docker-compose.test.yml down -v`.

---

## The three component groups, and the decision each one forced

The legacy `device` table (`supabase/migrations/20250101000003_device.sql:18-33`) carries three column groups. They do not map uniformly, and the differences drive the whole mapper:

| Group | Legacy columns | Nullability | Maps to |
|---|---|---|---|
| **PCBA-A** (电源板) | `pcba_a_sn`, `pcba_a_hw_rev`, `pcba_a_bom_rev`, `pcba_a_fw_ver` | all `NOT NULL` | a serialized `component_unit` (`pcba_a`) + one open installation |
| **PCBA-B** (控制板) | `pcba_b_sn`, `pcba_b_hw_rev`, `pcba_b_bom_rev`, `pcba_b_fw_ver` | all nullable; the schema comment warns `pcba_b_fw_ver` **may contain prose**, e.g. `"No wifi version"` | a serialized `component_unit` (`pcba_b`) + one open installation, when a serial is present |
| **HMI screen** (触摸屏) | `screen_model`, `hmi_ver` | nullable; **no serial column exists at all** | a **batch-form** installation (`hmi_screen`) — see below |

**The screen decision.** `component_unit.serial_no` is `NOT NULL`, and legacy identifies a screen only by model and firmware version — neither of which identifies an individual screen. Creating a unit would mean inventing a serial, which the Global Constraints forbid; using the model as the serial would collide across every device sharing that model. So the screen is migrated as what it actually is: a **batch** part. `component_installation` supports exactly this — `component_unit_id` NULL with `batch_no` set, permitted by the `unit_or_batch` CHECK — and the components migration's own comment defines batch tracking as "installation references type + batch_no, no unit row."

This needs **no schema change**, and it does not break replacement: `assertReplacementShape` keys off `component_type.tracking_mode`, which stays `serialized` for `hmi_screen`, so a future swap correctly demands a real serialized unit. The seeded `tracking_mode` describes what a screen *should* be once screens carry serials; the batch-form installation describes what the legacy data *actually knows*. Keep that distinction in a comment — it is the kind of thing that reads like a bug.

**The prose decision.** The schema's prose warning is on **`pcba_b_fw_ver`** — `20250101000003_device.sql:28` annotates that column "may contain notes e.g. `"No wifi version"`" — not on `pcba_b_sn`. Detecting prose reliably is guesswork either way, and the house rule is that a migration which guesses is a migration that silently corrupts a fleet (`migrate_demo.ts:20-22`). So the mapper does not judge: it carries every present value verbatim, and sets `needs_split = true` on anything that is not a single clean serial. `needs_split` is the only flag `component_unit` has, and the admin cleanup queue works off it — so the widening from "holds a range" to "this serial needs human eyes" is deliberate. Say so in the field's comment, and make the reconciliation report list them, so the queue is visible rather than implied.

**And say what that widening does *not* cover.** `needs_split` is computed from the **serial only** (`needsSplitSerial(serialNo)`), never from `hw_rev`/`bom_rev`/`fw_ver`. So a prose *firmware version* — the exact case the schema comment warns about — is carried verbatim into `component_unit.fw_ver` and is **not flagged**: a unit with a perfectly clean serial can still hold `"No wifi version"` in `fw_ver` and never appear in the queue. That is a real gap, not an oversight to fix by widening the flag further (a flag named `needs_split` set by a firmware string would mean something else again). Document it, in the field comment and in the runbook, as something whoever works the cleanup queue has to scan for directly.

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `modules/manufacturing/domain/legacyComponents.ts` | Pure: one legacy row → component drafts |
| `scripts/migrate_components.ts` | Runner: legacy read-only → platform writes |
| `__tests__/platform/manufacturing/legacyComponents.test.ts` | Unit |
| `__tests__/integration/migrateComponents.test.ts` | Integration, incl. the runner end to end |
| `docs/runbooks/RB-08-component-migration.md` | Runbook |

**Modify:**

| Path | Change |
|---|---|
| `scripts/reconcile.ts` | Add component reconciliation |
| `package.json` | Add `migrate:components` |
| `docs/superpowers/PROGRESS.md` | Flip the legacy component-data migration row |

---

## Task 1: The pure mapper

**Files:**
- Create: `modules/manufacturing/domain/legacyComponents.ts`
- Test: `__tests__/platform/manufacturing/legacyComponents.test.ts`

**Interfaces:**
- Consumes: nothing. Pure.
- Produces:
  - `type LegacyComponentRow` — the legacy columns this reads, plus `deviceId` and `createdAt`
  - `type ComponentUnitDraft = { typeCode: 'pcba_a' | 'pcba_b'; serialNo: string; hwRev: string | null; bomRev: string | null; fwVer: string | null; needsSplit: boolean }`
  - `type ComponentInstallDraft = { typeCode: 'pcba_a' | 'pcba_b' | 'hmi_screen'; unit: ComponentUnitDraft | null; batchNo: string | null; notes: string | null; installedAt: Date }`
  - `needsSplitSerial(serial: string): boolean`
  - `mapLegacyComponents(row: LegacyComponentRow): ComponentInstallDraft[]`

  Task 2's runner consumes `mapLegacyComponents` and writes each draft.

- [ ] **Step 1: Write the failing test**

Create `__tests__/platform/manufacturing/legacyComponents.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  mapLegacyComponents, needsSplitSerial, type LegacyComponentRow,
} from '@/modules/manufacturing/domain/legacyComponents'

const CREATED = new Date('2026-03-14T08:00:00Z')

const row = (over: Partial<LegacyComponentRow> = {}): LegacyComponentRow => ({
  deviceId: 'device-uuid-1',
  createdAt: CREATED,
  pcbaASn: 'EE-02A-2603-0001',
  pcbaAHwRev: 'V1.2',
  pcbaABomRev: 'B3',
  pcbaAFwVer: '1.0.4',
  pcbaBSn: null,
  pcbaBHwRev: null,
  pcbaBBomRev: null,
  pcbaBFwVer: null,
  screenModel: null,
  hmiVer: null,
  ...over,
})

describe('needsSplitSerial', () => {
  it('accepts a single clean serial', () => {
    expect(needsSplitSerial('EE-02A-2603-0001')).toBe(false)
    expect(needsSplitSerial('PCBA_B/2026/0007')).toBe(false)
  })
  it('flags a range', () => {
    expect(needsSplitSerial('EE-02A-2603-0001 to 0015')).toBe(true)
    expect(needsSplitSerial('EE-0001 TO 0015')).toBe(true)
  })
  it('flags a list', () => {
    expect(needsSplitSerial('EE-0001, EE-0002')).toBe(true)
    expect(needsSplitSerial('EE-0001 and EE-0002')).toBe(true)
    expect(needsSplitSerial('EE-0001 & EE-0002')).toBe(true)
  })
  it('flags prose — a sentence is not a serial', () => {
    expect(needsSplitSerial('No wifi version')).toBe(true)
    expect(needsSplitSerial('无 wifi 版本')).toBe(true)
  })
})

describe('mapLegacyComponents — PCBA-A', () => {
  it('produces one serialized unit and one installation, revisions verbatim', () => {
    const [install, ...rest] = mapLegacyComponents(row())
    expect(rest).toHaveLength(0)
    expect(install.typeCode).toBe('pcba_a')
    expect(install.batchNo).toBeNull()
    expect(install.unit).toEqual({
      typeCode: 'pcba_a', serialNo: 'EE-02A-2603-0001',
      hwRev: 'V1.2', bomRev: 'B3', fwVer: '1.0.4', needsSplit: false,
    })
  })

  it('stamps installed_at from the device creation time — never the clock', () => {
    expect(mapLegacyComponents(row())[0].installedAt).toBe(CREATED)
  })

  it('carries a ranged serial VERBATIM as one unit and flags it, never splitting', () => {
    const [install] = mapLegacyComponents(row({ pcbaASn: 'EE-02A-2603-0001 to 0015' }))
    expect(install.unit!.serialNo).toBe('EE-02A-2603-0001 to 0015')
    expect(install.unit!.needsSplit).toBe(true)
  })

  it('produces nothing for PCBA-A when the serial is blank', () => {
    expect(mapLegacyComponents(row({ pcbaASn: '   ' }))).toHaveLength(0)
  })

  it('trims surrounding whitespace but preserves internal characters', () => {
    const [install] = mapLegacyComponents(row({ pcbaASn: '  EE-02A-2603-0001  ' }))
    expect(install.unit!.serialNo).toBe('EE-02A-2603-0001')
  })
})

describe('mapLegacyComponents — PCBA-B', () => {
  it('adds a second installation when a B serial is present', () => {
    const installs = mapLegacyComponents(row({
      pcbaBSn: 'CTRL-0007', pcbaBHwRev: 'V2.0', pcbaBBomRev: null, pcbaBFwVer: '2.1',
    }))
    expect(installs.map((i) => i.typeCode)).toEqual(['pcba_a', 'pcba_b'])
    expect(installs[1].unit).toEqual({
      typeCode: 'pcba_b', serialNo: 'CTRL-0007',
      hwRev: 'V2.0', bomRev: null, fwVer: '2.1', needsSplit: false,
    })
  })

  it('carries a prose B value verbatim and flags it rather than judging it', () => {
    const installs = mapLegacyComponents(row({ pcbaBSn: 'No wifi version' }))
    expect(installs[1].unit!.serialNo).toBe('No wifi version')
    expect(installs[1].unit!.needsSplit).toBe(true)
  })

  it('omits PCBA-B entirely when it has no serial, even if revisions are present', () => {
    const installs = mapLegacyComponents(row({ pcbaBSn: null, pcbaBHwRev: 'V2.0' }))
    expect(installs.map((i) => i.typeCode)).toEqual(['pcba_a'])
  })
})

describe('mapLegacyComponents — HMI screen', () => {
  it('is a BATCH installation: no unit, batch_no from the model', () => {
    const installs = mapLegacyComponents(row({ screenModel: 'TK-070', hmiVer: '3.2' }))
    const screen = installs.find((i) => i.typeCode === 'hmi_screen')!
    expect(screen.unit).toBeNull()
    expect(screen.batchNo).toBe('TK-070')
    expect(screen.installedAt).toBe(CREATED)
  })

  it('records both legacy screen values verbatim in the notes', () => {
    const installs = mapLegacyComponents(row({ screenModel: 'TK-070', hmiVer: '3.2' }))
    const screen = installs.find((i) => i.typeCode === 'hmi_screen')!
    expect(screen.notes).toContain('TK-070')
    expect(screen.notes).toContain('3.2')
  })

  it('falls back to the HMI version as batch_no when only that is present', () => {
    const installs = mapLegacyComponents(row({ screenModel: null, hmiVer: '3.2' }))
    const screen = installs.find((i) => i.typeCode === 'hmi_screen')!
    expect(screen.batchNo).toBe('3.2')
  })

  it('produces no screen installation when both columns are empty', () => {
    const installs = mapLegacyComponents(row({ screenModel: '  ', hmiVer: null }))
    expect(installs.map((i) => i.typeCode)).toEqual(['pcba_a'])
  })
})

describe('mapLegacyComponents — a fully populated row', () => {
  it('produces all three groups in catalogue order', () => {
    const installs = mapLegacyComponents(row({
      pcbaBSn: 'CTRL-0007', screenModel: 'TK-070', hmiVer: '3.2',
    }))
    expect(installs.map((i) => i.typeCode)).toEqual(['pcba_a', 'pcba_b', 'hmi_screen'])
    expect(installs.every((i) => i.installedAt === CREATED)).toBe(true)
  })

  it('never invents a serial for any group', () => {
    const installs = mapLegacyComponents(row({ screenModel: 'TK-070' }))
    for (const i of installs) {
      if (i.unit) expect(i.unit.serialNo.trim()).not.toBe('')
    }
    expect(installs.find((i) => i.typeCode === 'hmi_screen')!.unit).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dlms && npm test -- legacyComponents`
Expected: FAIL — cannot resolve `@/modules/manufacturing/domain/legacyComponents`.

- [ ] **Step 3: Write the implementation**

Create `modules/manufacturing/domain/legacyComponents.ts`:

```ts
/**
 * Pure mapper for the legacy component-data migration (spec §15). No I/O.
 *
 * The legacy DLMS `device` table flattens components into ten wide columns; the
 * platform normalizes them into component_unit + component_installation. This
 * turns one legacy row into the installation drafts that describe it, and makes
 * no decisions the data does not support.
 *
 * Two rules are load-bearing and look like bugs if you don't know why:
 *
 * 1. A ranged serial ("…0001 to 0015") becomes ONE unit carrying that string
 *    verbatim, flagged needsSplit — never fifteen units. The bulk importer does
 *    the opposite because it is told about devices that do not exist yet, so
 *    expanding invents nothing. Here the device already exists and its identity
 *    was already decided by scripts/migrate_demo.ts, which likewise refused to
 *    split. Splitting would invent component identities the business never
 *    assigned and disagree with the device row the components hang off.
 *
 * 2. The HMI screen becomes a BATCH installation (no unit row, batch_no set)
 *    because legacy identifies a screen only by model and firmware version —
 *    neither identifies an individual screen, and component_unit.serial_no is
 *    NOT NULL, so a unit would mean inventing a serial. component_type
 *    .tracking_mode stays 'serialized' for hmi_screen deliberately: it
 *    describes what a screen should be once screens carry serials, and keeps
 *    assertReplacementShape demanding a real unit for any future swap. The
 *    batch-form installation describes what the legacy data actually knows.
 */

export type LegacyComponentRow = {
  deviceId: string
  createdAt: Date
  pcbaASn: string | null
  pcbaAHwRev: string | null
  pcbaABomRev: string | null
  pcbaAFwVer: string | null
  pcbaBSn: string | null
  pcbaBHwRev: string | null
  pcbaBBomRev: string | null
  pcbaBFwVer: string | null
  screenModel: string | null
  hmiVer: string | null
}

export type ComponentUnitDraft = {
  typeCode: 'pcba_a' | 'pcba_b'
  serialNo: string
  hwRev: string | null
  bomRev: string | null
  fwVer: string | null
  /**
   * "This serial needs human eyes before it is trustworthy." Spec §15 defines
   * it for ranged serials; it is deliberately widened here to any value that is
   * not a single clean serial, because component_unit has no other flag and the
   * admin cleanup queue works off this one. A migration that judged prose like
   * "No wifi version" to mean "no board" would be guessing — so it carries the
   * value verbatim and flags it instead.
   */
  needsSplit: boolean
}

export type ComponentInstallDraft = {
  typeCode: 'pcba_a' | 'pcba_b' | 'hmi_screen'
  unit: ComponentUnitDraft | null   // null for the batch-tracked screen
  batchNo: string | null            // set only when unit is null
  notes: string | null
  installedAt: Date                 // always device.created_at (spec §15)
}

const text = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim()
  return t === '' ? null : t
}

/** A single clean serial: no separators that imply several, and no spaces. */
export function needsSplitSerial(serial: string): boolean {
  const s = serial.trim()
  if (s === '') return false
  // Range or list notation — the spec's own examples.
  if (/\bto\b|\band\b|[,&~]|-{2,}/i.test(s)) return true
  // Anything with whitespace inside is prose, not a part number.
  if (/\s/.test(s)) return true
  return false
}

function unitFor(
  typeCode: 'pcba_a' | 'pcba_b',
  sn: string | null, hwRev: string | null, bomRev: string | null, fwVer: string | null,
): ComponentUnitDraft | null {
  const serialNo = text(sn)
  if (serialNo === null) return null
  return {
    typeCode, serialNo,
    hwRev: text(hwRev), bomRev: text(bomRev), fwVer: text(fwVer),
    needsSplit: needsSplitSerial(serialNo),
  }
}

/**
 * One legacy row → its installation drafts, in catalogue order (pcba_a,
 * pcba_b, hmi_screen). A group with nothing populated produces nothing at all:
 * a device genuinely without an accessory board must not gain an empty one.
 */
export function mapLegacyComponents(row: LegacyComponentRow): ComponentInstallDraft[] {
  const installs: ComponentInstallDraft[] = []

  const a = unitFor('pcba_a', row.pcbaASn, row.pcbaAHwRev, row.pcbaABomRev, row.pcbaAFwVer)
  if (a) installs.push({ typeCode: 'pcba_a', unit: a, batchNo: null, notes: null, installedAt: row.createdAt })

  const b = unitFor('pcba_b', row.pcbaBSn, row.pcbaBHwRev, row.pcbaBBomRev, row.pcbaBFwVer)
  if (b) installs.push({ typeCode: 'pcba_b', unit: b, batchNo: null, notes: null, installedAt: row.createdAt })

  const screenModel = text(row.screenModel)
  const hmiVer = text(row.hmiVer)
  if (screenModel || hmiVer) {
    installs.push({
      typeCode: 'hmi_screen',
      unit: null,
      // batch_no is NOT NULL-by-constraint when unit is null, so it takes
      // whichever value the row actually has; notes keep both verbatim so
      // nothing the legacy row said is lost to the choice.
      batchNo: screenModel ?? hmiVer,
      notes: [
        screenModel ? `Screen model: ${screenModel}` : null,
        hmiVer ? `HMI version: ${hmiVer}` : null,
      ].filter(Boolean).join('; ') || null,
      installedAt: row.createdAt,
    })
  }

  return installs
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dlms && npm test -- legacyComponents`
Expected: PASS, 18 tests.

- [ ] **Step 5: Type-check and commit**

Run: `cd dlms && npx tsc --noEmit` — must be clean.

```bash
git add dlms/modules/manufacturing/domain/legacyComponents.ts dlms/__tests__/platform/manufacturing/legacyComponents.test.ts
git commit -m "feat(manufacturing): pure mapper for the legacy component-data migration"
```

---

## Task 2: The runner

**Files:**
- Create: `scripts/migrate_components.ts`
- Create: `__tests__/integration/migrateComponents.test.ts`
- Modify: `package.json` (add `migrate:components`)

**Interfaces:**
- Consumes: `mapLegacyComponents` (Task 1); `withTransaction` from `@/lib/db/tx`.
- Produces:
  - `type MigrateComponentsResult = { devicesSeen: number; unitsCreated: number; installsCreated: number; missingDevices: string[]; flaggedSerials: Array<{ deviceId: string; typeCode: string; serialNo: string }> }`
  - `migrateComponents(legacyPool: Pool, platformPool: Pool, actorId: string): Promise<MigrateComponentsResult>`
  - a `main()` entry point guarded the way `migrate_demo.ts` guards its own

**Read `scripts/migrate_demo.ts` first and mirror it**: the env-var handling, the read-only legacy pool, keyset pagination with `BATCH_SIZE`, `ON CONFLICT DO NOTHING`, summing `rowCount` rather than attempted rows, and the `fileURLToPath` main-module guard. Do **not** copy its `SET LOCAL session_replication_role = 'replica'` — see Global Constraints.

**Behaviour the tests pin:**
- Legacy rows are read keyset-paged, ordered by `(created_at, id)`.
- A legacy device with **no** platform counterpart is recorded in `missingDevices` and skipped — never created. (`migrate_demo.ts` owns device creation; a missing device means it has not been run, or was run against different data.)
- Units are inserted first, then the installation referencing the unit's id — both `ON CONFLICT DO NOTHING`. When a unit already exists (a re-run, or two devices legitimately sharing a serial), its existing id is looked up and reused rather than a second unit being created.
- `component_unit.disposition` is `'installed'` for every unit this creates: the legacy row says the part is in the device.
- `installed_by` and `created_by` are the migration actor.
- The whole thing is re-runnable: a second run creates nothing and reports zeros.

- [ ] **Step 1: Write the failing integration test**

Create `__tests__/integration/migrateComponents.test.ts`. Model the legacy stand-in on `__tests__/integration/migrateDemo.test.ts`'s existing approach — a throwaway schema in the same test database, with the "legacy" pool pointed at it via the `options=-c search_path=` connection parameter, so the runner's unqualified `FROM device` resolves there while the platform pool resolves to `public`. **Read that file's helper before writing this one and reuse its shape.**

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client, Pool } from 'pg'
import { getPool } from '@/lib/db/pool'
import { migrateComponents } from '@/scripts/migrate_components'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

const SCHEMA = 'legacy_components_src'
const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

let db: Client
let legacyPool: Pool
let platformPool: Pool
let actorId: string
let deviceId: string
let orphanId: string

/** Connection string pointed at `schema` within the same test database. */
function legacyUrlForSchema(schema: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL!)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  actorId = (await db.query(
    `SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id

  // A platform device for the migration to hang components off.
  deviceId = (await db.query<{ id: string }>(
    `INSERT INTO device (variant_id, status, created_at, created_by, updated_by)
     VALUES ((SELECT id FROM device_variant WHERE code='pro'), 'in_stock',
             timestamptz '2026-03-14 08:00:00+00', $1, $1) RETURNING id`,
    [actorId])).rows[0].id
  orphanId = '00000000-0000-0000-0000-0000000000ff'

  // Legacy stand-in: only the columns the runner reads.
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await db.query(`CREATE SCHEMA ${SCHEMA}`)
  await db.query(`
    CREATE TABLE ${SCHEMA}.device (
      id uuid PRIMARY KEY,
      pcba_a_sn text, pcba_a_hw_rev text, pcba_a_bom_rev text, pcba_a_fw_ver text,
      pcba_b_sn text, pcba_b_hw_rev text, pcba_b_bom_rev text, pcba_b_fw_ver text,
      screen_model text, hmi_ver text,
      created_at timestamptz NOT NULL
    )`)
  await db.query(
    `INSERT INTO ${SCHEMA}.device VALUES
       ($1, $2, 'V1.2', 'B3', '1.0.4', $3, 'V2.0', NULL, '2.1', 'TK-070', '3.2',
        timestamptz '2026-03-14 08:00:00+00'),
       ($4, $5, 'V1.0', 'B1', '1.0.0', NULL, NULL, NULL, NULL, NULL, NULL,
        timestamptz '2026-03-15 08:00:00+00')`,
    [deviceId, `A-${runTag}`, `B-${runTag}`, orphanId, `ORPHAN-${runTag}`])

  legacyPool = new Pool({ connectionString: legacyUrlForSchema(SCHEMA) })
  platformPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL })
})

afterAll(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await legacyPool.end(); await platformPool.end()
  await db.end(); await getPool().end()
})

describe('migrateComponents', () => {
  it('creates units and open installations for every populated group', async () => {
    const result = await migrateComponents(legacyPool, platformPool, actorId)
    expect(result.unitsCreated).toBe(2)      // pcba_a + pcba_b; the screen has no unit
    expect(result.installsCreated).toBe(3)   // pcba_a + pcba_b + hmi_screen

    const { rows } = await db.query<{
      code: string; serial_no: string | null; batch_no: string | null
      hw_rev: string | null; fw_ver: string | null; installed_at: Date; removed_at: Date | null
    }>(
      `SELECT ct.code, cu.serial_no, ci.batch_no, cu.hw_rev, cu.fw_ver,
              ci.installed_at, ci.removed_at
         FROM component_installation ci
         JOIN component_type ct ON ct.id = ci.component_type_id
         LEFT JOIN component_unit cu ON cu.id = ci.component_unit_id
        WHERE ci.device_id = $1 ORDER BY ct.sort`, [deviceId])
    expect(rows.map((r) => r.code)).toEqual(['pcba_a', 'pcba_b', 'hmi_screen'])
    expect(rows[0].serial_no).toBe(`A-${runTag}`)
    expect(rows[0].hw_rev).toBe('V1.2')
    expect(rows[1].fw_ver).toBe('2.1')
    expect(rows.every((r) => r.removed_at === null)).toBe(true)
  })

  it('stamps installed_at from the legacy device creation time', async () => {
    const { rows } = await db.query<{ installed_at: Date }>(
      `SELECT installed_at FROM component_installation WHERE device_id=$1 LIMIT 1`, [deviceId])
    expect(rows[0].installed_at.toISOString()).toBe('2026-03-14T08:00:00.000Z')
  })

  it('migrates the screen as a batch installation with no unit row', async () => {
    const { rows } = await db.query<{ component_unit_id: string | null; batch_no: string; notes: string }>(
      `SELECT ci.component_unit_id, ci.batch_no, ci.notes
         FROM component_installation ci JOIN component_type ct ON ct.id = ci.component_type_id
        WHERE ci.device_id = $1 AND ct.code = 'hmi_screen'`, [deviceId])
    expect(rows[0].component_unit_id).toBeNull()
    expect(rows[0].batch_no).toBe('TK-070')
    expect(rows[0].notes).toContain('3.2')
  })

  it('marks created units as installed', async () => {
    const { rows } = await db.query<{ disposition: string }>(
      `SELECT disposition FROM component_unit WHERE serial_no = $1`, [`A-${runTag}`])
    expect(rows[0].disposition).toBe('installed')
  })

  it('reports a legacy device with no platform counterpart instead of creating one', async () => {
    const result = await migrateComponents(legacyPool, platformPool, actorId)
    expect(result.missingDevices).toContain(orphanId)
    const { rows } = await db.query(`SELECT 1 FROM device WHERE id = $1`, [orphanId])
    expect(rows).toHaveLength(0)
  })

  it('is idempotent — a second run creates nothing', async () => {
    const again = await migrateComponents(legacyPool, platformPool, actorId)
    expect(again.unitsCreated).toBe(0)
    expect(again.installsCreated).toBe(0)
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM component_installation WHERE device_id = $1`, [deviceId])
    expect(rows[0].n).toBe('3')
  })

  it('leaves the component audit trail enabled — these are genuine platform writes', async () => {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE table_name = 'component_unit' AND row_id IN
              (SELECT id FROM component_unit WHERE serial_no = $1)`, [`A-${runTag}`])
    expect(Number(rows[0].n)).toBeGreaterThan(0)
  })
})

describe('migrateComponents — flagged serials', () => {
  it('carries a ranged serial verbatim as one unit, flags needs_split, and reports it', async () => {
    const rangedDevice = (await db.query<{ id: string }>(
      `INSERT INTO device (variant_id, status, created_at, created_by, updated_by)
       VALUES ((SELECT id FROM device_variant WHERE code='basic'), 'in_stock',
               now(), $1, $1) RETURNING id`, [actorId])).rows[0].id
    const ranged = `EE-${runTag}-0001 to 0015`
    await db.query(
      `INSERT INTO ${SCHEMA}.device (id, pcba_a_sn, created_at) VALUES ($1, $2, now())`,
      [rangedDevice, ranged])

    const result = await migrateComponents(legacyPool, platformPool, actorId)
    const { rows } = await db.query<{ serial_no: string; needs_split: boolean }>(
      `SELECT serial_no, needs_split FROM component_unit WHERE serial_no = $1`, [ranged])
    expect(rows).toHaveLength(1)                 // ONE unit, not fifteen
    expect(rows[0].needs_split).toBe(true)
    expect(result.flaggedSerials.some((f) => f.serialNo === ranged)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dlms && npx vitest run --config vitest.integration.config.ts migrateComponents` (bring the container up first with `docker compose -f docker-compose.test.yml up -d --wait`).
Expected: FAIL — cannot resolve `@/scripts/migrate_components`.

- [ ] **Step 3: Write the runner**

Create `scripts/migrate_components.ts`, mirroring `scripts/migrate_demo.ts`'s structure. It must:

1. Export `migrateComponents(legacyPool, platformPool, actorId)` returning `MigrateComponentsResult`.
2. Read legacy rows keyset-paged by `(created_at, id)` in batches of 500, selecting exactly the ten component columns plus `id` and `created_at`.
3. Resolve the three `component_type` ids once, before the loop — not per row.
4. For each batch, look up which of those device ids exist on the platform in **one** query (`WHERE id = ANY($1)`), and record the rest in `missingDevices`.
5. For each present device, call `mapLegacyComponents` and, inside one `withTransaction(actorId, …)` per batch:
   - insert each unit `ON CONFLICT (component_type_id, serial_no) WHERE deleted_at IS NULL DO NOTHING RETURNING id`; when nothing is returned, `SELECT` the existing unit's id and reuse it;
   - insert the installation with `installed_at`, `installed_by`, `created_by`, and either the unit id or the `batch_no` + `notes`, `ON CONFLICT DO NOTHING` against `one_open_install`;
   - sum `rowCount`, never the number attempted.
6. Collect every unit whose draft had `needsSplit` into `flaggedSerials`.
7. Provide a `main()` that reads `LEGACY_DATABASE_URL` and `DATABASE_URL`, throws a clear error naming the missing one, resolves the migration actor the same way `migrate_demo.ts` does, prints a summary (devices seen, units created, installs created, missing devices, flagged serials), and exits non-zero if `missingDevices` is non-empty — a missing device means `migrate_demo.ts` has not been run against this data, and continuing would produce a silently partial migration.
8. Guard `main()` with the same `fileURLToPath` main-module check `migrate_demo.ts` uses, so importing the module in tests does not execute it.

Write the doc comments in the same voice as `migrate_demo.ts` — explain *why* for the split refusal, the batch-form screen, and the deliberate absence of audit suppression.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dlms && docker compose -f docker-compose.test.yml down -v && npm run test:integration`
Expected: the whole integration suite passes, including the 8 new tests.

- [ ] **Step 5: Wire the npm script, type-check, and commit**

Add to `package.json` beside `migrate:demo`:

```json
"migrate:components": "npx tsx scripts/migrate_components.ts",
```

Run: `cd dlms && npx tsc --noEmit` and `cd dlms && npm test` — both clean.

```bash
git add dlms/scripts/migrate_components.ts dlms/__tests__/integration/migrateComponents.test.ts dlms/package.json
git commit -m "feat(manufacturing): back-fill component units and installations from legacy device columns"
```

---

## Task 3: Reconciliation

**Files:**
- Modify: `scripts/reconcile.ts`

**Interfaces:**
- Consumes: `needsSplitSerial` (Task 1) if useful; the legacy and platform pools `reconcile.ts` already opens.
- Produces: `reconcileComponents(legacyPool, platformPool): Promise<boolean>`, wired into the existing run so any mismatch exits non-zero.

**Read `scripts/reconcile.ts` first** and follow its existing shape exactly: a `reportRow(label, source, target)` per comparison returning whether it matched, results ANDed together, non-zero exit on any false. It is read-only against both databases.

Add these comparisons:

1. **Expected vs actual installation count.** Count, in legacy, the number of populated component groups across all devices that exist on the platform — that is, `count(*) FILTER (WHERE pcba_a_sn is populated)` plus the same for `pcba_b_sn`, plus the count of rows with a screen model or HMI version. Compare against `component_installation` rows with `removed_at IS NULL`. These must be equal.
2. **Unit count.** Legacy's count of distinct non-blank `pcba_a_sn` plus distinct non-blank `pcba_b_sn` values, versus `component_unit` rows for those two types. Note in a comment that distinct-ness is what makes this correct: two devices legitimately sharing a serial produce one unit and two installations.
3. **No orphan installations** — every `component_installation.device_id` resolves to a `device` row.
4. **The cleanup queue is reported, not asserted.** Print the count of `component_unit` rows with `needs_split = true` as an informational line that never fails the run, since the spec's rule is that cutover never blocks on cleansing. Make the line loud enough to be actioned — it is the admin cleanup queue's only surface today.

Verify with `cd dlms && npx tsc --noEmit`, then:

```bash
git add dlms/scripts/reconcile.ts
git commit -m "feat(manufacturing): reconcile migrated component units and installations"
```

---

## Task 4: Runbook and status board

**Files:**
- Create: `docs/runbooks/RB-08-component-migration.md`
- Modify: `docs/superpowers/PROGRESS.md`

- [ ] **Step 1: Read the existing runbook**

Run: `cd dlms && cat docs/runbooks/RB-07-demo-migration.md`

Match its structure, headings and level of detail. Do not invent a different format.

- [ ] **Step 2: Write RB-08**

It must cover:
- **Prerequisite:** `migrate_demo.ts` has been run against this data and reconciled. `migrate_components.ts` exits non-zero if any legacy device is missing its platform counterpart, and that is the signal it was not.
- **Environment:** `LEGACY_DATABASE_URL` (read-only) and `DATABASE_URL`, exactly as RB-07 describes them.
- **Run:** `npm run migrate:components`, then `npm run reconcile`.
- **What it writes:** one `component_unit` per distinct PCBA-A/PCBA-B serial, one open `component_installation` per populated group per device, `installed_at` = the device's legacy creation time. Nothing else. It never writes to legacy and never creates a device.
- **Re-running is safe** and reports only what it newly wrote.
- **The cleanup queue:** what `needs_split = true` means, why ranged and prose serials are carried verbatim rather than split or dropped, and that working the queue is a separate manual task the migration deliberately does not block on.
- **The screen is batch-tracked** and why — a reader finding a `hmi_screen` installation with no unit row must be able to learn here that it is intentional.
- **Rollback:** `component_installation` is append-only and guarded, so there is no in-app undo. State plainly that rolling back means restoring the platform database from the pre-migration snapshot, and that the snapshot must be taken before the run.

- [ ] **Step 3: Update PROGRESS.md**

Change the legacy component-data migration row from ⏳ to ✅ with a short factual note: what it produces, that it is idempotent and reconciled, that ranged and prose serials are carried verbatim with `needs_split = true` as an admin cleanup queue, and that the HMI screen is migrated batch-form because legacy has no screen serial. Update the "Last updated" date.

Record honestly in the same row that **the script has not been run against real legacy data** — no `LEGACY_DATABASE_URL` exists in this environment — exactly as the demo-migration row does. Building it and running it are separate milestones; do not let the row imply the fleet has been migrated.

- [ ] **Step 4: Verify and commit**

```bash
cd dlms && npm test && npm run test:integration && npx tsc --noEmit
```

All three green, with real output pasted into the completion report.

```bash
git add dlms/docs/runbooks/RB-08-component-migration.md dlms/docs/superpowers/PROGRESS.md
git commit -m "docs(manufacturing): runbook for the legacy component-data migration"
```

---

## Deferred, and deliberately so

- **Working the `needs_split` queue** — an admin screen that lets someone split a ranged unit into N units and reassign installations. The migration's job is to make the queue visible and never block on it.
- **Legacy `service_event` → `repair`/`modification`** — a different spec §15 row, with its own keyword-triage rules.
- **Screens becoming serialized** — once screens carry serials, `hmi_screen` installations should migrate from batch-form to real units. `tracking_mode` is already `serialized`, so the replacement path is ready; the data is not.
- **Running it against the real fleet** — needs a read-only `LEGACY_DATABASE_URL`, which does not exist in this environment. Same blocker as the demo migration.
