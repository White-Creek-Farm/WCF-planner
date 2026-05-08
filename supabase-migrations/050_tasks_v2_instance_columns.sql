-- ============================================================================
-- 050_tasks_v2_instance_columns.sql
-- ----------------------------------------------------------------------------
-- Tasks v2 — task_instances column additions + FK adjustment.
--
-- Adds the v2 columns needed by the Task Center foundation:
--   completion_note            (required by v2 complete RPC)
--   due_date_edit_count        (regular-user 2-edit counter)
--   created_by_profile_id      (logged-in creator FK; nullable for legacy)
--   created_by_display_name    (stored display-name string, mirrors public
--                               webform's submitted_by_team_member pattern)
--   from_recurring_template    (preserves Recurring label after template delete)
--   from_system_rule_id        (links system-generated instances to rule)
--   designation                (text label: 'recurring' | 'system' | NULL)
--
-- Switches task_instances.template_id FK to ON DELETE SET NULL so deleting
-- a recurring template stops future generation but preserves existing
-- instances (designation column keeps the Recurring label intact).
--
-- Adds partial unique on (from_system_rule_id, due_date) WHERE not null,
-- giving the system-rule generator idempotent "one task per rule per due
-- date" protection (matches the existing pattern on template_id, due_date).
--
-- Backfill: existing rows with template_id IS NOT NULL get
-- from_recurring_template=true and designation='recurring'. completion_note
-- stays NULL on existing completed rows (legacy; v2 RPC requires it for new
-- completions only).
-- ============================================================================

ALTER TABLE public.task_instances
  ADD COLUMN IF NOT EXISTS completion_note text,
  ADD COLUMN IF NOT EXISTS due_date_edit_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_by_profile_id uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS created_by_display_name text,
  ADD COLUMN IF NOT EXISTS from_recurring_template boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS from_system_rule_id text,
  ADD COLUMN IF NOT EXISTS from_system_source_event_key text,
  ADD COLUMN IF NOT EXISTS designation text;

-- Designation check: only the documented label values plus NULL.
ALTER TABLE public.task_instances
  DROP CONSTRAINT IF EXISTS task_instances_designation_check;
ALTER TABLE public.task_instances
  ADD CONSTRAINT task_instances_designation_check
    CHECK (designation IS NULL OR designation IN ('recurring', 'system'));

-- Backfill recurring designation from existing template_id linkage.
UPDATE public.task_instances
SET from_recurring_template = true,
    designation = COALESCE(designation, 'recurring')
WHERE template_id IS NOT NULL AND from_recurring_template = false;

-- Switch template_id FK to SET NULL so template delete preserves instances.
-- The existing constraint name is task_instances_template_id_fkey (per mig
-- 036 default naming); guard with IF EXISTS for re-runnable apply.
ALTER TABLE public.task_instances
  DROP CONSTRAINT IF EXISTS task_instances_template_id_fkey;

ALTER TABLE public.task_instances
  ADD CONSTRAINT task_instances_template_id_fkey
    FOREIGN KEY (template_id)
    REFERENCES public.task_templates(id)
    ON DELETE SET NULL;

-- Idempotency for system-rule-generated tasks: one row per
-- (rule_id, source_event_key) pair. The source_event_key is the upstream
-- domain object identity (broiler batch id for broiler rules, pig sub-batch
-- id for pig 6mo). Two distinct broiler batches CAN share the same due
-- date — they are different events — so due_date is NOT in the unique key.
DROP INDEX IF EXISTS public.idx_task_instances_system_rule_due;
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_instances_system_rule_event
  ON public.task_instances (from_system_rule_id, from_system_source_event_key)
  WHERE from_system_rule_id IS NOT NULL;

-- Lookup index: system tasks by rule + due_date together (admin views,
-- digest grouping). Non-unique.
CREATE INDEX IF NOT EXISTS idx_task_instances_system_rule_due_at
  ON public.task_instances (from_system_rule_id, due_date)
  WHERE from_system_rule_id IS NOT NULL;

-- Lookup by system rule for admin views.
CREATE INDEX IF NOT EXISTS idx_task_instances_from_system_rule
  ON public.task_instances (from_system_rule_id)
  WHERE from_system_rule_id IS NOT NULL;

-- Lookup by creator for "tasks I created" filters.
CREATE INDEX IF NOT EXISTS idx_task_instances_created_by
  ON public.task_instances (created_by_profile_id)
  WHERE created_by_profile_id IS NOT NULL;

-- ============================================================================
-- End of 050_tasks_v2_instance_columns.sql
-- No RLS changes here. RLS overhaul lives in mig 053 alongside the RPCs.
-- Existing single-path columns (request_photo_path, completion_photo_path)
-- stay for backward compat; mig 051 backfills them into the photo sidecar.
-- ============================================================================
