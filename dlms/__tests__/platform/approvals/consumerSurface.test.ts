import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * EVERY APPROVAL CONSUMER MUST BE REACHABLE FROM THE PRODUCT.
 *
 * This exists because the shape it catches shipped twice in one wave. AP2 built
 * `requestEcoApproval` and `requestRepairSignOffApproval` complete with services,
 * unit tests, integration tests, registered handoff templates and PROGRESS rows —
 * and no server action and no component. Nothing in the product could raise
 * either request, so an engine whose entire posture is "requested ⇒ binding" had
 * **zero** observable effect on ECO and repair: `/approvals` could only ever
 * contain invoice rows, while the docs read as though the capability was live.
 * (MA2 did the same to modifications: schema, domain and service, no page.)
 *
 * A per-consumer test could not have caught it. Every unit test passed; the
 * service was correct. What was missing was a CALLER, which is a property of the
 * whole app, so the check has to be one too.
 *
 * DERIVED, NOT LISTED. The population is read out of the service sources — every
 * exported `request…Approval` function — so a THIRD consumer is covered the day
 * it is written rather than the day someone remembers to add it here. That is the
 * lesson of `rls.test.ts`, whose hand-written table list silently stopped
 * covering six tables as the schema grew.
 */

const ROOT = join(__dirname, '../../..')
const MODULES = join(ROOT, 'modules')
const PLATFORM = join(ROOT, 'app', '(platform)')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(full)) out.push(full)
  }
  return out
}

/**
 * The ENGINE's own service is not a consumer of itself. `requestApproval` /
 * `requestApprovalInTx` are the mechanism every consumer calls; demanding that
 * the generic entry point have its own server action would be asking for a
 * "raise an approval for anything" control that should not exist.
 */
const ENGINE_SERVICE = join('shared', 'approvals', 'services', 'approvalService.ts')

const serviceFiles = walk(MODULES)
  .filter((f) => f.includes('services') && !f.endsWith(ENGINE_SERVICE))
const platformFiles = walk(PLATFORM)
const actionSources = platformFiles
  .filter((f) => /['"]use server['"]/.test(readFileSync(f, 'utf8')))
  .map((f) => ({ file: f, src: readFileSync(f, 'utf8') }))
// Pages, components and everything else that can render a control.
const uiSources = [...platformFiles, ...walk(join(ROOT, 'components'))]
  .map((f) => ({ file: f, src: readFileSync(f, 'utf8') }))

/** Exported `request…Approval` service functions, by name. */
function requestServices(): string[] {
  const found = new Set<string>()
  for (const f of serviceFiles) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/export async function (request[A-Za-z]*Approval)\s*\(/g)) {
      found.add(m[1])
    }
  }
  return [...found].sort()
}

/** Exported `get…ApprovalState` service functions — the DISPLAY half. */
function stateServices(): string[] {
  const found = new Set<string>()
  for (const f of serviceFiles) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/export async function (get[A-Za-z]*ApprovalState)\s*\(/g)) {
      found.add(m[1])
    }
  }
  return [...found].sort()
}

describe('the approvals engine has a surface for every consumer it has a service for', () => {
  it('finds the services at all — an empty scan must not pass vacuously', () => {
    // Three today: invoice, eco, repair sign-off. A scan that broke would
    // otherwise make every assertion below trivially true, which is the worst
    // way for a coverage guard to fail.
    expect(requestServices().length).toBeGreaterThanOrEqual(3)
    expect(stateServices().length).toBeGreaterThanOrEqual(3)
  })

  it.each(requestServices())(
    '%s is called from a server action — otherwise nobody can raise the request',
    (fn) => {
      // `new RegExp` on a whole identifier: `requestApproval` must not satisfy
      // the requirement for `requestEcoApproval`.
      const re = new RegExp(`\\b${fn}\\b`)
      const callers = actionSources.filter((s) => re.test(s.src)).map((s) => s.file)
      expect(callers, `${fn} has no server action; no user can raise this request`)
        .not.toEqual([])
    },
  )

  it.each(stateServices())(
    '%s is read by a page or component — otherwise a drift refusal has no surface',
    (fn) => {
      // The display half matters on its own. Before this branch the repair page
      // did not call getRepairSignOffApprovalState at all, so a signer met the
      // drift refusal as the failure of a click, on a screen that had never
      // mentioned that an approval existed.
      const re = new RegExp(`\\b${fn}\\b`)
      const readers = uiSources.filter((s) => re.test(s.src)).map((s) => s.file)
      expect(readers, `${fn} is rendered nowhere; drift is invisible until refusal`)
        .not.toEqual([])
    },
  )
})

describe('the request controls do not quietly become mandatory approvals', () => {
  // "Requested ⇒ binding" is a decision argued at length in AP2: nothing in the
  // schema says WHEN an ECO or a repair needs a second pair of eyes, so an
  // approval is only ever binding once somebody asks for one. `requiredWithout-
  // Request: true` at either call site would stop every ECO and every repair in
  // the product until a request existed for each — a policy change disguised as
  // a one-word edit, which is exactly the kind that arrives in a refactor.
  const GATED = [
    'modules/engineering/services/ecoService.ts',
    'modules/maintenance/services/repairService.ts',
  ]

  it.each(GATED)('%s keeps requiredWithoutRequest false', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    expect(src).toMatch(/requiredWithoutRequest:\s*false/)
    expect(src).not.toMatch(/requiredWithoutRequest:\s*true/)
  })
})
