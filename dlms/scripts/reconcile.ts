// Reconciliation for the demo data migration (Task 14, spec §15): compares the
// legacy DLMS project against the platform project AFTER scripts/migrate_demo.ts
// has run, and exits non-zero on any mismatch so a silent partial migration
// cannot slip past CI or an operator skimming the log.
//
// Read-only against both databases — this script never writes anything.

import { Pool } from 'pg'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { mapStatus, DEVICE_AUDIT_TRIGGER } from '@/scripts/migrate_demo'

/**
 * Prints one comparison line and returns whether it matched. Threaded through
 * explicitly (not module-level mutable state) so reconcile() stays safe to
 * call more than once in the same process.
 */
function reportRow(label: string, source: unknown, target: unknown): boolean {
  const ok = source === target
  console.log(`${ok ? 'OK      ' : 'MISMATCH'}  ${label}: source=${source} target=${target}`)
  return ok
}

async function count(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(sql, params)
  return Number(rows[0].n)
}

/**
 * device row counts, unfiltered — every legacy device row is expected to
 * migrate. A mismatch here most often means unresolved mapping failures
 * (unknown statuses) that migrate_demo.ts reported and skipped — the fix is
 * to extend STATUS_MAP and re-run migrate:demo (safe: ON CONFLICT DO NOTHING).
 */
async function reconcileDeviceCounts(legacyPool: Pool, platformPool: Pool): Promise<boolean> {
  const legacyCount = await count(legacyPool, `SELECT count(*)::text AS n FROM device`)
  const platformCount = await count(platformPool, `SELECT count(*)::text AS n FROM device`)
  return reportRow('device row count', legacyCount, platformCount)
}

/**
 * device count by mapped status: groups the legacy side by mapStatus(status)
 * (the SAME function migrate_demo.ts uses, so this can never silently drift
 * from what the migration actually does) and compares against the platform
 * side's raw status grouping. A legacy status mapStatus() cannot map is
 * reported separately rather than crashing reconcile itself — those rows are
 * exactly the ones migrate_demo.ts already flagged as mapping failures.
 */
async function reconcileStatusCounts(legacyPool: Pool, platformPool: Pool): Promise<boolean> {
  const { rows: legacyRows } = await legacyPool.query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM device GROUP BY status`)

  const bySourceMappedStatus = new Map<string, number>()
  const unmapped: string[] = []
  for (const r of legacyRows) {
    try {
      const mapped = mapStatus(r.status)
      bySourceMappedStatus.set(mapped, (bySourceMappedStatus.get(mapped) ?? 0) + Number(r.n))
    } catch {
      unmapped.push(`"${r.status}" (${r.n} row${r.n === '1' ? '' : 's'})`)
    }
  }

  const { rows: targetRows } = await platformPool.query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM device GROUP BY status`)
  const byTargetStatus = new Map(targetRows.map((r) => [r.status, Number(r.n)]))

  let ok = true
  const allStatuses = new Set([...bySourceMappedStatus.keys(), ...byTargetStatus.keys()])
  for (const status of [...allStatuses].sort()) {
    const rowOk = reportRow(`device count for status "${status}"`, bySourceMappedStatus.get(status) ?? 0, byTargetStatus.get(status) ?? 0)
    ok = ok && rowOk
  }

  if (unmapped.length > 0) {
    console.log(`UNMAPPED legacy statuses excluded above (these rows failed migration — resolve and re-run): ${unmapped.join(', ')}`)
    ok = false
  }
  return ok
}

/**
 * sha256 over every row's (device_sn, legacy serial) pair, sorted, on both
 * sides. Detects silent corruption/truncation/reordering in transit — a
 * device count and status count can both match while individual serials were
 * still mangled, and this catches that. The legacy column is pcba_a_sn; its
 * platform analogue is pcba_a_sn_legacy — same value, renamed column.
 */
async function reconcileSerialHash(legacyPool: Pool, platformPool: Pool): Promise<boolean> {
  const legacyRows = (await legacyPool.query<{ k: string }>(
    `SELECT coalesce(device_sn, '') || '|' || coalesce(pcba_a_sn, '') AS k FROM device ORDER BY 1`)).rows
  const targetRows = (await platformPool.query<{ k: string }>(
    `SELECT coalesce(device_sn, '') || '|' || coalesce(pcba_a_sn_legacy, '') AS k FROM device ORDER BY 1`)).rows

  const legacyHash = createHash('sha256').update(legacyRows.map((r) => r.k).join('\n')).digest('hex')
  const targetHash = createHash('sha256').update(targetRows.map((r) => r.k).join('\n')).digest('hex')
  return reportRow('sha256(device_sn || pcba_a_sn), sorted', legacyHash, targetHash)
}

