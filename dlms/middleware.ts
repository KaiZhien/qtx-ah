import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isPublicPath } from '@/modules/shared/auth/publicPaths'

// `/api/outbox/drain` and `/api/cron` are public TO THIS GATE ONLY, and have to
// be: their callers (Vercel Cron, an external scheduler, an operator with curl)
// have no Supabase session, so without these entries every request would be
// answered with a 307 to /login and the handler would never run. They are not
// unauthenticated — each authenticates on a shared secret it compares in constant
// time, and refuses every request when that secret is unset (see
// app/api/outbox/drain/route.ts, app/api/cron/[job]/route.ts and the shared
// modules/shared/outbox/services/cronAuth.ts). Middleware has no database and
// could not make that decision anyway.
//
// `/api/health` was listed here before the route existed — pre-existing drift,
// now closed by app/api/health/route.ts (spec §13). It is genuinely public: a
// health check that needs a credential cannot be used by an uptime monitor, and
// what it discloses is bounded to liveness plus a queue depth.
//
// Every entry is pinned by __tests__/platform/shared/cronRoutes.test.ts and
// __tests__/platform/shared/outboxDrainRoute.test.ts, which parse this array out
// of this file's source: deleting one is the difference between the endpoint
// working and 307-ing to /login. Keep it a literal array declared HERE — moving
// it into a module would leave both of those pins matching nothing and passing.
//
// Matched by SEGMENT (isPublicPath), not by string prefix. `/auth` and
// `/api/cron` cover their children on purpose; `/api/health` does not cover
// `/api/healthcheck-evil`, which the old `startsWith` test admitted.
const PUBLIC_PATHS = [
  '/login', '/auth', '/unauthorized', '/api/health', '/api/outbox/drain', '/api/cron',
]

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

  if (!isPublicPath(pathname, PUBLIC_PATHS) && !data.user) {
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
