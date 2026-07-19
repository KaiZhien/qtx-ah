import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { getTask } from '@/modules/shared/tasks/services/taskService'
import { allowedNextTaskStatuses } from '@/modules/shared/tasks/domain/taskStatus'
import { TaskDetail } from '@/components/tasks/TaskDetail'
import { listAssignableUsers } from '../directory'

type PageProps = { params: { id: string } }

export default async function TaskDetailPage({ params }: PageProps) {
  const actor = await requireActor()
  // getTask's own authorize() throws for an actor without the tasks module at
  // all (unlike task-specific visibility, which it expresses as a null
  // return) — check the module gate first so that case 404s like every other
  // module-gated page instead of surfacing an uncaught PermissionError.
  if (!can(actor, 'view_records', 'tasks')) notFound()

  const task = await getTask(actor, params.id)
  // getTask returns null both when the task doesn't exist and when the actor
  // can't see it (confidential / module-gated) — that null IS the 404, so a
  // task invisible on every list is equally unreachable by direct URL
  // (spec §7.3: a denial must never confirm a record exists).
  if (!task) notFound()

  const canChangeStatus = can(actor, 'edit_records', 'tasks')
  const canAssign = can(actor, 'assign_tasks', 'tasks')
  const canComment = can(actor, 'view_records', 'tasks')
  const assignableUsers = canAssign ? await listAssignableUsers(actor) : []

  return (
    <TaskDetail
      task={task}
      allowedNext={allowedNextTaskStatuses(task.status)}
      canChangeStatus={canChangeStatus}
      canAssign={canAssign}
      canComment={canComment}
      assignableUsers={assignableUsers}
    />
  )
}
