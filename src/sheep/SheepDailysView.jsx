// Rewritten 2026-04-21 session (2nd pass): full cattle parity.
// sheep_dailys now carries feeds + minerals jsonb (migration 012); feed master
// list is the shared cattle_feed_inputs, scoped to sheep flocks via herd_scope.
// Edit modal has multi-row feed + mineral pickers (mirrors CattleDailysView).
// Card tile shows feed / mineral summary lines. Comments that are just
// "None" / "none" / "0" / "n/a" no longer render as a pill badge.
import React from 'react';
import {S} from '../lib/styles.js';
import {loadRoster, activeNames} from '../lib/teamMembers.js';
import AdminAddReportModal from '../shared/AdminAddReportModal.jsx';
import DailyPhotoChip from '../shared/DailyPhotoChip.jsx';
import DailyPhotoThumbnails from '../shared/DailyPhotoThumbnails.jsx';

// "nothing to report" sentinels — don't render these as a comment badge.
// Public-webform placeholder now tells the team to enter "0"; this covers
// both that convention and legacy "None" / "none" / "n/a" entries.
const isSentinelComment = (s) => {
  if (s == null) return true;
  const t = String(s).trim().toLowerCase();
  return t === '' || t === 'none' || t === '0' || t === 'n/a' || t === 'na' || t === '-';
};

