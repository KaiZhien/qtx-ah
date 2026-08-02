import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { getPreferences } from '@/modules/shared/notifications/services/notificationService'
import { CATEGORY_LABELS } from '@/modules/shared/notifications/domain/preferences'
import {
  PreferenceTable, type PreferenceRowView,
} from '@/components/notifications/PreferenceTable'

/**
 * Per-user notification preferences (spec §6.3).
 *
 * YOUR OWN ONLY. There is no user parameter here and no admin variant of this screen
 * anywhere — `setPreference` cannot express editing someone else's, because that would be a
 * way to silence a person's alerts without their knowledge.
 *
 * `getPreferences` returns EVERY shipped category, defaulted where no row exists, so this
 * page always renders the full list. A user who has never visited it sees what is actually
 * true for them rather than an empty screen that reads as "nothing is on".
 */
export default async function NotificationPreferencesPage() {
  const actor = await requireActor()
  const prefs = await getPreferences(actor)

  const rows: PreferenceRowView[] = prefs.map((p) => ({
    category: p.category,
    title: CATEGORY_LABELS[p.category].title,
    hint: CATEGORY_LABELS[p.category].hint,
    inApp: p.inApp,
    email: p.email,
    digest: p.digest,
  }))

  return (
    <div className="space-y-6">
      <div>
        <Link href="/notifications" className="text-sm text-slate-500 underline">
          ← Notifications
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">
          Notification preferences
        </h1>
        <p className="mt-1 text-slate-600">
          Changes save as you make them. In-app and email are independent — turning the bell
          off does not stop the email. Digest holds the email back for a periodic summary
          instead of sending it straight away; the in-app copy still arrives immediately.
        </p>
      </div>

      <div className="rounded-md border bg-white">
        <PreferenceTable rows={rows} />
      </div>

      {!process.env.RESEND_API_KEY && (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Email delivery is not configured on this deployment, so nothing is emailed
          regardless of the settings above. The in-app notifications below the bell are
          unaffected.
        </p>
      )}
    </div>
  )
}
