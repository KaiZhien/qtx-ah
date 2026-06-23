/**
 * PDF export for analytics — uses React.createElement directly to avoid
 * @jsxImportSource pragma conflicts with Next.js webpack bundler.
 */
import React from 'react'
import { renderToBuffer, Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import type { OverviewMetrics, StatusDuration, TransitionEdge, ThroughputPoint, AnalyticsRange } from '@/lib/types'

const styles = StyleSheet.create({
  page: { padding: 30, fontFamily: 'Helvetica', fontSize: 10 },
  title: { fontSize: 18, marginBottom: 10, fontWeight: 'bold' },
  section: { marginBottom: 16 },
  sectionTitle: { fontSize: 13, fontWeight: 'bold', marginBottom: 6, color: '#1a1a1a' },
  row: { flexDirection: 'row', borderBottom: '1pt solid #e0e0e0', paddingVertical: 3 },
  headerRow: { flexDirection: 'row', backgroundColor: '#f0f0f0', paddingVertical: 4, fontWeight: 'bold' },
  cell: { flex: 1, paddingHorizontal: 4 },
  meta: { fontSize: 8, color: '#666', marginBottom: 16 },
})

const ce = React.createElement

export interface PdfReportProps {
  overview: OverviewMetrics
  throughput: ThroughputPoint[]
  durations: StatusDuration[]
  transitions: TransitionEdge[]
  range: AnalyticsRange
}

export async function renderAnalyticsPdf(props: PdfReportProps): Promise<Buffer> {
  const { overview, durations, transitions, range } = props

  const doc = ce(Document, {},
    ce(Page, { size: 'A4', style: styles.page },
      ce(Text, { style: styles.title }, 'DLMS Analytics Report'),
      ce(Text, { style: styles.meta },
        `Generated: ${new Date().toISOString()} · Range: ${range}`
      ),

      // Overview
      ce(View, { style: styles.section },
        ce(Text, { style: styles.sectionTitle }, 'Overview'),
        ce(View, { style: styles.row },
          ce(Text, { style: styles.cell }, `Total Devices: ${overview.totalDevices}`),
          ce(Text, { style: styles.cell }, `Total Units: ${overview.totalUnits}`),
        ),
      ),

      // Status Distribution
      ce(View, { style: styles.section },
        ce(Text, { style: styles.sectionTitle }, 'Status Distribution'),
        ce(View, { style: styles.headerRow },
          ce(Text, { style: styles.cell }, 'Status'),
          ce(Text, { style: styles.cell }, 'Devices'),
          ce(Text, { style: styles.cell }, 'Units'),
        ),
        ...overview.byStatus.map((s, i) =>
          ce(View, { key: i, style: styles.row },
            ce(Text, { style: styles.cell }, s.label_en),
            ce(Text, { style: styles.cell }, String(s.device_count)),
            ce(Text, { style: styles.cell }, String(s.unit_count)),
          )
        ),
      ),

      // Bottlenecks
      ce(View, { style: styles.section },
        ce(Text, { style: styles.sectionTitle }, 'Bottlenecks (Status Dwell Time)'),
        ce(View, { style: styles.headerRow },
          ce(Text, { style: styles.cell }, 'Status'),
          ce(Text, { style: styles.cell }, 'Avg Days'),
          ce(Text, { style: styles.cell }, 'Median Days'),
          ce(Text, { style: styles.cell }, 'Samples'),
        ),
        ...durations.map((d, i) =>
          ce(View, { key: i, style: styles.row },
            ce(Text, { style: styles.cell }, d.status),
            ce(Text, { style: styles.cell }, d.avgDays.toFixed(1)),
            ce(Text, { style: styles.cell }, d.medianDays.toFixed(1)),
            ce(Text, { style: styles.cell }, String(d.sampleCount)),
          )
        ),
      ),

      // Top Transitions
      ce(View, { style: styles.section },
        ce(Text, { style: styles.sectionTitle }, 'Top Status Transitions'),
        ce(View, { style: styles.headerRow },
          ce(Text, { style: styles.cell }, 'From'),
          ce(Text, { style: styles.cell }, 'To'),
          ce(Text, { style: styles.cell }, 'Count'),
        ),
        ...transitions.slice(0, 10).map((t, i) =>
          ce(View, { key: i, style: styles.row },
            ce(Text, { style: styles.cell }, t.fromStatus),
            ce(Text, { style: styles.cell }, t.toStatus),
            ce(Text, { style: styles.cell }, String(t.count)),
          )
        ),
      ),
    )
  )

  return renderToBuffer(doc) as unknown as Promise<Buffer>
}
