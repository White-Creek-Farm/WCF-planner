// Direction (Steer Q&A) autosave helpers for the admin Newsletter editor.
//
// The "Your direction" textareas autosave with a debounce so typed direction is
// never lost — the reported data-loss bug was that toggling facts / re-gathering
// / a photo action refreshed the issue and clobbered unsaved text. These pure
// helpers back the component's dirty-tracking: they decide whether the local
// intake differs from what the server has (so autosave only fires on real
// changes, and a background refresh never overwrites unsaved edits) and map the
// current save state to a compact label/tone. Kept pure + in src/lib so they are
// unit-testable under the node vitest environment.

// Debounce window after typing stops before the autosave fires (700–1000ms).
export const DIRECTION_DEBOUNCE_MS = 800;

// Canonical comparison form for an intake answers map: coerces values to strings,
// drops empty/whitespace-only answers (so {} equals {highlights: '   '}), and
// sorts by key — so equality reflects what the server would actually store and a
// server `{}` never reads as "different" from empty textareas.
export function canonicalizeIntake(intake) {
  const entries = [];
  if (intake && typeof intake === 'object') {
    for (const key of Object.keys(intake)) {
      const raw = intake[key];
      const value = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
      if (value.trim() !== '') entries.push([key, value]);
    }
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries;
}

// True when two intake maps hold the same non-empty answers.
export function intakeEqual(a, b) {
  return JSON.stringify(canonicalizeIntake(a)) === JSON.stringify(canonicalizeIntake(b));
}

// True when local direction has unsaved edits vs the last server-known intake.
export function isDirectionDirty(local, lastSaved) {
  return !intakeEqual(local, lastSaved);
}

// The compact save-state label + tone shown next to the Steer section header so
// the admin can see typing is being saved without clicking anything.
export function directionSaveLabel(state) {
  switch (state) {
    case 'saving':
      return {text: 'Saving…', tone: 'muted'};
    case 'saved':
      return {text: 'Saved', tone: 'ok'};
    case 'unsaved':
      return {text: 'Unsaved…', tone: 'warn'};
    case 'error':
      return {text: 'Save failed — retry', tone: 'danger'};
    default:
      return {text: 'Autosaves as you type', tone: 'faint'};
  }
}
