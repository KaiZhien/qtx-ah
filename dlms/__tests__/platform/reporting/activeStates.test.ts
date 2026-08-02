import { describe, it, expect } from 'vitest'
import {
  ACTIVE_REPAIR_STATUSES, TERMINAL_REPAIR_STATUSES,
  OPEN_DO_STATUSES, TERMINAL_DO_STATUSES,
  UNPAID_INVOICE_STATUSES, NOT_UNPAID_INVOICE_STATUSES,
} from '@/modules/shared/reporting/domain/activeStates'
import { REPAIR_STATUSES } from '@/modules/maintenance/domain/repairStatus'
import { DO_STATUSES } from '@/modules/logistics/domain/doStatus'
import { INVOICE_STATUSES } from '@/modules/finance/domain/invoiceStatus'

describe('ACTIVE_REPAIR_STATUSES', () => {
  it('partitions the repair vocabulary — every status is active XOR terminal', () => {
    // The guard that matters: a status added to repairStatus.ts must land in one
    // of the two sets, and this fails if it lands in neither or both.
    for (const s of REPAIR_STATUSES) {
      const active = ACTIVE_REPAIR_STATUSES.includes(s)
      const terminal = TERMINAL_REPAIR_STATUSES.includes(s)
      expect(active !== terminal, `${s} is in neither set or in both`).toBe(true)
    }
    expect(ACTIVE_REPAIR_STATUSES.length + TERMINAL_REPAIR_STATUSES.length)
      .toBe(REPAIR_STATUSES.length)
  })

  it('counts awaiting_sign_off as ACTIVE — it is blocked on a human, not done', () => {
    // allowedNextRepairStatuses('awaiting_sign_off') is [] because sign-off is a
    // gated action, not an ordinary edge. Deriving "terminal" from "no outgoing
    // edges" would hide the most actionable repair on the board.
    expect(ACTIVE_REPAIR_STATUSES).toContain('awaiting_sign_off')
  })

  it('excludes exactly closed and cancelled', () => {
    expect([...TERMINAL_REPAIR_STATUSES].sort()).toEqual(['cancelled', 'closed'])
    expect(ACTIVE_REPAIR_STATUSES).not.toContain('closed')
    expect(ACTIVE_REPAIR_STATUSES).not.toContain('cancelled')
  })

  it('includes the early states — a reported repair is work in hand', () => {
    expect(ACTIVE_REPAIR_STATUSES).toContain('reported')
    expect(ACTIVE_REPAIR_STATUSES).toContain('in_diagnosis')
  })
})

describe('OPEN_DO_STATUSES', () => {
  it('partitions the DO vocabulary', () => {
    for (const s of DO_STATUSES) {
      expect(OPEN_DO_STATUSES.includes(s) !== TERMINAL_DO_STATUSES.includes(s)).toBe(true)
    }
  })

  it('counts a draft DO as outstanding — an unprepared delivery is the point', () => {
    expect(OPEN_DO_STATUSES).toContain('draft')
    expect(OPEN_DO_STATUSES).toContain('prepared')
    expect(OPEN_DO_STATUSES).toContain('dispatched')
  })

  it('excludes delivered and cancelled', () => {
    expect(OPEN_DO_STATUSES).not.toContain('delivered')
    expect(OPEN_DO_STATUSES).not.toContain('cancelled')
  })
})

describe('UNPAID_INVOICE_STATUSES', () => {
  it('is issued alone', () => {
    expect([...UNPAID_INVOICE_STATUSES]).toEqual(['issued'])
  })

  it('never counts a draft as money owed', () => {
    expect(UNPAID_INVOICE_STATUSES).not.toContain('draft')
    expect(NOT_UNPAID_INVOICE_STATUSES).toContain('draft')
  })

  it('partitions the invoice vocabulary', () => {
    for (const s of INVOICE_STATUSES) {
      expect(UNPAID_INVOICE_STATUSES.includes(s) !== NOT_UNPAID_INVOICE_STATUSES.includes(s))
        .toBe(true)
    }
  })
})
