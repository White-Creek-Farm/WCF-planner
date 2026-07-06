import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {
  buildDiffPlan,
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

const IMPORTER_RPCS = [
  'upsert_processing_from_asana',
  'upsert_processing_subtask_from_asana',
  'record_processing_attachment',
  'record_processing_import_exception',
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

  it('routes every write through the mig-156 importer service_role RPCs', () => {
    for (const rpc of IMPORTER_RPCS) {
      expect(edgeFn, `edge fn does not call svc.rpc('${rpc}')`).toContain(`svc.rpc('${rpc}'`);
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
