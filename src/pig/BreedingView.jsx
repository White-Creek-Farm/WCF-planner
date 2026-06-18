// ============================================================================
// src/pig/BreedingView.jsx  —  Phase 2 Round 6
// ----------------------------------------------------------------------------
// Breeding Gantt view for pig cycles. Form state + the cycle array come
// from usePig(); the persist helper + auto-save ref still live in App and
// come in as props (persistBreeding, breedAutoSaveTimer).
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {openableProps} from '../shared/openable.js';
import {fmt, fmtS, todayISO, addDays, toISO} from '../lib/dateUtils.js';
import {S} from '../lib/styles.js';
import {
  calcBreedingTimeline,
  calcCycleStatus,
  buildCycleSeqMap,
  cycleLabel,
  PIG_GROUPS,
  PIG_GROUP_COLORS,
  getReadableText,
} from '../lib/pig.js';
import {programDotStyle, getProgramColor} from '../lib/programColors.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import Badge from '../shared/Badge.jsx';
import UsersModal from '../auth/UsersModal.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {usePig} from '../contexts/PigContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';

export default function BreedingView({Header, loadUsers, persistBreeding, breedAutoSaveTimer, confirmDelete}) {
  const {authState, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const [tooltip, setTooltip] = React.useState(null);
  const {
    breedingCycles,
    setBreedingCycles,
    boarNames,
    breedTlStart,
    setBreedTlStart,
    breedForm,
    setBreedForm,
    showBreedForm,
    setShowBreedForm,
    editBreedId,
    setEditBreedId,
    breeders,
  } = usePig();
  const {setView} = useUI();
  const BREED_WEEKS = 104;
  const btlS = new Date(breedTlStart + 'T12:00:00');
  const btlE = addDays(btlS, BREED_WEEKS * 7);
  const bTotalDays = BREED_WEEKS * 7;
  function bpct(iso) {
    return ((new Date(iso + 'T12:00:00') - btlS) / 86400000 / bTotalDays) * 100;
  }
  const bWkHdrs = Array.from({length: BREED_WEEKS}, (_, i) => addDays(btlS, i * 7));
  const cycleSeqMap = buildCycleSeqMap(breedingCycles);

  const EMPTY_BREED = {
    group: '1',
    customSuffix: '',
    boar1Tags: '',
    boar2Tags: '',
    excludedSows: [],
    exposureStart: '',
    notes: '',
    boar1Name: boarNames.boar1,
    boar2Name: boarNames.boar2,
  };

  // Breeder-registry-driven sow pool: any Sow/Gilt in the breeders tab
  // whose group matches and who isn't archived.
  function sowsForGroup(group) {
    return breeders
      .filter((b) => !b.archived && (b.sex === 'Sow' || b.sex === 'Gilt') && String(b.group || '') === String(group))
      .map((b) => b.tag)
      .filter(Boolean);
  }
  // Add any group sows that aren't already listed under either boar to
  // Boar 1, EXCEPT sows the admin previously removed (excludedSows).
  // Returns the new boar1Tags string (newline-separated).
  function mergeSowsIntoB1(group, curB1, curB2, excluded) {
    const have1 = (curB1 || '')
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
    const have2 = (curB2 || '')
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
    const haveSet = new Set([...have1, ...have2]);
    const excludedSet = new Set(Array.isArray(excluded) ? excluded.map(String) : []);
    const missing = sowsForGroup(group).filter((t) => !haveSet.has(t) && !excludedSet.has(String(t)));
    if (missing.length === 0) return have1.join('\n');
    return [...have1, ...missing].join('\n');
  }
  // Cycle is "locked" once 14 days have passed since exposureStart —
  // Ronnie's 2-week grace period to shuffle sow/boar assignments after
  // the cycle goes live. Before lock, admin can still add/remove sows.
  function isCycleLocked(exposureStart) {
    if (!exposureStart) return false;
    const lockDay = toISO(addDays(new Date(exposureStart + 'T12:00:00'), 14));
    return todayISO() >= lockDay;
  }

  function persistBreedCycle(formSnapshot, cycleId) {
    if (!formSnapshot.exposureStart) return;
    const tl = calcBreedingTimeline(formSnapshot.exposureStart);
    const parseTags = function (str) {
      return str
        .split('\n')
        .map(function (t) {
          return t.trim();
        })
        .filter(Boolean);
    };
    const t1 = parseTags(formSnapshot.boar1Tags);
    const t2 = parseTags(formSnapshot.boar2Tags);
    const id = cycleId || String(Date.now());
    const cycle = {
      id: id,
      ...formSnapshot,
      sowCount: t1.length + t2.length,
      boar1Count: t1.length,
      boar2Count: t2.length,
      ...tl,
      boar1Name: formSnapshot.boar1Name || boarNames.boar1,
      boar2Name: formSnapshot.boar2Name || boarNames.boar2,
    };
    const nb = cycleId
      ? breedingCycles.map(function (c) {
          return c.id === cycleId ? cycle : c;
        })
      : [...breedingCycles, cycle];
    nb.sort(function (a, b) {
      return a.exposureStart.localeCompare(b.exposureStart);
    });
    setBreedingCycles(nb);
    persistBreeding(nb);
    if (!editBreedId) setEditBreedId(id);
  }
  function updBreed(k, v) {
    var next = {...breedForm, [k]: v};
    // For unstarted cycles, changing the group pulls that group's sows
    // into Boar 1 so the list tracks the breeders tab. Group switch
    // also clears excludedSows since exclusions are group-specific.
    if (k === 'group' && !isCycleLocked(next.exposureStart)) {
      next.excludedSows = [];
      next.boar1Tags = mergeSowsIntoB1(v, next.boar1Tags, next.boar2Tags, next.excludedSows);
    }
    setBreedForm(next);
    if (!next.exposureStart) return;
    clearTimeout(breedAutoSaveTimer.current);
    breedAutoSaveTimer.current = setTimeout(function () {
      persistBreedCycle(next, editBreedId);
    }, 500);
  }
  function closeBreedForm() {
    clearTimeout(breedAutoSaveTimer.current);
    if (breedForm.exposureStart) {
      persistBreedCycle(breedForm, editBreedId);
    }
    setShowBreedForm(false);
    setEditBreedId(null);
  }

  // Phase row definitions per group
  const phaseRows = PIG_GROUPS.flatMap((g) => [
    {group: g, phase: 'boar', label: `G${g} — Sows in with Boars`, startKey: 'boarStart', endKey: 'boarEnd'},
    {
      group: g,
      phase: 'paddock',
      label: `G${g} — Sows in Exposed Paddock`,
      startKey: 'paddockStart',
      endKey: 'paddockEnd',
    },
    {group: g, phase: 'farrowing', label: `G${g} — Farrowing`, startKey: 'farrowingStart', endKey: 'farrowingEnd'},
    {group: g, phase: 'weaning', label: `G${g} — Weaning`, startKey: 'weaningStart', endKey: 'weaningEnd'},
    {group: g, phase: 'gilt', label: `G${g} — Gilts Grow Out`, startKey: 'growStart', endKey: 'growEnd'},
    {group: g, phase: 'boarGrow', label: `G${g} — Boars Grow Out`, startKey: 'growStart', endKey: 'growEnd'},
  ]);

  return (
    <div>
      <Header />
      {showBreedForm && (
        <div
          style={{
            background: 'rgba(0,0,0,.45)',
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 500,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: '2rem 1rem',
            overflowY: 'auto',
          }}
        >
          <div
            style={{
              background: 'white',
              borderRadius: 12,
              width: '100%',
              maxWidth: 560,
              border: '1px solid var(--border)',
            }}
          >
            <div
              style={{
                padding: '14px 20px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div style={{fontSize: 15, fontWeight: 600}}>
                {editBreedId ? 'Edit Breeding Cycle' : 'Add Breeding Cycle'}{' '}
                <span style={{fontWeight: 400, color: 'var(--ink-faint)', fontSize: 11, marginLeft: 6}}>
                  Auto-saves as you type
                </span>
              </div>
              <button
                onClick={closeBreedForm}
                style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#999'}}
              >
                ×
              </button>
            </div>
            <div style={{padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10}}>
              {/* Boar names (per cycle) */}
              <div
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '10px 14px',
                }}
              >
                <div style={{fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8}}>
                  Boar names for this cycle
                </div>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                  <div>
                    <label style={S.label}>Boar 1 name</label>
                    <input value={breedForm.boar1Name || ''} onChange={(e) => updBreed('boar1Name', e.target.value)} />
                  </div>
                  <div>
                    <label style={S.label}>Boar 2 name</label>
                    <input value={breedForm.boar2Name || ''} onChange={(e) => updBreed('boar2Name', e.target.value)} />
                  </div>
                </div>
              </div>

              <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10}}>
                <div>
                  <label style={S.label}>Sow group</label>
                  <select value={breedForm.group} onChange={(e) => updBreed('group', e.target.value)}>
                    {PIG_GROUPS.map((g) => (
                      <option key={g} value={g}>
                        Group {g}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={S.label}>Batch number</label>
                  <input
                    type="text"
                    value={breedForm.customSuffix || ''}
                    onChange={(e) => updBreed('customSuffix', e.target.value)}
                    placeholder="e.g. 26-01"
                  />
                </div>
                <div>
                  <label style={S.label}>First day exposure (start date)</label>
                  <input
                    type="date"
                    value={breedForm.exposureStart}
                    onChange={(e) => updBreed('exposureStart', e.target.value)}
                  />
                </div>
              </div>

              {/* Sow-pool banner — shows how many sows are assigned to
                    the current group in the breeders tab. Prompts admin to
                    set up groups there if empty. */}
              {(() => {
                const pool = sowsForGroup(breedForm.group);
                const locked = isCycleLocked(breedForm.exposureStart);
                if (locked) {
                  return (
                    <div
                      style={{
                        background: '#f3f4f6',
                        border: '1px solid var(--border-strong)',
                        borderRadius: 10,
                        padding: '8px 12px',
                        fontSize: 12,
                        color: 'var(--ink)',
                      }}
                    >
                      Cycle locked — started on {fmtS(breedForm.exposureStart)} more than 2 weeks ago. Sow-boar
                      assignments can't be changed.
                    </div>
                  );
                }
                if (pool.length === 0) {
                  return (
                    <div
                      style={{
                        background: 'var(--warn-soft)',
                        border: '1px solid var(--border)',
                        borderRadius: 10,
                        padding: '8px 12px',
                        fontSize: 12,
                        color: 'var(--warn-ink)',
                      }}
                    >
                      No sows assigned to Group {breedForm.group} yet. Go to the <strong>Breeding Pigs</strong> tab and
                      set each sow's group to auto-fill this cycle.
                    </div>
                  );
                }
                return (
                  <div
                    style={{
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                      padding: '8px 12px',
                      fontSize: 12,
                      color: 'var(--text-primary)',
                    }}
                  >
                    <strong>{pool.length} sows</strong> currently in Group {breedForm.group}. Click a chip's × to
                    unassign a sow; assignments lock 2 weeks after the cycle starts.
                  </div>
                );
              })()}

              {(() => {
                const parseTags = (str) =>
                  (str || '')
                    .split('\n')
                    .map((t) => t.trim())
                    .filter(Boolean);
                const b1List = parseTags(breedForm.boar1Tags);
                const b2List = parseTags(breedForm.boar2Tags);
                const locked = isCycleLocked(breedForm.exposureStart);
                const assigned = new Set([...b1List, ...b2List]);
                const available = sowsForGroup(breedForm.group)
                  .filter((t) => !assigned.has(t))
                  .sort((a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0));
                // Multi-field setter that mirrors updBreed's autosave behavior
                // so we can update boarNTags AND excludedSows in one shot.
                function setFormFields(updates) {
                  const next = {...breedForm, ...updates};
                  setBreedForm(next);
                  if (!next.exposureStart) return;
                  clearTimeout(breedAutoSaveTimer.current);
                  breedAutoSaveTimer.current = setTimeout(function () {
                    persistBreedCycle(next, editBreedId);
                  }, 500);
                }
                function removeSow(boarKey, tag) {
                  const cur = parseTags(breedForm[boarKey]);
                  const curExcluded = Array.isArray(breedForm.excludedSows) ? breedForm.excludedSows : [];
                  const nextExcluded = curExcluded.includes(tag) ? curExcluded : [...curExcluded, tag];
                  setFormFields({[boarKey]: cur.filter((t) => t !== tag).join('\n'), excludedSows: nextExcluded});
                }
                function addSow(boarKey, tag) {
                  if (!tag) return;
                  const cur = parseTags(breedForm[boarKey]);
                  if (cur.includes(tag)) return;
                  const curExcluded = Array.isArray(breedForm.excludedSows) ? breedForm.excludedSows : [];
                  setFormFields({
                    [boarKey]: [...cur, tag].join('\n'),
                    excludedSows: curExcluded.filter((t) => t !== tag),
                  });
                }
                const chipRow = (list, boarKey) => (
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 4,
                      minHeight: 30,
                      padding: '6px 8px',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                    }}
                  >
                    {list.length === 0 && (
                      <span style={{fontSize: 11, color: 'var(--ink-faint)', fontStyle: 'italic', padding: '2px 0'}}>
                        No sows assigned
                      </span>
                    )}
                    {list.map((t) => (
                      <span
                        key={t}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          background: 'white',
                          border: '1px solid var(--border-strong)',
                          borderRadius: 12,
                          padding: '2px 4px 2px 10px',
                          fontSize: 12,
                          fontWeight: 600,
                          color: 'var(--ink)',
                        }}
                      >
                        #{t}
                        {!locked && (
                          <button
                            onClick={() => removeSow(boarKey, t)}
                            title="Remove"
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--ink-faint)',
                              cursor: 'pointer',
                              fontSize: 14,
                              lineHeight: 1,
                              padding: '0 4px',
                              fontFamily: 'inherit',
                            }}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                );
                const addDropdown = (boarKey) =>
                  !locked && (
                    <div style={{marginTop: 4}}>
                      <select
                        onChange={(e) => {
                          addSow(boarKey, e.target.value);
                          e.target.value = '';
                        }}
                        style={{fontSize: 11}}
                      >
                        <option value="">＋ Add sow from Group {breedForm.group}...</option>
                        {available.map((t) => (
                          <option key={t} value={t}>
                            #{t}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                return (
                  <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                    <div>
                      <label style={S.label}>
                        {breedForm.boar1Name || boarNames.boar1} sow tags{' '}
                        <span style={{fontWeight: 400, color: 'var(--ink-faint)'}}>({b1List.length})</span>
                      </label>
                      {chipRow(b1List, 'boar1Tags')}
                      {addDropdown('boar1Tags')}
                    </div>
                    <div>
                      <label style={S.label}>
                        {breedForm.boar2Name || boarNames.boar2} sow tags{' '}
                        <span style={{fontWeight: 400, color: 'var(--ink-faint)'}}>({b2List.length})</span>
                      </label>
                      {chipRow(b2List, 'boar2Tags')}
                      {addDropdown('boar2Tags')}
                    </div>
                  </div>
                );
              })()}
              <div
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '8px 12px',
                  fontSize: 12,
                  color: 'var(--text-primary)',
                }}
              >
                <strong>
                  Total sows in cycle:{' '}
                  {(breedForm.boar1Tags || '')
                    .split('\n')
                    .map((t) => t.trim())
                    .filter(Boolean).length +
                    (breedForm.boar2Tags || '')
                      .split('\n')
                      .map((t) => t.trim())
                      .filter(Boolean).length}
                </strong>
                &nbsp;·&nbsp; {boarNames.boar1}:{' '}
                {
                  (breedForm.boar1Tags || '')
                    .split('\n')
                    .map((t) => t.trim())
                    .filter(Boolean).length
                }
                &nbsp;·&nbsp; {boarNames.boar2}:{' '}
                {
                  (breedForm.boar2Tags || '')
                    .split('\n')
                    .map((t) => t.trim())
                    .filter(Boolean).length
                }
              </div>

              {/* Calculated timeline preview */}
              {breedForm.exposureStart &&
                (() => {
                  const tl = calcBreedingTimeline(breedForm.exposureStart);
                  if (!tl) return null;
                  return (
                    <div
                      style={{
                        background: 'var(--bg-card)',
                        border: '1px solid var(--border)',
                        borderRadius: 10,
                        padding: '10px 14px',
                        fontSize: 12,
                        color: 'var(--text-primary)',
                      }}
                    >
                      <div style={{fontWeight: 600, marginBottom: 6}}>Calculated timeline</div>
                      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px'}}>
                        <div>
                          Sows in with Boars:{' '}
                          <strong>
                            {fmtS(tl.boarStart)} → {fmtS(tl.boarEnd)}
                          </strong>
                        </div>
                        <div>
                          Sows in Exposed Paddock:{' '}
                          <strong>
                            {fmtS(tl.paddockStart)} → {fmtS(tl.paddockEnd)}
                          </strong>
                        </div>
                        <div>
                          Farrowing window:{' '}
                          <strong>
                            {fmtS(tl.farrowingStart)} → {fmtS(tl.farrowingEnd)}
                          </strong>
                        </div>
                        <div>
                          Weaning:{' '}
                          <strong>
                            {fmtS(tl.weaningStart)} → {fmtS(tl.weaningEnd)}
                          </strong>
                        </div>
                        <div>
                          Grow-out ends: <strong>{fmtS(tl.growEnd)}</strong>
                        </div>
                      </div>
                    </div>
                  );
                })()}

              <div>
                <label style={S.label}>Notes</label>
                <textarea value={breedForm.notes} onChange={(e) => updBreed('notes', e.target.value)} rows={2} />
              </div>
            </div>
            <div style={{padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8}}>
              {editBreedId && (
                <button
                  onClick={() => {
                    confirmDelete('Delete this breeding cycle? This cannot be undone.', () => {
                      clearTimeout(breedAutoSaveTimer.current);
                      const nb = breedingCycles.filter((c) => c.id !== editBreedId);
                      setBreedingCycles(nb);
                      persistBreeding(nb);
                      setShowBreedForm(false);
                      setEditBreedId(null);
                    });
                  }}
                  style={S.btnDanger}
                >
                  Delete
                </button>
              )}
              <button
                onClick={closeBreedForm}
                style={{
                  marginLeft: 'auto',
                  padding: '7px 16px',
                  borderRadius: 10,
                  border: '1px solid var(--border-strong)',
                  background: 'white',
                  color: 'var(--ink)',
                  fontWeight: 600,
                  fontSize: 12,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{padding: '1rem'}}>
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
        {/* Nav bar */}
        <div style={{display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center'}}>
          <button
            onClick={() => {
              const d = new Date();
              d.setMonth(d.getMonth() - 1);
              d.setDate(1);
              setBreedTlStart(toISO(d));
            }}
            style={{
              padding: '5px 14px',
              borderRadius: 10,
              border: 'none',
              background: '#085041',
              color: 'white',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            Today
          </button>
          <span style={{fontSize: 11, color: 'var(--ink-faint)'}}>
            {fmtS(breedTlStart)} — {fmtS(toISO(btlE))}
          </span>
          <button
            onClick={() => {
              setBreedForm({
                ...EMPTY_BREED,
                excludedSows: [],
                boar1Tags: mergeSowsIntoB1(EMPTY_BREED.group, '', '', []),
              });
              setEditBreedId(null);
              setShowBreedForm(true);
            }}
            style={{
              marginLeft: 'auto',
              padding: '5px 14px',
              borderRadius: 10,
              border: 'none',
              background: getProgramColor('pig'),
              color: getReadableText(getProgramColor('pig')),
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            + Add Cycle
          </button>
        </div>

        {/* Gantt */}
        <div className="breed-gantt" style={{...S.card, overflowX: 'auto', position: 'relative'}}>
          {/* Floating tooltip for pig timeline */}
          {tooltip &&
            tooltip.type === 'pig' &&
            (function () {
              return React.createElement(
                'div',
                {
                  style: {
                    position: 'fixed',
                    left: tooltip.vx,
                    top: tooltip.vy,
                    transform: 'translate(-50%,-100%)',
                    zIndex: 9999,
                    pointerEvents: 'none',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                  },
                },
                React.createElement(
                  'div',
                  {
                    style: {
                      background: '#1a1a1a',
                      color: 'white',
                      borderRadius: 10,
                      padding: '9px 12px',
                      fontSize: 12,
                      boxShadow: '0 4px 16px rgba(0,0,0,.35)',
                      minWidth: 180,
                      maxWidth: 260,
                    },
                  },
                  React.createElement(
                    'div',
                    {style: {fontWeight: 700, fontSize: 13, marginBottom: 5, color: 'white'}},
                    (tooltip.cycleLbl || 'Group ' + tooltip.group) + ' \u2014 ' + tooltip.phaseName,
                  ),
                  React.createElement(
                    'div',
                    {style: {display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 10px'}},
                    React.createElement('span', {style: {color: '#9ca3af'}}, 'Period:'),
                    React.createElement(
                      'span',
                      {style: {color: 'white'}},
                      fmt(tooltip.start) + ' \u2192 ' + fmt(tooltip.end),
                    ),
                    React.createElement('span', {style: {color: '#9ca3af'}}, 'Sows:'),
                    React.createElement('span', {style: {color: 'white'}}, (tooltip.sowCount || '?') + ' total'),
                  ),
                ),
                React.createElement('div', {
                  style: {
                    width: 0,
                    height: 0,
                    borderLeft: '7px solid transparent',
                    borderRight: '7px solid transparent',
                    borderTop: '7px solid #1a1a1a',
                  },
                }),
              );
            })()}
          <div style={{width: `${210 + BREED_WEEKS * 40}px`}}>
            {/* Week headers */}
            <div style={{display: 'flex', borderBottom: '1px solid var(--border)'}}>
              <div
                style={{
                  width: 210,
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
                Phase
              </div>
              <div style={{flex: 1, position: 'relative', height: 26, overflow: 'hidden'}}>
                {bWkHdrs.map((w, i) => {
                  const isNew = w.getDate() <= 7;
                  return (
                    <div
                      key={i}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: `${(i / BREED_WEEKS) * 100}%`,
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
                        {isNew ? w.toLocaleDateString('en-US', {month: 'short', year: '2-digit'}) : w.getDate()}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {phaseRows.map((row, ri) => {
              const isGroupStart = ri % 6 === 0;
              const rowCycles = breedingCycles.filter((c) => c.group === row.group);
              const todayPct = bpct(todayISO());
              const phaseColor = PIG_GROUP_COLORS[row.group]?.[row.phase] || '#ccc';
              // Per-bar dynamic contrast: light bgs (gilt shades) get
              // near-black text; darker bgs get white.
              const txtColor = getReadableText(phaseColor);
              return (
                <div
                  key={ri}
                  style={{display: 'flex', borderTop: isGroupStart ? '2px solid #bbb' : '1px solid #f0f0f0'}}
                >
                  <div
                    style={{
                      width: 210,
                      flexShrink: 0,
                      padding: '0 10px',
                      display: 'flex',
                      alignItems: 'center',
                      height: 40,
                      fontSize: 10,
                      fontWeight: isGroupStart ? 700 : 400,
                      color: isGroupStart ? '#333' : '#666',
                      borderRight: '1px solid var(--border)',
                      background: 'var(--surface-2)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      position: 'sticky',
                      left: 0,
                      zIndex: 10,
                    }}
                  >
                    {row.label}
                  </div>
                  <div style={{flex: 1, position: 'relative', height: 40}}>
                    {bWkHdrs.map((_, i) => (
                      <div
                        key={i}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: `${(i / BREED_WEEKS) * 100}%`,
                          height: '100%',
                          borderLeft: '1px solid #f5f5f5',
                          pointerEvents: 'none',
                        }}
                      />
                    ))}
                    {todayPct >= 0 && todayPct <= 100 && (
                      <div
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
                    {rowCycles.map((c) => {
                      // Always recalculate live so stale stored values never show
                      const liveTl = calcBreedingTimeline(c.exposureStart);
                      if (!liveTl) return null;
                      const liveC = {...c, ...liveTl};
                      const s = liveC[row.startKey],
                        e = liveC[row.endKey];
                      if (!s || !e) return null;
                      const left = Math.max(0, bpct(s));
                      const right = Math.min(100, bpct(e));
                      const w = right - left;
                      if (w < 0.2) return null;
                      const phaseNames = {
                        boar: 'Sows in with Boars',
                        paddock: 'Sows in Exposed Paddock',
                        farrowing: 'Farrowing',
                        weaning: 'Weaning',
                        gilt: 'Gilts Grow Out',
                        boarGrow: 'Boars Grow Out',
                      };
                      const cLbl = cycleLabel(c, cycleSeqMap);
                      // customSuffix (admin override) wins over the auto YY-NN
                      // so bar labels reflect what you typed into the modal.
                      const cSuffix = (c.customSuffix && String(c.customSuffix).trim()) || cycleSeqMap[c.id];
                      const label = `G${c.group}${cSuffix ? ' · ' + cSuffix : ''} — ${phaseNames[row.phase] || row.phase}`;
                      return (
                        <div
                          key={c.id}
                          onClick={() => {
                            const baseB1 = (c.boar1Tags || '').split(',').join('\n').split(', ').join('\n');
                            const baseB2 = (c.boar2Tags || '').split(',').join('\n').split(', ').join('\n');
                            const excluded = Array.isArray(c.excludedSows) ? c.excludedSows : [];
                            // Unstarted cycles: re-pull any newly-added sows
                            // from the breeder registry, skipping ones the
                            // admin previously removed (excludedSows). Started
                            // cycles are frozen — show what was saved.
                            const liveB1 = isCycleLocked(c.exposureStart)
                              ? baseB1
                              : mergeSowsIntoB1(c.group, baseB1, baseB2, excluded);
                            setBreedForm({
                              group: c.group,
                              customSuffix: c.customSuffix || '',
                              boar1Tags: liveB1,
                              boar2Tags: baseB2,
                              excludedSows: excluded,
                              exposureStart: c.exposureStart,
                              notes: c.notes || '',
                              boar1Name: c.boar1Name || boarNames.boar1,
                              boar2Name: c.boar2Name || boarNames.boar2,
                            });
                            setEditBreedId(c.id);
                            setShowBreedForm(true);
                          }}
                          onMouseEnter={function (ev) {
                            var r = ev.currentTarget.getBoundingClientRect();
                            setTooltip({
                              type: 'pig',
                              group: c.group,
                              cycleLbl: cLbl,
                              phase: row.phase,
                              phaseName: phaseNames[row.phase] || row.phase,
                              start: s,
                              end: e,
                              sowCount: c.sowCount,
                              vx: r.left + r.width / 2,
                              vy: r.top - 10,
                            });
                          }}
                          onMouseLeave={function () {
                            setTooltip(null);
                          }}
                          style={{
                            position: 'absolute',
                            left: `${left}%`,
                            width: `${w}%`,
                            top: 4,
                            bottom: 4,
                            borderRadius: 10,
                            cursor: 'pointer',
                            background: phaseColor,
                            display: 'flex',
                            alignItems: 'center',
                            padding: '0 7px',
                            overflow: 'hidden',
                            outline:
                              tooltip &&
                              tooltip.type === 'pig' &&
                              tooltip.group === c.group &&
                              tooltip.phase === row.phase
                                ? '2px solid rgba(0,0,0,.25)'
                                : 'none',
                          }}
                        >
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              color: txtColor,
                              whiteSpace: 'nowrap',
                              textOverflow: 'ellipsis',
                              overflow: 'hidden',
                            }}
                          >
                            {label}
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
        <div style={{display: 'flex', gap: 12, marginTop: 10, flexWrap: 'wrap', alignItems: 'center'}}>
          {PIG_GROUPS.map((g) => (
            <div key={g} style={{display: 'flex', alignItems: 'center', gap: 6}}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2 /* radius-allow: 10px legend swatch */,
                  background: PIG_GROUP_COLORS[g].gilt,
                }}
                title="Gilts grow-out"
              />
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2 /* radius-allow: 10px legend swatch */,
                  background: PIG_GROUP_COLORS[g].farrowing,
                }}
                title="Cycle base"
              />
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2 /* radius-allow: 10px legend swatch */,
                  background: PIG_GROUP_COLORS[g].boarGrow,
                }}
                title="Boars grow-out"
              />
              <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>Group {g}</span>
            </div>
          ))}
          <span style={{fontSize: 11, color: 'var(--ink-faint)'}}>
            Light = Gilts grow-out · Dark = Boars grow-out · Click bar to edit · Green line = today
          </span>
        </div>

        {/* Cycle cards below chart */}
        {breedingCycles.length > 0 && (
          <div style={{marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: 8}}>
            <div style={{fontSize: 13, fontWeight: 600, color: 'var(--ink-muted)'}}>Breeding cycles</div>
            {breedingCycles
              .slice()
              .sort((a, b) => (b.exposureStart || '').localeCompare(a.exposureStart || ''))
              .map((c) => {
                const tl = calcBreedingTimeline(c.exposureStart) || c;
                const openEdit = () => {
                  const baseB1 = (c.boar1Tags || '').split(',').join('\n').split(', ').join('\n');
                  const baseB2 = (c.boar2Tags || '').split(',').join('\n').split(', ').join('\n');
                  const excluded = Array.isArray(c.excludedSows) ? c.excludedSows : [];
                  const liveB1 = isCycleLocked(c.exposureStart)
                    ? baseB1
                    : mergeSowsIntoB1(c.group, baseB1, baseB2, excluded);
                  setBreedForm({
                    group: c.group,
                    customSuffix: c.customSuffix || '',
                    boar1Tags: liveB1,
                    boar2Tags: baseB2,
                    excludedSows: excluded,
                    exposureStart: c.exposureStart,
                    notes: c.notes || '',
                    boar1Name: c.boar1Name || boarNames.boar1,
                    boar2Name: c.boar2Name || boarNames.boar2,
                  });
                  setEditBreedId(c.id);
                  setShowBreedForm(true);
                };
                return (
                  <div
                    key={c.id}
                    {...openableProps(openEdit)}
                    className="hoverable-tile"
                    style={{
                      background: 'white',
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                      padding: '10px 14px',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '6px 20px',
                        alignItems: 'center',
                        marginBottom: 6,
                      }}
                    >
                      <span style={{display: 'inline-flex', alignItems: 'center', gap: 6}}>
                        <span style={programDotStyle('pig')} />
                        <strong>{cycleLabel(c, cycleSeqMap)}</strong>
                      </span>
                      <span style={{color: 'var(--ink-muted)'}}>{c.sowCount || '?'} sows total</span>
                      <span style={{color: 'var(--ink-muted)'}}>
                        Sows in with Boars: {fmt(tl.boarStart)} {'\u2192'} {fmt(tl.boarEnd)}
                      </span>
                      <span style={{color: 'var(--ink-muted)'}}>
                        Exposed Paddock: {fmt(tl.paddockStart)} {'\u2192'} {fmt(tl.paddockEnd)}
                      </span>
                      <span style={{color: 'var(--ink-muted)'}}>
                        Farrowing: {fmt(tl.farrowingStart)} {'\u2192'} {fmt(tl.farrowingEnd)}
                      </span>
                      <span style={{color: 'var(--ink-muted)'}}>Grow-out ends: {fmt(tl.growEnd)}</span>
                      <Badge
                        variant={
                          calcCycleStatus(c) === 'completed'
                            ? 'neutral'
                            : calcCycleStatus(c) === 'active'
                              ? 'ok'
                              : 'warn'
                        }
                      >
                        {c.status}
                      </Badge>
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        gap: '4px 20px',
                        borderTop: '1px solid var(--border)',
                        paddingTop: 6,
                      }}
                    >
                      <div style={{fontSize: 11}}>
                        <span style={{color: 'var(--ink-faint)'}}>
                          {c.boar1Name || boarNames.boar1} ({c.boar1Count || '?'} sows):{' '}
                        </span>
                        <span style={{fontWeight: 500}}>{c.boar1Tags || '—'}</span>
                      </div>
                      <div style={{fontSize: 11}}>
                        <span style={{color: 'var(--ink-faint)'}}>
                          {c.boar2Name || boarNames.boar2} ({c.boar2Count || '?'} sows):{' '}
                        </span>
                        <span style={{fontWeight: 500}}>{c.boar2Tags || '—'}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        )}
        {breedingCycles.length === 0 && (
          <div style={{textAlign: 'center', padding: '3rem', color: 'var(--ink-faint)', fontSize: 13}}>
            No breeding cycles yet — click "+ Add Cycle" to get started
          </div>
        )}
      </div>
    </div>
  );
}
