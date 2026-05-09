#!/usr/bin/env node
// One-shot script: resize + re-encode the raw PNGs from
// `<sourceDir>` into `<outDir>` for use under public/icons/planner/.
//
// sharp is not a project dependency — install it on demand before running.
// Recommended invocation:
//
//   npm install --no-save sharp@0.34.5
//   node scripts/optimize_planner_icons.cjs
//
// Optional explicit paths:
//
//   node scripts/optimize_planner_icons.cjs <sourceDir> <outDir>
//
// (`npx --yes -p sharp` does NOT make sharp resolvable from a separate
// .cjs file — confirmed during the 2026-05-08 icon lane. Install via
// npm --no-save and the require() at line 39 will find it.)
//
// Targets a max dimension of 256px at PNG quality ~80, palette compression,
// effort 10. Most icons land at 30-90 KB on this profile (vs 1-3 MB raw).

'use strict';
const fs = require('fs');
const path = require('path');

const sourceDir = process.argv[2] || 'C:/Users/Ronni/OneDrive/Desktop/planner pics';
const outDir = process.argv[3] || path.join(__dirname, '..', 'public', 'icons', 'planner');

// key (kebab-case) <- file basename. Outputs are written using the key
// so the runtime referencing layer never sees PascalCase or spaces.
const MAP = {
  broiler: 'broiler.png',
  'laying-hen': 'Laying hen.png',
  eggs: 'eggs.png',
  // App-facing pig key resolves to /icons/planner/pig.png, but the
  // source asset is "pig v2.png" (Ronnie's updated pig PNG, 2026-05-08).
  // Old "pig.png" desktop file stays out of the app set.
  pig: 'pig v2.png',
  cow: 'cow.png',
  sheep: 'sheep.png',
  tractor: 'Tractor.png',
  atv: 'ATV.png',
  hijet: 'Hijet.png',
  mowers: 'mowers.png',
  skidsteers: 'skidsteers.png',
  forestry: 'Forestry.png',
  fueling: 'Fueling.png',
  feed: 'feed.png',
  checkmark: 'checkmark.png',
  weighins: 'Weigh ins.png',
};

(async () => {
  const sharp = require('sharp');
  if (!fs.existsSync(sourceDir)) {
    console.error('Source dir missing:', sourceDir);
    process.exit(1);
  }
  fs.mkdirSync(outDir, {recursive: true});

  const results = [];
  for (const [key, srcName] of Object.entries(MAP)) {
    const src = path.join(sourceDir, srcName);
    const dst = path.join(outDir, `${key}.png`);
    if (!fs.existsSync(src)) {
      console.warn(`  [skip] missing source: ${srcName}`);
      continue;
    }
    const inSize = fs.statSync(src).size;
    await sharp(src)
      .resize({width: 256, height: 256, fit: 'inside', withoutEnlargement: true})
      .png({compressionLevel: 9, palette: true, quality: 80, effort: 10})
      .toFile(dst);
    const outSize = fs.statSync(dst).size;
    results.push({key, srcName, inSize, outSize});
    console.log(
      `  ${key.padEnd(12)} ${(inSize / 1024).toFixed(0).padStart(6)} KB -> ${(outSize / 1024)
        .toFixed(0)
        .padStart(4)} KB`,
    );
  }

  const totalIn = results.reduce((a, r) => a + r.inSize, 0);
  const totalOut = results.reduce((a, r) => a + r.outSize, 0);
  console.log(`\n  total: ${(totalIn / 1024 / 1024).toFixed(2)} MB -> ${(totalOut / 1024).toFixed(0)} KB`);
})();
