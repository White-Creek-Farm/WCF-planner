// ============================================================================
// src/broiler/BroilerListView.jsx  —  Phase 2 Round 6
// ----------------------------------------------------------------------------
// Broiler batches list/table view (planned+active on top, processed at
// bottom). Closed over App-scope openAdd/openEdit helpers + role-derived
// isMgmt flag; we take openAdd/openEdit as props (they mutate App state
// that hasn't been lifted yet) and derive isMgmt locally from authState.
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {fmt, fmtS, todayISO} from '../lib/dateUtils.js';
import {S} from '../lib/styles.js';
import {
  calcTimeline,
  calcPoultryStatus,
  calcBroilerStatsFromDailys,
  BREED_STYLE,
  STATUS_STYLE,
  getBatchColor,
  breedLabel,
  isNearHoliday,
} from '../lib/broiler.js';
import UsersModal from '../auth/UsersModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {useBatches} from '../contexts/BatchesContext.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ActivityPanel from '../shared/ActivityPanel.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ActivityModal from '../shared/ActivityModal.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';
import {useFeedCosts} from '../contexts/FeedCostsContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';

export default function BroilerListView({
  Header,
  loadUsers,
  openAdd,
  openEdit,
  persist,
  del,
  confirmDelete,
  canDeleteAnything,
}) {
  const {authState, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const {batches, setBatches} = useBatches();
  const {broilerDailys} = useDailysRecent();
  const {feedCosts} = useFeedCosts();
  const {setView, showAllComparison, setShowAllComparison} = useUI();
  const [activityTarget, setActivityTarget] = React.useState(null);

  const role = authState?.role;
  const isAdmin = role === 'admin';
  const isMgmt = role === 'management' || role === 'admin';
  const [listNotice, setListNotice] = React.useState(null);

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
      <div style={{padding: '1rem'}}>
        <div style={{display: 'flex', justifyContent: 'flex-end', marginBottom: 10}}>
          <button
            style={{
              padding: '7px 18px',
              borderRadius: 8,
              border: 'none',
              background: '#085041',
              color: 'white',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: 0.1,
              display: isMgmt ? 'block' : 'none',
            }}
            onClick={openAdd}
          >
            + Add Batch
          </button>
        </div>
        <InlineNotice notice={listNotice} onDismiss={() => setListNotice(null)} />
        <div style={{...S.card, overflowX: 'auto'}}>
          <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 900}}>
            <thead>
              <tr style={{background: '#ecfdf5', borderBottom: '1px solid #e5e7eb'}}>
                {[
                  'Batch Name',
                  'Breed',
                  'Hatchery',
                  'Hatch Date',
                  'Birds',
                  'Mort.',
                  'Brooder',
                  'Schooner',
                  'Brooder Period',
                  'Schooner Period',
                  'Processing Date',
                  'Time on Farm',
                  'Feed',
                  'Status',
                  '',
                ].map((h, i) => (
                  <th
                    key={i}
                    style={{
                      padding: '8px 10px',
                      textAlign: 'left',
                      fontWeight: 600,
                      color: '#4b5563',
                      whiteSpace: 'nowrap',
                      fontSize: 11,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {batches.length === 0 && (
                <tr>
                  <td colSpan={13} style={{padding: '2.5rem', textAlign: 'center', color: '#9ca3af'}}>
                    No batches yet — click "+ Add Batch" to get started
                  </td>
                </tr>
              )}
              {batches
                .filter((b) => b.status === 'planned' || b.status === 'active')
                .map((b, i) => {
                  const C = getBatchColor(b.name);
                  const autoSt = calcPoultryStatus(b);
                  const S2 = STATUS_STYLE[autoSt] || STATUS_STYLE.planned;
                  const B2 = BREED_STYLE[b.breed] || BREED_STYLE.CC;
                  const hw = isNearHoliday(b.hatchDate);
                  const pw = b.processingDate && isNearHoliday(b.processingDate);
                  const live = calcTimeline(b.hatchDate, b.breed, b.processingDate);
                  // Prefer stored brooderIn (hatchDate+1 per migration) over calcTimeline's (same as hatch)
                  const brooderIn = b.brooderIn || (live ? live.brooderIn : null);
                  const brooderOut = b.brooderOut || (live ? live.brooderOut : null);
                  const schoonerIn = live ? live.schoonerIn : b.schoonerIn;
                  const schoonerOut = live ? live.schoonerOut : b.schoonerOut;
                  return (
                    <tr
                      key={b.id}
                      onClick={() => openEdit(b)}
                      style={{
                        borderBottom: '1px solid #e5e7eb',
                        background: i % 2 === 0 ? 'white' : '#fafafa',
                        cursor: 'pointer',
                      }}
                    >
                      <td style={{padding: '8px 10px', fontWeight: 600, whiteSpace: 'nowrap'}}>
                        <span
                          style={{
                            display: 'inline-block',
                            width: 10,
                            height: 10,
                            borderRadius: 2,
                            background: C.bg,
                            marginRight: 6,
                            verticalAlign: 'middle',
                          }}
                        />
                        {b.name}
                        <span
                          onClick={(e) => e.stopPropagation()}
                          style={{marginLeft: 6}}
                          data-activity-surface="broiler.batch"
                        >
                          {React.createElement(ActivityPanel, {
                            sb,
                            authState,
                            entityType: 'broiler.batch',
                            entityId: b.name,
                            entityLabel: b.name,
                            mode: 'compact',
                            onCompactClick: setActivityTarget,
                          })}
                        </span>
                      </td>
                      <td style={{padding: '8px 10px'}}>
                        <span style={S.badge(B2.bg, B2.tx)}>{b.breed}</span>
                      </td>
                      <td style={{padding: '8px 10px', color: '#4b5563', whiteSpace: 'nowrap'}}>{b.hatchery}</td>
                      <td style={{padding: '8px 10px', whiteSpace: 'nowrap'}}>
                        {fmt(b.hatchDate)}
                        {hw ? ' \u26a0' : ''}
                      </td>
                      <td style={{padding: '8px 10px'}}>{b.birdCount}</td>
                      <td
                        style={{
                          padding: '8px 10px',
                          color:
                            (b.mortalityCumulative || 0) > 0 ||
                            (!/^b-24-/i.test(b.name) &&
                              broilerDailys
                                .filter(
                                  (d) =>
                                    (d.batch_label || '')
                                      .toLowerCase()
                                      .trim()
                                      .replace(/^\(processed\)\s*/, '')
                                      .trim() === b.name.toLowerCase().trim(),
                                )
                                .reduce((s, d) => s + (parseInt(d.mortality_count) || 0), 0) > 0)
                              ? '#b91c1c'
                              : '#9ca3af',
                          fontWeight: 600,
                        }}
                      >
                        {(() => {
                          if (/^b-24-/i.test(b.name)) return b.mortalityCumulative || 0;
                          return broilerDailys
                            .filter(
                              (d) =>
                                (d.batch_label || '')
                                  .toLowerCase()
                                  .trim()
                                  .replace(/^\(processed\)\s*/, '')
                                  .trim() === b.name.toLowerCase().trim(),
                            )
                            .reduce((s, d) => s + (parseInt(d.mortality_count) || 0), 0);
                        })()}
                      </td>
                      <td style={{padding: '8px 10px'}}>{b.brooder}</td>
                      <td style={{padding: '8px 10px'}}>
                        <span style={S.badge('#f3f4f6', '#374151')}>{b.schooner}</span>
                      </td>
                      <td style={{padding: '8px 10px', whiteSpace: 'nowrap', color: '#4b5563'}}>
                        {fmtS(brooderIn) + ' \u2192 ' + fmtS(brooderOut)}
                      </td>
                      <td style={{padding: '8px 10px', whiteSpace: 'nowrap', color: '#4b5563'}}>
                        {fmtS(schoonerIn) + ' \u2192 ' + fmtS(schoonerOut)}
                      </td>
                      <td style={{padding: '8px 10px', whiteSpace: 'nowrap'}}>
                        {b.processingDate ? (
                          <span>
                            {fmt(b.processingDate)}
                            {pw ? ' ⚠' : ''}
                          </span>
                        ) : (
                          <span style={{color: '#9ca3af'}}>TBD</span>
                        )}
                      </td>
                      <td style={{padding: '8px 10px', whiteSpace: 'nowrap'}}>
                        {(() => {
                          if (!b.hatchDate || !b.processingDate) return <span style={{color: '#9ca3af'}}>—</span>;
                          const days = Math.round(
                            (new Date(b.processingDate + 'T12:00:00') - new Date(b.hatchDate + 'T12:00:00')) / 86400000,
                          );
                          const w = Math.floor(days / 7),
                            d = days % 7;
                          return (
                            <span style={{fontWeight: 500, color: '#085041'}}>
                              {w}w {d}d
                            </span>
                          );
                        })()}
                      </td>
                      <td style={{padding: '8px 10px', whiteSpace: 'nowrap'}}>
                        {(() => {
                          const isB24 = /^b-24-/i.test(b.name);
                          if (isB24) {
                            const total = (b.brooderFeedLbs || 0) + (b.schoonerFeedLbs || 0);
                            return total > 0 ? (
                              <span style={{color: '#92400e', fontWeight: 600}}>{total.toLocaleString()} lbs</span>
                            ) : (
                              <span style={{color: '#9ca3af'}}>—</span>
                            );
                          }
                          const bd = broilerDailys.filter(
                            (d) =>
                              (d.batch_label || '')
                                .toLowerCase()
                                .trim()
                                .replace(/^\(processed\)\s*/, '')
                                .trim() === b.name.toLowerCase().trim(),
                          );
                          const total = bd.reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);
                          if (bd.length === 0) return <span style={{color: '#9ca3af'}}>—</span>;
                          return (
                            <span style={{color: '#92400e', fontWeight: 600}}>
                              {Math.round(total).toLocaleString()} lbs
                            </span>
                          );
                        })()}
                      </td>
                      <td style={{padding: '8px 10px'}}>
                        <span style={S.badge(S2.bg, S2.tx)}>{autoSt}</span>
                      </td>
                      <td style={{padding: '8px 10px', whiteSpace: 'nowrap'}}>
                        {isMgmt && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const nb = batches.map((x) => (x.id === b.id ? {...x, status: 'processed'} : x));
                              setBatches(nb);
                              persist(nb);
                            }}
                            style={{
                              fontSize: 11,
                              color: '#6b7280',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              marginRight: 8,
                            }}
                          >
                            Archive
                          </button>
                        )}
                        {isAdmin && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (canDeleteAnything(authState?.role)) {
                                setListNotice(null);
                                del(b.id);
                              } else {
                                setListNotice({kind: 'error', message: 'Only admins can delete batches.'});
                              }
                            }}
                            style={{
                              fontSize: 11,
                              color: '#b91c1c',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                            }}
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>

        {/* ── Batch Comparison Table ── */}
        {(() => {
          const completedBatches = batches
            .filter((b) => b.status === 'processed')
            .sort((a, b) => {
              const da = a.processingDate || '';
              const db = b.processingDate || '';
              return da < db ? 1 : da > db ? -1 : 0;
            });
          const displayed = showAllComparison ? completedBatches : completedBatches.slice(0, 10);
          if (completedBatches.length === 0) return null;
          return (
            <div style={{marginTop: 24}}>
              <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8}}>
                <div style={{fontSize: 13, fontWeight: 700, color: '#374151', letterSpacing: 0.3}}>
                  BATCH COMPARISON
                </div>
                {completedBatches.length > 10 && (
                  <button
                    onClick={() => setShowAllComparison((v) => !v)}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: '#085041',
                      background: 'none',
                      border: '1px solid #085041',
                      borderRadius: 6,
                      padding: '3px 10px',
                      cursor: 'pointer',
                    }}
                  >
                    {showAllComparison ? 'Show Last 10' : 'Show All ' + completedBatches.length}
                  </button>
                )}
              </div>
              <div style={{...S.card, overflowX: 'auto'}}>
                <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 11, minWidth: 1100}}>
                  <thead>
                    <tr style={{background: '#ecfdf5', borderBottom: '1px solid #d1fae5'}}>
                      {[
                        'Batch',
                        'Breed',
                        'Time on Farm',
                        'Schooner',
                        'Birds Arrived',
                        '4 Wk Lbs',
                        '6 Wk Lbs',
                        'Feed / Bird',
                        'Starter Feed',
                        'Grower Feed',
                        'Total Feed',
                        '# Processed',
                        'Avg Breast',
                        'Avg Thigh',
                        'Avg Dressed',
                        '',
                      ].map((h) => (
                        <th
                          key={h}
                          style={{
                            padding: '7px 10px',
                            textAlign: 'left',
                            fontWeight: 600,
                            color: '#374151',
                            whiteSpace: 'nowrap',
                            fontSize: 11,
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayed.map((b, i) => {
                      const n = (v) => parseFloat(v) || 0;
                      // Daily-reports-aware feed totals: B-24 uses legacy manual fields,
                      // B-25+ pulls from broilerDailys (matches dashboard's batchFeed helper)
                      const isB24 = /^b-24-/i.test(b.name);
                      let starter, grower;
                      if (isB24) {
                        starter = n(b.brooderFeedLbs);
                        grower = n(b.schoonerFeedLbs);
                      } else {
                        const bd = broilerDailys.filter(
                          (d) =>
                            (d.batch_label || '')
                              .toLowerCase()
                              .trim()
                              .replace(/^\(processed\)\s*/, '')
                              .trim() === b.name.toLowerCase().trim(),
                        );
                        starter = Math.round(
                          bd
                            .filter((d) => d.feed_type === 'STARTER')
                            .reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0),
                        );
                        grower = Math.round(
                          bd
                            .filter((d) => d.feed_type === 'GROWER')
                            .reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0),
                        );
                        // Fall back to manual fields if no daily reports found
                        if (starter === 0 && grower === 0) {
                          starter = n(b.brooderFeedLbs);
                          grower = n(b.schoonerFeedLbs);
                        }
                      }
                      const totalFeed = starter + grower;
                      const processed = n(b.totalToProcessor);
                      const feedPerBird = processed > 0 && totalFeed > 0 ? (totalFeed / processed).toFixed(1) : null;
                      const B2 = BREED_STYLE[b.breed] || BREED_STYLE.CC;
                      const sch = (b.schooner || '').toString().trim();
                      const timeOnFarm = (() => {
                        if (!b.hatchDate || !b.processingDate) return null;
                        const days = Math.round(
                          (new Date(b.processingDate + 'T12:00:00') - new Date(b.hatchDate + 'T12:00:00')) / 86400000,
                        );
                        return `${Math.floor(days / 7)}w ${days % 7}d`;
                      })();
                      const cell = (v, opts = {}) => {
                        const {green, bold} = opts;
                        const color = green ? '#085041' : '#111827';
                        return (
                          <td
                            key={Math.random()}
                            style={{
                              padding: '7px 10px',
                              whiteSpace: 'nowrap',
                              color: v ? color : '#9ca3af',
                              fontWeight: bold || v ? 600 : 400,
                            }}
                          >
                            {v || '—'}
                          </td>
                        );
                      };
                      return (
                        <tr
                          key={b.id}
                          onClick={() => openEdit(b)}
                          style={{
                            borderBottom: '1px solid #e5e7eb',
                            background: i % 2 === 0 ? 'white' : '#fafafa',
                            cursor: 'pointer',
                          }}
                          className="hoverable-tile"
                        >
                          <td style={{padding: '7px 10px', fontWeight: 700, whiteSpace: 'nowrap', color: '#111827'}}>
                            {b.name}
                          </td>
                          <td style={{padding: '7px 10px'}}>
                            {b.breed ? (
                              <span style={S.badge(B2.bg, B2.tx)}>{b.breed}</span>
                            ) : (
                              <span style={{color: '#9ca3af'}}>—</span>
                            )}
                          </td>
                          {cell(timeOnFarm)}
                          <td style={{padding: '7px 10px'}}>
                            {sch ? (
                              <span
                                style={{
                                  padding: '2px 8px',
                                  borderRadius: 4,
                                  fontSize: 10,
                                  fontWeight: 600,
                                  background: '#fef9c3',
                                  color: '#854d0e',
                                }}
                              >
                                {sch}
                              </span>
                            ) : (
                              <span style={{color: '#9ca3af'}}>{'\u2014'}</span>
                            )}
                          </td>
                          {cell(b.birdCountActual ? parseInt(b.birdCountActual).toLocaleString() : null)}
                          {cell(n(b.week4Lbs) > 0 ? `${n(b.week4Lbs)} lbs` : null)}
                          {cell(n(b.week6Lbs) > 0 ? `${n(b.week6Lbs)} lbs` : null)}
                          {cell(feedPerBird ? `${feedPerBird} lbs` : null, {green: true})}
                          {cell(starter > 0 ? `${Math.round(starter).toLocaleString()} lbs` : null)}
                          {cell(grower > 0 ? `${Math.round(grower).toLocaleString()} lbs` : null)}
                          {cell(totalFeed > 0 ? `${Math.round(totalFeed).toLocaleString()} lbs` : null, {bold: true})}
                          {cell(processed > 0 ? processed.toLocaleString() : null)}
                          {cell(n(b.avgBreastLbs) > 0 ? `${n(b.avgBreastLbs)} lbs` : null)}
                          {cell(n(b.avgThighsLbs) > 0 ? `${n(b.avgThighsLbs)} lbs` : null)}
                          {cell(n(b.avgDressedLbs) > 0 ? `${n(b.avgDressedLbs)} lbs` : null)}
                          {isAdmin && (
                            <td style={{padding: '7px 10px', whiteSpace: 'nowrap'}}>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  del(b.id);
                                }}
                                style={{
                                  fontSize: 11,
                                  color: '#b91c1c',
                                  background: 'none',
                                  border: 'none',
                                  cursor: 'pointer',
                                  fontFamily: 'inherit',
                                }}
                              >
                                Delete
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {!showAllComparison && completedBatches.length > 10 && (
                <div style={{textAlign: 'center', fontSize: 11, color: '#9ca3af', marginTop: 6}}>
                  {completedBatches.length - 10} more batches hidden — click "Show All" to expand
                </div>
              )}
            </div>
          );
        })()}

        {/* Processed batches */}
        {batches.filter((b) => b.status === 'processed').length > 0 && (
          <div style={{marginTop: 20}}>
            <div style={{fontSize: 13, fontWeight: 600, color: '#9ca3af', marginBottom: 8, letterSpacing: 0.3}}>
              PROCESSED ({batches.filter((b) => b.status === 'processed').length})
            </div>
            {batches
              .filter((b) => b.status === 'processed')
              .sort((a, b) =>
                (b.processingDate || b.hatchDate || '').localeCompare(a.processingDate || a.hatchDate || ''),
              )
              .map((b, i) => {
                const B2 = BREED_STYLE[b.breed] || BREED_STYLE.CC;
                // B-24-* batches: always use manually entered feed totals (legacy)
                const isB24 = /^b-24-/i.test(b.name);
                const bd = broilerDailys.filter(
                  (d) =>
                    (d.batch_label || '')
                      .toLowerCase()
                      .trim()
                      .replace(/^\(processed\)\s*/, '')
                      .trim() === b.name.toLowerCase().trim(),
                );
                const dailyStarterLbs = bd
                  .filter((d) => d.feed_type === 'STARTER')
                  .reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);
                const dailyGrowerLbs = bd
                  .filter((d) => d.feed_type === 'GROWER')
                  .reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);
                const dailyGritLbs = bd.reduce((s, d) => s + (parseFloat(d.grit_lbs) || 0), 0);
                const dailyMortality = bd.reduce((s, d) => s + (parseInt(d.mortality_count) || 0), 0);
                // Feed source logic: B-24 = manual only; B-25+ = daily reports only
                const starterLbs = isB24 ? b.brooderFeedLbs || 0 : dailyStarterLbs;
                const growerLbs = isB24 ? b.schoonerFeedLbs || 0 : dailyGrowerLbs;
                const gritLbs = isB24 ? b.gritLbs || 0 : dailyGritLbs;
                const mortality = isB24 ? b.mortalityCumulative || 0 : dailyMortality;
                const totalFeed = starterLbs + growerLbs;
                const starterCost = starterLbs * (b.perLbStarterCost || 0);
                const growerCost = growerLbs * (b.perLbStandardCost || 0);
                const feedCost = starterCost + growerCost;
                const gritCost = gritLbs * (b.perLbGritCost || 0);
                const chickCost = parseFloat(b.chickCost) || 0;
                const totalCost = feedCost + gritCost + (b.processingCost || 0) + chickCost;
                const perBird = b.totalToProcessor > 0 ? totalCost / b.totalToProcessor : 0;
                const mortalityPct = b.birdCount > 0 ? ((mortality / b.birdCount) * 100).toFixed(1) : 0;
                return (
                  <div
                    key={b.id}
                    onClick={() => openEdit(b)}
                    style={{
                      background: 'white',
                      border: '1px solid #e5e7eb',
                      borderRadius: 10,
                      marginBottom: 10,
                      overflow: 'hidden',
                      cursor: 'pointer',
                      opacity: 0.9,
                    }}
                    className="hoverable-tile"
                  >
                    {/* Header row */}
                    <div
                      style={{
                        padding: '10px 14px',
                        background: '#f9fafb',
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '6px 14px',
                        alignItems: 'center',
                        borderBottom: '1px solid #e5e7eb',
                      }}
                    >
                      <strong style={{fontSize: 13, color: '#111827'}}>{b.name}</strong>
                      {b.breed && <span style={S.badge(B2.bg, B2.tx)}>{breedLabel(b.breed)}</span>}
                      {b.hatchery && <span style={{color: '#6b7280', fontSize: 12}}>{b.hatchery}</span>}
                      {b.schooner && (
                        <span
                          style={{
                            padding: '2px 8px',
                            borderRadius: 4,
                            fontSize: 11,
                            fontWeight: 600,
                            background: '#fef9c3',
                            color: '#854d0e',
                          }}
                        >
                          Sch {b.schooner}
                        </span>
                      )}
                      <span style={{marginLeft: 'auto', display: 'flex', gap: 6}}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const nb = batches.map((x) => {
                              if (x.id !== b.id) return x;
                              const upd = {...x, status: 'active'};
                              // Stamp current admin rates if missing (e.g. reactivating a batch that was created blank)
                              if (!upd.perLbStarterCost || !upd.perLbStandardCost) {
                                upd.perLbStarterCost = feedCosts.starter || 0;
                                upd.perLbStandardCost = feedCosts.grower || 0;
                                upd.perLbGritCost = feedCosts.grit || 0;
                              }
                              return upd;
                            });
                            setBatches(nb);
                            persist(nb);
                          }}
                          style={{
                            fontSize: 11,
                            color: '#085041',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                          }}
                        >
                          Reactivate
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            confirmDelete('Delete this batch? This cannot be undone.', () => del(b.id));
                          }}
                          style={{
                            fontSize: 11,
                            color: '#b91c1c',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                          }}
                        >
                          Delete
                        </button>
                      </span>
                    </div>
                    {/* Stats grid */}
                    <div
                      style={{
                        padding: '10px 14px',
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill,minmax(110px,1fr))',
                        gap: 8,
                        fontSize: 11,
                      }}
                    >
                      {(() => {
                        const tofDays =
                          b.hatchDate && b.processingDate
                            ? Math.round(
                                (new Date(b.processingDate + 'T12:00:00') - new Date(b.hatchDate + 'T12:00:00')) /
                                  86400000,
                              )
                            : null;
                        const tofStr = tofDays != null ? `${Math.floor(tofDays / 7)}w ${tofDays % 7}d` : '—';
                        const lbsPerBird =
                          b.totalToProcessor > 0 && totalFeed > 0 ? (totalFeed / b.totalToProcessor).toFixed(1) : null;
                        return [
                          {l: 'Hatch Date', v: fmt(b.hatchDate)},
                          {l: 'Process Date', v: fmt(b.processingDate)},
                          {l: 'Time on Farm', v: tofStr},
                          {l: 'Birds Ordered', v: (b.birdCount || 0).toLocaleString()},
                          {
                            l: 'Birds Arrived',
                            v: b.birdCountActual ? parseInt(b.birdCountActual).toLocaleString() : '—',
                          },
                          {l: 'To Processor', v: (b.totalToProcessor || 0).toLocaleString()},
                          {l: 'Mortality', v: `${mortality} (${mortalityPct}%)`, warn: mortality > 20},
                          {l: 'Lbs / Bird', v: lbsPerBird ? `${lbsPerBird} lbs` : '—'},
                        ];
                      })().map(({l, v, warn}) => (
                        <div key={l} style={{background: '#f9fafb', borderRadius: 6, padding: '6px 8px'}}>
                          <div
                            style={{
                              color: '#9ca3af',
                              marginBottom: 2,
                              fontSize: 10,
                              textTransform: 'uppercase',
                              letterSpacing: 0.3,
                            }}
                          >
                            {l}
                          </div>
                          <div style={{fontWeight: 700, color: warn ? '#b91c1c' : '#111827', fontSize: 12}}>
                            {v || '\u2014'}
                          </div>
                        </div>
                      ))}
                    </div>
                    {/* Feed section */}
                    {(totalFeed > 0 || gritLbs > 0) && (
                      <div
                        style={{
                          padding: '8px 14px',
                          borderTop: '1px solid #f3f4f6',
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fill,minmax(110px,1fr))',
                          gap: 8,
                          fontSize: 11,
                          background: '#fefce8',
                        }}
                      >
                        <div
                          style={{
                            gridColumn: '1/-1',
                            fontSize: 10,
                            color: isB24 ? '#92400e' : '#085041',
                            marginBottom: 2,
                            fontStyle: isB24 ? 'italic' : 'normal',
                          }}
                        >
                          {isB24
                            ? '📋 Feed & grit from manually entered totals (2024 batch)'
                            : bd.length > 0
                              ? `🌾 Feed & grit from ${bd.length} daily report${bd.length !== 1 ? 's' : ''}`
                              : '⚠ No daily reports found for this batch'}
                        </div>
                        {[
                          {
                            l: isB24 ? 'Brooder Feed' : 'Starter Feed',
                            v: starterLbs > 0 ? `${Math.round(starterLbs).toLocaleString()} lbs` : '—',
                          },
                          {
                            l: isB24 ? 'Schooner Feed' : 'Grower Feed',
                            v: growerLbs > 0 ? `${Math.round(growerLbs).toLocaleString()} lbs` : '—',
                          },
                          {l: 'Grit', v: gritLbs > 0 ? `${Math.round(gritLbs).toLocaleString()} lbs` : '—'},
                          {l: 'Feed Cost', v: feedCost > 0 ? `$${feedCost.toFixed(2)}` : '—'},
                          {l: 'Grit Cost', v: gritCost > 0 ? `$${gritCost.toFixed(2)}` : '—'},
                          {l: 'Process Cost', v: b.processingCost > 0 ? `$${(b.processingCost || 0).toFixed(2)}` : '—'},
                          {l: 'Chick Cost', v: chickCost > 0 ? `$${chickCost.toFixed(2)}` : '—'},
                          {l: 'Total Cost', v: totalCost > 0 ? `$${totalCost.toFixed(2)}` : '—'},
                          {l: 'Per Bird Cost', v: perBird > 0 ? `$${perBird.toFixed(2)}` : '—'},
                        ].map(({l, v}) => (
                          <div
                            key={l}
                            style={{background: 'rgba(255,255,255,.6)', borderRadius: 6, padding: '6px 8px'}}
                          >
                            <div
                              style={{
                                color: '#92400e',
                                marginBottom: 2,
                                fontSize: 10,
                                textTransform: 'uppercase',
                                letterSpacing: 0.3,
                              }}
                            >
                              {l}
                            </div>
                            <div style={{fontWeight: 700, color: '#78350f', fontSize: 12}}>{v}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* Weights section */}
                    {(b.avgDressedLbs || b.avgBreastLbs || b.avgThighsLbs || b.week4Lbs || b.week6Lbs) && (
                      <div
                        style={{
                          padding: '8px 14px',
                          borderTop: '1px solid #f3f4f6',
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '6px 20px',
                          fontSize: 11,
                          color: '#6b7280',
                        }}
                      >
                        {b.week4Lbs > 0 && (
                          <span>
                            4-wk: <strong>{b.week4Lbs} lbs</strong>
                          </span>
                        )}
                        {b.week6Lbs > 0 && (
                          <span>
                            6-wk: <strong>{b.week6Lbs} lbs</strong>
                          </span>
                        )}
                        {b.avgDressedLbs > 0 && (
                          <span>
                            Avg dressed: <strong>{b.avgDressedLbs} lbs</strong>
                          </span>
                        )}
                        {b.avgBreastLbs > 0 && (
                          <span>
                            Avg breast: <strong>{b.avgBreastLbs} lbs</strong>
                          </span>
                        )}
                        {b.avgThighsLbs > 0 && (
                          <span>
                            Avg thighs: <strong>{b.avgThighsLbs} lbs</strong>
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
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
}
