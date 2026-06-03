import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const cattleHerds = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleHerdsView.jsx'), 'utf8');
const cattleForecast = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleForecastView.jsx'), 'utf8');
const sheepFlocks = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepFlocksView.jsx'), 'utf8');
const sheepAnimalPage = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepAnimalPage.jsx'), 'utf8');
const eqAdmin = fs.readFileSync(path.join(ROOT, 'src/admin/EquipmentWebformsAdmin.jsx'), 'utf8');
const livestockFeedInputs = fs.readFileSync(path.join(ROOT, 'src/admin/LivestockFeedInputsPanel.jsx'), 'utf8');
const diffHelper = fs.readFileSync(path.join(ROOT, 'src/lib/activityChangeDiff.js'), 'utf8');

describe('Activity change logging - cattle.animal', () => {
  it('CattleHerdsView imports runMutation and recordFieldChange', () => {
    expect(cattleHerds).toContain("import {runMutation, recordFieldChange} from '../lib/entityMutations.js'");
  });

  it('CattleHerdsView imports buildChanges', () => {
    expect(cattleHerds).toContain("import {buildChanges, countSummary} from '../lib/activityChangeDiff.js'");
  });

  it('CattleHerdsView patchCow uses runMutation with cattle.animal', () => {
    expect(cattleHerds).toContain("entityType: 'cattle.animal'");
    expect(cattleHerds).toContain('runMutation(');
  });

  it('CattleHerdsView excludes herd and processing_batch_id', () => {
    expect(cattleHerds).toContain("'herd'");
    expect(cattleHerds).toContain("'processing_batch_id'");
    expect(cattleHerds).toContain('CATTLE_EXCLUDE');
  });

  it('CattleForecastView patchCow uses runMutation with cattle.animal', () => {
    expect(cattleForecast).toContain("entityType: 'cattle.animal'");
    expect(cattleForecast).toContain('runMutation(');
  });

  it('neither cattle view routes deletes through record.deleted', () => {
    const deleteMatches = cattleHerds.match(/record\.deleted/g);
    expect(deleteMatches).toBeNull();
    const forecastDeleteMatches = cattleForecast.match(/record\.deleted/g);
    expect(forecastDeleteMatches).toBeNull();
  });
});

describe('Activity change logging - sheep.animal', () => {
  it('SheepAnimalPage imports runMutation and recordFieldChange', () => {
    expect(sheepAnimalPage).toContain("import {runMutation, recordFieldChange} from '../lib/entityMutations.js'");
  });

  it('SheepAnimalPage imports buildChanges', () => {
    expect(sheepAnimalPage).toContain("import {buildChanges, countSummary} from '../lib/activityChangeDiff.js'");
  });

  it('SheepAnimalPage patchSheep uses runMutation with sheep.animal', () => {
    expect(sheepAnimalPage).toContain("entityType: 'sheep.animal'");
    expect(sheepAnimalPage).toContain('runMutation(');
  });

  it('SheepAnimalPage excludes flock and processing_batch_id', () => {
    expect(sheepAnimalPage).toContain("'flock'");
    expect(sheepAnimalPage).toContain("'processing_batch_id'");
    expect(sheepAnimalPage).toContain('SHEEP_EXCLUDE');
  });

  it('does not route deletes through record.deleted', () => {
    expect(sheepAnimalPage.match(/record\.deleted/g)).toBeNull();
  });
});

describe('Activity change logging - equipment.item', () => {
  it('EquipmentWebformsAdmin imports runMutation and recordFieldChange and recordStatusChange', () => {
    expect(eqAdmin).toContain(
      "import {runMutation, recordFieldChange, recordStatusChange} from '../lib/entityMutations.js'",
    );
  });

  it('EquipmentWebformsAdmin imports countSummary and makeFieldChange', () => {
    expect(eqAdmin).toContain("import {countSummary, makeFieldChange} from '../lib/activityChangeDiff.js'");
  });

  it('uses equipment.item entity type', () => {
    expect(eqAdmin).toContain("entityType: 'equipment.item'");
  });

  it('IdentityEditor uses recordStatusChange for status', () => {
    expect(eqAdmin).toContain('recordStatusChange(sb');
  });

  it('TeamMembersEditor logs team_members as field.updated via makeFieldChange', () => {
    expect(eqAdmin).toContain("'team_members'");
    expect(eqAdmin).toContain('makeFieldChange');
    expect(eqAdmin).toContain("'Team members'");
  });

  it('uses countSummary for complex array fields', () => {
    expect(eqAdmin).toContain('countSummary(');
  });

  it('does not log documents', () => {
    expect(eqAdmin).not.toContain("field: 'documents'");
    expect(eqAdmin).not.toMatch(/recordFieldChange.*documents/);
  });

  it('does not route deletes through record.deleted', () => {
    expect(eqAdmin.match(/record\.deleted/g)).toBeNull();
  });
});

