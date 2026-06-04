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
import {setHousingAnchorFromReport} from '../lib/layerHousing.js';
import {buildLayerDailyGroupOptions, resolveLayerDailyBatchId} from './layerDailyGroups.js';

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
  feed_type: 'Feed type',
  feed_lbs: 'Feed (lbs)',
  grit_lbs: 'Grit (lbs)',
  layer_count: 'Layer count',
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
    feedType: r.feed_type || 'LAYER',
    feedLbs: r.feed_lbs != null ? String(r.feed_lbs) : '',
    gritLbs: r.grit_lbs != null ? String(r.grit_lbs) : '',
    layerCount: r.layer_count != null ? String(r.layer_count) : '',
    mortalityCount: r.mortality_count != null ? String(r.mortality_count) : '',
    mortalityReason: r.mortality_reason || '',
    groupMoved: r.group_moved !== false,
    watererChecked: r.waterer_checked !== false,
    comments: r.comments || '',
  };
}

export default function LayerDailyPage({
  sb,
  authState,
  Header,
  layerGroups = [],
  layerBatches = [],
  layerHousings = [],
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const recordId = location.pathname.replace('/layer/dailys/', '');
  // Originating list order (visible rows) handed through route state. Absent on
  // direct links and notification/deep-link opens, so the controls hide.
  const recordSeq = location.state?.recordSeq || null;
  function navigateSeq(id) {
    navigate('/layer/dailys/' + id, recordSeqNavOptions(recordSeq));
  }

  const [record, setRecord] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState(null);
  const [loadError, setLoadError] = React.useState(null);
  const [form, setForm] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const groupOptions = React.useMemo(
    () => buildLayerDailyGroupOptions({layerGroups, layerBatches, layerHousings, currentLabel: form?.batchLabel}),
    [layerGroups, layerBatches, layerHousings, form?.batchLabel],
  );

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    try {
      const {data, error} = await sb
        .from('layer_dailys')
        .select('*')
        .eq('id', recordId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) throw new Error('layer_dailys: ' + (error.message || error));
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
    const batchId =
      form.batchLabel === record.batch_label
        ? record.batch_id || resolveLayerDailyBatchId(form.batchLabel, {layerGroups, layerBatches, layerHousings})
        : resolveLayerDailyBatchId(form.batchLabel, {layerGroups, layerBatches, layerHousings});
    const rec = {
      date: form.date,
      team_member: form.teamMember,
      batch_label: form.batchLabel,
      batch_id: batchId,
      feed_type: form.feedType || 'LAYER',
      feed_lbs: form.feedLbs !== '' ? parseFloat(form.feedLbs) : 0,
      grit_lbs: form.gritLbs !== '' ? parseFloat(form.gritLbs) : 0,
      layer_count: form.layerCount !== '' ? parseInt(form.layerCount) : null,
      mortality_count: form.mortalityCount !== '' ? parseInt(form.mortalityCount) : 0,
      mortality_reason: form.mortalityReason || null,
      group_moved: form.groupMoved,
      waterer_checked: form.watererChecked,
      comments: form.comments || null,
    };
    const entityLabel =
      (rec.date || record.date) +
      (rec.batch_label ? ' · ' + rec.batch_label : record.batch_label ? ' · ' + record.batch_label : '');
    // Edit through the ownership-enforced SECDEF RPC (mig 091): server applies
    // the column allowlist + logs the field.updated Activity diff.
    let result = {ok: false};
    try {
      await updateDailyReport(sb, 'layer.daily', record.id, rec, {entityLabel});
      result = {ok: true};
    } catch (e) {
      setNotice({
        kind: 'error',
        message: 'Save failed: ' + friendlyDailyDbError(e.message || String(e), 'layer_dailys', rec),
      });
    }
    setSaving(false);
    if (result.ok) {
      setRecord((prev) => ({...prev, ...rec}));
      setNotice({kind: 'success', message: 'Saved.'});

      // Update housing anchor from report if layer_count is valid
      const lc = parseInt(rec.layer_count);
      if (!isNaN(lc) && lc >= 0 && rec.batch_label) {
        const anchorResult = await setHousingAnchorFromReport(sb, rec.batch_label, lc, rec.date);
        if (!anchorResult || !anchorResult.ok) {
          if (anchorResult && anchorResult.reason === 'ambiguous-batch') {
            setNotice({
              kind: 'warning',
              message:
                'Hen count saved on the report, but the housing anchor was NOT updated.\n\nThe batch "' +
                anchorResult.batchName +
                '" has multiple active housings (' +
                anchorResult.housingNames.join(', ') +
                '). Please go to Layers › Housings and set the count manually on the correct housing.',
            });
          } else if (anchorResult && anchorResult.reason === 'no-match') {
            setNotice({
              kind: 'warning',
              message:
                'Hen count saved on the report, but no matching housing was found for "' +
                rec.batch_label +
                '". Please update the housing count manually if needed.',
            });
          }
        }
      }
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
        await softDeleteDailyReport(sb, 'layer.daily', record.id, label);
        navigate('/layer/dailys');
      } catch (e) {
        setNotice({kind: 'error', message: 'Delete failed: ' + (e.message || String(e))});
      }
    });
  }

  if (loading) {
    return <RecordPageLoading Header={Header} label="Loading..." />;
  }

  if (loadError) {
    return (
      <RecordPageFrame Header={Header}>
        <RecordPageBody maxWidth={960} data-layer-daily-load-error="true">
          <RecordBackLink label="Back to Daily Reports" onBack={() => navigate('/layer/dailys')} />
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
        onBack={() => navigate('/layer/dailys')}
        message="Daily report not found. It may have been deleted."
      />
    );
  }

  // Visible label uses the mm/dd/yyyy formatter (fmtMDY), not raw ISO dates.
  const entityLabel = fmtMDY(record.date) + (record.batch_label ? ' · ' + record.batch_label : '');
  const isAddFeed = record.source === 'add_feed_webform';

  return (
    <RecordPageFrame Header={Header}>
      <RecordPageBody maxWidth={960} data-layer-daily-record-loaded="true">
        <RecordBackLink label="Back to Daily Reports" onBack={() => navigate('/layer/dailys')} />

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
            <TeamMemberSelect sb={sb} value={form.teamMember} onChange={(v) => setForm({...form, teamMember: v})} />
          </div>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Feed type</span>
            <select value={form.feedType} onChange={(e) => setForm({...form, feedType: e.target.value})} style={inp}>
              <option value="STARTER">Starter</option>
              <option value="GROWER">Grower</option>
              <option value="LAYER">Layer</option>
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
                <span style={fieldLabel}>Layer count</span>
                <input
                  type="number"
                  min="0"
                  value={form.layerCount}
                  onChange={(e) => setForm({...form, layerCount: e.target.value})}
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
          entityType="layer.daily"
          entityId={record.id}
          entityLabel={entityLabel}
        />
      </RecordPageBody>
    </RecordPageFrame>
  );
}
