import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// `/api/outbox/drain` is public TO THIS GATE ONLY, and has to be: the drain's
// callers (a scheduler, a cron, an operator with curl) have no Supabase session,
// so without this entry every POST would be answered with a 307 to /login and
// the handler would never run. It is not unauthenticated — it authenticates on a
// shared secret it compares in constant time, and refuses every request when that
// secret is unset (see app/api/outbox/drain/route.ts). Middleware has no database
// and could not make that decision anyway.
const PUBLIC_PATHS = ['/login', '/auth', '/unauthorized', '/api/health', '/api/outbox/drain']

/**
 * Refreshes the Supabase session on every route, then coarse-gates the
 * unauthenticated ones.
 *
 * The refresh runs unconditionally — including on public paths — so a signed-in
 * user browsing to /login still gets its cookies renewed; scoping the refresh
 * to protected routes only would silently break continuity for everyone else.
 *
 * The gate deliberately does NOT check permissions. Middleware runs on the edge
 * without database access, and a permission decision made here would be a second
 * source of truth competing with authorize(). Pages and services do the real
 * check; this just keeps anonymous traffic off authenticated routes.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Refresh the session so it doesn't expire mid-visit
  const { data } = await supabase.auth.getUser()

  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p))
  if (!isPublic && !data.user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    // Run on all routes except static files and Supabase auth callbacks
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
