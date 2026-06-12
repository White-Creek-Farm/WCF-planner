// ============================================================================
// Cattle Log static guard — locks migration 112 + the client modules to the
// Cattle Log implementation contract.
//
// Server (supabase-migrations/112_cattle_log.sql):
//   - cattle_log_issue_state + cattle_log_tag_links: deny-all RLS, REVOKE ALL
//     (SECDEF-only access, like comments in mig 071).
//   - Six public RPCs (submit/edit/delete entry, set issue, list entries,
//     list mentionable profiles): SECURITY DEFINER + SET search_path = public
//     + REVOKE FROM PUBLIC/anon + GRANT EXECUTE TO authenticated.
//   - Mirror guard re-issues of edit_comment/delete_comment ('clog-' ids are
//     managed only by the Cattle Log RPCs).
//   - 'cattle.log' branches in _activity_can_read/_activity_can_write
//     (explicit role gate light/farm_team/management/admin — NOT
//     profile_program_access).
//   - Resolver trigger on cattle (AFTER INSERT OR UPDATE OF tag, old_tags).
//   - NOTIFY pgrst, and NO transaction statements (TEST applies via exec_sql,
//     which rejects BEGIN/COMMIT).
//
// Client: the new modules never touch comments/cattle_log tables directly,
// cattleLogApi speaks only the contracted RPC names, CattleLogPage carries
// the contracted data hooks, and the integration points (routes,
// activityRegistry, CommentsSection mirror provenance) stay wired.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// For checks that prose comments could false-positive (e.g. ".from()" in a
// module header). NOTE: naive stripping — fine for these JS modules.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

const MIG_REL = 'supabase-migrations/112_cattle_log.sql';
const mig = read(MIG_REL);

const PUBLIC_RPCS = [
  'submit_cattle_log_entry',
  'edit_cattle_log_entry',
  'delete_cattle_log_entry',
  'set_cattle_log_issue',
  'list_cattle_log_entries',
  'list_cattle_log_mentionable_profiles',
];

const INTERNAL_HELPERS = [
  '_cattle_log_parse_tags',
  '_cattle_log_match_tag',
  '_cattle_log_upsert_mirror',
  '_cattle_log_validate_payload',
  '_cattle_log_validate_calf_note',
  '_cattle_log_insert_unresolved_link',
  '_cattle_log_notify_mentions',
  'resolve_cattle_log_unresolved_tags',
];

