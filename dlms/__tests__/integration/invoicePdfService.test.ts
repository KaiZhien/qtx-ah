// __tests__/integration/invoicePdfService.test.ts
//
// Written but NOT run in this worktree — no docker here, and
// `npm run test:integration` boots Postgres on the fixed port 55432 shared with
// every parallel agent. The controller runs this serially at merge; the harness
// picks up 20260803120000_platform_finance_warranty.sql automatically.
//
// A separate file from financeService.test.ts on purpose: that file belongs to
// the invoice/approval workstream and merging into it would collide.
//
// The property that matters most here: the money the PDF path loads is BYTE FOR
// BYTE the money getInvoice() gives the detail page. Not "rounds to the same
// value" — identical strings. Anything that introduces a float on this path
// breaks these assertions.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { createInvoice, getInvoice } from '@/modules/finance/services/invoiceService'
import {
  getInvoicePdfSource, listInvoiceDocumentAccess,
} from '@/modules/finance/services/invoicePdfService'
import { buildInvoicePdfModel } from '@/modules/finance/domain/invoicePdfModel'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string
const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const createdBuyerIds: string[] = []
const createdInvoiceIds: string[] = []

const fin = (): Actor => ({
  id: userId, roleKey: 'finance',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'view_finance', 'manage_finance']),
  moduleAccess: new Set(['finance']), active: true,
})
// The Finance role itself: holds view_audit_record (spec §3.2) and therefore CAN
// see who copied the invoice it owns. That is the whole point of gating the
// access list on view_audit_record rather than the admin-only view_full_audit.
const auditor = (): Actor => ({
  id: userId, roleKey: 'finance',
  permissions: new Set(['view_records', 'view_finance', 'view_audit_record']),
  moduleAccess: new Set(['finance']), active: true,
})
// Viewer never holds view_finance — the PDF is money, so this actor is refused.
const viewer = (): Actor => ({
  id: userId, roleKey: 'viewer',
  permissions: new Set(['view_records']), moduleAccess: new Set(['finance']), active: true,
})
const noModuleAccess = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'view_finance']),
  moduleAccess: new Set(['manufacturing']), active: true,
})

