'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutGrid } from 'lucide-react'
import type { ModuleDef } from '@/modules/shared/navigation/moduleRegistry'
import { cn } from '@/lib/utils'
import { iconFor } from '@/components/platform/moduleIcons'

type ModuleNavProps = {
  modules: ModuleDef[]
}

/** Sidebar nav. Rendering here is a UX convenience only — every module page
 * re-checks access itself, so hiding a link is never the control. */
export function ModuleNav({ modules }: ModuleNavProps) {
  const pathname = usePathname()

  return (
    <nav aria-label="Modules" className="flex w-56 shrink-0 flex-col gap-1 border-r bg-white p-4">
      <Link href="/" className="mb-4 flex items-center gap-2 px-2 text-sm font-semibold text-slate-900">
        <LayoutGrid className="h-5 w-5" aria-hidden="true" />
        QTX Ops
      </Link>
      {modules.map((m) => {
        const Icon = iconFor(m.icon)
        const isActive = pathname === m.href || pathname.startsWith(`${m.href}/`)
        return (
          <Link
            key={m.key}
            href={m.href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
              isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {m.label}
          </Link>
        )
      })}
    </nav>
  )
}
