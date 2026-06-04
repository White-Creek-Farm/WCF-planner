// ============================================================================
// supabase/functions/tasks-summary — Tasks v2 weekly digest (T10).
// ----------------------------------------------------------------------------
// Deploy:
//   supabase functions deploy tasks-summary --project-ref <project-ref>
//
// Two callers (auth boundary mirrors tasks-cron verbatim):
//   1. cron — pg_cron job invoked by mig 046's '0 13 * * 1' UTC schedule via
//      `public.invoke_tasks_summary(p_probe boolean DEFAULT false)`. The
//      helper reads three Vault secrets and posts to this function with:
//        Authorization: Bearer <TASKS_CRON_SERVICE_ROLE_KEY from vault>
//        x-cron-secret: <TASKS_CRON_SECRET from vault>
//        body: {"mode":"cron","probe":<bool>}
//   2. admin — manual "Send weekly summary now" path (UI not in v1, but the
//      auth shape is locked so a future button can use it). The caller's
//      user JWT is in Authorization; the function verifies admin role via
//      rpc('is_admin').
//        Authorization: Bearer <user JWT>
//        body: {"mode":"admin", "test_to":"someone@example.com"}
//
// Auth boundary (in order — anything else → 401, no audit row):
//   - cron mode: Authorization == env.TASKS_CRON_SERVICE_ROLE_KEY
//                AND x-cron-secret == env.TASKS_CRON_SECRET
//                AND body.mode == 'cron'.
//   - admin mode: rpc('is_admin') with caller JWT returns strict === true
//                AND body.mode == 'admin'.
//
// test_to gating (Codex C4 amendment 5):
//   - cron mode: body.test_to is REJECTED post-auth (400, no audit row).
//     A schedule that silently re-routes real recipient mail to a debug
//     address is exactly the kind of foot-gun that turns into a stale
//     leak. Cron NEVER carries test_to.
//   - admin mode: body.test_to is PASSED THROUGH to rapid-processor's
//     top-level test_to. rapid-processor uses test_to for the to: address
//     and prefixes [TEST] on the subject. (Codex C4 chose top-level over
//     data.test_to for consistency with egg_report et al.)
//
// Probe shortcut:
//   body.probe === true (after auth + mode-specific test_to gating
//   passes) → write a single tsr-probe-* row to task_summary_runs with
//   recipients_sent=0 / total_open_instances=0 / error_message='probe-only
//   invocation' and return immediately. No assignee work, no email send.
//   The SQL probe path uses `SELECT public.invoke_tasks_summary(true);`
//   so this branch is reachable from psql without sending real mail.
//
// Algorithm (probe=false):
//   1. Service-role SELECT on open task_instances (status='open') joined
//      with profiles for email + full_name. Only assignees with non-null
//      profiles.email and role IN ('admin','management','farm_team') are
//      included. role='inactive' is excluded.
//   2. Group by assignee_profile_id; sort each group by due_date asc.
//   3. For each unique assignee, POST to rapid-processor with
//      type:'tasks_weekly_summary'. Track per-recipient failure objects in
//      per_recipient_failures jsonb.
//   4. INSERT one task_summary_runs row at the end (or on top-level error,
//      with error_message set + counts up to that point).
//
// Locked design notes:
//   - Three-layer audit (cron.job_run_details / net._http_response /
//     task_summary_runs). This function only writes the third layer.
//   - DOES NOT touch task_cron_runs. Phase B's "do not overload" rule:
//     daily generator + weekly summary keep separate cron + audit.
//   - One bad recipient does NOT abort the run. per_recipient_failures
//     captures the per-assignee error so the rest of the loop continues
//     (Codex C4 Q8 lock).
// ============================================================================

import {serve} from 'https://deno.land/std@0.168.0/http/server.ts';
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2';

// Defensive trim — paste-deploy of secrets in Dashboard often picks up a
// trailing newline or space; safeEqual is exact-byte so we normalize at
// load time. Mirrors tasks-cron Phase B deploy lesson.
function envTrim(name: string): string {
  return (Deno.env.get(name) ?? '').replace(/^\s+|\s+$/g, '');
}
const SUPABASE_URL = envTrim('SUPABASE_URL');
const SUPABASE_ANON_KEY = envTrim('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = envTrim('SUPABASE_SERVICE_ROLE_KEY');
const TASKS_CRON_SECRET = envTrim('TASKS_CRON_SECRET');
const TASKS_CRON_SERVICE_ROLE_KEY = envTrim('TASKS_CRON_SERVICE_ROLE_KEY');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-cron-secret, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {...corsHeaders, 'Content-Type': 'application/json'},
  });
}

