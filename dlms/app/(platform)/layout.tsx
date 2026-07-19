import { redirect } from 'next/navigation'
import { getCurrentActor } from '@/modules/shared/auth/session'
import { visibleModules } from '@/modules/shared/navigation/moduleRegistry'
import { ModuleNav } from '@/components/platform/ModuleNav'

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const actor = await getCurrentActor()
  if (!actor) redirect('/login')

  const modules = visibleModules(actor)

  return (
    <div className="flex min-h-screen bg-slate-50">
      <ModuleNav modules={modules} />
      <div className="flex flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b bg-white px-6">
          <span className="text-sm text-slate-500">Search — coming in week 9</span>
          <span className="text-sm font-medium text-slate-700">{actor.roleKey.replace('_', ' ')}</span>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  )
}
