-- ============================================================================
-- 110_cattle_calf_row_heifer_promote.sql
-- ----------------------------------------------------------------------------
-- Close the heifer -> cow automation gap left by migrations 032/044.
--
-- Existing behavior:
--   * cattle_calving_records INSERT promotes a dam from sex='heifer' to
--     sex='cow' and writes a cattle_comments audit row.
--
-- Gap:
--   * A calf can also be represented by a cattle row whose dam_tag points to
--     the dam. Those calf rows are used by the UI as calf evidence, but they
--     did not fire the calving-record trigger, so the dam could remain a
--     heifer after having a calf.
--
-- This migration adds a cattle-row trigger for INSERT and dam_tag UPDATE.
-- When a calf row is linked to a dam currently classified as heifer, the dam
-- is promoted to cow and a calving-source audit comment is written. The match
-- resolves the dam by current tag first, then by non-import old_tags so WCF
-- retags work without treating selling-farm purchase tags as dam identity.
--
-- Backfill: any existing active heifer with an active calf row pointing at her
-- current tag or non-import old tag is promoted once with an audit comment.
-- Idempotent: after sex='cow', reruns find no matching heifers.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.cattle_promote_heifer_from_calf_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_dam_tag text := NULLIF(trim(NEW.dam_tag), '');
  v_dam_id text;
  v_dam_current_tag text;
  v_dam_sex text;
BEGIN
  IF v_dam_tag IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND COALESCE(OLD.dam_tag, '') = COALESCE(NEW.dam_tag, '') THEN
    RETURN NEW;
  END IF;

  -- Current tag match wins.
  SELECT c.id, c.tag, c.sex
    INTO v_dam_id, v_dam_current_tag, v_dam_sex
    FROM public.cattle c
   WHERE c.deleted_at IS NULL
     AND c.tag = v_dam_tag
   LIMIT 1;

  -- Retag-aware fallback: only WCF/manual/weigh-in prior tags, never import
  -- purchase tags, because selling-farm tag numbers can collide.
  IF v_dam_id IS NULL THEN
    SELECT c.id, c.tag, c.sex
      INTO v_dam_id, v_dam_current_tag, v_dam_sex
      FROM public.cattle c
     WHERE c.deleted_at IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(c.old_tags, '[]'::jsonb)) AS ot
          WHERE ot->>'tag' = v_dam_tag
            AND COALESCE(ot->>'source', '') <> 'import'
       )
     ORDER BY c.tag
     LIMIT 1;
  END IF;

  IF v_dam_id IS NULL OR v_dam_sex <> 'heifer' THEN
    RETURN NEW;
  END IF;

  UPDATE public.cattle
     SET sex = 'cow'
   WHERE id = v_dam_id;

  INSERT INTO public.cattle_comments (id, cattle_id, cattle_tag, comment, source, reference_id)
  VALUES (
    replace(gen_random_uuid()::text, '-', ''),
    v_dam_id,
    v_dam_current_tag,
    'Automatically promoted from heifer to cow after calf row was linked to this dam.',
    'calving',
    NEW.id
  );

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS cattle_calf_row_promote_heifer ON public.cattle;
CREATE TRIGGER cattle_calf_row_promote_heifer
  AFTER INSERT OR UPDATE OF dam_tag ON public.cattle
  FOR EACH ROW
  EXECUTE FUNCTION public.cattle_promote_heifer_from_calf_row();

DO $backfill$
DECLARE
  promoted_dam RECORD;
BEGIN
  FOR promoted_dam IN
    SELECT DISTINCT dam.id AS cattle_id, dam.tag AS cattle_tag
      FROM public.cattle dam
     WHERE dam.deleted_at IS NULL
       AND dam.sex = 'heifer'
       AND EXISTS (
         SELECT 1
           FROM public.cattle calf
          WHERE calf.deleted_at IS NULL
            AND NULLIF(trim(calf.dam_tag), '') IS NOT NULL
            AND (
              calf.dam_tag = dam.tag
              OR EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(COALESCE(dam.old_tags, '[]'::jsonb)) AS ot
                 WHERE ot->>'tag' = calf.dam_tag
                   AND COALESCE(ot->>'source', '') <> 'import'
              )
            )
       )
  LOOP
    UPDATE public.cattle
       SET sex = 'cow'
     WHERE id = promoted_dam.cattle_id;

    INSERT INTO public.cattle_comments (id, cattle_id, cattle_tag, comment, source, reference_id)
    VALUES (
      replace(gen_random_uuid()::text, '-', ''),
      promoted_dam.cattle_id,
      promoted_dam.cattle_tag,
      'Automatically promoted from heifer to cow (backfill 2026-06-11 - existing calf row linked to this dam).',
      'calving',
      NULL
    );
  END LOOP;
END;
$backfill$;

COMMIT;
