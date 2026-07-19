/**
 * The authorization vocabulary and the spec §3.2 matrix, as executable data.
 *
 * PERMISSION_MATRIX is the source of truth the seed is CHECKED AGAINST — it does
 * not grant anything at runtime (the DB does). Keeping the spec table here in
 * code is what lets __tests__/integration/seedMatrix.test.ts fail loudly when
 * the live seed drifts from the design document.
 */
export const PERMISSIONS = [
  'view_records', 'create_records', 'edit_records', 'delete_records', 'restore_records',
  'change_device_status', 'assign_tasks', 'approve_requests', 'sign_off_repairs',
  'upload_files', 'download_files', 'export_data', 'import_data', 'view_finance',
  'manage_finance', 'view_buyer_details', 'log_usage_service', 'view_audit_record',
  'view_full_audit', 'manage_users', 'manage_roles_permissions', 'manage_vocabularies',
  'manage_settings', 'request_full_export',
] as const
export type Permission = (typeof PERMISSIONS)[number]

export const MODULES = [
  'engineering', 'finance', 'logistics', 'manufacturing', 'maintenance', 'tasks', 'admin',
] as const
export type ModuleKey = (typeof MODULES)[number]

export const ROLES = ['super_admin', 'admin', 'manager', 'operator', 'finance', 'viewer'] as const
export type RoleKey = (typeof ROLES)[number]

export type Actor = {
  id: string
  roleKey: RoleKey
  /** Role grants + overrides, already resolved. */
  permissions: ReadonlySet<Permission>
  moduleAccess: ReadonlySet<ModuleKey>
  active: boolean
}

export const PERMISSION_MATRIX: Record<RoleKey, readonly Permission[]> = {
  super_admin: PERMISSIONS,
  admin: [
    'view_records', 'create_records', 'edit_records', 'delete_records', 'restore_records',
    'change_device_status', 'assign_tasks', 'approve_requests', 'sign_off_repairs',
    'upload_files', 'download_files', 'export_data', 'import_data', 'view_finance',
    'manage_finance', 'view_buyer_details', 'log_usage_service', 'view_audit_record',
    'view_full_audit', 'manage_vocabularies',
  ],
  manager: [
    'view_records', 'create_records', 'edit_records', 'delete_records',
    'change_device_status', 'assign_tasks', 'approve_requests', 'sign_off_repairs',
    'upload_files', 'download_files', 'export_data', 'import_data', 'view_finance',
    'view_buyer_details', 'log_usage_service', 'view_audit_record',
  ],
  operator: [
    'view_records', 'create_records', 'edit_records', 'change_device_status',
    'assign_tasks', 'upload_files', 'download_files', 'view_buyer_details',
    'log_usage_service', 'view_audit_record',
  ],
  finance: [
    'view_records', 'create_records', 'edit_records', 'assign_tasks', 'upload_files',
    'download_files', 'export_data', 'view_finance', 'manage_finance',
    'view_buyer_details', 'view_audit_record',
  ],
  viewer: ['view_records', 'download_files'],
}
