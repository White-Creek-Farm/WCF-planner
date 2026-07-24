import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ── Suite-Wide Seed Idempotency CP1 ──────────────────────────────────────────
// The highest-risk fixed-ID Playwright scenario seeds must use upsert, not
// plain insert, so a shared-DB worker-restart race (Playwright spawns a fresh
// worker after any failure, which can land a stale row after the new worker's
// TRUNCATE) cannot trip duplicate-primary-key errors. upsert(onConflict:'id')
// overwrites any stale row into the exact intended state; ignoreDuplicates
// would leave a stale row's wrong columns in place, so it is NOT allowed.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const SEED_FILES = [
  'tests/scenarios/cattle_processor_seed.js',
  'tests/scenarios/sheep_processor_seed.js',
  'tests/scenarios/cattle_herd_filters_seed.js',
  'tests/scenarios/cattle_soft_delete_seed.js',
  'tests/scenarios/admin_broiler_session_meta_seed.js',
  'tests/scenarios/broiler_timeline_seed.js',
  'tests/scenarios/fuel_reconcile_seed.js',
  'tests/scenarios/home_dashboard_equipment_seed.js',
  'tests/scenarios/p2601_seed.js',
];

describe('processor scenario seeds are idempotent (upsert, not insert)', () => {
  for (const rel of SEED_FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');

    it(`${rel} contains no plain .insert( calls`, () => {
      expect(src).not.toMatch(/\.insert\(/);
    });

    it(`${rel} writes rows via upsert(..., {onConflict: 'id'})`, () => {
      expect(src).toMatch(/\.upsert\(/);
      expect(src).toMatch(/onConflict:\s*'id'/);
    });

    it(`${rel} does not rely on ignoreDuplicates`, () => {
      expect(src).not.toMatch(/ignoreDuplicates/);
    });
  }
});

// ── CP2 fix — upsert payloads must clear known mutable stale state ────────────
// upsert only resets columns present in the payload; omitted nullable/mutable
// columns survive from a stale worker row. The seeds whose specs mutate those
// columns (soft-delete / restore, batch attachment, session completion, notes)
// must therefore seed the reset values explicitly so a re-seed produces the
// exact intended starting state, not a half-stale hybrid.
describe('CP2: upsert payloads reset known mutable stale columns', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  for (const rel of ['tests/scenarios/cattle_soft_delete_seed.js', 'tests/scenarios/cattle_herd_filters_seed.js']) {
    const src = read(rel);
    it(`${rel} explicitly resets soft-delete + attachment columns on seeded cattle`, () => {
      expect(src).toMatch(/deleted_at:\s*null/);
      expect(src).toMatch(/deleted_by:\s*null/);
      expect(src).toMatch(/processing_batch_id:\s*null/);
    });
  }

  it('admin_broiler_session_meta_seed.js resets completed_at + notes on seeded sessions', () => {
    const src = read('tests/scenarios/admin_broiler_session_meta_seed.js');
    expect(src).toMatch(/completed_at:\s*null/);
    expect(src).toMatch(/notes:\s*null/);
  });
});

// ── CP3: fuel / equipment / pig seeds — unique slug + mutable-column resets ───
describe('CP3: upsert payloads reset known mutable stale columns', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('home_dashboard_equipment_seed.js derives a UNIQUE per-kind slug from id (not a shared slug)', () => {
    const src = read('tests/scenarios/home_dashboard_equipment_seed.js');
    // equipment.slug is UNIQUE; a shared slug would 23505 under upsert-on-id.
    expect(src).toMatch(/const slug = id/);
    expect(src).not.toMatch(/'eq-attention-test'/);
  });

  it('home_dashboard_equipment_seed.js resets attention-trigger + fueling columns', () => {
    const src = read('tests/scenarios/home_dashboard_equipment_seed.js');
    expect(src).toMatch(/warranty_expiration:\s*null/);
    expect(src).toMatch(/service_intervals:\s*\[\]/);
    expect(src).toMatch(/every_fillup_items:\s*\[\]/);
    expect(src).toMatch(/service_intervals_completed:\s*\[\]/);
    expect(src).toMatch(/photos:\s*\[\]/);
  });

  it('fuel_reconcile_seed.js resets fueling + bill mutable columns', () => {
    const src = read('tests/scenarios/fuel_reconcile_seed.js');
    expect(src).toMatch(/parsed_data:\s*null/);
    expect(src).toMatch(/photos:\s*\[\]/);
    expect(src).toMatch(/podio_source_app:\s*null/);
    expect(src).toMatch(/client_submission_id:\s*null/);
  });

  it('p2601_seed.js resets pig Send-to-Trip / breeding / soft-delete columns', () => {
    const src = read('tests/scenarios/p2601_seed.js');
    expect(src).toMatch(/sent_to_trip_id:\s*null/);
    expect(src).toMatch(/sent_to_group_id:\s*null/);
    expect(src).toMatch(/transferred_to_breeding:\s*false/);
    expect(src).toMatch(/completed_at:\s*null/);
    expect(src).toMatch(/deleted_at:\s*null/);
  });
});

