'use client'
import { useTransition, useState } from 'react'
import Link from 'next/link'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { StatusBadge, PhaseBadge } from './DeviceStatusBadge'
import { Search, Download, ChevronLeft, ChevronRight, Plus, Pencil } from 'lucide-react'
import { createDeviceRowAction, updateDeviceRowAction } from '@/app/devices/actions'
import { GROUP_LABELS, FIELD_LABELS } from '@/lib/i18n/fields'
import type { DeviceRow, StatusOption, PhaseOption, DeviceInput } from '@/lib/types'
import { can, ACTIONS } from '@/lib/auth/permissions'
import type { Role } from '@/lib/types'

interface DeviceTableProps {
  devices: DeviceRow[]
  total: number
  page: number
  pageSize: number
  statuses: StatusOption[]
  phases: PhaseOption[]
  customers: string[]
  userRole: Role
  initialSearch?: string
  initialStatus?: string
  initialPhase?: string
  initialCustomer?: string
}

const SECTION = {
  device:   { bg: 'bg-[#2B7A8C]',  border: 'border-[#1E5E6E]' },
  pcbaA:    { bg: 'bg-[#3B5BA5]',  border: 'border-[#2D4580]' },
  pcbaB:    { bg: 'bg-[#4A7C3F]',  border: 'border-[#376030]' },
  hmi:      { bg: 'bg-[#C87941]',  border: 'border-[#A05E30]' },
  shipment: { bg: 'bg-[#7A7A2A]',  border: 'border-[#5C5C1E]' },
  status:   { bg: 'bg-[#8B3030]',  border: 'border-[#6B2020]' },
} as const
type Section = keyof typeof SECTION

const GROUP_SECTION: Record<string, Section> = {
  device_info:  'device',
  pcba_a:       'pcbaA',
  pcba_b:       'pcbaB',
  hmi:          'hmi',
  shipment:     'shipment',
  status_notes: 'status',
}

function GroupTh({ label, sub, colSpan, section }: { label: string; sub?: string; colSpan: number; section: Section }) {
  const { bg, border } = SECTION[section]
  return (
    <th colSpan={colSpan} className={`${bg} text-white text-center text-xs font-semibold px-2 py-1.5 border-b-2 ${border} whitespace-nowrap`}>
      {label}
      {sub && <span className="block text-[10px] font-normal opacity-80">{sub}</span>}
    </th>
  )
}

