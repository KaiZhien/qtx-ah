import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// An offered link must agree with what its destination enforces.
//
// Every admin page 404s rather than 403s (spec §7.3), so a control shown to
// someone who cannot open it does not explain itself — it dead-ends on a page
// that says the thing does not exist. The /admin landing cards were fixed for
// this during the wave by carrying the permission their page enforces; UserTable's
// "Permission exceptions" button was the one left, and it points at a page gated
// on manage_roles_permissions while the table itself only requires manage_users.
// A user admin who is not a permission-fabric admin saw the button on every row.
//
// SOURCE PINS, because the test environment has no DOM: these are facts about
// the files, in the same genre as actionAalPinning. What they buy is the
// cross-file half — the offer's gate is read out of one file and the
// destination's out of another, so the two cannot drift apart silently.
// ---------------------------------------------------------------------------

const dlmsRoot = join(__dirname, '..', '..', '..')
const read = (...p: string[]) => readFileSync(join(dlmsRoot, ...p), 'utf8')

/** The permission a page enforces in its own `can(actor, '…', 'admin')` guard. */
function enforcedPermission(source: string): string | null {
  return /\bcan\(actor,\s*'([a-z_]+)',\s*'admin'\)/.exec(source)?.[1] ?? null
}

describe('UserTable "Permission exceptions" link', () => {
  const overridesPage = read('app', '(platform)', 'admin', 'users', '[userId]', 'overrides', 'page.tsx')
  const usersPage = read('app', '(platform)', 'admin', 'users', 'page.tsx')
  const userTable = read('components', 'admin', 'UserTable.tsx')

  it('the destination still enforces a permission at all', () => {
    // Honesty guard: if this ever returns null the agreement assertions below
    // would compare undefined to undefined and pass vacuously.
    expect(enforcedPermission(overridesPage)).not.toBeNull()
  })

  it('is offered under exactly the permission the overrides page enforces', () => {
    const destination = enforcedPermission(overridesPage)
    const offered = /canManageOverrides = can\(actor,\s*'([a-z_]+)',\s*'admin'\)/.exec(usersPage)?.[1]
    expect(offered).toBe(destination)
  })

  it('is narrower than the users page itself, which is the whole point', () => {
    expect(enforcedPermission(usersPage)).toBe('manage_users')
    expect(enforcedPermission(overridesPage)).not.toBe('manage_users')
  })

  it('the table takes the decision as a prop rather than assuming it', () => {
    expect(/canManageOverrides:\s*boolean/.test(userTable)).toBe(true)
    expect(/canManageOverrides=\{canManageOverrides\}/.test(usersPage)).toBe(true)
  })

  it('renders the link ONLY under that prop', () => {
    const guard = userTable.indexOf('canManageOverrides && (')
    const href = userTable.indexOf('/overrides`')
    expect(guard).toBeGreaterThan(-1)
    expect(href).toBeGreaterThan(guard)
    // Exactly one link to the overrides route — a second, unguarded one would sit
    // outside the block above and this pin would not see it.
    expect(userTable.split('/overrides`').length - 1).toBe(1)
  })
})

describe('/admin landing cards keep the same agreement', () => {
  const landing = read('app', '(platform)', 'admin', 'page.tsx')

  // Split the SECTIONS array into one chunk per entry, then keep the ones that
  // both link somewhere and declare a gate.
  const entries = landing
    .split(/\{\s*key:/).slice(1)
    .map((chunk) => ({
      href: /href:\s*'([^']+)'/.exec(chunk)?.[1] ?? null,
      gate: /gate:\s*'([a-z_]+)'/.exec(chunk)?.[1] ?? null,
    }))
    .filter((e): e is { href: string; gate: string } => e.href !== null && e.gate !== null)

  it('found the gated cards', () => {
    expect(entries.length).toBeGreaterThanOrEqual(4)
  })

  it.each(entries)('$href is offered under the permission its page enforces ($gate)',
    ({ href, gate }) => {
      const segments = href.replace(/^\//, '').split('/')
      const page = read('app', '(platform)', ...segments, 'page.tsx')
      expect(enforcedPermission(page)).toBe(gate)
    })
})
