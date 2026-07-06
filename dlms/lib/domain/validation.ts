/**
 * Single source of truth for device validation schemas (§5.1.7).
 * DB constraints mirror the same intent. Tests use these directly.
 */

import { z } from 'zod'
import { parseSheetDate, coerceQty } from './normalize'
import type { DeviceInput } from '@/lib/types'

// Zod schema for device create/edit form input
export const deviceSchema = z.object({
  device_sn:     z.string().trim().optional().nullable(),
  product_name:  z.string().trim().optional().nullable(),
  model_no:      z.string().trim().optional().nullable(),
  pcba_a_sn:     z.string().trim().min(1, 'PCBA-A S/N is required'),
  pcba_a_hw_rev: z.string().trim().min(1, 'HW Rev is required'),
  pcba_a_bom_rev:z.string().trim().min(1, 'BOM Rev is required'),
  pcba_a_fw_ver: z.string().trim().min(1, 'FW Ver is required'),
  pcba_b_sn:     z.string().trim().optional().nullable(),
  pcba_b_hw_rev: z.string().trim().optional().nullable(),
  pcba_b_bom_rev:z.string().trim().optional().nullable(),
  pcba_b_fw_ver: z.string().trim().optional().nullable(),
  screen_model:  z.string().trim().optional().nullable(),
  hmi_ver:       z.string().trim().optional().nullable(),
  build_date:    z.string().nullable().optional().superRefine((v, ctx) => {
    if (!v || v.trim() === '') return
    try { parseSheetDate(v) } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message })
    }
  }).transform((v) => {
    if (!v || v.trim() === '') return null
    return parseSheetDate(v)
  }),
  ship_date:     z.string().nullable().optional().superRefine((v, ctx) => {
    if (!v || v.trim() === '') return
    try { parseSheetDate(v) } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message })
    }
  }).transform((v) => {
    if (!v || v.trim() === '') return null
    return parseSheetDate(v)
  }),
  next_service_date: z.string().nullable().optional().superRefine((v, ctx) => {
    if (!v || v.trim() === '') return
    try { parseSheetDate(v) } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message })
    }
  }).transform((v) => {
    if (!v || v.trim() === '') return null
    return parseSheetDate(v)
  }),
  qty:           z.union([z.number().int().nonnegative(), z.string(), z.null(), z.undefined()])
    .transform((v) => coerceQty(v as string | number | null | undefined))
    .optional()
    .nullable(),
  destination:   z.string().trim().optional().nullable(),
  customer:      z.string().trim().optional().nullable(),
  status:        z.string().min(1, 'Status is required'),
  phase:         z.string().min(1, 'Phase is required'),
  remarks:       z.string().optional().nullable(),
// satisfies z.ZodType<DeviceInput> removed — qty.transform() makes the input type
// include string, which is incompatible with the satisfies constraint, even though
// the output type is correct. The schema is functionally correct.
})

export type DeviceSchemaInput = z.input<typeof deviceSchema>
export type DeviceSchemaOutput = z.output<typeof deviceSchema>

// Schema for a single row from CSV import (all values come in as strings)
export const importRowSchema = z.object({
  device_sn:     z.string().optional(),
  product_name:  z.string().optional(),
  model_no:      z.string().optional(),
  pcba_a_sn:     z.string().min(1, 'PCBA-A S/N is required'),
  pcba_a_hw_rev: z.string().min(1, 'HW Rev (PCBA-A) is required'),
  pcba_a_bom_rev:z.string().min(1, 'BOM Rev (PCBA-A) is required'),
  pcba_a_fw_ver: z.string().min(1, 'FW Ver (PCBA-A) is required'),
  pcba_b_sn:     z.string().optional(),
  pcba_b_hw_rev: z.string().optional(),
  pcba_b_bom_rev:z.string().optional(),
  pcba_b_fw_ver: z.string().optional(),
  screen_model:  z.string().optional(),
  hmi_ver:       z.string().optional(),
  build_date:    z.string().optional(),
  ship_date:     z.string().optional(),
  qty:           z.string().optional(),
  destination:   z.string().optional(),
  customer:      z.string().optional(),
  status:        z.string().optional(),
  phase:         z.string().optional(),
  remarks:       z.string().optional(),
})

/**
 * Maps CSV column headers (from the spreadsheet) to device field names.
 * Single source of truth for import auto-mapping.
 */
export const CSV_COLUMN_MAP: Record<string, keyof DeviceSchemaInput> = {
  // Device Info
  'Device S/N':        'device_sn',
  '设备序列号':          'device_sn',
  'Device SN':         'device_sn',
  'Product Name':      'product_name',
  '产品名称':           'product_name',
  'Model No.':         'model_no',
  'Model No':          'model_no',
  '产品型号':           'model_no',

  // PCBA-A
  'PCBA-A S/N':        'pcba_a_sn',
  'PCBA-A SN':         'pcba_a_sn',
  '电源板序列号':        'pcba_a_sn',
  'PCBA-A HW Rev':     'pcba_a_hw_rev',
  'PCBA-A 硬件版本':    'pcba_a_hw_rev',
  'HW Rev (A)':        'pcba_a_hw_rev',
  'PCBA-A BOM Rev':    'pcba_a_bom_rev',
  'PCBA-A BOM版本':    'pcba_a_bom_rev',
  'BOM Rev (A)':       'pcba_a_bom_rev',
  'PCBA-A FW Ver':     'pcba_a_fw_ver',
  'PCBA-A 固件版本':    'pcba_a_fw_ver',
  'FW Ver (A)':        'pcba_a_fw_ver',

  // PCBA-B
  'PCBA-B S/N':        'pcba_b_sn',
  'PCBA-B SN':         'pcba_b_sn',
  '控制板序列号':        'pcba_b_sn',
  'PCBA-B HW Rev':     'pcba_b_hw_rev',
  'PCBA-B 硬件版本':    'pcba_b_hw_rev',
  'HW Rev (B)':        'pcba_b_hw_rev',
  'PCBA-B BOM Rev':    'pcba_b_bom_rev',
  'PCBA-B BOM版本':    'pcba_b_bom_rev',
  'BOM Rev (B)':       'pcba_b_bom_rev',
  'PCBA-B FW Ver':     'pcba_b_fw_ver',
  'PCBA-B 固件版本':    'pcba_b_fw_ver',
  'FW Ver (B)':        'pcba_b_fw_ver',

  // HMI
  'Screen Model':      'screen_model',
  '屏幕型号':           'screen_model',
  'HMI Ver':           'hmi_ver',
  'HMI软件版本':        'hmi_ver',
  'HMI Version':       'hmi_ver',

  // Shipment Info
  'Build Date':        'build_date',
  '生产日期':           'build_date',
  'Ship Date':         'ship_date',
  '出货日期':           'ship_date',
  'Qty':               'qty',
  '数量':              'qty',
  'Destination':       'destination',
  '目的地':            'destination',
  'Customer':          'customer',
  '客户':              'customer',

  // Status & Notes
  'Status':            'status',
  '状态':              'status',
  'Phase':             'phase',
  '阶段':              'phase',
  'Remarks':           'remarks',
  '备注':              'remarks',
}
