// Read-only helpers for the Task Center (T2 of Tasks v2). The Task
// Center is fully transparent — every authenticated user sees every
// task_instances row via the new authenticated_select policy from
// mig 053. T2 ships no mutations; this module exposes ONLY SELECT
// helpers.
//
// Mutations (complete / create / due-date edit / assign / delete /
// system-generate) live in a future tasksCenterMutationsApi.js that
// lands with T3+ as each functional tab arrives. Keeping reads and
// writes in separate modules makes the static no-mutation lock for
// T2 components trivial: the lock just asserts no T2 file imports
// from a mutations module that doesn't exist yet.

/**
 * Load every open task_instances row visible to the caller. Under
 * the v2 transparency RLS, every authenticated user sees every row
 * regardless of assignee.
 *
 * Returns rows sorted by due_date ascending so the caller can render
 * "oldest due first" (which puts overdue rows at the top naturally
 * — past dates are smaller than today's date). Tie-break on title.
 */
export async function loadOpenTaskInstances(sb) {
  const {data, error} = await sb
    .from('task_instances')
    .select('*')
    .eq('status', 'open')
    .order('due_date', {ascending: true})
    .order('title', {ascending: true});
  if (error) throw new Error(`loadOpenTaskInstances: ${error.message}`);
  return data || [];
}

/**
 * Load every eligible assignee for the My Tasks tab's grouped view.
 * Returns an id-keyed map of {id, full_name} for O(1) name resolution
 * per row.
 *
 * Goes through the SECURITY DEFINER list_eligible_assignees RPC (mig
 * 041) instead of a direct profiles SELECT so the call works for
 * regular non-admin users regardless of profiles RLS, and so we never
 * leak role/email through the wire (the RPC returns id + full_name
 * only). Same RPC the public Tasks webform uses.
 */
export async function loadEligibleProfilesById(sb) {
  const {data, error} = await sb.rpc('list_eligible_assignees');
  if (error) throw new Error(`loadEligibleProfilesById: ${error.message}`);
  const out = {};
  for (const p of data || []) out[p.id] = {id: p.id, full_name: p.full_name};
  return out;
}

/**
 * Pure helper: split a flat open-tasks list into
 *   { mine: TaskRow[], otherGroups: { profileId, name, tasks }[] }
 * for the My Tasks tab. mine is everything assigned to callerProfileId;
 * other groups are keyed by assignee_profile_id and named via the
 * profiles map (falling back to 'Unassigned' for null assignees and
 * to 'Unknown user' for ids not in the profiles map). Both lists keep
 * the input sort order (caller passes due_date asc).
 */
