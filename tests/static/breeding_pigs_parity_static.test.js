import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {ACTIVITY_REGISTRY, ENTITY_TYPES} from '../../src/lib/activityRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const sowsView = fs.readFileSync(path.join(ROOT, 'src/pig/SowsView.jsx'), 'utf8');
const registry = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
const migration = fs.readFileSync(path.join(ROOT, 'supabase-migrations/126_pig_breeder_activity_entity.sql'), 'utf8');

describe('Breeding pigs hub parity', () => {
  it('uses grouped table sections instead of the old card Record-button surface', () => {
    expect(sowsView).toContain('function BreedingPigTableSection');
    expect(sowsView).toContain('data-breeding-pig-table-section');
    expect(sowsView).toContain('data-breeding-pig-row');
    expect(sowsView).not.toContain('function PigTile');
    expect(sowsView).not.toContain('data-breeding-pig-record-link');
    expect(sowsView).not.toContain('>+ Record<');
    expect(sowsView).not.toContain('placeholder="Weight (lbs)"');
  });

  // CP3: the animal-list rows render through the shared <DataTable> (real
  // <table> + .hoverable-row tr) instead of the old .hoverable-tile faux grid.
  // The per-row record-open navigation and per-row data-* hook are preserved.
  it('renders the section rows through the shared DataTable with row numbers', () => {
    expect(sowsView).toContain("import DataTable from '../shared/DataTable.jsx'");
    expect(sowsView).toContain('surfaceKey="breeding-pig-table"');
    expect(sowsView).toContain('showRowNumbers');
    expect(sowsView).toContain("rowProps={(pig) => ({'data-breeding-pig-row': pig.id})}");
    expect(sowsView).not.toContain('className="hoverable-tile"');
  });

  it('makes the table row itself the record-page navigation target', () => {
    expect(sowsView).toContain('onRowOpen={(pig) => openBreedingPigRecord(pig, rows)}');
    expect(sowsView).toContain('openBreedingPigRecord(pig, rows)');
    expect(sowsView).toContain("navigate('/pig/sows/' + encodeURIComponent(pig.id)");
  });
});

describe('Breeding pig record page collaboration', () => {
  it('mounts Comments + Activity on breeding pig record pages', () => {
    expect(sowsView).toContain('RecordCollaborationSection');
    expect(sowsView).toContain("const BREEDING_PIG_ENTITY_TYPE = 'pig.breeder'");
    expect(sowsView).toContain('entityType={BREEDING_PIG_ENTITY_TYPE}');
    expect(sowsView).toContain('entityId={recordPig.id}');
  });

  it('registers pig.breeder for notifications and deep links', () => {
    expect(ENTITY_TYPES.PIG_BREEDER).toBe('pig.breeder');
    expect(ACTIVITY_REGISTRY['pig.breeder'].route('podio-3')).toBe('/pig/sows/podio-3');
    expect(registry).toContain("if (path.startsWith('/pig/sows/')) return {view: 'sows'");
  });
});

describe('Migration 126 - pig.breeder activity resolver', () => {
  it('adds a pig.breeder branch backed by ppp-breeders-v1', () => {
    expect(migration).toContain("p_entity_type = 'pig.breeder'");
    expect(migration).toContain("key = 'ppp-breeders-v1'");
    expect(migration).toContain("jsonb_build_object('id', p_entity_id)");
    expect(migration).toContain("RETURN 'pig' = ANY(v_access)");
  });

  it('keeps the resolver fail-closed and authenticated-only', () => {
    expect(migration).toContain('RETURN false;');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public._activity_can_read(text, text) FROM PUBLIC, anon;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public._activity_can_read(text, text) TO authenticated;');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public._activity_can_write(text, text) FROM PUBLIC, anon;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public._activity_can_write(text, text) TO authenticated;');
  });
});
