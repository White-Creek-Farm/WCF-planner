-- 077: Admin read RPC for client_error_events (Runtime Observability Phase 2).
--
-- Migration 068 stores redacted client errors with admin-only RLS and notes
-- "admin can query the table directly". The client_error persistence boundary
-- guard forbids any .from('client_error_events') in runtime src, so the admin
-- review surface reads through this SECURITY DEFINER RPC instead. Admin-only,
-- read-only, paginated by created_at. No write/update/delete path is added.

CREATE OR REPLACE FUNCTION public.list_client_errors(
  p_limit  int         DEFAULT 100,
  p_before timestamptz DEFAULT NULL
) RETURNS SETOF public.client_error_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
DECLARE
  v_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'list_client_errors: authenticated caller required';
  END IF;
  v_role := public.profile_role();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'list_client_errors: admin role required';
  END IF;

  RETURN QUERY
    SELECT *
    FROM public.client_error_events
    WHERE p_before IS NULL OR created_at < p_before
    ORDER BY created_at DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
END
$fn$;

REVOKE ALL ON FUNCTION public.list_client_errors(int, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_client_errors(int, timestamptz) TO authenticated;

NOTIFY pgrst, 'reload schema';
