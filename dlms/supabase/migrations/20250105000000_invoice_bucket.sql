-- Create a private Supabase Storage bucket for invoice files.
-- Service role (used via createAdminClient()) bypasses Storage RLS,
-- so no additional storage policies are needed for server-side access.
-- No public access is granted.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'invoices',
  'invoices',
  false,
  26214400,  -- 25 MB (bytes) — server guards at this limit before calling Claude
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/jpg']
)
ON CONFLICT (id) DO NOTHING;
