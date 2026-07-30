# Manufacturing Bulk Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Manager/Admin upload a PCBA traceability spreadsheet (`.xlsx` or `.csv`) and turn it into platform `device` + `component_unit` + `component_installation` rows, through a staged, reviewable, resumable batch.

**Architecture:** Three stages, matching spec §7.5 (*"Import confirm (per draft row) → device/units/installations + audit (row-level, resumable batch)"*).
1. **Parse** — the file is parsed *server-side only*; bilingual headers are auto-mapped, ranged serials (`"…0001 to 0015"`) are expanded into one draft row per unit, and every row is validated. The result is persisted as an `import_batch` + N `import_row` staging rows. The client never round-trips parsed data, which closes the tamper hole in the legacy importer.
2. **Review** — a page shows valid / invalid / needs-review rows. The needs-review queue holds rows whose serial notation could not be auto-expanded; a human fixes the row in place or skips it.
3. **Commit** — one `withTransaction` **per row**, so a partial batch is a legitimate resting state and re-running commit resumes where it stopped. Each committed row stamps its `device_id` onto the staging row inside the same transaction.

**Tech Stack:** Next.js 14 App Router (server actions), TypeScript, Zod, ExcelJS (already a dependency), node-postgres via `lib/db/tx.ts`, Supabase Postgres, Vitest (unit + dockerized-PG integration).

**Out of scope (separate follow-up plan):** the *legacy component-data migration* (DLMS `device.pcba_*` columns → `component_unit`/`installation` rows for already-migrated devices). It reuses this plan's `modules/manufacturing/domain/` mappers but reads from the legacy database rather than a spreadsheet, and it back-fills existing devices instead of creating new ones. Do not attempt it here.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **TDD is mandatory.** Write the failing test, run it, watch it fail, then implement. Never write implementation first.
- **Module boundary:** code lives under `modules/manufacturing/`. It may import `modules/shared/*` and `lib/*`; it must not import another module's tables. Cross-module work goes through the other module's service.
- **Pure domain, impure services.** Anything in `modules/manufacturing/domain/` does **no I/O** — no DB, no `fetch`, no `Date.now()` unless injected. All decision logic lives there and is unit-tested. Services do I/O and orchestrate.
- **Service function shape, in this exact order:** (1) `authorize(actor, '<permission>', 'manufacturing')` as the first line — it throws, it never returns a boolean; (2) `const data = <zodSchema>.parse(input)`; (3) `return withTransaction(actor.id, async (tx) => { … })`. Extra permission checks belong *inside* the transaction so a throw rolls the whole thing back.
- **Server actions:** every `'use server'` file under `app/(platform)/` must use `requireAal2Actor()` and must **never** use bare `requireActor()`. `__tests__/actionAalPinning.test.ts` walks the tree and will fail the build otherwise. Actions never throw — they return a discriminated `{ ok: true, data } | { ok: false, error }` and map errors through a local `toMessage()` that never leaks internals.
- **Pages gate with 404, not 403:** `const actor = await requireActor(); if (!can(actor, '<perm>', 'manufacturing')) notFound()` (spec §7.3).
- **Permission for this subsystem is `import_data`** — already in `modules/shared/authz/catalog.ts` and `supabase/seed/platform_seed.sql`, granted to `super_admin`, `admin`, `manager`. Do **not** add a new permission. This subsystem is `import_data`'s first platform consumer.
- **Migrations:** filename `<14-digit timestamp>_platform_<subject>.sql`. The `platform_` token is load-bearing — `__tests__/integration/setup.ts` selects migrations by `/^\d{14}_platform_.*\.sql$/`. Every new table gets audit columns + `version`, `SELECT fn_attach_audit('<table>')` unless explicitly exempted below, and `ENABLE ROW LEVEL SECURITY` with **no policy** (deny-via-REST). Committing the file deploys nothing — it is applied to cloud via the Supabase MCP `apply_migration`.
- **Status is never invented.** A device's status must exist in `status_option`. The import path may seat a device at a non-initial status (see Task 5's documented deviation) but must always write the matching `device_status_history` row.
- **Serials are never synthesized.** If a component group has no serial in the sheet, no `component_unit` row is created for it.
- **Verbatim preservation:** `remarks` is never trimmed (it is bilingual, multiline). Raw cell values are stored on the staging row so a reviewer can always see what the sheet actually said.
- **Commits:** one commit per task, message style `feat(manufacturing): …` / `test(manufacturing): …` / `fix(manufacturing): …`. **Never** add a `Co-Authored-By` trailer — every commit is authored solely by Reet Mitra (CLAUDE.md hard rule).
- **Verification before any completion claim:** `cd dlms && npm test`, `npm run test:integration`, `npm run type-check`, `npm run build` — paste real output, never assert green from memory.

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `supabase/migrations/20260730000000_platform_manufacturing_import.sql` | `import_batch` + `import_row` staging tables |
| `modules/manufacturing/domain/sheetValues.ts` | Pure cell coercion: serial normalization, sheet-date parsing |
| `modules/manufacturing/domain/serialRange.ts` | Pure range expansion + A/B pairing |
| `modules/manufacturing/domain/importMapping.ts` | Pure header aliasing, row validation, device+component draft shape |
| `modules/manufacturing/services/importParseService.ts` | File bytes → staged batch (ExcelJS/CSV, I/O) |
| `modules/manufacturing/services/importCommitService.ts` | Staged batch → devices/units/installations (per-row tx) |
| `app/(platform)/manufacturing/import/page.tsx` | Upload screen |
| `app/(platform)/manufacturing/import/actions.ts` | Server actions for upload/commit/skip/cancel |
| `app/(platform)/manufacturing/import/[batchId]/page.tsx` | Review + commit screen |
| `components/manufacturing/ImportUploadForm.tsx` | Client: file picker + variant default |
| `components/manufacturing/ImportReviewTable.tsx` | Client: valid/invalid/needs-review tabs |
| `components/manufacturing/ImportCommitPanel.tsx` | Client: commit button, progress loop |
| `__tests__/platform/manufacturing/sheetValues.test.ts` | Unit |
| `__tests__/platform/manufacturing/serialRange.test.ts` | Unit |
| `__tests__/platform/manufacturing/importMapping.test.ts` | Unit |
| `__tests__/platform/manufacturing/importActions.test.ts` | Unit (action authz + shape) |
| `__tests__/integration/importParseService.test.ts` | Integration (dockerized PG) |
| `__tests__/integration/importCommitService.test.ts` | Integration (dockerized PG) |

**Modify:**

| Path | Change |
|---|---|
| `app/(platform)/manufacturing/page.tsx` | Add an "Import" card, gated on `import_data` |
| `dlms/docs/superpowers/PROGRESS.md` | Flip the bulk-import row to ✅ |

**Do not touch:** `lib/services/importService.ts`, `lib/services/excelImportService.ts`, `lib/domain/*`, `app/legacy/*`. The legacy importer keeps working against the legacy `device` table; this is a parallel platform subsystem, not a refactor of it. Porting means *copying the proven logic into the platform module*, not importing across the legacy/platform boundary.

---

## Task 1: Staging schema

**Files:**
- Create: `supabase/migrations/20260730000000_platform_manufacturing_import.sql`
- Test: `__tests__/integration/importParseService.test.ts` (schema assertions only in this task)

**Interfaces:**
- Consumes: existing `device`, `device_variant`, `app_user`, `fn_attach_audit`.
- Produces: tables `import_batch`, `import_row` with the exact columns below. Tasks 4 and 5 write to them.

- [ ] **Step 1: Write the failing test**

