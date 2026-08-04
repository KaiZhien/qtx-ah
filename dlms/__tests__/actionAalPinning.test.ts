import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Action-layer AAL2 convention pin (same genre as *.clientSelection.test.ts).
//
// The MFA gate in app/(platform)/layout.tsx only guards PAGE RENDERING — Next
// does not run layouts for server-action dispatches, so an AAL1 session of an
// MFA-required role could POST a privileged action directly. requireAal2Actor
// closes that at the capability layer. This test turns "every platform server
// action calls requireAal2Actor, never bare requireActor" into a merge gate:
// any future action module that reaches for requireActor fails here.
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

// A file is a server-action module iff its source carries the 'use server'
// directive — the same signal the harness uses to expose action IDs.
const serverActionFiles = walk(PLATFORM_DIR).filter(
  (f) => /\.tsx?$/.test(f) && /['"]use server['"]/.test(readFileSync(f, 'utf8')),
)

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
    (file) => {
      const src = readFileSync(file, 'utf8')
      // (a) No bare requireActor. \b anchors the whole identifier;
      //     requireAal2Actor is not a substring of requireActor, so it never
      //     matches here — only the un-gated call/import would.
      expect(/\brequireActor\b/.test(src)).toBe(false)
      // (b) requireAal2Actor IS the gate.
      expect(/\brequireAal2Actor\b/.test(src)).toBe(true)
    },
  )
})
