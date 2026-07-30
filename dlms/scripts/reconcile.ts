// Reconciliation for the demo data migration (Task 14, spec §15): compares the
// legacy DLMS project against the platform project AFTER scripts/migrate_demo.ts
// and scripts/migrate_components.ts have run, and exits non-zero on any mismatch
// so a silent partial migration cannot slip past CI or an operator skimming the
// log. Device rows come from the first script, components from the second; the
// component section fails only on a partial or wrong migration, never on data
// the migration carried faithfully and a human still has to clean up.
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

// ===========================================================================
// Component back-fill (scripts/migrate_components.ts, spec §15). Three
// assertions that fail the run, and two observations that never do.
// ===========================================================================

/**
 * The platform's device ids. Every legacy-side component count below is scoped
 * to them, because that set is exactly what migrate_components.ts back-fills:
 * a legacy device with no platform counterpart is reported and SKIPPED there,
 * so counting its components here would report a missing DEVICE as missing
 * COMPONENTS and send the operator to the wrong script. The device-count and
 * status comparisons above already own that failure, and own it better.
 *
 * Deliberately not filtered by deleted_at, for the same reason
 * migrate_components.ts's existingDeviceIds is not: migrate_demo.ts carries a
 * legacy row's soft-delete state verbatim, and a soft-deleted device still has
 * the components it was built with, so the back-fill migrates them.
 */
async function platformDeviceIds(platformPool: Pool): Promise<string[]> {
  const { rows } = await platformPool.query<{ id: string }>(`SELECT id FROM device`)
  return rows.map((r) => r.id)
}

/**
 * The three conditions under which a legacy row produces an installation,
 * transcribed from mapLegacyComponents (modules/manufacturing/domain/
 * legacyComponents.ts) rather than guessed at: a pcba_a serial, a pcba_b
 * serial, and a screen group that exists when EITHER screen_model or hmi_ver
 * survives the trim. `btrim(coalesce(x,'')) <> ''` is the SQL spelling of that
 * module's text() helper — a whitespace-only column is "no component", not a
 * component with a blank serial.
 *
 * This is a sum of three filters, NOT devices × 3, and the difference is the
 * whole point: a device may populate one, two or three groups, and a group
 * nobody populated produces nothing at all (the mapper refuses to give a device
 * an empty accessory board it never had).
 */
const LEGACY_POPULATED_GROUPS = `
  SELECT (
      count(*) FILTER (WHERE btrim(coalesce(pcba_a_sn, '')) <> '')
    + count(*) FILTER (WHERE btrim(coalesce(pcba_b_sn, '')) <> '')
    + count(*) FILTER (WHERE btrim(coalesce(screen_model, '')) <> ''
                          OR btrim(coalesce(hmi_ver, '')) <> '')
  )::text AS n
    FROM device WHERE id = ANY($1::uuid[])`

/**
 * The two serialized groups, one row per (type, trimmed serial) a device
 * carries, with the revisions alongside. Revisions are trimmed AND
 * null-collapsed to '' so that null, '' and '   ' land in one bucket — which is
 * what the mapper's text() does to them, and therefore what decides whether two
 * devices sharing a serial actually disagree. Without the collapse the
 * divergence line below would invent disagreements out of empty strings.
 */
const LEGACY_SERIALS = `
  SELECT 'pcba_a' AS type_code, btrim(pcba_a_sn) AS serial_no,
         btrim(coalesce(pcba_a_hw_rev, '')) AS hw_rev,
         btrim(coalesce(pcba_a_bom_rev, '')) AS bom_rev,
         btrim(coalesce(pcba_a_fw_ver, '')) AS fw_ver
    FROM device WHERE id = ANY($1::uuid[]) AND btrim(coalesce(pcba_a_sn, '')) <> ''
   UNION ALL
  SELECT 'pcba_b', btrim(pcba_b_sn),
         btrim(coalesce(pcba_b_hw_rev, '')),
         btrim(coalesce(pcba_b_bom_rev, '')),
         btrim(coalesce(pcba_b_fw_ver, ''))
    FROM device WHERE id = ANY($1::uuid[]) AND btrim(coalesce(pcba_b_sn, '')) <> ''`

