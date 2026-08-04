import { notFound } from 'next/navigation'
import Link from 'next/link'
import { z } from 'zod'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import {
  getVariantBom, listBomVariantOptions, BomVariantNotFoundError,
  type VariantBomView, type BomLineRow,
} from '@/modules/engineering/services/bomEffectivityService'
import { serialOnlyBounds } from '@/modules/engineering/domain/bomEffectivity'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

type PageProps = { searchParams: { variant?: string; date?: string; serial?: string } }

// Deliberately the UTC date: prod runs UTC, and this is only the DEFAULT for the
// date box — the effectivity answer itself never touches a Date object, because
// getVariantBom reads the bound columns as ::text (a JS Date built at local
// midnight is exactly how a 'YYYY-MM-DD' bound shifts by a day off-UTC).
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

const dash = (v: string | null) => v ?? '—'

/**
 * The plain-English form of serialOnlyBounds: the part of this line's window
 * that the date the user typed cannot judge. Rendered beside the component type
 * so the caveat is on the ROW that is a guess, not only in a banner counting
 * them — "the ferrite bead is listed" and "the ferrite bead is listed only for
 * builds before QTX-P-00500" are different answers to the planner.
 */
function serialCaveat(line: BomLineRow): string | null {
  const { from, to } = serialOnlyBounds(line)
  if (from && to) return `only on builds ${from} up to (not including) ${to}`
  if (from) return `only from build ${from} onward`
  if (to) return `only on builds before ${to}`
  return null
}

/**
 * The effective BOM viewer (spec §6.3 / D17): "what was the BOM for this variant
 * on date D / at build serial S?"
 *
 * A plain GET form drives it, so the question is in the URL and shareable. The
 * precedence between the date and serial axes — serial wins when it can be
 * judged, date is the floor that always answers — is decided once in
 * modules/engineering/domain/bomEffectivity.ts and never re-expressed here.
 */
