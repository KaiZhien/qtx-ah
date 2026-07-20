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
  InvoiceNotFoundError, DuplicateInvoiceNoError,
} from '@/modules/finance/services/invoiceService'
import { InvalidInvoiceStatusChangeError } from '@/modules/finance/domain/invoiceStatus'
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
  buyerId: string, invoiceNo: string, opts: { taxSgd?: number } = {},
): Promise<{ invoiceId: string; version: number }> {
  const res = await createInvoice(fin(), {
    invoiceNo, buyerId, taxSgd: opts.taxSgd,
    lines: [{ description: 'Widget', quantity: 1, unitPriceSgd: 10 }],
  })
  createdInvoiceIds.push(res.invoiceId)
  const { rows } = await db.query<{ version: number }>(
    `SELECT version FROM sales_invoice WHERE id = $1`, [res.invoiceId])
  return { invoiceId: res.invoiceId, version: rows[0].version }
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
})
afterAll(async () => {
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
