import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// CP3 record-page sequence navigation wiring locks. Each operational record
// family that has a dedicated record page passes the originating list's visible
// order through route state (recordSeqNavOptions) and renders the shared
// RecordSequenceNav on the record page, carrying the sequence forward.
//
// broiler.batch is intentionally EXCLUDED — BatchForm already ships embedded
// prev/next controls; see the deferral lock at the bottom.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const HELPER_IMPORT = "from '../lib/recordSequence.js'";
const NAV_IMPORT = "from '../shared/RecordSequenceNav.jsx'";

// [label, listFile, listAssertions[], pageFile, pageRoutePrefix, currentIdExpr]
const SURFACES = [
  {
    name: 'cattle.processing',
    list: 'src/cattle/CattleBatchesView.jsx',
    listContains: [
      // Processed batches are collapsed behind Show Processed Batches; they
      // only join the sequence when that section is expanded.
      'const batchSeqRows = [...scheduledList, ...active, ...(showCompleted ? completed : [])]',
      "labeledSeqItems(batchSeqRows, 'name')",
    ],
    page: 'src/cattle/CattleBatchPage.jsx',
    nav: "navigate('/cattle/batches/' + id, recordSeqNavOptions(recordSeq))",
  },
  {
    name: 'sheep.processing',
    list: 'src/sheep/SheepBatchesView.jsx',
    listContains: ['const batchSeqRows = [...planned, ...completed]', "labeledSeqItems(batchSeqRows, 'name')"],
    page: 'src/sheep/SheepBatchPage.jsx',
    nav: "navigate('/sheep/batches/' + id, recordSeqNavOptions(recordSeq))",
  },
  {
    name: 'layer.batch',
    list: 'src/layer/LayerBatchesView.jsx',
    listContains: [
      'const batchSeqRows = [...activeBatches, ...retiredBatches]',
      "labeledSeqItems(batchSeqRows, 'name')",
    ],
    page: 'src/layer/LayerBatchPage.jsx',
    nav: "navigate('/layer/batches/' + id, recordSeqNavOptions(recordSeq))",
  },
  {
    name: 'layer.housing',
    list: 'src/layer/LayerBatchPage.jsx',
    listContains: ["recordSeqNavOptions(labeledSeqItems(batchHousings, 'housing_name'))"],
    page: 'src/layer/LayerHousingPage.jsx',
    nav: "navigate('/layer/housings/' + id, recordSeqNavOptions(recordSeq))",
  },
  {
    name: 'pig.batch',
    list: 'src/pig/PigBatchesView.jsx',
    listContains: ['const visiblePigBatches =', "labeledSeqItems(rows, 'batchName')"],
    page: 'src/pig/PigBatchesView.jsx',
    nav: "navigate('/pig/batches/' + encodeURIComponent(id), recordSeqNavOptions(recordSeq))",
  },
  {
    name: 'task.instance',
    list: 'src/tasks/MyTasksTab.jsx',
    listContains: [
      'const taskSeqRows =',
      // Collapsed other-assignee groups are excluded — only expanded groups join.
      'otherGroups.filter((g) => isGroupOpen(',
      "labeledSeqItems(taskSeqRows, 'title')",
    ],
    page: 'src/tasks/TaskInstancePage.jsx',
    nav: "navigate('/tasks/' + id, recordSeqNavOptions(recordSeq))",
  },
];

for (const s of SURFACES) {
  describe(`CP3 sequence nav — ${s.name}`, () => {
    const listSrc = read(s.list);
    const pageSrc = read(s.page);

    it('list imports the recordSequence helpers', () => {
      expect(listSrc).toContain(HELPER_IMPORT);
    });
    it('list passes the visible-order sequence through route state', () => {
      expect(listSrc).toContain('recordSeqNavOptions(');
      for (const c of s.listContains) expect(listSrc, c).toContain(c);
    });
    it('record page reads the sequence from route state', () => {
      expect(pageSrc).toContain('location.state?.recordSeq');
    });
    it('record page renders the shared RecordSequenceNav', () => {
      expect(pageSrc).toContain(NAV_IMPORT);
      expect(pageSrc).toContain('<RecordSequenceNav');
    });
    it('record page carries the sequence forward', () => {
      expect(pageSrc).toContain(s.nav);
    });
  });
}

// CompletedTab is the second task list surface.
describe('CP3 sequence nav — task.instance (CompletedTab)', () => {
  const src = read('src/tasks/CompletedTab.jsx');
  it('passes the completed visible order through route state', () => {
    expect(src).toContain('const taskSeqRows =');
    expect(src).toContain("labeledSeqItems(taskSeqRows, 'title')");
  });
});

// equipment.item is split: EquipmentFleetView builds the visible order and
// hands it up via onOpen; EquipmentHome (the nav owner) builds the slug-keyed
// options and renders RecordSequenceNav above the prop-driven EquipmentDetail.
describe('CP3 sequence nav — equipment.item', () => {
  const fleet = read('src/equipment/EquipmentFleetView.jsx');
  const home = read('src/equipment/EquipmentHome.jsx');
  it('fleet view builds the visible order and passes it through onOpen', () => {
    expect(fleet).toContain('const fleetSeqRows =');
    expect(fleet).toContain('onOpen(eq.slug, fleetSeqRows)');
  });
  it('home imports helpers and builds slug-keyed labeled items', () => {
    expect(home).toContain(HELPER_IMPORT);
    expect(home).toContain("labeledSeqItems(items, 'name', 'slug')");
  });
  it('home reads the sequence from route state and renders RecordSequenceNav', () => {
    expect(home).toContain('location.state?.recordSeq');
    expect(home).toContain(NAV_IMPORT);
    expect(home).toContain('<RecordSequenceNav');
  });
  it('home carries the sequence forward (slug-keyed)', () => {
    expect(home).toContain("navigate('/fleet/' + slug, recordSeqNavOptions(recordSeq))");
  });
});

describe('CP3 — broiler.batch deferred (existing BatchForm prev/next)', () => {
  it('BroilerBatchPage does NOT add a duplicate RecordSequenceNav', () => {
    const src = read('src/broiler/BroilerBatchPage.jsx');
    expect(src).not.toContain('RecordSequenceNav');
  });
  it('BatchForm retains its embedded prev/next props', () => {
    const src = read('src/broiler/BatchForm.jsx');
    expect(src).toContain('onNavigatePrev');
    expect(src).toContain('onNavigateNext');
  });
});
