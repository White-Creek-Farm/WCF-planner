import {test, expect} from './fixtures.js';

// ============================================================================
// Activity + @Mentions Phase 1 end-to-end coverage.
//
// What this spec proves:
//   1. Posting a comment on a task creates an activity_event row + the
//      Activity panel renders it in the dropdown chip count and the full
//      modal.
//   2. Posting with @mention creates a mention row + a 'mention'
//      notification for the recipient (NOT the actor).
//   3. Self-mention does NOT create a notification but DOES record the
//      mention row.
//   4. Completing a task fires the task.completed trigger -> a system
//      activity_event lands in the panel without anyone commenting.
//   5. Author soft-delete renders as "(comment deleted)" in the timeline
//      and prevents the body from leaking.
//
// Multi-user assertions about recipient inboxes are done at the DB layer
// (service_role) because driving two logged-in browser contexts in the
// existing single-storage-state fixture is heavier than the value it
// adds — the static lock already covers the dropdown render shape and
// the mig 057 spec covers Header bell behavior.
// ============================================================================

const TEST_ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;

async function seedAdminProfile(supabaseAdmin) {
  const {data: u} = await supabaseAdmin.auth.admin.listUsers();
  const adminUser = (u && u.users ? u.users : []).find(
    (x) => (x.email || '').toLowerCase() === (TEST_ADMIN_EMAIL || '').toLowerCase(),
  );
  if (!adminUser) throw new Error('admin auth user not found in TEST DB');
  await supabaseAdmin
    .from('profiles')
    .upsert({id: adminUser.id, email: adminUser.email, full_name: 'Test Admin', role: 'admin'}, {onConflict: 'id'});
  return adminUser.id;
}

async function profileIdByName(supabaseAdmin, fullName) {
  const {data} = await supabaseAdmin.from('profiles').select('id').ilike('full_name', fullName).limit(1);
  if (!data || data.length === 0) throw new Error(`profile "${fullName}" not found in TEST DB`);
  return data[0].id;
}

async function seedOpenTask(supabaseAdmin, {id, title, assigneeId, createdById}) {
  const {error} = await supabaseAdmin.from('task_instances').insert({
    id,
    assignee_profile_id: assigneeId,
    due_date: '2026-06-15',
    title,
    description: 'Activity Phase 1 spec seed',
    submission_source: 'admin_manual',
    status: 'open',
    from_recurring_template: false,
    created_by_profile_id: createdById,
    client_submission_id: `csid-act-${id}`,
  });
  if (error) throw new Error(`seedOpenTask(${id}): ${error.message}`);
}

