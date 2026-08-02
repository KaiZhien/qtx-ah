import { describe, it, expect } from 'vitest'
import {
  toCsv, csvField, CSV_BOM, CSV_EOL,
} from '@/modules/shared/export/domain/csv'

const decode = (b: Buffer) => b.toString('utf8')

describe('csvField — RFC 4180 quoting', () => {
  it('leaves a plain field unquoted', () => {
    expect(csvField('QTX-P-00412')).toBe('QTX-P-00412')
  })

  it('quotes a field containing a comma', () => {
    expect(csvField('Acme, Pte Ltd')).toBe('"Acme, Pte Ltd"')
  })

  it('quotes a field containing a double quote, and DOUBLES the quote', () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
  })

  it('quotes a field containing CR, LF, or CRLF', () => {
    expect(csvField('a\nb')).toBe('"a\nb"')
    expect(csvField('a\rb')).toBe('"a\rb"')
    expect(csvField('a\r\nb')).toBe('"a\r\nb"')
  })

  it('renders null and undefined as an EMPTY field, never the word "null"', () => {
    expect(csvField(null)).toBe('')
    expect(csvField(undefined)).toBe('')
  })

  it('distinguishes null from the empty string only by being identical — documented', () => {
    // CSV has no null. Both become an empty field; the JSON sidecars keep the
    // distinction for the nested sets that need it.
    expect(csvField(null)).toBe(csvField(''))
  })

  it('renders numbers, booleans and dates without locale interference', () => {
    expect(csvField(0)).toBe('0')
    expect(csvField(12000.5)).toBe('12000.5')
    expect(csvField(false)).toBe('false')
    expect(csvField(new Date('2026-08-04T10:00:00Z'))).toBe('2026-08-04T10:00:00.000Z')
  })

  it('preserves leading/trailing whitespace rather than trimming it', () => {
    expect(csvField('  padded  ')).toBe('  padded  ')
  })

  it('preserves a value verbatim even when it looks like a spreadsheet formula', () => {
    // DELIBERATE, and called out in the export README: an export is a fidelity
    // artifact. Prefixing a quote would silently alter stored data, and the
    // manifest sha256 would then certify something the database never held.
    expect(csvField('=SUM(A1:A2)')).toBe('=SUM(A1:A2)')
    expect(csvField('@foo')).toBe('@foo')
  })

  it('preserves non-ASCII verbatim (the fleet data is bilingual)', () => {
    expect(csvField('无 wifi 版本')).toBe('无 wifi 版本')
    expect(csvField('EE-0001至0015')).toBe('EE-0001至0015')
  })
})

describe('toCsv', () => {
  const columns = ['id', 'name', 'total'] as const
  const rows = [
    { id: 'a', name: 'Acme, Pte Ltd', total: 12000 },
    { id: 'b', name: null, total: null },
  ]

  it('starts with a UTF-8 BOM so Excel opens the bilingual data correctly', () => {
    const out = toCsv(columns, rows)
    expect(out.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(decode(out).startsWith(CSV_BOM)).toBe(true)
  })

  it('writes a header row from the column list', () => {
    const text = decode(toCsv(columns, rows)).slice(CSV_BOM.length)
    expect(text.split(CSV_EOL)[0]).toBe('id,name,total')
  })

  it('uses CRLF line endings per RFC 4180', () => {
    expect(CSV_EOL).toBe('\r\n')
    expect(decode(toCsv(columns, rows))).toContain('\r\n')
  })

  it('emits one line per row, in the given order', () => {
    const lines = decode(toCsv(columns, rows)).slice(CSV_BOM.length).split(CSV_EOL)
    expect(lines[1]).toBe('a,"Acme, Pte Ltd",12000')
    expect(lines[2]).toBe('b,,')
  })

  it('terminates the final row, so appending is well-defined', () => {
    expect(decode(toCsv(columns, rows)).endsWith(CSV_EOL)).toBe(true)
  })

  it('emits a header-only file (with BOM) for zero rows — never an empty file', () => {
    const out = toCsv(columns, [])
    const text = decode(out).slice(CSV_BOM.length)
    expect(text).toBe(`id,name,total${CSV_EOL}`)
  })

  it('reads each row by COLUMN NAME, so column order is the file contract', () => {
    const reordered = toCsv(['total', 'id', 'name'] as const, rows)
    const lines = decode(reordered).slice(CSV_BOM.length).split(CSV_EOL)
    expect(lines[0]).toBe('total,id,name')
    expect(lines[1]).toBe('12000,a,"Acme, Pte Ltd"')
  })

  it('renders a column missing from a row as empty rather than throwing', () => {
    const out = toCsv(['id', 'nope'] as const, [{ id: 'a' } as Record<string, unknown>])
    expect(decode(out).slice(CSV_BOM.length).split(CSV_EOL)[1]).toBe('a,')
  })

  it('quotes a header that needs quoting too', () => {
    const out = toCsv(['we,ird'] as const, [])
    expect(decode(out).slice(CSV_BOM.length)).toBe(`"we,ird"${CSV_EOL}`)
  })
})
