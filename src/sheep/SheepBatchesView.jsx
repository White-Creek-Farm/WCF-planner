// SheepBatchesView — mirror of CattleBatchesView for sheep.
//
// Sheep enter a processing batch ONLY through the Send-to-Processor flag
// on a sheep weigh-in entry. Gate is intentionally looser than cattle's
// finishers-only — any draft session, any flock (rams / ewes / feeders /
// null-herd Podio imports) per §7. This view lets admin:
//   * Create empty batch shells (+ New Batch).
//   * Edit batch metadata (name, planned/actual dates, status, notes, cost).
//   * Edit per-sheep live/hanging weights inline.
//   * Detach a sheep from a batch via the per-row × button — reverts
//     sheep.flock to the prior flock (from weigh_ins.prior_herd_or_flock
//     or sheep_transfers audit row), removes the sheep_detail row, clears
//     send_to_processor on the matching weigh_in. Blocks with admin
//     warning when no prior flock can be sourced.
//   * Delete a batch — loops detach across every attached sheep and
//     reports which reverted vs which couldn't.
//
// No multi-select on + New, no manual "+ Add sheep from feeders" dropdown.
// Sheep partition is exclusively driven by the weigh-in flag.
import React from 'react';
import UsersModal from '../auth/UsersModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ActivityPanel from '../shared/ActivityPanel.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ActivityModal from '../shared/ActivityModal.jsx';
import {loadSheepWeighInsCached, invalidateSheepWeighInsCache} from '../lib/sheepCache.js';
import {detachSheepFromBatch} from '../lib/sheepProcessingBatch.js';

