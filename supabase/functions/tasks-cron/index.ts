// ============================================================================
// supabase/functions/tasks-cron — Tasks Module v1 Phase B generator.
// ----------------------------------------------------------------------------
// Deploy:
//   supabase functions deploy tasks-cron --project-ref <project-ref>
//
// Two callers (locked in plan rev 3):
//   1. cron — pg_cron job invoked by mig 039's daily 04:00 UTC schedule via
//      `public.invoke_tasks_cron()` which reads three Vault secrets and posts
//      to this function with:
//        Authorization: Bearer <TASKS_CRON_SERVICE_ROLE_KEY from vault>
//        x-cron-secret: <TASKS_CRON_SECRET from vault>
//        body: {"mode":"cron"}
//   2. admin — manual "Run Cron Now" path. The caller's user JWT is in
//      Authorization; the function verifies admin role via rpc('is_admin').
//        Authorization: Bearer <user JWT>
//        body: {"mode":"admin"}
//
// Auth boundary, in order:
//   - cron mode requires Authorization to equal env.TASKS_CRON_SERVICE_ROLE_KEY
//     AND x-cron-secret to equal env.TASKS_CRON_SECRET (constant-time-ish
//     length-then-byte compare). body.mode must be 'cron'.
//     (env.TASKS_CRON_SERVICE_ROLE_KEY holds the legacy 219-char JWT;
//     env.SUPABASE_SERVICE_ROLE_KEY on new projects auto-injects as the
//     41-char sb_secret_* format which doesn't match the bearer Vault sends.)
//   - admin mode requires the rpc('is_admin') call (using the caller's JWT)
//     to return strict === true. body.mode must be 'admin'.
//   - Anything else (including mode-spoof attempts) → 401, no audit row.
//
// Probe shortcut:
//   body.probe === true after auth passes → write a single tcr-probe-* row
//   to task_cron_runs and return immediately. No template work. Used by
//   scripts/probe_tasks_cron_function.cjs to verify deploy + auth wiring.
//
// Algorithm (probe=false):
//   For each active template:
//     dates    = dueDatesThrough(template, today + 3 days)
//     existing = SELECT due_date FROM task_instances WHERE template_id = $1
//     missing  = canonical \ existing
//     if missing.length > 90 → push {template_id, horizon_size, capped_at:90}
//                              into cap_exceeded; SKIP this template.
//     else → rpc('generate_task_instances', {p_template_id, p_dates: missing})
//            inserted = rpc return value; generated += inserted;
//            skipped  += missing.length - inserted (race losses).
//   INSERT one task_cron_runs row at the end (or on error, with
//   error_message set + counts up to that point).
//
// Locked design notes:
//   - generate_task_instances RPC owns the partial-unique-index ON CONFLICT
//     DO NOTHING contract. The function never executes raw INSERTs against
//     task_instances.
//   - Children (task_instances rows) have NULL client_submission_id; only
//     the RPC/template owns idempotency.
//   - Three-layer audit (cron.job_run_details / net._http_response /
//     task_cron_runs). This function only writes the third layer.
// ============================================================================

import {serve} from 'https://deno.land/std@0.168.0/http/server.ts';
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2';
import {dueDatesThrough} from '../_shared/tasksRecurrence.js';

// Defensive trim: paste-deploy of secrets in Dashboard often picks up a trailing
// newline or space; safeEqual is exact-byte so we normalize at load time.
function envTrim(name: string): string {
  return (Deno.env.get(name) ?? '').replace(/^\s+|\s+$/g, '');
}
const SUPABASE_URL = envTrim('SUPABASE_URL');
const SUPABASE_ANON_KEY = envTrim('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = envTrim('SUPABASE_SERVICE_ROLE_KEY');
const TASKS_CRON_SECRET = envTrim('TASKS_CRON_SECRET');
// Legacy JWT for cron-bearer compare. Supabase's auto-injected SUPABASE_SERVICE_ROLE_KEY
// is now the new 41-char sb_secret_* format on new projects, but cron sends the
// 219-char legacy JWT from Vault. Compare against this dedicated secret instead.
const TASKS_CRON_SERVICE_ROLE_KEY = envTrim('TASKS_CRON_SERVICE_ROLE_KEY');

// CORS — must allow the headers cron + admin paths send. Codex amendment
// rev 3: include authorization, content-type, and x-cron-secret explicitly
// so OPTIONS preflight succeeds in any browser-driven probe.
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
// hides obvious length-leak signal. The TASKS_CRON_SECRET is a 96-char hex
// string from gen_random_bytes(48); brute-forcing per-request is infeasible.
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
  // 'tcr-<random>' / 'ti-<random>' style. Deno has crypto.randomUUID; we strip
  // dashes for grep-friendliness. Not used as PK on task_instances (the RPC
  // mints those server-side).
  return crypto.randomUUID().replace(/-/g, '');
}

