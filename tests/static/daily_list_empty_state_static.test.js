import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const helper = read('src/shared/OperationalListEmptyState.jsx');

const DAILY_HUBS = [
  ['src/broiler/BroilerDailysView.jsx', 'No broiler daily reports yet'],
  ['src/pig/PigDailysView.jsx', 'No pig daily reports yet'],
  ['src/cattle/CattleDailysView.jsx', 'No cattle daily reports yet'],
  ['src/sheep/SheepDailysView.jsx', 'No sheep daily reports yet'],
  ['src/layer/LayerDailysView.jsx', 'No layer daily reports yet'],
  ['src/layer/EggDailysView.jsx', 'No egg reports yet'],
];

describe('Lane F CP3 daily list empty-state primitive', () => {
  it('owns the shared empty-state chrome and load-error suppression', () => {
    expect(helper).toContain('export default function OperationalListEmptyState');
    expect(helper).toContain('if (loading || loadError || filteredCount > 0) return null');
    expect(helper).toContain('totalCount === 0 ? emptyLabel : filteredLabel');
    expect(helper).toContain("filteredLabel = 'No records match the current filters'");
    expect(helper).toContain(
      "data-empty-state={dataEmptyState || (totalCount === 0 ? 'true-empty' : 'filtered-empty')}",
    );
  });

  for (const [rel, emptyLabel] of DAILY_HUBS) {
    it(`${rel} delegates true-empty and filtered-empty rendering to OperationalListEmptyState`, () => {
      const src = read(rel);
      expect(src).toContain("from '../shared/OperationalListEmptyState.jsx'");
      expect(src).toContain('<OperationalListEmptyState');
      expect(src).toContain('loading={loading}');
      expect(src).toContain('loadError={loadError}');
      expect(src).toContain('totalCount={records.length}');
      expect(src).toContain('filteredCount={filtered.length}');
      expect(src).toContain(`emptyLabel="${emptyLabel}"`);
      expect(src).toMatch(/!\s*loading && !loadError && filtered\.length > 0/);
      expect(src).not.toContain('No records found');
    });
  }

  it('EggDailysView keeps egg-specific filtered-empty copy', () => {
    const src = read('src/layer/EggDailysView.jsx');
    expect(src).toContain('filteredLabel="No egg reports match the current filters"');
  });
});
