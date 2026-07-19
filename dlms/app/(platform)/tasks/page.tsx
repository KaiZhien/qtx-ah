import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listTasksFor } from '@/modules/shared/tasks/services/taskService'
import { TASK_STATUSES, type TaskStatus } from '@/modules/shared/tasks/domain/taskStatus'
import { TaskList } from '@/components/tasks/TaskList'
import { listAssignableUsers } from './directory'
import type { ModuleKey } from '@/modules/shared/authz/catalog'

type Scope = 'mine' | 'department' | 'all'

function parseScope(v: string | undefined): Scope {
  return v === 'department' || v === 'all' ? v : 'mine'
}

type PageProps = {
  searchParams: { scope?: string; status?: string; priority?: string; module?: string; overdue?: string }
}

/**
 * The central task centre. Scope/status/module/overdue live in search params
 * so every filter combination is a plain server fetch through listTasksFor —
 * priority isn't a TaskFilter field (it carries no visibility meaning), so it
 * filters the already-visibility-checked rows here instead of in the service.
 */
export default async function TasksPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, 'view_records', 'tasks')) notFound()

  const scope = parseScope(searchParams.scope)
  const status: TaskStatus[] | undefined = TASK_STATUSES.includes(searchParams.status as TaskStatus)
    ? [searchParams.status as TaskStatus]
    : undefined
  const module: ModuleKey | undefined = searchParams.module && searchParams.module !== 'all'
    ? (searchParams.module as ModuleKey)
    : undefined
  const overdueOnly = searchParams.overdue === 'true'

  const allTasks = await listTasksFor(actor, { scope, status, module, overdueOnly })
  const tasks = searchParams.priority && searchParams.priority !== 'all'
    ? allTasks.filter((t) => t.priority === searchParams.priority)
    : allTasks

  const canAssign = can(actor, 'assign_tasks', 'tasks')
  const canCreate = can(actor, 'create_records', 'tasks')
  const assignableUsers = canAssign ? await listAssignableUsers(actor) : []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Tasks</h1>
        <p className="mt-1 text-slate-600">
          Everything assigned to you and your team, across every module.
        </p>
      </div>
      <TaskList
        tasks={tasks}
        filter={{
          scope,
          status: searchParams.status ?? 'all',
          priority: searchParams.priority ?? 'all',
          module: searchParams.module ?? 'all',
          overdueOnly,
        }}
        assignableUsers={assignableUsers}
        canAssign={canAssign}
        canCreate={canCreate}
      />
    </div>
  )
}
