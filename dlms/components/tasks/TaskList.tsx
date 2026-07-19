'use client'

import Link from 'next/link'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { StatusPill } from './StatusPill'
import { NewTaskDialog } from './NewTaskDialog'
import { TASK_STATUSES } from '@/modules/shared/tasks/domain/taskStatus'
import { MODULES } from '@/modules/shared/authz/catalog'
import type { TaskListItem } from '@/modules/shared/tasks/services/taskService'
import type { AssigneeOption } from '@/app/(platform)/tasks/directory'

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

export type TaskListFilter = {
  scope: 'mine' | 'department' | 'all'
  status: string
  priority: string
  module: string
  overdueOnly: boolean
}

type TaskListProps = {
  tasks: TaskListItem[]
  filter: TaskListFilter
  assignableUsers: AssigneeOption[]
  canAssign: boolean
  canCreate: boolean
}

function formatDue(d: Date | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** The central task centre: scope tabs + filters drive the URL's search
 * params, so every combination is a plain server-rendered fetch through
 * app/(platform)/tasks/page.tsx — there is no client-side task cache to keep
 * in sync with the server's visibility rule. */
export function TaskList({ tasks, filter, assignableUsers, canAssign, canCreate }: TaskListProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (value === 'all' || value === '') params.delete(key)
    else params.set(key, value)
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={filter.scope} onValueChange={(v) => setParam('scope', v)}>
          <TabsList>
            <TabsTrigger value="mine">Mine</TabsTrigger>
            <TabsTrigger value="department">My department</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
        {canCreate && <NewTaskDialog assignableUsers={assignableUsers} canAssign={canAssign} />}
      </div>

      <div className="flex flex-wrap gap-3">
        <Select value={filter.status} onValueChange={(v) => setParam('status', v)}>
          <SelectTrigger className="w-44" aria-label="Filter by status"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {TASK_STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="capitalize">{s.replace('_', ' ')}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filter.priority} onValueChange={(v) => setParam('priority', v)}>
          <SelectTrigger className="w-40" aria-label="Filter by priority"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All priorities</SelectItem>
            {PRIORITIES.map((p) => (
              <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filter.module} onValueChange={(v) => setParam('module', v)}>
          <SelectTrigger className="w-44" aria-label="Filter by module"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All modules</SelectItem>
            {MODULES.map((m) => (
              <SelectItem key={m} value={m} className="capitalize">{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            className="rounded border-gray-300"
            checked={filter.overdueOnly}
            onChange={(e) => setParam('overdue', e.target.checked ? 'true' : '')}
          />
          Overdue only
        </label>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Assignee</TableHead>
              <TableHead>Due</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No tasks match these filters.
                </TableCell>
              </TableRow>
            ) : (
              tasks.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <Link href={`/tasks/${t.id}`} className="font-medium text-slate-900 hover:underline">
                      {t.title}
                    </Link>
                  </TableCell>
                  <TableCell><StatusPill status={t.status} /></TableCell>
                  <TableCell className="capitalize">{t.priority}</TableCell>
                  <TableCell>{t.assigneeName ?? 'Unassigned'}</TableCell>
                  <TableCell className={t.overdue ? 'font-medium text-red-700' : undefined}>
                    {t.overdue && 'Overdue — '}
                    {formatDue(t.dueDate)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
