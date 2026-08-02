-- ===========================================================================
-- Notifications (spec §6.3): `notification` + `notification_pref`.
--
-- Closes a gap both prior slices recorded and deferred: `status_transition.notify_roles`
-- has been carried in the outbox payload since 20260719000001_platform_devices.sql and
-- read by NOTHING. This migration creates the two tables that make it mean something,
-- and the drain becomes their first producer.
--
-- WHAT A NOTIFICATION IS, AND WHAT IT IS NOT. It is a DELIVERY ARTIFACT addressed to one
-- person — "this happened, and it is your business" — not a record of the thing that
-- happened. The event itself is already recorded on its own table and in audit_log, and
-- the handoff is already recorded in `outbox`. That distinction settles several of the
-- choices below: a notification carries no `version` (nobody contends for it), it is
-- never soft-deleted (a delivered message is a historical fact), and deleting the record
-- it points at must not cascade to it — the polymorphic entity_type/entity_id pair
-- carries no FK, for the reason 20260802000000_platform_approvals.sql states at length
-- and spec §6.1/§6.3 names as the shared mechanism for task_link, approval, file,
-- notification and audit_log alike.
--
-- WHY `category` IS UNCONSTRAINED, AND WHY THAT IS WHAT MAKES PREFERENCES WORK. Same
-- reasoning as outbox.aggregate_type: a CHECK listing today's categories would make
-- every new one a schema migration. The consequence here is better than merely cheap.
-- Preferences are keyed (user_id, category), and the ABSENCE of a row means DEFAULTS
-- (see notification_pref's COMMENT) — so a category added in code next week is delivered
-- to everyone under the default policy immediately, with no backfill and no migration.
-- The alternative (a row per user per category, seeded) would need a backfill for every
-- new category AND for every new user, and would silently under-deliver whenever one was
-- forgotten. Nothing here validates the category string; modules/shared/notifications
-- owns that vocabulary, the same way HANDOFF_TEMPLATES owns template keys.
--
-- WHY dedupe_key EXISTS: THE REMINDER SWEEP'S IDEMPOTENCY, AS A DATABASE FACT.
-- Spec §8.3 wants due-tomorrow and overdue reminders from a daily sweep. A sweep that is
-- retried, run twice by an operator, or fired twice by an overlapping schedule must not
-- notify twice — and "did I already run today?" state in a job table is exactly the wrong
-- mechanism, because it is wrong under partial failure (the job crashed halfway; did it
-- notify or not?) and under concurrency. Instead each reminder computes a deterministic
-- key that already contains everything that makes it unique — WHAT, about WHICH row, on
-- WHICH day — and the partial unique index below turns a repeat into a no-op via
-- ON CONFLICT DO NOTHING. Idempotency is then a property of the data, true for every
-- caller, rather than a property of one job's bookkeeping. A half-completed sweep re-run
-- five minutes later finishes the job and re-notifies nobody.
--
-- It is PARTIAL (`WHERE dedupe_key IS NOT NULL`) because most notifications have no
-- natural key and must never be collapsed: two devices genuinely entering Logistics on
-- the same day are two notifications, not one. Only a caller that can name what makes its
-- message unique opts in.
--
-- WHY emailed_at IS A TIMESTAMP AND NOT A BOOLEAN, AND WHY IT IS WRITTEN LATE. It records
-- that an email ACTUALLY WENT OUT, not that one was wanted — `notification_pref.email`
-- records the wanting. The two must not be conflated: the platform is deployed today with
-- no RESEND_API_KEY, and a system that stamped emailed_at on intent would report a mail
-- history that never happened. So the stamp is written only by the delivery path, only on
-- a confirmed send, and always AFTER the inserting transaction has committed — sending
-- mail inside a transaction is unrecallable if that transaction later rolls back, and an
-- email is the one side effect no ROLLBACK can reach. NULL therefore means "not emailed",
-- for every reason (not wanted, not configured, failed, still queued), which is the honest
-- reading and the only one the column can support.
--
-- THE DRAIN IS A PRODUCER, AND IT NEEDED NO NEW AUTHORITY. The outbox drain's automation
-- principal (22222222-…, 20260731000000_platform_outbox.sql) fans events out to these
-- rows inside its existing exactly-once transaction. It does so on `create_records`, which
-- it ALREADY HOLDS in every module — no grant was added, no revocation loosened, and
-- fn_seed_system_actor()'s keep-list is untouched. That is deliberate and worth stating in
-- the schema: a notification is created, not edited, so the narrowest permission that
-- could express the act is the one it already had. Had this needed `edit_records` the
-- principal's ceiling would have had to move, and that would have been a security decision
-- rather than a wiring one.
--
-- Belongs to the `qtx-ops-platform` project. Carries the `platform_` token so
-- __tests__/integration/setup.ts picks it up; committing this file does nothing by itself
-- until applied via the Supabase MCP/CLI. FOUR MIGRATIONS ALREADY SIT UNAPPLIED AHEAD OF
-- IT (manufacturing_import, outbox, modifications, approvals) and the order is strict —
-- this one references app_user only, but the drain that produces into it does not exist
-- without 20260731000000_platform_outbox.sql.
-- ===========================================================================

CREATE TABLE notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The RECIPIENT. Not "the audience" — fan-out happens at write time, one row per
  -- person, because read state and email state are per-person facts.
  user_id uuid NOT NULL REFERENCES app_user(id),
  category text NOT NULL,                  -- unconstrained on purpose; see the header
  title text NOT NULL,
  body text,
  -- The record this is ABOUT, polymorphic and FK-free (see the header). `module` is
  -- stored rather than derived for the same reason approval.module is: it scopes
  -- visibility, and it is a property of the entity rather than of the category.
  entity_type text,
  entity_id uuid,
  module text,
  -- Where clicking it should go. Stored rather than rebuilt from entity_type at read
  -- time so a notification keeps working after a route moves: the link a user was sent
  -- is a historical fact, and a 404 they can report beats a link silently retargeted.
  url text,
  dedupe_key text,                         -- opt-in idempotency; see the header
  read_at timestamptz,
  emailed_at timestamptz,                  -- ACTUAL delivery only; see the header
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The actor that CAUSED it. Usually the automation principal (the drain) or the human
  -- whose action triggered the fan-out. Distinct from user_id, which is who receives it.
  created_by uuid NOT NULL REFERENCES app_user(id)
);
COMMENT ON TABLE notification IS
  'In-app notifications (spec §6.3), one row per RECIPIENT per event — fanned out at write time because read and email state are per-person facts. Deliberately exempt from the version/deleted_at table shape: a delivered message is a historical fact that is never soft-deleted, and the only mutations are the owner stamping read_at and the delivery path stamping emailed_at, neither of which has a competing writer for optimistic concurrency to arbitrate. entity_type/entity_id carry no FK (spec §6.1 polymorphic-reference convention), so a notification survives the record it points at being removed — which is correct: it is evidence that someone was told, not a handle on the thing they were told about.';
