-- ============================================================================
-- 188 — Processing carcass-yield source totals (cattle, sheep, actual pig)
-- ----------------------------------------------------------------------------
-- The Processing drawer's Source details need Total live weight / Hanging
-- weight / Carcass yield for the exact linked source. This forward-only
-- migration reissues TWO Processing read functions:
--
-- 1. _processing_source_projection (last defined in mig 176) — adds FIVE
--    payload fields and nothing else:
--      cattle branch: 'total_live_weight' + 'total_hanging_weight' —
--        summed server-side from the batch's cows_detail JSON (the SAME
--        per-row values the cattle batch page sums for its yield, so a
--        page-side weight correction can never diverge from Processing);
--      sheep branch:  'total_live_weight' + 'total_hanging_weight' — same,
--        from sheep_detail;
--      pig branch:    'hanging_weight' — the exact trip's planner-owned
--        hangingWeight, ACTUAL phase only (planned trips emit NULL so the
--        client fails closed at "Not recorded", never 0%).
--
-- 2. _processing_animal_detail (last defined in mig 178) — the ONLY change
--    is guarding the two cattle/sheep 'hanging_weight' casts with the same
--    strict numeric regex. The mig-178 body cast detail JSON text straight
--    to ::numeric, so ONE malformed stored value made the whole record
--    read (get/list) throw. The pig legacy live-weights parse in the same
--    function already used the guarded-CASE idiom; this aligns the
--    remaining two casts with it.
--
-- FAIL CLOSED ON MALFORMED NUMBERS: planner JSON text is validated with a
-- strict numeric regex BEFORE any ::numeric cast (the cast sits inside the
-- guarded CASE arm and is unreachable for invalid text). Blank, malformed,
-- partial-numeric ('120junk'), zero, and negative values contribute
-- nothing and can never make these functions — and therefore get/list
-- Processing records — throw.
--
-- Signatures, SECURITY DEFINER posture, the REVOKE lines, and every
-- unrelated payload field are preserved verbatim. No data rewrite.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._processing_source_projection(p_rec public.processing_records)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE
  v_out jsonb;
  v_b jsonb; v_g jsonb; v_t jsonb;
  v_row RECORD;
  v_tags text;
  v_locked boolean;
  v_age jsonb;
  v_phase text;