export function splitTasksForMyTab(allOpenTasks, callerProfileId, profilesById) {
  const mine = [];
  const grouped = new Map();
  for (const ti of allOpenTasks || []) {
    if (ti.assignee_profile_id && ti.assignee_profile_id === callerProfileId) {
      mine.push(ti);
      continue;
    }
    const key = ti.assignee_profile_id || '__unassigned__';
    if (!grouped.has(key)) {
      const profile = ti.assignee_profile_id ? profilesById[ti.assignee_profile_id] : null;
      const name = ti.assignee_profile_id ? (profile ? profile.full_name : 'Unknown user') : 'Unassigned';
      grouped.set(key, {profileId: ti.assignee_profile_id || null, name, tasks: []});
    }
    grouped.get(key).tasks.push(ti);
  }
  // Stable group order: by display name asc.
  const otherGroups = Array.from(grouped.values()).sort((a, b) => {
    const an = (a.name || '').toLowerCase();
    const bn = (b.name || '').toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  return {mine, otherGroups};
}

/**
 * Pure helper: derive the "submitted/created" attribution string for
 * a task row. Public-webform rows surface the operator's free-text
 * name; logged-in-created rows surface the locked creator name from
 * mig 050. Recurring + system rows surface their generator label.
 *
 * Returns null when no attribution applies (legacy v1 generated rows
 * with no display data).
 */
export function attributionFor(ti) {
  if (!ti) return null;
  if (ti.submission_source === 'public_webform' && ti.submitted_by_team_member) {
    return {label: 'Submitted by', name: ti.submitted_by_team_member};
  }
  if (ti.created_by_display_name) {
    return {label: 'Created by', name: ti.created_by_display_name};
  }
  if (ti.from_recurring_template) {
    return {label: 'Source', name: 'Recurring template'};
  }
  if (ti.from_system_rule_id) {
    return {label: 'Source', name: 'System rule'};
  }
  return null;
}

/**
 * Pure helper: classify a task's due date relative to today (caller
 * passes a 'YYYY-MM-DD' string for today so tests are deterministic).
 * Returns 'overdue' | 'today' | 'upcoming'.
 */
export function dueStateFor(ti, todayStr) {
  if (!ti || !ti.due_date) return 'upcoming';
  if (ti.due_date < todayStr) return 'overdue';
  if (ti.due_date === todayStr) return 'today';
  return 'upcoming';
}

/**
 * Pure helper: photo-presence indicator for a row. Reads the legacy
 * single-path columns (request_photo_path / completion_photo_path)
 * already on the row — no extra query against the sidecar in T2.
 */
export function photoPresenceFor(ti) {
  if (!ti) return {hasRequest: false, hasCompletion: false};
  return {
    hasRequest: !!ti.request_photo_path,
    hasCompletion: !!ti.completion_photo_path,
  };
}

// ── Tasks v2 T3: Header badge count ─────────────────────────────────────
//
// Count open tasks assigned to the caller whose due_date is today or
// earlier (overdue + due-today). Filters server-side so only the
// caller's eligible rows transit, even though the v2 transparency RLS
// would otherwise let the caller SELECT every row. The Header badge
// uses this number; soft-fail on the consumer side keeps Header
// rendering even if the DB call errors.
//
// Returns 0 for a falsy callerProfileId (unauthenticated render path).
export async function countMyOpenDueOrPastTasks(sb, callerProfileId, todayStr) {
  if (!callerProfileId) return 0;
  if (!todayStr) return 0;
  const {count, error} = await sb
    .from('task_instances')
    .select('id', {count: 'exact', head: true})
    .eq('status', 'open')
    .eq('assignee_profile_id', callerProfileId)
    .lte('due_date', todayStr);
  if (error) throw new Error(`countMyOpenDueOrPastTasks: ${error.message}`);
  return count || 0;
}

// ── Tasks v2 T4: Completed tab ──────────────────────────────────────────
//
// Read the most recent completed task_instances rows. Capped at 200 so
// a long-running farm doesn't pull thousands of rows into the browser
// for a read-only review pane; foreseeable cohort fits comfortably.
// Older completions remain queryable via direct DB / future filters.
export async function loadCompletedTaskInstances(sb, {limit = 200} = {}) {
  const {data, error} = await sb
    .from('task_instances')
    .select('*')
    .eq('status', 'completed')
    .order('completed_at', {ascending: false, nullsFirst: false})
    .order('title', {ascending: true})
    .limit(limit);
  if (error) throw new Error(`loadCompletedTaskInstances: ${error.message}`);
  return data || [];
}

// ── Tasks v2 T4: Recurring tab ──────────────────────────────────────────
//
// Load every recurring task_templates row (active + inactive) so the
// Recurring tab can show toggle state. Inactive templates may still
// have open instances generated before deactivation; orphan grouping
// in the pure helper below covers the post-delete case (template_id
// went to NULL via mig 050's ON DELETE SET NULL).
export async function loadRecurringTaskTemplates(sb) {
  const {data, error} = await sb
    .from('task_templates')
    .select('*')
    .order('active', {ascending: false})
    .order('title', {ascending: true});
  if (error) throw new Error(`loadRecurringTaskTemplates: ${error.message}`);
  return data || [];
}

export async function loadOpenRecurringInstances(sb) {
  const {data, error} = await sb
    .from('task_instances')
    .select('*')
    .eq('status', 'open')
    .eq('designation', 'recurring')
    .order('due_date', {ascending: true})
    .order('title', {ascending: true});
  if (error) throw new Error(`loadOpenRecurringInstances: ${error.message}`);
  return data || [];
}

/**
 * Pure helper: bucket open recurring instances under their parent
 * templates and surface orphans (designation='recurring' but
 * template_id is NULL — the parent was deleted via the v2
 * SET NULL FK). Returns:
 *   {
 *     templates: [{template, openCount, instances: TaskRow[]}, ...],
 *     orphans:   TaskRow[],
 *   }
 * Templates appear in the order they were passed in (caller already
 * sorted by active desc, title asc). Instances inside each bucket
 * keep the input sort order (caller passed due_date asc).
 */
export function groupRecurringByTemplate(templates, openInstances) {
  const byId = new Map();
  for (const t of templates || []) {
    if (t && t.id) byId.set(t.id, {template: t, openCount: 0, instances: []});
  }
  const orphans = [];
  for (const ti of openInstances || []) {
    const tid = ti.template_id;
    if (tid && byId.has(tid)) {
      const bucket = byId.get(tid);
      bucket.instances.push(ti);
      bucket.openCount += 1;
    } else {
      orphans.push(ti);
    }
  }
  const templateBuckets = (templates || []).filter((t) => t && t.id).map((t) => byId.get(t.id));
  return {templates: templateBuckets, orphans};
}
