import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { callFailed, CALL_FAILED_MESSAGE } from '@/components/platform/callFailed'

// ---------------------------------------------------------------------------
// The rejected-server-action-invocation handler, and the convention that every
// async startTransition callback uses it.
//
// A server action's own failures come back as `{ ok: false, error }` — those are
// mapped, logged and shown. The INVOCATION can fail separately: a body-size
// rejection from the framework, a dropped connection, a stale action id after a
// redeploy, an expired session on a page left open overnight. Inside an async
// startTransition callback there is nowhere for that rejection to go, so React
// rethrows it when the transition unwraps and it escalates to the error
// boundary, replacing the whole page.
//
// It reached three occurrences before it became a helper (the import UI, the
// search palette, and DeviceTable), and by the end of the wave eight components
// had the shape. Two of them — the notification list and the preference table —
// make OPTIMISTIC updates whose revert lives in the `!result.ok` branch, which a
// rejection never reaches: the UI would keep showing a state the server refused.
// ---------------------------------------------------------------------------

afterEach(() => { vi.restoreAllMocks() })

describe('callFailed', () => {
  it('returns the shared generic line', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(callFailed('device load-more', new Error('boom'))).toBe(CALL_FAILED_MESSAGE)
  })

  it('logs once, structured, naming the call site', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    callFailed('import upload', new Error('Body exceeded 4mb limit'))
    expect(spy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(spy.mock.calls[0][0] as string)
    expect(logged.level).toBe('error')
    expect(logged.msg).toBe('import upload call failed')
    expect(logged.err).toContain('Body exceeded 4mb limit')
  })

  it('NEVER puts the underlying error into the string it returns', () => {
    // The returned string is rendered in the browser. The whole point of routing
    // a transport failure through here is that its text — which can name a table,
    // a connection string or an action id — goes to the server log and nowhere else.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const secret = 'relation "sales_invoice" does not exist'
    expect(callFailed('invoice load-more', new Error(secret))).not.toContain('sales_invoice')
  })

  it.each([
    ['a thrown string', 'just a string'],
    ['a thrown object', { code: 42 }],
    ['null', null],
    ['undefined', undefined],
  ])('survives %s without throwing itself', (_label, thrown) => {
    // A handler that throws while handling a rejection re-creates the exact
    // failure it exists to prevent, so it must accept anything `throw` accepts.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => callFailed('x', thrown)).not.toThrow()
    expect(callFailed('x', thrown)).toBe(CALL_FAILED_MESSAGE)
  })
})

// ---------------------------------------------------------------------------
// Convention pin, same genre as actionAalPinning: a fact about the source.
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

const COMPONENTS_DIR = join(__dirname, '..', '..', '..', 'components')
const asyncTransitionFiles = walk(COMPONENTS_DIR).filter(
  (f) => /\.tsx$/.test(f) && /startTransition\(async\b/.test(readFileSync(f, 'utf8')),
)

describe('every async startTransition callback handles its own rejection', () => {
  it('the scan actually found the known components', () => {
    // Guards against a silently-empty it.each. Raise when components are added.
    expect(asyncTransitionFiles.length).toBeGreaterThanOrEqual(8)
  })

  it.each(asyncTransitionFiles.map((f) => [f.slice(f.indexOf('components/')), f]))(
    '%s routes it through the shared helper', (_label, file) => {
      const src = readFileSync(file, 'utf8')
      expect(/\bcallFailed\b/.test(src)).toBe(true)
      // …and the rejection is actually caught. `callFailed` imported but never
      // reached from a catch would satisfy the line above and fix nothing.
      expect(/\}\s*catch\b/.test(src)).toBe(true)
    })

  it('the module-local copy the import UI grew is gone, not forked', () => {
    const stale = walk(COMPONENTS_DIR).filter((f) => /importCallFailed/.test(f))
    expect(stale).toEqual([])
  })
})
