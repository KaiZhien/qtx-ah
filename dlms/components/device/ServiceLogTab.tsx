'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { addServiceEventAction } from '@/app/legacy/devices/actions'
import {
  groupServiceEventsByDate,
  formatOccurredOn,
  type ServiceEventWithActor,
} from '@/lib/domain/serviceEvents'

interface ServiceLogTabProps {
  deviceId: string
  initialEvents: ServiceEventWithActor[]
  canLog: boolean
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

export function ServiceLogTab({ deviceId, initialEvents, canLog }: ServiceLogTabProps) {
  const router = useRouter()
  const [description, setDescription] = useState('')
  const [occurredOn, setOccurredOn] = useState(todayISO)
  const [submitting, setSubmitting] = useState(false)
  const [descError, setDescError] = useState<string | null>(null)

  const dateGroups = groupServiceEventsByDate(initialEvents)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!description.trim()) {
      setDescError('Description is required')
      return
    }
    setDescError(null)
    setSubmitting(true)
    try {
      const result = await addServiceEventAction(deviceId, description.trim(), occurredOn)
      if ('error' in result) {
        toast.error(result.error)
      } else {
        setDescription('')
        setOccurredOn(todayISO())
        router.refresh()
      }
    } catch {
      toast.error('Failed to save service event')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6 mt-4">
      {/* Add event form */}
      {canLog && (
        <form onSubmit={handleSubmit} className="border rounded-md p-4 space-y-3">
          <h3 className="text-sm font-semibold">Log Service Event</h3>
          <div className="space-y-1">
            <Textarea
              placeholder="What work was done?"
              value={description}
              onChange={(e) => { setDescription(e.target.value); setDescError(null) }}
              rows={3}
              className="text-sm"
            />
            {descError && (
              <p className="text-xs text-destructive">{descError}</p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Input
              type="date"
              value={occurredOn}
              onChange={(e) => setOccurredOn(e.target.value)}
              className="h-8 w-40 text-xs"
            />
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting ? 'Saving…' : 'Add Event'}
            </Button>
          </div>
        </form>
      )}

      {/* Empty state */}
      {initialEvents.length === 0 && (
        <p className="text-sm text-muted-foreground">No service events logged yet</p>
      )}

      {/* Date-grouped event list */}
      {dateGroups.map((group) => (
        <div key={group.date} className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1">
            {group.label}
          </p>
          <div className="space-y-2">
            {group.events.map((event) => (
              <div key={event.id} className="border rounded-md p-3 text-sm space-y-1 bg-background">
                <p className="whitespace-pre-wrap">{event.description}</p>
                <p className="text-xs text-muted-foreground">
                  {event.actor_email ?? 'Unknown'} · {formatOccurredOn(event.occurred_on)}
                </p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
