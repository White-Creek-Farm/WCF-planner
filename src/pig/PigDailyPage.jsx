import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import CommentsSection from '../shared/CommentsSection.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordActivityLog from '../shared/RecordActivityLog.jsx';
import {softDeleteDailyReport, canDeleteDailyReport} from '../lib/dailyReportsApi.js';
import {runMutation, recordFieldChange} from '../lib/entityMutations.js';
import {buildChanges} from '../lib/activityChangeDiff.js';

const fieldRow = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '6px 0',
  borderBottom: '1px solid #f3f4f6',
  fontSize: 13,
  gap: 8,
};
const fieldLabel = {fontWeight: 600, color: '#4b5563', fontSize: 12, flexShrink: 0};
const inp = {
  fontSize: 13,
  padding: '4px 8px',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  fontFamily: 'inherit',
  width: 120,
  boxSizing: 'border-box',
};
const EDIT_EXCLUDE = [
  'id',
  'submitted_at',
  'client_submission_id',
  'source',
  'daily_submission_id',
  'photos',
  'deleted_at',
  'deleted_by',
  'batch_id',
];
const LABELS = {
  date: 'Date',
  team_member: 'Team member',
  batch_label: 'Batch',
  pig_count: 'Pig count',
  feed_lbs: 'Feed (lbs)',
  group_moved: 'Group moved',
  nipple_drinker_moved: 'Nipple drinker moved',
  nipple_drinker_working: 'Nipple drinker working',
  troughs_moved: 'Troughs moved',
  fence_walked: 'Fence walked',
  fence_voltage: 'Fence voltage',
  issues: 'Issues',
};

function initForm(r) {
  return {
    date: r.date || '',
    teamMember: r.team_member || '',
    batchLabel: r.batch_label || '',
    pigCount: r.pig_count != null ? String(r.pig_count) : '',
    feedLbs: r.feed_lbs != null ? String(r.feed_lbs) : '',
    groupMoved: r.group_moved !== false,
    nippleDrinkerMoved: r.nipple_drinker_moved !== false,
    nippleDrinkerWorking: r.nipple_drinker_working !== false,
    troughsMoved: r.troughs_moved !== false,
    fenceWalked: r.fence_walked !== false,
    fenceVoltage: r.fence_voltage != null ? String(r.fence_voltage) : '',
    issues: r.issues || '',
  };
}

