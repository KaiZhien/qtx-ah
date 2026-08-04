import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * NO PAGE IS REACHABLE ONLY BY TYPING ITS URL.
 *
 * `/search` shipped that way: a full results page with its own permission story,
 * its own empty states and its own tests, and NOTHING anywhere in the app
 * pointing at it. No nav entry, and `SearchPalette` only ever pushed a hit's own
 * href. A page nobody can navigate to is not a delivered feature, but it costs
 * exactly as much to maintain as one — and nothing failed.
 *
 * DERIVED, NOT LISTED, for the reason rls.test.ts's hand-written table list
 * demonstrates: a checklist of "pages that should be linked" is a checklist that
 * stops being true the next time someone adds a page. The population is the
 * filesystem's, so a new page is covered the day it is created.
 *
 * SCOPE: STATIC routes only — anything with a `[param]` segment is addressed by
 * template literal (`/maintenance/repairs/${id}`) and a literal-string scan
 * cannot see it. That is a real limit, not an oversight: the detail pages are
 * reached from their list pages, and the orphan risk this catches is a
 * standalone section nobody wired into navigation.
 */

const ROOT = join(__dirname, '../../..')
const PLATFORM = join(ROOT, 'app', '(platform)')

/**
 * Static platform routes deliberately reachable by URL alone.
 *
 * Shipped with one entry, and the entry is not a page. Every addition here is a
 * page a user cannot find; it needs a reason a reader can check, not "it's fine".
 */
const EXPECTED_UNLINKED: Record<string, string> = {
  '/': 'The app root. Every logo, every post-login redirect and the middleware all '
    + 'target it, none of them by a literal this scan can match — and a root nobody '
    + 'can reach is not a failure mode that needs a test.',
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const platformFiles = walk(PLATFORM)

type Route = { href: string; dir: string }

/** Every parameter-less page route under (platform), with the directory that owns it. */
function staticRoutes(): Route[] {
  return platformFiles
    .filter((f) => f.endsWith(`${sep}page.tsx`))
    .map((f) => {
      const dir = f.slice(0, -`${sep}page.tsx`.length)
      const segments = relative(PLATFORM, dir)
        .split(sep)
        .filter((s) => s !== '' && !s.startsWith('('))   // route groups are not URL segments
      return { href: `/${segments.join('/')}`.replace(/\/$/, '') || '/', dir }
    })
    .filter((r) => !r.href.includes('['))
    .sort((a, b) => a.href.localeCompare(b.href))
}

const ROUTES = staticRoutes()

const sourceFiles = [
  ...walk(join(ROOT, 'app')),
  ...walk(join(ROOT, 'components')),
  ...walk(join(ROOT, 'modules')),
  ...walk(join(ROOT, 'lib')),
].filter((f) => /\.tsx?$/.test(f))
  .map((f) => ({ file: f, src: readFileSync(f, 'utf8') }))

/**
 * Files referencing `href` from OUTSIDE the route's own directory.
 *
 * The directory exclusion is what makes this mean something: a page's own
 * `<form action="/search">` refers to itself and proves nothing about whether
 * anyone can get there. `/search` had exactly zero outside references before the
 * palette gained its results-page link.
 *
 * Matched as a literal followed by a quote, `?`, backtick or `/` so that
 * `/admin` is not credited to a `'/admin/users'` mention — an over-eager match
 * here is a FALSE PASS, which is the failure direction that matters.
 */
function externalReferrers(route: Route): string[] {
  const escaped = route.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}(?=["'\`?])`)
  return sourceFiles
    .filter((s) => !s.file.startsWith(route.dir + sep))
    .filter((s) => re.test(s.src))
    .map((s) => relative(ROOT, s.file))
}

describe('every static platform page is reachable from inside the app', () => {
  it('finds the routes at all — an empty scan must not pass vacuously', () => {
    expect(ROUTES.length).toBeGreaterThan(40)
    expect(ROUTES.map((r) => r.href)).toContain('/search')
    expect(ROUTES.map((r) => r.href)).toContain('/approvals')
  })

  it.each(ROUTES.filter((r) => !(r.href in EXPECTED_UNLINKED)).map((r) => [r.href, r] as const))(
    '%s is linked from somewhere outside its own directory',
    (href, route) => {
      const referrers = externalReferrers(route)
      expect(referrers, `${href} is an orphan: nothing outside ${relative(ROOT, route.dir)} `
        + 'refers to it, so it is reachable only by typing the URL').not.toEqual([])
    },
  )

  describe('the exclusion list stays honest', () => {
    it.each(Object.keys(EXPECTED_UNLINKED))('%s is still a real route', (href) => {
      // A stale entry excuses a page that no longer exists while quietly
      // continuing to excuse anything that later takes its path.
      expect(ROUTES.map((r) => r.href)).toContain(href)
    })

    it.each(Object.entries(EXPECTED_UNLINKED))('%s carries a real reason', (_href, reason) => {
      expect(reason.trim().length).toBeGreaterThan(40)
    })
  })
})