BEGIN
  IF p_rec.source_kind IS NULL OR p_rec.source_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_rec.source_kind = 'broiler' THEN
    SELECT b.value INTO v_b
      FROM jsonb_array_elements(
             COALESCE((SELECT data FROM public.app_store WHERE key = 'ppp-v4'), '[]'::jsonb)) AS b
     WHERE COALESCE(btrim(b.value->>'id'), '') = p_rec.source_id
     LIMIT 1;
    IF v_b IS NULL THEN RETURN jsonb_build_object('matched', false); END IF;
    RETURN jsonb_build_object(
      'matched', true,
      'batch_name', v_b->>'name',
      'hatch_date', CASE WHEN COALESCE(v_b->>'hatchDate', v_b->>'hatch_date') ~ '^\d{4}-\d{2}-\d{2}'
                         THEN left(COALESCE(v_b->>'hatchDate', v_b->>'hatch_date'), 10) END,
      'processing_date', CASE WHEN COALESCE(v_b->>'processingDate', v_b->>'processing_date') ~ '^\d{4}-\d{2}-\d{2}'
                              THEN left(COALESCE(v_b->>'processingDate', v_b->>'processing_date'), 10) END,
      'count', NULLIF(btrim(COALESCE(v_b->>'totalToProcessor', v_b->>'total_to_processor', '')), '')::int,
      'age_days', CASE WHEN COALESCE(v_b->>'processingDate', v_b->>'processing_date') ~ '^\d{4}-\d{2}-\d{2}'
                        AND COALESCE(v_b->>'hatchDate', v_b->>'hatch_date') ~ '^\d{4}-\d{2}-\d{2}'
                       THEN left(COALESCE(v_b->>'processingDate', v_b->>'processing_date'), 10)::date
                            - left(COALESCE(v_b->>'hatchDate', v_b->>'hatch_date'), 10)::date END);
  END IF;

  IF p_rec.source_kind IN ('cattle', 'sheep') THEN
    IF p_rec.source_kind = 'cattle' THEN
      SELECT id, name,
             COALESCE(actual_process_date, planned_process_date) AS pdate,
             actual_process_date, cows_detail AS detail
        INTO v_row
        FROM public.cattle_processing_batches WHERE id = p_rec.source_id;
    ELSE
      SELECT id, name,
             COALESCE(actual_process_date, planned_process_date) AS pdate,
             actual_process_date, sheep_detail AS detail
        INTO v_row
        FROM public.sheep_processing_batches WHERE id = p_rec.source_id;
    END IF;
    IF v_row.id IS NULL THEN RETURN jsonb_build_object('matched', false); END IF;
    SELECT string_agg(DISTINCT NULLIF(btrim(d.value->>'tag'), ''), ' ') INTO v_tags
      FROM jsonb_array_elements(COALESCE(v_row.detail, '[]'::jsonb)) AS d;
    -- Live animal age range at the processing date, from current birth_date.
    IF p_rec.source_kind = 'cattle' THEN
      SELECT jsonb_build_object(
               'min_days', min(v_row.pdate - c.birth_date),
               'max_days', max(v_row.pdate - c.birth_date))
        INTO v_age
        FROM jsonb_array_elements(COALESCE(v_row.detail, '[]'::jsonb)) AS d
        JOIN public.cattle c ON c.id = d.value->>'cattle_id'
       WHERE c.birth_date IS NOT NULL AND v_row.pdate IS NOT NULL;
    ELSE
      SELECT jsonb_build_object(
               'min_days', min(v_row.pdate - s.birth_date),
               'max_days', max(v_row.pdate - s.birth_date))
        INTO v_age
        FROM jsonb_array_elements(COALESCE(v_row.detail, '[]'::jsonb)) AS d
        JOIN public.sheep s ON s.id = d.value->>'sheep_id'
       WHERE s.birth_date IS NOT NULL AND v_row.pdate IS NOT NULL;
    END IF;
    RETURN jsonb_build_object(
      'matched', true,
      'batch_name', v_row.name,
      'processing_date', v_row.pdate,
      'is_actual_date', v_row.actual_process_date IS NOT NULL,
      'count', jsonb_array_length(COALESCE(v_row.detail, '[]'::jsonb)),
      'animal_tags', COALESCE(v_tags, ''),
      'age', v_age,
      -- 188: canonical carcass totals summed from the batch detail JSON —
      -- the SAME per-row values the source batch page sums for its yield.
      -- Each value is regex-validated BEFORE the numeric cast (the cast is
      -- unreachable for invalid text); blank/malformed/zero/negative
      -- entries contribute nothing. NULL when nothing valid is recorded so
      -- clients fail closed at "Not recorded" instead of 0%.
      'total_live_weight',
        (SELECT NULLIF(sum(t.w), 0) FROM (
           SELECT CASE WHEN btrim(COALESCE(d.value->>'live_weight','')) ~ '^[0-9]+(\.[0-9]+)?$'
                       THEN btrim(d.value->>'live_weight')::numeric END AS w
             FROM jsonb_array_elements(COALESCE(v_row.detail, '[]'::jsonb)) AS d) t
          WHERE t.w IS NOT NULL AND t.w > 0),
      'total_hanging_weight',
        (SELECT NULLIF(sum(t.w), 0) FROM (
           SELECT CASE WHEN btrim(COALESCE(d.value->>'hanging_weight','')) ~ '^[0-9]+(\.[0-9]+)?$'
                       THEN btrim(d.value->>'hanging_weight')::numeric END AS w
             FROM jsonb_array_elements(COALESCE(v_row.detail, '[]'::jsonb)) AS d) t
          WHERE t.w IS NOT NULL AND t.w > 0));
  END IF;

  IF p_rec.source_kind = 'pig' THEN
    SELECT g.value INTO v_g
      FROM jsonb_array_elements(
             COALESCE((SELECT data FROM public.app_store WHERE key = 'ppp-feeders-v1'), '[]'::jsonb)) AS g
     WHERE COALESCE(btrim(g.value->>'id'), '') = split_part(p_rec.source_id, ':', 1)
     LIMIT 1;
    IF v_g IS NULL THEN RETURN jsonb_build_object('matched', false); END IF;
    v_phase := 'actual';
    SELECT t.value INTO v_t
      FROM jsonb_array_elements(COALESCE(v_g->'processingTrips', '[]'::jsonb)) AS t
     WHERE COALESCE(btrim(t.value->>'id'), '') = split_part(p_rec.source_id, ':', 2)
     LIMIT 1;
    IF v_t IS NULL THEN
      v_phase := 'planned';
      SELECT t.value INTO v_t
        FROM jsonb_array_elements(COALESCE(v_g->'plannedProcessingTrips', '[]'::jsonb)) AS t
       WHERE COALESCE(btrim(t.value->>'id'), '') = split_part(p_rec.source_id, ':', 2)
       LIMIT 1;
    END IF;
    IF v_t IS NULL THEN RETURN jsonb_build_object('matched', false); END IF;
    SELECT COALESCE((data -> split_part(p_rec.source_id, ':', 2) ->> 'locked')::boolean, false)
      INTO v_locked
      FROM public.app_store WHERE key = 'ppp-pig-planned-trip-locks-v1';
    v_age := public._pig_group_age_days(
      v_g,
      CASE WHEN COALESCE(v_t->>'date','') ~ '^\d{4}-\d{2}-\d{2}' THEN left(v_t->>'date',10)::date
           ELSE p_rec.processing_date END);
    RETURN jsonb_build_object(
      'matched', true,
      'batch_name', COALESCE(v_g->>'batchName', v_g->>'id'),
      'group_id', v_g->>'id',
      'trip_id', split_part(p_rec.source_id, ':', 2),
      'trip_ordinal', p_rec.trip_ordinal,
      'trip_label', 'Trip ' || COALESCE(p_rec.trip_ordinal, 0),
      'phase', v_phase,
      'scheduled_with_processor', COALESCE(v_locked, false),
      'processing_date', CASE WHEN COALESCE(v_t->>'date','') ~ '^\d{4}-\d{2}-\d{2}' THEN left(v_t->>'date',10) END,
      'count', CASE WHEN v_phase = 'actual'
                    THEN NULLIF(btrim(COALESCE(v_t->>'pigCount','')), '')::int
                    ELSE NULLIF(btrim(COALESCE(v_t->>'plannedCount','')), '')::int END,
      'age', v_age,
      -- 188: the exact trip's planner-owned carcass hanging weight. ACTUAL
      -- trips only, regex-validated BEFORE the cast; a malformed/blank/zero
      -- legacy value emits NULL (clients fail closed at "Not recorded",
      -- never 0%) and can never make get/list Processing records throw.
      'hanging_weight',
        (SELECT s.v FROM (
           SELECT CASE WHEN v_phase = 'actual'
                        AND btrim(COALESCE(v_t->>'hangingWeight','')) ~ '^[0-9]+(\.[0-9]+)?$'
                       THEN btrim(v_t->>'hangingWeight')::numeric END AS v) s
          WHERE s.v > 0));
  END IF;

  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_source_projection(public.processing_records) FROM PUBLIC, anon, authenticated;

