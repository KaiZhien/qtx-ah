import type { Tables } from './database.types'

export type AppUser = Tables<'app_user'>
export type DeviceRow = Tables<'device'>
export type StatusOption = Tables<'status_option'>
export type PhaseOption = Tables<'phase_option'>
export type AuditLogRow = Tables<'audit_log'>
export type ExtractedDeviceDraft = Tables<'extracted_device_draft'>

export type Role = 'viewer' | 'engineer' | 'admin' | 'system'

export type DeviceInput = {
  device_sn?: string | null
  product_name?: string | null
  model_no?: string | null
  pcba_a_sn: string
  pcba_a_hw_rev: string
  pcba_a_bom_rev: string
  pcba_a_fw_ver: string
  pcba_b_sn?: string | null
  pcba_b_hw_rev?: string | null
  pcba_b_bom_rev?: string | null
  pcba_b_fw_ver?: string | null
  screen_model?: string | null
  hmi_ver?: string | null
  build_date?: string | null
  ship_date?: string | null
  qty?: number | null
  destination?: string | null
  customer?: string | null
  status: string
  phase: string
  remarks?: string | null
}

export type ImportPreviewRow = {
  rowIndex: number
  raw: Record<string, string>
  valid: boolean
  errors: string[]
  parsed?: DeviceInput
}

export type DeviceStats = {
  totalDevices: number
  totalUnits: number
  byStatus: Record<string, number>
  byPhase: Record<string, number>
  byCustomer: Record<string, number>
}

export type ListDevicesParams = {
  search?: string
  status?: string
  phase?: string
  customer?: string
  model?: string
  buildDateFrom?: string
  buildDateTo?: string
  shipDateFrom?: string
  shipDateTo?: string
  sort?: string
  dir?: string
  page?: number
  pageSize?: number
  includeDeleted?: boolean
}

export type AuditEntry = {
  id: string
  actor_id: string | null
  actor_email?: string | null
  action: string
  table_name: string
  row_id: string
  old_values: Record<string, unknown> | null
  new_values: Record<string, unknown>
  changed_columns: string[]
  request_id: string | null
  occurred_at: string
}

// Typed error variants for service layer
export type ConflictError = { type: 'conflict'; message: string }
export type PermissionError = { type: 'permission'; message: string }
export type ValidationError = { type: 'validation'; message: string; errors: Record<string, string[]> }
export type ServiceError = ConflictError | PermissionError | ValidationError

export class AppError extends Error {
  constructor(public readonly serviceError: ServiceError) {
    super(serviceError.message)
    this.name = 'AppError'
  }
}
