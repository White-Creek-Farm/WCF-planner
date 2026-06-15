-- ============================================================================
-- 116_pasture_map_land_areas.sql  (Pasture Map CP1)
-- ----------------------------------------------------------------------------
-- First migration of the Pasture Map feature (reserved block 116-124). Stands
-- up the provider-neutral land model + OnX-KML import surface. NO daily-report
-- wiring, NO move ledger, NO map provider coupling (that is CP3+). Geometry is
-- canonical in PostGIS; the client renders it with a swappable map layer.
--
-- DESIGN (consensus CC + Codex, Ronnie-approved):
-- 1. Single SELF-REFERENCING land_areas table (not pastures + paddocks). One
--    table models every tier Ronnie needs now and later:
--      pasture > paddock                       (cattle/sheep/breeder-pig)
--      feeder_pig_area > section > paddock      (feeder pigs, 0.5-ac paddocks)
--    plus infrastructure / scratch / outline_candidate kinds. A future
--    designated-sheep tier needs no migration.
-- 2. Geometry is VERSIONED: land_area_geometry_versions is append-only so a
--    future move/grazing record (CP3) resolves against the boundary that
--    existed at that time, even after a boundary is re-drawn.
-- 3. SPECIES IS DECOUPLED FROM LAND. land_areas carries an optional
--    `designation` hint only; the species<->land link is a dated move event in
--    a later checkpoint, never a column here.
-- 4. IMPORT: OnX Web-Map KML exports Polygons (true areas) + LineStrings
--    (boundaries traced as open paths) with a stable per-markup UUID in
--    ExtendedData. The client parses KML -> GeoJSON (@tmcw/togeojson) and posts
--    placemarks to import_land_area_batch. Polygons import as reviewable areas;
--    LineStrings import as kind='outline_candidate' (NEVER auto-closed) for
--    manual close/convert. Re-importing the same file UPDATES matches by
--    (source, source_external_id) instead of duplicating. Each import is one
--    pasture_import_batches row so batch/file identity is preserved.
-- 5. NO fabricated grazing history: imported/drawn areas start
--    baseline_no_history=true (neutral on the map, no day counter) until a real
--    move exists. There is no seeded "last grazed 60 days ago" date.
-- 6. Geometry validity: imported Polygons are checked with ST_IsValid; invalid
--    rings are stored as raw_geometry with geometry_status='invalid' and get NO
--    version (no silent ST_MakeValid). LineStrings are outline_candidate until
--    a human closes them. All stored geometry is forced 2D (OnX LineStrings
--    carry a Z/elevation ordinate we drop). Acreage is GEODESIC
--    (ST_Area(::geography)), never planar.
--
-- ROLES (mig 115 convention, public.profile_role()):
--   read  (list_land_areas):           farm_team / management / admin
--   write (import/classify/close/del): management / admin only
--   equipment_tech + inactive have NO Pasture Map access.
--
-- ACCESS MODEL: deny-all RLS + REVOKE ALL on every table; all access is through
-- SECURITY DEFINER RPCs (mig 071/112/115 pattern). Geometry columns are served
-- as GeoJSON via ST_AsGeoJSON inside the RPCs (PostgREST would otherwise return
-- hex WKB). Validation failures use the 'PM_VALIDATION:' prefix; the bare
-- 'authenticated caller required' message stays UNprefixed (mig 112/115).
--
-- ACTIVITY/COMMENTS: deliberately NOT wired in CP1 (no comments, notifications,
-- or Task Center in this checkpoint). Audit is via created_by/updated_by/
-- deleted_by columns. A later checkpoint adds a 'land.area' activity branch.
--
-- POSTGIS: enabled in the `extensions` schema (Supabase standard) and every
-- PostGIS type/function is schema-qualified (extensions.geometry, extensions.
-- ST_*) so resolution does not depend on the session search_path.
--
-- NO BEGIN/COMMIT in this file: TEST applies via exec_sql (rejects them); PROD
-- applies with psql --single-transaction for atomicity.
-- Apply order: TEST first, PROD after lane approval.
-- Depends on: public.profiles, public.profile_role().
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;

