// LayerBatchesView — hub + router for layer batches and housings.
//
// Hub shows nav-only batch tiles (active + retired) with summary stats.
// Tile clicks navigate to /layer/batches/<id>. The per-record workspace
// (metadata edit, lifecycle phases, housings list, batch delete cascade)
// lives on LayerBatchPage; layer.housing records have their own page at
// /layer/housings/<id>. Both record pages own Comments + collapsed
// Activity via RecordCollaborationSection.
import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import {computeHousingDisplayCount, computeLayerFeedCost} from '../lib/layerHousing.js';
import {computeBatchStats} from './layerBatchStats.js';
import LayerBatchPage from './LayerBatchPage.jsx';
import LayerHousingPage from './LayerHousingPage.jsx';

// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
const StatPill = ({label, val, color = '#374151'}) => (
  <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 70}}>
    <div style={{fontSize: 11, color: '#9ca3af', marginBottom: 2}}>{label}</div>
    <div style={{fontWeight: 700, fontSize: 13, color}}>{val}</div>
  </div>
);

const LayerBatchesHub = ({
  sb,
  layerGroups,
  layerBatches,
  setLayerBatches,
  layerHousings,
  fmt,
  Header,
  authState,
  pendingEdit,
  setPendingEdit,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const {useState, useEffect} = React;
  const role = authState && authState.role;
  const canEdit = role === 'admin' || role === 'management';

  const [rawLayerDailys, setRawLayerDailys] = useState([]);
  const [rawEggDailys, setRawEggDailys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);

  const [showAddBatch, setShowAddBatch] = useState(false);
  const [addName, setAddName] = useState('');
  const [addArrivalDate, setAddArrivalDate] = useState('');
  const [addStatus, setAddStatus] = useState('active');
  const [addErr, setAddErr] = useState('');
  const [addBusy, setAddBusy] = useState(false);

  function nextBatchName() {
    const yr = new Date().getFullYear().toString().slice(2);
    const existing = (layerBatches || []).filter((b) => b.name && b.name.match(/^L-\d{2}-\d{2}$/));
    const nums = existing.map((b) => parseInt(b.name.slice(5)) || 0);
    const next = (Math.max(0, ...nums) + 1).toString().padStart(2, '0');
    return `L-${yr}-${next}`;
  }

  useEffect(() => {
    async function fetchAll(table, columns) {
      const PAGE = 1000;
      let all = [];
      let offset = 0;
      let done = false;
      while (!done) {
        const {data, error} = await sb
          .from(table)
          .select(columns)
          .is('deleted_at', null)
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
      setRawEggDailys(ed);
      setLoading(false);
    });
  }, [layerBatches, layerHousings]);

  // Pick up notice handed via navigation state (e.g. delete report from
  // record page if blocked detaches need surfacing on the hub).
  useEffect(() => {
    if (location.state && location.state.notice) {
      setNotice(location.state.notice);
      navigate(location.pathname, {replace: true, state: null});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Timeline deep-link → /layer/batches/<id>
  useEffect(() => {
    if (pendingEdit?.viewName === 'layerbatches' && pendingEdit?.id) {
      const id = pendingEdit.id;
      setPendingEdit && setPendingEdit(null);
      navigate('/layer/batches/' + id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEdit]);

  const batchStats = React.useMemo(
    () => computeBatchStats(layerBatches || [], layerHousings || [], rawLayerDailys, rawEggDailys),
    [layerBatches, layerHousings, rawLayerDailys, rawEggDailys],
  );

  function openAdd() {
    if (!canEdit) return;
    setAddErr('');
    setAddName(nextBatchName());
    setAddArrivalDate('');
    setAddStatus('active');
    setShowAddBatch(true);
  }

  async function saveNewBatch() {
    if (!canEdit) return;
    setAddErr('');
    const name = (addName || '').trim();
    if (!name) {
      setAddErr('Batch name required.');
      return;
    }
    setAddBusy(true);
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const rec = {
      id,
      name,
      status: addStatus || 'active',
      arrival_date: addArrivalDate || null,
      original_count: null,
      supplier: null,
      cost_per_bird: null,
      brooder_name: null,
      brooder_entry_date: null,
      brooder_exit_date: null,
      schooner_name: null,
      schooner_entry_date: null,
      schooner_exit_date: null,
      notes: null,
    };
    const {error} = await sb.from('layer_batches').upsert(rec, {onConflict: 'id'});
    setAddBusy(false);
    if (error) {
      setAddErr('Could not save: ' + error.message);
      return;
    }
    if (typeof setLayerBatches === 'function') {
      setLayerBatches((prev) => {
        const exists = prev.find((b) => b.id === rec.id);
        return exists ? prev.map((b) => (b.id === rec.id ? rec : b)) : [...prev, rec];
      });
    }
    setShowAddBatch(false);
    navigate('/layer/batches/' + id);
  }

  const activeBatches = (layerBatches || []).filter((b) => b.status === 'active');
  const retiredBatches = (layerBatches || []).filter((b) => b.status === 'retired');
  const batchColors = [
    {bg: '#ecfdf5', bd: '#a7f3d0', tx: '#065f46'},
    {bg: '#eff6ff', bd: '#bfdbfe', tx: '#1e40af'},
    {bg: '#fffbeb', bd: '#fde68a', tx: '#92400e'},
    {bg: '#f5f3ff', bd: '#ddd6fe', tx: '#5b21b6'},
  ];

  return (
    <div style={{minHeight: '100vh', background: '#f1f3f2'}}>
      <Header />
      <div style={{padding: '1rem', maxWidth: 1100, margin: '0 auto'}} data-layer-batches-hub>
        <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16}}>
          <div style={{fontSize: 20, fontWeight: 700, color: '#111827'}}>
            Layer Batches
            <span style={{fontSize: 13, fontWeight: 400, color: '#6b7280', marginLeft: 8}}>
              {activeBatches.length} active
            </span>
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={openAdd}
              data-layer-new-batch
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
          )}
        </div>

        {loading && <div style={{textAlign: 'center', padding: '3rem', color: '#9ca3af'}}>Loading...</div>}

        {!loading && (
          <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
            {activeBatches.map((batch, bi) => {
              const stats = batchStats[batch.id] || {};
              const housings = (layerHousings || []).filter((h) => h.batch_id === batch.id);
              const activeH = housings.filter((h) => h.status === 'active');
              const isRetHome = batch.name === 'Retirement Home';
              const bc = batchColors[bi % batchColors.length];
              return (
                <div
                  key={batch.id}
                  data-layer-batch-tile={batch.id}
                  onClick={() => navigate('/layer/batches/' + batch.id)}
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
                        const months = +((new Date() - new Date(anchor + 'T12:00:00')) / 86400000 / 30.44).toFixed(1);
                        return months > 0 ? (
                          <span style={{fontSize: 11, color: bc.tx, opacity: 0.85}}>{months + ' months old'}</span>
                        ) : null;
                      })()}
                  </div>
                  <div style={{padding: '12px 20px', display: 'flex', gap: 20, alignItems: 'flex-start'}}>
                    <div style={{flex: 1}}>
                      {activeH.length > 0 && (
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
                              {'🏠 ' + h.housing_name}
                              {(() => {
                                const c = computeHousingDisplayCount(h, rawLayerDailys);
                                return c > 0 ? ' · ' + c + ' hens' : '';
                              })()}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={{display: 'flex', gap: 20, flexShrink: 0}}>
                      <StatPill
                        label="Feed"
                        val={stats.totalFeed > 0 ? Math.round(stats.totalFeed).toLocaleString() + ' lbs' : '—'}
                        color="#92400e"
                      />
                      <StatPill
                        label="Mort."
                        val={stats.totalMort > 0 ? stats.totalMort : '0'}
                        color={stats.totalMort > 10 ? '#b91c1c' : '#374151'}
                      />
                      <StatPill
                        label="Dozens"
                        val={stats.totalEggs > 0 ? Math.floor(stats.totalEggs / 12).toLocaleString() : '—'}
                        color="#065f46"
                      />
                      {(() => {
                        const fc = computeLayerFeedCost(stats.starterFeed, stats.growerFeed, stats.layerFeed, batch);
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
                                : '—'
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

            {retiredBatches.length > 0 && (
              <>
                <div style={{fontSize: 12, fontWeight: 600, color: '#4b5563', letterSpacing: 0.3, marginTop: 8}}>
                  RETIRED BATCHES
                </div>
                {retiredBatches.map((batch, bi) => {
                  const stats = batchStats[batch.id] || {};
                  return (
                    <div
                      key={batch.id}
                      data-layer-batch-tile={batch.id}
                      onClick={() => navigate('/layer/batches/' + batch.id)}
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
                          val={stats.totalFeed > 0 ? Math.round(stats.totalFeed).toLocaleString() + ' lbs' : '—'}
                        />
                        <StatPill label="Mort." val={stats.totalMort || '0'} />
                        <StatPill
                          label="Dozens"
                          val={stats.totalEggs > 0 ? Math.floor(stats.totalEggs / 12).toLocaleString() : '—'}
                        />
                        {(() => {
                          const fc = computeLayerFeedCost(stats.starterFeed, stats.growerFeed, stats.layerFeed, batch);
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
                                  : '—'
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

            {activeBatches.length === 0 && retiredBatches.length === 0 && (
              <div
                style={{
                  background: 'white',
                  border: '1px solid #e5e7eb',
                  borderRadius: 12,
                  padding: '2rem',
                  textAlign: 'center',
                  color: '#6b7280',
                  fontSize: 13,
                }}
              >
                No layer batches yet. Click <strong>+ New Batch</strong> to plan one.
              </div>
            )}
          </div>
        )}
      </div>

      {/* + New Batch helper */}
      {showAddBatch && (
        <div
          onClick={() => setShowAddBatch(false)}
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
            data-layer-new-batch-modal
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
              <div style={{fontSize: 15, fontWeight: 600, color: '#78350f'}}>New Layer Batch</div>
              <button
                type="button"
                onClick={() => setShowAddBatch(false)}
                style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
              >
                ×
              </button>
            </div>
            <div style={{padding: '16px 20px', display: 'grid', gap: 10}}>
              <div>
                <label style={{fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3, fontWeight: 500}}>
                  Batch Name *
                </label>
                <input
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  data-layer-new-batch-name
                  placeholder="e.g. L-26-01"
                />
              </div>
              <div>
                <label style={{fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3, fontWeight: 500}}>
                  Status
                </label>
                <select value={addStatus} onChange={(e) => setAddStatus(e.target.value)}>
                  <option value="active">Active</option>
                  <option value="retired">Retired</option>
                </select>
              </div>
              <div>
                <label style={{fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3, fontWeight: 500}}>
                  Arrival Date
                </label>
                <input type="date" value={addArrivalDate} onChange={(e) => setAddArrivalDate(e.target.value)} />
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
                Saves a batch shell and opens its record page. Fill in brooder, schooner, and costs there.
              </div>
              {addErr && <div style={{color: '#b91c1c', fontSize: 12, fontWeight: 600}}>{addErr}</div>}
            </div>
            <div style={{padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8}}>
              <button
                type="button"
                onClick={saveNewBatch}
                disabled={addBusy}
                data-layer-new-batch-save
                style={{
                  padding: '8px 18px',
                  borderRadius: 7,
                  border: 'none',
                  background: addBusy ? '#9ca3af' : '#085041',
                  color: 'white',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: addBusy ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Save & open
              </button>
              <button
                type="button"
                onClick={() => setShowAddBatch(false)}
                style={{
                  padding: '8px 16px',
                  borderRadius: 7,
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
    </div>
  );
};

function LayerBatchesRouter(props) {
  const location = useLocation();
  if (location.pathname.startsWith('/layer/housings/')) {
    return React.createElement(LayerHousingPage, {
      sb: props.sb,
      fmt: props.fmt,
      Header: props.Header,
      authState: props.authState,
      layerGroups: props.layerGroups,
      layerBatches: props.layerBatches,
      layerHousings: props.layerHousings,
      setLayerHousings: props.setLayerHousings,
    });
  }
  if (location.pathname.startsWith('/layer/batches/')) {
    return React.createElement(LayerBatchPage, {
      sb: props.sb,
      fmt: props.fmt,
      Header: props.Header,
      authState: props.authState,
      layerGroups: props.layerGroups,
      layerBatches: props.layerBatches,
      layerHousings: props.layerHousings,
      setLayerBatches: props.setLayerBatches,
      setLayerHousings: props.setLayerHousings,
      batches: props.batches,
      feedCosts: props.feedCosts,
      confirmDelete: props.confirmDelete,
    });
  }
  return React.createElement(LayerBatchesHub, props);
}

export default LayerBatchesRouter;
