import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {formatBroilerBatchLabel} from '../../src/lib/broilerBatchMeta.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const metaSrc = fs.readFileSync(path.join(ROOT, 'src/lib/broilerBatchMeta.js'), 'utf8');
const broilerView = fs.readFileSync(path.join(ROOT, 'src/broiler/BroilerDailysView.jsx'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
const adminModal = fs.readFileSync(path.join(ROOT, 'src/shared/AdminAddReportModal.jsx'), 'utf8');
const webformHub = fs.readFileSync(path.join(ROOT, 'src/webforms/WebformHub.jsx'), 'utf8');
const addFeed = fs.readFileSync(path.join(ROOT, 'src/webforms/AddFeedWebform.jsx'), 'utf8');

describe('formatBroilerBatchLabel helper', () => {
  it('returns plain name when no meta entry exists', () => {
    expect(formatBroilerBatchLabel('B-26-99', [])).toBe('B-26-99');
  });

  it('returns plain name for empty input', () => {
    expect(formatBroilerBatchLabel('', [])).toBe('');
    expect(formatBroilerBatchLabel(null, [])).toBe('');
  });

  it('shows schooner location when brooderOut is in the past', () => {
    const meta = [{name: 'B-26-07', schooners: ['2', '3'], brooder: '1', brooderOut: '2025-01-01'}];
    expect(formatBroilerBatchLabel('B-26-07', meta)).toBe('B-26-07 (Schooner 2 & 3)');
  });

  it('shows brooder location when brooderOut is not set', () => {
    const meta = [{name: 'B-26-08', schooners: ['4', '5'], brooder: '2', brooderOut: null}];
    expect(formatBroilerBatchLabel('B-26-08', meta)).toBe('B-26-08 (Brooder 2)');
  });

  it('shows brooder location when brooderOut is in the future', () => {
    const meta = [{name: 'B-26-08', schooners: ['1'], brooder: '3', brooderOut: '2099-01-01'}];
    expect(formatBroilerBatchLabel('B-26-08', meta)).toBe('B-26-08 (Brooder 3)');
  });

  it('handles single schooner', () => {
    const meta = [{name: 'B-26-01', schooners: ['1'], brooder: '1', brooderOut: '2025-01-01'}];
    expect(formatBroilerBatchLabel('B-26-01', meta)).toBe('B-26-01 (Schooner 1)');
  });

  it('handles multi-schooner label with 6&6A', () => {
    const meta = [{name: 'B-26-05', schooners: ['6', '6A'], brooder: '2', brooderOut: '2025-01-01'}];
    expect(formatBroilerBatchLabel('B-26-05', meta)).toBe('B-26-05 (Schooner 6 & 6A)');
  });

  it('falls back to plain name when no brooder or schooner data', () => {
    const meta = [{name: 'B-26-99', schooners: [], brooder: null, brooderOut: null}];
    expect(formatBroilerBatchLabel('B-26-99', meta)).toBe('B-26-99');
  });
});

describe('BroilerDailysView receives batches from main.jsx', () => {
  it('main.jsx passes batches prop to BroilerDailysView', () => {
    expect(mainSrc).toMatch(/BroilerDailysView,\s*\{[\s\S]*?batches/);
  });

  it('BroilerDailysView accepts batches as a prop', () => {
    expect(broilerView).toMatch(/\(\{[\s\S]*?batches[\s\S]*?\}\)\s*=>/);
  });

  it('BroilerDailysView does not have dead local batches state', () => {
    expect(broilerView).not.toMatch(/useState\(\[\]\)[\s\S]{0,5}setBatches/);
  });
});

describe('dropdown option labels use formatBroilerBatchLabel', () => {
  it('BroilerDailysView imports and uses the helper', () => {
    expect(broilerView).toContain('formatBroilerBatchLabel');
    expect(broilerView).toContain("from '../lib/broilerBatchMeta.js'");
  });

  it('AdminAddReportModal imports and uses the helper', () => {
    expect(adminModal).toContain('formatBroilerBatchLabel');
    expect(adminModal).toContain("from '../lib/broilerBatchMeta.js'");
  });

  it('WebformHub imports and uses the helper', () => {
    expect(webformHub).toContain('formatBroilerBatchLabel');
    expect(webformHub).toContain("from '../lib/broilerBatchMeta.js'");
  });

  it('AddFeedWebform imports and uses the helper', () => {
    expect(addFeed).toContain('formatBroilerBatchLabel');
    expect(addFeed).toContain("from '../lib/broilerBatchMeta.js'");
  });
});

describe('dropdown option values remain plain batch names', () => {
  it('BroilerDailysView option value is b.name', () => {
    expect(broilerView).toMatch(/value=\{b\.name\}/);
  });

  it('AdminAddReportModal option value is plain b', () => {
    expect(adminModal).toMatch(/value=\{b\}[\s\S]*?formatBroilerBatchLabel/);
  });

  it('WebformHub option value is plain b', () => {
    expect(webformHub).toMatch(/value=\{b\}[\s\S]*?formatBroilerBatchLabel/);
  });

  it('AddFeedWebform option value is name, label is formatted', () => {
    expect(addFeed).toMatch(/value: name\}/);
    expect(addFeed).toContain('formatBroilerBatchLabel(name, broilerMeta)');
  });
});

describe('buildBroilerPublicMirror includes location data', () => {
  it('meta entries include brooder and brooderOut', () => {
    expect(metaSrc).toMatch(/brooder:\s*b\.brooder/);
    expect(metaSrc).toMatch(/brooderOut:\s*b\.brooderOut/);
  });
});
