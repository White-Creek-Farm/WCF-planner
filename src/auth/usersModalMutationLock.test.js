import {describe, expect, it} from 'vitest';
import {createUserMutationLock} from './usersModalMutationLock.js';

// Mirrors UsersModal's mutation contract exactly: claim the lock before
// touching notices or state, bail out silently when refused, and release in
// finally with the operation's own token.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

async function runMutation(lock, kind, targetId, work, journal, notices) {
  const token = lock.begin(kind, targetId);
  if (!token) {
    journal.push(`${kind}:refused`);
    return;
  }
  journal.push(`${kind}:started`);
  notices.err = '';
  notices.msg = '';
  try {
    await work.promise;
    notices.msg = `${kind}:done`;
  } catch (e) {
    notices.err = `${kind}:${e.message}`;
  } finally {
    journal.push(lock.release(token) ? `${kind}:released` : `${kind}:stale-release-ignored`);
  }
}

describe('createUserMutationLock', () => {
  it('refuses a second mutation synchronously, before any re-render', () => {
    const lock = createUserMutationLock();
    const first = lock.begin('delete', 'user-a');
    expect(first).not.toBeNull();
    // Same-tick double click: no await, no state update has happened yet.
    expect(lock.begin('delete', 'user-a')).toBeNull();
    expect(lock.begin('role', 'user-b')).toBeNull();
    expect(lock.isLocked()).toBe(true);
    expect(lock.active()).toBe(first);
  });

  it('releases only for the exact token that holds the lock', () => {
    const lock = createUserMutationLock();
    const first = lock.begin('name', 'user-a');
    expect(lock.release(null)).toBe(false);
    expect(lock.release(undefined)).toBe(false);
    expect(lock.release({kind: 'name', targetId: 'user-a', seq: first.seq})).toBe(false);
    expect(lock.isLocked()).toBe(true);
    expect(lock.release(first)).toBe(true);
    expect(lock.isLocked()).toBe(false);
    // A stale double-release never clears someone else's lock.
    const second = lock.begin('name', 'user-a');
    expect(lock.release(first)).toBe(false);
    expect(lock.owns(second)).toBe(true);
    expect(lock.release(second)).toBe(true);
  });

  it('a stale finally cannot clear a newer identical-looking operation', () => {
    const lock = createUserMutationLock();
    // Same kind, same target, back to back — the failure shape a
    // timestamp/string token could not distinguish.
    const first = lock.begin('password_reset', 'user-a');
    expect(lock.release(first)).toBe(true);
    const retry = lock.begin('password_reset', 'user-a');
    expect(retry).not.toBe(first);
    expect(lock.release(first)).toBe(false);
    expect(lock.isLocked()).toBe(true);
    expect(lock.active()).toBe(retry);
  });

  it('keeps controls locked across delayed overlapping operations', async () => {
    const lock = createUserMutationLock();
    const journal = [];
    const notices = {err: '', msg: ''};

    const slowDelete = deferred();
    const running = runMutation(lock, 'delete', 'user-a', slowDelete, journal, notices);

    // While the Edge call is in flight, every other trigger is refused and
    // must not touch the first operation's notices.
    notices.msg = 'delete-in-flight-notice';
    const overlappingRole = deferred();
    await runMutation(lock, 'role', 'user-b', overlappingRole, journal, notices);
    const overlappingCreate = deferred();
    await runMutation(lock, 'create', null, overlappingCreate, journal, notices);
    expect(journal).toEqual(['delete:started', 'role:refused', 'create:refused']);
    expect(notices.msg).toBe('delete-in-flight-notice');
    expect(lock.isLocked()).toBe(true);

    // The delayed response completes: the lock releases exactly once.
    slowDelete.resolve();
    await running;
    expect(journal).toEqual(['delete:started', 'role:refused', 'create:refused', 'delete:released']);
    expect(notices.msg).toBe('delete:done');
    expect(lock.isLocked()).toBe(false);

    // The next operation starts cleanly after release.
    const followUp = deferred();
    followUp.resolve();
    await runMutation(lock, 'program_access', 'user-b', followUp, journal, notices);
    expect(journal.at(-2)).toBe('program_access:started');
    expect(journal.at(-1)).toBe('program_access:released');
  });

  it('a failing mutation still releases and a late stale callback is ignored', async () => {
    const lock = createUserMutationLock();
    const journal = [];
    const notices = {err: '', msg: ''};

    const failing = deferred();
    const running = runMutation(lock, 'delete', 'user-a', failing, journal, notices);
    const staleToken = lock.active();
    failing.reject(new Error('edge 409'));
    await running;
    expect(journal).toEqual(['delete:started', 'delete:released']);
    expect(notices.err).toBe('delete:edge 409');
    expect(lock.isLocked()).toBe(false);

    // A newer operation takes the lock; the old operation's token surfaces
    // again (double finally / delayed timeout) and must be ignored.
    const next = lock.begin('delete', 'user-a');
    expect(lock.release(staleToken)).toBe(false);
    expect(lock.active()).toBe(next);
    expect(lock.isLocked()).toBe(true);
  });
});
