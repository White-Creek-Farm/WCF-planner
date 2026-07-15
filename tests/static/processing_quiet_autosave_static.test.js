import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static guards for the Processing quiet-autosave lane (Processor select +
// subtask Assignee select). Both are DEDICATED no-reload paths matching the
// shipped checklist-toggle contract:
//   • no generic runMutation (which sets the drawer's visible busy/loading
//     path), no visible load(), no notifyRef/onChanged (the schedule's full
//     load) — the drawer stays mounted, scrolled, and stable;
//   • optimistic patch first, direct RPC wrapper, then silentRefreshRecord so
//     the server-owned completion_blockers stay authoritative;
//   • Processor publishes the CONFIRMED value to the parent through the
//     narrow onProcessorChanged row patch; Assignee publishes nothing
//     (assignment never changes schedule summary counts);
//   • a failure rolls back the exact prior value with the existing inline
//     error treatment, and the per-field/per-subtask pending lock is always
//     released;
//   • withPendingSubtaskOverrides re-applies pending done AND pending
//     assignee AND pending processor values over any racing refetch.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const drawer = read('src/processing/ProcessingDrawer.jsx');
const view = read('src/processing/ProcessingCalendarView.jsx');

function slice(src, startMarker, endMarker, label) {
  const start = src.indexOf(startMarker);
  expect(start, `${label}: start marker "${startMarker}" present`).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start + startMarker.length);
  expect(end, `${label}: end marker "${endMarker}" present`).toBeGreaterThan(start);
  return src.slice(start, end);
}

const processorBody = slice(
  drawer,
  'async function saveProcessorSelect(value)',
  'function saveCustomerSelect(',
  'saveProcessorSelect',
);
const customerBody = slice(
  drawer,
  'async function saveCustomerSelect(value)',
  'function saveMilestoneTitle()',
  'saveCustomerSelect',
);
const assigneeBody = slice(
  drawer,
  'async function reassignSubtask(st, profileId)',
  'function deleteSubtask(st)',
  'reassignSubtask',
);
const overridesBody = slice(
  drawer,
  'const withPendingSubtaskOverrides',
  'const load = useCallback',
  'withPendingSubtaskOverrides',
);