function utcDatePlusISO(days: number): string {
  const now = new Date();
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
  const y = utc.getUTCFullYear();
  const m = utc.getUTCMonth() + 1;
  const d = utc.getUTCDate();
  return `${y}-${m < 10 ? '0' + m : m}-${d < 10 ? '0' + d : d}`;
}

function todayISO(): string {
  return utcDatePlusISO(0);
}

function todayPlus3ISO(): string {
  // UTC date math. Cron fires at 04:00 UTC; "today + 3 days" = 4 anchored
  // dates ahead of run time when today is the UTC day at run start.
  return utcDatePlusISO(3);
}

// Bearer parser tolerant of leading "Bearer " prefix.
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
  // anon-key client carrying the user JWT in global headers; rpc('is_admin')
  // resolves auth.uid() inside the SECURITY DEFINER function and returns true
  // only for role='admin' profiles. anon callers / farm_team / management
  // → false.
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
  generated_count: number;
  skipped_count: number;
  cap_exceeded: Array<{template_id: string; horizon_size: number; capped_at: number}>;
  error_message: string | null;
}

async function writeAuditRow(serviceClient: ReturnType<typeof createClient>, row: AuditRow): Promise<void> {
  const {error} = await serviceClient.from('task_cron_runs').insert(row);
  if (error) {
    // We can't write anything else — this is the last-resort audit. Surface
    // via stderr so Edge logs capture it. Cron / probe failure paths still
    // return their HTTP status; the missing audit row is recoverable from
    // net._http_response + cron.job_run_details.
    console.error('writeAuditRow failed:', error.message);
  }
}

// ─── Main handler ────────────────────────────────────────────────────────

// System-rule generation uses real planner stores and the existing
// generate_system_task_instance RPC. lead_time_days controls when the task is
// minted; due_date remains the actual farm event date.
interface SystemRule {
  id: string;
  generator_kind: string;
  lead_time_days: number | string | null;
}

interface SystemEvent {
  rule_id: string;
  due_date: string;
  source_event_key: string;
  // Human-readable batch/group name appended to the task title so a system
  // task is identifiable on its own (e.g. "Broiler 4-week weigh-in - B-26-04").
  entity_label: string;
}

const SYSTEM_APP_STORE_KEYS = ['ppp-v4', 'ppp-feeders-v1', 'ppp-breeding-v1', 'ppp-farrowing-v1'];
const BROODER_DAYS = 14;
const BROILER_4WK_DAYS = 28;
const BROILER_6WK_DAYS = 42;
const PIG_FARROW_START_DAYS = 116;
const PIG_FARROW_END_DAYS = 160;
const PIG_FARROW_BUFFER_DAYS = 14;
const PIG_6MO_DAYS = 180;

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function addDaysISO(iso: string, days: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function leadTimeDays(rule: SystemRule): number {
  const raw = Number(rule && rule.lead_time_days);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

function asObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item),
  );
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value == null) return '';
  return String(value).trim();
}

function numberField(row: Record<string, unknown>, key: string): number {
  const n = Number(row[key]);
  return Number.isFinite(n) ? n : 0;
}

function sourceKeyPart(...values: unknown[]): string {
  for (const value of values) {
    if (value == null) continue;
    const raw = String(value).trim();
    if (!raw) continue;
    const safe = raw.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (safe) return safe;
  }
  return 'unknown';
}

function shouldQueueSystemEvent(rule: SystemRule, event: SystemEvent, today: string): boolean {
  return event.due_date <= addDaysISO(today, leadTimeDays(rule));
}

