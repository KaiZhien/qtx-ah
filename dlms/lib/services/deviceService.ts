/**
 * Device service — single source of truth for all device mutations (§5.1.1).
 * All DB writes go through here. No component or Server Action writes directly.
 */

import { createAdminClient } from '@/lib/supabase/server'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { deviceSchema } from '@/lib/domain/validation'
import { normalizeSerial } from '@/lib/domain/normalize'
import { isValidTransition } from '@/lib/domain/statusTransitions'
import { AppError } from '@/lib/types'
import type { DeviceRow, DeviceInput, ListDevicesParams, DeviceStats, Role } from '@/lib/types'
import { isTraceableField, groupDevicesByDimension } from '@/lib/domain/componentTraceability'
import type { TraceabilityGroup } from '@/lib/domain/componentTraceability'
import { getAssignedDeviceIds } from './assignmentService'
import { getOverdueServiceDeviceIds } from './serviceScheduleService'
import { getAllStatuses, getAllPhases } from './vocabularyService'

/**
 * Validate status/phase against the LIVE vocabulary tables before a write, so the
 * device form, inline edit, draft promotion, and invoice confirm all get the same
 * clear error the CSV/Excel import gives (importService validateMappedRow) instead
 * of the DB's opaque foreign-key violation.
 *
 * Reads the vocabulary at call time, so admin-added codes pass automatically.
 * Validates existence against ALL codes (active + inactive) — this mirrors the FK
 * exactly and never falsely rejects a same-status write on a code that was later
 * deactivated. If the vocabulary can't be read (empty), it defers to the DB FK
 * (fail-open) rather than blocking a write on a check it couldn't perform.
 */
async function assertVocabValid(status?: string | null, phase?: string | null): Promise<void> {
  if (status != null) {
    const all = await getAllStatuses()
    if (all.length > 0 && !all.some((s) => s.code === status)) {
      const active = all.filter((s) => s.active).map((s) => s.code)
      throw new AppError({
        type: 'validation',
        message: `Status "${status}" is not a valid status. Valid options: ${active.join(', ')}`,
        errors: { status: [`Unknown status "${status}"`] },
      })
    }
  }
  if (phase != null) {
    const all = await getAllPhases()
    if (all.length > 0 && !all.some((p) => p.code === phase)) {
      const active = all.filter((p) => p.active).map((p) => p.code)
      throw new AppError({
        type: 'validation',
        message: `Phase "${phase}" is not a valid phase. Valid options: ${active.join(', ')}`,
        errors: { phase: [`Unknown phase "${phase}"`] },
      })
    }
  }
}

// NOTE: setSessionContext() was removed — it was a dead no-op stub that never
// actually set the app.actor_id GUC. The fn_audit trigger now reads actor_id
// directly from the row's created_by/updated_by columns (migration 20250106000000).