// Slice one CREATE OR REPLACE FUNCTION block (through its trailing
// REVOKE/GRANT lines, up to the next function definition or EOF).
function fnChunk(name) {
  const startRe = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\s*\\(`);
  const m = mig.match(startRe);
  expect(m, `${name} defined in migration 112`).toBeTruthy();
  const start = m.index;
  const next = mig.indexOf('CREATE OR REPLACE FUNCTION', start + 1);
  return mig.slice(start, next === -1 ? mig.length : next);
}

describe('migration 112 — tables (deny-all RLS, SECDEF-only access)', () => {
  it('creates cattle_log_issue_state with the contracted shape', () => {
    expect(mig).toContain('CREATE TABLE IF NOT EXISTS public.cattle_log_issue_state');
    expect(mig).toMatch(/comment_id\s+text PRIMARY KEY REFERENCES public\.comments\(id\) ON DELETE CASCADE/);
    expect(mig).toMatch(/is_issue\s+boolean NOT NULL DEFAULT true/);
    expect(mig).toMatch(/last_set_by\s+uuid REFERENCES public\.profiles\(id\)/);
    expect(mig).toMatch(/last_set_at\s+timestamptz/);
  });

  it('creates cattle_log_tag_links with the contracted shape (NULL cattle_id = unresolved)', () => {
    expect(mig).toContain('CREATE TABLE IF NOT EXISTS public.cattle_log_tag_links');
    expect(mig).toMatch(/comment_id\s+text NOT NULL REFERENCES public\.comments\(id\) ON DELETE CASCADE/);
    expect(mig).toMatch(/tag\s+text NOT NULL/);
    expect(mig).toMatch(/cattle_id\s+text REFERENCES public\.cattle\(id\)/);
    expect(mig).toContain('mirror_comment_id');
    for (const col of [
      'calf_herd',
      'calf_dob',
      'calf_dob_estimated',
      'calf_sex',
      'calf_origin',
      'calf_dam_tag',
      'calf_breed',
      'calf_note',
    ]) {
      expect(mig, `tag_links column ${col}`).toContain(col);
    }
    expect(mig).toContain('UNIQUE (comment_id, tag)');
  });

  it('locks both tables behind deny-all RLS + REVOKE ALL (RPC-only access)', () => {
    for (const table of ['cattle_log_issue_state', 'cattle_log_tag_links']) {
      expect(mig, `${table} revoked`).toContain(
        `REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`,
      );
      expect(mig, `${table} RLS enabled`).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(mig, `${table} deny-all policy`).toMatch(
        new RegExp(`CREATE POLICY ${table}_deny_all ON public\\.${table}\\s+FOR ALL USING \\(false\\)`),
      );
    }
  });
});

describe('migration 112 — RPC family (SECDEF, search_path, grants)', () => {
  for (const name of PUBLIC_RPCS) {
    it(`${name} is SECURITY DEFINER with pinned search_path and authenticated-only EXECUTE`, () => {
      const chunk = fnChunk(name);
      expect(chunk, `${name} SECURITY DEFINER`).toContain('SECURITY DEFINER');
      expect(chunk, `${name} search_path`).toContain('SET search_path = public');
      expect(chunk, `${name} revoked from PUBLIC/anon`).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon;`),
      );
      expect(chunk, `${name} granted to authenticated`).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO authenticated;`),
      );
    });
  }

  it('keeps every internal helper SECDEF-internal (no authenticated EXECUTE)', () => {
    for (const name of INTERNAL_HELPERS) {
      expect(mig, `${name} defined`).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\s*\\(`));
      expect(mig, `${name} fully revoked`).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`),
      );
      expect(mig, `${name} must not be client-callable`).not.toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\b`),
      );
    }
  });

  it('submit is replay-idempotent, blocks ambiguous tags, and forces is_issue on unresolved tags', () => {
    const chunk = fnChunk('submit_cattle_log_entry');
    // Replay path: existing p_id returns the stored summary instead of erroring.
    expect(chunk).toContain('IF EXISTS (SELECT 1 FROM public.comments WHERE id = p_id)');
    expect(chunk).toContain("'replayed', true");
    // Entry-id invariants the mirror-id scheme depends on.
    expect(chunk).toContain("IF p_id LIKE 'clog-%' THEN");
    expect(chunk).toContain("position('--' in p_id) > 0");
    // Role gate + singleton entity insert.
    expect(chunk).toContain("NOT IN ('light', 'farm_team', 'management', 'admin')");
    expect(chunk).toContain("(p_id, 'cattle.log', 'cattle-log', v_caller, p_body, v_mentions, v_attachments");
    // Ambiguous tag hard-fails; unresolved tags force is_issue true server-side.
    expect(chunk).toContain("RAISE EXCEPTION 'CATTLE_LOG_AMBIGUOUS_TAG: %', v_tag;");
    expect(chunk).toContain('COALESCE(p_is_issue, true) OR COALESCE(array_length(v_unresolved, 1), 0) > 0');
  });

  it('edit is author-only on live entries, diffs tag links, and hard-deletes removed mirrors', () => {
    const chunk = fnChunk('edit_cattle_log_entry');
    expect(chunk).toContain("RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: only the author may edit';");
    expect(chunk).toContain("IF p_id LIKE 'clog-%' THEN");
    expect(chunk).toMatch(/IF v_row\.entity_type <> 'cattle\.log' OR v_row\.entity_id <> 'cattle-log' THEN/);
    expect(chunk).toMatch(/IF v_row\.deleted_at IS NOT NULL THEN/);
    // Previous version recorded to comment_edits (mig 071 behavior).
    expect(chunk).toContain('INSERT INTO public.comment_edits');
    // Removed tag -> mirror hard-deleted, link dropped.
    expect(chunk).toContain('DELETE FROM public.comments WHERE id = v_link.mirror_comment_id;');
    expect(chunk).toContain('DELETE FROM public.cattle_log_tag_links WHERE id = v_link.id;');
    expect(chunk).toContain("RAISE EXCEPTION 'CATTLE_LOG_AMBIGUOUS_TAG: %', v_tag;");
    // Notify only newly added mentions (edit_comment behavior): previous
    // mentions are passed as the skip list.
    expect(chunk).toContain('_cattle_log_notify_mentions(p_id, v_caller, p_body, v_mentions, v_row.mentions)');
    // p_mentions semantics: NULL (the default) preserves the existing
    // mentions unchanged and sends no new mention notifications; '{}' still
    // removes all; non-null arrays stay the authoritative diffed set.
    expect(chunk).toMatch(/p_mentions\s+uuid\[\] DEFAULT NULL/);
    expect(chunk).toMatch(
      /IF p_mentions IS NULL THEN\s+v_mentions := COALESCE\(v_row\.mentions, ARRAY\[\]::uuid\[\]\);/,
    );
    expect(chunk).toMatch(/IF p_mentions IS NOT NULL THEN\s+PERFORM public\._cattle_log_notify_mentions/);
  });

  it('delete is management/admin-only: soft-deletes the entry, hard-deletes mirrors, keeps links', () => {
    const chunk = fnChunk('delete_cattle_log_entry');
    expect(chunk).toContain("NOT IN ('management', 'admin')");
    expect(chunk).toMatch(/UPDATE public\.comments\s+SET deleted_at = now\(\),\s+deleted_by = v_caller/);
    expect(chunk).toContain('DELETE FROM public.comments');
    expect(chunk).toMatch(/SET mirror_comment_id = NULL/);
    // Links/issue rows are kept (no DELETE on the log tables here).
    expect(chunk).not.toContain('DELETE FROM public.cattle_log_tag_links');
    expect(chunk).not.toContain('DELETE FROM public.cattle_log_issue_state');
  });

  it('set_cattle_log_issue is management/admin-only and upserts both directions', () => {
    const chunk = fnChunk('set_cattle_log_issue');
    expect(chunk).toContain("NOT IN ('management', 'admin')");
    expect(chunk).toContain('INSERT INTO public.cattle_log_issue_state');
    expect(chunk).toContain('ON CONFLICT (comment_id) DO UPDATE');
    expect(chunk).toContain('last_set_by');
    expect(chunk).toContain('last_set_at');
  });

  it('list excludes soft-deleted entries, filters issues/all, searches body+author+tag, keyset-paginates', () => {
    const chunk = fnChunk('list_cattle_log_entries');
    expect(chunk).toContain("NOT IN ('light', 'farm_team', 'management', 'admin')");
    expect(chunk).toContain('c.deleted_at IS NULL');
    expect(chunk).toContain("IF v_filter NOT IN ('issues', 'all') THEN");
    expect(chunk).toContain("v_filter = 'all' OR COALESCE(s.is_issue, true)");
    expect(chunk).toContain("c.body ILIKE '%' || v_search || '%'");
    expect(chunk).toContain("COALESCE(p.full_name, '') ILIKE '%' || v_search || '%'");
    // Tag search: leading '#'s stripped, digits-only, exact link match.
    expect(chunk).toContain("ltrim(v_search, '#')");
    expect(chunk).toMatch(/v_tag_q !~ '\^\[0-9\]\+\$'/);
    expect(chunk).toContain('l.comment_id = c.id AND l.tag = v_tag_q');
    // Newest-first keyset pagination.
    expect(chunk).toContain('ORDER BY c.created_at DESC, c.id DESC');
    expect(chunk).toContain('(c.created_at, c.id) < (p_before_created_at, p_before_id)');
    expect(chunk).toContain("'has_more', v_has_more");
  });

  it('mentionable profiles are limited to the Cattle Log role set', () => {
    const chunk = fnChunk('list_cattle_log_mentionable_profiles');
    expect(chunk).toMatch(/RETURNS TABLE\s*\(\s*id uuid,\s*full_name text\s*\)/);
    expect(chunk).toContain("p.role IN ('light', 'farm_team', 'management', 'admin')");
  });

  it('tag matching follows the mig-110 rule: active herds, current tag first, non-import old_tags', () => {
    const chunk = fnChunk('_cattle_log_match_tag');
    expect(chunk).toContain('c.deleted_at IS NULL');
    expect(chunk).toContain("c.herd IN ('mommas', 'backgrounders', 'finishers', 'bulls')");
    expect(chunk).toContain("COALESCE(ot->>'source', '') <> 'import'");
    // Current-tag tier resolves BEFORE the old_tags fallback is consulted.
    const currentIdx = chunk.indexOf('AND c.tag = p_tag');
    const oldTagsIdx = chunk.indexOf('old_tags');
    expect(currentIdx, 'current-tag match present').toBeGreaterThan(-1);
    expect(oldTagsIdx, 'old_tags fallback present').toBeGreaterThan(currentIdx);
  });

  it('mirror ids are deterministic and upserted (replay/resync safe)', () => {
    const chunk = fnChunk('_cattle_log_upsert_mirror');
    expect(chunk).toContain("'clog-' || p_entry_id || '--' || p_cattle_id");
    expect(chunk).toContain("'cattle.animal'");
    expect(chunk).toContain('ON CONFLICT (id) DO UPDATE');
  });

  it('attachment paths are validated with starts_with against the cattle log scope', () => {
    const chunk = fnChunk('_cattle_log_validate_payload');
    expect(chunk).toContain("starts_with(p_attachments->i->>'path', 'cattle.log/cattle-log/')");
    expect(chunk).not.toMatch(/ LIKE /);
    expect(chunk).toContain('too many attachments (% > 5)');
    expect(chunk).toContain('too many mentions (% > 10)');
    expect(chunk).toContain('CATTLE_LOG_MENTION_INVALID: cannot mention yourself');
    expect(chunk).toContain('body must be at least 4 characters');
  });

  it('mention notifications copy the mig-071 fan-out shape with the Cattle Log entity', () => {
    const chunk = fnChunk('_cattle_log_notify_mentions');
    expect(chunk).toContain("'comment_mention'");
    expect(chunk).toContain("'cattle.log', 'cattle-log', 'Cattle Log'");
    expect(chunk).toMatch(/comment_entity_type, comment_entity_id, comment_entity_label/);
  });

  it('never writes activity_events (Cattle Log is comments-only)', () => {
    expect(mig).not.toContain('activity_events');
  });
});

