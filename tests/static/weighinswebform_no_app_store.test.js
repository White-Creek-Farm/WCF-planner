// Static lock: WeighInsWebform.jsx must not reference app_store / ppp-v4,
// and must not import writeBroilerBatchAvg.
//
// The public broiler weigh-in form moved to webform_config.broiler_batch_meta
// (see src/lib/broilerBatchMeta.js) on the READ side. The previous app_store
// ppp-v4 read was anon-blocked under prod RLS and silently produced
// "(no schooner)" fallbacks. On the WRITE side (week4Lbs / week6Lbs batch
// stamp after Complete), the public form now routes through the
// stamp_broiler_batch_avg SECURITY DEFINER RPC (mig 055) -- importing
// writeBroilerBatchAvg would re-introduce the anon-blocked direct write
// path. Admin code legitimately uses both.

import {readFileSync, readdirSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {describe, it, expect} from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const FORM_PATH = resolve(HERE, '../../src/webforms/WeighInsWebform.jsx');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

function listRuntimeSourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listRuntimeSourceFiles(full));
    } else if (/\.(jsx?|cjs|mjs)$/.test(name) && !/\.(test|spec)\.(jsx?|cjs|mjs)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe('WeighInsWebform.jsx static lock', () => {
  const source = readFileSync(FORM_PATH, 'utf8');

  it('does not contain the literal "app_store"', () => {
    expect(source).not.toMatch(/app_store/);
  });

  it('does not contain the literal "ppp-v4"', () => {
    expect(source).not.toMatch(/ppp-v4/);
  });

  // Mig 055 hardening: importing writeBroilerBatchAvg re-introduces the
  // anon-blocked direct write path on app_store. Public form must use the
  // stamp_broiler_batch_avg SECURITY DEFINER RPC instead.
  it('does not import writeBroilerBatchAvg', () => {
    expect(source).not.toMatch(/writeBroilerBatchAvg/);
  });

  it('calls the stamp_broiler_batch_avg RPC', () => {
    expect(source).toMatch(/stamp_broiler_batch_avg/);
  });

  it('imports the public broiler mirror helper', () => {
    expect(source).toMatch(/from\s+['"]\.\.\/lib\/broilerBatchMeta\.js['"]/);
  });

  it('reads broiler_batch_meta from webform_config', () => {
    expect(source).toMatch(/broiler_batch_meta/);
  });

  // Pig recent-entries cap regression guard (2026-05-06).
  // The pig session UI previously rendered only `entries.slice(-10)` with a
  // header "Recent entries (latest 10)". Operators mid-weigh lost the first
  // entries from the visible list as soon as #11 landed. The fix renders all
  // entries with `Recent entries (<count>)`. These asserts lock the absence
  // of the old pattern in this file (pig-only block; cattle/sheep have their
  // own `slice(0, N)` patterns elsewhere that this lock does not touch).
  it('does not slice pig recent-entries to the latest 10', () => {
    expect(source).not.toMatch(/entries\.slice\(-10\)/);
  });

  it('header copy no longer says "latest 10"', () => {
    expect(source).not.toMatch(/Recent entries \(latest 10\)/);
  });

  it('pig recent-entries header renders the live entries.length count', () => {
    expect(source).toMatch(/'Recent entries \(' \+ entries\.length \+ '\)'/);
  });

  it('does not write forbidden retag reconcile_intent for resolved swap-tag entries', () => {
    expect(source).not.toContain("mode === 'retag' ? 'retag'");
    expect(source).toContain(
      "reconcile_intent: mode === 'replacement' ? 'replacement' : mode === 'new_cow' ? 'new_cow' : null",
    );
  });

  it('allows retry after a partial swap-tag side effect for the same cow', () => {
    expect(source).toContain('existingAtNewTag && existingAtNewTag.id !== retagCow.id');
    expect(source).toContain('cowNeedsUpdate');
  });

  it('records resolved swap-tag prior tags as weigh-in history tags', () => {
    const start = source.indexOf("if (mode === 'retag' && retagCow)");
    const end = source.indexOf('const rec = {', start);
    const retagBlock = source.slice(start, end);
    expect(retagBlock).toContain("source: 'weigh_in'");
    expect(retagBlock).not.toContain("source: 'import'");
    expect(retagBlock).toContain('priorTagIndex');
  });

  it('shades blacklisted cattle in the public weigh-in dropdowns', () => {
    expect(source).toContain('breeding_blacklist');
    expect(source).toContain('blacklistOptionS');
    expect(source).toContain('blacklistSelectS');
    expect(source).toContain('data-breeding-blacklist-option');
    expect(source).toContain('data-selected-breeding-blacklist');
    expect(source).toContain('selectedCattleIsBlacklisted');
    expect(source).toContain("backgroundColor: '#fee2e2'");
    expect(source).toContain("color: '#991b1b'");
  });

  it('keeps blacklisted cattle red after they are weighed', () => {
    expect(source).toContain('data-breeding-blacklist-recent-entry');
    expect(source).toContain("species === 'cattle' && !!(animal && animal.breeding_blacklist)");
    expect(source).toContain("background: isBlacklisted ? '#fef2f2'");
    expect(source).toContain("borderLeft: isBlacklisted ? '3px solid #dc2626'");
    expect(source).toContain("color: isBlacklisted ? '#991b1b'");
  });

  it('includes sex in the public animal dropdown label', () => {
    expect(source).toContain('const sex = animal.sex ?');
    expect(source).toContain("return '#' + tag + sex +");
  });

  it('lets inline new-cow weigh-in entries capture optional DOB', () => {
    expect(source).toContain('const [newCowBirthDate, setNewCowBirthDate] = React.useState');
    expect(source).toContain('birth_date: birthDate || null');
    expect(source).toContain('type="date"');
    expect(source).toContain('value={newCowBirthDate}');
    expect(source).toContain('birthDate: newCowBirthDate');
  });

  it('aligns public cattle and sheep recent entries on a fixed grid', () => {
    expect(source).toContain('data-public-weighin-recent-entry-grid="1"');
    expect(source).toContain("gridTemplateColumns: '64px 54px minmax(82px, 1fr) 72px 88px minmax(0, 86px) 92px'");
    expect(source).toContain("width: '100%'");
    expect(source).not.toContain("overflowX: 'auto'");
  });

  it('keeps the active weighing screen wide enough for aligned recent-entry columns', () => {
    expect(source).toContain("stage === 'session' && session");
    expect(source).toContain('style={{maxWidth: 640, margin:');
  });
});

describe('public webform app_store boundary', () => {
  it('keeps public webform source off app_store / ppp-v4 direct access', () => {
    const offenders = [];
    for (const file of listRuntimeSourceFiles(resolve(ROOT, 'src/webforms'))) {
      const rel = file.replace(ROOT + '\\', '').replace(/\\/g, '/');
      const code = stripComments(readFileSync(file, 'utf8'));
      if (/\bapp_store\b|ppp-v4|writeBroilerBatchAvg/.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
