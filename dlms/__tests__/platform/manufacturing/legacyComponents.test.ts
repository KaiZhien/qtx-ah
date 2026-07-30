import { describe, it, expect } from 'vitest'
import {
  mapLegacyComponents, needsSplitSerial, type LegacyComponentRow,
} from '@/modules/manufacturing/domain/legacyComponents'

const CREATED = new Date('2026-03-14T08:00:00Z')

const row = (over: Partial<LegacyComponentRow> = {}): LegacyComponentRow => ({
  deviceId: 'device-uuid-1',
  createdAt: CREATED,
  pcbaASn: 'EE-02A-2603-0001',
  pcbaAHwRev: 'V1.2',
  pcbaABomRev: 'B3',
  pcbaAFwVer: '1.0.4',
  pcbaBSn: null,
  pcbaBHwRev: null,
  pcbaBBomRev: null,
  pcbaBFwVer: null,
  screenModel: null,
  hmiVer: null,
  ...over,
})

describe('needsSplitSerial', () => {
  it('accepts a single clean serial', () => {
    expect(needsSplitSerial('EE-02A-2603-0001')).toBe(false)
    expect(needsSplitSerial('PCBA_B/2026/0007')).toBe(false)
  })
  it('accepts values that merely contain the ASCII words "to"/"and" as part of a clean serial', () => {
    // Former false positives: hyphens created regex word boundaries around
    // "to"/"and" under the old denylist. The allowlist doesn't care — these
    // are ordinary ASCII letters/digits/separators with no doubled hyphen.
    expect(needsSplitSerial('EE-TO-2603-0001')).toBe(false)
    expect(needsSplitSerial('EE-AND-2603-0001')).toBe(false)
  })
  it('flags a range', () => {
    expect(needsSplitSerial('EE-02A-2603-0001 to 0015')).toBe(true)
    expect(needsSplitSerial('EE-0001 TO 0015')).toBe(true)
  })
  it('flags a list', () => {
    expect(needsSplitSerial('EE-0001, EE-0002')).toBe(true)
    expect(needsSplitSerial('EE-0001 and EE-0002')).toBe(true)
    expect(needsSplitSerial('EE-0001 & EE-0002')).toBe(true)
  })
  it('flags prose — a sentence is not a serial', () => {
    expect(needsSplitSerial('No wifi version')).toBe(true)
    expect(needsSplitSerial('无 wifi 版本')).toBe(true)
  })
  it('flags a doubled hyphen even with no whitespace — range notation, not a part number', () => {
    expect(needsSplitSerial('EE--0015')).toBe(true)
  })
  it('flags a list separated by an ASCII comma with no whitespace', () => {
    // Regression guard: every pre-existing "flags true" fixture also
    // contained a space, so a stub of just /\s/.test(serial) passed the
    // whole suite. These cases have zero ASCII whitespace and only pass
    // under the real allowlist/separator logic.
    expect(needsSplitSerial('EE-0001,EE-0002')).toBe(true)
  })
  it('flags a full-width comma (U+FF0C) with no ASCII whitespace', () => {
    expect(needsSplitSerial('EE-0001，EE-0002')).toBe(true)
  })
  it('flags an ideographic comma (U+3001) with no ASCII whitespace', () => {
    expect(needsSplitSerial('EE-0001、EE-0002')).toBe(true)
  })
  it('flags a full-width tilde (U+FF5E) range with no ASCII whitespace', () => {
    expect(needsSplitSerial('EE-0001～0015')).toBe(true)
  })
  it('flags the Chinese range word 至 with no ASCII whitespace', () => {
    expect(needsSplitSerial('EE-0001至0015')).toBe(true)
  })
  it('flags self-contained CJK prose with no ASCII whitespace', () => {
    // The bilingual factory sheet can carry Chinese prose with no English
    // words to force spaces around it — this is the case the old
    // whitespace-driven check missed entirely.
    expect(needsSplitSerial('无线版本说明书编号')).toBe(true)
  })
  it('treats an empty or whitespace-only value as clean — unitFor already turns it into no unit', () => {
    expect(needsSplitSerial('')).toBe(false)
    expect(needsSplitSerial('   ')).toBe(false)
  })
})