describe('Activity change logging - diff helper', () => {
  it('exports buildChanges', () => {
    expect(diffHelper).toContain('export function buildChanges');
  });

  it('exports countSummary', () => {
    expect(diffHelper).toContain('export function countSummary');
  });

  it('supports exclude parameter', () => {
    expect(diffHelper).toContain('exclude');
  });

  it('supports formatters parameter', () => {
    expect(diffHelper).toContain('formatters');
  });
});

describe('Custom editable-table Activity — cattle forecast hide/unhide (CP1)', () => {
  it('CattleForecastView imports recordActivityEvent from entityMutations', () => {
    expect(cattleForecast).toMatch(/import \{[^}]*recordActivityEvent[^}]*\} from '\.\.\/lib\/entityMutations\.js'/);
  });
  it('has a recordForecastHiddenActivity helper', () => {
    expect(cattleForecast).toContain('async function recordForecastHiddenActivity(');
  });
  it('scopes the audit to the cattle.forecast workflow entity (NOT cattle.animal)', () => {
    expect(cattleForecast).toMatch(
      /recordActivityEvent\(sb, \{[\s\S]*?entityType: 'cattle\.forecast'[\s\S]*?eventType: 'status\.changed'/,
    );
    // The forecast audit must not be logged against the cattle.animal record.
    const fn = cattleForecast.match(/async function recordForecastHiddenActivity\([\s\S]*?\n {2}\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).not.toContain("entityType: 'cattle.animal'");
  });
  it('uses the singleton cattle-forecast entity_id and carries the cow label in the payload', () => {
    expect(cattleForecast).toContain("entityId: 'cattle-forecast'");
    expect(cattleForecast).toContain("cow && cow.tag ? '#' + cow.tag : cattleId");
    expect(cattleForecast).toContain('cattle_id: cattleId');
  });
  it('mounts the workflow Activity log on the forecast page', () => {
    expect(cattleForecast).toContain('RecordCollaborationSection');
    expect(cattleForecast).toMatch(
      /<RecordCollaborationSection[\s\S]*?entityType="cattle\.forecast"[\s\S]*?entityId="cattle-forecast"[\s\S]*?showComments=\{false\}/,
    );
  });
  it('body + payload make the month, cow, and visible<->hidden action clear', () => {
    expect(cattleForecast).toContain('const month = monthLabel(monthKey)');
    expect(cattleForecast).toContain("const from = nowHidden ? 'visible' : 'hidden'");
    expect(cattleForecast).toContain("const to = nowHidden ? 'hidden' : 'visible'");
    expect(cattleForecast).toContain("'Forecast month ' + month + ' for ' + cowLabel + ' changed '");
    expect(cattleForecast).toContain('forecast_month_visibility');
  });
  it('toggleHidden logs only AFTER a successful write (returns on write error first)', () => {
    expect(cattleForecast).toMatch(
      /Could not update hide state[\s\S]*?return;[\s\S]*?recordForecastHiddenActivity\(cattleId, monthKey, !currentlyHidden\)/,
    );
  });
  it('registry + global Activity recognize the cattle.forecast entity', () => {
    const registry = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
    expect(registry).toContain("CATTLE_FORECAST: 'cattle.forecast'");
    expect(registry).toMatch(/CATTLE_FORECAST\]: \{[\s\S]*?route: \(\) => '\/cattle\/forecast'/);
    const view = fs.readFileSync(path.join(ROOT, 'src/activity/ActivityLogView.jsx'), 'utf8');
    expect(view).toContain("'cattle.forecast': 'Cattle Forecast'");
  });
});

describe('Custom editable-table Activity — feed inputs and feed tests (CP2)', () => {
  it('LivestockFeedInputsPanel imports recordActivityEvent and diff helpers', () => {
    expect(livestockFeedInputs).toMatch(
      /import \{[^}]*buildChanges[^}]*countSummary[^}]*\} from '\.\.\/lib\/activityChangeDiff\.js'/,
    );
    expect(livestockFeedInputs).toMatch(
      /import \{[^}]*recordActivityEvent[^}]*\} from '\.\.\/lib\/entityMutations\.js'/,
    );
  });

  it('scopes feed-edit audit entries to the cattle.forecast workflow entity', () => {
    expect(livestockFeedInputs).toContain("entityType: 'cattle.forecast'");
    expect(livestockFeedInputs).toContain("entityId: 'cattle-forecast'");
    expect(livestockFeedInputs).toContain("entityLabel: 'Cattle Forecast'");
  });

  it('records feed input create/update/delete payloads with stable ids', () => {
    expect(livestockFeedInputs).toContain('async function recordFeedInputSavedActivity(');
    expect(livestockFeedInputs).toContain('async function recordFeedInputDeletedActivity(');
    expect(livestockFeedInputs).toContain("eventType: created ? 'record.created' : 'field.updated'");
    expect(livestockFeedInputs).toContain("eventType: 'record.deleted'");
    expect(livestockFeedInputs).toContain('feed_input_action');
    expect(livestockFeedInputs).toContain('feed_input_id');
    expect(livestockFeedInputs).toContain('synced_from_feed_test');
  });

  it('records feed test create/update/delete payloads with stable ids', () => {
    expect(livestockFeedInputs).toContain('async function recordFeedTestSavedActivity(');
    expect(livestockFeedInputs).toContain('async function recordFeedTestDeletedActivity(');
    expect(livestockFeedInputs).toContain('feed_test_action');
    expect(livestockFeedInputs).toContain('feed_test_id');
    expect(livestockFeedInputs).toContain('effective_date');
  });

  it('does not record every debounced feed autosave tick', () => {
    const updStart = livestockFeedInputs.indexOf('function upd(k, v)');
    const updEnd = livestockFeedInputs.indexOf('function toggleHerdScope', updStart);
    expect(updStart).toBeGreaterThan(-1);
    expect(updEnd).toBeGreaterThan(updStart);
    const updBody = livestockFeedInputs.slice(updStart, updEnd);
    expect(updBody).toContain('setTimeout(() => saveFeed(next, editingId), 1500)');
    expect(updBody).not.toContain('recordActivity');
  });

  it('closeForm records one summary Activity event for intentional feed saves', () => {
    const closeStart = livestockFeedInputs.indexOf('async function closeForm()');
    const closeEnd = livestockFeedInputs.indexOf('function cancelForm()', closeStart);
    expect(closeStart).toBeGreaterThan(-1);
    expect(closeEnd).toBeGreaterThan(closeStart);
    const closeBody = livestockFeedInputs.slice(closeStart, closeEnd);
    expect(closeBody).toContain('recordActivity: true');
    expect(closeBody).toContain('previousFeed: buildFeedRecord(originalForm, editingId)');
    expect(closeBody).toContain('await saveFeed(form, null, {recordActivity: true})');
  });

  it('delete Activity is logged only after the delete write succeeds', () => {
    expect(livestockFeedInputs).toMatch(
      /from\('cattle_feed_tests'\)\.delete\(\)\.eq\('id', testId\);[\s\S]*?if \(error\) \{[\s\S]*?return;[\s\S]*?await recordFeedTestDeletedActivity\(currentFeed, test\)/,
    );
    expect(livestockFeedInputs).toMatch(
      /from\('cattle_feed_inputs'\)\.delete\(\)\.eq\('id', id\);[\s\S]*?if \(error\) \{[\s\S]*?return;[\s\S]*?await recordFeedInputDeletedActivity\(feed\)/,
    );
  });
});