Create `__tests__/integration/importParseService.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
})
afterAll(async () => { await db.end(); await getPool().end() })

describe('import staging schema', () => {
  it('creates import_batch and import_row', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('import_batch','import_row')
        ORDER BY table_name`)
    expect(rows.map((r) => r.table_name)).toEqual(['import_batch', 'import_row'])
  })

  it('enforces the batch/source_row_no/unit_no uniqueness of a staged row', async () => {
    const userId = (await db.query(
      `SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
    const variantId = (await db.query(
      `SELECT id FROM device_variant WHERE code='pro'`)).rows[0].id
    const batchId = (await db.query<{ id: string }>(
      `INSERT INTO import_batch (source_filename, source_sha256, source_kind,
                                 default_variant_id, created_by, updated_by)
       VALUES ('t.xlsx', repeat('a', 64), 'xlsx', $1, $2, $2) RETURNING id`,
      [variantId, userId])).rows[0].id

    const insert = () => db.query(
      `INSERT INTO import_row (batch_id, source_row_no, unit_no, raw, created_by)
       VALUES ($1, 5, 1, '{}'::jsonb, $2)`, [batchId, userId])

    await insert()
    await expect(insert()).rejects.toThrow(/import_row_unique/)
    await db.query(`DELETE FROM import_batch WHERE id=$1`, [batchId])
  })

  it('cascades row deletion when a batch is deleted', async () => {
    const userId = (await db.query(
      `SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
    const variantId = (await db.query(
      `SELECT id FROM device_variant WHERE code='pro'`)).rows[0].id
    const batchId = (await db.query<{ id: string }>(
      `INSERT INTO import_batch (source_filename, source_sha256, source_kind,
                                 default_variant_id, created_by, updated_by)
       VALUES ('t2.xlsx', repeat('b', 64), 'xlsx', $1, $2, $2) RETURNING id`,
      [variantId, userId])).rows[0].id
    await db.query(
      `INSERT INTO import_row (batch_id, source_row_no, unit_no, raw, created_by)
       VALUES ($1, 1, 1, '{}'::jsonb, $2)`, [batchId, userId])
    await db.query(`DELETE FROM import_batch WHERE id=$1`, [batchId])
    const { rows } = await db.query(`SELECT 1 FROM import_row WHERE batch_id=$1`, [batchId])
    expect(rows).toHaveLength(0)
  })

  it('rejects an unknown row status', async () => {
    const userId = (await db.query(
      `SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
    const variantId = (await db.query(
      `SELECT id FROM device_variant WHERE code='pro'`)).rows[0].id
    const batchId = (await db.query<{ id: string }>(
      `INSERT INTO import_batch (source_filename, source_sha256, source_kind,
                                 default_variant_id, created_by, updated_by)
       VALUES ('t3.xlsx', repeat('c', 64), 'xlsx', $1, $2, $2) RETURNING id`,
      [variantId, userId])).rows[0].id
    await expect(db.query(
      `INSERT INTO import_row (batch_id, source_row_no, unit_no, raw, status, created_by)
       VALUES ($1, 1, 1, '{}'::jsonb, 'bogus', $2)`, [batchId, userId]))
      .rejects.toThrow(/import_row_status/)
    await db.query(`DELETE FROM import_batch WHERE id=$1`, [batchId])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dlms && npm run test:integration -- importParseService`
Expected: FAIL — `relation "import_batch" does not exist` (the first test returns `[]`, not `['import_batch','import_row']`).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260730000000_platform_manufacturing_import.sql`:

```sql
-- ===========================================================================
-- Manufacturing: bulk-import staging (spec §7.5 "Import confirm (per draft
-- row) | draft → device/units/installations + audit (row-level, resumable
-- batch)", §4.1 Manufacturing → Import).
--
-- Two tables. import_batch is one uploaded file. import_row is one prospective
-- device: a sheet row that carried a ranged serial fans out to N import_rows,
-- distinguished by unit_no.
--
-- Parsing happens server-side and lands here BEFORE anything is committed, so
-- the client never round-trips parsed data back for commit (the tamper hole in
-- the legacy lib/services/importService.ts path).
--
-- Belongs to the `qtx-ops-platform` project. Carries the platform_ token so
-- __tests__/integration/setup.ts picks it up; committing this file does
-- nothing by itself until applied via the Supabase MCP/CLI to the cloud
-- project.
-- ===========================================================================

CREATE TABLE import_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_filename text NOT NULL,
  source_sha256 text NOT NULL,            -- content hash; surfaced so a re-upload is recognisable
  source_kind text NOT NULL
    CONSTRAINT import_batch_kind CHECK (source_kind IN ('xlsx','csv')),
  -- Every device needs a variant and the traceability sheet has no variant
  -- column, so the uploader picks one for the file. An optional per-row
  -- Variant column overrides it (see importMapping.ts).
  default_variant_id uuid NOT NULL REFERENCES device_variant(id),
  status text NOT NULL DEFAULT 'draft'
    CONSTRAINT import_batch_status CHECK (status IN ('draft','committing','committed','cancelled')),
  row_count integer NOT NULL DEFAULT 0,
  unmapped_headers jsonb NOT NULL DEFAULT '[]'::jsonb,  -- sheet columns we ignored, shown to the reviewer
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  version integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE import_batch IS
  'One uploaded spreadsheet, staged for review before commit (spec §7.5). Never the system of record — device is.';
COMMENT ON COLUMN import_batch.status IS
  'draft = staged, awaiting review; committing = a commit pass is running; committed = no valid rows remain; cancelled = abandoned by the uploader.';

CREATE TABLE import_row (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  source_row_no integer NOT NULL,          -- 1-based row number in the sheet, for "row 42 says…"
  unit_no integer NOT NULL DEFAULT 1,      -- 1..N when one sheet row's serial range fanned out
  raw jsonb NOT NULL,                      -- mapped-but-unvalidated cell values, verbatim
  parsed jsonb,                            -- ImportDeviceDraft; NULL unless status='valid'
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'valid'
    CONSTRAINT import_row_status
    CHECK (status IN ('valid','invalid','needs_review','committed','skipped','failed')),
  device_id uuid REFERENCES device(id),    -- set in the same tx that creates the device
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id)
);
COMMENT ON TABLE import_row IS
  'One prospective device from a staged import. Deliberately NOT audit-attached: it is transient staging (a 5000-row file would otherwise write 5000+ audit_log rows), and the durable record — the created device and its components — carries its own audit trail. import_batch IS audited, so who imported what is never lost.';
COMMENT ON COLUMN import_row.status IS
  'valid = ready to commit; invalid = failed validation; needs_review = serial notation a human must resolve; committed = device created (device_id set); skipped = duplicate or deliberately excluded; failed = commit attempt errored, retryable.';
COMMENT ON COLUMN import_row.unit_no IS
  'A sheet row reading "…0001 to 0015" expands to 15 import_rows sharing source_row_no with unit_no 1..15.';

CREATE UNIQUE INDEX import_row_unique ON import_row(batch_id, source_row_no, unit_no);
CREATE INDEX import_row_batch_status ON import_row(batch_id, status);

-- Audit: batch only, by design (see the import_row table comment).
SELECT fn_attach_audit('import_batch');

ALTER TABLE import_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_row   ENABLE ROW LEVEL SECURITY;
-- No policy on either table: deny-via-REST. All access is through the
-- service-role write path in modules/manufacturing/services/import*.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dlms && npm run test:integration -- importParseService`
Expected: PASS, 4 tests.

- [ ] **Step 5: Apply to cloud and commit**

Apply via the Supabase MCP `apply_migration` against project `qtx-ops-platform` (name: `platform_manufacturing_import`, the SQL above verbatim). Then confirm the advisor is clean — `get_advisors` with `type: "security"` must not report `rls_disabled` for either new table.

```bash
git add dlms/supabase/migrations/20260730000000_platform_manufacturing_import.sql dlms/__tests__/integration/importParseService.test.ts
git commit -m "feat(manufacturing): import_batch + import_row staging schema"
```

---

## Task 2: Pure sheet-value and serial-range domain

Ported from the proven legacy modules (`lib/domain/normalize.ts`, `lib/domain/serialRange.ts`) into the manufacturing module. Copy the logic; do not import across the legacy boundary.

**Files:**
- Create: `modules/manufacturing/domain/sheetValues.ts`
- Create: `modules/manufacturing/domain/serialRange.ts`
- Test: `__tests__/platform/manufacturing/sheetValues.test.ts`
- Test: `__tests__/platform/manufacturing/serialRange.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normalizeSerial(value: string | null | undefined): string`
  - `parseSheetDate(value: string | null | undefined): string | null` (throws `Error` on malformed input)
  - `expandSerialRange(raw: string | null | undefined): { serials: string[] } | { error: string }`
  - `pairSerialRanges(pcbaA: string, pcbaB: string | null | undefined): { units: Array<{ pcbaA: string; pcbaB: string | null }> } | { error: string }`

  Note the shape change from legacy: `pairSerialRanges` returns camelCase `{ pcbaA, pcbaB }`, not snake_case `{ pcba_a_sn, pcba_b_sn }`. Task 3 depends on the camelCase form.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/platform/manufacturing/sheetValues.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { normalizeSerial, parseSheetDate } from '@/modules/manufacturing/domain/sheetValues'

describe('normalizeSerial', () => {
  it('uppercases and trims', () => {
    expect(normalizeSerial('  ee-02a-2603-0001 ')).toBe('EE-02A-2603-0001')
  })
  it('returns empty string for nullish or empty input', () => {
    expect(normalizeSerial(null)).toBe('')
    expect(normalizeSerial(undefined)).toBe('')
    expect(normalizeSerial('')).toBe('')
    expect(normalizeSerial('   ')).toBe('')
  })
})

describe('parseSheetDate', () => {
  it('passes ISO through', () => {
    expect(parseSheetDate('2026-03-14')).toBe('2026-03-14')
  })
  it('converts DD/MM/YYYY to ISO', () => {
    expect(parseSheetDate('14/3/2026')).toBe('2026-03-14')
    expect(parseSheetDate('01/12/2026')).toBe('2026-12-01')
  })
  it('returns null for blank input', () => {
    expect(parseSheetDate(null)).toBeNull()
    expect(parseSheetDate('   ')).toBeNull()
  })
  it('rejects an impossible calendar day', () => {
    expect(() => parseSheetDate('31/02/2026')).toThrow(/day 31 out of range/)
  })
  it('accepts a real leap day and rejects a fake one', () => {
    expect(parseSheetDate('29/02/2024')).toBe('2024-02-29')
    expect(() => parseSheetDate('29/02/2026')).toThrow(/out of range/)
  })
  it('rejects an out-of-range month', () => {
    expect(() => parseSheetDate('01/13/2026')).toThrow(/month 13 out of range/)
  })
  it('rejects an unrecognised format', () => {
    expect(() => parseSheetDate('March 14 2026')).toThrow(/Invalid date format/)
  })
})
```

Create `__tests__/platform/manufacturing/serialRange.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { expandSerialRange, pairSerialRanges } from '@/modules/manufacturing/domain/serialRange'

describe('expandSerialRange', () => {
  it('returns no serials for blank input', () => {
    expect(expandSerialRange('')).toEqual({ serials: [] })
    expect(expandSerialRange(null)).toEqual({ serials: [] })
  })
  it('returns a single normalized serial when there is no range', () => {
    expect(expandSerialRange(' ee-02a-2603-0001 ')).toEqual({ serials: ['EE-02A-2603-0001'] })
  })
  it('expands a range, zero-padding to the widest endpoint', () => {
    const r = expandSerialRange('EE-02A-2603-0008 to 0011')
    expect(r).toEqual({ serials: [
      'EE-02A-2603-0008', 'EE-02A-2603-0009', 'EE-02A-2603-0010', 'EE-02A-2603-0011',
    ] })
  })
  it('rejects ambiguous notation rather than guessing', () => {
    expect(expandSerialRange('SN-1 and SN-2')).toEqual({
      error: 'SN-1 and SN-2 cannot be auto-expanded — fix this row manually' })
    expect(expandSerialRange('SN-1, SN-2')).toHaveProperty('error')
    expect(expandSerialRange('SN-1 & SN-2')).toHaveProperty('error')
  })
  it('rejects a backwards range', () => {
    expect(expandSerialRange('SN-0010 to 0002')).toEqual({
      error: 'Range end (2) < start (10) in: SN-0010 to 0002' })
  })
  it('rejects an absurdly large range', () => {
    expect(expandSerialRange('SN-0001 to 6000')).toEqual({
      error: 'Range too large (6000 units) — fix this row manually' })
  })
})

describe('pairSerialRanges', () => {
  it('pairs each A serial with null when B is absent', () => {
    expect(pairSerialRanges('A-0001 to 0002', null)).toEqual({ units: [
      { pcbaA: 'A-0001', pcbaB: null },
      { pcbaA: 'A-0002', pcbaB: null },
    ] })
  })
  it('zips A and B in lockstep', () => {
    expect(pairSerialRanges('A-0001 to 0002', 'B-0007 to 0008')).toEqual({ units: [
      { pcbaA: 'A-0001', pcbaB: 'B-0007' },
      { pcbaA: 'A-0002', pcbaB: 'B-0008' },
    ] })
  })
  it('refuses to pair mismatched counts', () => {
    expect(pairSerialRanges('A-0001 to 0003', 'B-0007 to 0008')).toEqual({
      error: 'PCBA-A (3) and PCBA-B (2) counts differ — fix this row manually' })
  })
  it('returns no units when A is blank', () => {
    expect(pairSerialRanges('', 'B-0001')).toEqual({ units: [] })
  })
  it('propagates an A error unprefixed and a B error prefixed', () => {
    expect(pairSerialRanges('A-1 and A-2', null)).toHaveProperty(
      'error', 'A-1 and A-2 cannot be auto-expanded — fix this row manually')
    expect(pairSerialRanges('A-0001', 'B-1 and B-2')).toHaveProperty(
      'error', 'PCBA-B: B-1 and B-2 cannot be auto-expanded — fix this row manually')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dlms && npm test -- sheetValues serialRange`
Expected: FAIL — `Failed to resolve import "@/modules/manufacturing/domain/sheetValues"`.

- [ ] **Step 3: Write the implementations**

Create `modules/manufacturing/domain/sheetValues.ts`:

```ts
/**
 * Pure cell coercion for the bulk-import path. No I/O.
 *
 * Ported from the legacy lib/domain/normalize.ts, which serves the legacy
 * device table. Deliberately a copy, not an import: the legacy module is part
 * of the frozen /legacy app and the module boundary rule forbids reaching into
 * it. Behaviour is identical so a sheet parses the same on both paths.
 */

/** Uppercase + trim. '' for nullish/blank input. */
export function normalizeSerial(value: string | null | undefined): string {
  if (value == null) return ''
  return value.trim().toUpperCase()
}

/**
 * Parse a sheet date to 'YYYY-MM-DD'. Accepts DD/MM/YYYY (the spreadsheet
 * convention in this data) and ISO passthrough. Blank → null. Anything else,
 * including calendar-impossible dates like 31/02, throws.
 */
export function parseSheetDate(value: string | null | undefined): string | null {
  if (value == null || value.trim() === '') return null
  const v = value.trim()

  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) {
    validateDateParts(parseInt(iso[3], 10), parseInt(iso[2], 10), parseInt(iso[1], 10), v)
    return v
  }

  const dmy = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (dmy) {
    const day = parseInt(dmy[1], 10)
    const month = parseInt(dmy[2], 10)
    const year = parseInt(dmy[3], 10)
    validateDateParts(day, month, year, v)
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  throw new Error(`Invalid date format: "${v}" (expected DD/MM/YYYY)`)
}

function validateDateParts(day: number, month: number, year: number, raw: string): void {
  if (month < 1 || month > 12) {
    throw new Error(`Invalid date: "${raw}" (month ${month} out of range 1–12)`)
  }
  const maxDay = new Date(year, month, 0).getDate()
  if (day < 1 || day > maxDay) {
    throw new Error(
      `Invalid date: "${raw}" (day ${day} out of range 1–${maxDay} for month ${month}/${year})`)
  }
}
```

Create `modules/manufacturing/domain/serialRange.ts`:

```ts
import { normalizeSerial } from '@/modules/manufacturing/domain/sheetValues'

/**
 * Expand a serial or serial range into individual normalized serials. No I/O.
 *
 * Ported from the legacy lib/domain/serialRange.ts (see the sheetValues.ts
 * header for why it is a copy). The guards are the point: notation this
 * function cannot read unambiguously becomes an error, and the import stages
 * that row as needs_review rather than guessing at a device's identity.
 */
export function expandSerialRange(
  raw: string | null | undefined,
): { serials: string[] } | { error: string } {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { serials: [] }

  // Ambiguity is checked before the range pattern: "A-1 and A-2" must not be
  // mistaken for anything expandable.
  if (trimmed.includes(' and ') || trimmed.includes(',') || trimmed.includes('&')) {
    return { error: `${raw} cannot be auto-expanded — fix this row manually` }
  }

  const match = trimmed.match(/^(.*?)(\d+)\s+to\s+(\d+)$/i)
  if (!match) return { serials: [normalizeSerial(trimmed)] }

  const [, prefix, startStr, endStr] = match
  const start = parseInt(startStr, 10)
  const end = parseInt(endStr, 10)
  if (end < start) return { error: `Range end (${end}) < start (${start}) in: ${raw}` }

  const count = end - start + 1
  if (count > 5000) return { error: `Range too large (${count} units) — fix this row manually` }

  const padWidth = Math.max(startStr.length, endStr.length)
  const serials: string[] = []
  for (let i = start; i <= end; i++) {
    serials.push(normalizeSerial(prefix + String(i).padStart(padWidth, '0')))
  }
  return { serials }
}

export type SerialPair = { pcbaA: string; pcbaB: string | null }

/**
 * Pair the PCBA-A and PCBA-B serial columns of one sheet row into units.
 * Lockstep: the two ranges must produce the same count, or the row is a manual
 * fix. A blank B column pairs every A serial with null.
 */
export function pairSerialRanges(
  pcbaA: string, pcbaB: string | null | undefined,
): { units: SerialPair[] } | { error: string } {
  const a = expandSerialRange(pcbaA)
  if ('error' in a) return { error: a.error }
  if (a.serials.length === 0) return { units: [] }

  if (!(pcbaB ?? '').trim()) {
    return { units: a.serials.map((s) => ({ pcbaA: s, pcbaB: null })) }
  }

  const b = expandSerialRange(pcbaB)
  if ('error' in b) return { error: `PCBA-B: ${b.error}` }

  if (a.serials.length !== b.serials.length) {
    return { error: `PCBA-A (${a.serials.length}) and PCBA-B (${b.serials.length}) counts differ — fix this row manually` }
  }
  return { units: a.serials.map((s, i) => ({ pcbaA: s, pcbaB: b.serials[i] })) }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dlms && npm test -- sheetValues serialRange`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add dlms/modules/manufacturing/domain/sheetValues.ts dlms/modules/manufacturing/domain/serialRange.ts dlms/__tests__/platform/manufacturing/sheetValues.test.ts dlms/__tests__/platform/manufacturing/serialRange.test.ts
git commit -m "feat(manufacturing): pure sheet-value and serial-range domain for import"
```

---

## Task 3: Pure column mapping and row validation

The heart of the subsystem, and entirely pure — every mapping and validation decision is unit-tested with no database in sight.

**Files:**
- Create: `modules/manufacturing/domain/importMapping.ts`
- Test: `__tests__/platform/manufacturing/importMapping.test.ts`

**Interfaces:**
- Consumes: `normalizeSerial`, `parseSheetDate` (Task 2), `pairSerialRanges` (Task 2).
- Produces:
  - `type ImportField` — the union of mappable field keys
  - `COLUMN_ALIASES: Record<string, ImportField>`
  - `resolveHeader(header: string): ImportField | null`
  - `mapHeaders(headers: string[]): { columns: Array<ImportField | null>; unmapped: string[] }`
  - `type ImportComponentDraft = { typeCode: 'pcba_a' | 'pcba_b' | 'hmi_screen'; serialNo: string; hwRev: string | null; bomRev: string | null; fwVer: string | null }`
  - `type ImportDeviceDraft = { deviceSn, variantCode, status, phase, productName, modelNo, customer, destination, remarks, buildDate, shipDate: … ; components: ImportComponentDraft[] }` (exact shape in Step 3)
  - `type ImportRowOutcome = { unitNo: number; raw: Record<string, string> } & ({ status: 'valid'; parsed: ImportDeviceDraft; errors: [] } | { status: 'invalid' | 'needs_review'; errors: string[] })`
  - `type ValidationContext = { defaultVariantCode: string; validVariantCodes: string[]; validStatusCodes: string[]; validPhaseCodes: string[] }`
  - `validateSheetRow(raw: Record<string, string>, ctx: ValidationContext): ImportRowOutcome[]`

  Task 4 calls `mapHeaders` then `validateSheetRow` per sheet row and persists the outcomes.

**Design decisions locked here (a reviewer should check these, not re-litigate them):**

1. **One sheet row can produce many outcomes.** `validateSheetRow` returns an array because a ranged serial fans out. `unitNo` is 1-based within the sheet row.
2. **Unresolvable serial notation → `needs_review`, not `invalid`.** `invalid` means the data is wrong; `needs_review` means a human must disambiguate. They are separate tabs in the UI and the review queue works the latter.
3. **HMI screens are only componentised when the sheet supplies a serial.** The legacy sheet's HMI group is `Screen Model` + `HMI Ver` with no serial, and `component_unit.serial_no` is `NOT NULL` — synthesizing an identity would be a lie. So: an optional `Screen S/N` column, when present, produces an `hmi_screen` component with `hwRev = screen_model` and `fwVer = hmi_ver`. When absent, no component is produced and the screen text is appended to `remarks` as a final `HMI: <model> / <ver>` line, so nothing is lost.
4. **Variant comes from the batch default, overridable per row** by an optional `Variant` column. The traceability sheet has no variant column but `device.variant_id` is `NOT NULL`.
5. **Status and phase are validated against the live vocabulary and never auto-created** (spec §7, §10). A blank status is fine — Task 5 seats the device at the vocabulary's initial status.
6. **`remarks` is never trimmed.** It is bilingual and multiline.

- [ ] **Step 1: Write the failing test**

Create `__tests__/platform/manufacturing/importMapping.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  resolveHeader, mapHeaders, validateSheetRow,
  type ValidationContext,
} from '@/modules/manufacturing/domain/importMapping'

const ctx: ValidationContext = {
  defaultVariantCode: 'pro',
  validVariantCodes: ['pro', 'basic'],
  validStatusCodes: ['in_production', 'in_stock', 'shipped'],
  validPhaseCodes: ['production', 'validation'],
}

const goodRow = () => ({
  pcba_a_sn: 'EE-02A-2603-0001',
  pcba_a_hw_rev: 'V1.2',
  pcba_a_bom_rev: 'B3',
  pcba_a_fw_ver: '1.0.4',
  status: 'in_stock',
  phase: 'production',
})

describe('resolveHeader', () => {
  it('matches an exact English header', () => {
    expect(resolveHeader('PCBA-A S/N')).toBe('pcba_a_sn')
  })
  it('matches a Chinese header', () => {
    expect(resolveHeader('电源板序列号')).toBe('pcba_a_sn')
  })
  it('matches a bilingual header split by newline', () => {
    expect(resolveHeader('PCBA-A S/N\n电源板序列号')).toBe('pcba_a_sn')
  })
  it('matches a bilingual header in ASCII and fullwidth parentheses', () => {
    expect(resolveHeader('Build Date (生产日期)')).toBe('build_date')
    expect(resolveHeader('Build Date（生产日期）')).toBe('build_date')
  })
  it('ignores whitespace around a header', () => {
    expect(resolveHeader('  Status  ')).toBe('status')
  })
  it('returns null for an unknown header', () => {
    expect(resolveHeader('Internal Notes')).toBeNull()
    expect(resolveHeader('')).toBeNull()
  })
})

describe('mapHeaders', () => {
  it('maps positionally and reports what it ignored', () => {
    const r = mapHeaders(['Device S/N', 'Internal Notes', 'Status'])
    expect(r.columns).toEqual(['device_sn', null, 'status'])
    expect(r.unmapped).toEqual(['Internal Notes'])
  })
})

describe('validateSheetRow — happy paths', () => {
  it('produces one valid draft with a pcba_a component', () => {
    const [out] = validateSheetRow(goodRow(), ctx)
    expect(out.status).toBe('valid')
    if (out.status !== 'valid') throw new Error('unreachable')
    expect(out.unitNo).toBe(1)
    expect(out.parsed.variantCode).toBe('pro')
    expect(out.parsed.status).toBe('in_stock')
    expect(out.parsed.components).toEqual([
      { typeCode: 'pcba_a', serialNo: 'EE-02A-2603-0001', hwRev: 'V1.2', bomRev: 'B3', fwVer: '1.0.4' },
    ])
  })

  it('fans a ranged serial out into one outcome per unit', () => {
    const outs = validateSheetRow(
      { ...goodRow(), pcba_a_sn: 'EE-02A-2603-0001 to 0003' }, ctx)
    expect(outs).toHaveLength(3)
    expect(outs.map((o) => o.unitNo)).toEqual([1, 2, 3])
    expect(outs.every((o) => o.status === 'valid')).toBe(true)
    expect(outs.map((o) => (o.status === 'valid' ? o.parsed.components[0].serialNo : null)))
      .toEqual(['EE-02A-2603-0001', 'EE-02A-2603-0002', 'EE-02A-2603-0003'])
  })

  it('pairs PCBA-B in lockstep with PCBA-A', () => {
    const outs = validateSheetRow({
      ...goodRow(),
      pcba_a_sn: 'A-0001 to 0002',
      pcba_b_sn: 'B-0005 to 0006',
      pcba_b_hw_rev: 'V2.0',
    }, ctx)
    expect(outs).toHaveLength(2)
    const second = outs[1]
    if (second.status !== 'valid') throw new Error('expected valid')
    expect(second.parsed.components).toEqual([
      { typeCode: 'pcba_a', serialNo: 'A-0002', hwRev: 'V1.2', bomRev: 'B3', fwVer: '1.0.4' },
      { typeCode: 'pcba_b', serialNo: 'B-0006', hwRev: 'V2.0', bomRev: null, fwVer: null },
    ])
  })

  it('converts sheet dates to ISO', () => {
    const [out] = validateSheetRow({ ...goodRow(), build_date: '14/3/2026' }, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.buildDate).toBe('2026-03-14')
  })

  it('leaves status null when the sheet has no status column', () => {
    const row = goodRow()
    delete (row as Partial<typeof row>).status
    const [out] = validateSheetRow(row, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.status).toBeNull()
  })

  it('takes the variant from a per-row column when present', () => {
    const [out] = validateSheetRow({ ...goodRow(), variant: 'basic' }, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.variantCode).toBe('basic')
  })

  it('preserves remarks verbatim, without trimming', () => {
    const [out] = validateSheetRow({ ...goodRow(), remarks: '  返修记录\n line 2  ' }, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.remarks).toBe('  返修记录\n line 2  ')
  })
})

describe('validateSheetRow — HMI screen handling', () => {
  it('componentises the screen when a serial is supplied', () => {
    const [out] = validateSheetRow({
      ...goodRow(), screen_sn: 'SCR-77', screen_model: 'TK-070', hmi_ver: '3.2',
    }, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.components).toContainEqual(
      { typeCode: 'hmi_screen', serialNo: 'SCR-77', hwRev: 'TK-070', bomRev: null, fwVer: '3.2' })
    expect(out.parsed.remarks).toBeNull()
  })

  it('carries the screen text into remarks when there is no screen serial', () => {
    const [out] = validateSheetRow({
      ...goodRow(), screen_model: 'TK-070', hmi_ver: '3.2',
    }, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.components.map((c) => c.typeCode)).toEqual(['pcba_a'])
    expect(out.parsed.remarks).toBe('HMI: TK-070 / 3.2')
  })

  it('appends the screen line to existing remarks', () => {
    const [out] = validateSheetRow({ ...goodRow(), remarks: 'note', screen_model: 'TK-070' }, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.remarks).toBe('note\nHMI: TK-070')
  })
})

describe('validateSheetRow — rejections', () => {
  it('marks a row invalid when the PCBA-A serial is missing', () => {
    const row = goodRow()
    delete (row as Partial<typeof row>).pcba_a_sn
    const [out] = validateSheetRow(row, ctx)
    expect(out.status).toBe('invalid')
    expect(out.errors).toContain('PCBA-A S/N is required')
  })

  it('marks a row needs_review when the serial notation is ambiguous', () => {
    const [out] = validateSheetRow({ ...goodRow(), pcba_a_sn: 'A-1 and A-2' }, ctx)
    expect(out.status).toBe('needs_review')
    expect(out.errors[0]).toMatch(/cannot be auto-expanded/)
    expect(out.unitNo).toBe(1)
  })

  it('marks a row needs_review when A and B counts differ', () => {
    const [out] = validateSheetRow(
      { ...goodRow(), pcba_a_sn: 'A-0001 to 0003', pcba_b_sn: 'B-0001 to 0002' }, ctx)
    expect(out.status).toBe('needs_review')
    expect(out.errors[0]).toMatch(/counts differ/)
  })

  it('rejects a status outside the vocabulary without auto-creating it', () => {
    const [out] = validateSheetRow({ ...goodRow(), status: 'Teleported' }, ctx)
    expect(out.status).toBe('invalid')
    expect(out.errors).toContain('Status "Teleported" is not in the vocabulary')
  })

  it('rejects a phase outside the vocabulary', () => {
    const [out] = validateSheetRow({ ...goodRow(), phase: 'Nope' }, ctx)
    expect(out.status).toBe('invalid')
    expect(out.errors).toContain('Phase "Nope" is not in the vocabulary')
  })

  it('rejects an unknown variant code', () => {
    const [out] = validateSheetRow({ ...goodRow(), variant: 'deluxe' }, ctx)
    expect(out.status).toBe('invalid')
    expect(out.errors).toContain('Variant "deluxe" is not in the vocabulary')
  })

  it('reports a bad date as a row error rather than throwing', () => {
    const [out] = validateSheetRow({ ...goodRow(), ship_date: '31/02/2026' }, ctx)
    expect(out.status).toBe('invalid')
    expect(out.errors[0]).toMatch(/^Ship Date: /)
  })

  it('collects every error on the row, not just the first', () => {
    const [out] = validateSheetRow(
      { pcba_a_sn: 'A-1', status: 'Nope', phase: 'Nope' }, ctx)
    expect(out.status).toBe('invalid')
    expect(out.errors.length).toBeGreaterThanOrEqual(2)
  })

  it('returns nothing at all for a row with no serial and no content', () => {
    expect(validateSheetRow({}, ctx)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dlms && npm test -- importMapping`
Expected: FAIL — `Failed to resolve import "@/modules/manufacturing/domain/importMapping"`.

- [ ] **Step 3: Write the implementation**

Create `modules/manufacturing/domain/importMapping.ts`:

```ts
import { normalizeSerial, parseSheetDate } from '@/modules/manufacturing/domain/sheetValues'
import { pairSerialRanges } from '@/modules/manufacturing/domain/serialRange'

/** Every sheet column this importer understands. */
export type ImportField =
  | 'device_sn' | 'variant' | 'product_name' | 'model_no'
  | 'pcba_a_sn' | 'pcba_a_hw_rev' | 'pcba_a_bom_rev' | 'pcba_a_fw_ver'
  | 'pcba_b_sn' | 'pcba_b_hw_rev' | 'pcba_b_bom_rev' | 'pcba_b_fw_ver'
  | 'screen_sn' | 'screen_model' | 'hmi_ver'
  | 'build_date' | 'ship_date' | 'destination' | 'customer'
  | 'status' | 'phase' | 'remarks'

/**
 * Header → field. Ported from the legacy CSV_COLUMN_MAP (lib/domain/validation.ts)
 * and extended with `Variant` and `Screen S/N`, which the platform needs and the
 * legacy flat device table did not have.
 */
export const COLUMN_ALIASES: Record<string, ImportField> = {
  'Device S/N': 'device_sn', 'Device SN': 'device_sn', '设备序列号': 'device_sn',
  'Variant': 'variant', '变体': 'variant',
  'Product Name': 'product_name', '产品名称': 'product_name',
  'Model No.': 'model_no', 'Model No': 'model_no', '产品型号': 'model_no',

  'PCBA-A S/N': 'pcba_a_sn', 'PCBA-A SN': 'pcba_a_sn', '电源板序列号': 'pcba_a_sn',
  'PCBA-A HW Rev': 'pcba_a_hw_rev', 'HW Rev (A)': 'pcba_a_hw_rev', 'PCBA-A 硬件版本': 'pcba_a_hw_rev',
  'PCBA-A BOM Rev': 'pcba_a_bom_rev', 'BOM Rev (A)': 'pcba_a_bom_rev', 'PCBA-A BOM版本': 'pcba_a_bom_rev',
  'PCBA-A FW Ver': 'pcba_a_fw_ver', 'FW Ver (A)': 'pcba_a_fw_ver', 'PCBA-A 固件版本': 'pcba_a_fw_ver',

  'PCBA-B S/N': 'pcba_b_sn', 'PCBA-B SN': 'pcba_b_sn', '控制板序列号': 'pcba_b_sn',
  'PCBA-B HW Rev': 'pcba_b_hw_rev', 'HW Rev (B)': 'pcba_b_hw_rev', 'PCBA-B 硬件版本': 'pcba_b_hw_rev',
  'PCBA-B BOM Rev': 'pcba_b_bom_rev', 'BOM Rev (B)': 'pcba_b_bom_rev', 'PCBA-B BOM版本': 'pcba_b_bom_rev',
  'PCBA-B FW Ver': 'pcba_b_fw_ver', 'FW Ver (B)': 'pcba_b_fw_ver', 'PCBA-B 固件版本': 'pcba_b_fw_ver',

  'Screen S/N': 'screen_sn', 'Screen SN': 'screen_sn', '屏幕序列号': 'screen_sn',
  'Screen Model': 'screen_model', '屏幕型号': 'screen_model',
  'HMI Ver': 'hmi_ver', 'HMI Version': 'hmi_ver', 'HMI软件版本': 'hmi_ver',

  'Build Date': 'build_date', '生产日期': 'build_date',
  'Ship Date': 'ship_date', '出货日期': 'ship_date',
  'Destination': 'destination', '目的地': 'destination',
  'Customer': 'customer', '客户': 'customer',
  'Status': 'status', '状态': 'status',
  'Phase': 'phase', '阶段': 'phase',
  'Remarks': 'remarks', '备注': 'remarks',
}

/**
 * Resolve one header cell to a field. Real sheets carry bilingual headers as
 * "English (中文)", "English（中文）" or "English\n中文", so an exact miss is
 * retried against each newline- and parenthesis-delimited segment.
 */
export function resolveHeader(header: string): ImportField | null {
  const trimmed = header.trim()
  if (!trimmed) return null
  if (trimmed in COLUMN_ALIASES) return COLUMN_ALIASES[trimmed]

  for (const segment of trimmed.split('\n')) {
    for (const part of segment.split(/[()（）]/)) {
      const candidate = part.trim()
      if (candidate && candidate in COLUMN_ALIASES) return COLUMN_ALIASES[candidate]
    }
  }
  return null
}

/** Positional header map + the headers we ignored (shown to the reviewer). */
export function mapHeaders(headers: string[]): {
  columns: Array<ImportField | null>; unmapped: string[]
} {
  const columns = headers.map(resolveHeader)
  const unmapped = headers.filter((h, i) => columns[i] === null && h.trim() !== '')
  return { columns, unmapped }
}

export type ImportComponentDraft = {
  typeCode: 'pcba_a' | 'pcba_b' | 'hmi_screen'
  serialNo: string
  hwRev: string | null
  bomRev: string | null
  fwVer: string | null
}

export type ImportDeviceDraft = {
  deviceSn: string | null
  variantCode: string
  status: string | null        // null → seat at the vocabulary's initial status
  phase: string | null
  productName: string | null
  modelNo: string | null
  customer: string | null
  destination: string | null
  remarks: string | null
  buildDate: string | null     // YYYY-MM-DD
  shipDate: string | null      // YYYY-MM-DD
  components: ImportComponentDraft[]
}

export type ValidationContext = {
  defaultVariantCode: string
  validVariantCodes: string[]
  validStatusCodes: string[]
  validPhaseCodes: string[]
}

export type ImportRowOutcome =
  | { unitNo: number; raw: Record<string, string>; status: 'valid'; parsed: ImportDeviceDraft; errors: [] }
  | { unitNo: number; raw: Record<string, string>; status: 'invalid' | 'needs_review'; errors: string[] }

const text = (v: string | undefined): string | null => (v?.trim() ? v.trim() : null)

/**
 * Validate one sheet row, returning one outcome per physical unit.
 *
 * A row whose PCBA-A cell holds a range fans out: "…0001 to 0003" yields three
 * outcomes, each a complete device draft. Notation that cannot be expanded
 * unambiguously yields a single `needs_review` outcome — the review queue —
 * rather than a guess at a device's identity.
 */
export function validateSheetRow(
  raw: Record<string, string>, ctx: ValidationContext,
): ImportRowOutcome[] {
  const hasContent = Object.values(raw).some((v) => (v ?? '').trim() !== '')
  if (!hasContent) return []

  // Serial expansion first: it decides how many outcomes this row produces, and
  // its failures are review-queue material rather than validation errors.
  const paired = pairSerialRanges(raw.pcba_a_sn ?? '', raw.pcba_b_sn ?? null)
  if ('error' in paired) {
    return [{ unitNo: 1, raw, status: 'needs_review', errors: [paired.error] }]
  }

  // Row-level errors apply identically to every unit the row produces, so they
  // are computed once.
  const rowErrors: string[] = []

  if (paired.units.length === 0) rowErrors.push('PCBA-A S/N is required')

  const variantCode = text(raw.variant) ?? ctx.defaultVariantCode
  if (!ctx.validVariantCodes.includes(variantCode)) {
    rowErrors.push(`Variant "${variantCode}" is not in the vocabulary`)
  }

  const status = text(raw.status)
  if (status && !ctx.validStatusCodes.includes(status)) {
    rowErrors.push(`Status "${status}" is not in the vocabulary`)
  }
  const phase = text(raw.phase)
  if (phase && !ctx.validPhaseCodes.includes(phase)) {
    rowErrors.push(`Phase "${phase}" is not in the vocabulary`)
  }

  let buildDate: string | null = null
  try { buildDate = parseSheetDate(raw.build_date) }
  catch (e) { rowErrors.push(`Build Date: ${(e as Error).message}`) }
  let shipDate: string | null = null
  try { shipDate = parseSheetDate(raw.ship_date) }
  catch (e) { rowErrors.push(`Ship Date: ${(e as Error).message}`) }

  if (rowErrors.length > 0) {
    return [{ unitNo: 1, raw, status: 'invalid', errors: rowErrors }]
  }

  const screenSn = normalizeSerial(raw.screen_sn)
  const screenModel = text(raw.screen_model)
  const hmiVer = text(raw.hmi_ver)

  // remarks is preserved verbatim — bilingual, multiline, never trimmed.
  const baseRemarks = raw.remarks != null && raw.remarks !== '' ? raw.remarks : null
  // No screen serial → no component_unit (serial_no is NOT NULL and inventing an
  // identity would be a lie), so the screen text rides along on remarks instead.
  const screenNote = !screenSn && (screenModel || hmiVer)
    ? `HMI: ${[screenModel, hmiVer].filter(Boolean).join(' / ')}`
    : null
  const remarks = screenNote
    ? (baseRemarks ? `${baseRemarks}\n${screenNote}` : screenNote)
    : baseRemarks

  return paired.units.map((unit, i) => {
    const components: ImportComponentDraft[] = [{
      typeCode: 'pcba_a', serialNo: unit.pcbaA,
      hwRev: text(raw.pcba_a_hw_rev), bomRev: text(raw.pcba_a_bom_rev),
      fwVer: text(raw.pcba_a_fw_ver),
    }]
    if (unit.pcbaB) {
      components.push({
        typeCode: 'pcba_b', serialNo: unit.pcbaB,
        hwRev: text(raw.pcba_b_hw_rev), bomRev: text(raw.pcba_b_bom_rev),
        fwVer: text(raw.pcba_b_fw_ver),
      })
    }
    if (screenSn) {
      components.push({
        typeCode: 'hmi_screen', serialNo: screenSn,
        hwRev: screenModel, bomRev: null, fwVer: hmiVer,
      })
    }

    return {
      unitNo: i + 1, raw, status: 'valid' as const, errors: [] as [],
      parsed: {
        // A ranged row describes many devices but carries one device_sn cell;
        // giving every unit that same serial would collide on device_sn_unique.
        // Only an unfanned row can claim it.
        deviceSn: paired.units.length === 1 ? text(raw.device_sn) : null,
        variantCode, status, phase,
        productName: text(raw.product_name), modelNo: text(raw.model_no),
        customer: text(raw.customer), destination: text(raw.destination),
        remarks, buildDate, shipDate, components,
      },
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dlms && npm test -- importMapping`
Expected: PASS, 25 tests.

- [ ] **Step 5: Commit**

```bash
git add dlms/modules/manufacturing/domain/importMapping.ts dlms/__tests__/platform/manufacturing/importMapping.test.ts
git commit -m "feat(manufacturing): pure column mapping and import row validation"
```

---

## Task 4: Parse service — file bytes to a staged batch

**Files:**
- Create: `modules/manufacturing/services/importParseService.ts`
- Modify: `__tests__/integration/importParseService.test.ts` (append service tests to the schema tests from Task 1)

**Interfaces:**
- Consumes: `mapHeaders`, `validateSheetRow`, `ImportDeviceDraft` (Task 3); `import_batch`/`import_row` (Task 1); `withTransaction` from `@/lib/db/tx`; `authorize` from `@/modules/shared/authz/authorize`.
- Produces:
  - `class ImportParseError extends Error`
  - `type StagedBatch = { batchId: string; rowCount: number; valid: number; invalid: number; needsReview: number; unmappedHeaders: string[] }`
  - `stageImportFile(actor: Actor, input: { filename: string; kind: 'xlsx' | 'csv'; bytes: Uint8Array; defaultVariantCode: string }): Promise<StagedBatch>`

  Task 6's upload action calls `stageImportFile`. Task 5's commit service reads what it wrote.

**Notes for the implementer:**
- Parse **before** opening the transaction — ExcelJS work is slow and must not hold a DB connection.
- `bytes.buffer` is wrong when the `Uint8Array` is a view at a non-zero `byteOffset` (a real bug in the legacy path, `app/legacy/import/actions.ts:29`). Use `bytes.slice().buffer`.
- Within-batch duplicate serials become `invalid` at stage time — the second occurrence would otherwise fail at commit on `component_unit_sn`.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/integration/importParseService.test.ts` (keep the Task 1 imports; add these):

```ts
import { stageImportFile, ImportParseError } from '@/modules/manufacturing/services/importParseService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import ExcelJS from 'exceljs'

// Appended to the Task 1 file: these reuse `db` from the existing beforeAll.
const mgr = (userId: string): Actor => ({
  id: userId, roleKey: 'manager',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'import_data']),
  moduleAccess: new Set(['manufacturing']), active: true,
})
const viewer = (userId: string): Actor => ({
  id: userId, roleKey: 'viewer', permissions: new Set(['view_records']),
  moduleAccess: new Set(['manufacturing']), active: true,
})

async function sheetBytes(rows: string[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Traceability')
  rows.forEach((r) => ws.addRow(r))
  const buf = await wb.xlsx.writeBuffer()
  return new Uint8Array(buf as ArrayBuffer)
}

const HEADERS = ['Device S/N', 'PCBA-A S/N', 'PCBA-A HW Rev', 'PCBA-A BOM Rev',
                 'PCBA-A FW Ver', 'Status', 'Phase']

describe('stageImportFile', () => {
  let userId: string
  const tag = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

  beforeAll(async () => {
    userId = (await db.query(
      `SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
  })

  it('refuses an actor without import_data', async () => {
    const bytes = await sheetBytes([HEADERS, ['', `S-${tag()}`, 'V1', 'B1', '1.0', 'in_stock', 'production']])
    await expect(stageImportFile(viewer(userId), {
      filename: 'x.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })).rejects.toThrow(PermissionError)
  })

  it('stages valid rows with a parsed draft', async () => {
    const t = tag()
    const bytes = await sheetBytes([
      HEADERS,
      ['', `EE-A-${t}-0001`, 'V1.2', 'B3', '1.0.4', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'ok.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.rowCount).toBe(1)
    expect(staged.valid).toBe(1)

    const { rows } = await db.query<{ status: string; parsed: { components: unknown[] } }>(
      `SELECT status, parsed FROM import_row WHERE batch_id=$1`, [staged.batchId])
    expect(rows[0].status).toBe('valid')
    expect(rows[0].parsed.components).toHaveLength(1)
  })

  it('fans a ranged serial into one row per unit', async () => {
    const t = tag()
    const bytes = await sheetBytes([
      HEADERS,
      ['', `EE-A-${t}-0001 to 0003`, 'V1', 'B1', '1.0', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'range.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.rowCount).toBe(3)
    expect(staged.valid).toBe(3)
    const { rows } = await db.query<{ unit_no: number; source_row_no: number }>(
      `SELECT unit_no, source_row_no FROM import_row WHERE batch_id=$1 ORDER BY unit_no`,
      [staged.batchId])
    expect(rows.map((r) => r.unit_no)).toEqual([1, 2, 3])
    expect(new Set(rows.map((r) => r.source_row_no)).size).toBe(1)
  })

  it('routes unexpandable notation to needs_review', async () => {
    const bytes = await sheetBytes([
      HEADERS, ['', 'A-1 and A-2', 'V1', 'B1', '1.0', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'amb.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.needsReview).toBe(1)
    expect(staged.valid).toBe(0)
  })

  it('marks a within-batch duplicate serial invalid', async () => {
    const t = tag()
    const sn = `EE-A-${t}-0009`
    const bytes = await sheetBytes([
      HEADERS,
      ['', sn, 'V1', 'B1', '1.0', 'in_stock', 'production'],
      ['', sn, 'V1', 'B1', '1.0', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'dupe.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.valid).toBe(1)
    expect(staged.invalid).toBe(1)
    const { rows } = await db.query<{ errors: string[] }>(
      `SELECT errors FROM import_row WHERE batch_id=$1 AND status='invalid'`, [staged.batchId])
    expect(rows[0].errors[0]).toMatch(/duplicate/i)
  })

  it('reports headers it could not map', async () => {
    const t = tag()
    const bytes = await sheetBytes([
      [...HEADERS, 'Internal Notes'],
      ['', `EE-A-${t}-0004`, 'V1', 'B1', '1.0', 'in_stock', 'production', 'ignore me'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'extra.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.unmappedHeaders).toContain('Internal Notes')
  })

  it('rejects a sheet with no recognisable header row', async () => {
    const bytes = await sheetBytes([['Colour', 'Size'], ['red', 'L']])
    await expect(stageImportFile(mgr(userId), {
      filename: 'junk.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })).rejects.toThrow(ImportParseError)
  })

  it('rejects an unknown default variant', async () => {
    const bytes = await sheetBytes([HEADERS, ['', 'A-1', 'V1', 'B1', '1.0', 'in_stock', 'production']])
    await expect(stageImportFile(mgr(userId), {
      filename: 'v.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'deluxe',
    })).rejects.toThrow(ImportParseError)
  })

  it('parses a CSV body as well as a workbook', async () => {
    const t = tag()
    const csv = `${HEADERS.join(',')}\n,EE-A-${t}-0007,V1,B1,1.0,in_stock,production\n`
    const staged = await stageImportFile(mgr(userId), {
      filename: 'x.csv', kind: 'csv', bytes: new TextEncoder().encode(csv),
      defaultVariantCode: 'pro',
    })
    expect(staged.valid).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dlms && npm run test:integration -- importParseService`
Expected: FAIL — `Failed to resolve import "@/modules/manufacturing/services/importParseService"`.

- [ ] **Step 3: Write the implementation**

Create `modules/manufacturing/services/importParseService.ts`:

```ts
import { createHash } from 'node:crypto'
import { z } from 'zod'
import ExcelJS from 'exceljs'
import { withTransaction } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import {
  mapHeaders, validateSheetRow, type ImportField, type ImportRowOutcome,
  type ValidationContext,
} from '@/modules/manufacturing/domain/importMapping'

export class ImportParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportParseError'
  }
}

export type StagedBatch = {
  batchId: string; rowCount: number
  valid: number; invalid: number; needsReview: number
  unmappedHeaders: string[]
}

const stageSchema = z.object({
  filename: z.string().min(1).max(255),
  kind: z.enum(['xlsx', 'csv']),
  // Not z.instanceof(Uint8Array): TS 5.7 parameterised the typed arrays, so that
  // form infers the narrower Uint8Array<ArrayBuffer> and rejects callers holding a
  // plain Uint8Array (or a Node Buffer). Same runtime guard, published contract
  // stays Uint8Array.
  bytes: z.custom<Uint8Array>((v) => v instanceof Uint8Array, 'Expected Uint8Array'),
  defaultVariantCode: z.string().min(1).max(50),
})
export type StageImportInput = z.input<typeof stageSchema>

// A header row is one that names a serial column — the only columns the sheet
// cannot omit. Scanning the first 10 rows tolerates the title/legend banners
// real traceability workbooks carry above the table.
const HEADER_MARKERS = ['Device S/N', '设备序列号', 'PCBA-A S/N', '电源板序列号']

/**
 * Parse an uploaded spreadsheet and stage it as an import_batch + import_rows.
 *
 * Writes no devices. Parsing happens entirely server-side and the parsed drafts
 * live in the database, so the commit step (importCommitService) re-reads them
 * rather than trusting anything the browser sends back.
 */
export async function stageImportFile(
  actor: Actor, input: StageImportInput,
): Promise<StagedBatch> {
  authorize(actor, 'import_data', 'manufacturing')
  const data = stageSchema.parse(input)

  // Parse outside the transaction — ExcelJS on a large workbook must not hold a
  // pooled connection open.
  const grid = data.kind === 'xlsx'
    ? await readWorkbook(data.bytes)
    : readCsv(new TextDecoder().decode(data.bytes))

  const headerIdx = grid.findIndex((row) =>
    row.some((cell) => HEADER_MARKERS.some((m) => cell.includes(m))))
  if (headerIdx === -1 || headerIdx > 9) {
    throw new ImportParseError(
      'Could not find a header row — the sheet needs a "Device S/N" or "PCBA-A S/N" column in its first 10 rows.')
  }

  const { columns, unmapped } = mapHeaders(grid[headerIdx])

  const ctx = await loadValidationContext(actor, data.defaultVariantCode)

  // Stage every outcome, then mark repeat serials invalid. Doing it here rather
  // than at commit means the reviewer sees the collision before committing
  // anything, instead of a row failing on component_unit_sn mid-batch.
  const staged: Array<{ sourceRowNo: number; outcome: ImportRowOutcome }> = []
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const raw: Record<string, string> = {}
    grid[r].forEach((cell, c) => {
      const field: ImportField | null = columns[c] ?? null
      if (field && cell !== '') raw[field] = cell
    })
    for (const outcome of validateSheetRow(raw, ctx)) {
      staged.push({ sourceRowNo: r + 1, outcome })  // 1-based, matches the spreadsheet
    }
  }
  markDuplicateSerials(staged)

  const sha256 = createHash('sha256').update(data.bytes).digest('hex')

  return withTransaction(actor.id, async (tx) => {
    const { rows: vRows } = await tx.query<{ id: string }>(
      `SELECT id FROM device_variant WHERE code = $1 AND active`, [data.defaultVariantCode])
    if (vRows.length === 0) {
      throw new ImportParseError(`Unknown or inactive variant: ${data.defaultVariantCode}`)
    }

    const { rows: bRows } = await tx.query<{ id: string }>(
      `INSERT INTO import_batch
         (source_filename, source_sha256, source_kind, default_variant_id,
          row_count, unmapped_headers, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
      [data.filename, sha256, data.kind, vRows[0].id, staged.length,
       JSON.stringify(unmapped), actor.id])
    const batchId = bRows[0].id

    for (const { sourceRowNo, outcome } of staged) {
      await tx.query(
        `INSERT INTO import_row
           (batch_id, source_row_no, unit_no, raw, parsed, errors, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [batchId, sourceRowNo, outcome.unitNo, JSON.stringify(outcome.raw),
         outcome.status === 'valid' ? JSON.stringify(outcome.parsed) : null,
         JSON.stringify(outcome.errors), outcome.status, actor.id])
    }

    const count = (s: string) => staged.filter((x) => x.outcome.status === s).length
    return {
      batchId, rowCount: staged.length,
      valid: count('valid'), invalid: count('invalid'), needsReview: count('needs_review'),
      unmappedHeaders: unmapped,
    }
  })
}

/**
 * Live vocabulary — statuses/phases/variants are admin-editable rows, not
 * constants. Labels travel alongside codes because real traceability sheets
 * carry human labels ("In Stock", "Production"), not the snake_case codes;
 * resolveVocab in the domain matches either.
 */
async function loadValidationContext(
  actor: Actor, defaultVariantCode: string,
): Promise<ValidationContext> {
  return withTransaction(actor.id, async (tx) => {
    const { rows: variants } = await tx.query<{ code: string; name: string }>(
      `SELECT code, name FROM device_variant WHERE active`)
    const { rows: statuses } = await tx.query<{
      code: string; label_en: string; label_zh: string }>(
      `SELECT code, label_en, label_zh FROM status_option WHERE active`)
    const { rows: phases } = await tx.query<{
      code: string; label_en: string; label_zh: string }>(
      `SELECT code, label_en, label_zh FROM phase_option WHERE active`)
    return {
      defaultVariantCode,
      variants: variants.map((v) => ({ code: v.code, labels: [v.name] })),
      statuses: statuses.map((s) => ({ code: s.code, labels: [s.label_en, s.label_zh] })),
      phases: phases.map((p) => ({ code: p.code, labels: [p.label_en, p.label_zh] })),
    }
  })
}

/**
 * Two rows claiming the same PCBA-A serial cannot both become devices — the
 * second would collide on component_unit_sn. The first wins; later ones are
 * marked invalid, naming the row that took it.
 */
function markDuplicateSerials(
  staged: Array<{ sourceRowNo: number; outcome: ImportRowOutcome }>,
): void {
  const claimed = new Map<string, number>()
  for (const entry of staged) {
    const { outcome } = entry
    if (outcome.status !== 'valid') continue
    const primary = outcome.parsed.components[0]?.serialNo
    if (!primary) continue
    const owner = claimed.get(primary)
    if (owner !== undefined) {
      entry.outcome = {
        unitNo: outcome.unitNo, raw: outcome.raw, status: 'invalid',
        errors: [`Duplicate serial "${primary}" — already claimed by sheet row ${owner}`],
      }
    } else {
      claimed.set(primary, entry.sourceRowNo)
    }
  }
}

/** Workbook → a dense string grid. Formula cells yield their computed result. */
async function readWorkbook(bytes: Uint8Array): Promise<string[][]> {
  const wb = new ExcelJS.Workbook()
  // bytes.slice() copies into a buffer whose byteOffset is 0. Passing
  // bytes.buffer directly hands ExcelJS the wrong bytes whenever the array is a
  // view into a larger allocation.
  await wb.xlsx.load(bytes.slice().buffer)
  if (wb.worksheets.length === 0) throw new ImportParseError('The workbook has no sheets.')

  const ws = wb.getWorksheet('Traceability') ?? wb.worksheets[0]
  const grid: string[][] = []
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells: string[] = []
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = cellText(cell.value)
    })
    grid[rowNumber - 1] = Array.from(cells, (c) => c ?? '')
  })
  return Array.from(grid, (r) => r ?? [])
}

function cellText(value: unknown): string {
  if (value == null) return ''
  let v: unknown = value
  if (typeof v === 'object' && v !== null && 'result' in v) {
    v = (v as { result?: unknown }).result ?? null
  }
  if (v == null) return ''
  // Dates are re-rendered as DD/MM/YYYY so parseSheetDate handles them on the
  // same path as text dates.
  if (v instanceof Date) {
    return `${String(v.getDate()).padStart(2, '0')}/${String(v.getMonth() + 1).padStart(2, '0')}/${v.getFullYear()}`
  }
  return String(v).trim()
}

/** Minimal RFC-4180 CSV reader: quoted fields, doubled quotes, embedded newlines. */
function readCsv(body: string): string[][] {
  const grid: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') { field += '"'; i++ } else { quoted = false }
      } else field += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === ',') { row.push(field.trim()); field = ''; continue }
    if (ch === '\r') continue
    if (ch === '\n') { row.push(field.trim()); grid.push(row); row = []; field = ''; continue }
    field += ch
  }
  if (field !== '' || row.length > 0) { row.push(field.trim()); grid.push(row) }
  return grid.filter((r) => r.some((c) => c !== ''))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dlms && npm run test:integration -- importParseService`
Expected: PASS, 13 tests (4 schema + 9 service).

- [ ] **Step 5: Commit**

```bash
git add dlms/modules/manufacturing/services/importParseService.ts dlms/__tests__/integration/importParseService.test.ts
git commit -m "feat(manufacturing): stage uploaded spreadsheets as reviewable import batches"
```

---

## Task 5: Commit service — staged rows to devices and components

**Files:**
- Create: `modules/manufacturing/services/importCommitService.ts`
- Test: `__tests__/integration/importCommitService.test.ts`

**Interfaces:**
- Consumes: `import_batch`/`import_row` (Task 1), `ImportDeviceDraft` (Task 3), `stageImportFile` (Task 4, for test setup), `withTransaction`, `authorize`.
- Produces:
  - `type ImportBatchSummary = { batchId: string; filename: string; status: string; defaultVariantCode: string; unmappedHeaders: string[]; counts: Record<'valid'|'invalid'|'needs_review'|'committed'|'skipped'|'failed', number> }`
  - `type ImportRowView = { id: string; sourceRowNo: number; unitNo: number; status: string; errors: string[]; raw: Record<string, string>; deviceId: string | null }`
  - `getImportBatch(actor: Actor, batchId: string): Promise<ImportBatchSummary | null>`
  - `listImportRows(actor: Actor, batchId: string, status?: string): Promise<ImportRowView[]>`
  - `commitImportBatch(actor: Actor, input: { batchId: string; limit?: number }): Promise<{ committed: number; failed: number; skipped: number; remaining: number }>`
  - `skipImportRow(actor: Actor, rowId: string): Promise<void>`
  - `cancelImportBatch(actor: Actor, batchId: string): Promise<void>`

  Task 6's actions call all six.

**Documented deviation — status seating.** `createDevice` in `deviceWriteService.ts` always seats a device at the vocabulary's initial status, because a normal creation is the start of a lifecycle. An import is different: it records devices that already exist and are already somewhere in their lifecycle. So `commitImportBatch` may seat a device directly at the sheet's status, and:
- it always writes the matching `device_status_history` row (`NULL → status`), so the history log is never bypassed — the same shape `createDevice` writes;
- a non-initial target additionally requires `change_device_status`;
- a terminal target additionally requires `delete_records`, mirroring the write path's rule;
- both checks happen **inside** the row's transaction, so a rejection rolls that row back and leaves it `failed`, not half-written.

This is the same reasoning `scripts/migrate_demo.ts` applies when it maps legacy statuses 1:1 rather than walking the graph. It is a deliberate, permission-gated exception, not a hole — the transition graph still governs every *change* after import.

- [ ] **Step 1: Write the failing test**

Create `__tests__/integration/importCommitService.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import ExcelJS from 'exceljs'
import { getPool } from '@/lib/db/pool'
import { stageImportFile } from '@/modules/manufacturing/services/importParseService'
import {
  commitImportBatch, getImportBatch, listImportRows, skipImportRow, cancelImportBatch,
} from '@/modules/manufacturing/services/importCommitService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string

const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
let seq = 0
const sn = (p: string) => `${p}-${runTag}-${String(++seq).padStart(4, '0')}`

const mgr = (): Actor => ({
  id: userId, roleKey: 'manager',
  permissions: new Set(['view_records', 'create_records', 'edit_records',
                        'change_device_status', 'import_data']),
  moduleAccess: new Set(['manufacturing']), active: true,
})
const importerNoStatus = (): Actor => ({
  id: userId, roleKey: 'manager',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'import_data']),
  moduleAccess: new Set(['manufacturing']), active: true,
})
const viewer = (): Actor => ({
  id: userId, roleKey: 'viewer', permissions: new Set(['view_records']),
  moduleAccess: new Set(['manufacturing']), active: true,
})

const HEADERS = ['PCBA-A S/N', 'PCBA-A HW Rev', 'PCBA-A BOM Rev', 'PCBA-A FW Ver',
                 'PCBA-B S/N', 'Status', 'Phase']

async function stage(rows: string[][], actor: Actor = mgr()) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Traceability')
  ;[HEADERS, ...rows].forEach((r) => ws.addRow(r))
  const bytes = new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)
  return stageImportFile(actor, {
    filename: 'batch.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
  })
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(
    `SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
})
afterAll(async () => { await db.end(); await getPool().end() })

describe('commitImportBatch', () => {
  it('refuses an actor without import_data', async () => {
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    await expect(commitImportBatch(viewer(), { batchId })).rejects.toThrow(PermissionError)
  })

  it('creates a device, its component units and open installations', async () => {
    const a = sn('A'); const b = sn('B')
    const { batchId } = await stage([[a, 'V1.2', 'B3', '1.0.4', b, 'in_stock', 'production']])
    const res = await commitImportBatch(mgr(), { batchId })
    expect(res).toMatchObject({ committed: 1, failed: 0, remaining: 0 })

    const { rows } = await db.query<{ device_id: string }>(
      `SELECT device_id FROM import_row WHERE batch_id=$1 AND status='committed'`, [batchId])
    expect(rows).toHaveLength(1)
    const deviceId = rows[0].device_id

    const units = await db.query<{ serial_no: string; type_code: string; disposition: string }>(
      `SELECT cu.serial_no, ct.code AS type_code, cu.disposition
         FROM component_installation ci
         JOIN component_unit cu ON cu.id = ci.component_unit_id
         JOIN component_type ct ON ct.id = ci.component_type_id
        WHERE ci.device_id=$1 AND ci.removed_at IS NULL
        ORDER BY ct.sort`, [deviceId])
    expect(units.rows.map((r) => r.type_code)).toEqual(['pcba_a', 'pcba_b'])
    expect(units.rows.map((r) => r.serial_no)).toEqual([a, b])
    expect(units.rows.every((r) => r.disposition === 'installed')).toBe(true)

    const unit = await db.query<{ hw_rev: string; bom_rev: string; fw_ver: string }>(
      `SELECT hw_rev, bom_rev, fw_ver FROM component_unit WHERE serial_no=$1`, [a])
    expect(unit.rows[0]).toEqual({ hw_rev: 'V1.2', bom_rev: 'B3', fw_ver: '1.0.4' })
  })

  it('seats the device at the sheet status and writes its history row', async () => {
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'shipped', 'production']])
    await commitImportBatch(mgr(), { batchId })
    const { rows } = await db.query<{ status: string; device_id: string }>(
      `SELECT d.status, d.id AS device_id FROM device d
         JOIN import_row r ON r.device_id = d.id WHERE r.batch_id=$1`, [batchId])
    expect(rows[0].status).toBe('shipped')
    const hist = await db.query<{ from_status: string | null; to_status: string }>(
      `SELECT from_status, to_status FROM device_status_history WHERE device_id=$1`,
      [rows[0].device_id])
    expect(hist.rows).toEqual([{ from_status: null, to_status: 'shipped' }])
  })

  it('seats the device at the initial status when the sheet has none', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Traceability')
    ws.addRow(['PCBA-A S/N', 'PCBA-A HW Rev'])
    ws.addRow([sn('A'), 'V1'])
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)
    const { batchId } = await stageImportFile(mgr(), {
      filename: 'nostatus.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro' })
    await commitImportBatch(mgr(), { batchId })
    const { rows } = await db.query<{ status: string }>(
      `SELECT d.status FROM device d JOIN import_row r ON r.device_id=d.id WHERE r.batch_id=$1`,
      [batchId])
    expect(rows[0].status).toBe('in_production')
  })

  it('fails a row whose non-initial status the actor may not set, without writing a device', async () => {
    const a = sn('A')
    const { batchId } = await stage([[a, 'V1', 'B1', '1.0', '', 'shipped', 'production']])
    const res = await commitImportBatch(importerNoStatus(), { batchId })
    expect(res).toMatchObject({ committed: 0, failed: 1 })
    const units = await db.query(`SELECT 1 FROM component_unit WHERE serial_no=$1`, [a])
    expect(units.rows).toHaveLength(0)   // the whole row rolled back
  })

  it('skips a row whose serial already exists in the database', async () => {
    const a = sn('A')
    const first = await stage([[a, 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    await commitImportBatch(mgr(), { batchId: first.batchId })

    const second = await stage([[a, 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    const res = await commitImportBatch(mgr(), { batchId: second.batchId })
    expect(res).toMatchObject({ committed: 0, skipped: 1 })
    const { rows } = await db.query<{ errors: string[] }>(
      `SELECT errors FROM import_row WHERE batch_id=$1`, [second.batchId])
    expect(rows[0].errors[0]).toMatch(/already exists/i)
  })

  it('is resumable: a limited pass leaves the rest committable', async () => {
    const { batchId } = await stage([
      [sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production'],
      [sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production'],
      [sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production'],
    ])
    const first = await commitImportBatch(mgr(), { batchId, limit: 2 })
    expect(first).toMatchObject({ committed: 2, remaining: 1 })
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('committing')

    const second = await commitImportBatch(mgr(), { batchId })
    expect(second).toMatchObject({ committed: 1, remaining: 0 })
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('committed')
  })

  it('never commits the same row twice', async () => {
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    await commitImportBatch(mgr(), { batchId })
    const again = await commitImportBatch(mgr(), { batchId })
    expect(again).toMatchObject({ committed: 0, remaining: 0 })
    const { rows } = await db.query(
      `SELECT 1 FROM import_row WHERE batch_id=$1 AND status='committed'`, [batchId])
    expect(rows).toHaveLength(1)
  })

  it('leaves invalid and needs_review rows alone', async () => {
    const { batchId } = await stage([
      [sn('A'), 'V1', 'B1', '1.0', '', 'Teleported', 'production'],
      ['A-1 and A-2', 'V1', 'B1', '1.0', '', 'in_stock', 'production'],
    ])
    const res = await commitImportBatch(mgr(), { batchId })
    expect(res.committed).toBe(0)
    const summary = (await getImportBatch(mgr(), batchId))!
    expect(summary.counts.invalid).toBe(1)
    expect(summary.counts.needs_review).toBe(1)
  })
})

describe('listImportRows / skipImportRow / cancelImportBatch', () => {
  it('lists rows and filters by status', async () => {
    const { batchId } = await stage([
      [sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production'],
      [sn('A'), 'V1', 'B1', '1.0', '', 'Teleported', 'production'],
    ])
    expect(await listImportRows(mgr(), batchId)).toHaveLength(2)
    const invalid = await listImportRows(mgr(), batchId, 'invalid')
    expect(invalid).toHaveLength(1)
    expect(invalid[0].errors[0]).toMatch(/not in the vocabulary/)
  })

  it('skips a row so a commit pass ignores it', async () => {
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    const [row] = await listImportRows(mgr(), batchId, 'valid')
    await skipImportRow(mgr(), row.id)
    const res = await commitImportBatch(mgr(), { batchId })
    expect(res.committed).toBe(0)
  })

  it('refuses to commit a cancelled batch', async () => {
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    await cancelImportBatch(mgr(), batchId)
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('cancelled')
    const res = await commitImportBatch(mgr(), { batchId })
    expect(res).toMatchObject({ committed: 0, remaining: 0 })
  })

  it('returns null for a batch that does not exist', async () => {
    expect(await getImportBatch(mgr(), '00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dlms && npm run test:integration -- importCommitService`
Expected: FAIL — `Failed to resolve import "@/modules/manufacturing/services/importCommitService"`.

- [ ] **Step 3: Write the implementation**

Create `modules/manufacturing/services/importCommitService.ts`:

```ts
import { z } from 'zod'
import { withTransaction, type Tx } from '@/lib/db/tx'
import { authorize, PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import type { ImportDeviceDraft } from '@/modules/manufacturing/domain/importMapping'

export type ImportRowStatus =
  'valid' | 'invalid' | 'needs_review' | 'committed' | 'skipped' | 'failed'

export type ImportBatchSummary = {
  batchId: string; filename: string; status: string
  defaultVariantCode: string; unmappedHeaders: string[]
  counts: Record<ImportRowStatus, number>
}

export type ImportRowView = {
  id: string; sourceRowNo: number; unitNo: number
  status: ImportRowStatus; errors: string[]
  raw: Record<string, string>; deviceId: string | null
}

const ZERO_COUNTS: Record<ImportRowStatus, number> = {
  valid: 0, invalid: 0, needs_review: 0, committed: 0, skipped: 0, failed: 0,
}

export async function getImportBatch(
  actor: Actor, batchId: string,
): Promise<ImportBatchSummary | null> {
  authorize(actor, 'import_data', 'manufacturing')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; source_filename: string; status: string
      variant_code: string; unmapped_headers: string[]
    }>(
      `SELECT b.id, b.source_filename, b.status, v.code AS variant_code, b.unmapped_headers
         FROM import_batch b JOIN device_variant v ON v.id = b.default_variant_id
        WHERE b.id = $1`, [batchId])
    if (rows.length === 0) return null

    const { rows: countRows } = await tx.query<{ status: ImportRowStatus; n: string }>(
      `SELECT status, count(*)::text AS n FROM import_row WHERE batch_id = $1 GROUP BY status`,
      [batchId])
    const counts = { ...ZERO_COUNTS }
    for (const r of countRows) counts[r.status] = parseInt(r.n, 10)

    return {
      batchId: rows[0].id, filename: rows[0].source_filename, status: rows[0].status,
      defaultVariantCode: rows[0].variant_code, unmappedHeaders: rows[0].unmapped_headers,
      counts,
    }
  })
}

export async function listImportRows(
  actor: Actor, batchId: string, status?: ImportRowStatus,
): Promise<ImportRowView[]> {
  authorize(actor, 'import_data', 'manufacturing')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; source_row_no: number; unit_no: number; status: ImportRowStatus
      errors: string[]; raw: Record<string, string>; device_id: string | null
    }>(
      `SELECT id, source_row_no, unit_no, status, errors, raw, device_id
         FROM import_row
        WHERE batch_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY source_row_no, unit_no
        LIMIT 2000`, [batchId, status ?? null])
    return rows.map((r) => ({
      id: r.id, sourceRowNo: r.source_row_no, unitNo: r.unit_no, status: r.status,
      errors: r.errors, raw: r.raw, deviceId: r.device_id,
    }))
  })
}

/**
 * Scoped by batch as well as row id: the caller always knows which batch it is
 * looking at, and scoping means a row id from one batch can never be skipped
 * through another batch's page.
 */
export async function skipImportRow(
  actor: Actor, batchId: string, rowId: string,
): Promise<void> {
  authorize(actor, 'import_data', 'manufacturing')
  z.string().uuid().parse(batchId)
  z.string().uuid().parse(rowId)
  await withTransaction(actor.id, async (tx) => {
    await tx.query(
      `UPDATE import_row SET status='skipped', updated_at=now()
        WHERE id=$1 AND batch_id=$2
          AND status IN ('valid','invalid','needs_review','failed')`, [rowId, batchId])
  })
}

export async function cancelImportBatch(actor: Actor, batchId: string): Promise<void> {
  authorize(actor, 'import_data', 'manufacturing')
  z.string().uuid().parse(batchId)
  await withTransaction(actor.id, async (tx) => {
    await tx.query(
      `UPDATE import_batch
          SET status='cancelled', updated_at=now(), updated_by=$1, version=version+1
        WHERE id=$2 AND status IN ('draft','committing')`, [actor.id, batchId])
  })
}

const commitSchema = z.object({
  batchId: z.string().uuid(),
  // One action call commits at most this many rows, then reports what is left
  // so the client can call again. Keeps a 5000-row file inside the server
  // action time budget without giving up per-row atomicity.
  limit: z.number().int().min(1).max(500).default(200),
})
export type CommitImportInput = z.input<typeof commitSchema>

export type CommitResult = {
  committed: number; failed: number; skipped: number; remaining: number
}

/**
 * Commit up to `limit` staged rows. One transaction PER ROW (spec §7.5), so a
 * partial batch is a legitimate resting state: a row either produces a device
 * with all its components and installations, or it produces nothing and is
 * marked failed for a retry. Re-invoking resumes with whatever is still 'valid'.
 */
export async function commitImportBatch(
  actor: Actor, input: CommitImportInput,
): Promise<CommitResult> {
  authorize(actor, 'import_data', 'manufacturing')
  authorize(actor, 'create_records', 'manufacturing')
  const data = commitSchema.parse(input)

  const batchStatus = await withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ status: string }>(
      `SELECT status FROM import_batch WHERE id=$1`, [data.batchId])
    return rows[0]?.status ?? null
  })
  if (batchStatus === null || batchStatus === 'cancelled' || batchStatus === 'committed') {
    return { committed: 0, failed: 0, skipped: 0, remaining: 0 }
  }

  const pending = await withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string; parsed: ImportDeviceDraft }>(
      `SELECT id, parsed FROM import_row
        WHERE batch_id=$1 AND status='valid' AND parsed IS NOT NULL
        ORDER BY source_row_no, unit_no LIMIT $2`, [data.batchId, data.limit])
    return rows
  })

  // Batched pre-check: serials already in the database are skipped without an
  // attempt, so an existing device never shows up as a scary "failed" row. One
  // query for the whole page of rows, not one per row. Keyed by component type
  // as well as serial, because component_unit_sn is UNIQUE(component_type_id,
  // serial_no) — the same serial under two different types is legal, and
  // matching on the serial alone would wrongly skip a legitimate row.
  const alreadyPresent = await findExistingSerials(
    actor,
    pending.flatMap((p) => p.parsed.components.map(
      (c) => ({ typeCode: c.typeCode, serialNo: c.serialNo }))))

  let committed = 0, failed = 0, skipped = 0
  for (const row of pending) {
    const clash = row.parsed.components.find(
      (c) => alreadyPresent.has(`${c.typeCode}:${c.serialNo}`))
    if (clash) {
      await markRow(actor, row.id, 'skipped',
        [`A ${clash.typeCode} component with serial "${clash.serialNo}" already exists`])
      skipped++
      continue
    }
    try {
      await commitOneRow(actor, row.id, row.parsed)
      committed++
    } catch (err) {
      await markRow(actor, row.id, 'failed', [toRowError(err)])
      failed++
    }
  }

  const remaining = await withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM import_row WHERE batch_id=$1 AND status='valid'`,
      [data.batchId])
    const n = parseInt(rows[0].n, 10)
    await tx.query(
      `UPDATE import_batch SET status=$1, updated_at=now(), updated_by=$2, version=version+1
        WHERE id=$3 AND status IN ('draft','committing')`,
      [n === 0 ? 'committed' : 'committing', actor.id, data.batchId])
    return n
  })

  return { committed, failed, skipped, remaining }
}

/**
 * One row → one device, its component units, and one open installation each —
 * atomically, including the staging row's own status stamp. If anything throws,
 * the device never existed.
 */
async function commitOneRow(
  actor: Actor, rowId: string, draft: ImportDeviceDraft,
): Promise<void> {
  await withTransaction(actor.id, async (tx) => {
    // Re-lock the staging row and re-check its status: two concurrent commit
    // passes must not both create a device for it.
    const { rows: lockRows } = await tx.query<{ status: string }>(
      `SELECT status FROM import_row WHERE id=$1 FOR UPDATE`, [rowId])
    if (lockRows.length === 0 || lockRows[0].status !== 'valid') {
      throw new Error('Row is no longer pending')
    }

    const { rows: vRows } = await tx.query<{ id: string }>(
      `SELECT id FROM device_variant WHERE code=$1 AND active`, [draft.variantCode])
    if (vRows.length === 0) throw new Error(`Unknown or inactive variant: ${draft.variantCode}`)

    const status = await resolveStatus(tx, actor, draft.status)

    const { rows: dRows } = await tx.query<{ id: string }>(
      `INSERT INTO device
         (device_sn, variant_id, status, phase, product_name, model_no, customer,
          destination, remarks, build_date, ship_date, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
      [draft.deviceSn, vRows[0].id, status, draft.phase, draft.productName,
       draft.modelNo, draft.customer, draft.destination, draft.remarks,
       draft.buildDate, draft.shipDate, actor.id])
    const deviceId = dRows[0].id

    await tx.query(
      `INSERT INTO device_status_history (device_id, from_status, to_status, changed_by)
       VALUES ($1, NULL, $2, $3)`, [deviceId, status, actor.id])

    // Components: one unit per serialized part, each installed into its own slot 1.
    for (const c of draft.components) {
      const { rows: tRows } = await tx.query<{ id: string }>(
        `SELECT id FROM component_type WHERE code=$1 AND active AND deleted_at IS NULL`,
        [c.typeCode])
      if (tRows.length === 0) throw new Error(`Unknown component type: ${c.typeCode}`)
      const typeId = tRows[0].id

      const { rows: uRows } = await tx.query<{ id: string }>(
        `INSERT INTO component_unit
           (component_type_id, serial_no, hw_rev, bom_rev, fw_ver, disposition,
            created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,'installed',$6,$6) RETURNING id`,
        [typeId, c.serialNo, c.hwRev, c.bomRev, c.fwVer, actor.id])

      await tx.query(
        `INSERT INTO component_installation
           (device_id, component_type_id, component_unit_id, slot_no, installed_by, created_by)
         VALUES ($1,$2,$3,1,$4,$4)`, [deviceId, typeId, uRows[0].id, actor.id])
    }

    await tx.query(
      `UPDATE import_row SET status='committed', device_id=$1, committed_at=now(),
              updated_at=now(), errors='[]'::jsonb
        WHERE id=$2`, [deviceId, rowId])
  })
}

/**
 * Which status the imported device is seated at.
 *
 * An import records a device that already exists somewhere in its lifecycle, so
 * unlike createDevice it may seat a non-initial status — but only with
 * change_device_status, and a terminal status also needs delete_records, which
 * mirrors the write path (deviceWriteService.changeDeviceStatus). Both checks
 * run inside the caller's transaction, so a refusal rolls the row back whole.
 * The matching device_status_history row is always written by the caller, so
 * the history log is never bypassed.
 */
async function resolveStatus(
  tx: Tx, actor: Actor, requested: string | null,
): Promise<string> {
  const { rows: initRows } = await tx.query<{ code: string }>(
    `SELECT code FROM status_option WHERE is_initial AND active ORDER BY sort_order LIMIT 1`)
  if (initRows.length === 0) throw new Error('No initial device status is configured')
  const initial = initRows[0].code
  if (!requested || requested === initial) return initial

  const { rows } = await tx.query<{ is_terminal: boolean }>(
    `SELECT is_terminal FROM status_option WHERE code=$1 AND active`, [requested])
  if (rows.length === 0) throw new Error(`Unknown or inactive status: ${requested}`)

  authorize(actor, 'change_device_status', 'manufacturing')
  if (rows[0].is_terminal) authorize(actor, 'delete_records', 'manufacturing')
  return requested
}

/**
 * Which of these (component type, serial) pairs already exist. Returns a set of
 * `typeCode:serialNo` keys. Type-scoped on purpose: component_unit_sn is
 * UNIQUE(component_type_id, serial_no), so a PCBA-B carrying the same serial as
 * an existing PCBA-A is perfectly legal and must not be skipped.
 */
async function findExistingSerials(
  actor: Actor, pairs: Array<{ typeCode: string; serialNo: string }>,
): Promise<Set<string>> {
  if (pairs.length === 0) return new Set()
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ code: string; serial_no: string }>(
      `SELECT ct.code, cu.serial_no
         FROM component_unit cu
         JOIN component_type ct ON ct.id = cu.component_type_id
        WHERE cu.deleted_at IS NULL
          AND (ct.code, cu.serial_no) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
      [pairs.map((p) => p.typeCode), pairs.map((p) => p.serialNo)])
    return new Set(rows.map((r) => `${r.code}:${r.serial_no}`))
  })
}

async function markRow(
  actor: Actor, rowId: string, status: ImportRowStatus, errors: string[],
): Promise<void> {
  await withTransaction(actor.id, async (tx) => {
    // Scoped to a still-pending row. Both callers act on a row they just read as
    // 'valid', but if a concurrent commit pass won the race and committed it,
    // this must not stamp 'failed' over that row's success.
    await tx.query(
      `UPDATE import_row SET status=$1, errors=$2, updated_at=now()
        WHERE id=$3 AND status='valid'`,
      [status, JSON.stringify(errors), rowId])
  })
}

// Row-level failures are shown to the reviewer next to the row, so they must
// name the problem without leaking connection strings or SQL.
function toRowError(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: string }).code
    if (code === '23505') return 'A record with one of these serials already exists'
    if (code === '23503') return 'References a record that no longer exists'
  }
  if (err instanceof PermissionError) {
    return "You don't have permission to import a device at that status"
  }
  if (err instanceof Error && /Unknown or inactive|No initial device status|Unknown component type/.test(err.message)) {
    return err.message
  }
  console.error(JSON.stringify({ level: 'error', msg: 'import row commit failed', err: String(err) }))
  return 'This row could not be imported. Try again, and tell Reet if it keeps happening.'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dlms && npm run test:integration -- importCommitService`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add dlms/modules/manufacturing/services/importCommitService.ts dlms/__tests__/integration/importCommitService.test.ts
git commit -m "feat(manufacturing): resumable per-row commit of staged imports"
```

---

## Task 6: Server actions and UI

**Files:**
- Create: `app/(platform)/manufacturing/import/actions.ts`
- Create: `app/(platform)/manufacturing/import/page.tsx`
- Create: `app/(platform)/manufacturing/import/[batchId]/page.tsx`
- Create: `components/manufacturing/ImportUploadForm.tsx`
- Create: `components/manufacturing/ImportReviewTable.tsx`
- Create: `components/manufacturing/ImportCommitPanel.tsx`
- Test: `__tests__/platform/manufacturing/importActions.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4 and 5; `requireAal2Actor`/`MfaRequiredError` from `@/modules/shared/auth/session`; `can` from `@/modules/shared/authz/policy`; `PermissionError` from `@/modules/shared/authz/authorize`.
- Produces:
  - `type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }`
  - `uploadImportAction(form: FormData): Promise<ActionResult<{ batchId: string }>>`
  - `commitBatchAction(input: { batchId: string; limit?: number }): Promise<ActionResult<CommitResult>>`
  - `skipRowAction(input: { batchId: string; rowId: string }): Promise<ActionResult<null>>`
  - `cancelBatchAction(input: { batchId: string }): Promise<ActionResult<null>>`

**Constraints specific to this task:**
- `actions.ts` is a `'use server'` file under `app/(platform)/`, so `__tests__/actionAalPinning.test.ts` will automatically include it: it **must** call `requireAal2Actor()` and must not mention `requireActor`.
- Cap the upload at **10 MB** and accept only `.xlsx`/`.csv`, checked server-side from the `File` itself — never trust the client-side `accept` attribute.

- [ ] **Step 1: Write the failing test**

Create `__tests__/platform/manufacturing/importActions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireAal2Actor = vi.fn()
const stageImportFile = vi.fn()
const commitImportBatch = vi.fn()
const skipImportRow = vi.fn()
const cancelImportBatch = vi.fn()
const revalidatePath = vi.fn()

vi.mock('@/modules/shared/auth/session', async () => {
  const actual = await vi.importActual<typeof import('@/modules/shared/auth/session')>(
    '@/modules/shared/auth/session')
  return { ...actual, requireAal2Actor }
})
vi.mock('@/modules/manufacturing/services/importParseService', async () => {
  const actual = await vi.importActual<
    typeof import('@/modules/manufacturing/services/importParseService')>(
    '@/modules/manufacturing/services/importParseService')
  return { ...actual, stageImportFile }
})
vi.mock('@/modules/manufacturing/services/importCommitService', () => ({
  commitImportBatch, skipImportRow, cancelImportBatch,
}))
vi.mock('next/cache', () => ({ revalidatePath }))

const actor = { id: 'u1', roleKey: 'manager', permissions: new Set(['import_data']),
                moduleAccess: new Set(['manufacturing']), active: true }

const load = () => import('@/app/(platform)/manufacturing/import/actions')

const fileForm = (name: string, size = 100) => {
  const form = new FormData()
  form.set('variantCode', 'pro')
  form.set('file', new File(['x'.repeat(size)], name, {
    type: name.endsWith('.csv') ? 'text/csv'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  return form
}

beforeEach(() => {
  vi.clearAllMocks()
  requireAal2Actor.mockResolvedValue(actor)
})

describe('uploadImportAction', () => {
  it('stages the file and returns its batch id', async () => {
    stageImportFile.mockResolvedValue({ batchId: 'b1', rowCount: 3, valid: 3,
                                        invalid: 0, needsReview: 0, unmappedHeaders: [] })
    const { uploadImportAction } = await load()
    const res = await uploadImportAction(fileForm('sheet.xlsx'))
    expect(res).toEqual({ ok: true, data: { batchId: 'b1' } })
    expect(stageImportFile).toHaveBeenCalledWith(actor, expect.objectContaining({
      filename: 'sheet.xlsx', kind: 'xlsx', defaultVariantCode: 'pro' }))
  })

  it('recognises a csv upload', async () => {
    stageImportFile.mockResolvedValue({ batchId: 'b2', rowCount: 1, valid: 1,
                                        invalid: 0, needsReview: 0, unmappedHeaders: [] })
    const { uploadImportAction } = await load()
    await uploadImportAction(fileForm('sheet.csv'))
    expect(stageImportFile).toHaveBeenCalledWith(actor, expect.objectContaining({ kind: 'csv' }))
  })

  it('rejects an unsupported file type without calling the service', async () => {
    const { uploadImportAction } = await load()
    const res = await uploadImportAction(fileForm('notes.pdf'))
    expect(res).toEqual({ ok: false, error: 'Upload a .xlsx or .csv file.' })
    expect(stageImportFile).not.toHaveBeenCalled()
  })

  it('rejects a file over 10 MB without calling the service', async () => {
    const { uploadImportAction } = await load()
    const res = await uploadImportAction(fileForm('big.xlsx', 10 * 1024 * 1024 + 1))
    expect(res.ok).toBe(false)
    expect(stageImportFile).not.toHaveBeenCalled()
  })

  it('rejects a missing file', async () => {
    const form = new FormData()
    form.set('variantCode', 'pro')
    const { uploadImportAction } = await load()
    expect((await uploadImportAction(form)).ok).toBe(false)
  })

  it('turns a permission failure into a friendly message, never a throw', async () => {
    const { PermissionError } = await import('@/modules/shared/authz/authorize')
    stageImportFile.mockRejectedValue(new PermissionError('import_data', 'manufacturing'))
    const { uploadImportAction } = await load()
    expect(await uploadImportAction(fileForm('s.xlsx')))
      .toEqual({ ok: false, error: "You don't have permission to do that." })
  })

  it('surfaces a parse failure verbatim — it is the user\'s file, not an internal', async () => {
    const { ImportParseError } = await import(
      '@/modules/manufacturing/services/importParseService')
    stageImportFile.mockRejectedValue(new ImportParseError('Could not find a header row'))
    const { uploadImportAction } = await load()
    expect(await uploadImportAction(fileForm('s.xlsx')))
      .toEqual({ ok: false, error: 'Could not find a header row' })
  })

  it('never leaks an unexpected error', async () => {
    stageImportFile.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.4:5432'))
    const { uploadImportAction } = await load()
    const res = await uploadImportAction(fileForm('s.xlsx'))
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error).not.toMatch(/ECONNREFUSED/)
  })
})

describe('commitBatchAction / skipRowAction / cancelBatchAction', () => {
  it('commits and revalidates the batch page', async () => {
    commitImportBatch.mockResolvedValue({ committed: 2, failed: 0, skipped: 0, remaining: 1 })
    const { commitBatchAction } = await load()
    const res = await commitBatchAction({ batchId: 'b1' })
    expect(res).toEqual({ ok: true, data: { committed: 2, failed: 0, skipped: 0, remaining: 1 } })
    expect(revalidatePath).toHaveBeenCalledWith('/manufacturing/import/b1')
    expect(revalidatePath).toHaveBeenCalledWith('/manufacturing/devices')
  })

  it('skips a row', async () => {
    skipImportRow.mockResolvedValue(undefined)
    const { skipRowAction } = await load()
    expect(await skipRowAction({ batchId: 'b1', rowId: 'r1' })).toEqual({ ok: true, data: null })
    expect(skipImportRow).toHaveBeenCalledWith(actor, 'r1')
  })

  it('cancels a batch', async () => {
    cancelImportBatch.mockResolvedValue(undefined)
    const { cancelBatchAction } = await load()
    expect(await cancelBatchAction({ batchId: 'b1' })).toEqual({ ok: true, data: null })
  })

  it('reports an expired MFA session in plain language', async () => {
    const { MfaRequiredError } = await import('@/modules/shared/auth/session')
    requireAal2Actor.mockRejectedValue(new MfaRequiredError())
    const { commitBatchAction } = await load()
    const res = await commitBatchAction({ batchId: 'b1' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error).toMatch(/Two-factor/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dlms && npm test -- importActions`
Expected: FAIL — cannot resolve `@/app/(platform)/manufacturing/import/actions`.

> If `MfaRequiredError` takes constructor arguments in `modules/shared/auth/session.ts`, match its real signature in the test rather than changing the class.

- [ ] **Step 3: Write the actions**

Create `app/(platform)/manufacturing/import/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireAal2Actor, MfaRequiredError } from '@/modules/shared/auth/session'
import { PermissionError } from '@/modules/shared/authz/authorize'
import {
  stageImportFile, ImportParseError,
} from '@/modules/manufacturing/services/importParseService'
import {
  commitImportBatch, skipImportRow, cancelImportBatch, type CommitResult,
} from '@/modules/manufacturing/services/importCommitService'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

const MAX_BYTES = 10 * 1024 * 1024

function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  // The user's own file is the subject of this message, so it is safe (and
  // useful) to pass it through unchanged.
  if (err instanceof ImportParseError) return err.message
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'import action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function uploadImportAction(
  form: FormData,
): Promise<ActionResult<{ batchId: string }>> {
  try {
    const actor = await requireAal2Actor()

    const file = form.get('file')
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, error: 'Choose a file to import.' }
    }
    if (file.size > MAX_BYTES) {
      return { ok: false, error: 'That file is larger than 10 MB — split it and import in parts.' }
    }
    const lower = file.name.toLowerCase()
    const kind = lower.endsWith('.xlsx') ? 'xlsx' : lower.endsWith('.csv') ? 'csv' : null
    if (kind === null) return { ok: false, error: 'Upload a .xlsx or .csv file.' }

    const variantCode = String(form.get('variantCode') ?? '').trim()
    if (!variantCode) return { ok: false, error: 'Choose the device variant for this file.' }

    const { batchId } = await stageImportFile(actor, {
      filename: file.name, kind,
      bytes: new Uint8Array(await file.arrayBuffer()),
      defaultVariantCode: variantCode,
    })
    revalidatePath('/manufacturing/import')
    return { ok: true, data: { batchId } }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function commitBatchAction(
  input: { batchId: string; limit?: number },
): Promise<ActionResult<CommitResult>> {
  try {
    const actor = await requireAal2Actor()
    const result = await commitImportBatch(actor, input)
    revalidatePath(`/manufacturing/import/${input.batchId}`)
    revalidatePath('/manufacturing/devices')
    return { ok: true, data: result }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function skipRowAction(
  input: { batchId: string; rowId: string },
): Promise<ActionResult<null>> {
  try {
    const actor = await requireAal2Actor()
    await skipImportRow(actor, input.batchId, input.rowId)
    revalidatePath(`/manufacturing/import/${input.batchId}`)
    return { ok: true, data: null }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function cancelBatchAction(
  input: { batchId: string },
): Promise<ActionResult<null>> {
  try {
    const actor = await requireAal2Actor()
    await cancelImportBatch(actor, input.batchId)
    revalidatePath(`/manufacturing/import/${input.batchId}`)
    return { ok: true, data: null }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dlms && npm test -- importActions actionAalPinning`
Expected: PASS — the new action file joins the AAL pinning suite and satisfies it.

- [ ] **Step 5: Write the pages and components**

Create `app/(platform)/manufacturing/import/page.tsx`:

```tsx
import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listVariantOptions } from '@/modules/manufacturing/services/deviceReadService'
import { ImportUploadForm } from '@/components/manufacturing/ImportUploadForm'

export const dynamic = 'force-dynamic'

export default async function ImportPage() {
  const actor = await requireActor()
  if (!can(actor, 'import_data', 'manufacturing')) notFound()

  const variants = await listVariantOptions(actor)

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Import devices</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Upload a traceability spreadsheet. Nothing is created until you review the
          rows and confirm — serial ranges like <code>…0001 to 0015</code> are expanded
          into one device each.
        </p>
      </div>
      <ImportUploadForm variants={variants} />
    </div>
  )
}
```

> `listVariantOptions(actor)` already exists in `deviceReadService.ts`. Check its exact return shape and pass it through unchanged; if it returns `{ code, name }[]`, the form prop below matches.

Create `components/manufacturing/ImportUploadForm.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { uploadImportAction } from '@/app/(platform)/manufacturing/import/actions'
import { Button } from '@/components/ui/button'

export function ImportUploadForm({ variants }: { variants: { code: string; name: string }[] }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  return (
    <form
      className="space-y-4 rounded-lg border p-4"
      action={(form) => {
        setError(null)
        startTransition(async () => {
          const res = await uploadImportAction(form)
          if (res.ok) router.push(`/manufacturing/import/${res.data.batchId}`)
          else setError(res.error)
        })
      }}
    >
      <div className="space-y-1">
        <label htmlFor="file" className="text-sm font-medium">Spreadsheet</label>
        <input id="file" name="file" type="file" required
               accept=".xlsx,.csv"
               className="block w-full text-sm" />
        <p className="text-muted-foreground text-xs">.xlsx or .csv, up to 10 MB.</p>
      </div>

      <div className="space-y-1">
        <label htmlFor="variantCode" className="text-sm font-medium">Device variant</label>
        <select id="variantCode" name="variantCode" required
                className="block w-full rounded-md border px-3 py-2 text-sm">
          {variants.map((v) => <option key={v.code} value={v.code}>{v.name}</option>)}
        </select>
        <p className="text-muted-foreground text-xs">
          Applied to every row unless the sheet has its own Variant column.
        </p>
      </div>

      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}

      <Button type="submit" disabled={pending}>
        {pending ? 'Reading the file…' : 'Upload and review'}
      </Button>
    </form>
  )
}
```

Create `app/(platform)/manufacturing/import/[batchId]/page.tsx`:

```tsx
import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import {
  getImportBatch, listImportRows,
} from '@/modules/manufacturing/services/importCommitService'
import { ImportReviewTable } from '@/components/manufacturing/ImportReviewTable'
import { ImportCommitPanel } from '@/components/manufacturing/ImportCommitPanel'

export const dynamic = 'force-dynamic'

const ROW_STATUSES = [
  'valid', 'needs_review', 'invalid', 'committed', 'skipped', 'failed',
] as const

export default async function ImportBatchPage(
  { params, searchParams }: {
    params: { batchId: string }
    searchParams: { status?: string }
  },
) {
  const actor = await requireActor()
  if (!can(actor, 'import_data', 'manufacturing')) notFound()

  const batch = await getImportBatch(actor, params.batchId)
  if (!batch) notFound()

  // One status at a time, filtered in SQL. listImportRows caps at 2000 rows, so
  // loading the whole batch and filtering client-side would silently hide rows
  // on a large file — and the counts the tabs show come from getImportBatch's
  // GROUP BY, which is exact regardless of the cap.
  const active = (ROW_STATUSES as readonly string[]).includes(searchParams.status ?? '')
    ? (searchParams.status as (typeof ROW_STATUSES)[number])
    : 'valid'
  const rows = await listImportRows(actor, params.batchId, active)

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">{batch.filename}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {batch.counts.valid} ready · {batch.counts.needs_review} need review ·{' '}
          {batch.counts.invalid} invalid · {batch.counts.committed} imported ·{' '}
          {batch.counts.skipped} skipped · {batch.counts.failed} failed
        </p>
        {batch.unmappedHeaders.length > 0 && (
          <p className="text-muted-foreground mt-1 text-xs">
            Ignored columns: {batch.unmappedHeaders.join(', ')}
          </p>
        )}
      </div>

      <ImportCommitPanel
        batchId={batch.batchId}
        status={batch.status}
        pending={batch.counts.valid}
      />
      <ImportReviewTable
        batchId={batch.batchId} rows={rows} active={active} counts={batch.counts} />
    </div>
  )
}
```

Create `components/manufacturing/ImportCommitPanel.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { commitBatchAction, cancelBatchAction } from '@/app/(platform)/manufacturing/import/actions'
import { Button } from '@/components/ui/button'

export function ImportCommitPanel(
  { batchId, status, pending }: { batchId: string; status: string; pending: number },
) {
  const [message, setMessage] = useState<string | null>(null)
  const [busy, startTransition] = useTransition()
  const router = useRouter()

  const done = status === 'committed' || status === 'cancelled'

  // Commit in pages of 200 and keep going while rows remain: one round trip per
  // page keeps each server action well inside its time budget on a large file.
  const runCommit = () => {
    setMessage(null)
    startTransition(async () => {
      let committed = 0, failed = 0, skipped = 0
      for (;;) {
        const res = await commitBatchAction({ batchId, limit: 200 })
        if (!res.ok) { setMessage(res.error); break }
        committed += res.data.committed
        failed += res.data.failed
        skipped += res.data.skipped
        if (res.data.remaining === 0 ||
            res.data.committed + res.data.failed + res.data.skipped === 0) {
          setMessage(`Imported ${committed} · skipped ${skipped} · failed ${failed}`)
          break
        }
      }
      router.refresh()
    })
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border p-4">
      <Button onClick={runCommit} disabled={busy || done || pending === 0}>
        {busy ? 'Importing…' : `Import ${pending} device${pending === 1 ? '' : 's'}`}
      </Button>
      <Button
        variant="outline"
        disabled={busy || done}
        onClick={() => startTransition(async () => {
          const res = await cancelBatchAction({ batchId })
          if (!res.ok) setMessage(res.error)
          router.refresh()
        })}
      >
        Cancel batch
      </Button>
      {message && <p className="text-sm">{message}</p>}
    </div>
  )
}
```

Create `components/manufacturing/ImportReviewTable.tsx`:

```tsx
'use client'

import { useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { skipRowAction } from '@/app/(platform)/manufacturing/import/actions'
import type { ImportRowView } from '@/modules/manufacturing/services/importCommitService'
import { Button } from '@/components/ui/button'

const TABS = [
  { key: 'valid', label: 'Ready' },
  { key: 'needs_review', label: 'Needs review' },
  { key: 'invalid', label: 'Invalid' },
  { key: 'committed', label: 'Imported' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'failed', label: 'Failed' },
] as const

export function ImportReviewTable(
  { batchId, rows, active, counts }: {
    batchId: string
    rows: ImportRowView[]
    active: string
    counts: Record<string, number>
  },
) {
  const [, startTransition] = useTransition()
  const router = useRouter()
  const shown = rows

  return (
    <div className="space-y-3">
      {/* Tabs are links, not client state: each status is a separate SQL query,
          so a 5000-row batch never has to reach the browser to be filtered. */}
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/manufacturing/import/${batchId}?status=${t.key}`}
            className={`rounded-md border px-3 py-1 text-sm ${
              active === t.key ? 'bg-muted font-medium' : ''}`}
          >
            {t.label} ({counts[t.key] ?? 0})
          </Link>
        ))}
      </div>
      {counts[active] > shown.length && (
        <p className="text-muted-foreground text-sm">
          Showing the first {shown.length} of {counts[active]} rows.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="p-2 text-left">Sheet row</th>
              <th className="p-2 text-left">PCBA-A S/N</th>
              <th className="p-2 text-left">Status</th>
              <th className="p-2 text-left">Notes</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={5} className="text-muted-foreground p-4 text-center">
                Nothing here.
              </td></tr>
            )}
            {shown.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="p-2">{r.sourceRowNo}{r.unitNo > 1 ? `.${r.unitNo}` : ''}</td>
                <td className="p-2 font-mono text-xs">{r.raw.pcba_a_sn ?? '—'}</td>
                <td className="p-2">{r.raw.status ?? '—'}</td>
                <td className="p-2">
                  {r.deviceId
                    ? <Link className="underline" href={`/manufacturing/devices/${r.deviceId}`}>
                        View device
                      </Link>
                    : r.errors.join('; ')}
                </td>
                <td className="p-2 text-right">
                  {r.status !== 'committed' && r.status !== 'skipped' && (
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => startTransition(async () => {
                        await skipRowAction({ batchId, rowId: r.id })
                        router.refresh()
                      })}
                    >
                      Skip
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Verify the whole suite and the build**

Run each and paste the real output:

```bash
cd dlms && npm test && npm run type-check && npm run build
```

Expected: unit tests all pass (≥ 891 + the ~50 added here), `type-check` exits 0, `build` succeeds and lists the two new routes `/manufacturing/import` and `/manufacturing/import/[batchId]`.

> If `Button` in `components/ui/button.tsx` has no `size="sm"` or `variant="ghost"` variant, use the variants it actually defines rather than adding new ones.

- [ ] **Step 7: Commit**

```bash
git add "dlms/app/(platform)/manufacturing/import" dlms/components/manufacturing/Import*.tsx dlms/__tests__/platform/manufacturing/importActions.test.ts
git commit -m "feat(manufacturing): import upload, review queue, and resumable commit UI"
```

---

## Task 7: Wire the entry point and update the status board

**Files:**
- Modify: `app/(platform)/manufacturing/page.tsx`
- Modify: `dlms/docs/superpowers/PROGRESS.md`

**Interfaces:**
- Consumes: the `/manufacturing/import` route (Task 6).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Read the module landing page**

Run: `cd dlms && cat "app/(platform)/manufacturing/page.tsx"`

Note how the existing cards/links are rendered and how `can(...)` gates them inline (the devices and components entries are the models to copy).

- [ ] **Step 2: Add the Import entry, gated on `import_data`**

Add a card/link to the same list the existing entries use, matching their exact markup:

```tsx
{can(actor, 'import_data', 'manufacturing') && (
  <Link href="/manufacturing/import" className={/* the same className the sibling cards use */}>
    <h2 className="font-medium">Import</h2>
    <p className="text-muted-foreground text-sm">
      Upload a traceability spreadsheet and review it before creating devices.
    </p>
  </Link>
)}
```

- [ ] **Step 3: Verify the gate renders correctly**

Run: `cd dlms && npm run build`
Expected: build succeeds. Then confirm by reading the file that the new link sits inside the same container as its siblings and is not rendered for an actor lacking `import_data`.

- [ ] **Step 4: Update PROGRESS.md**

In the Phase 2 table, change the bulk-import row from:

```
| — | Manufacturing **bulk import** (Excel/draft → devices, column mapping, dedupe, ranged-serial review queue) | ⏳ | Split out of the write path (own subsystem); pairs with the legacy component-data migration |
```

to:

```
| I1 | Manufacturing **bulk import** — server-side parse → `import_batch`/`import_row` staging → review queue → per-row resumable commit into devices + component units + installations | ✅ | 7 tasks merged; migration applied to cloud (RLS deny-via-REST, advisor clean). Bilingual column mapping, ranged-serial expansion with a needs-review queue for ambiguous notation, within-batch and DB dedupe. Parsed drafts live server-side, closing the legacy importer's client-tamper path. Deferred: fix-in-place editing of review rows, PDF/draft extraction port, import of components onto existing devices |
```

Also update the "Last updated" date at the top of PROGRESS.md to the date of the merge, and leave the *legacy component-data migration* row at ⏳ — it is the follow-up plan.

- [ ] **Step 5: Final verification and commit**

```bash
cd dlms && npm test && npm run test:integration && npm run type-check && npm run build
```

All four must be green, with real output pasted into the completion report. Then:

```bash
git add "dlms/app/(platform)/manufacturing/page.tsx" dlms/docs/superpowers/PROGRESS.md
git commit -m "feat(manufacturing): surface bulk import on the module landing page"
```

---

## Deferred, and deliberately so

Record these in PROGRESS.md's carried-findings list rather than building them here:

- **Fix-in-place editing of `needs_review` rows.** Today a reviewer skips the row and fixes the sheet. Editing a staged row's serial in the UI is a natural follow-up and needs an `updateImportRow` service with re-validation.
- **Importing components onto an *existing* device.** This importer only creates new devices. The legacy component-data migration (the follow-up plan) covers back-filling components onto the devices `scripts/migrate_demo.ts` already created.
- **The PDF/image draft-extraction pipeline** (`lib/services/invoiceExtractionService.ts` + `extracted_device_draft`) is still legacy-only. Porting it is its own task; the `import_row` staging table was designed so drafts could later land in the same review queue.
- **Batch listing page.** There is no `/manufacturing/import` history view of past batches — a user reaches a batch by its URL after uploading. One `listImportBatches` query plus a table closes it.
- **`import_row` is not audit-attached** by design (see the migration comment). If an auditor ever needs per-row provenance, the batch's audit row plus the created device's own audit trail is the intended reconstruction path.
