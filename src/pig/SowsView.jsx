// ============================================================================
// src/pig/SowsView.jsx  —  Phase 2 Round 6
// ----------------------------------------------------------------------------
// Breeding pigs tab — sow/boar registry + archived records. Breeder form
// state comes from usePig(); persistBreeders is still an App helper and
// comes in as a prop.
// ============================================================================
import React from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import {sb} from '../lib/supabase.js';
import {fmt, fmtS, todayISO, addDays} from '../lib/dateUtils.js';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {printRows} from '../lib/printExport.js';
import {recordSeqNavOptions, labeledSeqItems} from '../lib/recordSequence.js';
import {S} from '../lib/styles.js';
import {calcBreedingTimeline, buildCycleSeqMap, cycleLabel, PIG_GROUPS, PIG_GROUP_COLORS} from '../lib/pig.js';
import {buildChanges} from '../lib/activityChangeDiff.js';
import {recordActivityEvent, recordFieldChange} from '../lib/entityMutations.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import DataTable from '../shared/DataTable.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import StatusText from '../shared/StatusText.jsx';
import OperationalListEmptyState from '../shared/OperationalListEmptyState.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';
import RecordSequenceNav from '../shared/RecordSequenceNav.jsx';
import {RecordPageBody, RecordBackLink, RecordPageNotFound, RecordTitle} from '../shared/RecordPageShell.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {usePig} from '../contexts/PigContext.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';

const BREEDING_PIG_ENTITY_TYPE = 'pig.breeder';
const EXTENDED_LIST_CONTROLS_ENABLED = false;
const BREEDER_ACTIVITY_LABELS = {
  tag: 'Tag',
  sex: 'Sex',
  group: 'Group',
  status: 'Status',
  breed: 'Breed',
  origin: 'Origin',
  birthDate: 'Birth date',
  lastWeight: 'Last recorded weight',
  purchaseDate: 'Purchase date',
  purchaseAmount: 'Purchase amount',
  notes: 'Notes',
};

