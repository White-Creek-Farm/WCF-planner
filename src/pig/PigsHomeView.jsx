// ============================================================================
// src/pig/PigsHomeView.jsx  —  Phase 2 Round 6
// ----------------------------------------------------------------------------
// Pigs home dashboard. Same hook-based pattern as BroilerHomeView — reads
// all its state through useAuth / useBatches / usePig / useDailysRecent /
// useUI, with Header + loadUsers still coming in as props (App-scope).
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {openableProps} from '../shared/openable.js';
import {fmt, fmtS, todayISO, addDays} from '../lib/dateUtils.js';
import {S} from '../lib/styles.js';
import {
  calcBreedingTimeline,
  calcCycleStatus,
  buildCycleSeqMap,
  PIG_GROUP_COLORS,
  PIG_GROUP_TEXT,
  PIG_GROUPS,
} from '../lib/pig.js';
import UsersModal from '../auth/UsersModal.jsx';
import PlannerIcon from '../components/PlannerIcon.jsx';
import {ANIMAL_ICON_KEYS} from '../lib/plannerIcons.js';
import {useAuth} from '../contexts/AuthContext.jsx';
import {useBatches} from '../contexts/BatchesContext.jsx';
import {usePig} from '../contexts/PigContext.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';

export default function PigsHomeView({Header, loadUsers}) {
  const {authState, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const {batches} = useBatches();
  const {breeders, feederGroups, farrowingRecs, breedingCycles} = usePig();
  const {pigDailys} = useDailysRecent();
  const {setView} = useUI();
  const avg = (arr, fn) => {
    const v = arr.map(fn).filter((x) => x != null && !isNaN(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const fmtN = (n, d = 1) => (n != null ? n.toFixed(d) : '—');
  const activeFeeders = feederGroups.filter((g) => g.status === 'active');
  const activeCycles2 = breedingCycles.filter((c) => calcCycleStatus(c) === 'active');
  const todayStr = todayISO();

  // Sow performance across all farrowing records
  const totalBorn = farrowingRecs.reduce((s, r) => s + (parseInt(r.totalBorn) || 0), 0);
  const totalDeaths = farrowingRecs.reduce((s, r) => s + (parseInt(r.deaths) || 0), 0);
  const survivalRate = totalBorn > 0 ? Math.round(((totalBorn - totalDeaths) / totalBorn) * 100) : null;
  const avgLitterBorn = farrowingRecs.length > 0 ? avg(farrowingRecs, (r) => parseInt(r.totalBorn) || null) : null;
  const avgLitterAlive =
    farrowingRecs.length > 0
      ? avg(farrowingRecs, (r) => {
          const b = parseInt(r.totalBorn) || 0;
          const d = parseInt(r.deaths) || 0;
          return b > 0 ? b - d : null;
        })
      : null;
  const totalFarrowed = farrowingRecs.length;
  // Active sows/boars from breeder registry
  const activeSows = breeders.filter((b) => !b.archived && (b.sex === 'Sow' || b.sex === 'Gilt')).length;
  const activeBoars = breeders.filter((b) => !b.archived && b.sex === 'Boar').length;
  // Total pigs on farm — only active batches + breeding stock
  const activeFeederNames = activeFeeders.flatMap((g) => {
    const subs = (g.subBatches || []).filter((s) => s.status === 'active');
    return subs.length > 0
      ? subs.map((s) => (s.name || '').toLowerCase().trim())
      : [(g.batchName || '').toLowerCase().trim()];
  });
  const pigCountsByGroup = (() => {
    const counts = {};
    [...pigDailys]
      .sort((a, b) => a.date.localeCompare(b.date))
      .forEach((d) => {
        if (d.pig_count > 0 && d.batch_label) {
          const lbl = d.batch_label.toLowerCase().trim();
          if (activeFeederNames.includes(lbl) || lbl === 'sows' || lbl === 'boars')
            counts[d.batch_label] = parseInt(d.pig_count);
        }
      });
    return counts;
  })();
  const pigsOnFarm = Object.values(pigCountsByGroup).reduce((s, v) => s + v, 0);
  const pigBreakdown = Object.entries(pigCountsByGroup)
    .sort((a, b) => b[1] - a[1])
    .map((e) => e[0] + ': ' + e[1])
    .join(' \u00b7 ');
  // Pigs processed + avg yield from trips
  const allTrips = feederGroups.flatMap((g) => (g.processingTrips || []).map((t) => ({...t, batch: g.batchName})));
  const currentYear = new Date().getFullYear().toString();
  const yearTrips = allTrips.filter((t) => (t.date || '').startsWith(currentYear));
  const totalProcessed = yearTrips.reduce((s, t) => s + (parseInt(t.pigCount) || 0), 0);
  const avgYield = (() => {
    const yields = allTrips
      .map((t) => {
        const live = (t.liveWeights || '')
          .split(/[\s,]+/)
          .map((v) => parseFloat(v))
          .filter((v) => !isNaN(v) && v > 0)
          .reduce((a, b) => a + b, 0);
        const hang = parseFloat(t.hangingWeight) || 0;
        return live > 0 && hang > 0 ? Math.round((hang / live) * 1000) / 10 : null;
      })
      .filter(Boolean);
    return yields.length > 0 ? Math.round((yields.reduce((a, b) => a + b, 0) / yields.length) * 10) / 10 : null;
  })();
  // Next farrowing window
  const nextFarrowing = (() => {
    const today2 = todayISO();
    const upcoming = breedingCycles
      .map((c) => {
        const tl = calcBreedingTimeline(c.exposureStart);
        if (!tl) return null;
        if (tl.farrowingEnd < today2) return null;
        return {group: c.group, start: tl.farrowingStart, end: tl.farrowingEnd};
      })
      .filter(Boolean)
      .sort((a, b) => a.start.localeCompare(b.start));
    return upcoming.length > 0 ? upcoming[0] : null;
  })();

  // Recent 5 cycles survival
  const _pigsHomeSeqMap = buildCycleSeqMap(breedingCycles);
  const recentCycleSurvival = breedingCycles
    .slice(-5)
    .map((c) => {
      const tl = calcBreedingTimeline(c.exposureStart);
      if (!tl) return null;
      const recs = farrowingRecs.filter((r) => {
        if (r.group !== c.group || !r.farrowingDate) return false;
        const rd = new Date(r.farrowingDate + 'T12:00:00');
        return (
          rd >= new Date(tl.farrowingStart + 'T12:00:00') && rd <= addDays(new Date(tl.farrowingEnd + 'T12:00:00'), 14)
        );
      });
      if (!recs.length) return null;
      const born = recs.reduce((s, r) => s + (parseInt(r.totalBorn) || 0), 0);
      const dead = recs.reduce((s, r) => s + (parseInt(r.deaths) || 0), 0);
      const _suf = _pigsHomeSeqMap[c.id];
      return {
        label: `G${c.group}${_suf ? ' · ' + _suf : ''} ${fmtS(c.exposureStart)}`,
        survival: born > 0 ? Math.round(((born - dead) / born) * 100) : 0,
        born,
        dead,
      };
    })
    .filter(Boolean);

  // Feeder batch performance
  const feederBatchStats = activeFeeders.map((g) => {
    const batchDailys = pigDailys.filter((d) => {
      const activeSubs = (g.subBatches || []).filter((s) => s.status === 'active');
      if (activeSubs.length > 0)
        return activeSubs.some(
          (s) => (d.batch_label || '').toLowerCase().trim() === (s.name || '').toLowerCase().trim(),
        );
      return (d.batch_label || '').toLowerCase().trim() === (g.batchName || '').toLowerCase().trim();
    });
    // Raw feed minus what's been allocated out to breeding-transferred pigs
    // (see PigBatchesView transfer flow).
    const rawFeed = batchDailys.reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);
    const totalFeed = Math.max(0, rawFeed - (parseFloat(g.feedAllocatedToTransfers) || 0));
    const originalCount = parseInt(g.originalPigCount) || 0;
    const reportDays = new Set(batchDailys.map((d) => d.date)).size;
    const cycle = breedingCycles.find((c) => c.id === g.cycleId);
    const tl = cycle ? calcBreedingTimeline(cycle.exposureStart) : null;
    // Use the OLDEST actual farrow date (to match the batch tile's age
    // range upper bound). Falls back to the theoretical farrowingStart
    // when no actual farrowing records exist for this cycle yet.
    let ageFromDate = null;
    if (cycle && tl) {
      const recs = farrowingRecs.filter((r) => {
        if (r.group !== cycle.group || !r.farrowingDate) return false;
        const rd = new Date(r.farrowingDate + 'T12:00:00');
        return (
          rd >= new Date(tl.farrowingStart + 'T12:00:00') && rd <= addDays(new Date(tl.farrowingEnd + 'T12:00:00'), 14)
        );
      });
      ageFromDate = recs.length > 0 ? recs.map((r) => r.farrowingDate).sort()[0] : tl.farrowingStart;
    }
    const daysOld = ageFromDate ? Math.round((new Date() - new Date(ageFromDate + 'T12:00:00')) / 86400000) : null;
    const perLbCost = parseFloat(g.perLbFeedCost) || 0;
    const totalFeedCost = totalFeed > 0 && perLbCost > 0 ? totalFeed * perLbCost : null;
    const costPerPig = totalFeedCost != null && originalCount > 0 ? totalFeedCost / originalCount : null;
    return {
      g,
      totalFeed,
      originalCount,
      reportDays,
      daysOld,
      feedPerPig: originalCount > 0 && totalFeed > 0 ? (totalFeed / originalCount).toFixed(0) : null,
      totalFeedCost,
      costPerPig,
    };
  });

  // Carcass yield trend from processing trips
  const yieldTrend = feederGroups
    .flatMap((g) =>
      (g.processingTrips || []).map((t) => {
        const live = (t.liveWeights || '')
          .split(/[\s,]+/)
          .map((v) => parseFloat(v))
          .filter((v) => !isNaN(v) && v > 0)
          .reduce((a, b) => a + b, 0);
        const hang = parseFloat(t.hangingWeight) || 0;
        return live > 0 && hang > 0
          ? {date: t.date, yield: Math.round((hang / live) * 1000) / 10, batch: g.batchName}
          : null;
      }),
    )
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-10);

  const recentPigDailys = [...pigDailys].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);

  const StatTile = ({label, val, sub, color = '#1e40af'}) => (
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
  const NavBtn = ({label, v}) => (
    <button
      onClick={() => setView(v)}
      style={{
        padding: '8px 16px',
        borderRadius: 10,
        border: '1px solid var(--border-strong)',
        background: 'white',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--ink)',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {label}
    </button>
  );
  const trendBar = (val, max, color) => (
    <div style={{display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4}}>
      <div
        style={{
          flex: 1,
          height: 7,
          background: '#f0f0f0',
          borderRadius: 4 /* radius-allow: trend bar track (height 7) */,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${Math.min(100, max > 0 ? (val / max) * 100 : 0)}%`,
            background: color,
            borderRadius: 4 /* radius-allow: trend bar fill (height 7) */,
          }}
        />
      </div>
      <span style={{fontSize: 10, color: 'var(--ink)', fontWeight: 600, minWidth: 36, textAlign: 'right'}}>
        {Math.round(val * 10) / 10}
      </span>
    </div>
  );

  return (
    <div style={{minHeight: '100vh', background: 'var(--bg-page)'}}>
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
        <div data-mobile-2col="1" style={{display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10}}>
          <StatTile
            label="Pigs on Farm"
            val={pigsOnFarm > 0 ? pigsOnFarm.toLocaleString() : '\u2014'}
            color="#1e40af"
          />
          <StatTile
            label="Active Sows"
            val={activeSows}
            sub={activeBoars + ' boar' + (activeBoars !== 1 ? 's' : '')}
            color="#1e40af"
          />
          <StatTile label="Active Cycles" val={activeCycles2.length} />
          <StatTile label="Active Batches" val={activeFeeders.length} color="#92400e" />
          <StatTile
            label="Avg Born / Litter"
            val={avgLitterBorn != null ? fmtN(avgLitterBorn, 1) : '\u2014'}
            color="#1e40af"
          />
          <StatTile
            label="Avg Alive / Litter"
            val={avgLitterAlive != null ? fmtN(avgLitterAlive, 1) : '\u2014'}
            color="#065f46"
          />
          <StatTile
            label="Overall Survival"
            val={survivalRate != null ? survivalRate + '%' : '\u2014'}
            color={
              survivalRate != null
                ? survivalRate >= 80
                  ? '#065f46'
                  : survivalRate >= 65
                    ? '#92400e'
                    : '#b91c1c'
                : 'var(--ink)'
            }
            sub={totalFarrowed + ' records'}
          />
          <StatTile
            label={'Processed ' + currentYear}
            val={totalProcessed > 0 ? totalProcessed.toLocaleString() : '\u2014'}
            color="var(--ink)"
            sub={avgYield != null ? 'Avg yield: ' + avgYield + '%' : null}
          />
        </div>
        {pigsOnFarm > 0 && (
          <div>
            <div
              style={{fontSize: 13, fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 8, letterSpacing: 0.3}}
            >
              PIGS ON FARM BREAKDOWN
            </div>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(130px,1fr))', gap: 8}}>
              {Object.entries(pigCountsByGroup)
                .sort((a, b) => {
                  const al = a[0].toLowerCase(),
                    bl = b[0].toLowerCase();
                  if (al === 'sows') return -1;
                  if (bl === 'sows') return 1;
                  if (al === 'boars') return -1;
                  if (bl === 'boars') return 1;
                  return al.localeCompare(bl);
                })
                .map(([name, count]) => (
                  <div
                    key={name}
                    style={{
                      background: 'white',
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                      padding: '10px 14px',
                      textAlign: 'center',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10,
                        color: 'var(--ink-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: 0.4,
                        marginBottom: 3,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {name}
                    </div>
                    <div style={{fontSize: 20, fontWeight: 700, color: '#1e40af'}}>{count}</div>
                  </div>
                ))}
            </div>
          </div>
        )}
        {/* Breeding group status — current phase + next milestone for each group */}
        {(function () {
          var today3 = todayISO();
          var groupStatuses = PIG_GROUPS.map(function (g) {
            // Find the most recent active or upcoming cycle for this group
            var cycles = breedingCycles
              .filter(function (c) {
                return c.group === g;
              })
              .map(function (c) {
                var tl = calcBreedingTimeline(c.exposureStart);
                if (!tl) return null;
                return {c: c, tl: tl};
              })
              .filter(Boolean)
              .sort(function (a, b) {
                return a.c.exposureStart.localeCompare(b.c.exposureStart);
              });
            // Find the cycle that's currently active or the next upcoming one
            var current = null;
            for (var ci = cycles.length - 1; ci >= 0; ci--) {
              var ct = cycles[ci];
              if (ct.tl.boarStart <= today3 && ct.tl.growEnd >= today3) {
                current = ct;
                break;
              }
            }
            if (!current) {
              // No active cycle — find the next upcoming one
              for (var ci2 = 0; ci2 < cycles.length; ci2++) {
                if (cycles[ci2].tl.boarStart > today3) {
                  current = cycles[ci2];
                  break;
                }
              }
            }
            if (!current && cycles.length > 0) current = cycles[cycles.length - 1]; // fallback to most recent
            if (!current) return {group: g, phase: 'No cycles', next: null, color: PIG_GROUP_COLORS[g]};

            var tl = current.tl;
            var phase = '',
              nextStep = '',
              nextDate = '',
              isActive = false;
            if (today3 < tl.boarStart) {
              phase = 'Planned';
              nextStep = 'Boar Exposure starts';
              nextDate = tl.boarStart;
            } else if (today3 <= tl.boarEnd) {
              phase = 'Boar Exposure';
              nextStep = 'Exposure Paddock';
              nextDate = tl.paddockStart;
              isActive = true;
            } else if (today3 <= tl.paddockEnd) {
              phase = 'Exp. Paddock';
              nextStep = 'Farrowing window opens';
              nextDate = tl.farrowingStart;
              isActive = true;
            } else if (today3 <= tl.farrowingEnd) {
              phase = 'Farrowing';
              nextStep = 'Weaning starts';
              nextDate = tl.weaningStart;
              isActive = true;
            } else if (today3 <= tl.weaningEnd) {
              phase = 'Weaning';
              nextStep = 'Grow-out starts';
              nextDate = tl.growStart;
              isActive = true;
            } else if (today3 <= tl.growEnd) {
              phase = 'Grow-out';
              nextStep = 'Cycle complete';
              nextDate = tl.growEnd;
              isActive = true;
            } else {
              phase = 'Completed';
              nextStep = 'Start next cycle';
              nextDate = null;
            }
            var daysToNext = nextDate
              ? Math.max(0, Math.round((new Date(nextDate + 'T12:00:00') - new Date(today3 + 'T12:00:00')) / 86400000))
              : null;
            return {
              group: g,
              phase: phase,
              nextStep: nextStep,
              nextDate: nextDate,
              daysToNext: daysToNext,
              isActive: isActive,
              color: PIG_GROUP_COLORS[g],
              tl: tl,
              cycle: current.c,
            };
          });
          if (
            groupStatuses.every(function (gs) {
              return gs.phase === 'No cycles';
            })
          )
            return null;
          return React.createElement(
            'div',
            null,
            React.createElement(
              'div',
              {style: {fontSize: 13, fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 8, letterSpacing: 0.3}},
              'BREEDING GROUP STATUS',
            ),
            React.createElement(
              'div',
              {style: {display: 'grid', gridTemplateColumns: 'repeat(' + PIG_GROUPS.length + ',1fr)', gap: 10}},
              groupStatuses.map(function (gs) {
                var bgColor = gs.color ? gs.color.boar : '#f3f4f6';
                var textColor = PIG_GROUP_TEXT[gs.group] || '#111827';
                return React.createElement(
                  'div',
                  {
                    key: gs.group,
                    style: {
                      background: 'white',
                      border: '1px solid var(--border)',
                      borderRadius: 12,
                      overflow: 'hidden',
                    },
                  },
                  React.createElement(
                    'div',
                    {
                      style: {
                        background: 'white',
                        borderLeft: '3px solid ' + bgColor,
                        padding: '8px 14px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      },
                    },
                    React.createElement(PlannerIcon, {iconKey: ANIMAL_ICON_KEYS.pig, size: 16}),
                    React.createElement(
                      'span',
                      {style: {fontSize: 13, fontWeight: 700, color: bgColor}},
                      'Group ' + gs.group,
                    ),
                  ),
                  React.createElement(
                    'div',
                    {style: {padding: '10px 14px'}},
                    React.createElement(
                      'div',
                      {style: {display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6}},
                      React.createElement(
                        'span',
                        {
                          style: {
                            fontSize: 11,
                            fontWeight: 700,
                            color: gs.isActive ? '#065f46' : '#6b7280',
                            background: gs.isActive ? '#d1fae5' : '#f3f4f6',
                            padding: '2px 8px',
                            borderRadius: 10,
                          },
                        },
                        gs.phase,
                      ),
                    ),
                    gs.nextStep &&
                      React.createElement(
                        'div',
                        {style: {fontSize: 12, color: 'var(--ink)', marginBottom: 2}},
                        React.createElement('span', {style: {color: 'var(--ink-faint)'}}, 'Next: '),
                        React.createElement('span', {style: {fontWeight: 600}}, gs.nextStep),
                      ),
                    gs.nextDate &&
                      React.createElement(
                        'div',
                        {style: {fontSize: 11, color: 'var(--ink-muted)'}},
                        fmt(gs.nextDate),
                        gs.daysToNext != null &&
                          gs.daysToNext > 0 &&
                          React.createElement(
                            'span',
                            {
                              style: {
                                marginLeft: 6,
                                fontWeight: 600,
                                color: gs.daysToNext <= 7 ? '#b91c1c' : '#6b7280',
                              },
                            },
                            '(' + gs.daysToNext + ' days)',
                          ),
                      ),
                  ),
                );
              }),
            ),
          );
        })()}

        {/* Active feeder batches */}
        {feederBatchStats.length > 0 && (
          <div>
            <div
              style={{fontSize: 13, fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 8, letterSpacing: 0.3}}
            >
              ACTIVE FEEDER BATCHES
            </div>
            <div style={{display: 'flex', flexDirection: 'column', gap: 14}}>
              {feederBatchStats.map(
                ({g, totalFeed, originalCount, reportDays, daysOld, feedPerPig, totalFeedCost, costPerPig}, fbi) => {
                  const fbColors = [
                    {bg: '#ecfdf5', bd: '#6ee7b7', tx: '#065f46'},
                    {bg: '#fef3c7', bd: '#fcd34d', tx: '#92400e'},
                    {bg: '#dbeafe', bd: '#93c5fd', tx: '#1e40af'},
                    {bg: '#fce7f3', bd: '#f9a8d4', tx: '#9d174d'},
                  ];
                  const fbc = fbColors[fbi % fbColors.length];
                  const activeSubs = (g.subBatches || []).filter((s) => s.status === 'active');
                  const subNames =
                    activeSubs.length > 0
                      ? activeSubs.map((s) => (s.name || '').toLowerCase().trim())
                      : [g.batchName.toLowerCase().trim()];
                  const latestCounts = {};
                  [...pigDailys]
                    .sort((a, b) => a.date.localeCompare(b.date))
                    .forEach((d) => {
                      if (d.pig_count > 0 && d.batch_label && subNames.includes(d.batch_label.toLowerCase().trim()))
                        latestCounts[d.batch_label] = parseInt(d.pig_count);
                    });
                  const currentCount = Object.values(latestCounts).reduce((s, v) => s + v, 0);
                  return (
                    <div
                      key={g.id}
                      {...openableProps(() => setView('pigbatches'))}
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
                          borderLeft: '3px solid ' + fbc.tx,
                          borderBottom: '1px solid var(--border)',
                          padding: '10px 18px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{fontSize: 15, fontWeight: 700, color: fbc.tx}}>{g.batchName}</span>
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
                        {daysOld != null && (
                          <span style={{fontSize: 11, color: fbc.tx, opacity: 0.85}}>
                            {Math.floor(daysOld / 30) + 'm ' + Math.floor((daysOld % 30) / 7) + 'w old'}
                          </span>
                        )}
                      </div>
                      <div style={{padding: '12px 18px'}}>
                        <div
                          style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(110px,1fr))', gap: 8}}
                        >
                          {[
                            {l: 'Current', v: currentCount > 0 ? currentCount.toString() : '\u2014', c: '#1e40af'},
                            {l: 'Original', v: originalCount > 0 ? originalCount.toString() : '\u2014'},
                            {
                              l: 'Total Feed',
                              v: totalFeed > 0 ? Math.round(totalFeed).toLocaleString() + ' lbs' : '\u2014',
                              c: '#92400e',
                            },
                            {l: 'Feed / Pig', v: feedPerPig ? feedPerPig + ' lbs' : '\u2014'},
                            {
                              l: 'Feed Cost',
                              v:
                                totalFeedCost != null
                                  ? '$' +
                                    totalFeedCost.toLocaleString(undefined, {
                                      minimumFractionDigits: 0,
                                      maximumFractionDigits: 0,
                                    })
                                  : '\u2014',
                              c: '#92400e',
                            },
                            {
                              l: 'Cost / Pig',
                              v:
                                costPerPig != null
                                  ? '$' +
                                    costPerPig.toLocaleString(undefined, {
                                      minimumFractionDigits: 2,
                                      maximumFractionDigits: 2,
                                    })
                                  : '\u2014',
                              c: '#065f46',
                            },
                            {l: 'Report Days', v: reportDays.toString()},
                          ].map((t) => (
                            <div
                              key={t.l}
                              style={{
                                padding: '8px 10px',
                                background: 'var(--surface-2)',
                                border: '1px solid var(--divider)',
                                borderRadius: 10,
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
                                {t.l}
                              </div>
                              <div style={{fontSize: 14, fontWeight: 700, color: t.c || 'var(--ink)'}}>{t.v}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                },
              )}
            </div>
          </div>
        )}

        {/* Farrowing survival + Carcass yield side by side */}
        {(recentCycleSurvival.length >= 2 || yieldTrend.length >= 2) && (
          <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14}}>
            {recentCycleSurvival.length >= 2 && (
              <div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--ink-muted)',
                    marginBottom: 8,
                    letterSpacing: 0.3,
                  }}
                >
                  FARROWING SURVIVAL
                </div>
                <div
                  style={{
                    background: 'white',
                    border: '1px solid var(--border)',
                    borderRadius: 12,
                    padding: '14px 16px',
                  }}
                >
                  {recentCycleSurvival.map((c, i) => (
                    <div key={i}>
                      <div style={{fontSize: 10, color: 'var(--ink-muted)', marginBottom: 1}}>
                        {c.label} {'\u2014'} {c.born} born, {c.dead} died
                      </div>
                      {trendBar(
                        c.survival,
                        100,
                        c.survival >= 80 ? '#065f46' : c.survival >= 65 ? '#d97706' : '#b91c1c',
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {yieldTrend.length >= 2 && (
              <div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--ink-muted)',
                    marginBottom: 8,
                    letterSpacing: 0.3,
                  }}
                >
                  CARCASS YIELD TREND
                </div>
                <div
                  style={{
                    background: 'white',
                    border: '1px solid var(--border)',
                    borderRadius: 12,
                    padding: '14px 16px',
                  }}
                >
                  {yieldTrend.map((t, i) => (
                    <div key={i}>
                      <div style={{fontSize: 10, color: 'var(--ink-muted)', marginBottom: 1}}>
                        {t.batch} {'\u00b7'} {fmt(t.date)}
                      </div>
                      {trendBar(t.yield, 100, '#1e40af')}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