const SheepBatchesView = ({
  sb,
  fmt,
  Header,
  authState,
  setView,
  showUsers,
  setShowUsers,
  allUsers,
  setAllUsers,
  loadUsers,
}) => {
  const {useState, useEffect} = React;
  const [batches, setBatches] = useState([]);
  const [sheep, setSheep] = useState([]);
  const [weighIns, setWeighIns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(null);
  const [sheepDraft, setSheepDraft] = useState({});
  const [expandedBatchId, setExpandedBatchId] = useState(null);
  // Inline notice for batch save / detach failures + per-row warnings.
  // Cleared at the start of each action handler + when opening the form.
  const [notice, setNotice] = useState(null);
  const [activityTarget, setActivityTarget] = useState(null);

  React.useEffect(() => {
    function onEntityDeepLink() {
      const dl = window._wcfEntityDeepLink;
      if (!dl || dl.entityType !== 'sheep.processing') return;
      const b = batches.find((x) => x.id === dl.entityId);
      if (b) {
        window._wcfEntityDeepLink = null;
        setActivityTarget({entityType: 'sheep.processing', entityId: b.id, entityLabel: b.name});
      }
    }
    onEntityDeepLink();
    window.addEventListener('wcf-entity-deep-link', onEntityDeepLink);
    return () => window.removeEventListener('wcf-entity-deep-link', onEntityDeepLink);
  }, [batches]);

  async function loadAll() {
    const [bR, sR, wAll] = await Promise.all([
      sb.from('sheep_processing_batches').select('*').order('planned_process_date', {ascending: false}),
      sb.from('sheep').select('*'),
      loadSheepWeighInsCached(sb),
    ]);
    if (bR.data) {
      const byDate = (x) => x.actual_process_date || x.planned_process_date || x.created_at || '';
      setBatches(bR.data.slice().sort((a, b) => byDate(b).localeCompare(byDate(a))));
    }
    if (sR.data) setSheep(sR.data);
    setWeighIns(wAll);
    setLoading(false);
  }
  useEffect(() => {
    loadAll();
  }, []);

  function sheepTagSet(s) {
    // Includes current WCF tag + prior WCF tags (source='weigh_in' retags).
    // Excludes purchase-farm tags (source='import') — same rule as cattle.
    const set = new Set();
    if (s && s.tag) set.add(s.tag);
    if (s && Array.isArray(s.old_tags)) {
      for (const ot of s.old_tags) {
        if (!ot || !ot.tag) continue;
        if (ot.source === 'import') continue;
        set.add(ot.tag);
      }
    }
    return set;
  }
  function lastWeight(s) {
    const tags = sheepTagSet(s);
    if (tags.size === 0) return null;
    const sorted = [...weighIns]
      .filter((w) => tags.has(w.tag))
      .sort((a, b) => (b.entered_at || '').localeCompare(a.entered_at || ''));
    return sorted[0] ? parseFloat(sorted[0].weight) : null;
  }

  function sheepDetailOf(batch) {
    return Array.isArray(batch.sheep_detail) ? batch.sheep_detail : [];
  }
  function recomputeTotals(rows) {
    const live = rows.reduce((s, r) => s + (parseFloat(r.live_weight) || 0), 0);
    const hang = rows.reduce((s, r) => s + (parseFloat(r.hanging_weight) || 0), 0);
    return {
      total_live_weight: live > 0 ? Math.round(live * 10) / 10 : null,
      total_hanging_weight: hang > 0 ? Math.round(hang * 10) / 10 : null,
    };
  }

  function openAdd() {
    setNotice(null);
    const yr = new Date().getFullYear().toString().slice(-2);
    const existing = batches
      .filter((b) => b.name && b.name.startsWith('S-' + yr + '-'))
      .map((b) => parseInt(b.name.slice(5)) || 0);
    const next = (Math.max(0, ...existing) + 1).toString().padStart(2, '0');
    setForm({
      name: 'S-' + yr + '-' + next,
      planned_process_date: '',
      actual_process_date: '',
      processing_cost: '',
      notes: '',
      status: 'planned',
    });
    setEditId(null);
    setShowForm(true);
  }
  function openEdit(b) {
    setNotice(null);
    setForm({
      name: b.name,
      planned_process_date: b.planned_process_date || '',
      actual_process_date: b.actual_process_date || '',
      processing_cost: b.processing_cost != null ? String(b.processing_cost) : '',
      notes: b.notes || '',
      status: b.status || 'planned',
    });
    setEditId(b.id);
    setShowForm(true);
  }
  // Save a batch shell. Sheep membership is driven entirely by the
  // Send-to-Processor flag on a sheep weigh-in entry (any flock per
  // §7) — no manual sheep attach in this view.
  async function saveBatch() {
    setNotice(null);
    if (!form.name.trim()) {
      setNotice({kind: 'error', message: 'Batch name required.'});
      return;
    }
    const rec = {
      name: form.name.trim(),
      planned_process_date: form.planned_process_date || null,
      actual_process_date: form.actual_process_date || null,
      processing_cost: form.processing_cost !== '' ? parseFloat(form.processing_cost) : null,
      notes: form.notes || null,
      status: form.status || 'planned',
    };
    if (editId) {
      await sb.from('sheep_processing_batches').update(rec).eq('id', editId);
    } else {
      const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
      await sb
        .from('sheep_processing_batches')
        .insert({id, ...rec, sheep_detail: [], total_live_weight: null, total_hanging_weight: null});
    }
    await loadAll();
    setShowForm(false);
    setEditId(null);
    setForm(null);
  }
  // Delete + detach loop. Reports per-sheep result so admin sees which
  // sheep reverted vs which couldn't (no_prior_flock — manual move needed).
  async function deleteBatch(id) {
    if (!window._wcfConfirmDelete) return;
    window._wcfConfirmDelete(
      'Delete this processing batch? Linked sheep will be detached and reverted to their prior flocks where possible.',
      async () => {
        const batch = batches.find((b) => b.id === id);
        const sheepIds = (batch && Array.isArray(batch.sheep_detail) ? batch.sheep_detail : [])
          .map((r) => r.sheep_id)
          .filter(Boolean);
        const reverted = [];
        const blocked = [];
        for (const sid of sheepIds) {
          const r = await detachSheepFromBatch(sb, sid, id, {
            teamMember: authState && authState.name ? authState.name : null,
          });
          if (r.ok) reverted.push(r);
          else blocked.push(r);
        }
        // Defensive: clear any sheep still pointing at this batch (covers detach
        // failures + rows FK'd but absent from sheep_detail).
        await sb.from('sheep').update({processing_batch_id: null}).eq('processing_batch_id', id);
        await sb.from('sheep_processing_batches').delete().eq('id', id);
        invalidateSheepWeighInsCache();
        if (blocked.length > 0) {
          const lines = blocked.map((b) => '#' + (b.sheep?.tag || b.sheepId || '?') + ' (' + b.reason + ')').join('\n');
          setNotice({
            kind: 'warning',
            message:
              'Batch deleted. ' +
              reverted.length +
              ' sheep reverted. ' +
              blocked.length +
              ' could not be auto-reverted:\n\n' +
              lines +
              '\n\nManually move them via the Flocks tab if needed.',
          });
        }
        await loadAll();
        setShowForm(false);
        setEditId(null);
        setForm(null);
      },
    );
  }
  // Per-row × detach. Surfaces block reasons.
  async function detachSheepAndReport(batch, s) {
    if (!s || !s.id) return;
    setNotice(null);
    const r = await detachSheepFromBatch(sb, s.id, batch.id, {
      teamMember: authState && authState.name ? authState.name : null,
    });
    if (!r.ok) {
      const tag = s.tag || r.sheep?.tag || '?';
      if (r.reason === 'no_prior_flock') {
        setNotice({
          kind: 'warning',
          message:
            'Cannot auto-detach #' +
            tag +
            ': no prior flock recorded for this sheep + batch. Manually move via the Flocks tab.',
        });
      } else {
        setNotice({
          kind: 'error',
          message: 'Detach failed for #' + tag + ': ' + r.reason + (r.error ? ' — ' + r.error : ''),
        });
      }
    }
    invalidateSheepWeighInsCache();
    await loadAll();
  }
  async function saveSheepWeight(batch, sheepId, field, value) {
    const rows = sheepDetailOf(batch).map((r) =>
      r.sheep_id === sheepId ? {...r, [field]: value === '' || value == null ? null : parseFloat(value)} : r,
    );
    const tots = recomputeTotals(rows);
    await sb
      .from('sheep_processing_batches')
      .update({sheep_detail: rows, ...tots})
      .eq('id', batch.id);
    setBatches((prev) => prev.map((b) => (b.id === batch.id ? {...b, sheep_detail: rows, ...tots} : b)));
  }

  const inpS = {
    fontSize: 13,
    padding: '7px 10px',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  };
  const lbl = {fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3, fontWeight: 500};

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
      <div style={{padding: '1rem', maxWidth: 1100, margin: '0 auto'}}>
        {!showForm && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12}}>
          <div style={{fontSize: 16, fontWeight: 700, color: '#111827'}}>
            Processing Batches <span style={{fontSize: 13, fontWeight: 400, color: '#6b7280'}}>({batches.length})</span>
          </div>
          <button
            onClick={openAdd}
            style={{
              padding: '7px 16px',
              borderRadius: 7,
              border: 'none',
              background: '#0f766e',
              color: 'white',
              fontWeight: 600,
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            + New Batch
          </button>
        </div>

        {loading && <div style={{textAlign: 'center', padding: '2rem', color: '#9ca3af'}}>Loading{'…'}</div>}
        {!loading && batches.length === 0 && (
          <div
            style={{
              background: 'white',
              border: '1px solid #e5e7eb',
              borderRadius: 12,
              padding: '2rem',
              textAlign: 'center',
              color: '#6b7280',
              fontSize: 13,
            }}
          >
            No processing batches yet. Click <strong>+ New Batch</strong> to plan one. Sheep enter this batch only via
            the Send-to-Processor flag on a sheep weigh-in entry.
          </div>
        )}

        <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
          {batches.map((b) => {
            const rows = sheepDetailOf(b);
            const totalLive = rows.reduce((s, r) => s + (parseFloat(r.live_weight) || 0), 0);
            const totalHang = rows.reduce((s, r) => s + (parseFloat(r.hanging_weight) || 0), 0);
            const yieldPct = totalLive > 0 && totalHang > 0 ? Math.round((totalHang / totalLive) * 1000) / 10 : null;
            const draftKey = (sid, field) => `${b.id}|${sid}|${field}`;
            const draftVal = (sid, field, curr) => {
              const k = draftKey(sid, field);
              return sheepDraft[k] != null ? sheepDraft[k] : curr != null ? String(curr) : '';
            };
            const isExpanded = expandedBatchId === b.id;
            return (
              <div
                key={b.id}
                style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden'}}
              >
                <div
                  onClick={() => setExpandedBatchId(isExpanded ? null : b.id)}
                  style={{
                    padding: '12px 18px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                  className="hoverable-tile"
                >
                  <span style={{fontSize: 11, color: '#9ca3af'}}>{isExpanded ? '▼' : '▶'}</span>
                  <span style={{fontSize: 14, fontWeight: 700, color: '#111827'}}>{b.name}</span>
                  <span onClick={(e) => e.stopPropagation()} data-activity-surface="sheep.processing">
                    {React.createElement(ActivityPanel, {
                      sb,
                      authState,
                      entityType: 'sheep.processing',
                      entityId: b.id,
                      entityLabel: b.name,
                      mode: 'compact',
                      onCompactClick: setActivityTarget,
                    })}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 10,
                      background: b.status === 'complete' ? '#374151' : '#0f766e',
                      color: 'white',
                      textTransform: 'uppercase',
                    }}
                  >
                    {b.status}
                  </span>
                  <span style={{fontSize: 11, color: '#6b7280'}}>
                    {rows.length} {rows.length === 1 ? 'sheep' : 'sheep'}
                  </span>
                  {b.planned_process_date && (
                    <span style={{fontSize: 11, color: '#6b7280'}}>planned {fmt(b.planned_process_date)}</span>
                  )}
                  {b.actual_process_date && (
                    <span style={{fontSize: 11, color: '#065f46'}}>processed {fmt(b.actual_process_date)}</span>
                  )}
                  {yieldPct && (
                    <span style={{fontSize: 11, fontWeight: 600, color: '#065f46'}}>{yieldPct + '% yield'}</span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      openEdit(b);
                    }}
                    style={{
                      marginLeft: 'auto',
                      fontSize: 11,
                      color: '#0f766e',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Edit
                  </button>
                </div>
                {isExpanded && (
                  <div style={{borderTop: '1px solid #f3f4f6', padding: '14px 18px', background: '#fafafa'}}>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                        gap: 8,
                        fontSize: 11,
                        color: '#4b5563',
                        marginBottom: 10,
                      }}
                    >
                      <div>
                        <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase'}}>Live wt total</div>
                        <div style={{fontWeight: 600}}>
                          {totalLive > 0 ? Math.round(totalLive).toLocaleString() + ' lb' : '—'}
                        </div>
                      </div>
                      <div>
                        <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase'}}>Hanging wt</div>
                        <div style={{fontWeight: 600}}>
                          {totalHang > 0 ? Math.round(totalHang).toLocaleString() + ' lb' : '—'}
                        </div>
                      </div>
                      <div>
                        <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase'}}>Yield</div>
                        <div style={{fontWeight: 600, color: yieldPct ? '#065f46' : '#9ca3af'}}>
                          {yieldPct ? yieldPct + '%' : '—'}
                        </div>
                      </div>
                      <div>
                        <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase'}}>Cost</div>
                        <div style={{fontWeight: 600}}>
                          {b.processing_cost ? '$' + b.processing_cost.toLocaleString() : '—'}
                        </div>
                      </div>
                    </div>
                    {rows.length > 0 && (
                      <div style={{border: '1px solid #f3f4f6', borderRadius: 8, overflow: 'hidden', marginBottom: 8}}>
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '70px 90px 1fr 1fr 60px 28px',
                            gap: 6,
                            background: '#f9fafb',
                            padding: '6px 10px',
                            fontSize: 10,
                            fontWeight: 700,
                            color: '#6b7280',
                            textTransform: 'uppercase',
                            letterSpacing: 0.5,
                            alignItems: 'center',
                          }}
                        >
                          <div>Tag</div>
                          <div>Breed</div>
                          <div>Live wt (lb)</div>
                          <div>Hanging wt (lb)</div>
                          <div style={{textAlign: 'right'}}>Yield</div>
                          <div></div>
                        </div>
                        {rows.map((r) => {
                          const s = sheep.find((x) => x.id === r.sheep_id);
                          const lv = parseFloat(r.live_weight);
                          const hw = parseFloat(r.hanging_weight);
                          const y = lv > 0 && hw > 0 ? Math.round((hw / lv) * 1000) / 10 : null;
                          return (
                            <div
                              key={r.sheep_id}
                              style={{
                                display: 'grid',
                                gridTemplateColumns: '70px 90px 1fr 1fr 60px 28px',
                                gap: 6,
                                padding: '5px 10px',
                                fontSize: 12,
                                borderTop: '1px solid #f3f4f6',
                                alignItems: 'center',
                              }}
                            >
                              <div style={{fontWeight: 700, color: '#111827'}}>{'#' + (r.tag || s?.tag || '?')}</div>
                              <div style={{fontSize: 11, color: '#6b7280'}}>{s?.breed || '—'}</div>
                              <input
                                type="number"
                                min="0"
                                step="0.1"
                                placeholder={'—'}
                                value={draftVal(r.sheep_id, 'live', r.live_weight)}
                                onChange={(e) =>
                                  setSheepDraft((p) => ({...p, [draftKey(r.sheep_id, 'live')]: e.target.value}))
                                }
                                onBlur={(e) => {
                                  saveSheepWeight(b, r.sheep_id, 'live_weight', e.target.value);
                                  setSheepDraft((p) => {
                                    const x = {...p};
                                    delete x[draftKey(r.sheep_id, 'live')];
                                    return x;
                                  });
                                }}
                                style={{
                                  fontSize: 12,
                                  padding: '4px 8px',
                                  border: '1px solid #e5e7eb',
                                  borderRadius: 5,
                                  fontFamily: 'inherit',
                                  width: '100%',
                                  boxSizing: 'border-box',
                                }}
                              />
                              <input
                                type="number"
                                min="0"
                                step="0.1"
                                placeholder={'—'}
                                value={draftVal(r.sheep_id, 'hanging', r.hanging_weight)}
                                onChange={(e) =>
                                  setSheepDraft((p) => ({...p, [draftKey(r.sheep_id, 'hanging')]: e.target.value}))
                                }
                                onBlur={(e) => {
                                  saveSheepWeight(b, r.sheep_id, 'hanging_weight', e.target.value);
                                  setSheepDraft((p) => {
                                    const x = {...p};
                                    delete x[draftKey(r.sheep_id, 'hanging')];
                                    return x;
                                  });
                                }}
                                style={{
                                  fontSize: 12,
                                  padding: '4px 8px',
                                  border: '1px solid #e5e7eb',
                                  borderRadius: 5,
                                  fontFamily: 'inherit',
                                  width: '100%',
                                  boxSizing: 'border-box',
                                }}
                              />
                              <div
                                style={{
                                  textAlign: 'right',
                                  fontSize: 11,
                                  color: y ? '#065f46' : '#9ca3af',
                                  fontWeight: y ? 600 : 400,
                                }}
                              >
                                {y ? y + '%' : '—'}
                              </div>
                              <button
                                onClick={() => detachSheepAndReport(b, s || {id: r.sheep_id, tag: r.tag})}
                                title="Detach sheep from batch (reverts flock)"
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  color: '#b91c1c',
                                  cursor: 'pointer',
                                  fontSize: 14,
                                  lineHeight: 1,
                                  padding: '0 2px',
                                  fontFamily: 'inherit',
                                }}
                              >
                                {'×'}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {b.status !== 'complete' && (
                      <div style={{fontSize: 11, color: '#6b7280', fontStyle: 'italic'}}>
                        Sheep enter this batch only via the Send-to-Processor flag on a sheep weigh-in entry.
                      </div>
                    )}
                    {b.notes && (
                      <div style={{marginTop: 6, fontSize: 11, color: '#6b7280', fontStyle: 'italic'}}>{b.notes}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Batch form modal */}
      {showForm && form && (
        <div
          onClick={() => {
            setNotice(null);
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
              }}
            >
              <div style={{fontSize: 15, fontWeight: 600, color: '#0f766e'}}>
                {editId ? 'Edit Batch' : 'New Processing Batch'}
              </div>
              <button
                onClick={() => {
                  setNotice(null);
                  setShowForm(false);
                  setEditId(null);
                  setForm(null);
                }}
                style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
              >
                {'×'}
              </button>
            </div>
            <div style={{padding: '16px 20px'}}>
              <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
              <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                <div style={{gridColumn: '1/-1'}}>
                  <label style={lbl}>Name *</label>
                  <input value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} style={inpS} />
                </div>
                <div>
                  <label style={lbl}>Status</label>
                  <select value={form.status} onChange={(e) => setForm({...form, status: e.target.value})} style={inpS}>
                    <option value="planned">Planned</option>
                    <option value="complete">Complete</option>
                  </select>
                </div>
                <div>
                  <label style={lbl}>Processing Cost ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.processing_cost}
                    onChange={(e) => setForm({...form, processing_cost: e.target.value})}
                    style={inpS}
                  />
                </div>
                <div>
                  <label style={lbl}>Planned Process Date</label>
                  <input
                    type="date"
                    value={form.planned_process_date}
                    onChange={(e) => setForm({...form, planned_process_date: e.target.value})}
                    style={inpS}
                  />
                </div>
                <div>
                  <label style={lbl}>Actual Process Date</label>
                  <input
                    type="date"
                    value={form.actual_process_date}
                    onChange={(e) => setForm({...form, actual_process_date: e.target.value})}
                    style={inpS}
                  />
                </div>
                <div style={{gridColumn: '1/-1'}}>
                  <label style={lbl}>Notes</label>
                  <textarea
                    value={form.notes}
                    onChange={(e) => setForm({...form, notes: e.target.value})}
                    rows={2}
                    style={{...inpS, resize: 'vertical'}}
                  />
                </div>
              </div>
              {!editId && (
                <div
                  style={{
                    marginTop: 12,
                    padding: '10px 12px',
                    background: '#f9fafb',
                    border: '1px solid #e5e7eb',
                    borderRadius: 6,
                    fontSize: 11,
                    color: '#6b7280',
                  }}
                >
                  Sheep enter this batch only via the Send-to-Processor flag on a sheep weigh-in entry. Create the empty
                  batch shell here; sheep attach themselves once they're flagged at the chute.
                </div>
              )}
            </div>
            <div style={{padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8}}>
              <button
                onClick={saveBatch}
                style={{
                  padding: '8px 20px',
                  borderRadius: 7,
                  border: 'none',
                  background: '#0f766e',
                  color: 'white',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Save
              </button>
              {editId && (
                <button
                  onClick={() => deleteBatch(editId)}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 7,
                    border: '1px solid #F09595',
                    background: 'white',
                    color: '#b91c1c',
                    fontSize: 13,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Delete
                </button>
              )}
              <button
                onClick={() => {
                  setNotice(null);
                  setShowForm(false);
                  setEditId(null);
                  setForm(null);
                }}
                style={{
                  padding: '8px 16px',
                  borderRadius: 7,
                  border: '1px solid #d1d5db',
                  background: 'white',
                  color: '#6b7280',
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {React.createElement(ActivityModal, {
        sb,
        authState,
        target: activityTarget,
        onClose: () => setActivityTarget(null),
      })}
    </div>
  );
};

export default SheepBatchesView;
