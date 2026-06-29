// Static lock: expanded cow / sheep detail panes show a read-only Age
// alongside the existing Birth Date input.
//
// Operators see age on the collapsed herd/flock tile; without this prop,
// it disappears once the animal is expanded. Active animals show current age.
// Outcome-herd cattle show age at the terminal event instead, and the shared
// detail component can render the row label supplied by the caller.

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {describe, it, expect} from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

const COW_DETAIL_CALLERS = ['src/cattle/CattleAnimalPage.jsx', 'src/cattle/CattleForecastView.jsx'];

const animalPage = readFileSync(resolve(ROOT, 'src/cattle/CattleAnimalPage.jsx'), 'utf8');
const forecastView = readFileSync(resolve(ROOT, 'src/cattle/CattleForecastView.jsx'), 'utf8');
const cowDetail = readFileSync(resolve(ROOT, 'src/cattle/CowDetail.jsx'), 'utf8');
const sheepDetail = readFileSync(resolve(ROOT, 'src/sheep/SheepDetail.jsx'), 'utf8');

describe('Every CowDetail caller passes ageLabel', () => {
  // Any file that renders <CowDetail> must pass the ageLabel prop, so the
  // shared Age row in CowDetail never falls back to "—" by accident in a
  // surface where age is already available. New callers added in the
  // future will fail this lock until they pass the prop.
  it('all CowDetail callers in src/ pass ageLabel', () => {
    for (const rel of COW_DETAIL_CALLERS) {
      const source = readFileSync(resolve(ROOT, rel), 'utf8');
      const cowDetailOpens = source.match(/<CowDetail\b/g) || [];
      const agePropPasses = source.match(/ageLabel=\{/g) || [];
      expect(cowDetailOpens.length, `${rel}: expected at least one <CowDetail> render`).toBeGreaterThan(0);
      expect(agePropPasses.length, `${rel}: ageLabel prop count must match <CowDetail> render count`).toBe(
        cowDetailOpens.length,
      );
    }
  });
});

describe('CattleAnimalPage → CowDetail ageLabel wiring', () => {
  it('loads cattle processing batches so processed records can age against the process date', () => {
    expect(animalPage).toContain("from('cattle_processing_batches')");
    expect(animalPage).toContain("select('id,name,actual_process_date,planned_process_date')");
  });

  it('computes event-specific age labels for outcome herd records', () => {
    expect(animalPage).toContain('function terminalAgeInfo');
    expect(animalPage).toContain("cow.herd === 'processed'");
    expect(animalPage).toContain("fieldLabel: 'Age at processing'");
    expect(animalPage).toContain('processingBatchDate(processingBatch)');
    expect(animalPage).toContain("cow.herd === 'sold'");
    expect(animalPage).toContain("fieldLabel: 'Age at sale'");
    expect(animalPage).toContain('cow.sale_date');
    expect(animalPage).toContain("cow.herd === 'deceased'");
    expect(animalPage).toContain("fieldLabel: 'Age at death'");
    expect(animalPage).toContain('cow.death_date');
  });

  it('passes the event-aware label and value into CowDetail', () => {
    expect(animalPage).toContain('const cowAge = terminalAgeInfo(cow, processingBatch)');
    expect(animalPage).toMatch(/ageFieldLabel=\{cowAge\.fieldLabel\}/);
    expect(animalPage).toMatch(/ageLabel=\{cowAge\.ageLabel\}/);
  });
});

describe('CattleForecastView → CowDetail ageLabel wiring', () => {
  it('passes the existing local ageStr ("—" already baked in upstream)', () => {
    expect(forecastView).toMatch(/ageLabel=\{ageStr\}/);
  });
});

describe('CowDetail accepts and renders ageLabel near birth_date', () => {
  it('destructures ageLabel from props', () => {
    expect(cowDetail).toMatch(/\bageLabel\b/);
  });

  it('renders the caller-supplied age field label and the ageLabel value with the "—" fallback', () => {
    expect(cowDetail).toMatch(/ageFieldLabel\s*=\s*'Age'/);
    expect(cowDetail).toMatch(/\{ageFieldLabel\}:<\/span>/);
    expect(cowDetail).toMatch(/\{ageLabel\s*\|\|\s*'—'\}/);
  });

  it('Age block sits between Birth and Purchased fields', () => {
    const birthIdx = cowDetail.indexOf('cow.birth_date');
    const ageIdx = cowDetail.indexOf('{ageFieldLabel}:</span>');
    const purchasedIdx = cowDetail.indexOf('cow.purchase_date');
    expect(birthIdx).toBeGreaterThan(-1);
    expect(ageIdx).toBeGreaterThan(birthIdx);
    expect(purchasedIdx).toBeGreaterThan(ageIdx);
  });
});

describe('SheepAnimalPage → SheepDetail ageLabel wiring', () => {
  const sheepAnimalPage = readFileSync(resolve(ROOT, 'src/sheep/SheepAnimalPage.jsx'), 'utf8');
  it('passes ageLabel into the SheepDetail render site', () => {
    expect(sheepAnimalPage).toMatch(/ageLabel=\{age\(animal\.birth_date\)\s*\|\|\s*'—'\}/);
  });
});

describe('SheepDetail accepts and renders ageLabel near birth_date', () => {
  it('destructures ageLabel from props', () => {
    expect(sheepDetail).toMatch(/\bageLabel\b/);
  });

  it('renders an "Age:" label and the ageLabel value with the "—" fallback', () => {
    expect(sheepDetail).toMatch(/>Age:</);
    expect(sheepDetail).toMatch(/\{ageLabel\s*\|\|\s*'—'\}/);
  });

  it('Age block sits between Birth and Purchased fields', () => {
    const birthIdx = sheepDetail.indexOf('sheep.birth_date');
    const ageIdx = sheepDetail.indexOf('>Age:<');
    const purchasedIdx = sheepDetail.indexOf('sheep.purchase_date');
    expect(birthIdx).toBeGreaterThan(-1);
    expect(ageIdx).toBeGreaterThan(birthIdx);
    expect(purchasedIdx).toBeGreaterThan(ageIdx);
  });
});
