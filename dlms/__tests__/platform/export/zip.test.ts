import { describe, it, expect } from 'vitest'
import { inflateRawSync } from 'node:zlib'
import { buildZip, crc32, DuplicateZipEntryError } from '@/modules/shared/export/domain/zip'

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/**
 * A deliberately independent ZIP reader: it walks the End Of Central Directory
 * record, then the central directory, then each local header — the same route a
 * real unzip takes. Reading the archive back with the writer's own structures
 * would prove nothing.
 */
function readZip(zip: Buffer) {
  let eocd = -1
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('no EOCD found')

  const total = zip.readUInt16LE(eocd + 10)
  const cdSize = zip.readUInt32LE(eocd + 12)
  const cdOffset = zip.readUInt32LE(eocd + 16)

  const entries: { name: string; data: Buffer; method: number; crc: number }[] = []
  let p = cdOffset
  for (let i = 0; i < total; i++) {
    if (zip.readUInt32LE(p) !== CD_SIG) throw new Error(`bad CD signature at entry ${i}`)
    const flags = zip.readUInt16LE(p + 8)
    const method = zip.readUInt16LE(p + 10)
    const crc = zip.readUInt32LE(p + 16)
    const compSize = zip.readUInt32LE(p + 20)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const localOffset = zip.readUInt32LE(p + 42)
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8')

    if ((flags & 0x0800) === 0) throw new Error(`entry ${name} is not flagged UTF-8`)

    if (zip.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error('bad local signature')
    const lNameLen = zip.readUInt16LE(localOffset + 26)
    const lExtraLen = zip.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const stored = zip.subarray(dataStart, dataStart + compSize)

    entries.push({
      name, method, crc,
      data: method === 8 ? inflateRawSync(stored) : Buffer.from(stored),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return { entries, total, cdSize, cdOffset }
}

const entry = (name: string, text: string) => ({ name, data: Buffer.from(text, 'utf8') })

describe('crc32', () => {
  it('matches the known IEEE CRC-32 of "123456789"', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })

  it('is 0 for empty input', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })

  it('returns an unsigned 32-bit value', () => {
    const v = crc32(Buffer.from('hello world, a longer body to exercise the table'))
    expect(v).toBeGreaterThanOrEqual(0)
    expect(v).toBeLessThanOrEqual(0xffffffff)
  })
})

describe('buildZip — a spec-conformant reader can read it back', () => {
  it('round-trips a single entry', () => {
    const zip = buildZip([entry('README.md', 'hello')])
    const { entries } = readZip(zip)
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('README.md')
    expect(entries[0].data.toString('utf8')).toBe('hello')
  })

  it('round-trips many entries including nested paths', () => {
    const zip = buildZip([
      entry('manifest.json', '{"a":1}'),
      entry('csv/device.csv', 'id,sn\r\n1,QTX-P-00412\r\n'),
      entry('json/audit_extract.json', '[]'),
    ])
    const { entries } = readZip(zip)
    expect(entries.map((e) => e.name)).toEqual([
      'manifest.json', 'csv/device.csv', 'json/audit_extract.json',
    ])
    expect(entries[1].data.toString('utf8')).toBe('id,sn\r\n1,QTX-P-00412\r\n')
  })

  it('round-trips bilingual UTF-8 content and filenames byte-for-byte', () => {
    const body = '无 wifi 版本,EE-0001至0015\r\n'
    const zip = buildZip([entry('csv/设备.csv', body)])
    const { entries } = readZip(zip)
    expect(entries[0].name).toBe('csv/设备.csv')
    expect(entries[0].data.toString('utf8')).toBe(body)
  })

  it('records a CRC that matches the UNCOMPRESSED bytes', () => {
    const data = Buffer.from('some reasonably compressible content '.repeat(20))
    const zip = buildZip([{ name: 'a.txt', data }])
    const { entries } = readZip(zip)
    expect(entries[0].crc).toBe(crc32(data))
    expect(entries[0].data.equals(data)).toBe(true)
  })

  it('round-trips a zero-byte entry', () => {
    const zip = buildZip([{ name: 'empty.csv', data: Buffer.alloc(0) }])
    const { entries } = readZip(zip)
    expect(entries[0].data.length).toBe(0)
  })

  it('round-trips binary content that is not valid UTF-8', () => {
    const data = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01, 0x7f])
    const zip = buildZip([{ name: 'blob.bin', data }])
    expect(readZip(zip).entries[0].data.equals(data)).toBe(true)
  })

  it('round-trips content large enough to actually deflate', () => {
    const data = Buffer.from('id,name\r\n'.repeat(5000))
    const zip = buildZip([{ name: 'big.csv', data }])
    expect(zip.length).toBeLessThan(data.length) // it really compressed
    expect(readZip(zip).entries[0].data.equals(data)).toBe(true)
  })

  it('produces a valid EOCD whose counts and offsets agree with the archive', () => {
    const zip = buildZip([entry('a', '1'), entry('b', '2'), entry('c', '3')])
    const { total, cdSize, cdOffset } = readZip(zip)
    expect(total).toBe(3)
    expect(cdOffset + cdSize + 22).toBe(zip.length)
  })

  it('builds a valid EMPTY archive for zero entries', () => {
    const zip = buildZip([])
    expect(zip.length).toBe(22)
    expect(readZip(zip).entries).toEqual([])
  })

  it('is DETERMINISTIC — identical input yields byte-identical output', () => {
    // So the ZIP's own sha256 is reproducible and a rebuild can be compared to a
    // previous export. A wall-clock mtime in the header would break this.
    const build = () => buildZip([entry('a.csv', 'x'), entry('b.csv', 'y')])
    expect(build().equals(build())).toBe(true)
  })

  it('REFUSES duplicate entry names rather than writing an ambiguous archive', () => {
    // Two members with one name: which one does the manifest's sha256 describe?
    expect(() => buildZip([entry('a.csv', '1'), entry('a.csv', '2')]))
      .toThrow(DuplicateZipEntryError)
  })

  it('names the offending path in the duplicate error', () => {
    expect(() => buildZip([entry('csv/device.csv', '1'), entry('csv/device.csv', '2')]))
      .toThrow(/csv\/device\.csv/)
  })
})
