import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const cron = fs.readFileSync(path.join(ROOT, 'supabase/functions/tasks-cron/index.ts'), 'utf8');

describe('tasks-cron system generation', () => {
  it('keeps recurring template generation and adds active system-rule generation', () => {
    expect(cron).toMatch(/rpc\('generate_task_instances'/);
    expect(cron).toMatch(/from\('task_system_rules'\)[\s\S]*?\.eq\('active', true\)/);
    expect(cron).toMatch(/generateSystemTaskInstances\(svc, runTodayISO\)/);
  });

  it('uses real planner app_store sources for broiler and pig system rules', () => {
    for (const key of ['ppp-v4', 'ppp-feeders-v1', 'ppp-breeding-v1', 'ppp-farrowing-v1']) {
      expect(cron, key).toContain(`'${key}'`);
    }
    expect(cron).toMatch(/from\('app_store'\)[\s\S]*?\.in\('key', SYSTEM_APP_STORE_KEYS\)/);
  });

  it('calls the existing SECURITY DEFINER RPC with rule, due date, source event key, and entity label', () => {
    expect(cron).toMatch(/rpc\('generate_system_task_instance', \{/);
    expect(cron).toMatch(/p_rule_id: event\.rule_id/);
    expect(cron).toMatch(/p_due_date: event\.due_date/);
    expect(cron).toMatch(/p_source_event_key: event\.source_event_key/);
    // Batch/group name passed so the generated title is identifiable on its own.
    expect(cron).toMatch(/p_entity_label: event\.entity_label/);
  });

  it('treats lead_time_days as the generation horizon while preserving the farm event due date', () => {
    expect(cron).toMatch(/function shouldQueueSystemEvent/);
    expect(cron).toMatch(/event\.due_date <= addDaysISO\(today, leadTimeDays\(rule\)\)/);
    expect(cron).toMatch(/due_date remains the actual farm event date/);
  });

  it('generates the three broiler system rules from hatch dates and skips completed weights', () => {
    expect(cron).toMatch(/BROODER_DAYS = 14/);
    expect(cron).toMatch(/BROILER_4WK_DAYS = 28/);
    expect(cron).toMatch(/BROILER_6WK_DAYS = 42/);
    expect(cron).toMatch(/rule\.generator_kind === 'broiler_4wk_weighin'/);
    expect(cron).toMatch(/rule\.generator_kind === 'broiler_6wk_weighin'/);
    expect(cron).toMatch(/rule\.generator_kind === 'clean_brooder'/);
    expect(cron).toMatch(/hasStampedBroilerWeight\(batch, 'week4Lbs'\)/);
    expect(cron).toMatch(/hasStampedBroilerWeight\(batch, 'week6Lbs'\)/);
  });

  it('generates pig 6-month weigh-ins from actual farrowing records linked to feeder batches', () => {
    expect(cron).toMatch(/PIG_6MO_DAYS = 180/);
    expect(cron).toMatch(/rule\.generator_kind !== 'pig_6mo_weighin'/);
    expect(cron).toMatch(/firstActualFarrowDate\(cycle, farrowingRecs\)/);
    expect(cron).toMatch(/stringField\(rec, 'group'\) === group/);
    expect(cron).toMatch(/source_event_key: `pig-\$\{targetKey\}`/);
  });

  it('skips already-created system source events before invoking the RPC', () => {
    expect(cron).toMatch(/from\('task_instances'\)[\s\S]*?from_system_rule_id, from_system_source_event_key/);
    expect(cron).toMatch(/existing\.has\(key\)/);
    expect(cron).toMatch(/existing\.add\(key\)/);
  });
});
