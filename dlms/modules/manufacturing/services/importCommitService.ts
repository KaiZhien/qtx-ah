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

const uuidSchema = z.string().uuid()

/** A batch a commit pass is still allowed to write into. */
const OPEN_BATCH_STATUSES = ['draft', 'committing']

export async function getImportBatch(
  actor: Actor, batchId: string,
): Promise<ImportBatchSummary | null> {
  authorize(actor, 'import_data', 'manufacturing')
  // Batch ids arrive off the URL, so a malformed one is a not-found, not a
  // crash: without this the query below raises Postgres 22P02 and the page
  // renders a raw driver string instead of its 404.
  if (!uuidSchema.safeParse(batchId).success) return null
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
  // Same reason as getImportBatch: a typo'd id in the URL is an empty list, not
  // a Postgres 22P02 surfaced to the reviewer.
  if (!uuidSchema.safeParse(batchId).success) return []
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
  uuidSchema.parse(batchId)
  uuidSchema.parse(rowId)
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
  uuidSchema.parse(batchId)
  await withTransaction(actor.id, async (tx) => {
    await tx.query(
      // 'committed' is cancellable only when the batch has no committed rows.
      // commitImportBatch no longer stamps a batch 'committed' unless something
      // actually committed, but a batch stamped that way by an earlier build —
      // all rows invalid, nothing imported — would otherwise be a one-way door:
      // nothing left to commit and no way to clean it up. A batch that really
      // did create devices still refuses: 'cancelled' must never claim that
      // devices sitting in the registry were never imported.
      `UPDATE import_batch AS b
          SET status='cancelled', updated_at=now(), updated_by=$1, version=version+1
        WHERE b.id=$2
          AND (b.status IN ('draft','committing')
               OR (b.status = 'committed'
                   AND NOT EXISTS (SELECT 1 FROM import_row r
                                    WHERE r.batch_id = b.id AND r.status = 'committed')))`,
      [actor.id, batchId])
  })
}

/**
 * Move a batch's failed rows back into the pending pool so a commit pass will
 * retry them. Deliberately explicit rather than folded into the pending read:
 * a row fails for a reason, and re-attempting it should be a decision someone
 * makes after fixing that reason, not something every pass does automatically.
 * Errors are cleared so a stale message can't outlive the condition it named.
 */
