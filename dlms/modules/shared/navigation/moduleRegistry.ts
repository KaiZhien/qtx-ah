import { can } from '@/modules/shared/authz/policy'
import type { Actor, ModuleKey, Permission } from '@/modules/shared/authz/catalog'

export type ModuleDef = {
  key: ModuleKey
  label: string
  href: string
  icon: string           // lucide-react icon name
  description: string
  /** The permission that makes this section worth showing at all. */
  gate: Permission
  sort: number
}

/**
 * The five business modules plus Tasks and Admin (spec §4.1).
 *
 * `gate` is what separates "may enter the module" from "has anything to do
 * there": Admin needs manage_users, not merely admin module access, so an
 * operator who was mistakenly given the admin module still sees nothing.
 */
export const MODULE_REGISTRY: readonly ModuleDef[] = [
  { key: 'engineering', label: 'Engineering', href: '/engineering', icon: 'Wrench',
    description: 'Change requests, failure investigations, documents, firmware.',
    gate: 'view_records', sort: 1 },
  { key: 'finance', label: 'Finance', href: '/finance', icon: 'Banknote',
    description: 'Sales invoices, buyers, approvals.', gate: 'view_records', sort: 2 },
  { key: 'logistics', label: 'Logistics', href: '/logistics', icon: 'Truck',
    description: 'Delivery orders, stock locations, shipping documents.',
    gate: 'view_records', sort: 3 },
  { key: 'manufacturing', label: 'Manufacturing', href: '/manufacturing', icon: 'Factory',
    description: 'Device registry, production pipeline, imports.', gate: 'view_records', sort: 4 },
  { key: 'maintenance', label: 'Maintenance', href: '/maintenance', icon: 'Hammer',
    description: 'Repairs, usage, modifications.', gate: 'view_records', sort: 5 },
  { key: 'tasks', label: 'Tasks', href: '/tasks', icon: 'CheckSquare',
    description: 'Everything assigned to you and your team.', gate: 'view_records', sort: 6 },
  { key: 'admin', label: 'Admin', href: '/admin', icon: 'Settings',
    description: 'Users, roles, permissions, audit, settings.', gate: 'manage_users', sort: 7 },
]

/** Pure: the modules this actor should see in the sidebar, in registry order. */
export function visibleModules(actor: Actor): ModuleDef[] {
  return MODULE_REGISTRY.filter((m) => can(actor, m.gate, m.key)).sort((a, b) => a.sort - b.sort)
}
