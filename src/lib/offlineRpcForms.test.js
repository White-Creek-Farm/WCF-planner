import {describe, it, expect} from 'vitest';
import {buildRpcRequest, getRpcFormConfig, RPC_FORM_KINDS} from './offlineRpcForms.js';

// ============================================================================
// Phase 1C-D registry coverage — weigh_in_session_batch buildArgs
// ----------------------------------------------------------------------------
// add_feed_batch registry shape is already locked by useOfflineRpcSubmit.test.js
// (the original Phase 1C-A test file). This file is registry-only — no hook,
// no IndexedDB, no supabase mocking — focused on the pure (payload, ids) →
// args contract that the queue worker re-applies on every replay.
// ============================================================================

const PIG_PAYLOAD = {
  species: 'pig',
  date: '2026-04-30',
  team_member: 'BMAN',
  batch_id: 'P-26-01',
  started_at: '2026-04-30T09:15:00.000Z',
  entries: [
    {weight: 240, tag: null, note: null, new_tag_flag: false, entered_at: '2026-04-30T09:15:30.000Z'},
    {weight: 245, tag: null, note: 'limps', new_tag_flag: false, entered_at: '2026-04-30T09:15:45.000Z'},
    {weight: 250, tag: null, note: null, new_tag_flag: false, entered_at: '2026-04-30T09:16:00.000Z'},
  ],
};

const BROILER_PAYLOAD = {
  species: 'broiler',
  date: '2026-04-30',
  team_member: 'BMAN',
  batch_id: 'B-26-01',
  broiler_week: 4,
  started_at: '2026-04-30T10:00:00.000Z',
  entries: [
    {weight: 1.4, tag: 'A', note: null, new_tag_flag: false, entered_at: '2026-04-30T10:00:30.000Z'},
    {weight: 1.5, tag: 'A', note: null, new_tag_flag: false, entered_at: '2026-04-30T10:00:45.000Z'},
    {weight: 1.6, tag: 'B', note: null, new_tag_flag: false, entered_at: '2026-04-30T10:01:00.000Z'},
    {weight: 1.7, tag: 'B', note: null, new_tag_flag: false, entered_at: '2026-04-30T10:01:15.000Z'},
  ],
};

