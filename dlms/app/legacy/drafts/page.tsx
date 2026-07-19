import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { listDrafts } from '@/lib/services/draftService'
import { requirePermission } from '@/lib/auth/session'
import { ACTIONS } from '@/lib/auth/permissions'
import { FileText, Upload } from 'lucide-react'

export default async function DraftsPage() {
  await requirePermission(ACTIONS.CONFIRM_DRAFT)
  const drafts = await listDrafts()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Extraction Drafts</h1>
          <p className="text-sm text-muted-foreground mt-1">Phase 2 · Review auto-extracted device records before importing</p>
        </div>
        <Link href="/legacy/drafts/upload">
          <Button variant="outline"><Upload className="h-4 w-4 mr-2" />Upload Document</Button>
        </Link>
      </div>

      {drafts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
            No pending drafts.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {drafts.map((draft) => {
            const payload = draft.extracted_payload as Record<string, unknown>
            const fields = (payload?.fields as Record<string, { value: unknown; confidence?: number }>) ?? {}
            const pcbaA = fields.pcba_a_sn?.value as string | undefined
            const confidence = Object.values(fields).reduce((sum: number, f: unknown) => {
              const field = f as { confidence?: number }
              return sum + (field?.confidence ?? 0)
            }, 0) / Math.max(Object.keys(fields).length, 1)

            return (
              <div key={draft.id} className="border rounded-md p-4 flex items-center gap-4">
                <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-sm truncate">{draft.source_file_path}</p>
                  {pcbaA && <p className="text-xs text-muted-foreground">PCBA-A: {pcbaA}</p>}
                  <p className="text-xs text-muted-foreground">
                    {new Date(draft.created_at).toLocaleString()} ·
                    Confidence: {Math.round(confidence * 100)}%
                  </p>
                </div>
                <Badge variant="warning">Pending Review</Badge>
                <Link href={`/legacy/drafts/${draft.id}`}>
                  <Button size="sm">Review</Button>
                </Link>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
