/**
 * Pure component-installation logic. Current components are simply the
 * installations that were never removed; a slot's history is every installation
 * that ever occupied that (type, slot) on the device, newest first. The
 * replacement-shape rule enforces the tracking-mode contract before any DB work,
 * so the transactional primitive (componentService) can trust its inputs.
 */
export type InstallationRow = {
  id: string
  componentTypeId: string
  componentUnitId: string | null
  batchNo: string | null
  slotNo: number
  installedAt: Date
  removedAt: Date | null
}

export class InvalidReplacementError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidReplacementError'
  }
}

export function currentInstallations(rows: InstallationRow[]): InstallationRow[] {
  return rows.filter((r) => r.removedAt === null)
}

export function historyForSlot(
  rows: InstallationRow[], componentTypeId: string, slotNo: number,
): InstallationRow[] {
  return rows
    .filter((r) => r.componentTypeId === componentTypeId && r.slotNo === slotNo)
    .sort((a, b) => b.installedAt.getTime() - a.installedAt.getTime())
}

export type ReplacementCheck = {
  trackingMode: 'serialized' | 'batch'
  removingUnitId: string | null
  replacementUnitId: string | null
  replacementBatchNo: string | null
}

/**
 * A serialized type is replaced by another unit (never the one being removed);
 * a batch type is replaced by a batch number. Throwing here keeps the impossible
 * states out of the transaction rather than relying on DB constraints alone.
 */
export function assertReplacementShape(c: ReplacementCheck): void {
  if (c.trackingMode === 'serialized') {
    if (!c.replacementUnitId) {
      throw new InvalidReplacementError('A serialized component must be replaced by a specific unit')
    }
    if (c.replacementUnitId === c.removingUnitId) {
      throw new InvalidReplacementError('The replacement cannot be the same unit being removed')
    }
    return
  }
  if (!c.replacementBatchNo) {
    throw new InvalidReplacementError('A batch component must be replaced by a batch number')
  }
}