export async function listDevices(params: ListDevicesParams = {}): Promise<{ rows: DeviceRow[]; total: number }> {
  const supabase = createAdminClient()
  const {
    search, status, phase, customer, model,
    buildDateFrom, buildDateTo, shipDateFrom, shipDateTo,
    pcba_a_hw_rev, pcba_a_bom_rev, pcba_a_fw_ver,
    pcba_b_hw_rev, pcba_b_bom_rev, pcba_b_fw_ver,
    screen_model, hmi_ver,
    sort, dir,
    page = 1, pageSize = 50, includeDeleted = false,
  } = params

  let query = supabase.from('device').select('*', { count: 'exact' })

  if (!includeDeleted) {
    query = query.is('deleted_at', null)
  }

  if (search) {
    // Sanitize: only allow characters that appear in serial numbers and customer names.
    // Rejects PostgREST filter-injection characters (comma, parens, dot used in .or() syntax).
    const raw = search.trim()
    if (!/^[A-Za-z0-9\-_ ~]+$/.test(raw)) {
      throw new AppError({ type: 'validation', message: 'Search term contains invalid characters', errors: {} })
    }
    const term = raw.toUpperCase()
    // Build per-column filters bound individually to avoid interpolation into the .or() string.
    query = query.or([
      `pcba_a_sn_normalized.ilike.%${term}%`,
      `pcba_b_sn_normalized.ilike.%${term}%`,
      `device_sn_normalized.ilike.%${term}%`,
      `customer.ilike.%${term}%`,
      `product_name.ilike.%${term}%`,
      `model_no.ilike.%${term}%`,
      `screen_model.ilike.%${term}%`,
      `destination.ilike.%${term}%`,
    ].join(','))
  }
  if (status)        query = query.eq('status', status)
  if (phase)         query = query.eq('phase', phase)
  if (customer)      query = query.ilike('customer', `%${customer}%`)
  if (model)         query = query.ilike('model_no', `%${model}%`)
  if (buildDateFrom) query = query.gte('build_date', buildDateFrom)
  if (buildDateTo)   query = query.lte('build_date', buildDateTo)
  if (shipDateFrom)  query = query.gte('ship_date', shipDateFrom)
  if (shipDateTo)    query = query.lte('ship_date', shipDateTo)
  // Component-revision exact-match filters (traceability drill-through)
  if (pcba_a_hw_rev)  query = query.eq('pcba_a_hw_rev',  pcba_a_hw_rev)
  if (pcba_a_bom_rev) query = query.eq('pcba_a_bom_rev', pcba_a_bom_rev)
  if (pcba_a_fw_ver)  query = query.eq('pcba_a_fw_ver',  pcba_a_fw_ver)
  if (pcba_b_hw_rev)  query = query.eq('pcba_b_hw_rev',  pcba_b_hw_rev)
  if (pcba_b_bom_rev) query = query.eq('pcba_b_bom_rev', pcba_b_bom_rev)
  if (pcba_b_fw_ver)  query = query.eq('pcba_b_fw_ver',  pcba_b_fw_ver)
  if (screen_model)   query = query.eq('screen_model',   screen_model)
  if (hmi_ver)        query = query.eq('hmi_ver',        hmi_ver)

  if (params.myQueueUserId || params.serviceOverdue) {
    let ids: string[] | null = null

    if (params.myQueueUserId) {
      ids = await getAssignedDeviceIds(params.myQueueUserId)
    }
    if (params.serviceOverdue) {
      const overdueIds = await getOverdueServiceDeviceIds()
      ids = ids ? ids.filter((id) => overdueIds.includes(id)) : overdueIds
    }

    if (!ids || ids.length === 0) return { rows: [], total: 0 }
    query = query.in('id', ids)
  }

  const SORTABLE = new Set([
    'device_sn', 'product_name', 'model_no', 'pcba_a_sn', 'pcba_b_sn',
    'build_date', 'ship_date', 'warranty_expiry', 'qty', 'destination', 'customer',
    'status', 'phase', 'created_at',
  ])
  const sortCol = sort && SORTABLE.has(sort) ? sort : 'created_at'
  // Default for created_at is newest-first (desc); for everything else default asc
  const ascending = sortCol === 'created_at' ? dir === 'asc' : dir !== 'desc'

  const from = (page - 1) * pageSize
  query = query.order(sortCol, { ascending }).range(from, from + pageSize - 1)

  const { data, error, count } = await query
  if (error) throw new Error(error.message)

  return { rows: (data ?? []) as DeviceRow[], total: count ?? 0 }
}

export async function getDevice(id: string): Promise<DeviceRow | null> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('device')
    .select('*')
    .eq('id', id)
    .single()
  if (error) return null
  return data as DeviceRow
}

/**
 * Look up a device by its PCBA-A serial number (normalized).
 * Returns null if not found. Used for duplicate detection before create.
 */
export async function getDeviceByPcbaSn(pcbaASn: string): Promise<DeviceRow | null> {
  const supabase = createAdminClient()
  const normalized = normalizeSerial(pcbaASn)
  const { data } = await supabase
    .from('device')
    .select('*')
    .eq('pcba_a_sn_normalized', normalized)
    .is('deleted_at', null)
    .maybeSingle()
  return (data as DeviceRow) ?? null
}

