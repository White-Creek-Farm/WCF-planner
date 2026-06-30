// ============================================================================
// supabase/functions/newsletter-harvest — Monthly Newsletter CP-B automation.
// ----------------------------------------------------------------------------
// Deploy:
//   supabase functions deploy newsletter-harvest --project-ref <project-ref>
//
// Two callers (mirrors tasks-cron, plan-locked):
//   1. cron  — pg_cron's monthly job invokes public.invoke_newsletter_cron()
//      (mig 146) which reads three Vault secrets and POSTs:
//        Authorization: Bearer <NEWSLETTER_CRON_SERVICE_ROLE_KEY>
//        x-cron-secret: <NEWSLETTER_CRON_SECRET>
//        body: {"mode":"cron"}
//      Cron pre-seeds the current month's issue: ensure issue, harvest facts,
//      mint the coordinated reminder task, and pre-fill the draft WITHOUT
//      clobbering admin edits (overwrite=false).
//   2. admin — the /admin/newsletter "Harvest" / "Generate draft" buttons call
//      sb.functions.invoke('newsletter-harvest', {body:{mode:'admin', issueId,
//      steps:['harvest'|'draft'], overwrite}}). The caller's user JWT is in
//      Authorization; the function verifies admin via rpc('is_admin').
//
// Auth boundary (in order):
//   - cron mode: Authorization === NEWSLETTER_CRON_SERVICE_ROLE_KEY AND
//     x-cron-secret === NEWSLETTER_CRON_SECRET (length-then-byte compare).
//   - admin mode: rpc('is_admin') on the caller JWT returns strict true.
//   - anything else → 401, no work, no audit row.
//
// AI boundary: the provider API key (NEWSLETTER_AI_API_KEY) lives ONLY here,
// never in the browser. The model returns STRUCTURED blocks; output is run
// through validateNewsletterBlocks (shared whitelist) before persistence, so no
// raw HTML / unknown block type can reach the public page. When no key is set,
// the deterministic template composer produces a valid draft so the whole flow
// is testable + shippable without a paid key (run is logged with provider
// 'template'). Detector + composer logic is the byte-identical shared copy in
// ../_shared (parity-locked to src/lib).
//
// All writes go through the mig 146 SECURITY DEFINER RPCs (service_role grant);
// this function never raw-writes the newsletter_* tables.
// ============================================================================

import {serve} from 'https://deno.land/std@0.168.0/http/server.ts';
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2';
import {detectNewsletterFacts} from '../_shared/newsletterFacts.js';
import {
  composeTemplateDraft,
  validateNewsletterBlocks,
  buildNewsletterPrompt,
  sanitizePhotoPlan,
  mergePhotoPlan,
  proposePhotoPlan,
} from '../_shared/newsletterDraft.js';
import {cronAuthOk} from '../_shared/newsletterCronAuth.js';
import {
  computeProductionYoy,
  buildProductionYoyBlocks,
  stripProductionYoyBlocks,
} from '../_shared/newsletterProductionYoy.js';
import {
  shapeHeadCounts,
  shapeBirths,
  shapeEggDailys,
  shapePastureMoves,
  shapeDailySubmissions,
  shapeCompletedTasks,
  shapeProcessingBatches,
  coverageEntry,
} from '../_shared/newsletterHarvestShape.js';