export default async function VariantBomPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_records', 'engineering')) notFound()

  const variants = await listBomVariantOptions(actor)
  const variantId = searchParams.variant || variants[0]?.id
  const date = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.date ?? '') ? searchParams.date! : todayIso()
  const serial = searchParams.serial?.trim() || undefined

  // The question lives in the URL so it can be shared, which means stale and
  // hand-edited links are ordinary. A `variant` that is not a UUID throws a
  // ZodError and one naming a deleted variant throws BomVariantNotFoundError —
  // both are "that page is gone", and the house rule for that is notFound().
  let bom: VariantBomView | null = null
  if (variantId) {
    try {
      bom = await getVariantBom(actor, { variantId, date, serial })
    } catch (err) {
      if (err instanceof BomVariantNotFoundError || err instanceof z.ZodError) notFound()
      throw err
    }
  }

  // Two very different causes, so two very different messages — see the domain's
  // findUnderdeterminedLines vs findBomEffectivityConflicts. A component type
  // that is under-determined is ambiguous, not corrupt; an overlap that a
  // comparable serial does NOT explain is a row the apply step cannot produce.
  const softIds = new Set((bom?.underdetermined ?? []).map((u) => u.componentTypeId))
  const hardConflicts = (bom?.conflicts ?? []).filter((c) => !softIds.has(c.componentTypeId))
  const guessedLineIds = new Set((bom?.underdetermined ?? []).flatMap((u) => u.lineIds))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Bill of materials</h1>
        <p className="mt-1 text-slate-600">
          The BOM as it stood at a point in time — or for one specific build serial. Change orders
          rewrite it at their effectivity point; nothing is overwritten.
        </p>
      </div>

      {variants.length === 0 ? (
        <p className="rounded-md border p-6 text-center text-sm text-muted-foreground">
          No active device variants.
        </p>
      ) : (
        <>
          <form className="flex flex-wrap items-end gap-3 rounded-md border p-4">
            <div>
              <Label htmlFor="variant" className="mb-1.5 block text-xs">Variant</Label>
              <select
                id="variant" name="variant" defaultValue={variantId}
                className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="date" className="mb-1.5 block text-xs">As at date</Label>
              <Input id="date" name="date" type="date" defaultValue={date} className="w-44" />
            </div>
            <div>
              <Label htmlFor="serial" className="mb-1.5 block text-xs">
                Build serial (optional — overrides the date)
              </Label>
              <Input
                id="serial" name="serial" defaultValue={serial ?? ''} className="w-56"
                placeholder="e.g. QTX-P-00412"
              />
            </div>
            <Button type="submit" variant="outline">Show BOM</Button>
          </form>

          {bom && (
            <>
              {hardConflicts.length > 0 && (
                <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-900">
                  {hardConflicts.length} component type(s) have overlapping effectivity windows
                  that a build serial does not separate. The latest definition is shown — the
                  underlying data needs fixing, because the apply step cannot produce this.
                </p>
              )}

              {/* Fires for ALL THREE dispositions, not just the one that leaves
                  two lines: a serial-keyed `remove` leaves the closed line
                  reading as effective on every date, and a serial-keyed `add`
                  leaves the new line reading as effective on every date
                  including ones before the change. Both are one line, so the
                  overlap detector above is blind to them. */}
              {bom.underdetermined.length > 0 && (
                <p className="rounded-md bg-yellow-50 px-3 py-2 text-sm text-yellow-900">
                  {bom.underdetermined.length} component type(s) below changed by BUILD SERIAL, not
                  by date{serial ? `, and ${serial} is not comparable with the serials on those
                  lines` : ''}. A date alone cannot say whether the change applies to the unit you
                  have in mind, so the rows marked below may be wrong for it — enter a comparable
                  build serial above for an exact answer.
                </p>
              )}

              <div className="rounded-md border">
                <h2 className="border-b px-4 py-3 text-sm font-medium text-slate-900">
                  {bom.variantName} — effective {serial ? `at serial ${serial}` : `on ${date}`}
                </h2>
                {bom.lines.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">
                    No components were on this BOM at that point.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Component type</TableHead>
                        <TableHead>Qty</TableHead>
                        <TableHead>Effective from</TableHead>
                        <TableHead>Introduced by</TableHead>
                        <TableHead>Notes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {bom.lines.map((l) => (
                        <TableRow key={l.id}>
                          <TableCell className="font-medium">
                            {l.componentTypeName}
                            {guessedLineIds.has(l.id) && (
                              <span className="mt-0.5 block text-xs font-normal text-yellow-800">
                                by build serial — {serialCaveat(l)}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="tabular-nums">{l.quantity}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {dash(l.effectiveFromDate)}
                            {l.effectiveFromSerial && ` / ${l.effectiveFromSerial}`}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {l.createdByEcoId && l.createdByEcoNo
                              ? <Link href={`/engineering/eco/${l.createdByEcoId}`} className="text-primary hover:underline">{l.createdByEcoNo}</Link>
                              : '—'}
                          </TableCell>
                          <TableCell className="text-muted-foreground">{dash(l.notes)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>

              <div className="rounded-md border">
                <h2 className="border-b px-4 py-3 text-sm font-medium text-slate-900">
                  Full history ({bom.history.length} line{bom.history.length === 1 ? '' : 's'})
                </h2>
                {bom.history.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">This variant has no BOM lines.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Component type</TableHead>
                        <TableHead>Qty</TableHead>
                        <TableHead>From (date / serial)</TableHead>
                        <TableHead>To (date / serial)</TableHead>
                        <TableHead>Opened by</TableHead>
                        <TableHead>Closed by</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {bom.history.map((l) => (
                        <TableRow key={l.id}>
                          <TableCell>{l.componentTypeName}</TableCell>
                          <TableCell className="tabular-nums">{l.quantity}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {dash(l.effectiveFromDate)} / {dash(l.effectiveFromSerial)}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {dash(l.effectiveToDate)} / {dash(l.effectiveToSerial)}
                          </TableCell>
                          <TableCell className="text-muted-foreground">{dash(l.createdByEcoNo)}</TableCell>
                          <TableCell className="text-muted-foreground">{dash(l.supersededByEcoNo)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
