'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusPill } from './StatusPill'
import { entityHref } from './entityHref'
import { changeStatusAction, assignAction, commentAction } from '@/app/(platform)/tasks/actions'
import type { TaskDetail as TaskDetailData } from '@/modules/shared/tasks/services/taskService'
import type { TaskStatus } from '@/modules/shared/tasks/domain/taskStatus'
import type { AssigneeOption } from '@/app/(platform)/tasks/directory'

const UNASSIGNED = '__unassigned__'

type TaskDetailProps = {
  task: TaskDetailData
  /** allowedNextTaskStatuses(task.status) computed server-side — the dropdown
   * never offers a transition the service would reject. */
  allowedNext: TaskStatus[]
  canChangeStatus: boolean
  canAssign: boolean
  canComment: boolean
  assignableUsers: AssigneeOption[]
}

function statusLabel(s: TaskStatus): string {
  return s.replace('_', ' ')
}

function formatDateTime(d: Date): string {
  return new Date(d).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function TaskDetail({
  task, allowedNext, canChangeStatus, canAssign, canComment, assignableUsers,
}: TaskDetailProps) {
  const router = useRouter()
  const [pendingStatus, setPendingStatus] = useState<TaskStatus | null>(null)
  const [blockedReason, setBlockedReason] = useState('')
  const [statusSubmitting, setStatusSubmitting] = useState(false)
  const [assignSubmitting, setAssignSubmitting] = useState(false)
  const [commentBody, setCommentBody] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)

  async function commitStatus(to: TaskStatus, reason?: string) {
    setStatusSubmitting(true)
    try {
      const res = await changeStatusAction(task.id, to, task.version, reason)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      setPendingStatus(null)
      setBlockedReason('')
      toast.success(`Status changed to ${statusLabel(to)}`)
      router.refresh()
    } finally {
      setStatusSubmitting(false)
    }
  }

  function handleStatusPick(to: TaskStatus) {
    // Blocking demands a reason so someone else can act on it later — the
    // service itself rejects a blocked transition with no reason.
    if (to === 'blocked') {
      setPendingStatus(to)
      return
    }
    commitStatus(to)
  }

  async function handleAssign(rawId: string) {
    const assigneeId = rawId === UNASSIGNED ? null : rawId
    setAssignSubmitting(true)
    try {
      const res = await assignAction(task.id, assigneeId, task.version)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success('Assignee updated')
      router.refresh()
    } finally {
      setAssignSubmitting(false)
    }
  }

  async function handleComment(e: React.FormEvent) {
    e.preventDefault()
    const body = commentBody.trim()
    if (!body) return
    setCommentSubmitting(true)
    try {
      const res = await commentAction(task.id, body)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      setCommentBody('')
      router.refresh()
    } finally {
      setCommentSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{task.title}</h1>
          {task.description && (
            <p className="mt-2 whitespace-pre-wrap text-slate-700">{task.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={task.status} />
          {canChangeStatus && allowedNext.length > 0 && (
            <Select
              value=""
              onValueChange={(v) => handleStatusPick(v as TaskStatus)}
              disabled={statusSubmitting}
            >
              <SelectTrigger className="w-48" aria-label="Change task status">
                <SelectValue placeholder="Change status…" />
              </SelectTrigger>
              <SelectContent>
                {allowedNext.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">{statusLabel(s)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {task.blockedReason && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          Blocked: {task.blockedReason}
        </p>
      )}

      {pendingStatus === 'blocked' && (
        <div className="space-y-2 rounded-md border p-3">
          <label htmlFor="blocked-reason" className="block text-sm font-medium text-slate-700">
            Why is this blocked?
          </label>
          <Textarea
            id="blocked-reason"
            value={blockedReason}
            onChange={(e) => setBlockedReason(e.target.value)}
            rows={2}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button" variant="outline" size="sm"
              onClick={() => { setPendingStatus(null); setBlockedReason('') }}
              disabled={statusSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="button" size="sm"
              disabled={statusSubmitting || !blockedReason.trim()}
              onClick={() => commitStatus('blocked', blockedReason.trim())}
            >
              {statusSubmitting ? 'Saving…' : 'Block task'}
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Assignee</h2>
          {canAssign ? (
            <Select
              value={task.assigneeId ?? UNASSIGNED}
              onValueChange={handleAssign}
              disabled={assignSubmitting}
            >
              <SelectTrigger className="mt-1.5 w-56" aria-label="Change assignee">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                {assignableUsers.map((u) => (
                  <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="mt-1.5 text-sm text-slate-700">{task.assigneeName ?? 'Unassigned'}</p>
          )}
        </div>

        <div>
          <h2 className="text-sm font-semibold text-slate-900">Linked records</h2>
          {task.links.length === 0 ? (
            <p className="mt-1.5 text-sm text-muted-foreground">No linked records.</p>
          ) : (
            <div className="mt-1.5 flex flex-wrap gap-2">
              {task.links.map((l) => (
                <Link
                  key={`${l.entityType}-${l.entityId}`}
                  href={entityHref(l.module, l.entityType, l.entityId)}
                  className="rounded-full border bg-slate-50 px-3 py-1 text-xs text-slate-700 hover:bg-slate-100"
                >
                  {l.entityType} · {l.entityId.slice(0, 8)}
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-slate-900">Subtasks</h2>
        {/* A STUB, deliberately, in the STUB_TABS voice used on the device profile
            (app/(platform)/manufacturing/devices/[id]/page.tsx): visibly unfinished
            beats silently pretending.

            LISTING is the small half — `task.parent_task_id` exists, and listTasks
            already applies canSeeTask, so a parentTaskId filter would inherit the
            visibility rule for free rather than duplicating it. The missing half is
            CREATION: nothing in the app ever sets parentTaskId. createTask's schema
            accepts it and no caller passes it, so the column is NULL on every row
            that will ever exist. Wiring the list alone would render "No subtasks" on
            every task in the system forever — an empty truth that reads as a working
            feature, which is the failure this stub exists to avoid.

            Subtasks are §8.3 scope that "tasks v1" (Week 2, Jul 31) shipped without,
            and §17 schedules no later week for them — so the copy below names no
            date rather than inventing one.

            __tests__/platform/tasks/subtasksStub.test.ts fails the moment a creation
            path appears, which is the signal to build the listing and delete this. */}
        <p className="mt-1.5 text-sm text-muted-foreground">
          Subtasks aren't built yet — nothing in the app creates one, so there is nothing to
          list here. No scheduled week.
        </p>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-slate-900">Comments</h2>
        <div className="mt-2 space-y-3">
          {task.comments.length === 0 && (
            <p className="text-sm text-muted-foreground">No comments yet.</p>
          )}
          {task.comments.map((c) => (
            <div key={c.id} className="rounded-md border p-3 text-sm">
              <p className="whitespace-pre-wrap">{c.body}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {c.authorName} · {formatDateTime(c.createdAt)}
                {c.editedAt && ' (edited)'}
              </p>
            </div>
          ))}
        </div>

        {canComment && (
          <form onSubmit={handleComment} className="mt-3 space-y-2">
            <label htmlFor="new-comment" className="sr-only">Add a comment</label>
            <Textarea
              id="new-comment"
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              placeholder="Add a comment…"
              rows={3}
            />
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={commentSubmitting || !commentBody.trim()}>
                {commentSubmitting ? 'Posting…' : 'Post comment'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
