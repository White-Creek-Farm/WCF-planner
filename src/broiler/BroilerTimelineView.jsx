// ============================================================================
// src/broiler/BroilerTimelineView.jsx  —  Phase 2 Round 6
// ----------------------------------------------------------------------------
// Broiler + layer timeline Gantt view. Consumes contexts via hooks; Header,
// loadUsers, and openEdit come in as props because their extractions are
// still deferred in App. The visible date range is derived from data:
// left bound = today − 90 days; right bound = max(today + 30d, latest
// rendered end date + 30d). Width grows with the data span; the container
// scrolls horizontally and lands on today (~12% from the left edge) on
// first paint. Vertical "today" line is preserved.
// ============================================================================
import React, {useRef, useEffect, useMemo} from 'react';
import {useNavigate} from 'react-router-dom';
import {sb} from '../lib/supabase.js';
import {toISO, addDays, fmt, fmtS, todayISO} from '../lib/dateUtils.js';
import {S} from '../lib/styles.js';
import {calcTimeline, RESOURCES, getBatchColor, breedLabel} from '../lib/broiler.js';
import {timelineRowSeparation} from '../lib/broilerTimelineRows.js';
import UsersModal from '../auth/UsersModal.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {useBatches} from '../contexts/BatchesContext.jsx';
import {useLayer} from '../contexts/LayerContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';

