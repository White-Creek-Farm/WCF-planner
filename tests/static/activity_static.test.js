// Static lock for Activity + @Mentions Phase 1 (mig 058 +
// src/lib/activityApi.js + activityRegistry.js + Header wire-up +
// Task Center attachment).
//
// What we lock:
//   * mig 058 ships the table shapes, RLS lockdown, grant shape, the
//     four SECDEF RPCs, the task.completed trigger, and the notifications
//     widen (CHECK + activity_event_id column).
//   * activityApi.js exposes only the LIVE audit helpers + mention
//     renderer + change-event name. The legacy composer client helpers
//     (post/edit/delete/count) were removed with ActivityPanel/
//     ActivityModal; Comments are the discussion path now.
//   * activityRegistry.js carries the task.instance entry and the route
//     resolver.
//   * No src/ file directly reads or writes public.activity_events /
//     public.activity_mentions — the SECDEF RPC layer is the only path.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const mig058 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/058_activity_events.sql'), 'utf8');
const mig060 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/060_activity_mention_contract.sql'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/activityApi.js'), 'utf8');
const regSrc = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
const taSrc = fs.readFileSync(path.join(ROOT, 'src/shared/MentionTextarea.jsx'), 'utf8');
const completeTaskModalSrc = fs.readFileSync(path.join(ROOT, 'src/tasks/CompleteTaskModal.jsx'), 'utf8');
const myTasksTabSrc = fs.readFileSync(path.join(ROOT, 'src/tasks/MyTasksTab.jsx'), 'utf8');

describe('mig 058 — activity_events table + RLS lockdown', () => {
  it('creates activity_events with the expected columns and constraints', () => {
    expect(mig058).toMatch(/CREATE TABLE IF NOT EXISTS public\.activity_events/);
    for (const col of [
      'id\\s+text PRIMARY KEY',
      'entity_type\\s+text NOT NULL',
      'entity_id\\s+text NOT NULL',
      'actor_profile_id\\s+uuid REFERENCES public\\.profiles\\(id\\) ON DELETE SET NULL',
      'event_type\\s+text NOT NULL',
      'body\\s+text',
      'payload\\s+jsonb NOT NULL DEFAULT',
      'created_at\\s+timestamptz NOT NULL DEFAULT now\\(\\)',
      'edited_at\\s+timestamptz',
      'deleted_at\\s+timestamptz',
    ]) {
      expect(mig058, `missing column shape: ${col}`).toMatch(new RegExp(col));
    }
    expect(mig058).toMatch(
      /CONSTRAINT activity_events_event_type_check\s+CHECK \(event_type ~ '\^\[a-z\]\[a-z0-9\._\]\+\$'\)/,
    );
  });

  it('creates the recipient-style indexes (entity + actor + partial unread)', () => {
    expect(mig058).toMatch(/CREATE INDEX IF NOT EXISTS activity_events_entity_idx/);
    expect(mig058).toMatch(/CREATE INDEX IF NOT EXISTS activity_events_actor_idx/);
    expect(mig058).toMatch(/WHERE deleted_at IS NULL/);
  });

  it('creates activity_mentions with compound PK + cascade FKs', () => {
    expect(mig058).toMatch(/CREATE TABLE IF NOT EXISTS public\.activity_mentions/);
    expect(mig058).toMatch(/event_id\s+text NOT NULL REFERENCES public\.activity_events\(id\) ON DELETE CASCADE/);
    expect(mig058).toMatch(/mentioned_profile_id\s+uuid NOT NULL REFERENCES public\.profiles\(id\) ON DELETE CASCADE/);
    expect(mig058).toMatch(/PRIMARY KEY \(event_id, mentioned_profile_id\)/);
  });

  it('locks RLS on both tables — no policies, REVOKE ALL from authenticated/anon', () => {
    expect(mig058).toMatch(/ALTER TABLE public\.activity_events ENABLE ROW LEVEL SECURITY/);
    expect(mig058).toMatch(/ALTER TABLE public\.activity_mentions ENABLE ROW LEVEL SECURITY/);
    expect(mig058).toMatch(/REVOKE ALL ON public\.activity_events FROM PUBLIC, anon, authenticated/);
    expect(mig058).toMatch(/REVOKE ALL ON public\.activity_mentions FROM PUBLIC, anon, authenticated/);
    // Negative: no CREATE POLICY ... ON public.activity_events / activity_mentions
    expect(mig058).not.toMatch(/CREATE POLICY[^;]*ON public\.activity_events/);
    expect(mig058).not.toMatch(/CREATE POLICY[^;]*ON public\.activity_mentions/);
  });
});

