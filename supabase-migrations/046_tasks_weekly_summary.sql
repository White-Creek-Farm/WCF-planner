-- ============================================================================
-- Migration 046: Tasks Module v1 Phase F — weekly summary (C4)
-- ----------------------------------------------------------------------------
-- 2026-05-05. Adds the cron-driven weekly task-summary email pipeline:
--
--   * Required extensions: pg_cron, pg_net, pgcrypto. Re-asserted self-
--     contained per Codex C4 amendment 3 — even though mig 039 ships
--     them, this migration stays safe to apply against a fresh project.
--   * Vault preflight (Codex C4 amendment 2): RAISE EXCEPTION at apply
--     time if any of the THREE secrets the helper reads is missing or
--     trimmed-empty:
--       TASKS_SUMMARY_FUNCTION_URL    (new in this migration)
--       TASKS_CRON_SECRET             (reused from mig 039)
--       TASKS_CRON_SERVICE_ROLE_KEY   (reused from mig 039)
--   * public.invoke_tasks_summary(p_probe boolean DEFAULT false) —
--     SECDEF + SET search_path = public. Mirrors mig 039's
--     invoke_tasks_cron + mig 045's 15s timeout, with one difference:
--     a probe-arg branch (Codex C4 BLOCKER 1). When p_probe is true the
--     posted body carries probe:true so the Edge Function's probe
--     shortcut runs WITHOUT triggering real summary work. SQL probes
--     call SELECT public.invoke_tasks_summary(true); the cron schedule
--     calls bare and rides the default false.
--   * public.task_summary_runs — separate audit table from
--     task_cron_runs. Admin-SELECT-only RLS (matches Phase B's
--     task_cron_runs_admin_select policy).
--     per_recipient_failures jsonb captures per-assignee send errors
--     (Codex Q8) so a failed email for one user doesn't suppress
--     visibility into the rest of the run.
--   * cron.schedule for tasks-summary-weekly at '0 13 * * 1' UTC. The
--     Mon 13:00 UTC slot was reserved by Phase B's "DELIBERATELY NOT
--     SCHEDULED" comment for this migration to fill.
--
-- DELIBERATELY NOT TOUCHED:
--   - tasks-cron-daily schedule (mig 039) and invoke_tasks_cron
--     (mig 039 + 045). Separate cron + audit; this migration adds
--     alongside.
--   - task_cron_runs. Codex's "do not overload" rule preserved.
--
-- Audit model (three layers, no overlap):
--   Layer 1 — cron.job_run_details: did the schedule fire?
--   Layer 2 — net._http_response: did the http_post deliver?
--   Layer 3 — task_summary_runs: did the function execute its logic?
--
-- Idempotent: every step uses IF EXISTS / IF NOT EXISTS / unschedule-
-- then-schedule.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- (1) Required extensions
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- (2) Vault preflight — all three read secrets, trimmed/non-empty
-- ----------------------------------------------------------------------------
-- Codex C4 amendment 2: the function reads three secrets. Validate
-- ALL three at apply time so a misconfigured project can't ship a
-- schedule that silently 4xx/5xx forever. Per the Phase B deploy
-- lesson #1 (function-secret paste via Dashboard UI was whitespace-
-- prone), we strip whitespace before the length check.
DO $preflight$
DECLARE
  v_url    text;
  v_secret text;
  v_jwt    text;
BEGIN
  SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'TASKS_SUMMARY_FUNCTION_URL';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'TASKS_CRON_SECRET';
  SELECT decrypted_secret INTO v_jwt    FROM vault.decrypted_secrets WHERE name = 'TASKS_CRON_SERVICE_ROLE_KEY';
  IF coalesce(length(trim(v_url)),    0) = 0 THEN RAISE EXCEPTION 'mig 046: TASKS_SUMMARY_FUNCTION_URL missing or empty in vault.decrypted_secrets'; END IF;
  IF coalesce(length(trim(v_secret)), 0) = 0 THEN RAISE EXCEPTION 'mig 046: TASKS_CRON_SECRET missing or empty in vault.decrypted_secrets'; END IF;
  IF coalesce(length(trim(v_jwt)),    0) = 0 THEN RAISE EXCEPTION 'mig 046: TASKS_CRON_SERVICE_ROLE_KEY missing or empty in vault.decrypted_secrets'; END IF;
