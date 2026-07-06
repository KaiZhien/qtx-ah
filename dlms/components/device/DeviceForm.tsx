'use client'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { GROUP_LABELS, FIELD_LABELS } from '@/lib/i18n/fields'
import { deviceSchema } from '@/lib/domain/validation'
import type { DeviceRow, StatusOption, PhaseOption, DeviceInput } from '@/lib/types'
import { AlertCircle } from 'lucide-react'

interface DeviceFormProps {
  initialData?: DeviceRow
  statuses: StatusOption[]
  phases: PhaseOption[]
  onSubmit: (data: DeviceInput) => Promise<void>
  isSubmitting?: boolean
  conflictError?: string | null
  submitLabel?: string
  onPcbaSnChange?: (pcbaASn: string, pcbaBSn: string) => void
}

const TEXTAREA_FIELDS = new Set(['remarks'])
const DATE_FIELDS = new Set(['build_date', 'ship_date', 'next_service_date'])

export function DeviceForm({ initialData, statuses, phases, onSubmit, isSubmitting, conflictError, submitLabel, onPcbaSnChange }: DeviceFormProps) {
  const form = useForm<DeviceInput>({
    resolver: zodResolver(deviceSchema) as any,
    defaultValues: initialData ? {
      device_sn: initialData.device_sn,
      product_name: initialData.product_name,
      model_no: initialData.model_no,
      pcba_a_sn: initialData.pcba_a_sn,
      pcba_a_hw_rev: initialData.pcba_a_hw_rev,
      pcba_a_bom_rev: initialData.pcba_a_bom_rev,
      pcba_a_fw_ver: initialData.pcba_a_fw_ver,
      pcba_b_sn: initialData.pcba_b_sn,
      pcba_b_hw_rev: initialData.pcba_b_hw_rev,
      pcba_b_bom_rev: initialData.pcba_b_bom_rev,
      pcba_b_fw_ver: initialData.pcba_b_fw_ver,
      screen_model: initialData.screen_model,
      hmi_ver: initialData.hmi_ver,
      build_date: initialData.build_date,
      ship_date: initialData.ship_date,
      next_service_date: initialData.next_service_date,
      qty: initialData.qty,
      destination: initialData.destination,
      customer: initialData.customer,
      status: initialData.status,
      phase: initialData.phase,
      remarks: initialData.remarks,
    } : { status: '', phase: '' },
  })

  const errors = form.formState.errors

  useEffect(() => {
    if (!onPcbaSnChange) return
    const { unsubscribe } = form.watch((values, { name }) => {
      if (name === 'pcba_a_sn' || name === 'pcba_b_sn') {
        onPcbaSnChange(values.pcba_a_sn ?? '', values.pcba_b_sn ?? '')
      }
    })
    return unsubscribe
  }, [form, onPcbaSnChange])

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
      {conflictError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{conflictError}</AlertDescription>
        </Alert>
      )}

      {GROUP_LABELS.map((group) => (
        <section key={group.key} className="space-y-4">
          <div className="border-b pb-1">
            <h3 className="font-semibold">{group.en}</h3>
            <p className="text-xs text-muted-foreground">{group.zh}</p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {group.fields.map((fieldKey) => {
              const label = FIELD_LABELS[fieldKey]
              const isStatus = fieldKey === 'status'
              const isPhase = fieldKey === 'phase'
              const isTextarea = TEXTAREA_FIELDS.has(fieldKey)
              const fieldError = (errors as Record<string, { message?: string }>)[fieldKey]?.message

              return (
                <div key={fieldKey} className={isTextarea ? 'sm:col-span-2' : ''}>
                  <Label htmlFor={fieldKey} className="flex flex-col gap-0.5 mb-1.5">
                    <span>{label?.en ?? fieldKey}</span>
                    <span className="text-xs font-normal text-muted-foreground">{label?.zh}</span>
                  </Label>

                  {isStatus ? (
                    <Select
                      onValueChange={(v) => form.setValue('status', v)}
                      defaultValue={initialData?.status}
                    >
                      <SelectTrigger><SelectValue placeholder="Select status..." /></SelectTrigger>
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
                      defaultValue={initialData?.phase}
                    >
                      <SelectTrigger><SelectValue placeholder="Select phase..." /></SelectTrigger>
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
                      className={fieldError ? 'border-destructive' : ''}
                    />
                  ) : (
                    <Input
                      id={fieldKey}
                      type={DATE_FIELDS.has(fieldKey) ? 'date' : 'text'}
                      {...form.register(fieldKey as keyof DeviceInput)}
                      className={fieldError ? 'border-destructive' : ''}
                    />
                  )}
                  {fieldError && (
                    <p className="text-xs text-destructive mt-1">{fieldError}</p>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ))}

      <div className="flex gap-3 pt-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving...' : (submitLabel ?? (initialData ? 'Save Changes' : 'Create Device'))}
        </Button>
        <Button type="button" variant="outline" onClick={() => history.back()}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
