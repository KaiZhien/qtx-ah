import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import type { Permission } from '@/modules/shared/authz/catalog'
import { Users, ShieldCheck, ListTree, ScrollText, Settings as SettingsIcon, Download } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

type AdminSection = {
  key: string
  label: string
  href: string | null
  icon: LucideIcon
  description: string
  note?: string
  /**
   * The permission the LINKED PAGE enforces, when it is narrower than the
   * `manage_users` gate on this landing page.
   *
   * Every admin subsection 404s rather than 403s, so a card offered to someone
   * who cannot open it dead-ends with no explanation — the same defect already
   * carried against UserTable's "Permission exceptions" link. Filtering here
   * keeps the offer and the destination in agreement.
   */
  gate?: Permission
}

// Vocabularies and Audit are still scaffolding — listed rather than omitted so
// the gap is visible, same rationale as ModuleLanding for the business modules.
// Everything with an href is live, and each one's gate matches its page.
const SECTIONS: readonly AdminSection[] = [
  { key: 'users', label: 'Users', href: '/admin/users', icon: Users,
    gate: 'manage_users',
    description: 'Invite, activate/deactivate, and change role or module access.' },
  { key: 'roles', label: 'Roles & permissions', href: '/admin/roles', icon: ShieldCheck,
    gate: 'manage_roles_permissions',
    description: 'Edit the role → permission matrix and per-user overrides.' },
  { key: 'vocabularies', label: 'Vocabularies', href: null, icon: ListTree,
    description: 'Manage shared status, phase, and category lists.', note: 'Coming soon' },
  { key: 'audit', label: 'Audit', href: null, icon: ScrollText,
    description: 'Search the full change history and security event trail.', note: 'Coming soon' },
  { key: 'settings', label: 'Settings', href: '/admin/settings', icon: SettingsIcon,
    gate: 'manage_settings',
    description: 'Retune platform-wide runtime knobs, such as the Finance approval threshold.' },
  // WAS `href: null` + "Coming soon" WHILE THE PAGE ALREADY EXISTED, which made
  // /admin/export reachable only by typing the URL. Nothing else in the app
  // linked to it either.
  { key: 'exports', label: 'Exports', href: '/admin/export', icon: Download,
    gate: 'request_full_export',
    description: 'Build and download a full-system export. Needs a freshly-entered '
      + 'authenticator code.' },
]

export default async function AdminLandingPage() {
  const actor = await requireActor()
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, 'manage_users', 'admin')) notFound()

  const sections = SECTIONS.filter((s) => !s.gate || can(actor, s.gate, 'admin'))

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold text-slate-900">Admin</h1>
      <p className="mt-2 text-slate-600">Users, roles, permissions, audit, and platform settings.</p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {sections.map((section) => {
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
