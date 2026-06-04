import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// ============================================================================
// Lane 1 CP2 — daily report writes go through the ownership RPCs.
// ----------------------------------------------------------------------------
// Gate for the 092 red-switch: once direct UPDATE/DELETE on the daily tables is
// revoked, ANY remaining client-side direct .update()/.delete() on those tables
// would break in production. This guard proves there are none left — every
// daily edit goes through update_daily_report and every delete through
// soft_delete_daily_report.
//
// equipment_fuelings / fuel_supplies are intentionally NOT covered here: their
// privileged edit UIs (/fleet EquipmentDetail, admin FuelLogAdmin) keep direct
// writes (RLS gates Light); Light edits them through the simple-owned RPCs.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const DAILY_TABLES = ['poultry_dailys', 'layer_dailys', 'egg_dailys', 'pig_dailys', 'cattle_dailys', 'sheep_dailys'];

function listSource(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listSource(full));
    else if (/\.(jsx?|cjs|mjs)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(full);
  }
  return out;
}

describe('CP2 — daily report writes are RPC-only', () => {
  const files = listSource(SRC);

  it('no client makes a direct .update()/.delete() on a daily table', () => {
    const offenders = [];
    for (const f of files) {
      // Collapse whitespace so multi-line method chains
      // (`sb.from('t')\n.update(rec)`) are detected the same as one-liners; the
      // `[^;]` bound keeps the match inside a single statement so a `.select()`
      // read query on the same table is not a false positive.
      const collapsed = fs.readFileSync(f, 'utf8').replace(/\s+/g, ' ');
      for (const t of DAILY_TABLES) {
        const re = new RegExp(`from\\( *['"]${t}['"] *\\)[^;]{0,200}?\\.(update|delete) *\\(`);
        if (re.test(collapsed)) offenders.push(`${path.relative(ROOT, f)} -> ${t}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('dailyReportsApi exposes the ownership-enforced edit + gate helpers', () => {
    const api = fs.readFileSync(path.join(SRC, 'lib/dailyReportsApi.js'), 'utf8');
    expect(api).toMatch(/export async function updateDailyReport/);
    expect(api).toMatch(/sb\.rpc\('update_daily_report'/);
    expect(api).toMatch(/export function canEditOwnRecord/);
    expect(api).toMatch(/record\.owner_profile_id === uid/);
  });
});