describe('mapLegacyComponents — PCBA-A', () => {
  it('produces one serialized unit and one installation, revisions verbatim', () => {
    const [install, ...rest] = mapLegacyComponents(row())
    expect(rest).toHaveLength(0)
    expect(install.typeCode).toBe('pcba_a')
    expect(install.batchNo).toBeNull()
    expect(install.unit).toEqual({
      typeCode: 'pcba_a', serialNo: 'EE-02A-2603-0001',
      hwRev: 'V1.2', bomRev: 'B3', fwVer: '1.0.4', needsSplit: false,
    })
  })

  it('stamps installed_at from the device creation time — never the clock', () => {
    expect(mapLegacyComponents(row())[0].installedAt).toBe(CREATED)
  })

  it('carries a ranged serial VERBATIM as one unit and flags it, never splitting', () => {
    const [install] = mapLegacyComponents(row({ pcbaASn: 'EE-02A-2603-0001 to 0015' }))
    expect(install.unit!.serialNo).toBe('EE-02A-2603-0001 to 0015')
    expect(install.unit!.needsSplit).toBe(true)
  })

  it('produces nothing for PCBA-A when the serial is blank', () => {
    expect(mapLegacyComponents(row({ pcbaASn: '   ' }))).toHaveLength(0)
  })

  it('trims surrounding whitespace but preserves internal characters', () => {
    const [install] = mapLegacyComponents(row({ pcbaASn: '  EE-02A-2603-0001  ' }))
    expect(install.unit!.serialNo).toBe('EE-02A-2603-0001')
  })

  it('trims surrounding whitespace from hwRev/bomRev/fwVer, leaving internal content untouched', () => {
    // Pinning intentional behavior: spec §15 says revisions are carried
    // "verbatim", but that means untouched content, not untouched padding.
    // Surrounding whitespace from the legacy export is trimmed like the
    // serial; any internal spacing is left exactly as the row had it.
    const [install] = mapLegacyComponents(row({
      pcbaAHwRev: '  V1.2 Rev A  ', pcbaABomRev: '  B3  ', pcbaAFwVer: '  1.0.4  ',
    }))
    expect(install.unit).toEqual({
      typeCode: 'pcba_a', serialNo: 'EE-02A-2603-0001',
      hwRev: 'V1.2 Rev A', bomRev: 'B3', fwVer: '1.0.4', needsSplit: false,
    })
  })
})

describe('mapLegacyComponents — PCBA-B', () => {
  it('adds a second installation when a B serial is present', () => {
    const installs = mapLegacyComponents(row({
      pcbaBSn: 'CTRL-0007', pcbaBHwRev: 'V2.0', pcbaBBomRev: null, pcbaBFwVer: '2.1',
    }))
    expect(installs.map((i) => i.typeCode)).toEqual(['pcba_a', 'pcba_b'])
    expect(installs[1].unit).toEqual({
      typeCode: 'pcba_b', serialNo: 'CTRL-0007',
      hwRev: 'V2.0', bomRev: null, fwVer: '2.1', needsSplit: false,
    })
  })

  it('carries a prose B value verbatim and flags it rather than judging it', () => {
    const installs = mapLegacyComponents(row({ pcbaBSn: 'No wifi version' }))
    expect(installs[1].unit!.serialNo).toBe('No wifi version')
    expect(installs[1].unit!.needsSplit).toBe(true)
  })

  it('omits PCBA-B entirely when it has no serial, even if revisions are present', () => {
    const installs = mapLegacyComponents(row({ pcbaBSn: null, pcbaBHwRev: 'V2.0' }))
    expect(installs.map((i) => i.typeCode)).toEqual(['pcba_a'])
  })
})

describe('mapLegacyComponents — HMI screen', () => {
  it('is a BATCH installation: no unit, batch_no from the model', () => {
    const installs = mapLegacyComponents(row({ screenModel: 'TK-070', hmiVer: '3.2' }))
    const screen = installs.find((i) => i.typeCode === 'hmi_screen')!
    expect(screen.unit).toBeNull()
    expect(screen.batchNo).toBe('TK-070')
    expect(screen.installedAt).toBe(CREATED)
  })

  it('records both legacy screen values verbatim in the notes', () => {
    const installs = mapLegacyComponents(row({ screenModel: 'TK-070', hmiVer: '3.2' }))
    const screen = installs.find((i) => i.typeCode === 'hmi_screen')!
    expect(screen.notes).toContain('TK-070')
    expect(screen.notes).toContain('3.2')
  })

  it('falls back to the HMI version as batch_no when only that is present', () => {
    const installs = mapLegacyComponents(row({ screenModel: null, hmiVer: '3.2' }))
    const screen = installs.find((i) => i.typeCode === 'hmi_screen')!
    expect(screen.batchNo).toBe('3.2')
  })

  it('produces no screen installation when both columns are empty', () => {
    const installs = mapLegacyComponents(row({ screenModel: '  ', hmiVer: null }))
    expect(installs.map((i) => i.typeCode)).toEqual(['pcba_a'])
  })
})

describe('mapLegacyComponents — a fully populated row', () => {
  it('produces all three groups in catalogue order', () => {
    const installs = mapLegacyComponents(row({
      pcbaBSn: 'CTRL-0007', screenModel: 'TK-070', hmiVer: '3.2',
    }))
    expect(installs.map((i) => i.typeCode)).toEqual(['pcba_a', 'pcba_b', 'hmi_screen'])
    expect(installs.every((i) => i.installedAt === CREATED)).toBe(true)
  })

  it('never invents a serial for any group', () => {
    const installs = mapLegacyComponents(row({ screenModel: 'TK-070' }))
    for (const i of installs) {
      if (i.unit) expect(i.unit.serialNo.trim()).not.toBe('')
    }
    expect(installs.find((i) => i.typeCode === 'hmi_screen')!.unit).toBeNull()
  })
})
