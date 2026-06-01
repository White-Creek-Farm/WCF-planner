import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordSequenceNav from '../shared/RecordSequenceNav.jsx';
import {recordSeqNavOptions} from '../lib/recordSequence.js';
/* eslint-disable no-unused-vars -- shell primitives are used in JSX only */
import {
  RecordPageFrame,
  RecordPageLoading,
  RecordPageNotFound,
  RecordPageBody,
  RecordBackLink,
  RecordTitle,
} from '../shared/RecordPageShell.jsx';
/* eslint-enable no-unused-vars */
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
/* eslint-disable no-unused-vars -- TeamMemberSelect is JSX-only */
import {
  recordFormCard,
  recordFieldRow,
  recordFieldRowClass,
  recordFieldLabel,
  recordControl,
  recordTextarea,
  TeamMemberSelect,
} from '../shared/recordPageControls.jsx';
/* eslint-enable no-unused-vars */
import {fmtMDY} from '../lib/dateUtils.js';
import {softDeleteDailyReport, canDeleteDailyReport} from '../lib/dailyReportsApi.js';
import {runMutation, recordFieldChange} from '../lib/entityMutations.js';
import {buildChanges} from '../lib/activityChangeDiff.js';

// Shared daily record-page layout primitives.
const fieldRow = recordFieldRow;
const fieldRowClass = recordFieldRowClass;
const fieldLabel = recordFieldLabel;
const inp = recordControl;
const EDIT_EXCLUDE = [
  'id',
  'submitted_at',
  'client_submission_id',
  'source',
  'daily_submission_id',
  'photos',
  'deleted_at',
  'deleted_by',
  'daily_dozen_count',
];
const LABELS = {
  date: 'Date',
  team_member: 'Team member',
  group1_name: 'Group 1 name',
  group1_count: 'Group 1 count',
  group2_name: 'Group 2 name',
  group2_count: 'Group 2 count',
  group3_name: 'Group 3 name',
  group3_count: 'Group 3 count',
  group4_name: 'Group 4 name',
  group4_count: 'Group 4 count',
  dozens_on_hand: 'Dozens on hand',
  comments: 'Comments',
};

function initForm(r) {
  return {
    date: r.date || '',
    teamMember: r.team_member || '',
    group1Name: r.group1_name || '',
    group1Count: r.group1_count != null ? String(r.group1_count) : '',
    group2Name: r.group2_name || '',
    group2Count: r.group2_count != null ? String(r.group2_count) : '',
    group3Name: r.group3_name || '',
    group3Count: r.group3_count != null ? String(r.group3_count) : '',
    group4Name: r.group4_name || '',
    group4Count: r.group4_count != null ? String(r.group4_count) : '',
    dozensOnHand: r.dozens_on_hand != null ? String(r.dozens_on_hand) : '',
    comments: r.comments || '',
  };
}

function computeDozenCount(f) {
  const total =
    (f.group1Count !== '' ? parseInt(f.group1Count) || 0 : 0) +
    (f.group2Count !== '' ? parseInt(f.group2Count) || 0 : 0) +
    (f.group3Count !== '' ? parseInt(f.group3Count) || 0 : 0) +
    (f.group4Count !== '' ? parseInt(f.group4Count) || 0 : 0);
  return Math.floor(total / 12);
}

