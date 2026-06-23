'use client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { EngineerActivity } from '@/lib/types'

interface Props {
  data: EngineerActivity[]
}

export function EngineerActivityPanel({ data }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Engineer Activity</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity data for this range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 px-3 font-medium text-muted-foreground">Engineer</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Changes</th>
                  <th className="text-right py-2 px-3 font-medium text-muted-foreground">Devices Touched</th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.actorId} className="border-b last:border-0 hover:bg-muted/40">
                    <td className="py-2 px-3">{row.actorEmail}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{row.changeCount}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{row.distinctDevices}</td>
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
