import { describe, it, expect } from 'vitest'
import {
  sha256Hex, describeFile, buildManifest, manifestBytes, MANIFEST_PATH,
} from '@/modules/shared/export/domain/manifest'
import {
  isMfaFresh, EXPORT_MFA_MAX_AGE_SECONDS, MFA_CLOCK_SKEW_SECONDS,
} from '@/modules/shared/export/domain/mfaFreshness'

describe('sha256Hex', () => {
  it('matches the known digest of the empty string', () => {
    expect(sha256Hex(Buffer.alloc(0)))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('matches the known digest of "abc"', () => {
    expect(sha256Hex(Buffer.from('abc')))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('is 64 lowercase hex characters', () => {
    expect(sha256Hex(Buffer.from('anything'))).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashes BYTES, so bilingual content is unambiguous', () => {
    expect(sha256Hex(Buffer.from('无', 'utf8'))).toBe(sha256Hex(Buffer.from([0xe6, 0x97, 0xa0])))
  })
})

describe('describeFile', () => {
  it('records path, byte length and digest of the exact bytes shipped', () => {
    const data = Buffer.from('id,sn\r\n')
    expect(describeFile('csv/device.csv', data, { entity: 'device', rowCount: 0 })).toEqual({
      path: 'csv/device.csv',
      format: 'csv',
      bytes: 7,
      sha256: sha256Hex(data),
      entity: 'device',
      rowCount: 0,
    })
  })

  it('preserves a rowCount of 0 rather than dropping it as falsy', () => {
    // "0 rows" and "row counts do not apply" are different facts.
    const f = describeFile('csv/device.csv', Buffer.from('x'), { entity: 'device', rowCount: 0 })
    expect(f.rowCount).toBe(0)
    expect('rowCount' in f).toBe(true)
  })

  it('reports rowCount null for a file that is not a row set', () => {
    const f = describeFile('README.md', Buffer.from('# hi'))
    expect(f.rowCount).toBeNull()
    expect(f.entity).toBeNull()
  })

  it('derives the format from the extension', () => {
    expect(describeFile('a.csv', Buffer.from('')).format).toBe('csv')
    expect(describeFile('a.json', Buffer.from('')).format).toBe('json')
    expect(describeFile('a.md', Buffer.from('')).format).toBe('markdown')
  })
})

describe('buildManifest — what makes the export VERIFIABLE (spec §12)', () => {
  const base = {
    exportId: '11111111-2222-3333-4444-555555555555',
    requestedAt: '2026-08-03T10:00:00.000Z',
    builtAt: '2026-08-03T10:00:04.000Z',
    requestedBy: { id: 'u1', name: 'Reet Mitra', email: 'reet@example.com' },
    appVersion: '0.1.0',
    schemaVersion: '20260803160000_platform_search_indexes',
    files: [
      describeFile('csv/device.csv', Buffer.from('a'), { entity: 'device', rowCount: 3 }),
      describeFile('csv/buyer.csv', Buffer.from('bb'), { entity: 'buyer', rowCount: 0 }),
      describeFile('README.md', Buffer.from('ccc')),
    ],
    deferred: ['attachments/'],
  }

  it('carries the export id, both timestamps, and the requester', () => {
    const m = buildManifest(base)
    expect(m.exportId).toBe(base.exportId)
    expect(m.requestedAt).toBe(base.requestedAt)
    expect(m.builtAt).toBe(base.builtAt)
    expect(m.requestedBy.email).toBe('reet@example.com')
  })

  it('carries app AND schema versions, so a restore knows what shape this is', () => {
    const m = buildManifest(base)
    expect(m.appVersion).toBe('0.1.0')
    expect(m.schemaVersion).toBe('20260803160000_platform_search_indexes')
  })

  it('lists every file with a sha256 — the point of the manifest', () => {
    const m = buildManifest(base)
    expect(m.files).toHaveLength(3)
    for (const f of m.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('totals files, bytes and rows across the export', () => {
    const m = buildManifest(base)
    expect(m.totals.files).toBe(3)
    expect(m.totals.bytes).toBe(1 + 2 + 3)
    expect(m.totals.rows).toBe(3) // 3 + 0; README contributes no rows
  })

  it('does NOT list itself — a file cannot carry its own digest', () => {
    const m = buildManifest(base)
    expect(m.files.map((f) => f.path)).not.toContain(MANIFEST_PATH)
  })

  it('records what was deliberately NOT exported', () => {
    // Attachments are in the spec's export tree and are blocked on file storage.
    // Silence would read as "there were none".
    expect(buildManifest(base).deferred).toContain('attachments/')
  })

  it('sorts files by path so two builds of one export compare cleanly', () => {
    const shuffled = { ...base, files: [base.files[2], base.files[0], base.files[1]] }
    expect(buildManifest(shuffled).files.map((f) => f.path))
      .toEqual(['README.md', 'csv/buyer.csv', 'csv/device.csv'])
  })
})

describe('manifestBytes', () => {
  const m = buildManifest({
    exportId: 'e', requestedAt: 'a', builtAt: 'b',
    requestedBy: { id: 'u', name: 'n', email: 'e' },
    appVersion: '1', schemaVersion: 's',
    files: [describeFile('a.csv', Buffer.from('x'), { entity: 'a', rowCount: 1 })],
    deferred: [],
  })

  it('is parseable JSON', () => {
    expect(JSON.parse(manifestBytes(m).toString('utf8')).exportId).toBe('e')
  })

  it('is deterministic for the same manifest', () => {
    expect(manifestBytes(m).equals(manifestBytes(m))).toBe(true)
  })

  it('is newline-terminated, so it reads correctly in a terminal', () => {
    expect(manifestBytes(m).toString('utf8').endsWith('\n')).toBe(true)
  })
})

describe('isMfaFresh — spec §12 "Super Admin + fresh MFA (§7.4)"', () => {
  const now = new Date('2026-08-03T10:00:00Z')
  const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString()

  it('accepts a TOTP challenge completed just now', () => {
    expect(isMfaFresh([{ method: 'totp', timestamp: ago(10) }], now)).toBe(true)
  })

  it('accepts one inside the max age and rejects one past it', () => {
    expect(EXPORT_MFA_MAX_AGE_SECONDS).toBe(300)
    expect(isMfaFresh([{ method: 'totp', timestamp: ago(299) }], now)).toBe(true)
    expect(isMfaFresh([{ method: 'totp', timestamp: ago(301) }], now)).toBe(false)
  })

  it('REJECTS a password-only session, however recent', () => {
    // AAL2 is the gate; a fresh password is not a fresh second factor.
    expect(isMfaFresh([{ method: 'password', timestamp: ago(1) }], now)).toBe(false)
  })

  it('finds the TOTP entry even when password is listed alongside it', () => {
    expect(isMfaFresh([
      { method: 'password', timestamp: ago(9000) },
      { method: 'totp', timestamp: ago(30) },
    ], now)).toBe(true)
  })

  it('uses the MOST RECENT factor entry when several are present', () => {
    expect(isMfaFresh([
      { method: 'totp', timestamp: ago(9000) },
      { method: 'mfa/totp', timestamp: ago(5) },
    ], now)).toBe(true)
  })

  it('FAILS CLOSED on an empty, null or undefined method list', () => {
    expect(isMfaFresh([], now)).toBe(false)
    expect(isMfaFresh(null, now)).toBe(false)
    expect(isMfaFresh(undefined, now)).toBe(false)
  })

  it('FAILS CLOSED on an unparseable timestamp', () => {
    expect(isMfaFresh([{ method: 'totp', timestamp: 'not-a-date' }], now)).toBe(false)
    expect(isMfaFresh([{ method: 'totp', timestamp: '' }], now)).toBe(false)
  })

  it('tolerates small clock skew but rejects a wildly future timestamp', () => {
    const ahead = (s: number) => new Date(now.getTime() + s * 1000).toISOString()
    expect(MFA_CLOCK_SKEW_SECONDS).toBe(60)
    expect(isMfaFresh([{ method: 'totp', timestamp: ahead(30) }], now)).toBe(true)
    expect(isMfaFresh([{ method: 'totp', timestamp: ahead(3600) }], now)).toBe(false)
  })

  it('honours an explicit max age when one is passed', () => {
    expect(isMfaFresh([{ method: 'totp', timestamp: ago(120) }], now, 60)).toBe(false)
    expect(isMfaFresh([{ method: 'totp', timestamp: ago(30) }], now, 60)).toBe(true)
  })
})
