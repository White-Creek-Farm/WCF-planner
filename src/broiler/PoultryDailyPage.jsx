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
/* eslint-disable no-unused-vars -- DailyPhotoThumbnails/TeamMemberSelect are JSX-only */
import DailyPhotoThumbnails from '../shared/DailyPhotoThumbnails.jsx';
import {
  recordFormCard,
  recordFieldRowClass,
  recordFieldLabel,
  recordControl,
  recordTextarea,
  recordCheckbox,
  TeamMemberSelect,
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
import {formatBroilerBatchLabel, splitSchooners} from '../lib/broilerBatchMeta.js';

// Shared record-page layout primitives (responsive label/value grid via
// fieldRowClass, control width, aligned booleans, roomy textareas).
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
];
const LABELS = {
  date: 'Date',
  team_member: 'Team member',
  batch_label: 'Group',
  feed_type: 'Feed type',
  feed_lbs: 'Feed (lbs)',
  grit_lbs: 'Grit (lbs)',
  mortality_count: 'Mortality count',
  mortality_reason: 'Mortality reason',
  group_moved: 'Group moved',
  waterer_checked: 'Waterer checked',
  comments: 'Comments',
};

function initForm(r) {
  return {
    date: r.date || '',
    teamMember: r.team_member || '',
    batchLabel: r.batch_label || '',
    feedType: r.feed_type || 'GROWER',
    feedLbs: r.feed_lbs != null ? String(r.feed_lbs) : '',
    gritLbs: r.grit_lbs != null ? String(r.grit_lbs) : '',
    mortalityCount: r.mortality_count != null ? String(r.mortality_count) : '',
    mortalityReason: r.mortality_reason || '',
    groupMoved: r.group_moved !== false,
    watererChecked: r.waterer_checked !== false,
    comments: r.comments || '',
  };
}

function buildBroilerGroupOptions(batches, currentLabel) {
  const activeBatches = (batches || []).filter((b) => b && b.status === 'active');
  const batchMeta = activeBatches.map((b) => ({
    name: b.name,
    schooners: splitSchooners(b.schooner),
    brooder: b.brooder || null,
    brooderOut: b.brooderOut || null,
  }));
  const options = activeBatches
    .filter((b) => b.name)
    .map((b) => ({value: b.name, label: formatBroilerBatchLabel(b.name, batchMeta)}));
  if (currentLabel && !options.some((o) => o.value === currentLabel)) {
    options.push({value: currentLabel, label: currentLabel});
  }
  return options;
}