const SheepDailysView = ({sb, fmt, Header, authState, pendingEdit, setPendingEdit, refreshDailys}) => {
  const {useState, useEffect} = React;
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const [records, setRecords] = useState([]);
  const [feedInputs, setFeedInputs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editId, setEditId] = useState(null);
  const [editSource, setEditSource] = useState(null);
  const [form, setForm] = useState(null);
  const [teamMembers, setTeamMembers] = useState([]);
  const [fFlock, setFFlock] = useState('');
  const [fTeam, setFTeam] = useState('');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const [srcFilter, setSrcFilter] = useState('all');

  const FLOCKS = ['rams', 'ewes', 'feeders', 'processed', 'deceased', 'sold'];
  const SHEEP_ACTIVE_FLOCKS = ['rams', 'ewes', 'feeders'];
  const FLOCK_LABELS = {
    rams: 'Rams',
    ewes: 'Ewes',
    feeders: 'Feeders',
    processed: 'Processed',
    deceased: 'Deceased',
    sold: 'Sold',
  };
  const FLOCK_COLORS = {
    rams: {bg: '#f0fdfa', tx: '#0f766e', bd: '#5eead4'},
    ewes: {bg: '#fdf4ff', tx: '#86198f', bd: '#f0abfc'},
    feeders: {bg: '#fefce8', tx: '#854d0e', bd: '#fde047'},
    processed: {bg: '#f3f4f6', tx: '#374151', bd: '#d1d5db'},
    deceased: {bg: '#f9fafb', tx: '#6b7280', bd: '#e5e7eb'},
    sold: {bg: '#eff6ff', tx: '#1e40af', bd: '#bfdbfe'},
  };

  const PAGE = 1000;
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    sb.from('sheep_dailys')
      .select('*')
      .order('date', {ascending: false})
      .order('submitted_at', {ascending: false})
      .range(0, PAGE - 1)
      .then(({data}) => {
        if (data) {
          setRecords(data);
          setHasMore(data.length === PAGE);
          if (pendingEdit && pendingEdit.viewName === 'sheepdailys' && pendingEdit.id) {
            const r = data.find((x) => x.id === pendingEdit.id);
            if (r) {
              openEdit(r);
              setPendingEdit && setPendingEdit(null);
            }
          }
        }
        setLoading(false);
      });
    sb.from('cattle_feed_inputs')
      .select('*')
      .eq('status', 'active')
      .order('category')
      .order('name')
      .then(({data}) => {
        if (data) setFeedInputs(data.filter((f) => (f.herd_scope || []).some((h) => SHEEP_ACTIVE_FLOCKS.includes(h))));
      });
    loadRoster(sb).then((roster) => setTeamMembers(activeNames(roster)));
  }, []);

  const pgLoading = React.useRef(false);
  useEffect(() => {
    if (hasMore && !pgLoading.current) {
      pgLoading.current = true;
      const next = page + 1;
      sb.from('sheep_dailys')
        .select('*')
        .order('date', {ascending: false})
        .order('submitted_at', {ascending: false})
        .range(next * PAGE, (next + 1) * PAGE - 1)
        .then(({data}) => {
          pgLoading.current = false;
          if (data) {
            setRecords((r) => {
              const ids = new Set(r.map((x) => x.id));
              return [...r, ...data.filter((x) => !ids.has(x.id))];
            });
            setHasMore(data.length === PAGE);
            setPage(next);
          }
        });
    }
  }, [hasMore, page]);

  function openEdit(d) {
    setForm({
      date: d.date || todayStr(),
      teamMember: d.team_member || '',
      flock: d.flock || 'ewes',
      feeds:
        Array.isArray(d.feeds) && d.feeds.length > 0
          ? d.feeds.map((f) => ({feedId: f.feed_input_id || '', qty: f.qty != null ? String(f.qty) : ''}))
          : [{feedId: '', qty: ''}],
      minerals:
        Array.isArray(d.minerals) && d.minerals.length > 0
          ? d.minerals.map((m) => ({feedId: m.feed_input_id || '', lbs: m.lbs != null ? String(m.lbs) : ''}))
          : [{feedId: '', lbs: ''}],
      fenceVoltageKv: d.fence_voltage_kv != null ? String(d.fence_voltage_kv) : '',
      waterersWorking: d.waterers_working == null ? true : !!d.waterers_working,
      mortalityCount: d.mortality_count != null ? String(d.mortality_count) : '',
      comments: d.comments || '',
      photos: Array.isArray(d.photos) ? d.photos : [],
    });
    setEditId(d.id);
    setEditSource(d.source || null);
    setShowForm(true);
  }

  async function saveEdit() {
    if (!form.date || !form.teamMember || !form.flock) {
      alert('Date, team member, and flock are required.');
      return;
    }
    const feedsJ = (form.feeds || [])
      .filter((r) => r.feedId && r.qty !== '' && r.qty != null)
      .map((r) => {
        const fi = feedInputs.find((x) => x.id === r.feedId);
        if (!fi) return null;
        const qty = parseFloat(r.qty) || 0;
        const unitWt = parseFloat(fi.unit_weight_lbs) || 1;
        return {
          feed_input_id: fi.id,
          feed_name: fi.name,
          category: fi.category,
          qty,
          unit: fi.unit,
          lbs_as_fed: Math.round(qty * unitWt * 100) / 100,
          is_creep: false,
        };
      })
      .filter(Boolean);
    const mineralsJ = (form.minerals || [])
      .filter((m) => m.feedId && m.lbs !== '' && m.lbs != null)
      .map((m) => {
        const fi = feedInputs.find((x) => x.id === m.feedId);
        if (!fi) return null;
        return {
          feed_input_id: fi.id,
          name: fi.name,
          lbs: parseFloat(m.lbs),
        };
      })
      .filter(Boolean);
    const rec = {
      date: form.date,
      team_member: form.teamMember,
      flock: form.flock,
      feeds: feedsJ,
      minerals: mineralsJ,
      fence_voltage_kv: form.fenceVoltageKv !== '' ? parseFloat(form.fenceVoltageKv) : null,
      waterers_working: !!form.waterersWorking,
      mortality_count: form.mortalityCount !== '' ? parseInt(form.mortalityCount) : 0,
      comments: form.comments || null,
    };
    const {error} = await sb.from('sheep_dailys').update(rec).eq('id', editId);
    if (error) {
      alert('Save failed: ' + error.message);
      return;
    }
    setRecords((p) => p.map((r) => (r.id === editId ? {...r, ...rec} : r)));
    refreshDailys && refreshDailys('sheep');
    setShowForm(false);
    setEditId(null);
    setForm(null);
  }

  function del(id) {
    if (!window._wcfConfirmDelete) return;
    window._wcfConfirmDelete('Delete this daily report? This cannot be undone.', async () => {
      await sb.from('sheep_dailys').delete().eq('id', id);
      setRecords((p) => p.filter((r) => r.id !== id));
      refreshDailys && refreshDailys('sheep');
      setShowForm(false);
      setEditId(null);
      setForm(null);
    });
  }

  const filtered = records.filter(
    (r) =>
      (!fFlock || r.flock === fFlock) &&
      (!fTeam || r.team_member === fTeam) &&
      (!fFrom || r.date >= fFrom) &&
      (!fTo || r.date <= fTo) &&
      (srcFilter === 'all' ||
        (srcFilter === 'daily' && r.source !== 'add_feed_webform') ||
        (srcFilter === 'addfeed' && r.source === 'add_feed_webform')),
  );
  const teamOpts = [...new Set(records.map((r) => r.team_member).filter(Boolean))].sort();
  const fi = {
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    fontSize: 12,
    fontFamily: 'inherit',
    background: 'white',
    width: 'auto',
  };

  // Summary metrics derived from feeds jsonb (hay bales + alfalfa lbs)
  const totalMort = filtered.reduce((s, r) => s + (parseInt(r.mortality_count) || 0), 0);
  const totalBales = filtered.reduce(
    (s, r) =>
      s +
      (Array.isArray(r.feeds)
        ? r.feeds.reduce((ss, f) => ss + (f.category === 'hay' && f.unit === 'bale' ? parseFloat(f.qty) || 0 : 0), 0)
        : 0),
    0,
  );
  // Alfalfa pellets only — exclude alfalfa hay so historical hay bales
  // (remapped to the ALFALFA cattle hay entry by migration 013) don't
  // get double-counted in the alfalfa-lb total.
  const totalAlfalfa = filtered.reduce(
    (s, r) =>
      s +
      (Array.isArray(r.feeds)
        ? r.feeds.reduce((ss, f) => {
            const nm = String(f.feed_name || '').toLowerCase();
            return ss + (f.category === 'pellet' && nm.includes('alfalfa') ? parseFloat(f.lbs_as_fed) || 0 : 0);
          }, 0)
        : 0),
    0,
  );

  return (
    <div style={{minHeight: '100vh', background: '#f1f3f2'}}>
      <Header />
      <div style={{padding: '1rem', maxWidth: 1200, margin: '0 auto'}}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <div>
            <div style={{fontSize: 15, fontWeight: 700, color: '#111827'}}>Daily Reports</div>
            <div style={{fontSize: 12, color: '#6b7280', marginTop: 2}}>{records.length.toLocaleString()} total</div>
          </div>
          <div style={{display: 'flex', gap: 8}}>
            <button
              onClick={() => setShowAddModal(true)}
              style={{
                padding: '8px 16px',
                borderRadius: 8,
                border: 'none',
                background: '#0f766e',
                color: 'white',
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              + Add Report
            </button>
          </div>
        </div>
        {showAddModal && (
          <AdminAddReportModal
            sb={sb}
            formType="sheep"
            onClose={() => setShowAddModal(false)}
            onSaved={(recs) => {
              setRecords((p) => [...(Array.isArray(recs) ? recs : [recs]), ...p]);
              refreshDailys && refreshDailys('sheep');
            }}
          />
        )}

        <div style={{display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center'}}>
          <input type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} style={{...fi, width: 130}} />
          <span style={{fontSize: 12, color: '#6b7280'}}>to</span>
          <input type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} style={{...fi, width: 130}} />
          <select value={fFlock} onChange={(e) => setFFlock(e.target.value)} style={fi}>
            <option value="">All flocks</option>
            {FLOCKS.map((f) => (
              <option key={f} value={f}>
                {FLOCK_LABELS[f]}
              </option>
            ))}
          </select>
          <select value={fTeam} onChange={(e) => setFTeam(e.target.value)} style={fi}>
            <option value="">All team</option>
            {teamOpts.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {(fFlock || fTeam || fFrom || fTo || srcFilter !== 'all') && (
            <button
              onClick={() => {
                setFFlock('');
                setFTeam('');
                setFFrom('');
                setFTo('');
                setSrcFilter('all');
              }}
              style={{...fi, color: '#6b7280', cursor: 'pointer'}}
            >
              Clear
            </button>
          )}
          <div
            style={{
              display: 'flex',
              borderRadius: 6,
              overflow: 'hidden',
              border: '1px solid #d1d5db',
              marginLeft: 'auto',
            }}
          >
            {[
              {k: 'all', l: 'All'},
              {k: 'daily', l: 'Daily Reports'},
              {k: 'addfeed', l: '🌾 Add Feed'},
            ].map((o, oi) => (
              <button
                key={o.k}
                onClick={() => setSrcFilter(o.k)}
                style={{
                  padding: '5px 10px',
                  border: 'none',
                  borderRight: oi < 2 ? '1px solid #d1d5db' : 'none',
                  fontFamily: 'inherit',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: srcFilter === o.k ? '#0f766e' : 'white',
                  color: srcFilter === o.k ? 'white' : '#6b7280',
                }}
              >
                {o.l}
              </button>
            ))}
          </div>
        </div>

        {loading && <div style={{textAlign: 'center', padding: '3rem', color: '#9ca3af'}}>Loading{'…'}</div>}
        {!loading && filtered.length === 0 && (
          <div style={{textAlign: 'center', padding: '3rem', color: '#9ca3af', fontSize: 13}}>No records found</div>
        )}
        {!loading && filtered.length > 0 && (
          <div style={{display: 'flex', flexDirection: 'column', gap: 4}}>
            {(() => {
              const dates = [...new Set(filtered.map((r) => r.date))];
              return filtered.map((d, i) => {
                const hasMort = parseInt(d.mortality_count) > 0;
                const comments = isSentinelComment(d.comments) ? '' : String(d.comments).trim();
                const notable = hasMort || comments;
                const prevDate = i > 0 ? filtered[i - 1].date : null;
                const showDivider = prevDate && prevDate !== d.date;
                const dateIdx = dates.indexOf(d.date);
                const shadeBg = dateIdx % 2 === 0 ? 'white' : '#f8fafc';
                const fc = FLOCK_COLORS[d.flock] || FLOCK_COLORS.ewes;
                const feedSummary =
                  Array.isArray(d.feeds) && d.feeds.length > 0
                    ? d.feeds
                        .map((f) => (f.feed_name || '?') + (f.qty != null ? ' ' + f.qty + ' ' + (f.unit || '') : ''))
                        .join(', ')
                    : '';
                const mineralSummary =
                  Array.isArray(d.minerals) && d.minerals.length > 0
                    ? d.minerals
                        .map((m) => {
                          const parts = [m.name || '?'];
                          if (m.lbs != null) parts.push(m.lbs + ' lb');
                          return parts.join(' ');
                        })
                        .join(', ')
                    : '';
                return (
                  <React.Fragment key={d.id}>
                    {showDivider && (
                      <div style={{height: 2, background: '#9ca3af', margin: '6px 0', borderRadius: 1}} />
                    )}
                    <div
                      onClick={() => openEdit(d)}
                      style={{
                        background: d.source === 'add_feed_webform' ? '#fffbeb' : shadeBg,
                        borderRadius: 8,
                        cursor: 'pointer',
                        border: notable
                          ? '1.5px solid #fca5a5'
                          : d.source === 'add_feed_webform'
                            ? '1px solid #fde68a'
                            : '1px solid #e5e7eb',
                        padding: '8px 14px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                      }}
                      className="hoverable-tile"
                    >
                      <div
                        data-mobile-1col="1"
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '90px 120px 90px 90px 1fr',
                          alignItems: 'center',
                          gap: 12,
                        }}
                      >
                        <span style={{fontSize: 12, color: '#6b7280'}}>{fmt(d.date)}</span>
                        <span style={{display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden'}}>
                          <span
                            style={{
                              padding: '2px 8px',
                              borderRadius: 4,
                              fontSize: 11,
                              fontWeight: 700,
                              background: fc.bg,
                              color: fc.tx,
                              border: '1px solid ' + fc.bd,
                              textAlign: 'center',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {FLOCK_LABELS[d.flock] || d.flock}
                          </span>
                          {d.source === 'add_feed_webform' && (
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                padding: '1px 6px',
                                borderRadius: 6,
                                background: '#fef3c7',
                                color: '#92400e',
                                border: '1px solid #fde68a',
                                flexShrink: 0,
                              }}
                            >
                              {'🌾'}
                            </span>
                          )}
                          <DailyPhotoChip photos={d.photos} />
                        </span>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            padding: '2px 8px',
                            borderRadius: 4,
                            background: '#f1f5f9',
                            color: '#475569',
                            border: '1px solid #e2e8f0',
                            textAlign: 'center',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {d.team_member || '—'}
                        </span>
                        <span
                          style={{
                            fontSize: 11,
                            color:
                              d.fence_voltage_kv != null
                                ? parseFloat(d.fence_voltage_kv) < 3
                                  ? '#b91c1c'
                                  : parseFloat(d.fence_voltage_kv) < 5
                                    ? '#92400e'
                                    : '#065f46'
                                : '#9ca3af',
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {d.fence_voltage_kv != null ? '⚡ ' + d.fence_voltage_kv + ' kV' : 'no voltage'}
                        </span>
                        <span style={{display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center'}}>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              padding: '2px 7px',
                              borderRadius: 4,
                              background: d.waterers_working === false ? '#fef2f2' : '#f0fdf4',
                              color: d.waterers_working === false ? '#b91c1c' : '#065f46',
                              border: d.waterers_working === false ? '1px solid #fecaca' : '1px solid #bbf7d0',
                            }}
                          >
                            {'Water: ' + (d.waterers_working === false ? 'No' : 'Yes')}
                          </span>
                        </span>
                      </div>
                      {feedSummary && <div style={{fontSize: 11, color: '#92400e'}}>{'🌾 ' + feedSummary}</div>}
                      {mineralSummary && <div style={{fontSize: 11, color: '#6b21a8'}}>{'🧂 ' + mineralSummary}</div>}
                      {(hasMort || comments) && (
                        <div style={{display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 2}}>
                          {hasMort && (
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                padding: '3px 8px',
                                borderRadius: 6,
                                background: '#fef2f2',
                                color: '#b91c1c',
                                border: '1px solid #fecaca',
                              }}
                            >
                              {'💀 ' + d.mortality_count + ' mort.'}
                            </span>
                          )}
                          {comments && (
                            <span
                              style={{
                                fontSize: 11,
                                color: '#92400e',
                                padding: '3px 10px',
                                background: '#fffbeb',
                                border: '1px solid #fde68a',
                                borderRadius: 6,
                                fontStyle: 'italic',
                              }}
                            >
                              {'💬 ' + comments}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </React.Fragment>
                );
              });
            })()}
          </div>
        )}
        {hasMore && (
          <div style={{textAlign: 'center', padding: '0.5rem', fontSize: 11, color: '#9ca3af'}}>
            Loading more records{'…'}
          </div>
        )}
      </div>

      {showForm && form && (
        <div
          onClick={() => {
            setShowForm(false);
            setEditId(null);
            setForm(null);
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
            alignItems: 'flex-start',
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
              maxWidth: 520,
              boxShadow: '0 8px 32px rgba(0,0,0,.2)',
              marginTop: 40,
            }}
          >
            <div
              style={{
                padding: '14px 20px',
                borderBottom: '1px solid #e5e7eb',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div style={{fontSize: 15, fontWeight: 600, color: '#0f766e'}}>
                {editSource === 'add_feed_webform' ? 'Edit Sheep Add Feed Report' : 'Edit Sheep Daily Report'}
              </div>
              <button
                onClick={() => {
                  setShowForm(false);
                  setEditId(null);
                  setForm(null);
                }}
                style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
              >
                {'×'}
              </button>
            </div>
            <div
              data-mobile-1col="1"
              style={{
                padding: '16px 20px',
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 10,
                maxHeight: '70vh',
                overflowY: 'auto',
              }}
            >
              <div style={{gridColumn: '1/-1'}}>
                <label style={S.label}>Date *</label>
                <input type="date" value={form.date} onChange={(e) => setForm({...form, date: e.target.value})} />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={S.label}>Team Member *</label>
                <select value={form.teamMember} onChange={(e) => setForm({...form, teamMember: e.target.value})}>
                  <option value="">Select...</option>
                  {teamMembers.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={S.label}>Flock *</label>
                <select value={form.flock} onChange={(e) => setForm({...form, flock: e.target.value})}>
                  <option value="">Select flock...</option>
                  {FLOCKS.map((f) => (
                    <option key={f} value={f}>
                      {FLOCK_LABELS[f]}
                    </option>
                  ))}
                </select>
              </div>

              {/* Feeds — multi-row picker, mirrors CattleDailysView */}
              <div style={{gridColumn: '1/-1', borderTop: '1px solid #e5e7eb', paddingTop: 10}}>
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6}}>
                  <span style={{fontSize: 11, fontWeight: 700, color: '#4b5563', letterSpacing: 0.5}}>FEEDS</span>
                  <button
                    type="button"
                    onClick={() => setForm({...form, feeds: [...(form.feeds || []), {feedId: '', qty: ''}]})}
                    style={{
                      fontSize: 11,
                      color: '#0f766e',
                      background: 'none',
                      border: '1px solid #5eead4',
                      borderRadius: 5,
                      padding: '3px 8px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    + Add
                  </button>
                </div>
                {form.feeds.map((r, ri) => {
                  const feedsForFlock = feedInputs.filter(
                    (f) => f.category !== 'mineral' && (!form.flock || (f.herd_scope || []).includes(form.flock)),
                  );
                  const fiRow = feedInputs.find((x) => x.id === r.feedId);
                  return (
                    <div
                      key={ri}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '2fr 1fr auto',
                        gap: 6,
                        marginBottom: 6,
                        alignItems: 'center',
                      }}
                    >
                      <select
                        value={r.feedId}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            feeds: form.feeds.map((x, i) => (i === ri ? {...x, feedId: e.target.value} : x)),
                          })
                        }
                      >
                        <option value="">Select feed...</option>
                        {feedsForFlock.map((ff) => (
                          <option key={ff.id} value={ff.id}>
                            {ff.name}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={r.qty}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            feeds: form.feeds.map((x, i) => (i === ri ? {...x, qty: e.target.value} : x)),
                          })
                        }
                        placeholder={fiRow ? fiRow.unit : 'qty'}
                      />
                      <button
                        type="button"
                        onClick={() => setForm({...form, feeds: form.feeds.filter((_, i) => i !== ri)})}
                        style={{
                          padding: '4px 8px',
                          border: '1px solid #d1d5db',
                          borderRadius: 5,
                          background: 'white',
                          color: '#9ca3af',
                          cursor: 'pointer',
                        }}
                      >
                        {'×'}
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Minerals — dropdown + lbs + optional pct_eaten per entry */}
              <div style={{gridColumn: '1/-1', borderTop: '1px solid #e5e7eb', paddingTop: 10}}>
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6}}>
                  <span style={{fontSize: 11, fontWeight: 700, color: '#4b5563', letterSpacing: 0.5}}>MINERALS</span>
                  <button
                    type="button"
                    onClick={() => setForm({...form, minerals: [...(form.minerals || []), {feedId: '', lbs: ''}]})}
                    style={{
                      fontSize: 11,
                      color: '#6b21a8',
                      background: 'none',
                      border: '1px solid #d8b4fe',
                      borderRadius: 5,
                      padding: '3px 8px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    + Add
                  </button>
                </div>
                {form.minerals.map((r, ri) => {
                  const minerals = feedInputs.filter((f) => f.category === 'mineral');
                  return (
                    <div
                      key={ri}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '2fr 1fr auto',
                        gap: 6,
                        marginBottom: 6,
                        alignItems: 'center',
                      }}
                    >
                      <select
                        value={r.feedId}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            minerals: form.minerals.map((x, i) => (i === ri ? {...x, feedId: e.target.value} : x)),
                          })
                        }
                      >
                        <option value="">Select mineral...</option>
                        {minerals.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={r.lbs}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            minerals: form.minerals.map((x, i) => (i === ri ? {...x, lbs: e.target.value} : x)),
                          })
                        }
                        placeholder="lbs"
                      />
                      <button
                        type="button"
                        onClick={() => setForm({...form, minerals: form.minerals.filter((_, i) => i !== ri)})}
                        style={{
                          padding: '4px 8px',
                          border: '1px solid #d1d5db',
                          borderRadius: 5,
                          background: 'white',
                          color: '#9ca3af',
                          cursor: 'pointer',
                        }}
                      >
                        {'×'}
                      </button>
                    </div>
                  );
                })}
              </div>

              {editSource !== 'add_feed_webform' && (
                <React.Fragment>
                  <div>
                    <label style={S.label}>Fence Voltage (kV)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={form.fenceVoltageKv}
                      onChange={(e) => setForm({...form, fenceVoltageKv: e.target.value})}
                      placeholder="0.0"
                    />
                  </div>
                  <div>
                    <label style={S.label}>Waterers working?</label>
                    <div style={{display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #d1d5db'}}>
                      {[
                        {v: true, l: 'Yes'},
                        {v: false, l: 'No'},
                      ].map(({v, l}) => (
                        <button
                          key={l}
                          type="button"
                          onClick={() => setForm({...form, waterersWorking: v})}
                          style={{
                            flex: 1,
                            padding: '7px 0',
                            border: 'none',
                            fontFamily: 'inherit',
                            fontSize: 12,
                            cursor: 'pointer',
                            background: form.waterersWorking === v ? (v ? '#0f766e' : '#374151') : '#f9fafb',
                            color: form.waterersWorking === v ? 'white' : '#6b7280',
                          }}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label style={S.label}>Mortality count</label>
                    <input
                      type="number"
                      min="0"
                      value={form.mortalityCount}
                      onChange={(e) => setForm({...form, mortalityCount: e.target.value})}
                      placeholder="0"
                    />
                  </div>
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={S.label}>Issues / Comments</label>
                    <textarea
                      value={form.comments}
                      onChange={(e) => setForm({...form, comments: e.target.value})}
                      rows={3}
                      placeholder="Type 0 if nothing to report"
                      style={{resize: 'vertical'}}
                    />
                  </div>
                </React.Fragment>
              )}
              <DailyPhotoThumbnails photos={form?.photos} />
            </div>
            <div style={{padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8}}>
              <button onClick={saveEdit} style={{...S.btnPrimary, width: 'auto', padding: '8px 20px'}}>
                Save
              </button>
              {editId && (
                <button onClick={() => del(editId)} style={S.btnDanger}>
                  Delete
                </button>
              )}
              <button
                onClick={() => {
                  setShowForm(false);
                  setEditId(null);
                  setForm(null);
                }}
                style={S.btnGhost}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SheepDailysView;
