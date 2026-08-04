-- ===========================================================================
-- Engineering deepening (2/2): BOM effectivity automation.
--
-- `eco` has carried effectivity_date + effectivity_serial since
-- 20260720100000_platform_engineering.sql, and NOTHING acted on them. This
-- migration lands the two halves that make them real:
--
--   1. `ec_affected_item` — spec §6.3's "(eng_change FK, component_type/variant
--      FK, disposition)". What an ECO actually changes.
--   2. Effectivity WINDOWS on `variant_bom_line`, turning it from "the BOM" into
--      "the BOM's history", so the system can answer *what was the BOM for this
--      variant on date D / at build serial S*.
--
-- The apply step (modules/engineering/services/bomEffectivityService.ts) closes
-- the outgoing line and opens the incoming one, in ONE transaction, idempotently.
--
-- ═══ EFFECTIVITY SEMANTICS — THE DECISION, WRITTEN DOWN ═══════════════════
--
-- Effectivity has TWO INDEPENDENT AXES and an ECO may carry either or both:
--
--   DATE   (eco.effectivity_date)   calendar: "from 2026-09-01, rev B replaces A".
--                                   A planning instrument. Says nothing about a
--                                   unit built off-schedule, reworked, or held
--                                   in WIP across the boundary.
--   SERIAL (eco.effectivity_serial) build:    "from SN QTX-P-00412 onward".
--                                   Names physical units, which is what a BOM is
--                                   actually about.
--
-- >>> PRECEDENCE RULE: when a BOM question names a build serial AND the line
-- >>> carries a COMPARABLE serial bound, the SERIAL axis decides alone and
-- >>> overrides the date axis. In every other case the DATE axis decides.
--
-- Why: a serial identifies one physical unit; a date is only a proxy for "units
-- built after this day". When the exact unit is known, the unit-level fact is
-- the stronger evidence and the date bound was never more than shorthand for
-- it. The rule is also the one that survives rework — a board rebuilt in
-- December is still SN 00300 and still carries SN 00300's BOM.
--
-- "Comparable" is deliberately narrow: both sides must normalize to the SAME
-- prefix family and end in a digit run. Serials here are free text and honour
-- legacy ranged/listed forms (device.pcba_a_sn_legacy), so cross-family
-- comparison would be invention. Uncomparable ⇒ the serial axis ABSTAINS and
-- the date axis decides; it never guesses. That is why the date axis is the
-- floor and resolveBomAt REQUIRES a date but only optionally takes a serial.
--
-- >>> AND THE COROLLARY THAT IS EASY TO MISREAD: a SERIAL-ONLY ECO leaves NULL
-- >>> on the date axis, and a NULL date bound means "unbounded", so the date
-- >>> axis answers 'in' for every date. That is the correct reading of the row
-- >>> and the WRONG answer to the question: a `remove` keyed to a serial leaves
-- >>> the dropped component listed on every date-only BOM forever, and an `add`
-- >>> lists the new one on dates before the change. Only `change` leaves two
-- >>> lines, so only `change` is visible to an overlap check.
-- >>>
-- >>> The fix is NOT for the apply step to synthesise a date bound. Units built
-- >>> after any such synthetic date genuinely do still carry the old part, so
-- >>> the row would state a calendar fact that is false, permanently, on the
-- >>> axis this header calls a proxy — the invention the abstain rule exists to
-- >>> refuse. Instead the date axis still answers (it is the floor) and
-- >>> findUnderdeterminedLines reports which lines that answer is a GUESS about,
-- >>> so every surface says so and offers the serial box. Anyone reading these
-- >>> columns directly, rather than through the resolver, inherits the guess
-- >>> WITHOUT the flag: that is the third reason (after double-counting history
-- >>> and the local-midnight date shift) not to re-express this in SQL.
--
-- WINDOWS ARE HALF-OPEN [from, to). An ECO effective at point P closes the
-- outgoing line AT P and opens the incoming line AT P: no day and no serial is
-- covered twice, and none is left uncovered. An inclusive upper bound would
-- double the BOM on exactly the changeover day — the one day anybody looks at.
--
-- NULL bounds: from = NULL means "since the beginning of time" (every BOM line
-- that predates this migration), to = NULL means "still effective". This is why
-- no backfill runs below — existing rows are already correct as unbounded
-- current lines.
--
-- The authority for all of the above is the pure domain
-- modules/engineering/domain/bomEffectivity.ts, which is unit-tested directly.
-- These columns only STORE the windows; they do not decide them.
-- ===========================================================================

