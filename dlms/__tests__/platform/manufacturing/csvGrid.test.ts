import { describe, it, expect } from 'vitest'
import { readCsvGrid } from '@/modules/manufacturing/domain/csvGrid'
import { ImportParseError } from '@/modules/manufacturing/domain/importErrors'

describe('readCsvGrid', () => {
  it('reads a plain row', () => {
    expect(readCsvGrid('a,b,c\n')).toEqual([['a', 'b', 'c']])
  })

  it('reads a body with no trailing newline', () => {
    expect(readCsvGrid('a,b,c')).toEqual([['a', 'b', 'c']])
  })

  it('reads several rows', () => {
    expect(readCsvGrid('h1,h2\nr1,r2\nr3,r4\n')).toEqual([
      ['h1', 'h2'], ['r1', 'r2'], ['r3', 'r4'],
    ])
  })

  it('returns nothing for an empty body', () => {
    expect(readCsvGrid('')).toEqual([])
  })

  it('reads a header-only body as one row', () => {
    expect(readCsvGrid('Device S/N,PCBA-A S/N\n')).toEqual([['Device S/N', 'PCBA-A S/N']])
  })

  it('keeps a comma inside a quoted field', () => {
    expect(readCsvGrid('a,"b,c",d\n')).toEqual([['a', 'b,c', 'd']])
  })

  it('keeps a newline inside a quoted field', () => {
    expect(readCsvGrid('a,"line1\nline2",c\n')).toEqual([['a', 'line1\nline2', 'c']])
  })

  it('unescapes a doubled quote inside a quoted field', () => {
    expect(readCsvGrid('a,"say ""hi""",c\n')).toEqual([['a', 'say "hi"', 'c']])
  })

  it('reads a field that is only a doubled quote', () => {
    expect(readCsvGrid('a,"""",c\n')).toEqual([['a', '"', 'c']])
  })

  it('treats a mid-field quote as a literal inch mark', () => {
    // The Fix-2 regression: entering quoted mode here swallowed the delimiter,
    // the newline and every following row into one field.
    expect(readCsvGrid('EE-1,10.1" HMI,pro\nEE-2,7" HMI,pro\n')).toEqual([
      ['EE-1', '10.1" HMI', 'pro'],
      ['EE-2', '7" HMI', 'pro'],
    ])
  })

  it('keeps a mid-field quote that never closes', () => {
    expect(readCsvGrid('ab"cd,e\n')).toEqual([['ab"cd', 'e']])
  })

  it('appends characters written after a closing quote', () => {
    expect(readCsvGrid('"ab"cd,e\n')).toEqual([['abcd', 'e']])
  })

  it('throws on an unterminated quoted field rather than truncating', () => {
    expect(() => readCsvGrid('a,"unclosed,b\nrow2,x,y\n')).toThrow(ImportParseError)
    expect(() => readCsvGrid('a,"unclosed,b\nrow2,x,y\n')).toThrow(/unterminated quoted field/i)
  })

  it('strips CR from CRLF line endings', () => {
    expect(readCsvGrid('a,b\r\nc,d\r\n')).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('normalises CRLF inside a quoted multi-line field to LF', () => {
    expect(readCsvGrid('a,"one\r\ntwo"\r\n')).toEqual([['a', 'one\ntwo']])
  })

  it('preserves every physical line, blank ones included', () => {
    // Fix 5: filtering blank rows out here renumbered every later row, so
    // source_row_no stopped matching the file the reviewer has open.
    const grid = readCsvGrid('Device S/N,PCBA-A S/N\n\n,EE-A-0001\n')
    expect(grid).toHaveLength(3)
    expect(grid[1]).toEqual([''])
    expect(grid[2]).toEqual(['', 'EE-A-0001'])
  })

  it('counts a blank line between data rows', () => {
    const grid = readCsvGrid('h\na\n\nb\n')
    expect(grid).toEqual([['h'], ['a'], [''], ['b']])
  })

  it('trims an unquoted field', () => {
    expect(readCsvGrid('  a  ,\tb\t\n')).toEqual([['a', 'b']])
  })

  it('preserves a quoted field verbatim, padding included', () => {
    // remarks is documented as preserved verbatim — never trimmed.
    expect(readCsvGrid('a,"  padded  ",c\n')).toEqual([['a', '  padded  ', 'c']])
  })

  it('preserves a quoted whitespace-only field as whitespace, not an absent cell', () => {
    expect(readCsvGrid('a,"  ",c\n')).toEqual([['a', '  ', 'c']])
  })

  it('reads an empty quoted field as an empty field', () => {
    expect(readCsvGrid('a,"",c\n')).toEqual([['a', '', 'c']])
    expect(readCsvGrid('""\n')).toEqual([['']])
  })

  it('keeps trailing empty fields', () => {
    expect(readCsvGrid('a,,\n')).toEqual([['a', '', '']])
  })

  it('preserves non-ASCII text', () => {
    expect(readCsvGrid('设备序列号,备注\nEE-1,"首批\n出货"\n')).toEqual([
      ['设备序列号', '备注'], ['EE-1', '首批\n出货'],
    ])
  })
})
