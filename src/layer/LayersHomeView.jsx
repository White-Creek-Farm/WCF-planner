// ============================================================================
// src/layer/LayersHomeView.jsx  —  Phase 2 Round 6
// ----------------------------------------------------------------------------
// Layers home dashboard — per-batch lifetime feed/egg/cost stats for active batches.
// Consumes useLayer for all layer-scope data, useFeedCosts for fallback
// feed rates when a batch has no per-batch cost overrides, plus the usual
// Auth/Batches/UI.
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {openableProps} from '../shared/openable.js';
import {fmt, fmtS, todayISO, addDays, toISO} from '../lib/dateUtils.js';
import {S} from '../lib/styles.js';
import {computeHousingDisplayCount, computeLayerFeedCost} from '../lib/layerHousing.js';
import UsersModal from '../auth/UsersModal.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {useBatches} from '../contexts/BatchesContext.jsx';
import {useLayer} from '../contexts/LayerContext.jsx';
import {useFeedCosts} from '../contexts/FeedCostsContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';

export default function LayersHomeView({Header, loadUsers}) {
  const {authState, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const {batches} = useBatches();
  const {layerBatches, layerHousings, allLayerDailys, allEggDailys, retHomeDashPeriod, setRetHomeDashPeriod} =
    useLayer();
  const {feedCosts} = useFeedCosts();
  const {setView} = useUI();
  const fmt$ = (v) =>
    v == null ? '\u2014' : '$' + v.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const fmt$0 = (v) =>
    v == null ? '\u2014' : '$' + v.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0});
  const lifetimeFromForBatch = (batch) => batch.brooder_entry_date || batch.arrival_date || '1900-01-01';

  // Compute stats for a given batch over an arbitrary date window.
  // Attribution rule: a report belongs to this batch if
  //   (a) its batch_id matches (most reliable for new submissions), OR
  //   (b) its batch_label matches the batch name OR any of this batch's housing names,
  //       AND no other active batch claims that name (text fallback for legacy rows).
  function computeBatchWindow(batch, fromISO, toISO) {
    const anchor = batch.brooder_entry_date || batch.arrival_date || null;
    const myHousings = (layerHousings || []).filter((h) => h.batch_id === batch.id);
    const myNames = new Set([
      batch.name.toLowerCase().trim(),
      ...myHousings.map((h) =>
        String(h.housing_name || '')
          .toLowerCase()
          .trim(),
      ),
    ]);
    const myReports = (allLayerDailys || []).filter((d) => {
      if (d.date < fromISO || d.date > toISO) return false;
      if (d.batch_id === batch.id) return true;
      if (d.batch_id) return false; // batch_id set but doesn't match — skip
      return myNames.has(
        String(d.batch_label || '')
          .toLowerCase()
          .trim(),
      );
    });
    let totalFeed = 0,
      totalMort = 0,
      starterFeed = 0,
      growerFeed = 0,
      layerFeed = 0;
    const reportDates = new Set();
    myReports.forEach((d) => {
      const f = parseFloat(d.feed_lbs) || 0;
      totalFeed += f;
      totalMort += parseInt(d.mortality_count) || 0;
      reportDates.add(d.date);
      let phase = d.feed_type || 'LAYER';
      if (anchor) {
        try {
          const days = Math.floor((new Date(d.date + 'T12:00:00') - new Date(anchor + 'T12:00:00')) / 86400000);
          if (days < 21) phase = 'STARTER';
          else if (days < 140) phase = 'GROWER';
          else phase = 'LAYER';
        } catch (_e) {
          /* defensive parse — fall through to default phase */
        }
      }
      if (phase === 'STARTER') starterFeed += f;
      else if (phase === 'GROWER') growerFeed += f;
      else layerFeed += f;
    });
    const hNames = new Set(
      myHousings.map((h) =>
        String(h.housing_name || '')
          .toLowerCase()
          .trim(),
      ),
    );
    let totalEggs = 0;
    (allEggDailys || [])
      .filter((d) => d.date >= fromISO && d.date <= toISO)
      .forEach((d) => {
        [
          [d.group1_name, d.group1_count],
          [d.group2_name, d.group2_count],
          [d.group3_name, d.group3_count],
          [d.group4_name, d.group4_count],
        ].forEach(([n, ct]) => {
          if (n && hNames.has(String(n).toLowerCase().trim())) totalEggs += parseInt(ct) || 0;
        });
      });
    const dozens = totalEggs / 12;
    // If batch has no rates (e.g. Retirement Home before first feed cost save), fall back to global rates
    var costBatch = batch;
    if (
      !parseFloat(batch.per_lb_starter_cost) &&
      !parseFloat(batch.per_lb_grower_cost) &&
      !parseFloat(batch.per_lb_layer_cost)
    ) {
      costBatch = {
        ...batch,
        per_lb_starter_cost: feedCosts.starter || 0,
        per_lb_grower_cost: feedCosts.grower || 0,
        per_lb_layer_cost: feedCosts.layer || 0,
      };
    }
    const cost = computeLayerFeedCost(starterFeed, growerFeed, layerFeed, costBatch);
    const hens = myHousings
      .filter((h) => h.status === 'active')
      .reduce((s, h) => s + computeHousingDisplayCount(h, allLayerDailys), 0);
    // Eggs/hen/day uses span of window
    const days = Math.max(
      1,
      Math.round((new Date(toISO + 'T12:00:00') - new Date(fromISO + 'T12:00:00')) / 86400000) + 1,
    );
    const epd = hens > 0 && totalEggs > 0 ? totalEggs / (hens * days) : null;
    const costPerDoz = dozens > 0 && cost != null ? cost / dozens : null;
    return {
      totalFeed,
      starterFeed,
      growerFeed,
      layerFeed,
      totalMort,
      totalEggs,
      dozens,
      cost,
      hens,
      epd,
      costPerDoz,
      reportDays: reportDates.size,
      days,
    };
  }

  // Compute housing stats over a window
  function computeHousingWindow(housing, batch, fromISO, toISO) {
    const anchor = batch ? batch.brooder_entry_date || batch.arrival_date || null : null;
    const hName = String(housing.housing_name || '')
      .toLowerCase()
      .trim();
    const myReports = (allLayerDailys || []).filter((d) => {
      if (d.date < fromISO || d.date > toISO) return false;
      if (
        String(d.batch_label || '')
          .toLowerCase()
          .trim() !== hName
      )
        return false;
      // If batch_id is set on the report, it must match this housing's parent batch
      if (d.batch_id && batch && d.batch_id !== batch.id) return false;
      return true;
    });
    let totalFeed = 0,
      totalMort = 0,
      starterFeed = 0,
      growerFeed = 0,
      layerFeed = 0;
    const reportDates = new Set();
    myReports.forEach((d) => {
      const f = parseFloat(d.feed_lbs) || 0;
      totalFeed += f;
      totalMort += parseInt(d.mortality_count) || 0;
      reportDates.add(d.date);
      let phase = d.feed_type || 'LAYER';
      if (anchor) {
        try {
          const days = Math.floor((new Date(d.date + 'T12:00:00') - new Date(anchor + 'T12:00:00')) / 86400000);
          if (days < 21) phase = 'STARTER';
          else if (days < 140) phase = 'GROWER';
          else phase = 'LAYER';
        } catch (_e) {
          /* defensive parse — fall through to default phase */
        }
      }
      if (phase === 'STARTER') starterFeed += f;
      else if (phase === 'GROWER') growerFeed += f;
      else layerFeed += f;
    });
    let totalEggs = 0;
    (allEggDailys || [])
      .filter((d) => d.date >= fromISO && d.date <= toISO)
      .forEach((d) => {
        [
          [d.group1_name, d.group1_count],
          [d.group2_name, d.group2_count],
          [d.group3_name, d.group3_count],
          [d.group4_name, d.group4_count],
        ].forEach(([n, ct]) => {
          if (n && String(n).toLowerCase().trim() === hName) totalEggs += parseInt(ct) || 0;
        });
      });
    const dozens = totalEggs / 12;
    var costBatchH = batch;
    if (
      batch &&
      !parseFloat(batch.per_lb_starter_cost) &&
      !parseFloat(batch.per_lb_grower_cost) &&
      !parseFloat(batch.per_lb_layer_cost)
    ) {
      costBatchH = {
        ...batch,
        per_lb_starter_cost: feedCosts.starter || 0,
        per_lb_grower_cost: feedCosts.grower || 0,
        per_lb_layer_cost: feedCosts.layer || 0,
      };
    }
    const cost = costBatchH ? computeLayerFeedCost(starterFeed, growerFeed, layerFeed, costBatchH) : null;
    const hens = computeHousingDisplayCount(housing, allLayerDailys);
    const days = Math.max(
      1,
      Math.round((new Date(toISO + 'T12:00:00') - new Date(fromISO + 'T12:00:00')) / 86400000) + 1,
    );
    const epd = hens > 0 && totalEggs > 0 ? totalEggs / (hens * days) : null;
    const costPerDoz = dozens > 0 && cost != null ? cost / dozens : null;
    return {
      totalFeed,
      starterFeed,
      growerFeed,
      layerFeed,
      totalMort,
      totalEggs,
      dozens,
      cost,
      hens,
      epd,
      costPerDoz,
      reportDays: reportDates.size,
    };
  }

  // Period dates
  const today = todayISO();

  // Retirement Home period
  const retFrom = toISO(addDays(new Date(), -(retHomeDashPeriod - 1)));

  // Trend renderer — suppresses noise from near-zero baselines
  const trendArrow = (cur, prev, higherIsBetter) => {
    if (cur == null || prev == null || prev === 0) return null;
    // If the previous value is negligible relative to current, the % is meaningless
    if (Math.abs(prev) < 0.05) return null;
    const pct = ((cur - prev) / prev) * 100;
    if (Math.abs(pct) > 200) return null; // cap noise from tiny baselines
    const up = pct >= 0;
    const good = higherIsBetter ? up : !up;
    const color = Math.abs(pct) < 2 ? '#9ca3af' : good ? '#065f46' : '#b91c1c';
    const arrow = Math.abs(pct) < 2 ? '\u2192' : up ? '\u2191' : '\u2193';
    return (
      <span style={{fontSize: 10, color, fontWeight: 600, marginLeft: 4}}>
        {arrow} {Math.abs(pct).toFixed(0)}%
      </span>
    );
  };

  // Build batch list — exclude Retirement Home, only active
  const dashBatches = (layerBatches || []).filter((b) => b.status === 'active' && b.name !== 'Retirement Home');
  const retHome = (layerBatches || []).find((b) => b.name === 'Retirement Home');

  // Top stats
  const activeHousings = (layerHousings || []).filter((h) => h.status === 'active');
  const totalHens = activeHousings.reduce((s, h) => {
    return s + computeHousingDisplayCount(h, allLayerDailys);
  }, 0);
  const last7iso = toISO(addDays(new Date(), -7));
  const totalEggsLast7 = (allEggDailys || [])
    .filter((d) => d.date >= last7iso)
    .reduce(
      (s, d) =>
        s +
        (parseInt(d.group1_count) || 0) +
        (parseInt(d.group2_count) || 0) +
        (parseInt(d.group3_count) || 0) +
        (parseInt(d.group4_count) || 0),
      0,
    );
  const latestEggReport = (allEggDailys || [])[0];
  const dozensOnHand = latestEggReport?.dozens_on_hand || 0;

  const StatTile = ({label, val, sub, color = '#78350f'}) => (
    <div style={{background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px'}}>
      <div
        style={{
          fontSize: 11,
          color: 'var(--ink-muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.8,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{fontSize: 24, fontWeight: 700, color, lineHeight: 1}}>{val}</div>
      {sub && <div style={{fontSize: 11, color: 'var(--ink-faint)', marginTop: 3}}>{sub}</div>}
    </div>
  );

  // Render a metrics row
  const MetricsGrid = ({s, prev, hideHens, hidePhases, showDaysDenominator = false}) => {
    const hasFeed = s.totalFeed > 0;
    const items = [
      {l: 'Total feed', v: s.totalFeed > 0 ? Math.round(s.totalFeed).toLocaleString() + ' lbs' : '\u2014'},
      ...(hidePhases
        ? []
        : [
            {
              l: 'Starter',
              v: s.starterFeed > 0 ? Math.round(s.starterFeed).toLocaleString() + ' lbs' : '\u2014',
              color: '#1e40af',
            },
            {
              l: 'Grower',
              v: s.growerFeed > 0 ? Math.round(s.growerFeed).toLocaleString() + ' lbs' : '\u2014',
              color: '#065f46',
            },
          ]),
      {l: 'Layer', v: s.layerFeed > 0 ? Math.round(s.layerFeed).toLocaleString() + ' lbs' : '\u2014', color: '#78350f'},
      {l: 'Feed cost', v: hasFeed ? fmt$0(s.cost) : '\u2014', color: '#92400e'},
      {l: 'Dozens', v: s.dozens > 0 ? Math.floor(s.dozens).toLocaleString() : '\u2014', color: '#065f46'},
      {
        l: 'Eggs/hen/day',
        v: s.epd != null ? s.epd.toFixed(2) : '\u2014',
        good: s.epd >= 0.7,
        trend: prev ? trendArrow(s.epd, prev.epd, true) : null,
      },
      {l: '$/dozen', v: hasFeed ? fmt$(s.costPerDoz) : '\u2014', color: '#065f46'},
      {l: 'Mortality', v: s.totalMort || '0', warn: s.totalMort > 10},
      ...(hideHens ? [] : [{l: 'Hens', v: s.hens > 0 ? s.hens.toLocaleString() : '\u2014'}]),
      {
        l: 'Report days',
        v: showDaysDenominator && s.days ? s.reportDays + ' of ' + s.days : String(s.reportDays || 0),
      },
    ];
    return (
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(110px,1fr))', gap: 8, minWidth: 0}}>
        {items.map((it) => (
          <div
            key={it.l}
            style={{
              padding: '8px 10px',
              background: 'var(--surface-2)',
              border: '1px solid var(--divider)',
              borderRadius: 10,
              minWidth: 0,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                fontSize: 9,
                color: 'var(--ink-faint)',
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
                color: it.warn ? '#b91c1c' : it.good ? '#065f46' : it.color || 'var(--ink)',
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
    );
  };

  const PeriodToggle = ({val, setVal, opts}) => (
    <div
      style={{display: 'flex', borderRadius: 10, overflow: 'hidden', border: '1px solid #d1d5db', width: 'fit-content'}}
    >
      {opts.map(({v, l}) => (
        <button
          key={v}
          onClick={() => setVal(v)}
          style={{
            padding: '6px 14px',
            border: '1px solid ' + (val === v ? '#085041' : 'var(--border-strong)'),
            fontFamily: 'inherit',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            background: 'white',
            color: val === v ? '#085041' : 'var(--ink-muted)',
          }}
        >
          {l}
        </button>
      ))}
    </div>
  );

  return (
    <div style={{minHeight: '100vh', background: 'var(--bg-page)', overflow: 'hidden'}}>
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
          gap: '1.25rem',
          minWidth: 0,
        }}
      >
        <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10}}>
          <StatTile label="Active Flocks" val={activeHousings.length} />
          <StatTile label="Total Hens" val={totalHens.toLocaleString()} color="#a16207" />
          <StatTile label="Dozens Last 7 Days" val={Math.floor(totalEggsLast7 / 12).toLocaleString()} color="#78350f" />
          <StatTile
            label="Dozens on Hand"
            val={dozensOnHand || '\u2014'}
            color="#065f46"
            sub={latestEggReport ? 'as of ' + fmt(latestEggReport.date) : ''}
          />
        </div>

        {/* Lifetime stats for active batches */}
        <div style={{display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap'}}>
          <div style={{fontSize: 13, fontWeight: 600, color: 'var(--ink-muted)', letterSpacing: 0.3}}>
            ACTIVE BATCHES {'\u2014'} LIFETIME
          </div>
        </div>

        {/* Active batch cards */}
        <div style={{display: 'flex', flexDirection: 'column', gap: 14}}>
          {dashBatches.map(function (batch, bi) {
            const myHousings = (layerHousings || []).filter((h) => h.batch_id === batch.id);
            const lifetimeFrom = lifetimeFromForBatch(batch);
            const cur = computeBatchWindow(batch, lifetimeFrom, today);
            const anchor = batch.brooder_entry_date || batch.arrival_date;
            const ageMonths = anchor
              ? +((new Date(today + 'T12:00:00') - new Date(anchor + 'T12:00:00')) / 86400000 / 30.44).toFixed(1)
              : 0;
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
                {...openableProps(() => setView('layerbatches'))}
                style={{
                  background: 'white',
                  border: '1px solid var(--border)',
                  borderRadius: 14,
                  overflow: 'hidden',
                  cursor: 'pointer',
                }}
                className="hoverable-tile"
              >
                <div
                  style={{
                    background: 'white',
                    borderBottom: '1px solid ' + bc.bd,
                    borderLeft: '3px solid ' + bc.tx,
                    padding: '12px 20px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <span style={{fontSize: 16, fontWeight: 700, color: bc.tx}}>{batch.name}</span>
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
                    Active
                  </span>
                  {ageMonths > 0 && (
                    <span style={{fontSize: 11, color: bc.tx, opacity: 0.85}}>{ageMonths} months old</span>
                  )}
                </div>
                <div style={{padding: '14px 20px'}}>
                  <MetricsGrid s={cur} hidePhases={myHousings.length > 0} />
                  {myHousings.length > 1 && (
                    <div style={{marginTop: 14, paddingTop: 12, borderTop: '1px dashed var(--border)'}}>
                      <div
                        style={{
                          fontSize: 10,
                          color: 'var(--ink-faint)',
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                          marginBottom: 8,
                          fontWeight: 600,
                        }}
                      >
                        HOUSINGS
                      </div>
                      <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
                        {(function () {
                          var batchColors = [
                            {bg: '#ecfdf5', bd: '#a7f3d0', tx: '#065f46'},
                            {bg: '#eff6ff', bd: '#bfdbfe', tx: '#1e40af'},
                            {bg: '#fffbeb', bd: '#fde68a', tx: '#92400e'},
                            {bg: '#f5f3ff', bd: '#ddd6fe', tx: '#5b21b6'},
                          ];
                          var bc = batchColors[bi % batchColors.length];
                          return myHousings.map((h) => {
                            const hCur = computeHousingWindow(h, batch, lifetimeFrom, today);
                            return (
                              <div
                                key={h.id}
                                style={{
                                  padding: '10px 12px',
                                  background: 'white',
                                  border: '1px solid ' + bc.bd,
                                  borderLeft: '3px solid ' + bc.tx,
                                  borderRadius: 10,
                                }}
                              >
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    marginBottom: 8,
                                    flexWrap: 'wrap',
                                  }}
                                >
                                  <span style={{fontSize: 13, fontWeight: 700, color: bc.tx}}>
                                    {'\ud83c\udfe0 ' + h.housing_name}
                                  </span>
                                  <span
                                    style={{
                                      fontSize: 10,
                                      fontWeight: 700,
                                      padding: '1px 7px',
                                      borderRadius: 10,
                                      background: h.status === 'active' ? '#d1fae5' : '#f3f4f6',
                                      color: h.status === 'active' ? '#065f46' : '#6b7280',
                                      textTransform: 'uppercase',
                                    }}
                                  >
                                    {h.status}
                                  </span>
                                  {hCur.hens > 0 && (
                                    <span style={{fontSize: 11, color: bc.tx, fontWeight: 600}}>
                                      {hCur.hens.toLocaleString()} hens
                                    </span>
                                  )}
                                </div>
                                <MetricsGrid s={hCur} hideHens={true} hidePhases={true} />
                              </div>
                            );
                          });
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Retirement Home card */}
        {retHome &&
          (() => {
            const cur = computeBatchWindow(retHome, retFrom, today);
            const myHousings = (layerHousings || []).filter((h) => h.batch_id === retHome.id);
            return (
              <div style={{marginTop: 6}}>
                <div style={{display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap'}}>
                  <div style={{fontSize: 13, fontWeight: 600, color: 'var(--ink-muted)', letterSpacing: 0.3}}>
                    {'\ud83c\udfe1 RETIREMENT HOME \u2014 ROLLING WINDOW'}
                  </div>
                  <PeriodToggle
                    val={retHomeDashPeriod}
                    setVal={setRetHomeDashPeriod}
                    opts={[
                      {v: 30, l: '30 Days'},
                      {v: 90, l: '90 Days'},
                      {v: 180, l: '6 Months'},
                    ]}
                  />
                </div>
                <div
                  {...openableProps(() => setView('layerbatches'))}
                  style={{
                    background: 'white',
                    border: '2px solid #e5d4b1',
                    borderRadius: 14,
                    padding: '18px 20px',
                    cursor: 'pointer',
                  }}
                  className="hoverable-tile"
                >
                  <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap'}}>
                    <span style={{fontSize: 16, fontWeight: 700, color: '#92400e'}}>Retirement Home</span>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: 10,
                        background: '#fef3c7',
                        color: '#92400e',
                        textTransform: 'uppercase',
                      }}
                    >
                      Permanent
                    </span>
                    <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>
                      {myHousings.length} housing{myHousings.length === 1 ? '' : 's'} {'\u00b7'}{' '}
                      {cur.hens.toLocaleString()} hens
                    </span>
                  </div>
                  <MetricsGrid s={cur} hidePhases={true} showDaysDenominator={true} />
                </div>
              </div>
            );
          })()}
      </div>
    </div>
  );
}