export async function retryFailedRows(
  actor: Actor, batchId: string,
): Promise<{ requeued: number }> {
  authorize(actor, 'import_data', 'manufacturing')
  if (!uuidSchema.safeParse(batchId).success) return { requeued: 0 }
  return withTransaction(actor.id, async (tx) => {
    const { rowCount } = await tx.query(
      // parsed IS NOT NULL: only a row that once validated can be committed,
      // and it is the same precondition the pending read applies.
      `UPDATE import_row
          SET status = 'valid', errors = '[]'::jsonb, updated_at = now()
        WHERE batch_id = $1 AND status = 'failed' AND parsed IS NOT NULL`, [batchId])
    return { requeued: rowCount ?? 0 }
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

/** The (component type, serial) identity of one staged component. */
type ComponentKey = { typeCode: string; serialNo: string }

/** A pending row whose stored draft has been read successfully. */
type StagedRow = { id: string; parsed: ImportDeviceDraft; components: ComponentKey[] }

const componentKey = (c: ComponentKey): string => `${c.typeCode}:${c.serialNo}`

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
  // Cheap early exit only. The check that actually holds is the one inside
  // commitOneRow's transaction, because a cancel can land after this read.
  if (batchStatus === null || !OPEN_BATCH_STATUSES.includes(batchStatus)) {
    return { committed: 0, failed: 0, skipped: 0, remaining: 0 }
  }

  const pending = await withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string; parsed: ImportDeviceDraft }>(
      `SELECT id, parsed FROM import_row
        WHERE batch_id=$1 AND status='valid' AND parsed IS NOT NULL
        ORDER BY source_row_no, unit_no LIMIT $2`, [data.batchId, data.limit])
    return rows
  })

  let committed = 0, failed = 0, skipped = 0

  // `parsed` is jsonb that an earlier parse pass wrote, so reading it can itself
  // throw — and per-row atomicity means a single malformed draft must fail its
  // own row, never abort the pass. Unpack every draft here, guarded, so nothing
  // downstream (the pre-check's flatMap, the clash lookup) touches raw jsonb.
  const staged: StagedRow[] = []
  for (const row of pending) {
    try {
      staged.push({ id: row.id, parsed: row.parsed, components: readComponents(row.parsed) })
    } catch (err) {
      const counted = await recordRowError(actor, row.id, err)
      if (counted === 'failed') failed++
      else if (counted === 'skipped') skipped++
    }
  }

  // Batched pre-check: serials already in the database are skipped without an
  // attempt, so an existing device never shows up as a scary "failed" row. One
  // query for the whole page of rows, not one per row. Keyed by component type
  // as well as serial, because component_unit_sn is UNIQUE(component_type_id,
  // serial_no) — the same serial under two different types is legal, and
  // matching on the serial alone would wrongly skip a legitimate row.
  const alreadyPresent = await findExistingSerials(
    actor, staged.flatMap((s) => s.components))

  // component_type codes resolve once for the whole pass. Resolving them per
  // component per row put a SELECT inside every per-row transaction: a 5000-row
  // file carrying three components each is 15,000 avoidable round trips on a
  // pool of 10.
  const typeIds = await findComponentTypeIds(
    actor, [...new Set(staged.flatMap((s) => s.components.map((c) => c.typeCode)))])

  for (const row of staged) {
    const clash = row.components.find((c) => alreadyPresent.has(componentKey(c)))
    if (clash) {
      // Counted only if the stamp landed — see markRow.
      if (await markRow(actor, row.id, 'skipped',
        [`A ${clash.typeCode} component with serial "${clash.serialNo}" already exists`])) {
        skipped++
      }
      continue
    }
    try {
      if (await commitOneRow(actor, row.id, row.parsed, typeIds) === 'committed') committed++
      // 'not_pending' — another pass owns this row, or the batch was cancelled
      // under us. Neither a success nor a failure: nothing written, nothing
      // counted, nothing logged. Reporting it as failed would send a reviewer
      // hunting for a row that is perfectly fine.
    } catch (err) {
      const counted = await recordRowError(actor, row.id, err)
      if (counted === 'failed') failed++
      else if (counted === 'skipped') skipped++
    }
  }

  const remaining = await withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ valid_n: string; committed_n: string }>(
      `SELECT count(*) FILTER (WHERE status='valid')::text     AS valid_n,
              count(*) FILTER (WHERE status='committed')::text AS committed_n
         FROM import_row WHERE batch_id=$1`, [data.batchId])
    const n = parseInt(rows[0].valid_n, 10)
    const committedRows = parseInt(rows[0].committed_n, 10)

    // 'committed' is a claim that this file produced devices, and the review
    // screen is read that way. A batch whose rows are all invalid/needs_review,
    // or whose only row failed for a fixable reason (a missing permission), has
    // produced nothing: it stays where it is, so it is still cancellable and
    // its failed rows are still the retryable state import_row.status documents.
    const next = n > 0 ? 'committing' : committedRows > 0 ? 'committed' : null
    if (next !== null) {
      await tx.query(
        `UPDATE import_batch SET status=$1, updated_at=now(), updated_by=$2, version=version+1
          WHERE id=$3 AND status IN ('draft','committing')`,
        [next, actor.id, data.batchId])
    }
    return n
  })

  return { committed, failed, skipped, remaining }
}

/** What one row's commit attempt did. Anything else throws. */
type RowOutcome = 'committed' | 'not_pending'

/**
 * One row → one device, its component units, and one open installation each —
 * atomically, including the staging row's own status stamp. If anything throws,
 * the device never existed.
 */