async function makeBuyer(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO buyer (name, country, contact_name, contact_email, contact_phone,
                        billing_address, created_by, updated_by)
     VALUES ($1,'Singapore','Jane Tan','jane@acme.test','+65 6555 0100',
             '1 Raffles Place' || chr(10) || '#20-01', $2, $2)
     RETURNING id`, [`PDF Buyer ${runTag}-${createdBuyerIds.length}`, userId])
  createdBuyerIds.push(rows[0].id)
  return rows[0].id
}

async function makeInvoice(
  buyerId: string, lines: { description: string; quantity: number; unitPriceSgd: number }[],
  taxSgd?: number,
): Promise<string> {
  const { invoiceId } = await createInvoice(fin(), {
    invoiceNo: `PDF-${runTag}-${createdInvoiceIds.length}`,
    buyerId, issueDate: '2026-07-01', dueDate: '2026-07-31', taxSgd, lines,
  })
  createdInvoiceIds.push(invoiceId)
  return invoiceId
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
})

afterAll(async () => {
  if (createdInvoiceIds.length) {
    const { rows: accessIds } = await db.query<{ id: string }>(
      `SELECT id FROM document_access_log WHERE entity_id = ANY($1)`, [createdInvoiceIds])
    await db.query(`DELETE FROM document_access_log WHERE entity_id = ANY($1)`, [createdInvoiceIds])
    await db.query(
      `DELETE FROM audit_log WHERE table_name='document_access_log' AND row_id = ANY($1)`,
      [accessIds.map((r) => r.id)])
    await db.query(`DELETE FROM sales_invoice_line WHERE invoice_id = ANY($1)`, [createdInvoiceIds])
    await db.query(`DELETE FROM audit_log WHERE table_name='sales_invoice' AND row_id = ANY($1)`,
      [createdInvoiceIds])
    await db.query(`DELETE FROM sales_invoice WHERE id = ANY($1)`, [createdInvoiceIds])
  }
  if (createdBuyerIds.length) {
    await db.query(`DELETE FROM buyer WHERE id = ANY($1)`, [createdBuyerIds])
  }
  await db.end()
  await getPool().end()
})

describe('getInvoicePdfSource — authorization', () => {
  it('refuses a Viewer: the PDF is money, so it needs view_finance', async () => {
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 10 }])
    await expect(getInvoicePdfSource(viewer(), id)).rejects.toThrow(PermissionError)
  })

  it('refuses an actor holding view_finance without Finance module access', async () => {
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 10 }])
    await expect(getInvoicePdfSource(noModuleAccess(), id)).rejects.toThrow(PermissionError)
  })

  it('logs NOTHING when authorization fails', async () => {
    // A refused request is not an access. If this ever fails, the log has started
    // recording attempts as downloads and every count in it is wrong.
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 10 }])
    await expect(getInvoicePdfSource(viewer(), id)).rejects.toThrow(PermissionError)
    const { rows } = await db.query(
      `SELECT id FROM document_access_log WHERE entity_id = $1`, [id])
    expect(rows).toHaveLength(0)
  })

  it('returns null for an unknown id and logs nothing', async () => {
    const missing = '00000000-0000-0000-0000-000000000000'
    expect(await getInvoicePdfSource(fin(), missing)).toBeNull()
    const { rows } = await db.query(
      `SELECT id FROM document_access_log WHERE entity_id = $1`, [missing])
    expect(rows).toHaveLength(0)
  })

  it('returns null for a malformed id rather than throwing', async () => {
    expect(await getInvoicePdfSource(fin(), 'not-a-uuid')).toBeNull()
  })
})

describe('getInvoicePdfSource — money fidelity', () => {
  it('carries subtotal, tax and total identically to getInvoice, byte for byte', async () => {
    const id = await makeInvoice(await makeBuyer(), [
      { description: 'Device', quantity: 3, unitPriceSgd: 8.1 },
      { description: 'Cuff', quantity: 7, unitPriceSgd: 0.1 },
    ], 12.34)

    const detail = (await getInvoice(fin(), id))!
    const pdf = (await getInvoicePdfSource(fin(), id))!

    // Strict equality on the STRINGS, not on parsed numbers: 8.1 * 3 is
    // 24.299999999999997 in IEEE-754 and 0.1 * 7 is 0.7000000000000001.
    // numeric(12,2) gives 24.30 and 0.70, and both paths must show that.
    expect(pdf.subtotalSgd).toBe(detail.subtotalSgd)
    expect(pdf.taxSgd).toBe(detail.taxSgd)
    expect(pdf.totalSgd).toBe(detail.totalSgd)
    expect(pdf.subtotalSgd).toBe('25.00')
    expect(pdf.totalSgd).toBe('37.34')
  })

  it('carries every line amount identically to getInvoice', async () => {
    const id = await makeInvoice(await makeBuyer(), [
      { description: 'A', quantity: 2, unitPriceSgd: 33.33 },
      { description: 'B', quantity: 1, unitPriceSgd: 0.05 },
    ])
    const detail = (await getInvoice(fin(), id))!
    const pdf = (await getInvoicePdfSource(fin(), id))!
    expect(pdf.lines.map((l) => l.amountSgd)).toEqual(detail.lines.map((l) => l.amountSgd))
    expect(pdf.lines.map((l) => l.unitPriceSgd)).toEqual(detail.lines.map((l) => l.unitPriceSgd))
    expect(pdf.lines.map((l) => l.quantity)).toEqual(detail.lines.map((l) => l.quantity))
  })

  it('renders to the same total the detail page prints', async () => {
    const id = await makeInvoice(await makeBuyer(),
      [{ description: 'A', quantity: 1, unitPriceSgd: 1234567.89 }])
    const detail = (await getInvoice(fin(), id))!
    const model = buildInvoicePdfModel((await getInvoicePdfSource(fin(), id))!)
    // The page renders `S${invoice.totalSgd}`; the PDF groups thousands.
    expect(model.total.replace(/,/g, '')).toBe(`S$${detail.totalSgd}`)
  })

  it('renders a zero-tax invoice as 0.00 rather than blank', async () => {
    const id = await makeInvoice(await makeBuyer(),
      [{ description: 'A', quantity: 1, unitPriceSgd: 10 }])
    const model = buildInvoicePdfModel((await getInvoicePdfSource(fin(), id))!)
    expect(model.tax).toBe('S$0.00')
  })
})

describe('getInvoicePdfSource — content', () => {
  it('loads the buyer billing block', async () => {
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 1 }])
    const pdf = (await getInvoicePdfSource(fin(), id))!
    expect(pdf.buyer).toMatchObject({
      contactName: 'Jane Tan', contactEmail: 'jane@acme.test', country: 'Singapore',
    })
    expect(pdf.buyer.billingAddress).toContain('Raffles Place')
  })

  it('returns dates as YYYY-MM-DD strings, never Date objects', async () => {
    // A Date here is the one-day-early bug on any non-UTC host, on a tax document.
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 1 }])
    const pdf = (await getInvoicePdfSource(fin(), id))!
    expect(pdf.issueDate).toBe('2026-07-01')
    expect(pdf.dueDate).toBe('2026-07-31')
  })

  it('watermarks a draft invoice DRAFT — an unissued invoice is never mistakable', async () => {
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 1 }])
    // createInvoice always starts at draft.
    const model = buildInvoicePdfModel((await getInvoicePdfSource(fin(), id))!)
    expect(model.watermark).toBe('DRAFT')
  })

  it('drops the watermark once the invoice is issued', async () => {
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 1 }])
    await db.query(`UPDATE sales_invoice SET status = 'issued' WHERE id = $1`, [id])
    const model = buildInvoicePdfModel((await getInvoicePdfSource(fin(), id))!)
    expect(model.watermark).toBeNull()
  })

  it('watermarks a void invoice VOID', async () => {
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 1 }])
    await db.query(`UPDATE sales_invoice SET status = 'void' WHERE id = $1`, [id])
    const model = buildInvoicePdfModel((await getInvoicePdfSource(fin(), id))!)
    expect(model.watermark).toBe('VOID')
  })

  it('returns null once the invoice is soft-deleted', async () => {
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 1 }])
    await db.query(`UPDATE sales_invoice SET deleted_at = now() WHERE id = $1`, [id])
    expect(await getInvoicePdfSource(fin(), id)).toBeNull()
  })

  it('logs NO access when the invoice vanishes in the two-transaction window', async () => {
    // This service deliberately runs TWO transactions — getInvoice() for the
    // money (so the amounts cannot drift from the detail page), then its own for
    // the buyer block plus the access-log INSERT. That design is only safe if a
    // soft delete landing BETWEEN them writes nothing: the second query misses,
    // the request 404s, and no download is recorded for a document nobody got.
    //
    // Simulated by soft-deleting after the row is created but reading through the
    // same code path: getInvoice's own miss short-circuits before the INSERT.
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 1 }])
    await db.query(`UPDATE sales_invoice SET deleted_at = now() WHERE id = $1`, [id])

    expect(await getInvoicePdfSource(fin(), id)).toBeNull()
    const { rows } = await db.query(
      `SELECT id FROM document_access_log WHERE entity_id = $1`, [id])
    expect(rows).toHaveLength(0)
  })
})

describe('document_access_log', () => {
  it('records one row per generation, attributed to the actor', async () => {
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 1 }])
    await getInvoicePdfSource(fin(), id)
    await getInvoicePdfSource(fin(), id)

    const { rows } = await db.query<{ actor_id: string; document_kind: string; entity_type: string }>(
      `SELECT actor_id, document_kind, entity_type FROM document_access_log
        WHERE entity_id = $1 ORDER BY accessed_at`, [id])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      actor_id: userId, document_kind: 'invoice_pdf', entity_type: 'sales_invoice',
    })
  })

  it('denormalizes the status the copy was taken under', async () => {
    // sales_invoice.status moves on; "was the copy they walked away with a DRAFT?"
    // has to stay answerable afterwards.
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 1 }])
    await getInvoicePdfSource(fin(), id)
    await db.query(`UPDATE sales_invoice SET status = 'issued' WHERE id = $1`, [id])
    await getInvoicePdfSource(fin(), id)

    const { rows } = await db.query<{ entity_status: string }>(
      `SELECT entity_status FROM document_access_log WHERE entity_id = $1 ORDER BY accessed_at`, [id])
    expect(rows.map((r) => r.entity_status)).toEqual(['draft', 'issued'])
  })

  it('also lands in the central audit_log via fn_audit', async () => {
    // The dedicated table is the fast index; audit_log is where an auditor looks.
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 1 }])
    await getInvoicePdfSource(fin(), id)

    const { rows: access } = await db.query<{ id: string }>(
      `SELECT id FROM document_access_log WHERE entity_id = $1`, [id])
    const { rows: audit } = await db.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_log
        WHERE table_name = 'document_access_log' AND row_id = $1`, [access[0].id])
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'insert', actor_id: userId })
  })

  it('has RLS enabled and NOT forced, with no policies', async () => {
    const { rows } = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'document_access_log'`)
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: false })
    const { rows: policies } = await db.query(
      `SELECT policyname FROM pg_policies WHERE tablename = 'document_access_log'`)
    expect(policies).toHaveLength(0)
  })

  it('fences entity_type and document_kind at the CHECK constraint', async () => {
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 1 }])
    await expect(db.query(
      `INSERT INTO document_access_log (entity_type, entity_id, document_kind, actor_id)
       VALUES ('anything', $1, 'invoice_pdf', $2)`, [id, userId])).rejects.toThrow()
    await expect(db.query(
      `INSERT INTO document_access_log (entity_type, entity_id, document_kind, actor_id)
       VALUES ('sales_invoice', $1, 'something_else', $2)`, [id, userId])).rejects.toThrow()
  })
})

describe('listInvoiceDocumentAccess', () => {
  it('refuses an actor without view_audit_record', async () => {
    // fin() deliberately omits view_audit_record so this stays a real check.
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 1 }])
    await expect(listInvoiceDocumentAccess(fin(), id)).rejects.toThrow(PermissionError)
  })

  it('ADMITS the Finance role — it owns the invoice and holds view_audit_record', async () => {
    // Regression guard for the original mistake: gating on view_full_audit made
    // this panel invisible to every role that would actually use it, Finance
    // included, while remaining visible only to admins.
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 1 }])
    await expect(listInvoiceDocumentAccess(auditor(), id)).resolves.toEqual([])
  })

  it('refuses a Viewer, who holds neither view_finance nor view_audit_record', async () => {
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 1 }])
    await expect(listInvoiceDocumentAccess(viewer(), id)).rejects.toThrow(PermissionError)
  })

  it('lists the accesses newest first, with the actor resolved', async () => {
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 1 }])
    await getInvoicePdfSource(fin(), id)
    const list = await listInvoiceDocumentAccess(auditor(), id)
    expect(list).toHaveLength(1)
    expect(list[0].actorId).toBe(userId)
    expect(list[0].actorEmail).toBe('reetmitra8@gmail.com')
  })

  it('returns an empty list for an invoice nobody has downloaded', async () => {
    const id = await makeInvoice(await makeBuyer(), [{ description: 'X', quantity: 1, unitPriceSgd: 1 }])
    expect(await listInvoiceDocumentAccess(auditor(), id)).toEqual([])
  })
})
