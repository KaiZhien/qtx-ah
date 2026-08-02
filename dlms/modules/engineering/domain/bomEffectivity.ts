/**
 * BOM effectivity — pure resolution logic, no I/O.
 *
 * `variant_bom_line` is no longer "the BOM"; it is the BOM's HISTORY. Every line
 * carries a window, and this module answers the only question that matters:
 * *what was the BOM for this variant on date D / at build serial S?*
 *
 * ═══ THE TWO AXES AND THE PRECEDENCE RULE ═══════════════════════════════════
 *
 * `eco.effectivity_date` and `eco.effectivity_serial` are INDEPENDENT axes and
 * an ECO may carry either or both, so a line may be bounded on either or both:
 *
 *   DATE   — calendar effectivity: "from 2026-09-01, PCBA-A rev B replaces A".
 *            A planning instrument. It says nothing about a unit built on an
 *            unusual schedule, reworked, or held in WIP across the boundary.
 *   SERIAL — build effectivity: "from SN QTX-P-00412 onward". Names physical
 *            units, which is what a BOM is actually about.
 *
 * >>> RULE: when the query names a serial AND the line carries at least one
 * >>> serial bound AND that bound is COMPARABLE with the query serial, the
 * >>> SERIAL axis decides — alone, overriding the date axis. In every other
 * >>> case the DATE axis decides.
 *
 * Why serial wins: a serial identifies one physical unit; a date is only a
 * proxy for "the units built after this day". When you know exactly which unit
 * you are asking about, the unit-level fact is the stronger evidence, and the
 * date bound was never more than shorthand for it. The rule is also the one
 * that is stable under rework — a board rebuilt in December is still SN 00300
 * and still carries SN 00300's BOM.
 *
 * "Comparable" is deliberately narrow (see serialSortKey): both sides must
 * normalize to the SAME prefix family and end in a digit run. Serials here are
 * free text and honour legacy ranged/listed forms, so cross-family comparison
 * would be invention. Uncomparable → the serial axis abstains ('unknown') and
 * the date axis decides; it never guesses.
 *
 * That is why `date` is REQUIRED by resolveBomAt and `serial` is optional: the
 * date axis is the floor that always produces an answer. Callers asking for
 * "the BOM today" inject today's date (house rule: injectable `today`).
 *
 * ═══ HALF-OPEN WINDOWS ══════════════════════════════════════════════════════
 * Both axes are half-open [from, to). An ECO effective at point P closes the
 * outgoing line AT P and opens the incoming line AT P: no day (and no serial)
 * is covered twice, and none is left uncovered. An inclusive `to` would double
 * the BOM on exactly the changeover day — the one day anybody looks at.
 *
 * ═══ NULL BOUNDS ════════════════════════════════════════════════════════════
 * from = null  → effective from the beginning of time (the pre-effectivity BOM
 *                lines that existed before this feature landed).
 * to   = null  → still effective (the current line).
 */

export type BomLineEffectivity = {
  id: string
  componentTypeId: string
  quantity: number
  /** 'YYYY-MM-DD' or null. Inclusive lower bound. */
  effectiveFromDate: string | null
  /** 'YYYY-MM-DD' or null. EXCLUSIVE upper bound. */
  effectiveToDate: string | null
  /** Free-text serial or null. Inclusive lower bound. */
  effectiveFromSerial: string | null
  /** Free-text serial or null. EXCLUSIVE upper bound. */
  effectiveToSerial: string | null
  /** ISO timestamp — the last tie-break, so the resolver is fully deterministic. */
  createdAt: string
}

/** The point in (date, serial) space a BOM question is asked at. */
export type BomAt = {
  /** Required — the date axis is the floor that always yields an answer. */
  date: string
  /** Optional; when present and comparable it overrides the date axis. */
  serial?: string | null
}

export type AxisVerdict = 'in' | 'out' | 'unknown'

// ── Serial ordering ─────────────────────────────────────────────────────────

/**
 * Splits a serial into an orderable (prefix family, sequence) pair.
 *
 * Normalization matches the component-serial convention used elsewhere in this
 * codebase (fn_component_unit_normalize / normalizeSerial): case-folded, with
 * spaces and hyphens stripped — so 'qtx p 412' and 'QTX-P-00412' are the same
 * unit. The sequence is the TRAILING digit run; the prefix is everything before
 * it and is the family key.
 *
 * Returns null when there is no trailing digit run ('QTX-PROTO', 'BATCH ONE',
 * ''), which is the signal that this serial cannot participate in ordering at
 * all. Callers must treat null as "abstain", never as zero.
 */
export function serialSortKey(
  serial: string | null | undefined,
): { prefix: string; seq: number } | null {
  if (serial == null) return null
  const norm = serial.replace(/[\s-]/g, '').toUpperCase()
  const m = norm.match(/^(.*?)(\d+)$/)
  if (!m) return null
  return { prefix: m[1], seq: parseInt(m[2], 10) }
}

// ── Per-axis verdicts ───────────────────────────────────────────────────────