-- ── 1. pasture_import_batches ───────────────────────────────────────────────
-- One row per KML upload / import operation. Preserves batch + file identity so
-- multiple KML files can be imported and audited independently.

CREATE TABLE IF NOT EXISTS public.pasture_import_batches (
  id              text PRIMARY KEY,
  source          text NOT NULL DEFAULT 'onx_kml'
                    CHECK (source IN ('onx_kml', 'manual', 'drawn')),
  file_name       text,
  placemark_count int  NOT NULL DEFAULT 0,
  inserted_count  int  NOT NULL DEFAULT 0,
  updated_count   int  NOT NULL DEFAULT 0,
  imported_by     uuid REFERENCES public.profiles(id),
  imported_at     timestamptz NOT NULL DEFAULT now(),
  notes           text
);

REVOKE ALL ON TABLE public.pasture_import_batches FROM PUBLIC, anon, authenticated;
ALTER TABLE public.pasture_import_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pasture_import_batches_deny_all ON public.pasture_import_batches;
CREATE POLICY pasture_import_batches_deny_all ON public.pasture_import_batches
  FOR ALL USING (false);

-- ── 2. land_areas (self-referencing land model) ─────────────────────────────

CREATE TABLE IF NOT EXISTS public.land_areas (
  id                  text PRIMARY KEY,
  parent_id           text REFERENCES public.land_areas(id) ON DELETE SET NULL,
  kind                text NOT NULL DEFAULT 'unclassified'
                        CHECK (kind IN ('unclassified', 'pasture', 'feeder_pig_area',
                                        'section', 'paddock', 'infrastructure',
                                        'scratch', 'outline_candidate')),
  name                text NOT NULL,
  permanence          text CHECK (permanence IN ('permanent', 'temporary')),
  designation         text CHECK (designation IN ('cattle', 'feeder_pig', 'sheep',
                                                   'breeder_pig', 'mixed', 'none')),
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'retired', 'blocked_repair')),
  review_status       text NOT NULL DEFAULT 'reviewed'
                        CHECK (review_status IN ('pending_review', 'reviewed')),
  geometry_status     text NOT NULL DEFAULT 'none'
                        CHECK (geometry_status IN ('none', 'valid', 'invalid',
                                                   'outline_candidate')),
  baseline_no_history boolean NOT NULL DEFAULT true,
  -- As-imported / working geometry, any type (LineString candidates or
  -- polygons), forced 2D + SRID 4326. The canonical polygon history lives in
  -- land_area_geometry_versions; raw_geometry is provenance + the source a
  -- human closes an outline candidate from.
  raw_geometry        extensions.geometry(Geometry, 4326),
  manual_acres        numeric(12, 4),
  computed_acres      numeric(12, 4),
  source              text NOT NULL DEFAULT 'drawn'
                        CHECK (source IN ('onx_kml', 'manual', 'drawn')),
  source_external_id  text,
  import_batch_id     text REFERENCES public.pasture_import_batches(id) ON DELETE SET NULL,
  raw_name            text,
  raw_notes           text,
  raw_color           text,
  created_by          uuid REFERENCES public.profiles(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_by          uuid REFERENCES public.profiles(id),
  deleted_at          timestamptz
);

