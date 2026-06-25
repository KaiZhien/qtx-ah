import { requirePermission } from '@/lib/auth/session'
import { listSubscribers } from '@/lib/services/reportSubscriberService'
import { ACTIONS } from '@/lib/auth/permissions'
import { Badge } from '@/components/ui/badge'
import { AddSubscriberForm } from './AddSubscriberForm'
import { ToggleActiveButton } from './ToggleActiveButton'

export default async function SubscribersPage() {
  await requirePermission(ACTIONS.MANAGE_USERS)
  const subscribers = await listSubscribers()

  return (
    <div className="space-y-8 max-w-2xl">
      <h1 className="text-2xl font-bold">Report Subscribers</h1>
      <p className="text-sm text-muted-foreground">
        Manage email addresses that receive the weekly digest report.
      </p>

      <section className="space-y-3">
        <h2 className="font-semibold border-b pb-1">Subscribers</h2>
        {subscribers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No subscribers yet.</p>
        ) : (
          <div className="space-y-2">
            {subscribers.map((sub) => (
              <div key={sub.id} className="flex items-center gap-3 p-2 rounded border">
                <span className="text-sm flex-1 truncate">{sub.email}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(sub.created_at).toLocaleDateString()}
                </span>
                <Badge variant={sub.active ? 'success' : 'gray'}>
                  {sub.active ? 'Active' : 'Inactive'}
                </Badge>
                <ToggleActiveButton id={sub.id} active={sub.active} />
              </div>
            ))}
          </div>
        )}
        <AddSubscriberForm />
      </section>
    </div>
  )
}
