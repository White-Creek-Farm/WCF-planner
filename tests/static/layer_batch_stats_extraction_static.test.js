import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const viewSrc = fs.readFileSync(path.join(ROOT, 'src/layer/LayerBatchesView.jsx'), 'utf8');
const helperSrc = fs.readFileSync(path.join(ROOT, 'src/layer/layerBatchStats.js'), 'utf8');
const registrySrc = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');

describe('layerBatchStats helper module — surface', () => {
  it('exports HOUSING_CAPS, getHousingCap, inRange, calcPhaseFromAge, computeBatchStats, computeHousingStats', () => {
    expect(helperSrc).toContain('export const HOUSING_CAPS');
    expect(helperSrc).toContain('export function getHousingCap');
    expect(helperSrc).toContain('export function inRange');
    expect(helperSrc).toContain('export function calcPhaseFromAge');
    expect(helperSrc).toContain('export function computeBatchStats');
    expect(helperSrc).toContain('export function computeHousingStats');
  });

  it('is presentation- and side-effect-free (no React, no Supabase, no Activity)', () => {
    expect(helperSrc).not.toMatch(/from\s+['"]react['"]/);
    expect(helperSrc).not.toMatch(/from\s+['"]@supabase/);
    expect(helperSrc).not.toMatch(/useState|useEffect|useRef|JSX|render/);
    expect(helperSrc).not.toContain('ActivityPanel');
    expect(helperSrc).not.toContain('ActivityModal');
    expect(helperSrc).not.toContain('recordActivityEvent');
    expect(helperSrc).not.toContain('recordFieldChange');
    expect(helperSrc).not.toContain("from('");
    expect(helperSrc).not.toContain('.update(');
    expect(helperSrc).not.toContain('.insert(');
    expect(helperSrc).not.toContain('.delete(');
  });

  it('preserves feed phase thresholds 21 and 140', () => {
    expect(helperSrc).toContain('days < 21');
    expect(helperSrc).toContain('days < 140');
  });

  it('falls back to LAYER when anchor and storedType are missing', () => {
    expect(helperSrc).toMatch(/storedType\s*\|\|\s*'LAYER'/);
  });
});

describe('LayerBatchesView hub — uses the extracted helpers', () => {
  it('imports computeBatchStats from layerBatchStats.js for tile stats', () => {
    expect(viewSrc).toMatch(/import\s+\{[^}]*computeBatchStats[^}]*\}\s+from\s+['"]\.\/layerBatchStats\.js['"]/);
  });

  it('no longer defines HOUSING_CAPS or getHousingCap inline', () => {
    expect(viewSrc).not.toMatch(/^\s*const\s+HOUSING_CAPS\s*=\s*\{/m);
    expect(viewSrc).not.toMatch(/^\s*const\s+getHousingCap\s*=/m);
  });

  it('no longer defines inRange or calcPhaseFromAge inline', () => {
    expect(viewSrc).not.toMatch(/function\s+inRange\s*\(/);
    expect(viewSrc).not.toMatch(/function\s+calcPhaseFromAge\s*\(/);
  });

  it('uses computeBatchStats for hub tile stats (via useMemo, not setBatchStats)', () => {
    expect(viewSrc).toContain('computeBatchStats(');
  });

  it('preserves the layerHousing helper imports the hub still uses', () => {
    expect(viewSrc).toContain('computeHousingDisplayCount');
    expect(viewSrc).toContain('computeLayerFeedCost');
    expect(viewSrc).toContain("from '../lib/layerHousing.js'");
  });
});

describe('LayerBatchesView — migrated to record pages', () => {
  it('no longer uses ActivityPanel or ActivityModal in the hub', () => {
    expect(viewSrc).not.toContain('ActivityPanel');
    expect(viewSrc).not.toContain('ActivityModal');
  });

  it('no longer listens for wcf-entity-deep-link in the hub', () => {
    expect(viewSrc).not.toContain('wcf-entity-deep-link');
  });

  it('tiles navigate to /layer/batches/<id>', () => {
    expect(viewSrc).toContain("navigate('/layer/batches/' + batch.id");
  });

  it('activityRegistry routes layer.batch + layer.housing to per-record routes', () => {
    expect(registrySrc).toMatch(/LAYER_BATCH[\s\S]*?route:\s*\(id\)\s*=>\s*'\/layer\/batches\/'\s*\+\s*id/);
    expect(registrySrc).toMatch(/LAYER_HOUSING[\s\S]*?route:\s*\(id\)\s*=>\s*'\/layer\/housings\/'\s*\+\s*id/);
  });

  it('main.jsx URL adapter now detects /layer/batches/<id> and /layer/housings/<id> subpaths', () => {
    expect(mainSrc).toContain("location.pathname.startsWith('/layer/batches/')");
    expect(mainSrc).toContain("location.pathname.startsWith('/layer/housings/')");
  });
});
