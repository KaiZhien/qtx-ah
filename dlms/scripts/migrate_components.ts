// Legacy component back-fill (spec §15): reads the ten flattened component
// columns off the legacy DLMS `device` table and normalizes them into
// component_unit + component_installation rows on the platform.
//
// This is the SECOND half of the demo migration and runs strictly AFTER
// scripts/migrate_demo.ts — it back-fills components onto devices that script
// already created and never creates a device itself. Device identity was
// decided there (ids preserved verbatim, ranged serials refused); this script
// only hangs parts off those rows. See docs/runbooks/RB-07-demo-migration.md.
//
// Safety: reads the legacy project over a READ-ONLY connection string
// (LEGACY_DATABASE_URL) and writes only to the platform project (DATABASE_URL).
// It never writes to DLMS.

import { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { withTransaction, type Tx } from '@/lib/db/tx'
import {
  mapLegacyComponents,
  type ComponentInstallDraft,
} from '@/modules/manufacturing/domain/legacyComponents'

const BATCH_SIZE = 500

/** The catalogue codes seeded by 20260720000001_platform_components.sql. */
const TYPE_CODES = ['pcba_a', 'pcba_b', 'hmi_screen'] as const

/** Exactly the columns this script reads — the ten component fields plus identity. */
type LegacyComponentSource = {
  id: string
  pcba_a_sn: string | null
  pcba_a_hw_rev: string | null
  pcba_a_bom_rev: string | null
  pcba_a_fw_ver: string | null
  pcba_b_sn: string | null
  pcba_b_hw_rev: string | null
  pcba_b_bom_rev: string | null
  pcba_b_fw_ver: string | null
  screen_model: string | null
  hmi_ver: string | null
  created_at: Date
}

export type MigrateComponentsResult = {
  devicesSeen: number
  unitsCreated: number
  installsCreated: number
  missingDevices: string[]
  flaggedSerials: Array<{ deviceId: string; typeCode: string; serialNo: string }>
}

const LEGACY_SELECT_COLUMNS = `id,
       pcba_a_sn, pcba_a_hw_rev, pcba_a_bom_rev, pcba_a_fw_ver,
       pcba_b_sn, pcba_b_hw_rev, pcba_b_bom_rev, pcba_b_fw_ver,
       screen_model, hmi_ver, created_at`

/**
 * Resolves the three component_type ids ONCE, before the row loop. They are a
 * fixed, admin-managed catalogue of three rows — re-resolving per device would
 * turn one query into one-per-row for a value that cannot change mid-run.
 *
 * A missing code throws rather than skipping that component group: the
 * catalogue is seeded by the same migration that creates the tables, so a gap
 * means the platform schema is not fully applied, and silently migrating two
 * of the three component families would look like a successful run.
 */
async function loadComponentTypeIds(platformPool: Pool): Promise<Record<string, string>> {
  const { rows } = await platformPool.query<{ code: string; id: string }>(
    `SELECT code, id FROM component_type WHERE code = ANY($1)`, [[...TYPE_CODES]])
  const byCode: Record<string, string> = {}
  for (const r of rows) byCode[r.code] = r.id
  const missing = TYPE_CODES.filter((c) => !byCode[c])
  if (missing.length > 0) {
    throw new Error(
      `component_type is missing ${missing.join(', ')} — apply ` +
      `20260720000001_platform_components.sql first.`)
  }
  return byCode
}

/**
 * Which of `ids` already exist as platform devices, in ONE round trip.
 *
 * Deliberately not filtered by deleted_at: migrate_demo.ts carries a legacy
 * row's soft-delete state verbatim, and a soft-deleted device still has the
 * components it was built with. Excluding it here would report a device that
 * genuinely migrated as "missing" and fail the run on data that is correct.
 */
async function existingDeviceIds(platformPool: Pool, ids: string[]): Promise<Set<string>> {
  const { rows } = await platformPool.query<{ id: string }>(
    `SELECT id FROM device WHERE id = ANY($1::uuid[])`, [ids])
  return new Set(rows.map((r) => r.id))
}

/**
 * Inserts a component unit, or returns the id of the one that is already there.
 *
 * ON CONFLICT must restate `WHERE deleted_at IS NULL` because component_unit_sn
 * is a PARTIAL unique index — without the predicate Postgres cannot infer which
 * index the clause means and rejects the statement outright.
 *
 * DO NOTHING returns no row when the unit already exists, which happens two
 * legitimate ways: a re-run, and two devices whose legacy rows carry the same
 * serial for the same component type. Both mean "this physical part is already
 * on record" — so the existing id is looked up and reused rather than a second
 * unit being created. A second unit would be a duplicate identity for one
 * physical board, which is exactly what the unique index exists to prevent.
 */
async function upsertUnit(
  tx: Tx,
  typeId: string,
  draft: NonNullable<ComponentInstallDraft['unit']>,
  actorId: string,
): Promise<{ id: string; created: number }> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO component_unit (
       component_type_id, serial_no, hw_rev, bom_rev, fw_ver,
       disposition, needs_split, created_by, updated_by
     ) VALUES ($1,$2,$3,$4,$5,'installed',$6,$7,$7)
     ON CONFLICT (component_type_id, serial_no) WHERE deleted_at IS NULL DO NOTHING
     RETURNING id`,
    [typeId, draft.serialNo, draft.hwRev, draft.bomRev, draft.fwVer, draft.needsSplit, actorId],
  )
  if (inserted.rows.length > 0) {
    return { id: inserted.rows[0].id, created: inserted.rowCount ?? 0 }
  }

  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM component_unit
      WHERE component_type_id = $1 AND serial_no = $2 AND deleted_at IS NULL`,
    [typeId, draft.serialNo])
  if (existing.rows.length === 0) {
    throw new Error(
      `component_unit insert for ${draft.typeCode} "${draft.serialNo}" conflicted but no live ` +
      `row could be found — the unique index or the row's deleted_at changed underneath this run.`)
  }
  return { id: existing.rows[0].id, created: 0 }
}

