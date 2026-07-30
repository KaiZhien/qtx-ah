import { normalizeSerial } from '@/lib/domain/normalize'

/*
 * This module has a deliberate twin in the ops platform:
 * modules/manufacturing/domain/serialRange.ts, copied rather than imported
 * because the platform module may not reach into frozen /legacy code. A
 * BEHAVIOURAL fix here — range notation, padding, the guards — belongs in both
 * files, or the two import paths silently start expanding the same sheet
 * differently.
 */

/**
 * Expand a serial or range string into individual normalized serials.
 *
 * Rules:
 * - Empty/null input → { serials: [] }
 * - Ambiguous notation (contains " and ", ",", or "&") → error
 * - Single serial (no " to ") → { serials: [normalized] }
 * - Range matching /^(.*?)(\d+)\s+to\s+(\d+)$/i → generate padded serials
 * - Range guards: end >= start, count <= 5000
 */
export function expandSerialRange(
  raw: string | null | undefined
): { serials: string[] } | { error: string } {
  // Rule 1: Empty/null
  const trimmed = (raw ?? '').trim()
  if (!trimmed) {
    return { serials: [] }
  }

  // Rule 2: Ambiguous notation (check BEFORE range)
  if (trimmed.includes(' and ') || trimmed.includes(',') || trimmed.includes('&')) {
    return {
      error: `${raw} cannot be auto-expanded — fix this row manually`,
    }
  }

  // Rule 4: Try to match range pattern
  const rangeMatch = trimmed.match(/^(.*?)(\d+)\s+to\s+(\d+)$/i)

  if (rangeMatch) {
    const [, prefix, startStr, endStr] = rangeMatch
    const start = parseInt(startStr, 10)
    const end = parseInt(endStr, 10)
    const padWidth = Math.max(startStr.length, endStr.length)

    // Guard: end < start
    if (end < start) {
      return {
        error: `Range end (${end}) < start (${start}) in: ${raw}`,
      }
    }

    const count = end - start + 1

    // Guard: range too large
    if (count > 5000) {
      return {
        error: `Range too large (${count} units) — fix this row manually`,
      }
    }

    // Generate serials
    const serials: string[] = []
    for (let i = start; i <= end; i++) {
      const serial = prefix + String(i).padStart(padWidth, '0')
      serials.push(normalizeSerial(serial))
    }

    return { serials }
  }

  // Rule 3: Single serial (regex didn't match, so treat as single)
  return { serials: [normalizeSerial(trimmed)] }
}

/**
 * Pair two serial ranges (A and B) into units.
 * Rules:
 * - Expand A; if error, propagate.
 * - If A is empty, return empty units array.
 * - If B is null/empty, pair each A with null.
 * - Expand B; if error, prefix with "PCBA-B: ".
 * - Lengths must match, else error.
 * - Zip and return.
 */
export function pairSerialRanges(
  pcbaA: string,
  pcbaB: string | null | undefined
): { units: Array<{ pcba_a_sn: string; pcba_b_sn: string | null }> } | { error: string } {
  // Rule 1: Expand A
  const aResult = expandSerialRange(pcbaA)
  if ('error' in aResult) {
    return { error: aResult.error }
  }

  const aSerials = aResult.serials

  // Rule 1: If A is empty, return empty units
  if (aSerials.length === 0) {
    return { units: [] }
  }

  // Rule 2: If B is null/empty, pair with null
  const bTrimmed = (pcbaB ?? '').trim()
  if (!bTrimmed) {
    return {
      units: aSerials.map((s) => ({ pcba_a_sn: s, pcba_b_sn: null })),
    }
  }

  // Rule 3: Expand B
  const bResult = expandSerialRange(pcbaB)
  if ('error' in bResult) {
    return { error: `PCBA-B: ${bResult.error}` }
  }

  const bSerials = bResult.serials

  // Rule 3: Check lengths match
  if (aSerials.length !== bSerials.length) {
    return {
      error: `PCBA-A (${aSerials.length}) and PCBA-B (${bSerials.length}) counts differ — fix this row manually`,
    }
  }

  // Rule 3: Zip
  return {
    units: aSerials.map((a, i) => ({
      pcba_a_sn: a,
      pcba_b_sn: bSerials[i],
    })),
  }
}
