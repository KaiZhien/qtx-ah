import type { ReactNode } from 'react'
import { getCurrentActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import type { ModuleKey, Permission } from '@/modules/shared/authz/catalog'

type PermissionGateProps = {
  permission: Permission
  module?: ModuleKey
  children: ReactNode
}

/**
 * Renders children only when can() allows — for hiding an affordance (a
 * button, a panel) inside a page that is already access-controlled.
 *
 * This is NEVER the access control by itself: pages still call
 * requireActor() + can() + notFound() at the top. Gating a widget here only
 * stops a permitted user from seeing something irrelevant to them — it must
 * never be the only thing standing between a denied user and the content.
 */
export async function PermissionGate({ permission, module, children }: PermissionGateProps) {
  const actor = await getCurrentActor()
  if (!actor || !can(actor, permission, module)) return null
  return <>{children}</>
}
