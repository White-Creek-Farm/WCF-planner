-- ============================================================================
-- 051_tasks_v2_audit_and_photos.sql
-- ----------------------------------------------------------------------------
-- Tasks v2 — due-date edit audit table + photo sidecar table.
--
-- Two new tables:
--   task_instance_due_date_edits — append-only audit log for the 2-edit
--     regular-user rule and admin-unlimited override. INSERTs come only
--     from the SECURITY DEFINER update_task_instance_due_date RPC (mig 053);
--     no INSERT policy means direct writes are blocked.
--   task_instance_photos — sidecar for up to 5 creation + 5 completion
--     photos per instance. CHECK sort_order BETWEEN 0 AND 4 plus partial
--     unique on (instance_id, kind, sort_order) gives belt-and-suspenders
--     against retry/concurrency double-inserts. RLS authenticated SELECT;
--     no INSERT/UPDATE/DELETE policy means RPC-only writes.
--
-- Backfills the photo sidecar from the existing single-path columns on
-- task_instances (request_photo_path → kind='creation', completion_photo_path
-- → kind='completion'). Existing single-path columns stay intact for
-- backward compat per Codex T6 — v2 RPCs mirror new uploads into both
-- the sidecar and the legacy columns until a future cleanup mig drops the
-- legacy columns.
-- ============================================================================

-- ── 1. task_instance_due_date_edits ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.task_instance_due_date_edits (
  id text PRIMARY KEY,
  instance_id text NOT NULL REFERENCES public.task_instances(id) ON DELETE CASCADE,
  edited_at timestamptz NOT NULL DEFAULT now(),
  edited_by_profile_id uuid NOT NULL REFERENCES public.profiles(id),
  edited_by_role text NOT NULL CHECK (edited_by_role IN ('admin', 'regular')),
  prior_due_date date NOT NULL,
  new_due_date date NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_due_date_edits_instance
  ON public.task_instance_due_date_edits (instance_id);

CREATE INDEX IF NOT EXISTS idx_due_date_edits_edited_at
  ON public.task_instance_due_date_edits (edited_at DESC);

ALTER TABLE public.task_instance_due_date_edits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_instance_due_date_edits_authenticated_select
  ON public.task_instance_due_date_edits;
CREATE POLICY task_instance_due_date_edits_authenticated_select
  ON public.task_instance_due_date_edits FOR SELECT
  TO authenticated
  USING (true);

-- No INSERT/UPDATE/DELETE policy → only SECURITY DEFINER RPC writes get
-- through (the RPC owner bypasses RLS).

-- ── 2. task_instance_photos sidecar ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.task_instance_photos (
  id text PRIMARY KEY,
  instance_id text NOT NULL REFERENCES public.task_instances(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('creation', 'completion')),
  storage_path text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by_profile_id uuid REFERENCES public.profiles(id),
  sort_order int NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 4)
);

-- Belt-and-suspenders cap at 5 photos per (instance_id, kind): unique on
-- the (instance, kind, sort_order) triple combined with the CHECK above
-- means at most 5 rows per (instance, kind) regardless of retry/concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_instance_photos_slot
  ON public.task_instance_photos (instance_id, kind, sort_order);

CREATE INDEX IF NOT EXISTS idx_task_instance_photos_instance
  ON public.task_instance_photos (instance_id);

ALTER TABLE public.task_instance_photos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_instance_photos_authenticated_select
  ON public.task_instance_photos;
CREATE POLICY task_instance_photos_authenticated_select
  ON public.task_instance_photos FOR SELECT
  TO authenticated
  USING (true);

-- No INSERT/UPDATE/DELETE policy → only SECURITY DEFINER RPC writes.

-- ── 3. Backfill photo sidecar from existing single-path columns ────────────
-- Idempotent via ON CONFLICT DO NOTHING on the slot unique index. Re-runs
-- do not duplicate; the slot key combines (instance_id, kind, sort_order=0).
INSERT INTO public.task_instance_photos
  (id, instance_id, kind, storage_path, uploaded_at, sort_order)
SELECT
  'tip-' || ti.id || '-r0',
  ti.id,
  'creation',
  ti.request_photo_path,
  COALESCE(ti.created_at, now()),
  0
FROM public.task_instances ti
WHERE ti.request_photo_path IS NOT NULL
ON CONFLICT (instance_id, kind, sort_order) DO NOTHING;

INSERT INTO public.task_instance_photos
  (id, instance_id, kind, storage_path, uploaded_at, sort_order)
SELECT
  'tip-' || ti.id || '-c0',
  ti.id,
  'completion',
  ti.completion_photo_path,
  COALESCE(ti.completed_at, ti.created_at, now()),
  0
FROM public.task_instances ti
WHERE ti.completion_photo_path IS NOT NULL
ON CONFLICT (instance_id, kind, sort_order) DO NOTHING;

-- ============================================================================
-- End of 051_tasks_v2_audit_and_photos.sql
-- No grants; tables are reachable via RLS SELECT for authenticated users
-- and via RPC owners only for INSERT/UPDATE/DELETE.
-- ============================================================================