describe('migration 112 — resolver trigger', () => {
  it('installs the AFTER INSERT OR UPDATE OF tag, old_tags trigger on cattle', () => {
    expect(mig).toContain('DROP TRIGGER IF EXISTS cattle_log_tag_resolver ON public.cattle;');
    expect(mig).toMatch(
      /CREATE TRIGGER cattle_log_tag_resolver\s+AFTER INSERT OR UPDATE OF tag, old_tags\s+ON public\.cattle\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.resolve_cattle_log_unresolved_tags\(\);/,
    );
  });

  it('resolver only fills unambiguous matches on live entries and never touches is_issue', () => {
    const chunk = fnChunk('resolve_cattle_log_unresolved_tags');
    expect(chunk).toContain('RETURNS trigger');
    expect(chunk).toContain('SECURITY DEFINER');
    expect(chunk).toContain('l.cattle_id IS NULL');
    expect(chunk).toContain('c.deleted_at IS NULL');
    // Unambiguous-only: exactly one global match resolves the link.
    expect(chunk).toContain('COALESCE(array_length(v_ids, 1), 0) <> 1');
    // Never touches the issue flag.
    expect(chunk).not.toContain('is_issue');
    expect(chunk).not.toContain('cattle_log_issue_state');
  });
});

describe('migration 112 — mirror guard on the generic comment RPCs', () => {
  for (const name of ['edit_comment', 'delete_comment']) {
    it(`${name} re-issue rejects 'clog-' mirrors before any other processing`, () => {
      const chunk = fnChunk(name);
      expect(chunk).toContain("LIKE 'clog-%' OR EXISTS");
      expect(chunk).toContain('WHERE mirror_comment_id = p_comment_id');
      expect(chunk).toContain(
        "RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: cattle log mirrors are managed by the Cattle Log RPCs';",
      );
      // Early clause: the guard fires before the role lookup.
      const guardIdx = chunk.indexOf("LIKE 'clog-%'");
      const roleIdx = chunk.indexOf('profile_role()');
      expect(guardIdx, `${name} guard before role check`).toBeLessThan(roleIdx);
    });

    it(`${name} re-issue rejects cattle.log ORIGINALS after the row fetch (originals guard)`, () => {
      // The id-based mirror guard above does NOT cover 'cl-…' originals
      // (mirrors live on entity_type cattle.animal). Without this entity
      // guard an author could edit/delete a log entry through the generic
      // RPCs, bypassing tag re-diff / mirror resync and orphaning mirrors.
      const chunk = fnChunk(name);
      expect(chunk).toMatch(
        /IF v_row\.entity_type = 'cattle\.log' THEN\s+RAISE EXCEPTION 'CATTLE_LOG_VALIDATION: cattle log entries are managed by the Cattle Log RPCs';\s+END IF;/,
      );
      // Placement: after the target row is fetched (guard references v_row).
      const fetchIdx = chunk.indexOf('INTO v_row');
      const entityGuardIdx = chunk.indexOf("v_row.entity_type = 'cattle.log'");
      expect(fetchIdx, `${name} fetches the row`).toBeGreaterThan(-1);
      expect(entityGuardIdx, `${name} originals guard after the fetch`).toBeGreaterThan(fetchIdx);
    });
  }

  it('edit_comment re-issue reproduces the mig-071 behavior faithfully', () => {
    const chunk = fnChunk('edit_comment');
    expect(chunk).toMatch(/edit_comment: caller role.*cannot edit/);
    expect(chunk).toContain('edit_comment: not permitted for entity');
    expect(chunk).toContain('edit_comment: only the author may edit');
    expect(chunk).toContain('_activity_can_write');
    expect(chunk).toContain('edit_comment: attachment[%] path not scoped to entity');
    expect(chunk).toContain('INSERT INTO public.comment_edits');
    expect(chunk).toMatch(
      /SELECT id, entity_type, entity_id, author_profile_id, body, mentions, attachments, deleted_at/,
    );
  });

  it('delete_comment re-issue reproduces the mig-071 behavior faithfully', () => {
    const chunk = fnChunk('delete_comment');
    expect(chunk).toMatch(/delete_comment: caller role.*cannot delete/);
    expect(chunk).toContain('delete_comment: not permitted for entity');
    expect(chunk).toContain('delete_comment: only author or admin may delete');
    expect(chunk).toMatch(/SET deleted_at = now\(\),\s+deleted_by = v_caller/);
  });
});

