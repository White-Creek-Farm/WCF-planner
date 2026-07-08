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
//   2. admin — the Processing admin "Sync now / Dry run / Backfill / Reconcile
//      planner" controls call sb.functions.invoke('processing-asana-sync',
//      {body:{mode:'admin', action:'dry_run'|'sync_once'|'sync_since'|
//      'attachment_backfill'|'sync_planner_to_processing', since?}}).
//      The caller's user JWT is in Authorization; verified via rpc('is_admin').
//
// Auth boundary (in order; anything else → 401, no work, no run row):
//   - cron mode:  cronAuthOk(bearer, x-cron-secret,
//                   PROCESSING_ASANA_CRON_SERVICE_ROLE_KEY,
//                   PROCESSING_ASANA_CRON_SECRET) — FAILS CLOSED when either
//                   secret is unconfigured (shared, generic helper).
//   - admin mode: rpc('is_admin') on the caller JWT returns strict === true.
//
// LOCKED MODEL (migration 157) — Planner is senior; match FIRST:
//   Every write sync (1) calls reconcile_planner_to_processing() FIRST so the
//   planner_batch rows exist, (2) loads those rows, (3) runs the PURE matcher
//   per top-level Asana task, (4) links via link_asana_to_processing, and (5)
//   imports subtasks/comments/attachments for LINKED rows (parent resolved via
//   the link). The Asana pass NEVER mints planner_batch and never overwrites
//   Planner live facts. Unmatched <2024 → asana_historical; unmatched >=2024 →
//   import_exception; Asana milestone → milestone (excluded from matching);
//   ambiguous (>=2 candidates / Name↔Batch-Name disagreement) → needs_review
//   link with NULL record + candidate_record_ids (defer to manual crosswalk).
//
// Actions:
//   dry_run                    — read-only preview: fetch Asana + run the matcher
//                                against the last-reconciled planner rows. NO
//                                writes, NO reconcile, NO sync-run row.
//   sync_planner_to_processing — ONLY reconcile_planner_to_processing() (no Asana
//                                fetch, no Asana token needed). NO sync-run row.
//   sync_once                  — full sync of every project task (cron pins this).
//   sync_since                 — incremental sync of tasks modified since
//                                body.since (ISO timestamp), via modified_since.
//   attachment_backfill        — like sync_once but also copies attachment BYTES
//                                into the private 'processing-attachments' bucket
//                                (gated: skipped-with-log until that bucket exists).
//
// ASANA seam:
//   ASANA_ACCESS_TOKEN is a SERVER-ONLY function secret, provisioned SEPARATELY
//   (absent right now). It is read via envTrim and NEVER returned to any caller.
//   While absent, every Asana-touching action returns a clear error and the probe
//   reports asanaConfigured:false. asanaGet() pages /tasks (opt_fields +
//   modified_since) and, per task, /subtasks + /stories + /attachments.
//
// DB boundary: ALL writes go through the migration 156/157 service_role RPCs
// (reconcile_planner_to_processing / upsert_processing_from_asana /
// link_asana_to_processing / upsert_processing_subtask_from_asana /
// record_processing_comment / record_processing_attachment /
// start_processing_sync_run / finish_processing_sync_run). This fn NEVER
// raw-writes the processing_* tables. Per-row failures log + continue so one bad
// task never aborts the batch. The dry_run preview READS processing_records with
// the service-role client (BYPASSRLS) — reads only, never writes.
//
// Pure matching/mapping/drift lives in ../_shared/processingAsanaShape.js
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
  mapAsanaComment,
  matchAsanaTaskToPlanner,
  normalizeWcfCode,
  computeDrift,
  buildDryRunReport,
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
// Server-only Asana PAT. Absent on TEST/PROD until provisioned → Asana actions
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
// metadata via the importer RPC (parent resolved via the link). Returns true when
// a NEW attachment was stored. Best-effort: a missing bucket / download failure
// logs + returns false (the caller counts it as skipped, never an abort).
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

// ─── Fetch (shared by dry_run and the write actions) ─────────────────────────

interface FetchedTask {
  task: Record<string, unknown>;
  gid: string | null;
  sectionName: string | null;
  sectionGid: string | null;
  program: string | null;
  cf: Record<string, unknown>;
}

interface PlannerRow {
  id: string;
  program: string | null;
  title: string | null;
  processing_date: string | null;
  status: string | null;
  number_processed: number | null;
  source_kind: string | null;
  source_id: string | null;
  sub_batch_attribution: unknown;
}

