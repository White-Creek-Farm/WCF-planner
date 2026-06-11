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
import RecordPageLoadError from '../shared/RecordPageLoadError.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
/* eslint-disable no-unused-vars -- DailyPhotoThumbnails/LockedTeamMemberField are JSX-only */
import DailyPhotoThumbnails from '../shared/DailyPhotoThumbnails.jsx';
import {
  recordFormCard,
  recordFieldRowClass,
  recordFieldLabel,
  recordControl,
  recordTextarea,
  recordCheckbox,
  recordSaveButton,
  recordSecondaryButton,
  recordDeleteButton,
  LockedTeamMemberField,
} from '../shared/recordPageControls.jsx';
/* eslint-enable no-unused-vars */
import {fmtMDY} from '../lib/dateUtils.js';
import {
  softDeleteDailyReport,
  canDeleteDailyReport,
  canEditOwnRecord,
  updateDailyReport,
} from '../lib/dailyReportsApi.js';
import {runMutation, recordFieldChange} from '../lib/entityMutations.js';
import {friendlyDailyDbError} from '../lib/dailyDuplicateCheck.js';
import {buildChanges} from '../lib/activityChangeDiff.js';

// Shared daily record-page layout primitives.
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
  'batch_id',
];
const LABELS = {
  date: 'Date',
  team_member: 'Team member',
  batch_label: 'Group',
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

function buildPigGroupOptions(feederGroups, currentLabel) {
  const names = [
    ...(feederGroups || []).map((g) => g && g.batchName).filter(Boolean),
    ...(feederGroups || []).flatMap((g) => (g?.subBatches || []).map((s) => s.name).filter(Boolean)),
  ];
  const values = [...new Set(names)].sort();
  if (currentLabel && !values.includes(currentLabel)) values.push(currentLabel);
  return values;
}

export default function PigDailyPage({sb, authState, Header, feederGroups = []}) {
  const navigate = useNavigate();
  const location = useLocation();
  const recordId = location.pathname.replace('/pig/dailys/', '');
  // Originating list order (visible rows) handed through route state. Absent on
  // direct links and notification/deep-link opens, so the controls hide.
  const recordSeq = location.state?.recordSeq || null;
  function navigateSeq(id) {
    navigate('/pig/dailys/' + id, recordSeqNavOptions(recordSeq));
  }

  const [record, setRecord] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState(null);
  const [loadError, setLoadError] = React.useState(null);
  const [form, setForm] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const groupOptions = React.useMemo(
    () => buildPigGroupOptions(feederGroups, form?.batchLabel),
    [feederGroups, form?.batchLabel],
  );

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    try {
      const {data, error} = await sb
        .from('pig_dailys')
        .select('*')
        .eq('id', recordId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) throw new Error('pig_dailys: ' + (error.message || error));
      if (data) {
        setRecord(data);
        setForm(initForm(data));
      } else {
        setRecord(null);
        setForm(null);
      }
    } catch (e) {
      setRecord(null);
      setForm(null);
      setLoadError({
        kind: 'error',
        message: 'Could not load daily report. Please refresh the page. (' + ((e && e.message) || e) + ')',
      });
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    setRecord(null);
    setLoading(true);
    setNotice(null);
    setLoadError(null);
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
    // Edit through the ownership-enforced SECDEF RPC (mig 091).
    let result = {ok: false};
    try {
      await updateDailyReport(sb, 'pig.daily', record.id, rec, {entityLabel});
      result = {ok: true};
    } catch (e) {
      setNotice({
        kind: 'error',
        message: 'Save failed: ' + friendlyDailyDbError(e.message || String(e), 'pig_dailys', rec),
      });
    }
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
    return <RecordPageLoading Header={Header} />;
  }

  if (loadError) {
    return (
      <RecordPageLoadError
        Header={Header}
        backLabel="Back to Daily Reports"
        onBack={() => navigate('/pig/dailys')}
        notice={loadError}
        onRetry={loadAll}
        maxWidth={960}
        retryButtonProps={{'data-daily-record-retry': '1'}}
        data-pig-daily-load-error="true"
      />
    );
  }

  if (!record || !form) {
    return (
      <RecordPageNotFound
        Header={Header}
        backLabel="Back to Daily Reports"
        onBack={() => navigate('/pig/dailys')}
        message="Daily report not found. It may have been deleted."
      />
    );
  }

  // Visible label uses the mm/dd/yyyy formatter (fmtMDY), not raw ISO dates.
  const entityLabel = fmtMDY(record.date) + (record.batch_label ? ' · ' + record.batch_label : '');
  const isAddFeed = record.source === 'add_feed_webform';

  return (
    <RecordPageFrame Header={Header}>
      <RecordPageBody maxWidth={960} data-pig-daily-record-loaded="true">
        <RecordBackLink label="Back to Daily Reports" onBack={() => navigate('/pig/dailys')} />

        <RecordSequenceNav seq={recordSeq} currentId={recordId} onNavigate={navigateSeq} />

        <RecordTitle>{entityLabel}</RecordTitle>

        {notice && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}

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
            <span style={fieldLabel}>Group</span>
            <select
              value={form.batchLabel}
              onChange={(e) => setForm({...form, batchLabel: e.target.value})}
              style={inp}
            >
              <option value="">Select group...</option>
              {groupOptions.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Team member</span>
            <LockedTeamMemberField value={form.teamMember} caption={null} />
          </div>
          <div className={fieldRowClass}>
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
              <div className={fieldRowClass}>
                <span style={fieldLabel}>Pig count</span>
                <input
                  type="number"
                  min="0"
                  value={form.pigCount}
                  onChange={(e) => setForm({...form, pigCount: e.target.value})}
                  style={inp}
                />
              </div>
              <div className={fieldRowClass}>
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
              <div className={fieldRowClass}>
                <span style={fieldLabel}>Group moved</span>
                <input
                  type="checkbox"
                  checked={form.groupMoved}
                  onChange={(e) => setForm({...form, groupMoved: e.target.checked})}
                  style={recordCheckbox}
                />
              </div>
              <div className={fieldRowClass}>
                <span style={fieldLabel}>Nipple drinker moved</span>
                <input
                  type="checkbox"
                  checked={form.nippleDrinkerMoved}
                  onChange={(e) => setForm({...form, nippleDrinkerMoved: e.target.checked})}
                  style={recordCheckbox}
                />
              </div>
              <div className={fieldRowClass}>
                <span style={fieldLabel}>Nipple drinker working</span>
                <input
                  type="checkbox"
                  checked={form.nippleDrinkerWorking}
                  onChange={(e) => setForm({...form, nippleDrinkerWorking: e.target.checked})}
                  style={recordCheckbox}
                />
              </div>
              <div className={fieldRowClass}>
                <span style={fieldLabel}>Troughs moved</span>
                <input
                  type="checkbox"
                  checked={form.troughsMoved}
                  onChange={(e) => setForm({...form, troughsMoved: e.target.checked})}
                  style={recordCheckbox}
                />
              </div>
              <div className={fieldRowClass}>
                <span style={fieldLabel}>Fence walked</span>
                <input
                  type="checkbox"
                  checked={form.fenceWalked}
                  onChange={(e) => setForm({...form, fenceWalked: e.target.checked})}
                  style={recordCheckbox}
                />
              </div>
              <div className={fieldRowClass}>
                <span style={fieldLabel}>Issues</span>
                <textarea
                  value={form.issues}
                  onChange={(e) => setForm({...form, issues: e.target.value})}
                  rows={3}
                  style={recordTextarea}
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
              style={recordSecondaryButton}
            >
              Revert
            </button>
            <button
              type="button"
              data-daily-save="1"
              onClick={handleSave}
              disabled={saving || !canEditOwnRecord(authState, record)}
              style={recordSaveButton}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {Array.isArray(record.photos) && record.photos.length > 0 && (
          <div style={{...recordFormCard, marginTop: 12}}>
            <DailyPhotoThumbnails photos={record.photos} />
          </div>
        )}

        {canDeleteDailyReport(authState, record) && (
          <button onClick={handleDelete} style={{...recordDeleteButton, marginTop: 12}}>
            Delete report
          </button>
        )}

        <RecordCollaborationSection
          sb={sb}
          authState={authState}
          entityType="pig.daily"
          entityId={record.id}
          entityLabel={entityLabel}
        />
      </RecordPageBody>
    </RecordPageFrame>
  );
}