/**
 * Open installations: one per populated legacy group. The screen group is in
 * that total even though it produces no unit — it migrates as a batch-form
 * installation (component_unit_id NULL, batch_no set), so installations and
 * units are structurally different numbers, not two views of one.
 *
 * The platform side is counted globally rather than scoped to the ids above
 * because the cutover target starts with no devices and no components of its
 * own: everything in component_installation got there from the back-fill. On a
 * platform that has since been in service this line reads as an excess, which
 * is honest — a component fitted through the UI after cutover really is an
 * installation the legacy data cannot explain. Run reconcile at cutover.
 *
 * A shortfall means the back-fill did not fully land. Re-running
 * migrate_components.ts is safe and is the first thing to try — with one
 * exception worth knowing before chasing it: that script INSERTs only into a
 * slot with NO installation history at all, so a slot the platform has already
 * taken over (a component removed through the UI) is left alone by design and
 * shows up here as one missing open row.
 */
async function reconcileInstallationCounts(legacyPool: Pool, platformPool: Pool, deviceIds: string[]): Promise<boolean> {
  const expected = await count(legacyPool, LEGACY_POPULATED_GROUPS, [deviceIds])
  const actual = await count(platformPool,
    `SELECT count(*)::text AS n FROM component_installation WHERE removed_at IS NULL`)
  return reportRow('open component_installation rows vs populated legacy groups', expected, actual)
}

/**
 * Units: DISTINCT serials per type, and the distinctness is what makes this
 * correct rather than a rounding of the truth. Two devices legitimately
 * carrying the same serial are ONE physical board — component_unit_sn
 * (UNIQUE per type where deleted_at IS NULL) enforces exactly that, and
 * migrate_components.ts's upsertUnit reuses the existing unit rather than
 * inventing a second identity — so they produce one unit and two
 * installations. Counting rows instead of distinct serials would demand a
 * duplicate the schema forbids and fail every run against real data. Do not
 * "simplify" the DISTINCT away.
 *
 * Distinct is taken per (type, serial), never across types: pcba_a "X" and
 * pcba_b "X" are two different boards and two units, because the unique index
 * is on (component_type_id, serial_no).
 *
 * hmi_screen is excluded on both sides — legacy identifies a screen only by
 * model and firmware, neither of which identifies an individual screen, so the
 * mapper deliberately produces no unit for it.
 */
async function reconcileUnitCounts(legacyPool: Pool, platformPool: Pool, deviceIds: string[]): Promise<boolean> {
  const expected = await count(legacyPool,
    `SELECT count(*)::text AS n
       FROM (SELECT DISTINCT type_code, serial_no FROM (${LEGACY_SERIALS}) s) d`, [deviceIds])
  const actual = await count(platformPool,
    `SELECT count(*)::text AS n
       FROM component_unit cu JOIN component_type ct ON ct.id = cu.component_type_id
      WHERE ct.code IN ('pcba_a', 'pcba_b') AND cu.deleted_at IS NULL`)
  return reportRow('component_unit rows (pcba_a+pcba_b) vs distinct legacy serials', expected, actual)
}

/**
 * Defense in depth, in the same spirit as the audit-trigger check above:
 * component_installation.device_id is NOT NULL REFERENCES device(id), so an
 * orphan is impossible while that FK is intact — which is precisely why this
 * costs one query and is worth it. A back-fill that hung components off ids
 * the platform does not have would be the worst possible failure (a fleet's
 * parts attributed to nothing), and reconcile should not have to assume a
 * constraint is still there to rule it out.
 */