/**
 * Migrates legacy component columns in batches of BATCH_SIZE ordered by
 * (created_at, id) — the compound key (not created_at alone) avoids skipping or
 * repeating rows when several legacy devices share a timestamp, the same idiom
 * migrate_demo.ts and deviceReadService.ts use. One withTransaction per batch.
 *
 * A legacy device with no platform counterpart is COLLECTED, not created. Device
 * creation belongs to migrate_demo.ts alone; a device missing here means that
 * script has not been run against this data (or was run against different data),
 * and inventing a bare device row to hang components off would produce a device
 * with no serial, status, or audit history. main() exits non-zero on any such
 * row rather than reporting a silently partial migration as a success.
 *
 * Everything is ON CONFLICT DO NOTHING and `rowCount` is what gets summed — never
 * the number of rows attempted — so a re-run reports only what it newly inserted
 * rather than every row it merely re-attempted. That count is the operator's
 * evidence the back-fill is complete; overstating it would hide a gap.
 *
 * NOTE — no `SET LOCAL session_replication_role = 'replica'` here, and that
 * asymmetry with migrate_demo.ts is deliberate. That script suppresses audit
 * triggers because it copies the legacy audit_log verbatim, so letting fn_audit
 * fire would double-write every device's history. Components never existed as
 * rows in DLMS — they were columns — so there is no legacy component audit to
 * copy, and these INSERTs are genuine NEW platform history that must be
 * attributed to the migration actor. Leaving the triggers firing is the whole
 * point: it is the only record of where these units came from. Do not "fix"
 * this into consistency with the sibling script.
 */