export async function createDevice(
  input: DeviceInput,
  actorId: string,
  actorRole: Role
): Promise<DeviceRow> {
  if (!can(actorRole, ACTIONS.CREATE_DEVICE)) {
    throw new AppError({ type: 'permission', message: 'You do not have permission to create devices' })
  }

  const parsed = deviceSchema.safeParse(input)
  if (!parsed.success) {
    throw new AppError({
      type: 'validation',
      message: 'Validation failed',
      errors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    })
  }

  // Reject unknown status/phase with a clear message (vs. an opaque DB FK error).
  await assertVocabValid(parsed.data.status, parsed.data.phase)

  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('device')
    .insert({
      ...parsed.data,
      created_by: actorId,
      updated_by: actorId,
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data as DeviceRow
}

export async function updateDevice(
  id: string,
  input: Partial<DeviceInput>,
  version: number,
  actorId: string,
  actorRole: Role
): Promise<DeviceRow> {
  if (!can(actorRole, ACTIONS.EDIT_DEVICE)) {
    throw new AppError({ type: 'permission', message: 'You do not have permission to edit devices' })
  }

  const supabase = createAdminClient()

  // Optimistic concurrency check. Also pull `status` so we can enforce the
  // status-transition rules here — this closes the bypass where the full edit
  // form and inline (double-click) editing called updateDevice directly and
  // could perform illegal moves (e.g. Retired → In Use) that changeStatus blocks.
  const { data: current, error: fetchErr } = await supabase
    .from('device')
    .select('version, deleted_at, status')
    .eq('id', id)
    .single()

  if (fetchErr || !current) throw new Error('Device not found')
  if (current.deleted_at) throw new AppError({ type: 'validation', message: 'Cannot edit a deleted record', errors: {} })
  if (current.version !== version) {
    throw new AppError({
      type: 'conflict',
      message: 'Record has been modified by another user. Please reload and try again.',
    })
  }

  // Reject unknown status/phase with a clear message BEFORE the transition check
  // — isValidTransition fails closed on unknown codes, so checking vocabulary
  // first turns "transition not allowed" confusion into "not a valid status,
  // valid options are …". Empty strings fall through to the Zod "required" error.
  await assertVocabValid(input.status || null, input.phase || null)

  // Enforce status-transition rules only when the status is actually changing.
  // Same-status writes and writes that don't touch status are unaffected.
  // (changeStatus validates first and then calls this — the re-check here is
  // idempotent: the same transition passes both times.)
  if (input.status != null && input.status !== current.status) {
    if (!isValidTransition(current.status ?? '', input.status)) {
      throw new AppError({
        type: 'conflict',
        message: `Status transition from "${current.status}" to "${input.status}" is not allowed`,
      })
    }
  }

  const parsed = deviceSchema.partial().safeParse(input)
  if (!parsed.success) {
    throw new AppError({
      type: 'validation',
      message: 'Validation failed',
      errors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    })
  }

  const { data, error } = await supabase
    .from('device')
    .update({
      ...parsed.data,
      updated_by: actorId,
    })
    .eq('id', id)
    .eq('version', version)  // Double-check in the UPDATE itself
    .select()
    .single()

  if (error) throw new Error(error.message)
  if (!data) {
    throw new AppError({
      type: 'conflict',
      message: 'Record has been modified by another user. Please reload and try again.',
    })
  }
  return data as DeviceRow
}

export async function changeStatus(
  id: string,
  status: string,
  phase: string,
  version: number,
  actorId: string,
  actorRole: Role
): Promise<DeviceRow> {
  if (!can(actorRole, ACTIONS.CHANGE_STATUS)) {
    throw new AppError({ type: 'permission', message: 'You do not have permission to change status' })
  }

  // Fetch the current device to validate the transition
  const current = await getDevice(id)
  if (!current) {
    throw new AppError({ type: 'conflict', message: 'Device not found' })
  }

  // Enforce status-transition rules
  if (!isValidTransition(current.status ?? '', status)) {
    throw new AppError({
      type: 'conflict',
      message: `Status transition from "${current.status}" to "${status}" is not allowed`,
    })
  }

  return updateDevice(id, { status, phase }, version, actorId, actorRole)
}

export async function softDeleteDevice(
  id: string,
  actorId: string,
  actorRole: Role
): Promise<void> {
  if (!can(actorRole, ACTIONS.SOFT_DELETE)) {
    throw new AppError({ type: 'permission', message: 'Only admins can delete records' })
  }

  const supabase = createAdminClient()
  const { error } = await supabase
    .from('device')
    .update({ deleted_at: new Date().toISOString(), updated_by: actorId })
    .eq('id', id)
    .is('deleted_at', null)  // Idempotency: only soft-delete active records

  if (error) throw new Error(error.message)
}

export async function getDeviceStats(): Promise<DeviceStats> {
  const supabase = createAdminClient()

  const [{ data: devices }, { data: stats }] = await Promise.all([
    supabase
      .from('device')
      .select('id, qty, status, phase, customer')
      .is('deleted_at', null),
    supabase
      .from('device')
      .select('id, qty')
      .is('deleted_at', null),
  ])

  const rows = devices ?? []
  const totalDevices = rows.length
  const totalUnits = rows.reduce((sum, r) => sum + (r.qty ?? 0), 0)

  const byStatus: Record<string, number> = {}
  const byPhase: Record<string, number> = {}
  const byCustomer: Record<string, number> = {}

  for (const row of rows) {
    if (row.status) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
    if (row.phase) byPhase[row.phase] = (byPhase[row.phase] ?? 0) + 1
    if (row.customer) byCustomer[row.customer] = (byCustomer[row.customer] ?? 0) + 1
  }

  return { totalDevices, totalUnits, byStatus, byPhase, byCustomer }
}


export async function getDistinctCustomers(): Promise<string[]> {
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('device')
    .select('customer')
    .is('deleted_at', null)
    .not('customer', 'is', null)
    .order('customer')
  const seen = new Set<string>()
  const result: string[] = []
  for (const row of data ?? []) {
    if (row.customer && !seen.has(row.customer)) {
      seen.add(row.customer)
      result.push(row.customer)
    }
  }
  return result
}

/**
 * Group all active devices by a component-revision field (traceability lookup).
 * Returns one bucket per distinct revision value, sorted by device count desc.
 * Throws a validation AppError for non-traceable fields (injection guard).
 */
export async function getComponentTraceability(field: string): Promise<TraceabilityGroup[]> {
  if (!isTraceableField(field)) {
    throw new AppError({ type: 'validation', message: `"${field}" is not a traceable component field`, errors: {} })
  }
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('device')
    .select(`id, qty, ${field}`)
    .is('deleted_at', null)
  if (error) throw new Error(error.message)
  // Cast via unknown: the dynamic column select confuses Supabase's template-literal
  // type inference; we only access id, qty, and field at runtime.
  return groupDevicesByDimension((data ?? []) as unknown as DeviceRow[], field)
}

/**
 * Count devices whose warranty expires within the next `withinDays` days
 * (warranty_expiry >= today AND warranty_expiry <= today + withinDays).
 * Excludes soft-deleted devices.
 * Used by the /devices page banner.
 */
export async function getExpiringWarrantyCount(withinDays = 7): Promise<number> {
  const supabase = createAdminClient()
  const today = new Date().toISOString().split('T')[0]   // 'YYYY-MM-DD'
  const future = new Date(Date.now() + withinDays * 86_400_000)
    .toISOString().split('T')[0]

  const { count, error } = await supabase
    .from('device')
    .select('*', { count: 'exact', head: true })
    .is('deleted_at', null)
    .gte('warranty_expiry', today)
    .lte('warranty_expiry', future)

  if (error) throw new Error(error.message)
  return count ?? 0
}
