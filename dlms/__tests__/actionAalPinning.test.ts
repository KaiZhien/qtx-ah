import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Capability-layer AAL2 convention pin (same genre as *.clientSelection.test.ts).
//
// The MFA gate in app/(platform)/layout.tsx only guards PAGE RENDERING. Next
// does not run layouts for server-action dispatches, so an AAL1 session of an
// MFA-required role could POST a privileged action directly. requireAal2Actor
// closes that at the capability layer, and this test turns the convention into a
// merge gate: any future module that reaches for bare requireActor fails here.
//
// TWO SURFACES BYPASS THE LAYOUT, NOT ONE:
//   1. server actions      — files carrying the 'use server' directive
//   2. ROUTE HANDLERS      — app/(platform)/**/route.ts
//
// Route handlers were added to this pin when the first one landed
// (finance/invoices/[id]/pdf, which streams an invoice PDF). They are exactly as
// exposed as a server action — Next runs no layout for them either — but they
// carry no 'use server' directive, so the original scan below could never see
// them and the next route handler could have shipped at AAL1 with no gate
// noticing. That is the same failure mode this file was created for after three
// action modules shipped with the guard misplaced; it does not get to recur on a
// new surface.
//
// SCOPE IS DELIBERATELY app/(platform)/** AND NOT app/api/**.
// Those are two different authentication models, and conflating them would
// either weaken this assertion or produce false failures:
//   - (platform) routes are ACTOR-authenticated. They sit behind the same
//     session//MFA story as the pages beside them, so requireAal2Actor is the
//     correct and only gate.
//   - app/api/** routes (health, cron, the outbox drain) authenticate by SHARED
//     SECRET and have no actor at all. requireAal2Actor is meaningless there;
//     demanding it would be nonsense, and relaxing THIS assertion to let them
//     pass would gut the pin for the routes that do need it.
// If an actor-authenticated handler is ever added under app/api/**, do not
// broaden this walk — move the handler, or add a second explicitly-named list
// here. Never soften assertAal2Gate.
// ---------------------------------------------------------------------------

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const PLATFORM_DIR = join(__dirname, '..', 'app', '(platform)')
const platformFiles = walk(PLATFORM_DIR)

// A file is a server-action module iff its source carries the 'use server'
// directive — the same signal the harness uses to expose action IDs.
const serverActionFiles = platformFiles.filter(
  (f) => /\.tsx?$/.test(f) && /['"]use server['"]/.test(readFileSync(f, 'utf8')),
)

// A route handler is any route.ts/route.tsx under the (platform) group. Matched
// by FILENAME, not by content: that is the whole point — a route handler has no
// directive to key off, so the only reliable signal is Next's own file
// convention, and anything Next will serve as a handler must be gated.
const routeHandlerFiles = platformFiles.filter((f) => /(^|[\\/])route\.tsx?$/.test(f))

/**
 * The shared assertion: requireAal2Actor is the gate, the bare non-AAL session
 * helper is not.
 *
 * Matches RAW SOURCE — comments and strings included, deliberately NOT stripped.
 * Stripping comments first would read better and would let prose name the banned
 * identifier, but a comment-stripping regex can eat real code (a `//` inside a
 * string literal takes the rest of the line with it), and that failure direction
 * is a FALSE NEGATIVE on a security pin — a genuine un-gated call sliding through
 * silently. A false positive just means an author has to reword a comment, which
 * is cheap and loud. Prefer the loud failure.
 *
 * Consequence for authors: do not write the forbidden identifier in prose in a
 * gated file. Say "the bare non-AAL session helper" instead.
 */
function assertAal2Gate(file: string): void {
  const src = readFileSync(file, 'utf8')
  // (a) No bare requireActor. \b anchors the whole identifier;
  //     requireAal2Actor is not a substring of requireActor, so it never
  //     matches here — only the un-gated call/import would.
  expect(/\brequireActor\b/.test(src)).toBe(false)
  // (b) requireAal2Actor IS the gate.
  expect(/\brequireAal2Actor\b/.test(src)).toBe(true)
}

describe('platform server actions enforce AAL2', () => {
  it('the scan actually found the known server-action modules', () => {
    // Guards against a silently-empty it.each (a broken scan would make the
    // convention checks below register zero tests and pass vacuously).
    //
    // RAISE THIS FLOOR WHEN MODULES ARE ADDED. It sat at 7 while the app had 22
    // action modules, which made the guard almost decorative: a scan that broke
    // badly enough to find only a third of them would still have passed. 20 is
    // deliberately just under the current count — low enough that deleting one
    // module in an ordinary refactor doesn't fail the build, high enough that a
    // broken glob or a changed directory layout does.
    expect(serverActionFiles.length).toBeGreaterThanOrEqual(20)
  })

  it.each(serverActionFiles)(
    'uses requireAal2Actor and not bare requireActor: %s',
    assertAal2Gate,
  )
})

describe('platform route handlers enforce AAL2', () => {
  it('the scan actually found the known route handlers', () => {
    // Same anti-vacuity guard. If this drops to zero, the scan broke — it does
    // NOT mean the convention is satisfied.
    expect(routeHandlerFiles.length).toBeGreaterThanOrEqual(1)
  })

  it.each(routeHandlerFiles)(
    'uses requireAal2Actor and not bare requireActor: %s',
    assertAal2Gate,
  )

  it('does not double-count: a route handler is never also a server-action module', () => {
    // If a route.ts ever carries 'use server' it would be asserted twice and the
    // two describe blocks would stop meaning distinct things. Cheap to notice.
    const overlap = routeHandlerFiles.filter((f) => serverActionFiles.includes(f))
    expect(overlap).toEqual([])
  })
})
