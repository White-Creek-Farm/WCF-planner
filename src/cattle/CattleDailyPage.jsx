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
];
const LABELS = {
  date: 'Date',
  team_member: 'Team member',
  herd: 'Herd',
  feeds: 'Feeds',
  minerals: 'Minerals',
  fence_voltage: 'Fence voltage',
  water_checked: 'Water checked',
  mortality_count: 'Mortality count',
  mortality_reason: 'Mortality reason',
  issues: 'Issues',
};
const FORMATTERS = {
  feeds: (v) =>
    Array.isArray(v)
      ? v.map((f) => (f.feed_name || f.feed_input_id) + ' ' + f.qty + (f.unit || '')).join(', ')
      : String(v ?? ''),
  minerals: (v) =>
    Array.isArray(v) ? v.map((m) => (m.name || m.feed_input_id) + ' ' + m.lbs + 'lb').join(', ') : String(v ?? ''),
};
const HERD_OPTIONS = ['mommas', 'backgrounders', 'finishers', 'bulls', 'processed', 'deceased', 'sold'];

function initForm(d) {
  return {
    date: d.date || '',
    teamMember: d.team_member || '',
    herd: d.herd || '',
    feeds:
      Array.isArray(d.feeds) && d.feeds.length > 0
        ? d.feeds.map((f) => ({
            feedId: f.feed_input_id || '',
            qty: f.qty != null ? String(f.qty) : '',
            isCreep: !!f.is_creep,
          }))
        : [{feedId: '', qty: '', isCreep: false}],
    minerals:
      Array.isArray(d.minerals) && d.minerals.length > 0
        ? d.minerals.map((m) => ({
            feedId: m.feed_input_id || '',
            lbs: m.lbs != null ? String(m.lbs) : '',
          }))
        : [{feedId: '', lbs: ''}],
    fenceVoltage: d.fence_voltage != null ? String(d.fence_voltage) : '',
    waterChecked: d.water_checked !== false,
    mortalityCount: d.mortality_count != null ? String(d.mortality_count) : '',
    mortalityReason: d.mortality_reason || '',
    issues: d.issues || '',
  };
}