function broilerHatchDate(batch: Record<string, unknown>): string | null {
  return isoDate(batch.hatchDate) || isoDate(batch.hatch_date);
}

function isBroilerBatchDone(batch: Record<string, unknown>, today: string): boolean {
  const status = stringField(batch, 'status').toLowerCase();
  if (status === 'processed') return true;
  const processingDate = isoDate(batch.processingDate) || isoDate(batch.processing_date);
  return !!processingDate && processingDate <= today && status !== 'planned';
}

function hasStampedBroilerWeight(batch: Record<string, unknown>, field: string): boolean {
  return numberField(batch, field) > 0;
}

function collectBroilerEvents(rule: SystemRule, batches: Array<Record<string, unknown>>, today: string): SystemEvent[] {
  const out: SystemEvent[] = [];
  for (const batch of batches) {
    if (isBroilerBatchDone(batch, today)) continue;
    const hatchDate = broilerHatchDate(batch);
    if (!hatchDate) continue;
    const batchKey = sourceKeyPart(batch.name, batch.batchName, batch.id);
    // Display batch name for the task title (e.g. "B-26-04").
    const entityLabel = stringField(batch, 'name') || stringField(batch, 'batchName') || stringField(batch, 'id');
    let dueDate: string | null = null;
    let sourcePrefix = 'broiler';

    if (rule.generator_kind === 'broiler_4wk_weighin') {
      if (hasStampedBroilerWeight(batch, 'week4Lbs')) continue;
      dueDate = addDaysISO(hatchDate, BROILER_4WK_DAYS);
    } else if (rule.generator_kind === 'broiler_6wk_weighin') {
      if (hasStampedBroilerWeight(batch, 'week6Lbs')) continue;
      dueDate = addDaysISO(hatchDate, BROILER_6WK_DAYS);
    } else if (rule.generator_kind === 'clean_brooder') {
      dueDate = addDaysISO(hatchDate, BROODER_DAYS + 1);
      sourcePrefix = 'brooder';
    }

    if (!dueDate) continue;
    const event = {
      rule_id: rule.id,
      due_date: dueDate,
      source_event_key: `${sourcePrefix}-${batchKey}`,
      entity_label: entityLabel,
    };
    if (shouldQueueSystemEvent(rule, event, today)) out.push(event);
  }
  return out;
}

function isPigBatchDone(row: Record<string, unknown>): boolean {
  const status = stringField(row, 'status').toLowerCase();
  return status === 'processed' || status === 'inactive' || status === 'removed';
}

function firstActualFarrowDate(
  cycle: Record<string, unknown>,
  farrowingRecs: Array<Record<string, unknown>>,
): string | null {
  const group = stringField(cycle, 'group');
  const exposureStart = isoDate(cycle.exposureStart);
  if (!group || !exposureStart) return null;
  const windowStart = addDaysISO(exposureStart, PIG_FARROW_START_DAYS);
  const windowEnd = addDaysISO(exposureStart, PIG_FARROW_END_DAYS + PIG_FARROW_BUFFER_DAYS);
  const dates = farrowingRecs
    .filter((rec) => stringField(rec, 'group') === group)
    .map((rec) => isoDate(rec.farrowingDate))
    .filter((date): date is string => !!date && date >= windowStart && date <= windowEnd)
    .sort();
  return dates[0] || null;
}

