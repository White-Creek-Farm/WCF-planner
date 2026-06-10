import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const TOKEN_CLOSURE_FILES = [
  'src/auth/LoginScreen.jsx',
  'src/auth/SetPasswordScreen.jsx',
  'src/auth/UsersModal.jsx',
  'src/cattle/CattleAnimalPage.jsx',
  'src/cattle/CattleBatchPage.jsx',
  'src/cattle/CowDetail.jsx',
  'src/equipment/EquipmentChecklistEntryPage.jsx',
  'src/equipment/EquipmentDetail.jsx',
  'src/equipment/EquipmentFuelingEntryPage.jsx',
  'src/layer/LayerBatchPage.jsx',
  'src/layer/LayerHousingPage.jsx',
  'src/livestock/WeighInSessionPage.jsx',
  'src/pig/PigBatchPage.jsx',
  'src/shared/CommentsSection.jsx',
  'src/shared/ErrorBoundary.jsx',
  'src/shared/Header.jsx',
  'src/shared/MentionTextarea.jsx',
  'src/shared/RecordActivityLog.jsx',
  'src/shared/RecordPageShell.jsx',
  'src/sheep/SheepAnimalPage.jsx',
  'src/sheep/SheepBatchPage.jsx',
  'src/sheep/SheepDetail.jsx',
  'src/tasks/TaskInstancePage.jsx',
];

const RETIRED_TOKEN_PATTERNS = [
  [/borderRadius:\s*(7|8)\b/g, 'retired 7/8 inline borderRadius'],
  [/border-radius:\s*(7|8)px/g, 'retired 7/8 CSS border-radius'],
  [/fontSize:\s*(9|10\.5|11\.5|12\.5|17|24|28)\b/g, 'retired fontSize'],
  [/font-size:\s*(9|10\.5|11\.5|12\.5|17|24|28)px/g, 'retired CSS font-size'],
  [/padding:\s*'(6px 14px|8px 14px|8px 16px)'/g, 'retired ad hoc action padding'],
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

describe('Lane I record/shared token closure', () => {
  it('keeps Codex-owned record/shared/auth surfaces off retired token values', () => {
    const found = TOKEN_CLOSURE_FILES.flatMap((rel) => violations(read(rel), rel));
    expect(found).toEqual([]);
  });

  it('equipment entry load-error Retry buttons use the shared record action token', () => {
    for (const rel of [
      'src/equipment/EquipmentFuelingEntryPage.jsx',
      'src/equipment/EquipmentChecklistEntryPage.jsx',
    ]) {
      const src = read(rel);
      expect(src).toContain("from '../shared/recordPageControls.jsx'");
      expect(src).toContain('recordSecondaryButton');
      expect(src).toContain('style={{...recordSecondaryButton, marginTop: 10}}');
    }
  });
});
