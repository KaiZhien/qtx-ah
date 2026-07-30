import { describe, it, expect } from 'vitest'
import { readCsvGrid } from '@/modules/manufacturing/domain/csvGrid'
import { ImportParseError } from '@/modules/manufacturing/domain/importErrors'

/**
 * Field-shape view of the reader, for the tests that are about parsing rather
 * than about line numbering. The line numbers have their own describe block
 * below, where they are the subject.
 */
const cells = (body: string): string[][] => readCsvGrid(body).map((r) => r.cells)

describe('readCsvGrid', () => {
  it('reads a plain row', () => {
    expect(cells('a,b,c\n')).toEqual([['a', 'b', 'c']])
  })

  it('reads a body with no trailing newline', () => {
    expect(cells('a,b,c')).toEqual([['a', 'b', 'c']])
  })

  it('reads several rows', () => {
    expect(cells('h1,h2\nr1,r2\nr3,r4\n')).toEqual([
      ['h1', 'h2'], ['r1', 'r2'], ['r3', 'r4'],
    ])
  })

  it('returns nothing for an empty body', () => {
    expect(readCsvGrid('')).toEqual([])
  })

  it('reads a header-only body as one row', () => {
    expect(cells('Device S/N,PCBA-A S/N\n')).toEqual([['Device S/N', 'PCBA-A S/N']])
  })

  it('keeps a comma inside a quoted field', () => {
    expect(cells('a,"b,c",d\n')).toEqual([['a', 'b,c', 'd']])
  })

  it('keeps a newline inside a quoted field', () => {
    expect(cells('a,"line1\nline2",c\n')).toEqual([['a', 'line1\nline2', 'c']])
  })

  it('unescapes a doubled quote inside a quoted field', () => {
    expect(cells('a,"say ""hi""",c\n')).toEqual([['a', 'say "hi"', 'c']])
  })

  it('reads a field that is only a doubled quote', () => {
    expect(cells('a,"""",c\n')).toEqual([['a', '"', 'c']])
  })

  it('treats a mid-field quote as a literal inch mark', () => {
    // The Fix-2 regression: entering quoted mode here swallowed the delimiter,
    // the newline and every following row into one field.
    expect(cells('EE-1,10.1" HMI,pro\nEE-2,7" HMI,pro\n')).toEqual([
      ['EE-1', '10.1" HMI', 'pro'],
      ['EE-2', '7" HMI', 'pro'],
    ])
  })

  it('keeps a mid-field quote that never closes', () => {
    expect(cells('ab"cd,e\n')).toEqual([['ab"cd', 'e']])
  })

  it('appends characters written after a closing quote', () => {
    expect(cells('"ab"cd,e\n')).toEqual([['abcd', 'e']])
  })

  it('quotes a field whose quote follows only whitespace', () => {
    // Fix-pass-2 regression: testing `field === ''` made this quote literal, so
    // the comma inside it became a delimiter and every later column shifted by
    // one — a four-column row read as five, silently, with no error.
    expect(cells('a, "b,c",d\n')).toEqual([['a', 'b,c', 'd']])
    expect(cells('a,\t"b,c",d\n')).toEqual([['a', 'b,c', 'd']])
    expect(cells(' "b,c"\n')).toEqual([['b,c']])
  })

  it('returns a whitespace-then-quoted field verbatim, without the leading padding', () => {
    // The padding before the opening quote belongs to the quoting syntax, not to
    // the value; the quoted content itself is still preserved exactly.
    expect(cells('a,   "  padded  ",c\n')).toEqual([['a', '  padded  ', 'c']])
    expect(cells('a, "首批\n出货",c\n')).toEqual([['a', '首批\n出货', 'c']])
  })

  it('keeps the column count when a quoted field is padded on both sides', () => {
    // Three columns in, three columns out. Whitespace *after* the closing quote is
    // appended like any other post-close character (see the "ab"cd case above),
    // which is what keeps the rule one rule rather than two.
    expect(cells('a, "first batch, urgent" ,in_stock\n')).toEqual([
      ['a', 'first batch, urgent ', 'in_stock'],
    ])
  })

  it('throws on an unterminated quoted field rather than truncating', () => {
    expect(() => readCsvGrid('a,"unclosed,b\nrow2,x,y\n')).toThrow(ImportParseError)
    expect(() => readCsvGrid('a,"unclosed,b\nrow2,x,y\n')).toThrow(/unterminated quoted field/i)
  })

  it('throws when the unterminated quote opened after whitespace', () => {
    expect(() => readCsvGrid('a, "unclosed,b\nrow2,x,y\n')).toThrow(/unterminated quoted field/i)
  })

  it('strips CR from CRLF line endings', () => {
    expect(cells('a,b\r\nc,d\r\n')).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('normalises CRLF inside a quoted multi-line field to LF', () => {
    expect(cells('a,"one\r\ntwo"\r\n')).toEqual([['a', 'one\ntwo']])
  })

  it('preserves every physical line, blank ones included', () => {
    // Fix 5: filtering blank rows out here renumbered every later row, so
    // source_row_no stopped matching the file the reviewer has open.
    const grid = cells('Device S/N,PCBA-A S/N\n\n,EE-A-0001\n')
    expect(grid).toHaveLength(3)
    expect(grid[1]).toEqual([''])
    expect(grid[2]).toEqual(['', 'EE-A-0001'])
  })

  it('counts a blank line between data rows', () => {
    expect(cells('h\na\n\nb\n')).toEqual([['h'], ['a'], [''], ['b']])
  })

  it('trims an unquoted field', () => {
    expect(cells('  a  ,\tb\t\n')).toEqual([['a', 'b']])
  })

  it('preserves a quoted field verbatim, padding included', () => {
    // remarks is documented as preserved verbatim — never trimmed.
    expect(cells('a,"  padded  ",c\n')).toEqual([['a', '  padded  ', 'c']])
  })

  it('preserves a quoted whitespace-only field as whitespace, not an absent cell', () => {
    expect(cells('a,"  ",c\n')).toEqual([['a', '  ', 'c']])
  })

  it('reads an empty quoted field as an empty field', () => {
    expect(cells('a,"",c\n')).toEqual([['a', '', 'c']])
    expect(cells('""\n')).toEqual([['']])
  })

  it('reads a final "" with no trailing newline as a present, empty field', () => {
    // The row exists because the field was *quoted*, not because it has content:
    // dropping that condition from the end-of-input push loses the row entirely,
    // which would renumber nothing but would lose a deliberately blanked cell.
    expect(cells('""')).toEqual([['']])
    expect(cells('a\n""')).toEqual([['a'], ['']])
    expect(cells('a,""')).toEqual([['a', '']])
  })

  it('keeps trailing empty fields', () => {
    expect(cells('a,,\n')).toEqual([['a', '', '']])
  })

  it('preserves non-ASCII text', () => {
    expect(cells('设备序列号,备注\nEE-1,"首批\n出货"\n')).toEqual([
      ['设备序列号', '备注'], ['EE-1', '首批\n出货'],
    ])
  })
})

describe('readCsvGrid line numbers', () => {
  it('numbers each record by its physical line', () => {
    expect(readCsvGrid('h1,h2\nr1,r2\nr3,r4\n').map((r) => r.lineNo)).toEqual([1, 2, 3])
  })

  it('counts blank lines', () => {
    expect(readCsvGrid('h\na\n\nb\n').map((r) => r.lineNo)).toEqual([1, 2, 3, 4])
  })

  it('numbers a record by the line it starts on, past a multi-line quoted value', () => {
    // `remarks` is documented as bilingual and multiline, so a quoted newline is
    // legitimate data — and it makes record count and line count diverge. Deriving
    // source_row_no from the array index would report the last row here as row 3.
    const rows = readCsvGrid('h1,h2\nr1,"one\ntwo"\nr3,r4\n')
    expect(rows.map((r) => r.lineNo)).toEqual([1, 2, 4])
    expect(rows[1].cells).toEqual(['r1', 'one\ntwo'])
    expect(rows[2].cells).toEqual(['r3', 'r4'])
  })

  it('counts every line of a value that spans more than two', () => {
    const rows = readCsvGrid('h\n"a\nb\nc"\nd\ne\n')
    expect(rows.map((r) => r.lineNo)).toEqual([1, 2, 5, 6])
    expect(rows[1].cells).toEqual(['a\nb\nc'])
    expect(rows[3].cells).toEqual(['e'])
  })

  it('counts a CRLF line break inside a quoted value', () => {
    const rows = readCsvGrid('h\r\n"a\r\nb"\r\nc\r\n')
    expect(rows.map((r) => r.lineNo)).toEqual([1, 2, 4])
    expect(rows[1].cells).toEqual(['a\nb'])
  })

  it('numbers a final record with no trailing newline', () => {
    expect(readCsvGrid('h\na\nb').map((r) => r.lineNo)).toEqual([1, 2, 3])
    expect(readCsvGrid('h\n"a\nb"').map((r) => r.lineNo)).toEqual([1, 2])
  })
})
