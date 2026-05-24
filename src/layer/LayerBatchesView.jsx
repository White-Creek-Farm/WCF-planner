// ============================================================================
// src/layer/LayerBatchesView.jsx  —  Phase 2 Round 2 tail (deferred from the
// original Round 2 push because it needed calcPhaseFromAge + inRange + the
// housing/overlap helpers lifted first). The body itself is unchanged — it
// was already a module-scope const component with an explicit prop signature.
// Only additions: imports header, `confirmDelete` added to the prop list
// (the inline original relied on an undeclared bare identifier that would
// have ReferenceError'd under Vite's strict mode), and export default.
// ============================================================================
import React from 'react';
import {toISO, addDays} from '../lib/dateUtils.js';
import {computeProjectedCount, computeHousingDisplayCount, computeLayerFeedCost} from '../lib/layerHousing.js';
import {BROODERS, SCHOONERS, BROODER_CLEANOUT, SCHOONER_CLEANOUT, overlaps} from '../lib/broiler.js';
import {S} from '../lib/styles.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ActivityPanel from '../shared/ActivityPanel.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ActivityModal from '../shared/ActivityModal.jsx';

const LayerBatchesView = ({
  sb,
  layerGroups,
  layerBatches,
  setLayerBatches,
  layerHousings,
  setLayerHousings,
  batches,
  fmt,
  Header,
  authState,
  feedCosts,
  setView,
  pendingEdit,
  setPendingEdit,
  confirmDelete,
}) => {
  const {useState, useEffect, useRef} = React;
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const [loading, setLoading] = useState(true);
  const [batchStats, setBatchStats] = useState({});
  const [housingStats, setHousingStats] = useState({});
  const [notice, setNotice] = useState(null);
  const [rawLayerDailys, setRawLayerDailys] = useState([]); // for projected count calc
  const [selectedBatchId, setSelectedBatchId] = useState(null);
  const [retHomePeriod, setRetHomePeriod] = useState(30); // Rolling window: 30, 90, or 180 days
  const [showBatchForm, setShowBatchForm] = useState(false);
  const [showHousingForm, setShowHousingForm] = useState(false);
  const [editBatchId, setEditBatchId] = useState(null);
  const [editHousingId, setEditHousingId] = useState(null);
  const [activityTarget, setActivityTarget] = useState(null);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  const HOUSING_CAPS = {
    'Layer Schooner': 450,
    'Eggmobile 1': 250,
    'Eggmobile 2': 250,
    'Eggmobile 3': 250,
    'Eggmobile 4': 250,
    'Retirement Home': 9999,
  };
  const getHousingCap = (name) => {
    if (!name) return 9999;
    for (const [k, v] of Object.entries(HOUSING_CAPS)) {
      if (name.toLowerCase().includes(k.toLowerCase())) return v;
    }
    return 9999;
  };

  const EMPTY_BATCH = {
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
  const EMPTY_HOUSING = {
    housing_name: '',
    status: 'active',
    current_count: '',
    start_date: todayStr(),
    retired_date: '',
    notes: '',
  };
  const [bForm, setBForm] = useState(EMPTY_BATCH);
  const [hForm, setHForm] = useState(EMPTY_HOUSING);
  const housingAutoSaveTimer = useRef(null);
  const [housingSaving, setHousingSaving] = useState(false);
  const [housingPending, setHousingPending] = useState(false); // shows "saving..." indicator
  // Layer batch form autosave state
  const batchAutoSaveTimer = useRef(null);
  const [batchSaving, setBatchSaving] = useState(false);
  const [batchPending, setBatchPending] = useState(false);

  // Handle deep-link from timeline (clicking a layer bar selects this batch)
  useEffect(() => {
    if (pendingEdit?.viewName === 'layerbatches' && pendingEdit?.id) {
      setSelectedBatchId(pendingEdit.id);
      setPendingEdit && setPendingEdit(null);
    }
  }, [pendingEdit]);

  // Compute next batch name
  function nextBatchName() {
    const yr = new Date().getFullYear().toString().slice(2);
    const existing = layerBatches.filter((b) => b.name && b.name.match(/^L-\d{2}-\d{2}$/));
    const nums = existing.map((b) => parseInt(b.name.slice(5)) || 0);
    const next = (Math.max(0, ...nums) + 1).toString().padStart(2, '0');
    return `L-${yr}-${next}`;
  }

  useEffect(() => {
    // Paginated fetch — Supabase caps at 1000 rows per request.
    // This fetches in pages of 1000 until all rows are retrieved.
    async function fetchAll(table, columns) {
      const PAGE = 1000;
      let all = [],
        offset = 0,
        done = false;
      while (!done) {
        const {data, error} = await sb
          .from(table)
          .select(columns)
          .range(offset, offset + PAGE - 1);
        if (error || !data || data.length === 0) {
          done = true;
          break;
        }
        all = all.concat(data);
        if (data.length < PAGE) done = true;
        else offset += PAGE;
      }
      return all;
    }
    Promise.all([
      fetchAll('layer_dailys', 'batch_label,batch_id,feed_lbs,grit_lbs,mortality_count,layer_count,date,feed_type'),
      fetchAll(
        'egg_dailys',
        'group1_name,group1_count,group2_name,group2_count,group3_name,group3_count,group4_name,group4_count,date',
      ),
    ]).then(([ld, ed]) => {
      setRawLayerDailys(ld);
      // Date range helper — only count records within a housing's active period
      function inRange(date, start, end) {
        if (!date) return false;
        if (start && date < start) return false;
        if (end && date > end) return false;
        return true;
      }
      // Live layer feed phase calc — bird age from brooder_entry_date.
      // Days 0-20 = STARTER, 21-139 = GROWER, 140+ = LAYER.
      // Falls back to stored feed_type if anchor date is unknown.
      function calcPhaseFromAge(reportDate, brooderEntry, storedType) {
        if (!brooderEntry || !reportDate) return storedType || 'LAYER';
        try {
          const days = Math.floor(
            (new Date(reportDate + 'T12:00:00') - new Date(brooderEntry + 'T12:00:00')) / 86400000,
          );
          if (days < 21) return 'STARTER';
          if (days < 140) return 'GROWER';
          return 'LAYER';
        } catch (e) {
          return storedType || 'LAYER';
        }
      }
      // Stats per batch — batch_id-based attribution.
      // Every layer_dailys row has a batch_id linking it to exactly one layer_batch.
      // This is set at submit time (for new reports) or backfilled (for historical data).
      // batch_id is the source of truth — NOT batch_label text matching.
      const stats = {};
      layerBatches.forEach((batch) => {
        const anchor = batch.brooder_entry_date || batch.arrival_date || null;
        const bHousings = layerHousings.filter((h) => h.batch_id === batch.id);
        const myReports = ld.filter((d) => d.batch_id === batch.id);
        let totalFeed = 0,
          totalMort = 0,
          starterFeed = 0,
          growerFeed = 0,
          layerFeed = 0;
        myReports.forEach((d) => {
          const f = parseFloat(d.feed_lbs) || 0;
          totalFeed += f;
          totalMort += parseInt(d.mortality_count) || 0;
          const phase = calcPhaseFromAge(d.date, anchor, d.feed_type);
          if (phase === 'STARTER') starterFeed += f;
          else if (phase === 'GROWER') growerFeed += f;
          else layerFeed += f;
        });
        let totalEggs = 0;
        bHousings.forEach((h) => {
          totalEggs += ed.reduce((s, d) => {
            if (!inRange(d.date, h.start_date, h.retired_date)) return s;
            let e = 0;
            [
              [d.group1_name, d.group1_count],
              [d.group2_name, d.group2_count],
              [d.group3_name, d.group3_count],
              [d.group4_name, d.group4_count],
            ].forEach(([n, c]) => {
              if (n === h.housing_name) e += parseInt(c) || 0;
            });
            return s + e;
          }, 0);
        });
        stats[batch.id] = {totalFeed, totalMort, totalEggs, starterFeed, growerFeed, layerFeed};
      });
      setBatchStats(stats);
      // Stats per housing — uses batch_id from each report's parent batch for phase calc
      const batchById = Object.fromEntries(layerBatches.map((b) => [b.id, b]));
      const hStats = {};
      layerHousings.forEach((h) => {
        const parent = h.batch_id ? batchById[h.batch_id] : null;
        const anchor = parent ? parent.brooder_entry_date || parent.arrival_date || null : null;
        const hd = ld.filter(
          (d) =>
            String(d.batch_label || '')
              .toLowerCase()
              .trim() ===
              String(h.housing_name || '')
                .toLowerCase()
                .trim() && inRange(d.date, h.start_date, h.retired_date),
        );
        let totalFeed = 0,
          totalMort = 0,
          starterFeedH = 0,
          growerFeedH = 0,
          layerFeedH = 0;
        hd.forEach((d) => {
          const f = parseFloat(d.feed_lbs) || 0;
          totalFeed += f;
          totalMort += parseInt(d.mortality_count) || 0;
          const phase = calcPhaseFromAge(d.date, anchor, d.feed_type);
          if (phase === 'STARTER') starterFeedH += f;
          else if (phase === 'GROWER') growerFeedH += f;
          else layerFeedH += f;
        });
        const totalEggs = ed.reduce((s, d) => {
          if (!inRange(d.date, h.start_date, h.retired_date)) return s;
          let e = 0;
          [
            [d.group1_name, d.group1_count],
            [d.group2_name, d.group2_count],
            [d.group3_name, d.group3_count],
            [d.group4_name, d.group4_count],
          ].forEach(([n, c]) => {
            if (n === h.housing_name) e += parseInt(c) || 0;
          });
          return s + e;
        }, 0);
        hStats[h.id] = {
          totalFeed,
          totalMort,
          totalEggs,
          starterFeed: starterFeedH,
          growerFeed: growerFeedH,
          layerFeed: layerFeedH,
        };
      });
      setHousingStats(hStats);
      setLoading(false);
    });
  }, [layerBatches, layerHousings]);

  // Which housings are currently locked (active in some batch)
  const lockedHousings = new Set(layerHousings.filter((h) => h.status === 'active').map((h) => h.housing_name));

  // Save batch
  // Build a record from a form snapshot. Used by both autosave and close-flush.
  function buildBatchRec(formSnapshot) {
    const f = formSnapshot;
    return {
      id: editBatchId || f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
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
      // Cost rates: only used at create-time. Once set, they're locked from this UI
      // (admin must update via Feed Costs panel). Defaulting on creation pulls from global.
      per_lb_starter_cost: editBatchId
        ? f.per_lb_starter_cost !== ''
          ? parseFloat(f.per_lb_starter_cost)
          : null
        : parseFloat(f.per_lb_starter_cost) || (feedCosts && feedCosts.starter) || null,
      per_lb_grower_cost: editBatchId
        ? f.per_lb_grower_cost !== ''
          ? parseFloat(f.per_lb_grower_cost)
          : null
        : parseFloat(f.per_lb_grower_cost) || (feedCosts && feedCosts.grower) || null,
      per_lb_layer_cost: editBatchId
        ? f.per_lb_layer_cost !== ''
          ? parseFloat(f.per_lb_layer_cost)
          : null
        : parseFloat(f.per_lb_layer_cost) || (feedCosts && feedCosts.layer) || null,
    };
  }

  async function persistBatchRec(rec) {
    setBatchSaving(true);
    const {error} = await sb.from('layer_batches').upsert(rec, {onConflict: 'id'});
    setBatchSaving(false);
    if (error) {
      console.warn('layer_batches upsert error:', error.message);
      return false;
    }
    setLayerBatches((prev) => {
      const exists = prev.find((b) => b.id === rec.id);
      return exists ? prev.map((b) => (b.id === rec.id ? rec : b)) : [...prev, rec];
    });
    setBatchPending(false);
    return true;
  }

  function scheduleBatchAutosave(formSnapshot) {
    if (!formSnapshot.name || !formSnapshot.name.trim()) return; // never autosave a nameless batch
    setBatchPending(true);
    clearTimeout(batchAutoSaveTimer.current);
    batchAutoSaveTimer.current = setTimeout(() => {
      const rec = buildBatchRec(formSnapshot);
      // Only set editBatchId on the first successful save of a NEW batch,
      // so subsequent autosaves UPDATE rather than re-INSERT
      if (!editBatchId) setEditBatchId(rec.id);
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
    if (!editBatchId) setEditBatchId(rec.id);
    return await persistBatchRec(rec);
  }

  function updBatch(updater) {
    setBForm((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : {...prev, ...updater};
      scheduleBatchAutosave(next);
      return next;
    });
  }

  async function closeBatchForm() {
    const ok = await flushBatchAutosave();
    if (!ok) return; // don't close if there's an unrecoverable error (e.g. missing name)
    setShowBatchForm(false);
    setEditBatchId(null);
    setBForm(EMPTY_BATCH);
    setBatchPending(false);
    setErr('');
  }

  // Save housing
  // ── Housing persistence (autosave model) ──
  // Build the record from a form snapshot. Used by both autosave and close-flush.
  function buildHousingRec(formSnapshot) {
    let newCurrentCountDate = null;
    if (editHousingId) {
      const existing = layerHousings.find((h) => h.id === editHousingId);
      const oldVal = existing?.current_count;
      const newVal = formSnapshot.current_count !== '' ? parseInt(formSnapshot.current_count) : null;
      if (newVal !== (oldVal == null ? null : parseInt(oldVal))) {
        newCurrentCountDate = todayStr();
      } else {
        newCurrentCountDate = existing?.current_count_date || null;
      }
    } else {
      if (formSnapshot.current_count !== '') {
        newCurrentCountDate = todayStr();
      }
    }
    return {
      id: editHousingId || String(Date.now()) + Math.random().toString(36).slice(2, 6),
      batch_id: selectedBatchId,
      housing_name: formSnapshot.housing_name,
      status: formSnapshot.status || 'active',
      current_count: formSnapshot.current_count !== '' ? parseInt(formSnapshot.current_count) : null,
      current_count_date: newCurrentCountDate,
      start_date: formSnapshot.start_date || null,
      retired_date: formSnapshot.retired_date || null,
      notes: formSnapshot.notes || null,
    };
  }

  // Persist a housing record. Returns true on success.
  async function persistHousing(rec) {
    if (!rec.housing_name) return false;
    if (!selectedBatchId) return false;
    // Capacity warning now uses current_count instead of allocated_count
    const cap = getHousingCap(rec.housing_name);
    if ((rec.current_count || 0) > cap) {
      setErr('\u26a0 ' + rec.housing_name + ' capacity is ' + cap + ' birds. You have ' + rec.current_count + '.');
    } else {
      setErr('');
    }
    setHousingSaving(true);
    const {error} = await sb.from('layer_housings').upsert(rec, {onConflict: 'id'});
    setHousingSaving(false);
    setHousingPending(false);
    if (error) {
      setErr('Could not save: ' + error.message);
      return false;
    }
    const exists = layerHousings.find((h) => h.id === rec.id);
    const updated = exists ? layerHousings.map((h) => (h.id === rec.id ? rec : h)) : [...layerHousings, rec];
    setLayerHousings(updated);
    if (!editHousingId) setEditHousingId(rec.id);
    return true;
  }

  // Schedule a debounced autosave (1.5s)
  function scheduleHousingAutosave(formSnapshot) {
    if (!formSnapshot.housing_name) return;
    setHousingPending(true);
    clearTimeout(housingAutoSaveTimer.current);
    housingAutoSaveTimer.current = setTimeout(() => {
      const rec = buildHousingRec(formSnapshot);
      persistHousing(rec);
    }, 1500);
  }

  // Flush pending autosave immediately
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

  // Close modal, flushing first
  async function closeHousingForm() {
    await flushHousingAutosave();
    setShowHousingForm(false);
    setEditHousingId(null);
    setHForm(EMPTY_HOUSING);
    setHousingPending(false);
    setErr('');
  }

  // Wrapper for setHForm that also schedules autosave
  function updHousing(updater) {
    setHForm((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      scheduleHousingAutosave(next);
      return next;
    });
  }

  // Retire housing
  async function retireHousing(h) {
    setNotice(null);
    const updated = {...h, status: 'retired', retired_date: todayStr()};
    const {error} = await sb.from('layer_housings').upsert(updated, {onConflict: 'id'});
    if (error) {
      setNotice({kind: 'error', message: 'Could not retire: ' + error.message});
      return;
    }
    setLayerHousings(layerHousings.map((x) => (x.id === h.id ? updated : x)));
  }

  const selectedBatch = layerBatches.find((b) => b.id === selectedBatchId);
  const batchHousings = layerHousings.filter((h) => h.batch_id === selectedBatchId);

  // Available housing options (layer groups not locked by another batch)
  const availableHousings = layerGroups.filter((g) => {
    if (editHousingId) {
      const cur = layerHousings.find((h) => h.id === editHousingId);
      if (cur && cur.housing_name === g.name) return true;
    }
    return (
      !lockedHousings.has(g.name) ||
      (editHousingId && layerHousings.find((h) => h.id === editHousingId)?.housing_name === g.name)
    );
  });

  const StatPill = ({label, val, color = '#374151'}) => (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 70}}>
      <div style={{fontSize: 11, color: '#9ca3af', marginBottom: 2}}>{label}</div>
      <div style={{fontWeight: 700, fontSize: 13, color}}>{val}</div>
    </div>
  );

  return (
    <div style={{minHeight: '100vh', background: '#f1f3f2'}}>
      <Header />
      <div style={{padding: '1rem', maxWidth: 1100, margin: '0 auto'}}>
        <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
        {/* BATCH LIST */}
        {!selectedBatchId && (
          <>
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16}}>
              <div style={{fontSize: 20, fontWeight: 700, color: '#111827'}}>
                Layer Batches
                <span style={{fontSize: 13, fontWeight: 400, color: '#6b7280', marginLeft: 8}}>
                  {layerBatches.filter((b) => b.status === 'active').length} active
                </span>
              </div>
              <button
                onClick={() => {
                  setBForm({...EMPTY_BATCH, name: nextBatchName()});
                  setEditBatchId(null);
                  setShowBatchForm(true);
                }}
                style={{
                  padding: '7px 18px',
                  borderRadius: 8,
                  border: 'none',
                  background: '#085041',
                  color: 'white',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                + New Batch
              </button>
            </div>
            {loading && <div style={{textAlign: 'center', padding: '3rem', color: '#9ca3af'}}>Loading...</div>}
            {!loading && (
              <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
                {/* Active batches */}
                {layerBatches
                  .filter((b) => b.status === 'active')
                  .map(function (batch, bi) {
                    const stats = batchStats[batch.id] || {};
                    const housings = layerHousings.filter((h) => h.batch_id === batch.id);
                    const activeH = housings.filter((h) => h.status === 'active');
                    const isRetHome = batch.name === 'Retirement Home';
                    var batchColors = [
                      {bg: '#ecfdf5', bd: '#a7f3d0', tx: '#065f46'},
                      {bg: '#eff6ff', bd: '#bfdbfe', tx: '#1e40af'},
                      {bg: '#fffbeb', bd: '#fde68a', tx: '#92400e'},
                      {bg: '#f5f3ff', bd: '#ddd6fe', tx: '#5b21b6'},
                    ];
                    var bc = batchColors[bi % batchColors.length];
                    return (
                      <div
                        key={batch.id}
                        onClick={() => setSelectedBatchId(batch.id)}
                        style={{
                          background: 'white',
                          border: '1px solid #e5e7eb',
                          borderRadius: 12,
                          overflow: 'hidden',
                          cursor: 'pointer',
                        }}
                        className="hoverable-tile"
                      >
                        <div
                          style={{
                            background: bc.bg,
                            borderBottom: '1px solid ' + bc.bd,
                            padding: '10px 20px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            flexWrap: 'wrap',
                          }}
                        >
                          <span style={{fontSize: 15, fontWeight: 700, color: bc.tx}}>{batch.name}</span>
                          <span onClick={(e) => e.stopPropagation()} data-activity-surface="layer.batch">
                            {React.createElement(ActivityPanel, {
                              sb,
                              authState,
                              entityType: 'layer.batch',
                              entityId: batch.id,
                              entityLabel: batch.name,
                              mode: 'compact',
                              onCompactClick: setActivityTarget,
                            })}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              padding: '2px 8px',
                              borderRadius: 10,
                              background: '#d1fae5',
                              color: '#065f46',
                              textTransform: 'uppercase',
                            }}
                          >
                            {isRetHome ? 'Permanent' : 'Active'}
                          </span>
                          {(batch.brooder_entry_date || batch.arrival_date) &&
                            (() => {
                              const anchor = batch.brooder_entry_date || batch.arrival_date;
                              const months = +(
                                (new Date() - new Date(anchor + 'T12:00:00')) /
                                86400000 /
                                30.44
                              ).toFixed(1);
                              return months > 0 ? (
                                <span style={{fontSize: 11, color: bc.tx, opacity: 0.85}}>
                                  {months + ' months old'}
                                </span>
                              ) : null;
                            })()}
                        </div>
                        <div style={{padding: '12px 20px', display: 'flex', gap: 20, alignItems: 'flex-start'}}>
                          <div style={{flex: 1}}>
                            {activeH.length > 0 &&
                              (() => {
                                var batchColors = [
                                  {bg: '#ecfdf5', bd: '#a7f3d0', tx: '#065f46'},
                                  {bg: '#eff6ff', bd: '#bfdbfe', tx: '#1e40af'},
                                  {bg: '#fffbeb', bd: '#fde68a', tx: '#92400e'},
                                  {bg: '#f5f3ff', bd: '#ddd6fe', tx: '#5b21b6'},
                                ];
                                var bc = batchColors[bi % batchColors.length];
                                return (
                                  <div style={{display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8}}>
                                    {activeH.map((h) => (
                                      <span
                                        key={h.id}
                                        style={{
                                          fontSize: 11,
                                          background: bc.bg,
                                          border: '1px solid ' + bc.bd,
                                          color: bc.tx,
                                          padding: '2px 8px',
                                          borderRadius: 6,
                                          fontWeight: 600,
                                        }}
                                      >
                                        🏠 {h.housing_name}
                                        {(() => {
                                          const c = computeHousingDisplayCount(h, rawLayerDailys);
                                          return c > 0 ? ' · ' + c + ' hens' : '';
                                        })()}
                                      </span>
                                    ))}
                                  </div>
                                );
                              })()}
                          </div>
                          <div style={{display: 'flex', gap: 20, flexShrink: 0}}>
                            <StatPill
                              label="Feed"
                              val={
                                stats.totalFeed > 0 ? Math.round(stats.totalFeed).toLocaleString() + ' lbs' : '\u2014'
                              }
                              color="#92400e"
                            />
                            <StatPill
                              label="Mort."
                              val={stats.totalMort > 0 ? stats.totalMort : '0'}
                              color={stats.totalMort > 10 ? '#b91c1c' : '#374151'}
                            />
                            <StatPill
                              label="Dozens"
                              val={stats.totalEggs > 0 ? Math.floor(stats.totalEggs / 12).toLocaleString() : '\u2014'}
                              color="#065f46"
                            />
                            {(() => {
                              const fc = computeLayerFeedCost(
                                stats.starterFeed,
                                stats.growerFeed,
                                stats.layerFeed,
                                batch,
                              );
                              return (
                                <StatPill
                                  label="Cost"
                                  val={
                                    fc != null
                                      ? '$' +
                                        fc.toLocaleString(undefined, {
                                          minimumFractionDigits: 0,
                                          maximumFractionDigits: 0,
                                        })
                                      : '\u2014'
                                  }
                                  color="#065f46"
                                />
                              );
                            })()}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                {/* Retired batches */}
                {layerBatches.filter((b) => b.status === 'retired').length > 0 && (
                  <>
                    <div style={{fontSize: 12, fontWeight: 600, color: '#4b5563', letterSpacing: 0.3, marginTop: 8}}>
                      RETIRED BATCHES
                    </div>
                    {layerBatches
                      .filter((b) => b.status === 'retired')
                      .map(function (batch, bi) {
                        const stats = batchStats[batch.id] || {};
                        const housings = layerHousings.filter((h) => h.batch_id === batch.id);
                        return (
                          <div
                            key={batch.id}
                            onClick={() => setSelectedBatchId(batch.id)}
                            style={{
                              background: bi % 2 === 0 ? '#f9fafb' : '#f3f4f6',
                              border: '1px solid #e5e7eb',
                              borderRadius: 12,
                              padding: '14px 20px',
                              cursor: 'pointer',
                              display: 'flex',
                              gap: 20,
                              alignItems: 'center',
                              opacity: 0.8,
                            }}
                            className="hoverable-tile"
                          >
                            <div style={{flex: 1}}>
                              <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                                <span style={{fontSize: 14, fontWeight: 700, color: '#374151'}}>{batch.name}</span>
                                <span
                                  style={{
                                    fontSize: 10,
                                    fontWeight: 700,
                                    padding: '2px 8px',
                                    borderRadius: 10,
                                    background: '#f3f4f6',
                                    color: '#6b7280',
                                    textTransform: 'uppercase',
                                  }}
                                >
                                  Retired
                                </span>
                                {(batch.brooder_entry_date || batch.arrival_date) &&
                                  (() => {
                                    const anchor = batch.brooder_entry_date || batch.arrival_date;
                                    const months = +(
                                      (new Date() - new Date(anchor + 'T12:00:00')) /
                                      86400000 /
                                      30.44
                                    ).toFixed(1);
                                    return months > 0 ? (
                                      <span style={{fontSize: 11, color: '#9ca3af'}}>{months + ' months old'}</span>
                                    ) : null;
                                  })()}
                              </div>
                            </div>
                            <div style={{display: 'flex', gap: 20, flexShrink: 0}}>
                              <StatPill
                                label="Feed"
                                val={
                                  stats.totalFeed > 0 ? Math.round(stats.totalFeed).toLocaleString() + ' lbs' : '\u2014'
                                }
                              />
                              <StatPill label="Mort." val={stats.totalMort || '0'} />
                              <StatPill
                                label="Dozens"
                                val={stats.totalEggs > 0 ? Math.floor(stats.totalEggs / 12).toLocaleString() : '\u2014'}
                              />
                              {(() => {
                                const fc = computeLayerFeedCost(
                                  stats.starterFeed,
                                  stats.growerFeed,
                                  stats.layerFeed,
                                  batch,
                                );
                                return (
                                  <StatPill
                                    label="Cost"
                                    val={
                                      fc != null
                                        ? '$' +
                                          fc.toLocaleString(undefined, {
                                            minimumFractionDigits: 0,
                                            maximumFractionDigits: 0,
                                          })
                                        : '\u2014'
                                    }
                                  />
                                );
                              })()}
                            </div>
                          </div>
                        );
                      })}
                  </>
                )}
              </div>
            )}
          </>
        )}

        {/* BATCH DETAIL */}
        {selectedBatchId && selectedBatch && (
          <>
            <div style={{display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16}}>
              <button
                onClick={() => setSelectedBatchId(null)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 7,
                  border: '1px solid #d1d5db',
                  background: 'white',
                  fontSize: 12,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                ← Back
              </button>
              <div style={{fontSize: 18, fontWeight: 700, color: '#111827'}}>{selectedBatch.name}</div>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: 10,
                  background: selectedBatch.status === 'active' ? '#d1fae5' : '#f3f4f6',
                  color: selectedBatch.status === 'active' ? '#065f46' : '#6b7280',
                  textTransform: 'uppercase',
                }}
              >
                {selectedBatch.name === 'Retirement Home' ? 'Permanent' : selectedBatch.status}
              </span>
              <button
                onClick={() => {
                  setBForm({
                    ...EMPTY_BATCH,
                    ...selectedBatch,
                    original_count: selectedBatch.original_count || '',
                    cost_per_bird: selectedBatch.cost_per_bird || '',
                    per_lb_starter_cost: selectedBatch.per_lb_starter_cost || '',
                    per_lb_grower_cost: selectedBatch.per_lb_grower_cost || '',
                    per_lb_layer_cost: selectedBatch.per_lb_layer_cost || '',
                  });
                  setEditBatchId(selectedBatch.id);
                  setShowBatchForm(true);
                }}
                style={{
                  marginLeft: 'auto',
                  padding: '6px 14px',
                  borderRadius: 7,
                  border: '1px solid #d1d5db',
                  background: 'white',
                  fontSize: 12,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Edit Batch
              </button>
            </div>

            {/* Batch summary stats */}
            {(() => {
              const isRetHome = selectedBatch.name === 'Retirement Home';
              let s;
              if (isRetHome) {
                // Rolling window stats computed from raw data
                const cutoff = new Date();
                cutoff.setDate(cutoff.getDate() - retHomePeriod);
                const cutoffStr = cutoff.toISOString().split('T')[0];
                const windowReports = rawLayerDailys.filter(
                  (d) => d.batch_id === selectedBatch.id && d.date >= cutoffStr,
                );
                const anchor = selectedBatch.brooder_entry_date || selectedBatch.arrival_date || null;
                let totalFeed = 0,
                  totalMort = 0,
                  starterFeed = 0,
                  growerFeed = 0,
                  layerFeed = 0;
                windowReports.forEach((d) => {
                  const f = parseFloat(d.feed_lbs) || 0;
                  totalFeed += f;
                  totalMort += parseInt(d.mortality_count) || 0;
                  // Phase calc (all Retirement Home is LAYER since no anchor, but be safe)
                  if (!anchor) layerFeed += f;
                  else {
                    try {
                      const days = Math.floor(
                        (new Date(d.date + 'T12:00:00') - new Date(anchor + 'T12:00:00')) / 86400000,
                      );
                      if (days < 21) starterFeed += f;
                      else if (days < 140) growerFeed += f;
                      else layerFeed += f;
                    } catch (e) {
                      layerFeed += f;
                    }
                  }
                });
                // Eggs from egg_dailys for the window — approximate from batchStats proportion
                // (egg_dailys aren't in rawLayerDailys, but batchStats has lifetime eggs)
                // For simplicity, use the housing stats approach
                const bHousings = layerHousings.filter((h) => h.batch_id === selectedBatch.id);
                const hNames = new Set(bHousings.map((h) => h.housing_name));
                s = {
                  totalFeed,
                  totalMort,
                  starterFeed,
                  growerFeed,
                  layerFeed,
                  totalEggs: (batchStats[selectedBatch.id] || {}).totalEggs || 0,
                  isWindowed: true,
                };
              } else {
                s = batchStats[selectedBatch.id] || {};
              }
              const feedCost = computeLayerFeedCost(s.starterFeed, s.growerFeed, s.layerFeed, selectedBatch);
              const totalDozens = s.totalEggs > 0 ? s.totalEggs / 12 : 0;
              const costPerDoz = feedCost != null && totalDozens > 0 ? feedCost / totalDozens : null;
              const fmt$ = (v) =>
                '$' + v.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
              const periodLabel = isRetHome
                ? {30: 'Last 30 Days', 90: 'Last 90 Days', 180: 'Last 6 Months'}[retHomePeriod]
                : 'Lifetime';
              return (
                <div>
                  {isRetHome && (
                    <div
                      style={{
                        display: 'flex',
                        gap: 0,
                        marginBottom: 12,
                        borderRadius: 8,
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
                        s.totalFeed > 0 ? Math.round(s.totalFeed).toLocaleString() + ' lbs' : '\u2014',
                        '#92400e',
                      ],
                      ...(isRetHome
                        ? []
                        : [
                            [
                              'Starter Feed',
                              s.starterFeed > 0 ? Math.round(s.starterFeed).toLocaleString() + ' lbs' : '\u2014',
                              s.starterFeed >= 1400 ? '#b91c1c' : '#1e40af',
                            ],
                          ]),
                      ...(isRetHome
                        ? []
                        : [
                            [
                              'Grower Feed',
                              s.growerFeed > 0 ? Math.round(s.growerFeed).toLocaleString() + ' lbs' : '\u2014',
                              '#065f46',
                            ],
                          ]),
                      [
                        'Layer Feed',
                        s.layerFeed > 0 ? Math.round(s.layerFeed).toLocaleString() + ' lbs' : '\u2014',
                        '#78350f',
                      ],
                      [
                        'Mortality' + (isRetHome ? ' (' + periodLabel + ')' : ''),
                        s.totalMort || '0',
                        s.totalMort > 10 ? '#b91c1c' : '#374151',
                      ],
                      ...(isRetHome
                        ? []
                        : [
                            [
                              'Total Dozens',
                              s.totalEggs > 0 ? Math.floor(s.totalEggs / 12).toLocaleString() : '\u2014',
                              '#065f46',
                            ],
                          ]),
                      ...(isRetHome ? [] : [['Feed Cost', feedCost != null ? fmt$(feedCost) : '\u2014', '#92400e']]),
                      ...(isRetHome
                        ? []
                        : [['Cost / Dozen', costPerDoz != null ? fmt$(costPerDoz) : '\u2014', '#065f46']]),
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
                </div>
              );
            })()}

            {/* PERFORMANCE SUMMARY (lifetime/derived metrics) — hidden for Retirement Home */}
            {selectedBatch.name !== 'Retirement Home' &&
              (() => {
                const s = batchStats[selectedBatch.id] || {};
                const bHousings = layerHousings.filter((h) => h.batch_id === selectedBatch.id);
                const orig = parseInt(selectedBatch.original_count) || 0;
                const currentHens = bHousings.reduce(
                  (sum, h) => sum + computeHousingDisplayCount(h, rawLayerDailys),
                  0,
                );
                // End date for time-based metrics: today if active, latest housing retired_date if retired
                const todayISOstr = new Date().toISOString().split('T')[0];
                let endDate = todayISOstr;
                if (selectedBatch.status === 'retired') {
                  const ret = bHousings
                    .map((h) => h.retired_date)
                    .filter(Boolean)
                    .sort();
                  endDate = ret.length > 0 ? ret[ret.length - 1] : selectedBatch.schooner_exit_date || todayISOstr;
                }
                // Batch age = today - brooder_entry_date (total time on farm)
                const anchor = selectedBatch.brooder_entry_date || selectedBatch.arrival_date || null;
                const batchAgeDays = anchor
                  ? Math.max(
                      0,
                      Math.round((new Date(endDate + 'T12:00:00') - new Date(anchor + 'T12:00:00')) / 86400000),
                    )
                  : 0;
                const batchAgeMonths = +(batchAgeDays / 30.44).toFixed(1);
                const batchAgeStr = batchAgeDays > 0 ? `${batchAgeMonths} months (${batchAgeDays} days)` : '\u2014';
                // Days in housing phase = endDate - first housing start_date
                const firstHousingStart =
                  bHousings.length > 0
                    ? bHousings
                        .map((h) => h.start_date)
                        .filter(Boolean)
                        .sort()[0]
                    : null;
                const daysInHousing = firstHousingStart
                  ? Math.max(
                      0,
                      Math.round(
                        (new Date(endDate + 'T12:00:00') - new Date(firstHousingStart + 'T12:00:00')) / 86400000,
                      ),
                    )
                  : 0;
                // Metric computations
                const eggsPerHen = orig > 0 ? s.totalEggs / orig : null;
                const eggsPerHenPerDay =
                  currentHens > 0 && daysInHousing > 0 ? s.totalEggs / (currentHens * daysInHousing) : null;
                const feedPerHen = orig > 0 ? s.totalFeed / orig : null;
                const feedCost = computeLayerFeedCost(s.starterFeed, s.growerFeed, s.layerFeed, selectedBatch);
                const costPerHen = feedCost != null && orig > 0 ? feedCost / orig : null;
                const fmt$ = (v) =>
                  '$' + v.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
                const tiles = [
                  {l: 'Batch Age', v: batchAgeStr, c: '#78350f'},
                  {l: 'Days in Housing', v: daysInHousing > 0 ? daysInHousing + ' days' : '\u2014', c: '#374151'},
                  {
                    l: 'Original \u2192 Current',
                    v: orig > 0 ? orig.toLocaleString() + ' \u2192 ' + currentHens.toLocaleString() : '\u2014',
                    c: '#78350f',
                  },
                  {
                    l: 'Dozens / Hen (lifetime)',
                    v: eggsPerHen != null ? (eggsPerHen / 12).toFixed(1) + ' doz' : '\u2014',
                    c: '#78350f',
                  },
                  {
                    l: 'Eggs / Hen / Day (housing)',
                    v: eggsPerHenPerDay != null ? eggsPerHenPerDay.toFixed(3) : '\u2014',
                    c: eggsPerHenPerDay != null && eggsPerHenPerDay >= 0.7 ? '#065f46' : '#b45309',
                  },
                  {
                    l: 'Feed / Hen (lifetime)',
                    v: feedPerHen != null ? feedPerHen.toFixed(1) + ' lbs' : '\u2014',
                    c: '#92400e',
                  },
                  {l: 'Cost / Hen (lifetime)', v: costPerHen != null ? fmt$(costPerHen) : '\u2014', c: '#065f46'},
                ];
                return (
                  <div
                    style={{
                      background: 'white',
                      border: '1px solid #e5e7eb',
                      borderRadius: 12,
                      padding: '16px 20px',
                      marginBottom: 16,
                    }}
                  >
                    <div
                      style={{fontSize: 12, fontWeight: 700, color: '#4b5563', letterSpacing: 0.5, marginBottom: 12}}
                    >
                      PERFORMANCE SUMMARY
                    </div>
                    <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10}}>
                      {tiles.map((t) => (
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
                          <div style={{fontSize: 17, fontWeight: 700, color: t.c || '#111827'}}>{t.v}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

            {/* Phase timeline — not shown for Retirement Home */}
            {selectedBatch.name !== 'Retirement Home' && (
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
                      name: selectedBatch.brooder_name,
                      entry: selectedBatch.brooder_entry_date,
                      exit: selectedBatch.brooder_exit_date,
                      color: '#dbeafe',
                      border: '#93c5fd',
                      text: '#1e40af',
                    },
                    {
                      label: 'Schooner',
                      icon: '🚌',
                      name: selectedBatch.schooner_name,
                      entry: selectedBatch.schooner_entry_date,
                      exit: selectedBatch.schooner_exit_date,
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
                          {phase.exit ? ' \u2192 ' + fmt(phase.exit) : ' \u2192 present'}
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
                {selectedBatch.status === 'active' && (
                  <button
                    onClick={() => {
                      setHForm(EMPTY_HOUSING);
                      setEditHousingId(null);
                      setShowHousingForm(true);
                    }}
                    style={{
                      padding: '5px 14px',
                      borderRadius: 7,
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
                  const hs = housingStats[h.id] || {};
                  const cap = getHousingCap(h.housing_name);
                  const displayCount = computeHousingDisplayCount(h, rawLayerDailys);
                  const proj = computeProjectedCount(h, rawLayerDailys);
                  const util = displayCount && cap ? Math.round((displayCount / cap) * 100) : null;
                  return (
                    <div
                      key={h.id}
                      style={{
                        background: 'white',
                        border: h.status === 'active' ? '1px solid #fde68a' : '1px solid #e5e7eb',
                        borderRadius: 10,
                        padding: '14px 18px',
                        display: 'flex',
                        gap: 16,
                        alignItems: 'center',
                      }}
                    >
                      <div style={{flex: 1}}>
                        <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6}}>
                          <span style={{fontSize: 13, fontWeight: 700, color: '#111827'}}>
                            {'\ud83c\udfe0 ' + h.housing_name}
                          </span>
                          <span data-activity-surface="layer.housing">
                            {React.createElement(ActivityPanel, {
                              sb,
                              authState,
                              entityType: 'layer.housing',
                              entityId: h.id,
                              entityLabel: h.housing_name,
                              mode: 'compact',
                              onCompactClick: setActivityTarget,
                            })}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              padding: '2px 7px',
                              borderRadius: 8,
                              background: h.status === 'active' ? '#d1fae5' : '#f3f4f6',
                              color: h.status === 'active' ? '#065f46' : '#6b7280',
                              textTransform: 'uppercase',
                            }}
                          >
                            {h.status}
                          </span>
                          {h.start_date && (
                            <span style={{fontSize: 11, color: '#6b7280'}}>from {fmt(h.start_date)}</span>
                          )}
                          {h.retired_date && (
                            <span style={{fontSize: 11, color: '#9ca3af'}}>{'\u2192 ' + fmt(h.retired_date)}</span>
                          )}
                        </div>
                        <div style={{display: 'flex', gap: 16, fontSize: 11, color: '#6b7280', flexWrap: 'wrap'}}>
                          <span>
                            Physical:{' '}
                            <strong style={{color: '#374151'}}>
                              {h.current_count != null ? h.current_count : '\u2014'}
                            </strong>
                            {h.current_count_date ? (
                              <span style={{color: '#9ca3af', fontWeight: 400}}>
                                {' on ' + fmt(h.current_count_date)}
                              </span>
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
                              <span style={{color: '#9ca3af', fontWeight: 400}}>
                                {' (\u2212' + proj.mortSince + ')'}
                              </span>
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
                        </div>
                      </div>
                      {batchHousings.length > 1 && (
                        <div style={{display: 'flex', gap: 16, flexShrink: 0}}>
                          <StatPill
                            label="Total Feed"
                            val={hs.totalFeed > 0 ? Math.round(hs.totalFeed) + ' lbs' : '\u2014'}
                            color="#92400e"
                          />
                          {selectedBatch && selectedBatch.name !== 'Retirement Home' && (
                            <StatPill
                              label="Starter"
                              val={hs.starterFeed > 0 ? Math.round(hs.starterFeed) + ' lbs' : '\u2014'}
                              color="#1e40af"
                            />
                          )}
                          {selectedBatch && selectedBatch.name !== 'Retirement Home' && (
                            <StatPill
                              label="Grower"
                              val={hs.growerFeed > 0 ? Math.round(hs.growerFeed) + ' lbs' : '\u2014'}
                              color="#065f46"
                            />
                          )}
                          <StatPill
                            label="Layer"
                            val={hs.layerFeed > 0 ? Math.round(hs.layerFeed) + ' lbs' : '\u2014'}
                            color="#78350f"
                          />
                          <StatPill
                            label="Mort."
                            val={hs.totalMort || '0'}
                            color={hs.totalMort > 5 ? '#b91c1c' : '#374151'}
                          />
                          <StatPill
                            label="Eggs"
                            val={hs.totalEggs > 0 ? hs.totalEggs.toLocaleString() : '\u2014'}
                            color="#78350f"
                          />
                        </div>
                      )}
                      <div style={{display: 'flex', gap: 6, flexShrink: 0}}>
                        <button
                          onClick={() => {
                            setHForm({
                              ...EMPTY_HOUSING,
                              ...h,
                              current_count: h.current_count != null ? h.current_count : '',
                            });
                            setEditHousingId(h.id);
                            setShowHousingForm(true);
                          }}
                          style={{
                            padding: '5px 10px',
                            borderRadius: 6,
                            border: '1px solid #d1d5db',
                            background: 'white',
                            fontSize: 11,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          Edit
                        </button>
                        {h.status === 'active' && (
                          <button
                            onClick={() => {
                              window._wcfConfirm('Retire ' + h.housing_name + '?', () => retireHousing(h), 'Retire');
                            }}
                            style={{
                              padding: '5px 10px',
                              borderRadius: 6,
                              border: '1px solid #fca5a5',
                              background: '#fef2f2',
                              color: '#b91c1c',
                              fontSize: 11,
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                            }}
                          >
                            Retire
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Batch notes */}
            {selectedBatch.notes && (
              <div
                style={{
                  background: 'white',
                  border: '1px solid #e5e7eb',
                  borderRadius: 10,
                  padding: '12px 16px',
                  fontSize: 12,
                  color: '#374151',
                }}
              >
                <span style={{color: '#9ca3af'}}>Notes: </span>
                {selectedBatch.notes}
              </div>
            )}
          </>
        )}

        {/* BATCH FORM MODAL */}
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
                  {editBatchId ? 'Edit Layer Batch' : 'New Layer Batch'}{' '}
                  <span style={{fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 6}}>
                    Auto-saves as you type
                  </span>
                </div>
                <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                  {batchSaving ? (
                    <span style={{fontSize: 11, color: '#9ca3af'}}>{'Saving\u2026'}</span>
                  ) : batchPending ? (
                    <span style={{fontSize: 11, color: '#9ca3af'}}>{'Unsaved\u2026'}</span>
                  ) : editBatchId ? (
                    <span style={{fontSize: 11, color: '#065f46'}}>{'\u2713 Saved'}</span>
                  ) : null}
                  <button
                    onClick={closeBatchForm}
                    style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
                  >
                    {'\u00d7'}
                  </button>
                </div>
              </div>
              <div
                style={{
                  padding: '16px 20px',
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 10,
                  maxHeight: '70vh',
                  overflowY: 'auto',
                }}
              >
                <div style={{gridColumn: '1/-1'}}>
                  <label style={S.label}>Batch Name *</label>
                  <input
                    value={bForm.name}
                    onChange={(e) => updBatch((f) => ({...f, name: e.target.value}))}
                    placeholder="e.g. L-26-01"
                  />
                </div>
                <div>
                  <label style={S.label}>Status</label>
                  <select value={bForm.status} onChange={(e) => updBatch((f) => ({...f, status: e.target.value}))}>
                    <option value="active">Active</option>
                    <option value="retired">Retired</option>
                  </select>
                </div>
                {bForm.name !== 'Retirement Home' && (
                  <div>
                    <label style={S.label}>Original Count</label>
                    <input
                      type="number"
                      min="0"
                      value={bForm.original_count || ''}
                      onChange={(e) => updBatch((f) => ({...f, original_count: e.target.value}))}
                    />
                  </div>
                )}
                {bForm.name !== 'Retirement Home' && (
                  <div>
                    <label style={S.label}>Supplier</label>
                    <input
                      value={bForm.supplier}
                      onChange={(e) => updBatch((f) => ({...f, supplier: e.target.value}))}
                    />
                  </div>
                )}
                {bForm.name !== 'Retirement Home' && (
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={S.label}>Cost per Bird ($)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      style={{maxWidth: 160}}
                      value={bForm.cost_per_bird || ''}
                      onChange={(e) => updBatch((f) => ({...f, cost_per_bird: e.target.value}))}
                    />
                  </div>
                )}

                {/* FEED COST RATES (read-only — populated from global rates set in Admin → Feed Costs) */}
                {bForm.name !== 'Retirement Home' && (
                  <div style={{gridColumn: '1/-1', borderTop: '1px solid #e5e7eb', paddingTop: 10, marginTop: 4}}>
                    <div style={{fontSize: 11, fontWeight: 700, color: '#4b5563', letterSpacing: 0.5, marginBottom: 6}}>
                      {'\ud83d\udcb0 FEED COST RATES'}{' '}
                      <span style={{fontWeight: 400, color: '#9ca3af'}}>
                        {'(locked \u2014 set in Admin \u203a Feed Costs)'}
                      </span>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        gap: 16,
                        fontSize: 12,
                        color: '#374151',
                        padding: '8px 12px',
                        background: '#f9fafb',
                        borderRadius: 8,
                        border: '1px solid #e5e7eb',
                      }}
                    >
                      <span>
                        Starter:{' '}
                        <strong>
                          {bForm.per_lb_starter_cost !== '' && bForm.per_lb_starter_cost != null
                            ? '$' + parseFloat(bForm.per_lb_starter_cost).toFixed(3) + '/lb'
                            : '\u2014'}
                        </strong>
                      </span>
                      <span>
                        Grower:{' '}
                        <strong>
                          {bForm.per_lb_grower_cost !== '' && bForm.per_lb_grower_cost != null
                            ? '$' + parseFloat(bForm.per_lb_grower_cost).toFixed(3) + '/lb'
                            : '\u2014'}
                        </strong>
                      </span>
                      <span>
                        Layer:{' '}
                        <strong>
                          {bForm.per_lb_layer_cost !== '' && bForm.per_lb_layer_cost != null
                            ? '$' + parseFloat(bForm.per_lb_layer_cost).toFixed(3) + '/lb'
                            : '\u2014'}
                        </strong>
                      </span>
                    </div>
                  </div>
                )}

                {/* BROODER PHASE */}
                {bForm.name !== 'Retirement Home' && (
                  <div
                    style={{
                      gridColumn: '1/-1',
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
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={S.label}>Brooder</label>
                    <select
                      value={bForm.brooder_name}
                      onChange={(e) => {
                        const val = e.target.value;
                        const entry = bForm.brooder_entry_date;
                        const exit = entry
                          ? toISO(addDays(new Date(entry + 'T12:00:00'), 21))
                          : bForm.brooder_exit_date;
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
                        // Check conflicts with broiler batches
                        const entry = bForm.brooder_entry_date;
                        const exit = entry
                          ? toISO(addDays(new Date(entry + 'T12:00:00'), 21 + BROODER_CLEANOUT))
                          : null;
                        const conflictBroiler =
                          entry &&
                          exit &&
                          batches
                            .filter((bt) => bt.brooder === b && bt.id !== editBatchId)
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
                          layerBatches
                            .filter((lb) => lb.brooder_name === b && lb.id !== editBatchId && lb.brooder_entry_date)
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
                  <div>
                    <label style={S.label}>Date in Brooder</label>
                    <input
                      type="date"
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
                  <div>
                    <label style={S.label}>
                      Exit Date <span style={{color: '#9ca3af', fontWeight: 400}}>(auto)</span>
                    </label>
                    <input
                      type="date"
                      value={bForm.brooder_exit_date}
                      readOnly
                      style={{background: '#f9fafb', color: '#6b7280'}}
                    />
                  </div>
                )}

                {/* SCHOONER PHASE */}
                {bForm.name !== 'Retirement Home' && (
                  <div
                    style={{
                      gridColumn: '1/-1',
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
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={S.label}>Schooner</label>
                    <select
                      value={bForm.schooner_name}
                      onChange={(e) => updBatch((f) => ({...f, schooner_name: e.target.value}))}
                    >
                      <option value="">Select schooner…</option>
                      {SCHOONERS.map((s) => {
                        const entry = bForm.schooner_entry_date;
                        const exit =
                          bForm.schooner_exit_date ||
                          (entry ? toISO(addDays(new Date(entry + 'T12:00:00'), 119 + SCHOONER_CLEANOUT)) : null);
                        const conflictBroiler =
                          entry &&
                          exit &&
                          batches
                            .filter((bt) => bt.schooner === s && bt.id !== editBatchId)
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
                          layerBatches
                            .filter(
                              (lb) =>
                                lb.schooner_name === 'Schooner ' + s && lb.id !== editBatchId && lb.schooner_entry_date,
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
                            key={s}
                            value={'Schooner ' + s}
                            disabled={conflict}
                            style={{color: conflict ? '#9ca3af' : 'inherit'}}
                          >
                            {'Schooner ' + s + (conflict ? ' ⚠ In use' : '')}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                )}
                {bForm.name !== 'Retirement Home' && (
                  <div>
                    <label style={S.label}>
                      Entry Date <span style={{color: '#9ca3af', fontWeight: 400}}>(auto)</span>
                    </label>
                    <input
                      type="date"
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
                  <div>
                    <label style={S.label}>
                      Exit Date <span style={{color: '#9ca3af', fontWeight: 400}}>(editable)</span>
                    </label>
                    <input
                      type="date"
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
                          gridColumn: '1/-1',
                          fontSize: 11,
                          padding: '4px 8px',
                          borderRadius: 5,
                          background: warn ? '#fef2f2' : '#ecfdf5',
                          color: warn ? '#b91c1c' : '#065f46',
                          fontWeight: 600,
                        }}
                      >
                        {warn ? '\u26a0 ' : ''}
                        {weeks} weeks in schooner {warn ? '(expected 3 to 24 weeks)' : '\u2713'}
                      </div>
                    );
                  })()}

                <div style={{gridColumn: '1/-1', borderTop: '1px solid #e5e7eb', paddingTop: 10, marginTop: 4}}>
                  <label style={S.label}>Notes</label>
                  <textarea
                    value={bForm.notes}
                    onChange={(e) => updBatch((f) => ({...f, notes: e.target.value}))}
                    rows={2}
                    style={{resize: 'vertical'}}
                  />
                </div>
                {err && <div style={{gridColumn: '1/-1', color: '#b91c1c', fontSize: 12, fontWeight: 600}}>{err}</div>}
              </div>
              {editBatchId && bForm.name !== 'Retirement Home' && (
                <div style={{padding: '12px 20px', borderTop: '1px solid #e5e7eb'}}>
                  <button
                    onClick={function () {
                      confirmDelete(
                        'Delete batch ' +
                          bForm.name +
                          '? This will also delete all its housings. This cannot be undone.',
                        function () {
                          clearTimeout(batchAutoSaveTimer.current);
                          sb.from('layer_housings')
                            .delete()
                            .eq('batch_id', editBatchId)
                            .then(function () {
                              setLayerHousings(function (prev) {
                                return prev.filter(function (h) {
                                  return h.batch_id !== editBatchId;
                                });
                              });
                            });
                          sb.from('layer_batches')
                            .delete()
                            .eq('id', editBatchId)
                            .then(function () {
                              setLayerBatches(function (prev) {
                                return prev.filter(function (b) {
                                  return b.id !== editBatchId;
                                });
                              });
                            });
                          setShowBatchForm(false);
                          setEditBatchId(null);
                          setBForm(EMPTY_BATCH);
                          setSelectedBatchId(null);
                        },
                      );
                    }}
                    style={S.btnDanger}
                  >
                    Delete Batch
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* HOUSING FORM MODAL */}
        {showHousingForm && (
          <div
            onClick={closeHousingForm}
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
                  {editHousingId ? 'Edit Housing' : 'Add Housing'}
                </div>
                <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                  {housingSaving ? (
                    <span style={{fontSize: 11, color: '#9ca3af'}}>{'Saving\u2026'}</span>
                  ) : housingPending ? (
                    <span style={{fontSize: 11, color: '#9ca3af'}}>{'Unsaved\u2026'}</span>
                  ) : editHousingId ? (
                    <span style={{fontSize: 11, color: '#065f46'}}>{'\u2713 Saved'}</span>
                  ) : null}
                  <button
                    onClick={closeHousingForm}
                    style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
                  >
                    {'\u00d7'}
                  </button>
                </div>
              </div>
              <div
                style={{
                  padding: '16px 20px',
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 10,
                  maxHeight: '65vh',
                  overflowY: 'auto',
                }}
              >
                <div style={{gridColumn: '1/-1'}}>
                  <label style={S.label}>Housing (Layer Group) *</label>
                  <select
                    value={hForm.housing_name}
                    onChange={(e) => updHousing((f) => ({...f, housing_name: e.target.value}))}
                  >
                    <option value="">{'Select housing\u2026'}</option>
                    {layerGroups.map((g) => {
                      const isRetiredBatch = selectedBatch && selectedBatch.status === 'retired';
                      const locked =
                        !isRetiredBatch &&
                        lockedHousings.has(g.name) &&
                        !(editHousingId && layerHousings.find((h) => h.id === editHousingId)?.housing_name === g.name);
                      const owningHousing = layerHousings.find(
                        (h) => h.housing_name === g.name && h.status === 'active',
                      );
                      const owningBatch = owningHousing
                        ? layerBatches.find((b) => b.id === owningHousing.batch_id)
                        : null;
                      const label =
                        g.name + (locked ? ' \u26a0 In use' + (owningBatch ? ' by ' + owningBatch.name : '') : '');
                      return (
                        <option key={g.id} value={g.name} disabled={locked}>
                          {label}
                        </option>
                      );
                    })}
                  </select>
                  {hForm.housing_name &&
                    (() => {
                      const owningH = layerHousings.find(
                        (h) => h.housing_name === hForm.housing_name && h.status === 'active',
                      );
                      const owningB = owningH ? layerBatches.find((b) => b.id === owningH.batch_id) : null;
                      if (!owningB) return null;
                      return (
                        <div
                          style={{
                            marginTop: 6,
                            fontSize: 11,
                            color: '#1d4ed8',
                            background: '#eff6ff',
                            border: '1px solid #bfdbfe',
                            borderRadius: 6,
                            padding: '5px 10px',
                          }}
                        >
                          Currently active in: <strong>{owningB.name}</strong>
                        </div>
                      );
                    })()}
                </div>
                {hForm.housing_name &&
                  (() => {
                    const cap = getHousingCap(hForm.housing_name);
                    return (
                      cap < 9999 && (
                        <div
                          style={{
                            gridColumn: '1/-1',
                            fontSize: 11,
                            color: '#92400e',
                            background: '#fffbeb',
                            border: '1px solid #fde68a',
                            borderRadius: 6,
                            padding: '6px 10px',
                          }}
                        >
                          {'\u26a0 Capacity: ' + cap + ' birds max'}
                        </div>
                      )
                    );
                  })()}
                <div style={{gridColumn: '1/-1'}}>
                  <label style={S.label}>Current Count</label>
                  <input
                    type="number"
                    min="0"
                    value={hForm.current_count || ''}
                    onChange={(e) => updHousing((f) => ({...f, current_count: e.target.value}))}
                  />
                  {(() => {
                    // Date hint: show below field when current count value differs from existing stored value
                    if (!editHousingId)
                      return hForm.current_count !== '' ? (
                        <div style={{fontSize: 10, color: '#065f46', marginTop: 4}}>
                          {'Will be stamped: ' + fmt(todayStr())}
                        </div>
                      ) : null;
                    const existing = layerHousings.find((h) => h.id === editHousingId);
                    const oldVal = existing?.current_count;
                    const newVal = hForm.current_count !== '' ? parseInt(hForm.current_count) : null;
                    const oldNorm = oldVal == null ? null : parseInt(oldVal);
                    if (newVal !== oldNorm) {
                      return (
                        <div style={{fontSize: 10, color: '#065f46', marginTop: 4, fontWeight: 600}}>
                          {'Will be stamped: ' + fmt(todayStr())}
                        </div>
                      );
                    }
                    if (existing?.current_count_date) {
                      return (
                        <div style={{fontSize: 10, color: '#9ca3af', marginTop: 4}}>
                          {'Last set: ' + fmt(existing.current_count_date)}
                        </div>
                      );
                    }
                    return null;
                  })()}
                </div>
                <div>
                  <label style={S.label}>Start Date</label>
                  <input
                    type="date"
                    value={hForm.start_date}
                    onChange={(e) => updHousing((f) => ({...f, start_date: e.target.value}))}
                  />
                </div>
                <div>
                  <label style={S.label}>Status</label>
                  <select value={hForm.status} onChange={(e) => updHousing((f) => ({...f, status: e.target.value}))}>
                    <option value="active">Active</option>
                    <option value="retired">Retired</option>
                  </select>
                </div>
                {hForm.status === 'retired' && (
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={S.label}>Retired Date</label>
                    <input
                      type="date"
                      value={hForm.retired_date}
                      onChange={(e) => updHousing((f) => ({...f, retired_date: e.target.value}))}
                    />
                  </div>
                )}
                <div style={{gridColumn: '1/-1'}}>
                  <label style={S.label}>Notes</label>
                  <textarea
                    value={hForm.notes}
                    onChange={(e) => updHousing((f) => ({...f, notes: e.target.value}))}
                    rows={2}
                    style={{resize: 'vertical'}}
                  />
                </div>
                {err && <div style={{gridColumn: '1/-1', color: '#b91c1c', fontSize: 12, fontWeight: 600}}>{err}</div>}
              </div>
            </div>
          </div>
        )}
      </div>
      {React.createElement(ActivityModal, {
        sb,
        authState,
        target: activityTarget,
        onClose: () => setActivityTarget(null),
      })}
    </div>
  );
};

export default LayerBatchesView;
