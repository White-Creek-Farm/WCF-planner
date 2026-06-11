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

const FLOCK_OPTIONS = ['rams', 'ewes', 'feeders', 'processed', 'deceased', 'sold'];

const EDIT_EXCLUDE = ['id', 'created_at', 'updated_at', 'deleted_at', 'source'];

const LABELS = {
  date: 'Date',
  team_member: 'Team member',
  flock: 'Flock',
  feeds: 'Feeds',
  minerals: 'Minerals',
  fence_voltage_kv: 'Fence voltage',
  waterers_working: 'Waterers working',
  mortality_count: 'Mortality count',
  comments: 'Comments',
};

const FORMATTERS = {
  feeds: (v) =>
    Array.isArray(v)
      ? v.map((f) => (f.feed_name || f.feed_input_id) + ' ' + f.qty + (f.unit || '')).join(', ')
      : String(v ?? ''),
  minerals: (v) =>
    Array.isArray(v) ? v.map((m) => (m.name || m.feed_input_id) + ' ' + m.lbs + 'lb').join(', ') : String(v ?? ''),
  waterers_working: (v) => (v === false ? 'No' : 'Yes'),
};

function initForm(d) {
  return {
    date: d.date || '',
    team_member: d.team_member || '',
    flock: d.flock || '',
    feeds:
      Array.isArray(d.feeds) && d.feeds.length > 0
        ? d.feeds.map((f) => ({feedId: f.feed_input_id || '', qty: f.qty != null ? String(f.qty) : ''}))
        : [{feedId: '', qty: ''}],
    minerals:
      Array.isArray(d.minerals) && d.minerals.length > 0
        ? d.minerals.map((m) => ({feedId: m.feed_input_id || '', lbs: m.lbs != null ? String(m.lbs) : ''}))
        : [{feedId: '', lbs: ''}],
    fence_voltage_kv: d.fence_voltage_kv != null ? String(d.fence_voltage_kv) : '',
    waterers_working: d.waterers_working !== false,
    mortality_count: d.mortality_count != null ? String(d.mortality_count) : '0',
    comments: d.comments || '',
  };
}

// Feed/mineral row controls reuse the shared record control, widened to fill
// the flex row (the shared control caps width for label/value rows).
const feedRowControl = {...recordControl, maxWidth: '100%'};

