import { notFound } from 'next/navigation'
import { getDraft } from '@/lib/services/draftService'
import { requireAuth } from '@/lib/auth/session'
import { PromoteDraftButton } from './PromoteDraftButton'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { FIELD_LABELS } from '@/lib/i18n/fields'

interface PageProps { params: { id: string } }

export default async function DraftDetailPage({ params }: PageProps) {
  await requireAuth()
  const draft = await getDraft(params.id)
  if (!draft) notFound()

  const payload = draft.extracted_payload as Record<string, unknown>
  const fields = (payload?.fields as Record<string, { value: unknown; confidence?: number; source_quote?: string }>) ?? {}

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Draft Review</h1>
          <p className="text-sm text-muted-foreground font-mono">{draft.source_file_path}</p>
        </div>
        <Badge variant="warning">{draft.status}</Badge>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Extracted Fields</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-3">
              {Object.entries(fields).map(([key, field]) => {
                const label = FIELD_LABELS[key]
                const conf = field.confidence ?? 0
                return (
                  <div key={key} className="flex flex-col gap-0.5">
                    <dt className="text-xs font-medium">{label?.en ?? key} <span className="text-muted-foreground">· {label?.zh}</span></dt>
                    <dd className="text-sm">{String(field.value ?? '—')}</dd>
                    <div className="flex items-center gap-2">
                      <div className="h-1 flex-1 rounded bg-muted">
                        <div className="h-1 rounded bg-green-500" style={{ width: `${conf * 100}%` }} />
                      </div>
                      <span className="text-xs text-muted-foreground">{Math.round(conf * 100)}%</span>
                    </div>
                  </div>
                )
              })}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Source Quotes</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-3">
              {Object.entries(fields)
                .filter(([, f]) => f.source_quote)
                .map(([key, field]) => (
                  <div key={key}>
                    <dt className="text-xs font-medium text-muted-foreground">{FIELD_LABELS[key]?.en ?? key}</dt>
                    <dd className="text-sm italic text-muted-foreground">"{field.source_quote}"</dd>
                  </div>
                ))}
            </dl>
          </CardContent>
        </Card>
      </div>

      {draft.status === 'pending_review' && (
        <PromoteDraftButton draftId={draft.id} />
      )}
    </div>
  )
}
