import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { MODULE_REGISTRY } from '@/modules/shared/navigation/moduleRegistry'
import { ModuleLanding } from '@/components/platform/ModuleLanding'

export default async function MaintenancePage() {
  const actor = await requireActor()
  const def = MODULE_REGISTRY.find((m) => m.key === 'maintenance')!
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, def.gate, def.key)) notFound()
  return <ModuleLanding module={def} buildWeek="Weeks 7–8" />
}
