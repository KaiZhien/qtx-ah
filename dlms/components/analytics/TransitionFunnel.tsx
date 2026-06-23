'use client'
import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { TransitionEdge } from '@/lib/types'

interface Props {
  data: TransitionEdge[]
}

type SortKey = 'from' | 'to' | 'count'

export function TransitionFunnel({ data }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('count')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // Sort by count descending first, then take top 15
  const top15 = [...data]
    .sort((a, b) => b.count - a.count)
    .slice(0, 15)

  const sorted = [...top15].sort((a, b) => {
    let cmp = 0
    if (sortKey === 'from') cmp = a.fromStatus.localeCompare(b.fromStatus)
    else if (sortKey === 'to') cmp = a.toStatus.localeCompare(b.toStatus)
    else cmp = a.count - b.count
    return sortDir === 'asc' ? cmp : -cmp
  })

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'count' ? 'desc' : 'asc')
    }
  }

  function sortIcon(key: SortKey) {
    if (sortKey !== key) return null
    return sortDir === 'asc' ? ' ↑' : ' ↓'
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Status Transitions (top 15)</CardTitle>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">No transition data available.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th
                    className="text-left py-2 px-3 font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none"
                    onClick={() => handleSort('from')}
                  >
                    From{sortIcon('from')}
                  </th>
                  <th
                    className="text-left py-2 px-3 font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none"
                    onClick={() => handleSort('to')}
                  >
                    To{sortIcon('to')}
                  </th>
                  <th
                    className="text-right py-2 px-3 font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none"
                    onClick={() => handleSort('count')}
                  >
                    Count{sortIcon('count')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((edge, i) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-muted/40">
                    <td className="py-2 px-3 font-mono text-xs">{edge.fromStatus}</td>
                    <td className="py-2 px-3 font-mono text-xs">{edge.toStatus}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{edge.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
