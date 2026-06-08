import {describe, expect, it} from 'vitest';
import {csvCell, csvFilename, downloadCsv, rowsToCsv} from './csvExport.js';

describe('csvExport', () => {
  it('escapes commas, quotes, newlines, and spreadsheet formula prefixes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('one,two')).toBe('"one,two"');
    expect(csvCell('said "hi"')).toBe('"said ""hi"""');
    expect(csvCell('line\r\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('|cmd')).toBe("'|cmd");
  });

  it('converts rows with column value functions to CRLF csv', () => {
    const csv = rowsToCsv(
      [
        {header: 'Tag', value: (r) => '#' + r.tag},
        {header: 'Herd', key: 'herd'},
        {header: 'Note', key: 'note'},
      ],
      [
        {tag: '101', herd: 'mommas', note: 'ready'},
        {tag: '102', herd: 'finishers', note: 'one,two'},
      ],
    );
    expect(csv).toBe('Tag,Herd,Note\r\n#101,mommas,ready\r\n#102,finishers,"one,two"\r\n');
  });

  it('builds stable dated csv filenames', () => {
    expect(csvFilename('Cattle Herds Export', new Date('2026-06-08T12:00:00Z'))).toBe(
      'cattle-herds-export-2026-06-08.csv',
    );
  });

  it('uses the farm-Central date for csv filenames', () => {
    expect(csvFilename('Cattle Herds', new Date('2026-06-08T04:00:00Z'))).toBe('cattle-herds-2026-06-07.csv');
  });

  it('returns false outside the browser for downloadCsv', () => {
    expect(downloadCsv('x.csv', 'a,b\r\n')).toBe(false);
  });
});
