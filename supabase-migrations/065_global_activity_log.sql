-- ============================================================================
-- 065_global_activity_log.sql
-- ----------------------------------------------------------------------------
-- Server-side RPC for the global Activity Log. Returns activity events
-- the caller is allowed to read, with actor name and mention resolution.
--
-- Filters: entity_type, event_type, text search, cursor pagination.
-- Uses _activity_can_read for per-row visibility gating.
--
-- Apply order: TEST first, PROD after lane approval.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.list_global_activity(
  p_limit       int          DEFAULT 50,
  p_before      timestamptz  DEFAULT NULL,
  p_entity_type text         DEFAULT NULL,
  p_event_type  text         DEFAULT NULL,
  p_search      text         DEFAULT NULL
) RETURNS TABLE (
  id                      text,
  entity_type             text,
  entity_id               text,
  entity_label            text,
  actor_profile_id        uuid,
  actor_display_name      text,
  event_type              text,
  body                    text,
  payload                 jsonb,
  created_at              timestamptz,
  edited_at               timestamptz,
  deleted_at              timestamptz,
  mentioned_profile_ids   uuid[],
  mentioned_profile_names text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
DECLARE
  v_role text;
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
BEGIN
  v_role := public.profile_role();
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'list_global_activity: authenticated caller required';
  END IF;
  IF v_role = 'inactive' THEN
    RAISE EXCEPTION 'list_global_activity: inactive profile';
  END IF;

  RETURN QUERY
    SELECT
      ae.id,
      ae.entity_type,
      ae.entity_id,
      COALESCE(ae.payload->>'entity_label', ae.entity_id) AS entity_label,
      ae.actor_profile_id,
      COALESCE(
        (SELECT p.full_name FROM public.profiles p WHERE p.id = ae.actor_profile_id),
        'Unknown'
      ) AS actor_display_name,
      ae.event_type,
      ae.body,
      ae.payload,
      ae.created_at,
      ae.edited_at,
      ae.deleted_at,
      COALESCE(
        (SELECT array_agg(am.mentioned_profile_id ORDER BY am.created_at, am.mentioned_profile_id)
           FROM public.activity_mentions am WHERE am.event_id = ae.id),
        ARRAY[]::uuid[]
      ) AS mentioned_profile_ids,
      COALESCE(
        (SELECT array_agg(COALESCE(p2.full_name, '') ORDER BY am2.created_at, am2.mentioned_profile_id)
           FROM public.activity_mentions am2
           LEFT JOIN public.profiles p2 ON p2.id = am2.mentioned_profile_id
          WHERE am2.event_id = ae.id),
        ARRAY[]::text[]
      ) AS mentioned_profile_names
    FROM public.activity_events ae
    WHERE (p_before IS NULL OR ae.created_at < p_before)
      AND (p_entity_type IS NULL OR ae.entity_type = p_entity_type)
      AND (p_event_type IS NULL OR ae.event_type = p_event_type)
      AND (p_search IS NULL OR ae.body ILIKE '%' || p_search || '%'
           OR (ae.payload->>'entity_label') ILIKE '%' || p_search || '%')
      AND public._activity_can_read(ae.entity_type, ae.entity_id)
    ORDER BY ae.created_at DESC
    LIMIT v_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.list_global_activity(int, timestamptz, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_global_activity(int, timestamptz, text, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 065_global_activity_log.sql
-- ============================================================================
