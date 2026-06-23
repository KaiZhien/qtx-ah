'use client'
import { useId } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from 'recharts'
import type { ThroughputPoint, AnalyticsRange } from '@/lib/types'

interface Props {
  data: ThroughputPoint[]
  range: AnalyticsRange
}

function formatDay(dateStr: string): string {
  // Format YYYY-MM-DD as MM/DD
  const parts = dateStr.split('-')
  if (parts.length === 3) return `${parts[1]}/${parts[2]}`
  return dateStr
}

export function ThroughputChart({ data, range }: Props) {
  const id = useId()
  const gradientCreatedId = `colorCreated-${id}`
  const gradientCompletedId = `colorCompleted-${id}`

  const chartData = data.map((d) => ({
    day: formatDay(d.day),
    'Devices Created': d.devicesCreated,
    'Devices Completed': d.devicesCompleted,
  }))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Throughput
          <span className="ml-2 text-xs text-muted-foreground font-normal">
            ({range === '7d' ? 'Last 7 days' : range === '30d' ? 'Last 30 days' : 'Last 90 days'})
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground">No data for this range.</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={gradientCreatedId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
                <linearGradient id={gradientCompletedId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#34d399" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#34d399" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="day" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area
                type="monotone"
                dataKey="Devices Created"
                stroke="hsl(var(--primary))"
                fill={`url(#${gradientCreatedId})`}
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="Devices Completed"
                stroke="#34d399"
                fill={`url(#${gradientCompletedId})`}
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}
