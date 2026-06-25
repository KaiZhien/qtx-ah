'use client'

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface DeviceChartsProps {
  byStatus: Record<string, number>
  byPhase: Record<string, number>
  byCustomer: Record<string, number>
}

export function DeviceCharts({ byStatus, byPhase, byCustomer }: DeviceChartsProps) {
  const statusData = Object.entries(byStatus).map(([name, count]) => ({ name, count }))
  const phaseData = Object.entries(byPhase).map(([name, count]) => ({ name, count }))
  const customerData = Object.entries(byCustomer)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }))

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {/* Chart 1 — Status breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">By Status</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart layout="vertical" data={statusData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" />
              <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Bar dataKey="count" fill="#6366f1" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Chart 2 — Phase breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">By Phase</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart layout="vertical" data={phaseData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" />
              <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Bar dataKey="count" fill="#8b5cf6" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Chart 3 — Top customers */}
      <Card className="md:col-span-2 lg:col-span-1">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Top Customers</CardTitle>
        </CardHeader>
        <CardContent>
          {Object.keys(byCustomer).length === 0 ? (
            <p className="text-sm text-muted-foreground">No customer data yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart layout="vertical" data={customerData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" />
                <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#06b6d4" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
