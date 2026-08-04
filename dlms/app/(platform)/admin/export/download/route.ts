import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { withTransaction } from '@/lib/db/tx'
import { getCurrentActor } from '@/modules/shared/auth/session'
import { PermissionError } from '@/modules/shared/authz/authorize'
import {
  buildFullExport, recordExportDownload, ExportMfaRequiredError,
  type ExportRequester,
} from '@/modules/shared/export/services/exportService'
import type { AuthenticationMethod } from '@/modules/shared/export/domain/mfaFreshness'

/**
 * Builds the full-system export and streams it back (spec §12, D36).
 *
 * A ROUTE HANDLER, NOT A SERVER ACTION, and deliberately under
 * `app/(platform)/admin/export/` rather than `app/api/`: a server action returns
 * a serialized value, so shipping a multi-megabyte ZIP through one means
 * base64-ing it into the RSC payload and rebuilding it in the browser. A route
 * handler sets Content-Disposition and lets the browser stream it to disk.
 * `app/api/**` belongs to another module in this wave; a route file is legal
 * anywhere under `app/`, so this one lives with the feature that owns it.
 *
 * Route handlers do not run the (platform) layout, so the layout's MFA gate never
 * fires here. That is exactly why the ceremony is re-verified below rather than
 * assumed from the page that linked here — a page render proves nothing about the
 * request that follows it, and this URL is guessable.
 *
 * `force-dynamic` because the response is per-actor and must never be cached by
 * Next, a CDN, or anything in between. This is the one response in the app that
 * would be catastrophic to serve from a shared cache.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const actor = await getCurrentActor()
    if (!actor) {
      return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
    }

    // The AMR claim: one entry per authentication method, each with the instant it
    // was satisfied. This is what makes "fresh" answerable at all — the AAL level
    // alone says only that a second factor happened at SOME point in this session.
    const supabase = createClient()
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    const methods =
      (aal?.currentAuthenticationMethods ?? null) as AuthenticationMethod[] | null

    const requester = await loadRequester(actor.id)

    // Throws PermissionError or ExportMfaRequiredError; both are handled below.
    const built = await buildFullExport(actor, requester, methods)

    await recordExportDownload(actor, built.exportId)

    return new NextResponse(new Uint8Array(built.zip), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(built.zip.length),
        'Content-Disposition': `attachment; filename="${built.filename}"`,
        // The archive is unredacted operational data. Nothing may retain a copy.
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (err) {
    // 404, not 403, for a permission denial — the same rule the page uses. A 403
    // here would confirm the endpoint exists to anyone who guesses the URL.
    if (err instanceof PermissionError) {
      return new NextResponse('Not found', { status: 404 })
    }
    if (err instanceof ExportMfaRequiredError) {
      return NextResponse.json({ error: err.message }, { status: 403 })
    }
    console.error(JSON.stringify({
      level: 'error', msg: 'full export failed',
      err: err instanceof Error ? err.message : String(err),
    }))
    return NextResponse.json(
      { error: 'The export could not be built. Nothing was downloaded.' },
      { status: 500 })
  }
}

/**
 * The requester's name and email for the manifest and README.
 *
 * `Actor` carries only authorization state — id, role, permissions, modules — so
 * the human identity is read here. Falls back to the id rather than throwing: an
 * export that refuses to build because a display name is missing would be a worse
 * outcome than one whose README names a UUID.
 */
async function loadRequester(actorId: string): Promise<ExportRequester> {
  const rows = await withTransaction(actorId, async (tx) => {
    const { rows } = await tx.query<{ full_name: string; email: string }>(
      `SELECT full_name, email FROM app_user WHERE id = $1`, [actorId])
    return rows
  })
  const r = rows[0]
  return {
    id: actorId,
    name: r?.full_name ?? actorId,
    email: r?.email ?? 'unknown',
  }
}
