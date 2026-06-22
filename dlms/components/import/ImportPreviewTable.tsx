'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { ImportPreviewRow } from '@/lib/types'
import { CheckCircle, XCircle } from 'lucide-react'

interface ImportPreviewTableProps {
  rows: ImportPreviewRow[]
  onImport: () => void
  isImporting: boolean
}

export function ImportPreviewTable({ rows, onImport, isImporting }: ImportPreviewTableProps) {
  const valid = rows.filter((r) => r.valid)
  const rejected = rows.filter((r) => !r.valid)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1 text-sm text-green-700">
          <CheckCircle className="h-4 w-4" />
          <span>{valid.length} valid rows</span>
        </div>
        <div className="flex items-center gap-1 text-sm text-red-600">
          <XCircle className="h-4 w-4" />
          <span>{rejected.length} rejected</span>
        </div>
        <div className="ml-auto">
          <Button onClick={onImport} disabled={isImporting || valid.length === 0}>
            {isImporting ? 'Importing...' : `Import ${valid.length} Valid Rows`}
          </Button>
        </div>
      </div>

      <Tabs defaultValue="valid">
        <TabsList>
          <TabsTrigger value="valid">Valid ({valid.length})</TabsTrigger>
          <TabsTrigger value="rejected">Rejected ({rejected.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="valid">
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>PCBA-A S/N</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Phase</TableHead>
                  <TableHead>Qty</TableHead>
                  <TableHead>Ship Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {valid.map((row) => (
                  <TableRow key={row.rowIndex} className="bg-green-50/30">
                    <TableCell className="text-muted-foreground text-xs">{row.rowIndex}</TableCell>
                    <TableCell className="font-mono text-xs">{row.parsed?.pcba_a_sn}</TableCell>
                    <TableCell>{row.parsed?.customer ?? '—'}</TableCell>
                    <TableCell><Badge variant="success">{row.parsed?.status}</Badge></TableCell>
                    <TableCell>{row.parsed?.phase}</TableCell>
                    <TableCell className="tabular-nums">{row.parsed?.qty ?? '—'}</TableCell>
                    <TableCell className="tabular-nums">{row.parsed?.ship_date ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
        <TabsContent value="rejected">
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>PCBA-A S/N</TableHead>
                  <TableHead>Rejection Reasons</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rejected.map((row) => (
                  <TableRow key={row.rowIndex} className="bg-red-50/30">
                    <TableCell className="text-muted-foreground text-xs">{row.rowIndex}</TableCell>
                    <TableCell className="font-mono text-xs">{row.raw['PCBA-A S/N'] ?? row.raw['pcba_a_sn'] ?? '—'}</TableCell>
                    <TableCell>
                      <ul className="text-xs text-destructive space-y-0.5">
                        {row.errors.map((e, i) => <li key={i}>• {e}</li>)}
                      </ul>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
