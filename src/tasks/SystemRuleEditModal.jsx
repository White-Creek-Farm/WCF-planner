// Tasks v2 T9 — System Rule edit modal. Admin-only.
//
// Editable: assignee_profile_id, lead_time_days, active.
// READ-ONLY (intentionally): id, name, description, generator_kind.
// The Edge Function dispatcher recognizes only the four built-in
// generator_kinds, so renaming/rekeying a rule would silently break
// generation — out of T9 scope per Codex's brief. T9 also explicitly
// excludes creating or deleting system rules.

import React from 'react';
import {updateSystemTaskRule} from '../lib/tasksCenterMutationsApi.js';

const OVERLAY = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,.5)',
  zIndex: 250,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};
const PANEL = {
  background: 'white',
  borderRadius: 12,
  padding: 18,
  width: 'min(520px, 96vw)',
  fontFamily: 'inherit',
};
const FIELD_LABEL = {fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4, display: 'block'};
const READ_ONLY_BLOCK = {
  background: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  padding: '8px 12px',
  fontSize: 13,
  color: '#374151',
  marginBottom: 10,
};
const INPUT = {
  width: '100%',
  padding: '8px 10px',
  border: '1px solid #d1d5db',
  borderRadius: 8,
  fontSize: 14,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};
const BTN_PRIMARY = {
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid #085041',
  background: '#085041',
  color: 'white',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  fontFamily: 'inherit',
};
const BTN_GHOST = {
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid #d1d5db',
  background: 'white',
  color: '#374151',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
  fontFamily: 'inherit',
};
const SUB = {fontSize: 12, color: '#6b7280'};

export default function SystemRuleEditModal({sb, isOpen, rule, profilesById, onClose, onSaved}) {
  const [assigneeId, setAssigneeId] = React.useState('');
  const [leadTimeDays, setLeadTimeDays] = React.useState(3);
  const [active, setActive] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');

  // Hydrate fields when the modal opens / the rule changes. Profile map
  // updates do NOT belong here — re-firing this effect mid-edit would
  // clobber the admin's in-flight changes to lead-time / active. The
  // assignee re-resolution against the assignable map lives in its own
  // effect below.
  React.useEffect(() => {
    if (!isOpen || !rule) {
      setAssigneeId('');
      setLeadTimeDays(3);
      setActive(true);
      setSaving(false);
      setErr('');
      return;
    }
    setAssigneeId(rule.assignee_profile_id || '');
    setLeadTimeDays(Number(rule.lead_time_days) || 0);
    setActive(!!rule.active);
    setSaving(false);
    setErr('');
  }, [isOpen, rule]);

  // When the assignable map loads/changes and the rule's current
  // assignee is hidden via Public Tasks availability, clear the dropdown
  // to '' so admin must pick a visible assignee.
  React.useEffect(() => {
    if (!isOpen || !rule) return;
    const cur = rule.assignee_profile_id || '';
    if (!cur) return;
    if (profilesById && profilesById[cur]) {
      setAssigneeId(cur);
    } else {
      setAssigneeId('');
    }
  }, [isOpen, rule, profilesById]);

  if (!isOpen || !rule) return null;

  const eligibleProfiles = Object.values(profilesById || {})
    .filter((p) => p && p.id && p.full_name)
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));

  function close() {
    if (onClose) onClose();
  }

  async function save() {
    if (saving) return;
    setErr('');
    if (!assigneeId) {
      setErr('Assignee is required.');
      return;
    }
    const lead = Number(leadTimeDays);
    if (!Number.isFinite(lead) || lead < 0) {
      setErr('Lead time days must be ≥ 0.');
      return;
    }
    setSaving(true);
    try {
      const result = await updateSystemTaskRule(sb, rule.id, {
        assignee_profile_id: assigneeId,
        lead_time_days: lead,
        active,
      });
      if (onSaved) onSaved(result);
      if (onClose) onClose();
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div data-system-rule-modal="1" style={OVERLAY} onClick={close}>
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12}}>
          <h2 style={{fontSize: 18, margin: 0, color: '#111827'}}>Edit System Rule</h2>
          <button type="button" onClick={close} style={BTN_GHOST}>
            Cancel
          </button>
        </div>

        <div style={READ_ONLY_BLOCK} data-system-rule-readonly="1">
          <div style={{fontWeight: 600, color: '#111827'}}>{rule.name}</div>
          <div style={{...SUB, marginTop: 2}}>
            id: <span data-system-rule-readonly-id={rule.id}>{rule.id}</span>
            {' · kind: '}
            <span data-system-rule-readonly-kind={rule.generator_kind}>{rule.generator_kind}</span>
          </div>
          {rule.description && <div style={{...SUB, marginTop: 4, color: '#4b5563'}}>{rule.description}</div>}
        </div>

        <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
          <div>
            <label style={FIELD_LABEL} htmlFor="system-rule-assignee">
              Assignee
            </label>
            <select
              id="system-rule-assignee"
              data-system-rule-field="assignee"
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              style={INPUT}
            >
              <option value="">— Select —</option>
              {eligibleProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={FIELD_LABEL} htmlFor="system-rule-lead">
              Lead time (days)
            </label>
            <input
              id="system-rule-lead"
              data-system-rule-field="lead-time-days"
              type="number"
              min={0}
              value={leadTimeDays}
              onChange={(e) => setLeadTimeDays(e.target.value)}
              style={INPUT}
            />
          </div>

          <label style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151'}}>
            <input
              type="checkbox"
              data-system-rule-field="active"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            Active (cron will generate instances)
          </label>
        </div>

        {err && (
          <div
            data-system-rule-error="1"
            style={{
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
              padding: '8px 12px',
              borderRadius: 8,
              marginTop: 12,
              fontSize: 13,
            }}
          >
            {err}
          </div>
        )}

        <div style={{display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14}}>
          <button type="button" onClick={close} disabled={saving} style={BTN_GHOST}>
            Cancel
          </button>
          <button type="button" data-system-rule-save="1" onClick={save} disabled={saving} style={BTN_PRIMARY}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
