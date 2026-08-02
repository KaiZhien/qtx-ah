// ---------------------------------------------------------------------------
// The invoice PDF route handler.
//
// A route handler is NOT covered by the (platform) layout's AAL2 gate (Next
// does not run layouts for route handlers, exactly as it does not for server
// actions — see requireAal2Actor's header) and NOT covered by
// __tests__/actionAalPinning.test.ts either, which only scans files carrying
// 'use server'. So the gate has to be asserted here, by hand. A finance
// document streaming out to an AAL1 session would be the same hole
// requireAal2Actor was introduced to close, reopened through a GET.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Actor } from '@/modules/shared/authz/catalog'

// vi.mock is hoisted above every const in this file, and so is the static
// `import { GET }` below — so the doubles have to be created in a hoisted block
// too, or the factory closes over a temporal-dead-zone binding.
const h = vi.hoisted(() => ({
  requireAal2Actor: vi.fn(),
  getSource: vi.fn(),
  listAccess: vi.fn(),
  render: vi.fn(),
  MfaRequiredError: class MfaRequiredError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
}))
const { MfaRequiredError, UnauthenticatedError } = h
const mockRequireAal2Actor = h.requireAal2Actor
const mockGetSource = h.getSource
const mockRender = h.render

vi.mock('@/modules/shared/auth/session', () => ({
  requireAal2Actor: h.requireAal2Actor,
  MfaRequiredError: h.MfaRequiredError,
  UnauthenticatedError: h.UnauthenticatedError,
}))

vi.mock('@/modules/finance/services/invoicePdfService', () => ({
  getInvoicePdfSource: h.getSource,
  listInvoiceDocumentAccess: h.listAccess,
}))

// @react-pdf/renderer is a heavy native-ish dependency; the document itself is
// covered by invoicePdfModel.test.ts. Here we only care that the route feeds it
// the model and streams what comes back.
vi.mock('@/modules/finance/pdf/invoicePdfDocument', () => ({
  renderInvoicePdf: h.render,
  buildInvoiceDocument: vi.fn(),
}))

import { GET } from '@/app/(platform)/finance/invoices/[id]/pdf/route'
import { PermissionError } from '@/modules/shared/authz/authorize'

const INVOICE_ID = '3f1b0c8e-1111-4222-8333-444455556666'

// Real Actors + the real `can()` rule — the gate under test is the actual
// policy, not a mocked boolean.
const financeActor = (): Actor => ({
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', roleKey: 'finance',
  permissions: new Set(['view_records', 'view_finance', 'manage_finance']),
  moduleAccess: new Set(['finance']), active: true,
})
const operatorActor = (): Actor => ({
  id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', roleKey: 'operator',
  permissions: new Set(['view_records']),
  moduleAccess: new Set(['manufacturing', 'finance']), active: true,
})
const noModuleActor = (): Actor => ({
  id: 'cccccccc-1111-4111-8111-cccccccccccc', roleKey: 'manager',
  permissions: new Set(['view_records', 'view_finance']),
  moduleAccess: new Set(['manufacturing']), active: true,
})

const source = () => ({
  invoiceNo: 'INV-2026-0007', status: 'issued' as const, currency: 'SGD',
  issueDate: '2026-07-01', dueDate: '2026-07-31', notes: null,
  subtotalSgd: '100.00', taxSgd: '7.00', totalSgd: '107.00',
  buyer: {
    name: 'Acme', contactName: null, contactEmail: null,
    contactPhone: null, billingAddress: null, country: null,
  },
  lines: [{ lineNo: 1, description: 'Device', deviceSn: null,
            quantity: '1.00', unitPriceSgd: '100.00', amountSgd: '100.00' }],
  generatedAt: new Date('2026-08-03T00:00:00Z'),
})

const call = () => GET(new Request('http://localhost/finance/invoices/x/pdf'),
                       { params: { id: INVOICE_ID } })

beforeEach(() => {
  vi.clearAllMocks()
  mockRender.mockResolvedValue(Buffer.from('%PDF-1.7 fake'))
  mockGetSource.mockResolvedValue(source())
})

