'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertCircle, AlertTriangle } from 'lucide-react'
import { GROUP_LABELS, FIELD_LABELS } from '@/lib/i18n/fields'
import { deviceSchema } from '@/lib/domain/validation'
import { confirmInvoiceDeviceAction } from '@/app/drafts/upload/actions'
import { toast } from 'sonner'
import type { DeviceInput, StatusOption, PhaseOption } from '@/lib/types'
import type { ExtractedFields } from '@/lib/services/invoiceExtractionService'

type FieldCorrection = {
  field: string
  extracted: string | null
  corrected: string | null
  confidence: number
}


interface ExtractedDeviceConfirmModalProps {
  open: boolean
  onClose: () => void
  /** Optional callback after a device is successfully created. Receives the new device ID. */
  onSuccess?: (deviceId: string) => void
  fields: ExtractedFields
  statuses: StatusOption[]
  phases: PhaseOption[]
  /** The original File the user uploaded — re-sent on confirm so nothing was persisted before. */
  file: File
  fileHash: string
}

const TEXTAREA_FIELDS = new Set(['remarks'])
const DATE_FIELDS = new Set(['build_date', 'ship_date'])
const LOW_CONFIDENCE_THRESHOLD = 0.5

function buildDefaultValues(fields: ExtractedFields): Partial<DeviceInput> {
  const get = (key: string): string => {
    const v = fields[key]?.value
    if (v == null) return ''
    return String(v)
  }
  return {
    device_sn:      get('device_sn') || null,
    product_name:   get('product_name') || null,
    model_no:       get('model_no') || null,
    pcba_a_sn:      get('pcba_a_sn'),
    pcba_a_hw_rev:  get('pcba_a_hw_rev'),
    pcba_a_bom_rev: get('pcba_a_bom_rev'),
    pcba_a_fw_ver:  get('pcba_a_fw_ver'),
    pcba_b_sn:      get('pcba_b_sn') || null,
    pcba_b_hw_rev:  get('pcba_b_hw_rev') || null,
    pcba_b_bom_rev: get('pcba_b_bom_rev') || null,
    pcba_b_fw_ver:  get('pcba_b_fw_ver') || null,
    screen_model:   get('screen_model') || null,
    hmi_ver:        get('hmi_ver') || null,
    build_date:     get('build_date') || null,
    ship_date:      get('ship_date') || null,
    qty:            fields.qty?.value != null ? Number(fields.qty.value) || null : null,
    destination:    get('destination') || null,
    customer:       get('customer') || null,
    status:         get('status') || '',
    phase:          get('phase') || '',
    remarks:        get('remarks') || null,
  }
}

