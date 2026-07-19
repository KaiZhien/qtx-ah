import { requirePermission } from '@/lib/auth/session'
import { getAllStatuses, getAllPhases } from '@/lib/services/vocabularyService'
import { ACTIONS } from '@/lib/auth/permissions'
import { Badge } from '@/components/ui/badge'
import { AddVocabForm } from './AddVocabForm'
import { ToggleActiveButton } from './ToggleActiveButton'

export default async function VocabulariesPage() {
  await requirePermission(ACTIONS.MANAGE_VOCABULARIES)
  const [statuses, phases] = await Promise.all([getAllStatuses(), getAllPhases()])

  return (
    <div className="space-y-8 max-w-2xl">
      <h1 className="text-2xl font-bold">Vocabulary Management</h1>
      <p className="text-sm text-muted-foreground">Add or deactivate Status/Phase values. No migration needed — changes take effect immediately.</p>

      {[
        { label: 'Status · 状态', table: 'status_option' as const, options: statuses },
        { label: 'Phase · 阶段', table: 'phase_option' as const, options: phases },
      ].map(({ label, table, options }) => (
        <section key={table} className="space-y-3">
          <h2 className="font-semibold border-b pb-1">{label}</h2>
          <div className="space-y-2">
            {options.map((opt) => (
              <div key={opt.code} className="flex items-center gap-3 p-2 rounded border">
                <span className="font-mono text-sm w-32">{opt.code}</span>
                <span className="text-sm">{opt.label_en}</span>
                <span className="text-sm text-muted-foreground">{opt.label_zh}</span>
                <Badge variant={opt.active ? 'success' : 'gray'} className="ml-auto">{opt.active ? 'Active' : 'Inactive'}</Badge>
                <ToggleActiveButton table={table} code={opt.code} active={opt.active} />
              </div>
            ))}
          </div>
          <AddVocabForm table={table} />
        </section>
      ))}
    </div>
  )
}
