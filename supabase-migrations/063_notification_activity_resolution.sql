-- ============================================================================
-- 063_notification_activity_resolution.sql
-- ----------------------------------------------------------------------------
-- Server-side notification loader that joins activity_events to resolve
-- the entity type/id for mention notifications. Clients never read
-- activity_events directly — this SECDEF RPC is the only path.
--
-- Returns the caller's own notifications (recipient = auth.uid()) with
-- three extra columns from the linked activity event when present:
--   activity_entity_type, activity_entity_id, activity_entity_label
--
-- Apply order: TEST first, PROD after lane approval.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.list_recent_notifications(
  p_limit int DEFAULT 20
) RETURNS TABLE (
  id                    text,
  recipient_profile_id  uuid,
  actor_profile_id      uuid,
  type                  text,
  task_instance_id      text,
  activity_event_id     text,
  title                 text,
  body                  text,
  read_at               timestamptz,
  created_at            timestamptz,
  activity_entity_type  text,
  activity_entity_id    text,
  activity_entity_label text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'list_recent_notifications: authenticated caller required';
  END IF;

  RETURN QUERY
    SELECT
      n.id,
      n.recipient_profile_id,
      n.actor_profile_id,
      n.type,
      n.task_instance_id,
      n.activity_event_id,
      n.title,
      n.body,
      n.read_at,
      n.created_at,
      CASE WHEN ae.id IS NOT NULL AND public._activity_can_read(ae.entity_type, ae.entity_id)
           THEN ae.entity_type ELSE NULL END AS activity_entity_type,
      CASE WHEN ae.id IS NOT NULL AND public._activity_can_read(ae.entity_type, ae.entity_id)
           THEN ae.entity_id ELSE NULL END AS activity_entity_id,
      CASE WHEN ae.id IS NOT NULL AND public._activity_can_read(ae.entity_type, ae.entity_id)
           THEN (ae.payload->>'entity_label')::text ELSE NULL END AS activity_entity_label
    FROM public.notifications n
    LEFT JOIN public.activity_events ae ON ae.id = n.activity_event_id
    WHERE n.recipient_profile_id = v_caller
    ORDER BY n.created_at DESC
    LIMIT v_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.list_recent_notifications(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_recent_notifications(int) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 063_notification_activity_resolution.sql
-- ============================================================================