describe('offlineRpcForms registry — weigh_in_session_batch', () => {
  it('exports weigh_in_session_batch as a known form_kind', () => {
    expect(RPC_FORM_KINDS).toContain('weigh_in_session_batch');
    const cfg = getRpcFormConfig('weigh_in_session_batch');
    expect(cfg.rpc).toBe('submit_weigh_in_session_batch');
    expect(typeof cfg.buildArgs).toBe('function');
  });

  it('pig minimum payload: parent shape + status=draft + no broiler_week', () => {
    const req = buildRpcRequest('weigh_in_session_batch', PIG_PAYLOAD, {csid: 'csid-pig', parentId: 'WS-pig'});
    expect(req.rpc).toBe('submit_weigh_in_session_batch');
    expect(req.args.parent_in.id).toBe('WS-pig');
    expect(req.args.parent_in.client_submission_id).toBe('csid-pig');
    expect(req.args.parent_in.species).toBe('pig');
    expect(req.args.parent_in.status).toBe('draft');
    expect(req.args.parent_in.date).toBe('2026-04-30');
    expect(req.args.parent_in.team_member).toBe('BMAN');
    expect(req.args.parent_in.batch_id).toBe('P-26-01');
    expect('broiler_week' in req.args.parent_in).toBe(false);
  });

  it('broiler payload with broiler_week=4 carries week on parent_in', () => {
    const req = buildRpcRequest('weigh_in_session_batch', BROILER_PAYLOAD, {csid: 'csid-b4', parentId: 'WS-b4'});
    expect(req.args.parent_in.species).toBe('broiler');
    expect(req.args.parent_in.broiler_week).toBe(4);
  });

  it('broiler payload with broiler_week=6 carries week on parent_in', () => {
    const req = buildRpcRequest(
      'weigh_in_session_batch',
      {...BROILER_PAYLOAD, broiler_week: 6},
      {csid: 'csid-b6', parentId: 'WS-b6'},
    );
    expect(req.args.parent_in.broiler_week).toBe(6);
  });

  it('byte-identical args on repeated buildRpcRequest(payload, ids) calls (replay determinism)', () => {
    // Critical: the queue worker re-calls sb.rpc(record.rpc, record.args) on
    // every drain. If buildArgs were not pure over (payload, ids) — e.g. by
    // stamping a fresh new Date() inside — replays would mutate the args
    // and the RPC would see a different parent every retry. Codex amend #1:
    // started_at + entered_at are PASS-THROUGH from the payload, never
    // generated inside buildArgs.
    const ids = {csid: 'csid-det', parentId: 'WS-det'};
    const a = buildRpcRequest('weigh_in_session_batch', PIG_PAYLOAD, ids);
    const b = buildRpcRequest('weigh_in_session_batch', PIG_PAYLOAD, ids);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('children carry NO client_submission_id field', () => {
    // Mig 030's unique index on weigh_ins.client_submission_id would 23505
    // on entry #2 of any multi-entry session if the parent's csid bled
    // through. Lock by exact-property absence (locked by Test 4 of the
    // mig 035 RPC contract spec on the DB side; this is the client-side
    // mirror).
    const req = buildRpcRequest('weigh_in_session_batch', PIG_PAYLOAD, {csid: 'csid-x', parentId: 'WS-x'});
    expect(req.args.entries_in.length).toBeGreaterThan(0);
    for (const child of req.args.entries_in) {
      expect('client_submission_id' in child).toBe(false);
    }
  });

  it('children carry NO side-effect columns (transfer/processor/trip/retag)', () => {
    // §7 mig 035 contract: side-effect columns are runtime-only, not RPC-written.
    const req = buildRpcRequest('weigh_in_session_batch', BROILER_PAYLOAD, {csid: 'csid-x', parentId: 'WS-x'});
    const FORBIDDEN = [
      'send_to_processor',
      'target_processing_batch_id',
      'sent_to_trip_id',
      'transferred_to_breeding',
      'transfer_breeder_id',
      'feed_allocation_lbs',
      'prior_herd_or_flock',
      'reconcile_intent',
    ];
    for (const child of req.args.entries_in) {
      for (const col of FORBIDDEN) {
        expect(col in child).toBe(false);
      }
    }
  });

  it('broiler entry preserves schooner label in tag column', () => {
    // Today's saveBatch convention stores the schooner LABEL in weigh_ins.tag.
    // The RPC's child writer reads `tag` straight through. buildArgs must
    // NOT rename, drop, or coerce this field.
    const req = buildRpcRequest('weigh_in_session_batch', BROILER_PAYLOAD, {csid: 'csid-x', parentId: 'WS-x'});
    expect(req.args.entries_in[0].tag).toBe('A');
    expect(req.args.entries_in[2].tag).toBe('B');
  });

  it('pig entry passes tag: null straight through', () => {
    const req = buildRpcRequest('weigh_in_session_batch', PIG_PAYLOAD, {csid: 'csid-x', parentId: 'WS-x'});
    for (const child of req.args.entries_in) {
      expect(child.tag).toBeNull();
    }
  });

  it('entered_at is a pure pass-through from payload entry (Codex amend #1)', () => {
    // Caller stamps entered_at when the user adds the entry. buildArgs must
    // preserve it byte-for-byte so retries don't shift timestamps to drain
    // time. If the caller omits entered_at, the field is omitted from the
    // child too (RPC defaults the column to now()).
    const req = buildRpcRequest('weigh_in_session_batch', PIG_PAYLOAD, {csid: 'csid-x', parentId: 'WS-x'});
    expect(req.args.entries_in[0].entered_at).toBe('2026-04-30T09:15:30.000Z');
    expect(req.args.entries_in[1].entered_at).toBe('2026-04-30T09:15:45.000Z');
    expect(req.args.entries_in[2].entered_at).toBe('2026-04-30T09:16:00.000Z');

    const noTimestampPayload = {
      ...PIG_PAYLOAD,
      entries: [{weight: 240, tag: null}],
    };
    const req2 = buildRpcRequest('weigh_in_session_batch', noTimestampPayload, {csid: 'c2', parentId: 'WS-2'});
    expect('entered_at' in req2.args.entries_in[0]).toBe(false);
  });

  it('child IDs are exactly ${parentId}-c${i}', () => {
    // Locks against any future buildArgs refactor that might prepend, suffix,
    // or rehash the child ID. The Playwright canary spec asserts this same
    // shape end-to-end; the unit test catches it before the harness runs.
    const req = buildRpcRequest('weigh_in_session_batch', BROILER_PAYLOAD, {
      csid: 'csid-x',
      parentId: 'WS-childid',
    });
    expect(req.args.entries_in.map((c) => c.id)).toEqual([
      'WS-childid-c0',
      'WS-childid-c1',
      'WS-childid-c2',
      'WS-childid-c3',
    ]);
  });

  it('started_at + notes are pass-through; omitted when missing', () => {
    const req = buildRpcRequest('weigh_in_session_batch', PIG_PAYLOAD, {csid: 'c', parentId: 'P'});
    expect(req.args.parent_in.started_at).toBe('2026-04-30T09:15:00.000Z');
    expect('notes' in req.args.parent_in).toBe(false);

    const withNotes = {...PIG_PAYLOAD, notes: 'paddock 3 was muddy'};
    const req2 = buildRpcRequest('weigh_in_session_batch', withNotes, {csid: 'c2', parentId: 'P2'});
    expect(req2.args.parent_in.notes).toBe('paddock 3 was muddy');

    const bareBones = {
      species: 'pig',
      date: '2026-04-30',
      team_member: 'BMAN',
      batch_id: 'P-26-01',
      entries: [{weight: 240, tag: null}],
    };
    const req3 = buildRpcRequest('weigh_in_session_batch', bareBones, {csid: 'c3', parentId: 'P3'});
    expect('started_at' in req3.args.parent_in).toBe(false);
    expect('notes' in req3.args.parent_in).toBe(false);
  });
});

// ============================================================================
// Lane H registry coverage — equipment_fueling buildArgs
// ----------------------------------------------------------------------------
// Single-parent RPC (no children). buildArgs is a thin shaper that stamps the
// hook-minted parentId/csid onto an already-computed payload. The form does
// the heavy field math (service intervals, every-fillup checks, photo URLs);
// the registry must not re-derive or drop any of it, and must be byte-stable
// across replays.
// ============================================================================

const HOURS_FUELING_PAYLOAD = {
  equipment_id: 'eq-tractor-1',
  date: '2026-06-08',
  team_member: 'BMAN',
  fuel_type: 'diesel',
  gallons: 12.5,
  def_gallons: 2,
  fuel_cost_per_gal: null,
  hours_reading: 250,
  km_reading: null,
  every_fillup_check: [{id: 'oil', label: 'Check oil', ok: true}],
  service_intervals_completed: [{interval: 250, kind: 'hours', label: '250h', completed_at: '2026-06-08'}],
  photos: [
    {
      name: 'side.jpg',
      path: 'fueling/tractor/1-side.jpg',
      url: 'https://x/side.jpg',
      uploadedAt: '2026-06-08T10:00:00.000Z',
    },
  ],
  comments: 'left front tire low',
  source: 'fuel_log_webform',
  podio_source_app: null,
};

const KM_FUELING_PAYLOAD = {
  equipment_id: 'eq-truck-1',
  date: '2026-06-08',
  team_member: 'BMAN',
  fuel_type: 'gasoline',
  gallons: 20,
  def_gallons: null,
  fuel_cost_per_gal: null,
  hours_reading: null,
  km_reading: 80500,
  every_fillup_check: [],
  service_intervals_completed: [],
  photos: [],
  comments: null,
  source: 'fuel_log_webform',
  podio_source_app: null,
};

describe('offlineRpcForms registry — equipment_fueling', () => {
  it('exports equipment_fueling as a known form_kind mapping to submit_equipment_fueling', () => {
    expect(RPC_FORM_KINDS).toContain('equipment_fueling');
    const cfg = getRpcFormConfig('equipment_fueling');
    expect(cfg.rpc).toBe('submit_equipment_fueling');
    expect(typeof cfg.buildArgs).toBe('function');
  });

  it('is a single-parent RPC: no children_in / entries_in key', () => {
    const req = buildRpcRequest('equipment_fueling', HOURS_FUELING_PAYLOAD, {csid: 'csid-h', parentId: 'EF-h'});
    expect(req.rpc).toBe('submit_equipment_fueling');
    expect('parent_in' in req.args).toBe(true);
    expect('children_in' in req.args).toBe(false);
    expect('entries_in' in req.args).toBe(false);
  });

  it('stamps hook-minted id + client_submission_id onto parent_in', () => {
    const req = buildRpcRequest('equipment_fueling', HOURS_FUELING_PAYLOAD, {csid: 'csid-h', parentId: 'EF-h'});
    expect(req.args.parent_in.id).toBe('EF-h');
    expect(req.args.parent_in.client_submission_id).toBe('csid-h');
  });

  it('hours-tracked payload carries hours_reading + null km_reading verbatim', () => {
    const req = buildRpcRequest('equipment_fueling', HOURS_FUELING_PAYLOAD, {csid: 'c', parentId: 'P'});
    expect(req.args.parent_in.hours_reading).toBe(250);
    expect(req.args.parent_in.km_reading).toBeNull();
    expect(req.args.parent_in.equipment_id).toBe('eq-tractor-1');
    expect(req.args.parent_in.gallons).toBe(12.5);
    expect(req.args.parent_in.def_gallons).toBe(2);
    expect(req.args.parent_in.fuel_type).toBe('diesel');
    expect(req.args.parent_in.source).toBe('fuel_log_webform');
  });

  it('km-tracked payload carries km_reading + null hours_reading verbatim', () => {
    const req = buildRpcRequest('equipment_fueling', KM_FUELING_PAYLOAD, {csid: 'c', parentId: 'P'});
    expect(req.args.parent_in.km_reading).toBe(80500);
    expect(req.args.parent_in.hours_reading).toBeNull();
    expect(req.args.parent_in.def_gallons).toBeNull();
  });

  it('passes already-computed checklist + photo data straight through (no re-derivation)', () => {
    const req = buildRpcRequest('equipment_fueling', HOURS_FUELING_PAYLOAD, {csid: 'c', parentId: 'P'});
    expect(req.args.parent_in.every_fillup_check).toEqual(HOURS_FUELING_PAYLOAD.every_fillup_check);
    expect(req.args.parent_in.service_intervals_completed).toEqual(HOURS_FUELING_PAYLOAD.service_intervals_completed);
    expect(req.args.parent_in.photos).toEqual(HOURS_FUELING_PAYLOAD.photos);
    expect(req.args.parent_in.comments).toBe('left front tire low');
  });

  it('defaults array/scalar fields when the payload omits them', () => {
    const minimal = {
      equipment_id: 'eq-x',
      date: '2026-06-08',
      team_member: 'BMAN',
      gallons: 5,
      hours_reading: 10,
    };
    const req = buildRpcRequest('equipment_fueling', minimal, {csid: 'c', parentId: 'P'});
    expect(req.args.parent_in.every_fillup_check).toEqual([]);
    expect(req.args.parent_in.service_intervals_completed).toEqual([]);
    expect(req.args.parent_in.photos).toEqual([]);
    expect(req.args.parent_in.fuel_type).toBeNull();
    expect(req.args.parent_in.def_gallons).toBeNull();
    expect(req.args.parent_in.fuel_cost_per_gal).toBeNull();
    expect(req.args.parent_in.km_reading).toBeNull();
    expect(req.args.parent_in.comments).toBeNull();
    expect(req.args.parent_in.source).toBe('fuel_log_webform');
    expect(req.args.parent_in.podio_source_app).toBeNull();
  });

  it('byte-identical args on repeated buildRpcRequest(payload, ids) calls (replay determinism)', () => {
    // The queue worker re-calls sb.rpc(record.rpc, record.args) on every drain.
    // buildArgs must be pure over (payload, ids) — no Date.now()/Math.random()
    // inside — so a queued fueling replays the exact same parent every retry.
    const ids = {csid: 'csid-det', parentId: 'EF-det'};
    const a = buildRpcRequest('equipment_fueling', HOURS_FUELING_PAYLOAD, ids);
    const b = buildRpcRequest('equipment_fueling', HOURS_FUELING_PAYLOAD, ids);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
