// ============================================================================
// src/processing/ProcessingDrawer.jsx  —  Processing record detail drawer
// ----------------------------------------------------------------------------
// Right-side slide-in (scrim + ~460px panel) opened by a row on the calendar.
// Loads get_processing_record (record + subtasks[] + attachments[] +
// completion_blockers[]) and renders the Asana-style record page:
//   • Source-owned fields (title / date / status / number processed) are
//     READ-ONLY (they mirror the live planner batch / imported facts). The only
//     Processing-owned edits on a real/imported row are Processor (any) and
//     Customer (broiler). Milestones are fully Processing-owned: title + date +
//     processor + customer are editable and the row is deletable.
//   • Subtasks: toggle done, add, rename, reassign, delete; "Apply template"
//     (additive). Strikethrough when done.
//   • Completion is a GATED manual action — computeCompletionBlockers lists the
//     outstanding requirements and disables Mark Complete until clear; the server
//     re-checks and RAISES PROCESSING_VALIDATION, surfaced via
//     friendlyProcessingError. Complete rows show Reopen instead.
//   • Attachments: the record's processing_attachments are listed read-only;
//     in-app upload is deferred (no storage bucket wired yet).
//   • Comments + activity via the shared RecordCollaborationSection
//     (entityType="processing.record").
// Every mutation reloads the drawer AND calls onChanged so the list refreshes.
// ============================================================================
import React from 'react';
import {
  getProcessingRecord,
  setProcessingProcessor,
  setProcessingCustomer,
  markProcessingComplete,
  reopenProcessingRecord,
  addProcessingSubtask,
  updateProcessingSubtask,
  setProcessingSubtaskDone,
  deleteProcessingSubtask,
  applyCurrentTemplate,
  updateProcessingMilestone,
  deleteProcessingMilestone,
  archiveProcessingRecord,
  isProcessingValidationError,
  friendlyProcessingError,
} from '../lib/processingApi.js';
import {resolveSourceForRecord, deriveDisplayStatus, weeksDaysText} from '../lib/processingSourceLink.js';
import {processingStatusVariantFromLabel, PROCESSING_STATUS_DISPLAY} from '../lib/processingStatusDisplay.js';
import {computeCompletionBlockers} from '../lib/processingCompletion.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import Badge from '../shared/Badge.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';

const OPERATIONAL_ROLES = ['admin', 'management', 'farm_team'];
const CUSTOMER_OPTIONS = ["Sonny's", 'Coastal Pastures - CONFIRMED', 'Coastal Pastures - POTENTIAL'];
const PEOPLE = ['Ronnie Jones', 'Isabel Hermann', 'Brian Naide', 'Brett Post', 'Jessica Torres'];

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

