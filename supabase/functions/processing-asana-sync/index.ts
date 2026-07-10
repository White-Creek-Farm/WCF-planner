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
//   2. admin — the Processing admin controls call
//      sb.functions.invoke('processing-asana-sync', {body:{mode:'admin', action, since?}}).
//      The caller's user JWT is in Authorization; verified via rpc('is_admin').
//
// LOCKED MODEL (migration 157) — Planner is senior; match FIRST. The Asana pass
// NEVER mints planner_batch and never overwrites Planner live facts.
//
// CUTOVER (asana_sync_enabled): enforced HERE for every Asana-touching action —
// once the flag is false, dry runs AND writes fail closed with a clear message;
// only the probe and the planner-only reconcile stay available (native
// Processing + historical reads live in the DB and are unaffected).
//
// DESTINATION SAFETY: destination_audit is the read-only zero-unmapped report
// (every field / enum option / user / section / story type / dependency must
// have a planner destination). Every WRITE action runs a mapping preflight and
// aborts fail-closed when anything is unresolved.
//
// ACTION ISOLATION (explicit boundaries; one dry run never unlocks another
// action's write):
//   probe                       — deploy/auth wiring + asanaConfigured boolean.
//   sync_planner_to_processing  — reconcile only (no Asana, no token).
//   destination_audit           — read-only full live-API destination audit.
//   dry_run                     — read-only record/match preview (no writes).
//   sync_review_queue           — records + links ONLY.
//   comments_dry_run / sync_comments        — comments ONLY (+ mention mapping).
//   artifacts_dry_run / sync_artifacts      — recursive subtasks ONLY.
//   activity_dry_run / sync_activity        — system stories + mention backfill.
//   attachment_dry_run / attachment_backfill — attachment BYTES (the ONLY byte
//                                              copier; sync_once/sync_since can
//                                              no longer copy bytes).
//   sync_once / sync_since      — records + links + subtasks + comments +
//                                 system stories. NEVER attachments.
//   import_templates_dry_run / import_templates — task templates ONLY.
//
// RATE LIMITS: asanaGet honors HTTP 429 Retry-After (retryAfterMs backoff,
// max 5 attempts) and follows offset pagination to completion.
//
// USERS: mapped by STABLE gid/email through the workspace user directory +
// auth.users emails (service role) — never display name alone. Unmatched users
// keep the documented display-name fallback.
//
// DB boundary: ALL writes go through the migration 156/157/164/165 service_role
// RPCs. This fn NEVER raw-writes the processing_* tables. Per-row failures log
// + continue so one bad task never aborts the batch.
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
  isSystemStory,
  mapAsanaSystemStory,
  matchAsanaTaskToPlanner,
  normalizeWcfCode,
  computeDrift,
  buildDryRunReport,
  buildTemplateImportPlan,
  mergeTemplateChecklistAssignees,
  buildUserDirectory,
  mapAsanaUserToProfile,
  parseAsanaMentionProfileIds,
  retryAfterMs,
  buildDestinationAudit,
  buildConversationPlan,
  conversationItemToCommentMediaRow,
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
// Server-only Asana PAT. Absent → Asana actions return a clear error; probe
// reports asanaConfigured:false. NEVER returned.
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
// resolved from memberships; program derives from the section name. Assignee +
// enum gids/colors + dependencies ride along for the user directory / audit.
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
  'assignee.gid',
  'num_subtasks',
  'dependencies.gid',
  'dependents.gid',
  'memberships.project.gid',
  'memberships.project.name',
  'memberships.section.gid',
  'memberships.section.name',
  'custom_fields.gid',
  'custom_fields.name',
  'custom_fields.type',
  'custom_fields.display_value',
  'custom_fields.number_value',
  'custom_fields.text_value',
  'custom_fields.enum_value.gid',
  'custom_fields.enum_value.name',
  'custom_fields.enum_value.color',
  'custom_fields.multi_enum_values.gid',
  'custom_fields.multi_enum_values.name',
  'custom_fields.multi_enum_values.color',
  'custom_fields.date_value.date',
  'custom_fields.date_value.date_time',
].join(',');

const SUBTASK_OPT_FIELDS = [
  'name',
  'assignee.name',
  'assignee.gid',
  'completed',
  'completed_at',
  'due_on',
  'start_on',
  'num_subtasks',
].join(',');
const STORY_OPT_FIELDS = [
  'type',
  'resource_subtype',
  'text',
  'html_text',
  'created_at',
  'created_by.name',
  'created_by.gid',
].join(',');
const ATTACH_OPT_FIELDS = ['name', 'resource_subtype', 'download_url', 'view_url', 'created_at', 'size', 'host'].join(
  ',',
);
const USER_OPT_FIELDS = ['name', 'email'].join(',');
const CF_SETTING_OPT_FIELDS = [
  'custom_field.gid',
  'custom_field.name',
  'custom_field.type',
  'custom_field.resource_subtype',
  'custom_field.enum_options.gid',
  'custom_field.enum_options.name',
  'custom_field.enum_options.color',
].join(',');

// Task-template recipe fields (dot-notation) — the recipe's subtasks are compact
// (name + subtype only) and custom_fields carry name/type/default + colored
// enum options. See mapAsanaTemplateToProcessing in the shared module.
const TEMPLATE_DETAIL_OPT_FIELDS = [
  'name',
  'created_at',
  'created_by.name',
  'project.gid',
  'template.name',
  'template.task_resource_subtype',
  'template.description',
  'template.relative_start_on',
  'template.relative_due_on',
  'template.due_time',
  'template.subtasks.name',
  'template.subtasks.task_resource_subtype',
  'template.custom_fields.gid',
  'template.custom_fields.name',
  'template.custom_fields.type',
  'template.custom_fields.display_value',
  'template.custom_fields.number_value',
  'template.custom_fields.text_value',
  'template.custom_fields.enum_options.gid',
  'template.custom_fields.enum_options.name',
  'template.custom_fields.enum_options.color',
].join(',');

interface AsanaPage {
  data?: unknown[];
  next_page?: {offset?: string | null} | null;
}

