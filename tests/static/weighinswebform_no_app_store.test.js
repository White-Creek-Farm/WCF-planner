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
