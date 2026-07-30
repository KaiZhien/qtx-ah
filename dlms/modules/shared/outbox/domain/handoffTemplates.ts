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
  deviceId: string
  deviceSn: string | null
  pcbaASnLegacy: string | null
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

const ELLIPSIS = '…'

/**
 * Truncates with a trailing ellipsis rather than throwing: a handoff task that
 * arrives slightly abbreviated is far better than one the drain can never
 * create because `createTask` rejects an oversized field. The result's length
 * never exceeds `max` (in UTF-16 code units — the unit `createSchema`'s zod
 * `.max()` counts, and thus what the Postgres `text` insert must satisfy),
 * including the ellipsis character itself.
 *
 * Cuts on whole code points, not UTF-16 code units: `reason`/`deviceSn` can
 * contain astral-plane characters (emoji, CJK Extension B+ names), which are
 * two code units each. Slicing on `.length` can land mid-surrogate-pair,
 * producing a lone surrogate that is not validly encodable as UTF-8 — merely
 * relocating the failure this function exists to prevent to `createTask`'s
 * insert (or corrupting it via replacement-character substitution). Iterating
 * the string (rather than indexing it) walks whole code points for free.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 0) return ''

  let result = ''
  for (const codePoint of text) {
    if (result.length + codePoint.length + ELLIPSIS.length > max) break
    result += codePoint
  }
  return `${result}${ELLIPSIS}`
}

/**
 * Three tiers, in order, so a queue of handoff tasks stays distinguishable
 * even for legacy-migrated rows:
 *
 * 1. `deviceSn` — the canonical identity when present.
 * 2. `pcbaASnLegacy` — the de-facto identity for legacy-migrated rows that
 *    never got a `device_sn`. May hold a preserved range such as
 *    `"EE-02A-2603-0001 to 0015"`; rendered verbatim, never parsed.
 * 3. A short prefix of the device's UUID (`deviceId`), which every row has
 *    regardless of serial data. This is the tier that matters most: without
 *    it, two serial-less devices would both render the same fixed literal,
 *    and a logistics queue full of character-for-character identical titles
 *    is effectively useless even though each task links to a different
 *    device.
 *
 * Never renders "null" or a blank identifier at any tier.
 */
function deviceLabel(ctx: HandoffContext): string {
  const sn = ctx.deviceSn?.trim()
  if (sn) return sn

  const legacy = ctx.pcbaASnLegacy?.trim()
  if (legacy) return legacy

  return `device ${ctx.deviceId.slice(0, 8)}`
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

/**
 * Dispatches on templateKey; throws UnknownTemplateError rather than falling
 * back. `task_template_key` is admin-editable free text, so any string —
 * including the name of an inherited `Object.prototype` member such as
 * `"constructor"` or `"toString"` — is a plausible input. A plain truthiness
 * check on `HANDOFF_TEMPLATES[templateKey]` would walk the prototype chain
 * and either hand back an inherited method mistyped as `HandoffTask` or throw
 * a raw `TypeError`; the explicit `hasOwnProperty` guard restricts resolution
 * to keys this module actually registered.
 */
export function buildHandoffTask(templateKey: string, ctx: HandoffContext): HandoffTask {
  if (!Object.prototype.hasOwnProperty.call(HANDOFF_TEMPLATES, templateKey)) {
    throw new UnknownTemplateError(templateKey)
  }
  return HANDOFF_TEMPLATES[templateKey](ctx)
}
