// Phase 2 Round 3 extraction (verbatim).
import React from 'react';
import UsersModal from '../auth/UsersModal.jsx';
import {toISO} from '../lib/dateUtils.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import {ANIMAL_ICON_KEYS} from '../lib/plannerIcons.js';
const SheepHomeView = ({
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
  const {useState, useEffect} = React;
  const [sheep, setSheep] = useState([]);
  const [dailys, setDailys] = useState([]);
  const [weighIns, setWeighIns] = useState([]);
  const [batchCounts, setBatchCounts] = useState({total: 0, planned: 0});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [period, setPeriod] = useState(30);
  const FLOCKS = ['rams', 'ewes', 'feeders'];
  const FLOCK_LABELS = {rams: 'Rams', ewes: 'Ewes', feeders: 'Feeders'};
  const FLOCK_COLORS = {rams: '#0f766e', ewes: '#86198f', feeders: '#854d0e'};
  const SEX_DEFAULT_WEIGHT = {ewe: 150, ram: 225, wether: 80};
  const ESTIMATE_WINDOW_DAYS = 120;
  const cutoff120 = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    try {
      const sessR = await sb.from('weigh_in_sessions').select('id').eq('species', 'sheep');
      if (sessR.error) throw new Error('weigh_in_sessions: ' + (sessR.error.message || sessR.error));
      const sessIds = (sessR.data || []).map((s) => s.id);
      const wR = sessIds.length > 0 ? await sb.from('weigh_ins').select('*').in('session_id', sessIds) : {data: []};
      if (wR.error) throw new Error('weigh_ins: ' + (wR.error.message || wR.error));
      const [sR, dR] = await Promise.all([
        sb.from('sheep').select('*').is('deleted_at', null),
        sb.from('sheep_dailys').select('*').is('deleted_at', null).gte('date', cutoff120),
      ]);
      if (sR.error) throw new Error('sheep: ' + (sR.error.message || sR.error));
      if (dR.error) throw new Error('sheep_dailys: ' + (dR.error.message || dR.error));

      setSheep(sR.data || []);
      setDailys(dR.data || []);
      setWeighIns(wR.data || []);
      setBatchCounts({total: 0, planned: 0});

      // Processing batch counts for the dashboard tile. Tolerate missing
      // table on legacy schemas (pre-migration-028).
      try {
        const bR = await sb.from('sheep_processing_batches').select('id,status');
        if (bR.error) throw bR.error;
        const all = (bR.data || []).length;
        const planned = (bR.data || []).filter((b) => b.status === 'planned').length;
        setBatchCounts({total: all, planned});
      } catch {
        setBatchCounts({total: 0, planned: 0});
      }
    } catch (e) {
      setSheep([]);
      setDailys([]);
      setWeighIns([]);
      setBatchCounts({total: 0, planned: 0});
      setLoadError({
        kind: 'error',
        message: 'Could not load sheep dashboard. Please retry. (' + ((e && e.message) || e) + ')',
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function lastWeight(s) {
    if (!s.tag) return 0;
    const w = weighIns.find((x) => x.tag === s.tag);
    return w ? parseFloat(w.weight) || 0 : 0;
  }
  function isRecentlyPurchased(s) {
    if (!s.purchase_date) return false;
    const ms = Date.now() - new Date(s.purchase_date + 'T12:00:00').getTime();
    return ms >= 0 && ms <= ESTIMATE_WINDOW_DAYS * 86400000;
  }
  function effectiveWeight(s) {
    const real = lastWeight(s);
    if (real > 0) return real;
    return isRecentlyPurchased(s) ? SEX_DEFAULT_WEIGHT[s.sex] || 0 : 0;
  }
  function flockTotalWeight(f) {
    return sheep.filter((s) => s.flock === f).reduce((sum, s) => sum + effectiveWeight(s), 0);
  }
  function flockEstCount(f) {
    return sheep.filter((s) => s.flock === f && lastWeight(s) === 0 && isRecentlyPurchased(s)).length;
  }

  const totalSheep = sheep.filter((s) => FLOCKS.includes(s.flock)).length;
  const totalWeight = FLOCKS.reduce((s, f) => s + flockTotalWeight(f), 0);
  const totalEstimated = FLOCKS.reduce((s, f) => s + flockEstCount(f), 0);
  const dailys30 = dailys.filter((d) => (d.date || '') >= cutoff30);
  const totalMort30 = dailys30.reduce((s, d) => s + (parseInt(d.mortality_count) || 0), 0);
  const totalReports30 = dailys30.length;
  // Helpers to pull hay bales / alfalfa lbs / mineral pct out of the feeds/
  // minerals jsonb arrays populated by migration 012 + new submits.
  const sumBales = (d) =>
    Array.isArray(d.feeds)
      ? d.feeds.reduce((s, f) => s + (f.category === 'hay' && f.unit === 'bale' ? parseFloat(f.qty) || 0 : 0), 0)
      : 0;
  // Alfalfa pellets only — hay category excluded so historical hay bales
  // (remapped by migration 013 to the ALFALFA cattle hay entry) don't
  // inflate alfalfa-lb totals via the bale unit-weight.
  const sumAlfalfa = (d) =>
    Array.isArray(d.feeds)
      ? d.feeds.reduce((s, f) => {
          const nm = String(f.feed_name || '').toLowerCase();
          return s + (f.category === 'pellet' && nm.includes('alfalfa') ? parseFloat(f.lbs_as_fed) || 0 : 0);
        }, 0)
      : 0;
  function computeWindow(fromISO, toISO) {
    const windowDays = Math.max(
      1,
      Math.floor((new Date(toISO + 'T12:00:00') - new Date(fromISO + 'T12:00:00')) / 86400000) + 1,
    );
    const rows = dailys.filter((d) => d.date >= fromISO && d.date <= toISO);
    let bales = 0,
      alfalfa = 0,
      mort = 0,
      fenceSum = 0,
      fenceN = 0,
      watersOk = 0,
      watersN = 0;
    const reportDates = new Set();
    for (const d of rows) {
      reportDates.add(d.date);
      bales += sumBales(d);
      alfalfa += sumAlfalfa(d);
      mort += parseInt(d.mortality_count) || 0;
      if (d.fence_voltage_kv != null) {
        fenceSum += parseFloat(d.fence_voltage_kv) || 0;
        fenceN++;
      }
      if (d.waterers_working != null) {
        if (d.waterers_working) watersOk++;
        watersN++;
      }
    }
    return {
      bales,
      alfalfa,
      mort,
      fenceAvg: fenceN > 0 ? fenceSum / fenceN : null,
      watersPct: watersN > 0 ? (watersOk / watersN) * 100 : null,
      reportDays: reportDates.size,
      days: windowDays,
    };
  }

  function trendArrow(cur, prev, higherIsBetter) {
    if (cur == null || prev == null || prev === 0) return null;
    if (Math.abs(prev) < 0.05) return null;
    const pct = ((cur - prev) / prev) * 100;
    if (Math.abs(pct) > 200) return null;
    const up = pct >= 0;
    const good = higherIsBetter ? up : !up;
    const color = Math.abs(pct) < 2 ? '#9ca3af' : good ? '#065f46' : '#b91c1c';
    const arrow = Math.abs(pct) < 2 ? '\u2192' : up ? '\u2191' : '\u2193';
    return (
      <span style={{fontSize: 10, color, fontWeight: 600, marginLeft: 4}}>
        {arrow} {Math.abs(pct).toFixed(0)}%
      </span>
    );
  }

  const periodFromISO = new Date(Date.now() - (period - 1) * 86400000).toISOString().slice(0, 10);
  const todayISOstr = new Date().toISOString().slice(0, 10);
  const prevToISO = new Date(Date.now() - period * 86400000).toISOString().slice(0, 10);
  const prevFromISO = new Date(Date.now() - (period * 2 - 1) * 86400000).toISOString().slice(0, 10);
  const cur = computeWindow(periodFromISO, todayISOstr);
  const prev = computeWindow(prevFromISO, prevToISO);

  const StatTile = ({label, val, sub, color = '#0f766e'}) => (
    <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 16px'}}>
      <div style={{fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4}}>
        {label}
      </div>
      <div style={{fontSize: 24, fontWeight: 700, color, lineHeight: 1}}>{val}</div>
      {sub && <div style={{fontSize: 11, color: '#9ca3af', marginTop: 3}}>{sub}</div>}
    </div>
  );

  const PeriodToggle = () => (
    <div
      style={{display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid #d1d5db', width: 'fit-content'}}
    >
      {[
        {v: 30, l: '30 Days'},
        {v: 90, l: '90 Days'},
        {v: 120, l: '120 Days'},
      ].map(({v, l}) => (
        <button
          key={v}
          onClick={() => setPeriod(v)}
          style={{
            padding: '6px 14px',
            border: 'none',
            fontFamily: 'inherit',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            background: period === v ? '#0f766e' : 'white',
            color: period === v ? 'white' : '#6b7280',
          }}
        >
          {l}
        </button>
      ))}
    </div>
  );

  return (
    <div
      style={{minHeight: '100vh', background: '#f1f3f2'}}
      data-sheep-home-loaded={loading || loadError ? 'false' : 'true'}
    >
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
      <div
        style={{
          padding: '1.25rem',
          maxWidth: 1200,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.5rem',
        }}
      >
        {loadError && (
          <div>
            <InlineNotice notice={loadError} />
            <button
              type="button"
              data-sheep-home-load-retry="1"
              onClick={loadAll}
              style={{
                padding: '7px 14px',
                borderRadius: 8,
                border: '1px solid #991b1b',
                background: 'white',
                color: '#991b1b',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              Retry
            </button>
          </div>
        )}
        {!loadError && (
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10}}>
            <StatTile label="Sheep on Farm" val={totalSheep.toLocaleString()} />
            <StatTile
              label="Total Live Weight"
              val={totalWeight > 0 ? Math.round(totalWeight).toLocaleString() + ' lbs' : '\u2014'}
              sub={totalEstimated > 0 ? totalEstimated + ' est.' : null}
            />
            <StatTile
              label="Mortality 30d"
              val={totalMort30.toString()}
              color={totalMort30 > 0 ? '#b91c1c' : '#374151'}
            />
            <StatTile label="Reports 30d" val={totalReports30.toString()} color="#374151" />
          </div>
        )}

        {!loadError && (
          <div>
            <div style={{fontSize: 13, fontWeight: 600, color: '#4b5563', marginBottom: 8, letterSpacing: 0.3}}>
              FLOCK BREAKDOWN
            </div>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10}}>
              {/* Processing-batches shortcut tile — discoverable nav alongside flock tiles. */}
              <div
                onClick={() => setView('sheepbatches')}
                style={{
                  background: 'white',
                  border: '1px solid #5eead4',
                  borderLeft: '4px solid #0f766e',
                  borderRadius: 12,
                  padding: '14px 16px',
                  cursor: 'pointer',
                }}
                className="hoverable-tile"
              >
                <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6}}>
                  <span style={{fontSize: 14, fontWeight: 700, color: '#0f766e'}}>Processing Batches</span>
                  <span style={{fontSize: 11, color: '#6b7280'}}>
                    {batchCounts.total} {batchCounts.total === 1 ? 'batch' : 'batches'}
                  </span>
                </div>
                <div style={{fontSize: 12, color: '#374151'}}>
                  {batchCounts.planned > 0 ? (
                    <span>
                      <strong>{batchCounts.planned}</strong> planned
                    </span>
                  ) : (
                    <span style={{color: '#9ca3af'}}>No planned batches</span>
                  )}
                </div>
                <div style={{fontSize: 11, color: '#9ca3af', marginTop: 4}}>
                  Sheep enter via the Send-to-Processor flag on a sheep weigh-in.
                </div>
              </div>
              {FLOCKS.map((f) => {
                const flockSheep = sheep.filter((s) => s.flock === f);
                const lw = flockTotalWeight(f);
                const est = flockEstCount(f);
                return (
                  <div
                    key={f}
                    onClick={() => setView('sheepflocks')}
                    style={{
                      background: 'white',
                      border: '1px solid #e5e7eb',
                      borderRadius: 12,
                      padding: '14px 16px',
                      cursor: 'pointer',
                    }}
                    className="hoverable-tile"
                  >
                    <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6}}>
                      <span style={{fontSize: 14, fontWeight: 700, color: FLOCK_COLORS[f]}}>{FLOCK_LABELS[f]}</span>
                      <span style={{fontSize: 11, color: '#6b7280'}}>
                        {flockSheep.length} {flockSheep.length === 1 ? 'sheep' : 'sheep'}
                      </span>
                    </div>
                    <div style={{fontSize: 12, color: '#374151'}}>
                      Live wt: <strong>{lw > 0 ? Math.round(lw).toLocaleString() + ' lbs' : '\u2014'}</strong>
                    </div>
                    {est > 0 && (
                      <div style={{fontSize: 11, color: '#92400e', marginTop: 2}}>
                        {est + ' est. (no weigh-in yet)'}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!loading && !loadError && (
          <div>
            <div style={{display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10}}>
              <div style={{fontSize: 13, fontWeight: 600, color: '#4b5563', letterSpacing: 0.3}}>
                FARM-WIDE DAILYS {'\u2014'} ROLLING WINDOW
              </div>
              <PeriodToggle />
            </div>
            <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, overflow: 'hidden'}}>
              <div
                style={{
                  background: '#f0fdfa',
                  borderBottom: '1px solid #5eead4',
                  borderLeft: '4px solid #0f766e',
                  padding: '12px 20px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <span
                  style={{
                    fontSize: 16,
                    fontWeight: 700,
                    color: '#0f766e',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <PlannerIcon iconKey={ANIMAL_ICON_KEYS.sheep} size={20} />
                  <span>All Flocks</span>
                </span>
                <span style={{fontSize: 11, color: '#6b7280'}}>
                  {cur.reportDays} of {cur.days} days reported
                </span>
              </div>
              <div style={{padding: '14px 20px'}}>
                <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8}}>
                  {[
                    {
                      l: 'Bales of hay',
                      v: cur.bales > 0 ? cur.bales.toFixed(2) : '\u2014',
                      trend: trendArrow(cur.bales, prev.bales, false),
                    },
                    {
                      l: 'Alfalfa lbs',
                      v: cur.alfalfa > 0 ? Math.round(cur.alfalfa).toLocaleString() : '\u2014',
                      trend: trendArrow(cur.alfalfa, prev.alfalfa, false),
                    },
                    {
                      l: 'Fence voltage',
                      v: cur.fenceAvg != null ? cur.fenceAvg.toFixed(1) + ' kV' : '\u2014',
                      trend: trendArrow(cur.fenceAvg, prev.fenceAvg, true),
                      color:
                        cur.fenceAvg >= 4
                          ? '#065f46'
                          : cur.fenceAvg >= 2
                            ? '#92400e'
                            : cur.fenceAvg != null
                              ? '#b91c1c'
                              : null,
                    },
                    {l: 'Waterers OK', v: cur.watersPct != null ? Math.round(cur.watersPct) + '%' : '\u2014'},
                    {l: 'Mortality', v: String(cur.mort || 0), warn: cur.mort > 0},
                    {l: 'Report days', v: cur.reportDays + ' of ' + cur.days},
                  ].map((it) => (
                    <div
                      key={it.l}
                      style={{
                        padding: '8px 10px',
                        background: '#f9fafb',
                        border: '1px solid #f3f4f6',
                        borderRadius: 8,
                        minWidth: 0,
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          fontSize: 9,
                          color: '#9ca3af',
                          textTransform: 'uppercase',
                          letterSpacing: 0.4,
                          marginBottom: 2,
                        }}
                      >
                        {it.l}
                      </div>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: it.warn ? '#b91c1c' : it.color || '#111827',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {it.v}
                        {it.trend}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {loading && (
          <div style={{textAlign: 'center', padding: '2rem', color: '#9ca3af', fontSize: 13}}>Loading{'\u2026'}</div>
        )}
        {!loading && !loadError && totalSheep === 0 && (
          <div
            style={{
              background: 'white',
              border: '1px solid #e5e7eb',
              borderRadius: 12,
              padding: '24px',
              textAlign: 'center',
              color: '#6b7280',
              fontSize: 13,
            }}
          >
            No sheep on file yet. Click <strong>Flocks</strong> in the sub-nav, then <strong>Bulk Import</strong> to
            load your records.
          </div>
        )}
      </div>
    </div>
  );
};

export default SheepHomeView;