COMMENT ON COLUMN notification.category IS
  'Left unconstrained, same reasoning as outbox.aggregate_type: a CHECK would make every new category a schema migration. The vocabulary lives in modules/shared/notifications/domain/categories.ts. Because notification_pref rows are optional and their absence means defaults, a category added in code is delivered under the default policy immediately — no backfill, no migration.';
COMMENT ON COLUMN notification.dedupe_key IS
  'Opt-in idempotency key, unique per user (partial index below). A caller that can name what makes its message unique — WHAT, about WHICH row, on WHICH day — sets it and inserts with ON CONFLICT DO NOTHING, which makes re-running the producing job a no-op. This is how the spec §8.3 reminder sweep is idempotent: as a property of the data, true for every caller and correct under partial failure and concurrency, rather than as one job''s "have I run today" bookkeeping. NULL for everything with no natural key, which must never be collapsed — two devices entering Logistics on the same day are two notifications.';
COMMENT ON COLUMN notification.emailed_at IS
  'When an email ACTUALLY went out — never when one was merely wanted (notification_pref.email records the wanting). Written only by the delivery path, only on a confirmed send, and only AFTER the inserting transaction committed, because a send cannot be rolled back. NULL means not emailed for ANY reason: not wanted, not configured (no RESEND_API_KEY — the platform''s state today), failed, or still queued.';

-- The bell's query, and the only hot one: unread, newest first, for one person.
-- Partial so its cost stays proportional to the unread backlog rather than to every
-- notification ever delivered — read rows accumulate forever and must not be paid for
-- on every page load.
CREATE INDEX notification_unread_idx ON notification(user_id, created_at DESC)
  WHERE read_at IS NULL;