-- Re-import idempotency: the same OnX markup (source, UUID) maps to one live
-- row. OnX mints unique v4 UUIDs per markup, so a cross-file collision only
-- happens when a shape was copied between files -- in which case updating the
-- existing row (Ronnie's stated "update, don't duplicate" rule) is correct.
CREATE UNIQUE INDEX IF NOT EXISTS land_areas_source_ext_uidx
  ON public.land_areas (source, source_external_id)
  WHERE source_external_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS land_areas_parent_idx
  ON public.land_areas (parent_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS land_areas_kind_idx
  ON public.land_areas (kind) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS land_areas_raw_geom_gix
  ON public.land_areas USING gist (raw_geometry);

REVOKE ALL ON TABLE public.land_areas FROM PUBLIC, anon, authenticated;
ALTER TABLE public.land_areas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS land_areas_deny_all ON public.land_areas;
CREATE POLICY land_areas_deny_all ON public.land_areas
  FOR ALL USING (false);

-- ── 3. land_area_geometry_versions (append-only boundary history) ───────────

CREATE TABLE IF NOT EXISTS public.land_area_geometry_versions (
  id             text PRIMARY KEY,
  land_area_id   text NOT NULL REFERENCES public.land_areas(id) ON DELETE CASCADE,
  version_number int  NOT NULL,
  geom           extensions.geometry(MultiPolygon, 4326) NOT NULL,
  computed_acres numeric(12, 4),
  source         text,
  raw_payload    jsonb,
  created_by     uuid REFERENCES public.profiles(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (land_area_id, version_number)
);

CREATE INDEX IF NOT EXISTS land_area_geom_versions_area_idx
  ON public.land_area_geometry_versions (land_area_id, version_number DESC);
CREATE INDEX IF NOT EXISTS land_area_geom_versions_gix
  ON public.land_area_geometry_versions USING gist (geom);

REVOKE ALL ON TABLE public.land_area_geometry_versions FROM PUBLIC, anon, authenticated;
ALTER TABLE public.land_area_geometry_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS land_area_geom_versions_deny_all ON public.land_area_geometry_versions;
CREATE POLICY land_area_geom_versions_deny_all ON public.land_area_geometry_versions
  FOR ALL USING (false);

-- ── 4. Internal helpers (SECDEF-internal; no client EXECUTE) ────────────────

-- acres from a geometry, geodesic (m^2 / 4046.8564224). NULL-safe.
CREATE OR REPLACE FUNCTION public._land_area_acres(p_geom extensions.geometry)
RETURNS numeric
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN p_geom IS NULL THEN NULL
    ELSE round((extensions.ST_Area(p_geom::extensions.geography) / 4046.8564224)::numeric, 4)
  END;
$fn$;
REVOKE ALL ON FUNCTION public._land_area_acres(extensions.geometry) FROM PUBLIC, anon, authenticated;

-- One land_area -> jsonb summary, including current (latest) polygon version as
-- GeoJSON, the raw/working geometry as GeoJSON, and a child count. Single
-- source of truth for RPC return shapes.
CREATE OR REPLACE FUNCTION public._land_area_summary(p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
STABLE
AS $fn$
DECLARE
  v_out jsonb;
BEGIN
  SELECT jsonb_build_object(
    'id', a.id,
    'parent_id', a.parent_id,
    'kind', a.kind,
    'name', a.name,
    'permanence', a.permanence,
    'designation', a.designation,
    'status', a.status,
    'review_status', a.review_status,
    'geometry_status', a.geometry_status,
    'baseline_no_history', a.baseline_no_history,
    'manual_acres', a.manual_acres,
    'computed_acres', a.computed_acres,
    'effective_acres', COALESCE(a.manual_acres, a.computed_acres),
    'source', a.source,
    'source_external_id', a.source_external_id,
    'import_batch_id', a.import_batch_id,
    'raw_name', a.raw_name,
    'raw_notes', a.raw_notes,
    'raw_color', a.raw_color,
    'created_at', a.created_at,
    'updated_at', a.updated_at,
    'child_count', (SELECT count(*) FROM public.land_areas c
                     WHERE c.parent_id = a.id AND c.deleted_at IS NULL),
    'raw_geometry', CASE WHEN a.raw_geometry IS NULL THEN NULL
                         ELSE extensions.ST_AsGeoJSON(a.raw_geometry)::jsonb END,
    'current_version', (
      SELECT jsonb_build_object(
        'id', v.id,
        'version_number', v.version_number,
        'computed_acres', v.computed_acres,
        'created_at', v.created_at,
        'geometry', extensions.ST_AsGeoJSON(v.geom)::jsonb)
      FROM public.land_area_geometry_versions v
      WHERE v.land_area_id = a.id
      ORDER BY v.version_number DESC
      LIMIT 1
    )
  )
  INTO v_out
  FROM public.land_areas a
  WHERE a.id = p_id;

  RETURN v_out;
END
$fn$;
REVOKE ALL ON FUNCTION public._land_area_summary(text) FROM PUBLIC, anon, authenticated;

-- Append a new polygon geometry version for an area and refresh its denormalised
-- computed_acres / geometry_status. p_geom must already be a validated 2D
-- (Multi)Polygon in SRID 4326. Returns the new version id.
CREATE OR REPLACE FUNCTION public._land_area_add_version(
  p_area_id text,
  p_geom    extensions.geometry,
  p_source  text,
  p_raw     jsonb,
  p_actor   uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_next   int;
  v_id     text := 'lagv-' || gen_random_uuid()::text;
  v_multi  extensions.geometry(MultiPolygon, 4326);
  v_acres  numeric;
BEGIN
  v_multi := extensions.ST_Multi(extensions.ST_Force2D(extensions.ST_SetSRID(p_geom, 4326)));
  v_acres := public._land_area_acres(v_multi);

  SELECT COALESCE(max(version_number), 0) + 1
    INTO v_next
    FROM public.land_area_geometry_versions
   WHERE land_area_id = p_area_id;

  INSERT INTO public.land_area_geometry_versions
    (id, land_area_id, version_number, geom, computed_acres, source, raw_payload, created_by)
  VALUES
    (v_id, p_area_id, v_next, v_multi, v_acres, p_source, p_raw, p_actor);

  UPDATE public.land_areas
     SET raw_geometry    = v_multi,
         computed_acres  = v_acres,
         geometry_status = 'valid',
         updated_at      = now()
   WHERE id = p_area_id;

  RETURN v_id;
END
$fn$;
REVOKE ALL ON FUNCTION public._land_area_add_version(text, extensions.geometry, text, jsonb, uuid)
  FROM PUBLIC, anon, authenticated;

-- ── 5. import_land_area_batch ───────────────────────────────────────────────
-- management/admin. p_placemarks is a jsonb array; each element:
--   { external_id, name, notes, color, geometry_type, geometry }
-- where geometry is a GeoJSON geometry object (Polygon / MultiPolygon /
-- LineString). Polygons -> reviewable areas (valid -> first geometry version;
-- invalid -> stored raw, geometry_status='invalid', no version). LineStrings ->
-- kind='outline_candidate' (raw line stored, NEVER auto-closed). Upsert key is
-- (source, source_external_id): an existing live match is UPDATED (re-staged),
-- not duplicated. Replay-idempotent by batch id.

CREATE OR REPLACE FUNCTION public.import_land_area_batch(
  p_batch_id   text,
  p_source     text,
  p_file_name  text,
  p_placemarks jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller   uuid := auth.uid();
  v_role     text;
  v_pm       jsonb;
  v_ext      text;
  v_name     text;
  v_gj       jsonb;
  v_gtype    text;
  v_geom     extensions.geometry;
  v_geom2d   extensions.geometry;
  v_existing public.land_areas%ROWTYPE;
  v_area_id  text;
  v_kind     text;
  v_gstatus  text;
  v_valid    boolean;
  v_ins      int := 0;
  v_upd      int := 0;
  v_count    int := 0;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'import_land_area_batch: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot import land areas', COALESCE(v_role, 'null');
  END IF;

  IF p_batch_id IS NULL OR p_batch_id !~ '^[A-Za-z0-9-]+$' OR length(p_batch_id) > 100 THEN
    RAISE EXCEPTION 'PM_VALIDATION: invalid batch id';
  END IF;
  IF COALESCE(p_source, '') NOT IN ('onx_kml', 'manual', 'drawn') THEN
    RAISE EXCEPTION 'PM_VALIDATION: unknown source %', COALESCE(p_source, 'null');
  END IF;

  -- Replay idempotency: a committed batch id returns its recorded summary.
  IF EXISTS (SELECT 1 FROM public.pasture_import_batches WHERE id = p_batch_id) THEN
    RETURN (
      SELECT jsonb_build_object(
        'batch_id', id, 'replayed', true,
        'placemark_count', placemark_count,
        'inserted', inserted_count, 'updated', updated_count)
      FROM public.pasture_import_batches WHERE id = p_batch_id);
  END IF;

  IF p_placemarks IS NULL OR jsonb_typeof(p_placemarks) <> 'array' THEN
    RAISE EXCEPTION 'PM_VALIDATION: placemarks must be a json array';
  END IF;

  -- Serialize concurrent imports so the source-uuid upserts cannot race.
  PERFORM pg_advisory_xact_lock(hashtext('land_areas_import'), hashtext(p_source));

  -- Create the batch row FIRST so land_areas.import_batch_id FK resolves during
  -- the loop; counts are backfilled after. (Same txn: a later failure rolls the
  -- whole import back, batch row included.)
  INSERT INTO public.pasture_import_batches
    (id, source, file_name, placemark_count, inserted_count, updated_count, imported_by)
  VALUES
    (p_batch_id, p_source, NULLIF(btrim(COALESCE(p_file_name, '')), ''), 0, 0, 0, v_caller);

  FOR v_pm IN SELECT * FROM jsonb_array_elements(p_placemarks) LOOP
    v_count := v_count + 1;
    v_ext   := NULLIF(btrim(COALESCE(v_pm->>'external_id', '')), '');
    v_name  := NULLIF(btrim(COALESCE(v_pm->>'name', '')), '');
    v_gj    := v_pm->'geometry';
    v_gtype := COALESCE(v_pm->>'geometry_type', v_gj->>'type');

    IF v_gj IS NULL OR jsonb_typeof(v_gj) <> 'object' THEN
      CONTINUE;  -- skip a placemark with no usable geometry
    END IF;

    -- Build, force 2D, stamp SRID 4326. ST_GeomFromGeoJSON throws on malformed
    -- input; let that abort the whole import (atomic, all-or-nothing).
    v_geom   := extensions.ST_GeomFromGeoJSON(v_gj::text);
    v_geom2d := extensions.ST_Force2D(extensions.ST_SetSRID(v_geom, 4326));
    v_gtype  := extensions.ST_GeometryType(v_geom2d);  -- 'ST_Polygon' etc.

    IF v_gtype IN ('ST_Polygon', 'ST_MultiPolygon') THEN
      v_valid := extensions.ST_IsValid(v_geom2d);
      -- Imported polygons land UNCLASSIFIED + pending_review: the real KML
      -- mixes paddocks with HUB/SHOP/scratch, so a manager classifies them
      -- (Accept as Pasture/Paddock, Infrastructure, Scratch/Delete) before any
      -- area participates in occupancy/rest logic.
      v_kind  := 'unclassified';
      v_gstatus := CASE WHEN v_valid THEN 'valid' ELSE 'invalid' END;
    ELSIF v_gtype IN ('ST_LineString', 'ST_MultiLineString') THEN
      v_valid := false;
      v_kind  := 'outline_candidate';
      v_gstatus := 'outline_candidate';
    ELSE
      v_kind  := 'scratch';
      v_valid := false;
      v_gstatus := 'invalid';
    END IF;

    -- Upsert by (source, external_id) when an id is present.
    v_existing := NULL;
    IF v_ext IS NOT NULL THEN
      SELECT * INTO v_existing FROM public.land_areas
       WHERE source = p_source AND source_external_id = v_ext AND deleted_at IS NULL
       LIMIT 1;
    END IF;

    IF v_existing.id IS NOT NULL THEN
      v_area_id := v_existing.id;
      UPDATE public.land_areas
         SET raw_name        = v_name,
             raw_notes       = NULLIF(v_pm->>'notes', ''),
             raw_color       = NULLIF(v_pm->>'color', ''),
             raw_geometry    = v_geom2d,
             geometry_status = v_gstatus,
             import_batch_id = p_batch_id,
             updated_at      = now()
       WHERE id = v_area_id;
      v_upd := v_upd + 1;
    ELSE
      v_area_id := 'la-' || gen_random_uuid()::text;
      INSERT INTO public.land_areas
        (id, kind, name, status, review_status, geometry_status,
         baseline_no_history, raw_geometry, source, source_external_id,
         import_batch_id, raw_name, raw_notes, raw_color, created_by)
      VALUES
        (v_area_id, v_kind, COALESCE(v_name, 'Imported area'), 'active',
         'pending_review', v_gstatus, true, v_geom2d, p_source, v_ext,
         p_batch_id, v_name, NULLIF(v_pm->>'notes', ''), NULLIF(v_pm->>'color', ''),
         v_caller);
      v_ins := v_ins + 1;
    END IF;

    -- A valid polygon gets its first canonical version immediately.
    IF v_gstatus = 'valid' THEN
      PERFORM public._land_area_add_version(
        v_area_id, v_geom2d, p_source,
        jsonb_build_object('external_id', v_ext, 'name', v_name), v_caller);
    END IF;
  END LOOP;

  UPDATE public.pasture_import_batches
     SET placemark_count = v_count, inserted_count = v_ins, updated_count = v_upd
   WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'batch_id', p_batch_id, 'replayed', false,
    'placemark_count', v_count, 'inserted', v_ins, 'updated', v_upd);
END
$fn$;
REVOKE ALL ON FUNCTION public.import_land_area_batch(text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_land_area_batch(text, text, text, jsonb) TO authenticated;

-- ── 6. list_land_areas ──────────────────────────────────────────────────────
-- read roles. Returns every live land_area with geometry as GeoJSON.

CREATE OR REPLACE FUNCTION public.list_land_areas(
  p_include_deleted boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_areas  jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'list_land_areas: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot read land areas', COALESCE(v_role, 'null');
  END IF;

  SELECT COALESCE(jsonb_agg(public._land_area_summary(a.id)
           ORDER BY a.kind, a.name, a.created_at), '[]'::jsonb)
    INTO v_areas
    FROM public.land_areas a
   WHERE (p_include_deleted OR a.deleted_at IS NULL);

  RETURN jsonb_build_object('land_areas', v_areas);
END
$fn$;
REVOKE ALL ON FUNCTION public.list_land_areas(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_land_areas(boolean) TO authenticated;

-- ── 7. update_land_area (classify / edit attributes) ────────────────────────
-- management/admin. NULL args leave a field unchanged; explicit clear flags
-- null out parent/manual_acres. Geometry is changed only via close/version RPCs.

CREATE OR REPLACE FUNCTION public.update_land_area(
  p_id              text,
  p_name            text    DEFAULT NULL,
  p_kind            text    DEFAULT NULL,
  p_parent_id       text    DEFAULT NULL,
  p_clear_parent    boolean DEFAULT false,
  p_permanence      text    DEFAULT NULL,
  p_designation     text    DEFAULT NULL,
  p_status          text    DEFAULT NULL,
  p_review_status   text    DEFAULT NULL,
  p_manual_acres    numeric DEFAULT NULL,
  p_clear_manual    boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_row    public.land_areas%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'update_land_area: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot edit land areas', COALESCE(v_role, 'null');
  END IF;

  SELECT * INTO v_row FROM public.land_areas WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'PM_VALIDATION: land area % not found', p_id;
  END IF;

  IF p_name IS NOT NULL THEN
    IF length(btrim(p_name)) = 0 OR length(p_name) > 200 THEN
      RAISE EXCEPTION 'PM_VALIDATION: name must be 1..200 characters';
    END IF;
    UPDATE public.land_areas SET name = btrim(p_name) WHERE id = p_id;
  END IF;

  IF p_kind IS NOT NULL THEN
    IF p_kind NOT IN ('unclassified', 'pasture', 'feeder_pig_area', 'section',
                      'paddock', 'infrastructure', 'scratch', 'outline_candidate') THEN
      RAISE EXCEPTION 'PM_VALIDATION: unknown kind %', p_kind;
    END IF;
    UPDATE public.land_areas SET kind = p_kind WHERE id = p_id;
  END IF;

  IF p_clear_parent THEN
    UPDATE public.land_areas SET parent_id = NULL WHERE id = p_id;
  ELSIF p_parent_id IS NOT NULL THEN
    IF p_parent_id = p_id THEN
      RAISE EXCEPTION 'PM_VALIDATION: an area cannot be its own parent';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.land_areas
                    WHERE id = p_parent_id AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'PM_VALIDATION: parent area % not found', p_parent_id;
    END IF;
    -- Cycle guard: walking the ancestor chain UP from the proposed parent must
    -- never reach p_id. Catches both A->B then B->A and deeper loops (direct
    -- self-parent is also caught here; the explicit check above just gives a
    -- clearer message). Depth-bounded so corrupt pre-existing data can't loop.
    IF EXISTS (
      WITH RECURSIVE ancestors(id, parent_id, depth) AS (
        SELECT la.id, la.parent_id, 1
          FROM public.land_areas la WHERE la.id = p_parent_id
        UNION ALL
        SELECT la.id, la.parent_id, a.depth + 1
          FROM public.land_areas la
          JOIN ancestors a ON la.id = a.parent_id
         WHERE a.depth < 1000
      )
      SELECT 1 FROM ancestors WHERE id = p_id
    ) THEN
      RAISE EXCEPTION 'PM_VALIDATION: parent assignment would create a cycle';
    END IF;
    UPDATE public.land_areas SET parent_id = p_parent_id WHERE id = p_id;
  END IF;

  IF p_permanence IS NOT NULL THEN
    IF p_permanence NOT IN ('permanent', 'temporary') THEN
      RAISE EXCEPTION 'PM_VALIDATION: unknown permanence %', p_permanence;
    END IF;
    UPDATE public.land_areas SET permanence = p_permanence WHERE id = p_id;
  END IF;

  IF p_designation IS NOT NULL THEN
    IF p_designation NOT IN ('cattle', 'feeder_pig', 'sheep', 'breeder_pig', 'mixed', 'none') THEN
      RAISE EXCEPTION 'PM_VALIDATION: unknown designation %', p_designation;
    END IF;
    UPDATE public.land_areas SET designation = p_designation WHERE id = p_id;
  END IF;

  IF p_status IS NOT NULL THEN
    IF p_status NOT IN ('active', 'retired', 'blocked_repair') THEN
      RAISE EXCEPTION 'PM_VALIDATION: unknown status %', p_status;
    END IF;
    UPDATE public.land_areas SET status = p_status WHERE id = p_id;
  END IF;

  IF p_review_status IS NOT NULL THEN
    IF p_review_status NOT IN ('pending_review', 'reviewed') THEN
      RAISE EXCEPTION 'PM_VALIDATION: unknown review_status %', p_review_status;
    END IF;
    UPDATE public.land_areas SET review_status = p_review_status WHERE id = p_id;
  END IF;

  IF p_clear_manual THEN
    UPDATE public.land_areas SET manual_acres = NULL WHERE id = p_id;
  ELSIF p_manual_acres IS NOT NULL THEN
    IF p_manual_acres < 0 OR p_manual_acres > 1000000 THEN
      RAISE EXCEPTION 'PM_VALIDATION: manual_acres out of range';
    END IF;
    UPDATE public.land_areas SET manual_acres = round(p_manual_acres, 4) WHERE id = p_id;
  END IF;

  UPDATE public.land_areas SET updated_at = now() WHERE id = p_id;
  RETURN public._land_area_summary(p_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.update_land_area(text, text, text, text, boolean, text, text, text, text, numeric, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_land_area(text, text, text, text, boolean, text, text, text, text, numeric, boolean) TO authenticated;

-- ── 8. close_land_area_outline ──────────────────────────────────────────────
-- management/admin. Promotes an outline_candidate (or fixes an invalid polygon)
-- by storing a human-confirmed closed polygon (GeoJSON). Validates ST_IsValid +
-- (Multi)Polygon type, forces 2D, writes the first/next canonical version, and
-- re-classifies kind. Pass an explicit target kind to classify on close;
-- defaults to 'unclassified' (manager classifies later). NEVER auto-closes a
-- line itself -- the closed ring is always human-confirmed client-side.

CREATE OR REPLACE FUNCTION public.close_land_area_outline(
  p_id              text,
  p_polygon_geojson jsonb,
  p_kind            text DEFAULT 'unclassified'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_row    public.land_areas%ROWTYPE;
  v_geom   extensions.geometry;
  v_gtype  text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'close_land_area_outline: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot close outlines', COALESCE(v_role, 'null');
  END IF;

  IF p_kind NOT IN ('unclassified', 'pasture', 'feeder_pig_area', 'section', 'paddock') THEN
    RAISE EXCEPTION 'PM_VALIDATION: close target kind % invalid', p_kind;
  END IF;

  SELECT * INTO v_row FROM public.land_areas WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'PM_VALIDATION: land area % not found', p_id;
  END IF;

  IF p_polygon_geojson IS NULL OR jsonb_typeof(p_polygon_geojson) <> 'object' THEN
    RAISE EXCEPTION 'PM_VALIDATION: a GeoJSON polygon object is required';
  END IF;

  v_geom  := extensions.ST_Force2D(extensions.ST_SetSRID(
              extensions.ST_GeomFromGeoJSON(p_polygon_geojson::text), 4326));
  v_gtype := extensions.ST_GeometryType(v_geom);
  IF v_gtype NOT IN ('ST_Polygon', 'ST_MultiPolygon') THEN
    RAISE EXCEPTION 'PM_VALIDATION: closed geometry must be a polygon (got %)', v_gtype;
  END IF;
  IF NOT extensions.ST_IsValid(v_geom) THEN
    RAISE EXCEPTION 'PM_VALIDATION: closed polygon is self-intersecting/invalid; fix and retry';
  END IF;

  PERFORM public._land_area_add_version(
    p_id, v_geom, COALESCE(v_row.source, 'drawn'),
    jsonb_build_object('closed_from', v_row.kind), v_caller);

  -- Reclassify ONLY when the pre-close row was an outline candidate OR an
  -- invalid imported polygon now being fixed (use the pre-state snapshot in
  -- v_row, since _land_area_add_version just flipped geometry_status to valid).
  -- A valid, already-classified area keeps its kind when its geometry is
  -- re-versioned, so close cannot silently reset a real paddock to p_kind.
  IF v_row.kind = 'outline_candidate' OR v_row.geometry_status = 'invalid' THEN
    UPDATE public.land_areas SET kind = p_kind WHERE id = p_id;
  END IF;

  RETURN public._land_area_summary(p_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.close_land_area_outline(text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_land_area_outline(text, jsonb, text) TO authenticated;

-- ── 9. delete_land_area (soft) ──────────────────────────────────────────────
-- management/admin. Soft-delete; children are detached (parent_id nulled) so a
-- deleted parent does not orphan the hierarchy invisibly. Geometry versions are
-- retained (CASCADE only fires on hard delete) for historical move resolution.

CREATE OR REPLACE FUNCTION public.delete_land_area(
  p_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_row    public.land_areas%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'delete_land_area: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('management', 'admin') THEN
    RAISE EXCEPTION 'PM_VALIDATION: caller role % cannot delete land areas', COALESCE(v_role, 'null');
  END IF;

  SELECT * INTO v_row FROM public.land_areas WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PM_VALIDATION: land area % not found', p_id;
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'id', p_id);
  END IF;

  UPDATE public.land_areas SET parent_id = NULL WHERE parent_id = p_id;
  UPDATE public.land_areas
     SET deleted_at = now(), deleted_by = v_caller, updated_at = now()
   WHERE id = p_id;

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'id', p_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.delete_land_area(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_land_area(text) TO authenticated;
