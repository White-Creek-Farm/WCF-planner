-- ============================================================================
-- Migration 048: equipment_service_materials + equipment_material_clears
-- ----------------------------------------------------------------------------
-- Internal rolling-stock checklist for equipment maintenance materials. The
-- public /equipment/<slug> webform is unaffected — the materials surface is
-- admin-only at /fleet/materials. Storage is two new authenticated-only
-- tables; the existing equipment.service_intervals + attachment_checklists
-- JSONB shapes are not modified.
--
-- Tables:
--   equipment_service_materials  — one row per (equipment, service identity,
--     material name). Identity = (source_kind, interval_unit, interval_value,
--     attachment_name) per Codex amendment 3 (label is display-only; do not
--     join on label).
--   equipment_material_clears    — one row per (material, due bucket). Clearing
--     a material in the operator checklist inserts here; the rolling list
--     hides the material until the next_due milestone advances (then the
--     bucket changes and the clear no longer matches). Per Codex amendment 1
--     "Every Use" clears persist indefinitely (due_bucket_unit='use').
--
-- RLS:
--   Both tables are authenticated-only (FOR ALL). No anon policies. Materials
--   are an internal admin surface; no public anon access.
--
-- Identity / dedup:
--   UNIQUE NULLS NOT DISTINCT is used so NULL `interval_value` (for 'use'
--   intervals) and NULL `attachment_name` (for service_interval-sourced
--   rows) collapse properly under uniqueness. Postgres 15+ feature; Supabase
--   runs 15+. Same applies to the clears table where due_bucket_value is
--   NULL for 'use' clears.
--
-- Seed:
--   Approved list per Codex prompt (2026-05-06). Curation already strips
--   "knock out / inspect / clean / blow out / wash / pressure wash" lines
--   that don't reference an actual product — verified for 5065 50h
--   (Grease + Loctite 567 only; no air cleaner). Seed uses ON CONFLICT
--   DO NOTHING keyed on the structural identity, so re-applies are no-ops.
--   Each seed row gets auto_seeded=true so a future seed re-run won't
--   overwrite admin edits to materials added through the editor.
--
-- Idempotent: every CREATE uses IF NOT EXISTS; the seed uses ON CONFLICT
-- DO NOTHING. Safe to re-apply.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- (1) equipment_service_materials
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.equipment_service_materials (
  id              text PRIMARY KEY,
  equipment_id    text NOT NULL REFERENCES public.equipment(id) ON DELETE CASCADE,
  source_kind     text NOT NULL CHECK (source_kind IN ('service_interval', 'attachment_checklist')),
  service_label   text,                                          -- display only; do not join on this
  attachment_name text,                                          -- NULL when source_kind='service_interval'
  interval_value  numeric,                                       -- NULL when interval_unit='use'
  interval_unit   text NOT NULL CHECK (interval_unit IN ('hours', 'km', 'use')),
  material_name   text NOT NULL,
  qty             text,                                          -- text — accommodates "1.2 qt", "4 qt", "(2)", etc.
  unit            text,
  notes           text,
  active          boolean NOT NULL DEFAULT true,
  sort_order      int NOT NULL DEFAULT 0,
  auto_seeded     boolean NOT NULL DEFAULT false,
  source_excerpt  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Stable structural identity for seed dedup + clear linking. Label is excluded
-- on purpose (Codex amendment 3) — label text can drift; identity must not.
CREATE UNIQUE INDEX IF NOT EXISTS equipment_service_materials_identity
  ON public.equipment_service_materials (
    equipment_id, source_kind, interval_unit, interval_value, attachment_name, material_name
  ) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS equipment_service_materials_eq
  ON public.equipment_service_materials (equipment_id);

ALTER TABLE public.equipment_service_materials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS equipment_service_materials_auth_all ON public.equipment_service_materials;
CREATE POLICY equipment_service_materials_auth_all ON public.equipment_service_materials
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- DELIBERATELY: no anon policies. Materials surface is admin-only.

-- ----------------------------------------------------------------------------
-- (2) equipment_material_clears
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.equipment_material_clears (
  id                 text PRIMARY KEY,
  material_id        text NOT NULL REFERENCES public.equipment_service_materials(id) ON DELETE CASCADE,
  equipment_id       text NOT NULL REFERENCES public.equipment(id) ON DELETE CASCADE,
  due_bucket_value   numeric,                                    -- NULL for 'use' clears (clear lasts until manual reset)
  due_bucket_unit    text NOT NULL CHECK (due_bucket_unit IN ('hours', 'km', 'use')),
  cleared_at         timestamptz NOT NULL DEFAULT now(),
  cleared_by         text
);

-- One clear per (material, due bucket). Re-clicking Clear in the same bucket is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS equipment_material_clears_identity
  ON public.equipment_material_clears (material_id, due_bucket_value, due_bucket_unit) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS equipment_material_clears_eq
  ON public.equipment_material_clears (equipment_id);

ALTER TABLE public.equipment_material_clears ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS equipment_material_clears_auth_all ON public.equipment_material_clears;
CREATE POLICY equipment_material_clears_auth_all ON public.equipment_material_clears
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- DELIBERATELY: no anon policies.

-- ----------------------------------------------------------------------------
-- (3) Approved seed list (curated 2026-05-06)
-- ----------------------------------------------------------------------------
-- All rows are auto_seeded=true so admin edits via the editor stay safe on
-- a future seed re-run (ON CONFLICT DO NOTHING never modifies an existing row).
-- service_label is generated from interval/attachment context for display.
-- IDs are deterministic (md5 hash of the structural identity) so re-runs
-- produce the same id and admin foreign-key references stay stable.

WITH seed(slug, source_kind, attachment_name, interval_value, interval_unit, sort_order, material_name) AS (
  VALUES
    -- 5065
    ('5065',        'service_interval', NULL,             50::numeric,    'hours',  10, 'Grease'),
    ('5065',        'service_interval', NULL,             50::numeric,    'hours',  20, 'Loctite 567'),
    ('5065',        'service_interval', NULL,             250::numeric,   'hours',  10, 'Air filters'),
    ('5065',        'service_interval', NULL,             250::numeric,   'hours',  20, 'Battery terminal cleaner/protectant'),
    ('5065',        'service_interval', NULL,             500::numeric,   'hours',  10, 'Engine oil'),
    ('5065',        'service_interval', NULL,             500::numeric,   'hours',  20, 'Engine oil filter'),
    ('5065',        'service_interval', NULL,             500::numeric,   'hours',  30, 'Fuel filters'),
    ('5065',        'service_interval', NULL,             600::numeric,   'hours',  10, 'MFWD axle oil'),
    ('5065',        'service_interval', NULL,             600::numeric,   'hours',  20, 'Thread sealant'),
    ('5065',        'service_interval', NULL,             1200::numeric,  'hours',  10, 'Transmission-hydraulic oil'),
    ('5065',        'service_interval', NULL,             1200::numeric,  'hours',  20, 'Transmission-hydraulic oil filter'),
    ('5065',        'service_interval', NULL,             1200::numeric,  'hours',  30, 'Hydraulic pickup screen/strainer'),
    ('5065',        'service_interval', NULL,             2000::numeric,  'hours',  10, 'Coolant'),

    -- mini-ex
    ('mini-ex',     'service_interval', NULL,             50::numeric,    'hours',  10, 'Grease'),
    ('mini-ex',     'service_interval', NULL,             250::numeric,   'hours',  10, 'Battery terminal cleaner/protectant'),
    ('mini-ex',     'service_interval', NULL,             500::numeric,   'hours',  10, 'Engine oil (7.5 qt)'),
    ('mini-ex',     'service_interval', NULL,             500::numeric,   'hours',  20, 'Engine oil filter'),
    ('mini-ex',     'service_interval', NULL,             500::numeric,   'hours',  30, 'Hydraulic filter'),
    ('mini-ex',     'service_interval', NULL,             500::numeric,   'hours',  40, 'Case drain filter'),
    ('mini-ex',     'service_interval', NULL,             500::numeric,   'hours',  50, 'Reservoir breather cap'),
    ('mini-ex',     'service_interval', NULL,             1000::numeric,  'hours',  10, 'Final drive oil (1.2 qt each side)'),
    ('mini-ex',     'service_interval', NULL,             1000::numeric,  'hours',  20, 'Hydraulic fluid (4 gal)'),
    ('mini-ex',     'service_interval', NULL,             1000::numeric,  'hours',  30, 'Coolant (2.2 gal)'),

    -- hijet-2018
    ('hijet-2018',  'service_interval', NULL,             5000::numeric,  'km',     10, 'Engine oil'),
    ('hijet-2018',  'service_interval', NULL,             5000::numeric,  'km',     20, 'Engine oil filter'),
    ('hijet-2018',  'service_interval', NULL,             5000::numeric,  'km',     30, 'Air filter'),
    ('hijet-2018',  'service_interval', NULL,             5000::numeric,  'km',     40, 'Cabin air filter'),
    ('hijet-2018',  'service_interval', NULL,             5000::numeric,  'km',     50, 'Battery terminal cleaner/protectant'),
    ('hijet-2018',  'service_interval', NULL,             40000::numeric, 'km',     10, 'Spark plugs'),
    ('hijet-2018',  'service_interval', NULL,             40000::numeric, 'km',     20, 'Brake fluid'),
    ('hijet-2018',  'service_interval', NULL,             40000::numeric, 'km',     30, 'Transmission fluid'),
    ('hijet-2018',  'service_interval', NULL,             40000::numeric, 'km',     40, 'Coolant'),
    ('hijet-2018',  'service_interval', NULL,             40000::numeric, 'km',     50, 'Fuel filter'),
    ('hijet-2018',  'service_interval', NULL,             40000::numeric, 'km',     60, '4x4 transfer case oil'),
    ('hijet-2018',  'service_interval', NULL,             60000::numeric, 'km',     10, 'Timing belt'),

    -- hijet-2020 (same intervals + materials as hijet-2018)
    ('hijet-2020',  'service_interval', NULL,             5000::numeric,  'km',     10, 'Engine oil'),
    ('hijet-2020',  'service_interval', NULL,             5000::numeric,  'km',     20, 'Engine oil filter'),
    ('hijet-2020',  'service_interval', NULL,             5000::numeric,  'km',     30, 'Air filter'),
    ('hijet-2020',  'service_interval', NULL,             5000::numeric,  'km',     40, 'Cabin air filter'),
    ('hijet-2020',  'service_interval', NULL,             5000::numeric,  'km',     50, 'Battery terminal cleaner/protectant'),
    ('hijet-2020',  'service_interval', NULL,             40000::numeric, 'km',     10, 'Spark plugs'),
    ('hijet-2020',  'service_interval', NULL,             40000::numeric, 'km',     20, 'Brake fluid'),
    ('hijet-2020',  'service_interval', NULL,             40000::numeric, 'km',     30, 'Transmission fluid'),
    ('hijet-2020',  'service_interval', NULL,             40000::numeric, 'km',     40, 'Coolant'),
    ('hijet-2020',  'service_interval', NULL,             40000::numeric, 'km',     50, 'Fuel filter'),
    ('hijet-2020',  'service_interval', NULL,             40000::numeric, 'km',     60, '4x4 transfer case oil'),
    ('hijet-2020',  'service_interval', NULL,             60000::numeric, 'km',     10, 'Timing belt'),

    -- gyro-trac
    ('gyro-trac',   'service_interval', NULL,             250::numeric,   'hours',  10, 'Engine oil sample kit'),
    ('gyro-trac',   'service_interval', NULL,             250::numeric,   'hours',  20, 'Engine oil'),
    ('gyro-trac',   'service_interval', NULL,             250::numeric,   'hours',  30, 'Engine oil filter'),
    ('gyro-trac',   'service_interval', NULL,             250::numeric,   'hours',  40, 'Air cleaner filters'),
    ('gyro-trac',   'service_interval', NULL,             250::numeric,   'hours',  50, 'Hydraulic spin-on filter'),
    ('gyro-trac',   'service_interval', NULL,             250::numeric,   'hours',  60, 'Fuel filter'),
    ('gyro-trac',   'service_interval', NULL,             250::numeric,   'hours',  70, 'Fuel/water separator'),
    ('gyro-trac',   'service_interval', NULL,             250::numeric,   'hours',  80, 'Battery terminal cleaner/protectant'),
    ('gyro-trac',   'service_interval', NULL,             500::numeric,   'hours',  10, 'Planetary oil'),

    -- toro
    ('toro',        'service_interval', NULL,             10::numeric,    'hours',  10, 'Grease'),
    ('toro',        'service_interval', NULL,             25::numeric,    'hours',  10, 'Soap'),
    ('toro',        'service_interval', NULL,             25::numeric,    'hours',  20, 'Foam air filter oil'),
    ('toro',        'service_interval', NULL,             100::numeric,   'hours',  10, 'Engine oil'),
    ('toro',        'service_interval', NULL,             100::numeric,   'hours',  20, 'Engine oil filter'),
    ('toro',        'service_interval', NULL,             100::numeric,   'hours',  30, 'Spark plugs'),
    ('toro',        'service_interval', NULL,             100::numeric,   'hours',  40, 'Pleated air filter'),
    ('toro',        'service_interval', NULL,             100::numeric,   'hours',  50, 'Foam air filter'),
    ('toro',        'service_interval', NULL,             100::numeric,   'hours',  60, 'Fuel filter'),
    ('toro',        'service_interval', NULL,             100::numeric,   'hours',  70, 'Battery terminal cleaner/protectant'),
    ('toro',        'service_interval', NULL,             500::numeric,   'hours',  10, 'Hydraulic oil'),
    ('toro',        'service_interval', NULL,             500::numeric,   'hours',  20, 'Hydraulic filters (2)'),

    -- c362
    ('c362',        'service_interval', NULL,             250::numeric,   'hours',  10, 'Engine oil sample kit'),
    ('c362',        'service_interval', NULL,             250::numeric,   'hours',  20, 'Air cleaner filters'),
    ('c362',        'service_interval', NULL,             250::numeric,   'hours',  30, 'Battery terminal cleaner/protectant'),
    ('c362',        'service_interval', NULL,             500::numeric,   'hours',  10, 'Engine oil'),
    ('c362',        'service_interval', NULL,             500::numeric,   'hours',  20, 'Engine oil filter'),
    ('c362',        'service_interval', NULL,             500::numeric,   'hours',  30, 'Fuel/water separator filter'),
    ('c362',        'service_interval', NULL,             500::numeric,   'hours',  40, 'Fuel filter'),
    ('c362',        'service_interval', NULL,             500::numeric,   'hours',  50, 'Hydraulic implement primary filter'),
    ('c362',        'service_interval', NULL,             500::numeric,   'hours',  60, 'Hydraulic tank breather filter'),
    ('c362',        'service_interval', NULL,             500::numeric,   'hours',  70, 'Outer air cleaner filter'),
    ('c362',        'service_interval', NULL,             500::numeric,   'hours',  80, 'Inner air cleaner filter'),
    ('c362',        'service_interval', NULL,             500::numeric,   'hours',  90, 'Final drive oil'),
    ('c362',        'service_interval', NULL,             500::numeric,   'hours', 100, 'Cab air filter'),
    ('c362',        'service_interval', NULL,             500::numeric,   'hours', 110, 'DEF breather filter'),
    ('c362',        'service_interval', NULL,             500::numeric,   'hours', 120, 'Grease'),
    ('c362',        'service_interval', NULL,             500::numeric,   'hours', 130, 'Hydraulic oil sample kit'),
    ('c362',        'service_interval', NULL,             500::numeric,   'hours', 140, 'Coolant sample kit'),
    ('c362',        'service_interval', NULL,             1000::numeric,  'hours',  10, 'Hydraulic oil'),
    ('c362',        'service_interval', NULL,             1000::numeric,  'hours',  20, 'Charge/secondary filter'),
    ('c362',        'service_interval', NULL,             1500::numeric,  'hours',  10, 'Blow-by recirculation system filter'),
    ('c362',        'service_interval', NULL,             3600::numeric,  'hours',  10, 'SCR system supply module filter'),
    ('c362',        'service_interval', NULL,             4000::numeric,  'hours',  10, 'Coolant'),

    -- ps100
    ('ps100',       'service_interval', NULL,             50::numeric,    'hours',  10, 'Grease'),
    ('ps100',       'service_interval', NULL,             50::numeric,    'hours',  20, 'Lubricant'),
    ('ps100',       'service_interval', NULL,             100::numeric,   'hours',  10, 'Cab air filter'),
    ('ps100',       'service_interval', NULL,             100::numeric,   'hours',  20, 'Cab recirculation filters'),
    ('ps100',       'service_interval', NULL,             300::numeric,   'hours',  10, 'Lift oil / large hydraulic filter'),
    ('ps100',       'service_interval', NULL,             300::numeric,   'hours',  20, 'Transmission oil filter cartridge'),
    ('ps100',       'service_interval', NULL,             300::numeric,   'hours',  30, 'Battery terminal cleaner/protectant'),
    ('ps100',       'service_interval', NULL,             300::numeric,   'hours',  40, 'Grease'),
    ('ps100',       'service_interval', NULL,             600::numeric,   'hours',  10, 'Engine oil'),
    ('ps100',       'service_interval', NULL,             600::numeric,   'hours',  20, 'Engine oil filter'),
    ('ps100',       'service_interval', NULL,             600::numeric,   'hours',  30, 'Fuel filters'),
    ('ps100',       'service_interval', NULL,             600::numeric,   'hours',  40, 'DEF filter'),
    ('ps100',       'service_interval', NULL,             600::numeric,   'hours',  50, 'Grease'),
    ('ps100',       'service_interval', NULL,             1200::numeric,  'hours',  10, 'Cab air filter'),
    ('ps100',       'service_interval', NULL,             1200::numeric,  'hours',  20, 'Cab recirculation filter'),
    ('ps100',       'service_interval', NULL,             1200::numeric,  'hours',  30, 'Air cleaner'),
    ('ps100',       'service_interval', NULL,             1200::numeric,  'hours',  40, 'Crankcase ventilation system'),
    ('ps100',       'service_interval', NULL,             1200::numeric,  'hours',  50, 'New Holland 73344274 hydraulic oil'),
    ('ps100',       'service_interval', NULL,             1200::numeric,  'hours',  60, 'Gear oil'),
    ('ps100',       'service_interval', NULL,             1200::numeric,  'hours',  70, 'Transmission fluid'),
    ('ps100',       'service_interval', NULL,             1200::numeric,  'hours',  80, 'Alternator belt'),
    ('ps100',       'service_interval', NULL,             1200::numeric,  'hours',  90, 'AC compressor belt'),
    ('ps100',       'service_interval', NULL,             1200::numeric,  'hours', 100, 'AC drier filter'),

    -- honda-atv-1
    ('honda-atv-1', 'service_interval', NULL,             200::numeric,   'hours',  10, 'Engine oil'),
    ('honda-atv-1', 'service_interval', NULL,             200::numeric,   'hours',  20, 'Engine oil filter'),
    ('honda-atv-1', 'service_interval', NULL,             200::numeric,   'hours',  30, 'Spark plug'),
    ('honda-atv-1', 'service_interval', NULL,             200::numeric,   'hours',  40, 'Battery terminal cleaner/protectant'),
    ('honda-atv-1', 'service_interval', NULL,             500::numeric,   'hours',  10, 'Front final gear oil'),
    ('honda-atv-1', 'service_interval', NULL,             500::numeric,   'hours',  20, 'Rear final gear oil'),

    -- honda-atv-2
    ('honda-atv-2', 'service_interval', NULL,             200::numeric,   'hours',  10, 'Engine oil (4 qt)'),
    ('honda-atv-2', 'service_interval', NULL,             200::numeric,   'hours',  20, 'Engine oil filter'),
    ('honda-atv-2', 'service_interval', NULL,             200::numeric,   'hours',  30, 'Spark plug'),
    ('honda-atv-2', 'service_interval', NULL,             200::numeric,   'hours',  40, 'Battery terminal cleaner/protectant'),
    ('honda-atv-2', 'service_interval', NULL,             500::numeric,   'hours',  10, 'Front final gear oil'),
    ('honda-atv-2', 'service_interval', NULL,             500::numeric,   'hours',  20, 'Rear final gear oil'),

    -- honda-atv-3
    ('honda-atv-3', 'service_interval', NULL,             200::numeric,   'hours',  10, 'Engine oil (4 qt)'),
    ('honda-atv-3', 'service_interval', NULL,             200::numeric,   'hours',  20, 'Engine oil filter'),
    ('honda-atv-3', 'service_interval', NULL,             200::numeric,   'hours',  30, 'Spark plug'),
    ('honda-atv-3', 'service_interval', NULL,             200::numeric,   'hours',  40, 'Battery terminal cleaner/protectant'),
    ('honda-atv-3', 'service_interval', NULL,             500::numeric,   'hours',  10, 'Front final gear oil'),
    ('honda-atv-3', 'service_interval', NULL,             500::numeric,   'hours',  20, 'Rear final gear oil'),

    -- honda-atv-4
    ('honda-atv-4', 'service_interval', NULL,             200::numeric,   'hours',  10, 'Engine oil (4 qt)'),
    ('honda-atv-4', 'service_interval', NULL,             200::numeric,   'hours',  20, 'Engine oil filter'),
    ('honda-atv-4', 'service_interval', NULL,             200::numeric,   'hours',  30, 'Spark plug'),
    ('honda-atv-4', 'service_interval', NULL,             200::numeric,   'hours',  40, 'Battery terminal cleaner/protectant'),
    ('honda-atv-4', 'service_interval', NULL,             500::numeric,   'hours',  10, 'Front final gear oil'),
    ('honda-atv-4', 'service_interval', NULL,             500::numeric,   'hours',  20, 'Rear final gear oil'),

    -- gehl
    ('gehl',        'service_interval', NULL,             250::numeric,   'hours',  10, 'Battery terminal cleaner/protectant'),
    ('gehl',        'service_interval', NULL,             250::numeric,   'hours',  20, 'Lubricant'),
    ('gehl',        'service_interval', NULL,             250::numeric,   'hours',  30, 'Primary air filter'),
    ('gehl',        'service_interval', NULL,             500::numeric,   'hours',  10, 'Engine oil'),
    ('gehl',        'service_interval', NULL,             500::numeric,   'hours',  20, 'Engine oil filter'),
    ('gehl',        'service_interval', NULL,             500::numeric,   'hours',  30, 'Secondary air cleaner filter'),
    ('gehl',        'service_interval', NULL,             500::numeric,   'hours',  40, 'Fuel/water separator'),
    ('gehl',        'service_interval', NULL,             500::numeric,   'hours',  50, 'Main fuel filter'),
    ('gehl',        'service_interval', NULL,             500::numeric,   'hours',  60, 'Hydraulic filter'),
    ('gehl',        'service_interval', NULL,             500::numeric,   'hours',  70, 'Coolant sample kit'),
    ('gehl',        'service_interval', NULL,             500::numeric,   'hours',  80, 'Diesel sample kit'),
    ('gehl',        'service_interval', NULL,             500::numeric,   'hours',  90, 'Hydraulic oil sample kit'),
    ('gehl',        'service_interval', NULL,             500::numeric,   'hours', 100, 'Engine oil sample kit'),
    ('gehl',        'service_interval', NULL,             1000::numeric,  'hours',  10, 'Hydraulic oil'),
    ('gehl',        'service_interval', NULL,             1000::numeric,  'hours',  20, 'Hydraulic filter'),
    ('gehl',        'service_interval', NULL,             1000::numeric,  'hours',  30, 'Final drive oil'),
    ('gehl',        'service_interval', NULL,             6000::numeric,  'hours',  10, 'Coolant'),

    -- ventrac (service_intervals)
    ('ventrac',     'service_interval', NULL,             50::numeric,    'hours',  10, 'Grease'),
    ('ventrac',     'service_interval', NULL,             50::numeric,    'hours',  20, 'Lubricant'),
    ('ventrac',     'service_interval', NULL,             100::numeric,   'hours',  10, 'Engine oil'),
    ('ventrac',     'service_interval', NULL,             100::numeric,   'hours',  20, 'Engine oil filter'),
    ('ventrac',     'service_interval', NULL,             100::numeric,   'hours',  30, 'Spark plugs'),
    ('ventrac',     'service_interval', NULL,             100::numeric,   'hours',  40, 'Primary air filter'),
    ('ventrac',     'service_interval', NULL,             500::numeric,   'hours',  10, 'Fuel filter'),
    ('ventrac',     'service_interval', NULL,             500::numeric,   'hours',  20, 'Battery terminal cleaner/protectant'),
    ('ventrac',     'service_interval', NULL,             500::numeric,   'hours',  30, 'Safety air filter'),
    ('ventrac',     'service_interval', NULL,             500::numeric,   'hours',  40, 'Hydraulic return filter (initial 500 only)'),
    ('ventrac',     'service_interval', NULL,             500::numeric,   'hours',  50, 'Hydraulic suction filter (initial 500 only)'),
    ('ventrac',     'service_interval', NULL,             500::numeric,   'hours',  60, 'Hydraulic oil (initial 500 only)'),
    ('ventrac',     'service_interval', NULL,             500::numeric,   'hours',  70, 'Rear transaxle oil (initial 500 only)'),
    ('ventrac',     'service_interval', NULL,             1000::numeric,  'hours',  10, 'Hydraulic suction filter'),
    ('ventrac',     'service_interval', NULL,             1000::numeric,  'hours',  20, 'Hydraulic return filter'),
    ('ventrac',     'service_interval', NULL,             1000::numeric,  'hours',  30, 'Hydraulic oil'),
    ('ventrac',     'service_interval', NULL,             1000::numeric,  'hours',  40, 'Rear transaxle oil'),
    ('ventrac',     'service_interval', NULL,             1000::numeric,  'hours',  50, 'Coolant'),

    -- ventrac (attachment_checklists)
    ('ventrac',     'attachment_checklist', 'AERO-Vator',     NULL,           'use',    10, 'Blaster Multi-Max spray'),
    ('ventrac',     'attachment_checklist', 'AERO-Vator',     50::numeric,    'hours',  10, 'Grease'),
    ('ventrac',     'attachment_checklist', 'AERO-Vator',     50::numeric,    'hours',  20, 'Tri-Flow spray'),
    ('ventrac',     'attachment_checklist', 'AERO-Vator',     50::numeric,    'hours',  30, '80/90 gear oil'),
    ('ventrac',     'attachment_checklist', 'AERO-Vator',     50::numeric,    'hours',  40, 'Fluid extractor'),
    ('ventrac',     'attachment_checklist', 'AERO-Vator',     500::numeric,   'hours',  10, 'Gearbox oil'),
    ('ventrac',     'attachment_checklist', 'AERO-Vator',     500::numeric,   'hours',  20, 'Fluid extractor'),
    ('ventrac',     'attachment_checklist', 'Landscape Rake', 50::numeric,    'hours',  10, 'Grease'),
    ('ventrac',     'attachment_checklist', 'Tough Cut',      50::numeric,    'hours',  10, 'Grease'),

    -- l328
    ('l328',        'service_interval', NULL,             250::numeric,   'hours',  10, 'Engine oil sample kit'),
    ('l328',        'service_interval', NULL,             250::numeric,   'hours',  20, 'Primary engine air filter'),
    ('l328',        'service_interval', NULL,             250::numeric,   'hours',  30, 'Secondary engine air filter'),
    ('l328',        'service_interval', NULL,             250::numeric,   'hours',  40, 'Battery terminal cleaner/protectant'),
    ('l328',        'service_interval', NULL,             500::numeric,   'hours',  10, 'Engine oil'),
    ('l328',        'service_interval', NULL,             500::numeric,   'hours',  20, 'Engine oil filter'),
    ('l328',        'service_interval', NULL,             500::numeric,   'hours',  30, 'Fuel/water separator filter element'),
    ('l328',        'service_interval', NULL,             500::numeric,   'hours',  40, 'Fuel filter'),
    ('l328',        'service_interval', NULL,             500::numeric,   'hours',  50, 'Hydraulic oil filter (filter only)'),
    ('l328',        'service_interval', NULL,             500::numeric,   'hours',  60, 'Cab air filter'),
    ('l328',        'service_interval', NULL,             500::numeric,   'hours',  70, 'Grease'),
    ('l328',        'service_interval', NULL,             500::numeric,   'hours',  80, 'Hydraulic oil sample kit'),
    ('l328',        'service_interval', NULL,             500::numeric,   'hours',  90, 'Coolant sample kit'),
    ('l328',        'service_interval', NULL,             1000::numeric,  'hours',  10, 'Hydraulic oil'),
    ('l328',        'service_interval', NULL,             1000::numeric,  'hours',  20, 'Hydraulic filter'),
    ('l328',        'service_interval', NULL,             4000::numeric,  'hours',  10, 'Coolant')
)
INSERT INTO public.equipment_service_materials (
  id,
  equipment_id,
  source_kind,
  service_label,
  attachment_name,
  interval_value,
  interval_unit,
  material_name,
  active,
  sort_order,
  auto_seeded
)
SELECT
  -- Deterministic id: 'esm-' + md5(structural identity). Re-runs produce the
  -- same id, so admin foreign-key references (clears, future cross-tables)
  -- stay stable across re-applies.
  'esm-' || substr(
    md5(
      e.id || '|' || s.source_kind || '|' || s.interval_unit
        || '|' || coalesce(s.interval_value::text, '')
        || '|' || coalesce(s.attachment_name, '')
        || '|' || s.material_name
    ),
    1, 24
  ),
  e.id,
  s.source_kind,
  -- Display label (Codex amendment 3: not part of identity).
  CASE
    WHEN s.interval_unit = 'use' THEN
      coalesce(s.attachment_name || ' Every Use', 'Every Use')
    WHEN s.attachment_name IS NOT NULL THEN
      s.attachment_name || ' ' || s.interval_value::text
        || (CASE WHEN s.interval_unit = 'km' THEN 'km' ELSE 'h' END)
    ELSE
      s.interval_value::text || (CASE WHEN s.interval_unit = 'km' THEN 'km' ELSE 'h' END)
  END,
  s.attachment_name,
  s.interval_value,
  s.interval_unit,
  s.material_name,
  true,                  -- active
  s.sort_order,
  true                   -- auto_seeded
FROM seed s
JOIN public.equipment e ON e.slug = s.slug
ON CONFLICT (equipment_id, source_kind, interval_unit, interval_value, attachment_name, material_name) DO NOTHING;

COMMIT;
