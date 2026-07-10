// ============================================================================
// src/processing/ProcessingDrawer.jsx  —  Processing record detail drawer
// ----------------------------------------------------------------------------
// Right-side slide-in (scrim + ~460px panel) opened by a row on the calendar.
// Loads get_processing_record (record + subtasks[] + attachments[] +
// completion_blockers[]) plus the record program's ACTIVE template, and renders
// the Asana-style record page:
//   • OWNERSHIP MATRIX: source-owned facts (title / date / status / number
//     processed) mirror the live planner batch / imported snapshot and are
//     READ-ONLY. Processing-owned edits: Assignee (profile-backed), Processor,
//     Customer (broiler), local template fields (set_processing_field), and
//     subtasks. Milestones are fully Processing-owned (title + date incl.
//     explicit clear + canonical status + assignee + processor + customer) and
//     deletable.
//   • DETAILS: the active template's fields render in configured order through
//     src/lib/processingFields.js — bound ids resolve from the record/derived
//     formulas (read-only), local ids edit typed values into record.fields.
//   • Subtasks: toggle done, add (with assignee), rename, profile-backed
//     reassign incl. clear, delete, reorder (up/down), imported start/due dates
//     shown; "Apply template" stays additive.
//   • Completion is a GATED manual action (computeCompletionBlockers mirrors
//     the server gate); Complete rows show Reopen instead.
//   • Attachments: list (filename / size_bytes per the DB contract), signed
//     open/download via processingAttachmentsApi, and an operational "Add
//     files" upload into the native/ namespace.
//   • Comments + activity via the shared RecordCollaborationSection.
// Every mutation reloads the drawer AND calls onChanged so the list refreshes.
// ============================================================================
import React from 'react';
import {
  getProcessingRecord,
  listProcessingTemplates,
  setProcessingProcessor,
  setProcessingCustomer,
  setProcessingAssignee,
  setProcessingField,
  markProcessingComplete,
  reopenProcessingRecord,
  addProcessingSubtask,
  updateProcessingSubtask,
  setProcessingSubtaskDone,
  deleteProcessingSubtask,
  reorderProcessingSubtasks,
  applyCurrentTemplate,
  updateProcessingMilestone,
  deleteProcessingMilestone,
  archiveProcessingRecord,
  isProcessingValidationError,
  friendlyProcessingError,
} from '../lib/processingApi.js';
import {uploadProcessingAttachment, getProcessingAttachmentUrl} from '../lib/processingAttachmentsApi.js';
import {resolveSourceForRecord, deriveDisplayStatus, weeksDaysText} from '../lib/processingSourceLink.js';
import {processingStatusVariantFromLabel, PROCESSING_STATUS_DISPLAY} from '../lib/processingStatusDisplay.js';
import {computeCompletionBlockers} from '../lib/processingCompletion.js';
import {normalizeFieldDef, resolveFieldDisplay, isFieldEditable} from '../lib/processingFields.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import Badge from '../shared/Badge.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';

const OPERATIONAL_ROLES = ['admin', 'management', 'farm_team'];
// Fallback only if the settings-backed customer_options can't be fetched; the
// live list comes from get_processing_settings (mig 162) via the customerOptions
// prop. See ProcessingOptionsModal for editing.
const CUSTOMER_OPTIONS_FALLBACK = ["Sonny's", 'Coastal Pastures - CONFIRMED', 'Coastal Pastures - POTENTIAL'];
// Field ids already rendered by the core rows above the Details section.
const CORE_COVERED_FIELD_IDS = ['status', 'program', 'batchName', 'animals', 'customer', 'processor'];

const T = {
  card: '#fff',
  border: '#E6E8EB',
  rowBorder: '#F0F1F3',
  ink: '#222933',
  muted: '#6B7280',
  label: '#7A828D',
  faint: '#9AA1AB',
  green: '#1C8A5F',
  chipBg: '#F1F3F4',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatDate(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : '—';
}
function isoDateInput(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function kbText(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

// eslint-disable-next-line no-unused-vars -- JSX-only use
function FieldRow({label, children}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 14,
        padding: '7px 0',
        borderTop: `1px solid ${T.rowBorder}`,
        minHeight: 34,
      }}
    >
      <span style={{fontSize: 12.5, color: T.muted, fontWeight: 600, whiteSpace: 'nowrap'}}>{label}</span>
      <div style={{minWidth: 0, textAlign: 'right'}}>{children}</div>
    </div>
  );
}

