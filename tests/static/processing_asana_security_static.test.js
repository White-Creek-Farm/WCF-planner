import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {
  buildDiffPlan,
  buildDryRunReport,
  mapAsanaTaskToProcessingRow,
  sectionToProgram,
} from '../../supabase/functions/_shared/processingAsanaShape.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const EDGE_FN = 'supabase/functions/processing-asana-sync/index.ts';
const SHAPE = 'supabase/functions/_shared/processingAsanaShape.js';

const edgeFn = fs.readFileSync(path.join(ROOT, EDGE_FN), 'utf8');
const shapeSrc = fs.readFileSync(path.join(ROOT, SHAPE), 'utf8');
const processingApi = fs.readFileSync(path.join(ROOT, 'src/lib/processingApi.js'), 'utf8');
const mig = fs.readFileSync(path.join(ROOT, 'supabase-migrations/156_processing_calendar.sql'), 'utf8');

// Walk src/ and collect every text-ish source file so we can prove a secret
// name is absent from the ENTIRE client bundle, not just a hand-picked file.
const TEXT_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.css', '.html', '.svg', '.md']);
function walkSrc(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSrc(full));
    else if (TEXT_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}
const SRC_FILES = walkSrc(path.join(ROOT, 'src'));

// The edge fn was re-scoped to "match Planner FIRST" (migration 157): it now
// routes every write through this exact set of mig-156/157 service_role RPCs.
// Kept in sync with the actual svc.rpc('…') calls in index.ts —
// record_processing_import_exception was removed; reconcile_planner_to_processing
// / link_asana_to_processing / record_processing_comment were added.
const IMPORTER_RPCS = [
  'reconcile_planner_to_processing',
  'link_asana_to_processing',
  'upsert_processing_from_asana',
  'upsert_processing_subtask_from_asana',
  'record_processing_comment',
  'record_processing_attachment',
  // mig 165: imported Asana SYSTEM stories → immutable historical Activity
  // (deterministic ae-asana-<gid> ids, original timestamps, service_role only).
  'record_processing_history_event',
  'start_processing_sync_run',
  'finish_processing_sync_run',
];

