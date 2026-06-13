import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// Scoped to the daily/reporting hub list surfaces only. Keep this list tight so
// the guard does not silently expand into a source-wide token-cleanup lane.
const DAILY_HUB_FILES = [
  'src/broiler/BroilerDailysView.jsx',
  'src/pig/PigDailysView.jsx',
  'src/cattle/CattleDailysView.jsx',
  'src/sheep/SheepDailysView.jsx',
  'src/layer/LayerDailysView.jsx',
  'src/layer/EggDailysView.jsx',
  'src/equipment/EquipmentFuelLogView.jsx',
];

// Retired radius tokens (7/8) and the ad hoc action paddings normalized in this
// slice. The data-row/header 6px 14px and the load-error/toolbar 7px 14px values
// are intentionally NOT forbidden here.
const RETIRED_TOKEN_PATTERNS = [
  [/borderRadius:\s*(7|8)\b/g, 'retired 7/8 inline borderRadius'],
  [/border-radius:\s*(7|8)px/g, 'retired 7/8 CSS border-radius'],
  [/padding:\s*'(8px 14px|8px 16px|8px 20px)'/g, 'retired ad hoc action padding'],
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function violations(src, rel) {
  const out = [];
  for (const [pattern, label] of RETIRED_TOKEN_PATTERNS) {
    for (const match of src.matchAll(pattern)) {
      const line = src.slice(0, match.index).split('\n').length;
      out.push(`${rel}:${line} ${label}: ${match[0]}`);
    }
  }
  return out;
}

describe('Lane I daily-hub token closure', () => {
  it('keeps the daily/reporting hub list surfaces off retired radius/padding tokens', () => {
    const found = DAILY_HUB_FILES.flatMap((rel) => violations(read(rel), rel));
    expect(found).toEqual([]);
  });
});
