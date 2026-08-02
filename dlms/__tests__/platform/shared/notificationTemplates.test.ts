import { describe, it, expect } from 'vitest'
import {
  buildHandoffNotification, buildApprovalRequestedNotification,
  buildApprovalDecidedNotification,
} from '@/modules/shared/notifications/domain/templates'

/**
 * The pure builders that turn a drained outbox event into the message a person reads.
 * Mirrors handoffTemplates.ts's contract: build or throw, touch nothing else.
 */

describe('buildHandoffNotification', () => {
  it('names the device, both statuses and the person who moved it', () => {
    const n = buildHandoffNotification({
      deviceId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      deviceSn: 'SN-00042', pcbaASnLegacy: null,
      fromStatus: 'ready_for_delivery', toStatus: 'shipped',
      reason: null, changedByName: 'Wei Chen', module: 'logistics',
    })
    expect(n.category).toBe('status_handoff')
    expect(n.title).toContain('SN-00042')
    expect(n.body).toContain('ready for delivery')
    expect(n.body).toContain('shipped')
    expect(n.body).toContain('Wei Chen')
    expect(n.entityType).toBe('device')
    expect(n.entityId).toBe('dddddddd-dddd-dddd-dddd-dddddddddddd')
    expect(n.url).toContain('dddddddd-dddd-dddd-dddd-dddddddddddd')
  })

  it('falls back to the legacy PCBA serial, then to the id, when there is no SN', () => {
    // Three-tier labelling, matching handoffTemplates: a device must always be nameable.
    const pcba = buildHandoffNotification({
      deviceId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      deviceSn: null, pcbaASnLegacy: 'PCBA-9', fromStatus: 'a', toStatus: 'b',
      reason: null, changedByName: 'X', module: 'logistics',
    })
    expect(pcba.title).toContain('PCBA-9')

    const bare = buildHandoffNotification({
      deviceId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      deviceSn: null, pcbaASnLegacy: null, fromStatus: 'a', toStatus: 'b',
      reason: null, changedByName: 'X', module: 'logistics',
    })
    expect(bare.title).toContain('dddddddd')
  })

  it('includes the reason when one was given', () => {
    const n = buildHandoffNotification({
      deviceId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      deviceSn: 'SN-1', pcbaASnLegacy: null, fromStatus: 'a', toStatus: 'b',
      reason: 'Customer pulled the order forward', changedByName: 'X', module: 'logistics',
    })
    expect(n.body).toContain('Customer pulled the order forward')
  })
})

describe('buildApprovalRequestedNotification', () => {
  it('names what needs deciding and who asked', () => {
    const n = buildApprovalRequestedNotification({
      approvalId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      kind: 'invoice', module: 'finance',
      entityType: 'sales_invoice', entityId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      label: 'INV-2026-014', requestedByName: 'Mei Lin',
    })
    expect(n.category).toBe('approval_requested')
    expect(n.title.toLowerCase()).toContain('approval')
    expect(n.body).toContain('INV-2026-014')
    expect(n.body).toContain('Mei Lin')
    expect(n.module).toBe('finance')
    // Points at the QUEUE, which is where the decision is actually made.
    expect(n.url).toBe('/approvals')
  })

  it('still reads sensibly with no label', () => {
    const n = buildApprovalRequestedNotification({
      approvalId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      kind: 'eco', module: 'engineering',
      entityType: 'eco', entityId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      label: null, requestedByName: 'Mei Lin',
    })
    expect(n.body).not.toContain('null')
    expect(n.body).toContain('Mei Lin')
  })
})

describe('buildApprovalDecidedNotification', () => {
  it('tells the requester the outcome and who decided', () => {
    const n = buildApprovalDecidedNotification({
      approvalId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      kind: 'invoice', module: 'finance',
      entityType: 'sales_invoice', entityId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      label: 'INV-2026-014', decidedByName: 'Wei Chen',
      decision: 'approved', note: null,
    })
    expect(n.category).toBe('approval_decided')
    expect(n.title.toLowerCase()).toContain('approved')
    expect(n.body).toContain('Wei Chen')
  })

  it('carries the rejection note — it is the whole point of a rejection', () => {
    // approvalService refuses a rejection without a note precisely so the requester is
    // not left guessing; dropping it here would undo that.
    const n = buildApprovalDecidedNotification({
      approvalId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      kind: 'invoice', module: 'finance',
      entityType: 'sales_invoice', entityId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      label: 'INV-2026-014', decidedByName: 'Wei Chen',
      decision: 'rejected', note: 'Line 3 tax code is wrong',
    })
    expect(n.title.toLowerCase()).toContain('rejected')
    expect(n.body).toContain('Line 3 tax code is wrong')
  })
})
