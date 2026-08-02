import { z } from 'zod'
import { withTransaction, OptimisticLockError, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import {
  knownSetting, parseSettingValue, SETTING_KEY_PATTERN, type SettingEntry,
} from '@/modules/shared/settings/domain/settingRegistry'

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

// ── The console's read and write path (spec §3.1, permission manage_settings) ──
//
// The header above explains why the READ above has no `authorize`: it is a
// Tx-only internal that enforces a gate inside a transaction its caller already
// authorized. Everything below is the opposite — a public entry point an
// administrator reaches from a screen — so every one of them runs
// `authorize(actor, 'manage_settings', 'admin')` on its first line, ahead of the
// connection, exactly as the platform's other services do.

export class SettingNotEditableError extends Error {
  readonly key: string
  constructor(key: string, reason: string) {
    super(reason)
    this.name = 'SettingNotEditableError'
    this.key = key
  }
}

export type SettingRow = {
  key: string
  /** The raw jsonb value, as stored. */
  value: unknown
  /** The JSON type Postgres reports — 'number', 'string', 'object', … */
  valueType: string
  /** Null when this key is not in the registry: visible, but read-only. */
  entry: SettingEntry | null
  updatedAt: Date
  updatedByName: string | null
  version: number
}

/**
 * Every knob in the table, registered or not.
 *
 * UNREGISTERED KEYS ARE INCLUDED DELIBERATELY. Filtering the list to what the
 * console can edit would make the table look emptier than the database is, and
 * the row an operator most needs to see is precisely the one nobody declared —
 * a knob written by hand, or one left behind by a feature that has since been
 * removed. They come back with `entry: null`, and the page renders them
 * read-only.
 */
export async function listSettings(actor: Actor): Promise<SettingRow[]> {
  authorize(actor, 'manage_settings', 'admin')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      key: string; value: unknown; value_type: string
      updated_at: Date; updated_by_name: string | null; version: number
    }>(
      `SELECT s.key, s.value, jsonb_typeof(s.value) AS value_type,
              s.updated_at, u.full_name AS updated_by_name, s.version
         FROM app_setting s
         LEFT JOIN app_user u ON u.id = s.updated_by
        ORDER BY s.key`)

    return rows.map((r) => ({
      key: r.key,
      value: r.value,
      valueType: r.value_type,
      entry: knownSetting(r.key),
      updatedAt: r.updated_at,
      updatedByName: r.updated_by_name,
      version: r.version,
    }))
  })
}

const updateSchema = z.object({
  key: z.string().min(1).max(100).regex(SETTING_KEY_PATTERN),
  /** Always the raw text from the form; the registry decides what it means. */
  value: z.string().max(10_000),
  version: z.number().int().nonnegative(),
})
export type UpdateSettingInput = z.input<typeof updateSchema>

/**
 * Change one knob.
 *
 * THREE THINGS THIS DOES NOT DO, each on purpose:
 *
 *   IT DOES NOT CREATE. `UPDATE ... WHERE key = $1` only; a key that is not there
 *     is refused rather than inserted. Which keys exist is decided by the
 *     migration that seeds them next to the code that reads them, and a console
 *     that can conjure arbitrary rows into a key→value table is a console that
 *     can typo a knob into existence beside the real one, leaving the reader
 *     failing closed while the screen shows a plausible value.
 *
 *   IT DOES NOT EDIT UNREGISTERED KEYS. Without a declared type there is nothing
 *     to validate against, and storing whatever text was typed is exactly how the
 *     threshold becomes the string "abc".
 *
 *   IT DOES NOT DEFAULT. See settingRegistry's header: a missing knob stays
 *     missing and the reader keeps failing closed and loudly.
 *
 * The optimistic lock is not ceremony despite the tiny row count — the column's
 * own COMMENT names the collision it arbitrates: two admins retuning the
 * threshold from this console at once. `fn_audit` records who and when, which is
 * the question an auditor actually asks about a settings change.
 */
export async function updateSetting(
  actor: Actor, input: UpdateSettingInput,
): Promise<{ version: number }> {
  authorize(actor, 'manage_settings', 'admin')
  const data = updateSchema.parse(input)

  // Parsed AHEAD of the connection: a malformed value is knowable from the input
  // alone, and refusing it here costs no pooled connection and no BEGIN/ROLLBACK.
  const parsed = parseSettingValue(data.key, data.value)
  if (!parsed.ok) throw new SettingNotEditableError(data.key, parsed.error)

  return withTransaction(actor.id, async (tx) => {
    const { rows: current } = await tx.query<{ version: number }>(
      `SELECT version FROM app_setting WHERE key = $1 FOR UPDATE`, [data.key])
    if (current.length === 0) {
      throw new SettingNotEditableError(data.key,
        `There is no "${data.key}" setting to change. Settings are created by the migration that `
        + 'ships the code reading them, never from this screen — otherwise a typo here becomes a '
        + 'second key beside the real one, and the real one stays unset.')
    }
    if (current[0].version !== data.version) throw new OptimisticLockError('app_setting', data.key)

    const { rows } = await tx.query<{ version: number }>(
      `UPDATE app_setting
          SET value = $1::jsonb, updated_at = now(), updated_by = $2, version = version + 1
        WHERE key = $3 AND version = $4
        RETURNING version`,
      [JSON.stringify(parsed.value), actor.id, data.key, data.version])
    if (rows.length === 0) throw new OptimisticLockError('app_setting', data.key)

    return { version: rows[0].version }
  })
}
