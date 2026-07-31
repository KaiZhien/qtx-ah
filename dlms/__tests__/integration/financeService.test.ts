// __tests__/integration/financeService.test.ts
//
// Written but NOT run in this worktree — no docker / no `npm run test:integration`
// available here (the ephemeral Postgres container's port is shared across
// parallel agents building other modules). The controller runs this at merge
// against the real test harness (__tests__/integration/setup.ts), which already
// picks up 20260720120000_platform_finance.sql automatically (its filename
// matches PLATFORM_MIGRATION_RE). Idiom mirrors
// __tests__/integration/deviceWriteService.test.ts: mock @/lib/supabase/server,
// connect real pg via TEST_DATABASE_URL, runTag for unique invoice_nos,
// afterAll cleanup of everything this file creates.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  listBuyers, getBuyer, createBuyer, updateBuyer, BuyerNotFoundError,
} from '@/modules/finance/services/buyerService'
import {
  listInvoices, getInvoice, createInvoice, updateInvoice, changeInvoiceStatus,
  listAllowedInvoiceTransitions, getInvoiceStatusCounts,
  requestInvoiceApproval, getInvoiceApprovalState,
  InvoiceNotFoundError, DuplicateInvoiceNoError,
} from '@/modules/finance/services/invoiceService'
import { InvalidInvoiceStatusChangeError } from '@/modules/finance/domain/invoiceStatus'
import {
  InvoiceApprovalError, buildInvoiceApprovalSnapshot,
} from '@/modules/finance/domain/invoiceApproval'
import { snapshotsAgree } from '@/modules/shared/approvals/domain/approvalDecision'
import {
  decideApproval, ApprovalAlreadyPendingError,
} from '@/modules/shared/approvals/services/approvalService'
import {
  FINANCE_APPROVAL_THRESHOLD_SGD, SettingUnavailableError,
} from '@/modules/shared/settings/services/settingService'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string
const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const createdBuyerIds: string[] = []
const createdInvoiceIds: string[] = []

// finance role: holds both view_finance and manage_finance (spec §3.2).
const fin = (): Actor => ({
  id: userId, roleKey: 'finance',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'view_finance', 'manage_finance']),
  moduleAccess: new Set(['finance']), active: true,
})
// manager with Finance module access but only view_finance (spec §3.2 footnote
// ① — a Manager sees financial info with module access, but manage_finance is
// Admin+/Finance-role only).
const mgrView = (): Actor => ({
  id: userId, roleKey: 'manager',
  permissions: new Set(['view_records', 'view_finance']),
  moduleAccess: new Set(['finance']), active: true,
})
// Viewer never holds view_finance, even with Finance module access (spec §3.2,
// decided 2026-07-17 — see the migration's buyer/sales_invoice comments).
const viewer = (): Actor => ({
  id: userId, roleKey: 'viewer',
  permissions: new Set(['view_records']),
  moduleAccess: new Set(['finance']), active: true,
})
// Holds every finance permission but was never granted the Finance module
// (spec §3.2: authorize() = module access AND permission).
const noModuleAccess = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'view_finance', 'manage_finance']),
  moduleAccess: new Set(['manufacturing']), active: true,
})

async function makeBuyer(name = `Buyer ${runTag}-${createdBuyerIds.length}`): Promise<{ id: string; version: number }> {
  const { rows } = await db.query<{ id: string; version: number }>(
    `INSERT INTO buyer (name, created_by, updated_by) VALUES ($1,$2,$2) RETURNING id, version`,
    [name, userId])
  createdBuyerIds.push(rows[0].id)
  return rows[0]
}

async function makeInvoice(
  buyerId: string, invoiceNo: string, opts: { taxSgd?: number; unitPriceSgd?: number } = {},
): Promise<{ invoiceId: string; version: number }> {
  const res = await createInvoice(fin(), {
    invoiceNo, buyerId, taxSgd: opts.taxSgd,
    lines: [{ description: 'Widget', quantity: 1, unitPriceSgd: opts.unitPriceSgd ?? 10 }],
  })
  createdInvoiceIds.push(res.invoiceId)
  const { rows } = await db.query<{ version: number }>(
    `SELECT version FROM sales_invoice WHERE id = $1`, [res.invoiceId])
  return { invoiceId: res.invoiceId, version: rows[0].version }
}

// ── Threshold-approval fixtures ─────────────────────────────────────────────

/**
 * A DIFFERENT app_user from `fin()`, because the pure domain refuses a decider who
 * is the requester — an approver sharing the bootstrap id could never approve
 * anything this file requests, and every gated test would pass for the wrong reason.
 */
let approverId: string
const approver = (): Actor => ({
  id: approverId, roleKey: 'manager',
  permissions: new Set(['view_records', 'view_finance', 'approve_requests']),
  moduleAccess: new Set(['finance']), active: true,
})

