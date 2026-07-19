import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { visibleModules } from '@/modules/shared/navigation/moduleRegistry'
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { iconFor } from '@/components/platform/moduleIcons'

/**
 * Platform home (`/`). The plan's sketch for this page shows a "My Tasks"
 * widget, but the task system doesn't exist yet (Task 10-12) — there is no
 * data source to render. Task 12 adds that widget above this once it lands;
 * until then this stays a welcome plus the module cards the actor can enter,
 * which exercises the same visibleModules() the sidebar uses.
 */
export default async function PlatformHomePage() {
  const actor = await requireActor()
  const modules = visibleModules(actor)

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Welcome back</h1>
      <p className="mt-1 text-slate-600">Signed in as {actor.roleKey.replace('_', ' ')}.</p>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {modules.map((m) => {
          const Icon = iconFor(m.icon)
          return (
            <Link key={m.key} href={m.href}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Icon className="h-5 w-5 text-slate-500" aria-hidden="true" />
                    {m.label}
                  </CardTitle>
                  <CardDescription>{m.description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          )
        })}
      </div>

      {modules.length === 0 && (
        <p className="mt-8 text-sm text-slate-500">
          No sections are enabled for your account yet. Contact your Super Admin.
        </p>
      )}
    </div>
  )
}
