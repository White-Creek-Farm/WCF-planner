import {describe, it, expect} from 'vitest';
import ledger from '../scripts/fleet/ledger.cjs';

const {checksum, listMigrations, extractPostconditions, classifyAdoption, reconcile, ledgerUpsertSql} = ledger;

describe('checksum', () => {
  it('is deterministic and CRLF-normalized', () => {
    expect(checksum('a\nb')).toBe(checksum('a\r\nb'));
    expect(checksum('a')).not.toBe(checksum('b'));
    expect(checksum('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('listMigrations', () => {
  const migs = listMigrations();
  it('enumerates archive 001-026 + parent in numeric order with unique versions', () => {
    expect(migs.length).toBeGreaterThan(150);
    expect(migs[0].version).toBe('001');
    expect(migs.at(-1).version).toBe('191');
    const versions = migs.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    // strictly ascending
    for (let i = 1; i < versions.length; i++) expect(Number(versions[i])).toBeGreaterThan(Number(versions[i - 1]));
  });
});

describe('extractPostconditions', () => {
  it('pulls tables, functions, and buckets', () => {
    const sql = `
      create table if not exists public.foo (id int);
      CREATE OR REPLACE FUNCTION public.bar(p int) returns void as $$ begin end $$ language plpgsql;
      insert into storage.buckets (id, public) values ('daily-photos', false);`;
    const pcs = extractPostconditions(sql);
    expect(pcs).toContainEqual({type: 'table', name: 'foo'});
    expect(pcs).toContainEqual({type: 'function', name: 'bar'});
    expect(pcs).toContainEqual({type: 'bucket', name: 'daily-photos'});
  });

  it('returns [] for pure data/alter migrations', () => {
    expect(
      extractPostconditions('update public.foo set x=1; alter table public.foo alter column x set default 0;'),
    ).toEqual([]);
  });
});

const snap = {
  baseTables: new Set(['foo']),
  allRelations: new Set(['foo']),
  functionNames: new Set(['bar']),
  functionSignatures: new Set(['bar(integer)']),
  buckets: new Set(['daily-photos']),
};

describe('classifyAdoption', () => {
  it('adopts-verified when all postconditions exist', () => {
    const r = classifyAdoption(
      'create table public.foo(id int); create function public.bar(p int) returns void as $$begin end$$ language plpgsql;',
      snap,
    );
    expect(r.status).toBe('adopted-verified');
    expect(r.postconditionCount).toBe(2);
  });

  it('REFUSES a partially applied migration (a postcondition object is missing)', () => {
    const r = classifyAdoption('create table public.foo(id int); create table public.missing_tbl(id int);', snap);
    expect(r.status).toBe('refused');
    expect(r.missing).toContainEqual({type: 'table', name: 'missing_tbl'});
  });

  it('adopts-checksum-only when there is no verifiable postcondition', () => {
    const r = classifyAdoption('update public.foo set x = 1;', snap);
    expect(r.status).toBe('adopted-checksum-only');
    expect(r.postconditionCount).toBe(0);
  });
});

describe('reconcile (drift detection)', () => {
  const migs = listMigrations().slice(0, 3); // 001,002,003
  const goodRows = migs.map((m) => ({
    version: m.version,
    kind: 'migration',
    checksum: checksum(require('fs').readFileSync(m.path, 'utf8')),
  }));

  it('reports ok when ledger matches the repo', () => {
    expect(reconcile(migs, goodRows).ok).toBe(true);
  });

  it('detects a changed migration body (checksum mismatch)', () => {
    const tampered = goodRows.map((r, i) => (i === 1 ? {...r, checksum: 'deadbeef'} : r));
    const rep = reconcile(migs, tampered);
    expect(rep.ok).toBe(false);
    expect(rep.changed.map((c) => c.version)).toContain(migs[1].version);
  });

  it('detects a migration missing from the ledger', () => {
    const rep = reconcile(migs, goodRows.slice(0, 2));
    expect(rep.missingFromLedger).toContain(migs[2].version);
  });

  it('detects an extra ledger version not in the repo', () => {
    const rep = reconcile(migs, [...goodRows, {version: '999', kind: 'migration', checksum: 'x'}]);
    expect(rep.extra).toContain('999');
  });
});

describe('ledgerUpsertSql', () => {
  it('emits an upsert with escaped values', () => {
    const sql = ledgerUpsertSql({
      version: '110',
      kind: 'migration',
      sum: 'abc',
      status: 'executed',
      postconditionCount: 2,
      note: "it's fine",
    });
    expect(sql).toContain('insert into public.wcf_fleet_migrations');
    expect(sql).toContain("'110'");
    expect(sql).toContain('on conflict (version) do update');
    expect(sql).toContain("it''s fine"); // escaped
  });
});
