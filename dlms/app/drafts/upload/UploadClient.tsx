'use client'

import { useState, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Upload } from 'lucide-react'
import { ExtractedDeviceConfirmModal } from '@/components/device/ExtractedDeviceConfirmModal'
import { extractInvoiceAction } from './actions'
import { toast } from 'sonner'
import type { StatusOption, PhaseOption } from '@/lib/types'
import type { ExtractedFields } from '@/lib/services/invoiceExtractionService'

interface UploadClientProps {
  statuses: StatusOption[]
  phases: PhaseOption[]
}

type QueueItem = {
  id: string
  file: File
  status: 'pending' | 'extracting' | 'extracted' | 'confirming' | 'done' | 'error'
  error?: string
  fields?: ExtractedFields
  fileHash?: string
  deviceId?: string
}

const ACCEPTED_TYPES = '.pdf,.jpg,.jpeg,.png'
const ACCEPTED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'])

function StatusBadge({ item }: { item: QueueItem }) {
  switch (item.status) {
    case 'pending':
      return <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">Pending</span>
    case 'extracting':
      return (
        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-full border border-blue-500 border-t-transparent animate-spin" />
          Extracting…
        </span>
      )
    case 'extracted':
      return <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">Review</span>
    case 'confirming':
      return <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">Confirming…</span>
    case 'done':
      return <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">Done</span>
    case 'error':
      return <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">Error</span>
  }
}

export function UploadClient({ statuses, phases }: UploadClientProps) {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [activeConfirmId, setActiveConfirmId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // Guard against concurrent extractions
  const processingRef = useRef(false)

  const processQueue = useCallback(async (items: QueueItem[]) => {
    if (processingRef.current) return
    const next = items.find(i => i.status === 'pending')
    if (!next) return

    processingRef.current = true

    setQueue(q => q.map(i => i.id === next.id ? { ...i, status: 'extracting' } : i))

    const formData = new FormData()
    formData.append('file', next.file)
    const result = await extractInvoiceAction(formData)

    processingRef.current = false

    if ('error' in result) {
      toast.error(`Failed to extract "${next.file.name}": ${result.error}`)
      setQueue(q => {
        const updated = q.map(i =>
          i.id === next.id ? { ...i, status: 'error' as const, error: result.error } : i
        )
        setTimeout(() => processQueue(updated), 0)
        return updated
      })
    } else {
      setQueue(q => {
        const updated = q.map(i =>
          i.id === next.id
            ? { ...i, status: 'extracted' as const, fields: result.fields, fileHash: result.fileHash }
            : i
        )
        setActiveConfirmId(next.id)
        return updated
      })
    }
  }, [])

  function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return

    const accepted: QueueItem[] = []
    for (const file of Array.from(files)) {
      if (!ACCEPTED_MIME.has(file.type)) {
        toast.error(`Unsupported file type: "${file.name}". Please upload a PDF, JPG, or PNG.`)
        continue
      }
      accepted.push({ id: crypto.randomUUID(), file, status: 'pending' })
    }

    if (accepted.length === 0) return

    setQueue(q => {
      const updated = [...q, ...accepted]
      // Start processing if no extraction or review is currently active
      if (!processingRef.current && !q.some(i => i.status === 'extracting' || i.status === 'extracted')) {
        setTimeout(() => processQueue(updated), 0)
      }
      return updated
    })

    // Reset so the same file can be re-selected later
    if (fileRef.current) fileRef.current.value = ''
  }

  function removeItem(id: string) {
    setQueue(q => q.filter(i => i.id !== id))
  }

  function handleConfirmSuccess(id: string, deviceId: string) {
    setQueue(q => {
      const updated = q.map(i => i.id === id ? { ...i, status: 'done' as const, deviceId } : i)
      setActiveConfirmId(null)
      setTimeout(() => processQueue(updated), 0)
      return updated
    })
  }

  function handleConfirmCancel(id: string) {
    setQueue(q => {
      const updated = q.map(i =>
        i.id === id ? { ...i, status: 'error' as const, error: 'Cancelled' } : i
      )
      setActiveConfirmId(null)
      setTimeout(() => processQueue(updated), 0)
      return updated
    })
  }

  const isExtracting = queue.some(i => i.status === 'extracting')
  const activeItem = activeConfirmId ? queue.find(i => i.id === activeConfirmId) : null

  return (
    <div className="flex min-h-[calc(100vh-3.5rem-3rem)] items-center justify-center">
      <div className="space-y-6 max-w-2xl w-full">
        <div>
          <h1 className="text-2xl font-bold">Invoice Upload</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Upload supplier invoices or shipment documents. Claude will extract device fields
            automatically — you can review and correct them before each device record is created.
          </p>
        </div>

        {/* Drop zone — always accessible */}
        <div
          className={[
            'border-2 border-dashed rounded-lg p-8 text-center transition-colors',
            isExtracting
              ? 'border-primary/30 cursor-wait opacity-60'
              : 'cursor-pointer hover:border-primary/50',
          ].join(' ')}
          onClick={() => { if (!isExtracting) fileRef.current?.click() }}
          onDrop={(e) => {
            e.preventDefault()
            if (isExtracting) return
            addFiles(e.dataTransfer.files)
          }}
          onDragOver={(e) => e.preventDefault()}
        >
          <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">
            Drop invoices here, or click to browse
          </p>
          <p className="text-xs text-muted-foreground mt-1">PDF, JPG, PNG · Max 25 MB · Multiple files supported</p>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPTED_TYPES}
            multiple
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
        </div>

        {/* Queue list */}
        {queue.length > 0 && (
          <div className="space-y-2">
            {queue.map(item => (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-lg border px-4 py-3 text-sm"
              >
                <div className="flex-1 min-w-0">
                  <p className="truncate font-medium">{item.file.name}</p>
                  {item.status === 'error' && item.error && item.error !== 'Cancelled' && (
                    <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">{item.error}</p>
                  )}
                  {item.status === 'done' && item.deviceId && (
                    <a
                      href={`/devices/${item.deviceId}`}
                      className="text-xs text-primary hover:underline mt-0.5 inline-block"
                    >
                      → Device created
                    </a>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <StatusBadge item={item} />
                  {(item.status === 'pending' || item.status === 'error') && (
                    <button
                      onClick={() => removeItem(item.id)}
                      className="ml-1 text-muted-foreground hover:text-foreground transition-colors"
                      aria-label={`Remove ${item.file.name}`}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            ))}

            <div className="pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileRef.current?.click()}
              >
                + Add more files
              </Button>
            </div>
          </div>
        )}

        {/* Confirm modal — one at a time, for the active extracted item */}
        {activeItem && activeItem.status === 'extracted' && activeItem.fields && activeItem.fileHash && (
          <ExtractedDeviceConfirmModal
            open
            onClose={() => handleConfirmCancel(activeItem.id)}
            onSuccess={(deviceId) => handleConfirmSuccess(activeItem.id, deviceId)}
            fields={activeItem.fields}
            statuses={statuses}
            phases={phases}
            file={activeItem.file}
            fileHash={activeItem.fileHash}
          />
        )}

        {queue.length === 0 && (
          <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
            <p className="font-medium text-foreground">What gets extracted</p>
            <p>Device S/N, PCBA-A &amp; B serials, hardware/firmware versions, HMI, build &amp; ship dates, customer, destination, quantity, and more — all 21 device fields.</p>
            <p>Any fields Claude can&apos;t find will be left blank for you to fill in.</p>
          </div>
        )}
      </div>
    </div>
  )
}
