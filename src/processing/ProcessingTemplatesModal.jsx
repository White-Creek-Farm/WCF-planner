// ============================================================================
// src/processing/ProcessingTemplatesModal.jsx  —  per-animal record templates
// ----------------------------------------------------------------------------
// ADMIN ONLY (Management + Farm Team have full operational access but NOT
// template editing — CP0). Edits the active template for a program:
//   • FIELDS tab — the record-page field layout: drag to reorder, rename,
//     change type (Text / Number / Date / Single select / Multi select /
//     Person / Formula), and for selects edit OPTIONS (label + color swatch →
//     the locked 12-color palette, add/remove). Field ids are STABLE: existing
//     ids are preserved, new fields mint 'fld-<uuid>'. Reserved bound ids
//     (Planner-owned / derived / RPC-owned — see processingFields.js) show a
//     "source-owned" tag; their layout position is editable, their values are
//     not authored here.
//   • SUBTASKS tab — the default checklist: drag to reorder, rename, per-step
//     profile-backed assignee (clearable), add/remove.
//   • Reset (per tab) restores the canonical v2 defaults for the program.
// Saving calls upsert_processing_template (a new active VERSION supersedes the
// prior one). Template field changes drive the record drawer's Details layout;
// the checklist seeds NEW planner records automatically (mig 164) and existing
// records via the drawer's additive "Apply template".
// Templates are LOCAL-ONLY (UI-simplification lane): the Asana task-template
// import workflow is gone from the client. Customer & Processor choice
// management (ProcessingOptionsModal, mig 162) opens from inside this modal.
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {
  listProcessingTemplates,
  upsertProcessingTemplate,
  newProcessingId,
  friendlyProcessingError,
} from '../lib/processingApi.js';
import {
  PROCESSING_FIELD_PALETTE,
  DEFAULT_OPTION_COLOR,
  normalizeFieldDef,
  normalizeFieldOption,
  optionKeyFromLabel,
  defaultProcessingFields,
  defaultProcessingChecklist,
  isReservedProcessingFieldId,
  validateTemplateDraft,
} from '../lib/processingFields.js';
import {loadEligibleProfilesById} from '../lib/tasksCenterApi.js';
import {programDotStyle, getProgramColor} from '../lib/programColors.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ProcessingOptionsModal from './ProcessingOptionsModal.jsx';

const PROGRAMS = [
  {key: 'broiler', label: 'Broiler'},
  {key: 'cattle', label: 'Cattle'},
  {key: 'pig', label: 'Pig'},
  {key: 'sheep', label: 'Lamb'},
];
const FIELD_TYPES = [
  {value: 'text', label: 'Text'},
  {value: 'number', label: 'Number'},
  {value: 'date', label: 'Date'},
  {value: 'single', label: 'Single select'},
  {value: 'multi', label: 'Multi select'},
  {value: 'people', label: 'Person'},
  {value: 'checkbox', label: 'Checkbox'},
  {value: 'url', label: 'URL'},
  {value: 'formula', label: 'Formula'},
];

const T = {
  card: '#fff',
  border: '#E6E8EB',
  ink: '#222933',
  muted: '#6B7280',
  label: '#7A828D',
  faint: '#9AA1AB',
  green: '#1C8A5F',
};
const rowInput = {
  border: `1px solid #E2E5E9`,
  borderRadius: 10,
  padding: '7px 10px',
  fontSize: 13,
  fontWeight: 600,
  color: T.ink,
  fontFamily: 'inherit',
  background: '#fff',
  outline: 'none',
};

