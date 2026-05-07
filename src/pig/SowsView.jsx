// ============================================================================
// src/pig/SowsView.jsx  —  Phase 2 Round 6
// ----------------------------------------------------------------------------
// Breeding pigs tab — sow/boar registry + archived records. Breeder form
// state comes from usePig(); persistBreeders is still an App helper and
// comes in as a prop.
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {fmt, fmtS, todayISO, addDays} from '../lib/dateUtils.js';
import {S} from '../lib/styles.js';
import {calcBreedingTimeline, buildCycleSeqMap, cycleLabel, PIG_GROUPS, PIG_GROUP_COLORS} from '../lib/pig.js';
import UsersModal from '../auth/UsersModal.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {usePig} from '../contexts/PigContext.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';

export default function SowsView({
  Header,
  loadUsers,
  persistBreeders,
  persistBreedOptions,
  persistOriginOptions,
  confirmDelete,
  resolveSire,
}) {
  const [leaderboardExpanded, setLeaderboardExpanded] = React.useState(false);
  const [showArchived, setShowArchived] = React.useState(false);
  const {authState, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const {
    breedingCycles,
    farrowingRecs,
    boarNames,
    breeders,
    setBreeders,
    breederForm,
    setBreederForm,
    showBreederForm,
    setShowBreederForm,
    editBreederId,
    setEditBreederId,
    breedOptions,
    setBreedOptions,
    originOptions,
    setOriginOptions,
    sowSearch,
    setSowSearch,
    expandedSow,
    setExpandedSow,
  } = usePig();
  const {pigDailys} = useDailysRecent();
  const {setView} = useUI();
  const cycleSeqMap = buildCycleSeqMap(breedingCycles);
  // ── Helpers ──
  function pigAge(birthDate) {
    if (!birthDate) return '—';
    const b = new Date(birthDate + 'T12:00:00');
    const t = new Date();
    const days = Math.round((t - b) / 86400000);
    if (days < 0) return '—';
    const y = Math.floor(days / 365),
      rem = days % 365,
      m = Math.floor(rem / 30),
      d = rem % 30;
    if (y > 0) return `${y}y ${m}m`;
    if (m > 0) return `${m}m ${d}d`;
    return `${d}d`;
  }

  function sowFarrowStats(tag) {
    const recs = farrowingRecs.filter((r) => r.sow.trim() === String(tag).trim());
    const born = recs.reduce((s, r) => s + (parseInt(r.totalBorn) || 0), 0);
    const dead = recs.reduce((s, r) => s + (parseInt(r.deaths) || 0), 0);
    return {litters: recs.length, alive: born - dead, born};
  }

  // resolveSire is defined above (shared between farrowing + sows views)

  // Sort: group first (blank last), then tag numerically
  function sortPigs(list) {
    return [...list].sort((a, b) => {
      const ga = a.group || '99',
        gb = b.group || '99';
      if (ga !== gb) return ga.localeCompare(gb, undefined, {numeric: true});
      return (parseFloat(a.tag) || 0) - (parseFloat(b.tag) || 0);
    });
  }

  const activePigs = sortPigs(breeders.filter((p) => !p.archived));
  const archivedPigs = sortPigs(breeders.filter((p) => p.archived));
  const activeSows = activePigs.filter((p) => p.sex === 'Sow' || p.sex === 'Gilt');
  const activeBoars = activePigs.filter((p) => p.sex === 'Boar');

  // Leaderboard
  const leaderboard = activeSows
    .map((p) => {
      const s = sowFarrowStats(p.tag);
      return {...p, ...s};
    })
    .filter((p) => p.litters > 0)
    .sort((a, b) => b.alive - a.alive);

  // Custom options helpers
  function addBreedOption(val) {
    const v = val.trim();
    if (!v || breedOptions.includes(v)) return;
    const nb = [...breedOptions, v];
    setBreedOptions(nb);
    persistBreedOptions(nb);
  }
  function addOriginOption(val) {
    const v = val.trim();
    if (!v || originOptions.includes(v)) return;
    const nb = [...originOptions, v];
    setOriginOptions(nb);
    persistOriginOptions(nb);
  }

  function saveBreeder() {
    if (!breederForm.tag.trim()) {
      alert('Please enter a tag number.');
      return;
    }
    const dup = breeders.find((b) => b.tag.trim() === breederForm.tag.trim() && b.id !== editBreederId);
    if (dup) {
      alert(`Tag #${breederForm.tag} already exists.`);
      return;
    }
    const pig = {
      id: editBreederId || String(Date.now()),
      ...breederForm,
      archived:
        breederForm.status === 'Deceased' || breederForm.status === 'Processed' || breederForm.status === 'Sold',
    };
    const nb = editBreederId ? breeders.map((b) => (b.id === editBreederId ? pig : b)) : [...breeders, pig];
    setBreeders(nb);
    persistBreeders(nb);
    setShowBreederForm(false);
    setEditBreederId(null);
  }

  const STATUS_OPTS = ['Sow Group', 'Boar Group', 'Deceased', 'Processed', 'Sold'];
  const SEX_OPTS = ['Sow', 'Gilt', 'Boar'];

  // CustomSelect component for breed/origin with add-new
  function CustomSelect({value, onChange, options, onAdd, placeholder}) {
    const [adding, setAdding] = React.useState(false);
    const [newVal, setNewVal] = React.useState('');
    return (
      <div>
        {!adding ? (
          <div style={{display: 'flex', gap: 6}}>
            <select value={value} onChange={onChange} style={{flex: 1}}>
              <option value="">{placeholder || 'Select...'}</option>
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setAdding(true)}
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid #d1d5db',
                background: 'white',
                cursor: 'pointer',
                fontSize: 12,
                color: '#085041',
                whiteSpace: 'nowrap',
              }}
            >
              + Add
            </button>
          </div>
        ) : (
          <div style={{display: 'flex', gap: 6}}>
            <input
              autoFocus
              value={newVal}
              onChange={(e) => setNewVal(e.target.value)}
              placeholder="New option..."
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onAdd(newVal);
                  onChange({target: {value: newVal}});
                  setAdding(false);
                  setNewVal('');
                }
              }}
            />
            <button
              type="button"
              onClick={() => {
                onAdd(newVal);
                onChange({target: {value: newVal}});
                setAdding(false);
                setNewVal('');
              }}
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                border: 'none',
                background: '#085041',
                color: 'white',
                cursor: 'pointer',
                fontSize: 12,
                whiteSpace: 'nowrap',
              }}
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setNewVal('');
              }}
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid #d1d5db',
                background: 'white',
                cursor: 'pointer',
                fontSize: 12,
                color: '#4b5563',
              }}
            >
              ✕
            </button>
          </div>
        )}
      </div>
    );
  }

  // Build farrowing history for a sow: each cycle she was in, with farrowing record or "missed"
  function sowFarrowHistory(tag) {
    var tagStr = String(tag).trim();
    var history = [];
    breedingCycles.forEach(function (c) {
      var allTags = [...(c.boar1Tags || '').split(/[\n,]+/), ...(c.boar2Tags || '').split(/[\n,]+/)]
        .map(function (t) {
          return t.trim();
        })
        .filter(Boolean);
      if (!allTags.includes(tagStr)) return;
      var tl = calcBreedingTimeline(c.exposureStart);
      if (!tl) return;
      // Find farrowing record for this sow in this cycle's window
      var rec = farrowingRecs.find(function (r) {
        if (r.sow.trim() !== tagStr) return false;
        if (!r.farrowingDate) return false;
        var rd = new Date(r.farrowingDate + 'T12:00:00');
        return (
          rd >= new Date(tl.farrowingStart + 'T12:00:00') && rd <= addDays(new Date(tl.farrowingEnd + 'T12:00:00'), 14)
        );
      });
      var b1Tags2 = (c.boar1Tags || '')
        .split(/[\n,]+/)
        .map(function (t) {
          return t.trim();
        })
        .filter(Boolean);
      var sire = rec
        ? resolveSire(rec)
        : b1Tags2.includes(tagStr)
          ? c.boar1Name || boarNames.boar1
          : c.boar2Name || boarNames.boar2;
      history.push({cycle: c, tl: tl, rec: rec, sire: sire || null, missed: !rec});
    });
    // Add any farrowing records not matched to a cycle above
    var matchedRecIds = new Set(
      history
        .filter(function (h2) {
          return h2.rec;
        })
        .map(function (h2) {
          return h2.rec.id;
        }),
    );
    farrowingRecs
      .filter(function (r) {
        return r.sow.trim() === tagStr && !matchedRecIds.has(r.id);
      })
      .forEach(function (r) {
        history.push({cycle: null, tl: null, rec: r, sire: resolveSire(r), missed: false});
      });
    // Sort newest first by farrowing date or cycle exposure date
    history.sort(function (a, b) {
      var da = a.rec ? a.rec.farrowingDate : a.cycle ? a.cycle.exposureStart : '';
      var db = b.rec ? b.rec.farrowingDate : b.cycle ? b.cycle.exposureStart : '';
      return (db || '').localeCompare(da || '');
    });
    return history;
  }

  function PigTile({pig}) {
    const stats = sowFarrowStats(pig.tag);
    const C = pig.group ? PIG_GROUP_COLORS[pig.group] : null;
    const isSow = pig.sex === 'Sow' || pig.sex === 'Gilt';
    const history = isSow ? sowFarrowHistory(pig.tag) : [];
    // Breeding-pig weights are entered ONLY on the tile (Ronnie's rule).
    // Each entry = {weight, date}. lastWeight is kept in sync for stats.
    const [wInput, setWInput] = React.useState('');
    const [wBusy, setWBusy] = React.useState(false);
    const weighins = Array.isArray(pig.weighins) ? pig.weighins : [];
    async function recordWeight() {
      const w = parseFloat(wInput);
      if (!Number.isFinite(w) || w <= 0) return;
      setWBusy(true);
      const entry = {weight: w, date: todayISO()};
      const nextWeighins = [...weighins, entry];
      const nb = breeders.map((b) => (b.id === pig.id ? {...b, weighins: nextWeighins, lastWeight: w} : b));
      setBreeders(nb);
      persistBreeders(nb);
      setWInput('');
      setWBusy(false);
    }
    const latestWeight = weighins.length > 0 ? weighins[weighins.length - 1].weight : pig.lastWeight;
    return (
      <div
        style={{
          background: 'white',
          border: '1px solid #e5e7eb',
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: '0 1px 4px rgba(0,0,0,.06)',
        }}
      >
        {/* Tile header */}
        <div
          onClick={() => {
            setBreederForm({
              tag: pig.tag,
              sex: pig.sex,
              group: pig.group,
              status: pig.status,
              breed: pig.breed,
              origin: pig.origin,
              birthDate: pig.birthDate,
              lastWeight: pig.lastWeight,
              purchaseDate: pig.purchaseDate,
              purchaseAmount: pig.purchaseAmount,
              notes: pig.notes || '',
            });
            setEditBreederId(pig.id);
            setShowBreederForm(true);
          }}
          style={{padding: '12px 16px', background: 'white', borderBottom: '1px solid #e5e7eb', cursor: 'pointer'}}
        >
          <div style={{fontSize: 16, fontWeight: 700, color: '#111827'}}>
            #{pig.tag} <span style={{fontSize: 12, fontWeight: 400, color: '#6b7280'}}>{pig.sex}</span>
          </div>
          <div style={{fontSize: 11, color: '#9ca3af', marginTop: 2}}>
            {pig.breed || '\u2014'} {'\u00b7'} {pigAge(pig.birthDate)}
            {(pig.status === 'Deceased' || pig.status === 'Processed' || pig.status === 'Sold') && (
              <span
                style={{
                  marginLeft: 6,
                  padding: '1px 7px',
                  borderRadius: 10,
                  background: '#374151',
                  color: 'white',
                  fontSize: 10,
                  fontWeight: 600,
                }}
              >
                {pig.status}
              </span>
            )}
          </div>
        </div>
        {/* Stats grid */}
        <div style={{padding: '10px 16px', display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8}}>
          {latestWeight && (
            <div>
              <div style={{fontSize: 10, color: '#9ca3af'}}>Last Weight</div>
              <div style={{fontSize: 15, fontWeight: 600, color: '#111827'}}>{latestWeight} lbs</div>
            </div>
          )}
          {isSow && (
            <div>
              <div style={{fontSize: 10, color: '#9ca3af'}}>Litters</div>
              <div style={{fontSize: 15, fontWeight: 600, color: '#111827'}}>{stats.litters}</div>
            </div>
          )}
          {isSow && (
            <div>
              <div style={{fontSize: 10, color: '#9ca3af'}}>Alive Total</div>
              <div style={{fontSize: 15, fontWeight: 600, color: '#065f46'}}>{stats.alive}</div>
            </div>
          )}
        </div>
        {/* Weight entry + history (breeding-pig only — Ronnie's spec) */}
        <div style={{padding: '8px 16px', borderTop: '1px solid #f3f4f6'}}>
          <div style={{display: 'flex', gap: 6, alignItems: 'center'}}>
            <input
              type="number"
              min="0"
              step="0.1"
              placeholder="Weight (lbs)"
              value={wInput}
              onChange={(e) => setWInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') recordWeight();
              }}
              style={{
                flex: 1,
                fontSize: 13,
                padding: '6px 10px',
                border: '1px solid #d1d5db',
                borderRadius: 6,
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
            />
            <button
              onClick={recordWeight}
              disabled={wBusy || !wInput}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: 'none',
                background: wBusy || !wInput ? '#9ca3af' : '#085041',
                color: 'white',
                fontSize: 12,
                fontWeight: 600,
                cursor: wBusy || !wInput ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              + Record
            </button>
          </div>
          {weighins.length > 0 && (
            <div
              style={{marginTop: 6, fontSize: 11, color: '#6b7280', display: 'flex', flexWrap: 'wrap', gap: '2px 10px'}}
            >
              {weighins
                .slice()
                .reverse()
                .slice(0, 6)
                .map((w, wi) => (
                  <span key={wi}>
                    <strong style={{color: '#111827'}}>{w.weight} lb</strong>{' '}
                    <span style={{color: '#9ca3af'}}>{fmtS(w.date)}</span>
                  </span>
                ))}
              {weighins.length > 6 && <span style={{color: '#9ca3af'}}>+{weighins.length - 6} more</span>}
            </div>
          )}
        </div>
        {/* Farrowing history */}
        {isSow && history.length > 0 && (
          <div style={{borderTop: '1px solid #f3f4f6', padding: '8px 16px 10px'}}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: '#6b7280',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                marginBottom: 6,
              }}
            >
              Farrowing History
            </div>
            {history
              .filter(function (h2) {
                // Hide "missed" entries until farrowing window has closed
                if (h2.missed && h2.tl && h2.tl.farrowingEnd >= todayISO()) return false;
                return true;
              })
              .map(function (h, hi) {
                if (h.missed) {
                  return React.createElement(
                    'div',
                    {
                      key: hi,
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '4px 0',
                        borderBottom: hi < history.length - 1 ? '1px solid #f8f8f8' : 'none',
                        fontSize: 11,
                      },
                    },
                    React.createElement(
                      'span',
                      {
                        style: {
                          color: '#b91c1c',
                          fontWeight: 600,
                          background: '#fef2f2',
                          padding: '1px 6px',
                          borderRadius: 4,
                          fontSize: 10,
                        },
                      },
                      'MISSED',
                    ),
                    React.createElement(
                      'span',
                      {style: {color: '#6b7280'}},
                      cycleLabel(h.cycle, cycleSeqMap) + ' \u00b7 ' + fmt(h.cycle.exposureStart),
                    ),
                    h.sire && React.createElement('span', {style: {color: '#9ca3af'}}, '\u00b7 Sire: ' + h.sire),
                  );
                }
                var born = parseInt(h.rec.totalBorn) || 0;
                var dead = parseInt(h.rec.deaths) || 0;
                var alive = born - dead;
                return React.createElement(
                  'div',
                  {
                    key: hi,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '4px 0',
                      borderBottom: hi < history.length - 1 ? '1px solid #f8f8f8' : 'none',
                      fontSize: 11,
                      flexWrap: 'wrap',
                    },
                  },
                  React.createElement(
                    'span',
                    {style: {color: '#374151', fontWeight: 600, minWidth: 90}},
                    fmt(h.rec.farrowingDate),
                  ),
                  React.createElement('span', {style: {color: '#065f46', fontWeight: 600}}, alive + ' alive'),
                  React.createElement('span', {style: {color: '#9ca3af'}}, born + ' born'),
                  dead > 0 && React.createElement('span', {style: {color: '#b91c1c'}}, dead + ' died'),
                  h.cycle && React.createElement('span', {style: {color: '#9ca3af'}}, cycleLabel(h.cycle, cycleSeqMap)),
                  h.sire && React.createElement('span', {style: {color: '#9ca3af'}}, '\u00b7 ' + h.sire),
                );
              })}
          </div>
        )}
        {pig.transferredFromBatch &&
          (() => {
            const tfb = pig.transferredFromBatch;
            const sourceLabel = tfb.subBatchName || tfb.batchName || '?';
            const dateStr = tfb.transferDate ? ' on ' + fmtS(tfb.transferDate) : '';
            const sexNoun = pig.sex === 'Boar' ? 'boar' : pig.sex === 'Sow' ? 'sow' : 'gilt';
            return (
              <div
                style={{
                  margin: '0 16px 10px',
                  padding: '6px 10px',
                  background: '#f5f3ff',
                  border: '1px solid #ddd6fe',
                  borderRadius: 6,
                  fontSize: 11,
                  color: '#5b21b6',
                  fontWeight: 600,
                }}
              >
                {'This ' + sexNoun + ' was saved from ' + sourceLabel + dateStr + '.'}
              </div>
            );
          })()}
        {pig.notes && (
          <div style={{padding: '0 16px 10px', fontSize: 11, color: '#6b7280', fontStyle: 'italic'}}>{pig.notes}</div>
        )}
      </div>
    );
  }

  return (
    <div>
      <Header />
      <div style={{padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1.25rem'}}>
        {/* Sow Leaderboard */}
        {leaderboard.length > 0 && (
          <div
            style={{
              background: 'white',
              border: '1px solid #e5e7eb',
              borderRadius: 12,
              overflow: 'hidden',
              boxShadow: '0 1px 4px rgba(0,0,0,.06)',
            }}
          >
            <div
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid #e5e7eb',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: '#f8fafb',
              }}
            >
              <div style={{fontWeight: 600, fontSize: 14}}>
                {'\ud83c\udfc6 Sow Leaderboard \u2014 Most Alive Piglets'}
              </div>
              {leaderboard.length > 5 && (
                <button
                  onClick={() => setLeaderboardExpanded((e) => !e)}
                  style={{fontSize: 12, color: '#085041', background: 'none', border: 'none', cursor: 'pointer'}}
                >
                  {leaderboardExpanded ? 'Show top 5' : 'Show all ' + leaderboard.length}
                </button>
              )}
            </div>
            <div style={{padding: '10px 16px'}}>
              {(leaderboardExpanded ? leaderboard : leaderboard.slice(0, 5)).map((p, i) => (
                <div
                  key={p.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '7px 0',
                    borderBottom:
                      i < (leaderboardExpanded ? leaderboard.length - 1 : Math.min(4, leaderboard.length - 1))
                        ? '1px solid #f0f0f0'
                        : 'none',
                  }}
                >
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 12,
                      background: i === 0 ? '#f59e0b' : i === 1 ? '#9ca3af' : i === 2 ? '#cd7c4b' : '#e5e7eb',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      fontWeight: 700,
                      color: i < 3 ? 'white' : '#6b7280',
                      flexShrink: 0,
                    }}
                  >
                    {i + 1}
                  </div>
                  <div style={{flex: 1}}>
                    <span style={{fontWeight: 600}}>Sow #{p.tag}</span>
                    <span style={{fontSize: 11, color: '#9ca3af', marginLeft: 8}}>
                      {p.litters} litter{p.litters !== 1 ? 's' : ' '} {'\u00b7'} {p.born} born
                    </span>
                  </div>
                  <div style={{fontSize: 16, fontWeight: 700, color: '#065f46'}}>{p.alive} alive</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Boar Leaderboard */}
        {(function () {
          var boarStats = {};
          farrowingRecs.forEach(function (r) {
            var sire = (resolveSire(r) || '').trim();
            if (!sire) return;
            if (!boarStats[sire]) boarStats[sire] = {name: sire, litters: 0, born: 0, dead: 0, alive: 0};
            boarStats[sire].litters++;
            var b = parseInt(r.totalBorn) || 0;
            var d = parseInt(r.deaths) || 0;
            boarStats[sire].born += b;
            boarStats[sire].dead += d;
            boarStats[sire].alive += b - d;
          });
          var boarBoard = Object.values(boarStats).sort(function (a, b) {
            return b.alive - a.alive;
          });
          if (boarBoard.length === 0) return null;
          return React.createElement(
            'div',
            {
              style: {
                background: 'white',
                border: '1px solid #e5e7eb',
                borderRadius: 12,
                overflow: 'hidden',
                boxShadow: '0 1px 4px rgba(0,0,0,.06)',
              },
            },
            React.createElement(
              'div',
              {style: {padding: '12px 16px', borderBottom: '1px solid #e5e7eb', background: '#f8fafb'}},
              React.createElement(
                'div',
                {style: {fontWeight: 600, fontSize: 14}},
                '\ud83c\udfc6 Boar Leaderboard \u2014 Most Alive Piglets',
              ),
            ),
            React.createElement(
              'div',
              {style: {padding: '10px 16px'}},
              boarBoard.map(function (b, i) {
                var survPct = b.born > 0 ? Math.round((b.alive / b.born) * 100) : 0;
                return React.createElement(
                  'div',
                  {
                    key: b.name,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '7px 0',
                      borderBottom: i < boarBoard.length - 1 ? '1px solid #f0f0f0' : 'none',
                    },
                  },
                  React.createElement(
                    'div',
                    {
                      style: {
                        width: 24,
                        height: 24,
                        borderRadius: 12,
                        background: i === 0 ? '#f59e0b' : i === 1 ? '#9ca3af' : '#e5e7eb',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 11,
                        fontWeight: 700,
                        color: i < 2 ? 'white' : '#6b7280',
                        flexShrink: 0,
                      },
                    },
                    String(i + 1),
                  ),
                  React.createElement(
                    'div',
                    {style: {flex: 1}},
                    React.createElement('span', {style: {fontWeight: 600}}, b.name),
                    React.createElement(
                      'span',
                      {style: {fontSize: 11, color: '#9ca3af', marginLeft: 8}},
                      b.litters +
                        ' litter' +
                        (b.litters !== 1 ? 's' : '') +
                        ' \u00b7 ' +
                        b.born +
                        ' born \u00b7 ' +
                        survPct +
                        '% survival',
                    ),
                  ),
                  React.createElement(
                    'div',
                    {style: {fontSize: 16, fontWeight: 700, color: '#065f46'}},
                    b.alive + ' alive',
                  ),
                );
              }),
            ),
          );
        })()}

        {/* Add pig button */}
        <div style={{display: 'flex', justifyContent: 'flex-end'}}>
          <button
            onClick={() => {
              setBreederForm({
                tag: '',
                sex: 'Sow',
                group: '1',
                status: 'Sow Group',
                breed: '',
                origin: '',
                birthDate: '',
                lastWeight: '',
                purchaseDate: '',
                purchaseAmount: '',
                notes: '',
              });
              setEditBreederId(null);
              setShowBreederForm(true);
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
            + Add Pig
          </button>
        </div>

        {/* Add/Edit form — modal overlay */}
        {showBreederForm && (
          <div
            onClick={() => {
              setShowBreederForm(false);
              setEditBreederId(null);
            }}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0,0,0,.45)',
              zIndex: 500,
              display: 'flex',
              alignItems: 'center',
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
                maxWidth: 640,
                boxShadow: '0 8px 32px rgba(0,0,0,.2)',
                maxHeight: '90vh',
                overflowY: 'auto',
              }}
            >
              <div
                style={{
                  padding: '14px 20px',
                  borderBottom: '1px solid #e5e7eb',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  position: 'sticky',
                  top: 0,
                  background: 'white',
                  zIndex: 1,
                }}
              >
                <div style={{fontSize: 15, fontWeight: 600, color: '#085041'}}>
                  {editBreederId ? 'Edit Breeding Pig' : 'Add Breeding Pig'}
                </div>
                <button
                  onClick={() => {
                    setShowBreederForm(false);
                    setEditBreederId(null);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: 22,
                    cursor: 'pointer',
                    color: '#9ca3af',
                    lineHeight: 1,
                    padding: '0 4px',
                  }}
                >
                  ×
                </button>
              </div>
              <div style={{padding: '16px 20px'}}>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10}}>
                  <div>
                    <label style={S.label}>Tag #</label>
                    <input
                      value={breederForm.tag}
                      onChange={(e) => setBreederForm({...breederForm, tag: e.target.value})}
                      placeholder="e.g. 5"
                    />
                  </div>
                  <div>
                    <label style={S.label}>Sex</label>
                    <select
                      value={breederForm.sex}
                      onChange={(e) => setBreederForm({...breederForm, sex: e.target.value})}
                    >
                      {SEX_OPTS.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={S.label}>Group</label>
                    <select
                      value={breederForm.group}
                      onChange={(e) => setBreederForm({...breederForm, group: e.target.value})}
                    >
                      <option value="">No group</option>
                      {PIG_GROUPS.map((g) => (
                        <option key={g} value={g}>
                          Group {g}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={S.label}>Status</label>
                    <select
                      value={breederForm.status}
                      onChange={(e) => setBreederForm({...breederForm, status: e.target.value})}
                    >
                      {STATUS_OPTS.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={S.label}>Breed</label>
                    <CustomSelect
                      value={breederForm.breed}
                      onChange={(e) => setBreederForm({...breederForm, breed: e.target.value})}
                      options={breedOptions}
                      onAdd={addBreedOption}
                      placeholder="Select breed..."
                    />
                  </div>
                  <div>
                    <label style={S.label}>Origin</label>
                    <CustomSelect
                      value={breederForm.origin}
                      onChange={(e) => setBreederForm({...breederForm, origin: e.target.value})}
                      options={originOptions}
                      onAdd={addOriginOption}
                      placeholder="Select origin..."
                    />
                  </div>
                  <div>
                    <label style={S.label}>Birth Date</label>
                    <input
                      type="date"
                      value={breederForm.birthDate}
                      onChange={(e) => setBreederForm({...breederForm, birthDate: e.target.value})}
                    />
                  </div>
                  <div>
                    <label style={S.label}>Last Recorded Weight (lbs)</label>
                    <input
                      type="number"
                      value={breederForm.lastWeight || ''}
                      onChange={(e) => setBreederForm({...breederForm, lastWeight: e.target.value})}
                    />
                  </div>
                  <div>
                    <label style={S.label}>Purchase Date</label>
                    <input
                      type="date"
                      value={breederForm.purchaseDate}
                      onChange={(e) => setBreederForm({...breederForm, purchaseDate: e.target.value})}
                    />
                  </div>
                  <div>
                    <label style={S.label}>Purchase Amount ($)</label>
                    <input
                      type="number"
                      value={breederForm.purchaseAmount || ''}
                      onChange={(e) => setBreederForm({...breederForm, purchaseAmount: e.target.value})}
                    />
                  </div>
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={S.label}>Notes</label>
                    <textarea
                      rows={2}
                      value={breederForm.notes}
                      onChange={(e) => setBreederForm({...breederForm, notes: e.target.value})}
                      placeholder="e.g. reason for status change, health notes..."
                    />
                  </div>
                </div>
                {breederForm.birthDate && (
                  <div style={{marginTop: 8, fontSize: 12, color: '#065f46'}}>Age: {pigAge(breederForm.birthDate)}</div>
                )}
                <div style={{display: 'flex', gap: 8, marginTop: 12}}>
                  <button onClick={saveBreeder} style={{...S.btnPrimary, width: 'auto', padding: '8px 20px'}}>
                    {editBreederId ? 'Save changes' : 'Add pig'}
                  </button>
                  {editBreederId && (
                    <button
                      onClick={() => {
                        confirmDelete('Delete this pig permanently? This cannot be undone.', () => {
                          const nb = breeders.filter((b) => b.id !== editBreederId);
                          setBreeders(nb);
                          persistBreeders(nb);
                          setShowBreederForm(false);
                          setEditBreederId(null);
                        });
                      }}
                      style={S.btnDanger}
                    >
                      Delete
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setShowBreederForm(false);
                      setEditBreederId(null);
                    }}
                    style={S.btnGhost}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Sows/Gilts — grouped by group with color headers */}
        {activeSows.length > 0 && (
          <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
            {(() => {
              const groups = [...new Set(activeSows.map((p) => p.group || 'none'))].sort((a, b) =>
                a === 'none' ? 1 : b === 'none' ? -1 : a.localeCompare(b, undefined, {numeric: true}),
              );
              return groups.map((grp) => {
                const pigs = activeSows.filter((p) => (p.group || 'none') === grp);
                const C = grp !== 'none' ? PIG_GROUP_COLORS[grp] : null;
                return (
                  <div
                    key={grp}
                    style={{
                      border: '1px solid #e5e7eb',
                      borderRadius: 12,
                      overflow: 'hidden',
                      boxShadow: '0 1px 3px rgba(0,0,0,.05)',
                    }}
                  >
                    <div
                      style={{
                        padding: '10px 16px',
                        background: C ? C.farrowing : '#f3f4f6',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                      }}
                    >
                      <span style={{fontWeight: 700, fontSize: 13, color: C ? 'white' : '#374151'}}>
                        {grp !== 'none' ? `Group ${grp}` : 'No Group'}
                      </span>
                      <span style={{fontSize: 12, color: C ? 'rgba(255,255,255,.75)' : '#9ca3af'}}>
                        {pigs.length} sow{pigs.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <div
                      style={{
                        padding: '10px',
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))',
                        gap: 8,
                        background: '#fafafa',
                      }}
                    >
                      {pigs.map((p) => (
                        <PigTile key={p.id} pig={p} />
                      ))}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        )}

        {/* Boars section */}
        {activeBoars.length > 0 && (
          <div
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: 12,
              overflow: 'hidden',
              boxShadow: '0 1px 3px rgba(0,0,0,.05)',
            }}
          >
            <div style={{padding: '10px 16px', background: '#1e40af', display: 'flex', alignItems: 'center', gap: 10}}>
              <span style={{fontWeight: 700, fontSize: 13, color: 'white'}}>Boars</span>
              <span style={{fontSize: 12, color: 'rgba(255,255,255,.75)'}}>
                {activeBoars.length} boar{activeBoars.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div
              style={{
                padding: '10px',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))',
                gap: 8,
                background: '#fafafa',
              }}
            >
              {activeBoars.map((p) => (
                <PigTile key={p.id} pig={p} />
              ))}
            </div>
          </div>
        )}

        {/* Archived */}
        {archivedPigs.length > 0 && (
          <div>
            <button
              onClick={() => setShowArchived((s) => !s)}
              style={{
                fontSize: 12,
                color: '#9ca3af',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '4px 0',
                letterSpacing: 0.3,
              }}
            >
              {showArchived ? '▼' : '▶'} ARCHIVED ({archivedPigs.length})
            </button>
            {showArchived && (
              <div
                style={{
                  marginTop: 8,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))',
                  gap: 10,
                  opacity: 0.7,
                }}
              >
                {archivedPigs.map((p) => (
                  <PigTile key={p.id} pig={p} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── FEED CONSUMPTION ── */}
        {(() => {
          // Aggregate feed from pig_dailys for SOWS and BOARS by month
          const sowDailys = pigDailys.filter((d) => d.batch_label?.toUpperCase() === 'SOWS');
          const boarDailys = pigDailys.filter((d) => d.batch_label?.toUpperCase() === 'BOARS');

          function monthlyFeed(dailys) {
            const byMonth = {};
            dailys.forEach((d) => {
              if (!d.date || !d.feed_lbs) return;
              const ym = d.date.slice(0, 7);
              byMonth[ym] = (byMonth[ym] || 0) + parseFloat(d.feed_lbs);
            });
            return Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0]));
          }

          const sowMonths = monthlyFeed(sowDailys);
          const boarMonths = monthlyFeed(boarDailys);
          const sowTotal = sowDailys.reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);
          const boarTotal = boarDailys.reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);

          if (sowMonths.length === 0 && boarMonths.length === 0) return null;

          const fmtMonth = (ym) => {
            const [y, m] = ym.split('-');
            return new Date(parseInt(y), parseInt(m) - 1, 1).toLocaleDateString('en-US', {
              month: 'short',
              year: 'numeric',
            });
          };

          return (
            <div
              style={{
                background: 'white',
                border: '1px solid #e5e7eb',
                borderRadius: 12,
                overflow: 'hidden',
                boxShadow: '0 1px 4px rgba(0,0,0,.06)',
              }}
            >
              <div
                style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid #e5e7eb',
                  background: '#f8fafb',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div style={{fontWeight: 600, fontSize: 14}}>🌾 Feed Consumption — Breeding Stock</div>
              </div>
              <div style={{padding: '16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16}}>
                {/* SOWS */}
                <div>
                  <div style={{fontSize: 13, fontWeight: 700, color: '#085041', marginBottom: 8}}>SOWS</div>
                  <div style={{fontSize: 11, color: '#6b7280', marginBottom: 10}}>
                    Total: <strong style={{color: '#111827'}}>{Math.round(sowTotal).toLocaleString()} lbs</strong> from{' '}
                    {sowDailys.length} reports
                  </div>
                  {sowMonths.slice(0, 12).map(([ym, lbs]) => (
                    <div
                      key={ym}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        padding: '4px 0',
                        borderBottom: '1px solid #f5f5f5',
                        fontSize: 12,
                      }}
                    >
                      <span style={{color: '#6b7280'}}>{fmtMonth(ym)}</span>
                      <span style={{fontWeight: 600, color: '#085041'}}>{Math.round(lbs).toLocaleString()} lbs</span>
                    </div>
                  ))}
                </div>
                {/* BOARS */}
                <div>
                  <div style={{fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8}}>BOARS</div>
                  <div style={{fontSize: 11, color: '#6b7280', marginBottom: 10}}>
                    Total: <strong style={{color: '#111827'}}>{Math.round(boarTotal).toLocaleString()} lbs</strong> from{' '}
                    {boarDailys.length} reports
                  </div>
                  {boarMonths.slice(0, 12).map(([ym, lbs]) => (
                    <div
                      key={ym}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        padding: '4px 0',
                        borderBottom: '1px solid #f5f5f5',
                        fontSize: 12,
                      }}
                    >
                      <span style={{color: '#6b7280'}}>{fmtMonth(ym)}</span>
                      <span style={{fontWeight: 600, color: '#374151'}}>{Math.round(lbs).toLocaleString()} lbs</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
