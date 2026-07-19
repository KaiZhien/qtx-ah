import type { Actor, ModuleKey } from '@/modules/shared/authz/catalog'

export type TaskVisibilityInput = {
  createdBy: string
  assigneeId: string | null
  confidential: boolean
  /** Modules of every record this task links to. Empty = unlinked, visible to all. */
  linkedModules: ModuleKey[]
}

/**
 * Whether this actor may see this task (spec §8.3).
 *
 * Two independent gates, both of which must pass:
 *
 *   1. Confidentiality — a confidential task is visible only to its creator, its
 *      assignee, and Admins.
 *   2. Link-derived module access — a task linked to a Finance record is as
 *      sensitive as that record, so it inherits the module gate. This is why the
 *      rule takes linkedModules rather than a single module: a task linked to
 *      both a device and an invoice needs BOTH.
 *
 * Involvement does not waive the module gate: being the assignee of a
 * finance-linked task does not grant sight of finance data. If that combination
 * arises, the fix is granting the user Finance access, not weakening the rule.
 *
 * Pure and list-shaped so the service can apply the identical rule to a single
 * task, a list page, and a search autocomplete — search must never surface a task
 * the detail page would refuse (spec §15).
 */
export function canSeeTask(actor: Actor, task: TaskVisibilityInput): boolean {
  if (!actor.active) return false

  const isPrivileged = actor.roleKey === 'super_admin' || actor.roleKey === 'admin'

  if (!isPrivileged) {
    for (const m of task.linkedModules) {
      if (!actor.moduleAccess.has(m)) return false
    }
  }

  if (task.confidential) {
    const involved = actor.id === task.createdBy || actor.id === task.assigneeId
    if (!involved && !isPrivileged) return false
  }

  return true
}
