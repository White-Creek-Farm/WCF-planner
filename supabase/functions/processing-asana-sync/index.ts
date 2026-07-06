// ============================================================================
// supabase/functions/processing-asana-sync — Processing Calendar ⇄ Asana mirror.
// ----------------------------------------------------------------------------
// Deploy (NO JWT verification — this fn does its OWN auth, exactly like
// tasks-cron / newsletter-harvest):
//   supabase functions deploy processing-asana-sync --project-ref <ref> --no-verify-jwt
//
// Two callers (mirrors tasks-cron / newsletter-harvest, plan-locked):
//   1. cron  — pg_cron invokes public.invoke_processing_asana_cron() (future
//      migration) which reads the Vault secrets and POSTs:
//        Authorization: Bearer <PROCESSING_ASANA_CRON_SERVICE_ROLE_KEY>
//        x-cron-secret: <PROCESSING_ASANA_CRON_SECRET>
//        body: {"mode":"cron"}
//      Cron ALWAYS pins action='sync_once' (body.action is ignored in cron mode).
//   2. admin — the Processing admin "Sync now / Dry run / Backfill" controls call
//      sb.functions.invoke('processing-asana-sync', {body:{mode:'admin',
//      action:'dry_run'|'sync_once'|'sync_since'|'attachment_backfill', since?}}).
//      The caller's user JWT is in Authorization; verified via rpc('is_admin').
//
// Auth boundary (in order; anything else → 401, no work, no run row):
//   - cron mode:  cronAuthOk(bearer, x-cron-secret,
//                   PROCESSING_ASANA_CRON_SERVICE_ROLE_KEY,
//                   PROCESSING_ASANA_CRON_SECRET) — FAILS CLOSED when either
//                   secret is unconfigured (shared, generic helper).
//   - admin mode: rpc('is_admin') on the caller JWT returns strict === true.
//
// Actions:
//   dry_run            — fetch Asana + diff against stored records. NO writes,
//                        NO sync-run row. Returns {plan}.
//   sync_once          — full sync of every project task (cron pins this).
//   sync_since         — incremental sync of tasks modified since body.since
//                        (ISO timestamp), via Asana modified_since.
//   attachment_backfill— like sync_once but also copies attachment BYTES into
//                        the private 'processing-attachments' Storage bucket
//                        (gated: skipped-with-log until that bucket exists).
//
// ASANA seam:
//   ASANA_ACCESS_TOKEN is a SERVER-ONLY function secret, provisioned SEPARATELY
//   (absent right now). It is read via envTrim and NEVER returned to any caller.
//   While absent, every sync action returns a clear error and the probe reports
//   asanaConfigured:false so the admin UI can show "needs server token" without
//   guessing. asanaGet() pages /tasks (opt_fields + modified_since) and, per
//   task, /tasks/{gid}/subtasks + /stories + /attachments.
//
// DB boundary: ALL writes go through the migration-155 service_role importer
// RPCs (upsert_processing_from_asana / upsert_processing_subtask_from_asana /
// record_processing_attachment / record_processing_import_exception /
// start_processing_sync_run / finish_processing_sync_run). This fn NEVER
// raw-writes the processing_* tables. Per-row failures log + continue so one
// bad task never aborts the batch. The dry_run diff READS processing_records
// with the service-role client (BYPASSRLS) — reads only, never writes.
//
// Pure mapping/classification/diff lives in ../_shared/processingAsanaShape.js
// (Node/vitest unit-tested; byte-shared with this Deno fn).
// ============================================================================

import {serve} from 'https://deno.land/std@0.168.0/http/server.ts';
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2';
import {cronAuthOk} from '../_shared/newsletterCronAuth.js';
import {
  ASANA_PROJECT_GID,
  sectionToProgram,
  indexCustomFields,
  classifyRecordType,
  mapAsanaTaskToProcessingRow,
  mapAsanaSubtask,
  flattenSubtasks,
  isRealComment,
  buildDiffPlan,
} from '../_shared/processingAsanaShape.js';

