/**
 * Single source of truth for bilingual field and group labels (§5.1.9).
 * Used by device detail sections, form, list columns, and CSV export headers.
 */

export type BilingualLabel = { en: string; zh: string }

export const GROUP_LABELS: Array<{
  key: string
  en: string
  zh: string
  fields: string[]
}> = [
  {
    key: 'device_info',
    en: 'Device Info',
    zh: '设备信息',
    fields: ['device_sn', 'product_name', 'model_no'],
  },
  {
    key: 'pcba_a',
    en: 'PCBA-A · Amplifier Board',
    zh: '电源板',
    fields: ['pcba_a_sn', 'pcba_a_hw_rev', 'pcba_a_bom_rev', 'pcba_a_fw_ver'],
  },
  {
    key: 'pcba_b',
    en: 'PCBA-B · Accessory Board',
    zh: '控制板',
    fields: ['pcba_b_sn', 'pcba_b_hw_rev', 'pcba_b_bom_rev', 'pcba_b_fw_ver'],
  },
  {
    key: 'hmi',
    en: 'HMI Screen',
    zh: '触摸屏',
    fields: ['screen_model', 'hmi_ver'],
  },
  {
    key: 'shipment',
    en: 'Shipment Info',
    zh: '出货信息',
    fields: ['build_date', 'ship_date', 'qty', 'destination', 'customer'],
  },
  {
    key: 'status_notes',
    en: 'Status & Notes',
    zh: '状态',
    fields: ['status', 'phase', 'remarks'],
  },
]

export const FIELD_LABELS: Record<string, BilingualLabel> = {
  device_sn:      { en: 'Device S/N',    zh: '设备序列号' },
  product_name:   { en: 'Product Name',  zh: '产品名称' },
  model_no:       { en: 'Model No.',     zh: '产品型号' },
  pcba_a_sn:      { en: 'PCBA-A S/N',   zh: '电源板序列号' },
  pcba_a_hw_rev:  { en: 'HW Rev',       zh: '硬件版本' },
  pcba_a_bom_rev: { en: 'BOM Rev',      zh: 'BOM版本' },
  pcba_a_fw_ver:  { en: 'FW Ver',       zh: '固件版本' },
  pcba_b_sn:      { en: 'PCBA-B S/N',   zh: '控制板序列号' },
  pcba_b_hw_rev:  { en: 'HW Rev',       zh: '硬件版本' },
  pcba_b_bom_rev: { en: 'BOM Rev',      zh: 'BOM版本' },
  pcba_b_fw_ver:  { en: 'FW Ver',       zh: '固件版本' },
  screen_model:   { en: 'Screen Model', zh: '屏幕型号' },
  hmi_ver:        { en: 'HMI Ver',      zh: 'HMI软件版本' },
  build_date:     { en: 'Build Date',   zh: '生产日期' },
  ship_date:       { en: 'Ship Date',       zh: '出货日期' },
  warranty_expiry: { en: 'Warranty Expiry', zh: '保修到期' },
  qty:             { en: 'Qty',             zh: '数量' },
  destination:    { en: 'Destination',  zh: '目的地' },
  customer:       { en: 'Customer',     zh: '客户' },
  status:         { en: 'Status',       zh: '状态' },
  phase:          { en: 'Phase',        zh: '阶段' },
  remarks:        { en: 'Remarks',      zh: '备注' },
}

export const ANALYTICS_LABELS: Record<string, { en: string; zh: string }> = {
  overview:          { en: 'Overview',             zh: '概览' },
  throughput:        { en: 'Throughput',            zh: '吞吐量' },
  bottlenecks:       { en: 'Bottlenecks',           zh: '瓶颈分析' },
  transitions:       { en: 'Status Transitions',    zh: '状态转换' },
  engineer_activity: { en: 'Engineer Activity',     zh: '工程师活动' },
  my_queue:          { en: 'My Queue',              zh: '我的队列' },
  devices_created:   { en: 'Devices Created',       zh: '新增设备' },
  devices_completed: { en: 'Devices Completed',     zh: '完成设备' },
  avg_days:          { en: 'Avg Days',              zh: '平均天数' },
  median_days:       { en: 'Median Days',           zh: '中位天数' },
  stale_days:        { en: 'Days Since Update',     zh: '距上次更新天数' },
  range_7d:          { en: 'Last 7 days',           zh: '最近7天' },
  range_30d:         { en: 'Last 30 days',          zh: '最近30天' },
  range_90d:         { en: 'Last 90 days',          zh: '最近90天' },
}

/** CSV export headers — bilingual: "English (中文)" */
export const CSV_EXPORT_HEADERS: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_LABELS).map(([key, { en, zh }]) => [key, `${en} (${zh})`])
)
