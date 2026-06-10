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
import {
  taskModalErrorNotice,
  taskModalFieldLabel as FIELD_LABEL,
  taskModalGhostButton as BTN_GHOST,
  taskModalInput as INPUT,
  taskModalOverlay as OVERLAY,
  taskModalPrimaryButton as BTN_PRIMARY,
  taskModalReadOnlyBlock as READ_ONLY_BLOCK,
  taskModalSubtleText as SUB,
  taskModalSystemRulePanel as PANEL,
} from './taskModalStyles.js';

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
          <div data-system-rule-error="1" style={taskModalErrorNotice}>
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
