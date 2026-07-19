import { MODULE_REGISTRY } from '@/modules/shared/navigation/moduleRegistry'
import type { ModuleKey } from '@/modules/shared/authz/catalog'

/**
 * Best-effort route for a linked record: `${moduleHref}/${entityType}s/{id}`.
 * This matches the one convention that exists today — Task 13's
 * `/manufacturing/devices/[id]` for entityType 'device' — since no other
 * module has shipped a record-detail route yet. A future module whose plural
 * or nesting differs can still get here fine; this is only a fallback link,
 * not the source of truth for any module's routing.
 */
export function entityHref(module: ModuleKey, entityType: string, entityId: string): string {
  const base = MODULE_REGISTRY.find((m) => m.key === module)?.href ?? `/${module}`
  return `${base}/${entityType}s/${entityId}`
}