// Drawer-control preview for the CURRENT DRAFT (fields render as the disabled
// control the record drawer would mount; checklist lists its steps). Module
// scope on purpose — a nested component type would remount per keystroke.
// eslint-disable-next-line no-unused-vars -- JSX-only use
function TemplatePreviewPane({fields, checklist, profilesById}) {
  const previewControl = (f) => {
    const disabled = {pointerEvents: 'none', opacity: 0.75};
    const base = {
      border: `1px solid #E2E5E9`,
      borderRadius: 10,
      padding: '5px 9px',
      fontSize: 12.5,
      fontWeight: 600,
      color: T.ink,
      background: '#fff',
      fontFamily: 'inherit',
    };
    if (isReservedProcessingFieldId(f.id) || f.type === 'formula') {
      return <span style={{fontSize: 12, color: T.faint, fontWeight: 700}}>read-only (source/derived)</span>;
    }
    switch (f.type) {
      case 'date':
        return <input type="date" readOnly tabIndex={-1} style={{...base, ...disabled}} />;
      case 'number':
        return <input type="number" readOnly tabIndex={-1} placeholder="0" style={{...base, ...disabled, width: 90}} />;
      case 'checkbox':
        return <input type="checkbox" readOnly tabIndex={-1} style={disabled} />;
      case 'url':
        return (
          <input type="url" readOnly tabIndex={-1} placeholder="https://…" style={{...base, ...disabled, width: 160}} />
        );
      case 'people':
        return (
          <select tabIndex={-1} style={{...base, ...disabled}}>
            <option>— person —</option>
          </select>
        );
      case 'single':
      case 'multi': {
        if (f.optionsSource) {
          return (
            <span style={{fontSize: 12, color: T.muted, fontWeight: 700}}>select · choices from admin settings</span>
          );
        }
        const opts = (Array.isArray(f.options) ? f.options : []).map(normalizeFieldOption).filter(Boolean);
        return (
          <span style={{display: 'inline-flex', gap: 5, flexWrap: 'wrap'}}>
            {opts.slice(0, 6).map((o) => (
              <span
                key={o.key}
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  borderRadius: 999,
                  padding: '2px 8px',
                  background: o.color.bg,
                  color: o.color.ink,
                }}
              >
                {o.label}
              </span>
            ))}
            {opts.length > 6 && <span style={{fontSize: 11, color: T.faint}}>+{opts.length - 6}</span>}
          </span>
        );
      }
      default:
        return (
          <input type="text" readOnly tabIndex={-1} placeholder="text" style={{...base, ...disabled, width: 140}} />
        );
    }
  };
  return (
    <div
      data-processing-template-preview="1"
      style={{border: `1px dashed ${T.border}`, borderRadius: 12, padding: '12px 14px', marginBottom: 14}}
    >
      <div style={{fontSize: 12, fontWeight: 800, color: T.label, textTransform: 'uppercase', letterSpacing: '.05em'}}>
        Drawer preview (draft)
      </div>
      {fields
        .filter((f) => f && String(f.name || '').trim())
        .map((f) => (
          <div
            key={f.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '6px 0',
              borderBottom: `1px solid #F4F5F6`,
            }}
          >
            <span style={{fontSize: 12.5, color: T.muted, fontWeight: 600}}>{f.name}</span>
            {previewControl(f)}
          </div>
        ))}
      <div
        style={{
          fontSize: 12,
          fontWeight: 800,
          color: T.label,
          textTransform: 'uppercase',
          letterSpacing: '.05em',
          margin: '12px 0 4px',
        }}
      >
        Checklist ({checklist.filter((c) => c && String(c.label || '').trim()).length} steps)
      </div>
      {checklist
        .filter((c) => c && String(c.label || '').trim())
        .map((c, i) => (
          <div key={i} style={{display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0'}}>
            <span
              aria-hidden="true"
              style={{width: 13, height: 13, borderRadius: '50%', border: '1.4px solid #CDD2D8', flex: 'none'}}
            />
            <span style={{fontSize: 12.5, color: T.ink, fontWeight: 600, flex: 1, minWidth: 0}}>{c.label}</span>
            <span style={{fontSize: 11, color: T.faint, fontWeight: 600}}>
              {(c.assignee_profile_id && profilesById[c.assignee_profile_id]?.full_name) || c.assignee || '—'}
            </span>
          </div>
        ))}
    </div>
  );
}

