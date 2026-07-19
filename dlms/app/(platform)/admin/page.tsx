import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { Users, ShieldCheck, ListTree, ScrollText, Settings as SettingsIcon, Download } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

type AdminSection = {
  key: string
  label: string
  href: string | null
  icon: LucideIcon
  description: string
  note?: string
}

// Users is the only subsection Task 8 builds; the rest land in later tasks
// (Task 9 adds roles/overrides to this same console) — listed here as visible
// scaffolding rather than left as a dead nav link, same rationale as
// ModuleLanding for the business modules.
const SECTIONS: readonly AdminSection[] = [
  { key: 'users', label: 'Users', href: '/admin/users', icon: Users,
    description: 'Invite, activate/deactivate, and change role or module access.' },
  { key: 'roles', label: 'Roles & permissions', href: null, icon: ShieldCheck,
    description: 'Edit the role → permission matrix and per-user overrides.', note: 'Coming in Task 9' },
  { key: 'vocabularies', label: 'Vocabularies', href: null, icon: ListTree,
    description: 'Manage shared status, phase, and category lists.', note: 'Coming soon' },
  { key: 'audit', label: 'Audit', href: null, icon: ScrollText,
    description: 'Search the full change history and security event trail.', note: 'Coming soon' },
  { key: 'settings', label: 'Settings', href: null, icon: SettingsIcon,
    description: 'Platform-wide configuration.', note: 'Coming soon' },
  { key: 'exports', label: 'Exports', href: null, icon: Download,
    description: 'Request and download full system exports.', note: 'Coming soon' },
]

export default async function AdminLandingPage() {
  const actor = await requireActor()
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, 'manage_users', 'admin')) notFound()

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold text-slate-900">Admin</h1>
      <p className="mt-2 text-slate-600">Users, roles, permissions, audit, and platform settings.</p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {SECTIONS.map((section) => {
          const Icon = section.icon
          const card = (
            <div className={`flex h-full flex-col rounded-lg border p-4 transition-colors ${
              section.href ? 'bg-white hover:border-slate-400' : 'bg-slate-50'
            }`}>
              <div className="flex items-center gap-2">
                <Icon className="h-5 w-5 text-slate-400" aria-hidden="true" />
                <span className="font-medium text-slate-900">{section.label}</span>
              </div>
              <p className="mt-1.5 text-sm text-slate-600">{section.description}</p>
              {section.note && (
                <span className="mt-3 inline-block w-fit rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                  {section.note}
                </span>
              )}
            </div>
          )
          return section.href ? (
            <Link key={section.key} href={section.href}>{card}</Link>
          ) : (
            <div key={section.key}>{card}</div>
          )
        })}
      </div>
    </div>
  )
}