// ── CP4: inline record/sequence Playwright spec seeds ────────────────────────
// The same idempotency contract for the small fixed-id seed helpers defined
// INLINE inside the record/sequence-nav spec files (not the scenarios/ dir).
const CP4_SPEC_FILES = [
  'tests/cattle_record_sequence_nav.spec.js',
  'tests/cattle_daily_sequence_nav.spec.js',
  'tests/cattle_batch_sequence_nav.spec.js',
  'tests/equipment_sequence_nav.spec.js',
  'tests/layer_sequence_nav.spec.js',
  'tests/sheep_batch_sequence_nav.spec.js',
  'tests/task_sequence_nav.spec.js',
  'tests/weighin_sequence_nav.spec.js',
  'tests/weighin_session_record_pages.spec.js',
];

describe('CP4: inline record/sequence spec seeds are idempotent', () => {
  for (const rel of CP4_SPEC_FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');

    it(`${rel} contains no plain .insert( calls`, () => {
      expect(src).not.toMatch(/\.insert\(/);
    });

    it(`${rel} writes rows via upsert(..., {onConflict: 'id'})`, () => {
      expect(src).toMatch(/\.upsert\(/);
      expect(src).toMatch(/onConflict:\s*'id'/);
    });

    it(`${rel} does not rely on ignoreDuplicates`, () => {
      expect(src).not.toMatch(/ignoreDuplicates/);
    });
  }
});

describe('CP4: inline seeds reset known mutable columns', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  for (const rel of ['tests/cattle_record_sequence_nav.spec.js', 'tests/weighin_session_record_pages.spec.js']) {
    it(`${rel} resets cattle soft-delete + attachment columns`, () => {
      const src = read(rel);
      expect(src).toMatch(/deleted_at:\s*null/);
      expect(src).toMatch(/deleted_by:\s*null/);
      expect(src).toMatch(/processing_batch_id:\s*null/);
    });
  }

  it('weighin_session_record_pages.spec.js resets weigh_ins trip/breeding + session columns', () => {
    const src = read('tests/weighin_session_record_pages.spec.js');
    expect(src).toMatch(/sent_to_trip_id:\s*null/);
    expect(src).toMatch(/transferred_to_breeding:\s*false/);
    expect(src).toMatch(/completed_at:\s*null/);
  });

  it('task_sequence_nav.spec.js resets task completion columns', () => {
    const src = read('tests/task_sequence_nav.spec.js');
    expect(src).toMatch(/completed_at:\s*null/);
    expect(src).toMatch(/completion_note:\s*null/);
  });
});

// ── CP5: inline broiler metadata Playwright spec seeds ──────────────────────
// Fixed-id rows created inside the broiler metadata spec must follow the same
// worker-restart contract as scenario seeds: upsert by id, and reset nullable
// runtime columns that could otherwise survive from a stale row.
const CP5_SPEC_FILES = ['tests/admin_broiler_session_metadata_edit.spec.js'];

describe('CP5: inline broiler metadata spec seeds are idempotent', () => {
  for (const rel of CP5_SPEC_FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');

    it(`${rel} contains no plain .insert( calls`, () => {
      expect(src).not.toMatch(/\.insert\(/);
    });

    it(`${rel} writes fixed-id rows via upsert(..., {onConflict: 'id'})`, () => {
      expect(src).toMatch(/\.upsert\(/);
      expect(src).toMatch(/onConflict:\s*'id'/);
    });

    it(`${rel} does not rely on ignoreDuplicates`, () => {
      expect(src).not.toMatch(/ignoreDuplicates/);
    });
  }
});

describe('CP5: inline broiler metadata seeds reset known mutable columns', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tests/admin_broiler_session_metadata_edit.spec.js'), 'utf8');

  it('admin_broiler_session_metadata_edit.spec.js resets session mutable columns', () => {
    expect(src).toMatch(/herd:\s*null/);
    expect(src).toMatch(/notes:\s*null/);
    expect(src).toMatch(/client_submission_id:\s*null/);
  });

  it('admin_broiler_session_metadata_edit.spec.js resets weigh_ins runtime columns', () => {
    expect(src).toMatch(/sent_to_trip_id:\s*null/);
    expect(src).toMatch(/sent_to_group_id:\s*null/);
    expect(src).toMatch(/send_to_processor:\s*false/);
    expect(src).toMatch(/target_processing_batch_id:\s*null/);
    expect(src).toMatch(/transferred_to_breeding:\s*false/);
    expect(src).toMatch(/transfer_breeder_id:\s*null/);
    expect(src).toMatch(/feed_allocation_lbs:\s*null/);
    expect(src).toMatch(/prior_herd_or_flock:\s*null/);
  });
});

// CP6: inline pig metrics Playwright/RPC spec seeds.
const CP6_SPEC_FILES = [
  'tests/pig_weighin_metrics_public.spec.js',
  'tests/pig_weighin_metrics_admin.spec.js',
  'tests/pig_session_metrics_rpc.spec.js',
];

describe('CP6: inline pig metrics spec seeds are idempotent', () => {
  for (const rel of CP6_SPEC_FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');

    it(`${rel} contains no plain .insert( calls`, () => {
      expect(src).not.toMatch(/\.insert\(/);
    });

    it(`${rel} writes fixed-id rows via upsert(..., {onConflict: 'id'})`, () => {
      expect(src).toMatch(/\.upsert\(/);
      expect(src).toMatch(/onConflict:\s*'id'/);
    });

    it(`${rel} does not rely on ignoreDuplicates`, () => {
      expect(src).not.toMatch(/ignoreDuplicates/);
    });
  }
});

describe('CP6: inline pig metrics seeds reset known mutable columns', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  for (const rel of CP6_SPEC_FILES) {
    it(`${rel} resets weigh_in_sessions mutable columns`, () => {
      const src = read(rel);
      expect(src).toMatch(/herd:\s*null/);
      expect(src).toMatch(/broiler_week:\s*null/);
      expect(src).toMatch(/completed_at:\s*/);
      expect(src).toMatch(/notes:\s*null/);
      expect(src).toMatch(/client_submission_id:\s*null/);
    });

    it(`${rel} resets weigh_ins runtime columns`, () => {
      const src = read(rel);
      expect(src).toMatch(/sent_to_trip_id:\s*null/);
      expect(src).toMatch(/sent_to_group_id:\s*null/);
      expect(src).toMatch(/send_to_processor:\s*false/);
      expect(src).toMatch(/target_processing_batch_id:\s*null/);
      expect(src).toMatch(/transferred_to_breeding:\s*false/);
      expect(src).toMatch(/transfer_breeder_id:\s*null/);
      expect(src).toMatch(/feed_allocation_lbs:\s*null/);
      expect(src).toMatch(/prior_herd_or_flock:\s*null/);
      expect(src).toMatch(/client_submission_id:\s*null/);
    });
  }

  it('pig_session_metrics_rpc.spec.js resets pig_dailys stale-state columns', () => {
    const src = read('tests/pig_session_metrics_rpc.spec.js');
    expect(src).toMatch(/deleted_at:\s*null/);
    expect(src).toMatch(/deleted_by:\s*null/);
    expect(src).toMatch(/photos:\s*\[\]/);
    expect(src).toMatch(/source:\s*null/);
    expect(src).toMatch(/daily_submission_id:\s*null/);
    expect(src).toMatch(/client_submission_id:\s*null/);
  });
});

// CP7: equipment Playwright spec seeds.
const CP7_SPEC_FILES = ['tests/equipment_materials.spec.js', 'tests/equipment_fueling_rpc.spec.js'];

describe('CP7: equipment Playwright spec seeds are idempotent/run-scoped', () => {
  for (const rel of CP7_SPEC_FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');

    it(`${rel} contains no plain .insert( calls`, () => {
      expect(src).not.toMatch(/\.insert\(/);
    });

    it(`${rel} writes direct service-role setup rows via upsert(..., {onConflict: 'id'})`, () => {
      expect(src).toMatch(/\.upsert\(/);
      expect(src).toMatch(/onConflict:\s*'id'/);
    });

    it(`${rel} scopes seeded ids and unique values to the current worker run`, () => {
      expect(src).toMatch(/const RUN_ID =/);
      expect(src).toMatch(/const seedKey =/);
      expect(src).toMatch(/const uniqueSeed =/);
    });

    it(`${rel} does not rely on ignoreDuplicates`, () => {
      expect(src).not.toMatch(/ignoreDuplicates/);
    });
  }
});

describe('CP7: equipment seeds avoid fixed unique-key collisions', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('equipment_materials.spec.js scopes fixed material slugs/ids and direct child rows', () => {
    const src = read('tests/equipment_materials.spec.js');
    expect(src).toContain("slug: seedKey('mat-overdue')");
    expect(src).toContain("id: seedKey('esm-grease')");
    expect(src).toContain("id: seedKey('emc-pre')");
    expect(src).toContain("id: seedKey('ef-cross')");
    expect(src).not.toContain("slug: 'mat-overdue'");
    expect(src).not.toContain("id: 'esm-grease'");
    expect(src).not.toContain("id: 'emc-pre'");
    expect(src).not.toContain("id: 'ef-cross'");
  });

  it('equipment_fueling_rpc.spec.js scopes fixed slugs and client_submission_id values', () => {
    const src = read('tests/equipment_fueling_rpc.spec.js');
    expect(src).toContain("slug: seedKey('rpc-hours')");
    expect(src).toContain("const csid = seedKey('csid-hours-1')");
    expect(src).toContain("id: seedKey('fuel-replay-2')");
    expect(src).not.toContain("slug: 'rpc-hours'");
    expect(src).not.toContain("client_submission_id).toBe('csid-hours-1')");
    expect(src).not.toContain("id: 'fuel-replay-2'");
  });
});

// ── CP8: remaining fixed-id Playwright spec seeds ────────────────────────────
// CP8 audited the rest of the plain `.insert(` calls in tests/ and converted
// only the deterministic fixed-id service-role SETUP rows that can collide on a
// shared-DB worker-restart race. Inserts left as plain insert (run-unique ids,
// anon/offline/constraint semantics under test, or AFTER INSERT triggers whose
// side effects are the contract under test) are intentionally NOT converted —
// see the partial-conversion block below and the lane report.
const CP8_FULL_FILES = [
  'tests/cattle_forecast.spec.js',
  'tests/daily_report_photos.spec.js',
  'tests/activity_navigation.spec.js',
  'tests/cattle_soft_delete.spec.js',
  'tests/tasks_v2_t3_t4.spec.js',
  'tests/tasks_v2_t5_system_tasks.spec.js',
  'tests/tasks_v2_t6_t7_create_complete.spec.js',
  'tests/tasks_v2_t8_t9_admin_controls.spec.js',
  'tests/tasks_v2_header_assignee_availability.spec.js',
  'tests/tasks_v2_center_my_tasks.spec.js',
];

describe('CP8: fully-converted spec seeds use upsert, not plain insert', () => {
  for (const rel of CP8_FULL_FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');

    it(`${rel} contains no plain .insert( calls`, () => {
      expect(src).not.toMatch(/\.insert\(/);
    });

    it(`${rel} writes fixed-id rows via upsert(..., {onConflict: ...})`, () => {
      expect(src).toMatch(/\.upsert\(/);
      expect(src).toMatch(/onConflict:/);
    });

    it(`${rel} does not rely on ignoreDuplicates`, () => {
      expect(src).not.toMatch(/ignoreDuplicates/);
    });
  }
});

describe('CP8: cattle_forecast uses the correct composite/natural conflict targets', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tests/cattle_forecast.spec.js'), 'utf8');

  it('cattle + cattle_processing_batches seeds upsert on id', () => {
    expect(src).toMatch(/from\('cattle'\)\.upsert\(/);
    expect(src).toMatch(/from\('cattle_processing_batches'\)\.upsert\(/);
    expect(src).toMatch(/onConflict:\s*'id'/);
  });

  it('cattle_forecast_hidden upserts on the (cattle_id, month_key) composite PK', () => {
    expect(src).toMatch(/from\('cattle_forecast_hidden'\)\s*\.upsert\(/);
    expect(src).toMatch(/onConflict:\s*'cattle_id,month_key'/);
  });

  it('cattle_forecast_heifer_includes upserts on the cattle_id PK', () => {
    expect(src).toMatch(/from\('cattle_forecast_heifer_includes'\)\.upsert\(/);
    expect(src).toMatch(/onConflict:\s*'cattle_id'/);
  });
});

// ── CP8: partial conversions — fixed-id SETUP rows converted, trigger-firing
// inserts intentionally retained. cattle_calving_records inserts drive the
// mig 032/033/044 AFTER INSERT promote/dam-link triggers the specs assert, and
// tasks_v2_rpcs keeps the task_instances inserts whose AFTER INSERT
// designation/photo-sidecar side effects are the contract under test. Upserting
// those would silently UPDATE on a stale row and skip the AFTER INSERT trigger.
describe('CP8: partial conversions keep trigger-firing inserts', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  for (const rel of ['tests/cattle_heifer_promote.spec.js', 'tests/cattle_calf_dam_link.spec.js']) {
    const src = read(rel);

    it(`${rel} seeds cattle rows via upsert(onConflict: 'id')`, () => {
      expect(src).toMatch(/from\('cattle'\)\.upsert\(/);
      expect(src).not.toMatch(/from\('cattle'\)\.insert\(/);
      expect(src).toMatch(/onConflict:\s*'id'/);
    });

    it(`${rel} intentionally keeps cattle_calving_records inserts (AFTER INSERT trigger under test)`, () => {
      expect(src).toMatch(/from\('cattle_calving_records'\)\.insert\(/);
    });

    it(`${rel} does not rely on ignoreDuplicates`, () => {
      expect(src).not.toMatch(/ignoreDuplicates/);
    });
  }

  it('tasks_v2_rpcs.spec.js converts the tmpl-trig-1 FK template to upsert(onConflict: id)', () => {
    const src = read('tests/tasks_v2_rpcs.spec.js');
    expect(src).toMatch(/from\('task_templates'\)\.upsert\(/);
    expect(src).not.toMatch(/from\('task_templates'\)\.insert\(/);
    expect(src).toMatch(/onConflict:\s*'id'/);
  });

  it('tasks_v2_rpcs.spec.js keeps the trigger-firing task_instances inserts (designation/photo sidecar under test)', () => {
    const src = read('tests/tasks_v2_rpcs.spec.js');
    expect(src).toMatch(/from\('task_instances'\)\.insert\(/);
  });
});

// ── CP8 follow-up: task_instances upserts must clear completion + edit-history
// stale state. upsert(onConflict:'id') only overwrites columns present in the
// payload, and the due-date edit history is a separate append-only sidecar that
// does not cascade on upsert — so open seeds that the spec later completes must
// null the completion columns, and the edit-cap specs must delete stale
// task_instance_due_date_edits rows for their fixed ids (same CP2/CP4 rule).
describe('CP8 follow-up: completion + edit-history stale-state resets', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('tasks_v2_t6_t7 open task seeds reset completion + request-photo columns', () => {
    const src = read('tests/tasks_v2_t6_t7_create_complete.spec.js');
    for (const col of [
      'completed_at: null',
      'completed_by_profile_id: null',
      'completion_note: null',
      'completion_photo_path: null',
      'request_photo_path: null',
    ]) {
      expect(src).toContain(col);
    }
    // Every fixed-id open seed (5 across the file) carries the reset set, so the
    // most-specific reset column appears at least that many times.
    const photoResets = src.match(/completion_photo_path: null/g) || [];
    expect(photoResets.length).toBeGreaterThanOrEqual(5);
  });

  it('tasks_v2_t8_t9 clears the append-only due-date edit history for its fixed ids', () => {
    const src = read('tests/tasks_v2_t8_t9_admin_controls.spec.js');
    expect(src).toMatch(/from\('task_instance_due_date_edits'\)\s*\.delete\(\)/);
    expect(src).toMatch(/instance_id'?,?\s*'tic-t8-simon-edit'/);
    expect(src).toContain("'tic-t8-cap-hit'");
  });
});

// -- CP9: remaining plain inserts are audited exceptions ----------------------
// After CP8, the only executable `.insert(` calls left in Playwright specs are
// rows whose INSERT semantics are part of the test contract: run-unique scratch
// setup rows, anon/offline duplicate-key behavior, or trigger/RPC paths where an
// upsert would silently update a stale row and skip the behavior under test.
const CP9_RAW_INSERT_SPEC_ALLOWLIST = [
  'tests/broiler_weigh_in_schooners.spec.js',
  'tests/cattle_calf_dam_link.spec.js',
  // Audited: seeds a dam + calving record (fixed ids, delete-first) for the
  // delete_cattle_calving_record RPC spec; idempotent under the worker race.
  'tests/cattle_calving_delete.spec.js',
  'tests/cattle_heifer_promote.spec.js',
  // Audited: bulk inert cattle-log rows (205-row pagination seed with FIXED
  // literal ids 'cl-page-0000'… + a Simon-authored search target) inserted
  // service-role behind delete-first hygiene (every cattle_log spec
  // hard-deletes ALL comments rows up front, links/issue rows cascade), so
  // an upsert would hide the duplicate-id failure the contract wants to
  // surface.
  'tests/cattle_log_basic.spec.js',
  // Audited: inert filler comments (FIXED literal ids 'cl-mntfill-00'…)
  // forcing a real scroll for the deep-link assertion; same delete-first
  // hygiene as above.
  'tests/cattle_log_mention_deeplink.spec.js',
  // Audited: screenshot-state seed rows with run-scoped mintEntryId() ids
  // (Date.now + random) behind the same delete-first comments wipe.
  'tests/cattle_log_screenshots.spec.js',
  'tests/generate_task_instances_rpc.spec.js',
  // Audited: seeds two throwaway newsletter issues (FIXED ids nli-2099-11 /
  // nli-2099-10, delete-first; deleted again in afterAll) for the public/admin
  // newsletter e2e. Service-role insert behind delete-first hygiene so a
  // duplicate-id failure surfaces rather than being masked by an upsert.
  'tests/newsletter_public.spec.js',
  // Audited: seeds a one-time task (fixed ids, delete-first) for the
  // task_completed cross-user notification spec; idempotent under the race.
  'tests/notifications_task_completed.spec.js',
  'tests/offline_queue_dedup.spec.js',
  'tests/offline_queue_pig_dailys_photos.spec.js',
  'tests/pig_dailys_offline.spec.js',
  // Audited: seeds one linked processing comment (FIXED id cmt-ptest-rename,
  // delete-first + afterAll cleanup) so the rename lane can prove comment
  // attachment-name coherence; service-role insert behind delete-first hygiene.
  'tests/processing_attachment_thumbnail_rename.spec.js',
  'tests/tasks_v2_rpcs.spec.js',
];

function listSpecFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSpecFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.spec.js')) {
      files.push(path.relative(ROOT, full).replaceAll(path.sep, '/'));
    }
  }
  return files;
}

function executableInsertLines(src) {
  return src
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('.insert(') && !line.startsWith('//'));
}

describe('CP9: remaining Playwright plain inserts are audited exceptions', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('all executable .insert( callsites in Playwright specs are allowlisted', () => {
    const files = listSpecFiles(path.join(ROOT, 'tests'))
      .filter((rel) => executableInsertLines(read(rel)).length > 0)
      .sort();

    expect(files).toEqual(CP9_RAW_INSERT_SPEC_ALLOWLIST);
  });

  it('broiler schooner setup inserts use run-unique session ids', () => {
    const src = read('tests/broiler_weigh_in_schooners.spec.js');
    expect(src.match(/from\('weigh_in_sessions'\)\.insert\(/g) || []).toHaveLength(2);
    expect(src.match(/from\('weigh_ins'\)\.insert\(/g) || []).toHaveLength(1);
    expect(src).toMatch(/const draftId = 'wsd-' \+ Math\.random\(\)\.toString\(36\)\.slice\(2, 10\)/);
    expect(src).toMatch(/const sessionId = 'wis-' \+ Math\.random\(\)\.toString\(36\)\.slice\(2, 10\)/);
    expect(src).toContain('id: `wie-${sessionId}-${i}`');
    expect(src).not.toMatch(/ignoreDuplicates/);
  });

  it('generate_task_instances_rpc template inserts use run-unique default ids', () => {
    const src = read('tests/generate_task_instances_rpc.spec.js');
    expect(src).toContain('id: overrides.id || `tmpl-rpc-${Math.random().toString(36).slice(2, 10)}`,');
    expect(src).toMatch(/from\('task_templates'\)\.insert\(template\)/);
    expect(src).not.toMatch(/id:\s*'tmpl-rpc-/);
    expect(src).not.toMatch(/ignoreDuplicates/);
  });

  it('offline_queue_dedup keeps raw inserts for null-csid and anon duplicate-key contracts', () => {
    const src = read('tests/offline_queue_dedup.spec.js');
    expect(src).toContain('legacy null client_submission_ids do NOT trigger uniqueness conflict');
    expect(src).toContain('anon insert duplicate raises 23505 referencing client_submission_id');
    expect(src.match(/from\('fuel_supplies'\)\.insert\(/g) || []).toHaveLength(4);
    expect(src).toMatch(/expect\(String\(r2\.error\.code\)\)\.toBe\('23505'\)/);
    expect(src).toMatch(/expect\(r2\.error\.message\)\.toMatch\(\/client_submission_id\/i\)/);
  });

  it('pig_dailys offline replay specs keep raw inserts to force 23505-on-csid', () => {
    const flat = read('tests/pig_dailys_offline.spec.js');
    expect(flat).toContain("id: queuedEntry.record.id + '-other-path'");
    expect(flat).toMatch(/from\('pig_dailys'\)\.insert\(preSeedRow\)/);
    expect(flat).toContain('client_submission_id is what triggers the 23505 on replay');

    const photos = read('tests/offline_queue_pig_dailys_photos.spec.js');
    expect(photos).toMatch(/id: 'pre-seed-id-' \+ Math\.random\(\)\.toString\(36\)\.slice\(2, 10\)/);
    expect(photos).toMatch(/from\('pig_dailys'\)\.insert\(preSeed\)/);
    expect(photos).toContain('23505 path');
    expect(photos).toContain('pre-seed wins');
  });
});
