-- ============================================================================
-- Migration 093: Tasks weekly summary — Sunday 8am Central schedule +
--                completed-assigned-task coverage
-- ----------------------------------------------------------------------------
-- 2026-06-04. Two product corrections to the weekly task digest pipeline
-- (mig 046 + supabase/functions/tasks-summary + rapid-processor):
--
--   1) SCHEDULE. The original cron fired Monday 13:00 UTC ('0 13 * * 1'),
--      which is Monday 8am Central during daylight time. The product
--      requirement is Sunday 8:00am America/Chicago (true wall-clock, DST
--      aware). We do NOT change the database timezone or any global
--      cron.timezone (Supabase DB stays UTC). Instead the job fires at the
--      two UTC hours that can be Sunday 08:00 Central (13:00 UTC during CDT,
--      14:00 UTC during CST) and the helper gates so only the fire whose
--      now() AT TIME ZONE 'America/Chicago' is Sunday 08:xx actually posts.
--      The other fire no-ops (RETURN NULL, no http_post, no email).
--
--   2) COMPLETED-ASSIGNED COVERAGE. The weekly email must also include tasks
--      the recipient created/assigned that were COMPLETED in the weekly
--      window — even when the recipient has zero open tasks. The Edge
--      Function reads public.notifications rows of type 'task_completed'
--      (recipient_profile_id = creator/assignor, per mig 057) for the window
--      returned by public.tasks_summary_window_start(). Using the existing
--      notification contract preserves its exclusions verbatim: NULL creator
--      has no recipient, and self-completion is already excluded at write
--      time in complete_task_instance (mig 057). This migration does NOT
--      change that product rule.
--
-- Changes:
--   * DROP + recreate public.invoke_tasks_summary with a second arg
--     p_enforce_chicago_sunday boolean DEFAULT false. The old (boolean)
--     overload is dropped so SELECT invoke_tasks_summary(true) is not
--     ambiguous. probe:p_probe is still posted in the body so the Edge
--     Function probe shortcut is unchanged; probes are never gated.
--   * public.tasks_summary_window_start() — SECDEF, returns the previous
--     Sunday 08:00 America/Chicago as timestamptz (the start of the week
--     that just ended). Service-role/postgres execute only.
--   * cron.schedule tasks-summary-weekly -> '0 13,14 * * 0', body
--     SELECT public.invoke_tasks_summary(false, true); (real run, gated).
--   * task_summary_runs gains total_completed_instances int for audit
--     parity with total_open_instances.
--
-- DELIBERATELY NOT TOUCHED:
--   - tasks-cron-daily schedule / invoke_tasks_cron (separate cron+audit).
--   - notifications type contract, RLS, and complete_task_instance rules.
--   - task_summary_runs admin-SELECT-only RLS (no new policies).
--   - Edge Function auth boundaries (cron bearer+x-cron-secret, admin
--     is_admin, test_to gating, x-tasks-summary-secret digest gate).
--
-- Idempotent: DROP IF EXISTS / CREATE OR REPLACE / ADD COLUMN IF NOT EXISTS /
-- unschedule-then-schedule.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- (1) Required extensions (re-assert; safe against a fresh project)
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- (2) task_summary_runs — add total_completed_instances for audit parity
-- ----------------------------------------------------------------------------
ALTER TABLE public.task_summary_runs
  ADD COLUMN IF NOT EXISTS total_completed_instances int NOT NULL DEFAULT 0;

-- ----------------------------------------------------------------------------
-- (3) tasks_summary_window_start() — previous Sunday 08:00 America/Chicago
-- ----------------------------------------------------------------------------
-- Returns the start of the week that just ended, as a timestamptz instant.
-- When the weekly job fires Sunday ~08:00 Central, this returns the prior
-- Sunday 08:00 Central, so the completed-task window is the trailing 7 days
-- [previous Sunday 08:00, this Sunday 08:00). DST is handled by Postgres'
-- America/Chicago zone math, not by a fixed offset.
CREATE OR REPLACE FUNCTION public.tasks_summary_window_start()
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $window$
DECLARE
  v_now_chi  timestamp;   -- Chicago wall-clock now (no tz)
  v_sunday   date;        -- Sunday of the current Chicago week
  v_boundary timestamp;   -- most recent Sunday 08:00 wall-clock at-or-before now
