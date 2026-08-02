/**
 * The issuing entity's letterhead details.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ INCOMPLETE ON PURPOSE. Do not invent the missing fields.              │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * `name` and `country` are the only facts this codebase actually knows
 * (README.md: "Internal — QuantumTX Pte Ltd"). Registered address, UEN/GST
 * registration number and bank details are NOT recorded anywhere in the repo,
 * and a fabricated UEN or account number on a document a customer pays against
 * is a materially worse outcome than an absent one — so every unknown is `null`
 * and the renderer simply omits the line.
 *
 * BEFORE THE FIRST REAL INVOICE GOES OUT, someone with authority must fill
 * these in. A Singapore tax invoice needs the supplier's name, address and GST
 * registration number to be a valid tax invoice at all; without them this
 * document is a proforma, not an invoice.
 *
 * WHERE THIS SHOULD LIVE EVENTUALLY: the `app_setting` store
 * (modules/shared/settings) already exists and is the right home — company
 * details are configuration, not code, and a Super Admin should be able to fix a
 * changed address without a deploy. It is hardcoded here only because
 * modules/shared/settings/** belongs to another workstream this wave and adding
 * keys to it would collide. Moving it is a small, mechanical follow-up.
 */
export type Letterhead = {
  name: string
  addressLines: string[]
  country: string | null
  uen: string | null
  gstRegNo: string | null
  email: string | null
  phone: string | null
}

export const QTX_LETTERHEAD: Letterhead = {
  name: 'QuantumTX Pte Ltd',
  addressLines: [],
  country: 'Singapore',
  uen: null,
  gstRegNo: null,
  email: null,
  phone: null,
}

/** The letterhead block, blanks already dropped — never prints "null". */
export function letterheadLines(lh: Letterhead = QTX_LETTERHEAD): string[] {
  return [
    ...lh.addressLines,
    lh.country,
    lh.uen ? `UEN ${lh.uen}` : null,
    lh.gstRegNo ? `GST Reg. No. ${lh.gstRegNo}` : null,
    lh.email,
    lh.phone,
  ]
    .map((l) => (l ?? '').trim())
    .filter((l) => l.length > 0)
}
