import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('broiler on-farm count contract', () => {
  const broilerLib = read('src/lib/broiler.js');
  const homeDashboard = read('src/dashboard/HomeDashboard.jsx');
  const broilerHome = read('src/broiler/BroilerHomeView.jsx');

  it('centralizes the active live-bird aggregate in the broiler library', () => {
    expect(broilerLib).toContain('export function computeBroilerOnFarmCounts');
    expect(broilerLib).toContain('onFarmBirds += stats.projectedBirds');
    expect(broilerLib).toContain('startedBirds += started');
  });

  it('uses live on-farm birds on the main Home dashboard', () => {
    expect(homeDashboard).toContain('computeBroilerOnFarmCounts');
    expect(homeDashboard).toContain('const broilerOnFarm = broilerOnFarmCounts.onFarmBirds');
    expect(homeDashboard).toContain('${broilerOnFarm.toLocaleString()} on farm');
    expect(homeDashboard).not.toContain('const birdsOnFarm = activeBatches.reduce');
    expect(homeDashboard).not.toContain('const projectedBirds = activeBatches.reduce');
  });

  it('labels live birds and started birds separately on the Broiler dashboard', () => {
    expect(broilerHome).toContain('computeBroilerOnFarmCounts');
    expect(broilerHome).toContain('label="Birds on Farm"');
    expect(broilerHome).toContain('broilerOnFarmCounts.onFarmBirds.toLocaleString()');
    expect(broilerHome).toContain('label="Birds Started"');
    expect(broilerHome).toContain("l: 'On-farm birds'");
    expect(broilerHome).not.toContain('label="Projected Birds"');
  });
});
