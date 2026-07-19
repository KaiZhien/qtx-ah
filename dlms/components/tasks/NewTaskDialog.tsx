'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { TaskForm, EMPTY_TASK_FORM, type TaskFormValues } from './TaskForm'
import { createTaskAction } from '@/app/(platform)/tasks/actions'
import type { ModuleKey } from '@/modules/shared/authz/catalog'
import type { AssigneeOption } from '@/app/(platform)/tasks/directory'

type NewTaskDialogProps = {
  assignableUsers: AssigneeOption[]
  canAssign: boolean
  /** Fixes the task's one link to this record — used by TaskPanel so a task
   * created from a record page is always linked to it, with no picker needed. */
  presetLink?: { entityType: string; entityId: string; module: ModuleKey }
  triggerLabel?: string
}

/** Owns the dialog's open/submitting/error state and turns TaskForm's values
 * into the FormData createTaskAction expects — same division of labor as
 * UserTable does around UserForm. */
export function NewTaskDialog({
  assignableUsers, canAssign, presetLink, triggerLabel = 'New task',
}: NewTaskDialogProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(values: TaskFormValues) {
    setSubmitting(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.set('title', values.title)
      if (values.description) fd.set('description', values.description)
      fd.set('priority', values.priority)
      if (values.dueDate) fd.set('dueDate', values.dueDate)
      if (values.assigneeId) fd.set('assigneeId', values.assigneeId)
      if (values.department) fd.set('department', values.department)
      if (values.confidential) fd.set('confidential', 'on')
      fd.set('links', JSON.stringify(presetLink ? [presetLink] : []))

      const res = await createTaskAction(fd)
      if (!res.ok) {
        setError(res.error)
        toast.error(res.error)
        return
      }
      toast.success('Task created')
      setOpen(false)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => { setError(null); setOpen(true) }}>
        <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
        {triggerLabel}
      </Button>
      <Dialog open={open} onOpenChange={(o) => { if (!o) setOpen(false) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
          </DialogHeader>
          <TaskForm
            initial={EMPTY_TASK_FORM}
            submitting={submitting}
            error={error}
            assignableUsers={assignableUsers}
            canAssign={canAssign}
            presetLink={presetLink}
            onCancel={() => setOpen(false)}
            onSubmit={handleSubmit}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
