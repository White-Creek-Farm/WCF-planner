import {describe, expect, it} from 'vitest';
import {printRows, rowsToPrintHtml} from './printExport.js';

describe('printExport', () => {
  it('builds escaped printable HTML from column specs and visible rows', () => {
    const html = rowsToPrintHtml({
      title: 'Cattle <Herds>',
      subtitle: '2 filtered rows',
      columns: [
        {header: 'Tag', value: (r) => r.tag},
        {header: 'Note', key: 'note'},
      ],
      rows: [
        {tag: 'A1', note: 'plain'},
        {tag: '<script>', note: 'quoted "value"'},
      ],
    });

    expect(html).toContain('<title>Cattle &lt;Herds&gt;</title>');
    expect(html).toContain('<div class="subtitle">2 filtered rows</div>');
    expect(html).toContain('<th>Tag</th>');
    expect(html).toContain('<td>A1</td>');
    expect(html).toContain('<td>&lt;script&gt;</td>');
    expect(html).toContain('<td>quoted &quot;value&quot;</td>');
    expect(html).not.toContain('<script>');
  });

  it('returns false outside the browser for printRows', () => {
    expect(printRows({title: 'x', columns: [], rows: []})).toBe(false);
  });
});
