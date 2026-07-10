import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isEmailAllowed } from '@/lib/auth/allowlist'

export async function middleware(request: NextRequest) {
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

  // Refresh the session so it doesn't expire mid-visit.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname

  // Build a redirect that carries over any refreshed/cleared session cookies.
  const redirectTo = (pathname: string, error?: string) => {
    const url = request.nextUrl.clone()
    url.pathname = pathname
    url.search = ''
    if (error) url.searchParams.set('error', error)
    const res = NextResponse.redirect(url)
    supabaseResponse.cookies.getAll().forEach((c) => res.cookies.set(c))
    return res
  }

  // API routes are never redirected — the BFF proxy returns 401/403 JSON itself.
  if (path.startsWith('/api/')) {
    return supabaseResponse
  }

  const isAuthPath = path === '/login' || path.startsWith('/auth/')

  // Not signed in → force login (auth paths pass through).
  if (!user) {
    return isAuthPath ? supabaseResponse : redirectTo('/login')
  }

  // Signed in but not on the allowlist → fail closed: sign out + bounce to login.
  if (!isEmailAllowed(user.email)) {
    await supabase.auth.signOut()
    return isAuthPath ? supabaseResponse : redirectTo('/login', 'not-authorized')
  }

  // Signed in + authorized, but sitting on /login → send home.
  if (path === '/login') {
    return redirectTo('/')
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    // Run on all routes except static files and Supabase auth callbacks.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
