import {test, expect} from './fixtures.js';

// Genuine farm_team browser proof for the login-gated /weighins surface.
// This catches both halves of PR3: migration-170 authorization and the client
// reroute away from the old multi-request detach helper.
test.use({storageState: {cookies: [], origins: []}});

const EMAIL = 'detach170-browser@wcfplanner.test';
const PASSWORD = 'Detach170Browser!pw';
const FULL_NAME = 'Detach Browser Farm Team';

async function ensureFarmTeamUser(supabaseAdmin) {
  const listed = await supabaseAdmin.auth.admin.listUsers();
  if (listed.error) throw new Error(`listUsers: ${listed.error.message}`);
  let user = listed.data?.users?.find((candidate) => candidate.email === EMAIL);
  if (!user) {
    const created = await supabaseAdmin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });
    if (created.error) throw new Error(`create farm_team user: ${created.error.message}`);
    user = created.data.user;
  } else {
    const updated = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      password: PASSWORD,
      email_confirm: true,
    });
    if (updated.error) throw new Error(`reset farm_team password: ${updated.error.message}`);
  }
  const profile = await supabaseAdmin.from('profiles').upsert(
    {
      id: user.id,
      email: EMAIL,
      full_name: FULL_NAME,
      role: 'farm_team',
      program_access: ['cattle'],
    },
    {onConflict: 'id'},
  );
  if (profile.error) throw new Error(`upsert farm_team profile: ${profile.error.message}`);
  return user;
}

async function login(page) {
  await page.goto('/');
  await page.getByPlaceholder('your@email.com').first().fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', {name: /^sign in$/i}).click();
  await expect(page.locator('[data-login-screen]')).toHaveCount(0, {timeout: 15_000});
}

test('farm_team /weighins toggle-clear uses one atomic cattle detach RPC', async ({
  page,
  supabaseAdmin,
  cattleMultiCowPreAttachedScenario,
}) => {
  const {batchId, sessionId, cows} = cattleMultiCowPreAttachedScenario;
  const cow = cows[0];
  const user = await ensureFarmTeamUser(supabaseAdmin);

  // The login-gated webform resumes draft sessions only. Keep the seeded
  // attached state but reopen its parent session before entering the form.
  // WeighInsWebform only lists drafts from the last seven days, so refresh the
  // historical scenario date/timestamp without weakening the real resume path.
  const now = new Date();
  const reopened = await supabaseAdmin
    .from('weigh_in_sessions')
    .update({
      date: now.toISOString().slice(0, 10),
      started_at: now.toISOString(),
      status: 'draft',
      completed_at: null,
    })
    .eq('id', sessionId);
  expect(reopened.error).toBeNull();

  let detachRpcCalls = 0;
  const forbiddenDirectWrites = [];
  page.on('request', (request) => {
    const url = request.url();
    const method = request.method();
    if (method === 'POST' && /\/rest\/v1\/rpc\/detach_cattle_from_processing_batch(?:\?|$)/.test(url)) {
      detachRpcCalls += 1;
    }
    if (
      ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) &&
      /\/rest\/v1\/(?:cattle_processing_batches|cattle|cattle_transfers|weigh_ins)(?:\?|$)/.test(url)
    ) {
      forbiddenDirectWrites.push(`${method} ${url}`);
    }
  });

  try {
    await login(page);
    await page.goto('/weighins');
    await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
    await page.getByText('Cattle', {exact: true}).click();
    await expect(page.getByText('Resume a draft session')).toBeVisible({timeout: 10_000});
    await page.getByText('finishers', {exact: true}).click();

    const row = page.locator('[data-public-weighin-recent-entry-grid="1"]').filter({hasText: `#${cow.tag}`});
    await expect(row).toBeVisible({timeout: 10_000});
    await row.getByRole('button', {name: '✓ Processor'}).click();

    await expect
      .poll(
        async () => {
          const result = await supabaseAdmin
            .from('cattle')
            .select('herd,processing_batch_id')
            .eq('id', cow.id)
            .single();
          return result.data;
        },
        {timeout: 10_000},
      )
      .toEqual({herd: 'finishers', processing_batch_id: null});

    expect(detachRpcCalls).toBe(1);
    expect(forbiddenDirectWrites).toEqual([]);

    const [batchResult, weighInResult, transferResult, activityResult] = await Promise.all([
      supabaseAdmin.from('cattle_processing_batches').select('cows_detail').eq('id', batchId).single(),
      supabaseAdmin
        .from('weigh_ins')
        .select('send_to_processor,target_processing_batch_id')
        .eq('id', `wi-test-cattle-${cow.tag}`)
        .single(),
      supabaseAdmin
        .from('cattle_transfers')
        .select('team_member,reason')
        .eq('cattle_id', cow.id)
        .eq('reason', 'processing_batch_undo')
        .single(),
      supabaseAdmin
        .from('activity_events')
        .select('actor_profile_id,payload')
        .eq('entity_type', 'cattle.processing')
        .eq('entity_id', batchId)
        .single(),
    ]);
    for (const result of [batchResult, weighInResult, transferResult, activityResult]) {
      expect(result.error).toBeNull();
    }
    expect(batchResult.data.cows_detail.map((rowItem) => rowItem.cattle_id)).not.toContain(cow.id);
    expect(weighInResult.data).toEqual({send_to_processor: false, target_processing_batch_id: null});
    expect(transferResult.data).toMatchObject({team_member: FULL_NAME, reason: 'processing_batch_undo'});
    expect(activityResult.data.actor_profile_id).toBe(user.id);
    expect(activityResult.data.payload.team_member).toBe(FULL_NAME);
  } finally {
    // activity_events.actor_profile_id is NO ACTION. Remove both possible
    // proof streams before deleting the reusable auth/profile fixture.
    const processingActivityCleanup = await supabaseAdmin
      .from('activity_events')
      .delete()
      .eq('entity_type', 'cattle.processing')
      .eq('entity_id', batchId)
      .eq('actor_profile_id', user.id);
    expect(processingActivityCleanup.error).toBeNull();
    const sessionActivityCleanup = await supabaseAdmin
      .from('activity_events')
      .delete()
      .eq('entity_type', 'weighin.session')
      .eq('entity_id', sessionId)
      .eq('actor_profile_id', user.id);
    expect(sessionActivityCleanup.error).toBeNull();
    const authCleanup = await supabaseAdmin.auth.admin.deleteUser(user.id);
    expect(authCleanup.error).toBeNull();
    const profileCleanup = await supabaseAdmin.from('profiles').delete().eq('id', user.id);
    expect(profileCleanup.error).toBeNull();
  }
});
