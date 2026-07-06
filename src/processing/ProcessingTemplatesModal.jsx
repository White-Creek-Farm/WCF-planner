// ============================================================================
// src/processing/ProcessingTemplatesModal.jsx  —  per-animal record templates
// ----------------------------------------------------------------------------
// ADMIN ONLY (Management + Farm Team have full operational access but NOT
// template editing — CP0). Edits the active template for a program: the
// record-page Field layout (name + type) and the default Subtask checklist
// (label + assignee). Saving calls upsert_processing_template, which creates a
// new active VERSION superseding the prior one; apply_current_template then
// seeds those steps onto batches additively.
//
// v1 scope (functional, not fully polished): add / rename / change-type / remove
// fields, and add / rename / reassign / remove checklist steps. DEFERRED niceties
// (fine to add later): drag-to-reorder rows, per-option label+color editing for
// select fields, and formula-expression authoring. Existing option/color data on
// a field is PRESERVED across saves (we spread each field and only touch
// name/type), so editing here never destroys select options authored elsewhere.
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {listProcessingTemplates, upsertProcessingTemplate, friendlyProcessingError} from '../lib/processingApi.js';
import {programDotStyle, getProgramColor} from '../lib/programColors.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';

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
  {value: 'formula', label: 'Formula'},
];
const PEOPLE = ['Ronnie Jones', 'Isabel Hermann', 'Brian Naide', 'Brett Post', 'Jessica Torres'];

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

export default function ProcessingTemplatesModal({authState, onClose}) {
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

  return <TemplatesEditor onClose={onClose} />;
}

// eslint-disable-next-line no-unused-vars -- JSX-only use
function TemplatesEditor({onClose}) {
  const {useState, useEffect, useCallback} = React;
  const [program, setProgram] = useState('broiler');
  const [tab, setTab] = useState('fields');
  const [fields, setFields] = useState([]);
  const [checklist, setChecklist] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setNotice(null);
    try {
      const templates = await listProcessingTemplates(sb, program);
      const active = (Array.isArray(templates) ? templates : []).find((t) => t.is_active) || templates[0] || null;
      setFields(Array.isArray(active?.fields) ? active.fields.map((f) => ({...f})) : []);
      setChecklist(Array.isArray(active?.checklist) ? active.checklist.map((c) => ({...c})) : []);
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

  // ── field editing ──────────────────────────────────────────────────────────
  function setFieldName(i, name) {
    setFields((cur) => cur.map((f, idx) => (idx === i ? {...f, name} : f)));
  }
  function setFieldType(i, type) {
    setFields((cur) => cur.map((f, idx) => (idx === i ? {...f, type} : f)));
  }
  function removeField(i) {
    setFields((cur) => cur.filter((_, idx) => idx !== i));
  }
  function addField() {
    setFields((cur) => [...cur, {name: '', type: 'text'}]);
  }

  // ── checklist editing ──────────────────────────────────────────────────────
  function setStepLabel(i, label) {
    setChecklist((cur) => cur.map((c, idx) => (idx === i ? {...c, label} : c)));
  }
  function setStepAssignee(i, assignee) {
    setChecklist((cur) => cur.map((c, idx) => (idx === i ? {...c, assignee} : c)));
  }
  function removeStep(i) {
    setChecklist((cur) => cur.filter((_, idx) => idx !== i));
  }
  function addStep() {
    setChecklist((cur) => [...cur, {label: '', assignee: ''}]);
  }

  async function save() {
    setSaving(true);
    setNotice(null);
    const cleanFields = fields.map((f) => ({...f, name: String(f.name || '').trim()})).filter((f) => f.name);
    const cleanChecklist = checklist
      .map((c) => ({...c, label: String(c.label || '').trim(), assignee: c.assignee || null}))
      .filter((c) => c.label);
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
          width: 600,
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
            <div style={{fontSize: 16, fontWeight: 800, letterSpacing: '-.01em', color: T.ink}}>
              {PROGRAMS.find((p) => p.key === program)?.label} record template
            </div>
            <div style={{fontSize: 12, color: T.faint, fontWeight: 600, marginTop: 2}}>
              Field layout &amp; checklist for every {PROGRAMS.find((p) => p.key === program)?.label} batch
            </div>
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

        {/* Body */}
        <div style={{flex: 1, overflow: 'auto', padding: '14px 20px 10px'}}>
          <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />

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
                Add, rename, remove and re-type the fields shown on every{' '}
                {PROGRAMS.find((p) => p.key === program)?.label} record page. Select options &amp; colors and
                drag-reorder are deferred to a later version.
              </p>
              {fields.length === 0 && (
                <div style={{fontSize: 12.5, color: T.faint, fontWeight: 600, marginBottom: 10}}>
                  No fields yet — add one below.
                </div>
              )}
              {fields.map((f, i) => (
                <div
                  key={i}
                  data-processing-template-field={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    border: `1px solid #ECEEF0`,
                    borderRadius: 10,
                    padding: '9px 10px',
                    marginBottom: 9,
                  }}
                >
                  <input
                    value={f.name || ''}
                    onChange={(e) => setFieldName(i, e.target.value)}
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
              ))}
              <button type="button" onClick={addField} style={addLink} data-processing-template-add-field>
                + Add field
              </button>
            </div>
          )}

          {!loading && !loadError && tab === 'subtasks' && (
            <div>
              <p style={{fontSize: 12.5, color: T.faint, fontWeight: 600, marginBottom: 14}}>
                The default checklist for every {PROGRAMS.find((p) => p.key === program)?.label} batch. Each step has an
                assignee. Drag-reorder is deferred to a later version.
              </p>
              {checklist.length === 0 && (
                <div style={{fontSize: 12.5, color: T.faint, fontWeight: 600, marginBottom: 10}}>
                  No steps yet — add one below.
                </div>
              )}
              {checklist.map((c, i) => (
                <div
                  key={i}
                  data-processing-template-step={i}
                  style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9}}
                >
                  <input
                    value={c.label || ''}
                    onChange={(e) => setStepLabel(i, e.target.value)}
                    placeholder="Subtask name"
                    style={{...rowInput, flex: 1, minWidth: 0}}
                  />
                  <select
                    value={PEOPLE.includes(c.assignee) ? c.assignee : ''}
                    onChange={(e) => setStepAssignee(i, e.target.value)}
                    aria-label="Assignee"
                    style={{...rowInput, flex: 'none', cursor: 'pointer', maxWidth: 150}}
                  >
                    <option value="">{c.assignee && !PEOPLE.includes(c.assignee) ? c.assignee : '— assignee'}</option>
                    {PEOPLE.map((p) => (
                      <option key={p} value={p}>
                        {p}
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
    </div>
  );
}