export default function ProcessingDrawer({sb, authState, recordId, onClose, onChanged}) {
  const {useState, useEffect, useCallback, useRef} = React;
  const role = authState?.role;
  const canOperate = OPERATIONAL_ROLES.includes(role);

  const [data, setData] = useState(null); // {record, subtasks, attachments, completion_blockers}
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

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
  const notifyRef = useRef(onChanged);
  notifyRef.current = onChanged;

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
  // Server-derived broiler Time-on-Farm (from get_processing_record); snapshot fallback.
  const tofText = isBroiler && record ? (weeksDaysText(record.time_on_farm_days) ?? sourceInfo?.timeOnFarmText) : null;
  const statusLabel = record ? deriveDisplayStatus(record, sourceInfo) : '';
  const isComplete = record ? record.completed_at != null || statusLabel === PROCESSING_STATUS_DISPLAY.complete : false;
  const blockers = record ? computeCompletionBlockers(record, subtasks) : [];
  const customerSelected = Array.isArray(record?.customer) ? record.customer : [];

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
    runMutation(() => updateProcessingMilestone(sb, {id: record.id, processingDate: dateDraft || null}));
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
      addProcessingSubtask(sb, {recordId: record.id, label, assignee: newSubtaskAssignee || null}),
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
  function reassignSubtask(st, assignee) {
    runMutation(() => updateProcessingSubtask(sb, {id: st.id, assignee: assignee || null}));
  }
  function deleteSubtask(st) {
    runMutation(() => deleteProcessingSubtask(sb, st.id));
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

  // ── archive (soft delete) an Asana-owned record ──────────────────────────────
  // Planner-owned rows are refused server-side; only asana_historical /
  // import_exception are archivable here (the record + its Asana link survive).
  const isArchivable =
    !!record && !isMilestone && ['asana_historical', 'import_exception'].includes(record.record_type);
  function doArchiveRecord() {
    setConfirmingArchive(false);
    runMutation(() => archiveProcessingRecord(sb, record.id, true)).then((ok) => {
      if (ok) onClose();
    });
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
                  <Badge variant={displayVariant}>{statusLabel}</Badge>
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

                <FieldRow label="Number processed">
                  <span style={{fontSize: 13.5, color: T.ink, fontWeight: 700, fontVariantNumeric: 'tabular-nums'}}>
                    {sourceInfo && sourceInfo.numberProcessed != null
                      ? Number(sourceInfo.numberProcessed).toLocaleString()
                      : record.number_processed != null
                        ? Number(record.number_processed).toLocaleString()
                        : '—'}
                  </span>
                </FieldRow>

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
                        data-processing-processor-input
                        style={{...inputStyle, textAlign: 'right', width: 200, maxWidth: '52vw'}}
                      />
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
                        {CUSTOMER_OPTIONS.map((opt) => {
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

              {/* Subtasks */}
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

                {subtasks.map((st) => (
                  <div
                    key={st.id}
                    data-processing-subtask={st.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
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
                      }}
                    >
                      {st.done ? '✓' : ''}
                    </button>
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
                        style={{...inputStyle, flex: 1, minWidth: 0}}
                      />
                    ) : (
                      <span
                        onClick={() => {
                          if (!canOperate) return;
                          setEditingSubtaskId(st.id);
                          setEditingSubtaskLabel(st.label || '');
                        }}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 13.5,
                          fontWeight: 600,
                          color: st.done ? T.faint : T.ink,
                          textDecoration: st.done ? 'line-through' : 'none',
                          cursor: canOperate ? 'text' : 'default',
                        }}
                      >
                        {st.label}
                      </span>
                    )}
                    {st.source === 'asana' && (
                      <Badge variant="info" style={{flex: 'none'}} title="Imported from Asana">
                        Asana
                      </Badge>
                    )}
                    {canOperate ? (
                      <select
                        value={PEOPLE.includes(st.assignee) ? st.assignee : ''}
                        onChange={(e) => reassignSubtask(st, e.target.value)}
                        disabled={busy}
                        aria-label="Assignee"
                        style={{...inputStyle, padding: '4px 6px', fontSize: 11.5, maxWidth: 120}}
                      >
                        <option value="">{st.assignee && !PEOPLE.includes(st.assignee) ? st.assignee : '—'}</option>
                        {PEOPLE.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    ) : (
                      st.assignee && (
                        <span style={{fontSize: 11.5, color: T.muted, fontWeight: 600}}>{st.assignee}</span>
                      )
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
                ))}

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
                      {PEOPLE.map((p) => (
                        <option key={p} value={p}>
                          {p}
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

              {/* Attachments (read-only list; in-app upload deferred) */}
              <div style={{marginTop: 22}}>
                <div style={{fontSize: 14, fontWeight: 800, color: T.ink, marginBottom: 8}}>
                  Attachments <span style={{fontSize: 12, fontWeight: 700, color: T.label}}>{attachments.length}</span>
                </div>
                {attachments.length === 0 ? (
                  <div style={{fontSize: 12.5, color: T.faint, fontWeight: 600}}>No attachments.</div>
                ) : (
                  <div style={{display: 'flex', flexWrap: 'wrap', gap: 10}}>
                    {attachments.map((at, i) => {
                      const name = at.file_name || at.name || at.title || at.id || `Attachment ${i + 1}`;
                      const meta = at.file_size
                        ? `${Math.round(Number(at.file_size) / 1024)} KB`
                        : at.created_at
                          ? formatDate(at.created_at)
                          : '';
                      return (
                        <div
                          key={at.id || i}
                          data-processing-attachment={at.id || i}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 11,
                            border: `1px solid ${T.border}`,
                            borderRadius: 12,
                            padding: 12,
                            width: 222,
                            maxWidth: '100%',
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
                        </div>
                      );
                    })}
                  </div>
                )}
                <div style={{fontSize: 11.5, color: T.faint, fontWeight: 600, marginTop: 8}}>
                  Attachments are populated from the Asana import. In-app upload is coming soon.
                </div>
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

              {/* Archive (soft delete) an Asana-owned record (operational roles) */}
              {isArchivable && canOperate && (
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
