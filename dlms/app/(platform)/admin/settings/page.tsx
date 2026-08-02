import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listSettings } from '@/modules/shared/settings/services/settingService'
import { describeSettingValue } from '@/modules/shared/settings/domain/settingRegistry'
import { SettingsTable, type SettingsRow } from './SettingsTable'

/**
 * Platform settings — the runtime knobs an administrator can retune WITHOUT a
 * deploy and without a migration (spec §3.1, §6.3).
 *
 * Gated on `manage_settings`, which already exists in the permission catalogue
 * and is granted to Super Admin. 404, NOT 403 (spec §7.3): a denial must not
 * confirm that the section exists.
 *
 * Until this page there was no way to change a knob except SQL against
 * production, which meant the Finance approval threshold — a control the business
 * genuinely tunes — could only move with a database session. The values were
 * always read live from the table on every use, so nothing here needed a deploy
 * story; what was missing was only the screen.
 */
export default async function AdminSettingsPage() {
  const actor = await requireActor()
  if (!can(actor, 'manage_settings', 'admin')) notFound()

  const settings = await listSettings(actor)

  const rows: SettingsRow[] = settings.map((s) => ({
    key: s.key,
    label: s.entry?.label ?? s.key,
    description: s.entry?.description
      // An unregistered key gets an honest explanation rather than a blank cell:
      // it is shown because hiding it would make the table look emptier than the
      // database is, and read-only because nothing here knows what it means.
      ?? 'This setting is not one the console knows how to edit, so it is shown read-only. '
        + 'It is stored in app_setting and read by whatever code declared it.',
    displayValue: describeSettingValue(s.value),
    valueType: s.valueType,
    editable: s.entry !== null,
    unit: s.entry?.unit ?? null,
    // Rendered on the server to one fixed locale: a raw Date crossing into a
    // client component would re-render in the browser's zone and disagree with
    // every other timestamp the platform prints.
    updatedAt: s.updatedAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    updatedByName: s.updatedByName,
    version: s.version,
  }))

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
        <p className="mt-1 text-slate-600">
          Platform-wide knobs, read live wherever they are used — a change here takes effect
          immediately, with no deploy. Every change is audited.
        </p>
      </div>

      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        A setting that is missing, or that holds the wrong kind of value, does not fall back to a
        default — whatever depends on it refuses to run and says which setting is at fault. That is
        deliberate: a control that silently switched itself off would be invisible.
      </div>

      <SettingsTable rows={rows} />
    </div>
  )
}