// Defensive trim: pasted Dashboard secrets often pick up a trailing newline.
function envTrim(name: string): string {
  return (Deno.env.get(name) ?? '').replace(/^\s+|\s+$/g, '');
}
const SUPABASE_URL = envTrim('SUPABASE_URL');
const SUPABASE_ANON_KEY = envTrim('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = envTrim('SUPABASE_SERVICE_ROLE_KEY');
const PROCESSING_ASANA_CRON_SECRET = envTrim('PROCESSING_ASANA_CRON_SECRET');
const PROCESSING_ASANA_CRON_SERVICE_ROLE_KEY = envTrim('PROCESSING_ASANA_CRON_SERVICE_ROLE_KEY');
// Server-only Asana PAT. Absent on TEST/PROD until provisioned → sync actions
// return a clear error; probe reports asanaConfigured:false. NEVER returned.
const ASANA_ACCESS_TOKEN = envTrim('ASANA_ACCESS_TOKEN');

const ASANA_BASE = 'https://app.asana.com/api/1.0';
const ATTACHMENT_BUCKET = 'processing-attachments';

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

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  if (trimmed.toLowerCase().startsWith('bearer ')) return trimmed.slice(7).trim();
  return trimmed;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

async function authenticateCron(req: Request, mode: string): Promise<boolean> {
  if (mode !== 'cron') return false;
  const bearer = extractBearer(req.headers.get('authorization'));
  const cronSecret = (req.headers.get('x-cron-secret') ?? '').replace(/^\s+|\s+$/g, '');
  // Fails closed when either PROCESSING_ASANA_CRON_* secret is unconfigured.
  return cronAuthOk(bearer, cronSecret, PROCESSING_ASANA_CRON_SERVICE_ROLE_KEY, PROCESSING_ASANA_CRON_SECRET);
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

// ─── Asana REST ──────────────────────────────────────────────────────────────

// opt_fields kept explicit so responses are small + stable. section/project are
// resolved from memberships; program derives from the section name.
const TASK_OPT_FIELDS = [
  'name',
  'resource_subtype',
  'completed',
  'completed_at',
  'due_on',
  'due_at',
  'start_on',
  'created_at',
  'modified_at',
  'notes',
  'assignee.name',
  'memberships.project.gid',
  'memberships.project.name',
  'memberships.section.gid',
  'memberships.section.name',
  'custom_fields.name',
  'custom_fields.type',
  'custom_fields.display_value',
  'custom_fields.number_value',
  'custom_fields.text_value',
  'custom_fields.enum_value.name',
  'custom_fields.multi_enum_values.name',
  'custom_fields.date_value.date',
  'custom_fields.date_value.date_time',
].join(',');

const SUBTASK_OPT_FIELDS = ['name', 'assignee.name', 'completed', 'completed_at', 'due_on', 'start_on'].join(',');
const STORY_OPT_FIELDS = ['type', 'text', 'created_at', 'created_by.name'].join(',');
const ATTACH_OPT_FIELDS = ['name', 'resource_subtype', 'download_url', 'view_url', 'created_at', 'size', 'host'].join(
  ',',
);

interface AsanaPage {
  data?: unknown[];
  next_page?: {offset?: string | null} | null;
}

async function asanaGet(path: string, params: Record<string, unknown>): Promise<AsanaPage> {
  if (!ASANA_ACCESS_TOKEN) throw new Error('ASANA_ACCESS_TOKEN not configured');
  const url = new URL(ASANA_BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: {Authorization: `Bearer ${ASANA_ACCESS_TOKEN}`, Accept: 'application/json'},
  });
  if (!res.ok) throw new Error(`asana GET ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as AsanaPage;
}

// Follow Asana's cursor pagination (next_page.offset) to completion.
async function asanaGetAll(path: string, params: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let offset: string | null = null;
  do {
    const page = await asanaGet(path, {...params, limit: 100, ...(offset ? {offset} : {})});
    if (Array.isArray(page.data)) out.push(...(page.data as Record<string, unknown>[]));
    offset = page.next_page && page.next_page.offset ? page.next_page.offset : null;
  } while (offset);
  return out;
}

// Resolve the section this task sits under WITHIN our project (fallback: first).
function resolveSection(task: Record<string, unknown>): {name: string | null; gid: string | null} {
  const memberships = Array.isArray(task.memberships) ? (task.memberships as Record<string, any>[]) : [];
  const inProject = memberships.find((m) => m && m.project && m.project.gid === ASANA_PROJECT_GID);
  const m = inProject || memberships[0];
  const section = m && m.section ? m.section : null;
  return {
    name: section && section.name != null ? String(section.name) : null,
    gid: section && section.gid != null ? String(section.gid) : null,
  };
}

// ─── Attachment byte copy (gated on the storage bucket existing) ─────────────

// Copy one Asana attachment's bytes into the private bucket, then record its
// metadata via the importer RPC. Returns true when a NEW attachment was stored.
// Best-effort: a missing bucket / download failure logs + returns false (the
// caller counts it as skipped, never an abort).
async function backfillAttachment(
  svc: ReturnType<typeof createClient>,
  parentGid: string,
  att: Record<string, any>,
): Promise<boolean> {
  const downloadUrl = att.download_url || att.view_url;
  const gid = att.gid != null ? String(att.gid) : null;
  if (!downloadUrl || !gid) return false;
  try {
    const res = await fetch(String(downloadUrl));
    if (!res.ok) {
      console.error(`attachment ${gid} download ${res.status}`);
      return false;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const filename = att.name != null ? String(att.name) : `attachment-${gid}`;
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const storagePath = `${parentGid}/${gid}-${filename}`;
    const up = await svc.storage.from(ATTACHMENT_BUCKET).upload(storagePath, bytes, {
      contentType,
      upsert: true,
    });
    if (up.error) {
      // Bucket not created yet (gated migration) or an upload error → skip.
      console.error(`attachment ${gid} upload skipped: ${up.error.message}`);
      return false;
    }
    const {error: recErr} = await svc.rpc('record_processing_attachment', {
      p_row: {
        parent_asana_gid: parentGid,
        asana_attachment_gid: gid,
        filename,
        content_type: contentType,
        size_bytes: att.size != null ? Number(att.size) : null,
        storage_path: storagePath,
        source_url: String(downloadUrl),
        original_created_at: att.created_at || null,
      },
    });
    if (recErr) {
      console.error(`record_processing_attachment ${gid}: ${recErr.message}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`attachment ${gid} error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ─── Fetch + map (shared by dry_run and the write actions) ───────────────────

interface MappedTask {
  task: Record<string, unknown>;
  sectionName: string | null;
  sectionGid: string | null;
  program: string | null;
  cfByName: Record<string, unknown>;
  recordType: string;
  row: Record<string, unknown>;
}

// Fetch every project task and map each to its p_row. `sinceISO` (optional)
// requests only tasks modified since that timestamp. Section-header rows
// (resource_subtype 'section') are dropped. No writes.
async function fetchAndMapTasks(sinceISO: string | null, syncRunId: string | null): Promise<MappedTask[]> {
  const tasks = await asanaGetAll('/tasks', {
    project: ASANA_PROJECT_GID,
    opt_fields: TASK_OPT_FIELDS,
    ...(sinceISO ? {modified_since: sinceISO} : {}),
  });
  const out: MappedTask[] = [];
  for (const task of tasks) {
    if (task.resource_subtype === 'section') continue;
    const section = resolveSection(task);
    const program = sectionToProgram(section.name);
    const cfByName = indexCustomFields(task);
    // Match lookups are wired later; classify with the pure rules for now
    // (unmatched-2026 exception routing happens when `matched` is threaded in).
    const recordType = classifyRecordType(task, {sectionName: section.name, program, customFieldsByName: cfByName});
    const row = mapAsanaTaskToProcessingRow(task, {
      sectionName: section.name,
      customFieldsByName: cfByName,
      recordType,
      sectionGid: section.gid,
      syncRunId,
    });
    out.push({task, sectionName: section.name, sectionGid: section.gid, program, cfByName, recordType, row});
  }
  return out;
}

// ─── dry_run ─────────────────────────────────────────────────────────────────

async function runDryRun(svc: ReturnType<typeof createClient>): Promise<Record<string, unknown>> {
  const mapped = await fetchAndMapTasks(null, null);
  // Read the already-stored records (service_role BYPASSRLS) to key the diff.
  const {data: existing, error} = await svc
    .from('processing_records')
    .select(
      'asana_gid, record_type, program, title, processing_date, status, processor, number_processed, customer, asana_section_name, source_kind, source_id',
    )
    .not('asana_gid', 'is', null);
  if (error) throw new Error(`select processing_records: ${error.message}`);
  const nativeByGid: Record<string, unknown> = {};
  for (const r of existing || []) {
    if (r && (r as {asana_gid?: string}).asana_gid) nativeByGid[(r as {asana_gid: string}).asana_gid] = r;
  }
  const plan = buildDiffPlan(
    mapped.map((m) => m.row),
    nativeByGid,
  );
  return {
    tasksFetched: mapped.length,
    wouldInsert: plan.wouldInsert,
    wouldUpdate: plan.wouldUpdate,
    wouldSkip: plan.wouldSkip,
  };
}

// ─── sync (write) ────────────────────────────────────────────────────────────

interface SyncCounts {
  tasks: number;
  recordsInserted: number;
  recordsUpdated: number;
  subtasks: number;
  attachments: number;
  comments: number;
  exceptions: number;
  errors: number;
}

async function runSync(
  svc: ReturnType<typeof createClient>,
  action: string,
  sinceISO: string | null,
  syncRunId: string,
): Promise<SyncCounts> {
  const counts: SyncCounts = {
    tasks: 0,
    recordsInserted: 0,
    recordsUpdated: 0,
    subtasks: 0,
    attachments: 0,
    comments: 0,
    exceptions: 0,
    errors: 0,
  };
  const doAttachments = action === 'sync_once' || action === 'sync_since' || action === 'attachment_backfill';
  const mapped = await fetchAndMapTasks(sinceISO, syncRunId);

  for (const m of mapped) {
    const gid = m.task.gid != null ? String(m.task.gid) : null;
    if (!gid) {
      counts.errors += 1;
      continue;
    }
    try {
      counts.tasks += 1;

      // An unmatched 2026 planner task classified as import_exception is ALSO
      // logged to the exceptions table so the admin triage view can surface it.
      if (m.recordType === 'import_exception') {
        const {error: exErr} = await svc.rpc('record_processing_import_exception', {
          p_row: {
            asana_gid: gid,
            program: m.program,
            title: m.task.name != null ? String(m.task.name) : null,
            reason: 'unmatched 2026 planner task',
            evidence: {section: m.sectionName},
            sync_run_id: syncRunId,
          },
        });
        if (exErr) counts.errors += 1;
        else counts.exceptions += 1;
      }

      const {data: up, error: upErr} = await svc.rpc('upsert_processing_from_asana', {p_row: m.row});
      if (upErr) {
        counts.errors += 1;
        console.error(`upsert_processing_from_asana ${gid}: ${upErr.message}`);
        continue; // no parent record → subtasks/attachments would orphan-fail
      }
      if (up && (up as {action?: string}).action === 'inserted') counts.recordsInserted += 1;
      else counts.recordsUpdated += 1;

      // Subtasks (flattened; parent resolved by asana_gid inside the RPC).
      try {
        const subs = await asanaGetAll(`/tasks/${gid}/subtasks`, {opt_fields: SUBTASK_OPT_FIELDS});
        for (const {subtask, sortOrder} of flattenSubtasks(subs)) {
          const srow = mapAsanaSubtask(subtask, gid, sortOrder);
          const {error: sErr} = await svc.rpc('upsert_processing_subtask_from_asana', {p_row: srow});
          if (sErr) counts.errors += 1;
          else counts.subtasks += 1;
        }
      } catch (e) {
        counts.errors += 1;
        console.error(`subtasks ${gid}: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Comments (stories): fetched + counted here. Persistence into the shared
      // comments layer (entity_type='processing.record') is DEFERRED — migration
      // 155 exposes no service_role comment-import RPC, and we do NOT invent one
      // or a processing_comments table. This is an honest count only.
      try {
        const stories = await asanaGetAll(`/tasks/${gid}/stories`, {opt_fields: STORY_OPT_FIELDS});
        counts.comments += stories.filter((s) => isRealComment(s)).length;
      } catch (e) {
        counts.errors += 1;
        console.error(`stories ${gid}: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Attachments (byte copy is gated on the storage bucket existing).
      if (doAttachments) {
        try {
          const atts = await asanaGetAll(`/tasks/${gid}/attachments`, {opt_fields: ATTACH_OPT_FIELDS});
          for (const att of atts) {
            const stored = await backfillAttachment(svc, gid, att as Record<string, any>);
            if (stored) counts.attachments += 1;
          }
        } catch (e) {
          counts.errors += 1;
          console.error(`attachments ${gid}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      counts.errors += 1;
      console.error(`task ${gid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return counts;
}

// ─── Main handler ────────────────────────────────────────────────────────────

const ACTIONS = new Set(['dry_run', 'sync_once', 'sync_since', 'attachment_backfill']);

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', {headers: corsHeaders});
  if (req.method !== 'POST') return jsonResponse({ok: false, error: 'method not allowed'}, 405);

  let body: {mode?: string; action?: string; since?: string; probe?: boolean} = {};
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

  const authed = mode === 'cron' ? await authenticateCron(req, mode) : await authenticateAdmin(req, mode);
  if (!authed) return jsonResponse({ok: false, error: 'unauthorized'}, 401);

  // Service-role client for all reads/writes AFTER auth.
  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {persistSession: false, autoRefreshToken: false},
  });

  // Probe: reports deploy + auth wiring and whether the Asana token is present
  // (boolean only — the token itself never leaves the function).
  if (body.probe === true) {
    return jsonResponse({ok: true, probe: true, run_mode: mode, asanaConfigured: !!ASANA_ACCESS_TOKEN});
  }

  // cron ALWAYS pins sync_once; admin chooses (default dry_run — the safe read).
  const action = mode === 'cron' ? 'sync_once' : String(body.action || 'dry_run').toLowerCase();
  if (!ACTIONS.has(action)) {
    return jsonResponse({ok: false, error: `action must be one of: ${Array.from(ACTIONS).join(', ')}`}, 400);
  }

  // Every action needs the Asana token. Absent → clear error (probe told the UI).
  if (!ASANA_ACCESS_TOKEN) {
    return jsonResponse({ok: false, error: 'ASANA_ACCESS_TOKEN not configured', asanaConfigured: false}, 503);
  }

  // dry_run: no writes, no sync-run row.
  if (action === 'dry_run') {
    try {
      const plan = await runDryRun(svc);
      return jsonResponse({ok: true, action, plan});
    } catch (e) {
      return jsonResponse({ok: false, action, error: e instanceof Error ? e.message : String(e)}, 500);
    }
  }

  if (action === 'sync_since' && !String(body.since || '').trim()) {
    return jsonResponse({ok: false, error: 'sync_since requires body.since (ISO timestamp)'}, 400);
  }
  const sinceISO = action === 'sync_since' ? String(body.since).trim() : null;

  // Write actions: bracket the work in a sync-run row.
  let runId = '';
  try {
    const {data: run, error: startErr} = await svc.rpc('start_processing_sync_run', {p_action: action});
    if (startErr) throw new Error(`start_processing_sync_run: ${startErr.message}`);
    runId = (run as {id?: string})?.id || '';
    const counts = await runSync(svc, action, sinceISO, runId);
    await svc.rpc('finish_processing_sync_run', {
      p_run_id: runId,
      p_status: 'ok',
      p_counts: counts,
      p_error: null,
    });
    return jsonResponse({ok: true, action, runId, counts});
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (runId) {
      await svc.rpc('finish_processing_sync_run', {p_run_id: runId, p_status: 'error', p_counts: {}, p_error: msg});
    }
    return jsonResponse({ok: false, action, error: msg}, 500);
  }
});
