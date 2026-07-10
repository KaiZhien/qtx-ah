import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isEmailAllowed } from '@/lib/auth/allowlist'

// ask / plan / prepare_session call Claude upstream and can exceed Vercel's
// default function timeout — bump it and force this route fully dynamic.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type RouteParams = { params: { path: string[] } }

async function proxy(request: NextRequest, { params }: RouteParams) {
  // 1. Validate the session server-side (cookies, anon client).
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ detail: 'unauthenticated' }, { status: 401 })
  }

  // 2. Enforce the clinician email allowlist (fail closed).
  if (!isEmailAllowed(user.email)) {
    return NextResponse.json({ detail: 'email not authorized' }, { status: 403 })
  }

  // 3. Build the upstream URL, preserving the incoming query string.
  const path = params.path.join('/')
  const upstreamUrl = `${process.env.BACKEND_URL}/api/${path}${request.nextUrl.search}`

  // 4. Forward selected request headers + inject the server-only API key.
  const headers = new Headers()
  const contentType = request.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)
  const adminKey = request.headers.get('x-admin-key')
  if (adminKey) headers.set('x-admin-key', adminKey)
  headers.set('x-api-key', process.env.QTX_API_KEY ?? '')

  // 5. Forward method + body. Streaming request bodies require duplex: 'half'.
  const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body
    init.duplex = 'half'
  }

  const upstream = await fetch(upstreamUrl, init)

  // 6. Stream the upstream response back, passing through the status and the
  //    headers that matter for rendering / downloads (PDF streams through).
  const responseHeaders = new Headers()
  const upstreamContentType = upstream.headers.get('content-type')
  if (upstreamContentType) responseHeaders.set('content-type', upstreamContentType)
  const contentDisposition = upstream.headers.get('content-disposition')
  if (contentDisposition) responseHeaders.set('content-disposition', contentDisposition)

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

export const GET = proxy
export const POST = proxy
