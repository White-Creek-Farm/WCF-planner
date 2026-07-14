// ============================================================================
// src/processing/ProcessingTemplatesModal.jsx  —  per-program checklist templates
// ----------------------------------------------------------------------------
// ADMIN ONLY (Management + Farm Team have full operational access but NOT
// template editing — CP0). Edits the active template for a program. The
// configurable record FIELDS surface is retired (planner-integration lane):
// record fields are fixed/planner-owned. The visible surfaces are Tasks
// (default checklist: drag to reorder, rename, per-step profile-backed
// assignee, add/remove) and Fields (customer/processor option choices).
//   • Checklist steps carry STABLE server-minted ids (mig 177). Existing step
//     ids are preserved verbatim through every edit/reorder — never regenerated
//     client-side; NEW steps are sent WITHOUT an id and the server mints one
//     ('stp-<uuid>'). Stable ids are what let apply_current_template merge
//     renames/assignments into records without duplicating steps.
//   • Saves send fields=null; the server preserves the active version's fields
//     verbatim.
// Saving calls upsert_processing_template (a new active VERSION supersedes the
// prior one); the checklist seeds NEW planner records automatically (mig 164)
// and existing records via the drawer's additive "Apply template".
// Templates are LOCAL-ONLY (UI-simplification lane): the Asana task-template
// import workflow is gone from the client. Customer & Processor choice
// management (ProcessingOptionsEditor, mig 162/175) renders inside this modal
// and AUTOSAVES (no option Save button — 'Save template' stays for the
// checklist only); every exit path that unmounts the editor or closes the
// modal awaits the editor's registered flush first, and a failed flush keeps
// the surface open with the inline error (see requestClose/requestSurface).
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {listProcessingTemplates, upsertProcessingTemplate, friendlyProcessingError} from '../lib/processingApi.js';
import {validateChecklistDraft} from '../lib/processingFields.js';
import {loadEligibleProfilesById} from '../lib/tasksCenterApi.js';
import {programDotStyle, getProgramColor} from '../lib/programColors.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import {ProcessingOptionsEditor} from './ProcessingOptionsModal.jsx';

