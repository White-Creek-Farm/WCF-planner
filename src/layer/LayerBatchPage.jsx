import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordSequenceNav from '../shared/RecordSequenceNav.jsx';
import {recordSeqNavOptions, labeledSeqItems} from '../lib/recordSequence.js';
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
import {S} from '../lib/styles.js';
import {recordFieldRowClass, recordFieldLabel, recordControl, recordTextarea} from '../shared/recordPageControls.jsx';
import {toISO, addDays} from '../lib/dateUtils.js';
import {BROODERS, SCHOONERS, BROODER_CLEANOUT, SCHOONER_CLEANOUT, overlaps} from '../lib/broiler.js';
import {computeProjectedCount, computeHousingDisplayCount, computeLayerFeedCost} from '../lib/layerHousing.js';
import {getHousingCap, computeBatchStats, computeHousingStats} from './layerBatchStats.js';
import {recordFieldChange, recordStatusChange} from '../lib/activityApi.js';
import {deleteLayerBatch} from '../lib/layerBatchDeleteApi.js';

const EMPTY_BATCH_DRAFT = {
  name: '',
  status: 'active',
  arrival_date: '',
  original_count: '',
  supplier: '',
  cost_per_bird: '',
  brooder_name: '',
  brooder_entry_date: '',
  brooder_exit_date: '',
  schooner_name: '',
  schooner_entry_date: '',
  schooner_exit_date: '',
  notes: '',
  per_lb_starter_cost: '',
  per_lb_grower_cost: '',
  per_lb_layer_cost: '',
};

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function LayerBatchPage({
  sb,
  fmt,
  Header,
  authState,
  layerGroups,
  layerBatches,
  layerHousings,
  setLayerBatches,
  setLayerHousings,
  batches,
  feedCosts,
  confirmDelete,
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const batchId = location.pathname.slice('/layer/batches/'.length);
  // Originating list order handed through route state; absent on direct links.
  const recordSeq = location.state?.recordSeq || null;
  function navigateSeq(id) {
    navigate('/layer/batches/' + id, recordSeqNavOptions(recordSeq));
  }

  const role = authState && authState.role;
  const canEdit = role === 'admin' || role === 'management';

  // Resolve the batch from the already-loaded layerBatches prop. main.jsx
  // guarantees layerBatches is populated before any layer route renders, so this
  // never races an empty by-id read on a cold direct load to /layer/batches/<id>.
  const batch = React.useMemo(
    () => (layerBatches || []).find((b) => b.id === batchId) || null,
    [layerBatches, batchId],
  );
  const [rawLayerDailys, setRawLayerDailys] = React.useState([]);
  const [rawEggDailys, setRawEggDailys] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const [retHomePeriod, setRetHomePeriod] = React.useState(30);

  // Batch edit modal state
  const [showBatchForm, setShowBatchForm] = React.useState(false);
  const [bForm, setBForm] = React.useState(EMPTY_BATCH_DRAFT);
  const [batchSaving, setBatchSaving] = React.useState(false);
  const [batchPending, setBatchPending] = React.useState(false);
  const [err, setErr] = React.useState('');
  const batchAutoSaveTimer = React.useRef(null);
  const batchInitialNotesRef = React.useRef(null);

  // + Add Housing modal state (tiny helper — just picker + start_date, then nav)
  const [showAddHousing, setShowAddHousing] = React.useState(false);
  const [addHousingName, setAddHousingName] = React.useState('');
  const [addHousingStart, setAddHousingStart] = React.useState(todayStr());
  const [addHousingErr, setAddHousingErr] = React.useState('');
  const [addHousingBusy, setAddHousingBusy] = React.useState(false);

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
      setLoadError({kind: 'error', message: 'Could not load layer batch metrics: ' + (e?.message || e)});
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    setNotice(null);
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, authState]);

  React.useEffect(() => {
    if (!loading && location.hash) {
      const anchor = location.hash.slice(1);
      setTimeout(() => {
        const el = document.getElementById(anchor);
        if (el) el.scrollIntoView({behavior: 'smooth', block: 'center'});
      }, 200);
    }
  }, [loading, location.hash]);

  function buildBatchRec(formSnapshot) {
    const f = formSnapshot;
    return {
      id: batch ? batch.id : f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: f.name.trim(),
      status: f.status || 'active',
      arrival_date: f.arrival_date || null,
      original_count: f.original_count !== '' ? parseInt(f.original_count) : null,
      supplier: f.supplier || null,
      cost_per_bird: f.cost_per_bird !== '' ? parseFloat(f.cost_per_bird) : null,
      brooder_name: f.brooder_name || null,
      brooder_entry_date: f.brooder_entry_date || null,
      brooder_exit_date: f.brooder_exit_date || null,
      schooner_name: f.schooner_name || null,
      schooner_entry_date: f.schooner_entry_date || null,
      schooner_exit_date: f.schooner_exit_date || null,
      notes: f.notes || null,
      per_lb_starter_cost: f.per_lb_starter_cost !== '' ? parseFloat(f.per_lb_starter_cost) : null,
      per_lb_grower_cost: f.per_lb_grower_cost !== '' ? parseFloat(f.per_lb_grower_cost) : null,
      per_lb_layer_cost: f.per_lb_layer_cost !== '' ? parseFloat(f.per_lb_layer_cost) : null,
    };
  }

  async function persistBatchRec(rec) {
    // Capture the persisted status BEFORE the write so we can emit a single
    // best-effort status.changed Activity event only on a real active<->retired
    // flip (not on every debounced autosave tick — once persisted, batch.status
    // matches rec.status on the next render and this never re-fires).
    const priorStatus = batch ? batch.status : null;
    setBatchSaving(true);
    const {error} = await sb.from('layer_batches').upsert(rec, {onConflict: 'id'});
    setBatchSaving(false);
    if (error) {
      setErr('Could not save: ' + error.message);
      return false;
    }
    if (typeof setLayerBatches === 'function') {
      setLayerBatches((prev) => {
        const exists = prev.find((b) => b.id === rec.id);
        return exists ? prev.map((b) => (b.id === rec.id ? rec : b)) : [...prev, rec];
      });
    }
    setBatchPending(false);
    if (batch && priorStatus && rec.status && priorStatus !== rec.status) {
      try {
        await recordStatusChange(sb, {
          entityType: 'layer.batch',
          entityId: batch.id,
          entityLabel: rec.name || batch.name || batch.id,
          from: priorStatus,
          to: rec.status,
        });
      } catch (_e) {
        /* best-effort */
      }
    }
    return true;
  }

  function scheduleBatchAutosave(formSnapshot) {
    if (!formSnapshot.name || !formSnapshot.name.trim()) return;
    setBatchPending(true);
    clearTimeout(batchAutoSaveTimer.current);
    batchAutoSaveTimer.current = setTimeout(() => {
      const rec = buildBatchRec(formSnapshot);
      persistBatchRec(rec);
    }, 1500);
  }

  async function flushBatchAutosave() {
    clearTimeout(batchAutoSaveTimer.current);
    if (!batchPending) return true;
    if (!bForm.name || !bForm.name.trim()) {
      setErr('Batch name is required.');
      return false;
    }
    const rec = buildBatchRec(bForm);
    return await persistBatchRec(rec);
  }

  function updBatch(updater) {
    setBForm((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : {...prev, ...updater};
      scheduleBatchAutosave(next);
      return next;
    });
  }

  function openEdit() {
    if (!canEdit || !batch) return;
    setBForm({
      ...EMPTY_BATCH_DRAFT,
      ...batch,
      original_count: batch.original_count || '',
      cost_per_bird: batch.cost_per_bird || '',
      per_lb_starter_cost: batch.per_lb_starter_cost || '',
      per_lb_grower_cost: batch.per_lb_grower_cost || '',
      per_lb_layer_cost: batch.per_lb_layer_cost || '',
      notes: batch.notes || '',
    });
    batchInitialNotesRef.current = batch.notes || '';
    setErr('');
    setShowBatchForm(true);
  }

  async function closeBatchForm() {
    const ok = await flushBatchAutosave();
    if (!ok) return;
    const prevNotes = batchInitialNotesRef.current;
    const currNotes = bForm.notes || '';
    if (batch && prevNotes !== null && currNotes !== prevNotes) {
      try {
        await recordFieldChange(sb, {
          entityType: 'layer.batch',
          entityId: batch.id,
          entityLabel: bForm.name || batch.name || batch.id,
          changes: [
            {
              field: 'notes',
              label: 'Notes',
              from: prevNotes,
              to: currNotes,
              old_present: !!prevNotes,
              new_present: !!currNotes,
            },
          ],
        });
      } catch (_e) {
        /* best-effort */
      }
    }
    batchInitialNotesRef.current = null;
    setShowBatchForm(false);
    setBForm(EMPTY_BATCH_DRAFT);
    setBatchPending(false);
    setErr('');
  }

  function handleDeleteBatch() {
    if (!canEdit || !batch || typeof confirmDelete !== 'function') return;
    confirmDelete(
      'Delete batch ' + batch.name + '? This will also delete all its housings. This cannot be undone.',
      async () => {
        clearTimeout(batchAutoSaveTimer.current);
        // Transactional delete via SECDEF RPC (mig 106): clears child housings +
        // deletes the batch root + writes one deletion audit event server-side,
        // all in one transaction. Replaces the two raw client deletes.
        const res = await deleteLayerBatch(sb, batch.id);
        if (!res || !res.ok) {
          setNotice({kind: 'error', message: 'Delete failed: ' + (res?.error || res?.reason || 'unknown error')});
          return;
        }
        if (typeof setLayerHousings === 'function') {
          const nextHousings = (layerHousings || []).filter((h) => h.batch_id !== batch.id);
          setLayerHousings(nextHousings);
        }
        if (typeof setLayerBatches === 'function') {
          setLayerBatches((prev) => prev.filter((b) => b.id !== batch.id));
        }
        navigate('/layer/batches');
      },
    );
  }

  async function saveNewHousing() {
    if (!canEdit || !batch) return;
    setAddHousingErr('');
    const name = (addHousingName || '').trim();
    if (!name) {
      setAddHousingErr('Pick a housing first.');
      return;
    }
    setAddHousingBusy(true);
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    const rec = {
      id,
      batch_id: batch.id,
      housing_name: name,
      status: 'active',
      current_count: null,
      current_count_date: null,
      start_date: addHousingStart || null,
      retired_date: null,
      notes: null,
    };
    const {error} = await sb.from('layer_housings').upsert(rec, {onConflict: 'id'});
    setAddHousingBusy(false);
    if (error) {
      setAddHousingErr('Could not save: ' + error.message);
      return;
    }
    if (typeof setLayerHousings === 'function') {
      const nextHousings = [...(layerHousings || []), rec];
      setLayerHousings(nextHousings);
    }
    setShowAddHousing(false);
    setAddHousingName('');
    setAddHousingStart(todayStr());
    navigate('/layer/housings/' + id);
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
        data-layer-batch-load-error="true"
      />
    );
  }

  if (!batch) {
    return (
      <RecordPageNotFound
        Header={Header}
        backLabel="Back to Layer Batches"
        onBack={() => navigate('/layer/batches')}
        message="Batch not found."
      />
    );
  }

  const batchHousings = (layerHousings || []).filter((h) => h.batch_id === batch.id);
  const isRetHome = batch.name === 'Retirement Home';

  // Stats for this batch (compute locally so the page is self-contained).
  const allBatchStats = computeBatchStats([batch], batchHousings, rawLayerDailys, rawEggDailys);
  const allHousingStats = computeHousingStats([batch], batchHousings, rawLayerDailys, rawEggDailys);
  let s;
  if (isRetHome) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retHomePeriod);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    const windowReports = rawLayerDailys.filter((d) => d.batch_id === batch.id && d.date >= cutoffStr);
    const anchor = batch.brooder_entry_date || batch.arrival_date || null;
    let totalFeed = 0;
    let totalMort = 0;
    let starterFeed = 0;
    let growerFeed = 0;
    let layerFeed = 0;
    windowReports.forEach((d) => {
      const f = parseFloat(d.feed_lbs) || 0;
      totalFeed += f;
      totalMort += parseInt(d.mortality_count) || 0;
      if (!anchor) layerFeed += f;
      else {
        try {
          const days = Math.floor((new Date(d.date + 'T12:00:00') - new Date(anchor + 'T12:00:00')) / 86400000);
          if (days < 21) starterFeed += f;
          else if (days < 140) growerFeed += f;
          else layerFeed += f;
        } catch (_e) {
          layerFeed += f;
        }
      }
    });
    s = {
      totalFeed,
      totalMort,
      starterFeed,
      growerFeed,
      layerFeed,
      totalEggs: (allBatchStats[batch.id] || {}).totalEggs || 0,
    };
  } else {
    s = allBatchStats[batch.id] || {};
  }

  const feedCost = computeLayerFeedCost(s.starterFeed, s.growerFeed, s.layerFeed, batch);
  const totalDozens = s.totalEggs > 0 ? s.totalEggs / 12 : 0;
  const costPerDoz = feedCost != null && totalDozens > 0 ? feedCost / totalDozens : null;
  const fmt$ = (v) => '$' + v.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const periodLabel = isRetHome
    ? {30: 'Last 30 Days', 90: 'Last 90 Days', 180: 'Last 6 Months'}[retHomePeriod]
    : 'Lifetime';

  // Performance summary tiles (non-RetHome)
  let perfTiles = null;
  if (!isRetHome) {
    const orig = parseInt(batch.original_count) || 0;
    const currentHens = batchHousings.reduce((sum, h) => sum + computeHousingDisplayCount(h, rawLayerDailys), 0);
    const todayISOstr = new Date().toISOString().split('T')[0];
    let endDate = todayISOstr;
    if (batch.status === 'retired') {
      const ret = batchHousings
        .map((h) => h.retired_date)
        .filter(Boolean)
        .sort();
      endDate = ret.length > 0 ? ret[ret.length - 1] : batch.schooner_exit_date || todayISOstr;
    }
    const anchor = batch.brooder_entry_date || batch.arrival_date || null;
    const batchAgeDays = anchor
      ? Math.max(0, Math.round((new Date(endDate + 'T12:00:00') - new Date(anchor + 'T12:00:00')) / 86400000))
      : 0;
    const batchAgeMonths = +(batchAgeDays / 30.44).toFixed(1);
    const batchAgeStr = batchAgeDays > 0 ? `${batchAgeMonths} months (${batchAgeDays} days)` : '—';
    const firstHousingStart =
      batchHousings.length > 0
        ? batchHousings
            .map((h) => h.start_date)
            .filter(Boolean)
            .sort()[0]
        : null;
    const daysInHousing = firstHousingStart
      ? Math.max(
          0,
          Math.round((new Date(endDate + 'T12:00:00') - new Date(firstHousingStart + 'T12:00:00')) / 86400000),
        )
      : 0;
    const eggsPerHen = orig > 0 ? s.totalEggs / orig : null;
    const eggsPerHenPerDay = currentHens > 0 && daysInHousing > 0 ? s.totalEggs / (currentHens * daysInHousing) : null;
    const feedPerHen = orig > 0 ? s.totalFeed / orig : null;
    const costPerHen = feedCost != null && orig > 0 ? feedCost / orig : null;
    perfTiles = [
      {l: 'Batch Age', v: batchAgeStr, c: '#78350f'},
      {l: 'Days in Housing', v: daysInHousing > 0 ? daysInHousing + ' days' : '—', c: '#374151'},
      {
        l: 'Original → Current',
        v: orig > 0 ? orig.toLocaleString() + ' → ' + currentHens.toLocaleString() : '—',
        c: '#78350f',
      },
      {
        l: 'Dozens / Hen (lifetime)',
        v: eggsPerHen != null ? (eggsPerHen / 12).toFixed(1) + ' doz' : '—',
        c: '#78350f',
      },
      {
        l: 'Eggs / Hen / Day (housing)',
        v: eggsPerHenPerDay != null ? eggsPerHenPerDay.toFixed(3) : '—',
        c: eggsPerHenPerDay != null && eggsPerHenPerDay >= 0.7 ? '#065f46' : '#b45309',
      },
      {l: 'Feed / Hen (lifetime)', v: feedPerHen != null ? feedPerHen.toFixed(1) + ' lbs' : '—', c: '#92400e'},
      {l: 'Cost / Hen (lifetime)', v: costPerHen != null ? fmt$(costPerHen) : '—', c: '#065f46'},
    ];
  }

  return (
    <RecordPageFrame Header={Header}>
      <RecordPageBody maxWidth={1100} data-layer-batch-record-loaded="true">
        <RecordBackLink label="Back to Layer Batches" onBack={() => navigate('/layer/batches')} />

        <RecordSequenceNav seq={recordSeq} currentId={batchId} onNavigate={navigateSeq} />

        <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12}}>
          <RecordTitle fontSize={24} margin={0}>
            {batch.name}
          </RecordTitle>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 10,
              background: batch.status === 'active' ? '#d1fae5' : '#f3f4f6',
              color: batch.status === 'active' ? '#065f46' : '#6b7280',
              textTransform: 'uppercase',
            }}
          >
            {isRetHome ? 'Permanent' : batch.status}
          </span>
          {(batch.brooder_entry_date || batch.arrival_date) &&
            (() => {
              const anchor = batch.brooder_entry_date || batch.arrival_date;
              const months = +((new Date() - new Date(anchor + 'T12:00:00')) / 86400000 / 30.44).toFixed(1);
              return months > 0 ? <span style={{fontSize: 12, color: '#6b7280'}}>{months + ' months old'}</span> : null;
            })()}
          {canEdit && (
            <button
              type="button"
              onClick={openEdit}
              data-layer-batch-edit={batch.id}
              style={{
                marginLeft: 'auto',
                padding: '10px 16px',
                borderRadius: 6,
                border: '1px solid #d1d5db',
                background: 'white',
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Edit Batch
            </button>
          )}
        </div>

        {notice && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}

        {/* Stats grid */}
        {isRetHome && (
          <div
            style={{
              display: 'flex',
              gap: 0,
              marginBottom: 12,
              borderRadius: 6,
              overflow: 'hidden',
              border: '1px solid #d1d5db',
              width: 'fit-content',
            }}
          >
            {[
              {v: 30, l: '30 Days'},
              {v: 90, l: '90 Days'},
              {v: 180, l: '6 Months'},
            ].map(({v, l}) => (
              <button
                key={v}
                type="button"
                onClick={() => setRetHomePeriod(v)}
                style={{
                  padding: '7px 16px',
                  border: 'none',
                  fontFamily: 'inherit',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: retHomePeriod === v ? '#085041' : 'white',
                  color: retHomePeriod === v ? 'white' : '#6b7280',
                }}
              >
                {l}
              </button>
            ))}
          </div>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(110px,1fr))',
            gap: 10,
            marginBottom: 20,
          }}
        >
          {[
            [
              'Total Feed' + (isRetHome ? ' (' + periodLabel + ')' : ''),
              s.totalFeed > 0 ? Math.round(s.totalFeed).toLocaleString() + ' lbs' : '—',
              '#92400e',
            ],
            ...(isRetHome
              ? []
              : [
                  [
                    'Starter Feed',
                    s.starterFeed > 0 ? Math.round(s.starterFeed).toLocaleString() + ' lbs' : '—',
                    s.starterFeed >= 1400 ? '#b91c1c' : '#1e40af',
                  ],
                ]),
            ...(isRetHome
              ? []
              : [
                  [
                    'Grower Feed',
                    s.growerFeed > 0 ? Math.round(s.growerFeed).toLocaleString() + ' lbs' : '—',
                    '#065f46',
                  ],
                ]),
            ['Layer Feed', s.layerFeed > 0 ? Math.round(s.layerFeed).toLocaleString() + ' lbs' : '—', '#78350f'],
            [
              'Mortality' + (isRetHome ? ' (' + periodLabel + ')' : ''),
              s.totalMort || '0',
              s.totalMort > 10 ? '#b91c1c' : '#374151',
            ],
            ...(isRetHome
              ? []
              : [['Total Dozens', s.totalEggs > 0 ? Math.floor(s.totalEggs / 12).toLocaleString() : '—', '#065f46']]),
            ...(isRetHome ? [] : [['Feed Cost', feedCost != null ? fmt$(feedCost) : '—', '#92400e']]),
            ...(isRetHome ? [] : [['Cost / Dozen', costPerDoz != null ? fmt$(costPerDoz) : '—', '#065f46']]),
          ].map(([l, v, c]) => (
            <div
              key={l}
              style={{
                background: 'white',
                border: '1px solid #e5e7eb',
                borderRadius: 10,
                padding: '12px 14px',
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
                {l}
              </div>
              <div style={{fontSize: 18, fontWeight: 700, color: c || '#111827'}}>{v}</div>
            </div>
          ))}
        </div>

        {/* Performance summary */}
        {perfTiles && (
          <div
            style={{
              background: 'white',
              border: '1px solid #e5e7eb',
              borderRadius: 12,
              padding: '16px 20px',
              marginBottom: 16,
            }}
          >
            <div style={{fontSize: 12, fontWeight: 700, color: '#4b5563', letterSpacing: 0.5, marginBottom: 12}}>
              PERFORMANCE SUMMARY
            </div>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10}}>
              {perfTiles.map((t) => (
                <div
                  key={t.l}
                  style={{
                    background: '#f9fafb',
                    border: '1px solid #e5e7eb',
                    borderRadius: 10,
                    padding: '12px 14px',
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
                    {t.l}
                  </div>
                  <div style={{fontSize: 18, fontWeight: 700, color: t.c || '#111827'}}>{t.v}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Lifecycle phases */}
        {!isRetHome && (
          <div
            style={{
              background: 'white',
              border: '1px solid #e5e7eb',
              borderRadius: 12,
              padding: '16px 20px',
              marginBottom: 16,
            }}
          >
            <div style={{fontSize: 12, fontWeight: 700, color: '#4b5563', letterSpacing: 0.5, marginBottom: 12}}>
              LIFECYCLE PHASES
            </div>
            <div style={{display: 'flex', gap: 0, alignItems: 'stretch'}}>
              {[
                {
                  label: 'Brooder',
                  icon: '🔆',
                  name: batch.brooder_name,
                  entry: batch.brooder_entry_date,
                  exit: batch.brooder_exit_date,
                  color: '#dbeafe',
                  border: '#93c5fd',
                  text: '#1e40af',
                },
                {
                  label: 'Schooner',
                  icon: '🚌',
                  name: batch.schooner_name,
                  entry: batch.schooner_entry_date,
                  exit: batch.schooner_exit_date,
                  color: '#d1fae5',
                  border: '#6ee7b7',
                  text: '#065f46',
                },
                {
                  label: 'Housing',
                  icon: '🏠',
                  name:
                    batchHousings
                      .filter((h) => h.status === 'active')
                      .map((h) => h.housing_name)
                      .join(', ') || '—',
                  entry: batchHousings[0]?.start_date,
                  exit: null,
                  color: '#fef3c7',
                  border: '#fde68a',
                  text: '#92400e',
                },
              ].map((phase, i) => (
                <React.Fragment key={phase.label}>
                  <div
                    style={{
                      flex: 1,
                      background: phase.color,
                      borderWidth: 1,
                      borderStyle: 'solid',
                      borderColor: phase.border,
                      borderRadius: i === 0 ? '8px 0 0 8px' : i === 2 ? '0 8px 8px 0' : '0',
                      padding: '10px 14px',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: phase.text,
                        letterSpacing: 0.5,
                        marginBottom: 4,
                      }}
                    >
                      {phase.icon} {phase.label.toUpperCase()}
                    </div>
                    <div style={{fontSize: 12, fontWeight: 600, color: '#111827', marginBottom: 4}}>
                      {phase.name || <span style={{color: '#9ca3af'}}>Not set</span>}
                    </div>
                    <div style={{fontSize: 10, color: '#6b7280'}}>
                      {phase.entry ? fmt(phase.entry) : '—'}
                      {phase.exit ? ' → ' + fmt(phase.exit) : ' → present'}
                    </div>
                  </div>
                  {i < 2 && (
                    <div
                      style={{
                        width: 20,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 14,
                        color: '#9ca3af',
                        flexShrink: 0,
                      }}
                    >
                      →
                    </div>
                  )}
                </React.Fragment>
              ))}
            </div>
          </div>
        )}

        {/* Housings */}
        <div style={{marginBottom: 16}}>
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10}}>
            <div style={{fontSize: 12, fontWeight: 700, color: '#4b5563', letterSpacing: 0.5}}>HOUSINGS</div>
            {canEdit && batch.status === 'active' && (
              <button
                type="button"
                onClick={() => {
                  setAddHousingErr('');
                  setAddHousingName('');
                  setAddHousingStart(todayStr());
                  setShowAddHousing(true);
                }}
                data-layer-batch-add-housing={batch.id}
                style={{
                  padding: '5px 14px',
                  borderRadius: 6,
                  border: 'none',
                  background: '#085041',
                  color: 'white',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                + Add Housing
              </button>
            )}
          </div>
          {batchHousings.length === 0 && (
            <div style={{color: '#9ca3af', fontSize: 13, padding: '1rem 0'}}>No housings yet.</div>
          )}
          <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
            {batchHousings.map((h) => {
              const hs = allHousingStats[h.id] || {};
              const cap = getHousingCap(h.housing_name);
              const displayCount = computeHousingDisplayCount(h, rawLayerDailys);
              const proj = computeProjectedCount(h, rawLayerDailys);
              const util = displayCount && cap ? Math.round((displayCount / cap) * 100) : null;
              return (
                <div
                  key={h.id}
                  data-layer-housing-tile={h.id}
                  onClick={() =>
                    navigate(
                      '/layer/housings/' + h.id,
                      recordSeqNavOptions(labeledSeqItems(batchHousings, 'housing_name')),
                    )
                  }
                  className="hoverable-tile"
                  style={{
                    background: 'white',
                    border: h.status === 'active' ? '1px solid #fde68a' : '1px solid #e5e7eb',
                    borderRadius: 10,
                    padding: '14px 18px',
                    display: 'flex',
                    gap: 16,
                    alignItems: 'center',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{flex: 1}}>
                    <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap'}}>
                      <span style={{fontSize: 13, fontWeight: 700, color: '#111827'}}>{'🏠 ' + h.housing_name}</span>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 7px',
                          borderRadius: 6,
                          background: h.status === 'active' ? '#d1fae5' : '#f3f4f6',
                          color: h.status === 'active' ? '#065f46' : '#6b7280',
                          textTransform: 'uppercase',
                        }}
                      >
                        {h.status}
                      </span>
                      {h.start_date && <span style={{fontSize: 11, color: '#6b7280'}}>from {fmt(h.start_date)}</span>}
                      {h.retired_date && (
                        <span style={{fontSize: 11, color: '#9ca3af'}}>{'→ ' + fmt(h.retired_date)}</span>
                      )}
                    </div>
                    <div style={{display: 'flex', gap: 16, fontSize: 11, color: '#6b7280', flexWrap: 'wrap'}}>
                      <span>
                        Physical:{' '}
                        <strong style={{color: '#374151'}}>{h.current_count != null ? h.current_count : '—'}</strong>
                      </span>
                      {proj && proj.anchorDate && proj.mortSince > 0 && (
                        <span>
                          Projected:{' '}
                          <strong style={{color: proj.projected < proj.anchor * 0.9 ? '#b91c1c' : '#92400e'}}>
                            {proj.projected}
                          </strong>
                        </span>
                      )}
                      <span>
                        Capacity: <strong style={{color: '#374151'}}>{cap === 9999 ? 'Unlimited' : cap}</strong>
                      </span>
                      {util !== null && (
                        <span>
                          Utilization:{' '}
                          <strong style={{color: util > 95 ? '#b91c1c' : util > 80 ? '#92400e' : '#065f46'}}>
                            {util + '%'}
                          </strong>
                        </span>
                      )}
                      <span style={{fontSize: 11, color: '#6b7280'}}>
                        Feed: {hs.totalFeed > 0 ? Math.round(hs.totalFeed) + ' lbs' : '—'} · Eggs:{' '}
                        {hs.totalEggs > 0 ? hs.totalEggs.toLocaleString() : '—'}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Batch notes display */}
        {batch.notes && (
          <div
            style={{
              background: 'white',
              border: '1px solid #e5e7eb',
              borderRadius: 10,
              padding: '12px 16px',
              fontSize: 12,
              color: '#374151',
              marginBottom: 16,
            }}
          >
            <span style={{color: '#9ca3af'}}>Notes: </span>
            {batch.notes}
          </div>
        )}

        <RecordCollaborationSection
          sb={sb}
          authState={authState}
          entityType="layer.batch"
          entityId={batch.id}
          entityLabel={batch.name}
        />
      </RecordPageBody>

      {/* + Add Housing helper modal */}
      {showAddHousing && (
        <div
          onClick={() => setShowAddHousing(false)}
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
            data-layer-add-housing-modal
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
              <div style={{fontSize: 15, fontWeight: 600, color: '#78350f'}}>Add Housing</div>
              <button
                type="button"
                onClick={() => setShowAddHousing(false)}
                style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
              >
                ×
              </button>
            </div>
            <div style={{padding: '16px 20px'}}>
              <div className={recordFieldRowClass}>
                <span style={recordFieldLabel}>Housing (Layer Group) *</span>
                <select
                  value={addHousingName}
                  onChange={(e) => setAddHousingName(e.target.value)}
                  style={recordControl}
                >
                  <option value="">{'Select housing…'}</option>
                  {(layerGroups || []).map((g) => {
                    const owning = (layerHousings || []).find(
                      (h) => h.housing_name === g.name && h.status === 'active',
                    );
                    const locked = !!owning;
                    const owningBatch = owning ? (layerBatches || []).find((b) => b.id === owning.batch_id) : null;
                    const label = g.name + (locked ? ' ⚠ In use' + (owningBatch ? ' by ' + owningBatch.name : '') : '');
                    return (
                      <option key={g.id} value={g.name} disabled={locked}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </div>
              <div className={recordFieldRowClass}>
                <span style={recordFieldLabel}>Start Date</span>
                <input
                  type="date"
                  value={addHousingStart}
                  onChange={(e) => setAddHousingStart(e.target.value)}
                  style={recordControl}
                />
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: '#6b7280',
                  background: '#f9fafb',
                  border: '1px solid #e5e7eb',
                  borderRadius: 6,
                  padding: '8px 10px',
                }}
              >
                Saves a housing shell and opens its record page. Fill in count, status, and notes there.
              </div>
              {addHousingErr && <div style={{color: '#b91c1c', fontSize: 12, fontWeight: 600}}>{addHousingErr}</div>}
            </div>
            <div style={{padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8}}>
              <button
                type="button"
                onClick={saveNewHousing}
                disabled={addHousingBusy || !addHousingName}
                data-layer-add-housing-save
                style={{
                  padding: '8px 18px',
                  borderRadius: 6,
                  border: 'none',
                  background: addHousingBusy || !addHousingName ? '#9ca3af' : '#085041',
                  color: 'white',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: addHousingBusy || !addHousingName ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Save & open
              </button>
              <button
                type="button"
                onClick={() => setShowAddHousing(false)}
                style={{
                  padding: '10px 16px',
                  borderRadius: 6,
                  border: '1px solid #d1d5db',
                  background: 'white',
                  color: '#6b7280',
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Batch form modal */}
      {showBatchForm && (
        <div
          onClick={closeBatchForm}
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
            data-layer-batch-form-modal
            style={{
              background: 'white',
              borderRadius: 12,
              width: '100%',
              maxWidth: 540,
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
                Edit Layer Batch{' '}
                <span style={{fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 6}}>
                  Auto-saves as you type
                </span>
              </div>
              <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                {batchSaving ? (
                  <span style={{fontSize: 11, color: '#9ca3af'}}>{'Saving…'}</span>
                ) : batchPending ? (
                  <span style={{fontSize: 11, color: '#9ca3af'}}>{'Unsaved…'}</span>
                ) : (
                  <span style={{fontSize: 11, color: '#065f46'}}>{'✓ Saved'}</span>
                )}
                <button
                  type="button"
                  onClick={closeBatchForm}
                  style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
                >
                  ×
                </button>
              </div>
            </div>
            <div style={{padding: '16px 20px', maxHeight: '70vh', overflowY: 'auto'}}>
              <div className={recordFieldRowClass}>
                <span style={recordFieldLabel}>Batch Name *</span>
                <input
                  value={bForm.name}
                  onChange={(e) => updBatch((f) => ({...f, name: e.target.value}))}
                  placeholder="e.g. L-26-01"
                  style={recordControl}
                />
              </div>
              <div className={recordFieldRowClass}>
                <span style={recordFieldLabel}>Status</span>
                <select
                  value={bForm.status}
                  onChange={(e) => updBatch((f) => ({...f, status: e.target.value}))}
                  style={recordControl}
                >
                  <option value="active">Active</option>
                  <option value="retired">Retired</option>
                </select>
              </div>
              {bForm.name !== 'Retirement Home' && (
                <div className={recordFieldRowClass}>
                  <span style={recordFieldLabel}>Original Count</span>
                  <input
                    type="number"
                    min="0"
                    value={bForm.original_count || ''}
                    onChange={(e) => updBatch((f) => ({...f, original_count: e.target.value}))}
                    style={recordControl}
                  />
                </div>
              )}
              {bForm.name !== 'Retirement Home' && (
                <div className={recordFieldRowClass}>
                  <span style={recordFieldLabel}>Supplier</span>
                  <input
                    value={bForm.supplier}
                    onChange={(e) => updBatch((f) => ({...f, supplier: e.target.value}))}
                    style={recordControl}
                  />
                </div>
              )}
              {bForm.name !== 'Retirement Home' && (
                <div className={recordFieldRowClass}>
                  <span style={recordFieldLabel}>Cost per Bird ($)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    style={{...recordControl, maxWidth: 160}}
                    value={bForm.cost_per_bird || ''}
                    onChange={(e) => updBatch((f) => ({...f, cost_per_bird: e.target.value}))}
                  />
                </div>
              )}

              {/* Feed cost rates (read-only) */}
              {bForm.name !== 'Retirement Home' && (
                <div style={{borderTop: '1px solid #e5e7eb', paddingTop: 10, marginTop: 4}}>
                  <div style={{fontSize: 11, fontWeight: 700, color: '#4b5563', letterSpacing: 0.5, marginBottom: 6}}>
                    {'💰 FEED COST RATES'}{' '}
                    <span style={{fontWeight: 400, color: '#9ca3af'}}>{'(locked — set in Admin › Feed Costs)'}</span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      gap: 16,
                      fontSize: 12,
                      color: '#374151',
                      padding: '8px 12px',
                      background: '#f9fafb',
                      borderRadius: 6,
                      border: '1px solid #e5e7eb',
                    }}
                  >
                    <span>
                      Starter:{' '}
                      <strong>
                        {bForm.per_lb_starter_cost !== '' && bForm.per_lb_starter_cost != null
                          ? '$' + parseFloat(bForm.per_lb_starter_cost).toFixed(3) + '/lb'
                          : '—'}
                      </strong>
                    </span>
                    <span>
                      Grower:{' '}
                      <strong>
                        {bForm.per_lb_grower_cost !== '' && bForm.per_lb_grower_cost != null
                          ? '$' + parseFloat(bForm.per_lb_grower_cost).toFixed(3) + '/lb'
                          : '—'}
                      </strong>
                    </span>
                    <span>
                      Layer:{' '}
                      <strong>
                        {bForm.per_lb_layer_cost !== '' && bForm.per_lb_layer_cost != null
                          ? '$' + parseFloat(bForm.per_lb_layer_cost).toFixed(3) + '/lb'
                          : '—'}
                      </strong>
                    </span>
                  </div>
                </div>
              )}

              {/* Brooder phase */}
              {bForm.name !== 'Retirement Home' && (
                <div
                  style={{
                    borderTop: '1px solid #e5e7eb',
                    paddingTop: 10,
                    marginTop: 4,
                    fontSize: 11,
                    fontWeight: 700,
                    color: '#4b5563',
                    letterSpacing: 0.5,
                  }}
                >
                  🔆 BROODER PHASE <span style={{fontWeight: 400, color: '#9ca3af'}}>(fixed 3 weeks)</span>
                </div>
              )}
              {bForm.name !== 'Retirement Home' && (
                <div className={recordFieldRowClass}>
                  <span style={recordFieldLabel}>Brooder</span>
                  <select
                    value={bForm.brooder_name}
                    style={recordControl}
                    onChange={(e) => {
                      const val = e.target.value;
                      const entry = bForm.brooder_entry_date;
                      const exit = entry ? toISO(addDays(new Date(entry + 'T12:00:00'), 21)) : bForm.brooder_exit_date;
                      const schoonerIn = exit || bForm.schooner_entry_date;
                      const schoonerOut = schoonerIn
                        ? toISO(addDays(new Date(schoonerIn + 'T12:00:00'), 119))
                        : bForm.schooner_exit_date;
                      updBatch((f) => ({
                        ...f,
                        brooder_name: val,
                        brooder_exit_date: exit || f.brooder_exit_date,
                        schooner_entry_date: schoonerIn || f.schooner_entry_date,
                        schooner_exit_date: schoonerOut || f.schooner_exit_date,
                      }));
                    }}
                  >
                    <option value="">Select brooder…</option>
                    {BROODERS.map((b) => {
                      const entry = bForm.brooder_entry_date;
                      const exit = entry ? toISO(addDays(new Date(entry + 'T12:00:00'), 21 + BROODER_CLEANOUT)) : null;
                      const conflictBroiler =
                        entry &&
                        exit &&
                        (batches || [])
                          .filter((bt) => bt.brooder === b && bt.id !== batch.id)
                          .some((bt) => {
                            const exEnd = toISO(
                              addDays(
                                new Date((bt.brooderOut || bt.brooder_exit_date || entry) + 'T12:00:00'),
                                BROODER_CLEANOUT,
                              ),
                            );
                            return overlaps(entry, exit, bt.brooderIn || bt.brooder_entry_date || '', exEnd);
                          });
                      const conflictLayer =
                        entry &&
                        exit &&
                        (layerBatches || [])
                          .filter((lb) => lb.brooder_name === b && lb.id !== batch.id && lb.brooder_entry_date)
                          .some((lb) => {
                            const lbExit =
                              lb.brooder_exit_date ||
                              toISO(addDays(new Date(lb.brooder_entry_date + 'T12:00:00'), 21 + BROODER_CLEANOUT));
                            return overlaps(entry, exit, lb.brooder_entry_date, lbExit);
                          });
                      const conflict = conflictBroiler || conflictLayer;
                      return (
                        <option
                          key={b}
                          value={'Brooder ' + b}
                          disabled={conflict}
                          style={{color: conflict ? '#9ca3af' : 'inherit'}}
                        >
                          {'Brooder ' + b + (conflict ? ' ⚠ In use' : '')}
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}
              {bForm.name !== 'Retirement Home' && (
                <div className={recordFieldRowClass}>
                  <span style={recordFieldLabel}>Date in Brooder</span>
                  <input
                    type="date"
                    style={recordControl}
                    value={bForm.brooder_entry_date}
                    onChange={(e) => {
                      const entry = e.target.value;
                      const exit = entry ? toISO(addDays(new Date(entry + 'T12:00:00'), 21)) : '';
                      const schoonerOut = exit ? toISO(addDays(new Date(exit + 'T12:00:00'), 119)) : '';
                      updBatch((f) => ({
                        ...f,
                        brooder_entry_date: entry,
                        brooder_exit_date: exit,
                        schooner_entry_date: exit,
                        schooner_exit_date: schoonerOut,
                        arrival_date: entry || f.arrival_date,
                      }));
                    }}
                  />
                </div>
              )}
              {bForm.name !== 'Retirement Home' && (
                <div className={recordFieldRowClass}>
                  <span style={recordFieldLabel}>
                    Exit Date <span style={{color: '#9ca3af', fontWeight: 400}}>(auto)</span>
                  </span>
                  <input
                    type="date"
                    value={bForm.brooder_exit_date}
                    readOnly
                    style={{...recordControl, background: '#f9fafb', color: '#6b7280'}}
                  />
                </div>
              )}

              {/* Schooner phase */}
              {bForm.name !== 'Retirement Home' && (
                <div
                  style={{
                    borderTop: '1px solid #e5e7eb',
                    paddingTop: 10,
                    marginTop: 4,
                    fontSize: 11,
                    fontWeight: 700,
                    color: '#4b5563',
                    letterSpacing: 0.5,
                  }}
                >
                  🚌 SCHOONER PHASE <span style={{fontWeight: 400, color: '#9ca3af'}}>(3 to 24 weeks)</span>
                </div>
              )}
              {bForm.name !== 'Retirement Home' && (
                <div className={recordFieldRowClass}>
                  <span style={recordFieldLabel}>Schooner</span>
                  <select
                    value={bForm.schooner_name}
                    onChange={(e) => updBatch((f) => ({...f, schooner_name: e.target.value}))}
                    style={recordControl}
                  >
                    <option value="">Select schooner…</option>
                    {SCHOONERS.map((sc) => {
                      const entry = bForm.schooner_entry_date;
                      const exit =
                        bForm.schooner_exit_date ||
                        (entry ? toISO(addDays(new Date(entry + 'T12:00:00'), 119 + SCHOONER_CLEANOUT)) : null);
                      const conflictBroiler =
                        entry &&
                        exit &&
                        (batches || [])
                          .filter((bt) => bt.schooner === sc && bt.id !== batch.id)
                          .some((bt) => {
                            const exEnd = toISO(
                              addDays(
                                new Date((bt.schoonerOut || bt.schooner_exit_date || entry) + 'T12:00:00'),
                                SCHOONER_CLEANOUT,
                              ),
                            );
                            return overlaps(entry, exit, bt.schoonerIn || bt.schooner_entry_date || '', exEnd);
                          });
                      const conflictLayer =
                        entry &&
                        exit &&
                        (layerBatches || [])
                          .filter(
                            (lb) =>
                              lb.schooner_name === 'Schooner ' + sc && lb.id !== batch.id && lb.schooner_entry_date,
                          )
                          .some((lb) => {
                            const lbExit =
                              lb.schooner_exit_date ||
                              toISO(addDays(new Date(lb.schooner_entry_date + 'T12:00:00'), 119 + SCHOONER_CLEANOUT));
                            return overlaps(entry, exit, lb.schooner_entry_date, lbExit);
                          });
                      const conflict = conflictBroiler || conflictLayer;
                      return (
                        <option
                          key={sc}
                          value={'Schooner ' + sc}
                          disabled={conflict}
                          style={{color: conflict ? '#9ca3af' : 'inherit'}}
                        >
                          {'Schooner ' + sc + (conflict ? ' ⚠ In use' : '')}
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}
              {bForm.name !== 'Retirement Home' && (
                <div className={recordFieldRowClass}>
                  <span style={recordFieldLabel}>
                    Entry Date <span style={{color: '#9ca3af', fontWeight: 400}}>(auto)</span>
                  </span>
                  <input
                    type="date"
                    style={recordControl}
                    value={bForm.schooner_entry_date}
                    onChange={(e) => {
                      const entry = e.target.value;
                      const exit = entry ? toISO(addDays(new Date(entry + 'T12:00:00'), 119)) : '';
                      updBatch((f) => ({...f, schooner_entry_date: entry, schooner_exit_date: exit}));
                    }}
                  />
                </div>
              )}
              {bForm.name !== 'Retirement Home' && (
                <div className={recordFieldRowClass}>
                  <span style={recordFieldLabel}>
                    Exit Date <span style={{color: '#9ca3af', fontWeight: 400}}>(editable)</span>
                  </span>
                  <input
                    type="date"
                    style={recordControl}
                    value={bForm.schooner_exit_date}
                    onChange={(e) => updBatch((f) => ({...f, schooner_exit_date: e.target.value}))}
                  />
                </div>
              )}
              {bForm.name !== 'Retirement Home' &&
                bForm.schooner_entry_date &&
                bForm.schooner_exit_date &&
                (() => {
                  const weeks = Math.round(
                    (new Date(bForm.schooner_exit_date + 'T12:00:00') -
                      new Date(bForm.schooner_entry_date + 'T12:00:00')) /
                      604800000,
                  );
                  const warn = weeks < 3 || weeks > 24;
                  return (
                    <div
                      style={{
                        fontSize: 11,
                        padding: '4px 8px',
                        borderRadius: 5,
                        background: warn ? '#fef2f2' : '#ecfdf5',
                        color: warn ? '#b91c1c' : '#065f46',
                        fontWeight: 600,
                      }}
                    >
                      {warn ? '⚠ ' : ''}
                      {weeks} weeks in schooner {warn ? '(expected 3 to 24 weeks)' : '✓'}
                    </div>
                  );
                })()}

              <div style={{borderTop: '1px solid #e5e7eb', paddingTop: 10, marginTop: 4}}>
                <div className={recordFieldRowClass} style={{borderBottom: 'none'}}>
                  <span style={recordFieldLabel}>Notes</span>
                  <textarea
                    value={bForm.notes}
                    onChange={(e) => updBatch((f) => ({...f, notes: e.target.value}))}
                    rows={2}
                    style={recordTextarea}
                  />
                </div>
              </div>
              {err && <div style={{color: '#b91c1c', fontSize: 12, fontWeight: 600}}>{err}</div>}
            </div>
            {!isRetHome && (
              <div style={{padding: '12px 20px', borderTop: '1px solid #e5e7eb'}}>
                <button
                  type="button"
                  onClick={handleDeleteBatch}
                  data-layer-batch-delete={batch.id}
                  style={S.btnDanger}
                >
                  Delete Batch
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </RecordPageFrame>
  );
}
