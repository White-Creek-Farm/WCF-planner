-- ============================================================================
-- 080_retire_legacy_activity_composer_rpcs.sql
-- ----------------------------------------------------------------------------
-- Retire legacy Activity composer/count RPCs from client execution.
--
-- Comments now own user discussion through commentsApi RPCs. Activity remains
-- audit/system history through list_activity_events, list_global_activity,
-- record_activity_event, and domain-specific audited SECDEF RPCs.
--
-- Keep the historical functions defined for dependency/audit stability, but
-- remove anon/authenticated execute privileges so runtime clients cannot call
-- the retired composer/count surface.
-- ============================================================================

REVOKE ALL ON FUNCTION public.count_activity_for_entity(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_activity_comment(text, text, text, text, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.edit_activity_event(text, text, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_activity_event(text) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 080_retire_legacy_activity_composer_rpcs.sql
-- ============================================================================
