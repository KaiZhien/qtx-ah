'use client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
} from 'recharts'
import type { OverviewMetrics } from '@/lib/types'

const COLORS = [
  'hsl(var(--primary))',
  '#60a5fa',
  '#34d399',
  '#f59e0b',
  '#f87171',
  '#a78bfa',
]

interface Props {
  metrics: OverviewMetrics
}

export function OverviewPanel({ metrics }: Props) {
  const statusData = metrics.byStatus.map((s) => ({
    name: s.label_en,
    count: s.device_count,
  }))

  const phaseData = metrics.byPhase.map((p) => ({
    name: p.label_en,
    count: p.device_count,
  }))

  return (
    <div className="space-y-4">
      {/* KPI tiles */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Devices</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{metrics.totalDevices.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Units</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{metrics.totalUnits.toLocaleString()}</div>
          </CardContent>
        </Card>

        {/* By Status bar chart */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">By Status</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            {statusData.length === 0 ? (
              <p className="text-xs text-muted-foreground">No data</p>
            ) : (
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={statusData} layout="vertical" margin={{ left: 0, right: 8, top: 0, bottom: 0 }}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={80} />
                  <Tooltip
                    contentStyle={{ fontSize: 12 }}
                    formatter={(value) => [value, 'Devices']}
                  />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {statusData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* By Phase bar chart */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">By Phase</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            {phaseData.length === 0 ? (
              <p className="text-xs text-muted-foreground">No data</p>
            ) : (
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={phaseData} layout="vertical" margin={{ left: 0, right: 8, top: 0, bottom: 0 }}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={80} />
                  <Tooltip
                    contentStyle={{ fontSize: 12 }}
                    formatter={(value) => [value, 'Devices']}
                  />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {phaseData.map((_, i) => (
                      <Cell key={i} fill={COLORS[(i + 2) % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
