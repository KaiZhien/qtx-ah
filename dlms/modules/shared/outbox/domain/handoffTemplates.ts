import type { ModuleKey } from '@/modules/shared/authz/catalog'

/**
 * Pure translation from a `status_transition.task_template_key` (spec §5.5) plus
 * the event that fired it into the shape of the handoff task the drain will
 * create. No I/O, no clock — everything comes from HandoffContext, so this can
 * be unit-tested without a database and the drain can call it inside or outside
 * a transaction with identical results.
 *
 * The output is deliberately shaped as direct `createTask` input (see
 * modules/shared/tasks/services/taskService.ts's `createSchema`): same field
 * names, same types, and the SAME length limits enforced here rather than left
 * to the database to reject at drain time.
 */

/** Mirrors createSchema: title is 1-200 chars, description is capped at 5000. */
const TITLE_MAX = 200
const DESCRIPTION_MAX = 5000

export type HandoffTask = {
  title: string
  description: string
  module: ModuleKey
  department: string
  priority: 'low' | 'normal' | 'high' | 'urgent'
}

export type HandoffContext = {
  deviceSn: string | null
  fromStatus: string
  toStatus: string
  reason: string | null
  changedByName: string
}

/**
 * A template key is present in `status_transition` but absent from
 * HANDOFF_TEMPLATES only when the status graph and this module have drifted
 * apart. That is a bug, not a degraded case, so buildHandoffTask throws rather
 * than inventing a generic task that would hide the disagreement. The drain
 * records the throw as a retryable outbox failure (spec §5.5).
 */
export class UnknownTemplateError extends Error {
  constructor(templateKey: string) {
    super(`No handoff template registered for task_template_key "${templateKey}"`)
    this.name = 'UnknownTemplateError'
  }
}

/**
 * Truncates with a trailing ellipsis rather than throwing: a handoff task that
 * arrives slightly abbreviated is far better than one the drain can never
 * create because `createTask` rejects an oversized field. The result's length
 * never exceeds `max`, including the ellipsis character itself.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 1) return text.slice(0, max)
  return `${text.slice(0, max - 1)}…`
}

/**
 * Legacy device rows frequently have no `device_sn` — `pcba_a_sn_legacy` is
 * their de-facto identity instead, but that field isn't part of this event's
 * context, so the best a pure template can do is name the device by what it
 * DOES know without ever rendering "null" or a blank identifier.
 */
function deviceLabel(ctx: HandoffContext): string {
  const sn = ctx.deviceSn?.trim()
  return sn && sn.length > 0 ? sn : 'device with no serial on file'
}

/** e.g. 'ready_for_delivery' -> 'ready for delivery'. */
function humanizeStatus(status: string): string {
  return status.replace(/_/g, ' ')
}

export const HANDOFF_TEMPLATES: Record<string, (ctx: HandoffContext) => HandoffTask> = {
  logistics_prepare_delivery: (ctx) => {
    const device = deviceLabel(ctx)
    const reasonClause = ctx.reason?.trim() ? ` Reason given: ${ctx.reason.trim()}.` : ''

    const title = truncate(`Prepare delivery for ${device}`, TITLE_MAX)
    const description = truncate(
      `${ctx.changedByName} moved ${device} from ${humanizeStatus(ctx.fromStatus)} to ` +
      `${humanizeStatus(ctx.toStatus)}.${reasonClause} Logistics: please prepare this device ` +
      'for outbound delivery.',
      DESCRIPTION_MAX,
    )

    return {
      title,
      description,
      module: 'logistics',
      department: 'Logistics',
      priority: 'normal',
    }
  },
}

/** Dispatches on templateKey; throws UnknownTemplateError rather than falling back. */
export function buildHandoffTask(templateKey: string, ctx: HandoffContext): HandoffTask {
  const template = HANDOFF_TEMPLATES[templateKey]
  if (!template) throw new UnknownTemplateError(templateKey)
  return template(ctx)
}