export default function ProcessingTemplatesModal({
  authState,
  onClose,
  customerOptions = [],
  processorOptions = [],
  onOptionsSaved,
}) {
  // Guard: admin-only. Render a small notice (still dismissible) for anyone else.
  if (authState?.role !== 'admin') {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 7000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
        }}
      >
        <div onClick={onClose} style={{position: 'absolute', inset: 0, background: 'rgba(20,28,24,.34)'}} />
        <div
          style={{
            position: 'relative',
            background: '#fff',
            borderRadius: 14,
            padding: '20px 22px',
            maxWidth: 380,
            boxShadow: '0 24px 60px rgba(20,30,40,.28)',
          }}
        >
          <InlineNotice notice={{kind: 'warning', message: 'Template editing is available to admins only.'}} />
          <div style={{textAlign: 'right'}}>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: T.green,
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <TemplatesEditor
      onClose={onClose}
      customerOptions={customerOptions}
      processorOptions={processorOptions}
      onOptionsSaved={onOptionsSaved}
    />
  );
}

// eslint-disable-next-line no-unused-vars -- JSX-only use
function TemplatesEditor({onClose, customerOptions = [], processorOptions = [], onOptionsSaved}) {
  const {useState, useEffect, useCallback, useMemo} = React;
  const [program, setProgram] = useState('broiler');
  const [tab, setTab] = useState('fields');
  const [fields, setFields] = useState([]);
  const [checklist, setChecklist] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [profilesById, setProfilesById] = useState({});
  // Active/Draft state: the loaded ACTIVE version (null = no template yet) and
  // its snapshot; any local divergence is an unsaved DRAFT until Save activates
  // a new version. Preview renders the draft's drawer controls + checklist.
  const [activeVersion, setActiveVersion] = useState(null);
  const [baseline, setBaseline] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  // HTML5 drag state: {kind: 'field'|'step', index} while dragging.
  const [drag, setDrag] = useState(null);
  // Open color-palette popover: {fieldIndex, optionIndex} or null.
  const [colorPick, setColorPick] = useState(null);
  // Customer & Processor choice management (mig 162) lives INSIDE Templates now.
  const [showOptions, setShowOptions] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setNotice(null);
    setColorPick(null);
    try {
      const templates = await listProcessingTemplates(sb, program);
      const active = (Array.isArray(templates) ? templates : []).find((t) => t.is_active) || templates[0] || null;
      // Normalize on load: stable ids for legacy id-less fields, options into
      // {key,label,color} shape. Saving persists the normalized form.
      const loadedFields = (Array.isArray(active?.fields) ? active.fields : [])
        .map((f) => normalizeFieldDef(f))
        .filter(Boolean);
      const loadedChecklist = (Array.isArray(active?.checklist) ? active.checklist : []).map((c) => ({
        label: c?.label || '',
        assignee: c?.assignee || null,
        assignee_profile_id: c?.assignee_profile_id || null,
      }));
      setFields(loadedFields);
      setChecklist(loadedChecklist);
      setActiveVersion(active ? active.version : null);
      setBaseline(JSON.stringify({fields: loadedFields, checklist: loadedChecklist}));
    } catch (e) {
      setFields([]);
      setChecklist([]);
      setLoadError({message: `Could not load the template. Please retry. (${(e && e.message) || e})`});
    } finally {
      setLoading(false);
    }
  }, [program]);

  useEffect(() => {
    load();
  }, [load]);

  // Profile choices for the per-step assignee picker (best-effort sidecar).
  useEffect(() => {
    let cancelled = false;
    loadEligibleProfilesById(sb)
      .then((map) => {
        if (!cancelled) setProfilesById(map || {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const profileChoices = useMemo(
    () =>
      Object.values(profilesById || {}).sort((a, b) =>
        String(a.full_name || '').localeCompare(String(b.full_name || '')),
      ),
    [profilesById],
  );

  // Unsaved-draft detection against the loaded ACTIVE snapshot.
  const isDirty = useMemo(() => JSON.stringify({fields, checklist}) !== baseline, [fields, checklist, baseline]);

  // ── reorder helper (shared by fields + checklist drag) ─────────────────────
  function reorder(list, from, to) {
    const next = list.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  }
  function dropOn(kind, index) {
    if (!drag || drag.kind !== kind || drag.index === index) {
      setDrag(null);
      return;
    }
    if (kind === 'field') setFields((cur) => reorder(cur, drag.index, index));
    else setChecklist((cur) => reorder(cur, drag.index, index));
    setDrag(null);
  }
  const dragProps = (kind, i) => ({
    draggable: true,
    onDragStart: (e) => {
      setDrag({kind, index: i});
      try {
        e.dataTransfer.setData('text/plain', String(i));
        e.dataTransfer.effectAllowed = 'move';
      } catch (_e) {
        /* jsdom / older browsers */
      }
    },
    onDragOver: (e) => e.preventDefault(),
    onDrop: (e) => {
      e.preventDefault();
      dropOn(kind, i);
    },
    onDragEnd: () => setDrag(null),
  });

  // ── field editing ──────────────────────────────────────────────────────────
  function patchField(i, patch) {
    setFields((cur) => cur.map((f, idx) => (idx === i ? {...f, ...patch} : f)));
  }
  function setFieldType(i, type) {
    setFields((cur) =>
      cur.map((f, idx) => {
        if (idx !== i) return f;
        const next = {...f, type};
        // Switching TO a select with no options seeds one grey option; switching
        // away preserves authored option data (prototype behavior).
        if ((type === 'single' || type === 'multi') && (!Array.isArray(next.options) || next.options.length === 0)) {
          next.options = [{key: 'option_1', label: 'Option 1', color: {...DEFAULT_OPTION_COLOR}}];
        }
        return next;
      }),
    );
  }
  function removeField(i) {
    setColorPick(null);
    setFields((cur) => cur.filter((_, idx) => idx !== i));
  }
  function addField() {
    setFields((cur) => [...cur, {id: newProcessingId('fld'), name: '', type: 'text'}]);
  }
  function patchOption(fi, oi, patch) {
    setFields((cur) =>
      cur.map((f, idx) => {
        if (idx !== fi) return f;
        const options = (f.options || []).map((o, j) => (j === oi ? {...o, ...patch} : o));
        return {...f, options};
      }),
    );
  }
  function addOption(fi) {
    setFields((cur) =>
      cur.map((f, idx) => {
        if (idx !== fi) return f;
        const n = (f.options || []).length + 1;
        return {
          ...f,
          options: [...(f.options || []), {key: `option_${n}`, label: 'New option', color: {...DEFAULT_OPTION_COLOR}}],
        };
      }),
    );
  }
  function removeOption(fi, oi) {
    setColorPick(null);
    setFields((cur) =>
      cur.map((f, idx) => (idx === fi ? {...f, options: (f.options || []).filter((_, j) => j !== oi)} : f)),
    );
  }
  function resetFields() {
    setColorPick(null);
    setFields(defaultProcessingFields(program));
  }

  // ── checklist editing ──────────────────────────────────────────────────────
  function patchStep(i, patch) {
    setChecklist((cur) => cur.map((c, idx) => (idx === i ? {...c, ...patch} : c)));
  }
  function setStepAssignee(i, profileId) {
    // A profile assignment (or explicit clear) supersedes the legacy text name.
    patchStep(i, {assignee_profile_id: profileId || null, assignee: null});
  }
  function removeStep(i) {
    setChecklist((cur) => cur.filter((_, idx) => idx !== i));
  }
  function addStep() {
    setChecklist((cur) => [...cur, {label: '', assignee: null, assignee_profile_id: null}]);
  }
  function resetChecklist() {
    setChecklist(defaultProcessingChecklist(program));
  }

  async function save() {
    setSaving(true);
    setNotice(null);
    // Validate the authored draft BEFORE normalization. Normalizing first would
    // silently discard blank rows and coerce unsupported types to text, making
    // the publish gate appear green while changing the administrator's draft.
    const draftFields = fields.map((f) => ({...f, name: String(f?.name || '').trim()}));
    const draftChecklist = checklist.map((c) => ({
      ...c,
      label: String(c?.label || '').trim(),
    }));
    const verdict = validateTemplateDraft(draftFields, draftChecklist);
    if (!verdict.ok) {
      setNotice({
        kind: 'error',
        message: `Cannot activate this template: ${verdict.problems.slice(0, 4).join(' · ')}${
          verdict.problems.length > 4 ? ` · +${verdict.problems.length - 4} more` : ''
        }`,
      });
      setSaving(false);
      return;
    }

    const cleanFields = draftFields
      .map((f) => normalizeFieldDef(f))
      .map((f) => {
        const out = {id: f.id, name: f.name, type: f.type};
        if (f.type === 'single' || f.type === 'multi') {
          out.options = (f.options || [])
            .map(normalizeFieldOption)
            .filter(Boolean)
            .map((o) => ({key: o.key || optionKeyFromLabel(o.label), label: o.label, color: o.color}));
        } else if (Array.isArray(f.options) && f.options.length) {
          out.options = f.options; // preserved across a type change
        }
        if (f.asana_gid) out.asana_gid = f.asana_gid;
        if (f.default != null) out.default = f.default;
        // Settings-sourced selects (Processor) carry no baked options; the
        // marker must survive every save or the runtime control loses its source.
        if (f.optionsSource) out.optionsSource = f.optionsSource;
        return out;
      });
    const cleanChecklist = draftChecklist.map((c) => ({
      label: c.label,
      assignee: c.assignee || null,
      assignee_profile_id: c.assignee_profile_id || null,
    }));
    try {
      await upsertProcessingTemplate(sb, {program, fields: cleanFields, checklist: cleanChecklist});
      setNotice({kind: 'success', message: 'Template saved (a new version is now active).'});
      await load();
    } catch (e) {
      setNotice({kind: 'error', message: friendlyProcessingError(e)});
    } finally {
      setSaving(false);
    }
  }

  const tabBtn = (active) => ({
    padding: '7px 14px',
    borderRadius: 10,
    border: 'none',
    background: active ? '#fff' : 'transparent',
    color: active ? T.ink : T.muted,
    fontSize: 12.5,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: active ? '0 1px 2px rgba(20,30,40,.10)' : 'none',
  });
  const progPill = (selected, accent) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 11px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: selected ? 700 : 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    border: `1px solid ${selected ? accent : T.border}`,
    background: selected ? `${accent}14` : '#fff',
    color: selected ? accent : T.muted,
  });
  const removeBtn = {
    width: 24,
    height: 28,
    borderRadius: 10,
    border: 'none',
    background: 'none',
    color: '#B4373A',
    cursor: 'pointer',
    fontSize: 14,
    flex: 'none',
    fontFamily: 'inherit',
  };
  const addLink = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    marginTop: 6,
    color: T.green,
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    fontFamily: 'inherit',
    padding: 0,
  };
  const dragHandle = {
    cursor: 'grab',
    color: '#C4C9CF',
    fontSize: 13,
    letterSpacing: '-2px',
    flex: 'none',
    userSelect: 'none',
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 7000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      data-processing-templates-modal="1"
    >
      <style>{`@keyframes wcfProcModalIn{from{transform:translateY(10px) scale(.985);opacity:0}to{transform:translateY(0) scale(1);opacity:1}}`}</style>
      <div onClick={onClose} style={{position: 'absolute', inset: 0, background: 'rgba(20,28,24,.34)'}} />
      <div
        style={{
          position: 'relative',
          width: 640,
          maxWidth: '96vw',
          maxHeight: '90vh',
          background: T.card,
          borderRadius: 18,
          boxShadow: '0 24px 60px rgba(20,30,40,.28)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'wcfProcModalIn .18s ease',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 11,
            padding: '16px 20px',
            borderBottom: `1px solid #ECEEF0`,
            flex: 'none',
          }}
        >
          <div style={{flex: 1, minWidth: 0}}>
            <div
              style={{
                fontSize: 16,
                fontWeight: 800,
                letterSpacing: '-.01em',
                color: T.ink,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              {PROGRAMS.find((p) => p.key === program)?.label} record template
              <span
                data-processing-template-state={isDirty ? 'draft' : activeVersion == null ? 'none' : 'active'}
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  borderRadius: 999,
                  padding: '3px 9px',
                  background: isDirty ? '#F7EFD6' : activeVersion == null ? '#F1F3F4' : '#E6F4EC',
                  color: isDirty ? '#8A6A1E' : activeVersion == null ? T.muted : '#1F7A4D',
                }}
              >
                {activeVersion == null
                  ? isDirty
                    ? 'Draft — no template active yet'
                    : 'No template yet'
                  : isDirty
                    ? `Draft (unsaved) · editing Active v${activeVersion}`
                    : `Active v${activeVersion}`}
              </span>
            </div>
            <div style={{fontSize: 12, color: T.faint, fontWeight: 600, marginTop: 2}}>
              Field layout &amp; checklist for every {PROGRAMS.find((p) => p.key === program)?.label} batch — Save
              activates a new version
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            data-processing-template-preview-toggle
            aria-pressed={showPreview}
            style={{
              background: showPreview ? '#E6F4EC' : '#fff',
              border: `1px solid ${showPreview ? T.green : T.border}`,
              color: showPreview ? '#1F7A4D' : T.muted,
              borderRadius: 10,
              padding: '7px 12px',
              fontSize: 12.5,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
              marginRight: 8,
            }}
          >
            {showPreview ? 'Hide preview' : 'Preview'}
          </button>
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
            }}
          >
            ✕
          </button>
        </div>

        {/* Tabs + program selector */}
        <div
          style={{
            padding: '14px 20px 4px',
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{display: 'inline-flex', background: '#F1F3F4', borderRadius: 10, padding: 3, gap: 2}}>
            <button
              type="button"
              onClick={() => setTab('fields')}
              style={tabBtn(tab === 'fields')}
              data-processing-template-tab="fields"
            >
              Fields
            </button>
            <button
              type="button"
              onClick={() => setTab('subtasks')}
              style={tabBtn(tab === 'subtasks')}
              data-processing-template-tab="subtasks"
            >
              Subtasks
            </button>
          </div>
          <div style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>
            {PROGRAMS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setProgram(p.key)}
                data-processing-template-program={p.key}
                style={progPill(program === p.key, getProgramColor(p.key))}
              >
                <span style={programDotStyle(p.key)} />
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Customer & Processor choice management (mig 162) — inside Templates */}
        <div
          style={{
            padding: '4px 20px 8px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            flex: 'none',
          }}
        >
          <button
            type="button"
            onClick={() => setShowOptions(true)}
            data-processing-options-btn="1"
            style={{
              background: '#fff',
              border: `1px solid #D2D6DB`,
              color: T.muted,
              borderRadius: 10,
              padding: '7px 12px',
              fontSize: 12.5,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Customer &amp; processor choices
          </button>
          <span style={{fontSize: 12, color: T.faint, fontWeight: 600}}>
            The choices behind the Customer + Processor selects in the drawer and Add milestone.
          </span>
        </div>

        {/* Body */}
        <div style={{flex: 1, overflow: 'auto', padding: '14px 20px 10px'}}>
          <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />

          {!loading && !loadError && showPreview && (
            <TemplatePreviewPane fields={fields} checklist={checklist} profilesById={profilesById} />
          )}

          {loading && <div style={{color: T.faint, fontSize: 13, fontWeight: 600}}>Loading template…</div>}

          {loadError && (
            <div>
              <InlineNotice notice={{kind: 'error', message: loadError.message}} />
              <button type="button" onClick={load} style={{...rowInput, cursor: 'pointer', fontWeight: 700}}>
                Retry
              </button>
            </div>
          )}

          {!loading && !loadError && tab === 'fields' && (
            <div>
              <p style={{fontSize: 12.5, color: T.faint, fontWeight: 600, marginBottom: 14}}>
                Drag to reorder, rename, re-type, and remove the fields shown on every{' '}
                {PROGRAMS.find((p) => p.key === program)?.label} record page. Select fields carry colored options
                (12-color palette). Source-owned fields position here but read from the batch.
              </p>
              {fields.length === 0 && (
                <div style={{fontSize: 12.5, color: T.faint, fontWeight: 600, marginBottom: 10}}>
                  No fields yet — add one below or Reset to the defaults.
                </div>
              )}
              {fields.map((f, i) => {
                const isSelect = f.type === 'single' || f.type === 'multi';
                const reserved = isReservedProcessingFieldId(f.id);
                return (
                  <div
                    key={f.id || i}
                    data-processing-template-field={i}
                    {...dragProps('field', i)}
                    style={{
                      border: `1px solid #ECEEF0`,
                      borderRadius: 10,
                      padding: '9px 10px',
                      marginBottom: 9,
                      opacity: drag && drag.kind === 'field' && drag.index === i ? 0.4 : 1,
                      background: '#fff',
                    }}
                  >
                    <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
                      <span aria-hidden="true" title="Drag to reorder" style={dragHandle}>
                        ⠿⠿
                      </span>
                      <input
                        value={f.name || ''}
                        onChange={(e) => patchField(i, {name: e.target.value})}
                        placeholder="Field name"
                        style={{...rowInput, flex: 1, minWidth: 0, fontWeight: 700}}
                      />
                      <select
                        value={FIELD_TYPES.some((t) => t.value === f.type) ? f.type : 'text'}
                        onChange={(e) => setFieldType(i, e.target.value)}
                        style={{...rowInput, flex: 'none', cursor: 'pointer'}}
                      >
                        {FIELD_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                      <button type="button" onClick={() => removeField(i)} aria-label="Remove field" style={removeBtn}>
                        ✕
                      </button>
                    </div>
                    {reserved && (
                      <div style={{fontSize: 10.5, color: T.faint, fontWeight: 700, marginTop: 5, marginLeft: 26}}>
                        SOURCE-OWNED / DERIVED — value comes from the batch, not typed in
                      </div>
                    )}
                    {isSelect && (
                      <div style={{marginTop: 9, marginLeft: 26}} data-processing-template-options={f.id}>
                        {(f.options || []).map((o, oi) => (
                          <div
                            key={o.key || oi}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              marginBottom: 6,
                              position: 'relative',
                            }}
                          >
                            <button
                              type="button"
                              aria-label="Option color"
                              data-processing-option-color={`${f.id}:${oi}`}
                              onClick={() =>
                                setColorPick(
                                  colorPick && colorPick.fieldIndex === i && colorPick.optionIndex === oi
                                    ? null
                                    : {fieldIndex: i, optionIndex: oi},
                                )
                              }
                              style={{
                                width: 22,
                                height: 22,
                                borderRadius: 6 /* radius-allow: template option color swatch */,
                                border: `1px solid ${T.border}`,
                                background: (o.color && o.color.bg) || DEFAULT_OPTION_COLOR.bg,
                                cursor: 'pointer',
                                flex: 'none',
                              }}
                            />
                            {colorPick && colorPick.fieldIndex === i && colorPick.optionIndex === oi && (
                              <div
                                data-processing-color-palette="1"
                                style={{
                                  position: 'absolute',
                                  top: 26,
                                  left: 0,
                                  zIndex: 5,
                                  display: 'grid',
                                  gridTemplateColumns: 'repeat(6, 1fr)',
                                  gap: 5,
                                  background: '#fff',
                                  border: `1px solid ${T.border}`,
                                  borderRadius: 10,
                                  padding: 8,
                                  boxShadow: '0 10px 28px rgba(20,30,40,.18)',
                                }}
                              >
                                {PROCESSING_FIELD_PALETTE.map((c) => (
                                  <button
                                    key={c.bg}
                                    type="button"
                                    aria-label={`Color ${c.bg}`}
                                    onClick={() => {
                                      patchOption(i, oi, {color: {...c}});
                                      setColorPick(null);
                                    }}
                                    style={{
                                      width: 20,
                                      height: 20,
                                      borderRadius: 6 /* radius-allow: palette swatch */,
                                      border: `1px solid ${T.border}`,
                                      background: c.bg,
                                      cursor: 'pointer',
                                    }}
                                  />
                                ))}
                              </div>
                            )}
                            <input
                              value={o.label || ''}
                              onChange={(e) => patchOption(i, oi, {label: e.target.value})}
                              placeholder="Option label"
                              style={{...rowInput, flex: 1, minWidth: 0, padding: '5px 9px', fontSize: 12.5}}
                            />
                            <button
                              type="button"
                              onClick={() => removeOption(i, oi)}
                              aria-label="Remove option"
                              style={removeBtn}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => addOption(i)}
                          style={{...addLink, fontSize: 12, marginTop: 2}}
                          data-processing-template-add-option={f.id}
                        >
                          + Add an option
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              <button type="button" onClick={addField} style={addLink} data-processing-template-add-field>
                + Add field
              </button>
            </div>
          )}

          {!loading && !loadError && tab === 'subtasks' && (
            <div>
              <p style={{fontSize: 12.5, color: T.faint, fontWeight: 600, marginBottom: 14}}>
                The default checklist for every {PROGRAMS.find((p) => p.key === program)?.label} batch. Drag to reorder;
                each step can carry an assignee. New planner batches receive these steps automatically.
              </p>
              {checklist.length === 0 && (
                <div style={{fontSize: 12.5, color: T.faint, fontWeight: 600, marginBottom: 10}}>
                  No steps yet — add one below or Reset to the defaults.
                </div>
              )}
              {checklist.map((c, i) => (
                <div
                  key={i}
                  data-processing-template-step={i}
                  {...dragProps('step', i)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 9,
                    opacity: drag && drag.kind === 'step' && drag.index === i ? 0.4 : 1,
                    background: '#fff',
                  }}
                >
                  <span aria-hidden="true" title="Drag to reorder" style={dragHandle}>
                    ⠿⠿
                  </span>
                  <input
                    value={c.label || ''}
                    onChange={(e) => patchStep(i, {label: e.target.value})}
                    placeholder="Subtask name"
                    style={{...rowInput, flex: 1, minWidth: 0}}
                  />
                  <select
                    value={c.assignee_profile_id && profilesById[c.assignee_profile_id] ? c.assignee_profile_id : ''}
                    onChange={(e) => setStepAssignee(i, e.target.value)}
                    aria-label="Assignee"
                    style={{...rowInput, flex: 'none', cursor: 'pointer', maxWidth: 150}}
                  >
                    <option value="">{c.assignee ? `${c.assignee} (name only)` : '— assignee'}</option>
                    {profileChoices.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.full_name}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => removeStep(i)} aria-label="Remove step" style={removeBtn}>
                    ✕
                  </button>
                </div>
              ))}
              <button type="button" onClick={addStep} style={addLink} data-processing-template-add-step>
                + Add subtask
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            padding: '14px 20px',
            borderTop: `1px solid #ECEEF0`,
            flex: 'none',
          }}
        >
          <div style={{display: 'flex', gap: 8}}>
            <button
              type="button"
              onClick={load}
              disabled={loading || saving}
              style={{
                background: '#fff',
                border: `1px solid #D2D6DB`,
                color: T.muted,
                borderRadius: 10,
                padding: '10px 14px',
                fontSize: 13,
                fontWeight: 700,
                cursor: loading || saving ? 'default' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Revert
            </button>
            <button
              type="button"
              onClick={tab === 'fields' ? resetFields : resetChecklist}
              disabled={loading || saving}
              data-processing-template-reset
              style={{
                background: '#fff',
                border: `1px solid #D2D6DB`,
                color: T.muted,
                borderRadius: 10,
                padding: '10px 14px',
                fontSize: 13,
                fontWeight: 700,
                cursor: loading || saving ? 'default' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {tab === 'fields' ? 'Reset fields' : 'Reset checklist'}
            </button>
          </div>
          <div style={{display: 'flex', gap: 10}}>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: '#fff',
                border: `1px solid #D2D6DB`,
                color: '#3F4650',
                borderRadius: 10,
                padding: '10px 16px',
                fontSize: 13.5,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Close
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || loading}
              data-processing-template-save
              style={{
                background: saving || loading ? '#EAECEF' : T.green,
                color: saving || loading ? '#9AA1AB' : '#fff',
                border: 'none',
                borderRadius: 10,
                padding: '10px 20px',
                fontSize: 13.5,
                fontWeight: 700,
                cursor: saving || loading ? 'default' : 'pointer',
                fontFamily: 'inherit',
                boxShadow: '0 1px 2px rgba(20,30,40,.12)',
              }}
            >
              {saving ? 'Saving…' : 'Save template'}
            </button>
          </div>
        </div>
      </div>
      {showOptions && (
        <ProcessingOptionsModal
          processorOptions={processorOptions}
          customerOptions={customerOptions}
          onClose={() => setShowOptions(false)}
          onSaved={onOptionsSaved}
        />
      )}
    </div>
  );
}
