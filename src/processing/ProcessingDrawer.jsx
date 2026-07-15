// ============================================================================
// src/processing/ProcessingDrawer.jsx  —  Processing record detail drawer
// ----------------------------------------------------------------------------
// Right-side slide-in (scrim + ~460px panel) opened by a row on the calendar.
// Loads get_processing_record (record + subtasks[] + attachments[] +
// completion_blockers[]) and renders the FIXED record page (planner-integration
// lane — the configurable template-field Details section is retired along with
// set_processing_field):
//   • OWNERSHIP MATRIX: source facts arrive as the server's LIVE planner
//     projection (record.source + record.animals) and are READ-ONLY here — the
//     'Source details' section renders them per program with the canonical
//     'Not recorded' for anything missing (never estimated). Processing-owned
//     edits: Processor, Customer (broiler, SINGLE select), and subtasks.
//     Milestones stay fully Processing-owned (title + date incl. explicit
//     clear + canonical status + processor + customer) and deletable. Batch
//     title and status are never directly editable (planner-owned).
//   • Source back-link: sourceRouteForRecord navigates to the exact native
//     planner page (pig links focus the exact trip) via react-router navigate
//     — the same mechanism every cross-record link in the app uses.
//   • Option lists are stable {id,label,active} objects (mig 175): pickers
//     offer ACTIVE labels; a stored value matching an inactive/off-list label
//     renders as '<label> (legacy)' until deliberately replaced.
//   • Subtasks: toggle done, add (with assignee), rename, profile-backed
//     reassign incl. clear, delete, reorder (up/down). 'Apply template' first
//     fetches preview_latest_template and shows a compact diff (additions /
//     renames / assignment changes / removed-step note) behind Confirm/Cancel;
//     an up-to-date checklist shows 'Checklist is up to date.' and no confirm.
//   • Completion is a GATED manual action driven by the SERVER's
//     completion_blockers only (no client mirror) — the button disables while
//     blockers exist; checklist toggles reconcile them SILENTLY, every other
//     mutation reloads them.
//   • Attachments: list (filename / size_bytes), signed open/download, and an
//     operational "Add files" upload into the native/ namespace.
//   • Comments + activity via the shared RecordCollaborationSection.
// Every mutation reloads the drawer AND calls onChanged so the list refreshes —
// EXCEPT checklist toggles: those patch the clicked subtask in place, silently
// refetch the record (no visible loading state), and patch ONLY the parent
// row's subtask counts through onSubtaskCountsChanged (never a full reload).
// ============================================================================
import React from 'react';
import {useNavigate} from 'react-router-dom';
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
  reorderProcessingSubtasks,
  applyCurrentTemplate,
  previewLatestTemplate,
  updateProcessingMilestone,
  deleteProcessingMilestone,
  archiveProcessingRecord,
  isProcessingValidationError,
  friendlyProcessingError,
} from '../lib/processingApi.js';
import {uploadProcessingAttachment, getProcessingAttachmentUrl} from '../lib/processingAttachmentsApi.js';
import {
  sourceRouteForRecord,
  sourceLinkLabel,
  weeksDaysText,
  yearsMonthsText,
  ageRangeText,
  displayOrNotRecorded,
  pigPlanSignal,
  NOT_RECORDED,
} from '../lib/processingSourceLink.js';
import {processingStatusLabel, processingStatusVariantFromLabel} from '../lib/processingStatusDisplay.js';
import {activeOptionLabels} from '../lib/processingFields.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import Badge from '../shared/Badge.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import StatusText from '../shared/StatusText.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';

const OPERATIONAL_ROLES = ['admin', 'management', 'farm_team'];
// Fallback only if the settings-backed customer_options can't be fetched; the
// live list comes from get_processing_settings (mig 175) via the customerOptions
// prop. See ProcessingOptionsEditor (inside Templates) for editing.
const CUSTOMER_OPTIONS_FALLBACK = ["Sonny's", 'Coastal Pastures - CONFIRMED', 'Coastal Pastures - POTENTIAL'];
// Sentinel select value representing a stored MULTI-customer set on an old
// record — never persisted; selecting anything else replaces the whole set.
const LEGACY_MULTI_CUSTOMER = '__legacy_multi_customer__';

// Stable comparison for the legacy array-backed customer column ([] / [value]
// / old multi-value sets) — used to roll back only our own optimistic value.
const canonCustomer = (v) => JSON.stringify(Array.isArray(v) ? v : []);

