'use client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { MyQueueItem } from '@/lib/types'

interface Props {
  data: MyQueueItem[]
}

function staleDaysColor(days: number): string {
  if (days < 3) return 'text-green-600 dark:text-green-400'
  if (days <= 7) return 'text-yellow-600 dark:text-yellow-400'
  return 'text-red-600 dark:text-red-400'
}

export function MyQueuePanel({ data }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">My Queue</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Your queue is empty.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground">PCBA-A S/N</th>
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground">Status</th>
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground">Phase</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Days Stale</th>
                </tr>
              </thead>
              <tbody>
                {data.map((item) => (
                  <tr key={item.deviceId} className="border-b last:border-0 hover:bg-muted/40">
                    <td className="py-2 px-3 font-mono text-xs">{item.pcbaASn}</td>
                    <td className="py-2 px-3">{item.status}</td>
                    <td className="py-2 px-3">{item.phase}</td>
                    <td className={`py-2 px-3 text-right tabular-nums font-semibold ${staleDaysColor(item.staleDays)}`}>
                      {item.staleDays}
                    </td>
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