// Fetch every project task. `sinceISO` (optional) requests only tasks modified
// since that timestamp. Section-header rows (resource_subtype 'section') are
// dropped. No writes; no classification (the matcher owns that per row).
async function fetchTasks(sinceISO: string | null): Promise<FetchedTask[]> {
  const tasks = await asanaGetAll('/tasks', {
    project: ASANA_PROJECT_GID,
    opt_fields: TASK_OPT_FIELDS,
    ...(sinceISO ? {modified_since: sinceISO} : {}),
  });
  const out: FetchedTask[] = [];
  for (const task of tasks) {
    if (task.resource_subtype === 'section') continue;
    const section = resolveSection(task);
    out.push({
      task,
      gid: task.gid != null ? String(task.gid) : null,
      sectionName: section.name,
      sectionGid: section.gid,
      program: sectionToProgram(section.name),
      cf: indexCustomFields(task) as Record<string, unknown>,
    });
  }
  return out;
}

// Load the reconciled planner_batch rows (service_role BYPASSRLS) for matching.
// archived=false ONLY: reconcile retires stale planner_batch rows (a cleared
// broiler date, a removed pig trip) by archiving them — a retired row must never
// be a match candidate, or Asana could resurrect it.
async function loadPlannerRows(svc: ReturnType<typeof createClient>): Promise<PlannerRow[]> {
  const {data, error} = await svc
    .from('processing_records')
    .select(
      'id, program, title, processing_date, status, number_processed, source_kind, source_id, sub_batch_attribution',
    )
    .eq('record_type', 'planner_batch')
    .eq('archived', false);
  if (error) throw new Error(`load planner_batch rows: ${error.message}`);
  return (data || []) as PlannerRow[];
}

// The WCF code for a task: from the Name, else the Batch Name (Farms) captured
// in the mapped row's historical_snapshot. Null for pig / uncoded tasks.
function codeForTask(task: Record<string, unknown>, row: Record<string, unknown>): string | null {
  const snap = (row.historical_snapshot || {}) as Record<string, unknown>;
  return normalizeWcfCode(task.name as string) || normalizeWcfCode(snap.batch_name as string) || null;
}

// ─── dry_run (read-only match preview) ───────────────────────────────────────

async function runDryRun(svc: ReturnType<typeof createClient>): Promise<Record<string, unknown>> {
  // Read-only review preview: NO reconcile (that writes), NO sync-run row, NO
  // Asana/DB writes. Planner rows are as-of the last reconcile; the classification
  // uses the SAME matcher rules the write path (runSync) applies. The full review
  // packet (buckets, review entries, milestones, duplicate/collision report, pig
  // candidates, drift preview) is assembled by the PURE, unit-tested
  // buildDryRunReport so the read preview and the write path can never diverge.
  const plannerRows = await loadPlannerRows(svc);
  const tasks = await fetchTasks(null);
  return buildDryRunReport(tasks, plannerRows) as Record<string, unknown>;
}

// ─── sync (write) ────────────────────────────────────────────────────────────

interface SyncCounts {
  reconcile: {ok?: boolean; cattle?: number; sheep?: number; broiler?: number; pig?: number} | null;
  plannerRows: number;
  tasks: number;
  matched: number;
  historical: number;
  exceptions: number;
  milestones: number;
  needsReview: number;
  subtasks: number;
  comments: number;
  attachments: number;
  errors: number;
}

interface LinkOpts {
  gid: string;
  recordId: string | null;
  program: string | null;
  code: string | null;
  matchStatus: string;
  matchMethod: string;
  confidence: string;
  candidateIds: string[];
  drift: Record<string, unknown>;
  row: Record<string, unknown>;
  syncRunId: string;
}

// Link an Asana task to a (possibly null) Processing record. Seeds processor +
// customer onto the record ONLY on first attach + only if blank (RPC-enforced).
async function link(svc: ReturnType<typeof createClient>, o: LinkOpts): Promise<string | null> {
  const {error} = await svc.rpc('link_asana_to_processing', {
    p_row: {
      asana_gid: o.gid,
      processing_record_id: o.recordId,
      program: o.program,
      asana_batch_code: o.code,
      match_status: o.matchStatus,
      match_method: o.matchMethod,
      confidence: o.confidence,
      candidate_record_ids: o.candidateIds,
      raw_asana_snapshot: o.row.raw_asana_snapshot,
      drift: o.drift,
      seed_processor: o.row.processor,
      seed_customer: o.row.customer,
      sync_run_id: o.syncRunId,
    },
  });
  if (error) {
    console.error(`link_asana_to_processing ${o.gid}: ${error.message}`);
    return error.message;
  }
  return null;
}

