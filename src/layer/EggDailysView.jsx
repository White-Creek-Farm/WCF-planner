// Auto-extracted by Phase 2 Round 2 (verbatim). See MIGRATION_PLAN §6.
import React from 'react';
import {S} from '../lib/styles.js';
import {loadRoster, activeNames} from '../lib/teamMembers.js';
import {checkDailyDuplicate, formatDuplicateError} from '../lib/dailyDuplicateCheck.js';
import AdminAddReportModal from '../shared/AdminAddReportModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
const EggDailysView = ({sb, fmt, Header, authState, layerGroups, pendingEdit, setPendingEdit, refreshDailys}) => {
  const {useState, useEffect} = React;
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const activeGroups = (layerGroups || []).filter((g) => g.status === 'active');
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [teamMembers, setTeamMembers] = useState([]);
  const [fTeam, setFTeam] = useState('');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const EMPTY = {
    date: todayStr(),
    teamMember: '',
    group1Name: activeGroups[0]?.name || '',
    group1Count: '',
    group2Name: activeGroups[1]?.name || '',
    group2Count: '',
    group3Name: activeGroups[2]?.name || '',
    group3Count: '',
    group4Name: activeGroups[3]?.name || '',
    group4Count: '',
    dozensOnHand: '',
    comments: '',
  };
  const [form, setForm] = useState(EMPTY);
  const [notice, setNotice] = useState(null);

  const PAGE = 1000;
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    sb.from('egg_dailys')
      .select('*')
      .order('date', {ascending: false})
      .range(0, PAGE - 1)
      .then(({data}) => {
        if (data) {
          setRecords(data);
          setHasMore(data.length === PAGE);
          if (pendingEdit?.viewName === 'eggdailys' && pendingEdit?.id) {
            const rec = data.find((r) => r.id === pendingEdit.id);
            if (rec) {
              openEdit(rec);
              setPendingEdit(null);
            }
          }
        }
        setLoading(false);
      });
    loadRoster(sb).then((roster) => setTeamMembers(activeNames(roster)));
  }, []);

  // Auto-load all pages on mount (guarded to prevent duplicate fetches on re-render)
  const pgLoading = React.useRef(false);
  React.useEffect(() => {
    if (hasMore && !pgLoading.current) {
      pgLoading.current = true;
      const next = page + 1;
      sb.from('egg_dailys')
        .select('*')
        .order('date', {ascending: false})
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
    setNotice(null);
    setForm({
      date: d.date || todayStr(),
      teamMember: d.team_member || '',
      group1Name: d.group1_name || '',
      group1Count: d.group1_count != null ? d.group1_count : '',
      group2Name: d.group2_name || '',
      group2Count: d.group2_count != null ? d.group2_count : '',
      group3Name: d.group3_name || '',
      group3Count: d.group3_count != null ? d.group3_count : '',
      group4Name: d.group4_name || '',
      group4Count: d.group4_count != null ? d.group4_count : '',
      dozensOnHand: d.dozens_on_hand != null ? d.dozens_on_hand : '',
      comments: d.comments || '',
    });
    setEditId(d.id);
    setShowForm(true);
  }
  const [showAddModal, setShowAddModal] = useState(false);
  async function save() {
    setNotice(null);
    const g1 = form.group1Count !== '' ? parseInt(form.group1Count) : 0;
    const g2 = form.group2Count !== '' ? parseInt(form.group2Count) : 0;
    const g3 = form.group3Count !== '' ? parseInt(form.group3Count) : 0;
    const g4 = form.group4Count !== '' ? parseInt(form.group4Count) : 0;
    const totalEggs = (g1 || 0) + (g2 || 0) + (g3 || 0) + (g4 || 0);
    const rec = {
      date: form.date,
      team_member: form.teamMember,
      group1_name: form.group1Name || null,
      group1_count: form.group1Count !== '' ? g1 : null,
      group2_name: form.group2Name || null,
      group2_count: form.group2Count !== '' ? g2 : null,
      group3_name: form.group3Name || null,
      group3_count: form.group3Count !== '' ? g3 : null,
      group4_name: form.group4Name || null,
      group4_count: form.group4Count !== '' ? g4 : null,
      daily_dozen_count: Math.floor(totalEggs / 12),
      dozens_on_hand: form.dozensOnHand !== '' ? parseFloat(form.dozensOnHand) : null,
      comments: form.comments || null,
    };
    if (editId) {
      sb.from('egg_dailys')
        .update(rec)
        .eq('id', editId)
        .then(({error}) => {
          if (error) {
            setNotice({kind: 'error', message: 'Save failed: ' + error.message});
            return;
          }
          refreshDailys && refreshDailys('egg');
        });
      setRecords((p) => p.map((r) => (r.id === editId ? {...r, ...rec} : r)));
      setShowForm(false);
      setEditId(null);
    } else {
      try {
        const dupe = await checkDailyDuplicate(sb, 'egg_dailys', rec);
        if (dupe) {
          setNotice({kind: 'error', message: formatDuplicateError('egg_dailys', rec)});
          return;
        }
      } catch (e) {
        setNotice({kind: 'error', message: e.message || 'Could not verify duplicate report.'});
        return;
      }
      const {data, error} = await sb
        .from('egg_dailys')
        .insert({...rec, submitted_at: new Date().toISOString()})
        .select()
        .single();
      if (error) {
        setNotice({kind: 'error', message: 'Save failed: ' + error.message});
      } else if (data) {
        setRecords((p) => [data, ...p]);
        refreshDailys && refreshDailys('egg');
      }
      setShowForm(false);
      setEditId(null);
    }
  }
  function del(id) {
    window._wcfConfirmDelete?.('Delete this egg daily report? This cannot be undone.', () => {
      sb.from('egg_dailys')
        .delete()
        .eq('id', id)
        .then(() => {
          refreshDailys && refreshDailys('egg');
        });
      setRecords((p) => p.filter((r) => r.id !== id));
      setShowForm(false);
      setEditId(null);
    });
  }

  const teamOpts = [...new Set(records.map((r) => r.team_member).filter(Boolean))].sort();
  const filtered = records.filter(
    (r) => (!fTeam || r.team_member === fTeam) && (!fFrom || r.date >= fFrom) && (!fTo || r.date <= fTo),
  );
  const totalEggs = filtered.reduce(
    (s, r) =>
      s +
      (parseInt(r.group1_count) || 0) +
      (parseInt(r.group2_count) || 0) +
      (parseInt(r.group3_count) || 0) +
      (parseInt(r.group4_count) || 0),
    0,
  );
  const fi = {
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    fontSize: 12,
    fontFamily: 'inherit',
    background: 'white',
    width: 'auto',
  };

  return (
    <div style={{minHeight: '100vh', background: '#f1f3f2'}}>
      <Header />
      <div style={{padding: '1rem', maxWidth: 1100, margin: '0 auto'}}>
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
              onClick={() => {
                setNotice(null);
                setShowAddModal(true);
              }}
              style={{
                padding: '8px 16px',
                borderRadius: 8,
                border: 'none',
                background: '#085041',
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
            formType="egg"
            onClose={() => setShowAddModal(false)}
            onSaved={(recs) => {
              setRecords((p) => [...recs, ...p]);
              refreshDailys && refreshDailys('egg');
            }}
          />
        )}
        <div style={{display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center'}}>
          <input type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} style={{...fi, width: 130}} />
          <span style={{fontSize: 12, color: '#6b7280'}}>to</span>
          <input type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} style={{...fi, width: 130}} />
          {(fFrom || fTo) && (
            <button
              onClick={() => {
                setFFrom('');
                setFTo('');
              }}
              style={{...fi, color: '#6b7280', cursor: 'pointer'}}
            >
              Clear
            </button>
          )}
        </div>
        <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
        {loading && <div style={{textAlign: 'center', padding: '3rem', color: '#9ca3af'}}>Loading...</div>}
        {!loading && filtered.length === 0 && (
          <div style={{textAlign: 'center', padding: '3rem', color: '#9ca3af', fontSize: 13}}>No records found</div>
        )}
        {!loading && filtered.length > 0 && (
          <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
            {filtered.map((d, i) => {
              const total =
                (parseInt(d.group1_count) || 0) +
                (parseInt(d.group2_count) || 0) +
                (parseInt(d.group3_count) || 0) +
                (parseInt(d.group4_count) || 0);
              const groups = [
                [d.group1_name, d.group1_count],
                [d.group2_name, d.group2_count],
                [d.group3_name, d.group3_count],
                [d.group4_name, d.group4_count],
              ].filter(([n, c]) => n && parseInt(c) > 0);
              const comment = d.comments && String(d.comments).trim().length > 2 ? String(d.comments).trim() : '';
              const notable = comment;
              return (
                <div
                  key={d.id}
                  onClick={() => openEdit(d)}
                  style={{
                    background: 'white',
                    borderRadius: 8,
                    cursor: 'pointer',
                    border: notable ? '1.5px solid #fca5a5' : '1px solid #e5e7eb',
                    padding: '8px 14px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                  className="hoverable-tile"
                >
                  <div
                    data-mobile-1col="1"
                    style={{display: 'grid', gridTemplateColumns: '90px 100px 90px 1fr', alignItems: 'center', gap: 12}}
                  >
                    <span style={{fontSize: 12, color: '#6b7280'}}>{fmt(d.date)}</span>
                    <span style={{fontWeight: 700, color: '#78350f', fontSize: 13, whiteSpace: 'nowrap'}}>
                      {'\ud83e\udd5a ' + total + ' eggs'}
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
                      {d.team_member || '\u2014'}
                    </span>
                    <span style={{display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center'}}>
                      {groups.map(([n, c]) => (
                        <span key={n} style={{color: '#374151', fontSize: 12, whiteSpace: 'nowrap'}}>
                          {n}: <strong>{c}</strong>
                        </span>
                      ))}
                      {parseFloat(d.dozens_on_hand) > 0 && (
                        <span style={{color: '#065f46', fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap'}}>
                          {'\ud83d\udce6 ' + d.dozens_on_hand + ' doz on hand'}
                        </span>
                      )}
                    </span>
                  </div>
                  {comment && (
                    <div
                      style={{
                        fontSize: 11,
                        color: '#92400e',
                        marginTop: 2,
                        padding: '4px 10px',
                        background: '#fffbeb',
                        border: '1px solid #fde68a',
                        borderRadius: 6,
                        fontStyle: 'italic',
                      }}
                    >
                      {'\ud83d\udcac ' + comment}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {hasMore && (
          <div style={{textAlign: 'center', padding: '0.5rem', fontSize: 11, color: '#9ca3af'}}>
            Loading more records...
          </div>
        )}
      </div>
      {showForm && (
        <div
          onClick={() => {
            setNotice(null);
            setShowForm(false);
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
              maxWidth: 480,
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
                position: 'sticky',
                top: 0,
                background: 'white',
              }}
            >
              <div style={{fontSize: 15, fontWeight: 600, color: '#78350f'}}>{editId ? 'Edit' : 'Add'} Egg Report</div>
              <button
                onClick={() => {
                  setNotice(null);
                  setShowForm(false);
                }}
                style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
              >
                ×
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
                <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={S.label}>Date *</label>
                <input type="date" value={form.date} onChange={(e) => setForm((f) => ({...f, date: e.target.value}))} />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={S.label}>Team Member</label>
                <select value={form.teamMember} onChange={(e) => setForm((f) => ({...f, teamMember: e.target.value}))}>
                  <option value="">Select...</option>
                  {teamMembers.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              {[1, 2, 3, 4].map((n) => (
                <React.Fragment key={n}>
                  <div>
                    <label style={S.label}>Group {n}</label>
                    <select
                      value={form[`group${n}Name`]}
                      onChange={(e) => setForm((f) => ({...f, [`group${n}Name`]: e.target.value}))}
                    >
                      <option value="">—</option>
                      {activeGroups.map((g) => (
                        <option key={g.name} value={g.name}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={S.label}>Eggs</label>
                    <input
                      type="number"
                      min="0"
                      value={form[`group${n}Count`]}
                      onChange={(e) => setForm((f) => ({...f, [`group${n}Count`]: e.target.value}))}
                      placeholder="0"
                    />
                  </div>
                </React.Fragment>
              ))}
              <div style={{gridColumn: '1/-1'}}>
                <label style={S.label}>Dozens on Hand</label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={form.dozensOnHand || ''}
                  onChange={(e) => setForm((f) => ({...f, dozensOnHand: e.target.value}))}
                />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={S.label}>Collected Today (calculated)</label>
                <div
                  style={{
                    background: '#f9fafb',
                    border: '1px solid #e5e7eb',
                    borderRadius: 6,
                    padding: '8px 12px',
                    fontSize: 14,
                    fontWeight: 700,
                    color: '#78350f',
                  }}
                >
                  {(() => {
                    const g1 = form.group1Count !== '' ? parseInt(form.group1Count) || 0 : 0;
                    const g2 = form.group2Count !== '' ? parseInt(form.group2Count) || 0 : 0;
                    const g3 = form.group3Count !== '' ? parseInt(form.group3Count) || 0 : 0;
                    const g4 = form.group4Count !== '' ? parseInt(form.group4Count) || 0 : 0;
                    const total = g1 + g2 + g3 + g4;
                    return total + ' eggs \u00b7 ' + Math.floor(total / 12) + ' dozen';
                  })()}
                </div>
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={S.label}>Comments</label>
                <textarea
                  value={form.comments}
                  onChange={(e) => setForm((f) => ({...f, comments: e.target.value}))}
                  rows={2}
                  style={{resize: 'vertical'}}
                />
              </div>
            </div>
            <div style={{padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8}}>
              <button onClick={save} style={{...S.btnPrimary, width: 'auto', padding: '8px 20px'}}>
                Save
              </button>
              {editId && (
                <button onClick={() => del(editId)} style={S.btnDanger}>
                  Delete
                </button>
              )}
              <button
                onClick={() => {
                  setNotice(null);
                  setShowForm(false);
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

export default EggDailysView;
