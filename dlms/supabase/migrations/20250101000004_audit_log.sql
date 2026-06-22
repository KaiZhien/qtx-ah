-- Append-only audit log — the change history (§6.2, §5.1.6)
-- Written exclusively by DB triggers; application code must never INSERT here directly.
CREATE TABLE audit_log (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id        uuid REFERENCES app_user(id) ON DELETE SET NULL,
  action          text NOT NULL CHECK (action IN ('insert', 'update', 'soft_delete')),
  table_name      text NOT NULL,
  row_id          uuid NOT NULL,
  old_values      jsonb,
  new_values      jsonb NOT NULL,
  changed_columns text[] NOT NULL DEFAULT '{}',
  request_id      text,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE audit_log IS
  'Append-only change history. Written only by DB triggers (fn_audit). Never written by application code. Powers both per-record history and the admin audit view.';
COMMENT ON COLUMN audit_log.action IS
  'insert = new record; update = field change; soft_delete = deleted_at set from null to non-null.';
COMMENT ON COLUMN audit_log.changed_columns IS
  'Column names whose values changed. Empty for inserts (all columns are new).';

CREATE INDEX audit_log_row_id_idx      ON audit_log(row_id);
CREATE INDEX audit_log_actor_id_idx    ON audit_log(actor_id);
CREATE INDEX audit_log_occurred_at_idx ON audit_log(occurred_at DESC);
CREATE INDEX audit_log_table_name_idx  ON audit_log(table_name);