function collectPigEvents(
  rule: SystemRule,
  feederGroups: Array<Record<string, unknown>>,
  breedingCycles: Array<Record<string, unknown>>,
  farrowingRecs: Array<Record<string, unknown>>,
  today: string,
): SystemEvent[] {
  if (rule.generator_kind !== 'pig_6mo_weighin') return [];
  const out: SystemEvent[] = [];
  const cyclesById = new Map<string, Record<string, unknown>>();
  for (const cycle of breedingCycles) {
    const id = stringField(cycle, 'id');
    if (id) cyclesById.set(id, cycle);
  }

  for (const group of feederGroups) {
    if (isPigBatchDone(group)) continue;
    const cycleId = stringField(group, 'cycleId');
    if (!cycleId) continue;
    const cycle = cyclesById.get(cycleId);
    if (!cycle) continue;
    const farrowDate = firstActualFarrowDate(cycle, farrowingRecs);
    if (!farrowDate) continue;
    const dueDate = addDaysISO(farrowDate, PIG_6MO_DAYS);
    const subs = asObjectArray(group.subBatches);
    const targets = subs.length > 0 ? subs.filter((sub) => !isPigBatchDone(sub)) : [group];

    for (const target of targets) {
      const targetKey =
        target === group
          ? sourceKeyPart(group.batchName, group.id, cycleId)
          : sourceKeyPart(target.name, target.id, group.batchName, group.id, cycleId);
      // Display batch/sub-batch name for the task title (e.g. "P-26-01-A").
      const entityLabel =
        target === group
          ? stringField(group, 'batchName') || stringField(group, 'id')
          : stringField(target, 'name') || stringField(group, 'batchName') || stringField(group, 'id');
      const event = {
        rule_id: rule.id,
        due_date: dueDate,
        source_event_key: `pig-${targetKey}`,
        entity_label: entityLabel,
      };
      if (shouldQueueSystemEvent(rule, event, today)) out.push(event);
    }
  }
  return out;
}

function collectSystemEvents(rules: SystemRule[], store: Map<string, unknown>, today: string): SystemEvent[] {
  const batches = asObjectArray(store.get('ppp-v4'));
  const feederGroups = asObjectArray(store.get('ppp-feeders-v1'));
  const breedingCycles = asObjectArray(store.get('ppp-breeding-v1'));
  const farrowingRecs = asObjectArray(store.get('ppp-farrowing-v1'));
  const events: SystemEvent[] = [];

  for (const rule of rules) {
    if (
      rule.generator_kind === 'broiler_4wk_weighin' ||
      rule.generator_kind === 'broiler_6wk_weighin' ||
      rule.generator_kind === 'clean_brooder'
    ) {
      events.push(...collectBroilerEvents(rule, batches, today));
    } else if (rule.generator_kind === 'pig_6mo_weighin') {
      events.push(...collectPigEvents(rule, feederGroups, breedingCycles, farrowingRecs, today));
    }
  }

  return events;
}

