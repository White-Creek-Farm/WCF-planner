// Tasks v2 T8 — Edit Due Date modal.
//
// Wraps update_task_instance_due_date (mig 053). The RPC handles auth +
// role + cap server-side; this modal mirrors the rules client-side so
// the user sees an immediate "limit reached" guard rather than a raw
// RPC raise.
//
// Regular users are capped at 2 edits via due_date_edit_count. Admin
// edits are unlimited and don't bump the regular cap. Same-date writes
// are no-ops at the RPC layer; we still let them through so the user
// sees a friendly idempotent confirmation rather than mysterious
// silence.
//
// History panel reads task_instance_due_date_edits via the existing
// loadDueDateEditHistory helper. Newest edit first; resolves
// edited_by_profile_id through the eligible-profiles map (Unknown user
// fallback for inactive/missing profiles).

import React from 'react';
import {loadDueDateEditHistory} from '../lib/tasksCenterApi.js';
import {updateTaskInstanceDueDateV2} from '../lib/tasksCenterMutationsApi.js';
import {fmt, fmtCentralDateTime} from '../lib/dateUtils.js';
import {
  taskModalErrorNotice as ERROR_NOTICE,
  taskModalFieldLabel as FIELD_LABEL,
  taskModalGhostButton as BTN_GHOST,
  taskModalHistoryRow as HISTORY_ROW,
  taskModalInput as INPUT,
  taskModalOverlay as OVERLAY,
  taskModalPanel as PANEL,
  taskModalPrimaryButton as BTN_PRIMARY,
  taskModalSubtleText as SUB,
} from './taskModalStyles.js';

function nameFor(profileId, profilesById) {
  if (!profileId) return null;
  const p = profilesById && profilesById[profileId];
  return p && p.full_name ? p.full_name : 'Unknown user';
}

export default function EditDueDateModal({sb, task, isOpen, isAdmin, profilesById, onClose, onUpdated}) {
  const [newDate, setNewDate] = React.useState('');
  const [history, setHistory] = React.useState([]);
  const [loadingHistory, setLoadingHistory] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    if (!isOpen || !task) {
      setNewDate('');
      setHistory([]);
      setLoadingHistory(true);
      setSaving(false);
      setErr('');
      return undefined;
    }
    setNewDate(task.due_date || '');
    setSaving(false);
    setErr('');
    let cancelled = false;
    setLoadingHistory(true);
    (async () => {
      try {
        const rows = await loadDueDateEditHistory(sb, task.id);
        if (!cancelled) setHistory(rows);
      } catch (e) {
        if (!cancelled) {
          setHistory([]);
          setErr(e && e.message ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, sb, task]);

  if (!isOpen || !task) return null;

  const editCount = Number(task.due_date_edit_count) || 0;
  const regularEditsRemaining = Math.max(0, 2 - editCount);
  const regularCapHit = !isAdmin && regularEditsRemaining === 0;
  const sameDate = newDate === task.due_date;

  function close() {
    if (onClose) onClose();
  }

  async function save() {
    if (saving) return;
    setErr('');
    if (!newDate) {
      setErr('New due date is required.');
      return;
    }
    if (regularCapHit) {
      setErr('Regular-user edit limit reached (2/2). Ask an admin if a further change is needed.');
      return;
    }
    setSaving(true);
    try {
      const result = await updateTaskInstanceDueDateV2(sb, task.id, newDate);
      if (onUpdated) onUpdated(task.id, result);
      if (onClose) onClose();
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div data-edit-due-date-modal="1" style={OVERLAY} onClick={close}>
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8}}>
          <h2 style={{fontSize: 18, margin: 0, color: '#111827'}}>Edit Due Date</h2>
          <button type="button" onClick={close} style={BTN_GHOST}>
            Cancel
          </button>
        </div>

        <div style={{fontSize: 13, color: '#374151', marginBottom: 14}}>
          <div style={{fontWeight: 600, color: '#111827'}}>{task.title}</div>
          <div style={{...SUB, marginTop: 2}}>
            Current due {fmt(task.due_date)}
            {' · '}
            <span data-edit-due-cap-state={isAdmin ? 'admin-unlimited' : `${editCount}/2`}>
              {isAdmin ? 'Admin: unlimited edits' : `${editCount}/2 regular edits used`}
            </span>
          </div>
        </div>

        <div>
          <label style={FIELD_LABEL} htmlFor="edit-due-date-new">
            New due date
          </label>
          <input
            id="edit-due-date-new"
            data-edit-due-field="new-date"
            type="date"
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            disabled={regularCapHit}
            style={INPUT}
          />
          {sameDate && newDate && (
            <div style={{...SUB, marginTop: 4}} data-edit-due-same-date="1">
              Same as current — saving will be a no-op.
            </div>
          )}
        </div>

        <div style={{marginTop: 16}}>
          <div style={{...FIELD_LABEL, marginBottom: 6}}>History</div>
          {loadingHistory ? (
            <div style={SUB}>Loading…</div>
          ) : history.length === 0 ? (
            <div style={SUB} data-edit-due-history-empty="1">
              No prior edits.
            </div>
          ) : (
            <ul
              data-edit-due-history-list="1"
              style={{listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6}}
            >
              {history.map((row) => (
                <li
                  key={row.id}
                  data-edit-due-history-row={row.id}
                  data-edit-due-history-role={row.edited_by_role}
                  style={HISTORY_ROW}
                >
                  <span style={{fontWeight: 600, color: '#111827'}}>
                    {fmt(row.prior_due_date)} → {fmt(row.new_due_date)}
                  </span>
                  <span style={{...SUB, marginLeft: 8}}>
                    {fmtCentralDateTime(row.edited_at)} ·{' '}
                    {nameFor(row.edited_by_profile_id, profilesById) || 'Unknown user'} ({row.edited_by_role})
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {err && (
          <div data-edit-due-error="1" style={ERROR_NOTICE}>
            {err}
          </div>
        )}

        <div style={{display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14}}>
          <button type="button" onClick={close} disabled={saving} style={BTN_GHOST}>
            Cancel
          </button>
          <button
            type="button"
            data-edit-due-save="1"
            onClick={save}
            disabled={saving || regularCapHit}
            style={BTN_PRIMARY}
          >
            {saving ? 'Saving…' : 'Save Due Date'}
          </button>
        </div>
      </div>
    </div>
  );
}
