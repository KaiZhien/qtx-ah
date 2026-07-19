import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listTasksFor } from '@/modules/shared/tasks/services/taskService'
import { listAssignableUsers } from '@/app/(platform)/tasks/directory'
import { StatusPill } from './StatusPill'
import { NewTaskDialog } from './NewTaskDialog'
import type { ModuleKey } from '@/modules/shared/authz/catalog'

type TaskPanelProps = {
  entityType: string
  entityId: string
  module: ModuleKey
}

/**
 * Drops into any record page — Task 13's device detail page is the first
 * caller, unchanged, so this prop shape (entityType, entityId, module) is
 * load-bearing.
 *
 * Server component fetching through the SAME listTasksFor every other
 * surface uses: a task this record's viewer cannot see never renders here
 * either, because there is exactly one visibility rule and it lives in the
 * service, not a copy of it drawn in this component.
 */
export async function TaskPanel({ entityType, entityId, module }: TaskPanelProps) {
  const actor = await requireActor()
  // A record page's viewer need not have the Tasks module at all (moduleAccess
  // is configured per user, independent of the module the record lives in) —
  // listTasksFor's authorize() throws in that case rather than returning an
  // empty list, so this must be checked before calling it, or a viewer of a
  // record they're otherwise entitled to see would get a crashed page instead
  // of a panel that quietly has nothing to show.
  if (!can(actor, 'view_records', 'tasks')) return null

  const tasks = await listTasksFor(actor, { scope: 'all', entityRef: { entityType, entityId } })
  const canCreate = can(actor, 'create_records', 'tasks')
  const canAssign = can(actor, 'assign_tasks', 'tasks')
  const assignableUsers = canAssign ? await listAssignableUsers(actor) : []

  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Tasks</h3>
        {canCreate && (
          <NewTaskDialog
            assignableUsers={assignableUsers}
            canAssign={canAssign}
            presetLink={{ entityType, entityId, module }}
          />
        )}
      </div>

      {tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tasks linked to this record.</p>
      ) : (
        <ul className="divide-y">
          {tasks.map((t) => (
            <li key={t.id} className="py-2">
              <Link
                href={`/tasks/${t.id}`}
                className="flex items-center justify-between gap-3 text-sm hover:underline"
              >
                <span className="truncate">{t.title}</span>
                <StatusPill status={t.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
