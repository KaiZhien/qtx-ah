'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AlertCircle } from 'lucide-react'
import type { ModuleKey } from '@/modules/shared/authz/catalog'
import type { AssigneeOption } from '@/app/(platform)/tasks/directory'

export type TaskFormValues = {
  title: string
  description: string
  priority: 'low' | 'normal' | 'high' | 'urgent'
  dueDate: string
  assigneeId: string
  department: string
  confidential: boolean
}

export const EMPTY_TASK_FORM: TaskFormValues = {
  title: '', description: '', priority: 'normal', dueDate: '', assigneeId: '', department: '',
  confidential: false,
}

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
const UNASSIGNED = '__unassigned__'

type TaskFormProps = {
  initial: TaskFormValues
  submitting: boolean
  error: string | null
  assignableUsers: AssigneeOption[]
  canAssign: boolean
  /** Set when opened from a record page — the link is fixed, not editable here. */
  presetLink?: { entityType: string; entityId: string; module: ModuleKey }
  onCancel: () => void
  onSubmit: (values: TaskFormValues) => void
}

/** Create-task form. Reused by the central task centre's "New task" dialog
 * (no presetLink) and by TaskPanel's "New task" button (presetLink fixes the
 * record this task will be linked to). */
export function TaskForm({
  initial, submitting, error, assignableUsers, canAssign, presetLink, onCancel, onSubmit,
}: TaskFormProps) {
  const [title, setTitle] = useState(initial.title)
  const [description, setDescription] = useState(initial.description)
  const [priority, setPriority] = useState<TaskFormValues['priority']>(initial.priority)
  const [dueDate, setDueDate] = useState(initial.dueDate)
  const [assigneeId, setAssigneeId] = useState(initial.assigneeId)
  const [department, setDepartment] = useState(initial.department)
  const [confidential, setConfidential] = useState(initial.confidential)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    onSubmit({ title, description, priority, dueDate, assigneeId, department, confidential })
  }

  const canSubmit = title.trim().length > 0

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {presetLink && (
        <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Linked to this {presetLink.entityType} record.
        </p>
      )}

      <div>
        <Label htmlFor="task-title" className="mb-1.5 block">Title</Label>
        <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </div>

      <div>
        <Label htmlFor="task-description" className="mb-1.5 block">Description</Label>
        <Textarea
          id="task-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label className="mb-1.5 block">Priority</Label>
          <Select value={priority} onValueChange={(v) => setPriority(v as TaskFormValues['priority'])}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {PRIORITIES.map((p) => (
                <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="task-due" className="mb-1.5 block">Due date</Label>
          <Input
            id="task-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
          />
        </div>
      </div>

      {canAssign && (
        <div>
          <Label className="mb-1.5 block">Assignee</Label>
          <Select value={assigneeId || UNASSIGNED} onValueChange={(v) => setAssigneeId(v === UNASSIGNED ? '' : v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
              {assignableUsers.map((u) => (
                <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div>
        <Label htmlFor="task-department" className="mb-1.5 block">Department (optional)</Label>
        <Input
          id="task-department"
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
          placeholder="For routing to a department's task list"
        />
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="rounded border-gray-300"
          checked={confidential}
          onChange={(e) => setConfidential(e.target.checked)}
        />
        Confidential — visible only to the creator, the assignee, and Admins
      </label>

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !canSubmit}>
          {submitting ? 'Creating…' : 'Create task'}
        </Button>
      </div>
    </form>
  )
}
