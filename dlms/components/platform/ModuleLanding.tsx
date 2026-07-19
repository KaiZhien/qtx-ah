import type { ModuleDef } from '@/modules/shared/navigation/moduleRegistry'
import { iconFor } from '@/components/platform/moduleIcons'

type ModuleLandingProps = {
  module: ModuleDef
  buildWeek: string
}

/** Placeholder shown until a module's real content lands (spec §17 roadmap).
 * States the section's purpose and when to expect it — visible scaffolding
 * beats a section that silently pretends to be finished. */
export function ModuleLanding({ module, buildWeek }: ModuleLandingProps) {
  const Icon = iconFor(module.icon)

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3">
        <Icon className="h-8 w-8 text-slate-400" aria-hidden="true" />
        <h1 className="text-2xl font-semibold text-slate-900">{module.label}</h1>
      </div>
      <p className="mt-3 text-slate-600">{module.description}</p>
      <p className="mt-6 inline-block rounded-md bg-slate-100 px-3 py-1 text-sm text-slate-500">
        Section content lands {buildWeek}.
      </p>
    </div>
  )
}