const PROGRAMS = [
  {key: 'broiler', label: 'Broiler'},
  {key: 'cattle', label: 'Cattle'},
  {key: 'pig', label: 'Pig'},
  {key: 'sheep', label: 'Lamb'},
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

// Read-only preview of the CURRENT DRAFT checklist as the record drawer would
// list it (step + resolved assignee). The retired field parts are gone with the
// Fields editor. Module scope on purpose — a nested component type would
// remount per keystroke.
// eslint-disable-next-line no-unused-vars -- JSX-only use
function TemplatePreviewPane({checklist, profilesById}) {
  const steps = checklist.filter((c) => c && String(c.label || '').trim());
  return (
    <div
      data-processing-template-preview="1"
      style={{border: `1px dashed ${T.border}`, borderRadius: 12, padding: '12px 14px', marginBottom: 14}}
    >
      <div style={{fontSize: 12, fontWeight: 800, color: T.label, textTransform: 'uppercase', letterSpacing: '.05em'}}>
        Checklist preview (draft) — {steps.length} steps
      </div>
      {steps.map((c, i) => (
        <div key={c.id || `new-${i}`} style={{display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0'}}>
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
  const {useState, useEffect, useCallback, useMemo, useRef} = React;
  const [program, setProgram] = useState('broiler');
  const [checklist, setChecklist] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [profilesById, setProfilesById] = useState({});
  // Active/Draft state: the loaded ACTIVE version (null = no template yet) and
  // its checklist snapshot; any local divergence is an unsaved DRAFT until Save
  // activates a new version. Fields are NOT part of the draft — they ride along
  // server-preserved (fields=null on save).
  const [showPreview, setShowPreview] = useState(false);
  const [activeSurface, setActiveSurface] = useState('tasks');
  // HTML5 drag state: the dragged step index, or null.
  const [drag, setDrag] = useState(null);

  // ── options autosave flush contract ─────────────────────────────────────────
  // The Fields surface's ProcessingOptionsEditor registers a flush here. Every
  // exit path that would unmount the editor or close the modal (surface switch
  // to Tasks, X, footer Close, scrim click, Escape) AWAITS it first: pending
  // debounced option edits are persisted before leaving. A failed flush keeps
  // the surface/modal open — the editor shows the inline error and retains the
  // edits (clicking Close again is the retry). Program switches also flush
  // (the editor stays mounted, so a failure there blocks nothing).
  const optionsFlushRef = useRef(null);
  const exitBusyRef = useRef(false);
  const registerOptionsFlush = useCallback((fn) => {
    optionsFlushRef.current = fn;
  }, []);
  const flushOptions = useCallback(async () => {
    const fn = optionsFlushRef.current;
    return fn ? await fn() : true;
  }, []);
  const requestClose = useCallback(async () => {
    if (exitBusyRef.current) return;
    exitBusyRef.current = true;
    try {
      if (await flushOptions()) onClose();
    } finally {
      exitBusyRef.current = false;
    }
  }, [flushOptions, onClose]);
  const requestSurface = useCallback(
    async (next) => {
      if (next === activeSurface || exitBusyRef.current) return;
      exitBusyRef.current = true;
      try {
        // Leaving Fields unmounts the options editor — persist first, and stay
        // put if the flush fails so nothing is discarded.
        if (activeSurface === 'fields' && !(await flushOptions())) return;
        setActiveSurface(next);
      } finally {
        exitBusyRef.current = false;
      }
    },
    [activeSurface, flushOptions],
  );
  const requestProgram = useCallback(
    async (key) => {
      if (activeSurface === 'fields') await flushOptions();
      setProgram(key);
    },
    [activeSurface, flushOptions],
  );

  // Esc closes the modal through the same flush-guarded path.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setNotice(null);
    try {
      const templates = await listProcessingTemplates(sb, program);
      const active = (Array.isArray(templates) ? templates : []).find((t) => t.is_active) || templates[0] || null;
      // Steps carry stable server ids (mig 177): keep each id verbatim; a
      // legacy id-less step stays id-less (the server mints one on next save).
      const loadedChecklist = (Array.isArray(active?.checklist) ? active.checklist : []).map((c) => ({
        id: c?.id || null,
        label: c?.label || '',
        assignee: c?.assignee || null,
        assignee_profile_id: c?.assignee_profile_id || null,
      }));
      setChecklist(loadedChecklist);
    } catch (e) {
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

  // ── checklist editing (step ids are stable — patches never touch c.id) ─────
  function reorder(list, from, to) {
    const next = list.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  }
  function dropOn(index) {
    if (drag == null || drag === index) {
      setDrag(null);
      return;
    }
    setChecklist((cur) => reorder(cur, drag, index));
    setDrag(null);
  }
  const dragProps = (i) => ({
    draggable: true,
    onDragStart: (e) => {
      setDrag(i);
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
      dropOn(i);
    },
    onDragEnd: () => setDrag(null),
  });

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
    // New steps have NO id — the server mints the stable 'stp-<uuid>' on save.
    setChecklist((cur) => [...cur, {id: null, label: '', assignee: null, assignee_profile_id: null}]);
  }
  async function save() {
    setSaving(true);
    setNotice(null);
    // Validate the authored draft BEFORE trimming discards anything: blank rows
    // must surface as problems, not silently vanish from the admin's draft.
    const draftChecklist = checklist.map((c) => ({
      ...c,
      label: String(c?.label || '').trim(),
    }));
    const verdict = validateChecklistDraft(draftChecklist);
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

    // Existing steps keep their stable id; new steps go up WITHOUT an id.
    const cleanChecklist = draftChecklist.map((c) => {
      const out = {
        label: c.label,
        assignee: c.assignee || null,
        assignee_profile_id: c.assignee_profile_id || null,
      };
      if (c.id) out.id = c.id;
      return out;
    });
    try {
      // fields: null — the server preserves the active version's fields verbatim.
      await upsertProcessingTemplate(sb, {program, fields: null, checklist: cleanChecklist});
      setNotice({kind: 'success', message: 'Template saved (a new version is now active).'});
      await load();
    } catch (e) {
      setNotice({kind: 'error', message: friendlyProcessingError(e)});
    } finally {
      setSaving(false);
    }
  }

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
      <div onClick={requestClose} style={{position: 'absolute', inset: 0, background: 'rgba(20,28,24,.34)'}} />
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
              {PROGRAMS.find((p) => p.key === program)?.label} checklist template
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
            onClick={requestClose}
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

        {/* Program selector */}
        <div
          style={{
            padding: '14px 20px 4px',
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>
            {PROGRAMS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => requestProgram(p.key)}
                data-processing-template-program={p.key}
                style={progPill(program === p.key, getProgramColor(p.key))}
              >
                <span style={programDotStyle(p.key)} />
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tasks / Fields surface selector */}
        <div
          style={{
            padding: '4px 20px 8px',
            display: 'flex',
            alignItems: 'center',
            flex: 'none',
          }}
        >
          <div
            role="group"
            aria-label="Template surface"
            data-processing-template-surface-toggle="1"
            style={{
              display: 'flex',
              borderRadius: 10,
              overflow: 'hidden',
              border: '1px solid var(--border-strong)',
              width: 220,
              maxWidth: '100%',
            }}
          >
            {[
              {key: 'tasks', label: 'Tasks'},
              {key: 'fields', label: 'Fields'},
            ].map((opt, i) => {
              const selected = activeSurface === opt.key;
              return (
                <React.Fragment key={opt.key}>
                  {i > 0 && <div style={{width: 1, background: 'var(--border-strong)', flexShrink: 0}} />}
                  <button
                    type="button"
                    onClick={() => requestSurface(opt.key)}
                    data-processing-template-surface={opt.key}
                    aria-pressed={selected}
                    style={{
                      flex: 1,
                      padding: '10px 0',
                      border: 'none',
                      fontFamily: 'inherit',
                      fontSize: 13,
                      fontWeight: selected ? 700 : 500,
                      cursor: 'pointer',
                      background: selected ? T.green : '#fff',
                      color: selected ? '#fff' : '#000',
                    }}
                  >
                    {opt.label}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        </div>

        {/* Body — single surface: the checklist editor */}
        <div style={{flex: 1, overflow: 'auto', padding: '14px 20px 10px'}}>
          <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />

          {activeSurface === 'tasks' && !loading && !loadError && showPreview && (
            <TemplatePreviewPane checklist={checklist} profilesById={profilesById} />
          )}

          {activeSurface === 'tasks' && loading && (
            <div style={{color: T.faint, fontSize: 13, fontWeight: 600}}>Loading template…</div>
          )}

          {activeSurface === 'tasks' && loadError && (
            <div>
              <InlineNotice notice={{kind: 'error', message: loadError.message}} />
              <button type="button" onClick={load} style={{...rowInput, cursor: 'pointer', fontWeight: 700}}>
                Retry
              </button>
            </div>
          )}

          {activeSurface === 'tasks' && !loading && !loadError && (
            <div>
              {checklist.map((c, i) => (
                <div
                  key={c.id || `new-${i}`}
                  data-processing-template-step={i}
                  {...dragProps(i)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 9,
                    opacity: drag === i ? 0.4 : 1,
                    background: '#fff',
                  }}
                >
                  <span aria-hidden="true" style={dragHandle}>
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
          {activeSurface === 'fields' && (
            <div data-processing-template-fields-panel="1">
              <ProcessingOptionsEditor
                processorOptions={processorOptions}
                customerOptions={customerOptions}
                onSaved={onOptionsSaved}
                registerFlush={registerOptionsFlush}
              />
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
          <div />
          <div style={{display: 'flex', gap: 10}}>
            <button
              type="button"
              onClick={requestClose}
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
            {activeSurface === 'tasks' && (
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
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