-- ── 1. ec_affected_item ────────────────────────────────────────────────────
CREATE TABLE ec_affected_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  eco_id uuid NOT NULL REFERENCES eco(id),
  -- variant_id is NOT NULL on purpose. The apply step must know EXACTLY which
  -- BOM it rewrites; an "all variants" wildcard would also silently rewrite the
  -- BOM of variants created after the ECO was written. An ECO affecting three
  -- variants carries three rows.
  variant_id uuid NOT NULL REFERENCES device_variant(id),
  component_type_id uuid NOT NULL REFERENCES component_type(id),
  disposition text NOT NULL CHECK (disposition IN ('add','change','remove')),
  quantity integer CHECK (quantity IS NULL OR quantity >= 1),
  notes text,                            -- carried onto the new BOM line
  -- Idempotency token. Set by the apply step in the same transaction as the BOM
  -- write; a second apply of the same ECO sees it and skips. Deliberately on the
  -- ITEM, not on eco: it is the item that was or wasn't applied, and an ECO
  -- whose items were added after a first apply can still be completed.
  applied_at timestamptz,
  applied_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  -- add/change must say how many; remove must not (there is no successor line).
  CONSTRAINT ec_item_qty_rule CHECK (
    (disposition = 'remove' AND quantity IS NULL) OR
    (disposition <> 'remove' AND quantity IS NOT NULL)),
  -- applied is atomic: both stamps or neither (mirrors repair_signoff_complete).
  CONSTRAINT ec_item_applied_complete CHECK ((applied_at IS NULL) = (applied_by IS NULL))
);
COMMENT ON TABLE ec_affected_item IS
  'What an ECO changes (spec §6.3 ec_affected_item). One row per (eco, variant, component type). Applied to variant_bom_line by modules/engineering/services/bomEffectivityService.ts once the ECO reaches `implemented`; applied_at is the idempotency token that makes re-applying a no-op.';
COMMENT ON COLUMN ec_affected_item.disposition IS
  'add = this component type joins the variant BOM; change = its quantity/notes change; remove = it leaves. The apply step REFUSES an add whose open line already exists, and a change/remove with no open line — those are data errors, not silent no-ops, and they roll the whole apply back.';
COMMENT ON COLUMN ec_affected_item.applied_at IS
  'Idempotency token. NULL = not yet applied. Set in the SAME transaction as the variant_bom_line write, with the row held FOR UPDATE, so two concurrent applies cannot double-apply.';

-- One row per (eco, variant, component type): two contradictory items for the
-- same target would make the apply order-dependent.
CREATE UNIQUE INDEX ec_affected_item_unique
  ON ec_affected_item(eco_id, variant_id, component_type_id) WHERE deleted_at IS NULL;
CREATE INDEX ec_affected_item_eco_idx ON ec_affected_item(eco_id) WHERE deleted_at IS NULL;
CREATE INDEX ec_affected_item_variant_idx ON ec_affected_item(variant_id) WHERE deleted_at IS NULL;

-- ── 2. Effectivity windows on variant_bom_line ─────────────────────────────
ALTER TABLE variant_bom_line
  ADD COLUMN effective_from_date   date,
  ADD COLUMN effective_to_date     date,
  ADD COLUMN effective_from_serial text,
  ADD COLUMN effective_to_serial   text,
  ADD COLUMN created_by_eco_id     uuid REFERENCES eco(id),
  ADD COLUMN superseded_by_eco_id  uuid REFERENCES eco(id);

COMMENT ON COLUMN variant_bom_line.effective_from_date IS
  'INCLUSIVE lower bound on the date axis; NULL = since the beginning of time. See this migration''s header for the date-vs-serial precedence rule.';
COMMENT ON COLUMN variant_bom_line.effective_to_date IS
  'EXCLUSIVE upper bound on the date axis; NULL = still effective. Half-open so the outgoing and incoming lines of one ECO neither overlap nor leave a gap on the changeover day.';
COMMENT ON COLUMN variant_bom_line.effective_from_serial IS
  'INCLUSIVE lower bound on the build-serial axis; NULL = unbounded. Free text (legacy ranged/listed serials are honoured); ordering is by normalized prefix family + trailing digit run, and an uncomparable pair makes this axis ABSTAIN so the date axis decides.';
COMMENT ON COLUMN variant_bom_line.effective_to_serial IS
  'EXCLUSIVE upper bound on the build-serial axis; NULL = still effective.';
COMMENT ON COLUMN variant_bom_line.created_by_eco_id IS
  'The ECO whose affected item opened this line. NULL for lines that predate effectivity automation or were entered by hand.';
COMMENT ON COLUMN variant_bom_line.superseded_by_eco_id IS
  'The ECO whose affected item closed this line (change or remove). Together with created_by_eco_id this is the full provenance chain for any BOM revision.';

