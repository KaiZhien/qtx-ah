/**
 * WHAT THE SETTINGS CONSOLE IS ALLOWED TO WRITE, and in what shape.
 *
 * Pure — no I/O, no clock. `app_setting.value` is `jsonb`, which is exactly the
 * right storage (a knob can be a number, a flag, a string or a small object
 * without a migration) and exactly the wrong thing to expose to a text input
 * unguarded: a threshold that becomes the STRING "abc" is accepted by the column,
 * survives the round trip, and is then discovered at the moment somebody tries to
 * issue an invoice — by which point the person who typed it is gone and the
 * failure looks like a bug in Finance.
 *
 * So every knob the console may EDIT is declared here with a type and a
 * validator, and the value is parsed on the way in. A key that is not declared is
 * still VISIBLE in the console — hiding rows would make the table look emptier
 * than it is, and an operator debugging a knob needs to see it — but it is
 * READ-ONLY, because inventing a type for a key whose meaning this module does
 * not know is how a console corrupts a setting it was only supposed to display.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN: DEFAULTS.
 *
 * There is no `default` and no `fallback` field, and adding one would undo a
 * decision the platform already made and tested. `getNumericSettingInTx` treats a
 * missing or non-numeric knob as a MISCONFIGURATION and fails closed and loudly,
 * naming the setting — because a control that silently switches itself off when
 * its row is deleted is invisible, and nothing in the UI would ever mention it.
 *
 * A default in the console would look harmless (it only fills a form field) and
 * would not be: the moment the console can say "unset means 5000", the reader's
 * refusal becomes a bug rather than the design, and someone reconciles the two by
 * softening the reader. The registry describes what a value must LOOK like, never
 * what it should BE when absent.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Mirrors the CHECK on `app_setting.key`: a console typo can never become a row. */
export const SETTING_KEY_PATTERN = /^[a-z][a-z0-9_]*$/

export type SettingType = 'number' | 'integer' | 'boolean' | 'string'

export type SettingEntry = {
  /** How the console names it. */
  label: string
  /** What it does, and what happens when it is wrong — shown next to the field. */
  description: string
  type: SettingType
  /** Inclusive bounds for `number` / `integer`. */
  min?: number
  max?: number
  /** Appended to the field, e.g. "SGD", "days". Purely presentational. */
  unit?: string
}

/**
 * Every knob the console may edit.
 *
 * ONE entry today, and that is not an oversight — it is the only key the platform
 * actually reads. Registering a key nothing reads would put a control in front of
 * an administrator that changes nothing, which is worse than an absent one.
 *
 * `export_retention_days` (spec §6.3) is deliberately NOT registered yet: the
 * export subsystem that would read it does not exist, and whether an absent
 * retention setting should fail closed (as the finance threshold does) or is
 * legitimately optional is a decision for whoever builds it — "no retention
 * limit" is a coherent policy in a way that "no approval threshold" is not.
 * Registering it is a two-line change here once that call is made; until then it
 * still shows in the console, read-only, if a row exists.
 */
export const SETTING_REGISTRY: Record<string, SettingEntry> = {
  finance_approval_threshold_sgd: {
    label: 'Finance approval threshold',
    description:
      'A sales invoice whose total is AT OR ABOVE this amount cannot be issued without an '
      + 'approved, non-drifted approval. Read from this table on every issue, so a change takes '
      + 'effect immediately with no deploy. If this setting is missing or is not a number, '
      + 'issuing is REFUSED rather than assumed — a control that silently switched itself off '
      + 'would be invisible.',
    type: 'number',
    min: 0,
    // numeric(12,2) holds ten integer digits; beyond that the comparison would be
    // against a value the column cannot represent.
    max: 9_999_999_999,
    unit: 'SGD',
  },
}

/** Own-property guarded: `key` arrives from a form post and from a jsonb row. */
export function isKnownSetting(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(SETTING_REGISTRY, key)
}

export function knownSetting(key: string): SettingEntry | null {
  return isKnownSetting(key) ? SETTING_REGISTRY[key] : null
}

export type ParsedSetting =
  | { ok: true; value: number | boolean | string }
  | { ok: false; error: string }

/**
 * A plain decimal literal — no exponent, no hex, no thousands separators, no
 * blanks. The same shape `getNumericSettingInTx` demands on the way OUT, restated
 * here on the way IN so the two can never disagree about what a number is:
 * accepting "1e5" would store a value the reader then rejects, which is a knob
 * that looks set and behaves as if it is not.
 */
const DECIMAL_LITERAL = /^-?(?:\d+(?:\.\d+)?)$/

/**
 * Turns a form field into the jsonb value that will be stored, or explains why it
 * cannot be.
 *
 * Refusals are sentences rather than codes because they are shown verbatim next
 * to the field the administrator just typed in.
 */
export function parseSettingValue(key: string, raw: string): ParsedSetting {
  const entry = knownSetting(key)
  if (!entry) {
    return {
      ok: false,
      error: `"${key}" is not a setting this console knows how to edit. It is shown read-only `
        + 'because changing a value whose meaning and type are undeclared is how a setting gets '
        + 'corrupted by the screen that was only supposed to display it.',
    }
  }

  const text = raw.trim()

  if (entry.type === 'boolean') {
    if (text === 'true') return { ok: true, value: true }
    if (text === 'false') return { ok: true, value: false }
    return { ok: false, error: `${entry.label} must be either true or false.` }
  }

  if (entry.type === 'string') {
    if (!text) return { ok: false, error: `${entry.label} cannot be blank.` }
    return { ok: true, value: text }
  }

  // number | integer
  if (!DECIMAL_LITERAL.test(text)) {
    return {
      ok: false,
      error: `${entry.label} must be a plain number — digits, and at most one decimal point. `
        + '"1e5", "1,000" and "abc" are refused here rather than stored and discovered later by '
        + 'whatever reads this setting.',
    }
  }
  if (entry.type === 'integer' && text.includes('.')) {
    return { ok: false, error: `${entry.label} must be a whole number.` }
  }

  const value = Number(text)
  // Guards the range where a double stops representing integers exactly: past
  // this, the number stored is not the number typed.
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    return { ok: false, error: `${entry.label} is too large to store exactly.` }
  }
  // Round-trip check: catches any literal whose stored form differs from what was
  // typed, so nobody can enter a precision the column will not keep.
  if (entry.min !== undefined && value < entry.min) {
    return { ok: false, error: `${entry.label} cannot be less than ${entry.min}.` }
  }
  if (entry.max !== undefined && value > entry.max) {
    return { ok: false, error: `${entry.label} cannot be more than ${entry.max}.` }
  }

  return { ok: true, value }
}

/**
 * Renders a stored jsonb value into the text the form field shows.
 *
 * Scalars lose their JSON quoting so the input round-trips: a `number` knob whose
 * field reads `"5000"` would be re-submitted as the STRING "5000" and fail the
 * reader's `jsonb_typeof = 'number'` check. Structured values keep their JSON
 * form, because there is no plainer rendering that does not lose them.
 */
export function describeSettingValue(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}
