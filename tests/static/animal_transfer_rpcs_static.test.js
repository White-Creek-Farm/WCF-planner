import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const mig075 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/075_animal_transfer_activity_rpcs.sql'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/animalTransferApi.js'), 'utf8');

function fnBody(name) {
  const m = mig075.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$fn\\$;`));
  expect(m, `expected ${name} definition`).not.toBeNull();
  return m[0];
}

const SPECS = [
  {
    name: 'transfer_cattle_animal',
    entity: 'cattle.animal',
    table: 'public.cattle',
    audit: 'public.cattle_transfers',
    field: 'herd',
    dests: ['mommas', 'backgrounders', 'finishers', 'bulls', 'processed', 'deceased', 'sold'],
    sig: 'text, text, text, text',
  },
  {
    name: 'transfer_sheep_animal',
    entity: 'sheep.animal',
    table: 'public.sheep',
    audit: 'public.sheep_transfers',
    field: 'flock',
    dests: ['rams', 'ewes', 'feeders', 'processed', 'deceased', 'sold'],
    sig: 'text, text, text, text',
  },
];

for (const s of SPECS) {
  describe(`mig 075 — ${s.name}`, () => {
    it('is SECURITY DEFINER with a pinned search_path', () => {
      const fn = fnBody(s.name);
      expect(fn).toMatch(/SECURITY DEFINER/);
      expect(fn).toMatch(/SET search_path = public/);
    });

    it('requires an authenticated active caller but is NOT admin-only (operational)', () => {
      const fn = fnBody(s.name);
      expect(fn).toMatch(/auth\.uid\(\)/);
      expect(fn).toMatch(/v_role = 'inactive'/);
      expect(fn).not.toMatch(/admin role required/);
      expect(fn).not.toMatch(/v_role <> 'admin'/);
    });

    it('validates the destination against active + outcome states', () => {
      const fn = fnBody(s.name);
      for (const d of s.dests) expect(fn).toContain(`'${d}'`);
      expect(fn).toMatch(/invalid destination/);
    });

    it('rejects missing/deleted source rows', () => {
      const fn = fnBody(s.name);
      expect(fn).toMatch(/deleted_at IS NULL/);
      expect(fn).toMatch(/record not found or deleted/);
    });

    it('no-ops when destination equals current, returning noop without writes', () => {
      const fn = fnBody(s.name);
      expect(fn).toMatch(/IF v_from = p_to_\w+ THEN[\s\S]*?'noop', true/);
    });

    it('sets death_date for deceased and sale_date for sold when missing', () => {
      const fn = fnBody(s.name);
      expect(fn).toMatch(/death_date = CASE WHEN p_to_\w+ = 'deceased' AND death_date IS NULL THEN current_date/);
      expect(fn).toMatch(/sale_date\s+= CASE WHEN p_to_\w+ = 'sold'\s+AND sale_date\s+IS NULL THEN current_date/);
    });

    it('writes the transfer audit row and a status.changed Activity event in one function', () => {
      const fn = fnBody(s.name);
      expect(fn).toContain(`INSERT INTO ${s.audit}`);
      expect(fn).toContain("'status.changed'");
      expect(fn).toContain(`'${s.entity}'`);
      expect(fn).toContain('INSERT INTO public.activity_events');
      expect(fn).toMatch(new RegExp(`'field', '${s.field}'`));
      expect(fn).toMatch(/'transfer_id', v_tr_id/);
      expect(fn).toMatch(/'entity_label', v_label/);
    });

    it('REVOKEs from anon and GRANTs EXECUTE to authenticated', () => {
      expect(mig075).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${s.name}\\(${s.sig}\\) FROM PUBLIC, anon`));
      expect(mig075).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${s.name}\\(${s.sig}\\) TO authenticated`));
    });
  });
}

describe('mig 075 — NOTIFY', () => {
  it('ends with NOTIFY pgrst reload', () => {
    expect(mig075).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});

describe('animalTransferApi — exports', () => {
  it('exports transferCattleAnimal calling the RPC', () => {
    expect(apiSrc).toMatch(/export async function transferCattleAnimal/);
    expect(apiSrc).toContain("sb.rpc('transfer_cattle_animal'");
    expect(apiSrc).toContain('p_to_herd: toHerd');
  });
  it('exports transferSheepAnimal calling the RPC', () => {
    expect(apiSrc).toMatch(/export async function transferSheepAnimal/);
    expect(apiSrc).toContain("sb.rpc('transfer_sheep_animal'");
    expect(apiSrc).toContain('p_to_flock: toFlock');
  });
});

describe('CattleHerdsView — dead client transfer helper removed', () => {
  it('no longer defines a client transferCow that inserts cattle_transfers', () => {
    const herds = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleHerdsView.jsx'), 'utf8');
    expect(herds).not.toContain('async function transferCow');
    expect(herds).not.toContain("from('cattle_transfers')");
  });
});
