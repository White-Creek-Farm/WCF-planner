import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

const sql = readFileSync('supabase-migrations/187_layer_historical_retirement_dates.sql', 'utf8');

describe('migration 187 historical Layer retirement dates', () => {
  it.each([
    ['lh-23-01-em2', '2026-01-28'],
    ['lh-23-01-ls', '2026-01-28'],
    ['lh-23-01-rh23', '2024-06-27'],
  ])('pins %s to its approved evidence-backed date', (id, date) => {
    expect(sql).toContain(`WHEN '${id}' THEN DATE '${date}'`);
  });

  it('updates only retired target rows whose date remains empty', () => {
    expect(sql).toMatch(/UPDATE public\.layer_housings/);
    expect(sql).toMatch(/WHERE id IN \('lh-23-01-em2', 'lh-23-01-ls', 'lh-23-01-rh23'\)/);
    expect(sql).toMatch(/AND status = 'retired'/);
    expect(sql).toMatch(/AND retired_date IS NULL/);
  });

  it('fails closed instead of overwriting a conflicting status or date', () => {
    expect(sql).toMatch(/status IS DISTINCT FROM 'retired'/);
    expect(sql).toMatch(/retired_date IS NOT NULL AND h\.retired_date <> DATE/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });
});
