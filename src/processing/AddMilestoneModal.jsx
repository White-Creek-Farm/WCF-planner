// ============================================================================
// src/processing/AddMilestoneModal.jsx  —  create a Processing milestone
// ----------------------------------------------------------------------------
// Batches are created by other planner functions / the historical import; this
// modal only adds a dated MILESTONE (record_type='milestone', purple-family
// identity) that drops onto the schedule at the processing date you set.
// Milestones are fully Processing-owned. Customer applies to broiler only and
// is a SINGLE select from customer_options (stored as [] or [value]); the
// parent Assignee is retired (UI-simplification lane).
//   createProcessingMilestone(sb, {id: newProcessingId('pmile'), ...})
// The id is minted client-side so the create is idempotent on retry; that same
// id is handed to onCreated so the caller can open the new record's drawer.
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {createProcessingMilestone, newProcessingId, friendlyProcessingError} from '../lib/processingApi.js';
import {activeOptionLabels} from '../lib/processingFields.js';
import {programDotStyle, getProgramColor} from '../lib/programColors.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';

const PROGRAMS = [
  {key: 'broiler', label: 'Broiler'},
  {key: 'cattle', label: 'Cattle'},
  {key: 'pig', label: 'Pig'},
  {key: 'sheep', label: 'Lamb'},
];
// Fallback only if the settings-backed customer_options can't be fetched (mig
// 162); the live list arrives via the customerOptions prop.
const CUSTOMER_OPTIONS_FALLBACK = ["Sonny's", 'Coastal Pastures - CONFIRMED', 'Coastal Pastures - POTENTIAL'];

const T = {
  card: '#fff',
  border: '#E6E8EB',
  ink: '#222933',
  muted: '#6B7280',
  label: '#7A828D',
  faint: '#9AA1AB',
  green: '#1C8A5F',
};
const labelStyle = {
  display: 'block',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.05em',
  textTransform: 'uppercase',
  color: T.label,
  marginBottom: 7,
};
const inputStyle = {
  width: '100%',
  border: `1px solid #D2D6DB`,
  borderRadius: 10,
  padding: '9px 11px',
  fontSize: 13.5,
  fontWeight: 600,
  color: T.ink,
  fontFamily: 'inherit',
  background: '#fff',
  outline: 'none',
  boxSizing: 'border-box',
};

const STATUS_CHOICES = [
  {value: 'planned', label: 'Planned'},
  {value: 'in_process', label: 'In Process'},
  {value: 'complete', label: 'Complete'},
];