/**
 * needs_data_review has no legacy-side equivalent (it's a platform-only flag
 * set by mapDeviceRow for ranged/missing serials) — recorded for the
 * operator's awareness, never compared.
 */
async function reportNeedsReviewCount(platformPool: Pool): Promise<void> {
  const n = await count(platformPool, `SELECT count(*)::text AS n FROM device WHERE needs_data_review`)
  console.log(`INFO      needs_data_review count (target only, not compared): ${n}`)
}

/**
 * audit_log count + max(occurred_at), scoped to table_name = 'device'.
 * Unscoped totals would never match for reasons unrelated to this migration:
 * legacy audit_log also covers tables Task 14 never migrates (warranty,
 * extracted_device_draft, ...), and the platform audit_log already carries
 * its own seed-time entries for role/permission/app_user rows.
 */
async function reconcileAuditLog(legacyPool: Pool, platformPool: Pool): Promise<boolean> {
  const legacy = (await legacyPool.query<{ n: string; max_at: Date | null }>(
    `SELECT count(*)::text AS n, max(occurred_at) AS max_at FROM audit_log WHERE table_name = 'device'`)).rows[0]
  const target = (await platformPool.query<{ n: string; max_at: Date | null }>(
    `SELECT count(*)::text AS n, max(occurred_at) AS max_at FROM audit_log WHERE table_name = 'device'`)).rows[0]

  const countOk = reportRow('audit_log(device) row count', Number(legacy.n), Number(target.n))
  const legacyMax = legacy.max_at?.toISOString() ?? null
  const targetMax = target.max_at?.toISOString() ?? null
  const maxAtOk = reportRow('audit_log(device) max(occurred_at)', legacyMax, targetMax)
  return countOk && maxAtOk
}

/**
 * Defense in depth for Issue 1 (trg_audit_device residue). migrate_demo.ts's
 * device-batch suppression is transaction-scoped (SET LOCAL
 * session_replication_role) and so cannot itself leave this disabled — but
 * reconcile runs as an independent process, potentially long after
 * migrate_demo exited and by a different operator, so it re-checks from
 * scratch rather than trusting that invariant held. 'O' (fires in the
 * default/origin session mode) and 'A' (fires always) are the two enabled
 * states; 'D' (disabled) or 'R' (replica-only, i.e. invisible in the origin
 * mode the application runs in) both mean device writes are not being
 * audited right now — either one fails reconcile.
 */
async function reconcileAuditTriggerEnabled(platformPool: Pool): Promise<boolean> {
  const { rows } = await platformPool.query<{ tgenabled: string }>(
    `SELECT tgenabled FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal`,
    [DEVICE_AUDIT_TRIGGER],
  )
  const state = rows[0]?.tgenabled ?? 'MISSING'
  const ok = state === 'O' || state === 'A'
  console.log(`${ok ? 'OK      ' : 'MISMATCH'}  ${DEVICE_AUDIT_TRIGGER} tgenabled: expected=O-or-A actual=${state}`)
  return ok
}

export async function reconcile(): Promise<void> {
  const legacyUrl = process.env.LEGACY_DATABASE_URL
  const platformUrl = process.env.DATABASE_URL
  if (!legacyUrl) throw new Error('LEGACY_DATABASE_URL is required (read-only connection to the old DLMS project)')
  if (!platformUrl) throw new Error('DATABASE_URL is required (the platform project)')

  const legacyPool = new Pool({ connectionString: legacyUrl, max: 3 })
  const platformPool = new Pool({ connectionString: platformUrl, max: 3 })

  let ok: boolean
  try {
    const deviceCountOk = await reconcileDeviceCounts(legacyPool, platformPool)
    const statusCountOk = await reconcileStatusCounts(legacyPool, platformPool)
    const serialHashOk = await reconcileSerialHash(legacyPool, platformPool)
    await reportNeedsReviewCount(platformPool)
    const auditLogOk = await reconcileAuditLog(legacyPool, platformPool)
    const auditTriggerOk = await reconcileAuditTriggerEnabled(platformPool)
    ok = deviceCountOk && statusCountOk && serialHashOk && auditLogOk && auditTriggerOk
  } finally {
    await legacyPool.end()
    await platformPool.end()
  }

  if (!ok) {
    console.error('\nRECONCILE FAILED — see MISMATCH lines above.')
    process.exitCode = 1
  } else {
    console.log('\nRECONCILE OK — all counts match.')
  }
}

// See scripts/migrate_demo.ts for why this checks import.meta.url rather than
// require.main: this file is also imported (for reportRow-free unit reuse) as
// plain ESM, and must not open database connections merely by being imported.
const isDirectRun = (() => {
  try {
    return !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()

if (isDirectRun) {
  reconcile().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
