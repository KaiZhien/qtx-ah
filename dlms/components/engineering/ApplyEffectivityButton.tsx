'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { applyEcoEffectivityAction } from '@/app/(platform)/engineering/bom/effectivityActions'

/**
 * Applies an implemented ECO's affected items to the variant BOMs.
 *
 * The operation is idempotent server-side — a second click reports "already
 * applied" instead of doubling the BOM — so this button is safe to retry after
 * any error it surfaces, and safe to double-click.
 */
export function ApplyEffectivityButton({ ecoId }: { ecoId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function apply() {
    setBusy(true)
    try {
      const res = await applyEcoEffectivityAction({ ecoId })
      if (!res.ok) { toast.error(res.error); return }
      toast.success(
        res.data.alreadyApplied
          ? 'Already applied — nothing to do.'
          : `Applied ${res.data.itemsApplied} item(s): ${res.data.linesOpened} BOM line(s) opened, ${res.data.linesClosed} closed.`,
      )
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button size="sm" onClick={apply} disabled={busy}>
      {busy ? 'Applying…' : 'Apply to BOM'}
    </Button>
  )
}
