// ============================================================================
// src/pig/FarrowingView.jsx  —  Phase 2 Round 6
// ----------------------------------------------------------------------------
// Farrowing records view (per-cycle sow outcomes). Form state + the records
// array are in PigContext; persistFarrowing comes in as a prop.
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {fmt, fmtS, todayISO, addDays, toISO} from '../lib/dateUtils.js';
import {S, getReadableText} from '../lib/styles.js';
import {calcBreedingTimeline, buildCycleSeqMap, cycleLabel, PIG_GROUPS} from '../lib/pig.js';
import {programDotStyle, getProgramColor} from '../lib/programColors.js';
import {matchCycleForFarrowing, ensureFarrowBatchForCycle} from '../lib/pigFarrowBatch.js';
import {buildChanges} from '../lib/activityChangeDiff.js';
import {recordActivityEvent} from '../lib/entityMutations.js';
import UsersModal from '../auth/UsersModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import StatusText from '../shared/StatusText.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import Badge from '../shared/Badge.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {usePig} from '../contexts/PigContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';

// Farrowing records live in app_store JSON, not a relational table, so there is
// no SECDEF delete RPC. Their lifecycle is audited best-effort against the
// matched breeding pig (pig.breeder) — the same entity SowsView owns — because
// there is intentionally no pig.farrowing entity. `record: 'pig.farrowing'` is a
// payload discriminator only, never an entity_type.
const BREEDING_PIG_ENTITY_TYPE = 'pig.breeder';
const FARROWING_ACTIVITY_LABELS = {
  sow: 'Sow',
  group: 'Group',
  farrowingDate: 'Farrowing date',
  exposureStart: 'Exposure start',
  sire: 'Sire',
  motheringQuality: 'Mothering quality',
  demeanor: 'Demeanor',
  totalBorn: 'Total born',
  deaths: 'Deaths',
  location: 'Location',
  wentWell: 'What went well',
  didntGoWell: "What didn't go well",
  defects: 'Deaths / defects',
};