// Length-first then byte compare. Not constant-time at the JS layer but
// hides obvious length-leak signal. Same as tasks-cron.
function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function uuidLike(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  if (trimmed.toLowerCase().startsWith('bearer ')) return trimmed.slice(7).trim();
  return trimmed;
}

// ─── Auth ────────────────────────────────────────────────────────────────

async function authenticateCron(req: Request, mode: string): Promise<boolean> {
  if (mode !== 'cron') return false;
  const bearer = extractBearer(req.headers.get('authorization'));
  const cronSecret = (req.headers.get('x-cron-secret') ?? '').replace(/^\s+|\s+$/g, '');
  return safeEqual(bearer, TASKS_CRON_SERVICE_ROLE_KEY) && safeEqual(cronSecret, TASKS_CRON_SECRET);
}

async function authenticateAdmin(req: Request, mode: string): Promise<boolean> {
  if (mode !== 'admin') return false;
  const authHeader = req.headers.get('authorization');
  if (!authHeader) return false;
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {persistSession: false, autoRefreshToken: false},
    global: {headers: {Authorization: authHeader}},
  });
  const {data, error} = await userClient.rpc('is_admin');
  if (error) return false;
  return data === true;
}

// ─── Audit row writer ────────────────────────────────────────────────────

interface AuditRow {
  id: string;
  run_mode: 'cron' | 'admin';
  recipients_sent: number;
  recipients_skipped: number;
  total_open_instances: number;
  total_completed_instances: number;
  per_recipient_failures: Array<{assignee_profile_id: string; email: string | null; error: string}>;
  error_message: string | null;
}

async function writeAuditRow(serviceClient: ReturnType<typeof createClient>, row: AuditRow): Promise<void> {
  const {error} = await serviceClient.from('task_summary_runs').insert(row);
  if (error) {
    console.error('writeAuditRow failed:', error.message);
  }
}

// ─── rapid-processor invocation ─────────────────────────────────────────
// Internal function-to-function call for the digest send. We don't use
// the project's Authorization: Bearer SUPABASE_SERVICE_ROLE_KEY pattern
// here — that path turned out to be brittle on the current Supabase
// platform key/env setup (envTrim alignment didn't resolve a persistent
// rapid-processor 401 in PROD). Instead, both functions share the
// already-Vault-stored TASKS_CRON_SECRET via a custom header. The cron
// secret is the same one tasks-cron / invoke_tasks_summary already use
// for their auth boundary, and both functions read it the same way
// (envTrim normalization).
//
// Headers sent (note: NO apikey, NO Authorization — the gateway accepts
// both being absent for this --no-verify-jwt function, and the custom
// header avoids any platform-level project-key conflict):
//   x-tasks-summary-secret: TASKS_CRON_SECRET
//   Content-Type: application/json
async function invokeRapidProcessor(payload: object): Promise<{ok: boolean; status: number; body: string}> {
  const url = `${SUPABASE_URL}/functions/v1/rapid-processor`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-tasks-summary-secret': TASKS_CRON_SECRET,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return {ok: res.ok, status: res.status, body: text};
}

// ─── Open task fetch + grouping ─────────────────────────────────────────

interface OpenTaskRow {
  id: string;
  due_date: string;
  title: string;
  description: string | null;
  submission_source: string;
  submitted_by_team_member: string | null;
  designation: string | null;
  created_by_display_name: string | null;
  request_photo_path: string | null;
  completion_photo_path: string | null;
  assignee_profile_id: string;
  profiles: {email: string | null; full_name: string | null; role: string | null} | null;
}

interface CompletedTask {
  task_instance_id: string;
  title: string;
  completed_at: string;
  completed_by: string;
}

