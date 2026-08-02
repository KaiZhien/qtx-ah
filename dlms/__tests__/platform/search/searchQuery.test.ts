import { describe, it, expect } from 'vitest'
import {
  MIN_QUERY_LENGTH, MAX_QUERY_LENGTH, PER_GROUP_LIMIT,
  normalizeRef, normalizeName, escapeLike, isSearchable, buildNeedles, rankOf,
} from '@/modules/shared/search/domain/searchQuery'

describe('normalizeRef — the reference/serial family (spec §8.4)', () => {
  it('lowercases and strips spaces and hyphens', () => {
    expect(normalizeRef('QTX-P-00412')).toBe('qtxp00412')
    expect(normalizeRef('REP-2026-0001')).toBe('rep20260001')
    expect(normalizeRef('  MOD 2026 0007 ')).toBe('mod20260007')
  })

  it('agrees with the normalization device_sn_normalized already uses', () => {
    // fn_device_normalize: lower(regexp_replace(device_sn, '[\s-]', '', 'g'))
    // deviceReadService builds its needle as: q.toLowerCase().replace(/[\s-]/g, '')
    expect(normalizeRef('QTX-P-00412')).toBe('QTX-P-00412'.toLowerCase().replace(/[\s-]/g, ''))
  })

  it('strips tabs and newlines too, not only the ASCII space', () => {
    expect(normalizeRef('REP\t2026\n0001')).toBe('rep20260001')
  })

  it('leaves an already-normalized value untouched (idempotent)', () => {
    expect(normalizeRef(normalizeRef('QTX-P-00412'))).toBe('qtxp00412')
  })
})

describe('normalizeName — the name/title family', () => {
  it('lowercases but KEEPS separators, because words matter in a name', () => {
    expect(normalizeName('Acme Corp')).toBe('acme corp')
    expect(normalizeName('Jean-Luc Picard')).toBe('jean-luc picard')
  })

  it('collapses runs of whitespace and trims', () => {
    expect(normalizeName('  Acme   Pte   Ltd  ')).toBe('acme pte ltd')
  })
})

describe('escapeLike', () => {
  it('escapes the LIKE wildcards so a serial cannot act as one', () => {
    expect(escapeLike('100%')).toBe('100\\%')
    expect(escapeLike('a_b')).toBe('a\\_b')
  })

  it('escapes the escape character itself, first', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b')
    // A lone backslash must not go on to escape a following wildcard.
    expect(escapeLike('\\%')).toBe('\\\\\\%')
  })

  it('leaves ordinary text alone', () => {
    expect(escapeLike('qtxp00412')).toBe('qtxp00412')
  })
})

describe('isSearchable — the debounce/short-circuit rule', () => {
  it('refuses queries shorter than MIN_QUERY_LENGTH after normalization', () => {
    expect(MIN_QUERY_LENGTH).toBe(2)
    expect(isSearchable('a')).toBe(false)
    expect(isSearchable('ab')).toBe(true)
  })

  it('refuses whitespace-only and empty queries', () => {
    expect(isSearchable('')).toBe(false)
    expect(isSearchable('   ')).toBe(false)
  })

  it('counts length AFTER normalization, so punctuation alone is not a query', () => {
    // '--' normalizes to '' in the ref family and would otherwise scan every table.
    expect(isSearchable('--')).toBe(false)
    expect(isSearchable('- -')).toBe(false)
  })

  it('refuses queries longer than MAX_QUERY_LENGTH', () => {
    expect(MAX_QUERY_LENGTH).toBe(100)
    expect(isSearchable('x'.repeat(100))).toBe(true)
    expect(isSearchable('x'.repeat(101))).toBe(false)
  })
})

describe('buildNeedles', () => {
  it('builds exact / prefix / contains for the ref family', () => {
    expect(buildNeedles('QTX-P-00412', 'ref')).toEqual({
      exact: 'qtxp00412',
      prefix: 'qtxp00412%',
      contains: '%qtxp00412%',
    })
  })

  it('builds exact / prefix / contains for the name family', () => {
    expect(buildNeedles('Acme Corp', 'name')).toEqual({
      exact: 'acme corp',
      prefix: 'acme corp%',
      contains: '%acme corp%',
    })
  })

  it('escapes the needle so a wildcard in user input cannot widen the match', () => {
    const n = buildNeedles('100%', 'name')
    expect(n.contains).toBe('%100\\%%')
    // exact is compared with `=`, never LIKE, so it must NOT carry escapes
    expect(n.exact).toBe('100%')
  })
})

describe('rankOf — the ordering rule (spec §8.4: exact + prefix + trigram partial)', () => {
  it('ranks exact 0, prefix 1, contains 2', () => {
    expect(rankOf('qtxp00412', 'qtxp00412')).toBe(0)
    expect(rankOf('qtxp00412', 'qtxp')).toBe(1)
    expect(rankOf('qtxp00412', '00412')).toBe(2)
  })

  it('returns null when the candidate does not match at all', () => {
    expect(rankOf('qtxp00412', 'zzz')).toBeNull()
  })

  it('prefers exact over prefix when both would apply', () => {
    // An exact match is also trivially a prefix match; rank must not report 1.
    expect(rankOf('abc', 'abc')).toBe(0)
  })
})

describe('PER_GROUP_LIMIT — the "cap per group" rule', () => {
  it('is a small constant, because global search runs many queries per keystroke', () => {
    expect(PER_GROUP_LIMIT).toBe(5)
  })
})
