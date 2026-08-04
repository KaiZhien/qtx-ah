import { z } from 'zod'
import { withTransaction } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import { getInvoice } from '@/modules/finance/services/invoiceService'
import type { InvoicePdfSource } from '@/modules/finance/domain/invoicePdfModel'

/**
 * Assembles everything the invoice PDF needs, and records that it was pulled.
 *
 * ── WHY THE PDF IS GENERATED, NOT STORED ───────────────────────────────────
 * Spec §10 puts document storage on the `file` table backed by S3 presigned
 * uploads. There is no AWS account (PROGRESS.md item 6 — "Deferred: needs an AWS
 * account + a domain name"), so the entire file-storage layer is blocked and
 * every "attach the official PDF to the invoice" design is blocked with it.
 *
 * Generating on demand and streaming the bytes sidesteps the blocker
 * completely, and it is a better answer than a stored artefact anyway for this
 * particular document: the PDF can never drift from the record it describes,
 * there is no stale copy to invalidate when an invoice is voided, and no bucket
 * lifecycle policy to get wrong. When S3 lands, "persist the issued PDF at the
 * moment of issue" becomes a real requirement (an issued invoice is supposed to
 * be immutable evidence) — but that is a deliberate later decision, not
 * something this build is pretending to have done.
 *
 * ── WHY THE MONEY COMES FROM getInvoice() ──────────────────────────────────
 * The PDF's amounts MUST equal the invoice detail page's amounts to the cent.
 * The cheapest way to guarantee that is to read them through the exact same
 * function the page uses, rather than a second SELECT that could drift. The only
 * thing this service selects for itself is the buyer's billing block and the
 * dates as TEXT (see below) — no money, no arithmetic.
 * ───────────────────────────────────────────────────────────────────────────
 */

/**
 * Loads the PDF source AND writes the access record. Returns null for an unknown
 * or soft-deleted invoice so the route can 404 without a thrown error path.
 *
 * The access row is written when the data is loaded, i.e. BEFORE the bytes are
 * rendered. If rendering then fails, an access is logged that produced no
 * document. That asymmetry is deliberate: over-logging a download that didn't
 * happen is harmless, under-logging one that did is the failure the audit exists
 * to prevent.
 */
