import type { Tx } from '@/lib/db/tx'

/**
 * `app_setting` — the runtime-knob store (spec §3.1 "system settings"), read side.
 *
 * WHY THIS IS A SERVICE AND NOT A CONSTANT. The whole reason the table exists is
 * that a Super Admin retunes the Finance approval threshold from the settings
 * console without a deploy and without a migration (see the seed block in
 * 20260802000000_platform_approvals.sql: "Code that reads it must read it from
 * here every time — a cached or hardcoded 5000 would make the console lie"). So
 * there is no module-level cache here, and there is no default baked into the
 * reader: a knob nobody set is a MISCONFIGURATION, not a value.
 *
 * WHY THERE IS NO `actor` AND NO `authorize` HERE. This is a Tx-only internal, not
 * a public entry point: its one caller reads a knob in order to ENFORCE a gate,
 * inside a transaction it already opened and already authorized. Gating the read
 * on a permission would mean an actor's own grants could decide whether a control
 * applies to them, which is the wrong way round. `manage_settings` gates WRITING a
 * knob — a console that does not exist yet — and that write path is where an
 * authorize call will belong. Nothing here surfaces a value to a user; the caller
 * decides what to show and behind which gate.
 *
 * WHY IT TAKES A `Tx`. Every consumer needs the knob in the same transaction that
 * locks the record the knob governs. `withTransaction` acquires a SEPARATE pooled
 * connection each time (the reason requestApprovalInTx and changeDeviceStatusInTx
 * exist at all), so a public wrapper would read the threshold on one connection
 * while the gate is enforced on another — and would hold two connections at once
 * for a single `SELECT ... WHERE key = $1`.
 */

/**
 * The one seeded key (20260802000000_platform_approvals.sql). Named here rather
 * than spelled out at the call site so the string that has to match the row lives
 * in exactly one place — the CHECK on `app_setting.key` makes a typo a key nothing
 * will ever look up, which is silent until an invoice is issued unapproved.
 */
export const FINANCE_APPROVAL_THRESHOLD_SGD = 'finance_approval_threshold_sgd'

/**
 * A knob that is missing, or holds something the reader cannot use.
 *
 * A distinct class, not a generic Error, because the caller has to be able to FAIL
 * CLOSED on it and say something true: a control that quietly switches itself off
 * when its setting is deleted is worse than no control at all, since nothing in the
 * UI would ever mention it.
 */
export class SettingUnavailableError extends Error {
  readonly key: string
  constructor(key: string, reason: string) {
    super(`The "${key}" setting ${reason}. Until an administrator sets it, anything that `
      + 'depends on it is refused rather than assumed — a control that silently switched '
      + 'itself off would be invisible.')
    this.name = 'SettingUnavailableError'
    this.key = key
  }
}

/** A plain decimal literal — the shape `numeric` will accept without argument. */
const DECIMAL_LITERAL = /^-?(?:\d+(?:\.\d+)?)$/

/**
 * A numeric knob, as EXACT DECIMAL TEXT rather than as a JS number.
 *
 * `value::text` on a jsonb number is the digits Postgres stored, and handing those
 * digits straight to a `::numeric` cast keeps the comparison in Postgres, where the
 * money already lives. Going through a JS float would reintroduce exactly the
 * rounding the whole finance module avoids by computing its totals in SQL — and it
 * would do so at the one place it matters most, the invoice that sits on the
 * threshold.
 *
 * `key` is always a code constant (never user input), so there is nothing to parse
 * and the parameterised query is the whole of the safety story.
 */
export async function getNumericSettingInTx(tx: Tx, key: string): Promise<string> {
  const { rows } = await tx.query<{ value: string; kind: string }>(
    `SELECT value::text AS value, jsonb_typeof(value) AS kind FROM app_setting WHERE key = $1`,
    [key])
  if (rows.length === 0) throw new SettingUnavailableError(key, 'has never been set')

  const { value, kind } = rows[0]
  // jsonb_typeof, not a regex alone: it names what was found for the error message
  // ("holds a string", "holds an object") without echoing a value of unknown size
  // or content back to a user.
  if (kind !== 'number' || !DECIMAL_LITERAL.test(value)) {
    throw new SettingUnavailableError(key, `holds a ${kind}, not a number`)
  }
  return value
}