interface AssigneeBucket {
  assignee_profile_id: string;
  email: string | null;
  full_name: string;
  role: string;
  tasks: Array<{
    id: string;
    due_date: string;
    title: string;
    description: string | null;
    submission_source: string;
    submitted_by_team_member: string | null;
    designation: string | null;
    created_by_display_name: string | null;
    has_photo: boolean;
  }>;
  // Completed-assigned coverage (mig 093): tasks this recipient
  // created/assigned that were completed in the weekly window. A recipient
  // can land in the digest with an empty `tasks` list and a non-empty
  // `completed` list (assigned-only recipient), and vice versa.
  completed: CompletedTask[];
}

// Group EVERY assignee that has at least one open task — including those
// with no email or role='inactive'. Codex C4 re-review BLOCKER 3: the
// main handler accounts per assignee bucket (recipients_sent +
// recipients_skipped == bucket count), and pushes per_recipient_failures
// entries for inactive/no-email buckets. So the grouping function must
// preserve those buckets rather than silently dropping them at this
// layer.
async function fetchOpenTasksGrouped(
  svc: ReturnType<typeof createClient>,
): Promise<{buckets: AssigneeBucket[]; totalOpen: number}> {
  const {data, error} = await svc
    .from('task_instances')
    .select(
      'id, due_date, title, description, submission_source, submitted_by_team_member, designation, created_by_display_name, request_photo_path, completion_photo_path, assignee_profile_id, profiles!task_instances_assignee_profile_id_fkey(email, full_name, role)',
    )
    .eq('status', 'open');
  if (error) throw new Error(`select task_instances: ${error.message}`);
  const rows = (data || []) as unknown as OpenTaskRow[];
  const totalOpen = rows.length;
  const groups = new Map<string, AssigneeBucket>();
  for (const r of rows) {
    const prof = r.profiles;
    const email = prof?.email ? String(prof.email).trim() : '';
    const role = prof?.role || '';
    let bucket = groups.get(r.assignee_profile_id);
    if (!bucket) {
      bucket = {
        assignee_profile_id: r.assignee_profile_id,
        email: email || null,
        full_name: prof?.full_name || '',
        role,
        tasks: [],
        completed: [],
      };
      groups.set(r.assignee_profile_id, bucket);
    }
    bucket.tasks.push({
      id: r.id,
      due_date: r.due_date,
      title: r.title,
      description: r.description || null,
      submission_source: r.submission_source,
      submitted_by_team_member: r.submitted_by_team_member,
      designation: r.designation || null,
      created_by_display_name: r.created_by_display_name || null,
      has_photo: !!(r.request_photo_path || r.completion_photo_path),
    });
  }
  for (const b of groups.values()) {
    b.tasks.sort((a, c) => {
      if (a.due_date < c.due_date) return -1;
      if (a.due_date > c.due_date) return 1;
      return a.title.localeCompare(c.title);
    });
  }
  return {buckets: Array.from(groups.values()), totalOpen};
}

// ─── Completed-assigned-task fetch (mig 093) ────────────────────────────
// Source of truth = public.notifications rows of type 'task_completed'.
// Migration 057 stamps recipient_profile_id = the task creator/assignor and
// already enforces the product exclusions at write time: NULL creator gets
// no notification, and self-completion (creator completed their own task) is
// excluded. Reading notifications therefore preserves those rules verbatim
// without re-deriving them here. The weekly window lower bound is the
// previous Sunday 08:00 America/Chicago, computed DST-correctly in SQL by
// public.tasks_summary_window_start().

interface CompletedNotifRow {
  task_instance_id: string | null;
  title: string;
  created_at: string;
  recipient_profile_id: string;
  recipient: {email: string | null; full_name: string | null; role: string | null} | null;
  actor: {full_name: string | null} | null;
  task: {title: string | null} | null;
}

interface CompletedBucket {
  email: string | null;
  full_name: string;
  role: string;
  items: CompletedTask[];
}

