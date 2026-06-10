import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MODAL_ACTION_FILES = [
  'src/shared/AdminNewWeighInModal.jsx',
  'src/cattle/CattleNewWeighInModal.jsx',
  'src/sheep/SheepNewWeighInModal.jsx',
  'src/cattle/CattleSendToProcessorModal.jsx',
  'src/sheep/SheepSendToProcessorModal.jsx',
  'src/livestock/PigSendToTripModal.jsx',
  'src/equipment/EquipmentAddModal.jsx',
  'src/equipment/EquipmentMaintenanceModal.jsx',
];

describe('Lane I modal action-button token cleanup', () => {
  for (const rel of MODAL_ACTION_FILES) {
    const src = read(rel);

    it(`${rel} consumes the shared record action button tokens`, () => {
      expect(src).toContain('recordSecondaryButton');
      expect(src).toContain('recordSaveButton');
      expect(src).toContain('recordPageControls.jsx');
    });

    it(`${rel} does not re-declare retired modal action button sizing`, () => {
      expect(src).not.toContain("padding: '8px 14px'");
      expect(src).not.toContain("padding: '8px 16px'");
      expect(src).not.toContain("padding: '8px 20px'");
      expect(src).not.toMatch(/borderRadius:\s*7\D/);
    });
  }
});
