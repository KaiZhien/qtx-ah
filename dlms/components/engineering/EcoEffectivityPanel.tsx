import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import {
  listAffectedItems, listBomVariantOptions,
} from '@/modules/engineering/services/bomEffectivityService'
import { getEcoApprovalState } from '@/modules/engineering/services/ecoService'
import { listComponentTypeOptions } from '@/modules/engineering/services/engineeringReadService'
import { AffectedItemsEditor } from './AffectedItemsEditor'
import { ApplyEffectivityButton } from './ApplyEffectivityButton'

type Props = {
  ecoId: string
  /** The ECO's current status — the apply is only offered at `implemented`. */
  status: string
  /** Shown so the panel can say WHY an apply is refused before it is attempted. */
  effectivityDate: Date | string | null
  effectivitySerial: string | null
}

/**
 * The BOM-effectivity half of the ECO detail page: what this order changes, and
 * the control that writes those changes into the variant BOMs.
 *
 * Server component — it reads through the same services every other surface
 * uses, so an actor who cannot view Engineering records never gets a panel with
 * data in it (the read throws before rendering, and the caller has already
 * gated the page).
 *
 * Applying is deliberately its OWN step rather than a side effect of the
 * status change: it is idempotent, it reports what it did, and rewriting a bill
 * of materials deserves its own audit event. Folding it into the status change
 * is a one-line change in whichever service owns changeEcoStatus, using
 * applyEcoEffectivityTx.
 */
export async function EcoEffectivityPanel({
  ecoId, status, effectivityDate, effectivitySerial,
}: Props) {
  const actor = await requireActor()
  if (!can(actor, 'view_records', 'engineering')) return null

  const items = await listAffectedItems(actor, ecoId)
  const canEdit = can(actor, 'edit_records', 'engineering')
  const anyApplied = items.some((i) => i.appliedAt !== null)
  const allApplied = items.length > 0 && items.every((i) => i.appliedAt !== null)
  const hasEffectivityPoint = !!effectivityDate || !!effectivitySerial?.trim()

  /**
   * The second reason this list can be frozen: an approval that has already been
   * acted on covers these exact rows, so `addAffectedItem` / `removeAffectedItem`
   * refuse. Read from the service rather than re-derived from `status` here — the
   * rule lives in `ecoScopeLockedByApproval` and a second copy of it in a component
   * is a copy that will disagree.
   *
   * Only read it when it could change what is rendered: an actor who cannot edit,
   * or an ECO already applied, has a frozen list either way and this would be a
   * query asked to confirm a conclusion already reached.
   */
  const approvalState = canEdit && !anyApplied ? await getEcoApprovalState(actor, ecoId) : null
  const scopeLocked = approvalState?.scopeLocked ?? false
  const editable = canEdit && !anyApplied && !scopeLocked

  const [variantOptions, componentTypeOptions] = editable
    ? await Promise.all([listBomVariantOptions(actor), listComponentTypeOptions(actor)])
    : [[], []]

  return (
    <section className="space-y-4 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-slate-900">Affected BOM items</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            What this order changes on each variant&apos;s bill of materials.
          </p>
        </div>
        {canEdit && status === 'implemented' && !allApplied && hasEffectivityPoint
          && items.length > 0 && <ApplyEffectivityButton ecoId={ecoId} />}
      </div>

      {status !== 'implemented' && items.length > 0 && (
        <p className="rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-900">
          These changes take effect on the BOM once this order is implemented.
        </p>
      )}
      {status === 'implemented' && items.length > 0 && !hasEffectivityPoint && (
        <p className="rounded-md bg-yellow-50 px-3 py-2 text-xs text-yellow-900">
          This order has no effectivity date or serial, so there is no point at which the BOM
          changes. Set one before applying.
        </p>
      )}
      {allApplied && (
        <p className="rounded-md bg-green-50 px-3 py-2 text-xs text-green-900">
          Applied to the BOM. <Link href="/engineering/bom" className="underline">View effective BOM</Link>
        </p>
      )}
      {scopeLocked && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {approvalState?.scopeLockedReason}
        </p>
      )}
      {approvalState && approvalState.drift.length > 0 && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-900">
          This order no longer matches the state that was approved, so it cannot be applied to the
          BOM: {approvalState.drift.join('; ')}
        </p>
      )}

      <AffectedItemsEditor
        ecoId={ecoId}
        items={items.map((i) => ({
          id: i.id, version: i.version, variantName: i.variantName,
          componentTypeName: i.componentTypeName, disposition: i.disposition,
          quantity: i.quantity, notes: i.notes,
          appliedAt: i.appliedAt ? i.appliedAt.toISOString() : null,
        }))}
        variantOptions={variantOptions}
        componentTypeOptions={componentTypeOptions}
        editable={editable}
      />
    </section>
  )
}
