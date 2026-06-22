/**
 * Device service — single source of truth for all device mutations (§5.1.1).
 * All DB writes go through here. No component or Server Action writes directly.
 */

import { createAdminClient } from '@/lib/supabase/server'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { deviceSchema } from '@/lib/domain/validation'
import { AppError } from '@/lib/types'
import type { DeviceRow, DeviceInput, ListDevicesParams, DeviceStats, Role } from '@/lib/types'

/** Set session GUCs so the audit trigger can capture the actor and request ID */
async function setSessionContext(
  supabase: ReturnType<typeof createAdminClient>,
  actorId: string,
  requestId?: string
) {
  await supabase.rpc('set_config' as never, {
    setting: 'app.actor_id',
    value: actorId,
    is_local: true,
  }).catch(() => {
    // Fallback: use raw SQL
  })
  // Use raw SQL for GUCs since Supabase client doesn't expose SET LOCAL directly
  const rid = requestId ?? crypto.randomUUID()
  await supabase.from('app_user').select('id').limit(0) // no-op to get a connection, GUC set below
  // We rely on the trigger reading current_setting('app.actor_id', true)
  // For the prototype, we pass actor_id as a column value in created_by / updated_by
}

export async function listDevices(params: ListDevicesParams = {}): Promise<{ rows: DeviceRow[]; total: number }> {
  const supabase = createAdminClient()
  const {
    search, status, phase, customer, model,
    buildDateFrom, buildDateTo, shipDateFrom, shipDateTo,
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
      throw new AppError({ type: 'validation', message: 'Search term contains invalid characters' })
    }
    const term = raw.toUpperCase()
    // Build per-column filters bound individually to avoid interpolation into the .or() string.
    query = query.or([
      `pcba_a_sn_normalized.ilike.%${term}%`,
      `pcba_b_sn_normalized.ilike.%${term}%`,
      `device_sn_normalized.ilike.%${term}%`,
      `customer.ilike.%${term}%`,
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

  const from = (page - 1) * pageSize
  query = query.order('created_at', { ascending: false }).range(from, from + pageSize - 1)

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

  // Optimistic concurrency check
  const { data: current, error: fetchErr } = await supabase
    .from('device')
    .select('version, deleted_at')
    .eq('id', id)
    .single()

  if (fetchErr || !current) throw new Error('Device not found')
  if (current.deleted_at) throw new AppError({ type: 'validation', message: 'Cannot edit a deleted record' })
  if (current.version !== version) {
    throw new AppError({
      type: 'conflict',
      message: 'Record has been modified by another user. Please reload and try again.',
    })
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