function envTrim(name: string): string {
  return (Deno.env.get(name) ?? '').replace(/^\s+|\s+$/g, '');
}
const SUPABASE_URL = envTrim('SUPABASE_URL');
const SUPABASE_ANON_KEY = envTrim('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = envTrim('SUPABASE_SERVICE_ROLE_KEY');
const NEWSLETTER_CRON_SECRET = envTrim('NEWSLETTER_CRON_SECRET');
const NEWSLETTER_CRON_SERVICE_ROLE_KEY = envTrim('NEWSLETTER_CRON_SERVICE_ROLE_KEY');
// The AI provider seam. Absent on TEST/PROD until the secret is added → the
// function falls back to the deterministic template composer (release blocker:
// add NEWSLETTER_AI_API_KEY + set settings.ai_provider/model to enable real AI).
const NEWSLETTER_AI_API_KEY = envTrim('NEWSLETTER_AI_API_KEY');

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

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

// Current farm-reporting month in UTC ('YYYY-MM'). The cron fires on the 25th,
// so "this month" is the month being reviewed; the admin finalizes early next
// month and can re-harvest after month end.
function currentYearMonthUTC(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`;
}

function periodBounds(yearMonth: string): {yearMonth: string; start: string; end: string} {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!m) return {yearMonth, start: '', end: ''};
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const start = `${y}-${pad2(mo)}-01`;
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // day 0 of next month = last day
  const end = `${y}-${pad2(mo)}-${pad2(lastDay)}`;
  return {yearMonth, start, end};
}

// ─── Auth ──────────────────────────────────────────────────────────────────

async function authenticateCron(req: Request, mode: string): Promise<boolean> {
  if (mode !== 'cron') return false;
  const bearer = extractBearer(req.headers.get('authorization'));
  const cronSecret = (req.headers.get('x-cron-secret') ?? '').replace(/^\s+|\s+$/g, '');
  // Fails closed when either NEWSLETTER_CRON_* secret is unconfigured (empty),
  // so empty env secrets + empty/blank headers can never authenticate.
  return cronAuthOk(bearer, cronSecret, NEWSLETTER_CRON_SERVICE_ROLE_KEY, NEWSLETTER_CRON_SECRET);
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

// ─── Harvest data assembly ───────────────────────────────────────────────────
// Reads the operational sources the detectors need with the service-role client
// and shapes each into the detector input via the pure (unit-tested)
// newsletterHarvestShape module. Every source is scanned defensively: a missing
// relation / absent app_store key becomes an honest "unavailable" coverage
// entry rather than a thrown harvest; an error is recorded as "error". The
// returned `coverage` array is persisted so the admin brief can show exactly
// what was scanned, empty, unavailable, or errored — never a silent empty.
//
// MORTALITY BOUNDARY: cattle/sheep "on farm" counts exclude dead/sold/processed
// animals at the SQL layer (death_date/sale_date/processing_batch_id IS NULL),
// and births are born-alive only (shapeBirths subtracts deaths). The
// finance/mortality denylist in the detectors + the ingest RPC is the backstop.
const HARVEST_APP_STORE_KEYS = ['ppp-v4', 'ppp-feeders-v1', 'ppp-farrowing-v1', 'ppp-breeders-v1'];

type ScanResult = {rows: Record<string, unknown>[]; available: boolean; error: string | null};

function isMissingRelation(msg: string): boolean {
  return /does not exist|schema cache|could not find|relation .* does not/i.test(msg || '');
}

// Run one source query; classify a missing relation as unavailable (not an
// error) so an environment without a given table still produces a clean harvest.
async function scanSource(
  run: () => PromiseLike<{data: unknown; error: {message?: string} | null}>,
): Promise<ScanResult> {
  try {
    const {data, error} = await run();
    if (error) {
      if (isMissingRelation(error.message || '')) return {rows: [], available: false, error: null};
      return {rows: [], available: true, error: error.message || 'query error'};
    }
    return {rows: (Array.isArray(data) ? data : []) as Record<string, unknown>[], available: true, error: null};
  } catch (e) {
    return {rows: [], available: true, error: e instanceof Error ? e.message : String(e)};
  }
}

const endOfDay = (isoDay: string) => `${isoDay}T23:59:59.999Z`;

async function assembleHarvestInputAndCoverage(
  svc: ReturnType<typeof createClient>,
  period: {yearMonth: string; start: string; end: string},
): Promise<{input: Record<string, unknown>; coverage: Record<string, unknown>[]}> {
  const coverage: Record<string, unknown>[] = [];

  // ── app_store programs: broiler + pig (ppp-* keys) ──
  const appStore = await scanSource(() => svc.from('app_store').select('key, data').in('key', HARVEST_APP_STORE_KEYS));
  const store = new Map<string, unknown>();
  for (const r of appStore.rows) store.set(r.key as string, (r as {data: unknown}).data);
  const arr = (v: unknown) => (Array.isArray(v) ? (v as unknown[]) : []);
  const broilerBatches = arr(store.get('ppp-v4'));
  const pigFeederGroups = arr(store.get('ppp-feeders-v1'));
  const pigFarrowings = arr(store.get('ppp-farrowing-v1'));
  // Transfer audit log — pigs moved from a feeder sub-batch into breeding leave
  // the on-farm feeder count; detectPigsOnFarm subtracts them (ledger-derived).
  const pigBreeders = arr(store.get('ppp-breeders-v1'));
  coverage.push(
    coverageEntry('broiler', 'Broilers', {
      available: store.has('ppp-v4'),
      error: appStore.error,
      rowCount: broilerBatches.length,
    }),
  );
  coverage.push(
    coverageEntry('pig', 'Pigs', {
      available: store.has('ppp-feeders-v1') || store.has('ppp-farrowing-v1'),
      error: appStore.error,
      rowCount: pigFeederGroups.length + pigFarrowings.length,
    }),
  );

  // ── Cattle: on-farm head by herd + born-alive calvings ──
  // On-farm = the current herds ONLY. WCF records a departure by MOVING the
  // animal to a 'processed' | 'deceased' | 'sold' herd, not by reliably setting
  // death_date/sale_date/processing_batch_id — so the herd value is the source
  // of truth for "still here". Mirrors CATTLE_HERD_KEYS in
  // src/lib/cattleHerdFilters.js (keep these two in sync).
  const CATTLE_ONFARM_HERDS = ['mommas', 'backgrounders', 'finishers', 'bulls'];
  const cattle = await scanSource(() =>
    svc.from('cattle').select('herd').in('herd', CATTLE_ONFARM_HERDS).is('deleted_at', null),
  );
  const cattleHerds = shapeHeadCounts(cattle.rows, 'herd');
  coverage.push(
    coverageEntry('cattle', 'Cattle on farm', {
      available: cattle.available,
      error: cattle.error,
      rowCount: cattle.rows.length,
    }),
  );

  const cattleCalving = await scanSource(() =>
    svc
      .from('cattle_calving_records')
      .select('dam_tag, calving_date, total_born, deaths')
      .gte('calving_date', period.start)
      .lte('calving_date', period.end),
  );
  const cattleBirths = shapeBirths(cattleCalving.rows, {dateField: 'calving_date'});
  coverage.push(
    coverageEntry('cattle_births', 'Calves born', {
      available: cattleCalving.available,
      error: cattleCalving.error,
      rowCount: cattleBirths.length,
    }),
  );

  // ── Sheep: on-farm head by flock + born-alive lambings ──
  // Same model as cattle: departures move the animal to a 'processed' |
  // 'deceased' | 'sold' flock, so the flock value is the on-farm source of
  // truth. Mirrors ALL_FLOCKS minus the outcome flocks in
  // src/sheep/SheepAnimalPage.jsx (rams | ewes | feeders are on-farm).
  const SHEEP_ONFARM_FLOCKS = ['rams', 'ewes', 'feeders'];
  const sheep = await scanSource(() =>
    svc.from('sheep').select('flock').in('flock', SHEEP_ONFARM_FLOCKS).is('deleted_at', null),
  );
  const sheepFlocks = shapeHeadCounts(sheep.rows, 'flock');
  coverage.push(
    coverageEntry('sheep', 'Sheep on farm', {
      available: sheep.available,
      error: sheep.error,
      rowCount: sheep.rows.length,
    }),
  );

  const sheepLambing = await scanSource(() =>
    svc
      .from('sheep_lambing_records')
      .select('dam_tag, lambing_date, total_born, deaths')
      .gte('lambing_date', period.start)
      .lte('lambing_date', period.end),
  );
  const sheepBirths = shapeBirths(sheepLambing.rows, {dateField: 'lambing_date'});
  coverage.push(
    coverageEntry('sheep_births', 'Lambs born', {
      available: sheepLambing.available,
      error: sheepLambing.error,
      rowCount: sheepBirths.length,
    }),
  );

  // ── Layers: egg collections (summed group counts) ──
  const eggs = await scanSource(() =>
    svc
      .from('egg_dailys')
      .select('date, group1_count, group2_count, group3_count, group4_count')
      .is('deleted_at', null)
      .gte('date', period.start)
      .lte('date', period.end),
  );
  const layerProduction = shapeEggDailys(eggs.rows);
  coverage.push(
    coverageEntry('layer', 'Layers & eggs', {available: eggs.available, error: eggs.error, rowCount: eggs.rows.length}),
  );

  // ── Pasture moves ──
  const moves = await scanSource(() =>
    svc
      .from('pasture_move_events')
      .select('animal_type, group_key, group_label, moved_at, to_land_area_id, animal_count')
      .gte('moved_at', period.start)
      .lte('moved_at', endOfDay(period.end)),
  );
  const pastureMoves = shapePastureMoves(moves.rows);
  coverage.push(
    coverageEntry('pasture_moves', 'Pasture moves', {
      available: moves.available,
      error: moves.error,
      rowCount: pastureMoves.length,
    }),
  );

  // ── Daily field reports ──
  const daily = await scanSource(() =>
    svc
      .from('daily_submissions')
      .select('date, program, team_member')
      .gte('date', period.start)
      .lte('date', period.end),
  );
  const dailySubmissions = shapeDailySubmissions(daily.rows);
  coverage.push(
    coverageEntry('daily_reports', 'Daily reports', {
      available: daily.available,
      error: daily.error,
      rowCount: daily.rows.length,
    }),
  );

  // ── Completed tasks (projects) ──
  const tasks = await scanSource(() =>
    svc
      .from('task_instances')
      .select('title, completed_at, designation, from_recurring_template, submission_source')
      .eq('status', 'completed')
      .gte('completed_at', period.start)
      .lte('completed_at', endOfDay(period.end)),
  );
  const completedTasks = shapeCompletedTasks(tasks.rows);
  coverage.push(
    coverageEntry('completed_tasks', 'Completed projects', {
      available: tasks.available,
      error: tasks.error,
      rowCount: tasks.rows.length,
    }),
  );

  // ── Processing batches (cattle + sheep) ──
  const cattleProc = await scanSource(() =>
    svc
      .from('cattle_processing_batches')
      .select('name, actual_process_date, total_hanging_weight')
      .not('actual_process_date', 'is', null)
      .gte('actual_process_date', period.start)
      .lte('actual_process_date', period.end),
  );
  const sheepProc = await scanSource(() =>
    svc
      .from('sheep_processing_batches')
      .select('name, actual_process_date, total_hanging_weight')
      .not('actual_process_date', 'is', null)
      .gte('actual_process_date', period.start)
      .lte('actual_process_date', period.end),
  );
  const processingBatches = [...shapeProcessingBatches(cattleProc.rows), ...shapeProcessingBatches(sheepProc.rows)];
  coverage.push(
    coverageEntry('processing_batches', 'Processing', {
      available: cattleProc.available || sheepProc.available,
      error: cattleProc.error || sheepProc.error,
      rowCount: processingBatches.length,
    }),
  );

  return {
    input: {
      period,
      broilerBatches,
      pigFeederGroups,
      pigFarrowings,
      pigBreeders,
      cattleHerds,
      cattleBirths,
      sheepFlocks,
      sheepBirths,
      layerProduction,
      pastureMoves,
      dailySubmissions,
      completedTasks,
      processingBatches,
    },
    coverage,
  };
}

// ─── AI provider seam ────────────────────────────────────────────────────────
// Only 'anthropic' is wired. Returns {blocks} (still re-validated by the caller)
// or null when no key/provider is configured, so the caller falls back to the
// deterministic template composer.
async function callAiProvider(opts: {
  provider: string;
  model: string;
  prompt: string;
}): Promise<{blocks: unknown[]; photoPlan: unknown[]} | null> {
  if (!NEWSLETTER_AI_API_KEY) return null;
  if (opts.provider !== 'anthropic') return null;
  const model = opts.model || 'claude-opus-4-8';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': NEWSLETTER_AI_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      messages: [{role: 'user', content: opts.prompt}],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = Array.isArray(data?.content) ? data.content.map((c: {text?: string}) => c?.text || '').join('') : '';
  // The model is instructed to return ONLY a {"blocks":[...]} JSON object; parse
  // defensively (extract the first {...} span) and let validateNewsletterBlocks
  // drop anything that isn't a whitelisted block.
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) throw new Error('anthropic: no JSON object in response');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
  } catch (_e) {
    throw new Error('anthropic: response was not valid JSON');
  }
  const blocks =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as {blocks?: unknown[]}).blocks)
      ? (parsed as {blocks: unknown[]}).blocks
      : [];
  const photoPlan =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as {photoPlan?: unknown[]}).photoPlan)
      ? (parsed as {photoPlan: unknown[]}).photoPlan
      : [];
  return {blocks, photoPlan};
}

// ─── Steps ───────────────────────────────────────────────────────────────────

async function runHarvest(
  svc: ReturnType<typeof createClient>,
  issueId: string,
  yearMonth: string,
): Promise<{factCount: number; coverage: Record<string, unknown>[]}> {
  const {data: issueRow, error: issErr} = await svc
    .from('newsletter_issues')
    .select('year_month, period_start, period_end')
    .eq('id', issueId)
    .single();
  if (issErr) throw new Error(`load issue: ${issErr.message}`);
  const period = {
    yearMonth: issueRow?.year_month || yearMonth,
    start: String(issueRow?.period_start || periodBounds(yearMonth).start),
    end: String(issueRow?.period_end || periodBounds(yearMonth).end),
  };

  const {input, coverage} = await assembleHarvestInputAndCoverage(svc, period);
  const facts = detectNewsletterFacts(input);
  const {error: repErr} = await svc.rpc('replace_newsletter_harvest_facts', {
    p_issue_id: issueId,
    p_facts: facts,
  });
  if (repErr) throw new Error(`replace_newsletter_harvest_facts: ${repErr.message}`);
  // Persist per-source coverage so the admin brief is honest about what was
  // scanned/empty/unavailable. A coverage write failure must not fail the
  // harvest (the facts already landed) — it is logged on the run instead.
  const {error: covErr} = await svc.rpc('set_newsletter_harvest_coverage', {
    p_issue_id: issueId,
    p_coverage: coverage,
  });
  if (covErr) {
    await svc.rpc('log_newsletter_run', {
      p_issue_id: issueId,
      p_run_type: 'harvest',
      p_status: 'error',
      p_error: `coverage: ${covErr.message}`,
    });
  }
  await svc.rpc('log_newsletter_run', {p_issue_id: issueId, p_run_type: 'harvest', p_status: 'ok'});
  return {factCount: facts.length, coverage};
}

// Year-over-year production totals for the draft's "Production — year over year"
// section. Pulls the SAME sources the Production tab uses, for [lastYear..thisYear]
// full years, and lets the shared module mirror the tab's per-program rules +
// Planner-wins-by-coverage. Read-only; never reads cost/price/death fields.
async function assembleProductionYoy(svc: ReturnType<typeof createClient>, thisYear: string, lastYear: string) {
  const yStart = `${lastYear}-01-01`;
  const yEnd = `${thisYear}-12-31`;
  const arr = (v: unknown) => (Array.isArray(v) ? (v as unknown[]) : []);

  const appStore = await scanSource(() =>
    svc.from('app_store').select('key, data').in('key', ['ppp-v4', 'ppp-feeders-v1']),
  );
  const store = new Map<string, unknown>();
  for (const r of appStore.rows) store.set(r.key as string, (r as {data: unknown}).data);

  const cattle = await scanSource(() =>
    svc
      .from('cattle_processing_batches')
      .select('actual_process_date, cows_detail')
      .not('actual_process_date', 'is', null)
      .gte('actual_process_date', yStart)
      .lte('actual_process_date', yEnd),
  );
  const sheep = await scanSource(() =>
    svc
      .from('sheep_processing_batches')
      .select('actual_process_date, sheep_detail')
      .not('actual_process_date', 'is', null)
      .gte('actual_process_date', yStart)
      .lte('actual_process_date', yEnd),
  );
  const eggs = await scanSource(() =>
    svc
      .from('egg_dailys')
      .select('date, group1_count, group2_count, group3_count, group4_count')
      .is('deleted_at', null)
      .gte('date', yStart)
      .lte('date', yEnd),
  );
  // Legacy spreadsheet rows (pre-Planner backfill) come through the SECDEF RPC.
  const legacy = await scanSource(() =>
    svc.rpc('list_production_legacy_events', {p_from_date: yStart, p_to_date: yEnd}),
  );

  const today = new Date().toISOString().slice(0, 10);
  return computeProductionYoy(
    {
      broilerBatches: arr(store.get('ppp-v4')),
      feederGroups: arr(store.get('ppp-feeders-v1')),
      cattleProcessingBatches: cattle.rows,
      sheepProcessingBatches: sheep.rows,
      eggDailys: eggs.rows,
      legacyEvents: legacy.rows,
    },
    {thisYear, lastYear, today},
  );
}

async function runDraft(
  svc: ReturnType<typeof createClient>,
  issueId: string,
  overwrite: boolean,
  revisionNotes?: string,
): Promise<{provider: string; blockCount: number; photoPlanCount: number}> {
  const {data: input, error: inErr} = await svc.rpc('get_newsletter_generation_input', {p_issue_id: issueId});
  if (inErr) throw new Error(`get_newsletter_generation_input: ${inErr.message}`);
  const settings = (input && input.settings) || {};
  const provider = String(settings.aiProvider || 'template');
  const model = String(settings.aiModel || '');
  // Thread the tone preset + length + (optional) revision notes into the prompt.
  // input.currentDraft + input.photoPlan come from the generation RPC, so a
  // revision edits the existing blocks and a refreshed plan keeps fulfilled slots.
  // Keep the deterministic YoY section out of the current-draft sample sent to
  // the AI on a revise, so the model never reproduces it (we re-append it fresh
  // below, exactly once).
  const cleanedCurrent =
    input && input.currentDraft && Array.isArray(input.currentDraft.blocks)
      ? {...input.currentDraft, blocks: stripProductionYoyBlocks(input.currentDraft.blocks)}
      : input && input.currentDraft;
  const draftInput = {
    ...input,
    currentDraft: cleanedCurrent,
    tone: settings.tone,
    tonePreset: settings.tonePreset,
    lengthDetail: settings.lengthDetail,
    revisionNotes: revisionNotes || '',
  };

  let payload: {blocks: unknown[]};
  let providerUsed = provider;
  let proposedPlan: unknown[];
  try {
    const aiResult = await callAiProvider({
      provider,
      model,
      prompt: buildNewsletterPrompt(draftInput),
    });
    if (aiResult) {
      payload = validateNewsletterBlocks(aiResult);
      proposedPlan = sanitizePhotoPlan(aiResult.photoPlan);
    } else {
      payload = composeTemplateDraft(draftInput);
      proposedPlan = proposePhotoPlan(draftInput);
      providerUsed = 'template';
    }
  } catch (e) {
    // A provider failure must never block the issue: fall back to the template
    // composer and record the provider error on the run.
    payload = composeTemplateDraft(draftInput);
    proposedPlan = proposePhotoPlan(draftInput);
    providerUsed = 'template';
    await svc.rpc('log_newsletter_run', {
      p_issue_id: issueId,
      p_run_type: 'ai_draft',
      p_provider: provider,
      p_model: model,
      p_status: 'error',
      p_error: e instanceof Error ? e.message : String(e),
    });
  }

  // Append the deterministic "Production — year over year" section with EXACT
  // numbers (never AI-authored). Additive and best-effort: a failure here must
  // never block the draft, so it is logged to the function console only.
  try {
    const ym = String((input && input.issue && input.issue.yearMonth) || '');
    const thisYear = ym.slice(0, 4);
    if (/^\d{4}$/.test(thisYear)) {
      const lastYear = String(Number(thisYear) - 1);
      const yoy = await assembleProductionYoy(svc, thisYear, lastYear);
      const base = stripProductionYoyBlocks(payload.blocks);
      payload = validateNewsletterBlocks({blocks: [...base, ...buildProductionYoyBlocks(yoy)]});
    }
  } catch (e) {
    console.error('newsletter production yoy skipped:', e instanceof Error ? e.message : String(e));
  }

  const {error: applyErr} = await svc.rpc('apply_newsletter_ai_draft', {
    p_issue_id: issueId,
    p_payload: payload,
    p_provider: providerUsed,
    p_model: model || null,
    p_overwrite: overwrite,
  });
  if (applyErr) throw new Error(`apply_newsletter_ai_draft: ${applyErr.message}`);

  // Merge the freshly-proposed shot-list onto the existing one (ALWAYS keep
  // slots the admin already fulfilled) and persist it. A plan-write failure must
  // not fail the draft — it is logged on the run.
  const mergedPlan = mergePhotoPlan(input && input.photoPlan, proposedPlan);
  const {error: planErr} = await svc.rpc('set_newsletter_photo_plan', {p_issue_id: issueId, p_plan: mergedPlan});
  if (planErr) {
    await svc.rpc('log_newsletter_run', {
      p_issue_id: issueId,
      p_run_type: 'ai_draft',
      p_status: 'error',
      p_error: `photo plan: ${planErr.message}`,
    });
  }

  await svc.rpc('log_newsletter_run', {
    p_issue_id: issueId,
    p_run_type: 'ai_draft',
    p_provider: providerUsed,
    p_model: model || null,
    p_status: 'ok',
  });
  return {provider: providerUsed, blockCount: payload.blocks.length, photoPlanCount: mergedPlan.length};
}

// ─── Main handler ────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', {headers: corsHeaders});
  if (req.method !== 'POST') return jsonResponse({ok: false, error: 'method not allowed'}, 405);

  let body: {
    mode?: string;
    issueId?: string;
    yearMonth?: string;
    steps?: string[];
    overwrite?: boolean;
    probe?: boolean;
    revisionNotes?: string;
  } = {};
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

  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {persistSession: false, autoRefreshToken: false},
  });

  // Probe reports whether the AI provider key is configured (boolean only — the
  // key itself never leaves the function) so the admin settings UI can show
  // Anthropic as available vs "needs server key" without guessing.
  if (body.probe === true) {
    return jsonResponse({ok: true, probe: true, run_mode: mode, aiConfigured: !!NEWSLETTER_AI_API_KEY});
  }

  try {
    const result: Record<string, unknown> = {ok: true, mode};

    if (mode === 'cron') {
      // Coordinated monthly pre-seed for the current month.
      const yearMonth = currentYearMonthUTC();
      const {data: issueId, error: ensErr} = await svc.rpc('ensure_newsletter_issue', {p_year_month: yearMonth});
      if (ensErr) throw new Error(`ensure_newsletter_issue: ${ensErr.message}`);
      result.issueId = issueId;
      result.yearMonth = yearMonth;
      result.harvest = await runHarvest(svc, issueId as string, yearMonth);
      result.draft = await runDraft(svc, issueId as string, false); // never clobber admin edits
      const {data: reminder} = await svc.rpc('create_newsletter_reminder_task', {p_year_month: yearMonth});
      result.reminder = reminder;
      await svc.rpc('log_newsletter_run', {p_issue_id: issueId, p_run_type: 'task_create', p_status: 'ok'});
      return jsonResponse(result);
    }

    // admin mode — operate on an explicit issue (or ensure from a month).
    let issueId = String(body.issueId || '');
    const yearMonth = String(body.yearMonth || '');
    if (!issueId) {
      if (!yearMonth) return jsonResponse({ok: false, error: 'issueId or yearMonth required'}, 400);
      const {data: ensured, error: ensErr} = await svc.rpc('ensure_newsletter_issue', {p_year_month: yearMonth});
      if (ensErr) throw new Error(`ensure_newsletter_issue: ${ensErr.message}`);
      issueId = ensured as string;
    }
    result.issueId = issueId;

    const steps = Array.isArray(body.steps) && body.steps.length ? body.steps : ['harvest', 'draft'];
    if (steps.includes('harvest')) result.harvest = await runHarvest(svc, issueId, yearMonth);
    if (steps.includes('draft'))
      result.draft = await runDraft(svc, issueId, body.overwrite !== false, body.revisionNotes);
    return jsonResponse(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse({ok: false, error: msg}, 500);
  }
});
