'use client'

import { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { FIELD_LABELS } from '@/lib/i18n/fields'
import {
  HISTORY_GROUP_OPTIONS,
  deviceVersionOf,
  filterHistoryEntries,
  groupEntriesByDate,
} from '@/lib/domain/historyView'
import type { AuditEntry } from '@/lib/types'

const ACTION_DOT: Record<string, string> = {
  insert:      'bg-green-500',
  update:      'bg-blue-500',
  soft_delete: 'bg-red-500',
}

const ACTION_LABEL: Record<string, string> = {
  insert:      'Created',
  update:      'Updated',
  soft_delete: 'Deleted',
}

interface ChangeHistoryTabProps {
  history: AuditEntry[]
}

export function ChangeHistoryTab({ history }: ChangeHistoryTabProps) {
  const [actionFilter, setActionFilter] = useState<string>('all')
  const [groupFilter, setGroupFilter]   = useState<string>('all')

  const filtered = filterHistoryEntries(history, {
    action: actionFilter === 'all' ? undefined : actionFilter,
    group:  groupFilter  === 'all' ? undefined : groupFilter,
  })
  const dateGroups = groupEntriesByDate(filtered)

  const hasFilters = actionFilter !== 'all' || groupFilter !== 'all'

  function clearFilters() {
    setActionFilter('all')
    setGroupFilter('all')
  }

  return (
    <div className="space-y-4 mt-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={actionFilter} onValueChange={setActionFilter}>
          <SelectTrigger className="h-8 w-36 text-xs">
            <SelectValue placeholder="Action" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            <SelectItem value="insert">Created</SelectItem>
            <SelectItem value="update">Updated</SelectItem>
            <SelectItem value="soft_delete">Deleted</SelectItem>
          </SelectContent>
        </Select>

        <Select value={groupFilter} onValueChange={setGroupFilter}>
          <SelectTrigger className="h-8 w-44 text-xs">
            <SelectValue placeholder="Section" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sections</SelectItem>
            {HISTORY_GROUP_OPTIONS.map((opt) => (
              <SelectItem key={opt.key} value={opt.key}>{opt.labelEn}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={clearFilters}>
            Clear filters
          </Button>
        )}

        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {filtered.length} / {history.length} entries
        </span>
      </div>

      {/* Empty states */}
      {history.length === 0 && (
        <p className="text-sm text-muted-foreground">No change history yet.</p>
      )}
      {history.length > 0 && filtered.length === 0 && (
        <div className="text-sm text-muted-foreground space-y-1">
          <p>No changes match the selected filters.</p>
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
      )}

      {/* Date-grouped timeline */}
      {dateGroups.map((group) => (
        <div key={group.dateKey} className="space-y-1">
          {/* Date header */}
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1">
            {new Date(group.dateKey + 'T12:00:00Z').toLocaleDateString(undefined, {
              year: 'numeric', month: 'long', day: 'numeric',
            })}
          </p>

          {/* Entries — vertical timeline rail */}
          <div className="relative pl-5">
            {/* Vertical line */}
            <div className="absolute left-[7px] top-2 bottom-2 w-px bg-border" />

            <div className="space-y-3">
              {group.entries.map((entry) => {
                const version = deviceVersionOf(entry)
                return (
                  <div key={entry.id} className="relative">
                    {/* Timeline dot */}
                    <div
                      className={`absolute -left-5 top-[7px] h-2.5 w-2.5 rounded-full border-2 border-background ${ACTION_DOT[entry.action] ?? 'bg-muted'}`}
                    />

                    <div className="border rounded-md p-3 space-y-1.5 text-sm bg-background">
                      {/* Header row */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge
                          variant={entry.action === 'soft_delete' ? 'destructive' : 'outline'}
                          className="text-xs"
                        >
                          {ACTION_LABEL[entry.action] ?? entry.action}
                        </Badge>
                        {version !== null && (
                          <Badge variant="secondary" className="text-xs font-mono">
                            v{version}
                          </Badge>
                        )}
                        <span className="text-muted-foreground text-xs">
                          {entry.actor_email ?? 'System'}
                        </span>
                        <span
                          className="text-xs text-muted-foreground tabular-nums"
                          title={new Date(entry.occurred_at).toLocaleString()}
                        >
                          {formatDistanceToNow(new Date(entry.occurred_at), { addSuffix: true })}
                        </span>
                      </div>

                      {/* Field-level diffs */}
                      {entry.changed_columns.length > 0 && (
                        <div className="text-xs space-y-0.5 pl-0.5">
                          {entry.changed_columns.map((col) => {
                            const oldVal = (entry.old_values as Record<string, unknown> | null)?.[col]
                            const newVal = (entry.new_values as Record<string, unknown>)[col]
                            return (
                              <div key={col} className="flex gap-2 items-baseline flex-wrap">
                                <span className="font-medium w-32 shrink-0">
                                  {FIELD_LABELS[col]?.en ?? col}
                                </span>
                                <span className="text-red-600 line-through">{String(oldVal ?? '')}</span>
                                <span className="text-muted-foreground">→</span>
                                <span className="text-green-700">{String(newVal ?? '')}</span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