/** Half-open [from, to) on the date axis. An unbounded line is always 'in'. */
export function dateAxisVerdict(line: BomLineEffectivity, date: string): 'in' | 'out' {
  if (line.effectiveFromDate !== null && date < line.effectiveFromDate) return 'out'
  if (line.effectiveToDate !== null && date >= line.effectiveToDate) return 'out'
  return 'in'
}

/**
 * Half-open [from, to) on the serial axis, or 'unknown' when this line cannot
 * be judged on serials at all: no serial bound, an unorderable query serial, an
 * unorderable bound, or a bound from a different prefix family. 'unknown' is
 * load-bearing — it is what makes lineAppliesAt fall back to the date axis
 * instead of inventing an ordering between unrelated serial schemes.
 */
export function serialAxisVerdict(line: BomLineEffectivity, serial: string): AxisVerdict {
  if (line.effectiveFromSerial === null && line.effectiveToSerial === null) return 'unknown'

  const q = serialSortKey(serial)
  if (!q) return 'unknown'

  const from = line.effectiveFromSerial !== null ? serialSortKey(line.effectiveFromSerial) : null
  const to = line.effectiveToSerial !== null ? serialSortKey(line.effectiveToSerial) : null

  // A bound that is present but unorderable, or from another family, makes the
  // whole serial judgement unsafe — abstain rather than half-apply it.
  if (line.effectiveFromSerial !== null && (!from || from.prefix !== q.prefix)) return 'unknown'
  if (line.effectiveToSerial !== null && (!to || to.prefix !== q.prefix)) return 'unknown'

  if (from && q.seq < from.seq) return 'out'
  if (to && q.seq >= to.seq) return 'out'
  return 'in'
}

/** The precedence rule itself: serial when usable, date otherwise. */
export function lineAppliesAt(line: BomLineEffectivity, at: BomAt): boolean {
  if (at.serial) {
    const verdict = serialAxisVerdict(line, at.serial)
    if (verdict !== 'unknown') return verdict === 'in'
  }
  return dateAxisVerdict(line, at.date) === 'in'
}

// ── Resolution ──────────────────────────────────────────────────────────────

// Descending "how late does this line start" order. A null from-bound means
// "beginning of time", so it must sort LOWEST, not highest — hence the explicit
// -Infinity rather than a naive null-last comparator.
function startRank(line: BomLineEffectivity): [string, number, string, string] {
  const seq = serialSortKey(line.effectiveFromSerial)
  return [
    line.effectiveFromDate ?? '', // '' sorts before every 'YYYY-MM-DD'
    seq ? seq.seq : -Infinity,
    line.createdAt,
    line.id,
  ]
}

function laterStartFirst(a: BomLineEffectivity, b: BomLineEffectivity): number {
  const ra = startRank(a)
  const rb = startRank(b)
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] === rb[i]) continue
    return ra[i] > rb[i] ? -1 : 1
  }
  return 0
}

/**
 * The effective BOM at `at`: at most ONE line per component type, in the order
 * the winning lines appear in `lines` (so the caller controls display order by
 * ordering its query — e.g. by component_type.sort).
 *
 * When several lines for one component type are simultaneously effective — a
 * data defect the apply step cannot produce, but which a hand-edited row could
 * — the LATEST-STARTING one wins, and the answer does not depend on input
 * order. Use findBomEffectivityConflicts to surface that defect rather than
 * letting it pass silently.
 */
export function resolveBomAt<L extends BomLineEffectivity>(
  lines: readonly L[], at: BomAt,
): L[] {
  const applying = lines.filter((l) => lineAppliesAt(l, at))
  const winners = new Map<string, L>()
  for (const l of applying) {
    const cur = winners.get(l.componentTypeId)
    if (!cur || laterStartFirst(l, cur) < 0) winners.set(l.componentTypeId, l)
  }
  const chosen = new Set([...winners.values()].map((l) => l.id))
  return applying.filter((l) => chosen.has(l.id))
}

/**
 * Component types with MORE THAN ONE effective line at `at`. Empty for a
 * well-formed BOM; non-empty means overlapping windows the UI should warn about
 * instead of quietly showing whichever line resolveBomAt picked.
 */
export function findBomEffectivityConflicts<L extends BomLineEffectivity>(
  lines: readonly L[], at: BomAt,
): { componentTypeId: string; lineIds: string[] }[] {
  const byType = new Map<string, string[]>()
  for (const l of lines) {
    if (!lineAppliesAt(l, at)) continue
    const bucket = byType.get(l.componentTypeId)
    if (bucket) bucket.push(l.id)
    else byType.set(l.componentTypeId, [l.id])
  }
  return [...byType.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([componentTypeId, lineIds]) => ({ componentTypeId, lineIds }))
}

/**
 * An ECO with NEITHER an effectivity date NOR an effectivity serial has no
 * point at which to close the outgoing line and open the incoming one, so it
 * cannot be applied to a BOM at all. The write service rejects it up front with
 * this — much better than the unique-index violation the apply would otherwise
 * hit when both bounds land as NULL and the old line never actually closes.
 */
export function isUsableEffectivityPoint(
  point: { date: string | null; serial: string | null },
): boolean {
  return !!point.date?.trim() || !!point.serial?.trim()
}
