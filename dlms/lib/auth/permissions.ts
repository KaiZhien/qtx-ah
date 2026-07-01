/**
 * Permission matrix — single source of truth (§3, §5.1.1).
 * Used by the service layer (throws PermissionError) and the UI (hides/disables elements).
 */

import type { Role } from '@/lib/types'

export type { Role }

export const ACTIONS = {
  VIEW_RECORDS:         'view_records',
  CREATE_DEVICE:        'create_device',
  EDIT_DEVICE:          'edit_device',
  CHANGE_STATUS:        'change_status',
  MANAGE_VOCABULARIES:  'manage_vocabularies',
  SOFT_DELETE:          'soft_delete',
  MANAGE_USERS:         'manage_users',
  VIEW_AUDIT_LOG:       'view_audit_log',        // per-record history (engineer+)
  VIEW_FULL_AUDIT_LOG:  'view_full_audit_log',   // cross-system full view (admin only)
  EXPORT_DATA:          'export_data',
  CONFIRM_DRAFT:        'confirm_draft',
  IMPORT_DATA:          'import_data',
  VIEW_ANALYTICS:       'view_analytics',
  ASSIGN_DEVICE:        'assign_device',
  LOG_SERVICE_EVENT:    'log_service_event',
} as const

export type Action = (typeof ACTIONS)[keyof typeof ACTIONS]

// PRD §3 permission matrix
const PERMISSIONS: Record<Role, Set<Action>> = {
  viewer: new Set([
    ACTIONS.VIEW_RECORDS,
    ACTIONS.VIEW_ANALYTICS,
  ]),
  engineer: new Set([
    ACTIONS.VIEW_RECORDS,
    ACTIONS.CREATE_DEVICE,
    ACTIONS.EDIT_DEVICE,
    ACTIONS.CHANGE_STATUS,
    ACTIONS.VIEW_AUDIT_LOG,
    ACTIONS.EXPORT_DATA,
    ACTIONS.CONFIRM_DRAFT,
    ACTIONS.IMPORT_DATA,
    ACTIONS.VIEW_ANALYTICS,
    ACTIONS.ASSIGN_DEVICE,
    ACTIONS.LOG_SERVICE_EVENT,
  ]),
  admin: new Set(Object.values(ACTIONS) as Action[]),
  system: new Set([]),  // system role writes only to extracted_device_draft (enforced by RLS)
}

export function can(role: Role, action: Action): boolean {
  return PERMISSIONS[role]?.has(action) ?? false
}
