'use client'
import { useState, useRef } from 'react'
import Papa from 'papaparse'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ImportPreviewTable } from '@/components/import/ImportPreviewTable'
import { previewImportAction, importAction, previewExcelAction } from './actions'
import type { ImportPreviewRow } from '@/lib/types'
import { Upload } from 'lucide-react'

export default function ImportPage() {
  const [rows, setRows] = useState<ImportPreviewRow[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function handleFile(file: File) {
    setError(null)
    setRows(null)
    setResult(null)

    const ext = file.name.split('.').pop()?.toLowerCase()

    if (ext === 'xlsx') {
      file.arrayBuffer().then(async (buf) => {
        try {
          const preview = await previewExcelAction(buf)
          setRows(preview)
        } catch (e) {
          setError((e as Error).message)
        }
      }).catch((e) => setError((e as Error).message))
      return
    }

    // Default: CSV path (unchanged)
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (result) => {
        try {
          const preview = await previewImportAction(result.data)
          setRows(preview)
        } catch (e) {
          setError((e as Error).message)
        }
      },
      error: (err) => setError(err.message),
    })
  }

  async function handleImport() {
    if (!rows) return
    setImporting(true)
    try {
      const res = await importAction(rows)
      setResult(res)
      setRows(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-3.5rem-3rem)] items-center justify-center">
    <div className="space-y-6 max-w-2xl w-full">
      <div>
        <h1 className="text-2xl font-bold">Import Devices</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload a CSV or Excel (.xlsx) file from the PCBA Traceability sheet. Columns are auto-mapped. Serial ranges are expanded to individual device rows.
        </p>
      </div>

      {/* Upload area */}
      <div
        className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
        onClick={() => fileRef.current?.click()}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
        onDragOver={(e) => e.preventDefault()}
      >
        <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">Drop a CSV or Excel (.xlsx) file here, or click to browse</p>
        <p className="text-xs text-muted-foreground mt-1">Expected: PCBA Traceability .xlsx or a CSV export. Bilingual headers OK. Serial ranges (e.g. 0001 to 0015) expand automatically.</p>
        <input ref={fileRef} type="file" accept=".csv,.xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      {result && (
        <Alert>
          <AlertDescription>
            Import complete: {result.imported} rows imported, {result.skipped} skipped.
          </AlertDescription>
        </Alert>
      )}

      {rows && (
        <ImportPreviewTable rows={rows} onImport={handleImport} isImporting={importing} />
      )}
    </div>
    </div>
  )
}