-- ── 2. Per-animal detail — guard the two hanging-weight casts ────────────────
-- Verbatim mig-178 body except the cattle/sheep 'hanging_weight' values are
-- regex-validated before the numeric cast (matching the guarded pig legacy
-- parse already in this function). A malformed stored detail value now
-- yields NULL for that animal instead of throwing the whole record read.
CREATE OR REPLACE FUNCTION public._processing_animal_detail(p_rec public.processing_records)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE
  v_detail jsonb;
  v_pdate  date;
  v_out    jsonb;
  v_g      jsonb;
  v_t      jsonb;
BEGIN
  IF p_rec.source_kind = 'cattle' THEN
    SELECT cows_detail, COALESCE(actual_process_date, planned_process_date)
      INTO v_detail, v_pdate
      FROM public.cattle_processing_batches WHERE id = p_rec.source_id;
    IF v_detail IS NULL THEN RETURN NULL; END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'animal_id', c.id,
             'tag', c.tag,
             'birth_date', c.birth_date,
             'age_days', CASE WHEN c.birth_date IS NOT NULL AND v_pdate IS NOT NULL
                              THEN v_pdate - c.birth_date END,
             'hanging_weight', CASE WHEN btrim(COALESCE(d.value->>'hanging_weight','')) ~ '^[0-9]+(\.[0-9]+)?$'
                                    THEN btrim(d.value->>'hanging_weight')::numeric END,
             'live_weight', lw.weight
           ) ORDER BY ord), '[]'::jsonb)
      INTO v_out
      FROM jsonb_array_elements(COALESCE(v_detail, '[]'::jsonb)) WITH ORDINALITY AS d(value, ord)
      JOIN public.cattle c ON c.id = d.value->>'cattle_id'
      LEFT JOIN LATERAL (
        SELECT w.weight
          FROM public.weigh_ins w
          JOIN public.weigh_in_sessions ws ON ws.id = w.session_id AND ws.species = 'cattle'
         WHERE w.weight IS NOT NULL AND w.weight > 0
           AND (w.tag = c.tag OR w.tag IN (
                 SELECT ot.value->>'tag'
                   FROM jsonb_array_elements(COALESCE(c.old_tags, '[]'::jsonb)) AS ot
                  WHERE COALESCE(ot.value->>'source', '') <> 'import'))
         ORDER BY w.entered_at DESC
         LIMIT 1
      ) lw ON true;
    RETURN COALESCE(v_out, '[]'::jsonb);
  END IF;

  IF p_rec.source_kind = 'sheep' THEN
    SELECT sheep_detail, COALESCE(actual_process_date, planned_process_date)
      INTO v_detail, v_pdate
      FROM public.sheep_processing_batches WHERE id = p_rec.source_id;
    IF v_detail IS NULL THEN RETURN NULL; END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'animal_id', s.id,
             'tag', s.tag,
             'birth_date', s.birth_date,
             'age_days', CASE WHEN s.birth_date IS NOT NULL AND v_pdate IS NOT NULL
                              THEN v_pdate - s.birth_date END,
             'hanging_weight', CASE WHEN btrim(COALESCE(d.value->>'hanging_weight','')) ~ '^[0-9]+(\.[0-9]+)?$'
                                    THEN btrim(d.value->>'hanging_weight')::numeric END,
             'live_weight', lw.weight
           ) ORDER BY ord), '[]'::jsonb)
      INTO v_out
      FROM jsonb_array_elements(COALESCE(v_detail, '[]'::jsonb)) WITH ORDINALITY AS d(value, ord)
      JOIN public.sheep s ON s.id = d.value->>'sheep_id'
      LEFT JOIN LATERAL (
        SELECT w.weight
          FROM public.weigh_ins w
          JOIN public.weigh_in_sessions ws ON ws.id = w.session_id AND ws.species = 'sheep'
         WHERE w.weight IS NOT NULL AND w.weight > 0
           AND (w.tag = s.tag OR w.tag IN (
                 SELECT ot.value->>'tag'
                   FROM jsonb_array_elements(COALESCE(s.old_tags, '[]'::jsonb)) AS ot
                  WHERE COALESCE(ot.value->>'source', '') <> 'import'))
         ORDER BY w.entered_at DESC
         LIMIT 1
      ) lw ON true;
    RETURN COALESCE(v_out, '[]'::jsonb);
  END IF;

  IF p_rec.source_kind = 'pig' AND p_rec.source_phase = 'actual' THEN
    -- Tagless: linked weigh-ins in deterministic (entered_at, id) order; the
    -- client labels them Pig 1..N. Falls back to the trip's stored legacy
    -- liveWeights string when no linked weigh-ins exist.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'weigh_in_id', w.id,
             'live_weight', w.weight
           ) ORDER BY w.entered_at ASC, w.id ASC), '[]'::jsonb)
      INTO v_out
      FROM public.weigh_ins w
     WHERE w.sent_to_trip_id = split_part(p_rec.source_id, ':', 2)
       AND w.sent_to_group_id = split_part(p_rec.source_id, ':', 1);
    IF jsonb_array_length(v_out) > 0 THEN RETURN v_out; END IF;
    SELECT g.value INTO v_g
      FROM jsonb_array_elements(
             COALESCE((SELECT data FROM public.app_store WHERE key = 'ppp-feeders-v1'), '[]'::jsonb)) AS g
     WHERE COALESCE(btrim(g.value->>'id'), '') = split_part(p_rec.source_id, ':', 1)
     LIMIT 1;
    SELECT t.value INTO v_t
      FROM jsonb_array_elements(COALESCE(v_g->'processingTrips', '[]'::jsonb)) AS t
     WHERE COALESCE(btrim(t.value->>'id'), '') = split_part(p_rec.source_id, ':', 2)
     LIMIT 1;
    IF v_t IS NULL THEN RETURN '[]'::jsonb; END IF;
    -- Legacy free-form parse mirroring the canonical client parser
    -- (parseLiveWeights, src/lib/pig.js): commas and all whitespace are
    -- separators; only strictly-numeric positive tokens survive, in source
    -- order. The CASE guard makes the numeric cast unreachable for invalid
    -- tokens, so malformed legacy text can never crash the record read.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'weigh_in_id', NULL,
             'live_weight', t.w
           ) ORDER BY t.ord), '[]'::jsonb)
      INTO v_out
      FROM (
        SELECT x.ord,
               CASE WHEN x.wt ~ '^\d+(\.\d+)?$' THEN x.wt::numeric END AS w
          FROM unnest(regexp_split_to_array(COALESCE(v_t->>'liveWeights', ''), '[\s,]+'))
               WITH ORDINALITY AS x(wt, ord)
      ) t
     WHERE t.w > 0;
    RETURN v_out;
  END IF;

  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_animal_detail(public.processing_records) FROM PUBLIC, anon, authenticated;