export default function EggDailyPage({sb, authState, Header}) {
  const navigate = useNavigate();
  const location = useLocation();
  const recordId = location.pathname.replace('/layer/eggs/', '');
  // Originating list order (visible rows) handed through route state. Absent on
  // direct links and notification/deep-link opens, so the controls hide.
  const recordSeq = location.state?.recordSeq || null;
  function navigateSeq(id) {
    navigate('/layer/eggs/' + id, recordSeqNavOptions(recordSeq));
  }

  const [record, setRecord] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState(null);
  const [form, setForm] = React.useState(null);
  const [saving, setSaving] = React.useState(false);

  async function loadAll() {
    const {data} = await sb.from('egg_dailys').select('*').eq('id', recordId).is('deleted_at', null).single();
    if (data) {
      setRecord(data);
      setForm(initForm(data));
    }
    setLoading(false);
  }

  React.useEffect(() => {
    setRecord(null);
    setLoading(true);
    setNotice(null);
    setForm(null);
    loadAll();
  }, [recordId]);

  React.useEffect(() => {
    if (!loading && location.hash) {
      const anchor = location.hash.slice(1);
      setTimeout(() => {
        const el = document.getElementById(anchor);
        if (el) el.scrollIntoView({behavior: 'smooth', block: 'center'});
      }, 200);
    }
  }, [loading, location.hash]);

  async function handleSave() {
    setNotice(null);
    setSaving(true);
    const rec = {
      date: form.date,
      team_member: form.teamMember,
      group1_name: form.group1Name || null,
      group1_count: form.group1Count !== '' ? parseInt(form.group1Count) : null,
      group2_name: form.group2Name || null,
      group2_count: form.group2Count !== '' ? parseInt(form.group2Count) : null,
      group3_name: form.group3Name || null,
      group3_count: form.group3Count !== '' ? parseInt(form.group3Count) : null,
      group4_name: form.group4Name || null,
      group4_count: form.group4Count !== '' ? parseInt(form.group4Count) : null,
      dozens_on_hand: form.dozensOnHand !== '' ? parseFloat(form.dozensOnHand) : null,
      daily_dozen_count: computeDozenCount(form),
      comments: form.comments || null,
    };
    const entityLabel = rec.date || record.date;
    const result = await runMutation(() => sb.from('egg_dailys').update(rec).eq('id', record.id), {
      activity: () => {
        const changes = buildChanges(record, rec, {exclude: EDIT_EXCLUDE, labels: LABELS});
        if (changes.length === 0) return;
        return recordFieldChange(sb, {
          entityType: 'egg.daily',
          entityId: record.id,
          entityLabel,
          changes,
        });
      },
      onError: (msg) => setNotice({kind: 'error', message: 'Save failed: ' + msg}),
    });
    setSaving(false);
    if (result.ok) {
      setRecord((prev) => ({...prev, ...rec}));
      setNotice({kind: 'success', message: 'Saved.'});
    }
  }

  function handleCancel() {
    if (record) setForm(initForm(record));
    setNotice(null);
  }

  async function handleDelete() {
    if (!window._wcfConfirmDelete) return;
    window._wcfConfirmDelete('Delete this daily report?', async () => {
      try {
        const label = record.date;
        await softDeleteDailyReport(sb, 'egg.daily', record.id, label);
        navigate('/layer/eggs');
      } catch (e) {
        setNotice({kind: 'error', message: 'Delete failed: ' + (e.message || String(e))});
      }
    });
  }

  if (loading) {
    return <RecordPageLoading Header={Header} label="Loading..." />;
  }

  if (!record || !form) {
    return (
      <RecordPageNotFound
        Header={Header}
        backLabel="Back to Egg Reports"
        onBack={() => navigate('/layer/eggs')}
        message="Egg report not found. It may have been deleted."
      />
    );
  }

  // Visible label uses the mm/dd/yyyy formatter (fmtMDY), not raw ISO dates.
  const entityLabel = fmtMDY(record.date);

  return (
    <RecordPageFrame Header={Header}>
      <RecordPageBody maxWidth={960}>
        <RecordBackLink label="Back to Egg Reports" onBack={() => navigate('/layer/eggs')} />

        <RecordSequenceNav seq={recordSeq} currentId={recordId} onNavigate={navigateSeq} />

        <RecordTitle>{entityLabel}</RecordTitle>

        {notice && <InlineNotice kind={notice.kind} message={notice.message} onDismiss={() => setNotice(null)} />}

        <div data-daily-edit-form="1" key={record.id} style={recordFormCard}>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Date</span>
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm({...form, date: e.target.value})}
              style={inp}
            />
          </div>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Team member</span>
            <TeamMemberSelect sb={sb} value={form.teamMember} onChange={(v) => setForm({...form, teamMember: v})} />
          </div>

          <div style={{borderBottom: '1px solid #e5e7eb', padding: '8px 0 4px', marginTop: 4}}>
            <span style={{fontWeight: 700, color: '#374151', fontSize: 12}}>Group 1</span>
          </div>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Name</span>
            <input
              type="text"
              value={form.group1Name}
              onChange={(e) => setForm({...form, group1Name: e.target.value})}
              style={inp}
            />
          </div>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Count</span>
            <input
              type="number"
              min="0"
              value={form.group1Count}
              onChange={(e) => setForm({...form, group1Count: e.target.value})}
              style={inp}
            />
          </div>

          <div style={{borderBottom: '1px solid #e5e7eb', padding: '8px 0 4px', marginTop: 4}}>
            <span style={{fontWeight: 700, color: '#374151', fontSize: 12}}>Group 2</span>
          </div>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Name</span>
            <input
              type="text"
              value={form.group2Name}
              onChange={(e) => setForm({...form, group2Name: e.target.value})}
              style={inp}
            />
          </div>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Count</span>
            <input
              type="number"
              min="0"
              value={form.group2Count}
              onChange={(e) => setForm({...form, group2Count: e.target.value})}
              style={inp}
            />
          </div>

          <div style={{borderBottom: '1px solid #e5e7eb', padding: '8px 0 4px', marginTop: 4}}>
            <span style={{fontWeight: 700, color: '#374151', fontSize: 12}}>Group 3</span>
          </div>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Name</span>
            <input
              type="text"
              value={form.group3Name}
              onChange={(e) => setForm({...form, group3Name: e.target.value})}
              style={inp}
            />
          </div>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Count</span>
            <input
              type="number"
              min="0"
              value={form.group3Count}
              onChange={(e) => setForm({...form, group3Count: e.target.value})}
              style={inp}
            />
          </div>

          <div style={{borderBottom: '1px solid #e5e7eb', padding: '8px 0 4px', marginTop: 4}}>
            <span style={{fontWeight: 700, color: '#374151', fontSize: 12}}>Group 4</span>
          </div>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Name</span>
            <input
              type="text"
              value={form.group4Name}
              onChange={(e) => setForm({...form, group4Name: e.target.value})}
              style={inp}
            />
          </div>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Count</span>
            <input
              type="number"
              min="0"
              value={form.group4Count}
              onChange={(e) => setForm({...form, group4Count: e.target.value})}
              style={inp}
            />
          </div>

          <div style={{...fieldRow, background: '#f9fafb', borderRadius: 6, padding: '6px 8px', marginTop: 4}}>
            <span style={{...fieldLabel, color: '#6b7280'}}>Daily dozen count (computed)</span>
            <span style={{fontWeight: 600, fontSize: 13}}>{form ? computeDozenCount(form) : '—'}</span>
          </div>

          <div className={fieldRowClass}>
            <span style={fieldLabel}>Dozens on hand</span>
            <input
              type="number"
              min="0"
              step="0.1"
              value={form.dozensOnHand}
              onChange={(e) => setForm({...form, dozensOnHand: e.target.value})}
              style={inp}
            />
          </div>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Comments</span>
            <textarea
              value={form.comments}
              onChange={(e) => setForm({...form, comments: e.target.value})}
              rows={3}
              style={recordTextarea}
            />
          </div>

          <div style={{display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end'}}>
            <button
              type="button"
              data-daily-cancel="1"
              onClick={handleCancel}
              disabled={saving}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                border: '1px solid #d1d5db',
                background: 'white',
                color: '#374151',
                cursor: 'pointer',
                fontSize: 12,
                fontFamily: 'inherit',
              }}
            >
              Revert
            </button>
            <button
              type="button"
              data-daily-save="1"
              onClick={handleSave}
              disabled={saving}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                border: '1px solid #085041',
                background: '#085041',
                color: 'white',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 600,
                fontFamily: 'inherit',
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {canDeleteDailyReport(authState) && (
          <button
            onClick={handleDelete}
            style={{
              marginTop: 12,
              padding: '8px 18px',
              borderRadius: 8,
              border: '1px solid #fca5a5',
              background: '#fef2f2',
              color: '#b91c1c',
              fontWeight: 600,
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Delete report
          </button>
        )}

        <RecordCollaborationSection
          sb={sb}
          authState={authState}
          entityType="egg.daily"
          entityId={record.id}
          entityLabel={entityLabel}
        />
      </RecordPageBody>
    </RecordPageFrame>
  );
}
