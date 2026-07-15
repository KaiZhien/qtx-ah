import { createReadClient } from '@/lib/supabase/server'
import type { AuditEntry } from '@/lib/types'

export type AuditLogParams = {
  tableFilter?: string
  actorFilter?: string
  actionFilter?: string
  rowId?: string
  page?: number
  pageSize?: number
}

export async function getAuditLog(params: AuditLogParams = {}): Promise<{ rows: AuditEntry[]; total: number }> {
  // Read path (createReadClient). NOTE the RLS SELECT policy on audit_log grants
  // BOTH engineer and admin every row — looser than the app-layer gate on the
  // full audit-log page, which is admin-only (getDeviceHistory's per-device view
  // is intentionally broader). The app-layer permission check remains the
  // enforcement boundary for the full view; RLS is the defense-in-depth backstop.
  const supabase = createReadClient()
  const { tableFilter, actorFilter, actionFilter, rowId, page = 1, pageSize = 50 } = params

  let query = supabase
    .from('audit_log')
    .select('*, app_user!audit_log_actor_id_fkey(email)', { count: 'exact' })
    .order('occurred_at', { ascending: false })

  if (tableFilter) query = query.eq('table_name', tableFilter)
  if (actorFilter) query = query.eq('actor_id', actorFilter)
  if (actionFilter) query = query.eq('action', actionFilter)
  if (rowId) query = query.eq('row_id', rowId)

  const from = (page - 1) * pageSize
  query = query.range(from, from + pageSize - 1)

  const { data, error, count } = await query
  if (error) throw new Error(error.message)

  const rows = (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    actor_id: r.actor_id as string | null,
    actor_email: (r.app_user as { email?: string } | null)?.email ?? null,
    action: r.action as string,
    table_name: r.table_name as string,
    row_id: r.row_id as string | null,
    old_values: r.old_values as Record<string, unknown> | null,
    // Hard-delete audit rows (device_assignment unassign, report_subscriber removal)
    // have new_values = NULL in the DB; coalesce so AuditEntry consumers keep a
    // non-null bag (the deleted row's data lives in old_values).
    new_values: (r.new_values ?? {}) as Record<string, unknown>,
    changed_columns: r.changed_columns as string[],
    request_id: r.request_id as string | null,
    occurred_at: r.occurred_at as string,
  })) as AuditEntry[]

  return { rows, total: count ?? 0 }
}

export async function getDeviceHistory(deviceId: string): Promise<AuditEntry[]> {
  const { rows } = await getAuditLog({ tableFilter: 'device', rowId: deviceId, pageSize: 200 })
  return rows
}
