import { deflateRawSync } from 'node:zlib'

/**
 * A minimal, deterministic ZIP writer (APPNOTE 6.3.x, the classic 32-bit format).
 *
 * WHY NOT A LIBRARY. Adding `jszip`/`archiver` means editing package.json and
 * package-lock.json, which seven agents are landing branches against in the same
 * wave — a lockfile conflict is a merge hazard for everyone, for a format whose
 * writer is a hundred lines of well-specified header layout. It is also pure,
 * synchronous and fully unit-testable, which the house rule ("pure logic lives in
 * domain, no I/O") prefers anyway. Its test reads the archive back through an
 * INDEPENDENT reader that walks EOCD → central directory → local headers, so
 * conformance is proven rather than assumed.
 *
 * SCOPE LIMITS, stated so nobody discovers them at 3am:
 *   - 32-bit only. No ZIP64, so the archive must stay under 4 GiB total, each
 *     member under 4 GiB, and under 65,535 members. `assertZipCapacity` below
 *     refuses rather than silently truncating a size field. A full-system export
 *     of this fleet is megabytes; if it ever approaches these bounds, that is the
 *     signal to move to the spec's worker-built streaming export.
 *   - Deflate (method 8) only, no encryption. Spec §12 wants 7z AES-256 with a
 *     separately-delivered passphrase — that is deferred with the rest of the S3
 *     delivery path, and this writer does NOT pretend to provide it.
 */

export class DuplicateZipEntryError extends Error {
  constructor(name: string) {
    super(`Two export files share the path "${name}". A ZIP with duplicate members is `
      + 'ambiguous — the manifest could not say which one its sha256 describes.')
    this.name = 'DuplicateZipEntryError'
  }
}

export class ZipCapacityError extends Error {
  constructor(detail: string) {
    super(`This export is too large for the 32-bit ZIP format: ${detail}. `
      + 'Building it anyway would truncate a size field and produce a corrupt archive.')
    this.name = 'ZipCapacityError'
  }
}

export type ZipEntry = { name: string; data: Buffer }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

/** IEEE CRC-32, the checksum every ZIP member carries. Unsigned. */
export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * A FIXED DOS timestamp (1980-01-01 00:00:00), not the wall clock.
 *
 * Looks like a placeholder somebody forgot to finish; it is what makes the
 * archive deterministic. Two builds of the same content must be byte-identical so
 * the ZIP's own sha256 is reproducible and an operator can compare a rebuild
 * against a previous export. Real timestamps live in manifest.json, where they
 * are readable and do not perturb the hash of everything else.
 */
const DOS_TIME = 0
const DOS_DATE = 0x0021

/** Bit 11: filename and comment are UTF-8. Without it, non-ASCII paths mojibake. */
const FLAG_UTF8 = 0x0800
const METHOD_DEFLATE = 8
const VERSION_NEEDED = 20

const MAX_U32 = 0xffffffff
const MAX_U16 = 0xffff

function assertZipCapacity(value: number, what: string) {
  if (value > MAX_U32) throw new ZipCapacityError(`${what} exceeds 4 GiB`)
}

export function buildZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > MAX_U16) {
    throw new ZipCapacityError(`${entries.length} members exceeds the 65,535 limit`)
  }

  const seen = new Set<string>()
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    if (seen.has(e.name)) throw new DuplicateZipEntryError(e.name)
    seen.add(e.name)

    const nameBytes = Buffer.from(e.name, 'utf8')
    const compressed = deflateRawSync(e.data)
    const crc = crc32(e.data)

    assertZipCapacity(e.data.length, `member "${e.name}"`)
    assertZipCapacity(compressed.length, `compressed member "${e.name}"`)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)      // local file header signature
    local.writeUInt16LE(VERSION_NEEDED, 4)
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(METHOD_DEFLATE, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)              // extra field length
    locals.push(local, nameBytes, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)    // central directory header signature
    central.writeUInt16LE(VERSION_NEEDED, 4) // version made by
    central.writeUInt16LE(VERSION_NEEDED, 6) // version needed to extract
    central.writeUInt16LE(FLAG_UTF8, 8)
    central.writeUInt16LE(METHOD_DEFLATE, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)            // extra field length
    central.writeUInt16LE(0, 32)            // file comment length
    central.writeUInt16LE(0, 34)            // disk number start
    central.writeUInt16LE(0, 36)            // internal file attributes
    central.writeUInt32LE(0, 38)            // external file attributes
    central.writeUInt32LE(offset, 42)       // relative offset of local header
    centrals.push(central, nameBytes)

    offset += 30 + nameBytes.length + compressed.length
    assertZipCapacity(offset, 'the archive')
  }

  const centralBytes = Buffer.concat(centrals)
  assertZipCapacity(centralBytes.length, 'the central directory')

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)         // end of central directory signature
  eocd.writeUInt16LE(0, 4)                  // number of this disk
  eocd.writeUInt16LE(0, 6)                  // disk with the central directory
  eocd.writeUInt16LE(entries.length, 8)     // entries on this disk
  eocd.writeUInt16LE(entries.length, 10)    // entries total
  eocd.writeUInt32LE(centralBytes.length, 12)
  eocd.writeUInt32LE(offset, 16)            // central directory offset
  eocd.writeUInt16LE(0, 20)                 // .zip comment length

  return Buffer.concat([...locals, centralBytes, eocd])
}
