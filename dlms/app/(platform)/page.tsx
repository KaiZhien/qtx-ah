import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { visibleModules } from '@/modules/shared/navigation/moduleRegistry'
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { iconFor } from '@/components/platform/moduleIcons'
import { listTasksFor } from '@/modules/shared/tasks/services/taskService'
import { StatusPill } from '@/components/tasks/StatusPill'

function formatDue(d: Date | null): string {
  if (!d) return 'No due date'
  return `Due ${new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

/**
 * Platform home (`/`). Task 12 adds the "My Tasks" widget the plan's sketch
 * always called for, above the module cards Task 7 built — the cards stay
 * because they're still how an actor with nothing assigned gets into a
 * section, but tasks are the more actionable content, so they lead.
 */
export default async function PlatformHomePage() {
  const actor = await requireActor()
  const modules = visibleModules(actor)
  // Tasks is its own gated module (moduleAccess is admin-configurable per
  // user, same as every other section) — listTasksFor's authorize() throws
  // for an actor without it, so this must not be called unconditionally, the
  // same way visibleModules() already hides the Tasks card for that actor.
  const hasTasksAccess = can(actor, 'view_records', 'tasks')
  const myTasks = hasTasksAccess
    ? await listTasksFor(actor, { scope: 'mine', status: ['open', 'in_progress', 'blocked'] })
    : []
  const overdueTasks = myTasks.filter((t) => t.overdue)
  const dueSoonTasks = myTasks.filter((t) => !t.overdue)

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Welcome back</h1>
      <p className="mt-1 text-slate-600">Signed in as {actor.roleKey.replace('_', ' ')}.</p>

      {hasTasksAccess && (
        <section className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">My Tasks</h2>
            <Link href="/tasks" className="text-sm text-blue-600 hover:underline">
              View all tasks
            </Link>
          </div>

          {myTasks.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">Nothing assigned to you right now.</p>
          ) : (
            <div className="mt-3 space-y-4">
              {overdueTasks.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-red-700">Overdue</h3>
                  <ul className="mt-2 divide-y rounded-md border">
                    {overdueTasks.map((t) => (
                      <li key={t.id} className="border-l-4 border-l-red-500">
                        <Link
                          href={`/tasks/${t.id}`}
                          className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-50"
                        >
                          <span className="truncate">{t.title}</span>
                          <span className="flex items-center gap-2 whitespace-nowrap">
                            <span className="text-xs text-red-700">{formatDue(t.dueDate)}</span>
                            <StatusPill status={t.status} />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {dueSoonTasks.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Due soon</h3>
                  <ul className="mt-2 divide-y rounded-md border">
                    {dueSoonTasks.map((t) => (
                      <li key={t.id}>
                        <Link
                          href={`/tasks/${t.id}`}
                          className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-50"
                        >
                          <span className="truncate">{t.title}</span>
                          <span className="flex items-center gap-2 whitespace-nowrap">
                            <span className="text-xs text-slate-500">{formatDue(t.dueDate)}</span>
                            <StatusPill status={t.status} />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      )}

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
