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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { StatusBadge, PhaseBadge } from './DeviceStatusBadge'
import { Search, Download, ChevronLeft, ChevronRight, Plus, Pencil, SlidersHorizontal, ChevronUp, ChevronDown, ChevronsUpDown, X, Bookmark, BookmarkPlus, Trash2 } from 'lucide-react'
import { createDeviceRowAction, updateDeviceRowAction, bulkChangeStatusAction, bulkSoftDeleteAction } from '@/app/devices/actions'
import { listPresetsAction, savePresetAction, deletePresetAction } from '@/app/devices/presets/actions'
import { GROUP_LABELS, FIELD_LABELS } from '@/lib/i18n/fields'
import { toast } from 'sonner'
import type { DeviceRow, StatusOption, PhaseOption, DeviceInput } from '@/lib/types'
import type { FilterPreset } from '@/lib/services/filterPresetService'
import { can, ACTIONS } from '@/lib/auth/permissions'
import type { Role } from '@/lib/types'
import { allowedNextStatuses } from '@/lib/domain/statusTransitions'

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

function ColTh({
  children, section, right, sortKey, activeSort, activeDir, onSort,
}: {
  children: React.ReactNode
  section: Section
  right?: boolean
  sortKey?: string
  activeSort?: string
  activeDir?: string
  onSort?: (key: string) => void
}) {
  const { bg } = SECTION[section]
  const isActive = sortKey && activeSort === sortKey
  const SortIcon = isActive
    ? activeDir === 'asc' ? ChevronUp : ChevronDown
    : ChevronsUpDown

  return (
    <th className={`${bg} text-white text-xs font-medium px-2 py-1.5 border-r border-white/20 whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}>
      {sortKey && onSort ? (
        <button
          onClick={() => onSort(sortKey)}
          className="inline-flex items-center gap-0.5 hover:opacity-80 active:opacity-60 transition-opacity"
        >
          {children}
          <SortIcon className={`h-3 w-3 shrink-0 ${isActive ? 'opacity-100' : 'opacity-40'}`} />
        </button>
      ) : (
        children
      )}
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

/** Returns 'expired' if warranty_expiry is in the past, 'soon' if within 7 days, null otherwise */

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
  fieldKey, data, onChange, statuses, phases, currentStatus,
}: {
  fieldKey: string
  data: DeviceInput
  onChange: (f: keyof DeviceInput, v: string | number | null) => void
  statuses: StatusOption[]
  phases: PhaseOption[]
  currentStatus?: string
}) {
  const raw = data[fieldKey as keyof DeviceInput]
  const strVal = raw == null ? '' : String(raw)

  if (fieldKey === 'status') {
    // Filter statuses to only allowed transitions when we know the current status.
    const filteredStatuses = currentStatus
      ? statuses.filter(s => allowedNextStatuses(currentStatus).includes(s.code))
      : statuses

    return (
      <select
        value={strVal}
        onChange={e => onChange('status', e.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">Select status…</option>
        {filteredStatuses.map(s => (
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
  open, isNew, data, statuses, phases, saving, rowError, onSave, onCancel, onChange, currentStatus,
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
  currentStatus?: string
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
                          currentStatus={currentStatus}
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
  const canChangeStatus = can(userRole, ACTIONS.CHANGE_STATUS)
  const canDelete = can(userRole, ACTIONS.SOFT_DELETE)

  const [editingId, setEditingId] = useState<string | 'new' | null>(null)
  const [editData, setEditData] = useState<DeviceInput>(EMPTY)
  const [editVersion, setEditVersion] = useState(1)
  // Track the original status of the device being edited for transition filtering
  const [editOriginalStatus, setEditOriginalStatus] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)
  const [showFilters, setShowFilters] = useState(
    !!(searchParams.get('model') || searchParams.get('buildFrom') ||
       searchParams.get('buildTo') || searchParams.get('shipFrom') || searchParams.get('shipTo') ||
       searchParams.get('pcba_a_hw_rev') || searchParams.get('pcba_a_bom_rev') ||
       searchParams.get('pcba_a_fw_ver') || searchParams.get('pcba_b_hw_rev') ||
       searchParams.get('pcba_b_bom_rev') || searchParams.get('pcba_b_fw_ver') ||
       searchParams.get('screen_model') || searchParams.get('hmi_ver'))
  )
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBulkStatus, setShowBulkStatus] = useState(false)
  const [bulkStatusVal, setBulkStatusVal] = useState<string>('__unchanged__')
  const [bulkPhaseVal, setBulkPhaseVal] = useState<string>('__unchanged__')

  // Preset state
  const [presets, setPresets] = useState<FilterPreset[]>([])
  const [presetsLoaded, setPresetsLoaded] = useState(false)
  const [showSavePreset, setShowSavePreset] = useState(false)
  const [presetName, setPresetName] = useState('')

  // Inline editing state
  const [inlineCell, setInlineCell] = useState<{ id: string; field: keyof DeviceInput; version: number } | null>(null)
  const [inlineValue, setInlineValue] = useState<string>('')
  const [inlineSaving, setInlineSaving] = useState(false)

  const activeSort = searchParams.get('sort') ?? ''
  const activeDir  = searchParams.get('dir')  ?? ''

  function toggleSort(key: string) {
    const cur = searchParams.get('sort')
    const dir = searchParams.get('dir')
    const nextDir = cur === key && dir === 'asc' ? 'desc' : 'asc'
    const params = new URLSearchParams(searchParams.toString())
    params.set('sort', key)
    params.set('dir', nextDir)
    params.set('page', '1')
    startTransition(() => router.push(`${pathname}?${params.toString()}`))
  }

  function clearAllFilters() {
    startTransition(() => router.push(pathname))
  }

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
    setEditOriginalStatus(device.status)
    setRowError(null)
  }

  function startNew() {
    setEditingId('new')
    setEditData({ ...EMPTY })
    setEditOriginalStatus(undefined)
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
        if ('error' in res) {
          setRowError(res.error)
          toast.error(res.error)
          return
        }
        toast.success('Device created')
      } else {
        const res = await updateDeviceRowAction(editingId!, payload, editVersion)
        if ('error' in res) {
          setRowError(res.error)
          toast.error(res.error)
          return
        }
        toast.success('Device updated')
      }
      setEditingId(null)
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  // Preset handlers
  async function loadPresets() {
    if (presetsLoaded) return
    const data = await listPresetsAction()
    setPresets(data)
    setPresetsLoaded(true)
  }

  async function handleBulkDelete() {
    if (!confirm(`Soft-delete ${selectedIds.size} device(s)?`)) return
    const items = devices
      .filter(d => selectedIds.has(d.id))
      .map(d => ({ id: d.id, version: d.version }))
    const res = await bulkSoftDeleteAction(items)
    if ('error' in res) {
      setRowError(res.error)
      toast.error(res.error)
      return
    }
    if (res.conflicts.length > 0) {
      const msg = `Deleted ${res.deleted}. Failed to delete ${res.conflicts.length} device(s) — they may have already been removed.`
      setRowError(msg)
      toast.warning(`${res.conflicts.length} conflict(s) — try refreshing`)
    } else {
      toast.success(`Deleted ${res.deleted} device(s)`)
    }
    setSelectedIds(new Set())
    router.refresh()
  }

  function handleBulkExport() {
    const ids = Array.from(selectedIds).join(',')
    window.location.href = `/devices/export?ids=${encodeURIComponent(ids)}`
    toast.success('Export started')
  }

  function handleExportXlsx() {
    const params = new URLSearchParams()
    if (searchParams.get('q')) params.set('q', searchParams.get('q')!)
    if (searchParams.get('status')) params.set('status', searchParams.get('status')!)
    if (searchParams.get('phase')) params.set('phase', searchParams.get('phase')!)
    if (searchParams.get('customer')) params.set('customer', searchParams.get('customer')!)
    params.set('format', 'xlsx')
    window.open(`/devices/export?${params.toString()}`, '_blank')
    toast.success('Excel export started')
  }

  async function handleBulkStatusConfirm() {
    const items = devices
      .filter(d => selectedIds.has(d.id))
      .map(d => ({ id: d.id, version: d.version }))
    const newStatus = bulkStatusVal === '__unchanged__' ? null : bulkStatusVal
    const newPhase = bulkPhaseVal === '__unchanged__' ? null : bulkPhaseVal
    const res = await bulkChangeStatusAction(items, newStatus, newPhase)
    if ('error' in res) {
      setRowError(res.error)
      toast.error(res.error)
      return
    }
    if (res.conflicts.length > 0) {
      setRowError(`Updated ${res.updated}. ${res.conflicts.length} device(s) had conflicts and were skipped.`)
      toast.warning(`${res.conflicts.length} conflict(s) — try refreshing`)
    } else {
      toast.success(`Updated ${res.updated} device(s)`)
    }
    setShowBulkStatus(false)
    setBulkStatusVal('__unchanged__')
    setBulkPhaseVal('__unchanged__')
    setSelectedIds(new Set())
    router.refresh()
  }

  // For the bulk status dialog, compute an intersection of allowed next statuses
  // across all selected devices. Fall back to showing all statuses if complex/empty.
  const bulkAllowedStatuses: StatusOption[] = (() => {
    if (selectedIds.size === 0) return statuses
    const selectedDevices = devices.filter(d => selectedIds.has(d.id))
    if (selectedDevices.length === 0) return statuses
    const sets = selectedDevices.map(d => new Set(allowedNextStatuses(d.status)))
    const intersection = statuses.filter(s => sets.every(set => set.has(s.code)))
    return intersection.length > 0 ? intersection : statuses
  })()

  const actionsCol = canEdit ? (
    <ColTh section="status"><span className="sr-only">Actions</span></ColTh>
  ) : null

  async function handleSavePreset() {
    const qs = searchParams.toString()
    if (!presetName.trim()) return
    const result = await savePresetAction(presetName.trim(), qs)
    if ('error' in result) {
      toast.error(result.error)
    } else {
      setPresets(p => [result.preset, ...p])
      toast.success('Filter preset saved')
    }
    setPresetName('')
    setShowSavePreset(false)
  }

  async function handleDeletePreset(id: string) {
    const result = await deletePresetAction(id)
    if ('error' in result) {
      toast.error(result.error)
    } else {
      setPresets(p => p.filter(x => x.id !== id))
      toast.success('Preset deleted')
    }
  }

  function applyPreset(queryString: string) {
    startTransition(() => router.push(`${pathname}?${queryString}`))
  }

  function startInlineEdit(device: DeviceRow, field: keyof DeviceInput) {
    if (!canEdit) return
    const cur = (device as Record<string, unknown>)[field as string]
    setInlineCell({ id: device.id, field, version: device.version })
    setInlineValue(cur == null ? '' : String(cur))
  }

  async function commitInlineEdit() {
    if (!inlineCell) return
    setInlineSaving(true)
    try {
      const patch: Partial<DeviceInput> = { [inlineCell.field]: inlineValue === '' ? null : inlineValue }
      const result = await updateDeviceRowAction(inlineCell.id, patch as DeviceInput, inlineCell.version)
      if ('error' in result) {
        toast.error(result.error)
      } else {
        toast.success('Saved')
        router.refresh()
      }
    } finally {
      setInlineSaving(false)
      setInlineCell(null)
    }
  }

  const totalPages = Math.ceil(total / pageSize)

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
        currentStatus={editOriginalStatus}
      />

      {/* Bulk status dialog */}
      <Dialog open={showBulkStatus} onOpenChange={o => { if (!o) { setShowBulkStatus(false); setBulkStatusVal('__unchanged__'); setBulkPhaseVal('__unchanged__') } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Status / Phase</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">{selectedIds.size} device(s) selected. Choose values to apply — leave "Unchanged" to keep each device&apos;s current value.</p>
            <div className="space-y-2">
              <Label>Status</Label>
              <select
                value={bulkStatusVal}
                onChange={e => setBulkStatusVal(e.target.value)}
                className={SELECT_CLASS}
              >
                <option value="__unchanged__">— Unchanged —</option>
                {bulkAllowedStatuses.map(s => (
                  <option key={s.code} value={s.code}>{s.label_en} · {s.label_zh}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Phase</Label>
              <select
                value={bulkPhaseVal}
                onChange={e => setBulkPhaseVal(e.target.value)}
                className={SELECT_CLASS}
              >
                <option value="__unchanged__">— Unchanged —</option>
                {phases.map(p => (
                  <option key={p.code} value={p.code}>{p.label_en} · {p.label_zh}</option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowBulkStatus(false); setBulkStatusVal('__unchanged__'); setBulkPhaseVal('__unchanged__') }}>
              Cancel
            </Button>
            <Button onClick={handleBulkStatusConfirm}>
              Apply to {selectedIds.size} device(s)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2 bg-blue-50 border border-blue-200 rounded-md">
          <span className="text-sm text-blue-700 font-medium">{selectedIds.size} selected</span>
          {canChangeStatus && (
            <Button size="sm" variant="outline" onClick={() => setShowBulkStatus(true)}>
              Change Status/Phase
            </Button>
          )}
          {canChangeStatus && (
            <Button size="sm" variant="outline" onClick={handleBulkExport}>
              Export Selected
            </Button>
          )}
          {canDelete && (
            <Button size="sm" variant="destructive" onClick={handleBulkDelete}>
              Delete Selected
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {/* Toolbar */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search S/N, product, model, destination, customer…"
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
          <Button
            variant={searchParams.get('myQueue') === '1' ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => updateParam('myQueue', searchParams.get('myQueue') === '1' ? '' : '1')}
          >
            My Queue
          </Button>
          <Button
            variant={showFilters ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setShowFilters(v => !v)}
          >
            <SlidersHorizontal className="h-4 w-4 mr-1" />
            Filters
          </Button>
          <DropdownMenu onOpenChange={(open) => { if (open) loadPresets() }}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Bookmark className="h-4 w-4 mr-1" />Presets
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {presets.length === 0 && !presetsLoaded && (
                <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
              )}
              {presetsLoaded && presets.length === 0 && (
                <DropdownMenuItem disabled>No saved presets</DropdownMenuItem>
              )}
              {presets.map((p) => (
                <DropdownMenuItem key={p.id} className="flex items-center justify-between group pr-1" onSelect={(e) => e.preventDefault()}>
                  <span className="truncate flex-1 cursor-pointer" onClick={() => applyPreset(p.query_string)}>{p.name}</span>
                  <Button
                    variant="ghost" size="icon" className="h-5 w-5 opacity-0 group-hover:opacity-100 ml-1 shrink-0"
                    onClick={(e) => { e.stopPropagation(); handleDeletePreset(p.id) }}
                  >
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </Button>
                </DropdownMenuItem>
              ))}
              {presets.length > 0 && <DropdownMenuSeparator />}
              {showSavePreset ? (
                <div className="px-2 py-1.5 flex gap-1">
                  <Input
                    placeholder="Preset name…"
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSavePreset(); if (e.key === 'Escape') setShowSavePreset(false) }}
                    className="h-7 text-xs flex-1"
                    autoFocus
                  />
                  <Button size="sm" className="h-7 px-2" onClick={handleSavePreset}>Save</Button>
                </div>
              ) : (
                <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setShowSavePreset(true) }}>
                  <BookmarkPlus className="h-4 w-4 mr-2" />Save current filters
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="ml-auto flex gap-2">
            <Link href={`/devices/export?${searchParams.toString()}`}>
              <Button variant="outline" size="sm">
                <Download className="h-4 w-4 mr-1" />Export CSV
              </Button>
            </Link>
            <Button variant="outline" size="sm" onClick={handleExportXlsx}>
              <Download className="h-4 w-4 mr-1" />Export Excel
            </Button>
            {canCreate && (
              <Button size="sm" onClick={startNew}>
                <Plus className="h-4 w-4 mr-1" />New Row
              </Button>
            )}
          </div>
        </div>

        {/* Advanced filters row */}
        {showFilters && (
          <div className="flex flex-wrap gap-2 items-end p-3 rounded-md border bg-muted/40">
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">Model No.</Label>
              <Input
                placeholder="e.g. QTX-200"
                defaultValue={searchParams.get('model') ?? ''}
                onChange={(e) => updateParam('model', e.target.value)}
                className="h-8 w-36 text-xs"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">Build Date From</Label>
              <Input
                type="date"
                defaultValue={searchParams.get('buildFrom') ?? ''}
                onChange={(e) => updateParam('buildFrom', e.target.value)}
                className="h-8 w-36 text-xs"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">Build Date To</Label>
              <Input
                type="date"
                defaultValue={searchParams.get('buildTo') ?? ''}
                onChange={(e) => updateParam('buildTo', e.target.value)}
                className="h-8 w-36 text-xs"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">Ship Date From</Label>
              <Input
                type="date"
                defaultValue={searchParams.get('shipFrom') ?? ''}
                onChange={(e) => updateParam('shipFrom', e.target.value)}
                className="h-8 w-36 text-xs"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">Ship Date To</Label>
              <Input
                type="date"
                defaultValue={searchParams.get('shipTo') ?? ''}
                onChange={(e) => updateParam('shipTo', e.target.value)}
                className="h-8 w-36 text-xs"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">PCBA-A HW Rev</Label>
              <Input
                placeholder="e.g. 2.1"
                defaultValue={searchParams.get('pcba_a_hw_rev') ?? ''}
                onChange={(e) => updateParam('pcba_a_hw_rev', e.target.value)}
                className="h-8 w-28 text-xs font-mono"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">PCBA-A BOM Rev</Label>
              <Input
                placeholder="e.g. A"
                defaultValue={searchParams.get('pcba_a_bom_rev') ?? ''}
                onChange={(e) => updateParam('pcba_a_bom_rev', e.target.value)}
                className="h-8 w-28 text-xs font-mono"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">PCBA-A FW Ver</Label>
              <Input
                placeholder="e.g. 1.0.0"
                defaultValue={searchParams.get('pcba_a_fw_ver') ?? ''}
                onChange={(e) => updateParam('pcba_a_fw_ver', e.target.value)}
                className="h-8 w-28 text-xs font-mono"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">PCBA-B HW Rev</Label>
              <Input
                placeholder="e.g. 1.0"
                defaultValue={searchParams.get('pcba_b_hw_rev') ?? ''}
                onChange={(e) => updateParam('pcba_b_hw_rev', e.target.value)}
                className="h-8 w-28 text-xs font-mono"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">PCBA-B BOM Rev</Label>
              <Input
                placeholder="e.g. B"
                defaultValue={searchParams.get('pcba_b_bom_rev') ?? ''}
                onChange={(e) => updateParam('pcba_b_bom_rev', e.target.value)}
                className="h-8 w-28 text-xs font-mono"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">PCBA-B FW Ver</Label>
              <Input
                placeholder="e.g. 2.0.0"
                defaultValue={searchParams.get('pcba_b_fw_ver') ?? ''}
                onChange={(e) => updateParam('pcba_b_fw_ver', e.target.value)}
                className="h-8 w-28 text-xs font-mono"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">Screen Model</Label>
              <Input
                placeholder="e.g. 7in-LCD"
                defaultValue={searchParams.get('screen_model') ?? ''}
                onChange={(e) => updateParam('screen_model', e.target.value)}
                className="h-8 w-28 text-xs font-mono"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">HMI Ver</Label>
              <Input
                placeholder="e.g. v2"
                defaultValue={searchParams.get('hmi_ver') ?? ''}
                onChange={(e) => updateParam('hmi_ver', e.target.value)}
                className="h-8 w-28 text-xs font-mono"
              />
            </div>
            <Button variant="ghost" size="sm" onClick={clearAllFilters} className="h-8 text-xs text-muted-foreground">
              <X className="h-3.5 w-3.5 mr-1" />Clear all
            </Button>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="rounded-md border overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="w-8 bg-gray-600 px-2 py-1.5" />
              <GroupTh label="设备信息" sub="Device Info"              colSpan={3} section="device" />
              <GroupTh label="PCBA-A (电源板 Amplifier Board)"         colSpan={4} section="pcbaA" />
              <GroupTh label="PCBA-B (控制板 Accessory Board)"         colSpan={4} section="pcbaB" />
              <GroupTh label="HMI Screen 触摸屏"                        colSpan={2} section="hmi" />
              <GroupTh label="出货信息" sub="Shipment Info"             colSpan={6} section="shipment" />
              <GroupTh label="状态 Status & Notes" colSpan={canEdit ? 4 : 3} section="status" />
            </tr>
            <tr>
              <th className="w-8 bg-gray-600 px-2 py-1.5 text-center">
                <input
                  type="checkbox"
                  checked={selectedIds.size === devices.length && devices.length > 0}
                  onChange={e => setSelectedIds(e.target.checked ? new Set(devices.map(d => d.id)) : new Set())}
                  className="rounded border-gray-300"
                />
              </th>
              <ColTh section="device" sortKey="device_sn" activeSort={activeSort} activeDir={activeDir} onSort={toggleSort}>Device S/N<br /><span className="opacity-70">设备序列号</span></ColTh>
              <ColTh section="device" sortKey="product_name" activeSort={activeSort} activeDir={activeDir} onSort={toggleSort}>Product Name<br /><span className="opacity-70">产品名称</span></ColTh>
              <ColTh section="device" sortKey="model_no" activeSort={activeSort} activeDir={activeDir} onSort={toggleSort}>Model No.<br /><span className="opacity-70">产品型号</span></ColTh>
              <ColTh section="pcbaA" sortKey="pcba_a_sn" activeSort={activeSort} activeDir={activeDir} onSort={toggleSort}>PCBA-A S/N<br /><span className="opacity-70">序列号</span></ColTh>
              <ColTh section="pcbaA">HW Rev<br /><span className="opacity-70">硬件版本</span></ColTh>
              <ColTh section="pcbaA">BOM Rev<br /><span className="opacity-70">物料版本</span></ColTh>
              <ColTh section="pcbaA">FW Ver<br /><span className="opacity-70">固件版本</span></ColTh>
              <ColTh section="pcbaB" sortKey="pcba_b_sn" activeSort={activeSort} activeDir={activeDir} onSort={toggleSort}>PCBA-B S/N<br /><span className="opacity-70">序列号</span></ColTh>
              <ColTh section="pcbaB">HW Rev<br /><span className="opacity-70">硬件版本</span></ColTh>
              <ColTh section="pcbaB">BOM Rev<br /><span className="opacity-70">物料版本</span></ColTh>
              <ColTh section="pcbaB">FW Ver<br /><span className="opacity-70">固件版本</span></ColTh>
              <ColTh section="hmi">Screen Model<br /><span className="opacity-70">屏幕</span></ColTh>
              <ColTh section="hmi">HMI Ver<br /><span className="opacity-70">HMI软件</span></ColTh>
              <ColTh section="shipment" sortKey="build_date" activeSort={activeSort} activeDir={activeDir} onSort={toggleSort}>Build Date<br /><span className="opacity-70">生产日期</span></ColTh>
              <ColTh section="shipment" sortKey="ship_date" activeSort={activeSort} activeDir={activeDir} onSort={toggleSort}>Ship Date<br /><span className="opacity-70">出货日期</span></ColTh>
              <ColTh section="shipment" sortKey="warranty_expiry" activeSort={activeSort} activeDir={activeDir} onSort={toggleSort}>Warranty Expiry<br /><span className="opacity-70">保修到期</span></ColTh>
              <ColTh section="shipment" right sortKey="qty" activeSort={activeSort} activeDir={activeDir} onSort={toggleSort}>Qty<br /><span className="opacity-70">量</span></ColTh>
              <ColTh section="shipment" sortKey="destination" activeSort={activeSort} activeDir={activeDir} onSort={toggleSort}>Destination<br /><span className="opacity-70">目的地</span></ColTh>
              <ColTh section="shipment" sortKey="customer" activeSort={activeSort} activeDir={activeDir} onSort={toggleSort}>Customer<br /><span className="opacity-70">客户</span></ColTh>
              <ColTh section="status" sortKey="status" activeSort={activeSort} activeDir={activeDir} onSort={toggleSort}>Status<br /><span className="opacity-70">状态</span></ColTh>
              <ColTh section="status" sortKey="phase" activeSort={activeSort} activeDir={activeDir} onSort={toggleSort}>Phase<br /><span className="opacity-70">阶段</span></ColTh>
              <ColTh section="status">Remarks<br /><span className="opacity-70">备注</span></ColTh>
              {canEdit && <ColTh section="status"><span className="sr-only">Edit</span></ColTh>}
            </tr>
          </thead>
          <tbody>
            {devices.length === 0 ? (
              <tr>
                <td colSpan={canEdit ? 23 : 22} className="text-center text-muted-foreground py-8">
                  No devices found.
                </td>
              </tr>
            ) : (
              devices.map((device, i) => (
                <tr key={device.id} className={`${i % 2 === 0 ? 'bg-white' : 'bg-muted/30'} group`}>
                  <td className="px-2 py-1.5 align-top">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(device.id)}
                      onChange={e => setSelectedIds(prev => {
                        const next = new Set(prev)
                        e.target.checked ? next.add(device.id) : next.delete(device.id)
                        return next
                      })}
                      className="rounded border-gray-300"
                    />
                  </td>
                  <Td>
                    <Link href={`/devices/${device.id}`} className="font-mono hover:underline text-blue-700">
                      {inlineCell?.id === device.id && inlineCell.field === 'device_sn' ? (
                        <Input
                          className="h-6 text-xs px-1 py-0 w-full"
                          value={inlineValue}
                          onChange={(e) => setInlineValue(e.target.value)}
                          onBlur={commitInlineEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitInlineEdit()
                            if (e.key === 'Escape') setInlineCell(null)
                          }}
                          autoFocus
                          disabled={inlineSaving}
                        />
                      ) : (
                        <span
                          className={canEdit ? 'cursor-pointer hover:bg-muted/60 rounded px-0.5 -mx-0.5' : ''}
                          onDoubleClick={() => startInlineEdit(device, 'device_sn')}
                        >
                          {n(device.device_sn)}
                        </span>
                      )}
                    </Link>
                  </Td>
                  <Td>{n(device.product_name)}</Td>
                  <Td className="font-mono">
                    {inlineCell?.id === device.id && inlineCell.field === 'model_no' ? (
                      <Input
                        className="h-6 text-xs px-1 py-0 w-full"
                        value={inlineValue}
                        onChange={(e) => setInlineValue(e.target.value)}
                        onBlur={commitInlineEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitInlineEdit()
                          if (e.key === 'Escape') setInlineCell(null)
                        }}
                        autoFocus
                        disabled={inlineSaving}
                      />
                    ) : (
                      <span
                        className={canEdit ? 'cursor-pointer hover:bg-muted/60 rounded px-0.5 -mx-0.5' : ''}
                        onDoubleClick={() => startInlineEdit(device, 'model_no')}
                      >
                        {n(device.model_no)}
                      </span>
                    )}
                  </Td>
                  <Td className="font-mono">
                    {inlineCell?.id === device.id && inlineCell.field === 'pcba_a_sn' ? (
                      <Input
                        className="h-6 text-xs px-1 py-0 w-full"
                        value={inlineValue}
                        onChange={(e) => setInlineValue(e.target.value)}
                        onBlur={commitInlineEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitInlineEdit()
                          if (e.key === 'Escape') setInlineCell(null)
                        }}
                        autoFocus
                        disabled={inlineSaving}
                      />
                    ) : (
                      <span
                        className={canEdit ? 'cursor-pointer hover:bg-muted/60 rounded px-0.5 -mx-0.5' : ''}
                        onDoubleClick={() => startInlineEdit(device, 'pcba_a_sn')}
                      >
                        {n(device.pcba_a_sn)}
                      </span>
                    )}
                  </Td>
                  <Td className="font-mono">{n(device.pcba_a_hw_rev)}</Td>
                  <Td className="font-mono">{n(device.pcba_a_bom_rev)}</Td>
                  <Td className="font-mono">{n(device.pcba_a_fw_ver)}</Td>
                  <Td className="font-mono">
                    {inlineCell?.id === device.id && inlineCell.field === 'pcba_b_sn' ? (
                      <Input
                        className="h-6 text-xs px-1 py-0 w-full"
                        value={inlineValue}
                        onChange={(e) => setInlineValue(e.target.value)}
                        onBlur={commitInlineEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitInlineEdit()
                          if (e.key === 'Escape') setInlineCell(null)
                        }}
                        autoFocus
                        disabled={inlineSaving}
                      />
                    ) : (
                      <span
                        className={canEdit ? 'cursor-pointer hover:bg-muted/60 rounded px-0.5 -mx-0.5' : ''}
                        onDoubleClick={() => startInlineEdit(device, 'pcba_b_sn')}
                      >
                        {n(device.pcba_b_sn)}
                      </span>
                    )}
                  </Td>
                  <Td className="font-mono">{n(device.pcba_b_hw_rev)}</Td>
                  <Td className="font-mono">{n(device.pcba_b_bom_rev)}</Td>
                  <Td className="font-mono">{n(device.pcba_b_fw_ver)}</Td>
                  <Td>{n(device.screen_model)}</Td>
                  <Td>{n(device.hmi_ver)}</Td>
                  <Td className="tabular-nums">{n(device.build_date)}</Td>
                  <Td className="tabular-nums">{n(device.ship_date)}</Td>
                  <Td className="tabular-nums">{n(device.warranty_expiry)}</Td>
                  <Td className="tabular-nums text-right">{device.qty ?? '—'}</Td>
                  <Td>
                    {inlineCell?.id === device.id && inlineCell.field === 'destination' ? (
                      <Input
                        className="h-6 text-xs px-1 py-0 w-full"
                        value={inlineValue}
                        onChange={(e) => setInlineValue(e.target.value)}
                        onBlur={commitInlineEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitInlineEdit()
                          if (e.key === 'Escape') setInlineCell(null)
                        }}
                        autoFocus
                        disabled={inlineSaving}
                      />
                    ) : (
                      <span
                        className={canEdit ? 'cursor-pointer hover:bg-muted/60 rounded px-0.5 -mx-0.5' : ''}
                        onDoubleClick={() => startInlineEdit(device, 'destination')}
                      >
                        {n(device.destination)}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {inlineCell?.id === device.id && inlineCell.field === 'customer' ? (
                      <Input
                        className="h-6 text-xs px-1 py-0 w-full"
                        value={inlineValue}
                        onChange={(e) => setInlineValue(e.target.value)}
                        onBlur={commitInlineEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitInlineEdit()
                          if (e.key === 'Escape') setInlineCell(null)
                        }}
                        autoFocus
                        disabled={inlineSaving}
                      />
                    ) : (
                      <span
                        className={canEdit ? 'cursor-pointer hover:bg-muted/60 rounded px-0.5 -mx-0.5' : ''}
                        onDoubleClick={() => startInlineEdit(device, 'customer')}
                      >
                        {n(device.customer)}
                      </span>
                    )}
                  </Td>
                  <Td><StatusBadge status={device.status} /></Td>
                  <Td><PhaseBadge phase={device.phase} /></Td>
                  <Td className="max-w-[200px]">
                    {inlineCell?.id === device.id && inlineCell.field === 'remarks' ? (
                      <Textarea
                        className="text-xs min-h-[3rem] w-full"
                        value={inlineValue}
                        onChange={(e) => setInlineValue(e.target.value)}
                        onBlur={commitInlineEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitInlineEdit() }
                          if (e.key === 'Escape') setInlineCell(null)
                        }}
                        autoFocus
                        disabled={inlineSaving}
                      />
                    ) : (
                      <span
                        className={`whitespace-pre-wrap ${canEdit ? 'cursor-pointer hover:bg-muted/60 rounded px-0.5 -mx-0.5' : ''}`}
                        onDoubleClick={() => canEdit && startInlineEdit(device, 'remarks')}
                      >
                        {n(device.remarks)}
                      </span>
                    )}
                  </Td>
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
