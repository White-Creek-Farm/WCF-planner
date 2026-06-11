import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordSequenceNav from '../shared/RecordSequenceNav.jsx';
import {recordSeqNavOptions} from '../lib/recordSequence.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
import RecordPageLoadError from '../shared/RecordPageLoadError.jsx';
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
import {recordFieldRowClass, recordFieldLabel, recordControl, recordTextarea} from '../shared/recordPageControls.jsx';
import {computeProjectedCount, computeHousingDisplayCount} from '../lib/layerHousing.js';
import {getHousingCap, computeHousingStats} from './layerBatchStats.js';
import {recordStatusChange} from '../lib/activityApi.js';

const EMPTY_HOUSING_DRAFT = {
  housing_name: '',
  status: 'active',
  current_count: '',
  start_date: '',
  retired_date: '',
  notes: '',
};

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function LayerHousingPage({
  sb,
  fmt,
  Header,
  authState,
  layerGroups,
  layerBatches,
  layerHousings,
  setLayerHousings,
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const housingId = location.pathname.slice('/layer/housings/'.length);
  // Originating list order handed through route state; absent on direct links.
  const recordSeq = location.state?.recordSeq || null;
  function navigateSeq(id) {
    navigate('/layer/housings/' + id, recordSeqNavOptions(recordSeq));
  }

  const role = authState && authState.role;
  const canEdit = role === 'admin' || role === 'management';

  // Resolve housing + parent batch from the already-loaded props. main.jsx
  // guarantees layerHousings/layerBatches are populated before any layer route
  // renders, so this never races an empty by-id read on a cold direct load to
  // /layer/housings/<id>.
  const housing = React.useMemo(
    () => (layerHousings || []).find((h) => h.id === housingId) || null,
    [layerHousings, housingId],
  );
  const parentBatch = React.useMemo(() => {
    const bid = housing && housing.batch_id;
    return bid ? (layerBatches || []).find((b) => b.id === bid) || null : null;
  }, [layerBatches, housing]);
  const [rawLayerDailys, setRawLayerDailys] = React.useState([]);
  const [rawEggDailys, setRawEggDailys] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const [showForm, setShowForm] = React.useState(false);
  const [hForm, setHForm] = React.useState(EMPTY_HOUSING_DRAFT);
  const [housingSaving, setHousingSaving] = React.useState(false);
  const [housingPending, setHousingPending] = React.useState(false);
  const [err, setErr] = React.useState('');
  const housingAutoSaveTimer = React.useRef(null);

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    const PAGE = 1000;
    async function fetchAll(table, columns) {
      let all = [];
      let offset = 0;
      let done = false;
      while (!done) {
        const {data, error} = await sb
          .from(table)
          .select(columns)
          .is('deleted_at', null)
          .range(offset, offset + PAGE - 1);
        if (error) {
          throw new Error(`${table}: ${error.message}`);
        }
        if (!data || data.length === 0) {
          done = true;
          break;
        }
        all = all.concat(data);
        if (data.length < PAGE) done = true;
        else offset += PAGE;
      }
      return all;
    }
    try {
      const [ld, ed] = await Promise.all([
        fetchAll('layer_dailys', 'batch_label,batch_id,feed_lbs,grit_lbs,mortality_count,layer_count,date,feed_type'),
        fetchAll(
          'egg_dailys',
          'group1_name,group1_count,group2_name,group2_count,group3_name,group3_count,group4_name,group4_count,date',
        ),
      ]);
      setRawLayerDailys(ld);
      setRawEggDailys(ed);
    } catch (e) {
      setRawLayerDailys([]);
      setRawEggDailys([]);
      setLoadError({kind: 'error', message: 'Could not load layer housing metrics: ' + (e?.message || e)});
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    setNotice(null);
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [housingId, authState]);

  React.useEffect(() => {
    if (!loading && location.hash) {
      const anchor = location.hash.slice(1);
      setTimeout(() => {
        const el = document.getElementById(anchor);
        if (el) el.scrollIntoView({behavior: 'smooth', block: 'center'});
      }, 200);
    }
  }, [loading, location.hash]);

  function openEdit() {
    if (!canEdit || !housing) return;
    setErr('');
    setNotice(null);
    setHForm({
      housing_name: housing.housing_name || '',
      status: housing.status || 'active',
      current_count: housing.current_count != null ? String(housing.current_count) : '',
      start_date: housing.start_date || '',
      retired_date: housing.retired_date || '',
      notes: housing.notes || '',
    });
    setShowForm(true);
  }

  function buildHousingRec(formSnapshot) {
    const newVal = formSnapshot.current_count !== '' ? parseInt(formSnapshot.current_count) : null;
    const oldVal = housing && housing.current_count != null ? parseInt(housing.current_count) : null;
    const stamp =
      newVal !== oldVal ? todayStr() : housing && housing.current_count_date ? housing.current_count_date : null;
    return {
      ...housing,
      housing_name: formSnapshot.housing_name,
      status: formSnapshot.status || 'active',
      current_count: newVal,
      current_count_date: stamp,
      start_date: formSnapshot.start_date || null,
      retired_date: formSnapshot.retired_date || null,
      notes: formSnapshot.notes || null,
    };
  }

  async function persistHousing(rec) {
    if (!rec.housing_name) return false;
    const cap = getHousingCap(rec.housing_name);
    if ((rec.current_count || 0) > cap) {
      setErr('⚠ ' + rec.housing_name + ' capacity is ' + cap + ' birds. You have ' + rec.current_count + '.');
    } else {
      setErr('');
    }
    // Capture the persisted status BEFORE the write so the edit-modal Status
    // select (which can both retire AND un-retire) emits one best-effort
    // status.changed event only on a real flip — not on every autosave tick
    // (once persisted, housing.status matches rec.status next render).
    const priorStatus = housing ? housing.status : null;
    setHousingSaving(true);
    const {error} = await sb.from('layer_housings').upsert(rec, {onConflict: 'id'});
    setHousingSaving(false);
    setHousingPending(false);
    if (error) {
      setErr('Could not save: ' + error.message);
      return false;
    }
    if (typeof setLayerHousings === 'function') {
      const nextHousings = (layerHousings || []).map((x) => (x.id === rec.id ? rec : x));
      setLayerHousings(nextHousings);
    }
    if (housing && priorStatus && rec.status && priorStatus !== rec.status) {
      try {
        await recordStatusChange(sb, {
          entityType: 'layer.housing',
          entityId: housing.id,
          entityLabel: rec.housing_name || housing.housing_name || housing.id,
          from: priorStatus,
          to: rec.status,
        });
      } catch (_e) {
        /* best-effort */
      }
    }
    return true;
  }

  function scheduleHousingAutosave(formSnapshot) {
    if (!formSnapshot.housing_name) return;
    setHousingPending(true);
    clearTimeout(housingAutoSaveTimer.current);
    housingAutoSaveTimer.current = setTimeout(() => {
      const rec = buildHousingRec(formSnapshot);
      persistHousing(rec);
    }, 1500);
  }

  async function flushHousingAutosave() {
    if (housingAutoSaveTimer.current) {
      clearTimeout(housingAutoSaveTimer.current);
      housingAutoSaveTimer.current = null;
    }
    if (housingPending && hForm.housing_name) {
      const rec = buildHousingRec(hForm);
      await persistHousing(rec);
    }
  }

  async function closeForm() {
    await flushHousingAutosave();
    setShowForm(false);
    setHForm(EMPTY_HOUSING_DRAFT);
    setHousingPending(false);
    setErr('');
  }

  function updHousing(updater) {
    setHForm((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      scheduleHousingAutosave(next);
      return next;
    });
  }

  async function retireNow() {
    if (!canEdit || !housing) return;
    setNotice(null);
    const priorStatus = housing.status;
    const updated = {...housing, status: 'retired', retired_date: housing.retired_date || todayStr()};
    const {error} = await sb.from('layer_housings').upsert(updated, {onConflict: 'id'});
    if (error) {
      setNotice({kind: 'error', message: 'Could not retire: ' + error.message});
      return;
    }
    if (typeof setLayerHousings === 'function') {
      const nextHousings = (layerHousings || []).map((x) => (x.id === updated.id ? updated : x));
      setLayerHousings(nextHousings);
    }
    // Best-effort status.changed audit on the layer.housing entity for the
    // active -> retired flip (only when the status actually transitioned).
    if (priorStatus !== updated.status) {
      try {
        await recordStatusChange(sb, {
          entityType: 'layer.housing',
          entityId: housing.id,
          entityLabel: housing.housing_name || housing.id,
          from: priorStatus,
          to: updated.status,
        });
      } catch (_e) {
        /* best-effort */
      }
    }
  }

  function confirmRetire() {
    if (!canEdit || !housing) return;
    if (typeof window === 'undefined' || typeof window._wcfConfirm !== 'function') {
      retireNow();
      return;
    }
    window._wcfConfirm('Retire ' + housing.housing_name + '?', () => retireNow(), 'Retire');
  }

  if (loading) {
    return <RecordPageLoading Header={Header} />;
  }

  if (loadError) {
    return (
      <RecordPageLoadError
        Header={Header}
        backLabel="Back to Layer Batches"
        onBack={() => navigate('/layer/batches')}
        notice={loadError}
        onRetry={loadAll}
        maxWidth={900}
        data-layer-housing-load-error="true"
      />
    );
  }

  if (!housing) {
    return (
      <RecordPageNotFound
        Header={Header}
        backLabel="Back to Layer Batches"
        onBack={() => navigate('/layer/batches')}
        message="Housing not found."
      />
    );
  }

  const hStatsMap = computeHousingStats(parentBatch ? [parentBatch] : [], [housing], rawLayerDailys, rawEggDailys);
  const hs = hStatsMap[housing.id] || {};
  const displayCount = computeHousingDisplayCount(housing, rawLayerDailys);
  const proj = computeProjectedCount(housing, rawLayerDailys);
  const cap = getHousingCap(housing.housing_name);
  const util = displayCount && cap ? Math.round((displayCount / cap) * 100) : null;
  const isActive = housing.status === 'active';
  const backTarget = parentBatch ? '/layer/batches/' + parentBatch.id : '/layer/batches';
  // Label without the arrow — RecordBackLink renders the leading "← ".
  const backLabel = parentBatch ? 'Back to ' + parentBatch.name : 'Back to Layer Batches';

  return (
    <RecordPageFrame Header={Header}>
      <RecordPageBody maxWidth={900} data-layer-housing-record-loaded="true">
        <RecordBackLink label={backLabel} onBack={() => navigate(backTarget)} />

        <RecordSequenceNav seq={recordSeq} currentId={housingId} onNavigate={navigateSeq} />

        <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12}}>
          <RecordTitle fontSize={22} margin={0}>
            {'🏠 ' + housing.housing_name}
          </RecordTitle>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 10,
              background: isActive ? '#d1fae5' : '#f3f4f6',
              color: isActive ? '#065f46' : '#6b7280',
              textTransform: 'uppercase',
            }}
          >
            {housing.status}
          </span>
          {parentBatch && (
            <button
              type="button"
              onClick={() => navigate('/layer/batches/' + parentBatch.id)}
              style={{
                background: 'none',
                border: 'none',
                color: '#1d4ed8',
                cursor: 'pointer',
                fontSize: 12,
                fontFamily: 'inherit',
                padding: 0,
              }}
            >
              Batch: {parentBatch.name}
            </button>
          )}
          {housing.start_date && <span style={{fontSize: 12, color: '#6b7280'}}>from {fmt(housing.start_date)}</span>}
          {housing.retired_date && (
            <span style={{fontSize: 12, color: '#9ca3af'}}>{'→ ' + fmt(housing.retired_date)}</span>
          )}
        </div>

        {notice && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}

        <div
          style={{
            background: 'white',
            border: '1px solid #e5e7eb',
            borderRadius: 10,
            padding: '14px 18px',
            marginBottom: 12,
          }}
        >
          <div style={{display: 'flex', gap: 16, fontSize: 12, color: '#374151', flexWrap: 'wrap', marginBottom: 10}}>
            <span>
              Physical:{' '}
              <strong style={{color: '#111827'}}>{housing.current_count != null ? housing.current_count : '—'}</strong>
              {housing.current_count_date ? (
                <span style={{color: '#9ca3af', fontWeight: 400}}>{' on ' + fmt(housing.current_count_date)}</span>
              ) : null}
            </span>
            {proj && proj.anchorDate && proj.mortSince > 0 && (
              <span
                title={
                  'Anchor ' +
                  proj.anchor +
                  ' on ' +
                  fmt(proj.anchorDate) +
                  ' minus ' +
                  proj.mortSince +
                  ' mortalities since'
                }
              >
                Projected:{' '}
                <strong style={{color: proj.projected < proj.anchor * 0.9 ? '#b91c1c' : '#92400e'}}>
                  {proj.projected}
                </strong>
                <span style={{color: '#9ca3af', fontWeight: 400}}>{' (−' + proj.mortSince + ')'}</span>
              </span>
            )}
            <span>
              Capacity: <strong style={{color: '#111827'}}>{cap === 9999 ? 'Unlimited' : cap}</strong>
            </span>
            {util !== null && (
              <span>
                Utilization:{' '}
                <strong style={{color: util > 95 ? '#b91c1c' : util > 80 ? '#92400e' : '#065f46'}}>{util + '%'}</strong>
              </span>
            )}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))',
              gap: 8,
              marginBottom: 10,
            }}
          >
            {[
              ['Total Feed', hs.totalFeed > 0 ? Math.round(hs.totalFeed).toLocaleString() + ' lbs' : '—', '#92400e'],
              ['Starter', hs.starterFeed > 0 ? Math.round(hs.starterFeed).toLocaleString() + ' lbs' : '—', '#1e40af'],
              ['Grower', hs.growerFeed > 0 ? Math.round(hs.growerFeed).toLocaleString() + ' lbs' : '—', '#065f46'],
              ['Layer', hs.layerFeed > 0 ? Math.round(hs.layerFeed).toLocaleString() + ' lbs' : '—', '#78350f'],
              ['Mortality', hs.totalMort || '0', hs.totalMort > 5 ? '#b91c1c' : '#374151'],
              ['Eggs', hs.totalEggs > 0 ? hs.totalEggs.toLocaleString() : '—', '#78350f'],
            ].map(([label, val, color]) => (
              <div
                key={label}
                style={{
                  background: '#f9fafb',
                  border: '1px solid #e5e7eb',
                  borderRadius: 6,
                  padding: '10px 12px',
                  textAlign: 'center',
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    color: '#6b7280',
                    marginBottom: 4,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  {label}
                </div>
                <div style={{fontSize: 15, fontWeight: 700, color}}>{val}</div>
              </div>
            ))}
          </div>

          {housing.notes && (
            <div style={{marginTop: 6, fontSize: 11, color: '#6b7280', fontStyle: 'italic'}}>{housing.notes}</div>
          )}

          {canEdit && (
            <div style={{display: 'flex', gap: 8, marginTop: 12}}>
              <button
                type="button"
                onClick={openEdit}
                data-layer-housing-edit={housing.id}
                style={{
                  padding: '10px 16px',
                  borderRadius: 6,
                  border: '1px solid #d1d5db',
                  background: 'white',
                  color: '#374151',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                Edit Housing
              </button>
              {isActive && (
                <button
                  type="button"
                  onClick={confirmRetire}
                  data-layer-housing-retire={housing.id}
                  style={{
                    padding: '10px 16px',
                    borderRadius: 6,
                    border: '1px solid #fca5a5',
                    background: '#fef2f2',
                    color: '#b91c1c',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  Retire
                </button>
              )}
            </div>
          )}
        </div>

        <RecordCollaborationSection
          sb={sb}
          authState={authState}
          entityType="layer.housing"
          entityId={housing.id}
          entityLabel={housing.housing_name}
        />
      </RecordPageBody>

      {showForm && (
        <div
          onClick={closeForm}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,.45)',
            zIndex: 500,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: '1rem',
            overflowY: 'auto',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            data-layer-housing-form-modal
            style={{
              background: 'white',
              borderRadius: 12,
              width: '100%',
              maxWidth: 440,
              boxShadow: '0 8px 32px rgba(0,0,0,.2)',
              marginTop: 40,
            }}
          >
            <div
              style={{
                padding: '14px 20px',
                borderBottom: '1px solid #e5e7eb',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div style={{fontSize: 15, fontWeight: 600, color: '#78350f'}}>
                Edit Housing{' '}
                <span style={{fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 6}}>
                  Auto-saves as you type
                </span>
              </div>
              <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                {housingSaving ? (
                  <span style={{fontSize: 11, color: '#9ca3af'}}>{'Saving…'}</span>
                ) : housingPending ? (
                  <span style={{fontSize: 11, color: '#9ca3af'}}>{'Unsaved…'}</span>
                ) : (
                  <span style={{fontSize: 11, color: '#065f46'}}>{'✓ Saved'}</span>
                )}
                <button
                  type="button"
                  onClick={closeForm}
                  style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
                >
                  ×
                </button>
              </div>
            </div>
            {/* Edit-modal form — migrated to shared record-page controls (CP2).
                Autosave (1500ms), saved indicator, capacity warning, locked
                in-use options, stamp hints, and the retire flow are unchanged. */}
            <div style={{padding: '16px 20px', maxHeight: '65vh', overflowY: 'auto'}}>
              <div className={recordFieldRowClass}>
                <span style={recordFieldLabel}>Housing (Layer Group) *</span>
                <select
                  value={hForm.housing_name}
                  onChange={(e) => updHousing((f) => ({...f, housing_name: e.target.value}))}
                  style={recordControl}
                >
                  <option value="">{'Select housing…'}</option>
                  {(layerGroups || []).map((g) => {
                    const owningHousing = (layerHousings || []).find(
                      (x) => x.housing_name === g.name && x.status === 'active' && x.id !== housing.id,
                    );
                    const locked = !!owningHousing && housing.housing_name !== g.name;
                    const owningBatch = owningHousing
                      ? (layerBatches || []).find((b) => b.id === owningHousing.batch_id)
                      : null;
                    const label = g.name + (locked ? ' ⚠ In use' + (owningBatch ? ' by ' + owningBatch.name : '') : '');
                    return (
                      <option key={g.id} value={g.name} disabled={locked}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </div>
              {hForm.housing_name &&
                (() => {
                  const c = getHousingCap(hForm.housing_name);
                  return (
                    c < 9999 && (
                      <div
                        style={{
                          fontSize: 11,
                          color: '#92400e',
                          background: '#fffbeb',
                          border: '1px solid #fde68a',
                          borderRadius: 6,
                          padding: '6px 10px',
                          marginBottom: 4,
                        }}
                      >
                        {'⚠ Capacity: ' + c + ' birds max'}
                      </div>
                    )
                  );
                })()}
              <div className={recordFieldRowClass}>
                <span style={recordFieldLabel}>Current Count</span>
                <div>
                  <input
                    type="number"
                    min="0"
                    value={hForm.current_count || ''}
                    onChange={(e) => updHousing((f) => ({...f, current_count: e.target.value}))}
                    style={recordControl}
                  />
                  {(() => {
                    const oldVal = housing.current_count != null ? parseInt(housing.current_count) : null;
                    const newVal = hForm.current_count !== '' ? parseInt(hForm.current_count) : null;
                    if (newVal !== oldVal) {
                      return (
                        <div style={{fontSize: 10, color: '#065f46', marginTop: 4, fontWeight: 600}}>
                          {'Will be stamped: ' + fmt(todayStr())}
                        </div>
                      );
                    }
                    if (housing.current_count_date) {
                      return (
                        <div style={{fontSize: 10, color: '#9ca3af', marginTop: 4}}>
                          {'Last set: ' + fmt(housing.current_count_date)}
                        </div>
                      );
                    }
                    return null;
                  })()}
                </div>
              </div>
              <div className={recordFieldRowClass}>
                <span style={recordFieldLabel}>Start Date</span>
                <input
                  type="date"
                  value={hForm.start_date}
                  onChange={(e) => updHousing((f) => ({...f, start_date: e.target.value}))}
                  style={recordControl}
                />
              </div>
              <div className={recordFieldRowClass}>
                <span style={recordFieldLabel}>Status</span>
                <select
                  value={hForm.status}
                  onChange={(e) => updHousing((f) => ({...f, status: e.target.value}))}
                  style={recordControl}
                >
                  <option value="active">Active</option>
                  <option value="retired">Retired</option>
                </select>
              </div>
              {hForm.status === 'retired' && (
                <div className={recordFieldRowClass}>
                  <span style={recordFieldLabel}>Retired Date</span>
                  <input
                    type="date"
                    value={hForm.retired_date}
                    onChange={(e) => updHousing((f) => ({...f, retired_date: e.target.value}))}
                    style={recordControl}
                  />
                </div>
              )}
              <div className={recordFieldRowClass}>
                <span style={recordFieldLabel}>Notes</span>
                <textarea
                  value={hForm.notes}
                  onChange={(e) => updHousing((f) => ({...f, notes: e.target.value}))}
                  rows={3}
                  style={recordTextarea}
                />
              </div>
              {err && <div style={{color: '#b91c1c', fontSize: 12, fontWeight: 600, marginTop: 8}}>{err}</div>}
            </div>
          </div>
        </div>
      )}
    </RecordPageFrame>
  );
}
