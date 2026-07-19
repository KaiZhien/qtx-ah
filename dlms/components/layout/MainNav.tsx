'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { cn } from '@/lib/utils'
import type { Role } from '@/lib/types'

interface NavItem {
  label: string
  href: string
  gate?: () => boolean
}

interface NavGroup {
  label: string
  items: NavItem[]
}

type NavEntry =
  | { type: 'link'; item: NavItem }
  | { type: 'group'; group: NavGroup }

function buildNav(role: Role): NavEntry[] {
  return [
    {
      type: 'link',
      item: { label: 'Dashboard', href: '/legacy' },
    },
    {
      type: 'link',
      item: { label: 'Devices', href: '/legacy/devices' },
    },
    {
      type: 'group',
      group: {
        label: 'Insights',
        items: [
          { label: 'Analytics', href: '/legacy/analytics', gate: () => can(role, ACTIONS.VIEW_ANALYTICS) },
          { label: 'Traceability', href: '/legacy/traceability', gate: () => can(role, ACTIONS.VIEW_ANALYTICS) },
        ],
      },
    },
    {
      type: 'group',
      group: {
        label: 'Data',
        items: [
          { label: 'New device', href: '/legacy/devices/new', gate: () => can(role, ACTIONS.CREATE_DEVICE) },
          { label: 'Import', href: '/legacy/import', gate: () => can(role, ACTIONS.IMPORT_DATA) },
          { label: 'Drafts', href: '/legacy/drafts', gate: () => can(role, ACTIONS.CONFIRM_DRAFT) },
        ],
      },
    },
    {
      type: 'group',
      group: {
        label: 'Admin',
        items: [
          { label: 'Audit Log', href: '/legacy/admin/audit', gate: () => can(role, ACTIONS.VIEW_FULL_AUDIT_LOG) },
          { label: 'Users', href: '/legacy/admin/users', gate: () => can(role, ACTIONS.MANAGE_USERS) },
          { label: 'Subscribers', href: '/legacy/admin/subscribers', gate: () => can(role, ACTIONS.MANAGE_USERS) },
          { label: 'Vocabularies', href: '/legacy/admin/vocabularies', gate: () => can(role, ACTIONS.MANAGE_VOCABULARIES) },
        ],
      },
    },
  ]
}

interface MainNavProps {
  role: Role
}

export function MainNav({ role }: MainNavProps) {
  const pathname = usePathname()

  const entries = buildNav(role)

  return (
    <nav className="flex items-center gap-4 text-sm">
      {entries.map((entry) => {
        if (entry.type === 'link') {
          const { label, href } = entry.item
          const isActive = pathname === href
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'transition-colors hover:text-foreground',
                isActive ? 'text-foreground font-medium' : 'text-muted-foreground'
              )}
            >
              {label}
            </Link>
          )
        }

        // Group — filter visible items first, skip the entire dropdown if none visible
        const { label, items } = entry.group
        const visibleItems = items.filter((i) => !i.gate || i.gate())
        if (visibleItems.length === 0) return null

        const groupActive = visibleItems.some((i) =>
          i.href === '/' ? pathname === '/' : pathname.startsWith(i.href)
        )

        return (
          <DropdownMenu key={label}>
            <DropdownMenuTrigger
              className={cn(
                'flex items-center gap-0.5 transition-colors hover:text-foreground outline-none',
                groupActive ? 'text-foreground font-medium' : 'text-muted-foreground'
              )}
            >
              {label}
              <ChevronDown className="h-3 w-3 opacity-70" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {visibleItems.map((item) => (
                <DropdownMenuItem key={item.href} asChild>
                  <Link
                    href={item.href}
                    className={cn(
                      'w-full cursor-pointer',
                      pathname.startsWith(item.href) && item.href !== '/' ? 'font-medium' : ''
                    )}
                  >
                    {item.label}
                  </Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )
      })}
    </nav>
  )
}