describe('migration 112 — _activity_can_read/_activity_can_write cattle.log branches', () => {
  const readBranchRe =
    /IF p_entity_type = 'cattle\.log' THEN\s+RETURN v_role IN \('light', 'farm_team', 'management', 'admin'\);\s+END IF;/;
  const writeRefuseRe = /IF p_entity_type = 'cattle\.log' THEN\s+RETURN false;\s+END IF;/;

  it('_activity_can_read gains an explicit role-gated cattle.log branch (not program_access)', () => {
    const chunk = fnChunk('_activity_can_read');
    expect(chunk).toMatch(readBranchRe);
    // Fail-closed default preserved.
    expect(chunk).toMatch(/RETURN false;\s+END\s+\$can_read\$/);
    // Faithful re-issue: the pre-existing branches survive.
    for (const entity of ['task.instance', 'broiler.batch', 'cattle.animal', 'cattle.forecast', 'weighin.session']) {
      expect(chunk, `existing branch ${entity} preserved`).toContain(`'${entity}'`);
    }
  });

  it('_activity_can_write REFUSES cattle.log (writes are Cattle-Log-RPC-family-only) and still delegates otherwise', () => {
    // A permissive cattle.log branch here would let generic post_comment
    // create cattle.log comments bypassing tag parsing / issue state.
    const chunk = fnChunk('_activity_can_write');
    expect(chunk).toMatch(writeRefuseRe);
    expect(chunk, 'must not role-allow cattle.log writes').not.toMatch(readBranchRe);
    expect(chunk).toContain('RETURN public._activity_can_read(p_entity_type, p_entity_id);');
  });
});