-- Only the date axis can be range-checked in SQL; serial bounds are free text
-- with no total order at the column level (see the header), so their ordering is
-- the domain module's job and is unit-tested there.
--
-- THE ASYMMETRY IS LOAD-BEARING AND IS NOT BELT-AND-BRACES. Change orders are
-- approved in APPROVAL order, never in effectivity order, so applying one whose
-- point sits below the line it would close is ordinary. On this axis the CHECK
-- catches it (as a raw 23514 the operator cannot act on); on the serial axis
-- NOTHING catches it, and [QTX-P-00500, QTX-P-00300) is simply written, leaving
-- the line unreachable at every serial and the history table rendering the
-- inverted pair with no flag. Both axes are therefore refused up front by
-- closesBeforeItOpened in the domain, called by the apply step before the
-- close-UPDATE — so this CHECK is the second line of defence on one axis and the
-- service is the ONLY line of defence on the other.
ALTER TABLE variant_bom_line
  ADD CONSTRAINT bom_line_date_window CHECK (
    effective_from_date IS NULL OR effective_to_date IS NULL
    OR effective_from_date <= effective_to_date);

-- THE INVARIANT SWAP. The original constraint was
--   UNIQUE (variant_id, component_type_id)
-- which by construction permits exactly one line per component type per variant
-- — i.e. no history at all. Replace it with a PARTIAL unique index over only the
-- still-OPEN line, so superseded rows accumulate freely while "at most one
-- current line per (variant, component type)" survives untouched.
--
-- "Open" = unbounded on BOTH axes. A line closed on either axis drops out of the
-- predicate, which is what lets its successor be inserted. It also means an ECO
-- carrying NEITHER an effectivity_date NOR an effectivity_serial cannot be
-- applied: closing would set both bounds to NULL, the old line would stay open
-- alongside the new one, and this index would reject it. The service catches
-- that case up front with a clear error rather than surfacing a raw 23505.
--
-- THAT GUARD COVERS THE STATED CAUSE, NOT EVERY CAUSE. The apply's open-line
-- lookup is `SELECT id … FOR UPDATE`, which takes NO LOCK when it returns zero
-- rows — so two applies of two different ECOs, each `add`ing the same (variant,
-- component type) not yet on the BOM, both see nothing and both INSERT, and the
-- second hits this index. It rolls back cleanly, so the index is doing its job;
-- the operator just learned nothing. The apply therefore takes a transaction-
-- scoped pg_advisory_xact_lock on (variant, component type) BEFORE the lookup —
-- a lock keyed on values exists before the row does — walking its items in
-- (variant_id, component_type_id) order so two applies can never deadlock.
--
-- Safe to create without a backfill: every existing row has both to-bounds NULL,
-- so all of them fall inside the predicate — and the constraint being dropped
-- already guaranteed they are unique on exactly this key.
ALTER TABLE variant_bom_line DROP CONSTRAINT bom_line_unique;
CREATE UNIQUE INDEX bom_line_open_unique ON variant_bom_line(variant_id, component_type_id)
  WHERE deleted_at IS NULL AND effective_to_date IS NULL AND effective_to_serial IS NULL;

-- History lookups: "every line this variant ever had", newest window first.
CREATE INDEX bom_line_variant_history_idx
  ON variant_bom_line(variant_id, component_type_id, effective_from_date DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX bom_line_created_by_eco_idx
  ON variant_bom_line(created_by_eco_id) WHERE created_by_eco_id IS NOT NULL;
CREATE INDEX bom_line_superseded_by_eco_idx
  ON variant_bom_line(superseded_by_eco_id) WHERE superseded_by_eco_id IS NOT NULL;

COMMENT ON TABLE variant_bom_line IS
  'Per-variant bill of materials WITH EFFECTIVITY (spec §6.3 / D17). No longer one row per (variant, component type) — one row per (variant, component type, effectivity window). The current BOM is the open line (effective_to_* IS NULL), enforced by bom_line_open_unique; any historical BOM is resolved by modules/engineering/domain/bomEffectivity.ts resolveBomAt(lines, { date, serial }). Anything that counts or lists BOM rows MUST filter to the open line or go through the resolver, or it will double-count superseded history.';

-- Audit + RLS on the new table (fn_audit is shape-agnostic; variant_bom_line
-- already carries both from 20260720000001_platform_components.sql).
SELECT fn_attach_audit('ec_affected_item');

-- RLS deny-via-REST (R1 pattern): no anon/authenticated policy = PostgREST
-- denies everything; NOT FORCE so the owner pool and fn_audit's SECURITY
-- DEFINER writes are untouched.
ALTER TABLE ec_affected_item ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY statements follow, by design.
