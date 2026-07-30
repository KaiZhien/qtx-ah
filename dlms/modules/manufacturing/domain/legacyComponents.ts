/**
 * Pure mapper for the legacy component-data migration (spec §15). No I/O.
 *
 * The legacy DLMS `device` table flattens components into ten wide columns; the
 * platform normalizes them into component_unit + component_installation. This
 * turns one legacy row into the installation drafts that describe it, and makes
 * no decisions the data does not support.
 *
 * Two rules are load-bearing and look like bugs if you don't know why:
 *
 * 1. A ranged serial ("…0001 to 0015") becomes ONE unit carrying that string
 *    verbatim, flagged needsSplit — never fifteen units. The bulk importer does
 *    the opposite because it is told about devices that do not exist yet, so
 *    expanding invents nothing. Here the device already exists and its identity
 *    was already decided by scripts/migrate_demo.ts, which likewise refused to
 *    split. Splitting would invent component identities the business never
 *    assigned and disagree with the device row the components hang off.
 *
 * 2. The HMI screen becomes a BATCH installation (no unit row, batch_no set)
 *    because legacy identifies a screen only by model and firmware version —
 *    neither identifies an individual screen, and component_unit.serial_no is
 *    NOT NULL, so a unit would mean inventing a serial. component_type
 *    .tracking_mode stays 'serialized' for hmi_screen deliberately: it
 *    describes what a screen should be once screens carry serials, and keeps
 *    assertReplacementShape demanding a real unit for any future swap. The
 *    batch-form installation describes what the legacy data actually knows.
 */

export type LegacyComponentRow = {
  deviceId: string
  createdAt: Date
  pcbaASn: string | null
  pcbaAHwRev: string | null
  pcbaABomRev: string | null
  pcbaAFwVer: string | null
  pcbaBSn: string | null
  pcbaBHwRev: string | null
  pcbaBBomRev: string | null
  pcbaBFwVer: string | null
  screenModel: string | null
  hmiVer: string | null
}

export type ComponentUnitDraft = {
  typeCode: 'pcba_a' | 'pcba_b'
  serialNo: string
  hwRev: string | null
  bomRev: string | null
  fwVer: string | null
  /**
   * "This serial needs human eyes before it is trustworthy." Spec §15 defines
   * it for ranged serials; it is deliberately widened here to any value that is
   * not a single clean serial, because component_unit has no other flag and the
   * admin cleanup queue works off this one. A migration that judged prose like
   * "No wifi version" to mean "no board" would be guessing — so it carries the
   * value verbatim and flags it instead.
   */
  needsSplit: boolean
}

export type ComponentInstallDraft = {
  typeCode: 'pcba_a' | 'pcba_b' | 'hmi_screen'
  unit: ComponentUnitDraft | null   // null for the batch-tracked screen
  batchNo: string | null            // set only when unit is null
  notes: string | null
  installedAt: Date                 // always device.created_at (spec §15)
}

const text = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim()
  return t === '' ? null : t
}

/** A single clean serial: no separators that imply several, and no spaces. */
export function needsSplitSerial(serial: string): boolean {
  const s = serial.trim()
  if (s === '') return false
  // Range or list notation — the spec's own examples.
  if (/\bto\b|\band\b|[,&~]|-{2,}/i.test(s)) return true
  // Anything with whitespace inside is prose, not a part number.
  if (/\s/.test(s)) return true
  return false
}

function unitFor(
  typeCode: 'pcba_a' | 'pcba_b',
  sn: string | null, hwRev: string | null, bomRev: string | null, fwVer: string | null,
): ComponentUnitDraft | null {
  const serialNo = text(sn)
  if (serialNo === null) return null
  return {
    typeCode, serialNo,
    hwRev: text(hwRev), bomRev: text(bomRev), fwVer: text(fwVer),
    needsSplit: needsSplitSerial(serialNo),
  }
}

/**
 * One legacy row → its installation drafts, in catalogue order (pcba_a,
 * pcba_b, hmi_screen). A group with nothing populated produces nothing at all:
 * a device genuinely without an accessory board must not gain an empty one.
 */
export function mapLegacyComponents(row: LegacyComponentRow): ComponentInstallDraft[] {
  const installs: ComponentInstallDraft[] = []

  const a = unitFor('pcba_a', row.pcbaASn, row.pcbaAHwRev, row.pcbaABomRev, row.pcbaAFwVer)
  if (a) installs.push({ typeCode: 'pcba_a', unit: a, batchNo: null, notes: null, installedAt: row.createdAt })

  const b = unitFor('pcba_b', row.pcbaBSn, row.pcbaBHwRev, row.pcbaBBomRev, row.pcbaBFwVer)
  if (b) installs.push({ typeCode: 'pcba_b', unit: b, batchNo: null, notes: null, installedAt: row.createdAt })

  const screenModel = text(row.screenModel)
  const hmiVer = text(row.hmiVer)
  if (screenModel || hmiVer) {
    installs.push({
      typeCode: 'hmi_screen',
      unit: null,
      // batch_no is NOT NULL-by-constraint when unit is null, so it takes
      // whichever value the row actually has; notes keep both verbatim so
      // nothing the legacy row said is lost to the choice.
      batchNo: screenModel ?? hmiVer,
      notes: [
        screenModel ? `Screen model: ${screenModel}` : null,
        hmiVer ? `HMI version: ${hmiVer}` : null,
      ].filter(Boolean).join('; ') || null,
      installedAt: row.createdAt,
    })
  }

  return installs
}
