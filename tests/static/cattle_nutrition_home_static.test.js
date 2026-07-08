import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const homeSrc = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleHomeView.jsx'), 'utf8');

describe('CattleHome nutrition rolling windows', () => {
  it('uses true dry matter from feed moisture for DM/CP/NFC instead of as-fed pounds', () => {
    expect(homeSrc).toMatch(/import \{feedNutritionContribution\} from '\.\.\/lib\/cattleNutrition\.js';/);
    expect(homeSrc).toMatch(/const nutrition = feedNutritionContribution\(f\);/);
    expect(homeSrc).toMatch(/dm \+= nutrition\.dryMatterLbs;/);
    expect(homeSrc).toMatch(/cp \+= nutrition\.crudeProteinLbs;/);
    expect(homeSrc).toMatch(/nfc \+= nutrition\.nfcLbs;/);
    expect(homeSrc).not.toMatch(/dm \+= lbs;/);
    expect(homeSrc).not.toMatch(/cp \+= \(lbs \* \(parseFloat\(ns\.protein_pct\)/);
    expect(homeSrc).not.toMatch(/nfc \+= \(lbs \* \(parseFloat\(ns\.nfc_pct\)/);
  });

  it('keeps total feed and feed cost based on as-fed pounds', () => {
    expect(homeSrc).toMatch(/feedLbs \+= nutrition\.asFedLbs;/);
    expect(homeSrc).toMatch(/feedCost \+= nutrition\.asFedLbs \* cpl;/);
  });
});
