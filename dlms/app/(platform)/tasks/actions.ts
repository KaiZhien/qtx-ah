'use server'

import { revalidatePath } from 'next/cache'
import {
  requireAal2Actor, MfaRequiredError, UnauthenticatedError, SESSION_EXPIRED_MESSAGE,
} from '@/modules/shared/auth/session'
import {
  createTask, changeTaskStatus, assignTask, addComment,
  TaskNotFoundError, InvalidTransitionError,
} from '@/modules/shared/tasks/services/taskService'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { TaskStatus } from '@/modules/shared/tasks/domain/taskStatus'

export type ActionResult = { ok: true } | { ok: false; error: string }

/**
 * Turns exceptions into sentences a user can act on.
 *
 * Known failures get their own wording; everything else gets a generic message
 * and a server-side log, because an unexpected error's text is written for us,
 * not for the person trying to do their job.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof UnauthenticatedError) return SESSION_EXPIRED_MESSAGE
  if (err instanceof OptimisticLockError) {
    return 'Someone else changed this task. Reload the page and try again.'
  }
  if (err instanceof TaskNotFoundError) return 'That task no longer exists.'
  if (err instanceof InvalidTransitionError) return err.message
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'task action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function changeStatusAction(
  taskId: string, to: TaskStatus, version: number, blockedReason?: string,
): Promise<ActionResult> {
  try {
    const actor = await requireAal2Actor()
    await changeTaskStatus(actor, taskId, to, version, { blockedReason })
    revalidatePath('/tasks')
    revalidatePath(`/tasks/${taskId}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function assignAction(
  taskId: string, assigneeId: string | null, version: number,
): Promise<ActionResult> {
  try {
    const actor = await requireAal2Actor()
    await assignTask(actor, taskId, assigneeId, version)
    revalidatePath('/tasks')
    revalidatePath(`/tasks/${taskId}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function commentAction(taskId: string, body: string): Promise<ActionResult> {
  try {
    const actor = await requireAal2Actor()
    await addComment(actor, taskId, body)
    revalidatePath(`/tasks/${taskId}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function createTaskAction(formData: FormData): Promise<ActionResult & { taskId?: string }> {
  try {
    const actor = await requireAal2Actor()
    const dueRaw = formData.get('dueDate') as string | null
    const linksRaw = formData.get('links') as string | null
    const { taskId } = await createTask(actor, {
      title: String(formData.get('title') ?? ''),
      description: (formData.get('description') as string) || undefined,
      priority: (formData.get('priority') as 'low' | 'normal' | 'high' | 'urgent') || 'normal',
      dueDate: dueRaw ? new Date(dueRaw) : undefined,
      assigneeId: (formData.get('assigneeId') as string) || undefined,
      department: (formData.get('department') as string) || undefined,
      confidential: formData.get('confidential') === 'on',
      links: linksRaw ? JSON.parse(linksRaw) : [],
    })
    revalidatePath('/tasks')
    return { ok: true, taskId }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