export default function PigDailyPage({sb, fmt, authState, Header}) {
  const navigate = useNavigate();
  const location = useLocation();
  const recordId = location.pathname.replace('/pig/dailys/', '');

  const [record, setRecord] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState(null);
  const [form, setForm] = React.useState(null);
  const [saving, setSaving] = React.useState(false);

  async function loadAll() {
    const {data} = await sb.from('pig_dailys').select('*').eq('id', recordId).is('deleted_at', null).single();
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

    // Derive batch_id from batch_label
    const batchId =
      form.batchLabel === record.batch_label
        ? record.batch_id
        : form.batchLabel
          ? form.batchLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')
          : null;

    const rec = {
      date: form.date,
      team_member: form.teamMember,
      batch_label: form.batchLabel,
      batch_id: batchId,
      pig_count: form.pigCount !== '' ? parseInt(form.pigCount) : null,
      feed_lbs: form.feedLbs !== '' ? parseFloat(form.feedLbs) : null,
      group_moved: form.groupMoved,
      nipple_drinker_moved: form.nippleDrinkerMoved,
      nipple_drinker_working: form.nippleDrinkerWorking,
      troughs_moved: form.troughsMoved,
      fence_walked: form.fenceWalked,
      fence_voltage: form.fenceVoltage !== '' ? parseFloat(form.fenceVoltage) : null,
      issues: form.issues || null,
    };
    const entityLabel =
      (rec.date || record.date) +
      (rec.batch_label ? ' · ' + rec.batch_label : record.batch_label ? ' · ' + record.batch_label : '');
    const result = await runMutation(() => sb.from('pig_dailys').update(rec).eq('id', record.id), {
      activity: () => {
        const changes = buildChanges(record, rec, {exclude: EDIT_EXCLUDE, labels: LABELS});
        if (changes.length === 0) return;
        return recordFieldChange(sb, {
          entityType: 'pig.daily',
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
        const label = record.date + (record.batch_label ? ' · ' + record.batch_label : '');
        await softDeleteDailyReport(sb, 'pig.daily', record.id, label);
        navigate('/pig/dailys');
      } catch (e) {
        setNotice({kind: 'error', message: 'Delete failed: ' + (e.message || String(e))});
      }
    });
  }

  if (loading) {
    return (
      <div style={{minHeight: '100vh', background: '#f1f3f2'}}>
        {Header && <Header />}
        <div style={{padding: 24, textAlign: 'center', color: '#6b7280', fontSize: 14}}>Loading…</div>
      </div>
    );
  }

  if (!record || !form) {
    return (
      <div style={{minHeight: '100vh', background: '#f1f3f2'}}>
        {Header && <Header />}
        <div style={{padding: 24}}>
          <button
            type="button"
            onClick={() => navigate('/pig/dailys')}
            style={{
              background: 'none',
              border: 'none',
              color: '#1d4ed8',
              cursor: 'pointer',
              fontSize: 14,
              fontFamily: 'inherit',
              padding: 0,
            }}
          >
            ← Back to Daily Reports
          </button>
          <div style={{marginTop: 16, color: '#6b7280', fontSize: 14}}>
            Daily report not found. It may have been deleted.
          </div>
        </div>
      </div>
    );
  }

  const entityLabel = record.date + (record.batch_label ? ' · ' + record.batch_label : '');
  const isAddFeed = record.source === 'add_feed_webform';

  return (
    <div style={{minHeight: '100vh', background: '#f1f3f2'}}>
      {Header && <Header />}
      <div style={{maxWidth: 800, margin: '0 auto', padding: '12px 16px'}}>
        <div style={{marginBottom: 12}}>
          <button
            type="button"
            onClick={() => navigate('/pig/dailys')}
            style={{
              background: 'none',
              border: 'none',
              color: '#1d4ed8',
              cursor: 'pointer',
              fontSize: 14,
              fontFamily: 'inherit',
              padding: 0,
              fontWeight: 500,
            }}
          >
            ← Back to Daily Reports
          </button>
        </div>

        <h1
          data-record-title="1"
          style={{fontSize: 28, fontWeight: 700, color: '#111827', margin: '0 0 12px', lineHeight: 1.2}}
        >
          {entityLabel}
        </h1>

        {notice && <InlineNotice kind={notice.kind} message={notice.message} onDismiss={() => setNotice(null)} />}

        <div
          data-daily-edit-form="1"
          key={record.id}
          style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 18px'}}
        >
          <div style={fieldRow}>
            <span style={fieldLabel}>Date</span>
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm({...form, date: e.target.value})}
              style={inp}
            />
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Batch</span>
            <input
              type="text"
              value={form.batchLabel}
              onChange={(e) => setForm({...form, batchLabel: e.target.value})}
              style={{...inp, width: 180}}
            />
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Team member</span>
            <input
              type="text"
              value={form.teamMember}
              onChange={(e) => setForm({...form, teamMember: e.target.value})}
              style={{...inp, width: 180}}
            />
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Feed (lbs)</span>
            <input
              type="number"
              min="0"
              step="0.1"
              value={form.feedLbs}
              onChange={(e) => setForm({...form, feedLbs: e.target.value})}
              style={inp}
            />
          </div>
          {!isAddFeed && (
            <>
              <div style={fieldRow}>
                <span style={fieldLabel}>Pig count</span>
                <input
                  type="number"
                  min="0"
                  value={form.pigCount}
                  onChange={(e) => setForm({...form, pigCount: e.target.value})}
                  style={inp}
                />
              </div>
              <div style={fieldRow}>
                <span style={fieldLabel}>Fence voltage (kV)</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={form.fenceVoltage}
                  onChange={(e) => setForm({...form, fenceVoltage: e.target.value})}
                  style={inp}
                />
              </div>
              <div style={fieldRow}>
                <span style={fieldLabel}>Group moved</span>
                <input
                  type="checkbox"
                  checked={form.groupMoved}
                  onChange={(e) => setForm({...form, groupMoved: e.target.checked})}
                />
              </div>
              <div style={fieldRow}>
                <span style={fieldLabel}>Nipple drinker moved</span>
                <input
                  type="checkbox"
                  checked={form.nippleDrinkerMoved}
                  onChange={(e) => setForm({...form, nippleDrinkerMoved: e.target.checked})}
                />
              </div>
              <div style={fieldRow}>
                <span style={fieldLabel}>Nipple drinker working</span>
                <input
                  type="checkbox"
                  checked={form.nippleDrinkerWorking}
                  onChange={(e) => setForm({...form, nippleDrinkerWorking: e.target.checked})}
                />
              </div>
              <div style={fieldRow}>
                <span style={fieldLabel}>Troughs moved</span>
                <input
                  type="checkbox"
                  checked={form.troughsMoved}
                  onChange={(e) => setForm({...form, troughsMoved: e.target.checked})}
                />
              </div>
              <div style={fieldRow}>
                <span style={fieldLabel}>Fence walked</span>
                <input
                  type="checkbox"
                  checked={form.fenceWalked}
                  onChange={(e) => setForm({...form, fenceWalked: e.target.checked})}
                />
              </div>
              <div style={fieldRow}>
                <span style={fieldLabel}>Issues</span>
                <textarea
                  value={form.issues}
                  onChange={(e) => setForm({...form, issues: e.target.value})}
                  rows={2}
                  style={{...inp, width: 260, resize: 'vertical'}}
                />
              </div>
            </>
          )}

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

        <div style={{marginTop: 16}}>
          <CommentsSection
            sb={sb}
            authState={authState}
            entityType="pig.daily"
            entityId={record.id}
            entityLabel={entityLabel}
          />
        </div>

        <div style={{marginTop: 16}}>
          <RecordActivityLog sb={sb} entityType="pig.daily" entityId={record.id} />
        </div>
      </div>
    </div>
  );
}
