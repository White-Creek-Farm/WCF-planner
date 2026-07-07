import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static guards for migration 157 (Processing reconciler + Asana link table).
// Source-text assertions — locks the frozen source-of-truth contract so a
// refactor can't silently drop it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const mig = fs.readFileSync(path.join(ROOT, 'supabase-migrations/157_processing_reconciler.sql'), 'utf8');

// Extract a single function body for scoped assertions.
function fnBody(name) {
  const re = new RegExp('CREATE OR REPLACE FUNCTION public\\.' + name + '\\b[\\s\\S]*?\\$fn\\$;');
  const m = mig.match(re);
  return m ? m[0] : '';
}

describe('mig 157 — processing_asana_links (many-Asana -> one-Processing)', () => {
  it('creates the link table with deny-all RLS + asana_gid UNIQUE + FK SET NULL', () => {
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS public\.processing_asana_links/);
    expect(mig).toMatch(/asana_gid\s+text NOT NULL UNIQUE/);
    expect(mig).toMatch(/processing_record_id\s+text REFERENCES public\.processing_records\(id\) ON DELETE SET NULL/);
    expect(mig).toMatch(/REVOKE ALL ON TABLE public\.processing_asana_links FROM PUBLIC, anon, authenticated/);
    expect(mig).toMatch(/CREATE POLICY processing_asana_links_deny_all[\s\S]*?USING \(false\)/);
  });
  it('does NOT put a UNIQUE on processing_record_id (many links may share one record)', () => {
    expect(mig).not.toMatch(/processing_record_id[^\n]*UNIQUE/);
  });
  it('carries per-link drift + acknowledge + crosswalk candidates', () => {
    for (const col of ['drift', 'drift_acknowledged_by', 'candidate_record_ids', 'match_status', 'match_method']) {
      expect(mig, `link col ${col}`).toContain(col);
    }
  });
});

describe('mig 157 — anti-duplicate + schema deltas', () => {
  it('one Processing row per Planner batch/event: partial UNIQUE(source_kind, source_id)', () => {
    expect(mig).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS processing_records_source_uniq[\s\S]*?\(source_kind, source_id\)[\s\S]*?WHERE source_id IS NOT NULL/,
    );
  });
  it('adds sub_batch_attribution (pig) + subtask local-ownership + comment import columns', () => {
    expect(mig).toContain('sub_batch_attribution');
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS done_locally_set\s+boolean/);
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS source\s+text/);
    for (const c of ['is_imported', 'original_author_name', 'asana_comment_gid']) expect(mig).toContain(c);
    expect(mig).toMatch(/comments_asana_comment_gid_key[\s\S]*?WHERE asana_comment_gid IS NOT NULL/);
  });
});

describe('mig 157 — Asana never mints planner_batch; live facts protected', () => {
  it('upsert_processing_from_asana refuses record_type=planner_batch and writes no source link', () => {
    const b = fnBody('upsert_processing_from_asana');
    expect(b).toMatch(/v_type = 'planner_batch'[\s\S]*?RAISE EXCEPTION/);
    // Asana-only rows carry no Planner source link on insert.
    expect(b).toMatch(/NULL, NULL,\s*--[^\n]*Planner source link/);
  });
  it('subtask importer gates done on done_locally_set (Asana cannot revert a local check-off)', () => {
    const b = fnBody('upsert_processing_subtask_from_asana');
    expect(b).toMatch(/done\s*=\s*CASE WHEN done_locally_set THEN done\s*ELSE COALESCE/);
    // parent resolved via the LINK, not processing_records.asana_gid
    expect(b).toMatch(/FROM public\.processing_asana_links[\s\S]*?asana_gid = p_row->>'parent_asana_gid'/);
  });
  it('local check-off marks done_locally_set + emits processing.record Activity', () => {
    const b = fnBody('set_processing_subtask_done');
    expect(b).toContain('done_locally_set = true');
    expect(b).toMatch(/INSERT INTO public\.activity_events[\s\S]*?'processing\.record'/);
  });
});

