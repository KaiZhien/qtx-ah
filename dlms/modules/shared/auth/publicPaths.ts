/**
 * Does `pathname` fall under one of the gate's public entries?
 *
 * SEGMENT-WISE, not string-prefix. The gate used `pathname.startsWith(entry)`,
 * which made `/api/healthcheck-evil` public because `/api/health` is a prefix of
 * it — any future route whose path merely begins with a listed one would have
 * skipped the session check, silently. Matching on segment boundaries means an
 * entry covers itself and everything genuinely beneath it, and nothing else.
 *
 * The two entries that NEED to cover children are why this is not a plain
 * equality test: `/auth` has to admit `/auth/confirm`, and `/api/cron` has to
 * admit every `[job]` under it. Both are directories in the route tree, so the
 * boundary rule expresses exactly what was intended all along.
 *
 * Pure and separately importable so it can be unit-tested without pulling
 * `@supabase/ssr` and the edge runtime into the test — but the LIST itself stays
 * declared in middleware.ts, because two other pins parse it out of that file's
 * source and would go quietly vacuous if it moved.
 *
 * Next normalizes `.` and `..` out of the pathname before middleware runs, so
 * this does not re-canonicalize; it is a matcher, not a sanitizer.
 */
export function isPublicPath(pathname: string, paths: readonly string[]): boolean {
  return paths.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}