describe('mig 076 — _activity_can_read cattle.forecast branch', () => {
  const mig076 = fs.readFileSync(
    path.join(ROOT, 'supabase-migrations/076_cattle_forecast_activity_entity.sql'),
    'utf8',
  );
  it('replaces _activity_can_read and adds a cattle.forecast branch gated on cattle program', () => {
    expect(mig076).toMatch(/CREATE OR REPLACE FUNCTION public\._activity_can_read/);
    expect(mig076).toMatch(/IF p_entity_type = 'cattle\.forecast' THEN[\s\S]*?RETURN 'cattle' = ANY\(v_access\)/);
  });
  it('preserves the existing weighin.session branch (full-replace, not a partial)', () => {
    expect(mig076).toContain("IF p_entity_type = 'weighin.session' THEN");
  });
  it('keeps anon revoked + authenticated granted and reloads PostgREST', () => {
    expect(mig076).toMatch(/REVOKE ALL ON FUNCTION public\._activity_can_read\(text, text\) FROM PUBLIC, anon/);
    expect(mig076).toMatch(/GRANT EXECUTE ON FUNCTION public\._activity_can_read\(text, text\) TO authenticated/);
    expect(mig076).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});

describe('Activity change logging - no direct table access', () => {
  const allSrc = [cattleHerds, cattleForecast, sheepFlocks, eqAdmin, livestockFeedInputs];
  for (const src of allSrc) {
    it('does not reference .from(activity_events)', () => {
      expect(src).not.toMatch(/\.from\(['"]activity_events['"]\)/);
    });
    it('does not reference .from(activity_mentions)', () => {
      expect(src).not.toMatch(/\.from\(['"]activity_mentions['"]\)/);
    });
  }
});
