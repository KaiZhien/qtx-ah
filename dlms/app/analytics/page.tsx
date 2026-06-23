import { requirePermission } from '@/lib/auth/session'
import { ACTIONS } from '@/lib/auth/permissions'
import {
  getOverviewMetrics,
  getThroughputSeries,
  getStatusDurations,
  getTransitionFunnel,
  getEngineerActivity,
  getMyQueue,
} from '@/lib/services/analyticsService'
import { OverviewPanel } from '@/components/analytics/OverviewPanel'
import { ThroughputChart } from '@/components/analytics/ThroughputChart'
import { BottleneckChart } from '@/components/analytics/BottleneckChart'
import { TransitionFunnel } from '@/components/analytics/TransitionFunnel'
import { EngineerActivityPanel } from '@/components/analytics/EngineerActivityPanel'
import { MyQueuePanel } from '@/components/analytics/MyQueuePanel'
import { RangeSelector } from '@/components/analytics/RangeSelector'
import type { AnalyticsRange } from '@/lib/types'

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: { range?: string }
}) {
  const user = await requirePermission(ACTIONS.VIEW_ANALYTICS)
  const range = (['7d', '30d', '90d'].includes(searchParams.range ?? '')
    ? searchParams.range
    : '30d') as AnalyticsRange

  const [overview, throughput, durations, transitions, engineerActivity, myQueue] =
    await Promise.all([
      getOverviewMetrics(),
      getThroughputSeries(range),
      getStatusDurations(),
      getTransitionFunnel(),
      user.role === 'admin' ? getEngineerActivity(range) : Promise.resolve([]),
      user.role === 'engineer' ? getMyQueue(user.id) : Promise.resolve([]),
    ])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Analytics</h1>
        <RangeSelector currentRange={range} />
      </div>

      <OverviewPanel metrics={overview} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ThroughputChart data={throughput} range={range} />
        <BottleneckChart data={durations} />
      </div>

      <TransitionFunnel data={transitions} />

      {user.role === 'admin' && (
        <EngineerActivityPanel data={engineerActivity} />
      )}

      {user.role === 'engineer' && (
        <MyQueuePanel data={myQueue} />
      )}
    </div>
  )
}
