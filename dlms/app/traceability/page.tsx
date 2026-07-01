import { requirePermission } from '@/lib/auth/session'
import { ACTIONS } from '@/lib/auth/permissions'
import { getComponentTraceability } from '@/lib/services/deviceService'
import { TRACEABILITY_DIMENSIONS, isTraceableField } from '@/lib/domain/componentTraceability'
import { TraceabilityView } from '@/components/traceability/TraceabilityView'

interface PageProps {
  searchParams: { dim?: string }
}

export default async function TraceabilityPage({ searchParams }: PageProps) {
  await requirePermission(ACTIONS.VIEW_ANALYTICS)

  const defaultDim = TRACEABILITY_DIMENSIONS[0].field
  const dim = (searchParams.dim && isTraceableField(searchParams.dim))
    ? searchParams.dim
    : defaultDim

  const groups = await getComponentTraceability(dim)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Component Traceability</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Fleet-wide rollup by component revision — identify affected devices for recalls or rework.
        </p>
      </div>
      <TraceabilityView dimension={dim} groups={groups} />
    </div>
  )
}