/** Every approval this file's SERVICE calls create, so afterAll can find them. */
const createdApprovalIds: string[] = []
const track = <T extends { approvalId: string }>(r: T): T => {
  createdApprovalIds.push(r.approvalId)
  return r
}

const approvalRow = async (id: string) => (await db.query<{
  status: string; snapshot: Record<string, unknown>; module: string; kind: string
  entity_type: string; entity_id: string
}>(`SELECT * FROM approval WHERE id = $1`, [id])).rows[0]

/** Runs `body` with the threshold temporarily set to `value`, then puts it back. */
async function withThreshold<T>(value: string | null, body: () => Promise<T>): Promise<T> {
  const { rows } = await db.query<{ value: string }>(
    `SELECT value::text AS value FROM app_setting WHERE key = $1`,
    [FINANCE_APPROVAL_THRESHOLD_SGD])
  const original = rows[0]?.value ?? null
  try {
    if (value === null) {
      await db.query(`DELETE FROM app_setting WHERE key = $1`, [FINANCE_APPROVAL_THRESHOLD_SGD])
    } else {
      await db.query(
        `INSERT INTO app_setting (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = app_setting.version + 1`,
        [FINANCE_APPROVAL_THRESHOLD_SGD, value])
    }
    return await body()
  } finally {
    if (original === null) {
      await db.query(`DELETE FROM app_setting WHERE key = $1`, [FINANCE_APPROVAL_THRESHOLD_SGD])
    } else {
      await db.query(
        `INSERT INTO app_setting (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [FINANCE_APPROVAL_THRESHOLD_SGD, original])
    }
  }
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
  approverId = (await db.query<{ id: string }>(
    `INSERT INTO app_user (email, full_name, role_id, department, module_access, active)
     SELECT 'finance-approver@test.local', 'Ava Approver', r.id, 'Finance',
            ARRAY['finance']::text[], true
       FROM role r WHERE r.key = 'manager'
     ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`)).rows[0].id
})
afterAll(async () => {
  if (createdApprovalIds.length) {
    const { rows: outboxIds } = await db.query<{ id: string }>(
      `SELECT id FROM outbox WHERE aggregate_id = ANY($1)`, [createdApprovalIds])
    await db.query(`DELETE FROM outbox WHERE aggregate_id = ANY($1)`, [createdApprovalIds])
    await db.query(`DELETE FROM audit_log WHERE table_name='outbox' AND row_id = ANY($1)`,
      [outboxIds.map((r) => r.id)])
    await db.query(`DELETE FROM approval WHERE id = ANY($1)`, [createdApprovalIds])
    await db.query(`DELETE FROM audit_log WHERE table_name='approval' AND row_id = ANY($1)`,
      [createdApprovalIds])
  }
  if (createdInvoiceIds.length) {
    await db.query(`DELETE FROM sales_invoice_line WHERE invoice_id = ANY($1)`, [createdInvoiceIds])
    await db.query(`DELETE FROM sales_invoice WHERE id = ANY($1)`, [createdInvoiceIds])
  }
  if (createdBuyerIds.length) {
    await db.query(`DELETE FROM buyer WHERE id = ANY($1)`, [createdBuyerIds])
  }
  await db.end()
  await getPool().end()
})

describe('buyerService', () => {
  describe('createBuyer', () => {
    it('refuses an actor without manage_finance (view_finance alone is not enough)', async () => {
      await expect(createBuyer(mgrView(), { name: `X ${runTag}` })).rejects.toThrow(PermissionError)
    })

    it('refuses an actor without Finance module access', async () => {
      await expect(createBuyer(noModuleAccess(), { name: `X ${runTag}` })).rejects.toThrow(PermissionError)
    })

    it('creates a buyer', async () => {
      const res = await createBuyer(fin(), { name: `ACME ${runTag}`, country: 'Singapore', contactEmail: 'a@acme.test' })
      createdBuyerIds.push(res.buyerId)
      const row = await db.query(
        `SELECT name, country, contact_email, created_by, version FROM buyer WHERE id = $1`, [res.buyerId])
      expect(row.rows[0]).toMatchObject({
        name: `ACME ${runTag}`, country: 'Singapore', contact_email: 'a@acme.test',
        created_by: userId, version: 1,
      })
    })
  })

  describe('getBuyer', () => {
    it('returns null for an unknown id (404, not a thrown error)', async () => {
      expect(await getBuyer(fin(), '00000000-0000-0000-0000-000000000000')).toBeNull()
    })

    it('returns the buyer detail for a known id', async () => {
      const b = await makeBuyer()
      const detail = await getBuyer(fin(), b.id)
      expect(detail?.id).toBe(b.id)
      expect(detail?.version).toBe(1)
    })

    it('refuses a Viewer (never holds view_finance, spec §3.2)', async () => {
      const b = await makeBuyer()
      await expect(getBuyer(viewer(), b.id)).rejects.toThrow(PermissionError)
    })
  })

  describe('listBuyers', () => {
    it('search by name (q) filters results', async () => {
      const uniqueName = `Zephyr-${runTag}`
      await makeBuyer(uniqueName)
      const { items } = await listBuyers(fin(), { q: uniqueName, limit: 10 })
      expect(items.map((i) => i.name)).toContain(uniqueName)
    })
  })

  describe('updateBuyer', () => {
    it('edits fields under optimistic concurrency, bumps version', async () => {
      const b = await makeBuyer()
      const res = await updateBuyer(fin(), { buyerId: b.id, version: b.version, name: 'Renamed Buyer' })
      expect(res.version).toBe(b.version + 1)
      const row = await db.query(`SELECT name, updated_by FROM buyer WHERE id = $1`, [b.id])
      expect(row.rows[0]).toMatchObject({ name: 'Renamed Buyer', updated_by: userId })
    })

    it('rejects a stale version with OptimisticLockError', async () => {
      const b = await makeBuyer()
      await expect(updateBuyer(fin(), { buyerId: b.id, version: b.version + 99, name: 'x' }))
        .rejects.toThrow(OptimisticLockError)
    })

    it('throws BuyerNotFoundError for an unknown id', async () => {
      await expect(updateBuyer(fin(), {
        buyerId: '00000000-0000-0000-0000-000000000000', version: 1, name: 'x',
      })).rejects.toThrow(BuyerNotFoundError)
    })
  })
})

describe('invoiceService', () => {
  describe('createInvoice', () => {
    it('refuses an actor without manage_finance', async () => {
      const b = await makeBuyer()
      await expect(createInvoice(mgrView(), {
        invoiceNo: `INV-${runTag}-DENY`, buyerId: b.id,
        lines: [{ description: 'Widget', quantity: 1, unitPriceSgd: 10 }],
      })).rejects.toThrow(PermissionError)
    })

    it('creates an invoice + lines in ONE transaction, computing amount_sgd and totals server-side', async () => {
      const b = await makeBuyer()
      const res = await createInvoice(fin(), {
        invoiceNo: `INV-${runTag}-1`, buyerId: b.id, taxSgd: 7,
        lines: [
          { description: 'Widget', quantity: 2, unitPriceSgd: 50 },
          { description: 'Gadget', quantity: 1, unitPriceSgd: 30 },
        ],
      })
      createdInvoiceIds.push(res.invoiceId)

      const inv = await db.query(
        `SELECT status, currency, subtotal_sgd, tax_sgd, total_sgd FROM sales_invoice WHERE id = $1`,
        [res.invoiceId])
      expect(inv.rows[0]).toMatchObject({
        status: 'draft', currency: 'SGD', subtotal_sgd: '130.00', tax_sgd: '7.00', total_sgd: '137.00',
      })

      const lines = await db.query(
        `SELECT line_no, description, quantity, unit_price_sgd, amount_sgd
           FROM sales_invoice_line WHERE invoice_id = $1 ORDER BY line_no`, [res.invoiceId])
      expect(lines.rows).toEqual([
        { line_no: 1, description: 'Widget', quantity: '2.00', unit_price_sgd: '50.00', amount_sgd: '100.00' },
        { line_no: 2, description: 'Gadget', quantity: '1.00', unit_price_sgd: '30.00', amount_sgd: '30.00' },
      ])
    })

    it('rejects a duplicate invoice_no with DuplicateInvoiceNoError', async () => {
      const b = await makeBuyer()
      const no = `INV-DUP-${runTag}`
      await makeInvoice(b.id, no)
      await expect(createInvoice(fin(), {
        invoiceNo: no, buyerId: b.id, lines: [{ description: 'X', quantity: 1, unitPriceSgd: 1 }],
      })).rejects.toThrow(DuplicateInvoiceNoError)
    })

    it('throws BuyerNotFoundError for an unknown buyer', async () => {
      await expect(createInvoice(fin(), {
        invoiceNo: `INV-${runTag}-NOBUYER`, buyerId: '00000000-0000-0000-0000-000000000000',
        lines: [{ description: 'X', quantity: 1, unitPriceSgd: 1 }],
      })).rejects.toThrow(BuyerNotFoundError)
    })
  })

  describe('getInvoice', () => {
    it('returns null for an unknown id', async () => {
      expect(await getInvoice(fin(), '00000000-0000-0000-0000-000000000000')).toBeNull()
    })

    it('returns the invoice with its lines and buyer name', async () => {
      const b = await makeBuyer()
      const { invoiceId } = await makeInvoice(b.id, `INV-${runTag}-GET`)
      const detail = await getInvoice(fin(), invoiceId)
      expect(detail?.buyerId).toBe(b.id)
      expect(detail?.lines).toHaveLength(1)
      expect(detail?.lines[0]).toMatchObject({
        description: 'Widget', quantity: '1.00', unitPriceSgd: '10.00', amountSgd: '10.00', deviceId: null,
      })
    })
  })

  describe('updateInvoice', () => {
    it('edits header fields under optimistic concurrency, leaves status untouched', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(b.id, `INV-${runTag}-UPD`)
      const res = await updateInvoice(fin(), { invoiceId, version, notes: 'updated note' })
      expect(res.version).toBe(version + 1)
      const row = await db.query(`SELECT notes, status FROM sales_invoice WHERE id = $1`, [invoiceId])
      expect(row.rows[0]).toMatchObject({ notes: 'updated note', status: 'draft' })
    })

    it('recomputes total_sgd when tax_sgd changes', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(b.id, `INV-${runTag}-TAX`)
      await updateInvoice(fin(), { invoiceId, version, taxSgd: 8 })
      const row = await db.query(
        `SELECT subtotal_sgd, tax_sgd, total_sgd FROM sales_invoice WHERE id = $1`, [invoiceId])
      expect(row.rows[0]).toMatchObject({ subtotal_sgd: '10.00', tax_sgd: '8.00', total_sgd: '18.00' })
    })

    it('rejects renaming to an existing invoice_no (DuplicateInvoiceNoError)', async () => {
      const b = await makeBuyer()
      const taken = `INV-${runTag}-TAKEN`
      await makeInvoice(b.id, taken)
      const { invoiceId, version } = await makeInvoice(b.id, `INV-${runTag}-RENAME`)
      await expect(updateInvoice(fin(), { invoiceId, version, invoiceNo: taken }))
        .rejects.toThrow(DuplicateInvoiceNoError)
    })

    it('does NOT expose a status field (status is change-only)', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(b.id, `INV-${runTag}-NOSTAT`)
      // @ts-expect-error status is intentionally not part of UpdateInvoiceInput
      await updateInvoice(fin(), { invoiceId, version, status: 'paid' })
      const row = await db.query(`SELECT status FROM sales_invoice WHERE id = $1`, [invoiceId])
      expect(row.rows[0].status).toBe('draft') // ignored
    })

    it('rejects a stale version', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(b.id, `INV-${runTag}-STALE`)
      await expect(updateInvoice(fin(), { invoiceId, version: version + 99, notes: 'x' }))
        .rejects.toThrow(OptimisticLockError)
    })

    it('throws InvoiceNotFoundError for an unknown id', async () => {
      await expect(updateInvoice(fin(), {
        invoiceId: '00000000-0000-0000-0000-000000000000', version: 1, notes: 'x',
      })).rejects.toThrow(InvoiceNotFoundError)
    })
  })

  describe('changeInvoiceStatus', () => {
    it('refuses a Viewer (no manage_finance)', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(b.id, `INV-${runTag}-VWDENY`)
      await expect(changeInvoiceStatus(viewer(), { invoiceId, toStatus: 'issued', version }))
        .rejects.toThrow(PermissionError)
    })

    it('moves draft -> issued, bumps version', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(b.id, `INV-${runTag}-ISSUE`)
      const res = await changeInvoiceStatus(fin(), { invoiceId, toStatus: 'issued', version })
      expect(res.status).toBe('issued')
      expect(res.version).toBe(version + 1)
      const row = await db.query(`SELECT status FROM sales_invoice WHERE id = $1`, [invoiceId])
      expect(row.rows[0].status).toBe('issued')
    })

    it('rejects draft -> paid (fail-closed: must issue first)', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(b.id, `INV-${runTag}-BADMOVE`)
      await expect(changeInvoiceStatus(fin(), { invoiceId, toStatus: 'paid', version }))
        .rejects.toThrow(InvalidInvoiceStatusChangeError)
      const row = await db.query(`SELECT status FROM sales_invoice WHERE id = $1`, [invoiceId])
      expect(row.rows[0].status).toBe('draft') // rolled back
    })

    it('rejects a move out of a terminal status (paid -> void)', async () => {
      const b = await makeBuyer()
      const seed = await makeInvoice(b.id, `INV-${runTag}-TERM`)
      const issued = await changeInvoiceStatus(fin(), { invoiceId: seed.invoiceId, toStatus: 'issued', version: seed.version })
      const paid = await changeInvoiceStatus(fin(), { invoiceId: seed.invoiceId, toStatus: 'paid', version: issued.version })
      await expect(changeInvoiceStatus(fin(), { invoiceId: seed.invoiceId, toStatus: 'void', version: paid.version }))
        .rejects.toThrow(InvalidInvoiceStatusChangeError)
    })

    it('rejects a stale version with OptimisticLockError', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(b.id, `INV-${runTag}-OPTLOCK`)
      await expect(changeInvoiceStatus(fin(), { invoiceId, toStatus: 'issued', version: version + 99 }))
        .rejects.toThrow(OptimisticLockError)
    })

    it('throws InvoiceNotFoundError for an unknown id', async () => {
      await expect(changeInvoiceStatus(fin(), {
        invoiceId: '00000000-0000-0000-0000-000000000000', toStatus: 'issued', version: 1,
      })).rejects.toThrow(InvoiceNotFoundError)
    })
  })

  describe('listAllowedInvoiceTransitions', () => {
    it('returns the two edges out of draft', async () => {
      expect(await listAllowedInvoiceTransitions(fin(), 'draft')).toEqual(['issued', 'void'])
    })
    it('returns [] for a terminal status', async () => {
      expect(await listAllowedInvoiceTransitions(fin(), 'paid')).toEqual([])
    })
  })

  describe('listInvoices', () => {
    it('filters by status and buyer', async () => {
      const b = await makeBuyer()
      const { invoiceId } = await makeInvoice(b.id, `INV-${runTag}-FILT`)
      const { items } = await listInvoices(fin(), { status: ['draft'], buyerId: b.id, limit: 10 })
      expect(items.map((i) => i.id)).toContain(invoiceId)
      const { items: paidOnly } = await listInvoices(fin(), { status: ['paid'], buyerId: b.id, limit: 10 })
      expect(paidOnly.map((i) => i.id)).not.toContain(invoiceId)
    })
  })

  describe('getInvoiceStatusCounts', () => {
    it('returns all four statuses in a fixed order, zero-filled where empty', async () => {
      const counts = await getInvoiceStatusCounts(fin())
      expect(counts.map((c) => c.status)).toEqual(['draft', 'issued', 'paid', 'void'])
      for (const c of counts) expect(c.count).toBeGreaterThanOrEqual(0)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// The Finance threshold gate (spec BR-4) — the approvals engine's first real
// consumer. Every test here goes through the SERVICE; the raw client is used only
// to set the admin knob, to read back what was stored, and to prove a refusal
// wrote nothing.
// ═══════════════════════════════════════════════════════════════════════════
describe('invoice threshold approval', () => {
  describe('the threshold comes from app_setting, never from a constant', () => {
    it('gates a SMALL invoice once an admin lowers the threshold beneath it', async () => {
      const b = await makeBuyer()
      // S$10.00 — an order of magnitude below the seeded 5000.
      const { invoiceId, version } = await makeInvoice(b.id, `INV-${runTag}-KNOBDOWN`)
      await withThreshold('5', async () => {
        await expect(changeInvoiceStatus(fin(), { invoiceId, toStatus: 'issued', version }))
          .rejects.toThrow(InvoiceApprovalError)
      })
      const row = await db.query(`SELECT status FROM sales_invoice WHERE id=$1`, [invoiceId])
      expect(row.rows[0].status).toBe('draft')
    })

    it('frees a LARGE invoice once an admin raises the threshold above it', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-KNOBUP`, { unitPriceSgd: 12000 })
      await withThreshold('999999', async () => {
        const res = await changeInvoiceStatus(fin(), { invoiceId, toStatus: 'issued', version })
        expect(res.status).toBe('issued')
      })
    })

    it('refuses to issue at all when the knob is missing — fail closed, and loudly', async () => {
      // A control that silently switches itself off when its setting is deleted is
      // worse than no control: nothing in the UI would ever say so.
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(b.id, `INV-${runTag}-NOKNOB`)
      await withThreshold(null, async () => {
        await expect(changeInvoiceStatus(fin(), { invoiceId, toStatus: 'issued', version }))
          .rejects.toThrow(SettingUnavailableError)
      })
      const row = await db.query(`SELECT status FROM sales_invoice WHERE id=$1`, [invoiceId])
      expect(row.rows[0].status).toBe('draft')
    })

    it('refuses to issue when the knob holds something that is not a number', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(b.id, `INV-${runTag}-BADKNOB`)
      await withThreshold('"lots"', async () => {
        await expect(changeInvoiceStatus(fin(), { invoiceId, toStatus: 'issued', version }))
          .rejects.toThrow(SettingUnavailableError)
      })
    })
  })

  describe('below the threshold, nothing changes', () => {
    it('issues without an approval and without creating one', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(b.id, `INV-${runTag}-BELOW`)
      const res = await changeInvoiceStatus(fin(), { invoiceId, toStatus: 'issued', version })
      expect(res.status).toBe('issued')
      const { rows } = await db.query(`SELECT id FROM approval WHERE entity_id = $1`, [invoiceId])
      expect(rows).toEqual([])
    })

    it('refuses a pointless approval request rather than queueing a decision that changes nothing',
      async () => {
        const b = await makeBuyer()
        const { invoiceId, version } = await makeInvoice(b.id, `INV-${runTag}-NOTNEEDED`)
        await expect(requestInvoiceApproval(fin(), { invoiceId, version }))
          .rejects.toMatchObject({ name: 'InvoiceApprovalError', code: 'below_threshold' })
      })
  })

  describe('at or above the threshold', () => {
    it('refuses draft → issued when no approval was ever requested', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-NOAPV`, { unitPriceSgd: 12000 })
      await expect(changeInvoiceStatus(fin(), { invoiceId, toStatus: 'issued', version }))
        .rejects.toMatchObject({ name: 'InvoiceApprovalError', code: 'approval_missing' })
      const row = await db.query(`SELECT status, version FROM sales_invoice WHERE id=$1`, [invoiceId])
      expect(row.rows[0]).toMatchObject({ status: 'draft', version })
    })

    it('gates an invoice sitting EXACTLY on the threshold ("at or above")', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-EXACT`, { unitPriceSgd: 5000 })
      await expect(changeInvoiceStatus(fin(), { invoiceId, toStatus: 'issued', version }))
        .rejects.toMatchObject({ code: 'approval_missing' })
    })

    it('leaves draft → void alone: the gate is on issuing, not on abandoning', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-VOID`, { unitPriceSgd: 12000 })
      const res = await changeInvoiceStatus(fin(), { invoiceId, toStatus: 'void', version })
      expect(res.status).toBe('void')
    })
  })

  describe('requestInvoiceApproval', () => {
    it('records a snapshot of the total, the currency and the buyer — not just the id', async () => {
      const b = await makeBuyer('Snapshot Buyer ' + runTag)
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-SNAP`, { unitPriceSgd: 12000 })
      const { approvalId } = track(await requestInvoiceApproval(fin(), { invoiceId, version }))

      const row = await approvalRow(approvalId)
      expect(row).toMatchObject({
        status: 'pending', module: 'finance', kind: 'invoice',
        entity_type: 'sales_invoice', entity_id: invoiceId,
      })
      expect(row.snapshot).toEqual({
        invoiceNo: `INV-${runTag}-SNAP`,
        buyerId: b.id,
        buyerName: 'Snapshot Buyer ' + runTag,
        currency: 'SGD',
        totalSgd: '12000.00',
      })
    })

    it('stores the total as the DRIVER returned it, and it still agrees on re-read', async () => {
      // The trap this pins: numeric(12,2) comes back from node-postgres as a STRING,
      // and snapshotsAgree compares two STRINGS as text — never numerically. So a
      // snapshot holding "12000" would NOT agree with a re-read "12000.00". Both
      // sides must come from the same column read the same way.
      const b = await makeBuyer()
      // A total whose text form does NOT survive a trip through Number(): 12345.60
      // becomes "12345.6", which snapshotsAgree would compare as text and refuse.
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-ROUNDTRIP`, { unitPriceSgd: 12000, taxSgd: 345.6 })
      const { approvalId } = track(await requestInvoiceApproval(fin(), { invoiceId, version }))

      const stored = (await approvalRow(approvalId)).snapshot
      expect(typeof stored.totalSgd).toBe('string')
      expect(stored.totalSgd).toBe('12345.60')

      const { rows } = await db.query<{
        total_sgd: string; invoice_no: string; currency: string; buyer_name: string
      }>(
        `SELECT i.total_sgd, i.invoice_no, i.currency, b.name AS buyer_name
           FROM sales_invoice i JOIN buyer b ON b.id = i.buyer_id WHERE i.id=$1`, [invoiceId])
      const rebuilt = buildInvoiceApprovalSnapshot({
        invoiceNo: rows[0].invoice_no, buyerId: b.id, buyerName: rows[0].buyer_name,
        currency: rows[0].currency, totalSgd: rows[0].total_sgd,
      })
      expect(rebuilt.totalSgd).toBe('12345.60')
      expect(snapshotsAgree(stored, rebuilt)).toBe(true)
    })

    it('writes the approval and its outbox event in ONE transaction', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-OUTBOX`, { unitPriceSgd: 12000 })
      const { approvalId } = track(await requestInvoiceApproval(fin(), { invoiceId, version }))
      const { rows } = await db.query<{ event_type: string; payload: Record<string, unknown> }>(
        `SELECT event_type, payload FROM outbox WHERE aggregate_id = $1`, [approvalId])
      expect(rows).toHaveLength(1)
      expect(rows[0].event_type).toBe('approval_requested')
      expect(rows[0].payload).toMatchObject({
        kind: 'invoice', module: 'finance', entityType: 'sales_invoice',
        entityId: invoiceId, label: `INV-${runTag}-OUTBOX`,
      })
    })

    it('refuses an actor without manage_finance', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-APVDENY`, { unitPriceSgd: 12000 })
      await expect(requestInvoiceApproval(mgrView(), { invoiceId, version }))
        .rejects.toThrow(PermissionError)
    })

    it('refuses a stale version — the requester attests to numbers they were shown', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-APVSTALE`, { unitPriceSgd: 12000 })
      await expect(requestInvoiceApproval(fin(), { invoiceId, version: version + 99 }))
        .rejects.toThrow(OptimisticLockError)
    })

    it('refuses an invoice that has already left draft', async () => {
      const b = await makeBuyer()
      const seed = await makeInvoice(b.id, `INV-${runTag}-APVISSUED`)
      const issued = await changeInvoiceStatus(fin(), {
        invoiceId: seed.invoiceId, toStatus: 'issued', version: seed.version })
      await expect(requestInvoiceApproval(fin(), {
        invoiceId: seed.invoiceId, version: issued.version,
      })).rejects.toMatchObject({ name: 'InvoiceApprovalError', code: 'not_draft' })
    })

    it('refuses an unknown invoice', async () => {
      await expect(requestInvoiceApproval(fin(), {
        invoiceId: '00000000-0000-0000-0000-000000000000', version: 1,
      })).rejects.toThrow(InvoiceNotFoundError)
    })

    it('refuses a second request while one is still pending', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-DOUBLE`, { unitPriceSgd: 12000 })
      track(await requestInvoiceApproval(fin(), { invoiceId, version }))
      await expect(requestInvoiceApproval(fin(), { invoiceId, version }))
        .rejects.toThrow(ApprovalAlreadyPendingError)
    })

    it('authorizes and validates before it ever acquires a connection', async () => {
      const previous = process.env.DATABASE_URL
      vi.resetModules()
      process.env.DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:1/unreachable'
      try {
        const svc = await import('@/modules/finance/services/invoiceService')
        const authz = await import('@/modules/shared/authz/authorize')
        await expect(svc.requestInvoiceApproval(viewer(), {
          invoiceId: '00000000-0000-0000-0000-000000000000', version: 1,
        })).rejects.toThrow(authz.PermissionError)
        await expect(svc.requestInvoiceApproval(fin(), {
          invoiceId: 'not-a-uuid', version: 1,
        })).rejects.toThrow(/uuid/i)
      } finally {
        process.env.DATABASE_URL = previous
        vi.resetModules()
      }
    })
  })

  describe('issuing against a decision', () => {
    it('refuses while the request is still pending', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-PENDING`, { unitPriceSgd: 12000 })
      track(await requestInvoiceApproval(fin(), { invoiceId, version }))
      await expect(changeInvoiceStatus(fin(), { invoiceId, toStatus: 'issued', version }))
        .rejects.toMatchObject({ code: 'approval_pending' })
    })

    it('issues once an APPROVED, unchanged invoice is decided', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-OK`, { unitPriceSgd: 12000 })
      const { approvalId } = track(await requestInvoiceApproval(fin(), { invoiceId, version }))
      await decideApproval(approver(), { approvalId, decision: 'approved' })

      const res = await changeInvoiceStatus(fin(), { invoiceId, toStatus: 'issued', version })
      expect(res.status).toBe('issued')
    })

    it('refuses on a rejection, repeating the note the approver left', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-REJECT`, { unitPriceSgd: 12000 })
      const { approvalId } = track(await requestInvoiceApproval(fin(), { invoiceId, version }))
      await decideApproval(approver(), {
        approvalId, decision: 'rejected', note: 'The 20% discount was never agreed.' })

      await expect(changeInvoiceStatus(fin(), { invoiceId, toStatus: 'issued', version }))
        .rejects.toThrow(/never agreed/)
    })

    // THE test the whole engine exists for.
    it('refuses an invoice EDITED after approval, and the refusal names the total', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-DRIFT`, { unitPriceSgd: 12000 })
      const { approvalId } = track(await requestInvoiceApproval(fin(), { invoiceId, version }))
      await decideApproval(approver(), { approvalId, decision: 'approved' })

      // Tax is the one lever that moves total_sgd in this build (there is no
      // line-edit path), and updateInvoice recomputes the total from it.
      const { version: bumped } = await updateInvoice(fin(), {
        invoiceId, version, taxSgd: 6500 })
      const after = await db.query<{ total_sgd: string }>(
        `SELECT total_sgd FROM sales_invoice WHERE id=$1`, [invoiceId])
      expect(after.rows[0].total_sgd).toBe('18500.00')

      const err = await changeInvoiceStatus(fin(), {
        invoiceId, toStatus: 'issued', version: bumped }).catch((e) => e)
      expect(err).toBeInstanceOf(InvoiceApprovalError)
      expect(err.code).toBe('approval_drifted')
      expect(err.message).toContain('totalSgd')
      expect(err.message).toContain('12000.00')
      expect(err.message).toContain('18500.00')

      const row = await db.query(`SELECT status FROM sales_invoice WHERE id=$1`, [invoiceId])
      expect(row.rows[0].status).toBe('draft')
    })

    it('refuses when the BUYER was swapped after approval', async () => {
      const b = await makeBuyer('Original Buyer ' + runTag)
      const other = await makeBuyer('Replacement Buyer ' + runTag)
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-BUYERDRIFT`, { unitPriceSgd: 12000 })
      const { approvalId } = track(await requestInvoiceApproval(fin(), { invoiceId, version }))
      await decideApproval(approver(), { approvalId, decision: 'approved' })

      const { version: bumped } = await updateInvoice(fin(), {
        invoiceId, version, buyerId: other.id })
      const err = await changeInvoiceStatus(fin(), {
        invoiceId, toStatus: 'issued', version: bumped }).catch((e) => e)
      expect(err.code).toBe('approval_drifted')
      expect(err.message).toContain('buyerId')
    })

    it('issues once the drift is PUT BACK — the check is on the state, not on the edit', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-RESTORED`, { unitPriceSgd: 12000, taxSgd: 100 })
      const { approvalId } = track(await requestInvoiceApproval(fin(), { invoiceId, version }))
      await decideApproval(approver(), { approvalId, decision: 'approved' })

      const v2 = (await updateInvoice(fin(), { invoiceId, version, taxSgd: 900 })).version
      await expect(changeInvoiceStatus(fin(), { invoiceId, toStatus: 'issued', version: v2 }))
        .rejects.toMatchObject({ code: 'approval_drifted' })

      const v3 = (await updateInvoice(fin(), { invoiceId, version: v2, taxSgd: 100 })).version
      const res = await changeInvoiceStatus(fin(), { invoiceId, toStatus: 'issued', version: v3 })
      expect(res.status).toBe('issued')
    })

    it('does not re-gate issued → paid', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-PAID`, { unitPriceSgd: 12000 })
      const { approvalId } = track(await requestInvoiceApproval(fin(), { invoiceId, version }))
      await decideApproval(approver(), { approvalId, decision: 'approved' })
      const issued = await changeInvoiceStatus(fin(), { invoiceId, toStatus: 'issued', version })
      const paid = await changeInvoiceStatus(fin(), {
        invoiceId, toStatus: 'paid', version: issued.version })
      expect(paid.status).toBe('paid')
    })
  })

  describe('getInvoiceApprovalState', () => {
    it('reports the live threshold and that a small invoice needs nothing', async () => {
      const b = await makeBuyer()
      const { invoiceId } = await makeInvoice(b.id, `INV-${runTag}-STATE1`)
      const state = await getInvoiceApprovalState(fin(), invoiceId)
      expect(state).toMatchObject({ thresholdSgd: '5000', requiresApproval: false, approval: null })
      expect(state!.drift).toEqual([])
    })

    it('surfaces the pending request and its requester', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-STATE2`, { unitPriceSgd: 12000 })
      track(await requestInvoiceApproval(fin(), { invoiceId, version }))
      const state = await getInvoiceApprovalState(fin(), invoiceId)
      expect(state!.requiresApproval).toBe(true)
      expect(state!.approval).toMatchObject({ status: 'pending', kind: 'invoice' })
      expect(state!.drift).toEqual([])
    })

    it('warns about drift BEFORE the user clicks Issue', async () => {
      const b = await makeBuyer()
      const { invoiceId, version } = await makeInvoice(
        b.id, `INV-${runTag}-STATE3`, { unitPriceSgd: 12000 })
      const { approvalId } = track(await requestInvoiceApproval(fin(), { invoiceId, version }))
      await decideApproval(approver(), { approvalId, decision: 'approved' })
      await updateInvoice(fin(), { invoiceId, version, taxSgd: 42 })

      const state = await getInvoiceApprovalState(fin(), invoiceId)
      expect(state!.approval!.status).toBe('approved')
      expect(state!.drift.join(' ')).toContain('totalSgd')
    })

    it('returns null for an unknown invoice, and refuses a Viewer', async () => {
      expect(await getInvoiceApprovalState(fin(), '00000000-0000-0000-0000-000000000000'))
        .toBeNull()
      await expect(getInvoiceApprovalState(viewer(), '00000000-0000-0000-0000-000000000000'))
        .rejects.toThrow(PermissionError)
    })
  })
})