async function fetchCompletedGrouped(
  svc: ReturnType<typeof createClient>,
): Promise<{byRecipient: Map<string, CompletedBucket>; totalCompleted: number}> {
  // Window start = previous Sunday 08:00 America/Chicago (timestamptz). When
  // run at the gated Sunday-08:00 send, this is the trailing 7-day window.
  const {data: windowStart, error: wErr} = await svc.rpc('tasks_summary_window_start');
  if (wErr) throw new Error(`tasks_summary_window_start: ${wErr.message}`);
  const startIso = typeof windowStart === 'string' ? windowStart : String(windowStart);

  const {data, error} = await svc
    .from('notifications')
    .select(
      'task_instance_id, title, created_at, recipient_profile_id, recipient:profiles!notifications_recipient_profile_id_fkey(email, full_name, role), actor:profiles!notifications_actor_profile_id_fkey(full_name), task:task_instances!notifications_task_instance_id_fkey(title)',
    )
    .eq('type', 'task_completed')
    .gte('created_at', startIso);
  if (error) throw new Error(`select notifications (task_completed): ${error.message}`);

  const rows = (data || []) as unknown as CompletedNotifRow[];
  const totalCompleted = rows.length;
  const byRecipient = new Map<string, CompletedBucket>();
  for (const r of rows) {
    const prof = r.recipient;
    const email = prof?.email ? String(prof.email).trim() : '';
    let bucket = byRecipient.get(r.recipient_profile_id);
    if (!bucket) {
      bucket = {
        email: email || null,
        full_name: prof?.full_name || '',
        role: prof?.role || '',
        items: [],
      };
      byRecipient.set(r.recipient_profile_id, bucket);
    }
    const taskTitle = (r.task?.title || r.title || '').trim();
    const completer = (r.actor?.full_name || '').trim();
    bucket.items.push({
      task_instance_id: r.task_instance_id || '',
      title: taskTitle || '(untitled)',
      completed_at: r.created_at,
      completed_by: completer || 'Someone',
    });
  }
  // Newest completion first within each recipient.
  for (const b of byRecipient.values()) {
    b.items.sort((a, c) => {
      if (a.completed_at < c.completed_at) return 1;
      if (a.completed_at > c.completed_at) return -1;
      return a.title.localeCompare(c.title);
    });
  }
  return {byRecipient, totalCompleted};
}

