import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static guards for sub-lane 4 of the Processing finish-out: server-backed
// Customer/Processor selector option lists (mig 162) + admin editor + drawer /
// Add-Milestone reading from settings (not hardcoded constants), preserving
// legacy/off-list values.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mig162 = read('supabase-migrations/162_processing_option_lists.sql');
const api = read('src/lib/processingApi.js');
const optionsModal = read('src/processing/ProcessingOptionsModal.jsx');
const drawer = read('src/processing/ProcessingDrawer.jsx');
const addMilestone = read('src/processing/AddMilestoneModal.jsx');
const view = read('src/processing/ProcessingCalendarView.jsx');
const templatesModal = read('src/processing/ProcessingTemplatesModal.jsx');

describe('mig 162 — option lists on the settings singleton', () => {
  it('adds customer_options and an admin-gated setter, without constraining stored values', () => {
    expect(mig162).toContain('ADD COLUMN IF NOT EXISTS customer_options');
    expect(mig162).toContain('CREATE OR REPLACE FUNCTION public.set_processing_option_list');
    expect(mig162).toContain('SECURITY DEFINER');
    expect(mig162).toMatch(/v_role <> 'admin'/);
    expect(mig162).toContain("p_kind NOT IN ('processor', 'customer')");
    expect(mig162).toContain("jsonb_typeof(COALESCE(p_options, '[]'::jsonb)) <> 'array'");
    expect(mig162).toContain(
      'GRANT EXECUTE ON FUNCTION public.set_processing_option_list(text, jsonb) TO authenticated',
    );
    // The lists drive widgets only — no CHECK / rewrite of stored record values.
    expect(mig162).not.toMatch(/ALTER TABLE public\.processing_records/);
    expect(mig162).not.toMatch(/ADD CONSTRAINT|CHECK \(processor|CHECK \(customer/);
    expect(mig162).not.toContain('UPDATE public.processing_records');
  });
});

describe('api wrapper', () => {
  it('exposes setProcessingOptionList calling the RPC', () => {
    expect(api).toContain('export async function setProcessingOptionList');
    expect(api).toContain("sb.rpc('set_processing_option_list'");
  });
});

describe('admin options editor — AUTOSAVE (UX lane)', () => {
  it('the editor autosaves both lists via the wrapper — the option Save/Saved button is gone', () => {
    expect(optionsModal).toContain('setProcessingOptionList(sb, kind, items)');
    expect(optionsModal).toContain('data-processing-option-add-input');
    expect(optionsModal).not.toContain('data-processing-option-save');
    expect(optionsModal).not.toMatch(/'Save' : 'Saved'|Save<\/button>/);
    // The dead standalone modal wrapper (with its Done footer) is removed;
    // the editor renders only inside the Templates modal's Fields surface.
    expect(optionsModal).not.toContain('data-processing-options-modal');
    expect(optionsModal).not.toMatch(/export default function ProcessingOptionsModal/);
  });

  it('debounced autosave engine: 400-700ms debounce, single in-flight chain, skip-duplicate, id reconcile', () => {
    const debounce = optionsModal.match(/AUTOSAVE_DEBOUNCE_MS = (\d+)/);
    expect(debounce, 'AUTOSAVE_DEBOUNCE_MS constant').toBeTruthy();
    expect(Number(debounce[1])).toBeGreaterThanOrEqual(400);
    expect(Number(debounce[1])).toBeLessThanOrEqual(700);
    // Every mutation schedules the debounced save (add/rename/active/withdraw).
    expect((optionsModal.match(/scheduleAutosave\(\);/g) || []).length).toBeGreaterThanOrEqual(4);
    // One RPC max in flight; the loop re-serializes the newest list after each
    // save, so an edit during a request persists right after it.
    expect(optionsModal).toMatch(/if \(!engine\.chain\) \{/);
    expect(optionsModal).toMatch(/const snapshot = itemsRef\.current;/);
    // Skip-duplicate contract.
    expect(optionsModal).toMatch(/if \(key === engine\.lastSavedKey\)/);
    // Server-minted ids reconcile through client-only temp keys (never sent).
    expect(optionsModal).toContain('tempKey');
    expect(optionsModal).toMatch(/payloadFor[\s\S]{0,200}if \(o\.id != null\) out\.id = o\.id;/);
    // Blank labels never autosave (mig 175 raises); flush blocks instead.
    expect(optionsModal).toContain('hasBlankLabel');
    // Withdraw-during-flight converts to deactivation (stored ids survive).
    expect(optionsModal).toMatch(/active: false\}\);/);
  });

  it('persist chain suspends before any work and the flush loop is bounded (renderer live-lock regression)', () => {
    // Zombie-chain regression: an async chain that converged WITHOUT crossing
    // an await ran its finally (engine.chain = null) BEFORE the
    // `engine.chain = (async () => ...)()` assignment landed, so the
    // assignment resurrected the completed promise permanently. Every later
    // persist/flush call then returned that stale instant-'ok' without
    // re-reading items, and the surface-switch flush spun the main thread
    // forever without issuing its RPC (CI + local Templates freeze). The
    // chain must suspend FIRST so the assignment always precedes completion.
    expect(optionsModal).toMatch(/engine\.chain = \(async \(\) => \{[\s\S]{0,700}?await null;[\s\S]{0,400}?try \{/);
    // And the host-awaited flush is a bounded loop that degrades to the
    // failed-flush contract (host stays open, edits retained) instead of a
    // for(;;) spin if convergence ever breaks again.
    const flushBody = optionsModal.slice(
      optionsModal.indexOf('const flush = useCallback'),
      optionsModal.indexOf('}, [persistNow, onBlankBlocked, kind]);'),
    );
    expect(flushBody).not.toContain('for (;;)');
    expect(flushBody).toMatch(/for \(let pass = 0; pass < \d+; pass\+\+\)/);
    expect(flushBody).toMatch(/setSaveState\('error'\);\s*return false;/);
  });

  it('host flush contract: Templates modal awaits the flush on every exit path', () => {
    expect(optionsModal).toContain('registerFlush');
    expect(templatesModal).toContain('registerFlush={registerOptionsFlush}');
    // Close (X / footer / scrim / Escape) waits for the final save; a failed
    // flush keeps the modal open with the editor's inline error.
    expect(templatesModal).toMatch(/if \(await flushOptions\(\)\) onClose\(\);/);
    expect(templatesModal).toMatch(/onClick=\{requestClose\}/);
    // Inside the admin TemplatesEditor no exit path bypasses the flush; the
    // only raw onClose handlers left are the non-admin guard's (no editor).
    const editorBody = templatesModal.slice(templatesModal.indexOf('function TemplatesEditor'));
    expect(editorBody).not.toMatch(/onClick=\{onClose\}/);
    expect(templatesModal).toMatch(/e\.key === 'Escape'\) requestClose\(\);/);
    // Leaving the Fields surface (which unmounts the editor) is flush-guarded.
    expect(templatesModal).toMatch(/if \(activeSurface === 'fields' && !\(await flushOptions\(\)\)\) return;/);
    expect(templatesModal).toMatch(/onClick=\{\(\) => requestSurface\(opt\.key\)\}/);
    // Program switches flush too (editor stays mounted, so never blocking).
    expect(templatesModal).toMatch(/onClick=\{\(\) => requestProgram\(p\.key\)\}/);
    // The checklist's own Save template button remains on the Tasks surface.
    expect(templatesModal).toContain('data-processing-template-save');
    expect(templatesModal).toContain('Save template');
  });
});

describe('drawer + Add Milestone read from settings (not hardcoded)', () => {
  it('drawer renders TRUE SINGLE selects for Customer AND Processor from the option lists', () => {
    expect(drawer).toContain('customerOptions = []');
    expect(drawer).toContain('processorOptions = []');
    expect(drawer).toContain('data-processing-processor-select');
    expect(drawer).not.toContain('datalist');
    // UI-simplification lane: Customer chips are retired — a single select over
    // customer_options, matching the Processor control. Zero-or-one stored via
    // the existing array-backed column.
    expect(drawer).toContain('data-processing-customer-select');
    expect(drawer).not.toContain('data-processing-customer-chip');
    // Quiet-autosave lane: the dedicated no-reload path builds next = [] /
    // [value] and calls the RPC wrapper directly (full contract in
    // processing_quiet_autosave_static.test.js).
    expect(drawer).toContain('const next = value ? [value] : [];');
    expect(drawer).toContain('await setProcessingCustomer(sb, rid, next);');
    // legacy handling: off-list single value stays selectable; a stored MULTI
    // set surfaces as ONE sentinel option until deliberately replaced/cleared.
    expect(drawer).toMatch(/\(legacy\)/);
    expect(drawer).toContain('(legacy — multiple)');
    expect(drawer).toContain('LEGACY_MULTI_CUSTOMER');
    expect(drawer).toMatch(/if \(value === LEGACY_MULTI_CUSTOMER\) return/);
    expect(drawer).toContain('CUSTOMER_OPTIONS_FALLBACK');
  });

  it('Add Milestone uses settings options + TRUE selects for Processor and Customer', () => {
    expect(addMilestone).toContain('customerOptions = []');
    expect(addMilestone).toContain('processorOptions = []');
    expect(addMilestone).toMatch(/<select[\s\S]{0,400}data-processing-milestone-processor/);
    expect(addMilestone).toMatch(/<select[\s\S]{0,400}data-processing-milestone-customer/);
    expect(addMilestone).not.toContain('datalist');
    expect(addMilestone).not.toContain('toggleCustomer');
    // zero-or-one customer, stored through the existing array-backed column
    expect(addMilestone).toMatch(/customer: isBroiler && customer \? \[customer\] : \[\]/);
  });
});

describe('calendar + Templates wire the option lists through', () => {
  it('fetches settings for operational roles and passes options through to every consumer', () => {
    expect(view).toContain('refreshOptionLists');
    expect(view).toContain('setOptionLists');
    expect(view).toContain('customerOptions={optionLists.customer}');
    expect(view).toContain('processorOptions={optionLists.processor}');
    expect(view).toContain('onOptionsSaved={refreshOptionLists}');
    // The options editor moved INSIDE Templates (no separate Admin-page control).
    expect(view).not.toContain('<ProcessingOptionsModal');
    expect(templatesModal).toContain("{key: 'fields', label: 'Fields'}");
    expect(templatesModal).toContain('data-processing-template-surface={opt.key}');
    expect(templatesModal).toContain('data-processing-template-fields-panel="1"');
    expect(templatesModal).toContain('<ProcessingOptionsEditor');
    expect(templatesModal).toContain('onSaved={onOptionsSaved}');
  });
});