describe('mig 157 — comments layer (imported authorship)', () => {
  it('list_comments prefers the imported author name + returns source/is_imported', () => {
    const b = fnBody('list_comments');
    expect(b).toMatch(/COALESCE\(c\.original_author_name, p\.full_name/);
    expect(b).toMatch(/c\.source,/);
    expect(b).toMatch(/c\.is_imported,/);
  });
  it('delete_comment blocks imported (Asana-sourced) rows', () => {
    const b = fnBody('delete_comment');
    expect(b).toMatch(/v_row\.source <> 'native'[\s\S]*?RAISE EXCEPTION/);
  });
  it('record_processing_comment resolves parent via the link + is idempotent on gid', () => {
    const b = fnBody('record_processing_comment');
    expect(b).toMatch(/FROM public\.processing_asana_links[\s\S]*?parent_asana_gid/);
    expect(b).toMatch(/asana_comment_gid = v_gid[\s\S]*?already imported/);
  });
});

describe('mig 157 — link seed-on-first-attach + planner enumeration', () => {
  it('link_asana_to_processing seeds processor/customer only on the FIRST attach of the effective record', () => {
    const b = fnBody('link_asana_to_processing');
    expect(b).toMatch(
      /NOT EXISTS \(SELECT 1 FROM public\.processing_asana_links\s*WHERE processing_record_id = v_eff_rec AND asana_gid <> v_gid\)/,
    );
    expect(b).toContain('v_first');
    expect(b).toContain('seed_processor');
  });
  it('upsert_processing_from_planner upserts by (source_kind, source_id) as planner_batch', () => {
    const b = fnBody('upsert_processing_from_planner');
    expect(b).toMatch(/WHERE source_kind = v_kind AND source_id = v_sid/);
    expect(b).toMatch(/'planner_batch'/);
  });
  it('reconcile enumerates all four programs under an advisory lock, pig per trip', () => {
    const b = fnBody('reconcile_planner_to_processing');
    expect(b).toMatch(/pg_advisory_xact_lock\(hashtext\('processing_reconcile'\)\)/);
    expect(b).toContain('cattle_processing_batches');
    expect(b).toContain('sheep_processing_batches');
    expect(b).toContain("key = 'ppp-v4'");
    expect(b).toContain("key = 'ppp-feeders-v1'");
    // pig source_id = group.id || ':' || trip.id (per-trip identity)
    expect(b).toMatch(/\(v_g->>'id'\) \|\| ':' \|\| \(v_t->>'id'\)/);
    // broiler row only when a processingDate is present
    expect(b).toMatch(/processingDate[\s\S]*?CONTINUE WHEN/);
  });
});

describe('mig 157 — grants + reload', () => {
  it('importer/link RPCs are service_role-only; reconcile/crosswalk are authenticated', () => {
    expect(mig).toMatch(/GRANT EXECUTE ON FUNCTION public\.link_asana_to_processing\(jsonb\) TO service_role/);
    expect(mig).toMatch(/GRANT EXECUTE ON FUNCTION public\.upsert_processing_from_planner\(jsonb\) TO service_role/);
    expect(mig).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.reconcile_planner_to_processing\(\) TO authenticated, service_role/,
    );
    expect(mig).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.resolve_processing_asana_link\(text, text\) TO authenticated/,
    );
    expect(mig).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});

describe('mig 157 — Codex blocker fixes', () => {
  it('B1: delete_comment preserves BOTH mig-112 cattle-log guards + the imported guard', () => {
    const b = fnBody('delete_comment');
    expect(b).toMatch(/p_comment_id LIKE 'clog-%'/); // mirror id guard
    expect(b).toMatch(/mirror_comment_id = p_comment_id/); // tag-links mirror guard
    expect(b).toMatch(/v_row\.entity_type = 'cattle\.log'/); // originals guard
    expect(b).toMatch(/v_row\.source <> 'native'/); // imported read-only guard
  });
  it('B2: upsert_processing_from_asana coerces the record match_status to the 156 domain', () => {
    const b = fnBody('upsert_processing_from_asana');
    expect(b).toMatch(/v_ms := CASE/);
    expect(b).toMatch(/'needs_review' THEN 'review'/);
    expect(b).toMatch(/ELSE 'unmatched'/);
    // record writes go through the coerced v_ms, never the raw detailed bucket
    expect(b).toMatch(/match_status\s*=\s*COALESCE\(v_ms, match_status\)/);
    expect(b).toMatch(/COALESCE\(v_ms, 'unmatched'\)/);
  });
  it('B3: link_asana_to_processing keeps a manual crosswalk + never orphans a non-null link', () => {
    const b = fnBody('link_asana_to_processing');
    expect(b).toContain('v_manual');
    expect(b).toMatch(/v_existing_method = 'manual_crosswalk'/);
    // manual OR (incoming null while an established record exists) -> keep record
    expect(b).toMatch(/v_keep_rec\s*:=\s*v_manual OR \(v_rec_id IS NULL AND v_existing_rec IS NOT NULL\)/);
    expect(b).toMatch(/CASE WHEN v_keep_rec THEN v_existing_rec ELSE v_rec_id END/);
  });
  it('B4: reconcile retires stale planner rows; upsert un-archives on re-eligibility', () => {
    const rec = fnBody('reconcile_planner_to_processing');
    expect(rec).toMatch(/v_run\s+text\s*:=\s*'reconcile-'/);
    expect(rec).toMatch(/SET archived = true[\s\S]*?sync_run_id IS DISTINCT FROM v_run/);
    expect(rec).toMatch(/'retired', v_retired/);
    const up = fnBody('upsert_processing_from_planner');
    expect(up).toMatch(/archived\s*=\s*false/); // un-archive when the source returns
    expect(up).toMatch(/sync_run_id\s*=\s*COALESCE\(p_row->>'sync_run_id', sync_run_id\)/);
  });
});

describe('mig 157 — Codex re-review fixes', () => {
  it('Bug1: link seed + first-attach + return follow the EFFECTIVE record, not the proposed one', () => {
    const b = fnBody('link_asana_to_processing');
    expect(b).toContain('v_eff_rec');
    expect(b).toMatch(/v_eff_rec := CASE WHEN v_keep_rec THEN v_existing_rec ELSE v_rec_id END/);
    // seed targets the effective record only — never the (possibly rejected) proposed v_rec_id
    expect(b).toMatch(/UPDATE public\.processing_records[\s\S]*?WHERE id = v_eff_rec/);
    expect(b).not.toMatch(/WHERE id = v_rec_id/);
    // first-attach keyed off the effective record + return value follows it too
    expect(b).toMatch(/v_existing_rec IS DISTINCT FROM v_eff_rec/);
    expect(b).toMatch(/'record_id', v_eff_rec/);
  });
  it('Bug2: list_processing_reconciliation planner_only_count excludes archived rows', () => {
    const b = fnBody('list_processing_reconciliation');
    expect(b).toMatch(/record_type = 'planner_batch'[\s\S]*?r\.archived = false/);
  });
});