export function ExtractedDeviceConfirmModal({
  open,
  onClose,
  onSuccess,
  fields,
  statuses,
  phases,
  file,
  fileHash,
}: ExtractedDeviceConfirmModalProps) {
  const router = useRouter()
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [existingDeviceId, setExistingDeviceId] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const form = useForm<DeviceInput>({
    resolver: zodResolver(deviceSchema) as any,
    defaultValues: buildDefaultValues(fields),
  })

  const errors = form.formState.errors

  async function handleConfirm(data: DeviceInput) {
    setIsSubmitting(true)
    setSubmitError(null)
    setExistingDeviceId(null)
    try {
      const formData = new FormData()
      formData.append('file', file)

      // Compute corrections: fields where user changed Claude's extracted value
      const defaults = buildDefaultValues(fields)
      const corrections: FieldCorrection[] = []
      for (const key of Object.keys(data) as (keyof DeviceInput)[]) {
        const extracted = defaults[key] ?? null
        const corrected = data[key] ?? null
        const extractedStr = extracted == null ? null : String(extracted)
        const correctedStr = corrected == null ? null : String(corrected)
        if (extractedStr !== correctedStr) {
          corrections.push({
            field: key as string,
            extracted: extractedStr,
            corrected: correctedStr,
            confidence: fields[key as string]?.confidence ?? 1,
          })
        }
      }

      const result = await confirmInvoiceDeviceAction(data, formData, fileHash, fields, corrections)

      if ('error' in result) {
        setSubmitError(result.error)
        toast.error(result.error)
        if ('existingId' in result && result.existingId) {
          setExistingDeviceId(result.existingId as string)
        }
      } else {
        toast.success('Device created successfully')
        if (onSuccess) {
          onSuccess(result.id)
        } else {
          onClose()
          router.push(`/devices/${result.id}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Confirm failed'
      setSubmitError(msg)
      toast.error(msg)
    } finally {
      setIsSubmitting(false)
    }
  }

  // Count low-confidence fields so we can warn the user
  const lowConfidenceFields = Object.entries(fields).filter(
    ([, f]) => f.value !== null && f.confidence < LOW_CONFIDENCE_THRESHOLD
  )

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Review Extracted Device Data</DialogTitle>
          <DialogDescription>
            Claude extracted the following device fields from your invoice. Review and correct
            any values before confirming — the device row will be created on Confirm.
          </DialogDescription>
        </DialogHeader>

        {lowConfidenceFields.length > 0 && (
          <Alert variant="default" className="border-yellow-400 text-yellow-700 bg-yellow-50">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {lowConfidenceFields.length} field{lowConfidenceFields.length > 1 ? 's were' : ' was'} extracted
              with low confidence and{lowConfidenceFields.length > 1 ? ' are' : ' is'} flagged below.
              Please double-check these values.
            </AlertDescription>
          </Alert>
        )}

        {submitError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {existingDeviceId ? (
                <>
                  A device with this PCBA-A S/N already exists.{' '}
                  <Link href={`/devices/${existingDeviceId}`} className="underline font-medium">
                    View existing device
                  </Link>
                </>
              ) : (
                submitError
              )}
            </AlertDescription>
          </Alert>
        )}

        <form onSubmit={form.handleSubmit(handleConfirm)} className="space-y-6">
          {GROUP_LABELS.map((group) => (
            <section key={group.key} className="space-y-4">
              <div className="border-b pb-1">
                <h3 className="font-semibold">{group.en}</h3>
                <p className="text-xs text-muted-foreground">{group.zh}</p>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {group.fields.map((fieldKey) => {
                  const label = FIELD_LABELS[fieldKey]
                  const extractedField = fields[fieldKey]
                  const isLowConfidence =
                    extractedField?.value !== null &&
                    extractedField?.confidence < LOW_CONFIDENCE_THRESHOLD
                  const isStatus = fieldKey === 'status'
                  const isPhase = fieldKey === 'phase'
                  const isTextarea = TEXTAREA_FIELDS.has(fieldKey)
                  const fieldError = (errors as Record<string, { message?: string }>)[fieldKey]?.message

                  return (
                    <div key={fieldKey} className={isTextarea ? 'sm:col-span-2' : ''}>
                      <Label htmlFor={fieldKey} className="flex flex-col gap-0.5 mb-1.5">
                        <span className="flex items-center gap-1.5">
                          {label?.en ?? fieldKey}
                          {isLowConfidence && (
                            <span
                              title={`Low confidence: ${Math.round((extractedField.confidence) * 100)}% — please verify`}
                              className="inline-flex items-center"
                            >
                              <AlertTriangle className="h-3 w-3 text-yellow-500" />
                            </span>
                          )}
                        </span>
                        <span className="text-xs font-normal text-muted-foreground">{label?.zh}</span>
                      </Label>

                      {isStatus ? (
                        <Select
                          onValueChange={(v) => form.setValue('status', v)}
                          defaultValue={buildDefaultValues(fields).status ?? ''}
                        >
                          <SelectTrigger className={isLowConfidence ? 'border-yellow-400' : ''}>
                            <SelectValue placeholder="Select status..." />
                          </SelectTrigger>
                          <SelectContent>
                            {statuses.map((s) => (
                              <SelectItem key={s.code} value={s.code}>
                                {s.label_en} · {s.label_zh}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : isPhase ? (
                        <Select
                          onValueChange={(v) => form.setValue('phase', v)}
                          defaultValue={buildDefaultValues(fields).phase ?? ''}
                        >
                          <SelectTrigger className={isLowConfidence ? 'border-yellow-400' : ''}>
                            <SelectValue placeholder="Select phase..." />
                          </SelectTrigger>
                          <SelectContent>
                            {phases.map((p) => (
                              <SelectItem key={p.code} value={p.code}>
                                {p.label_en} · {p.label_zh}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : isTextarea ? (
                        <Textarea
                          id={fieldKey}
                          rows={4}
                          {...form.register(fieldKey as keyof DeviceInput)}
                          className={[
                            fieldError ? 'border-destructive' : '',
                            isLowConfidence ? 'border-yellow-400' : '',
                          ].filter(Boolean).join(' ')}
                        />
                      ) : (
                        <Input
                          id={fieldKey}
                          type={DATE_FIELDS.has(fieldKey) ? 'date' : 'text'}
                          {...form.register(fieldKey as keyof DeviceInput)}
                          className={[
                            fieldError ? 'border-destructive' : '',
                            isLowConfidence ? 'border-yellow-400' : '',
                          ].filter(Boolean).join(' ')}
                        />
                      )}

                      {fieldError && (
                        <p className="text-xs text-destructive mt-1">{fieldError}</p>
                      )}

                      {isLowConfidence && extractedField.source_quote && !fieldError && (
                        <p className="text-xs text-yellow-600 mt-1 truncate" title={extractedField.source_quote}>
                          From invoice: &ldquo;{extractedField.source_quote}&rdquo;
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          ))}

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving device...' : 'Confirm & Create Device'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
