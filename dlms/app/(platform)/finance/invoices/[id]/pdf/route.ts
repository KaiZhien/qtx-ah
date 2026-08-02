import { NextResponse } from 'next/server'
import {
  requireAal2Actor, MfaRequiredError, UnauthenticatedError,
} from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { PermissionError } from '@/modules/shared/authz/authorize'
import { getInvoicePdfSource } from '@/modules/finance/services/invoicePdfService'
import { buildInvoicePdfModel } from '@/modules/finance/domain/invoicePdfModel'
import { renderInvoicePdf } from '@/modules/finance/pdf/invoicePdfDocument'

/**
 * GET /finance/invoices/{id}/pdf — streams a printable SGD sales invoice.
 *
 * Lives in the (platform) route group rather than under app/api/ deliberately:
 * it is a page-adjacent document download for a signed-in operator, not a
 * programmatic API surface, and app/api/** is another workstream's territory
 * this wave.
 *
 * ── runtime = 'nodejs' IS LOAD-BEARING ─────────────────────────────────────
 * @react-pdf/renderer needs Node built-ins (streams, Buffer, fs for font
 * loading). On the Edge runtime it fails at BUILD time with an unresolvable
 * module, not at request time. Do not remove this export, and do not "fix" a
 * bundling error by loosening types — the correct fix is always runtime config.
 * dynamic = 'force-dynamic' is equally load-bearing: this response depends on
 * the caller's identity, and a statically-optimized or cached one would serve a
 * finance document to the wrong person.
 * ───────────────────────────────────────────────────────────────────────────
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 404, never 403, for anything to do with whether this invoice is readable —
 * the platform convention (spec §7.3): a denial must not confirm that the
 * record exists. Pages use notFound(); a route handler streaming bytes returns
 * the status directly so the browser gets a real 404 for the download rather
 * than an HTML error page inside a .pdf.
 */
function notFoundResponse(): NextResponse {
  return new NextResponse('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function plain(status: number, body: string): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

export async function GET(
  _req: Request, { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    // requireAal2Actor, NOT requireActor. Next does not run the (platform)
    // layout for a route handler, so the layout's MFA gate does not apply here
    // any more than it applies to a server action. Streaming a finance document
    // is a capability; it gets the capability-layer gate.
    const actor = await requireAal2Actor()

    // Cheap gate first, before any I/O — and before the service confirms
    // anything about the invoice.
    if (!can(actor, 'view_finance', 'finance')) return notFoundResponse()
    if (!UUID_RE.test(params.id)) return notFoundResponse()

    const source = await getInvoicePdfSource(actor, params.id)
    if (!source) return notFoundResponse()

    const model = buildInvoicePdfModel(source)
    const buffer = await renderInvoicePdf(model)

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        // model.fileName is sanitized in the pure model (invoice_no is
        // user-entered free text and would otherwise be header injection).
        'Content-Disposition': `attachment; filename="${model.fileName}"`,
        // A finance document must never sit in a shared or browser cache: the
        // response varies by actor and the underlying invoice can be voided.
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      },
    })
  } catch (err) {
    if (err instanceof UnauthenticatedError) return plain(401, 'Sign in to download this invoice.')
    if (err instanceof MfaRequiredError) {
      // Deliberately not 404: this says nothing about the invoice, only about
      // the session, and telling the user to finish signing in is actionable
      // where a 404 would just be baffling.
      return plain(403, 'Two-factor authentication required — finish signing in and try again.')
    }
    // The service is its own choke point; its refusal must land as 404 too,
    // never escape as a 500 that reveals the check happened at all.
    if (err instanceof PermissionError) return notFoundResponse()

    console.error(JSON.stringify({
      level: 'error', msg: 'invoice pdf generation failed', err: String(err),
    }))
    return plain(500, 'Could not generate the invoice PDF. Try again, and tell Reet if it keeps happening.')
  }
}
