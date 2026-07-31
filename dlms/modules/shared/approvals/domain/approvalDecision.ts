/**
 * The approvals engine's pure half (spec §6.3, BR-4): who may decide a request,
 * and whether what was approved is still what is about to be acted on.
 *
 * No I/O, no clock, no randomness — the service loads the facts and hands them
 * here, exactly as repairStatus / deviceStatus do. Two independent halves:
 *
 *   1. evaluateDecision — the three refusals that guard a decision.
 *   2. snapshotsAgree / describeSnapshotDrift — the comparison that makes an
 *      approval mean something. An approval authorises a specific STATE, not an
 *      entity id (see 20260802000000_platform_approvals.sql's header). Without a
 *      faithful comparison the engine is theatre: approve an invoice at 12,000,
 *      edit it to 18,500, issue it against an approval nobody granted.
 *
 * The vocabularies below mirror the CHECK sets on `approval` exactly. A domain
 * type that drifts from them produces a raw constraint violation at the insert
 * instead of a friendly refusal here.
 */

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export const APPROVAL_KINDS = ['eco', 'invoice', 'repair_signoff'] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
}

export const APPROVAL_KIND_LABELS: Record<ApprovalKind, string> = {
  eco: 'Engineering Change Order',
  invoice: 'Invoice',
  repair_signoff: 'Repair Sign-off',
}

/** Falls back to the raw code so an unknown value renders as itself, never `undefined`. */
export function approvalStatusLabel(status: string): string {
  return APPROVAL_STATUS_LABELS[status as ApprovalStatus] ?? status
}

export function approvalKindLabel(kind: string): string {
  return APPROVAL_KIND_LABELS[kind as ApprovalKind] ?? kind
}

// ── The decision ────────────────────────────────────────────────────────────

export const DECISION_ERROR_CODES = [
  'already_decided', 'permission_denied', 'self_approval',
] as const
export type DecisionErrorCode = (typeof DECISION_ERROR_CODES)[number]

/**
 * Everything a decision turns on. `requestedBy` is guaranteed non-NULL by the
 * column, so the self-approval rule can never be silently inapplicable;
 * `deciderCanApprove` is the resolved `approve_requests` permission, resolved by
 * the caller because permission resolution reads the database.
 */
export type DecisionFacts = {
  status: ApprovalStatus
  requestedBy: string
  deciderId: string
  deciderCanApprove: boolean
}

export type ApprovalDecision = { ok: true } | { ok: false; error: DecisionErrorCode }

/**
 * Actor identity, compared the way it must be to FAIL CLOSED. Ids are uuids —
 * RFC 4122 hex, where case carries no meaning — so an id that arrives upper-cased
 * from one source and lower-cased from another is the same person. Comparing them
 * raw would let a case or whitespace mismatch slip the self-approval rule, and a
 * missed refusal is the failure that matters here; two genuinely different users
 * can never collide under this normalisation.
 */
function sameActor(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * The three refusals, in the order they are checked and for the reasons they are
 * checked in it:
 *
 *   1. ALREADY DECIDED comes first because it describes the RECORD rather than
 *      the person: `approved` and `rejected` are both terminal (spec §6.4), so a
 *      second decision is refused in both directions no matter who asks. This is
 *      also the race two managers actually hit — both hold the permission, both
 *      click, and the loser deserves "already decided" rather than a rule about
 *      themselves. Anything outside the vocabulary is treated as decided too:
 *      fail closed, never "unknown status, therefore still open".
 *
 *   2. PERMISSION next, mirroring the service's gate order (authorize() runs
 *      before any of this), so the code returned here matches the error the
 *      caller would have raised anyway — and a user who cannot approve anything
 *      is told the actionable thing rather than a rule about a workflow they
 *      cannot take part in.
 *
 *   3. SELF-APPROVAL last, and unconditionally: a decider who HOLDS
 *      `approve_requests` and is the requester is still refused. The rule lives
 *      in the pure domain precisely so that no call site — service, action,
 *      queue page, future outbox drain — can forget it.
 */
export function evaluateDecision(facts: DecisionFacts): ApprovalDecision {
  if (facts.status !== 'pending') return { ok: false, error: 'already_decided' }
  if (!facts.deciderCanApprove) return { ok: false, error: 'permission_denied' }
  if (sameActor(facts.requestedBy, facts.deciderId)) return { ok: false, error: 'self_approval' }
  return { ok: true }
}

const DECISION_ERROR_MESSAGES: Record<DecisionErrorCode, string> = {
  already_decided:
    'This request has already been decided, and a decision is final. '
    + 'Raise a new request if the record needs approving again.',
  permission_denied: 'You do not have permission to decide approval requests.',
  self_approval:
    'You cannot decide your own request — an approval is a second pair of eyes, '
    + 'so someone else has to review it.',
}

