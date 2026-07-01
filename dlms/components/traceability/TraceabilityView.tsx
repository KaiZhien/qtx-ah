'use client'

import { useTransition } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { TRACEABILITY_DIMENSIONS } from '@/lib/domain/componentTraceability'
import type { TraceabilityGroup } from '@/lib/domain/componentTraceability'

interface TraceabilityViewProps {
  dimension: string
  groups: TraceabilityGroup[]
}

export function TraceabilityView({ dimension, groups }: TraceabilityViewProps) {
  const router = useRouter()
  const pathname = usePathname()
  const [, startTransition] = useTransition()

  const activeDim = TRACEABILITY_DIMENSIONS.find((d) => d.field === dimension)

  function handleDimensionChange(field: string) {
    startTransition(() => router.push(`${pathname}?dim=${field}`))
  }

  const totalDevices = groups.reduce((s, g) => s + g.deviceCount, 0)
  const totalUnits   = groups.reduce((s, g) => s + g.unitCount, 0)

  return (
    <div className="space-y-4">
      {/* Dimension selector */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-muted-foreground">Group by</span>
        <Select value={dimension} onValueChange={handleDimensionChange}>
          <SelectTrigger className="h-8 w-52 text-xs">
            <SelectValue placeholder="Select dimension" />
          </SelectTrigger>
          <SelectContent>
            {TRACEABILITY_DIMENSIONS.map((d) => (
              <SelectItem key={d.field} value={d.field}>
                <span className="font-medium">{d.labelEn}</span>
                <span className="ml-1.5 text-muted-foreground text-xs opacity-70">
                  ({d.groupKey === 'pcba_a' ? 'PCBA-A' : d.groupKey === 'pcba_b' ? 'PCBA-B' : 'HMI'})
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {activeDim && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {groups.length} distinct value{groups.length !== 1 ? 's' : ''} ·{' '}
            {totalDevices} device{totalDevices !== 1 ? 's' : ''} ·{' '}
            {totalUnits} unit{totalUnits !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Empty state */}
      {groups.length === 0 && (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No devices found for this dimension.
        </p>
      )}

      {/* Grouped table */}
      {groups.length > 0 && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[50%]">
                  {activeDim?.labelEn ?? dimension}
                  <span className="ml-1 text-muted-foreground font-normal text-xs">
                    ({activeDim?.labelZh})
                  </span>
                </TableHead>
                <TableHead className="text-right">Devices</TableHead>
                <TableHead className="text-right">Units</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group, i) => {
                const isUnspecified = group.value === null
                const filterUrl = isUnspecified
                  ? null
                  : `/devices?${dimension}=${encodeURIComponent(group.value!)}`

                return (
                  <TableRow key={group.value ?? '__unspecified__'} className={i % 2 === 0 ? 'bg-white' : 'bg-muted/30'}>
                    <TableCell className="font-mono text-sm">
                      {isUnspecified ? (
                        <span className="text-muted-foreground italic">(unspecified)</span>
                      ) : (
                        <span>{group.value}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <Badge variant="secondary" className="text-xs">
                        {group.deviceCount}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {group.unitCount}
                    </TableCell>
                    <TableCell className="text-right">
                      {filterUrl && (
                        <Link
                          href={filterUrl}
                          className="text-xs text-primary underline hover:no-underline"
                        >
                          View →
                        </Link>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
