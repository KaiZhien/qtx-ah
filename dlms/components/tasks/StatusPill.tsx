import {
  FileEdit, Circle, PlayCircle, Ban, Hourglass, CheckCircle2, XCircle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TaskStatus } from '@/modules/shared/tasks/domain/taskStatus'

type StatusMeta = { label: string; icon: LucideIcon; className: string }

// Every status gets its own icon AND its own text label — never color alone —
// so the pill still reads correctly for a colorblind viewer or a grayscale
// print. Color is a reinforcement here, not the signal.
const STATUS_META: Record<TaskStatus, StatusMeta> = {
  draft: { label: 'Draft', icon: FileEdit, className: 'bg-gray-100 text-gray-700 border-gray-200' },
  open: { label: 'Open', icon: Circle, className: 'bg-blue-50 text-blue-700 border-blue-200' },
  in_progress: {
    label: 'In progress', icon: PlayCircle, className: 'bg-amber-50 text-amber-800 border-amber-200',
  },
  blocked: { label: 'Blocked', icon: Ban, className: 'bg-red-50 text-red-700 border-red-200' },
  awaiting_approval: {
    label: 'Awaiting approval', icon: Hourglass,
    className: 'bg-purple-50 text-purple-700 border-purple-200',
  },
  completed: {
    label: 'Completed', icon: CheckCircle2, className: 'bg-green-50 text-green-700 border-green-200',
  },
  cancelled: { label: 'Cancelled', icon: XCircle, className: 'bg-gray-100 text-gray-500 border-gray-200' },
}

export function StatusPill({ status, className }: { status: TaskStatus; className?: string }) {
  const meta = STATUS_META[status]
  const Icon = meta.icon
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium',
        meta.className, className,
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {meta.label}
    </span>
  )
}
