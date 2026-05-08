-- ============================================================================
-- 052_tasks_v2_system_rules.sql
-- ----------------------------------------------------------------------------
-- Tasks v2 — task_system_rules table + four seeded built-in rules.
--
-- Codex T5 lock: seed must resolve Simon and Mak from the same eligible-
-- assignee source the task UI uses (profiles WHERE role != 'inactive')
-- and FAIL CLOSED if either name resolves to zero or multiple profiles.
-- No active rule is created with a placeholder/null assignee.
--
-- Codex T4 lock: lead_time_days defaults to 3 for all four seeded rules
-- (broiler-4w, broiler-6w, clean-brooder, pig-6mo). Admin can adjust per
-- rule via the System Tasks tab UI (lands in T5/T9).
--
-- RLS: authenticated SELECT (everyone sees system rules — transparency
-- mirrors recurring templates). Admin FOR ALL handles create/edit/delete.
--
-- PROD apply prerequisite: Simon and Mak profiles must exist with
-- role != 'inactive' and unique full_name matches (case-insensitive). The
-- seed RAISES on resolution failure, leaving the table empty rather than
-- creating any rule with a placeholder. Apply scripts handle TEST DB
-- profile pre-creation; PROD admin ensures the profiles exist by hand
-- before running the migration.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.task_system_rules (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  assignee_profile_id uuid NOT NULL REFERENCES public.profiles(id),
  generator_kind text NOT NULL CHECK (generator_kind IN (
    'broiler_4wk_weighin',
    'broiler_6wk_weighin',
    'clean_brooder',
    'pig_6mo_weighin'
  )),
  lead_time_days int NOT NULL DEFAULT 3 CHECK (lead_time_days >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_system_rules_active
  ON public.task_system_rules (active)
  WHERE active = true;

ALTER TABLE public.task_system_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_system_rules_authenticated_select ON public.task_system_rules;
CREATE POLICY task_system_rules_authenticated_select
  ON public.task_system_rules FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS task_system_rules_admin_all ON public.task_system_rules;
CREATE POLICY task_system_rules_admin_all
  ON public.task_system_rules FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ── Seed: resolve Simon and Mak; fail closed on 0 or >1 matches. ────────────
DO $tasks_v2_seed$
DECLARE
  v_simon_id uuid;
  v_simon_count int;
  v_mak_id uuid;
  v_mak_count int;
BEGIN
  -- Resolve Simon (case-insensitive, eligible-assignee source).
  SELECT count(*) INTO v_simon_count
    FROM public.profiles
    WHERE role IS DISTINCT FROM 'inactive'
      AND lower(full_name) = lower('Simon');
  IF v_simon_count = 0 THEN
    RAISE EXCEPTION 'tasks v2 mig 052 seed: cannot resolve "Simon" — no eligible profile match (need role != inactive, full_name = Simon)';
  END IF;
  IF v_simon_count > 1 THEN
    RAISE EXCEPTION 'tasks v2 mig 052 seed: cannot resolve "Simon" — % eligible profile matches (must be exactly 1)', v_simon_count;
  END IF;
  SELECT id INTO v_simon_id
    FROM public.profiles
    WHERE role IS DISTINCT FROM 'inactive'
      AND lower(full_name) = lower('Simon')
    LIMIT 1;

  -- Resolve Mak (case-insensitive, eligible-assignee source).
  SELECT count(*) INTO v_mak_count
    FROM public.profiles
    WHERE role IS DISTINCT FROM 'inactive'
      AND lower(full_name) = lower('Mak');
  IF v_mak_count = 0 THEN
    RAISE EXCEPTION 'tasks v2 mig 052 seed: cannot resolve "Mak" — no eligible profile match (need role != inactive, full_name = Mak)';
  END IF;
  IF v_mak_count > 1 THEN
    RAISE EXCEPTION 'tasks v2 mig 052 seed: cannot resolve "Mak" — % eligible profile matches (must be exactly 1)', v_mak_count;
  END IF;
  SELECT id INTO v_mak_id
    FROM public.profiles
    WHERE role IS DISTINCT FROM 'inactive'
      AND lower(full_name) = lower('Mak')
    LIMIT 1;

  -- Insert/update the four built-in rules. ON CONFLICT DO NOTHING leaves
  -- existing rule rows untouched on re-apply (admin edits to assignee or
  -- lead_time_days are preserved across re-runs).
  INSERT INTO public.task_system_rules
    (id, name, description, assignee_profile_id, generator_kind, lead_time_days, active)
  VALUES
    (
      'broiler-4wk-weighin',
      'Broiler 4-week weigh-in',
      'Generated 3 days before the broiler batch reaches 4 weeks of age (hatch_date + 28 days).',
      v_simon_id,
      'broiler_4wk_weighin',
      3,
      true
    ),
    (
      'broiler-6wk-weighin',
      'Broiler 6-week weigh-in',
      'Generated 3 days before the broiler batch reaches 6 weeks of age (hatch_date + 42 days).',
      v_simon_id,
      'broiler_6wk_weighin',
      3,
      true
    ),
    (
      'clean-brooder',
      'Clean brooder',
      'Generated 3 days before the day after a broiler batch leaves the brooder for the schooner.',
      v_simon_id,
      'clean_brooder',
      3,
      true
    ),
    (
      'pig-6mo-weighin',
      'Pig sub-batch 6-month weigh-in',
      'Generated 3 days before 180 days after the first actual farrowing date in the linked breeding cycle. Skips when no actual farrowing date exists.',
      v_mak_id,
      'pig_6mo_weighin',
      3,
      true
    )
  ON CONFLICT (id) DO NOTHING;
END
$tasks_v2_seed$;

-- ============================================================================
-- End of 052_tasks_v2_system_rules.sql
-- Generation logic (Edge Function dispatch + generate_system_task_instance
-- RPC) lands in T10 (Email digest + cron extensions) — out of T1 scope.
-- T1 only ships the schema + seed; system tasks aren't generated until T10.
-- ============================================================================