describe('mig 058 — profile helpers + permission resolver', () => {
  it('adds profile_role + profile_program_access companions to is_admin', () => {
    expect(mig058).toMatch(/CREATE OR REPLACE FUNCTION public\.profile_role\(\)\s+RETURNS text/);
    expect(mig058).toMatch(/CREATE OR REPLACE FUNCTION public\.profile_program_access\(\)\s+RETURNS text\[\]/);
  });

  it('_activity_can_read fails closed; admin DOES NOT bypass entity existence', () => {
    expect(mig058).toMatch(/CREATE OR REPLACE FUNCTION public\._activity_can_read/);
    // fail-closed for empty entity_type / entity_id
    expect(mig058).toMatch(/IF p_entity_type IS NULL OR length\(trim\(p_entity_type\)\) = 0/);
    expect(mig058).toMatch(/IF v_role = 'inactive' THEN\s+RETURN false/);
    // Admin short-circuit was REMOVED in the blocker 1 fix. The per-type
    // EXISTS probe (asserted in the sibling test below) now runs for every
    // role, so a fake / typo / deleted id is rejected even for admins.
    // Phase 2 entity types that need program-access checks can re-add an
    // admin bypass AFTER the EXISTS probe; this test pins that the bypass
    // does NOT live above the existence gate.
    expect(mig058).not.toMatch(/v_role = 'admin' THEN\s+RETURN true/);
    expect(mig058).toMatch(/-- Unknown entity_type\. Fail closed/);
  });

  it('_activity_can_read verifies the source row EXISTS per task.* entity type', () => {
    // Phase 1 task.* branches must EXIST-probe the source table so fake
    // ids cannot receive comments. The bare "IN (...)" shortcut is gone.
    expect(mig058).not.toMatch(/p_entity_type IN \('task\.instance', 'task\.template', 'task\.system_rule'\)/);
    expect(mig058).toMatch(
      /p_entity_type = 'task\.instance'[\s\S]*?EXISTS \(SELECT 1 FROM public\.task_instances WHERE id = p_entity_id\)/,
    );
    expect(mig058).toMatch(
      /p_entity_type = 'task\.template'[\s\S]*?EXISTS \(SELECT 1 FROM public\.task_templates WHERE id = p_entity_id\)/,
    );
    expect(mig058).toMatch(
      /p_entity_type = 'task\.system_rule'[\s\S]*?EXISTS \(SELECT 1 FROM public\.task_system_rules WHERE id = p_entity_id\)/,
    );
  });

  it('_activity_can_write blocks inactive + delegates to can_read', () => {
    expect(mig058).toMatch(/CREATE OR REPLACE FUNCTION public\._activity_can_write/);
    expect(mig058).toMatch(/IF v_role IS NULL OR v_role = 'inactive' THEN\s+RETURN false/);
    expect(mig058).toMatch(/RETURN public\._activity_can_read\(p_entity_type, p_entity_id\)/);
  });
});