// Create an Asana-owned record (asana_historical | import_exception | milestone —
// NEVER planner_batch) then link the task to it. Returns an error string or null.
async function createRecordAndLink(
  svc: ReturnType<typeof createClient>,
  row: Record<string, unknown>,
  recordType: string,
  o: Omit<LinkOpts, 'recordId' | 'row'>,
): Promise<string | null> {
  const p_row = {...row, record_type: recordType, match_status: o.matchStatus, sync_run_id: o.syncRunId};
  const {data: up, error: upErr} = await svc.rpc('upsert_processing_from_asana', {p_row});
  if (upErr) {
    console.error(`upsert_processing_from_asana ${o.gid}: ${upErr.message}`);
    return upErr.message;
  }
  const recordId = (up as {id?: string})?.id || null;
  return link(svc, {...o, recordId, row});
}

// Import subtasks + comments + attachments for a LINKED task. Parent is resolved
// via the link inside each RPC, so this is only called once a link with a
// non-null processing_record_id exists.
async function importArtifacts(
  svc: ReturnType<typeof createClient>,
  gid: string,
  doAttachments: boolean,
  counts: SyncCounts,
): Promise<void> {
  // Subtasks (flattened).
  try {
    const subs = await asanaGetAll(`/tasks/${gid}/subtasks`, {opt_fields: SUBTASK_OPT_FIELDS});
    for (const {subtask, sortOrder} of flattenSubtasks(subs)) {
      const {error} = await svc.rpc('upsert_processing_subtask_from_asana', {
        p_row: mapAsanaSubtask(subtask, gid, sortOrder),
      });
      if (error) counts.errors += 1;
      else counts.subtasks += 1;
    }
  } catch (e) {
    counts.errors += 1;
    console.error(`subtasks ${gid}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Comments (stories) — persisted via record_processing_comment (idempotent on
  // asana_comment_gid; parent resolved via the link). Skipped duplicates aren't
  // counted as new.
  try {
    const stories = await asanaGetAll(`/tasks/${gid}/stories`, {opt_fields: STORY_OPT_FIELDS});
    for (const s of stories) {
      if (!isRealComment(s)) continue;
      const c = mapAsanaComment(s);
      const {data, error} = await svc.rpc('record_processing_comment', {
        p_row: {
          parent_asana_gid: gid,
          asana_comment_gid: c.asana_comment_gid,
          body: c.body,
          original_author_name: c.original_author_name,
          created_at: c.created_at,
        },
      });
      if (error) counts.errors += 1;
      else if ((data as {action?: string})?.action !== 'skipped') counts.comments += 1;
    }
  } catch (e) {
    counts.errors += 1;
    console.error(`stories ${gid}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Attachments (byte copy gated on the storage bucket existing).
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
}

async function runSync(
  svc: ReturnType<typeof createClient>,
  action: string,
  sinceISO: string | null,
  syncRunId: string,
  reviewOnly = false,
): Promise<SyncCounts> {
  const counts: SyncCounts = {
    reconcile: null,
    plannerRows: 0,
    tasks: 0,
    matched: 0,
    historical: 0,
    exceptions: 0,
    milestones: 0,
    needsReview: 0,
    subtasks: 0,
    comments: 0,
    attachments: 0,
    errors: 0,
  };

  // (1) Planner is senior — enumerate the planner_batch rows FIRST so matches
  //     have targets before we touch a single Asana task.
  const {data: rec, error: recErr} = await svc.rpc('reconcile_planner_to_processing');
  if (recErr) throw new Error(`reconcile_planner_to_processing: ${recErr.message}`);
  counts.reconcile = rec as SyncCounts['reconcile'];

  // (2) Load them for matching.
  const plannerRows = await loadPlannerRows(svc);
  counts.plannerRows = plannerRows.length;

  // reviewOnly (sync_review_queue) imports records + links ONLY: no subtasks,
  // comments, attachments, or Storage writes.
  const doAttachments =
    !reviewOnly && (action === 'sync_once' || action === 'sync_since' || action === 'attachment_backfill');

  // (3) Fetch every Asana task and (4/5) match → link → import artifacts.
  const tasks = await fetchTasks(sinceISO);
  for (const t of tasks) {
    const gid = t.gid;
    if (!gid) {
      counts.errors += 1;
      continue;
    }
    try {
      counts.tasks += 1;

      // Base p_row (reused for create-record buckets + seeds + the code).
      const row = mapAsanaTaskToProcessingRow(t.task, {
        sectionName: t.sectionName,
        customFieldsByName: t.cf,
        sectionGid: t.sectionGid,
        syncRunId,
      });
      const program = row.program as string | null;
      const code = codeForTask(t.task, row);
      const base = {gid, program, code, syncRunId};

      // Milestone → its own record + milestone link; EXCLUDED from batch matching.
      if (classifyRecordType(t.task, {sectionName: t.sectionName, program}) === 'milestone') {
        const err = await createRecordAndLink(svc, row, 'milestone', {
          ...base,
          matchStatus: 'milestone',
          matchMethod: 'milestone',
          confidence: 'none',
          candidateIds: [],
          drift: {},
        });
        if (err) {
          counts.errors += 1;
          continue;
        }
        counts.milestones += 1;
        if (!reviewOnly) await importArtifacts(svc, gid, doAttachments, counts);
        continue;
      }

      // Program task → run the deterministic matcher.
      const match = matchAsanaTaskToPlanner(t.task, {program, code, plannerRows, customFieldsByName: t.cf});

      // auto_exact → link to the senior Planner record (NO new record). Compute
      // per-link drift (never applied to the record).
      if (match.method === 'auto_exact' && match.recordId) {
        const plannerRow = plannerRows.find((r) => r.id === match.recordId) || null;
        const drift = computeDrift(t.task, plannerRow, {customFieldsByName: t.cf}) as Record<string, unknown>;
        const err = await link(svc, {
          ...base,
          recordId: match.recordId,
          matchStatus: 'matched',
          matchMethod: 'auto_exact',
          confidence: match.confidence,
          candidateIds: match.candidateIds,
          drift,
          row,
        });
        if (err) {
          counts.errors += 1;
          continue;
        }
        counts.matched += 1;
        if (!reviewOnly) await importArtifacts(svc, gid, doAttachments, counts);
        continue;
      }

      // historical (unmatched, <2024) → asana_historical record + historical link.
      if (match.method === 'historical') {
        const err = await createRecordAndLink(svc, row, 'asana_historical', {
          ...base,
          matchStatus: 'historical',
          matchMethod: 'historical',
          confidence: 'none',
          candidateIds: [],
          drift: {},
        });
        if (err) {
          counts.errors += 1;
          continue;
        }
        counts.historical += 1;
        if (!reviewOnly) await importArtifacts(svc, gid, doAttachments, counts);
        continue;
      }

      // needs_review, AMBIGUOUS (≥2 candidates / Name↔BN disagreement): a senior
      // Planner batch exists — link with a NULL record + candidates and defer to
      // manual crosswalk. NO new record, NO artifact import (link is unresolved).
      if (match.candidateIds.length > 0) {
        const err = await link(svc, {
          ...base,
          recordId: null,
          matchStatus: 'needs_review',
          matchMethod: 'none',
          confidence: match.confidence,
          candidateIds: match.candidateIds,
          drift: {},
          row,
        });
        if (err) counts.errors += 1;
        else counts.needsReview += 1;
        continue;
      }

      // needs_review, NO candidates (unmatched >=2024, or no-year-no-code) →
      // import_exception record so it is visible + artifacts attach.
      const err = await createRecordAndLink(svc, row, 'import_exception', {
        ...base,
        matchStatus: 'needs_review',
        matchMethod: 'none',
        confidence: 'none',
        candidateIds: [],
        drift: {},
      });
      if (err) {
        counts.errors += 1;
        continue;
      }
      counts.exceptions += 1;
      if (!reviewOnly) await importArtifacts(svc, gid, doAttachments, counts);
    } catch (e) {
      counts.errors += 1;
      console.error(`task ${gid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return counts;
}

// ─── Main handler ────────────────────────────────────────────────────────────

const ACTIONS = new Set([
  'dry_run',
  'sync_planner_to_processing',
  'sync_review_queue',
  'sync_once',
  'sync_since',
  'attachment_backfill',
]);

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

  // Planner-only reconcile: no Asana fetch, no token, no sync-run row.
  if (action === 'sync_planner_to_processing') {
    try {
      const {data, error} = await svc.rpc('reconcile_planner_to_processing');
      if (error) throw new Error(error.message);
      return jsonResponse({ok: true, action, reconcile: data});
    } catch (e) {
      return jsonResponse({ok: false, action, error: e instanceof Error ? e.message : String(e)}, 500);
    }
  }

  // Every Asana-touching action needs the token. Absent → clear error (the probe
  // already told the UI).
  if (!ASANA_ACCESS_TOKEN) {
    return jsonResponse({ok: false, error: 'ASANA_ACCESS_TOKEN not configured', asanaConfigured: false}, 503);
  }

  // dry_run: no writes, no reconcile, no sync-run row.
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
  // sync_review_queue = records + links ONLY (reconcile + match + link, no
  // subtasks/comments/attachments, no Storage) — the gated first queue population.
  const reviewOnly = action === 'sync_review_queue';

  // Write actions: bracket the work in a sync-run row.
  let runId = '';
  try {
    const {data: run, error: startErr} = await svc.rpc('start_processing_sync_run', {p_action: action});
    if (startErr) throw new Error(`start_processing_sync_run: ${startErr.message}`);
    runId = (run as {id?: string})?.id || '';
    const counts = await runSync(svc, action, sinceISO, runId, reviewOnly);
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
