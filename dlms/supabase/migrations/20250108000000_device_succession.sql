ALTER TABLE device ADD COLUMN replaced_by uuid REFERENCES device(id) ON DELETE SET NULL;
CREATE INDEX ON device(replaced_by) WHERE replaced_by IS NOT NULL;