describe('drawer — Processor select is a dedicated no-reload autosave path', () => {
  it('never routes through runMutation, load(), or notifyRef/onChanged', () => {
    expect(processorBody).not.toContain('runMutation');
    expect(processorBody).not.toContain('notifyRef');
    expect(processorBody).not.toContain('load()');
    expect(processorBody).not.toContain('onChanged');
  });

  it('calls the setProcessingProcessor RPC wrapper directly', () => {
    expect(processorBody).toContain('await setProcessingProcessor(sb, rid, next);');
  });

  it('optimistically patches data.record.processor before the RPC', () => {
    const optimisticIdx = processorBody.indexOf('processor: next');
    const rpcIdx = processorBody.indexOf('await setProcessingProcessor');
    expect(optimisticIdx).toBeGreaterThan(-1);
    expect(rpcIdx).toBeGreaterThan(optimisticIdx);
  });

  it('silently reconciles the record after success (server-owned blockers refresh quietly)', () => {
    expect(processorBody).toContain('await silentRefreshRecord()');
    expect(processorBody).toContain('tolerated');
  });

  it('publishes the CONFIRMED value through the narrow parent callback only on success', () => {
    expect(processorBody).toContain('processorChangedRef.current(rid, next)');
    // The failure path never patches the parent row.
    const catchIdx = processorBody.indexOf('} catch (e) {');
    expect(catchIdx).toBeGreaterThan(-1);
    expect(processorBody.slice(catchIdx)).not.toContain('processorChangedRef');
  });

  it('rolls the select back to the prior value on RPC failure with the inline error treatment', () => {
    expect(processorBody).toMatch(/\{\.\.\.d, record: \{\.\.\.d\.record, processor: prior\}\}/);
    expect(processorBody).toContain('isProcessingValidationError(e)');
    expect(processorBody).toContain('friendlyProcessingError(e)');
    expect(processorBody).toContain('Something went wrong. Please retry.');
  });

  it('a stale continuation cannot patch another record and cannot clobber a newer payload', () => {
    // Rollback only applies while the drawer still shows this record AND the
    // displayed value is still our own optimism.
    expect(processorBody).toContain('recordIdRef.current === rid');
    expect(processorBody).toMatch(/d\.record\.id === rid && \(d\.record\.processor \|\| null\) === next/);
  });

  it('uses a Processor-specific in-flight guard and always releases it', () => {
    expect(processorBody).toMatch(/if \(pendingProcessorRef\.current\) return;/);
    expect(processorBody).not.toContain('setBusy(');
    expect(processorBody).toMatch(
      /finally \{[\s\S]*pendingProcessorRef\.current = null;[\s\S]*setProcessorPending\(false\);/,
    );
    // The render disables ONLY the Processor select for its own pending write.
    expect(drawer).toContain('disabled={busy || processorPending}');
  });
});

describe('drawer — subtask Assignee select is a dedicated no-reload autosave path', () => {
  it('never routes through runMutation, load(), or notifyRef/onChanged', () => {
    expect(assigneeBody).not.toContain('runMutation');
    expect(assigneeBody).not.toContain('notifyRef');
    expect(assigneeBody).not.toContain('load()');
    expect(assigneeBody).not.toContain('onChanged');
  });

  it('calls the updateProcessingSubtask RPC wrapper directly (assign vs explicit clear)', () => {
    expect(assigneeBody).toContain('await updateProcessingSubtask(');
    expect(assigneeBody).toContain('{id: st.id, assigneeProfileId: next}');
    expect(assigneeBody).toContain('{id: st.id, clearAssignee: true}');
  });

  it('optimistically patches ONLY the selected subtask and clears imported assignee text', () => {
    // Assigning a profile mirrors the server: profile id set, text nulled.
    expect(assigneeBody).toContain('const optimistic = {assignee_profile_id: next, assignee: null};');
    expect(assigneeBody).toMatch(
      /subtasks: d\.subtasks\.map\(\(s\) => \(s\.id === st\.id \? \{\.\.\.s, \.\.\.optimistic\}/,
    );
  });

  it('silently reconciles after success and never publishes a parent patch', () => {
    expect(assigneeBody).toContain('await silentRefreshRecord()');
    expect(assigneeBody).not.toContain('countsChangedRef');
    expect(assigneeBody).not.toContain('processorChangedRef');
  });

  it('restores the complete prior assignment (profile id AND imported text) on failure', () => {
    expect(assigneeBody).toContain(
      'const prior = {assignee_profile_id: st.assignee_profile_id ?? null, assignee: st.assignee ?? null};',
    );
    expect(assigneeBody).toMatch(/subtasks: d\.subtasks\.map\(\(s\) => \(s\.id === st\.id \? \{\.\.\.s, \.\.\.prior\}/);
    expect(assigneeBody).toContain('isProcessingValidationError(e)');
    expect(assigneeBody).toContain('friendlyProcessingError(e)');
  });

  it('a stale continuation cannot roll back a different record after drawer navigation', () => {
    expect(assigneeBody).toContain('recordIdRef.current === rid');
  });

  it('uses a per-subtask assignment lock and always releases it', () => {
    expect(assigneeBody).toMatch(/if \(pendingAssigneesRef\.current\.has\(st\.id\)\) return;/);
    expect(assigneeBody).not.toContain('setBusy(');
    expect(assigneeBody).toMatch(/finally \{[\s\S]*pendingAssigneesRef\.current\.delete\(st\.id\);/);
    // The render disables ONLY that subtask's Assignee select while pending.
    expect(drawer).toContain('disabled={busy || pendingAssigneeIds.has(st.id)}');
  });

  it('no client-side notification writes — assignment notifications stay server-owned', () => {
    expect(assigneeBody).not.toContain('notification');
    expect(drawer).not.toMatch(/\.from\(['"]notifications['"]\)/);
  });
});

describe('drawer — Customer select is a dedicated no-reload autosave path', () => {
  it('never routes through runMutation, load(), or notifyRef/onChanged', () => {
    expect(customerBody).not.toContain('runMutation');
    expect(customerBody).not.toContain('notifyRef');
    expect(customerBody).not.toContain('load()');
    expect(customerBody).not.toContain('onChanged');
  });

  it('preserves the legacy-multiple sentinel and same-value no-ops', () => {
    expect(customerBody).toContain('if (value === LEGACY_MULTI_CUSTOMER) return;');
    expect(customerBody).toContain("if (!customerLegacyMulti && (customerCurrent || '') === (value || '')) return;");
  });

  it('optimistically patches record.customer as [] / [value] before the direct RPC', () => {
    expect(customerBody).toContain('const next = value ? [value] : [];');
    const optimisticIdx = customerBody.indexOf('customer: next');
    const rpcIdx = customerBody.indexOf('await setProcessingCustomer(sb, rid, next);');
    expect(optimisticIdx).toBeGreaterThan(-1);
    expect(rpcIdx).toBeGreaterThan(optimisticIdx);
  });

  it('silently reconciles after success and publishes the CONFIRMED value through the narrow parent callback only', () => {
    expect(customerBody).toContain('await silentRefreshRecord()');
    expect(customerBody).toContain('customerChangedRef.current(rid, next)');
    const catchIdx = customerBody.indexOf('} catch (e) {');
    expect(catchIdx).toBeGreaterThan(-1);
    expect(customerBody.slice(catchIdx)).not.toContain('customerChangedRef');
  });

  it('rolls back only its own still-displayed optimistic value on failure, with the inline error', () => {
    expect(customerBody).toContain('pendingCustomerRef.current = null;');
    expect(customerBody).toContain('recordIdRef.current === rid');
    expect(customerBody).toMatch(/canonCustomer\(d\.record\.customer\) === canonCustomer\(next\)/);
    expect(customerBody).toMatch(/\{\.\.\.d, record: \{\.\.\.d\.record, customer: prior\}\}/);
    expect(customerBody).toContain('isProcessingValidationError(e)');
    expect(customerBody).toContain('friendlyProcessingError(e)');
  });

  it('uses a Customer-specific in-flight guard, disables only the Customer select, and always releases the lock', () => {
    expect(customerBody).toMatch(/if \(pendingCustomerRef\.current\) return;/);
    expect(customerBody).not.toContain('setBusy(');
    expect(customerBody).toMatch(
      /finally \{[\s\S]*pendingCustomerRef\.current = null;[\s\S]*setCustomerPending\(false\);/,
    );
    expect(drawer).toContain('disabled={busy || customerPending}');
  });
});

describe('drawer — pending overrides survive racing silent refetches', () => {
  it('withPendingSubtaskOverrides re-applies pending done AND assignee AND processor AND customer values', () => {
    expect(overridesBody).toMatch(
      /if \(pendingDone\.has\(s\.id\)\) next = \{\.\.\.next, done: pendingDone\.get\(s\.id\)\};/,
    );
    expect(overridesBody).toMatch(
      /next = \{\.\.\.next, assignee_profile_id: assign\.assignee_profile_id, assignee: assign\.assignee\};/,
    );
    expect(overridesBody).toMatch(
      /out = \{\.\.\.out, record: \{\.\.\.out\.record, processor: pendingProcessor\.value\}\};/,
    );
    expect(overridesBody).toMatch(
      /out = \{\.\.\.out, record: \{\.\.\.out\.record, customer: pendingCustomer\.value\}\};/,
    );
    // Both fetch paths route through the overrides, so a refetch that raced
    // any unresolved write cannot flicker a control back.
    expect(drawer).toMatch(
      /const d = await getProcessingRecord\(sb, recordId\);[\s\S]{0,200}setData\(withPendingSubtaskOverrides\(d\)\)/,
    );
  });
});

describe('schedule — narrow row patches instead of a page reload', () => {
  it('the view passes both narrow callbacks and keeps the full load for generic mutations', () => {
    expect(view).toContain('onProcessorChanged={patchRecordProcessor}');
    expect(view).toContain('onCustomerChanged={patchRecordCustomer}');
    expect(view).toContain('onChanged={load}');
  });

  it('patchRecordProcessor patches only the matching row (with rebuilt search) and never calls load/setLoading', () => {
    const body = slice(view, 'const patchRecordProcessor', 'const patchRecordCustomer', 'patchRecordProcessor');
    expect(body).toMatch(/setRecords\(\(rows\) =>/);
    expect(body).toContain('if (r.id !== recordId) return r;');
    expect(body).toContain('processor: processor || null');
    expect(body).toContain('search_text: rebuildRowSearchText(next)');
    expect(body).not.toMatch(/\bload\(\)/);
    expect(body).not.toContain('setLoading');
  });

  it('patchRecordCustomer patches only the matching row (with rebuilt search) and never calls load/setLoading', () => {
    const body = slice(view, 'const patchRecordCustomer', '// Drawer-open deep links', 'patchRecordCustomer');
    expect(body).toMatch(/setRecords\(\(rows\) =>/);
    expect(body).toContain('if (r.id !== recordId) return r;');
    expect(body).toContain('customer: Array.isArray(customer) ? customer : []');
    expect(body).toContain('search_text: rebuildRowSearchText(next)');
    expect(body).not.toMatch(/\bload\(\)/);
    expect(body).not.toContain('setLoading');
  });

  it('rebuildRowSearchText mirrors the server search recipe from the row live fields', () => {
    const body = slice(view, 'function rebuildRowSearchText(r)', 'function num(', 'rebuildRowSearchText');
    expect(body).toContain('r.title');
    expect(body).toContain('r.processor');
    expect(body).toContain('Array.isArray(r.customer) ? r.customer : []');
    expect(body).toContain('r.source && r.source.batch_name');
    expect(body).toContain('trip ${r.trip_ordinal ?? 0}');
    expect(body).toContain('r.source && r.source.animal_tags');
    expect(body).toContain('.toLowerCase()');
  });
});