function ColTh({ children, section, right }: { children: React.ReactNode; section: Section; right?: boolean }) {
  const { bg } = SECTION[section]
  return (
    <th className={`${bg} text-white text-xs font-medium px-2 py-1.5 border-r border-white/20 whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}>
      {children}
    </th>
  )
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={`px-2 py-1.5 text-xs border-r border-border last:border-r-0 align-top ${className}`}>
      {children}
    </td>
  )
}

const EMPTY: DeviceInput = {
  device_sn: '', product_name: '', model_no: '',
  pcba_a_sn: '', pcba_a_hw_rev: '', pcba_a_bom_rev: '', pcba_a_fw_ver: '',
  pcba_b_sn: '', pcba_b_hw_rev: '', pcba_b_bom_rev: '', pcba_b_fw_ver: '',
  screen_model: '', hmi_ver: '',
  build_date: '', ship_date: '', qty: null, destination: '', customer: '',
  status: '', phase: '', remarks: '',
}

function deviceToInput(d: DeviceRow): DeviceInput {
  return {
    device_sn: d.device_sn ?? '',
    product_name: d.product_name ?? '',
    model_no: d.model_no ?? '',
    pcba_a_sn: d.pcba_a_sn,
    pcba_a_hw_rev: d.pcba_a_hw_rev,
    pcba_a_bom_rev: d.pcba_a_bom_rev,
    pcba_a_fw_ver: d.pcba_a_fw_ver,
    pcba_b_sn: d.pcba_b_sn ?? '',
    pcba_b_hw_rev: d.pcba_b_hw_rev ?? '',
    pcba_b_bom_rev: d.pcba_b_bom_rev ?? '',
    pcba_b_fw_ver: d.pcba_b_fw_ver ?? '',
    screen_model: d.screen_model ?? '',
    hmi_ver: d.hmi_ver ?? '',
    build_date: d.build_date ?? '',
    ship_date: d.ship_date ?? '',
    qty: d.qty ?? null,
    destination: d.destination ?? '',
    customer: d.customer ?? '',
    status: d.status,
    phase: d.phase,
    remarks: d.remarks ?? '',
  }
}

function n(v: string | null | undefined) { return v || '—' }
function nv(v: string) { return v === '' ? null : v }

const SELECT_CLASS =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm ' +
  'focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

function FieldControl({
  fieldKey, data, onChange, statuses, phases,
}: {
  fieldKey: string
  data: DeviceInput
  onChange: (f: keyof DeviceInput, v: string | number | null) => void
  statuses: StatusOption[]
  phases: PhaseOption[]
}) {
  const raw = data[fieldKey as keyof DeviceInput]
  const strVal = raw == null ? '' : String(raw)

  if (fieldKey === 'status') {
    return (
      <select
        value={strVal}
        onChange={e => onChange('status', e.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">Select status…</option>
        {statuses.map(s => (
          <option key={s.code} value={s.code}>{s.label_en} · {s.label_zh}</option>
        ))}
      </select>
    )
  }
  if (fieldKey === 'phase') {
    return (
      <select
        value={strVal}
        onChange={e => onChange('phase', e.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">Select phase…</option>
        {phases.map(p => (
          <option key={p.code} value={p.code}>{p.label_en} · {p.label_zh}</option>
        ))}
      </select>
    )
  }
  if (fieldKey === 'remarks') {
    return (
      <Textarea
        value={strVal}
        onChange={e => onChange('remarks', e.target.value)}
        rows={3}
      />
    )
  }
  if (fieldKey === 'qty') {
    return (
      <Input
        type="number"
        value={raw == null ? '' : String(raw)}
        onChange={e => onChange('qty', e.target.value === '' ? null : parseInt(e.target.value) || null)}
      />
    )
  }
  if (fieldKey === 'build_date' || fieldKey === 'ship_date') {
    return (
      <Input
        type="date"
        value={strVal}
        onChange={e => onChange(fieldKey as keyof DeviceInput, e.target.value)}
      />
    )
  }
  return (
    <Input
      value={strVal}
      onChange={e => onChange(fieldKey as keyof DeviceInput, e.target.value)}
    />
  )
}

function DeviceFormModal({
  open, isNew, data, statuses, phases, saving, rowError, onSave, onCancel, onChange,
}: {
  open: boolean
  isNew: boolean
  data: DeviceInput
  statuses: StatusOption[]
  phases: PhaseOption[]
  saving: boolean
  rowError: string | null
  onSave: () => void
  onCancel: () => void
  onChange: (field: keyof DeviceInput, value: string | number | null) => void
}) {
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel() }}>
      <DialogContent style={{ maxWidth: '56rem' }} className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isNew ? 'New Device' : 'Edit Device'}</DialogTitle>
          <p className="text-sm text-muted-foreground">{isNew ? '新增设备' : '编辑设备'}</p>
        </DialogHeader>

        <div className="space-y-5">
          {GROUP_LABELS.map(group => {
            const sectionKey = GROUP_SECTION[group.key] ?? 'device'
            const { bg } = SECTION[sectionKey]
            return (
              <section key={group.key}>
                <div className={`${bg} text-white text-xs font-semibold px-3 py-1.5 rounded-t`}>
                  {group.en}&nbsp;<span className="opacity-75 font-normal">{group.zh}</span>
                </div>
                <div className="border border-t-0 rounded-b p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {group.fields.map(fieldKey => {
                    const label = FIELD_LABELS[fieldKey]
                    return (
                      <div key={fieldKey} className={fieldKey === 'remarks' ? 'sm:col-span-2' : ''}>
                        <Label className="flex flex-col gap-0.5 mb-1.5">
                          <span className="text-sm font-medium">{label?.en ?? fieldKey}</span>
                          <span className="text-xs font-normal text-muted-foreground">{label?.zh}</span>
                        </Label>
                        <FieldControl
                          fieldKey={fieldKey}
                          data={data}
                          onChange={onChange}
                          statuses={statuses}
                          phases={phases}
                        />
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>

        {rowError && (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded px-3 py-2">
            {rowError}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={onSave}
            disabled={saving}
            className="bg-green-600 hover:bg-green-700 text-white"
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DeviceTable({
  devices, total, page, pageSize, statuses, phases, customers, userRole,
  initialSearch = '', initialStatus = '', initialPhase = '', initialCustomer = '',
}: DeviceTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [, startTransition] = useTransition()

  const canEdit = can(userRole, ACTIONS.EDIT_DEVICE)
  const canCreate = can(userRole, ACTIONS.CREATE_DEVICE)

  const [editingId, setEditingId] = useState<string | 'new' | null>(null)
  const [editData, setEditData] = useState<DeviceInput>(EMPTY)
  const [editVersion, setEditVersion] = useState(1)
  const [saving, setSaving] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)

  function updateParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (value) params.set(key, value); else params.delete(key)
    params.set('page', '1')
    startTransition(() => router.push(`${pathname}?${params.toString()}`))
  }

  function goToPage(newPage: number) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('page', String(newPage))
    startTransition(() => router.push(`${pathname}?${params.toString()}`))
  }

  function startEdit(device: DeviceRow) {
    setEditingId(device.id)
    setEditData(deviceToInput(device))
    setEditVersion(device.version)
    setRowError(null)
  }

  function startNew() {
    setEditingId('new')
    setEditData({ ...EMPTY })
    setRowError(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setRowError(null)
  }

  function handleChange(field: keyof DeviceInput, value: string | number | null) {
    setEditData(prev => ({ ...prev, [field]: value }))
  }

  async function handleSave() {
    setSaving(true)
    setRowError(null)
    try {
      const payload: DeviceInput = {
        ...editData,
        device_sn: nv(editData.device_sn as string),
        product_name: nv(editData.product_name as string),
        model_no: nv(editData.model_no as string),
        pcba_b_sn: nv(editData.pcba_b_sn as string),
        pcba_b_hw_rev: nv(editData.pcba_b_hw_rev as string),
        pcba_b_bom_rev: nv(editData.pcba_b_bom_rev as string),
        pcba_b_fw_ver: nv(editData.pcba_b_fw_ver as string),
        screen_model: nv(editData.screen_model as string),
        hmi_ver: nv(editData.hmi_ver as string),
        build_date: nv(editData.build_date as string),
        ship_date: nv(editData.ship_date as string),
        destination: nv(editData.destination as string),
        customer: nv(editData.customer as string),
        remarks: nv(editData.remarks as string),
      }

      if (editingId === 'new') {
        const res = await createDeviceRowAction(payload)
        if ('error' in res) { setRowError(res.error); return }
      } else {
        const res = await updateDeviceRowAction(editingId!, payload, editVersion)
        if ('error' in res) { setRowError(res.error); return }
      }
      setEditingId(null)
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  const totalPages = Math.ceil(total / pageSize)

  const actionsCol = canEdit ? (
    <ColTh section="status"><span className="sr-only">Actions</span></ColTh>
  ) : null

  return (
    <div className="space-y-4">
      {/* Modal editor */}
      <DeviceFormModal
        open={editingId !== null}
        isNew={editingId === 'new'}
        data={editData}
        statuses={statuses}
        phases={phases}
        saving={saving}
        rowError={rowError}
        onSave={handleSave}
        onCancel={cancelEdit}
        onChange={handleChange}
      />

      {/* Toolbar */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by S/N or customer..."
            defaultValue={initialSearch}
            onChange={(e) => updateParam('q', e.target.value)}
            className="pl-8"
          />
        </div>
        <Select defaultValue={initialStatus || '_all'} onValueChange={(v) => updateParam('status', v === '_all' ? '' : v)}>
          <SelectTrigger className="w-36"><SelectValue placeholder="All Statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All Statuses</SelectItem>
            {statuses.map((s) => <SelectItem key={s.code} value={s.code}>{s.label_en}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select defaultValue={initialPhase || '_all'} onValueChange={(v) => updateParam('phase', v === '_all' ? '' : v)}>
          <SelectTrigger className="w-28"><SelectValue placeholder="All Phases" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All Phases</SelectItem>
            {phases.map((p) => <SelectItem key={p.code} value={p.code}>{p.label_en}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select defaultValue={initialCustomer || '_all'} onValueChange={(v) => updateParam('customer', v === '_all' ? '' : v)}>
          <SelectTrigger className="w-36"><SelectValue placeholder="All Customers" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All Customers</SelectItem>
            {customers.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="ml-auto flex gap-2">
          <Link href={`/devices/export?${searchParams.toString()}`}>
            <Button variant="outline" size="sm">
              <Download className="h-4 w-4 mr-1" />Export CSV
            </Button>
          </Link>
          {canCreate && (
            <Button size="sm" onClick={startNew}>
              <Plus className="h-4 w-4 mr-1" />New Row
            </Button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-md border overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <GroupTh label="设备信息" sub="Device Info"              colSpan={3} section="device" />
              <GroupTh label="PCBA-A (电源板 Amplifier Board)"         colSpan={4} section="pcbaA" />
              <GroupTh label="PCBA-B (控制板 Accessory Board)"         colSpan={4} section="pcbaB" />
              <GroupTh label="HMI Screen 触摸屏"                        colSpan={2} section="hmi" />
              <GroupTh label="出货信息" sub="Shipment Info"             colSpan={5} section="shipment" />
              <GroupTh label="状态 Status & Notes" colSpan={canEdit ? 4 : 3} section="status" />
            </tr>
            <tr>
              <ColTh section="device">Device S/N<br /><span className="opacity-70">设备序列号</span></ColTh>
              <ColTh section="device">Product Name<br /><span className="opacity-70">产品名称</span></ColTh>
              <ColTh section="device">Model No.<br /><span className="opacity-70">产品型号</span></ColTh>
              <ColTh section="pcbaA">PCBA-A S/N<br /><span className="opacity-70">序列号</span></ColTh>
              <ColTh section="pcbaA">HW Rev<br /><span className="opacity-70">硬件版本</span></ColTh>
              <ColTh section="pcbaA">BOM Rev<br /><span className="opacity-70">物料版本</span></ColTh>
              <ColTh section="pcbaA">FW Ver<br /><span className="opacity-70">固件版本</span></ColTh>
              <ColTh section="pcbaB">PCBA-B S/N<br /><span className="opacity-70">序列号</span></ColTh>
              <ColTh section="pcbaB">HW Rev<br /><span className="opacity-70">硬件版本</span></ColTh>
              <ColTh section="pcbaB">BOM Rev<br /><span className="opacity-70">物料版本</span></ColTh>
              <ColTh section="pcbaB">FW Ver<br /><span className="opacity-70">固件版本</span></ColTh>
              <ColTh section="hmi">Screen Model<br /><span className="opacity-70">屏幕</span></ColTh>
              <ColTh section="hmi">HMI Ver<br /><span className="opacity-70">HMI软件</span></ColTh>
              <ColTh section="shipment">Build Date<br /><span className="opacity-70">生产日期</span></ColTh>
              <ColTh section="shipment">Ship Date<br /><span className="opacity-70">出货日期</span></ColTh>
              <ColTh section="shipment" right>Qty<br /><span className="opacity-70">量</span></ColTh>
              <ColTh section="shipment">Destination<br /><span className="opacity-70">目的地</span></ColTh>
              <ColTh section="shipment">Customer<br /><span className="opacity-70">客户</span></ColTh>
              <ColTh section="status">Status<br /><span className="opacity-70">状态</span></ColTh>
              <ColTh section="status">Phase<br /><span className="opacity-70">阶段</span></ColTh>
              <ColTh section="status">Remarks<br /><span className="opacity-70">备注</span></ColTh>
              {canEdit && <ColTh section="status"><span className="sr-only">Edit</span></ColTh>}
            </tr>
          </thead>
          <tbody>
            {devices.length === 0 ? (
              <tr>
                <td colSpan={canEdit ? 22 : 21} className="text-center text-muted-foreground py-8">
                  No devices found.
                </td>
              </tr>
            ) : (
              devices.map((device, i) => (
                <tr key={device.id} className={`${i % 2 === 0 ? 'bg-white' : 'bg-muted/30'} group`}>
                  <Td>
                    <Link href={`/devices/${device.id}`} className="font-mono hover:underline text-blue-700">
                      {n(device.device_sn)}
                    </Link>
                  </Td>
                  <Td>{n(device.product_name)}</Td>
                  <Td className="font-mono">{n(device.model_no)}</Td>
                  <Td className="font-mono">{n(device.pcba_a_sn)}</Td>
                  <Td className="font-mono">{n(device.pcba_a_hw_rev)}</Td>
                  <Td className="font-mono">{n(device.pcba_a_bom_rev)}</Td>
                  <Td className="font-mono">{n(device.pcba_a_fw_ver)}</Td>
                  <Td className="font-mono">{n(device.pcba_b_sn)}</Td>
                  <Td className="font-mono">{n(device.pcba_b_hw_rev)}</Td>
                  <Td className="font-mono">{n(device.pcba_b_bom_rev)}</Td>
                  <Td className="font-mono">{n(device.pcba_b_fw_ver)}</Td>
                  <Td>{n(device.screen_model)}</Td>
                  <Td>{n(device.hmi_ver)}</Td>
                  <Td className="tabular-nums">{n(device.build_date)}</Td>
                  <Td className="tabular-nums">{n(device.ship_date)}</Td>
                  <Td className="tabular-nums text-right">{device.qty ?? '—'}</Td>
                  <Td>{n(device.destination)}</Td>
                  <Td>{n(device.customer)}</Td>
                  <Td><StatusBadge status={device.status} /></Td>
                  <Td><PhaseBadge phase={device.phase} /></Td>
                  <Td className="max-w-[200px] whitespace-pre-wrap">{n(device.remarks)}</Td>
                  {canEdit && (
                    <Td>
                      <button
                        onClick={() => startEdit(device)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted text-muted-foreground"
                        title="Edit row"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </Td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{total} total records</span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => goToPage(page - 1)} disabled={page <= 1}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span>Page {page} of {totalPages || 1}</span>
          <Button variant="outline" size="icon" onClick={() => goToPage(page + 1)} disabled={page >= totalPages}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
