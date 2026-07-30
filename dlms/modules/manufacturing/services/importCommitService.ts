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

export async function skipImportRow(
  actor: Actor, batchId: string, rowId: string,
): Promise<void> {
  authorize(actor, 'import_data', 'manufacturing')
  z.string().uuid().parse(batchId)
  z.string().uuid().parse(rowId)
  await withTransaction(actor.id, async (tx) => {
    await tx.query(
      // Scoped to batch_id as well as id: the caller always knows which batch
      // it's looking at, and a row id from one batch must not be skippable
      // through another batch's page.
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
    await tx.query(
      // Scoped to status='valid': both call sites only ever mark a row they
      // just read as 'valid', so this is behaviour-neutral for them. It
      // guards against the case where a concurrent commit pass raced ahead,
      // already committed this row, and this pass's re-check in
      // commitOneRow lost the race — without the scope, this UPDATE would
      // stamp 'failed' over a row that already has a device sitting in the
      // registry. Do not remove this scope.
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
