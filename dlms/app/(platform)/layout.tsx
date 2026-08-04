import { redirect } from 'next/navigation'
import { getCurrentActor } from '@/modules/shared/auth/session'
import {
  visibleModules, visibleCrossModuleLinks,
} from '@/modules/shared/navigation/moduleRegistry'
import { ModuleNav } from '@/components/platform/ModuleNav'
import { NotificationBell } from '@/components/notifications/NotificationBell'
import { SearchPalette } from '@/components/search/SearchPalette'
import { createClient } from '@/lib/supabase/server'
import { requiresMfa, mfaGateStatus, type AalLevel } from '@/modules/shared/auth/mfaPolicy'

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const actor = await getCurrentActor()
  if (!actor) redirect('/login')

  // Mandatory MFA (spec §5.2): an MFA-required role must reach AAL2 before any
  // module. The AAL read is skipped entirely for roles that don't need it, so
  // non-MFA users pay nothing. Fail closed — a null level routes to /mfa.
  if (requiresMfa(actor.roleKey)) {
    const supabase = createClient()
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    const currentLevel = (aal?.currentLevel ?? null) as AalLevel | null
    if (mfaGateStatus({ roleKey: actor.roleKey, currentLevel }) === 'required') redirect('/mfa')
  }

  const modules = visibleModules(actor)
  const crossModuleLinks = visibleCrossModuleLinks(actor)

  return (
    <div className="flex min-h-screen bg-slate-50">
      <ModuleNav modules={modules} crossModuleLinks={crossModuleLinks} />
      <div className="flex flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b bg-white px-6">
          <SearchPalette />
          <span className="flex items-center gap-3">
            <NotificationBell />
            <span className="text-sm font-medium text-slate-700">{actor.roleKey.replace('_', ' ')}</span>
          </span>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  )
}