export default function CattleDailyPage({sb, authState, Header}) {
  const navigate = useNavigate();
  const location = useLocation();
  const recordId = location.pathname.replace('/cattle/dailys/', '');
  // Originating list order (visible rows) handed through route state. Absent on
  // direct links and notification/deep-link opens, so the controls hide.
  const recordSeq = location.state?.recordSeq || null;
  function navigateSeq(id) {
    navigate('/cattle/dailys/' + id, recordSeqNavOptions(recordSeq));
  }

  const [record, setRecord] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState(null);
  const [loadError, setLoadError] = React.useState(null);
  const [form, setForm] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [feedInputs, setFeedInputs] = React.useState([]);

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    try {
      const [recR, fiR] = await Promise.all([
        sb.from('cattle_dailys').select('*').eq('id', recordId).is('deleted_at', null).maybeSingle(),
        sb.from('cattle_feed_inputs').select('*').order('category').order('name'),
      ]);
      if (recR.error) throw new Error('cattle_dailys: ' + (recR.error.message || recR.error));
      if (fiR.error) throw new Error('cattle_feed_inputs: ' + (fiR.error.message || fiR.error));
      setFeedInputs(fiR.data || []);
      if (recR.data) {
        setRecord(recR.data);
        setForm(initForm(recR.data));
      } else {
        setRecord(null);
        setForm(null);
      }
    } catch (e) {
      setRecord(null);
      setForm(null);
      setFeedInputs([]);
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

  /* ---- Feed / mineral row helpers ---- */
  function setFeedRow(idx, key, val) {
    setForm((prev) => {
      const feeds = [...prev.feeds];
      feeds[idx] = {...feeds[idx], [key]: val};
      return {...prev, feeds};
    });
  }
  function addFeedRow() {
    setForm((prev) => ({...prev, feeds: [...prev.feeds, {feedId: '', qty: '', isCreep: false}]}));
  }
  function removeFeedRow(idx) {
    setForm((prev) => {
      const feeds = prev.feeds.filter((_, i) => i !== idx);
      return {...prev, feeds: feeds.length > 0 ? feeds : [{feedId: '', qty: '', isCreep: false}]};
    });
  }
  function setMineralRow(idx, key, val) {
    setForm((prev) => {
      const minerals = [...prev.minerals];
      minerals[idx] = {...minerals[idx], [key]: val};
      return {...prev, minerals};
    });
  }
  function addMineralRow() {
    setForm((prev) => ({...prev, minerals: [...prev.minerals, {feedId: '', lbs: ''}]}));
  }
  function removeMineralRow(idx) {
    setForm((prev) => {
      const minerals = prev.minerals.filter((_, i) => i !== idx);
      return {...prev, minerals: minerals.length > 0 ? minerals : [{feedId: '', lbs: ''}]};
    });
  }

  /* ---- Save ---- */
  async function handleSave() {
    setNotice(null);
    if (parseInt(form.mortalityCount) > 0 && !(form.mortalityReason || '').trim()) {
      setNotice({kind: 'error', message: 'Mortality reason is required when mortalities are reported.'});
      return;
    }
    setSaving(true);

    // Rebuild feeds JSON
    const feedsJ = (form.feeds || [])
      .filter((r) => r.feedId && r.qty !== '' && r.qty != null)
      .map((r) => {
        const fi = feedInputs.find((x) => x.id === r.feedId);
        if (!fi) return null;
        const qty = parseFloat(r.qty) || 0;
        const unitWt = parseFloat(fi.unit_weight_lbs) || 1;
        return {
          feed_input_id: fi.id,
          feed_name: fi.name,
          category: fi.category,
          qty,
          unit: fi.unit,
          lbs_as_fed: Math.round(qty * unitWt * 100) / 100,
          is_creep: !!r.isCreep,
          nutrition_snapshot: {
            moisture_pct: fi.moisture_pct,
            nfc_pct: fi.nfc_pct,
            protein_pct: fi.protein_pct,
          },
        };
      })
      .filter(Boolean);

    // Rebuild minerals JSON
    const mineralsJ = (form.minerals || [])
      .filter((m) => m.feedId && m.lbs !== '' && m.lbs != null)
      .map((m) => {
        const fi = feedInputs.find((x) => x.id === m.feedId);
        if (!fi) return null;
        return {feed_input_id: fi.id, name: fi.name, lbs: parseFloat(m.lbs) || 0};
      })
      .filter(Boolean);

    const rec = {
      date: form.date,
      team_member: form.teamMember,
      herd: form.herd,
      feeds: feedsJ,
      minerals: mineralsJ,
      fence_voltage: form.fenceVoltage !== '' ? parseFloat(form.fenceVoltage) : null,
      water_checked: form.waterChecked,
      mortality_count: form.mortalityCount !== '' ? parseInt(form.mortalityCount) : 0,
      mortality_reason: form.mortalityReason || null,
      issues: form.issues || null,
    };
    const entityLabel =
      (rec.date || record.date) + (rec.herd ? ' · ' + rec.herd : record.herd ? ' · ' + record.herd : '');
    // Edit through the ownership-enforced SECDEF RPC (mig 091).
    let result = {ok: false};
    try {
      await updateDailyReport(sb, 'cattle.daily', record.id, rec, {entityLabel});
      result = {ok: true};
    } catch (e) {
      setNotice({
        kind: 'error',
        message: 'Save failed: ' + friendlyDailyDbError(e.message || String(e), 'cattle_dailys', rec),
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
        const label = record.date + (record.herd ? ' · ' + record.herd : '');
        await softDeleteDailyReport(sb, 'cattle.daily', record.id, label);
        navigate('/cattle/dailys');
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
        onBack={() => navigate('/cattle/dailys')}
        notice={loadError}
        onRetry={loadAll}
        maxWidth={960}
        retryButtonProps={{'data-daily-record-retry': '1'}}
        data-cattle-daily-load-error="true"
      />
    );
  }

  if (!record || !form) {
    return (
      <RecordPageNotFound
        Header={Header}
        backLabel="Back to Daily Reports"
        onBack={() => navigate('/cattle/dailys')}
        message="Daily report not found. It may have been deleted."
      />
    );
  }

  // Visible label uses the mm/dd/yyyy formatter (fmtMDY), not raw ISO dates.
  const entityLabel = fmtMDY(record.date) + (record.herd ? ' · ' + record.herd : '');
  const isAddFeed = record.source === 'add_feed_webform';
  const showCreep = (form.herd || '').toLowerCase() === 'mommas';

  // Partition feed inputs for selects
  const feedOptions = feedInputs.filter((fi) => fi.category !== 'mineral');
  const mineralOptions = feedInputs.filter((fi) => fi.category === 'mineral');

  return (
    <RecordPageFrame Header={Header}>
      <RecordPageBody maxWidth={960} data-cattle-daily-record-loaded="true">
        <RecordBackLink label="Back to Daily Reports" onBack={() => navigate('/cattle/dailys')} />

        <RecordSequenceNav seq={recordSeq} currentId={recordId} onNavigate={navigateSeq} />

        <RecordTitle>{entityLabel}</RecordTitle>

        {notice && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}

        <div data-daily-edit-form="1" key={record.id} style={recordFormCard}>
          {/* ---- Core fields ---- */}
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
            <LockedTeamMemberField value={form.teamMember} caption={null} />
          </div>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Herd</span>
            <select value={form.herd} onChange={(e) => setForm({...form, herd: e.target.value})} style={inp}>
              <option value="">--</option>
              {HERD_OPTIONS.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>

          {/* ---- Feeds editor ---- */}
          <div style={{padding: '8px 0', borderBottom: '1px solid #f3f4f6'}}>
            <div style={{...fieldLabel, marginBottom: 4}}>Feeds</div>
            {form.feeds.map((row, idx) => (
              <div key={idx} style={{display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap'}}>
                <select
                  value={row.feedId}
                  onChange={(e) => setFeedRow(idx, 'feedId', e.target.value)}
                  style={{...inp, width: 180}}
                >
                  <option value="">-- select feed --</option>
                  {feedOptions.map((fi) => (
                    <option key={fi.id} value={fi.id}>
                      {fi.name} ({fi.unit})
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  placeholder="qty"
                  value={row.qty}
                  onChange={(e) => setFeedRow(idx, 'qty', e.target.value)}
                  style={{...inp, width: 80}}
                />
                {showCreep && (
                  <label style={{fontSize: 12, display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer'}}>
                    <input
                      type="checkbox"
                      checked={row.isCreep}
                      onChange={(e) => setFeedRow(idx, 'isCreep', e.target.checked)}
                    />
                    Creep
                  </label>
                )}
                <button
                  type="button"
                  onClick={() => removeFeedRow(idx)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#b91c1c',
                    cursor: 'pointer',
                    fontSize: 14,
                    fontFamily: 'inherit',
                    padding: '0 4px',
                  }}
                  title="Remove row"
                >
                  x
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addFeedRow}
              style={{
                background: 'none',
                border: 'none',
                color: '#1d4ed8',
                cursor: 'pointer',
                fontSize: 12,
                fontFamily: 'inherit',
                padding: 0,
                marginTop: 2,
              }}
            >
              + Add feed row
            </button>
          </div>

          {/* ---- Minerals editor ---- */}
          <div style={{padding: '8px 0', borderBottom: '1px solid #f3f4f6'}}>
            <div style={{...fieldLabel, marginBottom: 4}}>Minerals</div>
            {form.minerals.map((row, idx) => (
              <div key={idx} style={{display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4}}>
                <select
                  value={row.feedId}
                  onChange={(e) => setMineralRow(idx, 'feedId', e.target.value)}
                  style={{...inp, width: 180}}
                >
                  <option value="">-- select mineral --</option>
                  {mineralOptions.map((fi) => (
                    <option key={fi.id} value={fi.id}>
                      {fi.name}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  placeholder="lbs"
                  value={row.lbs}
                  onChange={(e) => setMineralRow(idx, 'lbs', e.target.value)}
                  style={{...inp, width: 80}}
                />
                <button
                  type="button"
                  onClick={() => removeMineralRow(idx)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#b91c1c',
                    cursor: 'pointer',
                    fontSize: 14,
                    fontFamily: 'inherit',
                    padding: '0 4px',
                  }}
                  title="Remove row"
                >
                  x
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addMineralRow}
              style={{
                background: 'none',
                border: 'none',
                color: '#1d4ed8',
                cursor: 'pointer',
                fontSize: 12,
                fontFamily: 'inherit',
                padding: 0,
                marginTop: 2,
              }}
            >
              + Add mineral row
            </button>
          </div>

          {/* ---- Operational fields (hidden for add_feed_webform) ---- */}
          {!isAddFeed && (
            <>
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
                <span style={fieldLabel}>Water checked</span>
                <input
                  type="checkbox"
                  checked={form.waterChecked}
                  onChange={(e) => setForm({...form, waterChecked: e.target.checked})}
                  style={recordCheckbox}
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
          entityType="cattle.daily"
          entityId={record.id}
          entityLabel={entityLabel}
        />
      </RecordPageBody>
    </RecordPageFrame>
  );
}
