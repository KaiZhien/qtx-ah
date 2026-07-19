-- ===========================================================================
-- Collaborative tasks (spec §4 / D28). One task system, surfaced in four places:
-- personal dashboard, module tabs, record panels, and the central task centre.
--
-- Belongs to the new `qtx-ops-platform` project (see the sibling
-- 20260718000000_platform_rbac.sql header for why this directory holds both the
-- new platform schema and the pre-existing DLMS migrations side by side).
-- ===========================================================================
CREATE TABLE task (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description  text,                       -- bilingual free text, preserved verbatim
  status       text NOT NULL DEFAULT 'open'
               CHECK (status IN ('draft','open','in_progress','blocked',
                                 'awaiting_approval','completed','cancelled')),
  priority     text NOT NULL DEFAULT 'normal'
               CHECK (priority IN ('low','normal','high','urgent')),
  due_date     timestamptz,
  assignee_id  uuid REFERENCES app_user(id),
  department   text,                       -- team queue when no individual is named
  confidential boolean NOT NULL DEFAULT false,
  blocked_reason text,
  parent_task_id uuid REFERENCES task(id), -- subtasks / checklists
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NOT NULL REFERENCES app_user(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES app_user(id),
  deleted_at   timestamptz,
  version      integer NOT NULL DEFAULT 1,
  -- A blocked task must say why: an unexplained blocker is a task nobody can unblock.
  CONSTRAINT blocked_needs_reason CHECK (
    status <> 'blocked' OR (blocked_reason IS NOT NULL AND char_length(blocked_reason) > 0)),
  CONSTRAINT completed_has_timestamp CHECK (
    (status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT no_self_parent CHECK (parent_task_id IS NULL OR parent_task_id <> id)
);
COMMENT ON TABLE task IS
  'Collaborative tasks across every module. "Overdue" is computed from due_date at read time, never stored.';
COMMENT ON COLUMN task.confidential IS
  'When true, visible only to creator, assignee, and Admins (see modules/shared/tasks/domain/visibility.ts).';

CREATE INDEX task_assignee_idx ON task(assignee_id, status) WHERE deleted_at IS NULL;
CREATE INDEX task_department_idx ON task(department, status) WHERE deleted_at IS NULL;
CREATE INDEX task_due_idx ON task(due_date)
  WHERE deleted_at IS NULL AND status IN ('open','in_progress','blocked','awaiting_approval');
CREATE INDEX task_parent_idx ON task(parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX task_title_trgm ON task USING gin (title gin_trgm_ops);

-- Polymorphic link to any record in any module (spec §6.1).
CREATE TABLE task_link (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  entity_type text NOT NULL,   -- 'device' | 'repair' | 'sales_invoice' | 'delivery_order' | ...
  entity_id   uuid NOT NULL,
  module      text NOT NULL CHECK (module IN
              ('engineering','finance','logistics','manufacturing','maintenance','tasks','admin')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL REFERENCES app_user(id),
  UNIQUE (task_id, entity_type, entity_id)
);
COMMENT ON COLUMN task_link.module IS
  'Denormalized owning module. Stored so task visibility can be filtered in ONE query without joining every entity table.';
CREATE INDEX task_link_entity_idx ON task_link(entity_type, entity_id);
CREATE INDEX task_link_task_idx ON task_link(task_id);

-- Append-only discussion.
CREATE TABLE task_comment (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id),
  edited_at  timestamptz
);
CREATE INDEX task_comment_task_idx ON task_comment(task_id, created_at);

-- Comments are append-only: the trail of a discussion is evidence.
CREATE OR REPLACE FUNCTION fn_task_comment_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'task_comment is append-only — comments cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.body IS DISTINCT FROM NEW.body AND NEW.edited_at IS NULL THEN
    RAISE EXCEPTION 'editing a comment must stamp edited_at' USING ERRCODE = '23514';
  END IF;
  IF OLD.task_id <> NEW.task_id OR OLD.created_by <> NEW.created_by
     OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'a comment''s task, author, and creation time are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_task_comment_guard BEFORE UPDATE OR DELETE ON task_comment
  FOR EACH ROW EXECUTE FUNCTION fn_task_comment_guard();

SELECT fn_attach_audit(t) FROM unnest(ARRAY['task','task_link','task_comment']) AS t;
