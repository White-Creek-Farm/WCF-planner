import {describe, it, expect} from 'vitest';
import {
  computeProductionYoy,
  buildProductionYoyBlocks,
  stripProductionYoyBlocks,
  formatYoyNumber,
  formatYoyDelta,
} from './newsletterProductionYoy.js';
import {validateNewsletterBlocks} from './newsletterDraft.js';

const TODAY = '2026-06-30';

const SOURCES = {
  broilerBatches: [
    {status: 'processed', processingDate: '2025-06-10', totalToProcessor: 600}, // 2025
    {status: 'processed', processingDate: '2026-06-04', totalToProcessor: 688}, // 2026
    {status: 'active', processingDate: '2026-06-22', totalToProcessor: 730}, // 2026 (today >= procDate)
    {status: 'active', processingDate: '2026-07-13', totalToProcessor: 999}, // future -> not processed
  ],
  feederGroups: [{processingTrips: [{date: '2026-04-01', pigCount: 25}]}], // pig 2026
  cattleProcessingBatches: [{actual_process_date: '2026-05-01', cows_detail: [{}, {}, {}]}], // cattle 2026 = 3
  sheepProcessingBatches: [],
  eggDailys: [
    {date: '2025-06-01', group1_count: 120}, // 2025 = 120 eggs (10 doz)
    {date: '2026-06-01', group1_count: 240, group2_count: 24}, // 2026 = 264 eggs (22 doz)
  ],
  legacyEvents: [
    {program: 'pig', event_date: '2025-03-01', quantity: 40}, // pig 2025 (no planner) -> backfills
    {program: 'broiler', event_date: '2026-01-01', quantity: 9999}, // IGNORED: planner covers broiler 2026
  ],
};

describe('newsletter production YoY', () => {
  const yoy = computeProductionYoy(SOURCES, {thisYear: '2026', lastYear: '2025', today: TODAY});
  const byKey = Object.fromEntries(yoy.programs.map((p) => [p.key, p]));

  it('counts broilers by totalToProcessor with the tab’s processed predicate', () => {
    expect(byKey.broiler.current).toBe(1418); // 688 + 730 (the future batch is excluded)
    expect(byKey.broiler.previous).toBe(600);
    expect(byKey.broiler.delta).toBe(818);
  });

  it('Planner wins by coverage; legacy only backfills uncovered program-years', () => {
    // 2026 broiler legacy row is ignored (Planner covers it).
    expect(byKey.broiler.current).toBe(1418);
    // 2025 pig has no planner events -> legacy backfill (40); 2026 pig is planner (25).
    expect(byKey.pig.previous).toBe(40);
    expect(byKey.pig.current).toBe(25);
    expect(byKey.pig.delta).toBe(-15);
  });

  it('cattle = cows_detail length; sheep absent is dropped', () => {
    expect(byKey.cattle.current).toBe(3);
    expect(byKey.cattle.previous).toBe(0);
    expect(byKey.sheep).toBeUndefined();
  });

  it('eggs are reported in dozens', () => {
    expect(byKey.egg.current).toBe(264); // raw eggs stored
    expect(formatYoyNumber('egg', byKey.egg.current)).toBe('22'); // 264 / 12
    expect(formatYoyDelta('egg', byKey.egg.delta)).toBe('▲ 12'); // 144 eggs = 12 doz
  });

  it('delta formatting: up/down/flat', () => {
    expect(formatYoyDelta('broiler', 818)).toBe('▲ 818');
    expect(formatYoyDelta('pig', -15)).toBe('▼ 15');
    expect(formatYoyDelta('cattle', 0)).toBe('no change');
  });

  it('builds whitelisted, validate-clean YoY blocks', () => {
    const blocks = buildProductionYoyBlocks(yoy);
    expect(blocks[1]).toMatchObject({type: 'heading', text: 'Production — year over year'});
    const stats = blocks.find((b) => b.type === 'stats');
    expect(stats.items.find((i) => i.label === 'Eggs (doz)').value).toContain('vs 2025');
    // Survives the security validator unchanged in shape.
    const validated = validateNewsletterBlocks({blocks});
    expect(validated.blocks.some((b) => b.type === 'stats')).toBe(true);
    expect(validated.blocks.some((b) => b.type === 'heading' && b.text.includes('year over year'))).toBe(true);
  });

  it('strips a prior YoY section cleanly (no duplication on revise)', () => {
    const draft = [
      {type: 'heading', text: 'White Creek Farm June Review'},
      {type: 'paragraph', text: 'Intro.'},
      ...buildProductionYoyBlocks(yoy), // divider + heading + paragraph + stats
      {type: 'paragraph', text: 'Closing.'},
    ];
    const stripped = stripProductionYoyBlocks(draft);
    expect(stripped.some((b) => b.type === 'heading' && b.text.includes('year over year'))).toBe(false);
    expect(stripped).toHaveLength(3); // heading, intro, closing
    // Idempotent re-append yields exactly one YoY section.
    const reappended = [...stripProductionYoyBlocks(draft), ...buildProductionYoyBlocks(yoy)];
    expect(reappended.filter((b) => b.type === 'heading' && b.text === 'Production — year over year')).toHaveLength(1);
  });

  it('returns no blocks when there is no production', () => {
    const empty = computeProductionYoy({}, {thisYear: '2026', lastYear: '2025', today: TODAY});
    expect(empty.programs).toEqual([]);
    expect(buildProductionYoyBlocks(empty)).toEqual([]);
  });
});