BEGIN
  v_now_chi  := now() AT TIME ZONE 'America/Chicago';
  -- DOW: 0 = Sunday. Subtracting it lands on this week's Sunday date.
  v_sunday   := v_now_chi::date - EXTRACT(DOW FROM v_now_chi)::int;
  v_boundary := v_sunday + time '08:00';
  IF v_now_chi < v_boundary THEN
    v_boundary := v_boundary - interval '7 days';
  END IF;
  -- Start of the trailing week = one week before the most recent boundary.
  -- Convert the Chicago wall-clock value back to a timestamptz instant.
  RETURN (v_boundary - interval '7 days') AT TIME ZONE 'America/Chicago';
END;
$window$;

REVOKE ALL ON FUNCTION public.tasks_summary_window_start() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tasks_summary_window_start() FROM anon;
REVOKE ALL ON FUNCTION public.tasks_summary_window_start() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.tasks_summary_window_start() TO postgres;
GRANT EXECUTE ON FUNCTION public.tasks_summary_window_start() TO service_role;

-- ----------------------------------------------------------------------------
-- (4) invoke_tasks_summary — add Sunday-08:00-Central gating
-- ----------------------------------------------------------------------------
-- Drop the old single-arg overload first so SELECT invoke_tasks_summary(true)
-- is not ambiguous against the new two-arg version (whose second arg
-- defaults). The cron body calls (false, true); SQL probes call (true) which
-- resolves to (probe=true, enforce=false) and therefore always reaches the
-- Edge Function's probe shortcut without sending real mail.
DROP FUNCTION IF EXISTS public.invoke_tasks_summary(boolean);

CREATE OR REPLACE FUNCTION public.invoke_tasks_summary(
  p_probe boolean DEFAULT false,
  p_enforce_chicago_sunday boolean DEFAULT false
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $invoke_tasks_summary$
DECLARE
  v_url     text;
  v_secret  text;
  v_jwt     text;
  v_req_id  bigint;
  v_now_chi timestamp;
BEGIN
  -- Schedule gate (cron only — probes pass enforce=false). The job is
  -- scheduled at 13:00 and 14:00 UTC Sunday; exactly one of those is
  -- Sunday 08:xx in America/Chicago depending on DST. The other no-ops.
  IF p_enforce_chicago_sunday THEN
    v_now_chi := now() AT TIME ZONE 'America/Chicago';
    IF NOT (EXTRACT(DOW FROM v_now_chi)::int = 0
            AND EXTRACT(HOUR FROM v_now_chi)::int = 8) THEN
      RETURN NULL;  -- not the Sunday 08:00 Central send window
    END IF;
  END IF;

  -- Trim Vault values here too (not just in the apply-time preflight) so a
  -- whitespace-padded secret can't produce a request the Edge Function then
  -- rejects (mig 046 BLOCKER 4).
  SELECT trim(decrypted_secret) INTO v_url    FROM vault.decrypted_secrets WHERE name = 'TASKS_SUMMARY_FUNCTION_URL';
  SELECT trim(decrypted_secret) INTO v_secret FROM vault.decrypted_secrets WHERE name = 'TASKS_CRON_SECRET';
  SELECT trim(decrypted_secret) INTO v_jwt    FROM vault.decrypted_secrets WHERE name = 'TASKS_CRON_SERVICE_ROLE_KEY';
  IF coalesce(length(v_url),    0) = 0
     OR coalesce(length(v_secret), 0) = 0
     OR coalesce(length(v_jwt),    0) = 0 THEN
    RAISE EXCEPTION 'invoke_tasks_summary: vault secret(s) missing/empty';
  END IF;
  SELECT net.http_post(
    url                  := v_url,
    headers              := jsonb_build_object(
                              'Authorization', 'Bearer ' || v_jwt,
                              'x-cron-secret', v_secret,
                              'Content-Type',  'application/json'
                            ),
    body                 := jsonb_build_object('mode','cron','probe',p_probe),
    timeout_milliseconds := 15000
  ) INTO v_req_id;
  RETURN v_req_id;
END;
$invoke_tasks_summary$;

REVOKE ALL ON FUNCTION public.invoke_tasks_summary(boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_tasks_summary(boolean, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.invoke_tasks_summary(boolean, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_tasks_summary(boolean, boolean) TO postgres;

-- ----------------------------------------------------------------------------
-- (5) cron schedule — Sunday 13:00 + 14:00 UTC, gated to Sunday 08:00 Central
-- ----------------------------------------------------------------------------
DO $sched$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tasks-summary-weekly') THEN
    PERFORM cron.unschedule('tasks-summary-weekly');
  END IF;
END $sched$;

SELECT cron.schedule(
  'tasks-summary-weekly',
  '0 13,14 * * 0',
  $cron_body$ SELECT public.invoke_tasks_summary(false, true); $cron_body$
);

COMMIT;