-- The list surface (which shows read ones too) and the "mark all read" sweep.
CREATE INDEX notification_user_idx ON notification(user_id, created_at DESC);
-- The idempotency guarantee itself. Per USER, not global: the same event legitimately
-- produces one row for each of five approvers, and they differ only by recipient.
CREATE UNIQUE INDEX notification_dedupe_idx ON notification(user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
-- Covers the app_user FKs, per the convention outbox_created_by states: an unindexed
-- referencing column turns every parent delete into a sequential scan.
CREATE INDEX notification_created_by_idx ON notification(created_by);
-- Record panels ("what has been said about this invoice?").
CREATE INDEX notification_entity_idx ON notification(entity_type, entity_id)
  WHERE entity_type IS NOT NULL;

CREATE TABLE notification_pref (
  user_id uuid NOT NULL REFERENCES app_user(id),
  category text NOT NULL,
  in_app boolean NOT NULL DEFAULT true,
  email boolean NOT NULL DEFAULT false,
  digest boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user(id),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, category)
);
COMMENT ON TABLE notification_pref IS
  'Per-user, per-category delivery preferences (spec §6.3). A MISSING ROW IS NOT "NO PREFERENCES" — it is the DEFAULTS (in-app on, email off, digest off), resolved in modules/shared/notifications/domain/preferences.ts. That is what lets a new category ship without a backfill, and what keeps a newly invited user notified from their first minute rather than silently muted until someone seeds their rows. Writes are upserts; a user only ever edits their own row (the service enforces it — there is no admin surface for editing someone else''s delivery preferences, which would be a way to silence a person''s alerts without their knowledge).';
COMMENT ON COLUMN notification_pref.in_app IS
  'Whether the bell shows this category. Defaults TRUE: an in-app notification is free to deliver and free to ignore, and the failure mode of over-delivery (noise) is recoverable by the user while the failure mode of under-delivery (missing an approval you were the only approver for) is not.';
COMMENT ON COLUMN notification_pref.email IS
  'Whether this category is also emailed. Defaults FALSE — email is intrusive, costs money, and leaves the platform; opting in is the user''s decision, and no default should mail people who never asked. Independent of in_app: turning the bell off does not silence email, because they answer different questions ("do I want to see this here" vs "do I want to be interrupted").';
COMMENT ON COLUMN notification_pref.digest IS
  'Whether this category may be rolled into a periodic digest instead of sent immediately. Stored and honoured by the preference resolver from day one; NO DIGEST JOB CONSUMES IT YET (spec §8.3''s digest is a separate slice) — so a user who sets it today is recording an intention that the immediate-send path already respects by suppressing the individual email.';

-- Audited: a preference change is a configuration change about who hears about what, and
-- "why did nobody get told?" is answerable only if the trail records the flag being
-- turned off and by whom. `notification` itself is audited too, per the house rule that
-- every mutable table carries fn_audit — see the report's carried findings for the one
-- observation that comes with it (a 50-row "mark all read" writes 50 audit rows; the
-- volumes here are small enough that consistency was preferred to a bespoke exemption).
--
-- ONE CONSEQUENCE WORTH STATING, in the same spirit as the approvals migration noting that
-- app_setting was the first AUDITED TEXT-KEYED table: `notification_pref` is the first
-- AUDITED COMPOSITE-KEYED table in this schema. fn_audit derives audit_log.row_id from
-- (new_values->>'id')::uuid inside an exception handler, so a table with no `id` column
-- yields row_id NULL rather than an error — which is exactly what audit_log.row_id's own
-- COMMENT already anticipates ("NULL for composite-keyed tables"). No change is needed
-- anywhere; its trail rows are found by table_name plus new_values->>'user_id'. The trail
-- stays cheap to query without audit_log_row_idx: preference rows are per-user-per-category
-- and edited rarely, not a table's worth of traffic.
SELECT fn_attach_audit(t) FROM unnest(ARRAY['notification','notification_pref']) AS t;

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_pref ENABLE ROW LEVEL SECURITY;
-- No policies, NOT FORCE — per 20260720000000_platform_rls.sql: deny-via-REST, with all
-- access through the service-role/owner write path where authorize() is the real gate.
-- Worth being explicit about for THIS pair, because a notification is the most obviously
-- "personal" data in the schema and an anon-readable policy would be a direct leak of one
-- user's work to another's browser.
