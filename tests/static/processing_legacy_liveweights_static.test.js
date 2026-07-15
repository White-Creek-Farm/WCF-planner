import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static guards for hotfix migration 178 — two server repairs:
//   1. PARSER — mig 176's pig legacy fallback split liveWeights on single
//      spaces and cast every nonblank token straight to numeric, so a valid
//      stored "315, 305, 280" produced token "315," and crashed the whole
//      record read RPC. Mig 178's _processing_animal_detail reissue splits on
//      the canonical client delimiter contract [\s,]+ (parseLiveWeights,
//      src/lib/pig.js), keeps only strictly-numeric positive tokens in source
//      order, and CASE-guards the cast so invalid tokens can never reach
//      ::numeric regardless of planner predicate order. Linked weigh-ins stay
//      authoritative; cattle/sheep branches are byte-identical to 176.
//   2. CANONICAL TITLE — processing_records.title is a stored snapshot that
//      goes stale between a source rename and the next reconcile.
//      _processing_current_title is the ONE display-title contract
//      (milestone/historical/dormant -> stored title; planner-backed rows ->
//      current source name, pig as 'Pig Trip · <name> · Trip <ordinal>';
//      missing/blank source -> stored title), reused by
//      list_processing_records, get_processing_record,
//      list_my_processing_subtasks, and _processing_notify_assignment.
//      The stored-title update inside planner reconciliation is untouched.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mig175 = read('supabase-migrations/175_processing_planner_foundation.sql');
const mig176 = read('supabase-migrations/176_processing_lifecycle_reconcile.sql');
const mig177 = read('supabase-migrations/177_processing_workflow_integration.sql');
const mig178 = read('supabase-migrations/178_processing_legacy_liveweights.sql');
const pigLib = read('src/lib/pig.js');
const drawer = read('src/processing/ProcessingDrawer.jsx');

// Extract one CREATE OR REPLACE FUNCTION body (same $fn$ convention as the
// other processing migrations).
function fnBody(sql, name) {
  const re = new RegExp('CREATE OR REPLACE FUNCTION public\\.' + name + '\\b[\\s\\S]*?\\$fn\\$;');
  const m = sql.match(re);
  return m ? m[0] : '';
}

const detail176 = fnBody(mig176, '_processing_animal_detail');
const detail178 = fnBody(mig178, '_processing_animal_detail');
const title178 = fnBody(mig178, '_processing_current_title');
const list178 = fnBody(mig178, 'list_processing_records');
const get178 = fnBody(mig178, 'get_processing_record');
const myTasks178 = fnBody(mig178, 'list_my_processing_subtasks');
const notify178 = fnBody(mig178, '_processing_notify_assignment');

// The cattle/sheep section: everything from the cattle branch up to the pig
// branch. The hotfix must not touch it.
function cattleSheepSlice(body) {
  const start = body.indexOf("IF p_rec.source_kind = 'cattle' THEN");
  const end = body.indexOf("IF p_rec.source_kind = 'pig'");
  return start >= 0 && end > start ? body.slice(start, end) : '';
}

describe('mig 178 — scope: exactly the parser repair + the canonical-title consumers', () => {
  it('reissues exactly the six intended functions and nothing else', () => {
    const created = (mig178.match(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)/g) || []).map((s) =>
      s.replace('CREATE OR REPLACE FUNCTION public.', ''),
    );
    expect(created).toEqual([
      '_processing_animal_detail',
      '_processing_current_title',
      'list_processing_records',
      'get_processing_record',
      'list_my_processing_subtasks',
      '_processing_notify_assignment',
    ]);
  });

  it('adds no tables, policies, or drops (function-only forward migration)', () => {
    expect(mig178).not.toMatch(/CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+POLICY|DROP\s+/i);
  });

  it('keeps every private helper revoked from PUBLIC, anon, and authenticated', () => {
    expect(mig178).toContain(
      'REVOKE ALL ON FUNCTION public._processing_animal_detail(public.processing_records) FROM PUBLIC, anon, authenticated;',
    );
    expect(mig178).toContain(
      'REVOKE ALL ON FUNCTION public._processing_current_title(public.processing_records, jsonb) FROM PUBLIC, anon, authenticated;',
    );
    expect(mig178).toContain(
      'REVOKE ALL ON FUNCTION public._processing_notify_assignment(text, text, uuid, text) FROM PUBLIC, anon, authenticated;',
    );
  });

  it('keeps the exposed RPC grants exactly as before (authenticated only, anon revoked)', () => {
    expect(mig178).toContain(
      'REVOKE ALL ON FUNCTION public.list_processing_records(int, text, boolean) FROM PUBLIC, anon;',
    );
    expect(mig178).toContain(
      'GRANT EXECUTE ON FUNCTION public.list_processing_records(int, text, boolean) TO authenticated;',
    );
    expect(mig178).toContain('REVOKE ALL ON FUNCTION public.get_processing_record(text) FROM PUBLIC, anon;');
    expect(mig178).toContain('GRANT EXECUTE ON FUNCTION public.get_processing_record(text) TO authenticated;');
    expect(mig178).toContain('REVOKE ALL ON FUNCTION public.list_my_processing_subtasks() FROM PUBLIC, anon;');
    expect(mig178).toContain('GRANT EXECUTE ON FUNCTION public.list_my_processing_subtasks() TO authenticated;');
  });

  it('notifies PostgREST (reissued exposed RPCs)', () => {
    expect(mig178).toContain("NOTIFY pgrst, 'reload schema';");
  });

  it('does not touch the reconcile/upsert stored-title update path (reconcile still refreshes stored titles)', () => {
    expect(mig178).not.toContain('upsert_processing_from_planner');
    expect(mig178).not.toContain('reconcile_planner_to_processing');
    // The 176 reconcile keeps passing live source names as stored titles.
    expect(mig176).toContain("'title', COALESCE(v_c.name, v_c.id)");
    expect(mig176).toContain("'title', COALESCE(v_s.name, v_s.id)");
  });
});