export default function FarrowingView({
  Header,
  loadUsers,
  persistFarrowing,
  persistFeeders,
  confirmDelete,
  resolveSire,
}) {
  const {authState, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const {
    breedingCycles,
    breeders,
    feederGroups,
    farrowingRecs,
    setFarrowingRecs,
    boarNames,
    farrowForm,
    setFarrowForm,
    showFarrowForm,
    setShowFarrowForm,
    editFarrowId,
    setEditFarrowId,
    farrowFilter,
    setFarrowFilter,
  } = usePig();
  const {setView} = useUI();
  const [notice, setNotice] = React.useState(null);
  const cycleSeqMap = buildCycleSeqMap(breedingCycles);
  const QUALITY_OPTS = ['', 'excellent', 'average', 'poor'];
  const LOCATION_OPTS = ['', 'inside-hut', 'outside-hut', 'inside-pen', 'outside-pen'];
  const locationLabel = (v) =>
    ({
      '': ' — ',
      'inside-hut': 'Inside hut',
      'outside-hut': 'Outside hut',
      'inside-pen': 'Inside pen',
      'outside-pen': 'Outside pen',
    })[v] || v;
  const qualityLabel = (v) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : '—');
  // Mothering rating → colored ink tone (CP0 WI-4: ratings are colored TEXT via
  // StatusText, not chips). excellent→ok, average→warn, poor→danger.
  const qualityTone = (v) => ({excellent: 'ok', average: 'warn', poor: 'danger'})[v] || 'muted';
  const EMPTY_FARROW = {
    sow: '',
    group: '1',
    farrowingDate: '',
    exposureStart: '',
    exposureEnd: '',
    sire: boarNames.boar1,
    motheringQuality: '',
    demeanor: '',
    totalBorn: 0,
    deaths: 0,
    location: '',
    wentWell: '',
    didntGoWell: '',
    defects: '',
  };

  // ── Best-effort farrowing → pig.breeder Activity ──────────────────────────
  // Match a farrowing record's sow tag to a registered breeding pig so the
  // audit lands on the existing pig.breeder entity (SowsView owns it). Tag
  // equality mirrors sowFarrowStats in SowsView.
  function matchBreederForSow(sow) {
    const tag = String(sow == null ? '' : sow).trim();
    if (!tag) return null;
    return (breeders || []).find((b) => String(b && b.tag != null ? b.tag : '').trim() === tag) || null;
  }
  function breederEntityLabel(b) {
    return b && b.tag ? '#' + b.tag : (b && b.id) || 'Breeding pig';
  }
  // Log a farrowing lifecycle event on the MATCHED breeding pig. Scoped to
  // pig.breeder (entity_id = breeder.id); if no breeder matches the sow tag we
  // skip the emit rather than writing to an invalid entity id. Always
  // best-effort (try/catch + swallowed reject) — never blocks the save/delete.
  function recordFarrowingActivity(rec, eventType, changes) {
    const breeder = matchBreederForSow(rec && rec.sow);
    if (!breeder) return;
    const label = breederEntityLabel(breeder);
    const totalBorn = parseInt(rec.totalBorn) || 0;
    const deaths = parseInt(rec.deaths) || 0;
    const verb = eventType === 'record.created' ? 'Added' : eventType === 'record.deleted' ? 'Deleted' : 'Updated';
    try {
      recordActivityEvent(sb, {
        entityType: BREEDING_PIG_ENTITY_TYPE,
        entityId: breeder.id,
        entityLabel: label,
        eventType,
        body: verb + ' farrowing record for ' + label + (rec.farrowingDate ? ' · ' + fmt(rec.farrowingDate) : ''),
        payload: {
          record: 'pig.farrowing',
          sow: rec.sow,
          group: rec.group || null,
          farrowingDate: rec.farrowingDate || null,
          totalBorn,
          deaths,
          alive: totalBorn - deaths,
          ...(changes && changes.length ? {changes} : {}),
        },
      }).catch(() => {});
    } catch (_e) {
      /* best-effort audit trail; farrowing persistence remains canonical */
    }
  }

  function saveFarrowForm() {
    setNotice(null);
    if (!farrowForm.sow) {
      setNotice({kind: 'error', message: 'Please enter a sow number.'});
      return;
    }
    const existing = editFarrowId ? farrowingRecs.find((r) => r.id === editFarrowId) || null : null;
    const rec = {
      id: editFarrowId || String(Date.now()),
      ...farrowForm,
      alive: (parseInt(farrowForm.totalBorn) || 0) - (parseInt(farrowForm.deaths) || 0),
    };
    const nb = editFarrowId ? farrowingRecs.map((r) => (r.id === editFarrowId ? rec : r)) : [...farrowingRecs, rec];
    nb.sort((a, b) => b.farrowingDate.localeCompare(a.farrowingDate));
    setFarrowingRecs(nb);
    persistFarrowing(nb);
    // Best-effort pig.breeder audit for the farrowing lifecycle (create + edit).
    // Logged AFTER persistFarrowing; a no-op edit (no field changes) is skipped.
    if (existing) {
      const changes = buildChanges(existing, rec, {exclude: ['id', 'alive'], labels: FARROWING_ACTIVITY_LABELS});
      if (changes.length > 0) recordFarrowingActivity(rec, 'field.updated', changes);
    } else {
      recordFarrowingActivity(rec, 'record.created');
    }
    // Farm-born batch creation: ensure exactly one feeder group exists for this
    // record's breeding cycle. Create-only + idempotent — existing/manual linked
    // batches are reused untouched; deleting/editing-away never removes a batch.
    const cycle = matchCycleForFarrowing(rec, breedingCycles);
    if (cycle && typeof persistFeeders === 'function') {
      const {next, created} = ensureFarrowBatchForCycle(feederGroups, cycle, nb, breedingCycles);
      if (created) persistFeeders(next);
    }
    setShowFarrowForm(false);
    setEditFarrowId(null);
  }

  // Parse comma/space separated tag numbers
  function parseTags(str) {
    return (str || '')
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  // Get all sow tags expected to farrow in a cycle
  function getExpectedSows(c) {
    return [...parseTags(c.boar1Tags), ...parseTags(c.boar2Tags)];
  }

  // Get missed sows for a cycle
  function getMissedSows(c, recs, tl) {
    if (!tl) return [];
    const expected = getExpectedSows(c);
    if (expected.length === 0) return [];
    const farrowed = new Set(recs.map((r) => r.sow.trim()));
    const today = new Date();
    const windowEnd = new Date(tl.farrowingEnd + 'T12:00:00');
    const windowStart = new Date(tl.farrowingStart + 'T12:00:00');
    const windowPassed = today > windowEnd;
    const windowStarted = today >= windowStart;
    return expected
      .filter((tag) => !farrowed.has(tag))
      .map((tag) => ({
        tag,
        status: windowPassed ? 'missed' : windowStarted ? 'pending' : 'not_yet',
        cycleLabel: `${cycleLabel(c, cycleSeqMap)} (${fmtS(tl.farrowingStart)} – ${fmtS(tl.farrowingEnd)})`,
      }));
  }

  // Match records to breeding cycles
  function getRecsForCycle(c) {
    const tl = calcBreedingTimeline(c.exposureStart);
    if (!tl) return [];
    return farrowingRecs
      .filter((r) => {
        if (r.group !== c.group || !r.farrowingDate) return false;
        const rd = new Date(r.farrowingDate + 'T12:00:00');
        const wStart = new Date(tl.farrowingStart + 'T12:00:00');
        const wEnd = addDays(tl.farrowingEnd, 14);
        return rd >= wStart && rd <= wEnd;
      })
      .sort((a, b) => a.farrowingDate.localeCompare(b.farrowingDate));
  }

  const sortedCycles = [...breedingCycles].sort((a, b) => b.exposureStart.localeCompare(a.exposureStart));
  const linkedIds = new Set();
  sortedCycles.forEach((c) => getRecsForCycle(c).forEach((r) => linkedIds.add(r.id)));
  const unlinked = farrowingRecs
    .filter((r) => !linkedIds.has(r.id))
    .sort((a, b) => b.farrowingDate.localeCompare(a.farrowingDate));

  const grandBorn = farrowingRecs.reduce((s, r) => s + (parseInt(r.totalBorn) || 0), 0);
  const grandDead = farrowingRecs.reduce((s, r) => s + (parseInt(r.deaths) || 0), 0);
  const grandAlive = grandBorn - grandDead;
  const grandRate = grandBorn > 0 ? Math.round((grandAlive / grandBorn) * 100) : 0;

  function CycleStatsBar({recs, sowCount}) {
    const born = recs.reduce((s, r) => s + (parseInt(r.totalBorn) || 0), 0);
    const dead = recs.reduce((s, r) => s + (parseInt(r.deaths) || 0), 0);
    const alive = born - dead;
    const rate = born > 0 ? Math.round((alive / born) * 100) : 0;
    const total = parseInt(sowCount) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((recs.length / total) * 100)) : 0;
    return (
      <div>
        <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8}}>
          <div style={{fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap'}}>
            Sows farrowed: <strong style={{color: 'var(--text-primary)'}}>{recs.length}</strong>
            {total > 0 && (
              <>
                {' '}
                of <strong>{total}</strong>
              </>
            )}
          </div>
          {total > 0 && (
            <>
              <div
                style={{
                  flex: 1,
                  height: 8,
                  background: '#f0f0f0',
                  borderRadius: 4 /* radius-allow: progress bar track (height 8) */,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${pct}%`,
                    background: pct >= 100 ? 'var(--ok-ink)' : 'var(--text-secondary)',
                    borderRadius: 4 /* radius-allow: progress bar fill (height 8) */,
                  }}
                />
              </div>
              <div style={{fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap'}}>{pct}%</div>
            </>
          )}
        </div>
        {recs.length > 0 && (
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 10}}>
            {[
              {label: 'Total born', val: born, color: 'var(--text-primary)'},
              {label: 'Deaths', val: dead, color: 'var(--danger)'},
              {label: 'Alive', val: alive, color: 'var(--text-primary)'},
              {label: 'Survival', val: rate + '%', color: 'var(--ok-ink)'},
            ].map((s) => (
              <div
                key={s.label}
                style={{
                  textAlign: 'center',
                  background: 'white',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '6px 8px',
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    color: 'var(--text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                    marginBottom: 2,
                  }}
                >
                  {s.label}
                </div>
                <div style={{fontSize: 16, fontWeight: 700, color: s.color}}>{s.val}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function RecordsTable({recs}) {
    if (recs.length === 0)
      return (
        <div style={{color: 'var(--text-muted)', fontSize: 12, padding: '6px 0 4px'}}>
          No farrowing records yet for this cycle
        </div>
      );
    return (
      <div style={{overflowX: 'auto'}}>
        <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 11, minWidth: 700}}>
          <thead>
            <tr style={{background: 'var(--green-50)', borderBottom: '1px solid var(--border)'}}>
              {[
                'Sow',
                'Farrow Date',
                'Impreg. Date',
                'Sire',
                'Mothering',
                'Born',
                'Deaths',
                'Alive',
                'Location',
                'Notes',
                '',
              ].map((h, i) => (
                <th
                  key={i}
                  style={{
                    padding: '6px 8px',
                    textAlign: 'left',
                    fontWeight: 600,
                    color: 'var(--text-secondary)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recs.map((r, i) => {
              const alive = (parseInt(r.totalBorn) || 0) - (parseInt(r.deaths) || 0);
              const impregDate = r.farrowingDate ? toISO(addDays(r.farrowingDate, -116)) : null;
              return (
                <tr
                  key={r.id}
                  style={{borderBottom: '1px solid #f5f5f5', background: i % 2 === 0 ? 'white' : '#fafafa'}}
                >
                  <td style={{padding: '6px 8px', fontWeight: 600}}>#{r.sow}</td>
                  <td style={{padding: '6px 8px', whiteSpace: 'nowrap'}}>{fmt(r.farrowingDate)}</td>
                  <td style={{padding: '6px 8px', whiteSpace: 'nowrap', color: 'var(--text-secondary)'}}>
                    {impregDate ? fmt(impregDate) : '\u2014'}
                  </td>
                  <td style={{padding: '6px 8px'}}>{resolveSire(r) || '\u2014'}</td>
                  <td style={{padding: '6px 8px'}}>
                    {r.motheringQuality ? (
                      <StatusText tone={qualityTone(r.motheringQuality)}>{qualityLabel(r.motheringQuality)}</StatusText>
                    ) : (
                      <span style={{color: 'var(--text-muted)'}}>—</span>
                    )}
                  </td>
                  <td style={{padding: '6px 8px', textAlign: 'center', fontWeight: 500}}>{r.totalBorn || 0}</td>
                  <td style={{padding: '6px 8px', textAlign: 'center', color: 'var(--danger)', fontWeight: 500}}>
                    {r.deaths || 0}
                  </td>
                  <td style={{padding: '6px 8px', textAlign: 'center', color: 'var(--text-primary)', fontWeight: 700}}>
                    {alive}
                  </td>
                  <td style={{padding: '6px 8px', whiteSpace: 'nowrap', color: 'var(--text-secondary)'}}>
                    {locationLabel(r.location)}
                  </td>
                  <td
                    style={{
                      padding: '6px 8px',
                      maxWidth: 160,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {[r.wentWell, r.didntGoWell, r.defects].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td style={{padding: '6px 8px'}}>
                    <button
                      onClick={() => {
                        setFarrowForm({
                          sow: r.sow,
                          group: r.group,
                          farrowingDate: r.farrowingDate,
                          exposureStart: r.exposureStart || '',
                          exposureEnd: r.exposureEnd || '',
                          sire: r.sire || '',
                          motheringQuality: r.motheringQuality || '',
                          demeanor: r.demeanor || '',
                          totalBorn: r.totalBorn || 0,
                          deaths: r.deaths || 0,
                          location: r.location || '',
                          wentWell: r.wentWell || '',
                          didntGoWell: r.didntGoWell || '',
                          defects: r.defects || '',
                        });
                        setEditFarrowId(r.id);
                        setShowFarrowForm(true);
                      }}
                      style={{
                        fontSize: 11,
                        color: 'var(--text-primary)',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div>
      <Header />
      {showFarrowForm && (
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
              maxWidth: 580,
              border: '1px solid var(--border)',
              marginBottom: '2rem',
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
                {editFarrowId ? 'Edit Farrowing Record' : 'Add Farrowing Record'}
              </div>
              <button
                onClick={() => {
                  setNotice(null);
                  setShowFarrowForm(false);
                  setEditFarrowId(null);
                }}
                style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#999'}}
              >
                ×
              </button>
            </div>
            <div style={{padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10}}>
              <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
              {/* Auto-resolve cycle from farrowing date */}
              {(function () {
                // Find matching cycle based on farrowing date
                var matchedCycle = null;
                if (farrowForm.farrowingDate) {
                  var fd = new Date(farrowForm.farrowingDate + 'T12:00:00');
                  for (var ci2 = 0; ci2 < breedingCycles.length; ci2++) {
                    var cc = breedingCycles[ci2];
                    var ttl = calcBreedingTimeline(cc.exposureStart);
                    if (!ttl) continue;
                    if (
                      fd >= new Date(ttl.farrowingStart + 'T12:00:00') &&
                      fd <= addDays(new Date(ttl.farrowingEnd + 'T12:00:00'), 14)
                    ) {
                      matchedCycle = cc;
                      break;
                    }
                  }
                }
                // Build sow dropdown from matched cycle's tags
                var sowOptions = [];
                if (matchedCycle) {
                  var b1t = (matchedCycle.boar1Tags || '')
                    .split(/[\n,]+/)
                    .map(function (t) {
                      return t.trim();
                    })
                    .filter(Boolean);
                  var b2t = (matchedCycle.boar2Tags || '')
                    .split(/[\n,]+/)
                    .map(function (t) {
                      return t.trim();
                    })
                    .filter(Boolean);
                  var allTagsInCycle = [...b1t, ...b2t];
                  // Find sows already recorded in this cycle's farrowing window
                  var mcTl = calcBreedingTimeline(matchedCycle.exposureStart);
                  var alreadyRecorded = new Set();
                  if (mcTl) {
                    farrowingRecs.forEach(function (r2) {
                      if (!r2.farrowingDate || !r2.sow) return;
                      // Skip the record currently being edited
                      if (editFarrowId && r2.id === editFarrowId) return;
                      var rd2 = new Date(r2.farrowingDate + 'T12:00:00');
                      if (
                        rd2 >= new Date(mcTl.farrowingStart + 'T12:00:00') &&
                        rd2 <= addDays(new Date(mcTl.farrowingEnd + 'T12:00:00'), 14)
                      ) {
                        alreadyRecorded.add(r2.sow.trim());
                      }
                    });
                  }
                  sowOptions = allTagsInCycle
                    .filter(function (t) {
                      return !alreadyRecorded.has(t);
                    })
                    .sort(function (a, b) {
                      return (parseFloat(a) || 0) - (parseFloat(b) || 0);
                    });
                }
                var resolvedSire = resolveSire({
                  sow: farrowForm.sow,
                  farrowingDate: farrowForm.farrowingDate,
                  sire: farrowForm.sire,
                });
                var resolvedGroup = matchedCycle ? matchedCycle.group : farrowForm.group;
                var resolvedExposure = matchedCycle ? matchedCycle.exposureStart : farrowForm.exposureStart || '';
                var readOnlyField = {
                  padding: '7px 10px',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  background: 'var(--green-50)',
                  fontSize: 13,
                  color: '#085041',
                };
                return React.createElement(
                  'div',
                  {style: {display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}},
                  // Farrowing date — first so cycle resolves before sow selection
                  React.createElement(
                    'div',
                    null,
                    React.createElement('label', {style: S.label}, 'Farrowing date'),
                    React.createElement('input', {
                      type: 'date',
                      'data-farrow-date': '1',
                      value: farrowForm.farrowingDate,
                      onChange: function (e) {
                        var newDate = e.target.value;
                        var newForm = {...farrowForm, farrowingDate: newDate};
                        // Auto-set group and exposure from matched cycle
                        if (newDate) {
                          var fd2 = new Date(newDate + 'T12:00:00');
                          for (var ci3 = 0; ci3 < breedingCycles.length; ci3++) {
                            var cc2 = breedingCycles[ci3];
                            var ttl2 = calcBreedingTimeline(cc2.exposureStart);
                            if (!ttl2) continue;
                            if (
                              fd2 >= new Date(ttl2.farrowingStart + 'T12:00:00') &&
                              fd2 <= addDays(new Date(ttl2.farrowingEnd + 'T12:00:00'), 14)
                            ) {
                              newForm.group = cc2.group;
                              newForm.exposureStart = cc2.exposureStart;
                              break;
                            }
                          }
                        }
                        setFarrowForm(newForm);
                      },
                    }),
                  ),
                  // Sow — dropdown if cycle matched, text input fallback
                  React.createElement(
                    'div',
                    null,
                    React.createElement('label', {style: S.label}, 'Sow #'),
                    sowOptions.length > 0
                      ? React.createElement(
                          'select',
                          {
                            'data-farrow-sow': '1',
                            value: farrowForm.sow,
                            onChange: function (e) {
                              setFarrowForm({...farrowForm, sow: e.target.value});
                            },
                          },
                          React.createElement('option', {value: ''}, 'Select sow...'),
                          sowOptions.map(function (t) {
                            return React.createElement('option', {key: t, value: t}, '#' + t);
                          }),
                        )
                      : React.createElement('input', {
                          'data-farrow-sow': '1',
                          value: farrowForm.sow,
                          onChange: function (e) {
                            setFarrowForm({...farrowForm, sow: e.target.value});
                          },
                          placeholder: 'e.g. 5',
                        }),
                  ),
                  // Group — read-only when cycle matched
                  React.createElement(
                    'div',
                    null,
                    React.createElement('label', {style: S.label}, 'Group' + (matchedCycle ? ' (from cycle)' : '')),
                    matchedCycle
                      ? React.createElement('div', {style: readOnlyField}, 'Group ' + resolvedGroup)
                      : React.createElement(
                          'select',
                          {
                            value: farrowForm.group,
                            onChange: function (e) {
                              setFarrowForm({...farrowForm, group: e.target.value});
                            },
                          },
                          PIG_GROUPS.map(function (g) {
                            return React.createElement('option', {key: g, value: g}, 'Group ' + g);
                          }),
                        ),
                  ),
                  // Impregnation date (auto)
                  React.createElement(
                    'div',
                    null,
                    React.createElement('label', {style: S.label}, 'Impregnation date (auto)'),
                    React.createElement(
                      'div',
                      {style: {...readOnlyField, color: farrowForm.farrowingDate ? '#085041' : '#aaa'}},
                      farrowForm.farrowingDate
                        ? fmt(toISO(addDays(farrowForm.farrowingDate, -116)))
                        : '\u2014 enter farrowing date \u2014',
                    ),
                    React.createElement(
                      'div',
                      {style: {fontSize: 11, color: 'var(--text-muted)', marginTop: 2}},
                      '116 days before farrowing date',
                    ),
                  ),
                  // Sire (from cycle)
                  React.createElement(
                    'div',
                    null,
                    React.createElement('label', {style: S.label}, 'Sire (from cycle)'),
                    React.createElement(
                      'div',
                      {style: {...readOnlyField, color: resolvedSire ? '#085041' : 'var(--ink-faint)'}},
                      resolvedSire || 'Select sow and farrowing date',
                    ),
                  ),
                  // Exposure start — read-only when cycle matched
                  React.createElement(
                    'div',
                    null,
                    React.createElement(
                      'label',
                      {style: S.label},
                      'Exposure start' + (matchedCycle ? ' (from cycle)' : ''),
                    ),
                    matchedCycle
                      ? React.createElement('div', {style: readOnlyField}, fmt(resolvedExposure))
                      : React.createElement('input', {
                          type: 'date',
                          value: farrowForm.exposureStart,
                          onChange: function (e) {
                            setFarrowForm({...farrowForm, exposureStart: e.target.value});
                          },
                        }),
                  ),
                  // Remaining fields inside the same grid
                  React.createElement(
                    'div',
                    null,
                    React.createElement('label', {style: S.label}, 'Total born'),
                    React.createElement('input', {
                      type: 'number',
                      min: '0',
                      'data-farrow-total-born': '1',
                      value: farrowForm.totalBorn || '',
                      onChange: function (e) {
                        setFarrowForm({...farrowForm, totalBorn: e.target.value});
                      },
                    }),
                  ),
                  React.createElement(
                    'div',
                    null,
                    React.createElement('label', {style: S.label}, 'Deaths'),
                    React.createElement('input', {
                      type: 'number',
                      min: '0',
                      'data-farrow-deaths': '1',
                      value: farrowForm.deaths || '',
                      onChange: function (e) {
                        setFarrowForm({...farrowForm, deaths: e.target.value});
                      },
                    }),
                    React.createElement(
                      'div',
                      {style: {fontSize: 11, color: 'var(--green-700)', marginTop: 3}},
                      'Alive: ' +
                        Math.max(0, (parseInt(farrowForm.totalBorn) || 0) - (parseInt(farrowForm.deaths) || 0)),
                    ),
                  ),
                  React.createElement(
                    'div',
                    null,
                    React.createElement('label', {style: S.label}, 'Mothering quality'),
                    React.createElement(
                      'select',
                      {
                        value: farrowForm.motheringQuality,
                        onChange: function (e) {
                          setFarrowForm({...farrowForm, motheringQuality: e.target.value});
                        },
                      },
                      QUALITY_OPTS.map(function (q) {
                        return React.createElement('option', {key: q, value: q}, qualityLabel(q));
                      }),
                    ),
                  ),
                  React.createElement(
                    'div',
                    null,
                    React.createElement('label', {style: S.label}, 'Location'),
                    React.createElement(
                      'select',
                      {
                        value: farrowForm.location,
                        onChange: function (e) {
                          setFarrowForm({...farrowForm, location: e.target.value});
                        },
                      },
                      LOCATION_OPTS.map(function (l) {
                        return React.createElement('option', {key: l, value: l}, locationLabel(l));
                      }),
                    ),
                  ),
                );
              })()}
              <div>
                <label style={S.label}>Demeanor</label>
                <input
                  value={farrowForm.demeanor}
                  onChange={(e) => setFarrowForm({...farrowForm, demeanor: e.target.value})}
                  placeholder="e.g. Friendly, protective..."
                />
              </div>
              <div>
                <label style={S.label}>What went well?</label>
                <textarea
                  rows={2}
                  value={farrowForm.wentWell}
                  onChange={(e) => setFarrowForm({...farrowForm, wentWell: e.target.value})}
                />
              </div>
              <div>
                <label style={S.label}>What didn't go well?</label>
                <textarea
                  rows={2}
                  value={farrowForm.didntGoWell}
                  onChange={(e) => setFarrowForm({...farrowForm, didntGoWell: e.target.value})}
                />
              </div>
              <div>
                <label style={S.label}>Deaths / Defects</label>
                <textarea
                  rows={2}
                  value={farrowForm.defects}
                  onChange={(e) => setFarrowForm({...farrowForm, defects: e.target.value})}
                />
              </div>
            </div>
            <div style={{padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8}}>
              <button onClick={saveFarrowForm} style={S.btnPrimary} data-farrow-save="1">
                {editFarrowId ? 'Save changes' : 'Add record'}
              </button>
              {editFarrowId && (
                <button
                  onClick={() => {
                    confirmDelete('Delete this farrowing record? This cannot be undone.', () => {
                      // Snapshot the record BEFORE the filter for the best-effort
                      // pig.breeder record.deleted emit below.
                      const deleted = farrowingRecs.find((r) => r.id === editFarrowId) || null;
                      const nb = farrowingRecs.filter((r) => r.id !== editFarrowId);
                      setFarrowingRecs(nb);
                      persistFarrowing(nb);
                      setShowFarrowForm(false);
                      setEditFarrowId(null);
                      // Best-effort pig.breeder record.deleted on the matched sow.
                      if (deleted) recordFarrowingActivity(deleted, 'record.deleted');
                    });
                  }}
                  style={S.btnDanger}
                >
                  Delete
                </button>
              )}
              <button
                onClick={() => {
                  setNotice(null);
                  setShowFarrowForm(false);
                  setEditFarrowId(null);
                }}
                style={S.btnGhost}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem'}}>
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
        {/* Overall totals */}
        <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10}}>
          {[
            {label: 'Total records', val: farrowingRecs.length, color: 'var(--text-primary)'},
            {label: 'Total born', val: grandBorn, color: 'var(--text-primary)'},
            {label: 'Total alive', val: grandAlive, color: 'var(--text-primary)'},
            {label: 'Total deaths', val: grandDead, color: 'var(--danger)'},
            {label: 'Overall survival', val: grandRate + '%', color: 'var(--ok-ink)'},
          ].map((s) => (
            <div
              key={s.label}
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
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  marginBottom: 4,
                }}
              >
                {s.label}
              </div>
              <div style={{fontSize: 20, fontWeight: 700, color: s.color}}>{s.val}</div>
            </div>
          ))}
        </div>

        {/* Per-cycle sections */}
        {sortedCycles.map((c) => {
          const tl = calcBreedingTimeline(c.exposureStart);
          if (!tl) return null;
          const recs = getRecsForCycle(c);
          return (
            <div
              key={c.id}
              style={{
                background: 'white',
                border: '1px solid var(--border)',
                borderRadius: 12,
                overflow: 'hidden',
                boxShadow: 'var(--shadow-sm)',
              }}
            >
              <div
                style={{
                  padding: '10px 16px',
                  background: 'white',
                  borderBottom: '1px solid var(--border)',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '6px 16px',
                  alignItems: 'center',
                }}
              >
                {(() => {
                  // CP0 WI-2b/2c: group identity demoted to a neutral dot + black
                  // cycle label; the program/group hue no longer colors the card
                  // border or the header text.
                  return (
                    <>
                      <span style={{display: 'inline-flex', alignItems: 'center', gap: 6}}>
                        <span style={programDotStyle('pig')} />
                        <strong style={{fontSize: 13, color: 'var(--text-primary)'}}>
                          {cycleLabel(c, cycleSeqMap)}
                        </strong>
                      </span>
                      <span style={{fontSize: 12, color: 'var(--text-secondary)'}}>
                        Boars in: {fmtS(c.exposureStart)} → {fmtS(tl.boarEnd)}
                      </span>
                      <span style={{fontSize: 12, color: 'var(--text-secondary)'}}>
                        Farrowing window: {fmtS(tl.farrowingStart)} → {fmtS(tl.farrowingEnd)}
                      </span>
                      {c.boar1Tags && (
                        <span style={{fontSize: 11, color: 'var(--text-secondary)'}}>
                          {c.boar1Name || boarNames.boar1 || 'Boar 1'}: {c.boar1Tags}
                        </span>
                      )}
                      {c.boar2Tags && (
                        <span style={{fontSize: 11, color: 'var(--text-secondary)'}}>
                          {c.boar2Name || boarNames.boar2 || 'Boar 2'}: {c.boar2Tags}
                        </span>
                      )}
                    </>
                  );
                })()}
                <button
                  data-farrow-add-record={c.id}
                  onClick={() => {
                    setFarrowForm({
                      ...EMPTY_FARROW,
                      group: c.group,
                      exposureStart: c.exposureStart,
                      exposureEnd: tl.boarEnd,
                    });
                    setEditFarrowId(null);
                    setShowFarrowForm(true);
                  }}
                  style={{
                    marginLeft: 'auto',
                    padding: '4px 12px',
                    borderRadius: 10,
                    border: 'none',
                    background: 'var(--green-700)',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  + Add Record
                </button>
              </div>
              <div style={{padding: '12px 16px'}}>
                <CycleStatsBar recs={recs} sowCount={c.sowCount} />
                <RecordsTable recs={recs} />
                {(() => {
                  const missed = getMissedSows(c, recs, tl);
                  if (missed.length === 0) return null;
                  const confirmed = missed.filter((m) => m.status === 'missed');
                  const pending = missed.filter((m) => m.status === 'pending');
                  return (
                    <div style={{marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10}}>
                      <div style={{fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6}}>
                        Sows not yet farrowed this cycle
                      </div>
                      <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
                        {confirmed.map((m) => (
                          <Badge key={m.tag} variant="danger">
                            #{m.tag} — missed
                          </Badge>
                        ))}
                        {pending.map((m) => (
                          <Badge key={m.tag} variant="warn">
                            #{m.tag} — pending
                          </Badge>
                        ))}
                      </div>
                      {confirmed.length > 0 && (
                        <div style={{fontSize: 11, color: 'var(--danger)', marginTop: 5}}>
                          ⚠ {confirmed.length} sow{confirmed.length > 1 ? 's' : ''} confirmed not pregnant this cycle —
                          farrowing window has passed
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          );
        })}

        {/* Master missed sows list */}
        {(() => {
          // Build miss history per sow across all cycles where window has passed
          const missMap = {};
          sortedCycles.forEach((c) => {
            const tl = calcBreedingTimeline(c.exposureStart);
            if (!tl) return;
            const today = new Date();
            if (today <= new Date(tl.farrowingEnd + 'T12:00:00')) return; // window not passed yet
            const recs = getRecsForCycle(c);
            const missed = getMissedSows(c, recs, tl);
            missed
              .filter((m) => m.status === 'missed')
              .forEach((m) => {
                if (!missMap[m.tag]) missMap[m.tag] = {tag: m.tag, cycles: [], lastFarrow: null};
                missMap[m.tag].cycles.push(m.cycleLabel);
              });
          });
          // Add last farrow date for each sow
          Object.keys(missMap).forEach((tag) => {
            const sowRecs = farrowingRecs
              .filter((r) => r.sow.trim() === tag && r.farrowingDate)
              .sort((a, b) => b.farrowingDate.localeCompare(a.farrowingDate));
            missMap[tag].lastFarrow = sowRecs.length > 0 ? sowRecs[0].farrowingDate : null;
          });
          const multiMiss = Object.values(missMap)
            .filter((s) => s.cycles.length > 1)
            .sort((a, b) => b.cycles.length - a.cycles.length);
          if (multiMiss.length === 0) return null;
          return (
            <div
              style={{
                background: 'white',
                border: '1px solid var(--border)',
                borderRadius: 12,
                overflow: 'hidden',
                boxShadow: 'var(--shadow-sm)',
              }}
            >
              <div
                style={{
                  padding: '10px 16px',
                  background: 'var(--danger-soft)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <strong style={{fontSize: 13, color: 'var(--danger)'}}>
                  ⚠ Sows Missing Multiple Cycles ({multiMiss.length})
                </strong>
                <span style={{fontSize: 11, color: 'var(--danger)'}}>
                  These sows have failed to farrow in 2 or more cycles — review for culling
                </span>
              </div>
              <div style={{padding: '12px 16px'}}>
                <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 12}}>
                  <thead>
                    <tr style={{background: 'var(--green-50)', borderBottom: '1px solid var(--border)'}}>
                      <th
                        style={{
                          padding: '6px 10px',
                          textAlign: 'left',
                          fontWeight: 600,
                          color: 'var(--text-secondary)',
                        }}
                      >
                        Sow #
                      </th>
                      <th
                        style={{
                          padding: '6px 10px',
                          textAlign: 'center',
                          fontWeight: 600,
                          color: 'var(--text-secondary)',
                        }}
                      >
                        Cycles Missed
                      </th>
                      <th
                        style={{
                          padding: '6px 10px',
                          textAlign: 'left',
                          fontWeight: 600,
                          color: 'var(--text-secondary)',
                        }}
                      >
                        Last Farrowing
                      </th>
                      <th
                        style={{
                          padding: '6px 10px',
                          textAlign: 'left',
                          fontWeight: 600,
                          color: 'var(--text-secondary)',
                        }}
                      >
                        Missed Cycles
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {multiMiss.map((s, i) => (
                      <tr
                        key={s.tag}
                        style={{borderBottom: '1px solid #f5f5f5', background: i % 2 === 0 ? 'white' : '#fafafa'}}
                      >
                        <td style={{padding: '7px 10px', fontWeight: 700, color: 'var(--danger)'}}>#{s.tag}</td>
                        <td style={{padding: '7px 10px', textAlign: 'center'}}>
                          <Badge variant="danger">{s.cycles.length}</Badge>
                        </td>
                        <td
                          style={{
                            padding: '7px 10px',
                            color: s.lastFarrow ? 'var(--text-primary)' : 'var(--text-muted)',
                          }}
                        >
                          {s.lastFarrow ? fmt(s.lastFarrow) : 'Never farrowed'}
                        </td>
                        <td style={{padding: '7px 10px', color: 'var(--text-secondary)', fontSize: 11}}>
                          {s.cycles.join(' · ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}

        {/* Unlinked records */}
        {unlinked.length > 0 && (
          <div
            style={{
              background: 'white',
              border: '1px solid var(--border)',
              borderRadius: 12,
              overflow: 'hidden',
              boxShadow: 'var(--shadow-sm)',
            }}
          >
            <div
              style={{
                padding: '10px 16px',
                background: 'var(--green-50)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <strong style={{fontSize: 13, color: 'var(--text-secondary)'}}>Unlinked records</strong>
              <span style={{fontSize: 11, color: 'var(--text-muted)'}}>
                These don't match any breeding cycle — edit to assign group/date
              </span>
              <button
                onClick={() => {
                  setFarrowForm(EMPTY_FARROW);
                  setEditFarrowId(null);
                  setShowFarrowForm(true);
                }}
                style={{
                  marginLeft: 'auto',
                  padding: '4px 12px',
                  borderRadius: 10,
                  border: 'none',
                  background: getProgramColor('pig'),
                  color: getReadableText(getProgramColor('pig')),
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                + Add Record
              </button>
            </div>
            <div style={{padding: '12px 16px'}}>
              <CycleStatsBar recs={unlinked} sowCount={0} />
              <RecordsTable recs={unlinked} />
            </div>
          </div>
        )}

        {farrowingRecs.length === 0 && (
          <div style={{textAlign: 'center', padding: '3rem', color: 'var(--text-muted)', fontSize: 13}}>
            No farrowing records yet — use the "+ Add Record" button inside each cycle group
          </div>
        )}
      </div>
    </div>
  );
}