export async function getInvoicePdfSource(
  actor: Actor, invoiceId: string,
): Promise<InvoicePdfSource | null> {
  // The money gate, and the brief's minimum bar for pulling a finance document.
  // Called here as well as inside getInvoice: authorize() is the choke point,
  // and every service entry point owns its own check rather than inheriting one.
  authorize(actor, 'view_finance', 'finance')

  const id = z.string().uuid().safeParse(invoiceId)
  if (!id.success) return null

  const invoice = await getInvoice(actor, id.data)
  if (!invoice) return null

  return withTransaction(actor.id, async (tx) => {
    // Dates as ::text, not as `date`. node-postgres parses a date column into a
    // JS Date at LOCAL midnight, so on a host west of UTC an invoice dated
    // 2026-01-01 prints as 31 Dec 2025. On a tax document the date is a legal
    // fact. `now()` comes from the same statement so the stamp printed on the
    // PDF and the stamp in document_access_log cannot disagree.
    const { rows } = await tx.query<{
      issue_date: string | null; due_date: string | null
      buyer_name: string; contact_name: string | null; contact_email: string | null
      contact_phone: string | null; billing_address: string | null; country: string | null
      generated_at: Date
    }>(
      `SELECT i.issue_date::text AS issue_date, i.due_date::text AS due_date,
              b.name AS buyer_name, b.contact_name, b.contact_email, b.contact_phone,
              b.billing_address, b.country, now() AS generated_at
         FROM sales_invoice i JOIN buyer b ON b.id = i.buyer_id
        WHERE i.id = $1 AND i.deleted_at IS NULL`, [id.data])
    const r = rows[0]
    // getInvoice already found it; a miss here means it was soft-deleted between
    // the two transactions. Treat it as gone rather than half-rendering it.
    if (!r) return null

    // The audit (brief: "who pulled which invoice's PDF, when"; spec §10's
    // "every grant audit-logged"). This INSERT also fires fn_audit, so the event
    // lands in the central audit_log too — with actor_id resolved from the
    // app.actor_id GUC withTransaction set. See the migration header.
    await tx.query(
      `INSERT INTO document_access_log
         (entity_type, entity_id, document_kind, entity_status, actor_id)
       VALUES ('sales_invoice', $1, 'invoice_pdf', $2, $3)`,
      [id.data, invoice.status, actor.id])

    return {
      invoiceNo: invoice.invoiceNo,
      status: invoice.status,
      currency: invoice.currency,
      issueDate: r.issue_date,
      dueDate: r.due_date,
      notes: invoice.notes,
      // Verbatim numeric(12,2) strings — the same values getInvoice hands the
      // detail page. Nothing here parses or recomputes them.
      subtotalSgd: invoice.subtotalSgd,
      taxSgd: invoice.taxSgd,
      totalSgd: invoice.totalSgd,
      buyer: {
        name: r.buyer_name,
        contactName: r.contact_name,
        contactEmail: r.contact_email,
        contactPhone: r.contact_phone,
        billingAddress: r.billing_address,
        country: r.country,
      },
      lines: invoice.lines.map((l) => ({
        lineNo: l.lineNo,
        description: l.description,
        deviceSn: l.deviceSn,
        quantity: l.quantity,
        unitPriceSgd: l.unitPriceSgd,
        amountSgd: l.amountSgd,
      })),
      generatedAt: r.generated_at,
    }
  })
}

export type InvoiceDocumentAccess = {
  id: string
  actorId: string
  actorName: string | null
  actorEmail: string | null
  entityStatus: string | null
  accessedAt: Date
}

/**
 * Who has pulled this invoice's PDF. Surfaced on the invoice detail page so the
 * trail is visible where it matters rather than only in the admin audit console
 * — an access log nobody looks at is not a control.
 *
 * Gated on view_audit_record, NOT view_full_audit. The distinction is the whole
 * point: view_full_audit is admin/super_admin only (spec §3.2 matrix), so gating
 * here would hide the panel from Finance — the role that OWNS the invoice and has
 * the strongest legitimate need to know who holds a copy of it. Framing this as
 * "staff monitoring" inverts the question; it is not "what has Alice been doing",
 * it is "who has a copy of the document I am responsible for", which is
 * record-scoped. view_audit_record already means exactly that, and Finance,
 * Manager, Operator and Admin all hold it while Viewer does not.
 */
export async function listInvoiceDocumentAccess(
  actor: Actor, invoiceId: string, limit = 20,
): Promise<InvoiceDocumentAccess[]> {
  authorize(actor, 'view_audit_record', 'finance')
  const id = z.string().uuid().safeParse(invoiceId)
  if (!id.success) return []

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; actor_id: string; actor_name: string | null; actor_email: string | null
      entity_status: string | null; accessed_at: Date
    }>(
      `SELECT a.id, a.actor_id, u.full_name AS actor_name, u.email AS actor_email,
              a.entity_status, a.accessed_at
         FROM document_access_log a JOIN app_user u ON u.id = a.actor_id
        WHERE a.entity_type = 'sales_invoice' AND a.entity_id = $1
          AND a.document_kind = 'invoice_pdf'
        ORDER BY a.accessed_at DESC
        LIMIT $2`, [id.data, Math.min(Math.max(limit, 1), 100)])
    return rows.map((r) => ({
      id: r.id, actorId: r.actor_id, actorName: r.actor_name, actorEmail: r.actor_email,
      entityStatus: r.entity_status, accessedAt: r.accessed_at,
    }))
  })
}
