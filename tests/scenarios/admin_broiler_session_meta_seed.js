// Admin broiler session metadata-edit scenario seed.
//
// Seeds the data the admin LivestockWeighInsView needs for broiler:
//   - one ACTIVE broiler batch (B-26-01) in app_store.ppp-v4
//     pre-stamped with week4Lbs=1.5 to match the seeded complete session
//   - webform_config.broiler_groups + broiler_batch_meta (active-only
//     filter would put B-26-01 in both; helper output mirrored directly)
//   - team_roster: BMAN + JANE active. Tests that need a retired-name
//     scenario insert a team_member='RETIREE' on a session row directly;
//     the active roster never includes RETIREE.
//   - 2 broiler weigh-in sessions for the batch:
//       sd-draft   : status='draft',    broiler_week=4, BMAN, 0 entries
//       sd-complete: status='complete', broiler_week=4, BMAN, 5 entries
//                    (avg 1.5; matches pre-stamped ppp-v4.week4Lbs)
//   - tests that need a SECOND complete wk4 session for the
//     two-session WK 4→6 case (T4) seed it themselves via supabaseAdmin.

const ROSTER = [
  {id: 'tm-bman', name: 'BMAN'},
  {id: 'tm-jane', name: 'JANE'},
];

const PPPV4 = [
  {
    name: 'B-26-01',
    schooner: '2&3',
    breed: 'CC',
    hatchery: 'CREDO FARMS',
    status: 'active',
    week4Lbs: 1.5,
  },
];

const BROILER_GROUPS = ['B-26-01'];
const BROILER_BATCH_META = [{name: 'B-26-01', schooners: ['2', '3']}];

const BATCH_ID = 'B-26-01';
const DRAFT_ID = 'sd-draft';
const COMPLETE_ID = 'sd-complete';

export async function seedAdminBroilerSessionMeta(supabaseAdmin) {
  // Roster (canonical + legacy mirror).
  let r = await supabaseAdmin.from('webform_config').upsert({key: 'team_roster', data: ROSTER}, {onConflict: 'key'});
  if (r.error) throw new Error(`seedAdminBroilerSessionMeta: team_roster ${r.error.message}`);
  r = await supabaseAdmin
    .from('webform_config')
    .upsert({key: 'team_members', data: ['BMAN', 'JANE']}, {onConflict: 'key'});
  if (r.error) throw new Error(`seedAdminBroilerSessionMeta: team_members ${r.error.message}`);

  // Public broiler webform_config keys (active-only filter output mirrored).
  r = await supabaseAdmin
    .from('webform_config')
    .upsert({key: 'broiler_groups', data: BROILER_GROUPS}, {onConflict: 'key'});
  if (r.error) throw new Error(`seedAdminBroilerSessionMeta: broiler_groups ${r.error.message}`);
  r = await supabaseAdmin
    .from('webform_config')
    .upsert({key: 'broiler_batch_meta', data: BROILER_BATCH_META}, {onConflict: 'key'});
  if (r.error) throw new Error(`seedAdminBroilerSessionMeta: broiler_batch_meta ${r.error.message}`);

  // app_store.ppp-v4 (admin source-of-truth; pre-stamped wk4 avg = 1.5).
  r = await supabaseAdmin.from('app_store').upsert({key: 'ppp-v4', data: PPPV4}, {onConflict: 'key'});
  if (r.error) throw new Error(`seedAdminBroilerSessionMeta: ppp-v4 ${r.error.message}`);

  // Sessions.
  const today = new Date().toISOString().slice(0, 10);
  const startedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const completedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const draftRow = {
    id: DRAFT_ID,
    species: 'broiler',
    status: 'draft',
    date: today,
    team_member: 'BMAN',
    batch_id: BATCH_ID,
    broiler_week: 4,
    started_at: startedAt,
    // Explicit resets so an upsert overwrites a stale worker row (e.g. one a
    // prior run completed or annotated) back into the intended draft state.
    completed_at: null,
    notes: null,
  };
  const completeRow = {
    id: COMPLETE_ID,
    species: 'broiler',
    status: 'complete',
    date: today,
    team_member: 'BMAN',
    batch_id: BATCH_ID,
    broiler_week: 4,
    started_at: startedAt,
    completed_at: completedAt,
    // T5 mutates notes on this id — reset so a stale note can't survive.
    notes: null,
  };
  r = await supabaseAdmin.from('weigh_in_sessions').upsert([draftRow, completeRow], {onConflict: 'id'});
  if (r.error) throw new Error(`seedAdminBroilerSessionMeta: weigh_in_sessions ${r.error.message}`);

  // 5 weigh_ins for the complete session: weights 1.3, 1.4, 1.5, 1.6, 1.7
  // Sum = 7.5; n = 5; avg = 1.5  → matches pre-stamped ppp-v4.week4Lbs.
  const enteredAt = completedAt;
  const completeEntries = [1.3, 1.4, 1.5, 1.6, 1.7].map((w, i) => ({
    id: `${COMPLETE_ID}-e${i}`,
    session_id: COMPLETE_ID,
    tag: i < 3 ? '2' : '3',
    weight: w,
    note: null,
    new_tag_flag: false,
    entered_at: enteredAt,
  }));
  r = await supabaseAdmin.from('weigh_ins').upsert(completeEntries, {onConflict: 'id'});
  if (r.error) throw new Error(`seedAdminBroilerSessionMeta: weigh_ins ${r.error.message}`);

  return {
    batchId: BATCH_ID,
    draftId: DRAFT_ID,
    completeId: COMPLETE_ID,
    roster: ROSTER,
    pppv4: PPPV4,
  };
}
