'use client'
import { useState, useRef } from 'react'
import Papa from 'papaparse'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ImportPreviewTable } from '@/components/import/ImportPreviewTable'
import { previewImportAction, importAction } from './actions'
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
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold">CSV Import</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload a CSV exported from the PCBA Traceability sheet. Columns are auto-mapped.
          Valid rows are imported; rejected rows are shown with reasons.
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
        <p className="text-sm text-muted-foreground">Drop a CSV file here, or click to browse</p>
        <p className="text-xs text-muted-foreground mt-1">Expected columns: PCBA-A S/N, Status, Phase, etc. (bilingual headers OK)</p>
        <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
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
  )
}