const btnSmall = {
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  background: '#f9fafb',
  color: '#374151',
  fontWeight: 500,
  fontSize: 12,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

export default function SheepDailyPage({sb, authState, Header}) {
  const navigate = useNavigate();
  const location = useLocation();
  const recordId = location.pathname.replace('/sheep/dailys/', '');
  // Originating list order (visible rows) handed through route state. Absent on
  // direct links and notification/deep-link opens, so the controls hide.
  const recordSeq = location.state?.recordSeq || null;
  function navigateSeq(id) {
    navigate('/sheep/dailys/' + id, recordSeqNavOptions(recordSeq));
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
        sb.from('sheep_dailys').select('*').eq('id', recordId).is('deleted_at', null).maybeSingle(),
        sb.from('cattle_feed_inputs').select('*').order('category').order('name'),
      ]);
      if (recR.error) throw new Error('sheep_dailys: ' + (recR.error.message || recR.error));
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

  const isWebformSource = record && record.source === 'add_feed_webform';

  function handleCancel() {
    if (record) setForm(initForm(record));
    setNotice(null);
  }

  function updateField(field, value) {
    setForm((prev) => ({...prev, [field]: value}));
  }

  // Feed row helpers
  function updateFeedRow(idx, key, value) {
    setForm((prev) => {
      const rows = [...prev.feeds];
      rows[idx] = {...rows[idx], [key]: value};
      return {...prev, feeds: rows};
    });
  }
  function addFeedRow() {
    setForm((prev) => ({...prev, feeds: [...prev.feeds, {feedId: '', qty: ''}]}));
  }
  function removeFeedRow(idx) {
    setForm((prev) => {
      const rows = prev.feeds.filter((_, i) => i !== idx);
      return {...prev, feeds: rows.length > 0 ? rows : [{feedId: '', qty: ''}]};
    });
  }

  // Mineral row helpers
  function updateMineralRow(idx, key, value) {
    setForm((prev) => {
      const rows = [...prev.minerals];
      rows[idx] = {...rows[idx], [key]: value};
      return {...prev, minerals: rows};
    });
  }
  function addMineralRow() {
    setForm((prev) => ({...prev, minerals: [...prev.minerals, {feedId: '', lbs: ''}]}));
  }
  function removeMineralRow(idx) {
    setForm((prev) => {
      const rows = prev.minerals.filter((_, i) => i !== idx);
      return {...prev, minerals: rows.length > 0 ? rows : [{feedId: '', lbs: ''}]};
    });
  }

  async function handleSave() {
    if (!form.date) {
      setNotice({kind: 'error', message: 'Date is required.'});
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
          is_creep: false,
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

    const updates = {
      date: form.date,
      team_member: form.team_member || null,
      flock: form.flock || null,
      feeds: feedsJ,
      minerals: mineralsJ,
      fence_voltage_kv: form.fence_voltage_kv !== '' ? parseFloat(form.fence_voltage_kv) || null : null,
      waterers_working: form.waterers_working,
      mortality_count: form.mortality_count !== '' ? parseInt(form.mortality_count, 10) || 0 : 0,
      comments: form.comments || null,
    };

    // If webform source, restrict to allowed fields only
    if (isWebformSource) {
      delete updates.fence_voltage_kv;
      delete updates.waterers_working;
      delete updates.mortality_count;
      delete updates.comments;
    }

    const changes = buildChanges(record, updates, {exclude: EDIT_EXCLUDE, labels: LABELS, formatters: FORMATTERS});

    if (changes.length === 0) {
      setNotice({kind: 'info', message: 'No changes to save.'});
      setSaving(false);
      return;
    }

    const entityLabel =
      (updates.date || record.date) +
      (updates.flock ? ' · ' + updates.flock : record.flock ? ' · ' + record.flock : '');

    // Edit through the ownership-enforced SECDEF RPC (mig 091). The RPC returns
    // a status, not the row, so reconstruct the updated record locally.
    let result = {ok: false, data: null};
    try {
      await updateDailyReport(sb, 'sheep.daily', record.id, updates, {entityLabel});
      result = {ok: true, data: {...record, ...updates}};
    } catch (e) {
      setNotice({
        kind: 'error',
        message: 'Save failed: ' + friendlyDailyDbError(e.message || String(e), 'sheep_dailys', updates),
      });
    }

    if (result.ok) {
      setRecord(result.data);
      setForm(initForm(result.data));
      setNotice({kind: 'success', message: 'Saved.'});
    }
    setSaving(false);
  }

  async function handleDelete() {
    if (!window._wcfConfirmDelete) return;
    window._wcfConfirmDelete('Delete this daily report?', async () => {
      try {
        const label = record.date + (record.flock ? ' · ' + record.flock : '');
        await softDeleteDailyReport(sb, 'sheep.daily', record.id, label);
        navigate('/sheep/dailys');
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
        onBack={() => navigate('/sheep/dailys')}
        notice={loadError}
        onRetry={loadAll}
        maxWidth={960}
        retryButtonProps={{'data-daily-record-retry': '1'}}
        data-sheep-daily-load-error="true"
      />
    );
  }

  if (!record) {
    return (
      <RecordPageNotFound
        Header={Header}
        backLabel="Back to Daily Reports"
        onBack={() => navigate('/sheep/dailys')}
        message="Daily report not found. It may have been deleted."
      />
    );
  }

  // Visible label uses the mm/dd/yyyy formatter (fmtMDY), not raw ISO dates.
  const entityLabel = fmtMDY(record.date) + (record.flock ? ' · ' + record.flock : '');

  // Feed select options grouped by category
  const feedCategories = feedInputs.reduce((acc, fi) => {
    const cat = fi.category || 'Other';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(fi);
    return acc;
  }, {});

  return (
    <RecordPageFrame Header={Header}>
      <RecordPageBody maxWidth={960} data-sheep-daily-record-loaded="true">
        <RecordBackLink label="Back to Daily Reports" onBack={() => navigate('/sheep/dailys')} />

        <RecordSequenceNav seq={recordSeq} currentId={recordId} onNavigate={navigateSeq} />

        <RecordTitle>{entityLabel}</RecordTitle>

        {notice && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}

        <div key={record.id} data-daily-edit-form="1" style={recordFormCard}>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Date</span>
            <input type="date" value={form.date} onChange={(e) => updateField('date', e.target.value)} style={inp} />
          </div>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Team member</span>
            <LockedTeamMemberField value={form.team_member} caption={null} />
          </div>
          <div className={fieldRowClass}>
            <span style={fieldLabel}>Flock</span>
            <select value={form.flock} onChange={(e) => updateField('flock', e.target.value)} style={inp}>
              <option value="">-- select --</option>
              {FLOCK_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>

          <div style={{padding: '6px 0', borderBottom: '1px solid #f3f4f6'}}>
            <div style={{...fieldLabel, marginBottom: 4}}>Feeds</div>
            {form.feeds.map((row, idx) => (
              <div key={idx} style={{display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4}}>
                <select
                  value={row.feedId}
                  onChange={(e) => updateFeedRow(idx, 'feedId', e.target.value)}
                  style={{...feedRowControl, flex: 2}}
                >
                  <option value="">-- feed --</option>
                  {Object.entries(feedCategories).map(([cat, items]) => (
                    <optgroup key={cat} label={cat}>
                      {items.map((fi) => (
                        <option key={fi.id} value={fi.id}>
                          {fi.name} ({fi.unit})
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <input
                  type="number"
                  placeholder="qty"
                  value={row.qty}
                  onChange={(e) => updateFeedRow(idx, 'qty', e.target.value)}
                  style={{...feedRowControl, flex: 1, minWidth: 70}}
                  min="0"
                  step="any"
                />
                <button type="button" onClick={() => removeFeedRow(idx)} style={btnSmall} title="Remove row">
                  ×
                </button>
              </div>
            ))}
            <button type="button" onClick={addFeedRow} style={{...btnSmall, marginTop: 2}}>
              + Add feed
            </button>
          </div>

          <div style={{padding: '6px 0', borderBottom: '1px solid #f3f4f6'}}>
            <div style={{...fieldLabel, marginBottom: 4}}>Minerals</div>
            {form.minerals.map((row, idx) => (
              <div key={idx} style={{display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4}}>
                <select
                  value={row.feedId}
                  onChange={(e) => updateMineralRow(idx, 'feedId', e.target.value)}
                  style={{...feedRowControl, flex: 2}}
                >
                  <option value="">-- mineral --</option>
                  {Object.entries(feedCategories).map(([cat, items]) => (
                    <optgroup key={cat} label={cat}>
                      {items.map((fi) => (
                        <option key={fi.id} value={fi.id}>
                          {fi.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <input
                  type="number"
                  placeholder="lbs"
                  value={row.lbs}
                  onChange={(e) => updateMineralRow(idx, 'lbs', e.target.value)}
                  style={{...feedRowControl, flex: 1, minWidth: 70}}
                  min="0"
                  step="any"
                />
                <button type="button" onClick={() => removeMineralRow(idx)} style={btnSmall} title="Remove row">
                  ×
                </button>
              </div>
            ))}
            <button type="button" onClick={addMineralRow} style={{...btnSmall, marginTop: 2}}>
              + Add mineral
            </button>
          </div>

          {!isWebformSource && (
            <>
              <div className={fieldRowClass}>
                <span style={fieldLabel}>Fence voltage</span>
                <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
                  <input
                    type="number"
                    value={form.fence_voltage_kv}
                    onChange={(e) => updateField('fence_voltage_kv', e.target.value)}
                    style={{...inp, maxWidth: 120}}
                    min="0"
                    step="any"
                  />
                  <span style={{fontSize: 12, color: '#6b7280'}}>kV</span>
                </div>
              </div>
              <div className={fieldRowClass}>
                <span style={fieldLabel}>Waterers working</span>
                <input
                  type="checkbox"
                  checked={form.waterers_working}
                  onChange={(e) => updateField('waterers_working', e.target.checked)}
                  style={recordCheckbox}
                />
              </div>
              <div className={fieldRowClass}>
                <span style={fieldLabel}>Mortality count</span>
                <input
                  type="number"
                  value={form.mortality_count}
                  onChange={(e) => updateField('mortality_count', e.target.value)}
                  style={{...inp, maxWidth: 120}}
                  min="0"
                  step="1"
                />
              </div>
              <div className={fieldRowClass}>
                <span style={fieldLabel}>Comments</span>
                <textarea
                  value={form.comments}
                  onChange={(e) => updateField('comments', e.target.value)}
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
              style={{...recordSaveButton, opacity: saving ? 0.6 : 1}}
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
          entityType="sheep.daily"
          entityId={record.id}
          entityLabel={entityLabel}
        />
      </RecordPageBody>
    </RecordPageFrame>
  );
}