export async function migrateComponents(
  legacyPool: Pool, platformPool: Pool, actorId: string,
): Promise<MigrateComponentsResult> {
  const typeIds = await loadComponentTypeIds(platformPool)

  const result: MigrateComponentsResult = {
    devicesSeen: 0, unitsCreated: 0, installsCreated: 0, missingDevices: [], flaggedSerials: [],
  }
  let cursor: { createdAt: Date; id: string } | null = null

  for (;;) {
    // sql/params are resolved BEFORE the call (rather than inlining the ternary as
    // the call's argument) so the compiler doesn't have to jointly resolve this
    // generic call's type together with `cursor`'s reassignment later in this same
    // loop body — inlined, tsc reports rows as circularly self-referential (TS7022).
    // Same reasoning as migrate_demo.ts's two paginated loops.
    const sql: string = cursor
      ? `SELECT ${LEGACY_SELECT_COLUMNS}
           FROM device WHERE (created_at, id) > ($1, $2)
          ORDER BY created_at ASC, id ASC LIMIT $3`
      : `SELECT ${LEGACY_SELECT_COLUMNS}
           FROM device ORDER BY created_at ASC, id ASC LIMIT $1`
    const params: unknown[] = cursor ? [cursor.createdAt, cursor.id, BATCH_SIZE] : [BATCH_SIZE]
    const { rows }: { rows: LegacyComponentSource[] } =
      await legacyPool.query<LegacyComponentSource>(sql, params)
    if (rows.length === 0) break

    result.devicesSeen += rows.length

    // One existence query per BATCH, not per row: the whole point of paging is
    // to keep the round trips proportional to batches rather than devices.
    const present = await existingDeviceIds(platformPool, rows.map((r) => r.id))

    const work: Array<{ deviceId: string; drafts: ComponentInstallDraft[] }> = []
    for (const row of rows) {
      if (!present.has(row.id)) {
        result.missingDevices.push(row.id)
        continue
      }
      const drafts = mapLegacyComponents({
        deviceId: row.id,
        createdAt: row.created_at,
        pcbaASn: row.pcba_a_sn,
        pcbaAHwRev: row.pcba_a_hw_rev,
        pcbaABomRev: row.pcba_a_bom_rev,
        pcbaAFwVer: row.pcba_a_fw_ver,
        pcbaBSn: row.pcba_b_sn,
        pcbaBHwRev: row.pcba_b_hw_rev,
        pcbaBBomRev: row.pcba_b_bom_rev,
        pcbaBFwVer: row.pcba_b_fw_ver,
        screenModel: row.screen_model,
        hmiVer: row.hmi_ver,
      })
      if (drafts.length > 0) work.push({ deviceId: row.id, drafts })
    }

    if (work.length > 0) {
      await withTransaction(actorId, async (tx) => {
        for (const { deviceId, drafts } of work) {
          for (const draft of drafts) {
            const typeId = typeIds[draft.typeCode]
            let unitId: string | null = null

            if (draft.unit) {
              // Reported on every run, not only the run that created the unit:
              // this list IS the admin cleanup queue, and a re-run must still
              // show the operator which serials nobody has cleaned up yet.
              if (draft.unit.needsSplit) {
                result.flaggedSerials.push({
                  deviceId, typeCode: draft.typeCode, serialNo: draft.unit.serialNo,
                })
              }
              const unit = await upsertUnit(tx, typeId, draft.unit, actorId)
              unitId = unit.id
              result.unitsCreated += unit.created
            }

            // The unit lands first so the installation can reference its id.
            // ON CONFLICT restates `WHERE removed_at IS NULL` for the same
            // reason upsertUnit does: one_open_install is a partial index and
            // inference fails without its predicate. installed_at comes from
            // the draft (the legacy device's created_at), never now() — these
            // parts went in when the device was built, and dating them to the
            // migration would erase the only install date the fleet has.
            //
            // The conflict target is the OPEN installation, so idempotency
            // holds for the cases that matter: a plain re-run, and a re-run
            // after a component was replaced (the replacement row is open, so
            // nothing is inserted). The one case it does not cover is a
            // component removed and NOT replaced after the migration — a later
            // re-run would re-open the original installation, because there is
            // no open row to conflict with. Re-run this script before the
            // migrated fleet is in service, not after (RB-07).
            const install = await tx.query(
              `INSERT INTO component_installation (
                 device_id, component_type_id, component_unit_id, batch_no,
                 installed_at, installed_by, notes, created_by
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$6)
               ON CONFLICT (device_id, component_type_id, slot_no)
                 WHERE removed_at IS NULL DO NOTHING`,
              [deviceId, typeId, unitId, draft.batchNo, draft.installedAt, actorId, draft.notes],
            )
            result.installsCreated += install.rowCount ?? 0
          }
        }
      })
    }

    const last: LegacyComponentSource = rows[rows.length - 1]
    cursor = { createdAt: last.created_at, id: last.id }
    if (rows.length < BATCH_SIZE) break
  }

  return result
}

