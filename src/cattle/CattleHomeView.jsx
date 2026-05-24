// Phase 2 Round 3 extraction (verbatim).
import React from 'react';
import UsersModal from '../auth/UsersModal.jsx';
import CattleBulkImport from './CattleBulkImport.jsx';
import SheepBulkImport from '../sheep/SheepBulkImport.jsx';
import CowDetail from './CowDetail.jsx';
import SheepDetail from '../sheep/SheepDetail.jsx';
import {loadCattleWeighInsCached} from '../lib/cattleCache.js';
import {toISO} from '../lib/dateUtils.js';
import {buildForecast} from '../lib/cattleForecast.js';
import {loadForecastSettings, loadHeiferIncludes, loadHidden} from '../lib/cattleForecastApi.js';
import {renderCattleIconLabel} from '../components/CattleIcon.jsx';
const CattleHomeView = ({
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
  const [cattle, setCattle] = useState([]);
  const [dailys, setDailys] = useState([]);
  const [weighIns, setWeighIns] = useState([]);
  const [calving, setCalving] = useState([]);
  const [targets, setTargets] = useState({});
  const [loading, setLoading] = useState(true);
  const [cattleDashPeriod, setCattleDashPeriod] = useState(30);
  const [forecastTile, setForecastTile] = useState(null);
  const HERDS = ['mommas', 'backgrounders', 'finishers', 'bulls'];
  const HERD_LABELS = {mommas: 'Mommas', backgrounders: 'Backgrounders', finishers: 'Finishers', bulls: 'Bulls'};
  const HERD_COLORS = {mommas: '#dc2626', backgrounders: '#ea580c', finishers: '#e11d48', bulls: '#991b1b'};
  // Pull 120 days of dailys so the nutrition panel can compute 30/90/120-day
  // windows in a single pass without re-fetching.
  const cutoff120 = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  useEffect(() => {
    Promise.all([
      sb.from('cattle').select('*'),
      sb.from('cattle_dailys').select('*').is('deleted_at', null).gte('date', cutoff120),
      loadCattleWeighInsCached(sb),
      sb.from('cattle_calving_records').select('*'),
      sb.from('cattle_nutrition_targets').select('*'),
      sb.from('cattle_processing_batches').select('*'),
      loadForecastSettings(sb).catch(() => null),
      loadHeiferIncludes(sb).catch(() => new Set()),
      loadHidden(sb).catch(() => []),
    ]).then(([cR, dR, wAll, calvR, tR, bR, settings, includes, hidden]) => {
      if (cR.data) setCattle(cR.data);
      if (dR.data) setDailys(dR.data);
      setWeighIns(wAll);
      if (calvR.data) setCalving(calvR.data);
      if (tR.data) {
        const m = {};
        tR.data.forEach((r) => {
          m[r.herd] = r;
        });
        setTargets(m);
      }
      // Forecast tile — next processor batch + current-year ready count.
      if (settings && cR.data) {
        try {
          const allBatches = bR.data || [];
          const f = buildForecast({
            cattle: cR.data,
            weighIns: wAll || [],
            settings,
            includes,
            hidden,
            realBatches: allBatches.filter((b) => b.status === 'active' || b.status === 'complete'),
            scheduledBatches: allBatches.filter((b) => b.status === 'scheduled'),
            todayMs: Date.now(),
          });
          setForecastTile({
            nextBatch: f.nextProcessorBatch,
            currentYearReady: f.summary.readyThisYear,
          });
        } catch {
          /* tolerate forecast errors on the home tile */
        }
      }
      setLoading(false);
    });
  }, []);

  // Weigh-ins sorted newest-first so .find() returns the globally latest
  // matching entry across whatever tags a cow has had (current + old).
  const weighInsDesc = React.useMemo(
    () => [...weighIns].sort((a, b) => (b.entered_at || '').localeCompare(a.entered_at || '')),
    [weighIns],
  );

  // Tags to probe for a given cow: current tag + any non-purchase old tags.
  // source='import' entries are selling-farm tags that can collide with
  // unrelated WCF cows and must NOT be used for weight lookups.
  function cowTagSet(c) {
    const s = new Set();
    if (c.tag) s.add(c.tag);
    if (Array.isArray(c.old_tags)) {
      for (const ot of c.old_tags) {
        if (!ot || !ot.tag || ot.source === 'import') continue;
        s.add(ot.tag);
      }
    }
    return s;
  }

  function cowLastWeight(c) {
    const tags = cowTagSet(c);
    if (tags.size === 0) return 0;
    const w = weighInsDesc.find((x) => tags.has(x.tag));
    return w ? parseFloat(w.weight) || 0 : 0;
  }

  // Default for cows without a real weigh-in yet. Used in aggregate math
  // (herd live weight, cow units, nutrition target) so feed planning stays
  // sane between purchase and first real weigh-in. Per-cow displays still
  // show "no weigh-in" — this fallback is aggregate-only.
  //
  // Scope: only cows purchased within the last ESTIMATE_WINDOW_DAYS days.
  // Older un-weighed records (legacy cows, on-farm calves) contribute 0 —
  // 1,000 lb is wrong for a calf and dishonest for a long-standing data gap.
  const DEFAULT_COW_WEIGHT = 1000;
  const ESTIMATE_WINDOW_DAYS = 120;
  function isRecentlyPurchased(c) {
    if (!c || !c.purchase_date) return false;
    const ms = Date.now() - new Date(c.purchase_date + 'T12:00:00').getTime();
    return ms >= 0 && ms <= ESTIMATE_WINDOW_DAYS * 86400000;
  }
  function cowEffectiveWeight(c) {
    const real = cowLastWeight(c);
    if (real > 0) return real;
    return isRecentlyPurchased(c) ? DEFAULT_COW_WEIGHT : 0;
  }
  function isWeightEstimated(c) {
    return cowLastWeight(c) === 0 && isRecentlyPurchased(c);
  }

  // Herd live weight = sum of effective weights (real where known, 1000 lb
  // fallback for un-weighed cows). Drives the dashboard tiles + window math.
  function herdLiveWeight(herd) {
    return cattle.filter((c) => c.herd === herd).reduce((s, c) => s + cowEffectiveWeight(c), 0);
  }
  function herdEstimatedCount(herd) {
    return cattle.filter((c) => c.herd === herd && isWeightEstimated(c)).length;
  }

  const totalCattle = cattle.filter((c) => HERDS.includes(c.herd)).length;
  const totalLiveWeight = HERDS.reduce((s, h) => s + herdLiveWeight(h), 0);
  const totalEstimatedCows = HERDS.reduce((s, h) => s + herdEstimatedCount(h), 0);
  const dailys30 = dailys.filter((d) => (d.date || '') >= cutoff30);
  const totalMort30 = dailys30.reduce((s, d) => s + (parseInt(d.mortality_count) || 0), 0);
  const totalFeedCost30 = dailys30.reduce((s, d) => {
    const feeds = Array.isArray(d.feeds) ? d.feeds : [];
    return (
      s +
      feeds.reduce(
        (ss, f) =>
          ss +
          (parseFloat(f.lbs_as_fed) || 0) *
            (f.nutrition_snapshot && f.nutrition_snapshot.landed_per_lb
              ? parseFloat(f.nutrition_snapshot.landed_per_lb)
              : 0),
        0,
      )
    );
  }, 0);

  // ── Rolling-window stats per herd ───────────────────────────────────────
  // Per-herd metrics for an arbitrary [fromISO, toISO] window. Target DM/day
  // = cow_units × target_pct × 10 (since total body weight = cow_units × 1000).
  // Cow units are window-AVERAGED, backdated to purchase_date so a cow
  // purchased mid-window only contributes to cow_units for the days she was
  // actually present — target lbs/day shrinks proportionally and matches
  // what was actually being fed. Creep-flagged feed lines on Mommas are
  // excluded from DM/CP/NFC (calves eat it, not the mommas) but still
  // counted in feedLbs / feedCost.
  function computeCattleHerdWindow(herd, fromISO, toISO) {
    const windowDays = Math.max(
      1,
      Math.floor((new Date(toISO + 'T12:00:00') - new Date(fromISO + 'T12:00:00')) / 86400000) + 1,
    );
    const rows = dailys.filter((d) => d.herd === herd && d.date >= fromISO && d.date <= toISO);
    let dm = 0,
      cp = 0,
      nfc = 0,
      feedLbs = 0,
      feedCost = 0,
      mort = 0;
    const reportDates = new Set();
    for (const d of rows) {
      reportDates.add(d.date);
      mort += parseInt(d.mortality_count) || 0;
      const feeds = Array.isArray(d.feeds) ? d.feeds : [];
      for (const f of feeds) {
        const lbs = parseFloat(f.lbs_as_fed) || 0;
        const ns = f.nutrition_snapshot || {};
        const cpl = parseFloat(ns.landed_per_lb) || 0;
        feedLbs += lbs;
        feedCost += lbs * cpl;
        if (herd === 'mommas' && f.is_creep) continue;
        dm += lbs;
        cp += (lbs * (parseFloat(ns.protein_pct) || 0)) / 100;
        nfc += (lbs * (parseFloat(ns.nfc_pct) || 0)) / 100;
      }
    }
    const perDay = {dm: dm / windowDays, cp: cp / windowDays, nfc: nfc / windowDays};

    let unitDays = 0;
    for (const c of cattle) {
      if (c.herd !== herd) continue;
      const wt = cowEffectiveWeight(c);
      let daysIn = windowDays;
      if (c.purchase_date && c.purchase_date > fromISO) {
        const ms = new Date(toISO + 'T12:00:00') - new Date(c.purchase_date + 'T12:00:00');
        daysIn = Math.max(0, Math.min(windowDays, Math.floor(ms / 86400000) + 1));
      }
      unitDays += wt * daysIn;
    }
    const cowUnits = unitDays / windowDays / 1000;

    const t = targets[herd];
    let target = null;
    if (t && cowUnits > 0) {
      const targetDm = cowUnits * (parseFloat(t.target_dm_pct_body) || 0) * 10;
      target = {
        dm: targetDm,
        cp: (targetDm * (parseFloat(t.target_cp_pct_dm) || 0)) / 100,
        nfc: (targetDm * (parseFloat(t.target_nfc_pct_dm) || 0)) / 100,
      };
    }
    return {feedLbs, feedCost, mort, perDay, target, cowUnits, reportDays: reportDates.size, days: windowDays};
  }
  // Only show herds that actually have cows — empty herds just add noise.
  const activeHerdsWithCows = HERDS.filter((h) => cattle.some((c) => c.herd === h));

  // Trend arrow: shows ↑/↓/→ + percent change vs prior period. Suppresses
  // noise from near-zero baselines (matches the Layers dashboard rule).
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
  function pctOfTargetColor(pct) {
    if (pct == null) return '#6b7280';
    if (pct >= 90 && pct <= 110) return '#065f46';
    if (pct >= 75 && pct < 90) return '#92400e';
    if (pct > 110) return '#1e40af';
    return '#b91c1c';
  }

  // Per-herd metrics grid — same auto-fill tile pattern as the Layers dashboard.
  const CattleMetricsGrid = ({s, prev}) => {
    const dmPct = s.target ? (s.perDay.dm / s.target.dm) * 100 : null;
    const cpPct = s.target ? (s.perDay.cp / s.target.cp) * 100 : null;
    const nfcPct = s.target ? (s.perDay.nfc / s.target.nfc) * 100 : null;
    const items = [
      {l: 'Total feed', v: s.feedLbs > 0 ? Math.round(s.feedLbs).toLocaleString() + ' lbs' : '\u2014'},
      {l: 'Feed cost', v: s.feedCost > 0 ? '$' + Math.round(s.feedCost).toLocaleString() : '\u2014', color: '#92400e'},
      {
        l: 'DM lb/day',
        v: s.perDay.dm > 0 ? s.perDay.dm.toFixed(1) : '\u2014',
        sub: s.target ? Math.round(s.target.dm) + ' target' : null,
        pct: dmPct,
        trend: prev ? trendArrow(s.perDay.dm, prev.perDay.dm, false) : null,
      },
      {
        l: 'CP lb/day',
        v: s.perDay.cp > 0 ? s.perDay.cp.toFixed(1) : '\u2014',
        sub: s.target ? Math.round(s.target.cp) + ' target' : null,
        pct: cpPct,
        trend: prev ? trendArrow(s.perDay.cp, prev.perDay.cp, false) : null,
      },
      {
        l: 'NFC lb/day',
        v: s.perDay.nfc > 0 ? s.perDay.nfc.toFixed(1) : '\u2014',
        sub: s.target ? Math.round(s.target.nfc) + ' target' : null,
        pct: nfcPct,
        trend: prev ? trendArrow(s.perDay.nfc, prev.perDay.nfc, false) : null,
      },
      {l: 'Cow units', v: s.cowUnits > 0 ? s.cowUnits.toFixed(1) : '\u2014'},
      {l: 'Mortality', v: String(s.mort || 0), warn: s.mort > 0},
      {l: 'Report days', v: s.reportDays + ' of ' + s.days},
    ];
    return (
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8, minWidth: 0}}>
        {items.map((it) => (
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
              style={{fontSize: 9, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2}}
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
            {it.sub && <div style={{fontSize: 9, color: '#9ca3af', marginTop: 2}}>{it.sub}</div>}
            {it.pct != null && (
              <div style={{fontSize: 10, fontWeight: 700, color: pctOfTargetColor(it.pct), marginTop: 2}}>
                {Math.round(it.pct) + '% of target'}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  const PeriodToggle = ({val, setVal, opts}) => (
    <div
      style={{display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid #d1d5db', width: 'fit-content'}}
    >
      {opts.map(({v, l}) => (
        <button
          key={v}
          onClick={() => setVal(v)}
          style={{
            padding: '6px 14px',
            border: 'none',
            fontFamily: 'inherit',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            background: val === v ? '#991b1b' : 'white',
            color: val === v ? 'white' : '#6b7280',
          }}
        >
          {l}
        </button>
      ))}
    </div>
  );

  // Window dates for current vs previous period (for trend arrows)
  const periodFromISO = new Date(Date.now() - (cattleDashPeriod - 1) * 86400000).toISOString().slice(0, 10);
  const todayISOstr = new Date().toISOString().slice(0, 10);
  const prevToISO = new Date(Date.now() - cattleDashPeriod * 86400000).toISOString().slice(0, 10);
  const prevFromISO = new Date(Date.now() - (cattleDashPeriod * 2 - 1) * 86400000).toISOString().slice(0, 10);

  const StatTile = ({label, val, sub, color = '#991b1b'}) => (
    <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 16px'}}>
      <div style={{fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4}}>
        {label}
      </div>
      <div style={{fontSize: 24, fontWeight: 700, color, lineHeight: 1}}>{val}</div>
      {sub && <div style={{fontSize: 11, color: '#9ca3af', marginTop: 3}}>{sub}</div>}
    </div>
  );

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
        <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10}}>
          <StatTile label="Cattle on Farm" val={totalCattle.toLocaleString()} />
          <StatTile
            label="Total Live Weight"
            val={totalLiveWeight > 0 ? Math.round(totalLiveWeight).toLocaleString() + ' lbs' : '\u2014'}
            sub={totalEstimatedCows > 0 ? totalEstimatedCows + ' est. @ 1,000 lb' : null}
            color="#991b1b"
          />
          <StatTile
            label="Cow Units (1,000 lb)"
            val={totalLiveWeight > 0 ? (totalLiveWeight / 1000).toFixed(1) : '\u2014'}
            sub={totalEstimatedCows > 0 ? totalEstimatedCows + ' est.' : null}
            color="#7f1d1d"
          />
          <StatTile
            label="Mortality 30d"
            val={totalMort30.toString()}
            color={totalMort30 > 0 ? '#b91c1c' : '#374151'}
          />
          <StatTile label="Reports 30d" val={dailys.length.toString()} color="#374151" />
          <StatTile
            label="Feed Cost 30d"
            val={totalFeedCost30 > 0 ? '$' + Math.round(totalFeedCost30).toLocaleString() : '\u2014'}
            color="#92400e"
          />
        </div>

        {forecastTile && (
          <div
            data-cattle-home-forecast-tile
            onClick={() => setView('cattleforecast')}
            style={{
              background: 'white',
              border: '1px solid #fca5a5',
              borderLeft: '4px solid #991b1b',
              borderRadius: 12,
              padding: '14px 18px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              flexWrap: 'wrap',
            }}
            className="hoverable-tile"
          >
            <span
              style={{
                fontSize: 11,
                padding: '3px 8px',
                background: '#991b1b',
                color: 'white',
                borderRadius: 4,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              Forecast
            </span>
            {forecastTile.nextBatch ? (
              <>
                <span style={{fontSize: 14, fontWeight: 700, color: '#111827'}}>
                  Next: {forecastTile.nextBatch.name}
                </span>
                <span style={{fontSize: 12, color: '#6b7280'}}>
                  {forecastTile.nextBatch.label} \u00b7 {forecastTile.nextBatch.animalIds.length}{' '}
                  {forecastTile.nextBatch.animalIds.length === 1 ? 'cow' : 'cows'}
                </span>
              </>
            ) : (
              <span style={{fontSize: 13, color: '#6b7280', fontStyle: 'italic'}}>No planned batch yet</span>
            )}
            <span style={{flex: 1}} />
            <span style={{fontSize: 12, color: '#374151'}}>
              <strong>{forecastTile.currentYearReady}</strong> ready <span style={{color: '#9ca3af'}}>this year</span>
            </span>
            <span style={{fontSize: 11, color: '#1d4ed8', textDecoration: 'underline'}}>Open Forecast {'\u2192'}</span>
          </div>
        )}

        {/* Per-herd breakdown */}
        <div>
          <div style={{fontSize: 13, fontWeight: 600, color: '#4b5563', marginBottom: 8, letterSpacing: 0.3}}>
            HERD BREAKDOWN
          </div>
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10}}>
            {HERDS.map((h) => {
              const cows = cattle.filter((c) => c.herd === h);
              const lw = herdLiveWeight(h);
              const cu = lw / 1000;
              const est = herdEstimatedCount(h);
              const t = targets[h];
              return (
                <div
                  key={h}
                  onClick={() => setView('cattleherds')}
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
                    <span style={{fontSize: 14, fontWeight: 700, color: HERD_COLORS[h]}}>{HERD_LABELS[h]}</span>
                    <span style={{fontSize: 11, color: '#6b7280'}}>
                      {cows.length} {cows.length === 1 ? 'cow' : 'cows'}
                    </span>
                  </div>
                  <div style={{fontSize: 12, color: '#374151'}}>
                    Live wt: <strong>{lw > 0 ? Math.round(lw).toLocaleString() + ' lbs' : '\u2014'}</strong>
                  </div>
                  <div style={{fontSize: 12, color: '#374151'}}>
                    Cow units: <strong>{cu > 0 ? cu.toFixed(1) : '\u2014'}</strong>
                  </div>
                  {est > 0 && (
                    <div style={{fontSize: 11, color: '#92400e', marginTop: 2}}>
                      {est + ' est. @ 1,000 lb (no weigh-in yet)'}
                    </div>
                  )}
                  {t && (
                    <div style={{fontSize: 11, color: '#9ca3af', marginTop: 4}}>
                      {'Target: DM ' +
                        t.target_dm_pct_body +
                        '% \u00b7 CP ' +
                        t.target_cp_pct_dm +
                        '% \u00b7 NFC ' +
                        t.target_nfc_pct_dm +
                        '%'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Rolling-window per-herd cards — same pattern as the Layers dashboard */}
        {activeHerdsWithCows.length > 0 && (
          <div>
            <div style={{display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10}}>
              <div style={{fontSize: 13, fontWeight: 600, color: '#4b5563', letterSpacing: 0.3}}>
                HERDS {'\u2014'} ROLLING WINDOW
              </div>
              <PeriodToggle
                val={cattleDashPeriod}
                setVal={setCattleDashPeriod}
                opts={[
                  {v: 30, l: '30 Days'},
                  {v: 90, l: '90 Days'},
                  {v: 120, l: '120 Days'},
                ]}
              />
            </div>
            <div style={{display: 'flex', flexDirection: 'column', gap: 14}}>
              {activeHerdsWithCows.map((h) => {
                const cur = computeCattleHerdWindow(h, periodFromISO, todayISOstr);
                const prev = computeCattleHerdWindow(h, prevFromISO, prevToISO);
                const t = targets[h];
                const cows = cattle.filter((c) => c.herd === h);
                const est = herdEstimatedCount(h);
                const accent = HERD_COLORS[h];
                return (
                  <div
                    key={h}
                    onClick={() => setView('cattleherds')}
                    style={{
                      background: 'white',
                      border: '1px solid #e5e7eb',
                      borderRadius: 14,
                      overflow: 'hidden',
                      cursor: 'pointer',
                    }}
                    className="hoverable-tile"
                  >
                    <div
                      style={{
                        background: '#fef2f2',
                        borderBottom: '1px solid #fecaca',
                        borderLeft: '4px solid ' + accent,
                        padding: '12px 20px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span style={{fontSize: 16, fontWeight: 700, color: accent}}>
                        {renderCattleIconLabel(HERD_LABELS[h], {size: 22})}
                      </span>
                      <span style={{fontSize: 11, color: '#6b7280'}}>
                        {cows.length} {cows.length === 1 ? 'cow' : 'cows'}
                      </span>
                      {cur.cowUnits > 0 && (
                        <span style={{fontSize: 11, color: '#6b7280'}}>
                          {'\u00b7 ' + cur.cowUnits.toFixed(1) + ' cow units (avg over window)'}
                        </span>
                      )}
                      {est > 0 && (
                        <span style={{fontSize: 11, color: '#92400e', fontStyle: 'italic'}}>
                          {'(' + est + ' est. @ 1,000 lb)'}
                        </span>
                      )}
                      {t && (
                        <span style={{fontSize: 11, color: '#9ca3af', marginLeft: 'auto'}}>
                          {'Target DM ' +
                            t.target_dm_pct_body +
                            '% \u00b7 CP ' +
                            t.target_cp_pct_dm +
                            '% DM \u00b7 NFC ' +
                            t.target_nfc_pct_dm +
                            '% DM'}
                        </span>
                      )}
                      {!t && (
                        <span style={{fontSize: 11, color: '#b91c1c', marginLeft: 'auto'}}>No target configured</span>
                      )}
                    </div>
                    <div style={{padding: '14px 20px'}}>
                      <CattleMetricsGrid s={cur} prev={prev} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {loading && (
          <div style={{textAlign: 'center', padding: '2rem', color: '#9ca3af', fontSize: 13}}>Loading{'\u2026'}</div>
        )}

        {!loading && totalCattle === 0 && (
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
            No cattle on file yet. Click <strong>Herds</strong> in the sub-nav to add your first cow, or wait for the
            Podio import after the daily report flow is live in the field.
          </div>
        )}
      </div>
    </div>
  );
};

export default CattleHomeView;
