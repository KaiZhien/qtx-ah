'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { updateSettingAction } from '@/app/(platform)/admin/settings/actions'

export type SettingsRow = {
  key: string
  label: string
  description: string
  /** The stored value rendered for a text input (scalars unquoted). */
  displayValue: string
  /** The JSON type Postgres reports, shown for unregistered rows. */
  valueType: string
  /** False when the key is not in the registry — visible, but not editable. */
  editable: boolean
  unit: string | null
  updatedAt: string
  updatedByName: string | null
  version: number
}

type Props = { rows: SettingsRow[] }

/**
 * The Super Admin settings console (spec §3.1).
 *
 * WHY EACH ROW IS ITS OWN FORM rather than one Save for the table: `app_setting`
 * is optimistically locked per key, so a single submit would either have to
 * abandon that (last write wins, silently) or fail the whole batch because one
 * unrelated knob moved. One row, one version, one refusal.
 *
 * UNREGISTERED KEYS RENDER READ-ONLY. Not hidden — the row an operator most needs
 * to see is the one nobody declared — but there is no type to validate against,
 * and writing whatever text was typed into a `jsonb` column is exactly how a
 * threshold becomes the string "abc".
 *
 * NO ROW OFFERS A DEFAULT OR A CLEAR CONTROL. A missing knob fails closed and
 * loudly at the reader, and that is the design: a control that silently switches
 * itself off when its row is deleted is invisible. A button here that could unset
 * one would make the reader's refusal look like a bug.
 *
 * Disabling an input is never the authorization — `updateSettingAction` re-checks
 * `manage_settings`, and the registry re-validates the value server-side. What is
 * on screen is a courtesy.
 */
export function SettingsTable({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-slate-500">
        No settings are stored yet. Settings are created by the migration that ships the code
        reading them, not from this screen.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {rows.map((row) => <SettingCard key={row.key} row={row} />)}
    </div>
  )
}

function SettingCard({ row }: { row: SettingsRow }) {
  const router = useRouter()
  const [value, setValue] = useState(row.displayValue)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = value !== row.displayValue

  async function save() {
    setSaving(true)
    setError(null)
    const result = await updateSettingAction({ key: row.key, value, version: row.version })
    setSaving(false)
    if (result.ok) {
      toast.success(`${row.label} updated`)
      // The page re-reads the row (and its new version) on the server; without
      // this the next save would submit a stale version and be refused.
      router.refresh()
    } else {
      setError(result.error)
    }
  }

  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="font-medium text-slate-900">{row.label}</h2>
          <code className="text-xs text-slate-500">{row.key}</code>
        </div>
        {!row.editable && (
          <Badge variant="secondary" className="bg-slate-100 text-slate-600">
            Read-only · {row.valueType}
          </Badge>
        )}
      </div>

      <p className="mt-2 text-sm text-slate-600">{row.description}</p>

      <div className="mt-3 flex flex-wrap items-start gap-2">
        <div className="flex items-center gap-2">
          <Input
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(null) }}
            disabled={!row.editable || saving}
            aria-label={row.label}
            aria-invalid={error ? true : undefined}
            className="w-64 font-mono"
          />
          {row.unit && <span className="text-sm text-slate-500">{row.unit}</span>}
        </div>
        {row.editable && (
          <Button onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        )}
      </div>

      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

      <p className="mt-3 text-xs text-slate-500">
        Last changed {row.updatedAt}
        {row.updatedByName ? ` by ${row.updatedByName}` : ''}. Every change is recorded in the
        audit trail.
      </p>
    </div>
  )
}