async function commitOneRow(
  actor: Actor, rowId: string, draft: ImportDeviceDraft,
  typeIds: Map<string, string>,
): Promise<RowOutcome> {
  return withTransaction(actor.id, async (tx) => {
    // Re-lock the staging row and re-check, inside this transaction, both that
    // the row is still pending and that its batch still wants committing.
    //
    // The batch status is joined in rather than read before the loop because a
    // cancel must stop a pass already in flight: read once up front, a cancel
    // landing mid-pass still left committed devices under a batch reading
    // 'cancelled', so 'cancelled' did not mean "nothing was imported".
    //
    // FOR UPDATE OF r locks only the staging row. Locking the batch row too
    // would serialise every row of the batch behind one another and would make
    // cancelImportBatch block on the very pass it is trying to stop.
    //
    // SKIP LOCKED: a row another pass already holds belongs to that pass. Left
    // to block, this pass would queue row-by-row behind the winner and the
    // pool's 15s statement_timeout would turn that queue into reported failures
    // for rows that are entirely fine.
    const { rows: lockRows } = await tx.query<{ status: string; batch_status: string }>(
      `SELECT r.status, b.status AS batch_status
         FROM import_row r JOIN import_batch b ON b.id = r.batch_id
        WHERE r.id = $1
        FOR UPDATE OF r SKIP LOCKED`, [rowId])
    if (lockRows.length === 0) return 'not_pending'
    if (lockRows[0].status !== 'valid') return 'not_pending'
    if (!OPEN_BATCH_STATUSES.includes(lockRows[0].batch_status)) return 'not_pending'

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

    // Components: one unit per serialized part, each installed into its own
    // slot. Slots are numbered per component type, because that is what
    // one_open_install (device_id, component_type_id, slot_no) constrains.
    // validateSheetRow emits at most one component per type today so every slot
    // is in fact 1 — but hard-coding 1 would mean a sheet that grows a second
    // PCBA-A column fails the row on a unique-index violation reported as a
    // serial problem, which it is not.
    const slots = new Map<string, number>()
    for (const c of draft.components) {
      const typeId = typeIds.get(c.typeCode)
      if (typeId === undefined) throw new Error(`Unknown component type: ${c.typeCode}`)
      const slot = (slots.get(c.typeCode) ?? 0) + 1
      slots.set(c.typeCode, slot)

      const { rows: uRows } = await tx.query<{ id: string }>(
        `INSERT INTO component_unit
           (component_type_id, serial_no, hw_rev, bom_rev, fw_ver, disposition,
            created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,'installed',$6,$6) RETURNING id`,
        [typeId, c.serialNo, c.hwRev, c.bomRev, c.fwVer, actor.id])

      await tx.query(
        `INSERT INTO component_installation
           (device_id, component_type_id, component_unit_id, slot_no, installed_by, created_by)
         VALUES ($1,$2,$3,$4,$5,$5)`, [deviceId, typeId, uRows[0].id, slot, actor.id])
    }

    await tx.query(
      `UPDATE import_row SET status='committed', device_id=$1, committed_at=now(),
              updated_at=now(), errors='[]'::jsonb
        WHERE id=$2`, [deviceId, rowId])

    return 'committed'
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
 *
 * status_transition.requires_reason is deliberately NOT consulted. Seating a
 * status is not a transition — there is no from_status, so there is no edge to
 * look a reason requirement up by — and the history row the caller writes
 * therefore carries a NULL reason, exactly as createDevice's first history row
 * does. requires_reason starts applying from the device's next status change,
 * which goes through changeDeviceStatus.
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
 * The (component type, serial) keys of one staged draft, read defensively:
 * `parsed` is stored jsonb, and a malformed one must fail its own row rather
 * than throw out of the commit loop and abort the pass.
 */
function readComponents(parsed: ImportDeviceDraft): ComponentKey[] {
  if (!parsed || !Array.isArray(parsed.components)) {
    throw new Error('Staged row carries no usable component list')
  }
  return parsed.components.map((c) => {
    if (!c || typeof c.typeCode !== 'string' || typeof c.serialNo !== 'string') {
      throw new Error('Staged row carries a malformed component entry')
    }
    return { typeCode: c.typeCode, serialNo: c.serialNo }
  })
}

/**
 * Which of these (component type, serial) pairs already exist. Returns a set of
 * `typeCode:serialNo` keys. Type-scoped on purpose: component_unit_sn is
 * UNIQUE(component_type_id, serial_no), so a PCBA-B carrying the same serial as
 * an existing PCBA-A is perfectly legal and must not be skipped.
 */
async function findExistingSerials(
  actor: Actor, pairs: ComponentKey[],
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

/**
 * component_type code → id for every code this pass will install, resolved once.
 * A code absent from the returned map fails its own row inside commitOneRow —
 * an unknown or retired component type is a row-level data problem, never a
 * reason to abandon the pass.
 */
async function findComponentTypeIds(
  actor: Actor, codes: string[],
): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map()
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string; code: string }>(
      `SELECT id, code FROM component_type
        WHERE code = ANY($1::text[]) AND active AND deleted_at IS NULL`, [codes])
    return new Map(rows.map((r) => [r.code, r.id]))
  })
}