describe('migration 112 — apply-safety', () => {
  it('reloads the PostgREST schema cache', () => {
    expect(mig).toContain("NOTIFY pgrst, 'reload schema';");
  });

  it('contains no transaction statements (exec_sql rejects BEGIN/COMMIT)', () => {
    // plpgsql block BEGINs are bare keywords; a transaction statement would
    // be a standalone 'BEGIN;' / 'COMMIT;'.
    expect(mig).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(mig).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});

// ── client modules ──────────────────────────────────────────────────────────

const NEW_MODULES = [
  'src/lib/cattleLogTags.js',
  'src/lib/cattleLogApi.js',
  'src/lib/cattleLogOffline.js',
  'src/cattle/CattleLogPage.jsx',
  'src/cattle/CattleLogHowTo.jsx',
];

describe('cattle log client — no direct table access (RPC-only)', () => {
  it('the new modules never query comments or the cattle_log tables directly', () => {
    for (const rel of NEW_MODULES) {
      const src = read(rel);
      for (const table of ['comments', 'comment_edits', 'cattle_log_issue_state', 'cattle_log_tag_links']) {
        expect(src, `${rel} must not .from('${table}')`).not.toMatch(new RegExp(`\\.from\\(\\s*['"]${table}['"]`));
      }
    }
  });

  it('CattleLogPage reads only the active-cattle preview list directly', () => {
    const page = read('src/cattle/CattleLogPage.jsx');
    const tables = [...page.matchAll(/\.from\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
    expect(tables).toEqual(['cattle']);
    expect(page).toContain(".is('deleted_at', null)");
    expect(page).toContain(".in('herd', CATTLE_HERDS)");
  });
});

describe('cattleLogApi — contracted RPC surface', () => {
  const api = read('src/lib/cattleLogApi.js');

  it('speaks only the six contracted RPC names', () => {
    const rpcNames = [...api.matchAll(/\.rpc\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...new Set(rpcNames)].sort()).toEqual([...PUBLIC_RPCS].sort());
    expect(stripComments(api), 'no direct table access').not.toMatch(/\.from\(/);
  });

  it('exports the contract wrapper set', () => {
    for (const fn of [
      'submitCattleLogEntry',
      'editCattleLogEntry',
      'deleteCattleLogEntry',
      'setCattleLogIssue',
      'listCattleLogEntries',
      'loadCattleLogMentionableProfiles',
      'classifyCattleLogError',
      'generateCattleLogEntryId',
    ]) {
      expect(api, `${fn} exported`).toMatch(new RegExp(`export (async )?function ${fn}\\b`));
    }
  });

  it("mints 'cl-' entry ids (never the 'clog-' mirror prefix, never '--')", () => {
    expect(api).toMatch(/`cl-\$\{ts\}-/);
    expect(api).not.toMatch(/`clog-/);
  });

  it('classifies the three server prefixes and falls back to transient', () => {
    expect(api).toContain("if (text.includes('CATTLE_LOG_AMBIGUOUS_TAG')) return 'ambiguous_tag';");
    expect(api).toContain("if (text.includes('CATTLE_LOG_MENTION_INVALID')) return 'mention_invalid';");
    expect(api).toContain("if (text.includes('CATTLE_LOG_VALIDATION')) return 'validation';");
    expect(api).toContain("return 'transient';");
  });
});

describe('cattleLogTags — pure parsing module', () => {
  const tags = read('src/lib/cattleLogTags.js');

  it('has no imports (pure module by contract)', () => {
    expect(tags).not.toMatch(/^\s*import\b/m);
    expect(tags).not.toMatch(/\brequire\s*\(/);
  });

  it('exports the contract helper set', () => {
    for (const fn of [
      'parseCattleLogTags',
      'normalizeTagSearchQuery',
      'buildCattleLogBodySegments',
      'matchTagToCattle',
    ]) {
      expect(tags, `${fn} exported`).toMatch(new RegExp(`export function ${fn}\\b`));
    }
  });

  it('keeps the digit-tag pattern and the active-herd matching rule', () => {
    expect(tags).toContain('/#([0-9]+)/g');
    expect(tags).toContain("['mommas', 'backgrounders', 'finishers', 'bulls']");
    expect(tags).toContain("source !== 'import'");
  });
});

describe('cattleLogOffline — queue replay contract', () => {
  const offline = read('src/lib/cattleLogOffline.js');

  it('extends offlineQueue.js (the single IndexedDB owner) instead of opening its own DB', () => {
    expect(offline).toContain("from './offlineQueue.js'");
    expect(offline).not.toMatch(/from 'idb'/);
    expect(offline).not.toMatch(/\bopenDB\s*\(/);
    expect(offline).not.toMatch(/\bindexedDB\b/);
  });

  it('replays via the idempotent submit RPC with deterministic upload paths', () => {
    expect(offline).toContain("export const CATTLE_LOG_SUBMIT_RPC = 'submit_cattle_log_entry';");
    expect(offline).toContain('cattle.log/cattle-log/${entryId}/${index}-');
    // upsert:false with duplicate-as-success (append-only storage contract).
    expect(offline).toMatch(/\.upload\([\s\S]{0,160}?upsert: false/);
    expect(offline).not.toContain('upsert: true');
    expect(offline).toMatch(/duplicate\|23505\|409/);
    // uploadedPaths persisted after EACH upload (partial-replay resume).
    expect(offline).toContain('appendCattleLogUploadedPath(row.csid, meta.key);');
  });

  it('routes failures: transient stays queued, deterministic errors go needs_attention', () => {
    expect(offline).toContain("status: 'queued', errorClass: 'transient'");
    expect(offline).toContain("status: 'needs_attention'");
  });

  it('offlineQueue.js carries the cattle_log form-kind extension', () => {
    const queue = read('src/lib/offlineQueue.js');
    expect(queue).toContain("export const CATTLE_LOG_FORM_KIND = 'cattle_log';");
    for (const fn of ['enqueueCattleLogSubmission', 'appendCattleLogUploadedPath', 'setCattleLogOutcome']) {
      expect(queue, `${fn} exported`).toMatch(new RegExp(`export async function ${fn}\\b`));
    }
  });
});

describe('CattleLogPage — contracted data hooks and behavior anchors', () => {
  const page = read('src/cattle/CattleLogPage.jsx');

  it('carries every contracted data hook', () => {
    for (const hook of [
      'data-cattle-log-loaded',
      'data-cattle-log-error',
      'data-cattle-log-row',
      'data-cattle-log-queued-row',
      'data-cattle-log-needs-attention-row',
      'data-cattle-log-issue-toggle',
      'data-cattle-log-submit',
      'data-cattle-log-search',
      'data-cattle-log-filter-issues',
      'data-cattle-log-filter-all',
      'data-cattle-log-calf-panel',
      'data-cattle-log-unresolved-note',
      'data-cattle-log-howto',
      'data-cattle-log-load-more',
    ]) {
      expect(page, `hook ${hook}`).toContain(hook);
    }
  });

  it('submit button is the labelled paper-airplane control', () => {
    expect(page).toContain('aria-label="Submit log entry"');
    expect(page).toContain('PaperAirplaneIcon');
  });

  it('defaults to the Issues filter and the Issue checkbox checked (forced for unknown tags)', () => {
    expect(page).toContain("useState('issues')");
    expect(page).toContain('const [composerIssue, setComposerIssue] = useState(true);');
    expect(page).toContain('forceIssue ? true : composerIssue');
    expect(page).toContain('disabled={forceIssue || submitting}');
  });

  it('renders mention deep-link anchors per entry row', () => {
    expect(page).toContain("id={'comment-' + e.id}");
  });

  it('fails closed: load errors clear stale rows and offer Retry via InlineNotice', () => {
    expect(page).toMatch(/if \(cancelled\) return;\s+setEntries\(\[\]\);/);
    expect(page).toContain('Could not load the Cattle Log');
    expect(page).toContain('InlineNotice');
    expect(page).toContain('Retry');
  });

  it('gates roles per contract (view/add vs manage)', () => {
    expect(page).toContain("const ALLOWED_ROLES = ['light', 'farm_team', 'management', 'admin'];");
    expect(page).toContain("const MANAGER_ROLES = ['management', 'admin'];");
    expect(page).toContain('disabled={!canManage || !!issueBusy[e.id]}');
  });
});

describe('cattle log — integration wiring', () => {
  it('routes registers cattlelog at /cattle/log', () => {
    expect(read('src/lib/routes.js')).toContain("cattlelog: '/cattle/log',");
  });

  it('main.jsx mounts CattleLogPage for the cattlelog view', () => {
    const main = read('src/main.jsx');
    expect(main).toContain("import CattleLogPage from './cattle/CattleLogPage.jsx';");
    expect(main).toMatch(/if \(view === 'cattlelog'\)\s+return React\.createElement\(CattleLogPage/);
  });

  it("activityRegistry resolves 'cattle.log' mention deep-links to /cattle/log", () => {
    const registry = read('src/lib/activityRegistry.js');
    expect(registry).toContain("'cattle.log'");
    // Registry convention: displayLabel is a function (callers invoke it).
    const idx = registry.indexOf("displayLabel: () => 'Cattle Log'");
    expect(idx, "displayLabel 'Cattle Log' present").toBeGreaterThan(-1);
    const win = registry.slice(Math.max(0, idx - 300), idx + 300);
    expect(win).toMatch(/route: \(\) => '\/cattle\/log'/);
    expect(win).toMatch(/program: 'cattle'/);
  });

  it('CommentsSection marks clog- mirrors with provenance and suppresses edit/delete on them', () => {
    const cs = read('src/shared/CommentsSection.jsx');
    expect(cs, 'mirror detection by id prefix').toContain("startsWith('clog-')");
    expect(cs, 'provenance chip text').toContain('From Cattle Log');
    expect(cs, 'provenance chip links to the log page').toContain('/cattle/log');
    // Suppression proof: BOTH action blocks (author edit/delete + admin
    // delete) must be gated on !isCattleLogMirror. Token-count contract, not
    // exact JSX, so layout refactors stay free as long as both gates remain.
    const suppressionGates = cs.match(/!isCattleLogMirror/g) || [];
    expect(suppressionGates.length, 'both action blocks gated with !isCattleLogMirror').toBeGreaterThanOrEqual(2);
  });

  it("CattleLogPage file inputs never force camera capture (no 'capture=' attribute)", () => {
    // The image_file_input_capture guard's comment-stripper cannot see this
    // file's composer input (the '/*' inside its accept="image/*,..." value
    // opens a false block comment that swallows the surrounding JSX), so the
    // real capture= lock for CattleLogPage lives here, on the RAW text.
    const page = read('src/cattle/CattleLogPage.jsx');
    expect(page, "no capture= attribute anywhere (data-* attrs don't count)").not.toMatch(/(?<!-)capture=/);
  });
});
