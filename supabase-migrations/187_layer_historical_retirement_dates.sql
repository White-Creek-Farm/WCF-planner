-- Evidence-backed retirement dates for three historical Layer housings.
--
-- These records predate consistent retired_date capture. The dates below are
-- derived from their own daily history and successor-housing handoffs:
--   * Eggmobile #2 - 2023: old logs end 2026-01-27; successor starts 2026-01-28
--   * Layer Schooner - 2023: old logs end 2026-01-27; successor starts 2026-01-28
--   * Retirement Home - 2023: 2024-06-27 daily says the remaining birds moved
--
-- Missing rows are allowed so this data correction remains safe on environments
-- that do not carry PROD history. Existing conflicting state fails closed.

DO $$
DECLARE
  v_conflict text;
BEGIN
  SELECT h.id
  INTO v_conflict
  FROM public.layer_housings h
  WHERE
    (h.id = 'lh-23-01-em2' AND (
      h.status IS DISTINCT FROM 'retired'
      OR (h.retired_date IS NOT NULL AND h.retired_date <> DATE '2026-01-28')
    ))
    OR (h.id = 'lh-23-01-ls' AND (
      h.status IS DISTINCT FROM 'retired'
      OR (h.retired_date IS NOT NULL AND h.retired_date <> DATE '2026-01-28')
    ))
    OR (h.id = 'lh-23-01-rh23' AND (
      h.status IS DISTINCT FROM 'retired'
      OR (h.retired_date IS NOT NULL AND h.retired_date <> DATE '2024-06-27')
    ))
  LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 187 refused conflicting layer_housings row %',
      v_conflict;
  END IF;

  UPDATE public.layer_housings
  SET retired_date = CASE id
    WHEN 'lh-23-01-em2' THEN DATE '2026-01-28'
    WHEN 'lh-23-01-ls' THEN DATE '2026-01-28'
    WHEN 'lh-23-01-rh23' THEN DATE '2024-06-27'
  END
  WHERE id IN ('lh-23-01-em2', 'lh-23-01-ls', 'lh-23-01-rh23')
    AND status = 'retired'
    AND retired_date IS NULL;
END;
$$;
