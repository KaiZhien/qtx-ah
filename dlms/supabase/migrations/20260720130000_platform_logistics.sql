-- ===========================================================================
-- Logistics: stock locations + delivery orders with proof-of-delivery
-- reference fields (spec §6.3 "Logistics stock" / "Post-sales" delivery_order,
-- narrowed to the Basic-module scope: CRUD + a simple DO status flow, NOT
-- stock-level accounting, NOT file uploads — POD is reference fields
-- (pod_reference/pod_received_at), not an attachment pipeline).
--
-- Belongs to the qtx-ops-platform project (see 20260718000000_platform_rbac.sql
-- header). Carries the platform_ implicit convention of the sibling platform_*
-- migrations; committing this file does nothing by itself until applied via
-- the Supabase MCP/CLI to the cloud project.
--
-- This migration also lands the deferred FK component_unit.location_id →
-- stock_location(id) that 20260720000001_platform_components.sql declared as
-- a plain nullable uuid because stock_location did not exist yet.
-- ===========================================================================

CREATE TABLE stock_location (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  country     text,
  address     text,
  notes       text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL REFERENCES app_user(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES app_user(id),
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE stock_location IS
  'Logistics stock locations (spec §6.3 "Logistics stock"), narrowed to Basic scope: identity + address/notes only, no stock_level accounting. Also the target of the deferred component_unit.location_id FK landed below.';

-- Basic CRUD only (locationService.ts) — no stock-level accounting in this
-- module, so no further indexes beyond the code uniqueness above.

CREATE TABLE delivery_order (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  do_no              text NOT NULL,
  status             text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','prepared','dispatched','delivered','cancelled')),
  customer           text,
  destination        text,
  ship_date          date,
  delivered_date     date,
  pod_reference      text,          -- reference only (e.g. a POD doc number/id) — not a file upload
  pod_received_at    timestamptz,
  import_export_ref  text,          -- reference to an import/export doc, tracked elsewhere
  carrier            text,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES app_user(id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES app_user(id),
  deleted_at         timestamptz,
  version            integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE delivery_order IS
  'Delivery orders (spec §6.3 Post-sales, Basic-module slice): structured record + POD reference fields (pod_reference/pod_received_at), never a PDF/file attachment pipeline (Basic scope explicitly excludes uploads). Status is a fixed 5-state flow (modules/logistics/domain/doStatus.ts), not an admin-editable vocabulary graph like device status — deliberately simpler for Basic scope.';
COMMENT ON COLUMN delivery_order.pod_reference IS
  'Proof-of-delivery reference (e.g. an external POD document number). Basic scope: a text field, not a file upload — see spec scope note.';
COMMENT ON COLUMN delivery_order.import_export_ref IS
  'Reference to an import/export shipping document tracked outside this table (spec §4.1 Logistics subsections: "shipping docs"). Basic scope: a reference field only.';

-- do_no unique among live rows only, matching device_sn_unique's shape (a
-- cancelled/soft-deleted DO's number can be reused).
CREATE UNIQUE INDEX delivery_order_do_no_unique ON delivery_order(do_no)
  WHERE deleted_at IS NULL;
CREATE INDEX delivery_order_status_idx ON delivery_order(status) WHERE deleted_at IS NULL;

CREATE TABLE delivery_order_line (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_order_id  uuid NOT NULL REFERENCES delivery_order(id),
  line_no            integer NOT NULL,
  device_id          uuid REFERENCES device(id),   -- NULL: not every shipped line is a registry device
  description        text,
  quantity           numeric(12,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES app_user(id)
);
COMMENT ON TABLE delivery_order_line IS
  'Delivery order line items, written once as part of the DO-create transaction (deliveryOrderService.createDeliveryOrder) and never edited afterward in Basic scope — hence created_at/created_by only, no updated_*/deleted_at/version, and no audit trigger below (nothing to trail beyond the insert the parent delivery_order create already audits).';
CREATE INDEX delivery_order_line_do_idx ON delivery_order_line(delivery_order_id);
CREATE INDEX delivery_order_line_device_idx ON delivery_order_line(device_id) WHERE device_id IS NOT NULL;

-- ── Land the deferred component_unit.location_id FK (see
--    20260720000001_platform_components.sql's column comment) ───────────────
ALTER TABLE component_unit
  ADD CONSTRAINT component_unit_location_fk FOREIGN KEY (location_id) REFERENCES stock_location(id);

-- Audit on the mutable header tables. delivery_order_line is deliberately
-- excluded — see its table comment above (insert-once, no update path).
SELECT fn_attach_audit(t) FROM unnest(ARRAY['stock_location','delivery_order']) AS t;

-- RLS deny-via-REST (R1 pattern, 20260720000000_platform_rls.sql): app reaches
-- these only via the owner pool / service_role; no anon/authenticated policy =
-- PostgREST denies all. NOT FORCE (would also gate the owner connection and
-- fn_audit's SECURITY DEFINER writes).
ALTER TABLE stock_location       ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_order       ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_order_line  ENABLE ROW LEVEL SECURITY;