describe('GET /finance/invoices/[id]/pdf', () => {
  it('streams the PDF for an actor holding view_finance in the finance module', async () => {
    mockRequireAal2Actor.mockResolvedValue(financeActor())
    const res = await call()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(await res.arrayBuffer()).toEqual(Buffer.from('%PDF-1.7 fake').buffer)
  })

  it('names the download after the invoice number', async () => {
    mockRequireAal2Actor.mockResolvedValue(financeActor())
    const res = await call()
    expect(res.headers.get('content-disposition'))
      .toBe('attachment; filename="INV-2026-0007.pdf"')
  })

  it('forbids caching — a finance document must not sit in a shared cache', async () => {
    mockRequireAal2Actor.mockResolvedValue(financeActor())
    const res = await call()
    expect(res.headers.get('cache-control')).toMatch(/no-store/)
  })

  it('404s — not 403 — for an actor without view_finance', async () => {
    // Platform convention (spec §7.3): a denial must never confirm that the
    // record exists. Operator has finance module access but not view_finance.
    mockRequireAal2Actor.mockResolvedValue(operatorActor())
    const res = await call()
    expect(res.status).toBe(404)
    expect(mockGetSource).not.toHaveBeenCalled()
  })

  it('404s for an actor holding view_finance without finance module access', async () => {
    mockRequireAal2Actor.mockResolvedValue(noModuleActor())
    expect((await call()).status).toBe(404)
    expect(mockGetSource).not.toHaveBeenCalled()
  })

  it('404s for a deactivated actor even with every finance permission', async () => {
    mockRequireAal2Actor.mockResolvedValue({ ...financeActor(), active: false })
    expect((await call()).status).toBe(404)
  })

  it('404s when the invoice does not exist or was soft-deleted', async () => {
    mockRequireAal2Actor.mockResolvedValue(financeActor())
    mockGetSource.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(404)
    expect(mockRender).not.toHaveBeenCalled()
  })

  it('404s when the service itself refuses on permission', async () => {
    // Belt and braces: the service is its own choke point, and its refusal must
    // land as 404 rather than escaping as a 500.
    mockRequireAal2Actor.mockResolvedValue(financeActor())
    mockGetSource.mockRejectedValue(new PermissionError('view_finance', 'finance'))
    expect((await call()).status).toBe(404)
  })

  it('refuses an AAL1 session of an MFA-required role', async () => {
    // The gate the (platform) layout cannot apply to a route handler.
    mockRequireAal2Actor.mockRejectedValue(new MfaRequiredError())
    const res = await call()
    expect(res.status).toBe(403)
    expect(mockGetSource).not.toHaveBeenCalled()
  })

  it('401s an unauthenticated caller', async () => {
    mockRequireAal2Actor.mockRejectedValue(new UnauthenticatedError())
    expect((await call()).status).toBe(401)
  })

  it('never leaks an internal error message to the caller', async () => {
    mockRequireAal2Actor.mockResolvedValue(financeActor())
    mockGetSource.mockRejectedValue(new Error('relation "sales_invoice" does not exist'))
    const res = await call()
    expect(res.status).toBe(500)
    expect(await res.text()).not.toMatch(/sales_invoice/)
  })

  it('rejects a malformed invoice id without reaching the service', async () => {
    mockRequireAal2Actor.mockResolvedValue(financeActor())
    const res = await GET(new Request('http://localhost/x'), { params: { id: 'not-a-uuid' } })
    expect(res.status).toBe(404)
    expect(mockGetSource).not.toHaveBeenCalled()
  })

  it('watermarks a draft invoice DRAFT and a void one VOID', async () => {
    mockRequireAal2Actor.mockResolvedValue(financeActor())

    mockGetSource.mockResolvedValue({ ...source(), status: 'draft' })
    await call()
    expect(mockRender.mock.calls[0][0]).toMatchObject({ watermark: 'DRAFT' })

    mockGetSource.mockResolvedValue({ ...source(), status: 'void' })
    await call()
    expect(mockRender.mock.calls[1][0]).toMatchObject({ watermark: 'VOID' })
  })

  it('passes the built model — not the raw source — to the renderer', async () => {
    mockRequireAal2Actor.mockResolvedValue(financeActor())
    await call()
    expect(mockRender).toHaveBeenCalledWith(
      expect.objectContaining({ total: 'S$107.00', invoiceNo: 'INV-2026-0007' }))
  })
})
