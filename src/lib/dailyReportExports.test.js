import {describe, expect, it} from 'vitest';
import {
  buildBroilerDailyExportColumns,
  buildCattleDailyExportColumns,
  buildEggDailyExportColumns,
  buildSheepDailyExportColumns,
  dailyExportYesNo,
  dailyFeedLbsAsFed,
  dailyFeedSummary,
  dailyHayBales,
  dailyMineralLbs,
  dailyMineralSummary,
  dailyPhotoCount,
  dailyReportSourceLabel,
  eggDailyTotalForRow,
} from './dailyReportExports.js';

function valueFor(columns, header, row) {
  return columns.find((column) => column.header === header).value(row);
}

describe('dailyReportExports', () => {
  it('keeps common daily export value helpers stable', () => {
    const row = {
      source: 'add_feed_webform',
      photos: [{id: 1}, {id: 2}],
      feeds: [
        {feed_name: 'Corn', qty: 12, unit: 'lb', lbs_as_fed: '12.3'},
        {feed_name: 'Hay', qty: '2', unit: 'bale', category: 'hay', lbs_as_fed: '40'},
      ],
      minerals: [{name: 'Loose mineral', lbs: '1.5'}, {name: 'Salt'}],
    };

    expect(dailyExportYesNo(false)).toBe('no');
    expect(dailyExportYesNo(null)).toBe('yes');
    expect(dailyReportSourceLabel(row.source)).toBe('Add Feed');
    expect(dailyReportSourceLabel('daily_report')).toBe('Daily Report');
    expect(dailyPhotoCount(row)).toBe(2);
    expect(dailyFeedSummary(row)).toBe('Corn 12 lb, Hay 2 bale');
    expect(dailyFeedLbsAsFed(row)).toBe('52.30');
    expect(dailyHayBales(row)).toBe('2.00');
    expect(dailyMineralSummary(row)).toBe('Loose mineral 1.5 lb, Salt');
    expect(dailyMineralLbs(row)).toBe('1.50');
  });

  it('builds ruminant daily columns with caller-provided labels and comment sentinel policy', () => {
    const cattleColumns = buildCattleDailyExportColumns({herdLabels: {mommas: 'Mommas'}});
    expect(valueFor(cattleColumns, 'Herd', {herd: 'mommas'})).toBe('Mommas');

    const sheepColumns = buildSheepDailyExportColumns({
      flockLabels: {ewes: 'Ewes'},
      isSentinelComment: (value) => value === 'hide-me',
    });
    expect(valueFor(sheepColumns, 'Flock', {flock: 'ewes'})).toBe('Ewes');
    expect(valueFor(sheepColumns, 'Comments', {comments: 'hide-me'})).toBe('');
    expect(valueFor(sheepColumns, 'Comments', {comments: 'Watch feet'})).toBe('Watch feet');
  });

  it('builds poultry and egg column specs used by CSV and print views', () => {
    expect(buildBroilerDailyExportColumns().map((column) => column.header)).toContain('Broiler group');
    expect(eggDailyTotalForRow({group1_count: '12', group2_count: '8', group3_count: '', group4_count: '3'})).toBe(23);

    const eggColumns = buildEggDailyExportColumns();
    expect(valueFor(eggColumns, 'Total eggs', {group1_count: '1', group2_count: '2'})).toBe(3);
  });
});
