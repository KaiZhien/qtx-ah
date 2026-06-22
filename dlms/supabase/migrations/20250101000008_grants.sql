-- Grant table privileges to the Supabase roles. RLS (migration 0007) enforces
-- row-level access; these grants are the prerequisite table-level privileges
-- that PostgREST checks first. Without them every query returns 42501.
--
-- anon gets SELECT only (read at the GRANT layer; RLS additionally blocks
-- unauthenticated reads where auth.uid() IS NOT NULL is required).
-- authenticated and service_role get full DML; RLS enforces row-level scope.

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Existing tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public
  TO anon, authenticated, service_role;

-- Future tables/sequences/functions created in this schema
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
