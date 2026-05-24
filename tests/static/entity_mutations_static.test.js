import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const helperSrc = fs.readFileSync(path.join(ROOT, 'src/lib/entityMutations.js'), 'utf8');
const eqDetailSrc = fs.readFileSync(path.join(ROOT, 'src/equipment/EquipmentDetail.jsx'), 'utf8');

describe('entityMutations.js — contract shape', () => {
  it('exports runMutation as the shared mutation helper', () => {
    expect(helperSrc).toMatch(/export async function runMutation/);
  });

  it('re-exports activity helpers from activityApi for convenience', () => {
    expect(helperSrc).toContain("from './activityApi.js'");
    expect(helperSrc).toMatch(/export \{.*recordStatusChange.*\}/);
    expect(helperSrc).toMatch(/export \{.*recordFieldChange.*\}/);
    expect(helperSrc).toMatch(/export \{.*recordActivityEvent.*\}/);
  });

  it('does NOT import or reference any specific table name', () => {
    const code = helperSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(/equipment|cattle|sheep|pig|broiler|layer|daily/i);
  });

  it('never swallows mutation errors — only activity errors when best-effort', () => {
    expect(helperSrc).toContain('activityBestEffort');
    expect(helperSrc).not.toMatch(/catch.*\{[\s\n]*\}/);
  });

  it('rejects invalid mutateFn responses (undefined/null/non-object)', () => {
    expect(helperSrc).toContain('must return {data, error}');
    expect(helperSrc).toMatch(/resp == null \|\| typeof resp !== 'object'/);
  });

  it('documents NON-TRANSACTIONAL limitation', () => {
    expect(helperSrc).toMatch(/NON-TRANSACTIONAL/);
    expect(helperSrc).toContain('already committed');
    expect(helperSrc).toContain('SECDEF RPC');
  });

  it('calls onError with the error message string', () => {
    expect(helperSrc).toContain("typeof onError === 'function'");
  });

  it('returns normalized {ok, data} or {ok, error} shape', () => {
    expect(helperSrc).toContain('{ok: true, data}');
    expect(helperSrc).toContain('{ok: false, error: msg}');
  });
});

describe('EquipmentDetail — pilot migration to runMutation', () => {
  it('imports runMutation from entityMutations', () => {
    expect(eqDetailSrc).toContain("from '../lib/entityMutations.js'");
    expect(eqDetailSrc).toContain('runMutation');
  });

  it('no longer imports directly from activityApi', () => {
    expect(eqDetailSrc).not.toContain("from '../lib/activityApi.js'");
  });

  it('uses runMutation for the status toggle', () => {
    expect(eqDetailSrc).toContain('runMutation(');
    expect(eqDetailSrc).toContain('recordStatusChange');
  });

  it('passes onError for user-visible error feedback', () => {
    expect(eqDetailSrc).toContain('onError:');
  });

  it('only calls onReload on success', () => {
    expect(eqDetailSrc).toContain('if (result.ok) onReload()');
  });
});