// One GET with 429 Retry-After handling (retryAfterMs backoff; max 5 attempts).
async function asanaGet(path: string, params: Record<string, unknown>): Promise<AsanaPage> {
  if (!ASANA_ACCESS_TOKEN) throw new Error('ASANA_ACCESS_TOKEN not configured');
  const url = new URL(ASANA_BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const res = await fetch(url.toString(), {
      headers: {Authorization: `Bearer ${ASANA_ACCESS_TOKEN}`, Accept: 'application/json'},
    });
    if (res.status === 429 && attempt < 5) {
      const waitMs = retryAfterMs(res.headers.get('retry-after'), attempt);
      await res.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (!res.ok) throw new Error(`asana GET ${path} ${res.status}: ${await res.text()}`);
    return (await res.json()) as AsanaPage;
  }
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

// GENUINELY recursive subtask fetch: the direct /subtasks response does NOT
// embed descendants, so any subtask reporting num_subtasks > 0 gets its own
// fetch; children attach as node.subtasks for flattenSubtasks. Depth-capped
// defensively at 5 (the calendar uses 1-2 levels).
async function fetchSubtasksRecursive(gid: string, depth = 0): Promise<Record<string, unknown>[]> {
  const subs = await asanaGetAll(`/tasks/${gid}/subtasks`, {opt_fields: SUBTASK_OPT_FIELDS});
  if (depth >= 5) return subs;
  for (const sub of subs) {
    const childGid = sub && sub.gid != null ? String(sub.gid) : null;
    const n = Number((sub as Record<string, unknown>).num_subtasks ?? 0);
    if (childGid && Number.isFinite(n) && n > 0) {
      (sub as Record<string, unknown>).subtasks = await fetchSubtasksRecursive(childGid, depth + 1);
    }
  }
  return subs;
}

// ─── Directory + profile mapping (stable gid/email identity) ─────────────────

interface MappingContext {
  directory: ReturnType<typeof buildUserDirectory>;
  profilesByEmail: Record<string, string>;
}

// Workspace users via the project's workspace + planner emails via auth.users
// (service role; emails never leave the function).
async function loadMappingContext(svc: ReturnType<typeof createClient>): Promise<MappingContext> {
  const projPage = await asanaGet(`/projects/${ASANA_PROJECT_GID}`, {opt_fields: 'workspace.gid,name'});
  const workspaceGid =
    projPage && (projPage as Record<string, any>).data && (projPage as Record<string, any>).data.workspace
      ? String((projPage as Record<string, any>).data.workspace.gid)
      : null;
  const users = workspaceGid ? await asanaGetAll('/users', {workspace: workspaceGid, opt_fields: USER_OPT_FIELDS}) : [];
  const directory = buildUserDirectory(users);

  const profilesByEmail: Record<string, string> = {};
  let page = 1;
  for (;;) {
    const {data, error} = await svc.auth.admin.listUsers({page, perPage: 200});
    if (error) throw new Error(`auth listUsers: ${error.message}`);
    const list = (data && data.users) || [];
    for (const u of list) {
      if (u && u.email && u.id) profilesByEmail[String(u.email).toLowerCase()] = String(u.id);
    }
    if (list.length < 200) break;
    page += 1;
  }
  return {directory, profilesByEmail};
}

// Fail-closed mapping preflight for every WRITE action: sections + custom-field
// settings + users must all resolve. Throws with the unmapped list on failure.
async function enforceDestinationPreflight(svc: ReturnType<typeof createClient>): Promise<MappingContext> {
  const sections = await asanaGetAll(`/projects/${ASANA_PROJECT_GID}/sections`, {opt_fields: 'name'});
  const cfSettings = await asanaGetAll(`/projects/${ASANA_PROJECT_GID}/custom_field_settings`, {
    opt_fields: CF_SETTING_OPT_FIELDS,
  });
  const ctx = await loadMappingContext(svc);
  const audit = buildDestinationAudit({
    sections,
    customFieldSettings: cfSettings,
    users: Object.values(ctx.directory.byGid),
    profilesByEmail: ctx.profilesByEmail,
  }) as {ok: boolean; unmapped: Array<Record<string, unknown>>};
  if (!audit.ok) {
    const detail = audit.unmapped
      .map((u) => `${u.kind}:${u.name ?? u.id ?? '?'} (${u.reason})`)
      .slice(0, 10)
      .join('; ');
    throw new Error(`destination preflight failed — unresolved destinations: ${detail}`);
  }
  return ctx;
}

// The ONE storage-path convention for Asana attachment bytes — shared by the
// record-level backfill AND the comment-media importer, so the same file can
// never be copied twice under two names.
function asanaAttachmentPath(parentGid: string, gid: string, filename: string): string {
  return `${parentGid}/${gid}-${filename}`;
}

// ─── Attachment byte copy (attachment_backfill ONLY) ─────────────────────────

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
    const storagePath = asanaAttachmentPath(parentGid, gid, filename);
    const up = await svc.storage.from(ATTACHMENT_BUCKET).upload(storagePath, bytes, {
      contentType,
      upsert: true,
    });
    if (up.error) {
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
// archived=false ONLY: a retired row must never be a match candidate.
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

// Already-linked task gids (non-null processing_record_id) — the base set for
// every artifact/comment/activity/attachment import.
async function loadLinkedGids(svc: ReturnType<typeof createClient>): Promise<string[]> {
  const {data, error} = await svc
    .from('processing_asana_links')
    .select('asana_gid, processing_record_id')
    .not('processing_record_id', 'is', null);
  if (error) throw new Error(`load linked rows: ${error.message}`);
  return ((data || []) as Array<{asana_gid: string | null}>).map((l) => l.asana_gid).filter(Boolean) as string[];
}

// The WCF code for a task: from the Name, else the Batch Name (Farms) captured
// in the mapped row's historical_snapshot. Null for pig / uncoded tasks.
function codeForTask(task: Record<string, unknown>, row: Record<string, unknown>): string | null {
  const snap = (row.historical_snapshot || {}) as Record<string, unknown>;
  return normalizeWcfCode(task.name as string) || normalizeWcfCode(snap.batch_name as string) || null;
}

// ─── destination_audit (read-only, full live enumeration) ────────────────────

async function runDestinationAudit(svc: ReturnType<typeof createClient>): Promise<Record<string, unknown>> {
  const sections = await asanaGetAll(`/projects/${ASANA_PROJECT_GID}/sections`, {opt_fields: 'name'});
  const cfSettings = await asanaGetAll(`/projects/${ASANA_PROJECT_GID}/custom_field_settings`, {
    opt_fields: CF_SETTING_OPT_FIELDS,
  });
  const ctx = await loadMappingContext(svc);
  const templates = await asanaGetAll('/task_templates', {project: ASANA_PROJECT_GID, opt_fields: 'name'});
  const tasks = await fetchTasks(null);

  // Recursive enumeration per task: subtasks (genuinely recursive), stories by
  // type, attachments, dependencies. Read-only throughout.
  let subtaskCount = 0;
  let attachmentCount = 0;
  let dependencyCount = 0;
  const storyTypeCounts: Record<string, number> = {};
  for (const t of tasks) {
    if (!t.gid) continue;
    const deps = Array.isArray((t.task as Record<string, unknown>).dependencies)
      ? ((t.task as Record<string, unknown>).dependencies as unknown[]).length
      : 0;
    const depd = Array.isArray((t.task as Record<string, unknown>).dependents)
      ? ((t.task as Record<string, unknown>).dependents as unknown[]).length
      : 0;
    dependencyCount += deps + depd;
    try {
      const subs = await fetchSubtasksRecursive(t.gid);
      subtaskCount += flattenSubtasks(subs).length;
      const stories = await asanaGetAll(`/tasks/${t.gid}/stories`, {opt_fields: STORY_OPT_FIELDS});
      for (const s of stories) {
        const type = s && s.type != null ? String(s.type) : 'unknown';
        storyTypeCounts[type] = (storyTypeCounts[type] || 0) + 1;
      }
      const atts = await asanaGetAll(`/tasks/${t.gid}/attachments`, {opt_fields: 'name'});
      attachmentCount += atts.length;
    } catch (e) {
      console.error(`audit ${t.gid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return buildDestinationAudit({
    sections,
    customFieldSettings: cfSettings,
    users: Object.values(ctx.directory.byGid),
    tasks,
    storyTypeCounts,
    dependencyCount,
    taskTemplates: templates,
    subtaskCount,
    attachmentCount,
    profilesByEmail: ctx.profilesByEmail,
  }) as Record<string, unknown>;
}

// ─── dry_run (read-only match preview) ───────────────────────────────────────

async function runDryRun(svc: ReturnType<typeof createClient>): Promise<Record<string, unknown>> {
  // Read-only review preview: NO reconcile (that writes), NO sync-run row, NO
  // Asana/DB writes. Planner rows are as-of the last reconcile; the classification
  // uses the SAME matcher rules the write path (runSync) applies via the PURE,
  // unit-tested buildDryRunReport.
  const plannerRows = await loadPlannerRows(svc);
  const tasks = await fetchTasks(null);
  return buildDryRunReport(tasks, plannerRows) as Record<string, unknown>;
}

// ─── comments (comments_dry_run / sync_comments) ─────────────────────────────

interface CommentImportCounts {
  linkedTasks: number;
  commentsFound: number;
  inserted: number;
  skipped: number;
  mentionsMapped: number;
  errors: number;
  dryRun: boolean;
}

// Import Asana COMMENTS ONLY for already-linked tasks. Idempotent on
// asana_comment_gid; mentions map to planner profiles via the user directory
// (ctx nullable → mentions skipped, e.g. when the preflight was not run).
// Deliberately does NOT touch subtasks, attachments, Storage, or system stories.
async function runCommentsImport(
  svc: ReturnType<typeof createClient>,
  dryRun: boolean,
  ctx: MappingContext | null,
): Promise<CommentImportCounts> {
  const counts: CommentImportCounts = {
    linkedTasks: 0,
    commentsFound: 0,
    inserted: 0,
    skipped: 0,
    mentionsMapped: 0,
    errors: 0,
    dryRun,
  };
  const gids = await loadLinkedGids(svc);
  for (const gid of gids) {
    counts.linkedTasks += 1;
    try {
      const stories = await asanaGetAll(`/tasks/${gid}/stories`, {opt_fields: STORY_OPT_FIELDS});
      for (const s of stories) {
        if (!isRealComment(s)) continue;
        counts.commentsFound += 1;
        const mentions = ctx ? parseAsanaMentionProfileIds(s.text as string, ctx.directory, ctx.profilesByEmail) : [];
        if (mentions.length > 0) counts.mentionsMapped += 1;
        if (dryRun) continue;
        const c = mapAsanaComment(s);
        const {data, error: cErr} = await svc.rpc('record_processing_comment', {
          p_row: {
            parent_asana_gid: gid,
            asana_comment_gid: c.asana_comment_gid,
            body: c.body,
            original_author_name: c.original_author_name,
            created_at: c.created_at,
            mentions,
          },
        });
        if (cErr) counts.errors += 1;
        else if ((data as {action?: string})?.action === 'inserted') counts.inserted += 1;
        else counts.skipped += 1;
      }
    } catch (e) {
      counts.errors += 1;
      console.error(`comments ${gid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return counts;
}

// ─── subtasks (artifacts_dry_run / sync_artifacts) ───────────────────────────

interface ArtifactsImportCounts {
  linkedTasks: number;
  subtasksFound: number;
  upserted: number;
  errors: number;
  dryRun: boolean;
}

// Recursive-subtask import for already-linked tasks. Local check-offs and local
// assignee ownership are preserved server-side (migs 157/165). NO comments,
// NO attachments, NO Storage.
async function runArtifactsImport(
  svc: ReturnType<typeof createClient>,
  dryRun: boolean,
  ctx: MappingContext | null,
): Promise<ArtifactsImportCounts> {
  const counts: ArtifactsImportCounts = {linkedTasks: 0, subtasksFound: 0, upserted: 0, errors: 0, dryRun};
  const gids = await loadLinkedGids(svc);
  for (const gid of gids) {
    counts.linkedTasks += 1;
    try {
      const subs = await fetchSubtasksRecursive(gid);
      for (const {subtask, sortOrder} of flattenSubtasks(subs)) {
        counts.subtasksFound += 1;
        if (dryRun) continue;
        const p_row = mapAsanaSubtask(subtask, gid, sortOrder) as Record<string, unknown>;
        if (ctx && p_row.assignee_gid) {
          const {profileId} = mapAsanaUserToProfile(String(p_row.assignee_gid), ctx.directory, ctx.profilesByEmail);
          if (profileId) p_row.assignee_profile_id = profileId;
        }
        const {error} = await svc.rpc('upsert_processing_subtask_from_asana', {p_row});
        if (error) counts.errors += 1;
        else counts.upserted += 1;
      }
    } catch (e) {
      counts.errors += 1;
      console.error(`subtasks ${gid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return counts;
}

// ─── system stories + mention backfill (activity_dry_run / sync_activity) ────

interface ActivityImportCounts {
  linkedTasks: number;
  systemStories: number;
  inserted: number;
  skipped: number;
  commentMentionBackfills: number;
  errors: number;
  dryRun: boolean;
}

// Import Asana SYSTEM stories as immutable historical Activity (original
// timestamps, deterministic ids) and re-offer comment mentions so previously
// imported comments gain their profile-mapped mentions.
async function runActivityImport(
  svc: ReturnType<typeof createClient>,
  dryRun: boolean,
  ctx: MappingContext | null,
): Promise<ActivityImportCounts> {
  const counts: ActivityImportCounts = {
    linkedTasks: 0,
    systemStories: 0,
    inserted: 0,
    skipped: 0,
    commentMentionBackfills: 0,
    errors: 0,
    dryRun,
  };
  const gids = await loadLinkedGids(svc);
  for (const gid of gids) {
    counts.linkedTasks += 1;
    try {
      const stories = await asanaGetAll(`/tasks/${gid}/stories`, {opt_fields: STORY_OPT_FIELDS});
      for (const s of stories) {
        if (isSystemStory(s)) {
          counts.systemStories += 1;
          if (dryRun) continue;
          const {data, error} = await svc.rpc('record_processing_history_event', {
            p_row: mapAsanaSystemStory(s, gid),
          });
          if (error) counts.errors += 1;
          else if ((data as {action?: string})?.action === 'inserted') counts.inserted += 1;
          else counts.skipped += 1;
          continue;
        }
        if (isRealComment(s) && ctx) {
          const mentions = parseAsanaMentionProfileIds(s.text as string, ctx.directory, ctx.profilesByEmail);
          if (mentions.length === 0) continue;
          counts.commentMentionBackfills += 1;
          if (dryRun) continue;
          const c = mapAsanaComment(s);
          // record_processing_comment backfills mentions onto an existing
          // imported comment (mig 165) — idempotent, display-only.
          const {error} = await svc.rpc('record_processing_comment', {
            p_row: {
              parent_asana_gid: gid,
              asana_comment_gid: c.asana_comment_gid,
              body: c.body,
              original_author_name: c.original_author_name,
              created_at: c.created_at,
              mentions,
            },
          });
          if (error) counts.errors += 1;
        }
      }
    } catch (e) {
      counts.errors += 1;
      console.error(`activity ${gid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return counts;
}

// ─── attachments (attachment_dry_run / attachment_backfill) ──────────────────

interface AttachmentDryRunCounts {
  linkedTasks: number;
  attachmentsFound: number;
  newAttachments: number;
  alreadyStored: number;
  bucketReady: boolean;
  errors: number;
  dryRun: true;
}

async function runAttachmentDryRun(svc: ReturnType<typeof createClient>): Promise<AttachmentDryRunCounts> {
  const counts: AttachmentDryRunCounts = {
    linkedTasks: 0,
    attachmentsFound: 0,
    newAttachments: 0,
    alreadyStored: 0,
    bucketReady: false,
    errors: 0,
    dryRun: true,
  };

  try {
    const {data: bucket} = await svc.storage.getBucket(ATTACHMENT_BUCKET);
    counts.bucketReady = !!bucket;
  } catch (_e) {
    counts.bucketReady = false;
  }

  const stored = new Set<string>();
  {
    const {data, error} = await svc.from('processing_attachments').select('asana_attachment_gid');
    if (error) throw new Error(`load stored attachments: ${error.message}`);
    for (const r of (data || []) as Array<{asana_attachment_gid: string | null}>) {
      if (r.asana_attachment_gid) stored.add(String(r.asana_attachment_gid));
    }
  }

  const gids = await loadLinkedGids(svc);
  for (const gid of gids) {
    counts.linkedTasks += 1;
    try {
      const atts = await asanaGetAll(`/tasks/${gid}/attachments`, {opt_fields: ATTACH_OPT_FIELDS});
      for (const att of atts) {
        counts.attachmentsFound += 1;
        const a = att as Record<string, unknown>;
        const agid = a && a.gid != null ? String(a.gid) : null;
        if (agid && stored.has(agid)) counts.alreadyStored += 1;
        else counts.newAttachments += 1;
      }
    } catch (e) {
      counts.errors += 1;
      console.error(`attachments ${gid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return counts;
}

interface AttachmentBackfillCounts {
  linkedTasks: number;
  attachmentsFound: number;
  copied: number;
  errors: number;
}

// The ONLY attachment byte-copier. Requires the bucket; idempotent on
// asana_attachment_gid (record_processing_attachment skips stored gids after
// upsert:true refreshes bytes at the same path).
async function runAttachmentBackfill(svc: ReturnType<typeof createClient>): Promise<AttachmentBackfillCounts> {
  const counts: AttachmentBackfillCounts = {linkedTasks: 0, attachmentsFound: 0, copied: 0, errors: 0};
  const {data: bucket} = await svc.storage.getBucket(ATTACHMENT_BUCKET);
  if (!bucket) throw new Error(`storage bucket ${ATTACHMENT_BUCKET} does not exist (gated migration not applied)`);
  const gids = await loadLinkedGids(svc);
  for (const gid of gids) {
    counts.linkedTasks += 1;
    try {
      const atts = await asanaGetAll(`/tasks/${gid}/attachments`, {opt_fields: ATTACH_OPT_FIELDS});
      for (const att of atts) {
        counts.attachmentsFound += 1;
        const storedNow = await backfillAttachment(svc, gid, att as Record<string, any>);
        if (storedNow) counts.copied += 1;
      }
    } catch (e) {
      counts.errors += 1;
      console.error(`attachments ${gid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return counts;
}

// ─── conversation fidelity (comment_media_dry_run / sync_comment_media) ─────

// The B-26-04 acceptance task — its per-item plan is always reported verbatim.
const B2604_TASK_GID = '1211760432273073';

interface CommentMediaCounts {
  linkedTasks: number;
  textComments: number;
  mediaComments: number;
  fileOnlyPosts: number;
  taskAttachments: number;
  alreadyImported: number;
  missingComments: number;
  newMediaBytes: number;
  ambiguous: number;
  deadParents: number;
  commentsWritten: number;
  attachmentRowsWritten: number;
  bytesCopied: number;
  errors: number;
  dryRun: boolean;
}

// Baselines for idempotent classification: every imported comment gid and every
// stored Asana attachment gid (with its existing path/mime for byte reuse).
async function loadConversationBaselines(svc: ReturnType<typeof createClient>): Promise<{
  importedCommentGids: Set<string>;
  storedAttachments: Map<string, {storage_path: string; content_type: string | null}>;
}> {
  const importedCommentGids = new Set<string>();
  {
    const {data, error} = await svc.from('comments').select('asana_comment_gid').not('asana_comment_gid', 'is', null);
    if (error) throw new Error(`load imported comments: ${error.message}`);
    for (const r of (data || []) as Array<{asana_comment_gid: string}>) importedCommentGids.add(r.asana_comment_gid);
  }
  const storedAttachments = new Map<string, {storage_path: string; content_type: string | null}>();
  {
    const {data, error} = await svc
      .from('processing_attachments')
      .select('asana_attachment_gid, storage_path, content_type')
      .not('asana_attachment_gid', 'is', null);
    if (error) throw new Error(`load stored attachments: ${error.message}`);
    for (const r of (data || []) as Array<{
      asana_attachment_gid: string;
      storage_path: string;
      content_type: string | null;
    }>) {
      storedAttachments.set(r.asana_attachment_gid, {storage_path: r.storage_path, content_type: r.content_type});
    }
  }
  return {importedCommentGids, storedAttachments};
}

// Shared walker for both the dry run and the write: builds each linked task's
// conversation plan; the write additionally copies NEW bytes once and records
// the comment+media atomically via record_processing_comment_media.
async function runCommentMedia(
  svc: ReturnType<typeof createClient>,
  dryRun: boolean,
  ctx: MappingContext | null,
): Promise<{counts: CommentMediaCounts; b2604: unknown; ambiguousDetails: unknown[]}> {
  const counts: CommentMediaCounts = {
    linkedTasks: 0,
    textComments: 0,
    mediaComments: 0,
    fileOnlyPosts: 0,
    taskAttachments: 0,
    alreadyImported: 0,
    missingComments: 0,
    newMediaBytes: 0,
    ambiguous: 0,
    deadParents: 0,
    commentsWritten: 0,
    attachmentRowsWritten: 0,
    bytesCopied: 0,
    errors: 0,
    dryRun,
  };
  const {importedCommentGids, storedAttachments} = await loadConversationBaselines(svc);
  const gids = await loadLinkedGids(svc);
  let b2604: unknown = null;
  const ambiguousDetails: unknown[] = [];

  for (const gid of gids) {
    counts.linkedTasks += 1;
    let stories: Record<string, unknown>[];
    let atts: Record<string, unknown>[];
    try {
      stories = await asanaGetAll(`/tasks/${gid}/stories`, {opt_fields: STORY_OPT_FIELDS});
      atts = await asanaGetAll(`/tasks/${gid}/attachments`, {opt_fields: ATTACH_OPT_FIELDS});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/ 404:/.test(msg)) counts.deadParents += 1;
      else counts.errors += 1;
      console.error(`conversation ${gid}: ${msg}`);
      continue;
    }
    const plan = buildConversationPlan({
      stories,
      attachments: atts,
      importedCommentGids,
      storedAttachmentGids: [...storedAttachments.keys()],
    }) as {
      items: Array<Record<string, any>>;
      ambiguous: Array<Record<string, unknown>>;
      counts: Record<string, number>;
    };
    counts.textComments += plan.counts.textComments;
    counts.mediaComments += plan.counts.mediaComments;
    counts.fileOnlyPosts += plan.counts.fileOnlyPosts;
    counts.taskAttachments += plan.counts.taskAttachments;
    counts.alreadyImported += plan.counts.alreadyImported;
    counts.missingComments += plan.counts.missingComments;
    counts.newMediaBytes += plan.counts.newMediaBytes;
    counts.ambiguous += plan.counts.ambiguous;
    for (const a of plan.ambiguous) ambiguousDetails.push({taskGid: gid, ...a});

    if (gid === B2604_TASK_GID) {
      b2604 = {taskGid: gid, plan: plan.items, counts: plan.counts, ambiguous: plan.ambiguous};
    }
    if (dryRun) continue;

    // WRITE: only conversation media items (text comments stay sync_comments').
    const attsByGid = new Map<string, Record<string, unknown>>();
    for (const a of atts) if (a && a.gid != null) attsByGid.set(String(a.gid), a);
    for (const item of plan.items) {
      if (item.kind !== 'media_comment' && item.kind !== 'file_only_post') continue;
      try {
        const mentions = ctx
          ? parseAsanaMentionProfileIds(String(item.body || ''), ctx.directory, ctx.profilesByEmail)
          : [];
        const row = conversationItemToCommentMediaRow(
          item,
          gid,
          attsByGid,
          (attGid: string, filename: string) => asanaAttachmentPath(gid, attGid, filename),
          mentions,
        ) as Record<string, any>;
        // Bytes: copy each NEW attachment once; reuse the stored path/mime for
        // already-copied files (attachment_backfill compatibility).
        let mediaReady = true;
        for (const meta of row.attachments as Array<Record<string, any>>) {
          const attGid = String(meta.asana_attachment_gid);
          const known = storedAttachments.get(attGid);
          if (known) {
            meta.storage_path = known.storage_path;
            meta.content_type = known.content_type;
            continue;
          }
          const att = attsByGid.get(attGid) as Record<string, any> | undefined;
          const downloadUrl = att && (att.download_url || att.view_url);
          if (!downloadUrl) {
            counts.errors += 1;
            mediaReady = false;
            console.error(`comment media ${attGid}: no download URL`);
            break;
          }
          const res = await fetch(String(downloadUrl));
          if (!res.ok) {
            counts.errors += 1;
            console.error(`comment media ${attGid} download ${res.status}`);
            mediaReady = false;
            break;
          }
          const bytes = new Uint8Array(await res.arrayBuffer());
          const contentType = res.headers.get('content-type') || 'application/octet-stream';
          const up = await svc.storage.from(ATTACHMENT_BUCKET).upload(meta.storage_path, bytes, {
            contentType,
            upsert: true,
          });
          if (up.error) {
            counts.errors += 1;
            console.error(`comment media ${attGid} upload: ${up.error.message}`);
            mediaReady = false;
            break;
          }
          meta.content_type = contentType;
          counts.bytesCopied += 1;
          storedAttachments.set(attGid, {storage_path: meta.storage_path, content_type: contentType});
        }
        // Never create a comment/attachment row whose metadata points at a
        // missing object. Any bytes copied before a later file failed are safe
        // retryable orphans at the deterministic upsert path; the next run
        // repairs the whole item before the atomic DB recorder is called.
        if (!mediaReady) continue;
        const {data, error} = await svc.rpc('record_processing_comment_media', {p_row: row});
        if (error) {
          counts.errors += 1;
          console.error(`record_processing_comment_media ${item.storyGid}: ${error.message}`);
          continue;
        }
        const result = data as {comment_action?: string; attachments_inserted?: number};
        if (result?.comment_action === 'inserted' || result?.comment_action === 'enriched') {
          counts.commentsWritten += 1;
        }
        counts.attachmentRowsWritten += Number(result?.attachments_inserted || 0);
        if (item.storyGid) importedCommentGids.add(String(item.storyGid));
      } catch (e) {
        counts.errors += 1;
        console.error(`comment media ${gid}/${item.storyGid}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return {counts, b2604, ambiguousDetails};
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
  systemStories: number;
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

// Import subtasks + comments + SYSTEM stories for a LINKED task. Parent is
// resolved via the link inside each RPC. NEVER attachments — bytes move only
// through the dedicated attachment_backfill action.
async function importArtifacts(
  svc: ReturnType<typeof createClient>,
  gid: string,
  ctx: MappingContext | null,
  counts: SyncCounts,
): Promise<void> {
  // Subtasks (genuinely recursive, flattened parent-first).
  try {
    const subs = await fetchSubtasksRecursive(gid);
    for (const {subtask, sortOrder} of flattenSubtasks(subs)) {
      const p_row = mapAsanaSubtask(subtask, gid, sortOrder) as Record<string, unknown>;
      if (ctx && p_row.assignee_gid) {
        const {profileId} = mapAsanaUserToProfile(String(p_row.assignee_gid), ctx.directory, ctx.profilesByEmail);
        if (profileId) p_row.assignee_profile_id = profileId;
      }
      const {error} = await svc.rpc('upsert_processing_subtask_from_asana', {p_row});
      if (error) counts.errors += 1;
      else counts.subtasks += 1;
    }
  } catch (e) {
    counts.errors += 1;
    console.error(`subtasks ${gid}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Stories: comments (with mapped mentions) + system history (original
  // timestamps, deterministic ids). Skipped duplicates aren't counted as new.
  try {
    const stories = await asanaGetAll(`/tasks/${gid}/stories`, {opt_fields: STORY_OPT_FIELDS});
    for (const s of stories) {
      if (isRealComment(s)) {
        const c = mapAsanaComment(s);
        const mentions = ctx ? parseAsanaMentionProfileIds(s.text as string, ctx.directory, ctx.profilesByEmail) : [];
        const {data, error} = await svc.rpc('record_processing_comment', {
          p_row: {
            parent_asana_gid: gid,
            asana_comment_gid: c.asana_comment_gid,
            body: c.body,
            original_author_name: c.original_author_name,
            created_at: c.created_at,
            mentions,
          },
        });
        if (error) counts.errors += 1;
        else if ((data as {action?: string})?.action === 'inserted') counts.comments += 1;
        continue;
      }
      if (isSystemStory(s)) {
        const {data, error} = await svc.rpc('record_processing_history_event', {
          p_row: mapAsanaSystemStory(s, gid),
        });
        if (error) counts.errors += 1;
        else if ((data as {action?: string})?.action === 'inserted') counts.systemStories += 1;
      }
    }
  } catch (e) {
    counts.errors += 1;
    console.error(`stories ${gid}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function runSync(
  svc: ReturnType<typeof createClient>,
  action: string,
  sinceISO: string | null,
  syncRunId: string,
  reviewOnly = false,
  ctx: MappingContext | null = null,
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
    systemStories: 0,
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

  // (3) Fetch every Asana task and (4/5) match → link → import artifacts.
  // reviewOnly (sync_review_queue) imports records + links ONLY.
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
      }) as Record<string, unknown>;
      if (ctx && row.assignee_gid) {
        const {profileId} = mapAsanaUserToProfile(String(row.assignee_gid), ctx.directory, ctx.profilesByEmail);
        if (profileId) row.assignee_profile_id = profileId;
      }
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
        if (!reviewOnly) await importArtifacts(svc, gid, ctx, counts);
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
        if (!reviewOnly) await importArtifacts(svc, gid, ctx, counts);
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
        if (!reviewOnly) await importArtifacts(svc, gid, ctx, counts);
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
      if (!reviewOnly) await importArtifacts(svc, gid, ctx, counts);
    } catch (e) {
      counts.errors += 1;
      console.error(`task ${gid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return counts;
}

// ─── Task-template import ────────────────────────────────────────────────────

// A caller-JWT client so template WRITES run as the admin user (auth.uid()
// present) — upsert_processing_template is admin-gated, so the service-role
// client cannot call it. Returns null when there's no Authorization header.
function userClientFromReq(req: Request): ReturnType<typeof createClient> | null {
  const authHeader = req.headers.get('authorization');
  if (!authHeader) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {persistSession: false, autoRefreshToken: false},
    global: {headers: {Authorization: authHeader}},
  });
}

// Fetch every task template on the SF Processing Calendar project, then GET each
// one's full recipe (subtasks + custom fields incl. option colors). Read-only.
async function fetchAsanaTemplates(): Promise<Record<string, unknown>[]> {
  const compact = await asanaGetAll('/task_templates', {project: ASANA_PROJECT_GID, opt_fields: 'name'});
  const out: Record<string, unknown>[] = [];
  for (const c of compact) {
    const gid = c && (c as Record<string, unknown>).gid;
    if (gid == null) continue;
    const page = await asanaGet(`/task_templates/${gid}`, {opt_fields: TEMPLATE_DETAIL_OPT_FIELDS});
    const rec = (page as unknown as {data?: unknown}).data;
    if (rec && typeof rec === 'object') out.push(rec as Record<string, unknown>);
  }
  return out;
}

// Active processing_templates keyed by program (service-role read, BYPASSRLS) —
// the idempotency baseline for the import plan.
async function loadActiveTemplatesByProgram(
  svc: ReturnType<typeof createClient>,
): Promise<Record<string, {fields: unknown; checklist: unknown}>> {
  const {data, error} = await svc
    .from('processing_templates')
    .select('program, fields, checklist')
    .eq('is_active', true);
  if (error) throw new Error(`load active templates: ${error.message}`);
  const out: Record<string, {fields: unknown; checklist: unknown}> = {};
  for (const row of Array.isArray(data) ? (data as Record<string, unknown>[]) : []) {
    if (row && row.program) out[String(row.program)] = {fields: row.fields, checklist: row.checklist};
  }
  return out;
}

// Read-only preview (apply=false) or admin write (apply=true). The write upserts
// ONLY 'ready' items via the caller's admin JWT, MERGING the active template's
// checklist assignees by label (the Asana template API cannot carry assignees,
// so planner-side assignments survive a re-import).
async function runTemplateImport(
  svc: ReturnType<typeof createClient>,
  userClient: ReturnType<typeof createClient> | null,
  apply: boolean,
): Promise<Record<string, unknown>> {
  const raw = await fetchAsanaTemplates();
  const activeByProgram = await loadActiveTemplatesByProgram(svc);
  const plan = buildTemplateImportPlan(raw, activeByProgram) as {
    items: Array<Record<string, unknown>>;
    summary: Record<string, number>;
  };
  if (!apply) return {applied: false, ...plan};

  if (!userClient) throw new Error('admin user client required to write templates');
  const written: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  for (const item of plan.items) {
    if (item.status !== 'ready') continue;
    const active = activeByProgram[String(item.program)] || null;
    const mergedChecklist = mergeTemplateChecklistAssignees(
      item.checklist as unknown[],
      active ? (active.checklist as unknown[]) : [],
    );
    const {data, error} = await userClient.rpc('upsert_processing_template', {
      p_program: item.program,
      p_fields: item.fields,
      p_checklist: mergedChecklist,
    });
    if (error) errors.push({program: item.program, error: error.message});
    else written.push({program: item.program, version: (data as {version?: number})?.version ?? null});
  }
  return {applied: true, written, errors, summary: plan.summary};
}

// ─── Main handler ────────────────────────────────────────────────────────────

const ACTIONS = new Set([
  'destination_audit',
  'dry_run',
  'sync_planner_to_processing',
  'sync_review_queue',
  'comments_dry_run',
  'sync_comments',
  'comment_media_dry_run',
  'sync_comment_media',
  'artifacts_dry_run',
  'sync_artifacts',
  'activity_dry_run',
  'sync_activity',
  'sync_once',
  'sync_since',
  'attachment_backfill',
  'attachment_dry_run',
  'import_templates_dry_run',
  'import_templates',
]);

// Every write action runs the fail-closed destination preflight first.
const WRITE_ACTIONS = new Set([
  'sync_review_queue',
  'sync_comments',
  'sync_comment_media',
  'sync_artifacts',
  'sync_activity',
  'sync_once',
  'sync_since',
  'attachment_backfill',
  'import_templates',
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

  // Planner-only reconcile: no Asana fetch, no token, no sync-run row, and
  // AVAILABLE AFTER CUTOVER (it never touches Asana).
  if (action === 'sync_planner_to_processing') {
    try {
      const {data, error} = await svc.rpc('reconcile_planner_to_processing');
      if (error) throw new Error(error.message);
      return jsonResponse({ok: true, action, reconcile: data});
    } catch (e) {
      return jsonResponse({ok: false, action, error: e instanceof Error ? e.message : String(e)}, 500);
    }
  }

  // CUTOVER ENFORCEMENT: asana_sync_enabled=false locks EVERY remaining action
  // (they all touch Asana) — reads and writes alike fail closed.
  try {
    const {data: settings, error: setErr} = await svc
      .from('processing_asana_sync_settings')
      .select('asana_sync_enabled')
      .eq('id', 'singleton')
      .maybeSingle();
    if (setErr) throw new Error(setErr.message);
    if (!settings || settings.asana_sync_enabled !== true) {
      return jsonResponse(
        {ok: false, action, error: 'asana_sync_enabled is false — Asana sync/import is locked (final cutover)'},
        423,
      );
    }
  } catch (e) {
    return jsonResponse(
      {ok: false, action, error: `could not verify asana_sync_enabled: ${e instanceof Error ? e.message : String(e)}`},
      500,
    );
  }

  // Every remaining action needs the token. Absent → clear error.
  if (!ASANA_ACCESS_TOKEN) {
    return jsonResponse({ok: false, error: 'ASANA_ACCESS_TOKEN not configured', asanaConfigured: false}, 503);
  }

  // Fail-closed destination preflight before ANY write import; the mapping
  // context doubles as the user directory for assignee/mention resolution.
  let ctx: MappingContext | null = null;
  if (WRITE_ACTIONS.has(action)) {
    try {
      ctx = await enforceDestinationPreflight(svc);
    } catch (e) {
      return jsonResponse({ok: false, action, error: e instanceof Error ? e.message : String(e)}, 409);
    }
  }

  // destination_audit: the full read-only zero-unmapped enumeration.
  if (action === 'destination_audit') {
    try {
      const report = await runDestinationAudit(svc);
      return jsonResponse({ok: true, action, report});
    } catch (e) {
      return jsonResponse({ok: false, action, error: e instanceof Error ? e.message : String(e)}, 500);
    }
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

  // Read-only per-lane dry runs (no DB writes, no sync-run rows). Each loads
  // the mapping context best-effort so mention/assignee counts are real.
  if (action === 'comments_dry_run' || action === 'artifacts_dry_run' || action === 'activity_dry_run') {
    try {
      let dryCtx: MappingContext | null = null;
      try {
        dryCtx = await loadMappingContext(svc);
      } catch (_e) {
        dryCtx = null;
      }
      const report =
        action === 'comments_dry_run'
          ? await runCommentsImport(svc, true, dryCtx)
          : action === 'artifacts_dry_run'
            ? await runArtifactsImport(svc, true, dryCtx)
            : await runActivityImport(svc, true, dryCtx);
      return jsonResponse({ok: true, action, report});
    } catch (e) {
      return jsonResponse({ok: false, action, error: e instanceof Error ? e.message : String(e)}, 500);
    }
  }

  // comment_media_dry_run: read-only conversation-fidelity plan — per-task
  // classification, the exact B-26-04 plan, ambiguity, and idempotency deltas.
  if (action === 'comment_media_dry_run') {
    try {
      let dryCtx: MappingContext | null = null;
      try {
        dryCtx = await loadMappingContext(svc);
      } catch (_e) {
        dryCtx = null;
      }
      const {counts, b2604, ambiguousDetails} = await runCommentMedia(svc, true, dryCtx);
      return jsonResponse({ok: true, action, report: {...counts, b2604, ambiguousDetails}});
    } catch (e) {
      return jsonResponse({ok: false, action, error: e instanceof Error ? e.message : String(e)}, 500);
    }
  }

  // attachment_dry_run: read-only preview of the attachment byte-copy.
  if (action === 'attachment_dry_run') {
    try {
      const report = await runAttachmentDryRun(svc);
      return jsonResponse({ok: true, action, report});
    } catch (e) {
      return jsonResponse({ok: false, action, error: e instanceof Error ? e.message : String(e)}, 500);
    }
  }

  // import_templates_dry_run: read-only preview of the Asana task-template import.
  if (action === 'import_templates_dry_run') {
    try {
      const report = await runTemplateImport(svc, null, false);
      return jsonResponse({ok: true, action, report});
    } catch (e) {
      return jsonResponse({ok: false, action, error: e instanceof Error ? e.message : String(e)}, 500);
    }
  }

  // WRITE actions from here down — every one bracketed in a sync-run row.
  const startRun = async (): Promise<string> => {
    const {data: run, error: startErr} = await svc.rpc('start_processing_sync_run', {p_action: action});
    if (startErr) throw new Error(`start_processing_sync_run: ${startErr.message}`);
    return (run as {id?: string})?.id || '';
  };
  const finishRun = async (runId: string, status: string, counts: object, error: string | null) => {
    if (!runId) return;
    await svc.rpc('finish_processing_sync_run', {
      p_run_id: runId,
      p_status: status,
      p_counts: counts,
      p_error: error,
    });
  };

  // import_templates: admin write via the caller's JWT.
  if (action === 'import_templates') {
    if (mode !== 'admin') return jsonResponse({ok: false, error: 'import_templates is admin-only'}, 403);
    const userClient = userClientFromReq(req);
    let tRunId = '';
    try {
      tRunId = await startRun();
      const report = await runTemplateImport(svc, userClient, true);
      await finishRun(tRunId, 'ok', (report.summary as Record<string, number>) || {}, null);
      return jsonResponse({ok: true, action, runId: tRunId, report});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await finishRun(tRunId, 'error', {}, msg);
      return jsonResponse({ok: false, action, error: msg}, 500);
    }
  }

  // sync_comments: COMMENTS ONLY (record_processing_comment; mentions mapped).
  if (action === 'sync_comments') {
    let runId = '';
    try {
      runId = await startRun();
      const counts = await runCommentsImport(svc, false, ctx);
      await finishRun(runId, 'ok', counts, null);
      return jsonResponse({ok: true, action, runId, counts});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await finishRun(runId, 'error', {}, msg);
      return jsonResponse({ok: false, action, error: msg}, 500);
    }
  }

  // sync_comment_media: the ONLY action that copies + associates COMMENT media
  // bytes (attachment_backfill stays record-level and byte-compatible via the
  // shared path convention + gid skip).
  if (action === 'sync_comment_media') {
    let runId = '';
    try {
      runId = await startRun();
      const {counts, b2604, ambiguousDetails} = await runCommentMedia(svc, false, ctx);
      await finishRun(runId, 'ok', counts, null);
      return jsonResponse({ok: true, action, runId, counts, b2604, ambiguousDetails});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await finishRun(runId, 'error', {}, msg);
      return jsonResponse({ok: false, action, error: msg}, 500);
    }
  }

  // sync_artifacts: recursive SUBTASKS ONLY.
  if (action === 'sync_artifacts') {
    let runId = '';
    try {
      runId = await startRun();
      const counts = await runArtifactsImport(svc, false, ctx);
      await finishRun(runId, 'ok', counts, null);
      return jsonResponse({ok: true, action, runId, counts});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await finishRun(runId, 'error', {}, msg);
      return jsonResponse({ok: false, action, error: msg}, 500);
    }
  }

  // sync_activity: SYSTEM stories + comment-mention backfill ONLY.
  if (action === 'sync_activity') {
    let runId = '';
    try {
      runId = await startRun();
      const counts = await runActivityImport(svc, false, ctx);
      await finishRun(runId, 'ok', counts, null);
      return jsonResponse({ok: true, action, runId, counts});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await finishRun(runId, 'error', {}, msg);
      return jsonResponse({ok: false, action, error: msg}, 500);
    }
  }

  // attachment_backfill: the ONLY attachment byte-copier.
  if (action === 'attachment_backfill') {
    let runId = '';
    try {
      runId = await startRun();
      const counts = await runAttachmentBackfill(svc);
      await finishRun(runId, 'ok', counts, null);
      return jsonResponse({ok: true, action, runId, counts});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await finishRun(runId, 'error', {}, msg);
      return jsonResponse({ok: false, action, error: msg}, 500);
    }
  }

  // sync_once / sync_since / sync_review_queue: records + links (+ subtasks /
  // comments / system stories for the full syncs). NEVER attachment bytes.
  if (action === 'sync_since' && !String(body.since || '').trim()) {
    return jsonResponse({ok: false, error: 'sync_since requires body.since (ISO timestamp)'}, 400);
  }
  const sinceISO = action === 'sync_since' ? String(body.since).trim() : null;
  const reviewOnly = action === 'sync_review_queue';

  let runId = '';
  try {
    runId = await startRun();
    const counts = await runSync(svc, action, sinceISO, runId, reviewOnly, ctx);
    await finishRun(runId, 'ok', counts, null);
    return jsonResponse({ok: true, action, runId, counts});
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishRun(runId, 'error', {}, msg);
    return jsonResponse({ok: false, action, error: msg}, 500);
  }
});
