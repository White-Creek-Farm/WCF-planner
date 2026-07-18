import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static guards for the Processing Source-details carcass-yield lane:
//   1) Mig 188 is a minimal forward-only reissue of ONE internal function
//      (_processing_source_projection) whose only change is the pig
//      branch's actual-phase hanging_weight — signature, security posture,
//      and unrelated payload fields preserved.
//   2) The drawer renders one shared read-only yield block (Total live
//      weight / Hanging weight / Carcass yield) through the single pure
//      summarizeCarcassYield helper for cattle/sheep AND pig — no
//      competing math, projected weights never feed it, planned pig trips
//      fail closed.
//   3) Broiler Source details gain nothing.
// Behavior proofs live in src/lib/carcassYield.test.js + the browser spec.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mig = read('supabase-migrations/188_processing_carcass_yield_source_totals.sql');
const drawer = read('src/processing/ProcessingDrawer.jsx');
const helper = read('src/lib/carcassYield.js');

describe('mig 188 — carcass-yield source totals + guarded animal detail', () => {
  it('reissues EXACTLY the two affected read functions', () => {
    expect(mig).toMatch(
      /CREATE OR REPLACE FUNCTION public\._processing_source_projection\(p_rec public\.processing_records\)/,
    );
    expect(mig).toMatch(
      /CREATE OR REPLACE FUNCTION public\._processing_animal_detail\(p_rec public\.processing_records\)/,
    );
    expect(mig.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(2);
    // EXACTLY one function-specific REVOKE each — a duplicate (or a missing
    // one) fails this count.
    const revokes = mig.match(/^REVOKE ALL ON FUNCTION public\._processing_\w+\(public\.processing_records\).*$/gm);
    expect(revokes).toHaveLength(2);
    expect(
      mig.match(/REVOKE ALL ON FUNCTION public\._processing_source_projection\(public\.processing_records\)/g),
    ).toHaveLength(1);
    expect(
      mig.match(/REVOKE ALL ON FUNCTION public\._processing_animal_detail\(public\.processing_records\)/g),
    ).toHaveLength(1);
  });

  it('animal detail: both hanging-weight casts are regex-guarded (no unguarded NULLIF cast remains)', () => {
    const guarded = mig.match(
      /'hanging_weight', CASE WHEN btrim\(COALESCE\(d\.value->>'hanging_weight',''\)\) ~ '\^\[0-9\]\+\(\\\.\[0-9\]\+\)\?\$'\s*THEN btrim\(d\.value->>'hanging_weight'\)::numeric END,/g,
    );
    expect(guarded).toHaveLength(2); // cattle + sheep branches
    expect(mig).not.toMatch(/NULLIF\(btrim\(COALESCE\(d\.value->>'hanging_weight',''\)\), ''\)::numeric/);
  });

  it('header truthfully describes the five payload additions AND the guarded animal-detail reissue', () => {
    expect(mig).toMatch(/adds FIVE[\s\S]{0,8}payload fields/); // wraps across a comment line
    expect(mig).toMatch(/cattle branch: 'total_live_weight' \+ 'total_hanging_weight'/);
    expect(mig).toMatch(/sheep branch: {2}'total_live_weight' \+ 'total_hanging_weight'/);
    expect(mig).toMatch(/pig branch: {4}'hanging_weight'/);
    expect(mig).toMatch(/_processing_animal_detail \(last defined in mig 178\)/);
    expect(mig).toMatch(/guarding the two cattle\/sheep 'hanging_weight' casts/);
  });

  it('emits hanging_weight for the ACTUAL pig phase only, regex-guarded and > 0 (never throws, never 0)', () => {
    expect(mig).toMatch(
      /'hanging_weight',\s*\(SELECT s\.v FROM \(\s*SELECT CASE WHEN v_phase = 'actual'\s*AND btrim\(COALESCE\(v_t->>'hangingWeight',''\)\) ~ '\^\[0-9\]\+\(\\\.\[0-9\]\+\)\?\$'\s*THEN btrim\(v_t->>'hangingWeight'\)::numeric END AS v\) s\s*WHERE s\.v > 0\)/,
    );
  });

  it('emits cattle/sheep detail totals with the cast unreachable for invalid text (guarded CASE, positive-only, NULL when empty)', () => {
    expect(mig).toMatch(/'total_live_weight',\s*\(SELECT NULLIF\(sum\(t\.w\), 0\)/);
    expect(mig).toMatch(/'total_hanging_weight',\s*\(SELECT NULLIF\(sum\(t\.w\), 0\)/);
    expect(mig).toMatch(
      /CASE WHEN btrim\(COALESCE\(d\.value->>'live_weight',''\)\) ~ '\^\[0-9\]\+\(\\\.\[0-9\]\+\)\?\$'\s*THEN btrim\(d\.value->>'live_weight'\)::numeric END/,
    );
    expect(mig).toMatch(
      /CASE WHEN btrim\(COALESCE\(d\.value->>'hanging_weight',''\)\) ~ '\^\[0-9\]\+\(\\\.\[0-9\]\+\)\?\$'\s*THEN btrim\(d\.value->>'hanging_weight'\)::numeric END/,
    );
    expect(mig).toMatch(/WHERE t\.w IS NOT NULL AND t\.w > 0/);
    // No unguarded weight cast survives anywhere in the detail-total /
    // hanging-weight additions: the legacy NULLIF(btrim(...))::numeric
    // pattern must not appear for these fields.
    expect(mig).not.toMatch(/NULLIF\(btrim\(COALESCE\(d\.value->>'live_weight'/);
    expect(mig).not.toMatch(/NULLIF\(btrim\(COALESCE\(v_t->>'hangingWeight'/);
  });

  it('preserves the security posture and unrelated payload fields verbatim', () => {
    expect(mig).toMatch(/SECURITY DEFINER SET search_path = public STABLE/);
    expect(mig).toContain(
      'REVOKE ALL ON FUNCTION public._processing_source_projection(public.processing_records) FROM PUBLIC, anon, authenticated;',
    );
    // Spot anchors across all three program branches.
    for (const anchor of ["'age_days'", "'animal_tags'", "'is_actual_date'", "'scheduled_with_processor'"]) {
      expect(mig).toContain(anchor);
    }
  });
});

describe('drawer — one shared yield block, read-only, fail-closed', () => {
  it('computes ONLY through the shared pure helper (no competing math)', () => {
    expect(drawer).toMatch(/import \{summarizeCarcassYield\} from '\.\.\/lib\/carcassYield\.js'/);
    expect(drawer.match(/summarizeCarcassYield\(/g)).toHaveLength(2); // cattle/sheep + pig call sites
    // The drawer itself never divides weights.
    expect(drawer).not.toMatch(/hang[a-zA-Z]*\s*\/\s*live/i);
  });

  it('renders the three read-only rows via renderCarcassYield with the canonical Not recorded fallback', () => {
    expect(drawer).toMatch(/function renderCarcassYield\(summary, kind\)/);
    expect(drawer).toContain('data-processing-carcass-yield={kind}');
    expect(drawer).toContain('label="Total live weight"');
    expect(drawer).toContain('label="Hanging weight"');
    expect(drawer).toContain('label="Carcass yield"');
    expect(drawer).toMatch(/summary\.yieldPct != null \? summary\.yieldPct\.toFixed\(1\) \+ '%' : null/);
  });

  it('cattle/sheep: mig-188 detail totals feed the block, placed below Age and above the roster', () => {
    expect(drawer).toMatch(
      /label="Age"[\s\S]{0,1200}?renderCarcassYield\(\s*summarizeCarcassYield\(\{\s*liveValues: \[source\.total_live_weight\],\s*hangingValues: \[source\.total_hanging_weight\],\s*\}\),\s*kind,\s*\)[\s\S]{0,900}?AnimalsTable/,
    );
  });

  it('pig: exact-trip actuals only — planned trips pass empty inputs and fail closed', () => {
    expect(drawer).toMatch(/liveValues: isPigActual \? animals\.map\(\(a\) => a\.live_weight\) : \[\]/);
    expect(drawer).toMatch(/hangingTotal: isPigActual \? source\.hanging_weight : null/);
  });

  it('broiler Source details gain no carcass block', () => {
    const broilerBlock = drawer.slice(
      drawer.indexOf("{kind === 'broiler' && ("),
      drawer.indexOf("{(kind === 'cattle'"),
    );
    expect(broilerBlock).toContain('label="Batch"');
    expect(broilerBlock).not.toContain('Carcass');
    expect(broilerBlock).not.toContain('renderCarcassYield');
  });
});

describe('helper — planner-parity math with STRICT validation', () => {
  it('uses the exact shared rounding contract (sum first, one decimal) and fail-closed nulls', () => {
    expect(helper).toMatch(/Math\.round\(\(hang \/ live\) \* 1000\) \/ 10/);
    expect(helper).toMatch(/live > 0 \? live : null/);
    expect(helper).toMatch(/hang > 0 \? hang : null/);
    expect(helper).toMatch(/live > 0 && hang > 0 \?/);
  });

  it('validates strictly — no permissive parseFloat semantics anywhere in the helper', () => {
    expect(helper).not.toMatch(/parseFloat\(/); // no call sites (the comment may name the banned idiom)
    expect(helper).toMatch(/function toValidWeight\(v\)/);
    expect(helper).toMatch(/\/\^\\d\+\(\\\.\\d\+\)\?\$\//);
    expect(helper).toMatch(/Number\.isFinite\(n\) && n > 0/);
  });
});
