/**
 * Service event service — manages per-device service/maintenance log entries.
 * All DB writes go through here. No component or Server Action writes directly.
 */

import { createAdminClient } from '@/lib/supabase/server'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { parseSheetDate } from '@/lib/domain/normalize'
import { AppError } from '@/lib/types'
import type { ServiceEvent, Role } from '@/lib/types'
import type { ServiceEventWithActor } from '@/lib/domain/serviceEvents'

export async function listServiceEvents(deviceId: string): Promise<ServiceEventWithActor[]> {
  const supabase = createAdminClient()
  const { data, error } = await (supabase.from('service_event') as any)
    .select('*, app_user!service_event_created_by_fkey(email)')
    .eq('device_id', deviceId)
    .order('occurred_on', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const { app_user, ...rest } = row
    return {
      ...rest,
      actor_email: (app_user as { email?: string } | null)?.email ?? null,
    } as ServiceEventWithActor
  })
}

export async function addServiceEvent(
  input: { deviceId: string; description: string; occurredOn: string },
  actorId: string,
  actorRole: Role
): Promise<ServiceEvent> {
  if (!can(actorRole, ACTIONS.LOG_SERVICE_EVENT)) {
    throw new AppError({ type: 'permission', message: 'You do not have permission to log service events' })
  }

  const trimmed = input.description?.trim() ?? ''
  if (!trimmed) {
    throw new AppError({ type: 'validation', message: 'Description is required', errors: { description: ['Description is required'] } })
  }
  if (trimmed.length > 2000) {
    throw new AppError({ type: 'validation', message: 'Description must be 2000 characters or fewer', errors: { description: ['Description must be 2000 characters or fewer'] } })
  }
  // Must be YYYY-MM-DD AND a real calendar date — rejects e.g. 2025-13-40 / 2025-02-30
  let calendarValid = false
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn)) {
    try {
      calendarValid = parseSheetDate(input.occurredOn) === input.occurredOn
    } catch {
      calendarValid = false
    }
  }
  if (!calendarValid) {
    throw new AppError({ type: 'validation', message: 'occurredOn must be a valid date in YYYY-MM-DD format', errors: { occurredOn: ['Must be a valid date in YYYY-MM-DD format'] } })
  }

  const supabase = createAdminClient()
  const { data, error } = await (supabase.from('service_event') as any)
    .insert({
      device_id: input.deviceId,
      description: trimmed,
      occurred_on: input.occurredOn,
      created_by: actorId,
    })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as ServiceEvent
}
