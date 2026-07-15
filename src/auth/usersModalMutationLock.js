// Deterministic single-flight mutation lock for UsersModal.
//
// UsersModal previously tracked in-flight mutations with a single
// `userActionId` useState value. React state updates are asynchronous, so two
// triggers in the same frame could both observe the idle state, and a stale
// async `finally` could clear a newer operation's lock, re-enabling controls
// while an Edge/RPC call was still in flight.
//
// This lock closes both gaps:
// - begin() checks and claims a plain closure variable synchronously, so a
//   second mutation is refused before React re-renders.
// - Tokens are compared by object identity in release(), so a stale finally
//   can never release a lock it does not own (no timestamp/string collisions).
export function createUserMutationLock() {
  let current = null;
  let seq = 0;
  return {
    // Claims the lock for one mutation. Returns the token to release with, or
    // null when another mutation already holds the lock (caller must bail out
    // without touching notices or list state).
    begin(kind, targetId = null) {
      if (current !== null) return null;
      seq += 1;
      current = {kind, targetId, seq};
      return current;
    },
    // Releases only when `token` is the exact object currently holding the
    // lock. Returns whether the lock was actually released so the component
    // can keep its disabled-state in step.
    release(token) {
      if (token == null || token !== current) return false;
      current = null;
      return true;
    },
    owns(token) {
      return token != null && token === current;
    },
    isLocked() {
      return current !== null;
    },
    active() {
      return current;
    },
  };
}
