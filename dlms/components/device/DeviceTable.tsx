'use client'
import { useTransition } from 'react'
import Link from 'next/link'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusBadge, PhaseBadge } from './DeviceStatusBadge'
import { Search, Download, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import type { DeviceRow, StatusOption, PhaseOption } from '@/lib/types'
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

// Section colour palette — matches the spreadsheet header colours
const SECTION = {
  device:   { bg: 'bg-[#2B7A8C]',  border: 'border-[#1E5E6E]' },
  pcbaA:    { bg: 'bg-[#3B5BA5]',  border: 'border-[#2D4580]' },
  pcbaB:    { bg: 'bg-[#4A7C3F]',  border: 'border-[#376030]' },
  hmi:      { bg: 'bg-[#C87941]',  border: 'border-[#A05E30]' },
  shipment: { bg: 'bg-[#7A7A2A]',  border: 'border-[#5C5C1E]' },
  status:   { bg: 'bg-[#8B3030]',  border: 'border-[#6B2020]' },
} as const

type Section = keyof typeof SECTION

function GroupTh({ label, sub, colSpan, section }: { label: string; sub?: string; colSpan: number; section: Section }) {
  const { bg, border } = SECTION[section]
  return (
    <th
      colSpan={colSpan}
      className={`${bg} text-white text-center text-xs font-semibold px-2 py-1.5 border-b-2 ${border} whitespace-nowrap`}
    >
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
    <td className={`px-2 py-2 text-xs border-r border-border last:border-r-0 align-top ${className}`}>
      {children}
    </td>
  )
}

function dash(v: string | null | undefined) {
  return v || '—'
}

export function DeviceTable({
  devices, total, page, pageSize, statuses, phases, customers, userRole,
  initialSearch = '', initialStatus = '', initialPhase = '', initialCustomer = '',
}: DeviceTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [, startTransition] = useTransition()

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

  const totalPages = Math.ceil(total / pageSize)

  return (
    <div className="space-y-4">
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
          {can(userRole, ACTIONS.CREATE_DEVICE) && (
            <Link href="/devices/new">
              <Button size="sm">
                <Plus className="h-4 w-4 mr-1" />New Device
              </Button>
            </Link>
          )}
        </div>
      </div>

      {/* Colour-coded grouped table */}
      <div className="rounded-md border overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            {/* Row 1: section group labels */}
            <tr>
              <GroupTh label="设备信息" sub="Device Info"                         colSpan={3} section="device" />
              <GroupTh label="PCBA-A (电源板 Amplifier Board)"                    colSpan={4} section="pcbaA" />
              <GroupTh label="PCBA-B (控制板 Accessory Board)"                    colSpan={4} section="pcbaB" />
              <GroupTh label="HMI Screen 触摸屏"                                   colSpan={2} section="hmi" />
              <GroupTh label="出货信息" sub="Shipment Info"                        colSpan={5} section="shipment" />
              <GroupTh label="状态 Status & Notes"                                 colSpan={3} section="status" />
            </tr>
            {/* Row 2: individual column labels */}
            <tr>
              {/* Device Info */}
              <ColTh section="device">Device S/N<br /><span className="opacity-70">设备序列号</span></ColTh>
              <ColTh section="device">Product Name<br /><span className="opacity-70">产品名称</span></ColTh>
              <ColTh section="device">Model No.<br /><span className="opacity-70">产品型号</span></ColTh>
              {/* PCBA-A */}
              <ColTh section="pcbaA">PCBA-A S/N<br /><span className="opacity-70">序列号</span></ColTh>
              <ColTh section="pcbaA">HW Rev<br /><span className="opacity-70">硬件版本</span></ColTh>
              <ColTh section="pcbaA">BOM Rev<br /><span className="opacity-70">物料版本</span></ColTh>
              <ColTh section="pcbaA">FW Ver<br /><span className="opacity-70">固件版本</span></ColTh>
              {/* PCBA-B */}
              <ColTh section="pcbaB">PCBA-B S/N<br /><span className="opacity-70">序列号</span></ColTh>
              <ColTh section="pcbaB">HW Rev<br /><span className="opacity-70">硬件版本</span></ColTh>
              <ColTh section="pcbaB">BOM Rev<br /><span className="opacity-70">物料版本</span></ColTh>
              <ColTh section="pcbaB">FW Ver<br /><span className="opacity-70">固件版本</span></ColTh>
              {/* HMI */}
              <ColTh section="hmi">Screen Model<br /><span className="opacity-70">屏幕</span></ColTh>
              <ColTh section="hmi">HMI Ver<br /><span className="opacity-70">HMI软件</span></ColTh>
              {/* Shipment */}
              <ColTh section="shipment">Build Date<br /><span className="opacity-70">生产日期</span></ColTh>
              <ColTh section="shipment">Ship Date<br /><span className="opacity-70">出货日期</span></ColTh>
              <ColTh section="shipment" right>Qty<br /><span className="opacity-70">量</span></ColTh>
              <ColTh section="shipment">Destination<br /><span className="opacity-70">目的地</span></ColTh>
              <ColTh section="shipment">Customer<br /><span className="opacity-70">客户</span></ColTh>
              {/* Status */}
              <ColTh section="status">Status<br /><span className="opacity-70">状态</span></ColTh>
              <ColTh section="status">Phase<br /><span className="opacity-70">阶段</span></ColTh>
              <ColTh section="status">Remarks<br /><span className="opacity-70">备注</span></ColTh>
            </tr>
          </thead>
          <tbody>
            {devices.length === 0 ? (
              <tr>
                <td colSpan={21} className="text-center text-muted-foreground py-8">No devices found.</td>
              </tr>
            ) : (
              devices.map((device, i) => (
                <tr key={device.id} className={i % 2 === 0 ? 'bg-white' : 'bg-muted/30'}>
                  {/* Device Info */}
                  <Td>
                    <Link href={`/devices/${device.id}`} className="font-mono hover:underline text-blue-700">
                      {dash(device.device_sn)}
                    </Link>
                  </Td>
                  <Td>{dash(device.product_name)}</Td>
                  <Td className="font-mono">{dash(device.model_no)}</Td>
                  {/* PCBA-A */}
                  <Td className="font-mono">{dash(device.pcba_a_sn)}</Td>
                  <Td className="font-mono">{dash(device.pcba_a_hw_rev)}</Td>
                  <Td className="font-mono">{dash(device.pcba_a_bom_rev)}</Td>
                  <Td className="font-mono">{dash(device.pcba_a_fw_ver)}</Td>
                  {/* PCBA-B */}
                  <Td className="font-mono">{dash(device.pcba_b_sn)}</Td>
                  <Td className="font-mono">{dash(device.pcba_b_hw_rev)}</Td>
                  <Td className="font-mono">{dash(device.pcba_b_bom_rev)}</Td>
                  <Td className="font-mono">{dash(device.pcba_b_fw_ver)}</Td>
                  {/* HMI */}
                  <Td className="font-mono">{dash(device.screen_model)}</Td>
                  <Td className="font-mono">{dash(device.hmi_ver)}</Td>
                  {/* Shipment */}
                  <Td className="tabular-nums">{dash(device.build_date)}</Td>
                  <Td className="tabular-nums">{dash(device.ship_date)}</Td>
                  <Td className="tabular-nums text-right">{device.qty ?? '—'}</Td>
                  <Td>{dash(device.destination)}</Td>
                  <Td>{dash(device.customer)}</Td>
                  {/* Status */}
                  <Td><StatusBadge status={device.status} /></Td>
                  <Td><PhaseBadge phase={device.phase} /></Td>
                  <Td className="max-w-[200px] whitespace-pre-wrap">{dash(device.remarks)}</Td>
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
