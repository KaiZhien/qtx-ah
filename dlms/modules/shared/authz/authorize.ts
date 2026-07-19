import { can } from './policy'
import type { Actor, ModuleKey, Permission } from './catalog'

export class PermissionError extends Error {
  readonly permission: Permission
  readonly module?: ModuleKey
  constructor(permission: Permission, module?: ModuleKey) {
    super(`Permission denied: ${permission}${module ? ` in ${module}` : ''}`)
    this.name = 'PermissionError'
    this.permission = permission
    this.module = module
  }
}

/**
 * The choke point. Every service entry point calls this before touching data.
 *
 * Throws rather than returning false so a forgotten `if` cannot silently permit
 * an action; route handlers translate PermissionError into 403 (or 404 for
 * id-addressed reads, so a denial never confirms a record exists — spec §7.3).
 */
export function authorize(actor: Actor, permission: Permission, module?: ModuleKey): void {
  if (!can(actor, permission, module)) throw new PermissionError(permission, module)
}
