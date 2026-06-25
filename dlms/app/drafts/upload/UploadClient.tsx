'use client'

import { useState, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Upload, FileText, Image } from 'lucide-react'
import { ExtractedDeviceConfirmModal } from '@/components/device/ExtractedDeviceConfirmModal'
import { extractInvoiceAction } from './actions'
import type { StatusOption, PhaseOption } from '@/lib/types'
import type { ExtractedFields } from '@/lib/services/invoiceExtractionService'

interface UploadClientProps {
  statuses: StatusOption[]
  phases: PhaseOption[]
}

type ExtractionState =
  | { status: 'idle' }
  | { status: 'extracting' }
  | { status: 'extracted'; fields: ExtractedFields; fileHash: string; file: File }
  | { status: 'error'; message: string }

const ACCEPTED_TYPES = '.pdf,.jpg,.jpeg,.png'
const ACCEPTED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'])

function fileIcon(type: string) {
  if (type === 'application/pdf') return <FileText className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
  return <Image className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
}

export function UploadClient({ statuses, phases }: UploadClientProps) {
  const [state, setState] = useState<ExtractionState>({ status: 'idle' })
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    if (!ACCEPTED_MIME.has(file.type)) {
      setState({ status: 'error', message: `Unsupported file type: ${file.type}. Please upload a PDF, JPG, or PNG.` })
      return
    }
    setSelectedFile(file)
    setState({ status: 'extracting' })

    const formData = new FormData()
    formData.append('file', file)

    const result = await extractInvoiceAction(formData)

    if ('error' in result) {
      setState({ status: 'error', message: result.error })
    } else {
      setState({
        status: 'extracted',
        fields: result.fields,
        fileHash: result.fileHash,
        file,
      })
    }
  }

  function handleModalClose() {
    setState({ status: 'idle' })
    setSelectedFile(null)
    // Reset the file input so the same file can be re-uploaded if needed
    if (fileRef.current) fileRef.current.value = ''
  }

  const isExtracting = state.status === 'extracting'

  return (
    <div className="flex min-h-[calc(100vh-3.5rem-3rem)] items-center justify-center">
      <div className="space-y-6 max-w-2xl w-full">
        <div>
          <h1 className="text-2xl font-bold">Invoice Upload</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Upload a supplier invoice or shipment document. Claude will extract device fields
            automatically — you can review and correct them before the device record is created.
          </p>
        </div>

        {/* Drop zone */}
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
            const f = e.dataTransfer.files[0]
            if (f) handleFile(f)
          }}
          onDragOver={(e) => e.preventDefault()}
        >
          {isExtracting ? (
            <>
              <div className="h-8 w-8 mx-auto mb-2 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              <p className="text-sm font-medium">Extracting device data…</p>
              <p className="text-xs text-muted-foreground mt-1">
                Claude is reading your invoice. This usually takes 5–15 seconds.
              </p>
              {selectedFile && (
                <p className="text-xs text-muted-foreground mt-2">{selectedFile.name}</p>
              )}
            </>
          ) : (
            <>
              {selectedFile ? fileIcon(selectedFile.type) : <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />}
              <p className="text-sm text-muted-foreground">
                {selectedFile
                  ? `Selected: ${selectedFile.name} — click or drop to replace`
                  : 'Drop an invoice here, or click to browse'}
              </p>
              <p className="text-xs text-muted-foreground mt-1">PDF, JPG, PNG · Max 25 MB</p>
            </>
          )}
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPTED_TYPES}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) handleFile(f)
            }}
          />
        </div>

        {state.status === 'error' && (
          <Alert variant="destructive">
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}

        {/* Confirm modal opens automatically when extraction succeeds */}
        {state.status === 'extracted' && (
          <ExtractedDeviceConfirmModal
            open
            onClose={handleModalClose}
            fields={state.fields}
            statuses={statuses}
            phases={phases}
            file={state.file}
            fileHash={state.fileHash}
          />
        )}

        {state.status === 'idle' && (
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
