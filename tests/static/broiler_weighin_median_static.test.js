import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const ROOT = process.cwd();
const listSrc = fs.readFileSync(path.join(ROOT, 'src/livestock/LivestockWeighInsView.jsx'), 'utf8');
const recordSrc = fs.readFileSync(path.join(ROOT, 'src/livestock/WeighInSessionPage.jsx'), 'utf8');

describe('broiler weigh-in median placement', () => {
  it('puts Median weight immediately after Avg weight in the main table definition', () => {
    const avg = listSrc.indexOf("key: 'avg'");
    const median = listSrc.indexOf("key: 'median'", avg);
    const sharedProps = listSrc.indexOf('const sharedProps', median);

    expect(avg).toBeGreaterThan(-1);
    expect(median).toBeGreaterThan(avg);
    expect(sharedProps).toBeGreaterThan(median);
    expect(listSrc.slice(avg, median).match(/key: '/g)).toHaveLength(1);
    expect(listSrc.slice(median, sharedProps)).toContain("label: 'Median weight'");
  });

  it('renders the Broiler median immediately after the average in the record header', () => {
    const average = recordSrc.indexOf("{isBroiler && broilerAvg !== ''");
    const median = recordSrc.indexOf("{isBroiler && broilerMedian !== ''", average);
    const notice = recordSrc.indexOf('{notice &&', median);

    expect(average).toBeGreaterThan(-1);
    expect(median).toBeGreaterThan(average);
    expect(notice).toBeGreaterThan(median);
    expect(recordSrc.slice(average, median)).not.toContain("{isBroiler && broilerMedian !== ''");
    expect(recordSrc.slice(median, notice)).toContain('median {broilerMedian} lb');
  });
});