export async function main(): Promise<void> {
  const legacyUrl = process.env.LEGACY_DATABASE_URL
  const platformUrl = process.env.DATABASE_URL
  if (!legacyUrl) throw new Error('LEGACY_DATABASE_URL is required (read-only connection to the old DLMS project)')
  if (!platformUrl) throw new Error('DATABASE_URL is required (the platform project)')

  // Read-only at the application level: this script only ever SELECTs from
  // legacyPool. (The connection string itself should also be provisioned
  // read-only in Postgres — see the runbook.)
  const legacyPool = new Pool({ connectionString: legacyUrl, max: 5 })
  const platformPool = new Pool({ connectionString: platformUrl, max: 5 })

  try {
    const superAdmin = await platformPool.query<{ id: string }>(
      `SELECT au.id FROM app_user au JOIN role r ON r.id = au.role_id
        WHERE r.key = 'super_admin' ORDER BY au.created_at LIMIT 1`)
    const actorId = superAdmin.rows[0]?.id
    if (!actorId) throw new Error('No super_admin app_user found on the platform project to attribute the migration to')

    console.log('Migrating components...')
    const result = await migrateComponents(legacyPool, platformPool, actorId)
    console.log(`Legacy devices seen:   ${result.devicesSeen}`)
    console.log(`Component units:       ${result.unitsCreated}`)
    console.log(`Installations:         ${result.installsCreated}`)

    if (result.flaggedSerials.length > 0) {
      // Not an error: spec §15 requires the cutover to carry these verbatim and
      // let a human clean them up afterwards, never to block on data cleansing.
      console.warn(`Serials flagged for review (${result.flaggedSerials.length}) — needs_split is set on each:`)
      for (const f of result.flaggedSerials) {
        console.warn(`  device ${f.deviceId}: ${f.typeCode} = "${f.serialNo}"`)
      }
    }

    if (result.missingDevices.length > 0) {
      console.error(
        `Legacy devices with no platform counterpart (${result.missingDevices.length}) — ` +
        `run migrate_demo.ts against this same legacy data FIRST, then re-run this ` +
        `(safe: ON CONFLICT DO NOTHING):`)
      for (const id of result.missingDevices) console.error(`  ${id}`)
      // Non-zero exit, not a warning: every one of these is a device whose
      // components were silently dropped. A run that exits 0 having skipped
      // devices reads as a complete migration and nobody looks again.
      process.exitCode = 1
    }
  } finally {
    await legacyPool.end()
    await platformPool.end()
  }
}

// Only run main() when this file is executed directly (npm run migrate:components),
// not when imported for its exports by the test suite. Compared via
// import.meta.url (not require.main, which doesn't exist once this file is
// loaded as ESM by vitest/vite-node) against argv so a plain import — as the
// test suite does — never triggers a live database connection.
const isDirectRun = (() => {
  try {
    return !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()

if (isDirectRun) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