async function reconcileNoOrphanInstallations(platformPool: Pool): Promise<boolean> {
  const orphans = await count(platformPool,
    `SELECT count(*)::text AS n FROM component_installation ci
      WHERE NOT EXISTS (SELECT 1 FROM device d WHERE d.id = ci.device_id)`)
  return reportRow('component_installation rows whose device_id has no device', 0, orphans)
}

/**
 * Serials two legacy devices share while disagreeing about the revisions —
 * migrate_components.ts's divergentUnits, seen from the other side. It keeps
 * the first unit's revisions and reports the ones it could not store; the
 * counts above are unaffected (one serial is still one unit), so nothing here
 * fails, and nothing here should: like the cleanup queue below, this is a
 * human's judgement call about which revision is real, not a migration defect.
 *
 * Counted per SERIAL, where the runner counts per DEVICE that disagreed, so
 * a serial carried by three devices with three revision sets is 1 here and 2
 * there. Both point at the same population; the runner's output is the one
 * with the actual values.
 */
async function reportDivergentSerials(legacyPool: Pool, deviceIds: string[]): Promise<void> {
  const n = await count(legacyPool,
    `SELECT count(*)::text AS n FROM (
       SELECT type_code, serial_no FROM (${LEGACY_SERIALS}) s
        GROUP BY type_code, serial_no
       HAVING count(DISTINCT (hw_rev, bom_rev, fw_ver)) > 1) d`, [deviceIds])
  console.log(
    `INFO      legacy serials shared by devices with DIVERGENT revisions (not compared): ${n}` +
    (n > 0 ? ' — the first unit\'s revisions were kept; see migrate_components.ts output for both sides' : ''))
}

/**
 * The admin cleanup queue. Spec §15's rider is that cutover never blocks on
 * cleansing, so this can only ever be reported — a needs_split serial is data
 * the migration carried faithfully and flagged, which is the correct outcome,
 * not a failure. It is printed loudly and in full anyway because this listing
 * is the queue's only surface today: there is no admin screen for it yet, and
 * the runner's own listing scrolls past at migration time. Reconcile is the
 * thing an operator re-runs, so it has to keep saying so.
 */
async function reportNeedsSplitQueue(platformPool: Pool): Promise<void> {
  const { rows } = await platformPool.query<{ code: string; serial_no: string }>(
    `SELECT ct.code, cu.serial_no
       FROM component_unit cu JOIN component_type ct ON ct.id = cu.component_type_id
      WHERE cu.needs_split AND cu.deleted_at IS NULL
      ORDER BY ct.sort, cu.serial_no`)

  if (rows.length === 0) {
    console.log('INFO      component_unit needs_split queue: 0 — nothing awaiting cleanup')
    return
  }
  console.warn(
    `ACTION    component_unit needs_split queue: ${rows.length} — NEVER fails reconcile ` +
    `(spec §15: cutover never blocks on cleansing), and nobody has cleaned these up yet:`)
  for (const r of rows) console.warn(`            ${r.code}: "${r.serial_no}"`)
}

/**
 * The component half of the migration, run as one block so its lines stay
 * together in the log. Returns whether every ASSERTED comparison matched; the
 * two reported observations above deliberately have no say in it.
 */
export async function reconcileComponents(legacyPool: Pool, platformPool: Pool): Promise<boolean> {
  const deviceIds = await platformDeviceIds(platformPool)

  const installsOk = await reconcileInstallationCounts(legacyPool, platformPool, deviceIds)
  const unitsOk = await reconcileUnitCounts(legacyPool, platformPool, deviceIds)
  const orphansOk = await reconcileNoOrphanInstallations(platformPool)

  await reportDivergentSerials(legacyPool, deviceIds)
  await reportNeedsSplitQueue(platformPool)

  return installsOk && unitsOk && orphansOk
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
    // Last, so the needs_split queue it prints sits immediately above the
    // verdict line rather than scrolling away under the audit comparisons.
    const componentsOk = await reconcileComponents(legacyPool, platformPool)
    ok = deviceCountOk && statusCountOk && serialHashOk && auditLogOk && auditTriggerOk && componentsOk
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
