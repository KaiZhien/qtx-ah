ALTER TABLE device ADD COLUMN next_service_date date;
CREATE INDEX ON device(next_service_date) WHERE next_service_date IS NOT NULL AND deleted_at IS NULL;
