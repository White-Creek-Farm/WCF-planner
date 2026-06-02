import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
import {recordSeqNavOptions, labeledSeqItems} from '../lib/recordSequence.js';
import UsersModal from '../auth/UsersModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import {loadCattleWeighInsCached} from '../lib/cattleCache.js';
import {buildForecast} from '../lib/cattleForecast.js';
import {loadForecastSettings, loadHeiferIncludes, loadHidden} from '../lib/cattleForecastApi.js';
import CattleBatchPage from './CattleBatchPage.jsx';

const CattleBatchesHub = ({
  sb,
  fmt,
  Header,
  authState,
  setView,
  showUsers,
  setShowUsers,
  allUsers,
  setAllUsers,
  loadUsers,
}) => {
  const navigate = useNavigate();
  const {useState, useEffect, useMemo} = React;
  const role = authState && authState.role;
  const canEdit = role === 'admin' || role === 'management';

  const [batches, setBatches] = useState([]);
  const [cattle, setCattle] = useState([]);
  const [weighIns, setWeighIns] = useState([]);
  const [calvingRecs, setCalvingRecs] = useState([]);
  const [forecastSettings, setForecastSettings] = useState(null);
  const [heiferIncludes, setHeiferIncludes] = useState(new Set());
  const [hidden, setHidden] = useState([]);
  const [loading, setLoading] = useState(true);

  const [showPlanned, setShowPlanned] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [scheduleDateDraft, setScheduleDateDraft] = useState({});
  const [notice, setNotice] = useState(null);

  async function loadAll() {
    setLoading(true);
    try {
      const [bR, cR, wAll, calR] = await Promise.all([
        sb.from('cattle_processing_batches').select('*').order('actual_process_date', {ascending: false}),
        sb.from('cattle').select('*').is('deleted_at', null),
        loadCattleWeighInsCached(sb),
        sb.from('cattle_calving_records').select('*'),
      ]);
      if (bR.error) throw new Error('cattle_processing_batches: ' + (bR.error.message || bR.error));
      if (cR.error) throw new Error('cattle: ' + (cR.error.message || cR.error));
      if (calR.error) throw new Error('cattle_calving_records: ' + (calR.error.message || calR.error));

      const forecastSidecarErrors = [];
      const [settings, inc, hid] = await Promise.all([
        loadForecastSettings(sb).catch((e) => {
          forecastSidecarErrors.push(e);
          return null;
        }),
        loadHeiferIncludes(sb).catch((e) => {
          forecastSidecarErrors.push(e);
          return new Set();
        }),
        loadHidden(sb).catch((e) => {
          forecastSidecarErrors.push(e);
          return [];
        }),
      ]);

      const byDate = (x) => x.actual_process_date || x.planned_process_date || x.created_at || '';
      setBatches((bR.data || []).slice().sort((a, b) => byDate(b).localeCompare(byDate(a))));
      setCattle(cR.data || []);
      setWeighIns(wAll || []);
      setCalvingRecs(calR.data || []);
      setForecastSettings(settings);
      setHeiferIncludes(inc);
      setHidden(hid);
      if (forecastSidecarErrors.length > 0) {
        setNotice(
          (prev) =>
            prev || {
              kind: 'warning',
              message: 'Forecast data could not fully load. Planned batches may be unavailable until refresh.',
            },
        );
      }
    } catch (e) {
      setNotice({
        kind: 'error',
        message: 'Could not load cattle processing batches. Please refresh the page. (' + (e.message || e) + ')',
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const forecast = useMemo(() => {
    if (!forecastSettings) return null;
    const realBatchesOnly = batches.filter((b) => b.status === 'active' || b.status === 'complete');
    const scheduledBatchesOnly = batches.filter((b) => b.status === 'scheduled');
    return buildForecast({
      cattle,
      weighIns,
      settings: forecastSettings,
      includes: heiferIncludes,
      hidden,
      realBatches: realBatchesOnly,
      scheduledBatches: scheduledBatchesOnly,
      todayMs: Date.now(),
    });
  }, [cattle, weighIns, forecastSettings, heiferIncludes, hidden, batches]);

  const virtualPlanned = useMemo(() => {
    if (!forecast) return [];
    const nowYm = new Date().toISOString().slice(0, 7);
    const limitMs = Date.now() + 365 * 86400000;
    const limitYm = new Date(limitMs).toISOString().slice(0, 7);
    return forecast.virtualBatches.filter((vb) => vb.monthKey >= nowYm && vb.monthKey <= limitYm);
  }, [forecast]);

  const scheduledList = useMemo(() => {
    if (!forecast) return [];
    return forecast.scheduledBatches
      .slice()
      .sort((a, b) => (a.planned_process_date || '').localeCompare(b.planned_process_date || ''));
  }, [forecast]);

  async function scheduleVirtualBatch(vb) {
    if (!canEdit) return;
    setNotice(null);
    const date = (scheduleDateDraft[vb.name] || '').trim();
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setNotice({kind: 'error', message: 'Pick a processor date (YYYY-MM-DD) before scheduling.'});
      return;
    }
    const rowId = 'cpb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const row = {
      id: rowId,
      name: vb.name,
      planned_process_date: date,
      status: 'scheduled',
      cows_detail: [],
      documents: [],
    };
    const r = await sb.from('cattle_processing_batches').insert(row).select().single();
    if (r.error) {
      setNotice({kind: 'error', message: 'Schedule failed: ' + r.error.message});
      return;
    }
    navigate('/cattle/batches/' + rowId);
  }

  const active = batches.filter((b) => b.status === 'active');
  const completed = batches.filter((b) => b.status === 'complete');
  // Visible/rendered order for record sequence nav (scheduled → active → then
  // processed ONLY when the Show Processed Batches section is expanded).
  // Virtual/planned forecast tiles are excluded — they don't route.
  const batchSeqRows = [...scheduledList, ...active, ...(showCompleted ? completed : [])];

  return (
    <div style={{minHeight: '100vh', background: '#f1f3f2'}}>
      {showUsers && (
        <UsersModal
          sb={sb}
          authState={authState}
          allUsers={allUsers}
          setAllUsers={setAllUsers}
          setShowUsers={setShowUsers}
          loadUsers={loadUsers}
        />
      )}
      <Header />
      <div style={{padding: '1rem', maxWidth: 1100, margin: '0 auto'}}>
        <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12}}>
          <div style={{fontSize: 16, fontWeight: 700, color: '#111827'}} data-cattle-batches-root>
            Processing Batches{' '}
            <span style={{fontSize: 13, fontWeight: 400, color: '#6b7280'}}>
              {scheduledList.length} scheduled · {active.length} active · {completed.length} processed
            </span>
          </div>
          {!canEdit && (
            <span
              style={{
                fontSize: 11,
                padding: '3px 8px',
                background: '#eff6ff',
                border: '1px solid #bfdbfe',
                borderRadius: 6,
                color: '#1e40af',
                fontWeight: 600,
              }}
            >
              READ-ONLY
            </span>
          )}
        </div>

        {loading && <div style={{textAlign: 'center', padding: '2rem', color: '#9ca3af'}}>Loading{'…'}</div>}

        {/* Show Planned Batches (virtual, top, collapsed) */}
        {!loading && (
          <CollapsibleSection
            label="Show Planned Batches"
            count={virtualPlanned.length}
            expanded={showPlanned}
            onToggle={() => setShowPlanned((v) => !v)}
            color="#fef2f2"
            border="#fca5a5"
            text="#991b1b"
            dataKey="planned"
          >
            {virtualPlanned.length === 0 ? (
              <div style={{padding: '0.75rem', color: '#9ca3af', fontSize: 12, fontStyle: 'italic'}}>
                No planned batches in the next 12 months — the forecast has no eligible cattle landing in the display
                window.
              </div>
            ) : (
              <div style={{display: 'flex', flexDirection: 'column', gap: 6, padding: '0.5rem 0.75rem'}}>
                {virtualPlanned.map((vb) => (
                  <div
                    key={vb.name}
                    data-virtual-batch={vb.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      flexWrap: 'wrap',
                      padding: '8px 10px',
                      background: 'white',
                      border: '1px dashed #fca5a5',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  >
                    <strong style={{color: '#991b1b'}}>{vb.name}</strong>
                    <span style={{color: '#6b7280'}}>{vb.label}</span>
                    <span
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        background: '#fef2f2',
                        color: '#991b1b',
                        border: '1px solid #fca5a5',
                        borderRadius: 4,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                      }}
                    >
                      Planned
                    </span>
                    <span style={{color: '#6b7280'}}>
                      {vb.animalIds.length} {vb.animalIds.length === 1 ? 'cow' : 'cows'}
                    </span>
                    {vb.projectedTotalLbs > 0 && (
                      <span style={{color: '#065f46', fontWeight: 600}}>
                        {Math.round(vb.projectedTotalLbs).toLocaleString()} lb projected
                      </span>
                    )}
                    <span style={{flex: 1}} />
                    {canEdit ? (
                      <span style={{display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap'}}>
                        <input
                          data-virtual-batch-schedule-date={vb.name}
                          type="date"
                          value={scheduleDateDraft[vb.name] || ''}
                          onChange={(e) => setScheduleDateDraft((prev) => ({...prev, [vb.name]: e.target.value}))}
                          style={{
                            fontSize: 11,
                            padding: '3px 6px',
                            border: '1px solid #d1d5db',
                            borderRadius: 5,
                            fontFamily: 'inherit',
                          }}
                          title="Processor date for this batch"
                        />
                        <button
                          data-virtual-batch-schedule={vb.name}
                          onClick={() => scheduleVirtualBatch(vb)}
                          disabled={!scheduleDateDraft[vb.name]}
                          style={{
                            fontSize: 11,
                            padding: '4px 10px',
                            borderRadius: 5,
                            border: 'none',
                            background: scheduleDateDraft[vb.name] ? '#085041' : '#9ca3af',
                            color: 'white',
                            cursor: scheduleDateDraft[vb.name] ? 'pointer' : 'not-allowed',
                            fontFamily: 'inherit',
                            fontWeight: 600,
                          }}
                        >
                          Schedule
                        </button>
                      </span>
                    ) : (
                      <span style={{fontSize: 11, color: '#9ca3af', fontStyle: 'italic'}}>
                        Created when sent to processor at WeighIns
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CollapsibleSection>
        )}

        {/* Scheduled batches — navigate to record page */}
        {!loading && scheduledList.length > 0 && (
          <div style={{marginTop: 12}} data-scheduled-section>
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: '#92400e',
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                marginBottom: 8,
              }}
            >
              Scheduled ({scheduledList.length})
            </div>
            <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
              {scheduledList.map((sb2) => (
                <div
                  key={sb2.id}
                  data-scheduled-batch={sb2.name}
                  data-batch-row={sb2.id}
                  onClick={() =>
                    navigate('/cattle/batches/' + sb2.id, recordSeqNavOptions(labeledSeqItems(batchSeqRows, 'name')))
                  }
                  className="hoverable-tile"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                    padding: '8px 10px',
                    background: 'white',
                    border: '1px solid #fde68a',
                    borderRadius: 8,
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  <strong style={{color: '#92400e'}}>{sb2.name}</strong>
                  <span
                    style={{
                      fontSize: 10,
                      padding: '1px 6px',
                      background: '#fffbeb',
                      color: '#92400e',
                      border: '1px solid #fde68a',
                      borderRadius: 4,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                    }}
                  >
                    Scheduled
                  </span>
                  <span style={{color: '#6b7280'}}>
                    {sb2.animalIds.length} {sb2.animalIds.length === 1 ? 'cow' : 'cows'} forecast
                  </span>
                  {sb2.planned_process_date && <span style={{color: '#065f46'}}>{fmt(sb2.planned_process_date)}</span>}
                  <span style={{flex: 1}} />
                  <span style={{fontSize: 11, color: '#9ca3af', fontStyle: 'italic'}}>
                    Cattle remain forecast-backed until sent from WeighIns
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Active batches — navigate to record page */}
        {!loading && (
          <div style={{marginTop: 12}}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: '#1d4ed8',
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                marginBottom: 8,
              }}
            >
              Active ({active.length})
            </div>
            {active.length === 0 ? (
              <div
                style={{
                  background: 'white',
                  border: '1px solid #e5e7eb',
                  borderRadius: 12,
                  padding: '1.25rem',
                  textAlign: 'center',
                  color: '#6b7280',
                  fontSize: 13,
                }}
              >
                No active batches. Cattle enter an active batch only via the Send-to-Processor flag on a finishers
                weigh-in session.
              </div>
            ) : (
              <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
                {active.map((b) => {
                  const rows = Array.isArray(b.cows_detail) ? b.cows_detail : [];
                  const totalLive = rows.reduce((s, r) => s + (parseFloat(r.live_weight) || 0), 0);
                  const totalHang = rows.reduce((s, r) => s + (parseFloat(r.hanging_weight) || 0), 0);
                  const yieldPct =
                    totalLive > 0 && totalHang > 0 ? Math.round((totalHang / totalLive) * 1000) / 10 : null;
                  return (
                    <div
                      key={b.id}
                      data-batch-row={b.id}
                      data-batch-name={b.name}
                      data-batch-status={b.status}
                      onClick={() =>
                        navigate('/cattle/batches/' + b.id, recordSeqNavOptions(labeledSeqItems(batchSeqRows, 'name')))
                      }
                      className="hoverable-tile"
                      style={{
                        background: 'white',
                        border: '1px solid #e5e7eb',
                        borderRadius: 12,
                        padding: '12px 18px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span style={{fontSize: 14, fontWeight: 700, color: '#111827'}}>{b.name}</span>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: 10,
                          background: '#1d4ed8',
                          color: 'white',
                          textTransform: 'uppercase',
                        }}
                      >
                        {b.status}
                      </span>
                      <span style={{fontSize: 11, color: '#6b7280'}}>
                        {rows.length} {rows.length === 1 ? 'cow' : 'cows'}
                      </span>
                      {b.actual_process_date && (
                        <span style={{fontSize: 11, color: '#065f46'}}>processed {fmt(b.actual_process_date)}</span>
                      )}
                      {yieldPct && (
                        <span style={{fontSize: 11, fontWeight: 600, color: '#065f46'}}>{yieldPct + '% yield'}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Processed batches — navigate to record page */}
        {!loading && (
          <div style={{marginTop: 14}}>
            <CollapsibleSection
              label="Show Processed Batches"
              count={completed.length}
              expanded={showCompleted}
              onToggle={() => setShowCompleted((v) => !v)}
              color="#f3f4f6"
              border="#d1d5db"
              text="#374151"
              dataKey="processed"
            >
              {completed.length === 0 ? (
                <div style={{padding: '0.75rem', color: '#9ca3af', fontSize: 12, fontStyle: 'italic'}}>
                  No processed batches yet.
                </div>
              ) : (
                <div style={{display: 'flex', flexDirection: 'column', gap: 10, padding: '0.5rem 0'}}>
                  {completed.map((b) => {
                    const rows = Array.isArray(b.cows_detail) ? b.cows_detail : [];
                    const totalLive = rows.reduce((s, r) => s + (parseFloat(r.live_weight) || 0), 0);
                    const totalHang = rows.reduce((s, r) => s + (parseFloat(r.hanging_weight) || 0), 0);
                    const yieldPct =
                      totalLive > 0 && totalHang > 0 ? Math.round((totalHang / totalLive) * 1000) / 10 : null;
                    return (
                      <div
                        key={b.id}
                        data-batch-row={b.id}
                        data-batch-name={b.name}
                        data-batch-status={b.status}
                        onClick={() =>
                          navigate(
                            '/cattle/batches/' + b.id,
                            recordSeqNavOptions(labeledSeqItems(batchSeqRows, 'name')),
                          )
                        }
                        className="hoverable-tile"
                        style={{
                          background: 'white',
                          border: '1px solid #e5e7eb',
                          borderRadius: 12,
                          padding: '12px 18px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{fontSize: 14, fontWeight: 700, color: '#111827'}}>{b.name}</span>
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            padding: '2px 8px',
                            borderRadius: 10,
                            background: '#374151',
                            color: 'white',
                            textTransform: 'uppercase',
                          }}
                        >
                          {b.status}
                        </span>
                        <span style={{fontSize: 11, color: '#6b7280'}}>
                          {rows.length} {rows.length === 1 ? 'cow' : 'cows'}
                        </span>
                        {(b.actual_process_date || b.planned_process_date) && (
                          <span style={{fontSize: 11, color: '#065f46'}}>
                            processed {fmt(b.actual_process_date || b.planned_process_date)}
                          </span>
                        )}
                        {yieldPct && (
                          <span style={{fontSize: 11, fontWeight: 600, color: '#065f46'}}>{yieldPct + '% yield'}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CollapsibleSection>
          </div>
        )}
      </div>
    </div>
  );
};

function CollapsibleSection({label, count, expanded, onToggle, color, border, text, children, dataKey}) {
  return (
    <div
      style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', marginBottom: 0}}
      data-batches-section={dataKey}
    >
      <div
        onClick={onToggle}
        style={{
          padding: '12px 16px',
          background: color,
          borderBottom: expanded ? '1px solid ' + border : 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          cursor: 'pointer',
        }}
      >
        <span style={{fontSize: 12, color: text}}>{expanded ? '▼' : '▶'}</span>
        <span style={{fontSize: 13, fontWeight: 700, color: text}}>{label}</span>
        <span style={{fontSize: 11, color: text, opacity: 0.7}}>({count})</span>
      </div>
      {expanded && children}
    </div>
  );
}

function CattleBatchesRouter(props) {
  const location = useLocation();
  const batchDetailId = location.pathname.startsWith('/cattle/batches/')
    ? location.pathname.slice('/cattle/batches/'.length) || null
    : null;
  if (batchDetailId) {
    return React.createElement(CattleBatchPage, {
      sb: props.sb,
      fmt: props.fmt,
      authState: props.authState,
      Header: props.Header,
    });
  }
  return React.createElement(CattleBatchesHub, props);
}

export default CattleBatchesRouter;