// One template-driven Details row. Bound/derived fields render read-only;
// local fields edit typed values through set_processing_field. MODULE-LEVEL on
// purpose: a component type declared inside the drawer would be re-minted on
// every render, remounting the input mid-keystroke and dropping focus (which
// also swallows the commit-on-blur).
// eslint-disable-next-line no-unused-vars -- JSX-only use
function DetailFieldRow({
  field,
  record,
  canOperate,
  busy,
  profilesById,
  profileChoices,
  profileName,
  fieldDrafts,
  setFieldDrafts,
  saveLocalField,
  setNotice,
  inputStyle,
}) {
  const resolved = resolveFieldDisplay(field, record, {todayISO: todayISO()});
  const editable = canOperate && isFieldEditable(field, record) && !resolved.readOnly;
  const value = resolved.value;

  if (!editable) {
    let text = value;
    if (field.type === 'date') text = value ? formatDate(value) : null;
    if (Array.isArray(value)) text = value.join(', ');
    if (field.type === 'people' && value) text = profileName(value) || String(value);
    return (
      <FieldRow label={field.name}>
        <span style={{fontSize: 13, color: text ? T.ink : T.faint, fontWeight: 600}}>{text || '—'}</span>
      </FieldRow>
    );
  }

  if (field.type === 'date') {
    return (
      <FieldRow label={field.name}>
        <input
          type="date"
          value={isoDateInput(value)}
          disabled={busy}
          onChange={(e) => saveLocalField(field, e.target.value || null)}
          data-processing-field-input={field.id}
          style={{...inputStyle, textAlign: 'right'}}
        />
      </FieldRow>
    );
  }
  if (field.type === 'single') {
    const options = Array.isArray(field.options) ? field.options : [];
    const current = value == null ? '' : String(value);
    return (
      <FieldRow label={field.name}>
        <select
          value={options.some((o) => o.label === current) ? current : current ? '__current' : ''}
          disabled={busy}
          onChange={(e) => saveLocalField(field, e.target.value === '' ? null : e.target.value)}
          data-processing-field-input={field.id}
          style={{...inputStyle, maxWidth: 200}}
        >
          <option value="">—</option>
          {current && !options.some((o) => o.label === current) && <option value="__current">{current}</option>}
          {options.map((o) => (
            <option key={o.key} value={o.label}>
              {o.label}
            </option>
          ))}
        </select>
      </FieldRow>
    );
  }
  if (field.type === 'multi') {
    const options = Array.isArray(field.options) ? field.options : [];
    const selected = Array.isArray(value) ? value.map(String) : [];
    const labels = options.map((o) => o.label);
    const merged = [...labels, ...selected.filter((s) => !labels.includes(s))];
    return (
      <FieldRow label={field.name}>
        <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end'}}>
          {merged.map((label) => {
            const on = selected.includes(label);
            const opt = options.find((o) => o.label === label);
            return (
              <button
                key={label}
                type="button"
                disabled={busy}
                data-processing-field-chip={`${field.id}:${label}`}
                onClick={() => saveLocalField(field, on ? selected.filter((s) => s !== label) : [...selected, label])}
                style={{
                  fontSize: 11.5,
                  fontWeight: 700,
                  borderRadius: 999,
                  padding: '4px 10px',
                  cursor: busy ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                  border: `1px solid ${on ? T.green : T.border}`,
                  background: on && opt ? opt.color.bg : on ? '#E6F4EC' : '#fff',
                  color: on && opt ? opt.color.ink : on ? '#1F7A4D' : T.muted,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </FieldRow>
    );
  }
  if (field.type === 'people') {
    const current = value == null ? '' : String(value);
    return (
      <FieldRow label={field.name}>
        <select
          value={profilesById[current] ? current : ''}
          disabled={busy}
          onChange={(e) => saveLocalField(field, e.target.value || null)}
          data-processing-field-input={field.id}
          style={{...inputStyle, maxWidth: 200}}
        >
          <option value="">{current && !profilesById[current] ? String(current) : '—'}</option>
          {profileChoices.map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name}
            </option>
          ))}
        </select>
      </FieldRow>
    );
  }
  // text / number: draft-buffered input, commit on blur / Enter.
  const draft = fieldDrafts[field.id] !== undefined ? fieldDrafts[field.id] : value == null ? '' : String(value);
  const commit = () => {
    const raw = fieldDrafts[field.id];
    if (raw === undefined) return;
    setFieldDrafts((d) => {
      const next = {...d};
      delete next[field.id];
      return next;
    });
    const trimmed = String(raw).trim();
    const prev = value == null ? '' : String(value);
    if (trimmed === prev) return;
    if (field.type === 'number') {
      const n = trimmed === '' ? null : Number(trimmed);
      if (trimmed !== '' && !Number.isFinite(n)) {
        setNotice({kind: 'error', message: `${field.name} expects a number.`});
        return;
      }
      saveLocalField(field, n);
    } else {
      saveLocalField(field, trimmed === '' ? null : trimmed);
    }
  };
  return (
    <FieldRow label={field.name}>
      <input
        type={field.type === 'number' ? 'number' : 'text'}
        value={draft}
        disabled={busy}
        onChange={(e) => setFieldDrafts((d) => ({...d, [field.id]: e.target.value}))}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        data-processing-field-input={field.id}
        style={{...inputStyle, textAlign: 'right', width: field.type === 'number' ? 110 : 190, maxWidth: '52vw'}}
      />
    </FieldRow>
  );
}

export default function ProcessingDrawer({
  sb,
  authState,
  recordId,
  onClose,
  onChanged,
  customerOptions = [],
  processorOptions = [],
  profilesById = {},
}) {
  const {useState, useEffect, useCallback, useRef, useMemo} = React;
  const role = authState?.role;
  const canOperate = OPERATIONAL_ROLES.includes(role);

  const [data, setData] = useState(null); // {record, subtasks, attachments, completion_blockers}
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [template, setTemplate] = useState(null); // active template for record.program

  // Local editable buffers.
  const [processorDraft, setProcessorDraft] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [dateDraft, setDateDraft] = useState('');
  const [newSubtask, setNewSubtask] = useState('');
  const [newSubtaskAssignee, setNewSubtaskAssignee] = useState('');
  const [editingSubtaskId, setEditingSubtaskId] = useState(null);
  const [editingSubtaskLabel, setEditingSubtaskLabel] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [fieldDrafts, setFieldDrafts] = useState({}); // {fieldId: draft string} for text/number
  const [uploadBusy, setUploadBusy] = useState(false);
  const notifyRef = useRef(onChanged);
  notifyRef.current = onChanged;
  const fileInputRef = useRef(null);

  const record = data?.record || null;
  const subtasks = Array.isArray(data?.subtasks) ? data.subtasks : [];
  const attachments = Array.isArray(data?.attachments) ? data.attachments : [];

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const d = await getProcessingRecord(sb, recordId);
      setData(d);
      if (d && d.record) {
        setProcessorDraft(d.record.processor || '');
        setTitleDraft(d.record.title || '');
        setDateDraft(isoDateInput(d.record.processing_date));
        setFieldDrafts({});
      }
    } catch (e) {
      setData(null);
      setLoadError({message: `Could not load this record. Please retry. (${(e && e.message) || e})`});
    } finally {
      setLoading(false);
    }
  }, [sb, recordId]);

  useEffect(() => {
    load();
  }, [load]);

  // Active template for the record's program drives the Details field layout.
  // Best-effort sidecar: a template load failure never blocks the record.
  useEffect(() => {
    let cancelled = false;
    async function loadTemplate() {
      const program = record?.program;
      if (!program || record?.record_type === 'milestone') {
        setTemplate(null);
        return;
      }
      try {
        const templates = await listProcessingTemplates(sb, program);
        if (cancelled) return;
        const active = (Array.isArray(templates) ? templates : []).find((t) => t.is_active) || templates[0] || null;
        setTemplate(active || null);
      } catch (_e) {
        if (!cancelled) setTemplate(null);
      }
    }
    loadTemplate();
    return () => {
      cancelled = true;
    };
  }, [sb, record?.program, record?.record_type]);

  // Esc closes the drawer.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Run a mutation with consistent busy/notice handling, then reload + notify.
  const runMutation = useCallback(
    async (fn, {onValidation} = {}) => {
      setBusy(true);
      setNotice(null);
      try {
        await fn();
        await load();
        if (notifyRef.current) notifyRef.current();
        return true;
      } catch (e) {
        if (isProcessingValidationError(e)) {
          setNotice({kind: onValidation === 'warning' ? 'warning' : 'error', message: friendlyProcessingError(e)});
        } else {
          setNotice({kind: 'error', message: `Something went wrong. Please retry. (${(e && e.message) || e})`});
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const isMilestone = record?.record_type === 'milestone';
  const isBroiler = record ? (record.program || record.source_kind) === 'broiler' : false;
  const sourceInfo = record ? resolveSourceForRecord(record, {}) : null;
  const tofText = isBroiler && record ? (weeksDaysText(record.time_on_farm_days) ?? sourceInfo?.timeOnFarmText) : null;
  const statusLabel = record ? deriveDisplayStatus(record, sourceInfo) : '';
  const isComplete = record ? record.completed_at != null || statusLabel === PROCESSING_STATUS_DISPLAY.complete : false;
  const blockers = record ? computeCompletionBlockers(record, subtasks) : [];
  const customerSelected = useMemo(() => (Array.isArray(record?.customer) ? record.customer : []), [record?.customer]);
  const customerChoices = useMemo(() => {
    const base = Array.isArray(customerOptions) && customerOptions.length ? customerOptions : CUSTOMER_OPTIONS_FALLBACK;
    const merged = base.slice();
    for (const c of customerSelected) if (c && !merged.includes(c)) merged.push(c);
    return merged;
  }, [customerOptions, customerSelected]);

  // Profile choices for people pickers (assignee rows). Sorted by name.
  const profileChoices = useMemo(() => {
    return Object.values(profilesById || {})
      .filter((p) => p && p.id)
      .sort((a, b) => String(a.full_name || '').localeCompare(String(b.full_name || '')));
  }, [profilesById]);
  const profileName = useCallback(
    (id) => (id && profilesById && profilesById[id] ? profilesById[id].full_name || 'Unknown user' : null),
    [profilesById],
  );

  // Template fields for the Details section (configured order; core ids skipped).
  const detailFields = useMemo(() => {
    if (!template || isMilestone) return [];
    const list = Array.isArray(template.fields) ? template.fields : [];
    return list
      .map(normalizeFieldDef)
      .filter(Boolean)
      .filter((f) => !CORE_COVERED_FIELD_IDS.includes(f.id));
  }, [template, isMilestone]);

  // ── field mutations ────────────────────────────────────────────────────────
  function saveProcessor() {
    if ((record.processor || '') === (processorDraft || '')) return;
    runMutation(() => setProcessingProcessor(sb, record.id, processorDraft.trim() || null));
  }
  function toggleCustomer(option) {
    const next = customerSelected.includes(option)
      ? customerSelected.filter((c) => c !== option)
      : [...customerSelected, option];
    runMutation(() => setProcessingCustomer(sb, record.id, next));
  }
  function saveAssignee(profileId) {
    runMutation(() => setProcessingAssignee(sb, record.id, profileId || null));
  }
  function saveMilestoneTitle() {
    if (!isMilestone || (record.title || '') === titleDraft.trim()) return;
    if (!titleDraft.trim()) {
      setNotice({kind: 'error', message: 'Milestone name is required.'});
      return;
    }
    runMutation(() => updateProcessingMilestone(sb, {id: record.id, title: titleDraft.trim()}));
  }
  function saveMilestoneDate() {
    if (!isMilestone || isoDateInput(record.processing_date) === dateDraft) return;
    // An emptied date input is an EXPLICIT clear (floating milestone).
    runMutation(() =>
      updateProcessingMilestone(
        sb,
        dateDraft ? {id: record.id, processingDate: dateDraft} : {id: record.id, clearDate: true},
      ),
    );
  }
  function saveMilestoneStatus(status) {
    if (!isMilestone || !status) return;
    runMutation(() => updateProcessingMilestone(sb, {id: record.id, status}));
  }
  function saveLocalField(field, value) {
    runMutation(() => setProcessingField(sb, record.id, field.id, value));
  }

  // ── completion ─────────────────────────────────────────────────────────────
  function markComplete() {
    runMutation(() => markProcessingComplete(sb, record.id));
  }
  function reopen() {
    runMutation(() => reopenProcessingRecord(sb, record.id));
  }

  // ── subtasks ───────────────────────────────────────────────────────────────
  function toggleSubtask(st) {
    runMutation(() => setProcessingSubtaskDone(sb, st.id, !st.done));
  }
  function addSubtask() {
    const label = newSubtask.trim();
    if (!label) return;
    runMutation(() =>
      addProcessingSubtask(sb, {recordId: record.id, label, assigneeProfileId: newSubtaskAssignee || null}),
    ).then((ok) => {
      if (ok) {
        setNewSubtask('');
        setNewSubtaskAssignee('');
      }
    });
  }
  function saveSubtaskLabel(st) {
    const label = editingSubtaskLabel.trim();
    setEditingSubtaskId(null);
    if (!label || label === st.label) return;
    runMutation(() => updateProcessingSubtask(sb, {id: st.id, label}));
  }
  function reassignSubtask(st, profileId) {
    runMutation(() =>
      updateProcessingSubtask(
        sb,
        profileId ? {id: st.id, assigneeProfileId: profileId} : {id: st.id, clearAssignee: true},
      ),
    );
  }
  function deleteSubtask(st) {
    runMutation(() => deleteProcessingSubtask(sb, st.id));
  }
  function moveSubtask(st, delta) {
    const ids = subtasks.map((s) => s.id);
    const from = ids.indexOf(st.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(to, 0, st.id);
    runMutation(() => reorderProcessingSubtasks(sb, record.id, ids));
  }
  function applyTemplate() {
    runMutation(() => applyCurrentTemplate(sb, record.id));
  }

  // ── milestone delete ───────────────────────────────────────────────────────
  function doDeleteMilestone() {
    setConfirmingDelete(false);
    runMutation(() => deleteProcessingMilestone(sb, record.id)).then((ok) => {
      if (ok) onClose();
    });
  }

  // ── archive (soft delete) / restore an Asana-owned record ───────────────────
  const isArchivable =
    !!record && !isMilestone && ['asana_historical', 'import_exception'].includes(record.record_type);
  const isArchived = !!record?.archived;
  function doArchiveRecord() {
    setConfirmingArchive(false);
    runMutation(() => archiveProcessingRecord(sb, record.id, true)).then((ok) => {
      if (ok) onClose();
    });
  }
  function doRestoreRecord() {
    runMutation(() => archiveProcessingRecord(sb, record.id, false));
  }

  // ── attachments ────────────────────────────────────────────────────────────
  async function openAttachment(at) {
    setNotice(null);
    const url = await getProcessingAttachmentUrl(sb, at.storage_path, 600);
    if (!url) {
      setNotice({kind: 'error', message: 'Could not open this attachment. Please retry.'});
      return;
    }
    window.open(url, '_blank', 'noopener');
  }
  async function onFilesPicked(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length || !record) return;
    setUploadBusy(true);
    setNotice(null);
    try {
      for (const file of files) {
        // Sequential on purpose: clear failure attribution per file.
        await uploadProcessingAttachment(sb, {recordId: record.id, file});
      }
      await load();
      if (notifyRef.current) notifyRef.current();
    } catch (err) {
      setNotice({kind: 'error', message: friendlyProcessingError(err)});
    } finally {
      setUploadBusy(false);
    }
  }

  const primaryBtn = (disabled) => ({
    background: disabled ? '#EAECEF' : T.green,
    color: disabled ? '#9AA1AB' : '#fff',
    border: 'none',
    borderRadius: 10,
    padding: '9px 16px',
    fontSize: 13,
    fontWeight: 700,
    cursor: disabled ? 'default' : 'pointer',
    fontFamily: 'inherit',
  });
  const ghostBtn = {
    background: T.card,
    color: T.muted,
    border: `1px solid ${T.border}`,
    borderRadius: 10,
    padding: '7px 12px',
    fontSize: 12.5,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
  const inputStyle = {
    border: `1px solid #D2D6DB`,
    borderRadius: 10,
    padding: '6px 9px',
    fontSize: 13,
    fontWeight: 600,
    color: T.ink,
    fontFamily: 'inherit',
    background: '#fff',
    outline: 'none',
  };
  const arrowBtn = (disabled) => ({
    background: 'none',
    border: 'none',
    color: disabled ? '#D8DCE0' : T.faint,
    cursor: disabled ? 'default' : 'pointer',
    fontSize: 11,
    lineHeight: 1,
    padding: '1px 2px',
    fontFamily: 'inherit',
  });

  const displayVariant = processingStatusVariantFromLabel(statusLabel);

  return (
    <div style={{position: 'fixed', inset: 0, zIndex: 6000}} data-processing-drawer={recordId}>
      <style>{`
        @keyframes wcfProcScrimIn{from{opacity:0}to{opacity:1}}
        @keyframes wcfProcPanelIn{from{transform:translateX(26px);opacity:.3}to{transform:translateX(0);opacity:1}}
      `}</style>
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(20,28,24,.28)',
          animation: 'wcfProcScrimIn .15s ease',
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Processing record"
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          height: '100vh',
          width: 466,
          maxWidth: '94vw',
          background: T.card,
          boxShadow: '-10px 0 36px rgba(20,30,40,.20)',
          display: 'flex',
          flexDirection: 'column',
          animation: 'wcfProcPanelIn .18s ease',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 16px',
            borderBottom: `1px solid ${T.rowBorder}`,
            flex: 'none',
          }}
        >
          <div style={{flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 9}}>
            {record && <Badge variant={displayVariant}>{statusLabel}</Badge>}
            {isComplete && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: '#E6F4EC',
                  color: '#1F7A4D',
                  border: '1px solid #BFE6CF',
                  borderRadius: 10,
                  padding: '4px 10px',
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                ✓ Completed
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 30,
              height: 30,
              borderRadius: 10,
              border: `1px solid ${T.border}`,
              background: '#fff',
              color: T.muted,
              cursor: 'pointer',
              fontSize: 15,
              flex: 'none',
            }}
          >
            ✕
          </button>
        </div>

        <div style={{flex: 1, overflow: 'auto', padding: '18px 20px 44px'}}>
          {loading && <div style={{color: T.faint, fontSize: 13, fontWeight: 600}}>Loading record…</div>}

          {loadError && (
            <div data-processing-drawer-error="1">
              <InlineNotice notice={{kind: 'error', message: loadError.message}} />
              <button type="button" onClick={load} style={ghostBtn}>
                Retry
              </button>
            </div>
          )}

          {!loading && !loadError && !record && (
            <InlineNotice
              notice={{kind: 'warning', message: 'This record could not be found. It may have been deleted.'}}
            />
          )}

          {!loading && !loadError && record && (
            <>
              <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />

              {/* Title */}
              {isMilestone && canOperate ? (
                <div style={{marginBottom: 14}}>
                  <input
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={saveMilestoneTitle}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                    aria-label="Milestone name"
                    style={{...inputStyle, width: '100%', fontSize: 17, fontWeight: 800, boxSizing: 'border-box'}}
                  />
                  <div style={{fontSize: 11.5, color: T.faint, fontWeight: 600, marginTop: 4}}>Milestone</div>
                </div>
              ) : (
                <div style={{marginBottom: 14}}>
                  <h2 style={{fontSize: 18, fontWeight: 800, letterSpacing: '-.01em', color: T.ink}}>{record.title}</h2>
                  <div style={{fontSize: 11.5, color: T.faint, fontWeight: 600, marginTop: 3}}>
                    {(record.program || record.source_kind || '').replace(/^\w/, (c) => c.toUpperCase())}
                    {record.record_type ? ` · ${record.record_type.replace(/_/g, ' ')}` : ''}
                  </div>
                </div>
              )}

              {/* Core fields */}
              <div>
                <FieldRow label="Status">
                  {isMilestone && canOperate ? (
                    <select
                      value={
                        statusLabel === PROCESSING_STATUS_DISPLAY.complete
                          ? 'complete'
                          : statusLabel === PROCESSING_STATUS_DISPLAY.inProcess
                            ? 'in_process'
                            : 'planned'
                      }
                      disabled={busy}
                      onChange={(e) => saveMilestoneStatus(e.target.value)}
                      data-processing-milestone-status
                      style={{...inputStyle, maxWidth: 160}}
                    >
                      <option value="planned">Planned</option>
                      <option value="in_process">In Process</option>
                      <option value="complete">Complete</option>
                    </select>
                  ) : (
                    <Badge variant={displayVariant}>{statusLabel}</Badge>
                  )}
                </FieldRow>

                {/* Assignee — profile-backed, Processing-owned on every record */}
                <FieldRow label="Assignee">
                  {canOperate ? (
                    <select
                      value={
                        record.assignee_profile_id && profilesById[record.assignee_profile_id]
                          ? record.assignee_profile_id
                          : ''
                      }
                      disabled={busy}
                      onChange={(e) => saveAssignee(e.target.value || null)}
                      aria-label="Assignee"
                      data-processing-assignee-select
                      style={{...inputStyle, maxWidth: 200}}
                    >
                      <option value="">
                        {record.assignee_profile_id && !profilesById[record.assignee_profile_id]
                          ? 'Assigned user'
                          : record.assignee_name
                            ? `${record.assignee_name} (imported)`
                            : '—'}
                      </option>
                      {profileChoices.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.full_name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span style={{fontSize: 13, color: T.muted, fontWeight: 600}}>
                      {profileName(record.assignee_profile_id) || record.assignee_name || '—'}
                    </span>
                  )}
                </FieldRow>

                <FieldRow label="Processing date">
                  {isMilestone && canOperate ? (
                    <input
                      type="date"
                      value={dateDraft}
                      onChange={(e) => setDateDraft(e.target.value)}
                      onBlur={saveMilestoneDate}
                      style={{...inputStyle, textAlign: 'right'}}
                      data-processing-milestone-date
                    />
                  ) : (
                    <span style={{fontSize: 13.5, color: T.ink, fontWeight: 700}}>
                      {formatDate(record.processing_date)}
                    </span>
                  )}
                </FieldRow>

                {!isMilestone && (
                  <FieldRow label="Number processed">
                    <span style={{fontSize: 13.5, color: T.ink, fontWeight: 700, fontVariantNumeric: 'tabular-nums'}}>
                      {sourceInfo && sourceInfo.numberProcessed != null
                        ? Number(sourceInfo.numberProcessed).toLocaleString()
                        : record.number_processed != null
                          ? Number(record.number_processed).toLocaleString()
                          : '—'}
                    </span>
                  </FieldRow>
                )}

                {(isBroiler ? tofText : sourceInfo?.ageText) && (
                  <FieldRow label={isBroiler ? 'Time on farm' : 'Age'}>
                    <span style={{fontSize: 13.5, color: T.ink, fontWeight: 700}}>
                      {isBroiler ? tofText : sourceInfo.ageText}
                    </span>
                  </FieldRow>
                )}

                {/* Processor — editable Processing-owned field */}
                <FieldRow label="Processor">
                  {canOperate ? (
                    <div style={{display: 'inline-flex', alignItems: 'center', gap: 6}}>
                      <input
                        value={processorDraft}
                        onChange={(e) => setProcessorDraft(e.target.value)}
                        onBlur={saveProcessor}
                        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                        placeholder="Processor"
                        aria-label="Processor"
                        list="processing-processor-choices"
                        data-processing-processor-input
                        style={{...inputStyle, textAlign: 'right', width: 200, maxWidth: '52vw'}}
                      />
                      <datalist id="processing-processor-choices">
                        {(Array.isArray(processorOptions) ? processorOptions : []).map((p) => (
                          <option key={p} value={p} />
                        ))}
                      </datalist>
                    </div>
                  ) : (
                    <span style={{fontSize: 13.5, color: record.processor ? T.ink : T.faint, fontWeight: 600}}>
                      {record.processor || '—'}
                    </span>
                  )}
                </FieldRow>

                {/* Customer — broiler only, editable Processing-owned field */}
                {isBroiler && (
                  <FieldRow label="Customer">
                    {canOperate ? (
                      <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end'}}>
                        {customerChoices.map((opt) => {
                          const on = customerSelected.includes(opt);
                          return (
                            <button
                              key={opt}
                              type="button"
                              disabled={busy}
                              onClick={() => toggleCustomer(opt)}
                              data-processing-customer-chip={opt}
                              title={opt}
                              style={{
                                fontSize: 11.5,
                                fontWeight: 700,
                                borderRadius: 999,
                                padding: '4px 10px',
                                cursor: busy ? 'default' : 'pointer',
                                fontFamily: 'inherit',
                                border: `1px solid ${on ? T.green : T.border}`,
                                background: on ? '#E6F4EC' : '#fff',
                                color: on ? '#1F7A4D' : T.muted,
                              }}
                            >
                              {opt.split(' - ')[0]}
                              {opt.includes(' - ') ? ` (${opt.split(' - ')[1].slice(0, 4).toLowerCase()})` : ''}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <span style={{fontSize: 13, color: T.muted, fontWeight: 600}}>
                        {customerSelected.length ? customerSelected.map((c) => c.split(' - ')[0]).join(', ') : '—'}
                      </span>
                    )}
                  </FieldRow>
                )}
              </div>

              {/* Details — the active template's fields in configured order */}
              {detailFields.length > 0 && (
                <div style={{marginTop: 22}} data-processing-details-section="1">
                  <div style={{fontSize: 14, fontWeight: 800, color: T.ink, marginBottom: 4}}>Details</div>
                  {detailFields.map((f) => (
                    <DetailFieldRow
                      key={f.id}
                      field={f}
                      record={record}
                      canOperate={canOperate}
                      busy={busy}
                      profilesById={profilesById}
                      profileChoices={profileChoices}
                      profileName={profileName}
                      fieldDrafts={fieldDrafts}
                      setFieldDrafts={setFieldDrafts}
                      saveLocalField={saveLocalField}
                      setNotice={setNotice}
                      inputStyle={inputStyle}
                    />
                  ))}
                </div>
              )}

              {/* Subtasks */}
              {!isMilestone && (
                <div style={{marginTop: 22}}>
                  <div style={{display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8}}>
                    <span style={{fontSize: 14, fontWeight: 800, color: T.ink}}>Subtasks</span>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: T.label,
                        background: T.chipBg,
                        borderRadius: 999,
                        padding: '2px 9px',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {subtasks.filter((s) => s.done).length}/{subtasks.length}
                    </span>
                    {canOperate && (
                      <button
                        type="button"
                        onClick={applyTemplate}
                        disabled={busy}
                        style={{...ghostBtn, marginLeft: 'auto'}}
                      >
                        Apply template
                      </button>
                    )}
                  </div>

                  {subtasks.length === 0 && (
                    <div style={{fontSize: 12.5, color: T.faint, fontWeight: 600, padding: '6px 0'}}>
                      No subtasks yet.
                    </div>
                  )}

                  {subtasks.map((st, idx) => {
                    const dates = [
                      st.start_on ? `starts ${formatDate(st.start_on)}` : null,
                      st.due_on ? `due ${formatDate(st.due_on)}` : null,
                      st.done && st.completed_at ? `done ${formatDate(st.completed_at)}` : null,
                    ].filter(Boolean);
                    const assigneeValue =
                      st.assignee_profile_id && profilesById[st.assignee_profile_id] ? st.assignee_profile_id : '';
                    const importedAssignee = !st.assignee_profile_id && st.assignee ? st.assignee : null;
                    return (
                      <div
                        key={st.id}
                        data-processing-subtask={st.id}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 10,
                          padding: '8px 2px',
                          borderTop: `1px solid #F4F5F6`,
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => canOperate && toggleSubtask(st)}
                          disabled={!canOperate || busy}
                          aria-label={st.done ? 'Mark subtask not done' : 'Mark subtask done'}
                          style={{
                            width: 18,
                            height: 18,
                            borderRadius: '50%',
                            border: st.done ? 'none' : `1.6px solid #CDD2D8`,
                            background: st.done ? T.green : '#fff',
                            color: '#fff',
                            fontSize: 11,
                            fontWeight: 800,
                            cursor: canOperate ? 'pointer' : 'default',
                            flex: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: 0,
                            marginTop: 2,
                          }}
                        >
                          {st.done ? '✓' : ''}
                        </button>
                        <div style={{flex: 1, minWidth: 0}}>
                          {editingSubtaskId === st.id ? (
                            <input
                              autoFocus
                              value={editingSubtaskLabel}
                              onChange={(e) => setEditingSubtaskLabel(e.target.value)}
                              onBlur={() => saveSubtaskLabel(st)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') e.currentTarget.blur();
                                if (e.key === 'Escape') setEditingSubtaskId(null);
                              }}
                              style={{...inputStyle, width: '100%', boxSizing: 'border-box'}}
                            />
                          ) : (
                            <span
                              onClick={() => {
                                if (!canOperate) return;
                                setEditingSubtaskId(st.id);
                                setEditingSubtaskLabel(st.label || '');
                              }}
                              style={{
                                display: 'block',
                                fontSize: 13.5,
                                fontWeight: 600,
                                color: st.done ? T.faint : T.ink,
                                textDecoration: st.done ? 'line-through' : 'none',
                                cursor: canOperate ? 'text' : 'default',
                                overflowWrap: 'anywhere',
                              }}
                            >
                              {st.label}
                            </span>
                          )}
                          {dates.length > 0 && (
                            <span
                              style={{display: 'block', fontSize: 11, color: T.faint, fontWeight: 600, marginTop: 2}}
                            >
                              {dates.join(' · ')}
                            </span>
                          )}
                        </div>
                        {st.source === 'asana' && (
                          <Badge variant="info" style={{flex: 'none'}} title="Imported from Asana">
                            Asana
                          </Badge>
                        )}
                        {canOperate ? (
                          <select
                            value={assigneeValue}
                            onChange={(e) => reassignSubtask(st, e.target.value || null)}
                            disabled={busy}
                            aria-label="Assignee"
                            style={{...inputStyle, padding: '4px 6px', fontSize: 11.5, maxWidth: 120}}
                          >
                            <option value="">{importedAssignee ? `${importedAssignee} (imported)` : '—'}</option>
                            {profileChoices.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.full_name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          (profileName(st.assignee_profile_id) || st.assignee) && (
                            <span style={{fontSize: 11.5, color: T.muted, fontWeight: 600}}>
                              {profileName(st.assignee_profile_id) || st.assignee}
                            </span>
                          )
                        )}
                        {canOperate && (
                          <span style={{display: 'inline-flex', flexDirection: 'column', flex: 'none'}}>
                            <button
                              type="button"
                              onClick={() => moveSubtask(st, -1)}
                              disabled={busy || idx === 0}
                              aria-label="Move subtask up"
                              data-processing-subtask-up={st.id}
                              style={arrowBtn(busy || idx === 0)}
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              onClick={() => moveSubtask(st, 1)}
                              disabled={busy || idx === subtasks.length - 1}
                              aria-label="Move subtask down"
                              data-processing-subtask-down={st.id}
                              style={arrowBtn(busy || idx === subtasks.length - 1)}
                            >
                              ▼
                            </button>
                          </span>
                        )}
                        {canOperate && (
                          <button
                            type="button"
                            onClick={() => deleteSubtask(st)}
                            disabled={busy}
                            aria-label="Delete subtask"
                            style={{
                              background: 'none',
                              border: 'none',
                              color: '#B4373A',
                              cursor: 'pointer',
                              fontSize: 14,
                              flex: 'none',
                            }}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    );
                  })}

                  {canOperate && (
                    <div style={{display: 'flex', gap: 6, marginTop: 10, alignItems: 'center'}}>
                      <input
                        value={newSubtask}
                        onChange={(e) => setNewSubtask(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addSubtask()}
                        placeholder="Add a subtask"
                        data-processing-add-subtask
                        style={{...inputStyle, flex: 1, minWidth: 0}}
                      />
                      <select
                        value={newSubtaskAssignee}
                        onChange={(e) => setNewSubtaskAssignee(e.target.value)}
                        aria-label="New subtask assignee"
                        style={{...inputStyle, padding: '6px 6px', fontSize: 11.5, maxWidth: 120}}
                      >
                        <option value="">—</option>
                        {profileChoices.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.full_name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={addSubtask}
                        disabled={busy || !newSubtask.trim()}
                        style={primaryBtn(busy || !newSubtask.trim())}
                      >
                        Add
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Completion gate */}
              {canOperate && (
                <div style={{marginTop: 22, borderTop: `1px solid ${T.rowBorder}`, paddingTop: 16}}>
                  <div style={{fontSize: 14, fontWeight: 800, color: T.ink, marginBottom: 8}}>Completion</div>
                  {isComplete ? (
                    <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                      <span style={{fontSize: 12.5, color: '#1F7A4D', fontWeight: 700}}>
                        Completed{record.completed_at ? ` · ${formatDate(record.completed_at)}` : ''}
                      </span>
                      <button
                        type="button"
                        onClick={reopen}
                        disabled={busy}
                        style={{...ghostBtn, marginLeft: 'auto'}}
                        data-processing-reopen
                      >
                        Reopen
                      </button>
                    </div>
                  ) : (
                    <>
                      {blockers.length > 0 && (
                        <ul
                          style={{
                            margin: '0 0 10px',
                            paddingLeft: 18,
                            color: '#8A6A1E',
                            fontSize: 12.5,
                            fontWeight: 600,
                          }}
                        >
                          {blockers.map((b, i) => (
                            <li key={i} style={{marginBottom: 2}}>
                              {b}
                            </li>
                          ))}
                        </ul>
                      )}
                      <button
                        type="button"
                        onClick={markComplete}
                        disabled={busy || blockers.length > 0}
                        data-processing-mark-complete
                        style={primaryBtn(busy || blockers.length > 0)}
                      >
                        Mark complete
                      </button>
                      {blockers.length === 0 && (
                        <span style={{fontSize: 11.5, color: T.faint, fontWeight: 600, marginLeft: 10}}>
                          All requirements met.
                        </span>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Attachments — signed open/download + operational native upload */}
              <div style={{marginTop: 22}}>
                <div style={{display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8}}>
                  <span style={{fontSize: 14, fontWeight: 800, color: T.ink}}>
                    Attachments{' '}
                    <span style={{fontSize: 12, fontWeight: 700, color: T.label}}>{attachments.length}</span>
                  </span>
                  {canOperate && (
                    <>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current && fileInputRef.current.click()}
                        disabled={busy || uploadBusy}
                        data-processing-add-files
                        style={{...ghostBtn, marginLeft: 'auto'}}
                      >
                        {uploadBusy ? 'Uploading…' : '+ Add files'}
                      </button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        onChange={onFilesPicked}
                        style={{display: 'none'}}
                        aria-label="Add attachment files"
                      />
                    </>
                  )}
                </div>
                {attachments.length === 0 ? (
                  <div style={{fontSize: 12.5, color: T.faint, fontWeight: 600}}>No attachments.</div>
                ) : (
                  <div style={{display: 'flex', flexWrap: 'wrap', gap: 10}}>
                    {attachments.map((at, i) => {
                      const name = at.filename || at.id || `Attachment ${i + 1}`;
                      const meta = [kbText(at.size_bytes), at.asana_attachment_gid ? 'Asana' : null]
                        .filter(Boolean)
                        .join(' · ');
                      return (
                        <button
                          key={at.id || i}
                          type="button"
                          onClick={() => openAttachment(at)}
                          data-processing-attachment={at.id || i}
                          title={`Open ${name}`}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 11,
                            border: `1px solid ${T.border}`,
                            borderRadius: 12,
                            padding: 12,
                            width: 222,
                            maxWidth: '100%',
                            background: '#fff',
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                            textAlign: 'left',
                          }}
                        >
                          <span
                            aria-hidden="true"
                            style={{
                              width: 34,
                              height: 34,
                              borderRadius: 10,
                              background: '#E6F4EC',
                              color: '#1F7A4D',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flex: 'none',
                              fontSize: 15,
                            }}
                          >
                            ⎘
                          </span>
                          <span style={{minWidth: 0}}>
                            <span
                              style={{
                                display: 'block',
                                fontSize: 13,
                                fontWeight: 700,
                                color: T.ink,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {name}
                            </span>
                            {meta && (
                              <span style={{display: 'block', fontSize: 11.5, color: T.faint, fontWeight: 600}}>
                                {meta}
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Milestone delete (operational roles) */}
              {isMilestone && canOperate && (
                <div style={{marginTop: 22, borderTop: `1px solid ${T.rowBorder}`, paddingTop: 14}}>
                  {confirmingDelete ? (
                    <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
                      <span style={{fontSize: 12.5, color: T.muted, fontWeight: 600}}>Delete this milestone?</span>
                      <button
                        type="button"
                        onClick={doDeleteMilestone}
                        disabled={busy}
                        style={{...ghostBtn, borderColor: '#b91c1c', color: '#b91c1c'}}
                        data-processing-milestone-delete-confirm
                      >
                        Delete
                      </button>
                      <button type="button" onClick={() => setConfirmingDelete(false)} style={ghostBtn}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(true)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#B4373A',
                        fontSize: 12.5,
                        fontWeight: 700,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        padding: 0,
                      }}
                      data-processing-milestone-delete
                    >
                      Delete milestone
                    </button>
                  )}
                </div>
              )}

              {/* Restore an archived record (operational roles) */}
              {isArchived && canOperate && (
                <div style={{marginTop: 22, borderTop: `1px solid ${T.rowBorder}`, paddingTop: 14}}>
                  <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
                    <span style={{fontSize: 12.5, color: T.muted, fontWeight: 600}}>
                      This record is archived (hidden from the calendar).
                    </span>
                    <button
                      type="button"
                      onClick={doRestoreRecord}
                      disabled={busy}
                      style={ghostBtn}
                      data-processing-record-restore
                    >
                      Restore
                    </button>
                  </div>
                </div>
              )}

              {/* Archive (soft delete) an Asana-owned record (operational roles) */}
              {isArchivable && !isArchived && canOperate && (
                <div style={{marginTop: 22, borderTop: `1px solid ${T.rowBorder}`, paddingTop: 14}}>
                  {confirmingArchive ? (
                    <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
                      <span style={{fontSize: 12.5, color: T.muted, fontWeight: 600}}>
                        Archive this record? It hides from the calendar; the Asana history is kept.
                      </span>
                      <button
                        type="button"
                        onClick={doArchiveRecord}
                        disabled={busy}
                        style={{...ghostBtn, borderColor: '#b91c1c', color: '#b91c1c'}}
                        data-processing-record-archive-confirm
                      >
                        Archive
                      </button>
                      <button type="button" onClick={() => setConfirmingArchive(false)} style={ghostBtn}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingArchive(true)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#B4373A',
                        fontSize: 12.5,
                        fontWeight: 700,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        padding: 0,
                      }}
                      data-processing-record-archive
                    >
                      Archive record
                    </button>
                  )}
                </div>
              )}

              {/* Comments + activity */}
              <RecordCollaborationSection
                sb={sb}
                authState={authState}
                entityType="processing.record"
                entityId={recordId}
                entityLabel={record.title || recordId}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
