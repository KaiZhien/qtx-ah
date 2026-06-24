import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { getDeviceStats } from '@/lib/services/deviceService'
import { getAuditLog } from '@/lib/services/auditService'
import { requireAuth } from '@/lib/auth/session'
import { Package, Layers, TrendingUp, Users } from 'lucide-react'
import { NotificationBanners } from '@/components/NotificationBanners'

export default async function DashboardPage() {
  const user = await requireAuth()
  const [stats, { rows: recentActivity }] = await Promise.all([
    getDeviceStats(),
    getAuditLog({ pageSize: 10 }),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">Device Lifecycle Management · QuantumTX</p>
      </div>

      <NotificationBanners />

      {/* Metric tiles */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Link href="/devices">
          <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Records</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalDevices}</div>
              <p className="text-xs text-muted-foreground">Active device records</p>
            </CardContent>
          </Card>
        </Link>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Units</CardTitle>
            <Layers className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalUnits.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">Sum of all Qty</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">By Status</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1 mt-1">
              {Object.entries(stats.byStatus).map(([s, n]) => (
                <Link key={s} href={`/devices?status=${encodeURIComponent(s)}`}>
                  <Badge variant="outline" className="text-xs">{s}: {n}</Badge>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">By Customer</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1 mt-1">
              {Object.entries(stats.byCustomer).slice(0, 5).map(([c, n]) => (
                <Link key={c} href={`/devices?customer=${encodeURIComponent(c)}`}>
                  <Badge variant="secondary" className="text-xs">{c}: {n}</Badge>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent activity.</p>
            ) : (
              recentActivity.map((entry) => (
                <div key={entry.id} className="flex items-start gap-3 text-sm border-b last:border-0 pb-2 last:pb-0">
                  <span className="text-xs text-muted-foreground tabular-nums shrink-0 pt-0.5">
                    {new Date(entry.occurred_at).toLocaleString()}
                  </span>
                  <span className="text-muted-foreground shrink-0">{entry.actor_email ?? 'System'}</span>
                  <span className="capitalize shrink-0">
                    <Badge variant={entry.action === 'soft_delete' ? 'destructive' : 'outline'} className="text-xs">
                      {entry.action}
                    </Badge>
                  </span>
                  <Link href={`/devices/${entry.row_id}`} className="font-mono text-xs hover:underline truncate">
                    {entry.row_id.slice(0, 8)}…
                  </Link>
                  {entry.changed_columns.length > 0 && (
                    <span className="text-xs text-muted-foreground truncate">
                      ({entry.changed_columns.join(', ')})
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