export default function SowsView({
  Header,
  loadUsers,
  persistBreeders,
  persistBreedOptions,
  persistOriginOptions,
  confirmDelete,
  resolveSire,
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const {authState} = useAuth();
  const [leaderboardExpanded, setLeaderboardExpanded] = React.useState(false);
  const [showArchived, setShowArchived] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  const [exportNotice, setExportNotice] = React.useState('');
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
  } = usePig();
  const {pigDailys} = useDailysRecent();
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

  const breederSearchQ = (sowSearch || '').trim().toLowerCase();
  function breederMatchesSearch(pig) {
    if (!breederSearchQ) return true;
    return [pig.tag, pig.sex, pig.group ? 'Group ' + pig.group : '', pig.status, pig.breed, pig.origin, pig.notes]
      .map((v) => String(v || '').toLowerCase())
      .some((v) => v.includes(breederSearchQ));
  }

  const activePigs = sortPigs(breeders.filter((p) => !p.archived && breederMatchesSearch(p)));
  const archivedPigs = sortPigs(breeders.filter((p) => p.archived && breederMatchesSearch(p)));
  const activeSows = activePigs.filter((p) => p.sex === 'Sow' || p.sex === 'Gilt');
  const activeBoars = activePigs.filter((p) => p.sex === 'Boar');
  const breedingPigSeqRows = [...activeSows, ...activeBoars, ...(showArchived ? archivedPigs : [])];
  const filteredBreederCount = breedingPigSeqRows.length;
  const recordMode = location.pathname.startsWith('/pig/sows/');
  const recordRawId = recordMode ? location.pathname.slice('/pig/sows/'.length).split('/')[0] || '' : null;
  let recordId = recordRawId;
  if (recordMode) {
    try {
      recordId = decodeURIComponent(recordRawId);
    } catch {
      recordId = recordRawId;
    }
  }
  const recordSeq = location.state?.recordSeq || null;
  const recordPig = recordMode ? breeders.find((p) => String(p.id) === String(recordId)) : null;

  function goToBreedingPigs() {
    navigate('/pig/sows');
  }

  function navigateSeq(id) {
    navigate('/pig/sows/' + encodeURIComponent(id), recordSeqNavOptions(recordSeq));
  }

  function openBreedingPigRecord(pig, rows) {
    navigate('/pig/sows/' + encodeURIComponent(pig.id), recordSeqNavOptions(labeledSeqItems(rows, 'tag')));
  }

  function openBreedingPigEditor(pig) {
    setNotice(null);
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
  }

  function breedingPigTitle(pig) {
    if (!pig) return 'Breeding Pig';
    const sex = pig.sex ? ' ' + pig.sex : '';
    return '#' + (pig.tag || pig.id) + sex;
  }

  function breedingPigEntityLabel(pig) {
    return pig && pig.tag ? '#' + pig.tag : pig?.id || 'Breeding Pig';
  }

  function latestBreederWeight(pig) {
    const weighins = Array.isArray(pig.weighins) ? pig.weighins : [];
    return weighins.length > 0 ? weighins[weighins.length - 1].weight : pig.lastWeight;
  }

  function groupLabelForPig(pig) {
    return pig.group ? 'Group ' + pig.group : 'No group';
  }

  function currencyLabel(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) && n > 0 ? '$' + n.toLocaleString() : '-';
  }

  function displayCell(value) {
    return value == null || value === '' ? '-' : value;
  }

  function breedingPigExportColumns() {
    return [
      {header: 'Tag', value: (pig) => pig.tag},
      {header: 'Sex', value: (pig) => pig.sex},
      {header: 'Group', value: (pig) => (pig.group ? 'Group ' + pig.group : '')},
      {header: 'Status', value: (pig) => pig.status},
      {header: 'Breed', value: (pig) => pig.breed},
      {header: 'Origin', value: (pig) => pig.origin},
      {header: 'Birth date', value: (pig) => pig.birthDate},
      {header: 'Age', value: (pig) => pigAge(pig.birthDate)},
      {header: 'Last weight', value: (pig) => latestBreederWeight(pig)},
      {header: 'Purchase date', value: (pig) => pig.purchaseDate},
      {header: 'Purchase amount', value: (pig) => pig.purchaseAmount},
      {header: 'Litters', value: (pig) => sowFarrowStats(pig.tag).litters},
      {header: 'Alive total', value: (pig) => sowFarrowStats(pig.tag).alive},
      {header: 'Notes', value: (pig) => pig.notes},
      {header: 'Record ID', value: (pig) => pig.id},
    ];
  }

  function handleExportCsv() {
    const columns = breedingPigExportColumns();
    const ok = downloadCsv(csvFilename('pig-breeding-pigs'), rowsToCsv(columns, breedingPigSeqRows));
    setExportNotice(ok ? '' : 'CSV export is only available in the browser.');
  }

  function handlePrintRows() {
    const columns = breedingPigExportColumns();
    const ok = printRows({
      title: 'Breeding Pigs',
      subtitle: breedingPigSeqRows.length + ' visible breeding pigs',
      columns,
      rows: breedingPigSeqRows,
    });
    setExportNotice(ok ? '' : 'Print is only available in the browser.');
  }

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

  async function saveBreeder() {
    setNotice(null);
    if (!breederForm.tag.trim()) {
      setNotice({kind: 'error', message: 'Please enter a tag number.'});
      return;
    }
    const dup = breeders.find((b) => b.tag.trim() === breederForm.tag.trim() && b.id !== editBreederId);
    if (dup) {
      setNotice({kind: 'error', message: `Tag #${breederForm.tag} already exists.`});
      return;
    }
    const existing = editBreederId ? breeders.find((b) => b.id === editBreederId) : null;
    const pig = {
      id: editBreederId || String(Date.now()),
      ...breederForm,
      archived:
        breederForm.status === 'Deceased' || breederForm.status === 'Processed' || breederForm.status === 'Sold',
    };
    const nb = editBreederId ? breeders.map((b) => (b.id === editBreederId ? pig : b)) : [...breeders, pig];
    setBreeders(nb);
    await persistBreeders(nb);
    try {
      if (existing) {
        const changes = buildChanges(existing, pig, {
          exclude: ['id', 'archived', 'weighins'],
          labels: BREEDER_ACTIVITY_LABELS,
        });
        if (changes.length > 0) {
          await recordFieldChange(sb, {
            entityType: BREEDING_PIG_ENTITY_TYPE,
            entityId: pig.id,
            entityLabel: breedingPigEntityLabel(pig),
            changes,
          });
        }
      } else {
        await recordActivityEvent(sb, {
          entityType: BREEDING_PIG_ENTITY_TYPE,
          entityId: pig.id,
          entityLabel: breedingPigEntityLabel(pig),
          eventType: 'record.created',
          body: 'Added breeding pig ' + breedingPigEntityLabel(pig),
          payload: {record: 'pig.breeder', tag: pig.tag, sex: pig.sex, group: pig.group || null},
        });
      }
    } catch (_e) {
      /* best-effort audit trail; app_store persistence remains canonical */
    }
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
                borderRadius: 10,
                border: '1px solid var(--border-strong)',
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
                borderRadius: 10,
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
                borderRadius: 10,
                border: '1px solid var(--border-strong)',
                background: 'white',
                cursor: 'pointer',
                fontSize: 12,
                color: 'var(--ink-muted)',
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

  // CP3: animal-list rows now render through the shared <DataTable> (real
  // table semantics, openable rows with right-aligned numerics; DataTable owns
  // the keyboard-open wiring). The section chrome (title band + count + muted
  // state) is preserved around it; the view's own grouping/sort/filter still
  // feed `pigs`/`rows` unchanged.
  const breedingPigColumns = [
    {
      key: 'tag',
      label: 'Tag',
      primary: true,
      render: (pig) => (
        <span style={{fontWeight: 700, color: 'var(--ink)'}}>{pig.tag ? '#' + pig.tag : '(no tag)'}</span>
      ),
    },
    {key: 'sex', label: 'Sex', render: (pig) => <StatusText tone="muted">{displayCell(pig.sex)}</StatusText>},
    {key: 'group', label: 'Group', render: (pig) => <StatusText tone="muted">{groupLabelForPig(pig)}</StatusText>},
    {key: 'status', label: 'Status', render: (pig) => <StatusText tone="muted">{displayCell(pig.status)}</StatusText>},
    {
      key: 'breed',
      label: 'Breed',
      mobilePriority: false,
      render: (pig) => <StatusText tone="muted">{displayCell(pig.breed)}</StatusText>,
    },
    {
      key: 'origin',
      label: 'Origin',
      mobilePriority: false,
      render: (pig) => <StatusText tone="muted">{displayCell(pig.origin)}</StatusText>,
    },
    {
      key: 'birth',
      label: 'Birth',
      render: (pig) => (
        <StatusText tone="muted">
          {pig.birthDate ? fmtS(pig.birthDate) + ' (' + pigAge(pig.birthDate) + ')' : '-'}
        </StatusText>
      ),
    },
    {
      key: 'weight',
      label: 'Weight',
      align: 'right',
      render: (pig) => {
        const latestWeight = latestBreederWeight(pig);
        return latestWeight ? (
          <span style={{color: '#065f46', fontWeight: 700}}>{latestWeight + ' lb'}</span>
        ) : (
          <StatusText tone="muted">{'-'}</StatusText>
        );
      },
    },
    {
      key: 'purchase',
      label: 'Purchase',
      mobilePriority: false,
      render: (pig) => (
        <StatusText tone="muted">
          {(pig.purchaseDate ? fmtS(pig.purchaseDate) : '-') + ' ' + currencyLabel(pig.purchaseAmount)}
        </StatusText>
      ),
    },
    {
      key: 'litters',
      label: 'Litters',
      align: 'right',
      render: (pig) => {
        const isSow = pig.sex === 'Sow' || pig.sex === 'Gilt';
        if (!isSow) return <StatusText tone="muted">{'-'}</StatusText>;
        const stats = sowFarrowStats(pig.tag);
        return (
          <span style={{color: '#065f46', fontWeight: 700}}>{stats.litters + ' / ' + stats.alive + ' alive'}</span>
        );
      },
    },
    {
      key: 'notes',
      label: 'Notes',
      render: (pig) => {
        const transfer = pig.transferredFromBatch;
        const transferLabel = transfer
          ? 'Saved from ' +
            (transfer.subBatchName || transfer.batchName || '?') +
            (transfer.transferDate ? ' on ' + fmtS(transfer.transferDate) : '')
          : '';
        return <StatusText tone="muted">{pig.notes || transferLabel || '-'}</StatusText>;
      },
    },
    {
      key: 'edit',
      label: '',
      mobilePriority: false,
      render: (pig) => (
        <button
          type="button"
          data-breeding-pig-edit={pig.id}
          onClick={(e) => {
            e.stopPropagation();
            openBreedingPigEditor(pig);
          }}
          style={{
            padding: '4px 8px',
            borderRadius: 10,
            border: '1px solid var(--border-strong)',
            background: 'white',
            color: '#085041',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'inherit',
          }}
        >
          Edit
        </button>
      ),
    },
  ];

  function BreedingPigTableSection({title, pigs, color = '#085041', rows = breedingPigSeqRows, muted = false}) {
    if (!pigs || pigs.length === 0) return null;
    return (
      <div
        data-breeding-pig-table-section={title}
        style={{
          border: '1px solid var(--border)',
          borderRadius: 10,
          overflow: 'hidden',
          background: 'white',
          opacity: muted ? 0.78 : 1,
        }}
      >
        <div
          style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--border)',
            borderLeft: '3px solid ' + color,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span style={{fontWeight: 700, fontSize: 13, color}}>{title}</span>
          <span style={{fontSize: 12, color: 'var(--ink-muted)'}}>
            {pigs.length} {pigs.length === 1 ? 'pig' : 'pigs'}
          </span>
        </div>
        <DataTable
          surfaceKey="breeding-pig-table"
          rows={pigs}
          rowKey="id"
          density="comfortable"
          showRowNumbers
          columns={breedingPigColumns}
          onRowOpen={(pig) => openBreedingPigRecord(pig, rows)}
          rowProps={(pig) => ({'data-breeding-pig-row': pig.id})}
        />
      </div>
    );
  }

  function BreedingPigRecordDetails({pig}) {
    const stats = sowFarrowStats(pig.tag);
    const isSow = pig.sex === 'Sow' || pig.sex === 'Gilt';
    const history = isSow ? sowFarrowHistory(pig.tag) : [];
    const weighins = Array.isArray(pig.weighins) ? pig.weighins : [];
    const latestWeight = latestBreederWeight(pig);
    const fieldStyle = {background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px'};
    const labelStyle = {fontSize: 11, color: 'var(--ink-muted)', marginBottom: 3};
    const valueStyle = {fontSize: 14, color: 'var(--ink)', fontWeight: 600};
    const value = (v) => (v == null || v === '' ? '\u2014' : v);

    return (
      <div data-breeding-pig-record-details="1" style={{display: 'flex', flexDirection: 'column', gap: 12}}>
        <div
          style={{
            background: 'white',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: 14,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))',
            gap: 10,
          }}
        >
          <div style={fieldStyle}>
            <div style={labelStyle}>Tag #</div>
            <div style={valueStyle}>{value(pig.tag)}</div>
          </div>
          <div style={fieldStyle}>
            <div style={labelStyle}>Sex</div>
            <div style={valueStyle}>{value(pig.sex)}</div>
          </div>
          <div style={fieldStyle}>
            <div style={labelStyle}>Group</div>
            <div style={valueStyle}>{pig.group ? 'Group ' + pig.group : 'No group'}</div>
          </div>
          <div style={fieldStyle}>
            <div style={labelStyle}>Status</div>
            <div style={valueStyle}>{value(pig.status)}</div>
          </div>
          <div style={fieldStyle}>
            <div style={labelStyle}>Breed</div>
            <div style={valueStyle}>{value(pig.breed)}</div>
          </div>
          <div style={fieldStyle}>
            <div style={labelStyle}>Origin</div>
            <div style={valueStyle}>{value(pig.origin)}</div>
          </div>
          <div style={fieldStyle}>
            <div style={labelStyle}>Birth Date</div>
            <div style={valueStyle}>
              {pig.birthDate ? fmtS(pig.birthDate) + ' (' + pigAge(pig.birthDate) + ')' : '\u2014'}
            </div>
          </div>
          <div style={fieldStyle}>
            <div style={labelStyle}>Last Recorded Weight</div>
            <div style={valueStyle}>{latestWeight ? latestWeight + ' lbs' : '\u2014'}</div>
          </div>
          <div style={fieldStyle}>
            <div style={labelStyle}>Purchase Date</div>
            <div style={valueStyle}>{pig.purchaseDate ? fmtS(pig.purchaseDate) : '\u2014'}</div>
          </div>
          <div style={fieldStyle}>
            <div style={labelStyle}>Purchase Amount</div>
            <div style={valueStyle}>
              {pig.purchaseAmount ? '$' + Number(pig.purchaseAmount).toLocaleString() : '\u2014'}
            </div>
          </div>
          {isSow && (
            <>
              <div style={fieldStyle}>
                <div style={labelStyle}>Litters</div>
                <div style={valueStyle}>{stats.litters}</div>
              </div>
              <div style={fieldStyle}>
                <div style={labelStyle}>Alive Total</div>
                <div style={{...valueStyle, color: '#065f46'}}>{stats.alive}</div>
              </div>
            </>
          )}
        </div>

        {weighins.length > 0 && (
          <div style={{background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: 14}}>
            <div style={{fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 8}}>Weight History</div>
            <div data-breeding-pig-weight-history={pig.id} style={{display: 'flex', flexWrap: 'wrap', gap: '6px 12px'}}>
              {weighins
                .slice()
                .reverse()
                .map((w, wi) => (
                  <span key={wi} style={{fontSize: 12, color: 'var(--ink-muted)'}}>
                    <strong style={{color: 'var(--ink)'}}>{w.weight} lb</strong>{' '}
                    <span style={{color: 'var(--ink-faint)'}}>{fmtS(w.date)}</span>
                  </span>
                ))}
            </div>
          </div>
        )}

        {isSow && history.length > 0 && (
          <div style={{background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: 14}}>
            <div style={{fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 8}}>Farrowing History</div>
            <div data-breeding-pig-farrowing-history={pig.id} style={{display: 'flex', flexDirection: 'column'}}>
              {history
                .filter(function (h2) {
                  if (h2.missed && h2.tl && h2.tl.farrowingEnd >= todayISO()) return false;
                  return true;
                })
                .map(function (h, hi) {
                  if (h.missed) {
                    return (
                      <div
                        key={hi}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '7px 0',
                          borderBottom: hi < history.length - 1 ? '1px solid var(--divider)' : 'none',
                          fontSize: 12,
                        }}
                      >
                        <span
                          style={{
                            color: '#b91c1c',
                            fontWeight: 700,
                            background: '#fef2f2',
                            padding: '1px 6px',
                            borderRadius: 10,
                            fontSize: 10,
                          }}
                        >
                          MISSED
                        </span>
                        <span style={{color: 'var(--ink-muted)'}}>
                          {cycleLabel(h.cycle, cycleSeqMap) + ' - ' + fmt(h.cycle.exposureStart)}
                        </span>
                        {h.sire && <span style={{color: 'var(--ink-faint)'}}>{'Sire: ' + h.sire}</span>}
                      </div>
                    );
                  }
                  const born = parseInt(h.rec.totalBorn) || 0;
                  const dead = parseInt(h.rec.deaths) || 0;
                  const alive = born - dead;
                  return (
                    <div
                      key={hi}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '7px 0',
                        borderBottom: hi < history.length - 1 ? '1px solid var(--divider)' : 'none',
                        fontSize: 12,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span style={{color: 'var(--ink)', fontWeight: 700, minWidth: 90}}>
                        {fmt(h.rec.farrowingDate)}
                      </span>
                      <span style={{color: '#065f46', fontWeight: 700}}>{alive + ' alive'}</span>
                      <span style={{color: 'var(--ink-faint)'}}>{born + ' born'}</span>
                      {dead > 0 && <span style={{color: '#b91c1c'}}>{dead + ' died'}</span>}
                      {h.cycle && <span style={{color: 'var(--ink-faint)'}}>{cycleLabel(h.cycle, cycleSeqMap)}</span>}
                      {h.sire && <span style={{color: 'var(--ink-faint)'}}>{h.sire}</span>}
                    </div>
                  );
                })}
            </div>
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
                data-breeding-pig-transfer-note={pig.id}
                style={{
                  padding: '8px 12px',
                  background: '#f5f3ff',
                  border: '1px solid #ddd6fe',
                  borderRadius: 10,
                  fontSize: 12,
                  color: '#5b21b6',
                  fontWeight: 700,
                }}
              >
                {'This ' + sexNoun + ' was saved from ' + sourceLabel + dateStr + '.'}
              </div>
            );
          })()}

        {pig.notes && (
          <div
            data-breeding-pig-notes={pig.id}
            style={{
              background: 'white',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: 14,
              fontSize: 13,
              color: 'var(--ink-muted)',
            }}
          >
            <div style={{fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 6}}>Notes</div>
            {pig.notes}
          </div>
        )}
      </div>
    );
  }

  if (recordMode && !recordPig) {
    return (
      <RecordPageNotFound
        Header={Header}
        backLabel="Back to Breeding Pigs"
        onBack={goToBreedingPigs}
        message="Breeding pig not found."
        data-breeding-pig-record-not-found="true"
      />
    );
  }

  if (recordMode && recordPig) {
    return (
      <div style={{minHeight: '100vh', background: 'var(--bg-page)'}}>
        <Header />
        <RecordPageBody maxWidth={960} data-breeding-pig-record-loaded="true">
          <RecordBackLink label="Back to Breeding Pigs" onBack={goToBreedingPigs} />
          <RecordSequenceNav seq={recordSeq} currentId={recordId} onNavigate={navigateSeq} />
          <RecordTitle>{breedingPigTitle(recordPig)}</RecordTitle>
          <BreedingPigRecordDetails pig={recordPig} />
          <RecordCollaborationSection
            sb={sb}
            authState={authState}
            entityType={BREEDING_PIG_ENTITY_TYPE}
            entityId={recordPig.id}
            entityLabel={breedingPigEntityLabel(recordPig)}
          />
        </RecordPageBody>
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
              border: '1px solid var(--border)',
              borderRadius: 12,
              overflow: 'hidden',
              boxShadow: '0 1px 4px rgba(0,0,0,.06)',
            }}
          >
            <div
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid var(--border)',
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
                    <span style={{fontSize: 11, color: 'var(--ink-faint)', marginLeft: 8}}>
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
                border: '1px solid var(--border)',
                borderRadius: 12,
                overflow: 'hidden',
                boxShadow: '0 1px 4px rgba(0,0,0,.06)',
              },
            },
            React.createElement(
              'div',
              {style: {padding: '12px 16px', borderBottom: '1px solid var(--border)', background: '#f8fafb'}},
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
                      {style: {fontSize: 11, color: 'var(--ink-faint)', marginLeft: 8}},
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

        {/* Search + add pig */}
        <div
          style={{display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center'}}
        >
          <div style={{display: 'flex', gap: 8, alignItems: 'center', flex: '1 1 280px', maxWidth: 520}}>
            <input
              data-breeding-pig-search="1"
              value={sowSearch || ''}
              onChange={(e) => setSowSearch(e.target.value)}
              placeholder="Search tag, group, breed, status..."
              style={{flex: 1, minWidth: 0}}
            />
            {sowSearch && (
              <button
                type="button"
                data-breeding-pig-search-clear="1"
                onClick={() => setSowSearch('')}
                style={{
                  padding: '7px 12px',
                  borderRadius: 10,
                  border: '1px solid var(--border-strong)',
                  background: 'white',
                  color: 'var(--ink-muted)',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                }}
              >
                Clear
              </button>
            )}
          </div>
          <div style={{display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end'}}>
            {EXTENDED_LIST_CONTROLS_ENABLED && (
              <>
                <button
                  type="button"
                  data-breeding-pigs-export-csv="1"
                  onClick={handleExportCsv}
                  disabled={breedingPigSeqRows.length === 0}
                  style={{
                    padding: '7px 12px',
                    borderRadius: 10,
                    border: '1px solid var(--border-strong)',
                    background: 'white',
                    color: breedingPigSeqRows.length === 0 ? 'var(--ink-faint)' : '#085041',
                    cursor: breedingPigSeqRows.length === 0 ? 'not-allowed' : 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: 'inherit',
                  }}
                >
                  Export CSV
                </button>
                <button
                  type="button"
                  data-breeding-pigs-print="1"
                  onClick={handlePrintRows}
                  disabled={breedingPigSeqRows.length === 0}
                  style={{
                    padding: '7px 12px',
                    borderRadius: 10,
                    border: '1px solid var(--border-strong)',
                    background: 'white',
                    color: breedingPigSeqRows.length === 0 ? 'var(--ink-faint)' : '#085041',
                    cursor: breedingPigSeqRows.length === 0 ? 'not-allowed' : 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: 'inherit',
                  }}
                >
                  Print
                </button>
              </>
            )}
            <button
              onClick={() => {
                setNotice(null);
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
                borderRadius: 10,
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
        </div>
        {exportNotice && <div style={{fontSize: 12, color: '#b91c1c'}}>{exportNotice}</div>}

        {/* Add/Edit form — modal overlay */}
        {showBreederForm && (
          <div
            onClick={() => {
              setNotice(null);
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
                  borderBottom: '1px solid var(--border)',
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
                    setNotice(null);
                    setShowBreederForm(false);
                    setEditBreederId(null);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: 22,
                    cursor: 'pointer',
                    color: 'var(--ink-faint)',
                    lineHeight: 1,
                    padding: '0 4px',
                  }}
                >
                  ×
                </button>
              </div>
              <div style={{padding: '16px 20px'}}>
                <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
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
                      setNotice(null);
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
                  <BreedingPigTableSection
                    key={grp}
                    title={grp !== 'none' ? `Group ${grp}` : 'No Group'}
                    pigs={pigs}
                    color={C ? C.farrowing : '#374151'}
                    rows={breedingPigSeqRows}
                  />
                );
              });
            })()}
          </div>
        )}

        <BreedingPigTableSection title="Boars" pigs={activeBoars} color="#1e40af" rows={breedingPigSeqRows} />

        {/* Archived */}
        {archivedPigs.length > 0 && (
          <div>
            <button
              onClick={() => setShowArchived((s) => !s)}
              style={{
                fontSize: 12,
                color: 'var(--ink-faint)',
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
              <div style={{marginTop: 8}}>
                <BreedingPigTableSection
                  title="Archived"
                  pigs={archivedPigs}
                  color="#6b7280"
                  rows={breedingPigSeqRows}
                  muted={true}
                />
              </div>
            )}
          </div>
        )}

        <OperationalListEmptyState
          totalCount={breeders.length}
          filteredCount={filteredBreederCount}
          emptyLabel="No breeding pigs yet"
          filteredLabel="No breeding pigs match the current search"
          data-empty-state="breeding-pigs"
        />

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
                border: '1px solid var(--border)',
                borderRadius: 12,
                overflow: 'hidden',
                boxShadow: '0 1px 4px rgba(0,0,0,.06)',
              }}
            >
              <div
                style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid var(--border)',
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
                  <div style={{fontSize: 11, color: 'var(--ink-muted)', marginBottom: 10}}>
                    Total: <strong style={{color: 'var(--ink)'}}>{Math.round(sowTotal).toLocaleString()} lbs</strong>{' '}
                    from {sowDailys.length} reports
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
                      <span style={{color: 'var(--ink-muted)'}}>{fmtMonth(ym)}</span>
                      <span style={{fontWeight: 600, color: '#085041'}}>{Math.round(lbs).toLocaleString()} lbs</span>
                    </div>
                  ))}
                </div>
                {/* BOARS */}
                <div>
                  <div style={{fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 8}}>BOARS</div>
                  <div style={{fontSize: 11, color: 'var(--ink-muted)', marginBottom: 10}}>
                    Total: <strong style={{color: 'var(--ink)'}}>{Math.round(boarTotal).toLocaleString()} lbs</strong>{' '}
                    from {boarDailys.length} reports
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
                      <span style={{color: 'var(--ink-muted)'}}>{fmtMonth(ym)}</span>
                      <span style={{fontWeight: 600, color: 'var(--ink)'}}>{Math.round(lbs).toLocaleString()} lbs</span>
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
