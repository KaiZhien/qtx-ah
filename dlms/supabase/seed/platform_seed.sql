-- supabase/seed/platform_seed.sql — deterministic: same data for dev, staging, and tests.
-- Idempotent: every INSERT is ON CONFLICT DO NOTHING (repo norm — idempotent upsert, not
-- one-shot) so a second run against an already-seeded database is a no-op rather than a
-- unique-violation error.
INSERT INTO role (key, name, description, is_system, sort) VALUES
  ('super_admin','Super Administrator','Full control including users, roles, settings, and full export.',true,1),
  ('admin','Administrator','All operational abilities; cannot alter the permission fabric.',true,2),
  ('manager','Manager','Operate and approve within accessible modules.',true,3),
  ('operator','Operator','Create and edit records within accessible modules.',true,4),
  ('finance','Finance','Operate within Finance and Logistics; manages financial records.',true,5),
  ('viewer','Viewer','Read-only across accessible modules.',true,6)
ON CONFLICT DO NOTHING;

INSERT INTO permission (key, name, sort) VALUES
  ('view_records','View records',1),
  ('create_records','Create records',2),
  ('edit_records','Edit records',3),
  ('delete_records','Delete (archive) records',4),
  ('restore_records','Restore archived records',5),
  ('change_device_status','Change device status',6),
  ('assign_tasks','Assign tasks',7),
  ('approve_requests','Approve requests',8),
  ('sign_off_repairs','Sign off repairs',9),
  ('upload_files','Upload files',10),
  ('download_files','Download files',11),
  ('export_data','Export data',12),
  ('import_data','Import data',13),
  ('view_finance','View financial information',14),
  ('manage_finance','Manage financial records',15),
  ('view_buyer_details','View buyer details',16),
  ('log_usage_service','Log usage and service events',17),
  ('view_audit_record','View record history',18),
  ('view_full_audit','View full audit log',19),
  ('manage_users','Manage users',20),
  ('manage_roles_permissions','Manage roles and permissions',21),
  ('manage_vocabularies','Manage vocabularies',22),
  ('manage_settings','Manage system settings',23),
  ('request_full_export','Request full system export',24)
ON CONFLICT DO NOTHING;

-- The §3.2 matrix, as data. Read down each role's column in the spec table.
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p WHERE r.key = 'super_admin'
ON CONFLICT DO NOTHING;

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key = 'admin' AND p.key IN (
  'view_records','create_records','edit_records','delete_records','restore_records',
  'change_device_status','assign_tasks','approve_requests','sign_off_repairs',
  'upload_files','download_files','export_data','import_data','view_finance',
  'manage_finance','view_buyer_details','log_usage_service','view_audit_record',
  'view_full_audit','manage_vocabularies')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key = 'manager' AND p.key IN (
  'view_records','create_records','edit_records','delete_records','change_device_status',
  'assign_tasks','approve_requests','sign_off_repairs','upload_files','download_files',
  'export_data','import_data','view_finance','view_buyer_details','log_usage_service',
  'view_audit_record')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key = 'operator' AND p.key IN (
  'view_records','create_records','edit_records','change_device_status','assign_tasks',
  'upload_files','download_files','view_buyer_details','log_usage_service','view_audit_record')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key = 'finance' AND p.key IN (
  'view_records','create_records','edit_records','assign_tasks','upload_files',
  'download_files','export_data','view_finance','manage_finance','view_buyer_details',
  'view_audit_record')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
WHERE r.key = 'viewer' AND p.key IN ('view_records','download_files')
ON CONFLICT DO NOTHING;

-- Bootstrap Super Admin. auth_user_id is linked on first login (Task 5).
INSERT INTO app_user (email, full_name, role_id, department, module_access, active)
SELECT 'reetmitra8@gmail.com', 'Reet Mitra', r.id, 'Engineering',
       ARRAY['engineering','finance','logistics','manufacturing','maintenance','tasks','admin'],
       true
FROM role r WHERE r.key = 'super_admin'
ON CONFLICT DO NOTHING;

-- The outbox drain's automation principal (spec §5.5) — the second of the function's
-- two required call sites. It MUST stay here and not be inlined: 20260731000000_platform_outbox.sql
-- defines and also calls fn_seed_system_actor(), but that call is a no-op on a
-- from-scratch database because migrations are applied before this seed and the
-- function's `operator` role does not exist yet. This call is what actually creates the
-- principal in dev, CI and any rebuilt database; the migration's call covers the cloud
-- project, where the roles below already existed when it applied. Both are idempotent,
-- so whichever runs second does nothing. See that migration's header before removing
-- either one. Must stay AFTER the role_permission inserts above: the function derives
-- the principal's revocation rows from the operator role's grants.
SELECT fn_seed_system_actor();
