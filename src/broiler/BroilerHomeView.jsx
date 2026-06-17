// ============================================================================
// src/broiler/BroilerHomeView.jsx  —  Phase 2 Round 6 (first extraction)
// ----------------------------------------------------------------------------
// First of the inline-JSX views lifted out of App's render body. Consumes
// context state directly via hooks; Header + loadUsers still come in as props
// because Header's own extraction is deferred (§18.6) and loadUsers remains
// an App method.
// ============================================================================
import React from 'react';
import {useNavigate} from 'react-router-dom';
import {openableProps} from '../shared/openable.js';
import {sb} from '../lib/supabase.js';
import {fmt, fmtS, todayISO} from '../lib/dateUtils.js';
import {S} from '../lib/styles.js';
import {
  calcTimeline,
  calcBatchFeed,
  calcBroilerStatsFromDailys,
  computeBroilerOnFarmCounts,
  BREED_STYLE,
} from '../lib/broiler.js';
import UsersModal from '../auth/UsersModal.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {useBatches} from '../contexts/BatchesContext.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';

export default function BroilerHomeView({Header, loadUsers}) {
  const navigate = useNavigate();
  const {authState, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const {batches} = useBatches();
  const {broilerDailys} = useDailysRecent();
  const {setView} = useUI();
  const todayStr = todayISO();

  // Active batch tiles open the broiler batch record page. Mirrors the
  // canonical navigation used by BroilerListView/BroilerTimelineView:
  // /broiler/batches/<encodeURIComponent(name)>.
  function openBroilerBatch(b) {
    if (b && b.name) navigate('/broiler/batches/' + encodeURIComponent(b.name));
  }
  const broilerOnFarmCounts = computeBroilerOnFarmCounts(batches, broilerDailys);
  const activeBr = broilerOnFarmCounts.activeBatches;
  // Ignore batches before 2025 for all dashboard metrics
  const procBr = batches.filter((b) => b.status === 'processed' && (b.hatchDate || '') >= '2025');
  const currentYear = String(new Date().getFullYear());
  const procBrThisYear = procBr.filter((b) => (b.processingDate || '').startsWith(currentYear));
  const ccBr = procBr.filter((b) => b.breed === 'CC');
  const wrBr = procBr.filter((b) => b.breed === 'WR');
  const avg = (arr, fn) => {
    const v = arr.map(fn).filter((x) => x != null && !isNaN(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const fmtN = (n, d = 1) => (n != null ? n.toFixed(d) : '—');

  // Get true feed/mort: daily reports for B-25+, manual fields for B-24
  const batchFeed = (b) => {
    if (/^b-24-/i.test(b.name)) return (b.brooderFeedLbs || 0) + (b.schoonerFeedLbs || 0);
    return broilerDailys
      .filter(
        (d) =>
          (d.batch_label || '')
            .toLowerCase()
            .trim()
            .replace(/^\(processed\)\s*/, '') === b.name.toLowerCase().trim(),
      )
      .reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);
  };
  const batchMort = (b) => {
    if (/^b-24-/i.test(b.name)) return b.mortalityCumulative || 0;
    return broilerDailys
      .filter(
        (d) =>
          (d.batch_label || '')
            .toLowerCase()
            .trim()
            .replace(/^\(processed\)\s*/, '') === b.name.toLowerCase().trim(),
      )
      .reduce((s, d) => s + (parseInt(d.mortality_count) || 0), 0);
  };

  const breedStats = (arr) => {
    if (arr.length < 2) return null;
    return {
      count: arr.length,
      mort: avg(arr, (b) => (b.birdCount > 0 ? (batchMort(b) / b.birdCount) * 100 : null)),
      feedPerBird: avg(
        arr.filter((b) => b.totalToProcessor > 0 && batchFeed(b) > 0),
        (b) => batchFeed(b) / (b.totalToProcessor || 1),
      ),
      dressed: avg(
        arr.filter((b) => parseFloat(b.avgDressedLbs) > 0),
        (b) => parseFloat(b.avgDressedLbs),
      ),
      costPerBird: avg(
        arr.filter((b) => b.totalToProcessor > 0 && (b.perLbStarterCost || 0) > 0 && batchFeed(b) > 0),
        (b) => {
          const isB24 = /^b-24-/i.test(b.name);
          const f = isB24
            ? (b.brooderFeedLbs || 0) * (b.perLbStarterCost || 0) +
              (b.schoonerFeedLbs || 0) * (b.perLbStandardCost || 0) +
              (b.gritLbs || 0) * (b.perLbGritCost || 0) +
              (b.processingCost || 0)
            : batchFeed(b) * (b.perLbStandardCost || 0) + (b.processingCost || 0);
          return b.totalToProcessor > 0 ? f / b.totalToProcessor : null;
        },
      ),
      daysOnFarm: avg(
        arr.filter((b) => b.hatchDate && b.processingDate),
        (b) => Math.round((new Date(b.processingDate + 'T12:00:00') - new Date(b.hatchDate + 'T12:00:00')) / 86400000),
      ),
    };
  };
  const ccStats = breedStats(ccBr);
  const wrStats = breedStats(wrBr);

  // Active batch cards
  const activeBatchDetails = activeBr.map((b) => {
    const live = calcTimeline(b.hatchDate, b.breed, b.processingDate);
    const inBrooder = live && todayStr < live.brooderOut;
    const daysToProc = b.processingDate
      ? Math.max(0, Math.round((new Date(b.processingDate + 'T12:00:00') - new Date()) / 86400000))
      : null;
    const batchDailys = broilerDailys.filter(
      (d) =>
        (d.batch_label || '')
          .toLowerCase()
          .trim()
          .replace(/^\(processed\)\s*/, '') === b.name.toLowerCase().trim(),
    );
    const daysActive = b.hatchDate
      ? Math.max(1, Math.round((new Date() - new Date(b.hatchDate + 'T12:00:00')) / 86400000))
      : 1;
    const reportRate = Math.round((new Set(batchDailys.map((d) => d.date)).size / daysActive) * 100);
    const feedSoFar = batchDailys.reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);
    const gritSoFar = batchDailys.reduce((s, d) => s + (parseFloat(d.grit_lbs) || 0), 0);
    const mortSoFar = batchDailys.reduce((s, d) => s + (parseInt(d.mortality_count) || 0), 0);
    const mortPct = b.birdCount > 0 ? ((mortSoFar / b.birdCount) * 100).toFixed(1) : null;
    const sameBreed = procBr.filter(
      (b2) =>
        b2.breed === b.breed &&
        b2.hatchDate &&
        b2.processingDate &&
        (b2.brooderFeedLbs || 0) + (b2.schoonerFeedLbs || 0) > 0,
    );
    const histFeedDay =
      sameBreed.length >= 2
        ? avg(sameBreed, (b2) => {
            const tf = (b2.brooderFeedLbs || 0) + (b2.schoonerFeedLbs || 0);
            const d2 = Math.round(
              (new Date(b2.processingDate + 'T12:00:00') - new Date(b2.hatchDate + 'T12:00:00')) / 86400000,
            );
            return d2 > 0 ? tf / d2 : null;
          })
        : null;
    const projFeed = histFeedDay ? Math.round(histFeedDay * daysActive) : null;
    const feedPct = projFeed && projFeed > 0 ? Math.round((feedSoFar / projFeed) * 100) : null;
    const B2 = BREED_STYLE[b.breed] || BREED_STYLE.CC;
    const phaseLabel = inBrooder
      ? live
        ? `Brooder · out ${fmtS(live.brooderOut)}`
        : 'Brooder'
      : live
        ? `Schooner · out ${fmtS(live.schoonerOut)}`
        : 'Schooner';
    return {b, inBrooder, daysToProc, daysActive, feedSoFar, mortSoFar, mortPct, phaseLabel, B2};
  });

  // Last 10 processed for trends
  const trend10 = [...procBr]
    .sort((a, b) => (b.processingDate || '').localeCompare(a.processingDate || ''))
    .slice(0, 10)
    .reverse();

  const trendBar = (val, max, color) => (
    <div style={{display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4}}>
      <div
        style={{
          flex: 1,
          height: 7,
          background: '#f0f0f0',
          borderRadius: 4 /* radius-allow: 7px trend bar track */,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${Math.min(100, max > 0 ? (val / max) * 100 : 0)}%`,
            background: color,
            borderRadius: 4 /* radius-allow: 7px trend bar fill */,
          }}
        />
      </div>
      <span style={{fontSize: 10, color: 'var(--ink)', fontWeight: 600, minWidth: 36, textAlign: 'right'}}>
        {Math.round(val * 10) / 10}
      </span>
    </div>
  );

  // Financial — this year only
  const finBr = procBrThisYear.filter((b) => batchFeed(b) > 0 && b.totalToProcessor > 0);
  const totalLbsMeat = procBrThisYear.reduce(
    (s, b) => s + (b.totalToProcessor || 0) * (parseFloat(b.avgDressedLbs) || 0),
    0,
  );
  const totalLbsWhole = procBrThisYear.reduce((s, b) => s + (parseFloat(b.totalLbsWhole) || 0), 0);
  const totalLbsCuts = procBrThisYear.reduce((s, b) => s + (parseFloat(b.totalLbsCuts) || 0), 0);
  const wholePct =
    totalLbsWhole + totalLbsCuts > 0 ? Math.round((totalLbsWhole / (totalLbsWhole + totalLbsCuts)) * 100) : null;
  const cutsPct = wholePct != null ? 100 - wholePct : null;
  const totalFeedCost = finBr.reduce((s, b) => s + batchFeed(b) * (b.perLbStandardCost || 0), 0);
  const totalAllCost = finBr.reduce(
    (s, b) => s + batchFeed(b) * (b.perLbStandardCost || 0) + (b.processingCost || 0) + (parseFloat(b.chickCost) || 0),
    0,
  );
  const feedCostPct = totalAllCost > 0 ? Math.round((totalFeedCost / totalAllCost) * 100) : null;
  const totalProc = finBr.reduce((s, b) => s + (b.totalToProcessor || 0), 0);

  // Lbs produced trend — last 9 processed batches, sorted oldest to newest
  // (oldest-left -> newest-right). procBr is already processed-only.
  const lbsTrend = [...procBr]
    .filter((b) => b.processingDate)
    .sort((a, b) => a.processingDate.localeCompare(b.processingDate))
    .slice(-9)
    .map((b) => ({
      name: b.name,
      date: b.processingDate,
      whole: parseFloat(b.totalLbsWhole) || 0,
      cuts: parseFloat(b.totalLbsCuts) || 0,
      total: (parseFloat(b.totalLbsWhole) || 0) + (parseFloat(b.totalLbsCuts) || 0),
    }))
    .filter((b) => b.total > 0);

  const recentDailys = [...broilerDailys].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);

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
  const StatTile = ({label, val, sub, color = '#085041'}) => (
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
  const BreedCol = ({label, stats, color, bg}) =>
    stats ? (
      <div
        style={{
          flex: 1,
          minWidth: 220,
          background: bg,
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: '14px 16px',
        }}
      >
        <div style={{fontSize: 12, fontWeight: 700, color, marginBottom: 10}}>
          {label} <span style={{fontWeight: 400, color: 'var(--ink-faint)'}}>({stats.count} batches)</span>
        </div>
        {[
          {l: 'Avg Mortality', v: stats.mort != null ? fmtN(stats.mort) + '%' : '—'},
          {l: 'Avg Feed / Bird', v: stats.feedPerBird != null ? fmtN(stats.feedPerBird, 1) + ' lbs' : '—'},
          {l: 'Avg Dressed Wt', v: stats.dressed != null ? fmtN(stats.dressed, 2) + ' lbs' : '—'},
          {l: 'Avg Cost / Bird', v: stats.costPerBird != null ? '$' + fmtN(stats.costPerBird, 2) : '—'},
          {l: 'Avg Days on Farm', v: stats.daysOnFarm != null ? Math.round(stats.daysOnFarm) + ' days' : '—'},
        ].map(({l, v}) => (
          <div
            key={l}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 12,
              marginBottom: 6,
              paddingBottom: 6,
              borderBottom: '1px solid rgba(0,0,0,.06)',
            }}
          >
            <span style={{color: 'var(--ink-muted)'}}>{l}</span>
            <span style={{fontWeight: 700, color: 'var(--ink)'}}>{v}</span>
          </div>
        ))}
      </div>
    ) : null;

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
        {/* Key stats */}
        <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10}}>
          <StatTile label="Active Batches" val={activeBr.length} />
          <StatTile
            label="Birds on Farm"
            val={broilerOnFarmCounts.onFarmBirds.toLocaleString()}
            color="#085041"
            sub={
              broilerOnFarmCounts.startedBirds > 0 ? broilerOnFarmCounts.startedBirds.toLocaleString() + ' started' : ''
            }
          />
          <StatTile
            label="Birds Started"
            val={broilerOnFarmCounts.startedBirds.toLocaleString()}
            color="#a16207"
            sub={broilerOnFarmCounts.mortality > 0 ? broilerOnFarmCounts.mortality.toLocaleString() + ' mortality' : ''}
          />
          {(function () {
            var yrBirds = procBrThisYear.reduce(function (s, b) {
              return s + (parseInt(b.totalToProcessor) || 0);
            }, 0);
            return React.createElement(StatTile, {
              label: 'Processed Birds ' + currentYear,
              val: yrBirds.toLocaleString(),
              color: '#374151',
              sub: procBrThisYear.length + ' batch' + (procBrThisYear.length !== 1 ? 'es' : ''),
            });
          })()}
          {(function () {
            var yrWhole = procBrThisYear.reduce(function (s, b) {
              return s + (parseFloat(b.totalLbsWhole) || 0);
            }, 0);
            var yrCuts = procBrThisYear.reduce(function (s, b) {
              return s + (parseFloat(b.totalLbsCuts) || 0);
            }, 0);
            var yrTotal = yrWhole + yrCuts;
            return React.createElement(StatTile, {
              label: 'Total Lbs ' + currentYear,
              val: yrTotal > 0 ? Math.round(yrTotal).toLocaleString() + ' lbs' : '\u2014',
              color: '#065f46',
              sub:
                yrWhole > 0
                  ? 'Whole: ' +
                    Math.round(yrWhole).toLocaleString() +
                    ' \u00b7 Cuts: ' +
                    Math.round(yrCuts).toLocaleString()
                  : '',
            });
          })()}
        </div>

        {/* Active batch tracker */}
        {activeBatchDetails.length > 0 && (
          <div>
            <div
              style={{fontSize: 13, fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 8, letterSpacing: 0.3}}
            >
              ACTIVE BATCHES
            </div>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(270px,1fr))', gap: 10}}>
              {activeBatchDetails.map(
                ({b, inBrooder, daysToProc, daysActive, feedSoFar, mortSoFar, mortPct, phaseLabel, B2}) => (
                  <div
                    key={b.id}
                    {...openableProps(() => openBroilerBatch(b))}
                    style={{
                      background: 'white',
                      border: '1px solid var(--border)',
                      borderRadius: 12,
                      padding: '14px 16px',
                      cursor: 'pointer',
                    }}
                    className="hoverable-tile"
                  >
                    <div style={{display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap'}}>
                      <span style={{fontSize: 16}}>{inBrooder ? '🐣' : '🐔'}</span>
                      <strong style={{fontSize: 13, whiteSpace: 'nowrap'}}>{b.name}</strong>
                      <span style={{...S.badge(B2.bg, B2.tx), whiteSpace: 'nowrap'}}>{b.breed}</span>
                      <span style={{...S.badge('#f3f4f6', '#374151'), whiteSpace: 'nowrap'}}>
                        {'Sch ' + b.schooner}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: inBrooder ? '#065f46' : '#a16207',
                          background: inBrooder ? '#ecfdf5' : '#fef9c3',
                          padding: '2px 8px',
                          borderRadius: 10,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {inBrooder ? 'BROODER' : 'SCHOONER'}
                      </span>
                    </div>
                    {(() => {
                      const stats = calcBroilerStatsFromDailys(b, broilerDailys);
                      const dayOne = parseInt(b.birdCountActual) || 0;
                      const projFeed = calcBatchFeed(b);
                      return [
                        {
                          l: 'To processing',
                          v: daysToProc != null ? Math.floor(daysToProc / 7) + 'w ' + (daysToProc % 7) + 'd' : '\u2014',
                          warn: daysToProc != null && daysToProc <= 7,
                        },
                        {l: 'On farm', v: Math.floor(daysActive / 7) + 'w ' + (daysActive % 7) + 'd'},
                        {l: 'Current phase', v: phaseLabel},
                        {l: 'Birds (day 1)', v: dayOne > 0 ? dayOne.toLocaleString() : '\u2014'},
                        {l: 'On-farm birds', v: stats.projectedBirds.toLocaleString(), green: true},
                        {
                          l: 'Mortality',
                          v: mortSoFar > 0 ? `${mortSoFar} birds (${mortPct}%)` : '0',
                          warn: mortSoFar > 15,
                        },
                      ];
                    })().map(({l, v, warn, green}) => (
                      <div
                        key={l}
                        style={{display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4}}
                      >
                        <span style={{color: 'var(--ink-faint)'}}>{l}</span>
                        <span style={{fontWeight: 600, color: warn ? '#b91c1c' : green ? '#085041' : 'var(--ink)'}}>
                          {v}
                        </span>
                      </div>
                    ))}
                    {/* Feed: Projected vs Actual */}
                    {(() => {
                      const stats2 = calcBroilerStatsFromDailys(b, broilerDailys);
                      const pf = calcBatchFeed(b);
                      return React.createElement(
                        'div',
                        {style: {marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--divider)'}},
                        React.createElement(
                          'div',
                          {
                            style: {
                              fontSize: 10,
                              color: 'var(--ink-faint)',
                              textTransform: 'uppercase',
                              letterSpacing: 0.5,
                              marginBottom: 4,
                            },
                          },
                          'Feed: Projected / Actual',
                        ),
                        [
                          {l: 'Starter', proj: pf.starter, act: stats2.starterFeed, color: '#1d4ed8'},
                          {l: 'Grower', proj: pf.grower, act: stats2.growerFeed, color: '#085041'},
                        ].map(function (f) {
                          var diff = f.act - f.proj;
                          return React.createElement(
                            'div',
                            {
                              key: f.l,
                              style: {
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                fontSize: 11,
                                marginBottom: 3,
                              },
                            },
                            React.createElement('span', {style: {color: f.color, fontWeight: 600}}, f.l),
                            React.createElement(
                              'div',
                              {style: {display: 'flex', gap: 6, alignItems: 'center'}},
                              React.createElement(
                                'span',
                                {style: {color: 'var(--ink-muted)'}},
                                f.proj.toLocaleString(),
                              ),
                              React.createElement('span', {style: {color: 'var(--ink-faint)'}}, ' / '),
                              React.createElement(
                                'span',
                                {style: {fontWeight: 700, color: f.act > 0 ? 'var(--ink)' : 'var(--ink-faint)'}},
                                f.act > 0 ? f.act.toLocaleString() : '\u2014',
                              ),
                              f.act > 0 &&
                                React.createElement(
                                  'span',
                                  {
                                    style: {
                                      fontSize: 10,
                                      fontWeight: 600,
                                      color: diff > 0 ? '#b91c1c' : '#065f46',
                                      marginLeft: 4,
                                    },
                                  },
                                  '(' + (diff > 0 ? '+' : '') + diff.toLocaleString() + ')',
                                ),
                            ),
                          );
                        }),
                      );
                    })()}
                  </div>
                ),
              )}
            </div>
          </div>
        )}

        {/* CC vs WR */}
        {(ccStats || wrStats) && (
          <div>
            <div
              style={{fontSize: 13, fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 8, letterSpacing: 0.3}}
            >
              BREED COMPARISON
            </div>
            <div style={{display: 'flex', gap: 12, flexWrap: 'wrap'}}>
              <BreedCol label="🐓 Cornish Cross" stats={ccStats} color="#185FA5" bg="#E6F1FB" />
              <BreedCol label="🐤 White Ranger" stats={wrStats} color="#854F0B" bg="#FAEEDA" />
            </div>
          </div>
        )}

        {/* Performance trends */}
        {trend10.length >= 3 && (
          <div>
            <div
              style={{fontSize: 13, fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 8, letterSpacing: 0.3}}
            >
              PERFORMANCE TRENDS — LAST {trend10.length} PROCESSED BATCHES
            </div>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12}}>
              <div
                style={{background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px'}}
              >
                <div style={{fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 10}}>
                  Mortality %
                </div>
                {trend10.map((b) => {
                  const m = b.birdCount > 0 ? (batchMort(b) / b.birdCount) * 100 : 0;
                  const maxM = Math.max(
                    ...trend10.map((b2) => (b2.birdCount > 0 ? (batchMort(b2) / b2.birdCount) * 100 : 0)),
                    1,
                  );
                  return (
                    <div key={b.id}>
                      <div style={{fontSize: 10, color: 'var(--ink-muted)', marginBottom: 1}}>{b.name}</div>
                      {trendBar(m, maxM, '#b91c1c')}
                    </div>
                  );
                })}
              </div>
              <div
                style={{background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px'}}
              >
                <div style={{fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 10}}>
                  Feed / Bird (lbs)
                </div>
                {trend10
                  .filter((b) => batchFeed(b) > 0 && b.totalToProcessor > 0)
                  .map((b) => {
                    const f = batchFeed(b) / (b.totalToProcessor || 1);
                    const maxF = Math.max(
                      ...trend10
                        .filter((b2) => batchFeed(b2) > 0 && b2.totalToProcessor > 0)
                        .map((b2) => batchFeed(b2) / (b2.totalToProcessor || 1)),
                      1,
                    );
                    return (
                      <div key={b.id}>
                        <div style={{fontSize: 10, color: 'var(--ink-muted)', marginBottom: 1}}>{b.name}</div>
                        {trendBar(f, maxF, '#92400e')}
                      </div>
                    );
                  })}
              </div>
              <div
                style={{background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px'}}
              >
                <div style={{fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 10}}>
                  Avg Dressed Wt (lbs)
                </div>
                {trend10
                  .filter((b) => parseFloat(b.avgDressedLbs) > 0)
                  .map((b) => {
                    const maxW = Math.max(
                      ...trend10
                        .filter((b2) => parseFloat(b2.avgDressedLbs) > 0)
                        .map((b2) => parseFloat(b2.avgDressedLbs) || 0),
                      1,
                    );
                    return (
                      <div key={b.id}>
                        <div style={{fontSize: 10, color: 'var(--ink-muted)', marginBottom: 1}}>{b.name}</div>
                        {trendBar(parseFloat(b.avgDressedLbs) || 0, maxW, '#065f46')}
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
        )}

        {/* Financial summary */}
        {finBr.length >= 2 && (
          <div>
            <div
              style={{fontSize: 13, fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 8, letterSpacing: 0.3}}
            >
              {'FINANCIAL SUMMARY ' + currentYear}
            </div>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10}}>
              <StatTile
                label="Total Feed Cost"
                val={totalFeedCost > 0 ? '$' + Math.round(totalFeedCost).toLocaleString() : '\u2014'}
                color="#92400e"
              />
              <StatTile
                label="Processing Cost"
                val={(function () {
                  var pc = finBr.reduce(function (s, b) {
                    return s + (parseFloat(b.processingCost) || 0);
                  }, 0);
                  return pc > 0 ? '$' + Math.round(pc).toLocaleString() : '\u2014';
                })()}
                color="#374151"
              />
              <StatTile
                label="Total Cost"
                val={totalAllCost > 0 ? '$' + Math.round(totalAllCost).toLocaleString() : '\u2014'}
                color="#7f1d1d"
                sub="Feed + processing"
              />
              <StatTile
                label="Avg Cost / Bird"
                val={totalProc > 0 && totalAllCost > 0 ? '$' + (totalAllCost / totalProc).toFixed(2) : '\u2014'}
                color="#374151"
              />
              {totalLbsWhole > 0 && (
                <StatTile
                  label="Total Lbs \u2014 Whole"
                  val={
                    Math.round(totalLbsWhole).toLocaleString() +
                    ' lbs' +
                    (wholePct != null ? ' (' + wholePct + '%)' : '')
                  }
                  color="#065f46"
                />
              )}
              {totalLbsCuts > 0 && (
                <StatTile
                  label="Total Lbs \u2014 Cuts"
                  val={
                    Math.round(totalLbsCuts).toLocaleString() + ' lbs' + (cutsPct != null ? ' (' + cutsPct + '%)' : '')
                  }
                  color="#a16207"
                />
              )}
            </div>
          </div>
        )}

        {/* Lbs produced trend */}
        {lbsTrend.length >= 2 && (
          <div>
            <div
              style={{fontSize: 13, fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 8, letterSpacing: 0.3}}
            >
              LBS PRODUCED TREND — LAST {lbsTrend.length} BATCHES
            </div>
            <div style={{background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '16px'}}>
              {(() => {
                const maxTotal = Math.max(...lbsTrend.map((b) => b.total), 1);
                return lbsTrend.map((b, i) => (
                  <div key={i} style={{marginBottom: 10}}>
                    <div style={{display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3}}>
                      <span style={{color: 'var(--ink)', fontWeight: 600}}>{b.name}</span>
                      <span style={{color: 'var(--ink-muted)'}}>
                        {fmt(b.date)} ·{' '}
                        <strong style={{color: 'var(--ink)'}}>{Math.round(b.total).toLocaleString()} lbs total</strong>
                      </span>
                    </div>
                    {/* Stacked bar: whole (green) + cuts (blue) */}
                    <div
                      style={{
                        display: 'flex',
                        height: 16,
                        borderRadius: 10,
                        overflow: 'hidden',
                        background: 'var(--divider)',
                      }}
                    >
                      {b.whole > 0 && (
                        <div
                          style={{
                            width: `${(b.whole / maxTotal) * 100}%`,
                            background: '#065f46',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {b.whole / b.total > 0.15 && (
                            <span
                              style={{
                                fontSize: 9,
                                color: 'white',
                                fontWeight: 700,
                                whiteSpace: 'nowrap',
                                padding: '0 4px',
                              }}
                            >
                              {Math.round(b.whole)} W
                            </span>
                          )}
                        </div>
                      )}
                      {b.cuts > 0 && (
                        <div
                          style={{
                            width: `${(b.cuts / maxTotal) * 100}%`,
                            background: '#1d4ed8',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {b.cuts / b.total > 0.15 && (
                            <span
                              style={{
                                fontSize: 9,
                                color: 'white',
                                fontWeight: 700,
                                whiteSpace: 'nowrap',
                                padding: '0 4px',
                              }}
                            >
                              {Math.round(b.cuts)} C
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ));
              })()}
              <div style={{display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: 'var(--ink-muted)'}}>
                <span>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 10,
                      height: 10,
                      background: '#065f46',
                      borderRadius: 2 /* radius-allow: 10px legend swatch */,
                      marginRight: 4,
                    }}
                  />
                  Whole Birds
                </span>
                <span>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 10,
                      height: 10,
                      background: '#1d4ed8',
                      borderRadius: 2 /* radius-allow: 10px legend swatch */,
                      marginRight: 4,
                    }}
                  />
                  Cuts (excl. necks, feet, backs)
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
