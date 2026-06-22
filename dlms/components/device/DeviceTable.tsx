'use client'
import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
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

function primaryId(device: DeviceRow): string {
  return device.device_sn || device.pcba_a_sn
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

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>PCBA-A S/N · Device S/N</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Phase</TableHead>
              <TableHead>Build Date</TableHead>
              <TableHead>Ship Date</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead>FW Ver</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {devices.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                  No devices found.
                </TableCell>
              </TableRow>
            ) : (
              devices.map((device) => (
                <TableRow key={device.id}>
                  <TableCell>
                    <Link href={`/devices/${device.id}`} className="font-mono text-xs hover:underline block">
                      {device.pcba_a_sn}
                    </Link>
                    {device.device_sn && (
                      <span className="text-xs text-muted-foreground font-mono">{device.device_sn}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{device.customer ?? '—'}</TableCell>
                  <TableCell><StatusBadge status={device.status} /></TableCell>
                  <TableCell><PhaseBadge phase={device.phase} /></TableCell>
                  <TableCell className="text-sm tabular-nums">{device.build_date ?? '—'}</TableCell>
                  <TableCell className="text-sm tabular-nums">{device.ship_date ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{device.qty ?? '—'}</TableCell>
                  <TableCell className="text-xs font-mono">{device.pcba_a_fw_ver}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
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
