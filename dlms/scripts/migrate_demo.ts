// Demo data migration (Task 14, spec §15): copies devices + audit history from the
// old DLMS project into the platform project so the July-31 demo shows a real
// fleet rather than synthetic rows. This is the ANCESTOR of the week-10 rehearsed
// production cutover script, not the cutover itself — see docs/runbooks/RB-07-demo-migration.md.
//
// Safety: reads the legacy project over a READ-ONLY connection string
// (LEGACY_DATABASE_URL) and writes only to the platform project (DATABASE_URL).
// It never writes to DLMS.

import { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { withTransaction } from '@/lib/db/tx'

/**
 * Legacy status → platform status (spec §15).
 *
 * Both the LIVE production codes and the drifted seed codes are handled, because
 * prod uses "In Stock"/"Under Repair"/"Shipped" while seed.sql says
 * "Stock"/"Repair" — a documented drift that has bitten before.
 *
 * Unknown values throw. A migration that guesses is a migration that silently
 * corrupts a fleet: the operator must see the unknown value and decide.
 */
const STATUS_MAP: Record<string, string> = {
  'In Stock': 'in_stock',
  'Stock': 'in_stock',
  'Under Repair': 'under_repair',
  'Repair': 'under_repair',
  'Shipped': 'shipped',
  'Delivered': 'delivered',
  'Retired': 'retired',
  'Lost': 'scrapped',
}

export function mapStatus(legacy: string): string {
  const mapped = STATUS_MAP[legacy?.trim()]
  if (!mapped) {
    throw new Error(
      `Unknown legacy status: "${legacy}". Add it to STATUS_MAP and re-run — do not guess.`)
  }
  return mapped
}

export type LegacyDevice = {
  id: string
  device_sn: string | null
  pcba_a_sn: string | null
  product_name: string | null
  model_no: string | null
  status: string
  phase: string | null
  customer: string | null
  destination: string | null
  remarks: string | null
  build_date: Date | null
  ship_date: Date | null
  created_at: Date
}

export type PlatformDevice = {
  id: string
  device_sn: string | null
  device_sn_normalized: string | null
  pcba_a_sn_legacy: string | null
  variant_id: string
  status: string
  phase: string | null
  product_name: string | null
  model_no: string | null
  customer: string | null
  destination: string | null
  remarks: string | null
  build_date: Date | null
  ship_date: Date | null
  needs_data_review: boolean
  created_at: Date
  created_by: string
  updated_by: string
}

/** Matches the trigger-maintained normalization: lowercase, strip spaces and dashes. */
const normalize = (sn: string | null): string | null =>
  sn ? sn.toLowerCase().replace(/[\s-]/g, '') : null

/** A serial holding a range or list ("0001 to 0015", "0001, 0002") describes many devices in one row. */
const isRangedSerial = (sn: string | null): boolean =>
  !!sn && /\b(to|~|-{2,}|,)\b|\bto\b/i.test(sn)

/**
 * Legacy phase → platform phase_option code. Legacy phase_option.code is
 * proper-case English (dlms/supabase/seed.sql: 'Production', 'Validation',
 * 'Rework', 'Pilot', 'EOL'); the platform's ported vocabulary
 * (20260719000001_platform_devices.sql) is snake_case ('production', ...,
 * 'end_of_life') — the SAME kind of drift mapStatus handles, on a different
 * column. Legacy device.phase is NOT NULL, so without this every device
 * insert fails its device_phase_fkey (found by running the mapper against a
 * seeded legacy table locally, not by a brief-provided test).
 *
 * Unlike mapStatus this never throws: phase is a ported-for-fidelity field
 * with no UI consumer until week 3 (CLAUDE.md), not the device's operational
 * identity — an unrecognized value degrades to NULL (the platform column is
 * nullable) rather than blocking migration of the row's serial/status/audit
 * history over metadata nothing reads yet.
 */
const PHASE_MAP: Record<string, string> = {
  'Production': 'production',
  'Validation': 'validation',
  'Rework': 'rework',
  'Pilot': 'pilot',
  'EOL': 'end_of_life',
}
const mapPhase = (legacy: string | null): string | null =>
  legacy ? PHASE_MAP[legacy.trim()] ?? null : null

/**
 * Maps one legacy device row.
 *
 * The device UUID is preserved verbatim — audit_log rows reference it, and
 * spec D21 requires the trail to read continuously across the cutover.
 *
 * Ranged serials are carried VERBATIM into pcba_a_sn_legacy with
 * needs_data_review = true rather than split into N devices. Splitting would
 * invent device identities the business never assigned, and the cutover must not
 * block on data cleansing (spec §15) — the flag becomes an admin cleanup queue.
 */
export function mapDeviceRow(
  row: LegacyDevice, variantIds: Record<string, string>, actorId: string,
): PlatformDevice {
  const isPro = /\bpro\b/i.test(row.product_name ?? '')
  const ranged = isRangedSerial(row.pcba_a_sn)
  const hasNoSerial = !row.device_sn && !row.pcba_a_sn?.trim()

  return {
    id: row.id,
    device_sn: row.device_sn,
    device_sn_normalized: normalize(row.device_sn),
    pcba_a_sn_legacy: row.pcba_a_sn,
    variant_id: isPro ? variantIds.pro : variantIds.basic,
    status: mapStatus(row.status),
    phase: mapPhase(row.phase),
    product_name: row.product_name,
    model_no: row.model_no,
    customer: row.customer,
    destination: row.destination,
    remarks: row.remarks,          // bilingual, multiline — never touched
    build_date: row.build_date,
    ship_date: row.ship_date,
    needs_data_review: ranged || hasNoSerial,
    created_at: row.created_at,
    created_by: actorId,
    updated_by: actorId,
  }
}

// ===========================================================================
// Runner — reads the legacy project read-only, writes only to the platform
// project. Not exercised by the mapping unit tests above; verified by manual
// local run (see docs/runbooks/RB-07-demo-migration.md) since no real legacy
// credentials exist in this environment.
// ===========================================================================

const BATCH_SIZE = 500

type LegacyAuditRow = {
  id: string
  table_name: string
  row_id: string | null
  action: string
  actor_id: string | null
  old_values: unknown
  new_values: unknown
  changed_columns: string[] | null
  occurred_at: Date
}

type MappingFailure = { id: string; status: string; error: string }

/**
 * Loads platform variant ids by code, keyed the way mapDeviceRow expects
 * (variantIds.basic / variantIds.pro).
 */
async function loadVariantIds(platformPool: Pool): Promise<Record<string, string>> {
  const { rows } = await platformPool.query<{ code: string; id: string }>(
    `SELECT code, id FROM device_variant`)
  const byCode: Record<string, string> = {}
  for (const r of rows) byCode[r.code] = r.id
  if (!byCode.basic || !byCode.pro) {
    throw new Error(
      `device_variant is missing 'basic' and/or 'pro' — apply 20260719000001_platform_devices.sql first.`)
  }
  return byCode
}

/**
 * Builds an email → platform app_user.id map so legacy audit_log.actor_id can be
 * remapped to the corresponding platform user. Legacy and platform app_user
 * rows have DIFFERENT ids (they are different tables in different projects) —
 * email is the only stable join key across the cutover.
 */
async function loadActorMapByEmail(
  legacyPool: Pool, platformPool: Pool,
): Promise<Map<string, string>> {
  const legacy = await legacyPool.query<{ id: string; email: string }>(
    `SELECT id, email FROM app_user`)
  const platform = await platformPool.query<{ id: string; email: string }>(
    `SELECT id, email FROM app_user`)
  const platformByEmail = new Map(platform.rows.map((r) => [r.email.toLowerCase(), r.id]))
  const legacyIdToPlatformId = new Map<string, string>()
  for (const row of legacy.rows) {
    const platformId = platformByEmail.get(row.email.toLowerCase())
    if (platformId) legacyIdToPlatformId.set(row.id, platformId)
  }
  return legacyIdToPlatformId
}

/** Name fn_attach_audit('device') gives the trigger (20260718000001_platform_audit.sql:170). */
const DEVICE_AUDIT_TRIGGER = 'trg_audit_device'

/**
 * Migrates device rows in batches of BATCH_SIZE ordered by (created_at, id) —
 * the compound key (not created_at alone) avoids skipping or repeating rows
 * when several legacy devices share a timestamp, same idiom as
 * deviceReadService.ts's keyset pagination. One withTransaction per batch.
 * Mapping failures (unknown statuses) are collected rather than aborting the
 * whole run — a single bad row must not block the other N-1 that are fine;
 * the operator resolves the list at the end.
 *
 * ON CONFLICT (id) DO NOTHING makes the whole migration re-runnable: a second
 * run after fixing STATUS_MAP only inserts what's still missing.
 *
 * trg_audit_device is disabled for the duration of this batch loop. Without
 * this, every INSERT below would ALSO fire fn_audit and manufacture a brand
 * new "insert" audit_log row (dated now(), attributed to whoever ran the
 * migration) for every device — a synthetic event that never happened,
 * sitting alongside the real history migrateAuditLog copies verbatim below.
 * That would double-count every device's audit trail and permanently break
 * reconcile.ts's audit_log row-count check. Re-enabled in the finally clause
 * regardless of outcome, and this must run OUTSIDE the batches' transactions
 * (ALTER TABLE is not something we want tied to a batch's commit/rollback).
 */
async function migrateDevices(
  legacyPool: Pool, platformPool: Pool, variantIds: Record<string, string>, actorId: string,
): Promise<{ migrated: number; failures: MappingFailure[] }> {
  const failures: MappingFailure[] = []
  let migrated = 0
  let cursor: { createdAt: Date; id: string } | null = null

  await platformPool.query(`ALTER TABLE device DISABLE TRIGGER ${DEVICE_AUDIT_TRIGGER}`)
  try {
    for (;;) {
      // sql/params are resolved BEFORE the call (rather than inlining the ternary as
      // the call's argument) so the compiler doesn't have to jointly resolve this
      // generic call's type together with `cursor`'s reassignment later in this same
      // loop body — inlined, tsc reports rows as circularly self-referential (TS7022).
      const sql: string = cursor
        ? `SELECT id, device_sn, pcba_a_sn, product_name, model_no, status, phase,
                  customer, destination, remarks, build_date, ship_date, created_at
             FROM device WHERE (created_at, id) > ($1, $2)
            ORDER BY created_at ASC, id ASC LIMIT $3`
        : `SELECT id, device_sn, pcba_a_sn, product_name, model_no, status, phase,
                  customer, destination, remarks, build_date, ship_date, created_at
             FROM device ORDER BY created_at ASC, id ASC LIMIT $1`
      const params: unknown[] = cursor ? [cursor.createdAt, cursor.id, BATCH_SIZE] : [BATCH_SIZE]
      const { rows }: { rows: LegacyDevice[] } = await legacyPool.query<LegacyDevice>(sql, params)
      if (rows.length === 0) break

      const mapped: PlatformDevice[] = []
      for (const row of rows) {
        try {
          mapped.push(mapDeviceRow(row, variantIds, actorId))
        } catch (err) {
          failures.push({ id: row.id, status: row.status, error: (err as Error).message })
        }
      }

      if (mapped.length > 0) {
        // rowCount (not mapped.length) is what's actually summed: ON CONFLICT DO
        // NOTHING returns rowCount 0 for a row already present, so a re-run after
        // fixing STATUS_MAP reports only what it newly inserted, not every row it
        // merely re-attempted — the runtime/count this produces is the first real
        // data point for the week-10 cutover window and must not overstate itself.
        await withTransaction(actorId, async (tx) => {
          for (const d of mapped) {
            const result = await tx.query(
              `INSERT INTO device (
                 id, device_sn, device_sn_normalized, pcba_a_sn_legacy, variant_id, status,
                 phase, product_name, model_no, customer, destination, remarks,
                 build_date, ship_date, needs_data_review, created_at, created_by, updated_by
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
               ON CONFLICT (id) DO NOTHING`,
              [d.id, d.device_sn, d.device_sn_normalized, d.pcba_a_sn_legacy, d.variant_id, d.status,
                d.phase, d.product_name, d.model_no, d.customer, d.destination, d.remarks,
                d.build_date, d.ship_date, d.needs_data_review, d.created_at, d.created_by, d.updated_by],
            )
            migrated += result.rowCount ?? 0
          }
        })
      }

      const last: LegacyDevice = rows[rows.length - 1]
      cursor = { createdAt: last.created_at, id: last.id }
      if (rows.length < BATCH_SIZE) break
    }
  } finally {
    await platformPool.query(`ALTER TABLE device ENABLE TRIGGER ${DEVICE_AUDIT_TRIGGER}`)
  }

  return { migrated, failures }
}

/**
 * Copies audit_log rows verbatim — same ids, same occurred_at — so the trail
 * reads continuously across the cutover (spec D21). actor_id is remapped via
 * the email-matched user map; an actor with no match on the platform side is
 * left NULL rather than guessed, same philosophy as mapStatus.
 *
 * Scoped to table_name = 'device': legacy audit_log also covers tables this
 * task never migrates (warranty, extracted_device_draft, filter_presets, ...),
 * whose row_id values reference legacy rows with no platform counterpart.
 * Copying those would be noise at best and dangling references at worst.
 */
async function migrateAuditLog(
  legacyPool: Pool, actorMap: Map<string, string>, actorId: string,
): Promise<number> {
  let copied = 0
  let cursor: { occurredAt: Date; id: string } | null = null

  for (;;) {
    // See the identical comment in migrateDevices above: sql/params are resolved
    // before the call rather than inlined, to avoid a circular-type false positive.
    const sql: string = cursor
      ? `SELECT id, table_name, row_id, action, actor_id, old_values, new_values,
                changed_columns, occurred_at
           FROM audit_log WHERE table_name = 'device' AND (occurred_at, id) > ($1, $2)
          ORDER BY occurred_at ASC, id ASC LIMIT $3`
      : `SELECT id, table_name, row_id, action, actor_id, old_values, new_values,
                changed_columns, occurred_at
           FROM audit_log WHERE table_name = 'device'
          ORDER BY occurred_at ASC, id ASC LIMIT $1`
    const params: unknown[] = cursor ? [cursor.occurredAt, cursor.id, BATCH_SIZE] : [BATCH_SIZE]
    const { rows }: { rows: LegacyAuditRow[] } = await legacyPool.query<LegacyAuditRow>(sql, params)
    if (rows.length === 0) break

    await withTransaction(actorId, async (tx) => {
      for (const r of rows) {
        const mappedActor = r.actor_id ? actorMap.get(r.actor_id) ?? null : null
        const result = await tx.query(
          `INSERT INTO audit_log (
             id, table_name, row_id, action, actor_id, old_values, new_values,
             changed_columns, occurred_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO NOTHING`,
          [r.id, r.table_name, r.row_id, r.action, mappedActor, r.old_values, r.new_values,
            r.changed_columns, r.occurred_at],
        )
        copied += result.rowCount ?? 0
      }
    })

    const last: LegacyAuditRow = rows[rows.length - 1]
    cursor = { occurredAt: last.occurred_at, id: last.id }
    if (rows.length < BATCH_SIZE) break
  }

  return copied
}

export async function main(): Promise<void> {
  // This is the demo migration script, not the rehearsed production cutover
  // (week 10). Refusing to run in production keeps the two paths from ever
  // being confused — a demo-data copy against the real production platform
  // database would be catastrophic.
  if (process.env.APP_ENV === 'production') {
    throw new Error(
      'migrate_demo.ts refuses to run with APP_ENV=production — this is the demo script, not the cutover.')
  }

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
    const variantIds = await loadVariantIds(platformPool)
    const superAdmin = await platformPool.query<{ id: string }>(
      `SELECT au.id FROM app_user au JOIN role r ON r.id = au.role_id
        WHERE r.key = 'super_admin' ORDER BY au.created_at LIMIT 1`)
    const actorId = superAdmin.rows[0]?.id
    if (!actorId) throw new Error('No super_admin app_user found on the platform project to attribute the migration to')

    console.log('Migrating devices...')
    const { migrated, failures } = await migrateDevices(legacyPool, platformPool, variantIds, actorId)
    console.log(`Devices migrated: ${migrated}`)
    if (failures.length > 0) {
      console.error(`Mapping failures (${failures.length}) — resolve and re-run (safe: ON CONFLICT DO NOTHING):`)
      for (const f of failures) console.error(`  device ${f.id}: status="${f.status}" — ${f.error}`)
    }

    console.log('Migrating audit_log...')
    const actorMap = await loadActorMapByEmail(legacyPool, platformPool)
    const auditCopied = await migrateAuditLog(legacyPool, actorMap, actorId)
    console.log(`Audit log rows copied: ${auditCopied}`)

    if (failures.length > 0) {
      process.exitCode = 1
    }
  } finally {
    await legacyPool.end()
    await platformPool.end()
  }
}

// Only run main() when this file is executed directly (npm run migrate:demo),
// not when imported for its pure exports by the test suite. Compared via
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