/**
 * Stamp a row's problem and say which counter the caller should increment, or
 * null when nothing was stamped.
 *
 * A no-op stamp means another pass owns the row and may already have committed
 * it, so this pass must neither count it as failed nor log about it — the
 * previous version reported a phantom failure (and logged one) in a batch where
 * nothing had failed.
 */
async function recordRowError(
  actor: Actor, rowId: string, err: unknown,
): Promise<'failed' | 'skipped' | null> {
  const { status, message, unexpected } = classifyRowError(err)
  if (!(await markRow(actor, rowId, status, [message]))) return null
  if (unexpected) {
    console.error(JSON.stringify({
      level: 'error', msg: 'import row commit failed', err: String(err),
    }))
  }
  return status
}

/**
 * Stamp a staging row's status. Returns whether the UPDATE actually landed.
 *
 * Scoped to status='valid': every call site only ever marks a row it just read
 * as 'valid', so this is behaviour-neutral for them. It guards against the case
 * where a concurrent commit pass raced ahead, already committed this row, and
 * this pass's re-check in commitOneRow lost the race — without the scope, this
 * UPDATE would stamp 'failed' over a row that already has a device sitting in
 * the registry. Do not remove this scope.
 *
 * Wrapped: recording one row's problem is itself a database write, and a
 * failure there must not abort the rows the pass has not reached yet. A row
 * whose stamp never landed stays 'valid' and is simply retried next pass.
 */
async function markRow(
  actor: Actor, rowId: string, status: ImportRowStatus, errors: string[],
): Promise<boolean> {
  try {
    return await withTransaction(actor.id, async (tx) => {
      const res = await tx.query(
        `UPDATE import_row SET status=$1, errors=$2, updated_at=now()
          WHERE id=$3 AND status='valid'`,
        [status, JSON.stringify(errors), rowId])
      return (res.rowCount ?? 0) > 0
    })
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', msg: 'import row status stamp failed', err: String(err),
    }))
    return false
  }
}

type RowErrorOutcome = {
  /** Which resting state the row lands in. */
  status: 'failed' | 'skipped'
  /** Shown to the reviewer next to the row. */
  message: string
  /** Nothing below recognised this error, so it needs a human to look at it. */
  unexpected: boolean
}

// Row-level problems are shown to the reviewer next to the row, so they must
// name the problem without leaking connection strings, SQL or library internals.
function classifyRowError(err: unknown): RowErrorOutcome {
  const isPgError = Boolean(err) && typeof err === 'object'
  const code = isPgError && 'code' in (err as object)
    ? String((err as { code: unknown }).code) : ''
  const constraint = isPgError && 'constraint' in (err as object)
    ? String((err as { constraint: unknown }).constraint) : ''

  if (code === '23505') {
    // Which unique index fired matters: these read as three different problems
    // to whoever has to fix the sheet, and one of them is not a problem at all.
    switch (constraint) {
      case 'component_unit_sn':
        // The batched pre-check missed it: another pass, or another user,
        // created this unit between the check and the insert. That is a benign
        // re-upload rather than a defect in this row, so it rests as 'skipped'
        // and reads exactly like a pre-check skip.
        return { status: 'skipped', unexpected: false,
                 message: 'A component with one of these serials already exists' }
      case 'device_sn_unique':
        return { status: 'failed', unexpected: false,
                 message: 'Another device already carries this Device S/N' }
      case 'one_open_install':
        return { status: 'failed', unexpected: false,
                 message: 'This device already has a component fitted in that slot' }
      default:
        return { status: 'failed', unexpected: false,
                 message: 'A record with one of these serials already exists' }
    }
  }
  if (code === '23503') {
    return { status: 'failed', unexpected: false,
             message: 'References a record that no longer exists' }
  }
  if (err instanceof PermissionError) {
    return { status: 'failed', unexpected: false,
             message: "You don't have permission to import a device at that status" }
  }
  if (err instanceof Error &&
      /Unknown or inactive|No initial device status|Unknown component type/.test(err.message)) {
    return { status: 'failed', unexpected: false, message: err.message }
  }
  return {
    status: 'failed', unexpected: true,
    message: 'This row could not be imported. Try again, and tell Reet if it keeps happening.',
  }
}