export function messageForDecisionError(code: DecisionErrorCode): string {
  return DECISION_ERROR_MESSAGES[code]
}

export class ApprovalDecisionError extends Error {
  readonly code: DecisionErrorCode
  constructor(code: DecisionErrorCode, message: string) {
    super(message)
    this.name = 'ApprovalDecisionError'
    this.code = code
  }
}

// ── Snapshot comparison ─────────────────────────────────────────────────────
//
// Every decision this comparison makes, and why. Each is pinned by a test in
// __tests__/platform/shared/approvalDecision.test.ts.
//
// KEY ORDER IS NOT SIGNIFICANT. Postgres `jsonb` does not preserve object key
//   order, so the snapshot that comes back is a re-ordering of the one that went
//   in. An order-sensitive comparison (JSON.stringify of both sides, say) would
//   report drift on every single approval and train everyone to ignore the
//   warning — worse than not checking at all.
//
// ARRAY ORDER IS SIGNIFICANT. jsonb DOES preserve array order, and for a
//   snapshot the order is content: invoice line 1 and line 2 are not
//   interchangeable, and a reordering changes which line a numbered reference
//   points at. So [a,b] does not agree with [b,a].
//
// NUMBERS THAT ARRIVE AS STRINGS. node-postgres returns `numeric` and `bigint`
//   columns as STRINGS to avoid silent float truncation, so a total is `12000`
//   when it came through zod from a form and `"12000.00"` when it came from a
//   driver row. Refusing that pair would report drift on every unchanged
//   invoice. A number (or bigint) therefore agrees with a well-formed decimal
//   STRING of the same value — `0` agrees with `"0"` and with `"0.00"`.
//   Deliberately narrow, in three ways:
//     * Cross-type only. Two STRINGS are compared as text, never as numbers,
//       because leading zeros are content in a string field: invoice number
//       "0012" is not "12".
//     * Strict literal shape. `""`, `"  "`, `"0x10"`, `"1,000"`, `true` and
//       `null` never become numbers — the JS `==` coercions that make `0 == ""`
//       and `0 == false` true are exactly the false agreements to avoid.
//     * Compared as canonical DECIMAL TEXT, not via Number(). `numeric` holds
//       more precision than a double: Number("12000.000000000000000001") is
//       12000, so a Number()-based comparison would wave through a real edit.
//
// NULL IS NOT A MISSING KEY. jsonb distinguishes them and so does this. A field
//   that vanished from the projection is a different event from a field set to
//   null, and a refusal should be able to say which happened. The one exception
//   is a JS `undefined` value, which is normalised to ABSENT: jsonb cannot store
//   it, so treating `{note: undefined}` as different from `{}` would report a
//   drift that disappears the moment the object round-trips through the
//   database. Inside an ARRAY, `undefined` and holes become `null` instead —
//   which is precisely what JSON.stringify does, and therefore what the database
//   will hold.
//
// DATES ARE COMPARED AS THEIR ISO STRINGS, because that is what a jsonb round
//   trip turns them into. A snapshot read back from the column holds the string;
//   a freshly built projection may hold a real Date. Without this they would
//   never agree — and worse, a naive key-walk sees a Date as an object with NO
//   own keys, making every Date equal to every other Date and to `{}`.
//
// ANYTHING WHOSE CONTENT IS INVISIBLE TO A KEY WALK IS NOT COMPARABLE, and
//   therefore counts as drift. A Map, a Set, a RegExp and an invalid Date all
//   stringify to `{}` and all enumerate as keyless, so a comparison that
//   descended into them would report agreement between values it never actually
//   looked at. Objects that merely carry an unusual PROTOTYPE are fine — their
//   content is still in their own keys, which is what jsonb would store.
//
// DEPTH IS CAPPED, so a cyclic current-state object (a row carrying a backlink,
//   say) becomes a refusal rather than a stack overflow that takes out the
//   request.
//
// snapshotsAgree(a, b) is true EXACTLY when describeSnapshotDrift(a, b) is
// empty — both run the same comparator. That invariant is what makes a refusal
// trustworthy: the engine never blocks an action it cannot explain, and never
// stays silent about one it should have blocked.

/** Beyond this nesting depth values are treated as changed. Snapshots are shallow. */
const MAX_DEPTH = 32

/** How much of one value a drift line prints before it is elided. */
export const DRIFT_VALUE_MAX = 120

/** Marks a value this comparison refuses to interpret (see "ANYTHING ELSE EXOTIC"). */
const OPAQUE = Symbol('opaque')