// ─── Main handler ────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {headers: corsHeaders});
  }
  if (req.method !== 'POST') {
    return jsonResponse({ok: false, error: 'method not allowed'}, 405);
  }

  let body: {mode?: string; probe?: boolean; test_to?: string} = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch (_e) {
    return jsonResponse({ok: false, error: 'invalid json body'}, 400);
  }

  const mode = String(body.mode || '').toLowerCase();
  if (mode !== 'cron' && mode !== 'admin') {
    return jsonResponse({ok: false, error: 'mode required: cron | admin'}, 400);
  }

  let authed = false;
  if (mode === 'cron') {
    authed = await authenticateCron(req, mode);
  } else if (mode === 'admin') {
    authed = await authenticateAdmin(req, mode);
  }
  if (!authed) {
    return jsonResponse({ok: false, error: 'unauthorized'}, 401);
  }

  // Cron-mode test_to is rejected POST-auth so no audit row is written
  // (mirrors mode-spoof / wrong-secret 401 contract). Admin-mode test_to
  // is allowed and passed through to rapid-processor verbatim.
  const testTo = typeof body.test_to === 'string' ? body.test_to.trim() : '';
  if (mode === 'cron' && testTo.length > 0) {
    return jsonResponse({ok: false, error: 'test_to is not allowed in cron mode'}, 400);
  }

  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {persistSession: false, autoRefreshToken: false},
  });

  // Probe short-circuit. tsr-probe-* rows are deterministically removable
  // by id prefix; PROD probes are real audit (consistent with task_cron_runs).
  if (body.probe === true) {
    const probeRow: AuditRow = {
      id: 'tsr-probe-' + uuidLike(),
      run_mode: mode as 'cron' | 'admin',
      recipients_sent: 0,
      recipients_skipped: 0,
      total_open_instances: 0,
      total_completed_instances: 0,
      per_recipient_failures: [],
      error_message: 'probe-only invocation',
    };
    await writeAuditRow(svc, probeRow);
    return jsonResponse({ok: true, probe: true, run_mode: mode});
  }

  let recipients_sent = 0;
  let recipients_skipped = 0;
  let total_open_instances = 0;
  let total_completed_instances = 0;
  const per_recipient_failures: AuditRow['per_recipient_failures'] = [];
  let errMsg: string | null = null;

  try {
    const {buckets: openBuckets, totalOpen} = await fetchOpenTasksGrouped(svc);
    total_open_instances = totalOpen;

    // Merge completed-assigned coverage (mig 093) into the recipient set.
    // A recipient is anyone with open assigned tasks OR with tasks they
    // assigned/created that were completed this week. Both lists are keyed
    // by profile id; the union is the digest recipient set. A recipient
    // with only completed items (zero open tasks) still gets an email; a
    // recipient with neither never enters this map, so the no-email-when-
    // both-empty rule holds structurally.
    const {byRecipient: completedByRecipient, totalCompleted} = await fetchCompletedGrouped(svc);
    total_completed_instances = totalCompleted;

    const byId = new Map<string, AssigneeBucket>();
    for (const b of openBuckets) byId.set(b.assignee_profile_id, b);
    for (const [recipientId, c] of completedByRecipient) {
      let bucket = byId.get(recipientId);
      if (!bucket) {
        // Assigned-only recipient: no open tasks, build from the completed
        // notification's recipient profile join. Same skip rules apply
        // (inactive / no-email) in the loop below.
        bucket = {
          assignee_profile_id: recipientId,
          email: c.email,
          full_name: c.full_name,
          role: c.role,
          tasks: [],
          completed: [],
        };
        byId.set(recipientId, bucket);
      }
      bucket.completed = c.items;
    }
    const buckets = Array.from(byId.values());

    // Per-recipient accounting (Codex C4 re-review BLOCKER 3, extended for
    // completed coverage):
    //   - Every recipient bucket is either sent or skipped exactly once.
    //   - recipients_sent + recipients_skipped MUST equal buckets.length.
    //   - per_recipient_failures records every skip reason (inactive,
    //     missing email, send failure) so audit shows WHY.
    for (const bucket of buckets) {
      // Skip 1/3: profile has role='inactive' — treat like a deactivated
      // user; never email regardless of mode.
      if (bucket.role === 'inactive') {
        recipients_skipped += 1;
        per_recipient_failures.push({
          assignee_profile_id: bucket.assignee_profile_id,
          email: bucket.email,
          error: "skipped: profile role is 'inactive'",
        });
        continue;
      }
      // Skip 2/3: no email on file. Profile may still be a valid actor
      // but we have no way to deliver mail.
      if (!bucket.email) {
        recipients_skipped += 1;
        per_recipient_failures.push({
          assignee_profile_id: bucket.assignee_profile_id,
          email: null,
          error: 'skipped: profile has no email',
        });
        continue;
      }
      // Send path. Carries both the open assigned tasks and the completed-
      // assigned tasks for this recipient; rapid-processor renders whichever
      // sections are non-empty and skips the send only if both are empty.
      const payload: Record<string, unknown> = {
        type: 'tasks_weekly_summary',
        data: {
          email: bucket.email,
          full_name: bucket.full_name,
          tasks: bucket.tasks,
          count: bucket.tasks.length,
          completed: bucket.completed,
          completed_count: bucket.completed.length,
        },
      };
      if (testTo) payload.test_to = testTo;
      try {
        const res = await invokeRapidProcessor(payload);
        if (!res.ok) {
          // Skip 3a/3: rapid-processor returned non-2xx.
          recipients_skipped += 1;
          per_recipient_failures.push({
            assignee_profile_id: bucket.assignee_profile_id,
            email: bucket.email,
            error: `rapid-processor ${res.status}: ${res.body.slice(0, 200)}`,
          });
          continue;
        }
        recipients_sent += 1;
      } catch (e) {
        // Skip 3b/3: network/runtime error invoking rapid-processor.
        recipients_skipped += 1;
        per_recipient_failures.push({
          assignee_profile_id: bucket.assignee_profile_id,
          email: bucket.email,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    errMsg = e instanceof Error ? e.message : String(e);
  }

  const auditRow: AuditRow = {
    id: 'tsr-' + uuidLike(),
    run_mode: mode as 'cron' | 'admin',
    recipients_sent,
    recipients_skipped,
    total_open_instances,
    total_completed_instances,
    per_recipient_failures,
    error_message: errMsg,
  };
  await writeAuditRow(svc, auditRow);

  if (errMsg) {
    return jsonResponse(
      {
        ok: false,
        error: errMsg,
        recipients_sent,
        recipients_skipped,
        total_open_instances,
        total_completed_instances,
        per_recipient_failures,
      },
      500,
    );
  }
  return jsonResponse({
    ok: true,
    recipients_sent,
    recipients_skipped,
    total_open_instances,
    total_completed_instances,
    per_recipient_failures,
  });
});