async function generateSystemTaskInstances(
  serviceClient: ReturnType<typeof createClient>,
  today: string,
): Promise<{generated: number; skipped: number}> {
  const {data: rules, error: rulesErr} = await serviceClient
    .from('task_system_rules')
    .select('id, generator_kind, lead_time_days')
    .eq('active', true);
  if (rulesErr) throw new Error(`select task_system_rules: ${rulesErr.message}`);

  const activeRules = (rules || []) as SystemRule[];
  if (activeRules.length === 0) return {generated: 0, skipped: 0};

  const {data: storeRows, error: storeErr} = await serviceClient
    .from('app_store')
    .select('key, data')
    .in('key', SYSTEM_APP_STORE_KEYS);
  if (storeErr) throw new Error(`select app_store system sources: ${storeErr.message}`);

  const store = new Map<string, unknown>();
  for (const row of storeRows || []) store.set(row.key, row.data);

  const events = collectSystemEvents(activeRules, store, today);
  if (events.length === 0) return {generated: 0, skipped: 0};

  const ruleIds = Array.from(new Set(events.map((event) => event.rule_id)));
  const {data: existingRows, error: existingErr} = await serviceClient
    .from('task_instances')
    .select('from_system_rule_id, from_system_source_event_key')
    .in('from_system_rule_id', ruleIds);
  if (existingErr) throw new Error(`select existing system task_instances: ${existingErr.message}`);

  const existing = new Set(
    (existingRows || []).map(
      (row: {from_system_rule_id: string | null; from_system_source_event_key: string | null}) =>
        `${row.from_system_rule_id || ''}\n${row.from_system_source_event_key || ''}`,
    ),
  );

  let generated = 0;
  let skipped = 0;
  for (const event of events) {
    const key = `${event.rule_id}\n${event.source_event_key}`;
    if (existing.has(key)) {
      skipped += 1;
      continue;
    }

    const {error: rpcErr} = await serviceClient.rpc('generate_system_task_instance', {
      p_rule_id: event.rule_id,
      p_due_date: event.due_date,
      p_source_event_key: event.source_event_key,
      p_entity_label: event.entity_label,
    });
    if (rpcErr) {
      throw new Error(
        `rpc generate_system_task_instance ${event.rule_id}/${event.source_event_key}: ${rpcErr.message}`,
      );
    }
    existing.add(key);
    generated += 1;
  }

  return {generated, skipped};
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {headers: corsHeaders});
  }
  if (req.method !== 'POST') {
    return jsonResponse({ok: false, error: 'method not allowed'}, 405);
  }

  // Parse body. Tolerate empty body for OPTIONS-followed-by-POST clients.
  let body: {mode?: string; probe?: boolean} = {};
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

  // Auth — exactly one path must succeed for the requested mode.
  let authed = false;
  if (mode === 'cron') {
    authed = await authenticateCron(req, mode);
  } else if (mode === 'admin') {
    authed = await authenticateAdmin(req, mode);
  }
  if (!authed) {
    return jsonResponse({ok: false, error: 'unauthorized'}, 401);
  }

  // Service-role client for all writes/reads after auth.
  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {persistSession: false, autoRefreshToken: false},
  });

  // Probe short-circuit. tcr-probe-* rows are deterministically removable
  // by id prefix; PROD probes are real audit per Codex Q4.
  if (body.probe === true) {
    const probeRow: AuditRow = {
      id: 'tcr-probe-' + uuidLike(),
      run_mode: mode as 'cron' | 'admin',
      generated_count: 0,
      skipped_count: 0,
      cap_exceeded: [],
      error_message: 'probe-only invocation',
    };
    await writeAuditRow(svc, probeRow);
    return jsonResponse({ok: true, probe: true, run_mode: mode});
  }

  // Algorithm — generate missing instances for every active template.
  const runTodayISO = todayISO();
  const throughISO = todayPlus3ISO();
  const cap_exceeded: AuditRow['cap_exceeded'] = [];
  let generated_count = 0;
  let skipped_count = 0;
  let errMsg: string | null = null;

  try {
    const {data: templates, error: tErr} = await svc
      .from('task_templates')
      .select('id, recurrence, recurrence_interval, first_due_date, active')
      .eq('active', true);
    if (tErr) throw new Error(`select task_templates: ${tErr.message}`);

    for (const t of templates || []) {
      const canonical = dueDatesThrough(
        {
          recurrence: t.recurrence,
          recurrence_interval: t.recurrence_interval,
          first_due_date: t.first_due_date,
        },
        throughISO,
      );
      if (canonical.length === 0) continue;

      const {data: existingRows, error: eErr} = await svc
        .from('task_instances')
        .select('due_date')
        .eq('template_id', t.id);
      if (eErr) throw new Error(`select task_instances for ${t.id}: ${eErr.message}`);
      const existing = new Set((existingRows || []).map((r: {due_date: string}) => String(r.due_date).slice(0, 10)));
      const missing = canonical.filter((d) => !existing.has(d));
      if (missing.length === 0) continue;

      if (missing.length > 90) {
        cap_exceeded.push({template_id: t.id, horizon_size: missing.length, capped_at: 90});
        // Skip-and-audit (Codex Q1 lock). No partial generation.
        continue;
      }

      const {data: insertedCount, error: rErr} = await svc.rpc('generate_task_instances', {
        p_template_id: t.id,
        p_dates: missing,
      });
      if (rErr) throw new Error(`rpc generate_task_instances ${t.id}: ${rErr.message}`);
      const ins = Number(insertedCount) || 0;
      generated_count += ins;
      skipped_count += missing.length - ins; // race losses + already-existing
    }

    const systemCounts = await generateSystemTaskInstances(svc, runTodayISO);
    generated_count += systemCounts.generated;
    skipped_count += systemCounts.skipped;
  } catch (e) {
    errMsg = e instanceof Error ? e.message : String(e);
  }

  const auditRow: AuditRow = {
    id: 'tcr-' + uuidLike(),
    run_mode: mode as 'cron' | 'admin',
    generated_count,
    skipped_count,
    cap_exceeded,
    error_message: errMsg,
  };
  await writeAuditRow(svc, auditRow);

  if (errMsg) {
    return jsonResponse({ok: false, error: errMsg, generated_count, skipped_count, cap_exceeded}, 500);
  }
  return jsonResponse({ok: true, generated_count, skipped_count, cap_exceeded});
});