describe('mig 178 — pig legacy liveWeights parse matches the client contract', () => {
  it('splits on commas AND all whitespace ([\\s,]+), not single spaces', () => {
    expect(detail178).toContain("regexp_split_to_array(COALESCE(v_t->>'liveWeights', ''), '[\\s,]+')");
    // The 176 single-space split of the legacy string is gone.
    expect(detail178).not.toContain("string_to_array(COALESCE(v_t->>'liveWeights', ''), ' ')");
  });

  it('CASE-guards the numeric cast behind strict validation (no direct cast of free-form tokens)', () => {
    expect(detail178).toContain("CASE WHEN x.wt ~ '^\\d+(\\.\\d+)?$' THEN x.wt::numeric END");
    // The crashing 176 pattern must be absent from the pig fallback.
    expect(detail178).not.toContain("NULLIF(btrim(wt), '')::numeric");
  });

  it('keeps only positive weights (zero/negative/malformed tokens are excluded)', () => {
    expect(detail178).toMatch(/WHERE t\.w > 0/);
  });

  it('preserves source order via split ordinality', () => {
    expect(detail178).toMatch(/WITH ORDINALITY AS x\(wt, ord\)/);
    expect(detail178).toMatch(/ORDER BY t\.ord/);
  });

  it('returns [] when nothing valid remains (record still loads, UI shows its empty state)', () => {
    expect(detail178).toContain("IF v_t IS NULL THEN RETURN '[]'::jsonb; END IF;");
    expect(detail178).toMatch(/COALESCE\(jsonb_agg\(jsonb_build_object\(\s*'weigh_in_id', NULL,/);
  });

  it('linked weigh-ins remain authoritative: legacy fallback only when zero linked entries', () => {
    const weighIns = detail178.indexOf('w.sent_to_trip_id = split_part(p_rec.source_id');
    const guard = detail178.indexOf('IF jsonb_array_length(v_out) > 0 THEN RETURN v_out; END IF;');
    const fallback = detail178.indexOf("regexp_split_to_array(COALESCE(v_t->>'liveWeights'");
    expect(weighIns).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(weighIns);
    expect(fallback).toBeGreaterThan(guard);
  });

  it('cattle/sheep branches are byte-identical to the effective migration-176 definitions', () => {
    const before = cattleSheepSlice(detail176);
    const after = cattleSheepSlice(detail178);
    expect(before.length).toBeGreaterThan(0);
    expect(after).toBe(before);
  });
});

describe('mig 178 — canonical current display title contract', () => {
  it('is SECURITY DEFINER, pinned search_path, STABLE, and reuses _processing_source_projection', () => {
    expect(title178).toContain('LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE');
    expect(title178).toContain('COALESCE(p_projection, public._processing_source_projection(p_rec))');
    // No second implementation of the four source lookups.
    expect(title178).not.toContain('app_store');
    expect(title178).not.toContain('cattle_processing_batches');
    expect(title178).not.toContain('sheep_processing_batches');
  });

  it('milestones, historical/import rows, and dormant rows keep the stored title', () => {
    expect(title178).toMatch(
      /IF p_rec\.record_type <> 'planner_batch'\s*\n\s*OR p_rec\.source_kind IS NULL OR p_rec\.source_id IS NULL\s*\n\s*OR p_rec\.archived OR p_rec\.source_removed_at IS NOT NULL THEN\s*\n\s*RETURN p_rec\.title;/,
    );
  });

  it('missing/unmatched source and blank source name fall back to the stored title', () => {
    expect(title178).toMatch(
      /COALESCE\(\(v_proj->>'matched'\)::boolean, false\) = false THEN\s*\n\s*RETURN p_rec\.title;/,
    );
    expect(title178).toContain("NULLIF(btrim(COALESCE(v_proj->>'batch_name', '')), '')");
    expect(title178).toMatch(/IF v_name IS NULL THEN\s*\n\s*RETURN p_rec\.title;/);
  });

  it("pig planner rows render 'Pig Trip · <current name> · Trip <stable ordinal>' (reconcile's convention)", () => {
    expect(title178).toContain("RETURN 'Pig Trip · ' || v_name || ' · Trip ' || COALESCE(p_rec.trip_ordinal, 0);");
    // The stored-title writer in 176 uses the same shape — one convention.
    expect(mig176).toContain(
      "v_title := 'Pig Trip · ' || btrim(p_row->>'pig_batch_name') || ' · Trip ' || COALESCE(v_old.trip_ordinal, 0);",
    );
  });

  it('broiler/cattle/sheep planner rows return the current source batch name', () => {
    expect(title178).toMatch(/RETURN v_name;\s*\nEND/);
  });
});

describe('mig 178 — every stale-title consumer now reads the canonical title', () => {
  it('list_processing_records returns the canonical title, reusing the already-computed projection', () => {
    expect(list178).toContain("'title', public._processing_current_title(r, src.projection),");
    // The stored title is no longer the returned title field...
    expect(list178).not.toContain("'title', r.title,");
    // ...but search still covers stored title + live batch name (unchanged).
    expect(list178).toMatch(/'search_text', lower\(concat_ws\(' ',\s*\n\s*r\.title, r\.processor,/);
    expect(list178).toContain("src.projection->>'batch_name'");
    // Projection still computed once per row in the lateral.
    expect(list178).toContain('SELECT public._processing_source_projection(r) AS projection');
  });

  it('get_processing_record overrides record.title with the canonical title, projection computed once', () => {
    expect(get178).toContain('v_src := public._processing_source_projection(v_row);');
    expect(get178).toContain("'title', public._processing_current_title(v_row, v_src),");
    expect(get178).toContain("'source', v_src,");
    // Only ONE projection evaluation in the whole body.
    expect(get178.match(/_processing_source_projection/g)).toHaveLength(1);
    // Shape, gate, and fail-closed behavior unchanged.
    expect(get178).toContain('PERFORM public._processing_require_operational();');
    expect(get178).toContain("'animals', public._processing_animal_detail(v_row));");
    expect(get178).toContain("jsonb_build_object('record', v_rec, 'subtasks', v_subs, 'attachments', v_atts,");
    expect(get178).toContain("'completion_blockers', to_jsonb(v_blockers));");
  });

  it('list_my_processing_subtasks returns AND sorts by the canonical title (computed once per row)', () => {
    expect(myTasks178).toContain("'record_title',    ct.title,");
    expect(myTasks178).toContain('ORDER BY r.processing_date ASC NULLS LAST, ct.title ASC, s.sort_order ASC');
    expect(myTasks178).toContain('SELECT public._processing_current_title(r) AS title');
    expect(myTasks178).not.toContain("'record_title',    r.title,");
  });

  it('_processing_notify_assignment embeds the canonical current title in new notifications', () => {
    expect(notify178).toContain('SELECT public._processing_current_title(r) INTO v_title');
    expect(notify178).not.toMatch(/SELECT title INTO v_title FROM public\.processing_records/);
    // Idempotence/suppression/best-effort behavior unchanged from 177.
    expect(notify178).toContain('IF p_recipient IS NULL OR p_recipient = v_actor THEN RETURN; END IF;');
    expect(notify178).toContain('processing assignment notification failed');
  });

  it('the pre-178 stale-title reads exist only in the superseded 175/177 definitions', () => {
    // Anchor the defect this repairs: 175/177 read stored title directly.
    expect(fnBody(mig175, 'list_my_processing_subtasks')).toContain("'record_title',    r.title,");
    expect(fnBody(mig177, '_processing_notify_assignment')).toMatch(
      /SELECT title INTO v_title FROM public\.processing_records/,
    );
  });
});

describe('client contract anchors', () => {
  it('src/lib/pig.js parseLiveWeights is still the mirrored parser source of truth', () => {
    expect(pigLib).toContain('.split(/[\\s,]+/)');
    expect(pigLib).toMatch(/filter\(\(v\) => !isNaN\(v\) && v > 0\)/);
  });

  it('the drawer header renders record.title, which get_processing_record now guarantees is canonical', () => {
    // Planner-backed drawer titles therefore cannot regress to stale stored
    // values: the server overrides title at read time and the drawer renders
    // that field directly (no client-side stale-title derivation).
    expect(drawer).toMatch(/<h2[^>]*>\{record\.title\}<\/h2>/);
  });
});