test.describe('Activity Phase 1 — comments, mentions, system events', () => {
  test('actor name renders from profiles.full_name — not the "User" placeholder', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    await seedOpenTask(supabaseAdmin, {
      id: 'tic-act-actor',
      title: 'Actor-name task',
      assigneeId: adminId,
      createdById: adminId,
    });

    await page.goto('/tasks');
    const row = page.locator('[data-task-row="tic-act-actor"]');
    await expect(row).toBeVisible();
    await row.locator('[data-activity-compact-chip="1"]').click();
    const modal = page.locator('[data-activity-modal="1"]');
    await modal.locator('[data-mention-textarea="1"]').fill('actor-name spec body');
    await modal.locator('[data-activity-post-button="1"]').click();
    const firstRow = modal.locator('[data-activity-event-row]').first();
    await expect(firstRow).toBeVisible({timeout: 5_000});

    const actorEl = firstRow.locator('[data-activity-event-actor]').first();
    await expect(actorEl).toBeVisible();
    // Resolved server-side via the profiles join. The seed gave the admin
    // profile full_name='Test Admin' — that's what we expect on screen.
    await expect(actorEl).toHaveText('Test Admin');
    await expect(actorEl).not.toHaveText('User');
  });

  test('post_activity_comment rejects fake task ids (existence check in resolver)', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    await seedOpenTask(supabaseAdmin, {
      id: 'tic-act-real',
      title: 'Real task',
      assigneeId: adminId,
      createdById: adminId,
    });

    // The rejection + acceptance both happen server-side via the SECDEF
    // resolver. We drive the RPC from inside the page's authenticated
    // context so auth.uid() resolves to the admin and the resolver runs
    // as the real caller.
    await page.goto('/tasks');

    // Fake task id → not permitted (existence check in _activity_can_read).
    const rejection = await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      const mod = await import('/src/lib/supabase.js');
      const result = await mod.sb.rpc('post_activity_comment', {
        p_entity_type: 'task.instance',
        p_entity_id: 'tic-does-not-exist',
        p_body: 'should fail',
        p_entity_label: null,
        p_mentions: [],
      });
      return {ok: !result.error, message: result.error ? result.error.message : null};
    });
    expect(rejection.ok).toBe(false);
    expect(rejection.message).toMatch(/not permitted/);

    // Real task id → succeeds.
    const success = await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      const mod = await import('/src/lib/supabase.js');
      const result = await mod.sb.rpc('post_activity_comment', {
        p_entity_type: 'task.instance',
        p_entity_id: 'tic-act-real',
        p_body: 'should succeed',
        p_entity_label: 'Real task',
        p_mentions: [],
      });
      return {ok: !result.error, error: result.error ? result.error.message : null, data: result.data};
    });
    expect(success.ok).toBe(true);
    expect(success.data?.ok).toBe(true);
  });

  test('admin posts a plain comment on a task and sees it in the chip + modal', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    await seedOpenTask(supabaseAdmin, {
      id: 'tic-act-plain',
      title: 'Plain comment task',
      assigneeId: adminId,
      createdById: adminId,
    });

    await page.goto('/tasks');

    // Compact chip is in the row's action group. Initial count is 0 (empty body).
    const row = page.locator('[data-task-row="tic-act-plain"]');
    await expect(row).toBeVisible();
    const chip = row.locator('[data-activity-compact-chip="1"]');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('data-activity-count', '0');

    // Click the chip → ActivityModal opens with the full panel.
    await chip.click();
    const modal = page.locator('[data-activity-modal="1"]');
    await expect(modal).toBeVisible();
    const panel = modal.locator('[data-activity-panel="1"][data-activity-mode="full"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-activity-empty="1"]')).toBeVisible();

    // Post a plain comment.
    await panel.locator('[data-mention-textarea="1"]').fill('Looks good to me.');
    await panel.locator('[data-activity-post-button="1"]').click();

    // Wait for the row to appear + verify count + body.
    await expect(panel.locator('[data-activity-event-row]').first()).toBeVisible({timeout: 5_000});
    await expect(panel.locator('[data-activity-event-type="comment.posted"]').first()).toBeVisible();
    await expect(panel).toContainText('Looks good to me.');

    // Close the modal and check the row chip count bumped to 1.
    await modal.locator('[data-activity-modal-close="1"]').click();
    await expect(modal).toHaveCount(0);
    // The chip lazy-loads count on mount; it should re-render after the
    // ACTIVITY_CHANGE_EVENT fired by postActivityComment.
    await expect(chip).toHaveAttribute('data-activity-count', '1', {timeout: 5_000});
  });

  test('@mention creates a notification for the recipient (not the actor)', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    const makId = await profileIdByName(supabaseAdmin, 'Mak');
    await seedOpenTask(supabaseAdmin, {
      id: 'tic-act-mention',
      title: 'Mention target task',
      assigneeId: makId,
      createdById: adminId,
    });

    await page.goto('/tasks');
    // The task is assigned to Mak, so it sits under the collapsed
    // "All other open tasks → Mak" group. Expand the group first so
    // the row's data-task-row attribute is reachable.
    await page.locator(`[data-tasks-group="${makId}"] button`).first().click();
    const row = page.locator('[data-task-row="tic-act-mention"]');
    await expect(row).toBeVisible();
    await row.locator('[data-activity-compact-chip="1"]').click();
    const modal = page.locator('[data-activity-modal="1"]');
    await expect(modal).toBeVisible();

    // Mig 060 contract: visible body is plain text — uuid never appears
    // there. p_mentions[] is authoritative for who gets notified. Drive
    // the picker UI so the test also covers MentionTextarea's insert
    // behavior.
    const textarea = modal.locator('[data-mention-textarea="1"]');
    await textarea.fill('Heads up ');
    await textarea.press('End');
    await textarea.type('@Mak');
    // Popover should open; pick Mak.
    const picker = modal.locator('[data-mention-picker="1"]');
    await expect(picker).toBeVisible({timeout: 2_000});
    await picker.locator(`[data-mention-picker-item="${makId}"]`).click();
    // Verify the textarea now reads plain "@Mak" with NO uuid leak.
    await expect.poll(async () => textarea.inputValue()).toMatch(/^Heads up @Mak\s*$/);
    expect(await textarea.inputValue()).not.toMatch(/profile:/);
    expect(await textarea.inputValue()).not.toMatch(/\[Mak\]/);
    await textarea.type('— please review.');
    await modal.locator('[data-activity-post-button="1"]').click();
    await expect(modal.locator('[data-activity-event-row]').first()).toBeVisible({timeout: 5_000});

    // Verify the activity_event row exists with the mention recorded.
    const {data: events} = await supabaseAdmin
      .from('activity_events')
      .select('id, entity_type, entity_id, event_type, body, actor_profile_id')
      .eq('entity_type', 'task.instance')
      .eq('entity_id', 'tic-act-mention')
      .order('created_at', {ascending: false})
      .limit(1);
    expect(events?.length).toBe(1);
    expect(events[0].event_type).toBe('comment.posted');
    expect(events[0].actor_profile_id).toBe(adminId);

    const eventId = events[0].id;
    const {data: mentions} = await supabaseAdmin
      .from('activity_mentions')
      .select('mentioned_profile_id')
      .eq('event_id', eventId);
    expect(mentions?.length).toBe(1);
    expect(mentions[0].mentioned_profile_id).toBe(makId);

    // Notification for Mak (recipient) exists.
    const {data: notifs} = await supabaseAdmin
      .from('notifications')
      .select('id, recipient_profile_id, actor_profile_id, type, activity_event_id, task_instance_id, title')
      .eq('activity_event_id', eventId);
    expect(notifs?.length).toBe(1);
    expect(notifs[0].recipient_profile_id).toBe(makId);
    expect(notifs[0].actor_profile_id).toBe(adminId);
    expect(notifs[0].type).toBe('mention');
    expect(notifs[0].task_instance_id).toBe('tic-act-mention'); // Phase 1 shortcut
    expect(notifs[0].title).toMatch(/mentioned you on /);

    // Posted body must be plain "@Mak" — no token leak server-side.
    expect(events[0].body).toMatch(/Heads up @Mak/);
    expect(events[0].body).not.toMatch(/profile:/);
    expect(events[0].body).not.toMatch(/\[Mak\]/);

    // Rendered chip must NOT expose the uuid in the DOM. The chip
    // carries data-mention-profile-id, but the visible text is "@Mak".
    const renderedRow = modal.locator('[data-activity-event-row]').first();
    const renderedText = (await renderedRow.locator('span').allInnerTexts()).join(' ');
    expect(renderedText).toMatch(/@Mak/);
    expect(renderedText).not.toMatch(makId);
    expect(renderedText).not.toMatch(/profile:/);
  });

  test('self-mention records the mention row but skips the notification', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    await seedOpenTask(supabaseAdmin, {
      id: 'tic-act-self',
      title: 'Self-mention task',
      assigneeId: adminId,
      createdById: adminId,
    });

    await page.goto('/tasks');
    const row = page.locator('[data-task-row="tic-act-self"]');
    await row.locator('[data-activity-compact-chip="1"]').click();
    const modal = page.locator('[data-activity-modal="1"]');
    await expect(modal).toBeVisible();

    // Drive picker for "Test Admin" (the seeded full_name).
    const textarea = modal.locator('[data-mention-textarea="1"]');
    await textarea.fill('Note to self ');
    await textarea.press('End');
    await textarea.type('@Test');
    const picker = modal.locator('[data-mention-picker="1"]');
    await expect(picker).toBeVisible({timeout: 2_000});
    await picker.locator(`[data-mention-picker-item="${adminId}"]`).click();
    expect(await textarea.inputValue()).toMatch(/Note to self @Test Admin/);
    expect(await textarea.inputValue()).not.toMatch(/profile:/);
    await modal.locator('[data-activity-post-button="1"]').click();
    await expect(modal.locator('[data-activity-event-row]').first()).toBeVisible({timeout: 5_000});

    const {data: events} = await supabaseAdmin
      .from('activity_events')
      .select('id')
      .eq('entity_id', 'tic-act-self')
      .order('created_at', {ascending: false})
      .limit(1);
    const eventId = events[0].id;
    const {data: mentions} = await supabaseAdmin
      .from('activity_mentions')
      .select('mentioned_profile_id')
      .eq('event_id', eventId);
    expect(mentions?.length).toBe(1);
    expect(mentions[0].mentioned_profile_id).toBe(adminId);

    // No notification for self.
    const {data: notifs} = await supabaseAdmin.from('notifications').select('id').eq('activity_event_id', eventId);
    expect(notifs?.length).toBe(0);
  });

  test('completing a task auto-fires task.completed event via trigger', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    await seedOpenTask(supabaseAdmin, {
      id: 'tic-act-trigger',
      title: 'Trigger task',
      assigneeId: adminId,
      createdById: adminId,
    });

    await page.goto('/tasks');
    const row = page.locator('[data-task-row="tic-act-trigger"]');
    await expect(row).toBeVisible();
    await row.locator('[data-task-complete-button="1"]').click();
    const completeModal = page.locator('[data-complete-task-modal="1"]');
    await expect(completeModal).toBeVisible();
    await completeModal.locator('[data-complete-task-field="note"]').fill('Done as part of the trigger spec.');
    await completeModal.locator('[data-complete-task-save="1"]').click();

    // Wait for the modal to close after success.
    await expect(completeModal).toHaveCount(0, {timeout: 10_000});

    // task.completed event landed for this instance.
    const {data: events} = await supabaseAdmin
      .from('activity_events')
      .select('id, event_type, body, actor_profile_id')
      .eq('entity_id', 'tic-act-trigger')
      .order('created_at', {ascending: false});
    const trig = events?.find((e) => e.event_type === 'task.completed');
    expect(trig).toBeTruthy();
    expect(trig.actor_profile_id).toBe(adminId);
    expect(trig.body).toContain('trigger spec');
  });

  test('author soft-delete leaves a placeholder row + hides the body', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    await seedOpenTask(supabaseAdmin, {
      id: 'tic-act-del',
      title: 'Delete spec task',
      assigneeId: adminId,
      createdById: adminId,
    });

    await page.goto('/tasks');
    const row = page.locator('[data-task-row="tic-act-del"]');
    await row.locator('[data-activity-compact-chip="1"]').click();
    const modal = page.locator('[data-activity-modal="1"]');
    await modal.locator('[data-mention-textarea="1"]').fill('Will be deleted shortly.');
    await modal.locator('[data-activity-post-button="1"]').click();

    const firstRow = modal.locator('[data-activity-event-row]').first();
    await expect(firstRow).toBeVisible({timeout: 5_000});
    const eventId = await firstRow.getAttribute('data-activity-event-row');
    expect(eventId).toBeTruthy();

    // Author delete button is visible for the caller.
    const delBtn = modal.locator(`[data-activity-delete-button="${eventId}"]`);
    await expect(delBtn).toBeVisible();
    await delBtn.click();

    // Soft-deleted row keeps a placeholder + the body is gone.
    await expect(firstRow).toHaveAttribute('data-activity-deleted', '1', {timeout: 5_000});
    await expect(modal).toContainText('(comment deleted)');
    await expect(modal).not.toContainText('Will be deleted shortly.');
  });
});
