-- ===========================================================================
-- Finance module — basic portions (spec §4.1/§6.3, D18: Finance = sales
-- invoices only; SGD-only decision). buyer + sales_invoice + sales_invoice_line
-- give CRUD and a simple 4-state invoice status flow. Deliberately NOT built
-- here: the threshold-approval engine (spec §3.2 permission 8/BR-4 — invoices
-- ≥ a configurable threshold route to an approval queue) and PDF generation
-- (spec BR-7 — invoices are structured records with attached official PDFs;
-- `file` attachment isn't part of this basic build). Those are later work on
-- top of this schema, not a reshape of it.
--
-- Also lands the device.buyer_id FK that 20260719000001_platform_devices.sql
-- deliberately deferred (its column comment: "no FK constraint until [buyer]
-- exists") — see the ALTER TABLE below.
--
-- House DDL conventions (matching 20260719000001_platform_devices.sql /
-- 20260720000001_platform_components.sql): id uuid PK default gen_random_uuid(),
-- created_at/created_by NOT NULL, updated_at NOT NULL/updated_by nullable,
-- deleted_at nullable (soft delete only), version int default 1 (optimistic
-- lock). RLS: ENABLE ROW LEVEL SECURITY with NO policies and NEVER FORCE (deny-
-- via-REST — see 20260720000000_platform_rls.sql's header for why: all real
-- app reads/writes for this module go through withTransaction() as the table
-- owner or the service-role client, neither of which RLS policies gate; FORCE
-- would break both).
-- ===========================================================================

CREATE TABLE buyer (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  country          text,                 -- free text: spec's SG/MY focus is a near-term
                                          -- fact about the business, not a schema constraint
  contact_name     text,
  contact_email    text,
  contact_phone    text,
  billing_address  text,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL REFERENCES app_user(id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES app_user(id),
  deleted_at       timestamptz,
  version          integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE buyer IS
  'Finance module buyer/customer record (spec §6.3, D18 sales-invoices-only build). Owns many sales_invoice rows and, once a device is delivered, is referenced from device.buyer_id (spec §4.2 hub model).';
COMMENT ON COLUMN buyer.country IS
  'Free text. Spec §1 names Singapore/Malaysia as the near-term business focus but does not constrain this to a vocabulary table.';

CREATE TABLE sales_invoice (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no     text NOT NULL,
  buyer_id       uuid NOT NULL REFERENCES buyer(id),
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','issued','paid','void')),
  issue_date     date,
  due_date       date,
  currency       text NOT NULL DEFAULT 'SGD' CHECK (currency = 'SGD'),
  subtotal_sgd   numeric(12,2),
  tax_sgd        numeric(12,2),
  total_sgd      numeric(12,2),
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL REFERENCES app_user(id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES app_user(id),
  deleted_at     timestamptz,
  version        integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE sales_invoice IS
  'Sales invoice header (spec D18: Finance = sales invoices only, this basic build). status is a simple 4-state flow (draft/issued/paid/void — modules/finance/domain/invoiceStatus.ts), a deliberately narrower stand-in for the full spec §6.3 draft→pending_approval→final→paid/void lifecycle, which needs the threshold-approval engine this build does not include.';
COMMENT ON COLUMN sales_invoice.currency IS
  'Fixed at SGD for this basic build (D18 SGD-only decision). The CHECK constraint is the single source of truth — never trust application code to enforce it.';
COMMENT ON COLUMN sales_invoice.subtotal_sgd IS
  'Sum of sales_invoice_line.amount_sgd, computed server-side (invoiceService.createInvoice) — never entered directly.';
COMMENT ON COLUMN sales_invoice.total_sgd IS
  'subtotal_sgd + tax_sgd, computed server-side. Recomputed whenever tax_sgd changes (invoiceService.updateInvoice).';

-- Partial unique index (not an inline UNIQUE) so a soft-deleted invoice frees
-- its number for reuse — same pattern as device_sn_unique.
CREATE UNIQUE INDEX sales_invoice_invoice_no_unique ON sales_invoice(invoice_no)
  WHERE deleted_at IS NULL;
CREATE INDEX sales_invoice_buyer_idx ON sales_invoice(buyer_id) WHERE deleted_at IS NULL;
CREATE INDEX sales_invoice_status_idx ON sales_invoice(status) WHERE deleted_at IS NULL;

CREATE TABLE sales_invoice_line (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      uuid NOT NULL REFERENCES sales_invoice(id),
  line_no         integer NOT NULL,
  description     text NOT NULL,
  quantity        numeric(12,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_sgd  numeric(12,2) NOT NULL,
  amount_sgd      numeric(12,2) NOT NULL,
  device_id       uuid REFERENCES device(id),   -- device already exists (unlike the
                                                 -- deferred component_* FKs) — a real FK
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES app_user(id),
  CONSTRAINT sales_invoice_line_no_unique UNIQUE (invoice_id, line_no)
);
COMMENT ON TABLE sales_invoice_line IS
  'Line items, written once alongside their invoice in one transaction (invoiceService.createInvoice). No update/version columns by design — this basic build has no line-edit path (invoiceService.updateInvoice only touches header fields); a wrong line is fixed by voiding the invoice and issuing a new one.';
COMMENT ON COLUMN sales_invoice_line.amount_sgd IS
  'quantity * unit_price_sgd, computed server-side in the same INSERT — never trust a client-supplied amount.';
COMMENT ON COLUMN sales_invoice_line.device_id IS
  'Optional link to the device this line bills for (spec §4.2: reference device.id, never copy device data).';

CREATE INDEX sales_invoice_line_invoice_idx ON sales_invoice_line(invoice_id);
CREATE INDEX sales_invoice_line_device_idx ON sales_invoice_line(device_id) WHERE device_id IS NOT NULL;

-- Land the deferred FK: 20260719000001_platform_devices.sql declared
-- device.buyer_id as a plain nullable uuid because buyer didn't exist yet
-- ("no FK constraint until then" — see that migration's column comment).
-- buyer now exists, so the constraint lands here, exactly as promised.
ALTER TABLE device ADD CONSTRAINT device_buyer_fk FOREIGN KEY (buyer_id) REFERENCES buyer(id);

SELECT fn_attach_audit(t) FROM unnest(ARRAY['buyer','sales_invoice','sales_invoice_line']) AS t;

-- RLS deny-via-REST (R1 pattern, see 20260720000000_platform_rls.sql): no
-- anon/authenticated policy = PostgREST denies all; the app never reaches
-- these tables as those roles. NOT FORCE — see file header.
ALTER TABLE buyer               ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_invoice       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_invoice_line  ENABLE ROW LEVEL SECURITY;
