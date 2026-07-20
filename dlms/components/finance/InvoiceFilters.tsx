'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { INVOICE_STATUSES } from '@/modules/finance/domain/invoiceStatus'
import type { BuyerOption } from '@/modules/finance/services/buyerService'

type Props = { buyerOptions: BuyerOption[] }

const ALL_STATUS = '__all__'
const ALL_BUYER = '__all__'
const STATUS_LABEL: Record<string, string> = { draft: 'Draft', issued: 'Issued', paid: 'Paid', void: 'Void' }

/**
 * Status + buyer filters, reflected in the URL's search params — same
 * convention as manufacturing/DeviceFilters.tsx — so every combination is a
 * plain server refetch through invoices/page.tsx.
 */
export function InvoiceFilters({ buyerOptions }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const status = searchParams.get('status') ?? ALL_STATUS
  const buyerId = searchParams.get('buyer') ?? ALL_BUYER

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (value && value !== ALL_STATUS && value !== ALL_BUYER) params.set(key, value)
    else params.delete(key)
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <div className="flex flex-wrap items-end gap-4">
      <div>
        <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Status</label>
        <Select value={status} onValueChange={(v) => setParam('status', v)}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_STATUS}>All statuses</SelectItem>
            {INVOICE_STATUSES.map((s) => <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Buyer</label>
        <Select value={buyerId} onValueChange={(v) => setParam('buyer', v)}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_BUYER}>All buyers</SelectItem>
            {buyerOptions.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