type ValueKind = 'primitive' | 'array' | 'object' | 'opaque'

/** Dates become the string a jsonb round trip would have produced. */
function toLeaf(value: unknown): unknown {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? OPAQUE : value.toISOString()
  }
  return value
}

function classify(leaf: unknown): ValueKind {
  if (leaf === OPAQUE) return 'opaque'
  if (leaf === null) return 'primitive'
  if (Array.isArray(leaf)) return 'array'
  if (typeof leaf === 'object') {
    // Comparable exactly when walking its OWN keys reproduces what jsonb would
    // store — which is the standard [object Object] tag. That admits an object
    // with an unusual prototype (Object.create(x), a driver's row class, a
    // Proxy), because its content still lives in own enumerable keys, and
    // refuses Map, Set, RegExp, typed arrays and boxed primitives, whose content
    // is INVISIBLE to that walk and which would therefore all compare equal to
    // `{}` and to each other. Testing the prototype against Object.prototype
    // instead would refuse the first group too, and a comparison that reports
    // drift on every approval is as useless as one that never does.
    return Object.prototype.toString.call(leaf) === '[object Object]' ? 'object' : 'opaque'
  }
  if (typeof leaf === 'function' || typeof leaf === 'symbol') return 'opaque'
  return 'primitive'
}

/** A plain decimal literal. No exponent, no hex, no thousands separators, no blanks. */
const DECIMAL_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

/**
 * The canonical decimal text of a numeric value, or null when it is not one.
 * Text, not a float: `numeric` carries more digits than a double, so collapsing
 * through Number() would make two genuinely different totals compare equal.
 */
function canonicalNumeric(value: unknown): string | null {
  if (typeof value === 'bigint') return canonicalDecimal(value.toString())
  if (typeof value === 'number') {
    // NaN/±Infinity are not amounts. Fail closed rather than inventing an order.
    return Number.isFinite(value) ? canonicalDecimal(String(value)) : null
  }
  if (typeof value === 'string') return canonicalDecimal(value)
  return null
}

function canonicalDecimal(text: string): string | null {
  // String(1e21) is "1e+21", which fails this test and so declines to compare —
  // deliberate: an exponent form has already lost the precision this exists for.
  if (!DECIMAL_LITERAL.test(text)) return null
  const negative = text.startsWith('-')
  const unsigned = negative || text.startsWith('+') ? text.slice(1) : text
  const dot = unsigned.indexOf('.')
  let integer = dot === -1 ? unsigned : unsigned.slice(0, dot)
  let fraction = dot === -1 ? '' : unsigned.slice(dot + 1)
  integer = integer.replace(/^0+/, '')
  fraction = fraction.replace(/0+$/, '')
  if (integer === '') integer = '0'
  const magnitude = fraction === '' ? integer : `${integer}.${fraction}`
  // -0 and 0 are the same amount of money.
  return negative && magnitude !== '0' ? `-${magnitude}` : magnitude
}

function primitivesAgree(a: unknown, b: unknown): boolean {
  if (a === b) return true
  const aNumeric = typeof a === 'number' || typeof a === 'bigint'
  const bNumeric = typeof b === 'number' || typeof b === 'bigint'
  const crossType = (aNumeric && typeof b === 'string') || (bNumeric && typeof a === 'string')
  if (!crossType) return false
  const ca = canonicalNumeric(a)
  const cb = canonicalNumeric(b)
  return ca !== null && cb !== null && ca === cb
}

/** Own, defined-valued, enumerable string keys — inherited members are not content. */
function ownRecord(value: object): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(value)) {
    const child = (value as Record<string, unknown>)[key]
    if (child !== undefined) out[key] = child
  }
  return out
}

function hasKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/** Holes and `undefined` elements are `null`, matching JSON.stringify and jsonb. */
function elementAt(array: unknown[], index: number): unknown {
  const value = array[index]
  return value === undefined ? null : value
}

function valuesAgree(a: unknown, b: unknown, depth: number): boolean {
  if (a === b) return true            // same reference, or identical primitive
  if (depth > MAX_DEPTH) return false // fail closed (cycles, pathological nesting)

  const la = toLeaf(a)
  const lb = toLeaf(b)
  const ka = classify(la)
  const kb = classify(lb)
  if (ka === 'opaque' || kb === 'opaque' || ka !== kb) return false

  if (ka === 'array') {
    const aa = la as unknown[]
    const bb = lb as unknown[]
    if (aa.length !== bb.length) return false
    for (let i = 0; i < aa.length; i++) {
      if (!valuesAgree(elementAt(aa, i), elementAt(bb, i), depth + 1)) return false
    }
    return true
  }

  if (ka === 'object') {
    const ra = ownRecord(la as object)
    const rb = ownRecord(lb as object)
    const keys = Object.keys(ra)
    if (keys.length !== Object.keys(rb).length) return false
    for (const key of keys) {
      if (!hasKey(rb, key)) return false
      if (!valuesAgree(ra[key], rb[key], depth + 1)) return false
    }
    return true
  }

  return primitivesAgree(la, lb)
}