describe('mig 058 — RPCs (list / count / post / edit / delete)', () => {
  it('list_activity_events checks _activity_can_read and clamps the limit', () => {
    // Drop-then-CREATE pattern (not CREATE OR REPLACE) because the
    // RETURNS TABLE shape gained actor_display_name; Postgres refuses to
    // change return shape via CREATE OR REPLACE.
    expect(mig058).toMatch(/DROP FUNCTION IF EXISTS public\.list_activity_events\(text, text, int\);/);
    expect(mig058).toMatch(/CREATE FUNCTION public\.list_activity_events/);
    expect(mig058).toMatch(/IF NOT public\._activity_can_read\(p_entity_type, p_entity_id\)/);
    expect(mig058).toMatch(/IF v_limit > 200 THEN v_limit := 200/);
  });

  it('list_activity_events returns actor_display_name resolved server-side from profiles', () => {
    // The RPC body joins profiles by actor_profile_id and exposes the
    // result as actor_display_name. Client renders that directly — no
    // round-trip + no client-side join.
    //
    // profiles.id MUST be table-qualified — bare `id` inside the subquery
    // collides with the function's RETURNS TABLE column named `id`,
    // raising "column reference id is ambiguous" at runtime (silent in
    // PostgREST → empty data → panel renders "No activity yet" even though
    // the row exists). The qualifier on the alias closes that hole.
    expect(mig058).toMatch(/actor_display_name\s+text,/);
    expect(mig058).toMatch(
      /\(SELECT p\.full_name FROM public\.profiles p WHERE p\.id = ae\.actor_profile_id\) AS actor_display_name/,
    );
  });

  it('count_activity_for_entity also gates on _activity_can_read', () => {
    expect(mig058).toMatch(/CREATE OR REPLACE FUNCTION public\.count_activity_for_entity/);
    expect(mig058).toMatch(/IF NOT public\._activity_can_read\(p_entity_type, p_entity_id\)/);
  });

  it('post_activity_comment (mig 058 base) caps mentions, rejects inactive, self-mention rule', () => {
    // Mig 058 defines the original RPC. Mig 060 replaces it to drop the
    // body-uuid validation — the assertions about that drop live in the
    // "mig 060" describe block below. Everything OTHER than the body-
    // uuid check is pinned here against mig 058's definition.
    expect(mig058).toMatch(/CREATE OR REPLACE FUNCTION public\.post_activity_comment/);
    expect(mig058).toMatch(/IF v_n_mentions > 10 THEN\s+RAISE EXCEPTION 'post_activity_comment: too many mentions/);
    expect(mig058).toMatch(/IF v_mention_role = 'inactive' THEN/);
    expect(mig058).toMatch(/IF v_m = v_caller THEN\s+CONTINUE/);
    expect(mig058).toMatch(/INSERT INTO public\.notifications[\s\S]*?'mention'[\s\S]*?activity_event_id/);
  });

  it('edit_activity_event is author-only and re-validates mentions', () => {
    expect(mig058).toMatch(/CREATE OR REPLACE FUNCTION public\.edit_activity_event/);
    expect(mig058).toMatch(
      /IF v_row\.actor_profile_id IS DISTINCT FROM v_caller THEN\s+RAISE EXCEPTION 'edit_activity_event: only the author may edit'/,
    );
    expect(mig058).toMatch(/IF v_row\.event_type <> 'comment\.posted'/);
  });

  it('delete_activity_event is soft-delete only, author or admin, idempotent', () => {
    expect(mig058).toMatch(/CREATE OR REPLACE FUNCTION public\.delete_activity_event/);
    expect(mig058).toMatch(
      /IF v_row\.deleted_at IS NOT NULL THEN\s+RETURN jsonb_build_object\('ok', true, 'idempotent_replay', true/,
    );
    expect(mig058).toMatch(/IF NOT v_admin AND v_row\.actor_profile_id IS DISTINCT FROM v_caller/);
    expect(mig058).toMatch(/SET deleted_at = now\(\)/);
    // No hard delete from this RPC
    expect(mig058).not.toMatch(/DELETE FROM public\.activity_events/);
  });

  it('all four RPCs REVOKE from anon + GRANT to authenticated', () => {
    for (const fn of [
      'list_activity_events',
      'count_activity_for_entity',
      'post_activity_comment',
      'edit_activity_event',
      'delete_activity_event',
    ]) {
      const sig = mig058.match(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon`));
      expect(sig, `${fn}: REVOKE from anon missing`).not.toBeNull();
      const grant = mig058.match(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated`));
      expect(grant, `${fn}: GRANT to authenticated missing`).not.toBeNull();
    }
  });
});

describe('mig 058 — notifications widen + activity_event_id', () => {
  it('widens notifications.type CHECK to include mention', () => {
    expect(mig058).toMatch(/ALTER TABLE public\.notifications DROP CONSTRAINT IF EXISTS notifications_type_check/);
    expect(mig058).toMatch(/CHECK \(type IN \('task_completed', 'mention'\)\)/);
  });

  it('adds nullable activity_event_id FK + index', () => {
    expect(mig058).toMatch(
      /ADD COLUMN IF NOT EXISTS activity_event_id text REFERENCES public\.activity_events\(id\) ON DELETE CASCADE/,
    );
    expect(mig058).toMatch(/CREATE INDEX IF NOT EXISTS notifications_activity_event_idx/);
  });
});

describe('mig 058 — task.completed trigger', () => {
  it('emits task.completed events on the open->completed transition', () => {
    expect(mig058).toMatch(/CREATE OR REPLACE FUNCTION public\._activity_emit_task_completed/);
    expect(mig058).toMatch(/IF NEW\.status = 'completed'[\s\S]*?OLD\.status IS DISTINCT FROM 'completed'/);
    expect(mig058).toMatch(/'task\.completed'/);
    expect(mig058).toMatch(/CREATE TRIGGER task_instances_emit_completed/);
  });
});

describe('src/lib/activityApi.js — helpers + parser', () => {
  it('exports the live Activity Layer helpers + change event name', () => {
    expect(apiSrc).toMatch(/export async function listActivityEvents/);
    expect(apiSrc).toMatch(/export async function recordActivityEvent/);
    expect(apiSrc).toMatch(/export async function recordFieldChange/);
    expect(apiSrc).toMatch(/export async function recordStatusChange/);
    expect(apiSrc).toMatch(/export function buildFieldChangeSummary/);
    expect(apiSrc).toMatch(/export function renderMentionSegments/);
    expect(apiSrc).toMatch(/export const ACTIVITY_CHANGE_EVENT = 'wcf-activity-change'/);
  });

  it('no longer exports the retired legacy-composer helpers', () => {
    // The legacy global Activity composer (ActivityModal/ActivityPanel) was
    // retired. Comments are the live discussion path now; Activity is
    // read-only audit/system history. These client helpers were the only
    // callers of the legacy comment write/edit/delete/count RPCs.
    expect(apiSrc).not.toMatch(/export async function countActivityForEntity/);
    expect(apiSrc).not.toMatch(/export async function postActivityComment/);
    expect(apiSrc).not.toMatch(/export async function editActivityEvent/);
    expect(apiSrc).not.toMatch(/export async function deleteActivityEvent/);
  });

  it('live helpers route through .rpc() — no direct .from() on activity tables', () => {
    // Strip JSDoc comments before scanning so the platform-contract
    // comment that names the forbidden patterns doesn't itself trigger
    // the lock.
    const code = apiSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    expect(code).not.toMatch(/\.from\(\s*['"]activity_events['"]\s*\)/);
    expect(code).not.toMatch(/\.from\(\s*['"]activity_mentions['"]\s*\)/);
    expect(apiSrc).toMatch(/\.rpc\('list_activity_events'/);
    expect(apiSrc).toMatch(/\.rpc\('record_activity_event'/);
    // The legacy comment write/edit/delete/count RPC calls are gone.
    expect(apiSrc).not.toMatch(/\.rpc\('count_activity_for_entity'/);
    expect(apiSrc).not.toMatch(/\.rpc\('post_activity_comment'/);
    expect(apiSrc).not.toMatch(/\.rpc\('edit_activity_event'/);
    expect(apiSrc).not.toMatch(/\.rpc\('delete_activity_event'/);
  });

  it('mention renderer uses name-array chipping; no uuid token markup', () => {
    // Mig 060 retired the `@[Name](profile:uuid)` wire format. The
    // renderer now receives mentioned_profile_names (resolved server-
    // side in list_activity_events) and chips literal "@Name" spans.
    // The token regex + token-builder + token-extractor are gone — if
    // they reappear, the visible body would leak uuids again.
    expect(apiSrc).toMatch(/export function renderMentionSegments/);
    // New signature accepts mentioned_profile_names + ids.
    expect(apiSrc).toMatch(/renderMentionSegments\(body, mentionedProfileNames[^)]*mentionedProfileIds/);
    // Negative locks on the dead token format and helpers.
    expect(apiSrc).not.toMatch(/export function extractMentionUuids/);
    expect(apiSrc).not.toMatch(/export function buildMentionToken/);
    expect(apiSrc).not.toMatch(/MENTION_INLINE_RE/);
    // No regex literal that matches the dead canonical form anywhere.
    expect(apiSrc).not.toMatch(/@\\\[\(/);
  });
});

describe('mig 060 — mention contract switch (plain @Name + p_mentions[] authoritative)', () => {
  it('list_activity_events RETURNS gains mentioned_profile_names text[]', () => {
    expect(mig060).toMatch(/DROP FUNCTION IF EXISTS public\.list_activity_events\(text, text, int\);/);
    expect(mig060).toMatch(/CREATE FUNCTION public\.list_activity_events/);
    expect(mig060).toMatch(/mentioned_profile_names\s+text\[\]/);
    // Names array is ordered to stay positionally aligned with the ids.
    expect(mig060).toMatch(
      /array_agg\(COALESCE\(p2\.full_name, ''\) ORDER BY am2\.created_at, am2\.mentioned_profile_id\)/,
    );
    // Same ORDER BY on the ids array so they pair correctly.
    expect(mig060).toMatch(/array_agg\(am\.mentioned_profile_id ORDER BY am\.created_at, am\.mentioned_profile_id\)/);
  });

  it('post_activity_comment + edit_activity_event drop body-uuid validation', () => {
    // The dead checks: _extract_mention_uuids(p_body), v_extracted = ANY(...)
    expect(mig060).not.toMatch(/_extract_mention_uuids\(p_body\)/);
    expect(mig060).not.toMatch(/v_m = ANY\(v_extracted\)/);
    // The replacement RPCs are still defined.
    expect(mig060).toMatch(/CREATE OR REPLACE FUNCTION public\.post_activity_comment/);
    expect(mig060).toMatch(/CREATE OR REPLACE FUNCTION public\.edit_activity_event/);
  });

  it('still enforces existence + role + cap + permission server-side', () => {
    // Authoritative validations the server retains.
    expect(mig060).toMatch(/post_activity_comment: authenticated caller required/);
    expect(mig060).toMatch(/post_activity_comment: body required/);
    expect(mig060).toMatch(/post_activity_comment: body too long/);
    expect(mig060).toMatch(/IF NOT public\._activity_can_write\(p_entity_type, p_entity_id\)/);
    expect(mig060).toMatch(/IF v_n_mentions > 10 THEN/);
    expect(mig060).toMatch(/mentioned profile % not found/);
    expect(mig060).toMatch(/mentioned profile % is inactive/);
    // Self-mention rule preserved.
    expect(mig060).toMatch(/IF v_m = v_caller THEN\s+CONTINUE/);
  });

  it('grants + revokes preserved on the replaced functions', () => {
    expect(mig060).toMatch(/REVOKE ALL ON FUNCTION public\.list_activity_events\([^)]*\) FROM PUBLIC, anon/);
    expect(mig060).toMatch(/GRANT EXECUTE ON FUNCTION public\.list_activity_events\([^)]*\) TO authenticated/);
    expect(mig060).toMatch(/REVOKE ALL ON FUNCTION public\.post_activity_comment\([^)]*\) FROM PUBLIC, anon/);
    expect(mig060).toMatch(/GRANT EXECUTE ON FUNCTION public\.post_activity_comment\([^)]*\) TO authenticated/);
    expect(mig060).toMatch(/REVOKE ALL ON FUNCTION public\.edit_activity_event\([^)]*\) FROM PUBLIC, anon/);
    expect(mig060).toMatch(/GRANT EXECUTE ON FUNCTION public\.edit_activity_event\([^)]*\) TO authenticated/);
  });
});

describe('src/lib/activityRegistry.js — registry + route resolver', () => {
  it('declares the task.instance entry + resolveNotificationRoute', () => {
    expect(regSrc).toMatch(/export const ENTITY_TYPES = \{/);
    expect(regSrc).toMatch(/TASK_INSTANCE: 'task\.instance'/);
    // Registry uses a computed key — [ENTITY_TYPES.TASK_INSTANCE]: { ... }
    expect(regSrc).toMatch(/\[ENTITY_TYPES\.TASK_INSTANCE\]:\s*\{/);
    expect(regSrc).toMatch(/displayLabel:/);
    expect(regSrc).toMatch(/route:/);
    expect(regSrc).toMatch(/export function getActivityEntityMeta/);
    expect(regSrc).toMatch(/export function resolveNotificationRoute/);
  });
});

describe('src/shared/MentionTextarea.jsx — picker', () => {
  it('loads eligible profiles via the canonical Tasks v2 helper', () => {
    expect(taSrc).toMatch(/import \{loadTaskAssignableProfilesById\} from '\.\.\/lib\/tasksCenterApi\.js'/);
  });
  it('carries the data-* hooks for textarea + picker', () => {
    for (const hook of [
      'data-mention-textarea="1"',
      'data-mention-picker="1"',
      'data-mention-picker-item',
      'data-mention-uuids',
      'data-mention-count',
    ]) {
      expect(taSrc, `missing data-* hook: ${hook}`).toContain(hook);
    }
  });
  it('inserts plain "@DisplayName " on pick — no uuid / parens leak into the textarea', () => {
    // Polish lock: the picker's insertion string must be the user-friendly
    // "@" + display + " " form. Any reappearance of "[Name](profile:" or
    // a buildMentionToken import would leak uuids back into the visible
    // composer. Strip comments first so the doc-block reference to the
    // dead canonical token doesn't trip the negative regex.
    expect(taSrc).toMatch(/const inserted = '@' \+ display \+ ' '/);
    const taCode = taSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    expect(taCode).not.toMatch(/buildMentionToken/);
    expect(taCode).not.toMatch(/profile:\$\{profile\.id\}/);
    expect(taCode).not.toMatch(/@\[.*\]\(profile:/);
  });
  it('tracks mentions via explicit picker state, NOT re-derived from body', () => {
    // p_mentions[] is authoritative. Typing/erasing body text does not
    // mutate mentions. The picker append step dedupes by uuid.
    expect(taSrc).not.toMatch(/extractMentionUuids/);
    expect(taSrc).toMatch(/mentions\.includes\(profile\.id\)/);
  });
});

describe('Task Center wire-up', () => {
  it('CompleteTaskModal does not embed ActivityPanel (moved to record page)', () => {
    expect(completeTaskModalSrc).not.toContain('ActivityPanel');
    expect(completeTaskModalSrc).not.toContain('data-complete-task-activity');
  });

  it('MyTasksTab does not import ActivityPanel or ActivityModal (moved to record page)', () => {
    expect(myTasksTabSrc).not.toMatch(/import ActivityPanel/);
    expect(myTasksTabSrc).not.toMatch(/import ActivityModal/);
    expect(myTasksTabSrc).not.toContain('setActivityTarget');
  });

  it('TaskRow photo indicator uses the picture icon + photo count label (paperclip retired)', () => {
    // Polish lock: the only attachment kind on task rows today is a
    // photo. Paperclip 📎 reads as a generic file; switched to 🖼 with a
    // photo count label so operators see at a glance what they're
    // opening. Paperclip stays available for non-photo attachment kinds
    // when those ship.
    expect(myTasksTabSrc).toMatch(/data-task-has-photo="1"/);
    expect(myTasksTabSrc).toMatch(/data-task-photo-count=\{count\}/);
    expect(myTasksTabSrc).toMatch(/🖼/);
    // Negative: no paperclip in the live render path. (The doc-comment
    // mentions both intentionally — we strip comments before scanning.)
    const code = myTasksTabSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    expect(code).not.toContain('📎');
  });
});

describe('mig 066 — record_activity_event (generalized Activity Layer RPC)', () => {
  const mig066 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/066_activity_change_events.sql'), 'utf8');

  it('defines the generalized SECURITY DEFINER RPC with event_type param', () => {
    expect(mig066).toMatch(/CREATE OR REPLACE FUNCTION public\.record_activity_event/);
    expect(mig066).toMatch(/SECURITY DEFINER/);
    expect(mig066).toMatch(/p_entity_type\s+text/);
    expect(mig066).toMatch(/p_entity_id\s+text/);
    expect(mig066).toMatch(/p_event_type\s+text/);
    expect(mig066).toMatch(/p_entity_label\s+text/);
    expect(mig066).toMatch(/p_body\s+text/);
    expect(mig066).toMatch(/p_payload\s+jsonb/);
  });

  it('drops the narrow record_activity_change_event if it existed', () => {
    expect(mig066).toMatch(/DROP FUNCTION IF EXISTS public\.record_activity_change_event/);
  });

  it('authenticates the caller and rejects inactive profiles', () => {
    expect(mig066).toMatch(/record_activity_event: authenticated caller required/);
    expect(mig066).toMatch(/v_role IS NULL OR v_role = 'inactive'/);
  });

  it('rejects null or blank event_type before the allowlist check', () => {
    expect(mig066).toMatch(/p_event_type IS NULL OR length\(trim\(p_event_type\)\) = 0/);
    expect(mig066).toMatch(/record_activity_event: event_type required/);
  });

  it('enforces an event_type allowlist', () => {
    for (const t of ['field.updated', 'status.changed', 'record.created', 'record.deleted', 'record.restored']) {
      expect(mig066, `missing allowed event_type: ${t}`).toContain(`'${t}'`);
    }
    expect(mig066).toMatch(/record_activity_event: unsupported event_type/);
  });

  it('gates on _activity_can_write', () => {
    expect(mig066).toMatch(/IF NOT public\._activity_can_write\(p_entity_type, p_entity_id\)/);
  });

  it('documents record.deleted as soft-delete only (tombstone must exist for resolver)', () => {
    expect(mig066).toMatch(/soft-deleted/i);
    expect(mig066).toMatch(/source entity must still exist/i);
    expect(mig066).not.toMatch(/record soft-deleted or removed/);
  });

  it('documents Phase 1 best-effort semantics (not audit-grade transactional)', () => {
    expect(mig066).toMatch(/Phase 1/);
    expect(mig066).toMatch(/best-effort/i);
  });

  it('inserts into activity_events and stores entity_label in payload', () => {
    expect(mig066).toMatch(/INSERT INTO public\.activity_events/);
    expect(mig066).toMatch(/p_event_type/);
    expect(mig066).toMatch(/entity_label/);
  });

  it('guards body length', () => {
    expect(mig066).toMatch(/body too long/);
  });

  it('does NOT create notifications or mentions', () => {
    expect(mig066).not.toMatch(/INSERT INTO public\.notifications/);
    expect(mig066).not.toMatch(/INSERT INTO public\.activity_mentions/);
  });

  it('REVOKE from anon + GRANT to authenticated + NOTIFY', () => {
    expect(mig066).toMatch(/REVOKE ALL ON FUNCTION public\.record_activity_event\([^)]*\) FROM PUBLIC, anon/);
    expect(mig066).toMatch(/GRANT EXECUTE ON FUNCTION public\.record_activity_event\([^)]*\) TO authenticated/);
    expect(mig066).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});

describe('Activity Layer — event type labels', () => {
  const logSrc = fs.readFileSync(path.join(ROOT, 'src/activity/ActivityLogView.jsx'), 'utf8');
  const EVENT_TYPES = ['field.updated', 'status.changed', 'record.created', 'record.deleted', 'record.restored'];

  it('ActivityLogView EVENT_TYPE_LABELS covers all Activity Layer event types', () => {
    for (const t of EVENT_TYPES) {
      expect(logSrc, `missing EVENT_TYPE_LABELS for ${t}`).toContain(`'${t}'`);
    }
  });
});

describe('Activity Layer — pilot surface: layer batch notes (field.updated)', () => {
  const layerPageSrc = fs.readFileSync(path.join(ROOT, 'src/layer/LayerBatchPage.jsx'), 'utf8');

  it('imports recordFieldChange from activityApi', () => {
    expect(layerPageSrc).toContain("import {recordFieldChange} from '../lib/activityApi.js'");
  });

  it('tracks initial notes via batchInitialNotesRef', () => {
    expect(layerPageSrc).toContain('batchInitialNotesRef');
  });

  it('fires field change event on form close when notes changed', () => {
    expect(layerPageSrc).toContain('recordFieldChange(sb');
    expect(layerPageSrc).toContain("field: 'notes'");
    expect(layerPageSrc).toContain("label: 'Notes'");
  });
});

describe('Activity Layer — pilot surface: equipment status (status.changed)', () => {
  const eqSrc = fs.readFileSync(path.join(ROOT, 'src/equipment/EquipmentDetail.jsx'), 'utf8');

  it('imports runMutation + recordStatusChange from entityMutations', () => {
    expect(eqSrc).toContain("from '../lib/entityMutations.js'");
    expect(eqSrc).toContain('runMutation');
    expect(eqSrc).toContain('recordStatusChange');
  });

  it('fires status change event on equipment status toggle', () => {
    expect(eqSrc).toContain('recordStatusChange(sb');
    expect(eqSrc).toContain("entityType: 'equipment.item'");
  });
});

describe('Source-wide: no direct activity table reads/writes anywhere in src/', () => {
  // Walk src/ once and assert no .jsx/.js file references the activity
  // tables directly. The SECDEF RPC layer is the only path.
  const srcRoot = path.join(ROOT, 'src');
  function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(p));
      else if (entry.isFile() && /\.(jsx?|cjs|mjs)$/.test(entry.name)) out.push(p);
    }
    return out;
  }
  const files = walk(srcRoot);
  function stripComments(src) {
    // Remove /* ... */ block comments + // ... line comments before
    // scanning for forbidden patterns. Same identifier-boundary safety
    // as the prod-stability dialog static lock pattern.
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
  }
  for (const file of files) {
    const rel = path.relative(srcRoot, file);
    it(`${rel} does not reference activity_events / activity_mentions tables directly`, () => {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      // Forbidden: client-side .from('activity_events') or
      // .from('activity_mentions'). RPC string literals (e.g.
      // .rpc('list_activity_events')) are fine because the function
      // name lives in a separate identifier namespace and the SECDEF
      // RPCs are the only sanctioned write path.
      expect(code, `${rel}: .from('activity_events') is forbidden`).not.toMatch(
        /\.from\(\s*['"]activity_events['"]\s*\)/,
      );
      expect(code, `${rel}: .from('activity_mentions') is forbidden`).not.toMatch(
        /\.from\(\s*['"]activity_mentions['"]\s*\)/,
      );
    });
  }

  it('does not reintroduce retired Activity composer or deep-link bridge identifiers in runtime source', () => {
    const forbidden = [
      'ActivityPanel',
      'ActivityModal',
      'setActivityTarget',
      'wcf-entity-deep-link',
      '_wcfEntityDeepLink',
    ];
    const offenders = [];
    for (const file of files) {
      const rel = path.relative(srcRoot, file);
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      for (const token of forbidden) {
        if (code.includes(token)) offenders.push(`${rel}: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
