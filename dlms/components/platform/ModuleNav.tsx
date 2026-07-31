'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutGrid } from 'lucide-react'
import type { CrossModuleLink, ModuleDef } from '@/modules/shared/navigation/moduleRegistry'
import { cn } from '@/lib/utils'
import { iconFor } from '@/components/platform/moduleIcons'

type NavEntry = { key: string; label: string; href: string; icon: string }

type ModuleNavProps = {
  modules: ModuleDef[]
  /** Sections belonging to no single module (Approvals). Separated by a rule. */
  crossModuleLinks?: CrossModuleLink[]
}

/** Sidebar nav. Rendering here is a UX convenience only — every module page
 * re-checks access itself, so hiding a link is never the control. */
export function ModuleNav({ modules, crossModuleLinks = [] }: ModuleNavProps) {
  const pathname = usePathname()

  const item = (entry: NavEntry) => {
    const Icon = iconFor(entry.icon)
    const isActive = pathname === entry.href || pathname.startsWith(`${entry.href}/`)
    return (
      <Link
        key={entry.key}
        href={entry.href}
        aria-current={isActive ? 'page' : undefined}
        className={cn(
          'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
          isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
        )}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
        {entry.label}
      </Link>
    )
  }

  return (
    <nav aria-label="Modules" className="flex w-56 shrink-0 flex-col gap-1 border-r bg-white p-4">
      <Link href="/" className="mb-4 flex items-center gap-2 px-2 text-sm font-semibold text-slate-900">
        <LayoutGrid className="h-5 w-5" aria-hidden="true" />
        QTX Ops
      </Link>
      {modules.map(item)}
      {crossModuleLinks.length > 0 && (
        <>
          <hr className="my-2" />
          {crossModuleLinks.map(item)}
        </>
      )}
    </nav>
  )
}