export default function AddMilestoneModal({
  initialProgram,
  onClose,
  onCreated,
  customerOptions = [],
  processorOptions = [],
}) {
  const {useState} = React;
  const validInitial = PROGRAMS.some((p) => p.key === initialProgram) ? initialProgram : 'broiler';
  const [program, setProgram] = useState(validInitial);
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [processor, setProcessor] = useState('');
  const [customer, setCustomer] = useState('');
  const [status, setStatus] = useState('planned');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  const isBroiler = program === 'broiler';
  // Option lists are stable objects [{id,label,active}] (mig 175); the pickers
  // offer ACTIVE labels only (activeOptionLabels also tolerates the legacy
  // string-array shape). Customer falls back to the seeded constant when the
  // settings list is empty/unfetched. Zero-or-one customer, matching Processor.
  const customerLabels = activeOptionLabels(customerOptions);
  const customerChoices = customerLabels.length ? customerLabels : CUSTOMER_OPTIONS_FALLBACK;
  const processorChoices = activeOptionLabels(processorOptions);

  async function create() {
    if (!name.trim()) {
      setNotice({kind: 'error', message: 'Milestone name is required.'});
      return;
    }
    setSaving(true);
    setNotice(null);
    const id = newProcessingId('pmile');
    try {
      await createProcessingMilestone(sb, {
        id,
        program,
        title: name.trim(),
        processingDate: date || null,
        processor: processor.trim() || null,
        customer: isBroiler && customer ? [customer] : [],
        status,
      });
      if (onCreated) onCreated(id);
    } catch (e) {
      setNotice({kind: 'error', message: friendlyProcessingError(e)});
      setSaving(false);
    }
  }

  const pillStyle = (selected, accent) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '7px 13px',
    borderRadius: 999,
    fontSize: 12.5,
    fontWeight: selected ? 700 : 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    border: `1px solid ${selected ? accent : T.border}`,
    background: selected ? `${accent}14` : '#fff',
    color: selected ? accent : T.muted,
  });

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
      data-processing-add-milestone-modal="1"
    >
      <style>{`@keyframes wcfProcModalIn{from{transform:translateY(10px) scale(.985);opacity:0}to{transform:translateY(0) scale(1);opacity:1}}`}</style>
      <div onClick={onClose} style={{position: 'absolute', inset: 0, background: 'rgba(20,28,24,.34)'}} />
      <div
        style={{
          position: 'relative',
          width: 560,
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
            <div style={{fontSize: 16, fontWeight: 800, letterSpacing: '-.01em', color: T.ink}}>New milestone</div>
            <div style={{fontSize: 12, color: T.faint, fontWeight: 600, marginTop: 2}}>
              Drops onto the schedule at the processing date you set.
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

        {/* Body */}
        <div style={{flex: 1, overflow: 'auto', padding: '18px 20px 8px'}}>
          <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />

          <div style={{marginBottom: 18}}>
            <label style={labelStyle}>Program</label>
            <div style={{display: 'flex', gap: 7, flexWrap: 'wrap'}}>
              {PROGRAMS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setProgram(p.key)}
                  data-processing-milestone-program={p.key}
                  style={pillStyle(program === p.key, getProgramColor(p.key))}
                >
                  <span style={programDotStyle(p.key)} />
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{marginBottom: 14}}>
            <label style={labelStyle}>Milestone name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Add 240 whole birds in July"
              data-processing-milestone-name
              style={inputStyle}
            />
          </div>

          <div style={{marginBottom: 14}}>
            <label style={labelStyle}>Processing date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              data-processing-milestone-date
              style={{...inputStyle, width: 200}}
            />
            <div style={{fontSize: 11.5, color: T.faint, fontWeight: 600, marginTop: 6}}>
              Drops the milestone onto the schedule at this date.
            </div>
          </div>

          <div style={{marginBottom: 14}}>
            <label style={labelStyle}>Status</label>
            <div style={{display: 'flex', gap: 7, flexWrap: 'wrap'}}>
              {STATUS_CHOICES.map((s) => {
                const on = status === s.value;
                return (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => setStatus(s.value)}
                    data-processing-milestone-status={s.value}
                    style={{
                      fontSize: 12.5,
                      fontWeight: on ? 700 : 600,
                      borderRadius: 999,
                      padding: '6px 13px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      border: `1px solid ${on ? T.green : T.border}`,
                      background: on ? '#E6F4EC' : '#fff',
                      color: on ? '#1F7A4D' : T.muted,
                    }}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{marginBottom: isBroiler ? 14 : 6}}>
            <label style={labelStyle}>Processor (optional)</label>
            {/* TRUE SELECT from the admin-configured processor_options (mig
                162): arbitrary typing is impossible; '—' means none. */}
            <select
              value={processor}
              onChange={(e) => setProcessor(e.target.value)}
              data-processing-milestone-processor
              style={{...inputStyle, width: 260, cursor: 'pointer'}}
            >
              <option value="">—</option>
              {processorChoices.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          {isBroiler && (
            <div style={{marginBottom: 6}}>
              <label style={labelStyle}>Customer (optional)</label>
              {/* TRUE SINGLE SELECT from the admin-configured customer_options
                  (mig 162), matching the Processor control. '—' means none. */}
              <select
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
                data-processing-milestone-customer
                style={{...inputStyle, width: 260, cursor: 'pointer'}}
              >
                <option value="">—</option>
                {customerChoices.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 10,
            padding: '14px 20px',
            borderTop: `1px solid #ECEEF0`,
            flex: 'none',
          }}
        >
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
            Cancel
          </button>
          <button
            type="button"
            onClick={create}
            disabled={saving || !name.trim()}
            data-processing-milestone-create
            style={{
              background: saving || !name.trim() ? '#EAECEF' : T.green,
              color: saving || !name.trim() ? '#9AA1AB' : '#fff',
              border: 'none',
              borderRadius: 10,
              padding: '10px 18px',
              fontSize: 13.5,
              fontWeight: 700,
              cursor: saving || !name.trim() ? 'default' : 'pointer',
              fontFamily: 'inherit',
              boxShadow: '0 1px 2px rgba(20,30,40,.12)',
            }}
          >
            {saving ? 'Creating…' : 'Create milestone'}
          </button>
        </div>
      </div>
    </div>
  );
}