const T = {
  card: '#fff',
  border: '#E6E8EB',
  rowBorder: '#F0F1F3',
  tint: '#FAFBFB',
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
  return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : null;
}
function isoDateInput(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
function kbText(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
function countText(value) {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) ? n.toLocaleString() : null;
}
function weightText(value) {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) ? `${n.toLocaleString()} lb` : null;
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

// Read-only source-owned value: any missing value renders the canonical
// 'Not recorded' in supporting gray — never an estimate.
// eslint-disable-next-line no-unused-vars -- JSX-only use
function SourceValue({value}) {
  const text = displayOrNotRecorded(value);
  const missing = text === NOT_RECORDED;
  return (
    <span style={{fontSize: 13.5, color: missing ? T.faint : T.ink, fontWeight: missing ? 600 : 700}}>{text}</span>
  );
}

// Compact read-only animals table (Source details). Columns are provided as
// {key, label, align?, render(row, index)}; every missing cell value renders
// 'Not recorded'.
// eslint-disable-next-line no-unused-vars -- JSX-only use
function AnimalsTable({columns, rows}) {
  const grid = columns.map((c, i) => (i === 0 ? 'minmax(64px,1.2fr)' : 'minmax(70px,1fr)')).join(' ');
  return (
    <div
      data-processing-animals-table={rows.length}
      style={{border: `1px solid ${T.rowBorder}`, borderRadius: 12, overflow: 'hidden', marginTop: 10}}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: grid,
          columnGap: 10,
          padding: '7px 12px',
          background: T.tint,
        }}
      >
        {columns.map((c) => (
          <span
            key={c.key}
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: T.faint,
              ...(c.align === 'right' ? {textAlign: 'right'} : {}),
            }}
          >
            {c.label}
          </span>
        ))}
      </div>
      {rows.map((row, i) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: grid,
            columnGap: 10,
            padding: '7px 12px',
            borderTop: `1px solid ${T.rowBorder}`,
            alignItems: 'center',
          }}
        >
          {columns.map((c) => {
            const text = displayOrNotRecorded(c.render(row, i));
            const missing = text === NOT_RECORDED;
            return (
              <span
                key={c.key}
                style={{
                  fontSize: 12.5,
                  fontWeight: missing ? 600 : 700,
                  color: missing ? T.faint : T.ink,
                  fontVariantNumeric: 'tabular-nums',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  ...(c.align === 'right' ? {textAlign: 'right'} : {}),
                }}
              >
                {text}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export default function ProcessingDrawer({
  sb,
  authState,
  recordId,
  onClose,
  onChanged,
  onSubtaskCountsChanged,
  onProcessorChanged,
  onCustomerChanged,
  customerOptions = [],
  processorOptions = [],
  profilesById = {},
}) {
  const {useState, useEffect, useCallback, useRef, useMemo} = React;
  const navigate = useNavigate();
  const role = authState?.role;
  const canOperate = OPERATIONAL_ROLES.includes(role);

  const [data, setData] = useState(null); // {record, subtasks, attachments, completion_blockers}
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  // Local editable buffers.
  const [titleDraft, setTitleDraft] = useState('');
  const [dateDraft, setDateDraft] = useState('');
  const [newSubtask, setNewSubtask] = useState('');
  const [newSubtaskAssignee, setNewSubtaskAssignee] = useState('');
  const [editingSubtaskId, setEditingSubtaskId] = useState(null);
  const [editingSubtaskLabel, setEditingSubtaskLabel] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  // Apply-template preview: null = closed; otherwise the server's read-only
  // diff from preview_latest_template.
  const [templatePreview, setTemplatePreview] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const notifyRef = useRef(onChanged);
  notifyRef.current = onChanged;
  const countsChangedRef = useRef(onSubtaskCountsChanged);
  countsChangedRef.current = onSubtaskCountsChanged;
  const processorChangedRef = useRef(onProcessorChanged);
  processorChangedRef.current = onProcessorChanged;
  const customerChangedRef = useRef(onCustomerChanged);
  customerChangedRef.current = onCustomerChanged;
  const fileInputRef = useRef(null);
  // Quiet-autosave plumbing (dedicated no-reload paths — checklist toggle,
  // Processor select, Customer select, subtask Assignee select):
  //   • fetchSeqRef — monotonic token bumped by EVERY record fetch (load or
  //     silent); a response applies only while its token is still current, so
  //     stale/out-of-order responses can never overwrite fresher data.
  //   • recordIdRef — the drawer's live record id; a silent refetch started
  //     for a record the drawer has moved away from is skipped.
  //   • pendingSubtasksRef — subtask id -> optimistic done value while its RPC
  //     is in flight. A Map ref (not state) so async continuations always see
  //     the live set; the state Set mirrors it only to disable that checkbox.
  //   • pendingAssigneesRef — subtask id -> optimistic {assignee_profile_id,
  //     assignee} while its assignment RPC is in flight; the state Set mirrors
  //     it only to disable that subtask's Assignee select.
  //   • pendingProcessorRef — {recordId, value} while a Processor write is in
  //     flight (one at a time); the state boolean disables only that select.
  const fetchSeqRef = useRef(0);
  const recordIdRef = useRef(recordId);
  recordIdRef.current = recordId;
  const pendingSubtasksRef = useRef(new Map());
  const [pendingSubtaskIds, setPendingSubtaskIds] = useState(() => new Set());
  const pendingAssigneesRef = useRef(new Map());
  const [pendingAssigneeIds, setPendingAssigneeIds] = useState(() => new Set());
  const pendingProcessorRef = useRef(null);
  const [processorPending, setProcessorPending] = useState(false);
  const pendingCustomerRef = useRef(null);
  const [customerPending, setCustomerPending] = useState(false);

  // Live view of the latest rendered payload for async continuations (the
  // checklist fallback count) — same render-sync pattern as recordIdRef.
  const dataRef = useRef(null);
  dataRef.current = data;

  const record = data?.record || null;
  const subtasks = Array.isArray(data?.subtasks) ? data.subtasks : [];
  const attachments = Array.isArray(data?.attachments) ? data.attachments : [];
  // SERVER-authoritative completion gate — no client mirror. Generic mutations
  // reload the drawer; checklist toggles silently refetch — either way the
  // blockers refresh alongside the record.
  const blockers = Array.isArray(data?.completion_blockers) ? data.completion_blockers : [];

  // Re-apply in-flight optimistic values (checkbox done state, subtask
  // assignee, record Processor) over a fresh server payload so a fetch that
  // raced an unresolved write can never flicker the control back. Each map is
  // consulted independently, so a simultaneous checkbox write and assignee
  // write — on the same or different subtasks — both survive any refetch.
  const withPendingSubtaskOverrides = useCallback((d) => {
    if (!d) return d;
    let out = d;
    const pendingDone = pendingSubtasksRef.current;
    const pendingAssign = pendingAssigneesRef.current;
    if ((pendingDone.size || pendingAssign.size) && Array.isArray(out.subtasks)) {
      out = {
        ...out,
        subtasks: out.subtasks.map((s) => {
          let next = s;
          if (pendingDone.has(s.id)) next = {...next, done: pendingDone.get(s.id)};
          const assign = pendingAssign.get(s.id);
          if (assign) {
            next = {...next, assignee_profile_id: assign.assignee_profile_id, assignee: assign.assignee};
          }
          return next;
        }),
      };
    }
    const pendingProcessor = pendingProcessorRef.current;
    if (pendingProcessor && out.record && out.record.id === pendingProcessor.recordId) {
      out = {...out, record: {...out.record, processor: pendingProcessor.value}};
    }
    const pendingCustomer = pendingCustomerRef.current;
    if (pendingCustomer && out.record && out.record.id === pendingCustomer.recordId) {
      out = {...out, record: {...out.record, customer: pendingCustomer.value}};
    }
    return out;
  }, []);

  const load = useCallback(async () => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const d = await getProcessingRecord(sb, recordId);
      if (seq !== fetchSeqRef.current) return; // superseded by a newer fetch
      setData(withPendingSubtaskOverrides(d));
      if (d && d.record) {
        setTitleDraft(d.record.title || '');
        setDateDraft(isoDateInput(d.record.processing_date));
      }
    } catch (e) {
      if (seq !== fetchSeqRef.current) return;
      setData(null);
      setLoadError({message: `Could not load this record. Please retry. (${(e && e.message) || e})`});
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [sb, recordId, withPendingSubtaskOverrides]);

  useEffect(() => {
    load();
  }, [load]);

  // Silent server reconcile for the checklist path: refetch the record WITHOUT
  // the drawer's visible loading state so subtasks (counts, completed_at) and
  // the server-owned completion_blockers stay authoritative while the drawer
  // stays mounted and stable. Skipped once the drawer has moved to another
  // record; a superseded response is discarded, never applied.
  const silentRefreshRecord = useCallback(async () => {
    if (recordId !== recordIdRef.current) return null;
    const seq = ++fetchSeqRef.current;
    const d = await getProcessingRecord(sb, recordId);
    if (seq !== fetchSeqRef.current || recordId !== recordIdRef.current) return null;
    setData(withPendingSubtaskOverrides(d));
    setLoadError(null);
    setLoading(false); // no-op normally; completes a superseded visible load
    return d;
  }, [sb, recordId, withPendingSubtaskOverrides]);

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
  const statusLabel = record ? processingStatusLabel(record.effective_status) : '';
  const displayVariant = processingStatusVariantFromLabel(statusLabel);
  const isComplete = record ? record.completed_at != null || record.effective_status === 'complete' : false;
  // Live planner projection (mig 176): null / matched:false means the source
  // row is gone or was never linked — no Source details, no back-link.
  const source = record && record.source && record.source.matched !== false ? record.source : null;
  const animals = Array.isArray(record?.animals) ? record.animals : [];
  const sourceRoute = source ? sourceRouteForRecord(record) : null;

  // Picker choices: ACTIVE option labels only (stable {id,label,active}
  // objects, shape-tolerant of the legacy string arrays). A stored value that
  // is off-list OR matches an INACTIVE option's label renders as '(legacy)'.
  const processorChoices = useMemo(() => activeOptionLabels(processorOptions), [processorOptions]);
  const customerActiveLabels = useMemo(() => activeOptionLabels(customerOptions), [customerOptions]);
  const customerBaseOptions = customerActiveLabels.length ? customerActiveLabels : CUSTOMER_OPTIONS_FALLBACK;
  // Customer (broiler) — SINGLE select stored in the array-backed column as []
  // or [value]. MULTIPLE stored values (old records) surface as ONE
  // "(legacy — multiple)" option until deliberately replaced or cleared.
  const customerSelected = useMemo(() => (Array.isArray(record?.customer) ? record.customer : []), [record?.customer]);
  const customerLegacyMulti = customerSelected.length > 1;
  const customerCurrent = customerSelected.length === 1 ? customerSelected[0] : '';
  const customerSelectValue = customerLegacyMulti ? LEGACY_MULTI_CUSTOMER : customerCurrent;

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

  // ── field mutations (Processing-owned) ─────────────────────────────────────
  // Processor — DEDICATED no-reload autosave path (NOT runMutation), same
  // contract as the checklist toggle: patch the select optimistically, save
  // through the existing RPC wrapper, silently reconcile the record so the
  // server-owned completion_blockers update, and narrowly patch the parent
  // schedule row's processor after CONFIRMED success. The drawer never shows
  // its loading state and the schedule never reloads for a Processor pick; a
  // failure rolls this select back with the existing inline error treatment
  // and publishes nothing to the parent.
  async function saveProcessorSelect(value) {
    if (!canOperate || !record) return;
    if (pendingProcessorRef.current) return; // one in-flight Processor write
    const rid = record.id;
    const prior = record.processor || null;
    const next = value || null;
    if ((prior || '') === (next || '')) return;
    pendingProcessorRef.current = {recordId: rid, value: next};
    setProcessorPending(true);
    setNotice(null);
    setData((d) => (d && d.record && d.record.id === rid ? {...d, record: {...d.record, processor: next}} : d));
    try {
      await setProcessingProcessor(sb, rid, next);
      // The write landed — publish the CONFIRMED value to the matching
      // schedule row only (processor filtering derives from that field).
      if (processorChangedRef.current) processorChangedRef.current(rid, next);
      try {
        await silentRefreshRecord();
      } catch (_e) {
        /* tolerated — blockers refresh on the next mutation/load */
      }
    } catch (e) {
      // The write failed: unregister the pending value FIRST so a racing
      // refetch cannot re-apply the failed optimism, then roll back ONLY our
      // own still-displayed optimistic value on this record. The parent was
      // never patched for a failed write.
      pendingProcessorRef.current = null;
      if (recordIdRef.current === rid) {
        setData((d) =>
          d && d.record && d.record.id === rid && (d.record.processor || null) === next
            ? {...d, record: {...d.record, processor: prior}}
            : d,
        );
      }
      if (isProcessingValidationError(e)) {
        setNotice({kind: 'error', message: friendlyProcessingError(e)});
      } else {
        setNotice({kind: 'error', message: `Something went wrong. Please retry. (${(e && e.message) || e})`});
      }
    } finally {
      pendingProcessorRef.current = null;
      setProcessorPending(false);
    }
  }
  // Customer — same DEDICATED no-reload autosave contract as Processor
  // (broiler-only TRUE single select stored in the legacy array-backed
  // column): optimistic [] / [value] patch, direct RPC, silent reconcile,
  // narrow parent row patch after CONFIRMED success, rollback + inline error
  // on failure. The legacy-multiple sentinel stays a pure no-op.
  async function saveCustomerSelect(value) {
    if (!canOperate || !record) return;
    // The legacy-multiple option IS the stored state — picking it changes nothing.
    if (value === LEGACY_MULTI_CUSTOMER) return;
    if (!customerLegacyMulti && (customerCurrent || '') === (value || '')) return;
    if (pendingCustomerRef.current) return; // one in-flight Customer write
    const rid = record.id;
    const prior = customerSelected;
    const next = value ? [value] : [];
    pendingCustomerRef.current = {recordId: rid, value: next};
    setCustomerPending(true);
    setNotice(null);
    setData((d) => (d && d.record && d.record.id === rid ? {...d, record: {...d.record, customer: next}} : d));
    try {
      await setProcessingCustomer(sb, rid, next);
      // The write landed — publish the CONFIRMED value to the matching
      // schedule row only.
      if (customerChangedRef.current) customerChangedRef.current(rid, next);
      try {
        await silentRefreshRecord();
      } catch (_e) {
        /* tolerated — blockers refresh on the next mutation/load */
      }
    } catch (e) {
      // The write failed: unregister the pending value FIRST so a racing
      // refetch cannot re-apply the failed optimism, then roll back ONLY our
      // own still-displayed optimistic value on this record. The parent was
      // never patched for a failed write.
      pendingCustomerRef.current = null;
      if (recordIdRef.current === rid) {
        setData((d) =>
          d && d.record && d.record.id === rid && canonCustomer(d.record.customer) === canonCustomer(next)
            ? {...d, record: {...d.record, customer: prior}}
            : d,
        );
      }
      if (isProcessingValidationError(e)) {
        setNotice({kind: 'error', message: friendlyProcessingError(e)});
      } else {
        setNotice({kind: 'error', message: `Something went wrong. Please retry. (${(e && e.message) || e})`});
      }
    } finally {
      pendingCustomerRef.current = null;
      setCustomerPending(false);
    }
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

  // ── completion (server-gated) ──────────────────────────────────────────────
  function markComplete() {
    runMutation(() => markProcessingComplete(sb, record.id));
  }
  function reopen() {
    runMutation(() => reopenProcessingRecord(sb, record.id));
  }

  // ── subtasks ───────────────────────────────────────────────────────────────
  // Checklist toggle — DEDICATED no-reload path (NOT runMutation): patch the
  // clicked subtask in place, lock only that checkbox while its RPC is in
  // flight, then silently reconcile the record (subtasks + completion_blockers)
  // and narrowly patch the parent row's counts. The drawer never shows its
  // loading state and the schedule never reloads for a checkbox. Completing the
  // last subtask never auto-completes the record — completion stays a separate
  // gated action.
  async function toggleSubtask(st) {
    if (!canOperate || busy) return;
    if (pendingSubtasksRef.current.has(st.id)) return; // one in-flight write per subtask
    const nextDone = !st.done;
    pendingSubtasksRef.current.set(st.id, nextDone);
    setPendingSubtaskIds(new Set(pendingSubtasksRef.current.keys()));
    setNotice(null);
    setData((d) => {
      if (!d || !Array.isArray(d.subtasks)) return d;
      return {...d, subtasks: d.subtasks.map((s) => (s.id === st.id ? {...s, done: nextDone} : s))};
    });
    try {
      await setProcessingSubtaskDone(sb, st.id, nextDone);
      // The write landed. A reconcile failure must NOT roll the toggle back —
      // the optimistic state already matches the server.
      let fresh = null;
      try {
        fresh = await silentRefreshRecord();
      } catch (_e) {
        /* tolerated — blockers refresh on the next mutation/load */
      }
      // Publish CONFIRMED counts only — an unconfirmed pending toggle must
      // never reach the schedule row (it would stick if that write failed;
      // pending optimism stays drawer-local and each toggle publishes its own
      // outcome when it resolves).
      if (countsChangedRef.current) {
        let list;
        if (Array.isArray(fresh?.subtasks)) {
          // Authoritative: the RAW server payload (confirmed writes only —
          // no pending overrides applied here, unlike the drawer display).
          list = fresh.subtasks;
        } else {
          // Fallback (refresh failed/skipped/superseded): latest drawer data
          // normalized to confirmed values — every OTHER still-pending toggle
          // reverts to its prior value (toggles flip booleans, so prior is
          // the negation) and only THIS known-landed write is added.
          const overrides = pendingSubtasksRef.current;
          const base = Array.isArray(dataRef.current?.subtasks) ? dataRef.current.subtasks : subtasks;
          list = base.map((s) => {
            if (s.id === st.id) return {...s, done: nextDone};
            const pend = overrides.get(s.id);
            return pend === undefined ? s : {...s, done: !pend};
          });
        }
        countsChangedRef.current(recordId, {done: list.filter((s) => s.done).length, total: list.length});
      }
    } catch (e) {
      // The write failed: restore the prior state for THIS subtask only, with
      // the existing inline error treatment. Unregister the pending value
      // FIRST so a concurrent refetch cannot re-apply the failed optimism.
      // The schedule row needs no correction — unconfirmed optimism is never
      // published to the parent, so it never saw this toggle.
      pendingSubtasksRef.current.delete(st.id);
      setData((d) => {
        if (!d || !Array.isArray(d.subtasks)) return d;
        return {
          ...d,
          subtasks: d.subtasks.map((s) => (s.id === st.id ? {...s, done: st.done, completed_at: st.completed_at} : s)),
        };
      });
      if (isProcessingValidationError(e)) {
        setNotice({kind: 'error', message: friendlyProcessingError(e)});
      } else {
        setNotice({kind: 'error', message: `Something went wrong. Please retry. (${(e && e.message) || e})`});
      }
    } finally {
      pendingSubtasksRef.current.delete(st.id);
      setPendingSubtaskIds(new Set(pendingSubtasksRef.current.keys()));
    }
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
  // Assignee — DEDICATED no-reload autosave path (NOT runMutation), same
  // contract as the checklist toggle: patch ONLY the selected subtask
  // optimistically (assigning a profile also clears an imported-name fallback,
  // mirroring the server's column semantics; clearing nulls both), save
  // through the existing RPC (server-owned Activity + assignment notification
  // rules unchanged), then silently reconcile the record. No parent patch —
  // assignment never changes schedule summary counts. A failure restores the
  // exact prior assignment with the existing inline error treatment.
  async function reassignSubtask(st, profileId) {
    if (!canOperate || !record) return;
    if (pendingAssigneesRef.current.has(st.id)) return; // one in-flight assignment per subtask
    const rid = record.id;
    const next = profileId || null;
    const prior = {assignee_profile_id: st.assignee_profile_id ?? null, assignee: st.assignee ?? null};
    if ((prior.assignee_profile_id || null) === next && (next !== null || !prior.assignee)) return;
    const optimistic = {assignee_profile_id: next, assignee: null};
    pendingAssigneesRef.current.set(st.id, optimistic);
    setPendingAssigneeIds(new Set(pendingAssigneesRef.current.keys()));
    setNotice(null);
    setData((d) => {
      if (!d || !Array.isArray(d.subtasks)) return d;
      return {...d, subtasks: d.subtasks.map((s) => (s.id === st.id ? {...s, ...optimistic} : s))};
    });
    try {
      await updateProcessingSubtask(sb, next ? {id: st.id, assigneeProfileId: next} : {id: st.id, clearAssignee: true});
      // The write landed. A reconcile failure must NOT roll the value back —
      // the optimistic state already matches the server.
      try {
        await silentRefreshRecord();
      } catch (_e) {
        /* tolerated — the next mutation/load reconciles */
      }
    } catch (e) {
      // The write failed: unregister the pending value FIRST so a racing
      // refetch cannot re-apply the failed optimism, then restore the exact
      // prior assignment (profile id AND imported text) on THIS subtask only,
      // and only while the drawer still shows this record.
      pendingAssigneesRef.current.delete(st.id);
      if (recordIdRef.current === rid) {
        setData((d) => {
          if (!d || !Array.isArray(d.subtasks)) return d;
          return {...d, subtasks: d.subtasks.map((s) => (s.id === st.id ? {...s, ...prior} : s))};
        });
      }
      if (isProcessingValidationError(e)) {
        setNotice({kind: 'error', message: friendlyProcessingError(e)});
      } else {
        setNotice({kind: 'error', message: `Something went wrong. Please retry. (${(e && e.message) || e})`});
      }
    } finally {
      pendingAssigneesRef.current.delete(st.id);
      setPendingAssigneeIds(new Set(pendingAssigneesRef.current.keys()));
    }
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

  // ── apply template: preview first, then confirm ────────────────────────────
  async function openTemplatePreview() {
    setPreviewBusy(true);
    setNotice(null);
    try {
      const preview = await previewLatestTemplate(sb, record.id);
      setTemplatePreview(preview || {});
    } catch (e) {
      setNotice({
        kind: 'error',
        message: isProcessingValidationError(e)
          ? friendlyProcessingError(e)
          : `Could not preview the template. Please retry. (${(e && e.message) || e})`,
      });
    } finally {
      setPreviewBusy(false);
    }
  }
  function confirmApplyTemplate() {
    runMutation(() => applyCurrentTemplate(sb, record.id)).then((ok) => {
      if (ok) setTemplatePreview(null);
    });
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

  // ── Source details rows per program (read-only; planner-owned) ─────────────
  function renderSourceDetails() {
    if (isMilestone || !record || !source) return null;
    const kind = record.source_kind;
    const programName = kind === 'sheep' ? 'sheep' : kind; // planner names; Lamb == sheep planner
    const pigSignal = pigPlanSignal(record);
    const isPigActual = kind === 'pig' && (source.phase || record.source_phase) === 'actual';
    const processingDateText = formatDate(source.processing_date);
    return (
      <div style={{marginTop: 22}} data-processing-source-section={kind}>
        <div style={{display: 'flex', alignItems: 'center', gap: 9, marginBottom: 2}}>
          <span style={{fontSize: 14, fontWeight: 800, color: T.ink}}>Source details</span>
          {sourceRoute && (
            <button
              type="button"
              data-processing-source-link={kind}
              onClick={() => navigate(sourceRoute)}
              style={{
                marginLeft: 'auto',
                background: 'none',
                border: 'none',
                color: T.green,
                fontSize: 12.5,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: 'inherit',
                padding: 0,
                whiteSpace: 'nowrap',
              }}
            >
              {sourceLinkLabel(record)} ↗
            </button>
          )}
        </div>
        <div style={{fontSize: 11.5, color: T.faint, fontWeight: 600, marginBottom: 6}}>
          Source facts are owned by the {programName} planner and read-only here.
        </div>

        {kind === 'broiler' && (
          <div>
            <FieldRow label="Batch">
              <SourceValue value={source.batch_name} />
            </FieldRow>
            <FieldRow label="Hatch date">
              <SourceValue value={formatDate(source.hatch_date)} />
            </FieldRow>
            <FieldRow label="Processing date">
              <SourceValue value={processingDateText} />
            </FieldRow>
            <FieldRow label="Age">
              <SourceValue value={weeksDaysText(source.age_days)} />
            </FieldRow>
            <FieldRow label="Count">
              <SourceValue value={countText(record.live_count)} />
            </FieldRow>
            {/* Processor/Customer are Processing-owned and already editable in
                the core fields above — never repeated as source rows. */}
          </div>
        )}

        {(kind === 'cattle' || kind === 'sheep') && (
          <div>
            <FieldRow label="Batch">
              <SourceValue value={source.batch_name} />
            </FieldRow>
            <FieldRow label="Processing date">
              <SourceValue
                value={
                  processingDateText
                    ? source.is_actual_date === false
                      ? `${processingDateText} (planned)`
                      : processingDateText
                    : null
                }
              />
            </FieldRow>
            <FieldRow label="Count">
              <SourceValue value={countText(record.live_count)} />
            </FieldRow>
            <FieldRow label="Age">
              <SourceValue value={ageRangeText(source.age, yearsMonthsText)} />
            </FieldRow>
            {animals.length > 0 ? (
              <AnimalsTable
                rows={animals}
                columns={[
                  {key: 'tag', label: 'Tag', render: (a) => a.tag},
                  {key: 'age', label: 'Age', render: (a) => yearsMonthsText(a.age_days)},
                  {key: 'live', label: 'Live weight', align: 'right', render: (a) => weightText(a.live_weight)},
                  {key: 'hang', label: 'Hanging weight', align: 'right', render: (a) => weightText(a.hanging_weight)},
                ]}
              />
            ) : (
              <div style={{fontSize: 12.5, color: T.faint, fontWeight: 600, padding: '8px 0 2px'}}>
                No animals recorded on the source batch.
              </div>
            )}
          </div>
        )}

        {kind === 'pig' && (
          <div>
            <FieldRow label="Batch">
              <SourceValue value={source.batch_name} />
            </FieldRow>
            <FieldRow label="Trip">
              <SourceValue value={record.trip_ordinal != null ? `Trip ${record.trip_ordinal}` : null} />
            </FieldRow>
            {pigSignal && (
              <FieldRow label="Phase">
                <StatusText tone="muted" style={{fontSize: 12.5}}>
                  {pigSignal}
                </StatusText>
              </FieldRow>
            )}
            <FieldRow label="Processing date">
              <SourceValue value={processingDateText} />
            </FieldRow>
            <FieldRow label="Count">
              <SourceValue value={countText(record.live_count)} />
            </FieldRow>
            {/* Planned trips have no animal rows — only ACTUAL trips list the
                linked weigh-in live weights, labelled Pig 1..N in order. */}
            {isPigActual &&
              (animals.length > 0 ? (
                <AnimalsTable
                  rows={animals}
                  columns={[
                    {key: 'pig', label: 'Pig', render: (_a, i) => `Pig ${i + 1}`},
                    {key: 'live', label: 'Live weight', align: 'right', render: (a) => weightText(a.live_weight)},
                  ]}
                />
              ) : (
                <div style={{fontSize: 12.5, color: T.faint, fontWeight: 600, padding: '8px 0 2px'}}>
                  No live weights recorded on this trip.
                </div>
              ))}
          </div>
        )}
      </div>
    );
  }

  // ── Apply-template preview panel ───────────────────────────────────────────
  function renderTemplatePreview() {
    if (!templatePreview) return null;
    const additions = Array.isArray(templatePreview.additions) ? templatePreview.additions : [];
    const renames = Array.isArray(templatePreview.renames) ? templatePreview.renames : [];
    const assignments = Array.isArray(templatePreview.assignment_changes) ? templatePreview.assignment_changes : [];
    const removedBlocked = Array.isArray(templatePreview.removed_blocked) ? templatePreview.removed_blocked : [];
    const upToDate = !!templatePreview.up_to_date;
    const listStyle = {margin: '4px 0 8px', paddingLeft: 18, fontSize: 12.5, color: T.ink, fontWeight: 600};
    return (
      <div
        data-processing-apply-template-preview="1"
        style={{
          border: `1px solid ${T.border}`,
          borderRadius: 12,
          background: T.tint,
          padding: '10px 12px',
          margin: '4px 0 10px',
        }}
      >
        {upToDate ? (
          <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
            <span style={{fontSize: 12.5, color: '#1F7A4D', fontWeight: 700}}>Checklist is up to date.</span>
            <button type="button" onClick={() => setTemplatePreview(null)} style={{...ghostBtn, marginLeft: 'auto'}}>
              Close
            </button>
          </div>
        ) : (
          <>
            <div style={{fontSize: 12.5, color: T.ink, fontWeight: 700, marginBottom: 4}}>
              {`Template v${templatePreview.template_version ?? '—'}: `}
              {additions.length} addition{additions.length === 1 ? '' : 's'}, {renames.length} rename
              {renames.length === 1 ? '' : 's'}, {assignments.length} assignment change
              {assignments.length === 1 ? '' : 's'}.
            </div>
            {additions.length > 0 && (
              <ul style={listStyle}>
                {additions.map((a, i) => (
                  <li key={`add-${i}`}>+ {a.label}</li>
                ))}
              </ul>
            )}
            {renames.length > 0 && (
              <ul style={listStyle}>
                {renames.map((r, i) => (
                  <li key={`ren-${i}`}>
                    {r.from} → {r.to}
                  </li>
                ))}
              </ul>
            )}
            {assignments.length > 0 && (
              <ul style={listStyle}>
                {assignments.map((a, i) => (
                  <li key={`asg-${i}`}>
                    {a.label} → {profileName(a.assignee_profile_id) || 'assigned user'}
                  </li>
                ))}
              </ul>
            )}
            {removedBlocked.length > 0 && (
              <div style={{fontSize: 11.5, color: T.faint, fontWeight: 600, marginBottom: 8}}>
                {removedBlocked.length} previously removed step{removedBlocked.length === 1 ? '' : 's'} stay
                {removedBlocked.length === 1 ? 's' : ''} removed: {removedBlocked.map((r) => r.label).join(', ')}
              </div>
            )}
            <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
              <button
                type="button"
                onClick={confirmApplyTemplate}
                disabled={busy}
                data-processing-apply-template-confirm
                style={primaryBtn(busy)}
              >
                Apply changes
              </button>
              <button type="button" onClick={() => setTemplatePreview(null)} disabled={busy} style={ghostBtn}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

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

              {/* Title — batch titles are planner-owned and read-only */}
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

              {/* Core fields — status is not directly editable on batches */}
              <div>
                <FieldRow label="Status">
                  {isMilestone && canOperate ? (
                    <select
                      value={
                        ['planned', 'in_process', 'complete'].includes(record.effective_status)
                          ? record.effective_status
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

                {/* Milestone date is Processing-owned; a source-linked batch
                    shows its date inside Source details. Unlinked batches keep
                    a read-only date + count row here so nothing is lost. */}
                {isMilestone ? (
                  <FieldRow label="Processing date">
                    {canOperate ? (
                      <input
                        type="date"
                        value={dateDraft}
                        onChange={(e) => setDateDraft(e.target.value)}
                        onBlur={saveMilestoneDate}
                        style={{...inputStyle, textAlign: 'right'}}
                        data-processing-milestone-date
                      />
                    ) : (
                      <SourceValue value={formatDate(record.processing_date)} />
                    )}
                  </FieldRow>
                ) : (
                  !source && (
                    <>
                      <FieldRow label="Processing date">
                        <SourceValue value={formatDate(record.processing_date)} />
                      </FieldRow>
                      <FieldRow label="Count">
                        <SourceValue value={countText(record.live_count ?? record.number_processed)} />
                      </FieldRow>
                    </>
                  )
                )}

                {/* Processor — TRUE SELECT from the admin-configured ACTIVE
                    processor options. Arbitrary typing is impossible; a stored
                    off-list or deactivated value stays visible + selectable as
                    (legacy) until deliberately replaced; '—' clears. */}
                <FieldRow label="Processor">
                  {canOperate ? (
                    <select
                      value={record.processor || ''}
                      disabled={busy || processorPending}
                      onChange={(e) => saveProcessorSelect(e.target.value)}
                      aria-label="Processor"
                      data-processing-processor-select
                      style={{...inputStyle, maxWidth: 220}}
                    >
                      <option value="">—</option>
                      {record.processor && !processorChoices.includes(record.processor) && (
                        <option value={record.processor}>{record.processor} (legacy)</option>
                      )}
                      {processorChoices.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span style={{fontSize: 13.5, color: record.processor ? T.ink : T.faint, fontWeight: 600}}>
                      {record.processor || '—'}
                    </span>
                  )}
                </FieldRow>

                {/* Customer — broiler only, TRUE SINGLE SELECT from the ACTIVE
                    customer options, matching the Processor control. '—'
                    clears; a stored off-list/deactivated value shows as
                    (legacy); an old multi-customer set shows as ONE
                    (legacy — multiple) option until deliberately replaced. */}
                {isBroiler && (
                  <FieldRow label="Customer">
                    {canOperate ? (
                      <select
                        value={customerSelectValue}
                        disabled={busy || customerPending}
                        onChange={(e) => saveCustomerSelect(e.target.value)}
                        aria-label="Customer"
                        data-processing-customer-select
                        style={{...inputStyle, maxWidth: 220}}
                      >
                        <option value="">—</option>
                        {customerLegacyMulti && (
                          <option value={LEGACY_MULTI_CUSTOMER}>
                            {customerSelected.join(' + ')} (legacy — multiple)
                          </option>
                        )}
                        {customerCurrent && !customerBaseOptions.includes(customerCurrent) && (
                          <option value={customerCurrent}>{customerCurrent} (legacy)</option>
                        )}
                        {customerBaseOptions.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span style={{fontSize: 13, color: T.muted, fontWeight: 600}}>
                        {customerSelected.length ? customerSelected.join(', ') : '—'}
                      </span>
                    )}
                  </FieldRow>
                )}
              </div>

              {/* Source details — live planner projection, read-only */}
              {renderSourceDetails()}

              {/* Subtasks */}
              {!isMilestone && (
                <div style={{marginTop: 22}}>
                  <div style={{display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8}}>
                    <span style={{fontSize: 14, fontWeight: 800, color: T.ink}}>Subtasks</span>
                    <span
                      data-processing-subtask-count
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
                        onClick={openTemplatePreview}
                        disabled={busy || previewBusy}
                        data-processing-apply-template
                        style={{...ghostBtn, marginLeft: 'auto'}}
                      >
                        {previewBusy ? 'Checking…' : 'Apply template'}
                      </button>
                    )}
                  </div>

                  {canOperate && renderTemplatePreview()}

                  {subtasks.length === 0 && (
                    <div style={{fontSize: 12.5, color: T.faint, fontWeight: 600, padding: '6px 0'}}>
                      No subtasks yet.
                    </div>
                  )}

                  {subtasks.map((st, idx) => {
                    const doneDate = st.done && st.completed_at ? `done ${formatDate(st.completed_at)}` : null;
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
                          disabled={!canOperate || busy || pendingSubtaskIds.has(st.id)}
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
                          {doneDate && (
                            <span
                              style={{display: 'block', fontSize: 11, color: T.faint, fontWeight: 600, marginTop: 2}}
                            >
                              {doneDate}
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
                            disabled={busy || pendingAssigneeIds.has(st.id)}
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

              {/* Completion gate — the server's completion_blockers are the
                  ONLY source of truth; the button disables while any exist. */}
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
