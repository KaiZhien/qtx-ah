'use client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from 'recharts'
import type { StatusDuration } from '@/lib/types'

interface Props {
  data: StatusDuration[]
}

export function BottleneckChart({ data }: Props) {
  // Data is already sorted worst-first (highest avgDays) from the service
  const chartData = data.map((d) => ({
    status: d.status,
    'Avg Days': parseFloat(d.avgDays.toFixed(1)),
    'Median Days': parseFloat(d.medianDays.toFixed(1)),
    sampleCount: d.sampleCount,
  }))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Bottlenecks — Time per Status</CardTitle>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground">No dwell data available.</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
            >
              <XAxis type="number" tick={{ fontSize: 11 }} unit=" d" />
              <YAxis type="category" dataKey="status" tick={{ fontSize: 11 }} width={90} />
              <Tooltip
                contentStyle={{ fontSize: 12 }}
                formatter={(value, name) => [`${value} days`, String(name)]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Avg Days" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
              <Bar dataKey="Median Days" fill="#60a5fa" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}