/**
 * Does the state that was approved still describe the state about to be acted
 * on? Every consumer calls this immediately before it acts (spec §6.3) and
 * refuses when it is false.
 */
export function snapshotsAgree(approved: unknown, current: unknown): boolean {
  return valuesAgree(approved, current, 0)
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function childPath(path: string, key: string): string {
  if (IDENTIFIER.test(key)) return path === '' ? key : `${path}.${key}`
  return `${path}[${JSON.stringify(key)}]`
}

function pathLabel(path: string): string {
  return path === '' ? '(whole snapshot)' : path
}

/** Cuts on whole code points: a lone surrogate is not encodable as UTF-8. */
function truncateForDrift(text: string): string {
  if (text.length <= DRIFT_VALUE_MAX) return text
  let out = ''
  for (const ch of text) {
    if (out.length + ch.length > DRIFT_VALUE_MAX - 1) break
    out += ch
  }
  return `${out}…`
}

function describeOpaque(value: unknown): string {
  if (typeof value === 'function') return 'function'
  if (typeof value === 'symbol') return 'symbol'
  const name = (value as { constructor?: { name?: string } } | null)?.constructor?.name
  return name ? name : 'value'
}

/**
 * Renders one value for a human reading a refusal. Strings keep their quotes on
 * purpose: without them a change from "" to "   " is an invisible drift line,
 * and `null` becomes indistinguishable from the string "null".
 */
function render(value: unknown): string {
  const leaf = toLeaf(value)
  if (classify(leaf) === 'opaque') return `[${describeOpaque(value)}]`
  if (typeof leaf === 'number' && !Number.isFinite(leaf)) return String(leaf)
  if (typeof leaf === 'bigint') return truncateForDrift(leaf.toString())
  let text: string
  try {
    text = JSON.stringify(leaf) ?? String(leaf)
  } catch {
    return '[unserialisable value]' // cyclic structure
  }
  return truncateForDrift(text)
}

function collectDrift(
  a: unknown, b: unknown, path: string, out: string[], depth: number,
): void {
  if (a === b) return
  if (depth > MAX_DEPTH) {
    if (!valuesAgree(a, b, depth)) {
      out.push(`${pathLabel(path)}: nested too deeply to compare — treated as changed`)
    }
    return
  }

  const la = toLeaf(a)
  const lb = toLeaf(b)
  const ka = classify(la)
  const kb = classify(lb)

  if (ka === 'object' && kb === 'object') {
    const ra = ownRecord(la as object)
    const rb = ownRecord(lb as object)
    // Sorted, so the same pair of snapshots always produces the same lines
    // whatever order their keys happen to arrive in — the message half of the
    // key-order-insensitivity above.
    const keys = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort()
    for (const key of keys) {
      const child = childPath(path, key)
      if (!hasKey(ra, key)) out.push(`${child}: added (${render(rb[key])})`)
      else if (!hasKey(rb, key)) out.push(`${child}: removed (was ${render(ra[key])})`)
      else collectDrift(ra[key], rb[key], child, out, depth + 1)
    }
    return
  }

  if (ka === 'array' && kb === 'array') {
    const aa = la as unknown[]
    const bb = lb as unknown[]
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
      const child = `${path}[${i}]`
      if (i >= aa.length) out.push(`${child}: added (${render(elementAt(bb, i))})`)
      else if (i >= bb.length) out.push(`${child}: removed (was ${render(elementAt(aa, i))})`)
      else collectDrift(elementAt(aa, i), elementAt(bb, i), child, out, depth + 1)
    }
    return
  }

  if (!valuesAgree(a, b, depth)) {
    out.push(`${pathLabel(path)}: ${render(la)} → ${render(lb)}`)
  }
}

/**
 * What changed between what was approved and what is there now, one line per
 * field, naming the field and both values: "total: 12000 → 18500", not "this
 * invoice changed". The first is something a requester can act on — re-request
 * at the new number, or put the old one back; the second is a dead end.
 *
 * Added and removed keys are named too, because a field DISAPPEARING from the
 * record under approval is exactly as material as one whose value moved.
 *
 * Empty exactly when snapshotsAgree is true.
 */
export function describeSnapshotDrift(approved: unknown, current: unknown): string[] {
  const out: string[] = []
  collectDrift(approved, current, '', out, 0)
  return out
}
