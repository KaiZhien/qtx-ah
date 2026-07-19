import { getPool } from '@/lib/db/pool'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

export type AssigneeOption = { id: string; name: string }

/**
 * Active employees eligible to be a task's assignee.
 *
 * Task 11 shipped no user-directory read (assignTask/createTask only validate
 * a single id), and the platform's real staff directory
 * (modules/admin/services/userService.listUsers) is gated on manage_users,
 * which most people who assign tasks do not hold. Assignment is org-wide by
 * design — any active employee, not just people who share the assigner's
 * module access (assignTask itself only checks the target is active) — so
 * this is a plain read gated on the same permission that lets a caller
 * reassign a task, not a copy of manage_users.
 */
export async function listAssignableUsers(actor: Actor): Promise<AssigneeOption[]> {
  authorize(actor, 'assign_tasks', 'tasks')
  const { rows } = await getPool().query<{ id: string; full_name: string }>(
    `SELECT id, full_name FROM app_user WHERE active AND deleted_at IS NULL ORDER BY full_name`,
  )
  return rows.map((r) => ({ id: r.id, name: r.full_name }))
}