describe('processing-asana — Asana token never leaks to the client', () => {
  it('found at least one src file to scan (guards against an empty glob)', () => {
    expect(SRC_FILES.length).toBeGreaterThan(50);
  });

  it('ASANA_ACCESS_TOKEN appears ONLY in the edge function, nowhere under src/', () => {
    expect(edgeFn).toContain('ASANA_ACCESS_TOKEN');
    for (const f of SRC_FILES) {
      const body = fs.readFileSync(f, 'utf8');
      expect(body, `ASANA_ACCESS_TOKEN leaked into ${path.relative(ROOT, f)}`).not.toContain('ASANA_ACCESS_TOKEN');
    }
  });

  it('the Asana token is never exposed as a VITE_-prefixed (client-bundled) env var', () => {
    expect(edgeFn).not.toContain('VITE_ASANA');
    for (const f of SRC_FILES) {
      const body = fs.readFileSync(f, 'utf8');
      expect(body, `VITE_ASANA env leaked into ${path.relative(ROOT, f)}`).not.toContain('VITE_ASANA');
    }
  });

  it('the probe returns only a boolean asanaConfigured, never the raw token', () => {
    expect(edgeFn).toMatch(/asanaConfigured:\s*!!ASANA_ACCESS_TOKEN/);
    // The token is only ever consumed as an Authorization: Bearer header value.
    expect(edgeFn).toContain('Bearer ${ASANA_ACCESS_TOKEN}');
    // No JSON response field carries the raw token value.
    expect(edgeFn).not.toMatch(/["'`]?\w*[Tt]oken["'`]?\s*:\s*ASANA_ACCESS_TOKEN/);
  });
});

describe('processing-asana — edge fn never raw-writes source tables', () => {
  it('has no svc.from(<source table>) access at all', () => {
    expect(edgeFn).not.toMatch(
      /svc\.from\(\s*['"](cattle|sheep|cattle_processing_batches|sheep_processing_batches|app_store)['"]\s*\)/,
    );
  });

  it('never chains insert/update/upsert/delete onto any svc.from() (writes go through RPCs)', () => {
    expect(edgeFn).not.toMatch(/svc\.from\([^)]*\)\.(insert|update|upsert|delete)\(/);
  });

  it('routes every write through the mig-156/157 importer service_role RPCs (match-first re-scope)', () => {
    for (const rpc of IMPORTER_RPCS) {
      expect(edgeFn, `edge fn does not call svc.rpc('${rpc}')`).toContain(`svc.rpc('${rpc}'`);
    }
    // And there is NO svc.rpc('…') OUTSIDE this reviewed allowlist — a new
    // service_role write path would have to be added to IMPORTER_RPCS first
    // (strengthens the no-raw-source-write guard rather than weakening it).
    const calledSvcRpcs = [...edgeFn.matchAll(/svc\.rpc\(\s*'([^']+)'/g)].map((match) => match[1]);
    expect(calledSvcRpcs.length).toBeGreaterThan(0);
    for (const name of calledSvcRpcs) {
      expect(IMPORTER_RPCS, `unexpected svc.rpc('${name}') not in the importer allowlist`).toContain(name);
    }
  });
});

describe('processing-asana — pure, deterministic shape/diff layer', () => {
  it('is a pure module: no imports, no Deno/Node I/O', () => {
    expect(shapeSrc).not.toMatch(/^\s*import\s/m);
    expect(shapeSrc).not.toContain('Deno.');
    expect(shapeSrc).not.toContain('require(');
  });

  it('exports buildDiffPlan and mapAsanaTaskToProcessingRow', () => {
    expect(shapeSrc).toContain('export function buildDiffPlan');
    expect(shapeSrc).toContain('export function mapAsanaTaskToProcessingRow');
    expect(typeof buildDiffPlan).toBe('function');
    expect(typeof mapAsanaTaskToProcessingRow).toBe('function');
  });

  it("sectionToProgram maps 'WCF Lamb Processing' -> 'sheep'", () => {
    expect(shapeSrc).toContain("'WCF Lamb Processing': 'sheep'");
    expect(sectionToProgram('WCF Lamb Processing')).toBe('sheep');
  });
});

describe('processing-asana — read-only dry_run review report', () => {
  it('the shared module exports a pure buildDryRunReport', () => {
    expect(shapeSrc).toContain('export function buildDryRunReport');
    expect(typeof buildDryRunReport).toBe('function');
  });

  it('buildDryRunReport carries write-path-parity buckets + review-grade detail', () => {
    // Buckets mirror the write path's counts.* classification names.
    for (const key of ['matched:', 'historical:', 'import_exception:', 'needs_review:', 'milestone:']) {
      expect(shapeSrc).toContain(key);
    }
    // Detail collections the report must surface.
    for (const key of ['review', 'milestones', 'collisions', 'pigCandidates', 'driftPreview']) {
      expect(shapeSrc).toContain(key);
    }
    // Collision sub-reports.
    for (const key of ['duplicateAsanaCodes', 'ambiguousCandidates', 'plannerContested']) {
      expect(shapeSrc).toContain(key);
    }
    // Live shape check (not just source text): every documented key is present.
    const report = buildDryRunReport([], []);
    expect(Object.keys(report.buckets).sort()).toEqual([
      'historical',
      'import_exception',
      'matched',
      'milestone',
      'needs_review',
    ]);
    expect(Object.keys(report.collisions).sort()).toEqual([
      'ambiguousCandidates',
      'duplicateAsanaCodes',
      'plannerContested',
    ]);
    for (const key of ['tasksFetched', 'plannerRows', 'review', 'milestones', 'pigCandidates', 'driftPreview']) {
      expect(report).toHaveProperty(key);
    }
  });

  it('runDryRun is READ-ONLY: builds the report, never reconciles / writes / starts a sync run', () => {
    const start = edgeFn.indexOf('async function runDryRun');
    expect(start).toBeGreaterThan(-1);
    const body = edgeFn.slice(start, edgeFn.indexOf('\n}', start));
    expect(body).toContain('buildDryRunReport(tasks, plannerRows)');
    expect(body).not.toContain('reconcile_planner_to_processing');
    expect(body).not.toContain('start_processing_sync_run');
    expect(body).not.toMatch(/svc\.rpc\(/);
    expect(body).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });

  it('the dry_run action returns the read preview plan and skips the write bracket', () => {
    // action==='dry_run' returns { plan: <report> } and never enters runSync.
    expect(edgeFn).toMatch(/if \(action === 'dry_run'\)[\s\S]*?runDryRun\(svc\)[\s\S]*?plan/);
    // dry_run is still gated behind the Asana token like the write actions.
    expect(edgeFn).toMatch(/if \(!ASANA_ACCESS_TOKEN\)[\s\S]*?asanaConfigured: false/);
  });
});

describe('processing-asana — source-owned fields are guarded in the client API', () => {
  it('exposes editors ONLY for processor + customer (source-owned facts stay read-only)', () => {
    expect(processingApi).toContain('export async function setProcessingProcessor');
    expect(processingApi).toContain('export async function setProcessingCustomer');
  });

  it('has NO client wrapper that writes title/processing_date/number_processed/status on a planner_batch', () => {
    expect(processingApi).not.toContain('setProcessingDate');
    expect(processingApi).not.toContain('setProcessingNumber');
    expect(processingApi).not.toContain('setProcessingTitle');
    expect(processingApi).not.toContain('setProcessingStatus');
  });

  it('the source-mode flag exists end to end (wrapper + RPC + settings column)', () => {
    expect(processingApi).toContain('export async function setAsanaSyncEnabled');
    expect(processingApi).toContain("sb.rpc('set_asana_sync_enabled'");
    expect(mig).toMatch(/FUNCTION public\.set_asana_sync_enabled\(boolean\)/);
    expect(mig).toMatch(/asana_sync_enabled\s+boolean/);
  });
});