export default function BroilerTimelineView({Header, loadUsers, openEdit}) {
  const navigate = useNavigate();
  const {authState, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const {batches, tooltip, setTooltip} = useBatches();
  const {layerBatches} = useLayer();
  const {setView, setPendingEdit} = useUI();

  function openBroilerBatch(b) {
    if (b && b.name) {
      navigate('/broiler/batches/' + encodeURIComponent(b.name));
    } else if (typeof openEdit === 'function') {
      openEdit(b);
    }
  }

  const today = todayISO();
  const tlStart = toISO(addDays(today, -90));

  const latestEndISO = useMemo(() => {
    let latest = today;
    const bump = (iso) => {
      if (iso && iso > latest) latest = iso;
    };
    for (const b of batches || []) {
      bump(b.brooderOut);
      bump(b.schoonerOut);
      bump(b.processingDate);
      // Cover planned batches whose phases haven't been written to the row yet.
      if (b.hatchDate && b.breed) {
        const live = calcTimeline(b.hatchDate, b.breed, b.processingDate);
        if (live) {
          bump(live.brooderOut);
          bump(live.schoonerOut);
        }
      }
    }
    for (const lb of layerBatches || []) {
      if (lb.status !== 'active') continue;
      if (lb.name === 'Retirement Home') continue;
      const bs = lb.brooder_entry_date;
      if (bs) bump(lb.brooder_exit_date || toISO(addDays(new Date(bs + 'T12:00:00'), 21)));
      const ss = lb.schooner_entry_date;
      if (ss) bump(lb.schooner_exit_date || toISO(addDays(new Date(ss + 'T12:00:00'), 119)));
    }
    return latest;
  }, [batches, layerBatches, today]);

  const tlEndISO = toISO(addDays(latestEndISO, 30));
  const tlS = new Date(tlStart + 'T12:00:00');
  const tlE = new Date(tlEndISO + 'T12:00:00');
  const totalDays = Math.max(1, Math.round((tlE - tlS) / 86400000));
  const weeksShown = Math.max(1, Math.ceil(totalDays / 7));
  const pct = (iso) => ((new Date(iso + 'T12:00:00') - tlS) / 86400000 / totalDays) * 100;
  const wkHdrs = Array.from({length: weeksShown}, (_, i) => addDays(tlS, i * 7));

  // Land today near the left edge on first paint. Self-terminating so the
  // user's manual scroll isn't yanked back on later renders.
  const scrollRef = useRef(null);
  const didInitialScroll = useRef(false);
  useEffect(() => {
    if (didInitialScroll.current) return;
    const el = scrollRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const ganttPx = weeksShown * 120;
    const targetX = (pct(today) / 100) * ganttPx - el.clientWidth * 0.12;
    el.scrollLeft = Math.max(0, targetX);
    didInitialScroll.current = true;
  });

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
      <div style={{padding: '1rem'}}>
        {/* Gantt */}
        <div ref={scrollRef} style={{...S.card, overflowX: 'auto'}}>
          <div style={{width: `${weeksShown * 120}px`, position: 'relative'}} data-gantt="1">
            {/* Floating tooltip */}
            {tooltip &&
              (() => {
                if (tooltip.type === 'layer') {
                  const lb = tooltip.lb;
                  const bar = tooltip.bar;
                  return (
                    <div
                      style={{
                        position: 'fixed',
                        left: tooltip.vx,
                        top: tooltip.vy,
                        transform: 'translate(-50%,-100%)',
                        zIndex: 9999,
                        pointerEvents: 'none',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                      }}
                    >
                      <div
                        style={{
                          background: '#1a1a1a',
                          color: 'white',
                          borderRadius: 10,
                          padding: '9px 12px',
                          fontSize: 12,
                          boxShadow: '0 4px 16px rgba(0,0,0,.35)',
                          minWidth: 180,
                          maxWidth: 240,
                        }}
                      >
                        <div style={{fontWeight: 700, fontSize: 13, marginBottom: 5, color: '#fde68a'}}>
                          {lb.name}
                          {' \u00b7 '}
                          {bar.label}
                        </div>
                        <div style={{display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 10px'}}>
                          {lb.original_count && (
                            <>
                              <span style={{color: '#9ca3af'}}>Birds:</span>
                              <span style={{color: 'white'}}>{lb.original_count.toLocaleString()}</span>
                            </>
                          )}
                          <span style={{color: '#9ca3af'}}>{bar.label}:</span>
                          <span style={{color: 'white'}}>
                            {fmtS(bar.start)} {'\u2192'} {fmtS(bar.end)}
                          </span>
                          {bar.resName && (
                            <>
                              <span style={{color: '#9ca3af'}}>Using:</span>
                              <span style={{color: 'white'}}>{bar.resName}</span>
                            </>
                          )}
                          {lb.brooder_entry_date && (
                            <>
                              <span style={{color: '#9ca3af'}}>Brooder in:</span>
                              <span style={{color: 'white'}}>{fmtS(lb.brooder_entry_date)}</span>
                            </>
                          )}
                          {lb.schooner_exit_date && (
                            <>
                              <span style={{color: '#9ca3af'}}>Schooner out:</span>
                              <span style={{color: '#a7f3d0'}}>{fmtS(lb.schooner_exit_date)}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div
                        style={{
                          width: 0,
                          height: 0,
                          borderLeft: '7px solid transparent',
                          borderRight: '7px solid transparent',
                          borderTop: '7px solid #1a1a1a',
                        }}
                      />
                    </div>
                  );
                }
                const b = tooltip.batch;
                const isBrooder = tooltip.resType === 'brooder';
                const live = calcTimeline(b.hatchDate, b.breed, b.processingDate);
                const brooderIn = b.brooderIn || (live ? live.brooderIn : null);
                const brooderOut = b.brooderOut || (live ? live.brooderOut : null);
                const schoonerIn = live ? live.schoonerIn : b.schoonerIn;
                const schoonerOut = live ? live.schoonerOut : b.schoonerOut;
                return (
                  <div
                    style={{
                      position: 'fixed',
                      left: tooltip.vx,
                      top: tooltip.vy,
                      transform: 'translate(-50%,-100%)',
                      zIndex: 9999,
                      pointerEvents: 'none',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                    }}
                  >
                    <div
                      style={{
                        background: '#1a1a1a',
                        color: 'white',
                        borderRadius: 10,
                        padding: '9px 12px',
                        fontSize: 12,
                        boxShadow: '0 4px 16px rgba(0,0,0,.35)',
                        minWidth: 180,
                        maxWidth: 240,
                      }}
                    >
                      <div style={{fontWeight: 700, fontSize: 13, marginBottom: 5, color: 'white'}}>{b.name}</div>
                      <div style={{display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 10px'}}>
                        <span style={{color: '#9ca3af'}}>Breed:</span>
                        <span style={{color: 'white'}}>{breedLabel(b.breed)}</span>
                        <span style={{color: '#9ca3af'}}>Hatchery:</span>
                        <span style={{color: 'white'}}>{b.hatchery}</span>
                        <span style={{color: '#9ca3af'}}>Birds:</span>
                        <span style={{color: 'white'}}>{b.birdCount}</span>
                        {isBrooder && (
                          <>
                            <span style={{color: '#9ca3af'}}>Brooder {b.brooder}:</span>
                            <span style={{color: 'white'}}>{fmtS(brooderIn) + ' \u2192 ' + fmtS(brooderOut)}</span>
                          </>
                        )}
                        {!isBrooder && (
                          <>
                            <span style={{color: '#9ca3af'}}>Schooner {b.schooner}:</span>
                            <span style={{color: 'white'}}>{fmtS(schoonerIn) + ' \u2192 ' + fmtS(schoonerOut)}</span>
                          </>
                        )}
                        {b.processingDate && (
                          <>
                            <span style={{color: '#9ca3af'}}>Processing:</span>
                            <span style={{color: '#a7f3d0'}}>{fmt(b.processingDate)}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div
                      style={{
                        width: 0,
                        height: 0,
                        borderLeft: '7px solid transparent',
                        borderRight: '7px solid transparent',
                        borderTop: '7px solid #1a1a1a',
                      }}
                    />
                  </div>
                );
              })()}

            {/* Week headers */}
            <div style={{display: 'flex', borderBottom: '1px solid var(--border)'}}>
              <div
                style={{
                  width: 145,
                  flexShrink: 0,
                  padding: '6px 10px',
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'var(--ink-faint)',
                  borderRight: '1px solid var(--border)',
                  background: 'var(--surface-2)',
                  position: 'sticky',
                  left: 0,
                  zIndex: 10,
                }}
              >
                Resource
              </div>
              <div style={{flex: 1, position: 'relative', height: 26, overflow: 'hidden'}}>
                {wkHdrs.map((w, i) => {
                  const isNew = w.getDate() <= 7;
                  return (
                    <div
                      key={i}
                      data-week-header="1"
                      data-iso={toISO(w)}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: `${(i / wkHdrs.length) * 100}%`,
                        height: '100%',
                        borderLeft: `1px solid ${isNew ? '#aaa' : '#eee'}`,
                        paddingLeft: 3,
                        display: 'flex',
                        alignItems: 'center',
                      }}
                    >
                      <span
                        style={{
                          fontSize: 9,
                          whiteSpace: 'nowrap',
                          color: isNew ? '#444' : '#bbb',
                          fontWeight: isNew ? 600 : 400,
                        }}
                      >
                        {isNew ? w.toLocaleDateString('en-US', {month: 'short', day: 'numeric'}) : w.getDate()}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Today line overlay — calculated in row */}
            {RESOURCES.map((res, ri) => {
              // Visual row separation (presentational only): one strong divider
              // at the brooder -> schooner boundary and an alternating light
              // fill on schooner rows for horizontal scanning. See
              // src/lib/broilerTimelineRows.js.
              const {boundaryTop, fill} = timelineRowSeparation(ri);
              const rowBg = fill === 'shaded' ? 'var(--surface-2)' : fill === 'plain' ? 'var(--bg-card)' : null;
              const rowBatches = batches.filter((b) => {
                if (res.type === 'brooder' && b.brooder !== res.id) return false;
                if (res.type === 'schooner' && b.schooner !== res.id) return false;
                const s = res.type === 'brooder' ? b.brooderIn : b.schoonerIn;
                const e = res.type === 'brooder' ? b.brooderOut : b.schoonerOut;
                return new Date(e + 'T12:00:00') >= tlS && new Date(s + 'T12:00:00') <= tlE;
              });
              const todayPct = pct(todayISO());
              return (
                <div
                  key={res.label}
                  data-resource-row="1"
                  data-resource-type={res.type}
                  data-resource-label={res.label}
                  data-row-fill={fill}
                  data-row-divider={boundaryTop ? '1' : undefined}
                  style={{display: 'flex', borderTop: boundaryTop ? '2px solid var(--border)' : '1px solid #eee'}}
                >
                  <div
                    data-row-region="label"
                    style={{
                      width: 145,
                      flexShrink: 0,
                      padding: '0 10px',
                      display: 'flex',
                      alignItems: 'center',
                      height: 44,
                      fontSize: 11,
                      fontWeight: 600,
                      color: 'var(--ink-muted)',
                      borderRight: '1px solid var(--border)',
                      // Opaque fill so bars scrolling under the sticky label stay
                      // hidden; schooner rows alternate, brooders keep the sidebar.
                      background: rowBg || 'var(--surface-2)',
                      position: 'sticky',
                      left: 0,
                      zIndex: 10,
                    }}
                  >
                    {res.label}
                  </div>
                  <div
                    data-row-region="grid"
                    style={{flex: 1, position: 'relative', height: 44, background: rowBg || undefined}}
                  >
                    {/* week grid lines */}
                    {wkHdrs.map((_, i) => (
                      <div
                        key={i}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: `${(i / wkHdrs.length) * 100}%`,
                          height: '100%',
                          borderLeft: '1px solid #f0f0f0',
                          pointerEvents: 'none',
                        }}
                      />
                    ))}
                    {/* today line */}
                    {todayPct >= 0 && todayPct <= 100 && (
                      <div
                        data-today-line="1"
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: `${todayPct}%`,
                          height: '100%',
                          borderLeft: '2px solid rgba(8,80,65,.4)',
                          pointerEvents: 'none',
                          zIndex: 2,
                        }}
                      />
                    )}
                    {/* batch bars (broiler) */}
                    {rowBatches.map((b) => {
                      const s = res.type === 'brooder' ? b.brooderIn : b.schoonerIn;
                      const e = res.type === 'brooder' ? b.brooderOut : b.schoonerOut;
                      const left = Math.max(0, pct(s));
                      const right = Math.min(100, pct(e));
                      const w = right - left;
                      if (w < 0.3) return null;
                      const C = getBatchColor(b.name);
                      const isHovered = tooltip && tooltip.id === b.id && tooltip.type === res.type;
                      return (
                        <div
                          key={b.id}
                          onClick={() => openBroilerBatch(b)}
                          onMouseEnter={(e) => {
                            const barRect = e.currentTarget.getBoundingClientRect();
                            setTooltip({
                              id: b.id,
                              type: res.type,
                              batch: b,
                              resType: res.type,
                              vx: barRect.left + barRect.width / 2,
                              vy: barRect.top - 10,
                            });
                          }}
                          onMouseLeave={() => setTooltip(null)}
                          style={{
                            position: 'absolute',
                            left: left + '%',
                            width: w + '%',
                            top: 6,
                            bottom: 6,
                            borderRadius: 10,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            padding: '0 6px',
                            overflow: 'hidden',
                            zIndex: isHovered ? 10 : 1,
                            background: C.bg,
                            opacity: 0.8,
                            color: C.tx,
                            border: '1px solid ' + C.bd,
                            outline:
                              b.conflictOverride && b.status !== 'processed'
                                ? '2px dashed #E24B4A'
                                : isHovered
                                  ? '2px solid rgba(0,0,0,.25)'
                                  : 'none',
                            outlineOffset: '-2px',
                          }}
                        >
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              overflow: 'hidden',
                              whiteSpace: 'nowrap',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {(b.conflictOverride && b.status !== 'processed' ? '\u26a0 ' : '') + b.name}
                          </span>
                        </div>
                      );
                    })}
                    {/* Layer bars merged into the same broiler resource row */}
                    {(layerBatches || [])
                      .filter((lb) => {
                        if (lb.status !== 'active') return false;
                        if (lb.name === 'Retirement Home') return false;
                        // Strip prefix to compare with res.id
                        if (res.type === 'brooder') {
                          const lbId = (lb.brooder_name || '').replace(/^Brooder\s*/i, '').trim();
                          if (lbId !== res.id) return false;
                          if (!lb.brooder_entry_date) return false;
                          const lbStart = lb.brooder_entry_date;
                          const lbEnd = lb.brooder_exit_date || toISO(addDays(new Date(lbStart + 'T12:00:00'), 21));
                          return new Date(lbEnd + 'T12:00:00') >= tlS && new Date(lbStart + 'T12:00:00') <= tlE;
                        } else {
                          const lbId = (lb.schooner_name || '').replace(/^Schooner\s*/i, '').trim();
                          if (lbId !== res.id) return false;
                          if (!lb.schooner_entry_date) return false;
                          const lbStart = lb.schooner_entry_date;
                          const lbEnd = lb.schooner_exit_date || toISO(addDays(new Date(lbStart + 'T12:00:00'), 119));
                          return new Date(lbEnd + 'T12:00:00') >= tlS && new Date(lbStart + 'T12:00:00') <= tlE;
                        }
                      })
                      .map((lb) => {
                        const isB = res.type === 'brooder';
                        const lbStart = isB ? lb.brooder_entry_date : lb.schooner_entry_date;
                        const lbEnd = isB
                          ? lb.brooder_exit_date || toISO(addDays(new Date(lbStart + 'T12:00:00'), 21))
                          : lb.schooner_exit_date || toISO(addDays(new Date(lbStart + 'T12:00:00'), 119));
                        const left = Math.max(0, pct(lbStart));
                        const right = Math.min(100, pct(lbEnd));
                        const w = right - left;
                        if (w < 0.3) return null;
                        const C = getBatchColor(lb.name);
                        const isHov = tooltip && tooltip.lbId === lb.id && tooltip.barKey === (isB ? 'b' : 's');
                        return (
                          <div
                            key={'lb-' + lb.id + '-' + res.id}
                            onClick={() => {
                              if (setPendingEdit) setPendingEdit({id: lb.id, viewName: 'layerbatches'});
                              setView && setView('layerbatches');
                            }}
                            onMouseEnter={(e) => {
                              const r = e.currentTarget.getBoundingClientRect();
                              setTooltip({
                                lbId: lb.id,
                                barKey: isB ? 'b' : 's',
                                lb,
                                bar: {
                                  label: isB ? 'Brooder' : 'Schooner',
                                  start: lbStart,
                                  end: lbEnd,
                                  resName: isB ? lb.brooder_name : lb.schooner_name,
                                },
                                vx: r.left + r.width / 2,
                                vy: r.top - 10,
                                type: 'layer',
                              });
                            }}
                            onMouseLeave={() => setTooltip(null)}
                            style={{
                              position: 'absolute',
                              left: left + '%',
                              width: w + '%',
                              top: 6,
                              bottom: 6,
                              borderRadius: 10,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              padding: '0 6px',
                              overflow: 'hidden',
                              zIndex: isHov ? 10 : 1,
                              background: C.bg,
                              opacity: 0.8,
                              color: C.tx,
                              border: '2px solid #f59e0b',
                              outline: isHov ? '2px solid rgba(0,0,0,.25)' : 'none',
                              outlineOffset: '-2px',
                            }}
                          >
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                overflow: 'hidden',
                                whiteSpace: 'nowrap',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {'\ud83e\udd5a ' + lb.name}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Legend */}
        <div style={{display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap', alignItems: 'center'}}>
          <span style={{fontSize: 11, color: 'var(--ink-faint)'}}>
            Each batch has its own color {'\u00b7'} brooder and schooner phases share the same color {'\u00b7'} amber
            border = layer batch ({'\ud83e\udd5a'}) {'\u00b7'} click any bar to edit {'\u00b7'} green line = today
          </span>
        </div>

        {batches.length === 0 && (
          <div style={{textAlign: 'center', padding: '3rem', color: 'var(--ink-faint)', fontSize: 13}}>
            No batches yet — click "+ Add Batch" to get started
          </div>
        )}
      </div>
    </div>
  );
}
