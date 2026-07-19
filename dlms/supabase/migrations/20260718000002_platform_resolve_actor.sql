-- ===========================================================================
-- One round trip for the full authorization state. Expired overrides are filtered
-- here so a lapsed grant stops working the moment it expires, without waiting for
-- the hourly sweep job.
-- ===========================================================================
CREATE OR REPLACE FUNCTION fn_resolve_actor(p_auth_user_id uuid)
RETURNS TABLE (
  id uuid, role_key text, module_access text[], active boolean,
  role_permissions text[], granted_overrides text[], revoked_overrides text[]
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    u.id,
    r.key,
    u.module_access,
    u.active AND u.deleted_at IS NULL,
    coalesce((SELECT array_agg(p.key ORDER BY p.key) FROM role_permission rp
                JOIN permission p ON p.id = rp.permission_id
               WHERE rp.role_id = u.role_id), '{}'),
    coalesce((SELECT array_agg(p.key ORDER BY p.key) FROM user_permission_override o
                JOIN permission p ON p.id = o.permission_id
               WHERE o.user_id = u.id AND o.granted AND o.deleted_at IS NULL
                 AND (o.expires_at IS NULL OR o.expires_at > now())), '{}'),
    coalesce((SELECT array_agg(p.key ORDER BY p.key) FROM user_permission_override o
                JOIN permission p ON p.id = o.permission_id
               WHERE o.user_id = u.id AND NOT o.granted AND o.deleted_at IS NULL
                 AND (o.expires_at IS NULL OR o.expires_at > now())), '{}')
  FROM app_user u
  JOIN role r ON r.id = u.role_id
  WHERE u.auth_user_id = p_auth_user_id;
$$;
REVOKE EXECUTE ON FUNCTION fn_resolve_actor(uuid) FROM public, anon, authenticated;