END $preflight$;

-- ----------------------------------------------------------------------------
-- (3) public.task_summary_runs — separate audit table from task_cron_runs
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.task_summary_runs (
  id                       text PRIMARY KEY,
  ran_at                   timestamptz NOT NULL DEFAULT now(),
  run_mode                 text NOT NULL DEFAULT 'cron'
                             CHECK (run_mode IN ('cron','admin')),
  recipients_sent          int  NOT NULL DEFAULT 0,
  recipients_skipped       int  NOT NULL DEFAULT 0,
  total_open_instances     int  NOT NULL DEFAULT 0,
  per_recipient_failures   jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_message            text
);

CREATE INDEX IF NOT EXISTS task_summary_runs_ran_at_idx
  ON public.task_summary_runs (ran_at DESC);

ALTER TABLE public.task_summary_runs ENABLE ROW LEVEL SECURITY;

-- Admin SELECT only — mirrors task_cron_runs_admin_select (mig 037
-- line 167). NO INSERT / UPDATE / DELETE policies; the Edge Function
-- writes via service-role and bypasses RLS.
DO $rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'task_summary_runs'
       AND policyname = 'task_summary_runs_admin_select'
  ) THEN
    CREATE POLICY task_summary_runs_admin_select ON public.task_summary_runs
      FOR SELECT TO authenticated
      USING (public.is_admin());
  END IF;
END $rls$;

-- ----------------------------------------------------------------------------
-- (4) public.invoke_tasks_summary(p_probe boolean DEFAULT false)
-- ----------------------------------------------------------------------------
-- Cron schedule body becomes a clean one-liner SELECT against this
-- helper. The probe-arg branch (Codex C4 BLOCKER 1) lets SQL
-- verification probes opt into the Edge Function's probe shortcut
-- without triggering real summary work + emails.
--
-- Returns: net.http_post request id (bigint). pg_net is async — this
-- id is the only signal pg_cron can act on at the SQL layer.
-- Function-execution audit lives separately in task_summary_runs
-- (Edge Function-owned writes only). Delivery audit lives in
-- net._http_response.
CREATE OR REPLACE FUNCTION public.invoke_tasks_summary(p_probe boolean DEFAULT false)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $invoke_tasks_summary$
DECLARE
  v_url    text;
  v_secret text;
  v_jwt    text;
  v_req_id bigint;
BEGIN
  -- Codex C4 re-review BLOCKER 4: trim() the Vault values here too,
  -- not just in the apply-time preflight. Vault values can pick up
  -- whitespace from Dashboard paste; preflight checks length(trim())
  -- but a non-trimmed v_url/v_secret/v_jwt would still produce a
  -- whitespace-padded HTTP request that the Edge Function rejects.
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

REVOKE ALL ON FUNCTION public.invoke_tasks_summary(boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_tasks_summary(boolean) FROM anon;
REVOKE ALL ON FUNCTION public.invoke_tasks_summary(boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_tasks_summary(boolean) TO postgres;

-- ----------------------------------------------------------------------------
-- (5) cron schedule — tasks-summary-weekly at Mon 13:00 UTC
-- ----------------------------------------------------------------------------
-- Idempotent: unschedule the prior job (if any) before re-scheduling
-- so re-applying this migration doesn't accumulate duplicate jobs.
-- Cron body uses the bare call (default p_probe=false) so the real
-- summary fires every Monday.
DO $sched$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tasks-summary-weekly') THEN
    PERFORM cron.unschedule('tasks-summary-weekly');
  END IF;
END $sched$;

SELECT cron.schedule(
  'tasks-summary-weekly',
  '0 13 * * 1',
  $cron_body$ SELECT public.invoke_tasks_summary(); $cron_body$
);

COMMIT;
