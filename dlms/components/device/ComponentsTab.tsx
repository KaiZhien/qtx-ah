/**
 * ComponentsTab — per-device component timeline.
 *
 * Derives a component-focused history from the generic audit_log entries
 * (already fetched by the detail page) and renders it grouped by component:
 * PCBA-A · Amplifier Board, PCBA-B · Accessory Board, HMI Screen.
 *
 * Server-safe: no client state needed.
 */

import { formatDistanceToNow } from 'date-fns'
import { Badge } from '@/components/ui/badge'
import { DeviceGroupSection } from '@/components/device/DeviceGroupSection'
import { buildComponentTimeline, COMPONENT_GROUP_KEYS, type ComponentGroupKey } from '@/lib/domain/componentHistory'
import type { AuditEntry, DeviceRow } from '@/lib/types'

// Section colours matching DeviceTable.tsx for visual consistency
const SECTION_COLORS: Record<ComponentGroupKey, { header: string; border: string }> = {
  pcba_a:  { header: 'bg-[#e8f0fe] border-[#4285f4]',  border: 'border-[#4285f4]/30' },
  pcba_b:  { header: 'bg-[#e6f4ea] border-[#34a853]',  border: 'border-[#34a853]/30' },
  hmi:     { header: 'bg-[#fce8e6] border-[#ea4335]',  border: 'border-[#ea4335]/30' },
}

interface ComponentsTabProps {
  device: DeviceRow
  history: AuditEntry[]
  canViewHistory: boolean
}

export function ComponentsTab({ device, history, canViewHistory }: ComponentsTabProps) {
  const timeline = buildComponentTimeline(history, device)

  return (
    <div className="space-y-6 mt-4">
      {timeline.map((group) => {
        const colors = SECTION_COLORS[group.groupKey]
        return (
          <div key={group.groupKey} className={`border rounded-md overflow-hidden ${colors.border}`}>
            {/* Section header */}
            <div className={`px-4 py-2 border-b ${colors.header}`}>
              <h3 className="text-sm font-semibold">{group.groupLabelEn}</h3>
              <p className="text-xs text-muted-foreground">{group.groupLabelZh}</p>
            </div>

            <div className="p-4 space-y-4">
              {/* Current config */}
              <DeviceGroupSection groupKey={group.groupKey} device={device} showEmpty={false} />

              {/* Timeline — audit history is gated; viewers see a restriction note
                  instead of a misleading "no changes recorded" empty state. */}
              {!canViewHistory ? (
                <p className="text-xs text-muted-foreground italic">
                  Change history is restricted to engineers and admins.
                </p>
              ) : (
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  Change History
                </h4>

                {group.events.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">No component changes recorded.</p>
                ) : (
                  <div className="space-y-2">
                    {group.events.map((event, i) => (
                      <div key={i} className="border rounded p-3 space-y-1 text-sm bg-background">
                        {/* Event header: badge + actor + relative time */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge
                            variant={event.action === 'soft_delete' ? 'destructive' : 'outline'}
                            className="text-xs"
                          >
                            {event.action === 'insert' ? 'installed' : event.action}
                          </Badge>
                          <span className="text-muted-foreground text-xs">
                            {event.actorEmail ?? 'System'}
                          </span>
                          <span
                            className="text-xs text-muted-foreground tabular-nums"
                            title={new Date(event.occurred_at).toLocaleString()}
                          >
                            {formatDistanceToNow(new Date(event.occurred_at), { addSuffix: true })}
                          </span>
                        </div>

                        {/* Field-level diffs */}
                        {event.changes.length > 0 && (
                          <div className="text-xs space-y-0.5 pl-1">
                            {event.changes.map((change) => (
                              <div key={change.field} className="flex gap-2 items-baseline flex-wrap">
                                <span className="font-medium w-28 shrink-0 text-foreground">
                                  {change.label}
                                </span>
                                {change.oldValue ? (
                                  <>
                                    <span className="text-red-600 line-through">{change.oldValue}</span>
                                    <span className="text-muted-foreground">→</span>
                                  </>
                                ) : null}
                                <span className="text-green-700">{change.newValue || '—'}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Insert with no populated fields — just show "Device created" */}
                        {event.action === 'insert' && event.changes.length === 0 && (
                          <p className="text-xs text-muted-foreground pl-1 italic">
                            No component data recorded at creation.
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
