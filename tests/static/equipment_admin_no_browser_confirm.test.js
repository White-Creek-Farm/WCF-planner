// Static lock: checkpoint 1 of the project-wide browser-dialog cleanup.
//
// Admin/equipment delete and removal flows must route through the typed
// DeleteModal (via window._wcfConfirmDelete), not window.confirm or bare
// confirm(). PROJECT.md Cross-App contract: "Do not introduce window.confirm,
// window.alert, or window.prompt for destructive flows; use typed
// confirmation modals. Use DeleteModal for deletes."
//
// Scoped to the five files cleared in checkpoint 1. Other surfaces
// (cattle/sheep/pig/auth/public webform) are still pending later checkpoints
// and are intentionally not asserted here.

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {describe, it, expect} from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

const SCOPED_FILES = [
  'src/admin/EquipmentMaterialsEditor.jsx',
  'src/admin/EquipmentWebformsAdmin.jsx',
  'src/admin/FuelLogAdmin.jsx',
  'src/admin/FuelBillsView.jsx',
  'src/equipment/EquipmentDetail.jsx',
];

// Matches `confirm(` and `window.confirm(` but not identifier suffixes
// (`confirmDelete(`, `_wcfConfirmDelete(`, etc.). The leading boundary check
// rejects matches where `confirm` is preceded by a word char or dot-prefix
// other than `window.`.
const DESTRUCTIVE_CONFIRM_RE = /(?:^|[^A-Za-z0-9_.])(?:window\.)?confirm\(/;

describe('admin/equipment delete flows: no browser confirm()', () => {
  for (const rel of SCOPED_FILES) {
    it(`${rel} routes destructive confirms through the typed modal`, () => {
      const source = readFileSync(resolve(ROOT, rel), 'utf8');
      expect(source).not.toMatch(DESTRUCTIVE_CONFIRM_RE);
    });
  }
});