export default function PoultryDailyPage({sb, authState, Header, batches = []}) {
  const navigate = useNavigate();
  const location = useLocation();
  const recordId = location.pathname.replace('/broiler/dailys/', '');
  // Originating list order (visible rows) handed through route state. Absent on
  // direct links and notification/deep-link opens, so the controls hide.
  const recordSeq = location.state?.recordSeq || null;
  function navigateSeq(id) {
    navigate('/broiler/dailys/' + id, recordSeqNavOptions(recordSeq));
  }

  const [record, setRecord] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState(null);
  const [loadError, setLoadError] = React.useState(null);
  const [form, setForm] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const groupOptions = React.useMemo(
    () => buildBroilerGroupOptions(batches, form?.batchLabel),
    [batches, form?.batchLabel],
  );

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    try {
      const {data, error} = await sb
        .from('poultry_dailys')
        .select('*')
        .eq('id', recordId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) throw new Error('poultry_dailys: ' + (error.message || error));
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
    if (parseInt(form.mortalityCount) > 0 && !(form.mortalityReason || '').trim()) {
      setNotice({kind: 'error', message: 'Mortality reason is required when mortalities are reported.'});
      return;
    }
    setSaving(true);
    const rec = {
      date: form.date,
      team_member: form.teamMember,
      batch_label: form.batchLabel,
      feed_type: form.feedType || 'GROWER',
      feed_lbs: form.feedLbs !== '' ? parseFloat(form.feedLbs) : 0,
      grit_lbs: form.gritLbs !== '' ? parseFloat(form.gritLbs) : 0,
      mortality_count: form.mortalityCount !== '' ? parseInt(form.mortalityCount) : 0,
      mortality_reason: form.mortalityReason || null,
      group_moved: form.groupMoved,
      waterer_checked: form.watererChecked,
      comments: form.comments || null,
    };
    const entityLabel =
      (rec.date || record.date) +
      (rec.batch_label ? ' · ' + rec.batch_label : record.batch_label ? ' · ' + record.batch_label : '');
    try {
      // Edit goes through the ownership-enforced SECDEF RPC (mig 091): server
      // applies the column allowlist + logs the field.updated Activity diff.
      await updateDailyReport(sb, 'poultry.daily', record.id, rec, {entityLabel});
      setRecord((prev) => ({...prev, ...rec}));
      setNotice({kind: 'success', message: 'Saved.'});
    } catch (e) {
      setNotice({
        kind: 'error',
        message: 'Save failed: ' + friendlyDailyDbError(e.message || String(e), 'poultry_dailys', rec),
      });
    } finally {
      setSaving(false);
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
        await softDeleteDailyReport(sb, 'poultry.daily', record.id, label);
        navigate('/broiler/dailys');
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
      <RecordPageFrame Header={Header}>
        <RecordPageBody maxWidth={960} data-poultry-daily-load-error="true">
          <RecordBackLink label="Back to Daily Reports" onBack={() => navigate('/broiler/dailys')} />
          <InlineNotice notice={loadError} />
          <button
            type="button"
            data-daily-record-retry="1"
            onClick={() => loadAll()}
            style={{
              marginTop: 10,
              padding: '7px 14px',
              borderRadius: 7,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#374151',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Retry
          </button>
        </RecordPageBody>
      </RecordPageFrame>
    );
  }

  if (!record || !form) {
    return (
      <RecordPageNotFound
        Header={Header}
        backLabel="Back to Daily Reports"
        onBack={() => navigate('/broiler/dailys')}
        message="Daily report not found. It may have been deleted."
      />
    );
  }

  // Visible label uses the mm/dd/yyyy formatter (fmtMDY) instead of raw ISO
  // dates so the title/Activity context match the sequence-nav labels.
  const entityLabel = fmtMDY(record.date) + (record.batch_label ? ' · ' + record.batch_label : '');
  const isAddFeed = record.source === 'add_feed_webform';

  return (
    <RecordPageFrame Header={Header}>
      <RecordPageBody maxWidth={960} data-poultry-daily-record-loaded="true">
        <RecordBackLink label="Back to Daily Reports" onBack={() => navigate('/broiler/dailys')} />

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
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </div>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Team member</span>
            <TeamMemberSelect sb={sb} value={form.teamMember} onChange={(v) => setForm({...form, teamMember: v})} />
          </div>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Feed type</span>
            <select value={form.feedType} onChange={(e) => setForm({...form, feedType: e.target.value})} style={inp}>
              <option value="STARTER">Starter</option>
              <option value="GROWER">Grower</option>
            </select>
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
                <span style={fieldLabel}>Grit (lbs)</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={form.gritLbs}
                  onChange={(e) => setForm({...form, gritLbs: e.target.value})}
                  style={inp}
                />
              </div>
              <div className={fieldRowClass}>
                <span style={fieldLabel}>Mortality count</span>
                <input
                  type="number"
                  min="0"
                  value={form.mortalityCount}
                  onChange={(e) => setForm({...form, mortalityCount: e.target.value})}
                  style={inp}
                />
              </div>
              {(parseInt(form.mortalityCount) > 0 || form.mortalityReason) && (
                <div className={fieldRowClass}>
                  <span style={fieldLabel}>Mortality reason</span>
                  <input
                    type="text"
                    value={form.mortalityReason}
                    onChange={(e) => setForm({...form, mortalityReason: e.target.value})}
                    style={inp}
                  />
                </div>
              )}
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
                <span style={fieldLabel}>Waterer checked</span>
                <input
                  type="checkbox"
                  checked={form.watererChecked}
                  onChange={(e) => setForm({...form, watererChecked: e.target.checked})}
                  style={recordCheckbox}
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
            </>
          )}

          {!canEditOwnRecord(authState, record) && (
            <div data-daily-view-only="1" style={{marginTop: 8, fontSize: 11, color: '#6b7280'}}>
              View only — you can edit or delete only your own reports.
            </div>
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
              disabled={saving || !canEditOwnRecord(authState, record)}
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

        {Array.isArray(record.photos) && record.photos.length > 0 && (
          <div style={{...recordFormCard, marginTop: 12}}>
            <DailyPhotoThumbnails photos={record.photos} />
          </div>
        )}

        {canDeleteDailyReport(authState, record) && (
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
          entityType="poultry.daily"
          entityId={record.id}
          entityLabel={entityLabel}
        />
      </RecordPageBody>
    </RecordPageFrame>
  );
}
