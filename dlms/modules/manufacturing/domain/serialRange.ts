import { normalizeSerial } from '@/modules/manufacturing/domain/sheetValues'

/**
 * Expand a serial or serial range into individual normalized serials. No I/O.
 *
 * Ported from the legacy lib/domain/serialRange.ts (see the sheetValues.ts
 * header for why it is a copy). The guards are the point: notation this
 * function cannot read unambiguously becomes an error, and the import stages
 * that row as needs_review rather than guessing at a device's identity.
 */
export function expandSerialRange(
  raw: string | null | undefined,
): { serials: string[] } | { error: string } {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { serials: [] }

  // Ambiguity is checked before the range pattern: "A-1 and A-2" must not be
  // mistaken for anything expandable.
  if (trimmed.includes(' and ') || trimmed.includes(',') || trimmed.includes('&')) {
    return { error: `${raw} cannot be auto-expanded — fix this row manually` }
  }

  const match = trimmed.match(/^(.*?)(\d+)\s+to\s+(\d+)$/i)
  if (!match) return { serials: [normalizeSerial(trimmed)] }

  const [, prefix, startStr, endStr] = match
  const start = parseInt(startStr, 10)
  const end = parseInt(endStr, 10)
  if (end < start) return { error: `Range end (${end}) < start (${start}) in: ${raw}` }

  const count = end - start + 1
  if (count > 5000) return { error: `Range too large (${count} units) — fix this row manually` }

  const padWidth = Math.max(startStr.length, endStr.length)
  const serials: string[] = []
  for (let i = start; i <= end; i++) {
    serials.push(normalizeSerial(prefix + String(i).padStart(padWidth, '0')))
  }
  return { serials }
}

export type SerialPair = { pcbaA: string; pcbaB: string | null }

/**
 * Pair the PCBA-A and PCBA-B serial columns of one sheet row into units.
 * Lockstep: the two ranges must produce the same count, or the row is a manual
 * fix. A blank B column pairs every A serial with null.
 */
export function pairSerialRanges(
  pcbaA: string, pcbaB: string | null | undefined,
): { units: SerialPair[] } | { error: string } {
  const a = expandSerialRange(pcbaA)
  if ('error' in a) return { error: a.error }
  if (a.serials.length === 0) return { units: [] }

  if (!(pcbaB ?? '').trim()) {
    return { units: a.serials.map((s) => ({ pcbaA: s, pcbaB: null })) }
  }

  const b = expandSerialRange(pcbaB)
  if ('error' in b) return { error: `PCBA-B: ${b.error}` }

  if (a.serials.length !== b.serials.length) {
    return { error: `PCBA-A (${a.serials.length}) and PCBA-B (${b.serials.length}) counts differ — fix this row manually` }
  }
  return { units: a.serials.map((s, i) => ({ pcbaA: s, pcbaB: b.serials[i] })) }
}
