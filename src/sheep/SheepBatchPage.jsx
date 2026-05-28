import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
import {detachSheepFromBatch} from '../lib/sheepProcessingBatch.js';
import {invalidateSheepWeighInsCache} from '../lib/sheepCache.js';
import {recordStatusChange, recordActivityEvent} from '../lib/entityMutations.js';

export default function SheepBatchPage({sb, fmt, authState, Header}) {
  const navigate = useNavigate();
  const location = useLocation();
  const batchId = location.pathname.slice('/sheep/batches/'.length);

  const role = authState && authState.role;
  const canEdit = role === 'admin' || role === 'management';

  const [batch, setBatch] = React.useState(null);
  const [sheep, setSheep] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState(null);
  const [draft, setDraft] = React.useState({});
  const [metaDraft, setMetaDraft] = React.useState(null);

  function logStatus(batchObj, from, to) {
    recordStatusChange(sb, {
      entityType: 'sheep.processing',
      entityId: batchObj.id,
      entityLabel: batchObj.name,
      from,
      to,
    }).catch(() => {});
  }
  function logEvent(batchObj, body) {
    recordActivityEvent(sb, {
      entityType: 'sheep.processing',
      entityId: batchObj.id,
      eventType: 'field.updated',
      entityLabel: batchObj.name,
      body,
    }).catch(() => {});
  }

  async function loadAll() {
    const [bR, sR] = await Promise.all([
      sb.from('sheep_processing_batches').select('*').eq('id', batchId).maybeSingle(),
      sb.from('sheep').select('*'),
    ]);
    if (bR.data) {
      setBatch(bR.data);
      setMetaDraft({
        name: bR.data.name || '',
        planned_process_date: bR.data.planned_process_date || '',
        actual_process_date: bR.data.actual_process_date || '',
        processing_cost: bR.data.processing_cost != null ? String(bR.data.processing_cost) : '',
        notes: bR.data.notes || '',
        status: bR.data.status || 'planned',
      });
    } else {
      setBatch(null);
    }
    if (sR.data) setSheep(sR.data);
    setLoading(false);
  }

  React.useEffect(() => {
    setBatch(null);
    setLoading(true);
    setNotice(null);
    loadAll();
  }, [batchId, authState]);

  React.useEffect(() => {
    if (!loading && location.hash) {
      const anchor = location.hash.slice(1);
      setTimeout(() => {
        const el = document.getElementById(anchor);
        if (el) el.scrollIntoView({behavior: 'smooth', block: 'center'});
      }, 200);
    }
  }, [loading, location.hash]);

  function sheepDetail() {
    return Array.isArray(batch && batch.sheep_detail) ? batch.sheep_detail : [];
  }
  function recomputeTotals(rows) {
    const live = rows.reduce((s, r) => s + (parseFloat(r.live_weight) || 0), 0);
    const hang = rows.reduce((s, r) => s + (parseFloat(r.hanging_weight) || 0), 0);
    return {
      total_live_weight: live > 0 ? Math.round(live * 10) / 10 : null,
      total_hanging_weight: hang > 0 ? Math.round(hang * 10) / 10 : null,
    };
  }

  async function saveSheepWeight(sheepId, field, value) {
    if (!canEdit || !batch) return;
    const currentRows = sheepDetail();
    const currentRow = currentRows.find((r) => r.sheep_id === sheepId);
    if (!currentRow) return;
    const oldValue = currentRow[field];
    const trimmed = value === '' || value == null ? null : parseFloat(value);
    if (trimmed != null && Number.isNaN(trimmed)) return;
    const newValue = trimmed;
    const oldNorm = oldValue == null ? null : oldValue;
    const newNorm = newValue == null ? null : newValue;
    if (oldNorm === newNorm) return;
    setNotice(null);
    const rows = currentRows.map((r) => (r.sheep_id === sheepId ? {...r, [field]: newValue} : r));
    const totals = recomputeTotals(rows);
    const {error} = await sb
      .from('sheep_processing_batches')
      .update({sheep_detail: rows, ...totals})
      .eq('id', batch.id);
    if (error) {
      setNotice({kind: 'error', message: 'Weight save failed: ' + error.message});
      return;
    }
    setBatch((prev) => (prev ? {...prev, sheep_detail: rows, ...totals} : prev));
    const tag = currentRow.tag || sheep.find((x) => x.id === sheepId)?.tag || sheepId;
    const fieldLabel = field === 'live_weight' ? 'Live weight' : field === 'hanging_weight' ? 'Hanging weight' : field;
    const fmtVal = (v) => (v == null ? '(empty)' : String(v));
    logEvent(batch, '#' + tag + ' ' + fieldLabel + ' ' + fmtVal(oldValue) + ' → ' + fmtVal(newValue));
  }

  async function saveMetaField(field, rawValue, options = {}) {
    if (!canEdit || !batch) return;
    let value = rawValue;
    if (field === 'name') {
      value = (rawValue || '').trim();
      if (!value || value === batch.name) return;
    } else if (field === 'planned_process_date' || field === 'actual_process_date') {
      value = (rawValue || '').trim();
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
      if (value === (batch[field] || '')) return;
      if (value === '') value = null;
    } else if (field === 'processing_cost') {
      const trimmed = (rawValue || '').toString().trim();
      value = trimmed === '' ? null : parseFloat(trimmed);
      if (value != null && Number.isNaN(value)) return;
      const current = batch.processing_cost != null ? batch.processing_cost : null;
      if (value === current) return;
    } else if (field === 'notes') {
      value = rawValue || null;
      if ((value || '') === (batch.notes || '')) return;
    }
    setNotice(null);
    const update = {[field]: value};
    const {error} = await sb.from('sheep_processing_batches').update(update).eq('id', batch.id);
    if (error) {
      setNotice({kind: 'error', message: 'Save failed: ' + error.message});
      return;
    }
    const oldValue = batch[field];
    setBatch((prev) => (prev ? {...prev, [field]: value} : prev));
    const label = options.label || field;
    const fmtVal = (v) => (v == null || v === '' ? '(empty)' : String(v));
    logEvent(batch, label + ' ' + fmtVal(oldValue) + ' → ' + fmtVal(value));
  }

  async function saveStatus(nextStatus) {
    if (!canEdit || !batch) return;
    if (nextStatus === batch.status) return;
    setNotice(null);
    const {error} = await sb.from('sheep_processing_batches').update({status: nextStatus}).eq('id', batch.id);
    if (error) {
      setNotice({kind: 'error', message: 'Status save failed: ' + error.message});
      return;
    }
    const prevStatus = batch.status;
    setBatch((prev) => (prev ? {...prev, status: nextStatus} : prev));
    logStatus(batch, prevStatus, nextStatus);
  }

  async function handleDetach(s, rowTag) {
    if (!canEdit || !batch || !s || !s.id) return;
    setNotice(null);
    const r = await detachSheepFromBatch(sb, s.id, batch.id, {
      teamMember: authState && authState.name ? authState.name : null,
    });
    if (!r.ok) {
      const tag = s.tag || rowTag || r.sheep?.tag || '?';
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
      return;
    }
    logEvent(batch, 'Detached #' + (s.tag || rowTag || '?') + ' from batch');
    invalidateSheepWeighInsCache();
    await loadAll();
  }

  async function handleDeleteBatch() {
    if (!canEdit || !batch) return;
    if (typeof window === 'undefined' || !window._wcfConfirmDelete) return;
    window._wcfConfirmDelete(
      'Delete this processing batch? Linked sheep will be detached and reverted to their prior flocks where possible.',
      async () => {
        setNotice(null);
        const sheepIds = sheepDetail()
          .map((r) => r.sheep_id)
          .filter(Boolean);
        const reverted = [];
        const blocked = [];
        for (const sid of sheepIds) {
          const r = await detachSheepFromBatch(sb, sid, batch.id, {
            teamMember: authState && authState.name ? authState.name : null,
          });
          if (r.ok) reverted.push(r);
          else blocked.push(r);
        }
        await sb.from('sheep').update({processing_batch_id: null}).eq('processing_batch_id', batch.id);
        const {error} = await sb.from('sheep_processing_batches').delete().eq('id', batch.id);
        invalidateSheepWeighInsCache();
        if (error) {
          setNotice({kind: 'error', message: 'Delete failed: ' + error.message});
          return;
        }
        if (blocked.length > 0) {
          const lines = blocked.map((b) => '#' + (b.sheep?.tag || b.sheepId || '?') + ' (' + b.reason + ')').join('\n');
          const message =
            'Batch deleted. ' +
            reverted.length +
            ' sheep reverted. ' +
            blocked.length +
            ' could not be auto-reverted:\n\n' +
            lines +
            '\n\nManually move them via the Flocks tab if needed.';
          navigate('/sheep/batches', {state: {notice: {kind: 'warning', message}}});
          return;
        }
        navigate('/sheep/batches');
      },
    );
  }

  if (loading) {
    return (
      <div style={{minHeight: '100vh', background: '#f1f3f2'}}>
        {Header && <Header />}
        <div style={{padding: 24, textAlign: 'center', color: '#6b7280', fontSize: 14}}>Loading…</div>
      </div>
    );
  }

  if (!batch) {
    return (
      <div style={{minHeight: '100vh', background: '#f1f3f2'}}>
        {Header && <Header />}
        <div style={{padding: 24}}>
          <button
            type="button"
            onClick={() => navigate('/sheep/batches')}
            style={{
              background: 'none',
              border: 'none',
              color: '#1d4ed8',
              cursor: 'pointer',
              fontSize: 14,
              fontFamily: 'inherit',
              padding: 0,
            }}
          >
            ← Back to Processing Batches
          </button>
          <div style={{marginTop: 16, color: '#6b7280', fontSize: 14}}>Batch not found.</div>
        </div>
      </div>
    );
  }

  const rows = sheepDetail();
  const totalLive = rows.reduce((s, r) => s + (parseFloat(r.live_weight) || 0), 0);
  const totalHang = rows.reduce((s, r) => s + (parseFloat(r.hanging_weight) || 0), 0);
  const yieldPct = totalLive > 0 && totalHang > 0 ? Math.round((totalHang / totalLive) * 1000) / 10 : null;
  const isComplete = batch.status === 'complete';
  const entityLabel = batch.name || batchId;
  const draftKey = (sid, field) => `${batch.id}|${sid}|${field}`;
  const draftVal = (sid, field, curr) => {
    const k = draftKey(sid, field);
    return draft[k] != null ? draft[k] : curr != null ? String(curr) : '';
  };

  const inpS = {
    fontSize: 13,
    padding: '6px 9px',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  };
  const lbl = {fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3, fontWeight: 500};

  return (
    <div style={{minHeight: '100vh', background: '#f1f3f2'}}>
      {Header && <Header />}
      <div style={{maxWidth: 900, margin: '0 auto', padding: '12px 16px'}}>
        <div style={{marginBottom: 12}}>
          <button
            type="button"
            onClick={() => navigate('/sheep/batches')}
            style={{
              background: 'none',
              border: 'none',
              color: '#1d4ed8',
              cursor: 'pointer',
              fontSize: 14,
              fontFamily: 'inherit',
              padding: 0,
              fontWeight: 500,
            }}
          >
            ← Back to Processing Batches
          </button>
        </div>

        <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12}}>
          <h1 data-record-title="1" style={{fontSize: 24, fontWeight: 700, color: '#111827', margin: 0}}>
            {batch.name}
          </h1>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 10,
              background: isComplete ? '#374151' : '#0f766e',
              color: 'white',
              textTransform: 'uppercase',
            }}
          >
            {batch.status}
          </span>
          <span style={{fontSize: 12, color: '#6b7280'}}>
            {rows.length} {rows.length === 1 ? 'sheep' : 'sheep'}
          </span>
          {batch.planned_process_date && (
            <span style={{fontSize: 12, color: '#6b7280'}}>planned {fmt(batch.planned_process_date)}</span>
          )}
          {batch.actual_process_date && (
            <span style={{fontSize: 12, color: '#065f46'}}>processed {fmt(batch.actual_process_date)}</span>
          )}
          {yieldPct && <span style={{fontSize: 12, fontWeight: 600, color: '#065f46'}}>{yieldPct + '% yield'}</span>}
        </div>

        {notice && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}

        {/* Metadata editor */}
        <div
          data-sheep-batch-meta="1"
          style={{
            background: 'white',
            border: '1px solid #e5e7eb',
            borderRadius: 10,
            padding: '14px 18px',
            marginBottom: 12,
          }}
        >
          <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
            <div style={{gridColumn: '1/-1'}}>
              <label style={lbl}>Name</label>
              <input
                value={metaDraft ? metaDraft.name : ''}
                disabled={!canEdit}
                data-sheep-batch-name
                onChange={(e) => setMetaDraft((m) => ({...m, name: e.target.value}))}
                onBlur={(e) => saveMetaField('name', e.target.value, {label: 'Renamed'})}
                style={{...inpS, width: '100%'}}
              />
            </div>
            <div>
              <label style={lbl}>Status</label>
              <select
                value={metaDraft ? metaDraft.status : 'planned'}
                disabled={!canEdit}
                data-sheep-batch-status
                onChange={(e) => {
                  const next = e.target.value;
                  setMetaDraft((m) => ({...m, status: next}));
                  saveStatus(next);
                }}
                style={{...inpS, width: '100%'}}
              >
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
                value={metaDraft ? metaDraft.processing_cost : ''}
                disabled={!canEdit}
                data-sheep-batch-cost
                onChange={(e) => setMetaDraft((m) => ({...m, processing_cost: e.target.value}))}
                onBlur={(e) => saveMetaField('processing_cost', e.target.value, {label: 'Cost'})}
                style={{...inpS, width: '100%'}}
              />
            </div>
            <div>
              <label style={lbl}>Planned Process Date</label>
              <input
                type="date"
                value={metaDraft ? metaDraft.planned_process_date : ''}
                disabled={!canEdit}
                data-sheep-batch-planned-date
                onChange={(e) => setMetaDraft((m) => ({...m, planned_process_date: e.target.value}))}
                onBlur={(e) => saveMetaField('planned_process_date', e.target.value, {label: 'Planned date'})}
                style={{...inpS, width: '100%'}}
              />
            </div>
            <div>
              <label style={lbl}>Actual Process Date</label>
              <input
                type="date"
                value={metaDraft ? metaDraft.actual_process_date : ''}
                disabled={!canEdit}
                data-sheep-batch-actual-date
                onChange={(e) => setMetaDraft((m) => ({...m, actual_process_date: e.target.value}))}
                onBlur={(e) => saveMetaField('actual_process_date', e.target.value, {label: 'Actual date'})}
                style={{...inpS, width: '100%'}}
              />
            </div>
            <div style={{gridColumn: '1/-1'}}>
              <label style={lbl}>Notes</label>
              <textarea
                value={metaDraft ? metaDraft.notes : ''}
                disabled={!canEdit}
                data-sheep-batch-notes
                rows={2}
                onChange={(e) => setMetaDraft((m) => ({...m, notes: e.target.value}))}
                onBlur={(e) => saveMetaField('notes', e.target.value, {label: 'Notes'})}
                style={{...inpS, width: '100%', resize: 'vertical'}}
              />
            </div>
          </div>
        </div>

        {/* Stats + sheep weights */}
        <div
          style={{
            background: 'white',
            border: '1px solid #e5e7eb',
            borderRadius: 10,
            padding: '14px 18px',
            marginBottom: 12,
          }}
        >
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
            <Stat label="Live wt total" value={totalLive > 0 ? Math.round(totalLive).toLocaleString() + ' lb' : '—'} />
            <Stat label="Hanging wt" value={totalHang > 0 ? Math.round(totalHang).toLocaleString() + ' lb' : '—'} />
            <Stat label="Yield" value={yieldPct ? yieldPct + '%' : '—'} color={yieldPct ? '#065f46' : '#9ca3af'} />
            <Stat label="Cost" value={batch.processing_cost ? '$' + batch.processing_cost.toLocaleString() : '—'} />
          </div>

          {rows.length > 0 ? (
            <div style={{display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8}}>
              {rows.map((r) => {
                const s = sheep.find((x) => x.id === r.sheep_id);
                const lv = parseFloat(r.live_weight);
                const hw = parseFloat(r.hanging_weight);
                const y = lv > 0 && hw > 0 ? Math.round((hw / lv) * 1000) / 10 : null;
                const weightDisabled = !canEdit || isComplete;
                const weightStyle = {
                  fontSize: 13,
                  padding: '6px 8px',
                  border: '1px solid #e5e7eb',
                  borderRadius: 5,
                  fontFamily: 'inherit',
                  width: '100%',
                  minWidth: 70,
                  boxSizing: 'border-box',
                  background: weightDisabled ? '#f9fafb' : 'white',
                  color: '#111827',
                  opacity: 1,
                  WebkitTextFillColor: '#111827',
                };
                return (
                  <div
                    key={r.sheep_id}
                    data-batch-sheep-row={r.sheep_id}
                    style={{
                      border: '1px solid #f3f4f6',
                      borderRadius: 8,
                      padding: '8px 10px',
                      fontSize: 12,
                    }}
                  >
                    <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4}}>
                      <span style={{fontWeight: 700, color: '#111827', minWidth: 50}}>
                        {'#' + (r.tag || s?.tag || '?')}
                      </span>
                      <span style={{fontSize: 11, color: '#6b7280'}}>{s?.breed || '—'}</span>
                      {y && <span style={{fontSize: 11, fontWeight: 600, color: '#065f46'}}>{y + '% yield'}</span>}
                      <span style={{flex: 1}} />
                      {canEdit && !isComplete && (
                        <button
                          type="button"
                          onClick={() => handleDetach(s || {id: r.sheep_id, tag: r.tag}, r.tag)}
                          title="Detach sheep from batch (reverts flock)"
                          data-batch-sheep-detach={r.sheep_id}
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
                          ×
                        </button>
                      )}
                    </div>
                    <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
                      <label style={{flex: '1 1 120px', minWidth: 0}}>
                        <div style={{fontSize: 10, color: '#6b7280', textTransform: 'uppercase', marginBottom: 2}}>
                          Live wt (lb)
                        </div>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          placeholder="—"
                          value={draftVal(r.sheep_id, 'live', r.live_weight)}
                          disabled={weightDisabled}
                          data-batch-sheep-live-weight={r.sheep_id}
                          onChange={(e) => setDraft((p) => ({...p, [draftKey(r.sheep_id, 'live')]: e.target.value}))}
                          onBlur={(e) => {
                            saveSheepWeight(r.sheep_id, 'live_weight', e.target.value);
                            setDraft((p) => {
                              const x = {...p};
                              delete x[draftKey(r.sheep_id, 'live')];
                              return x;
                            });
                          }}
                          style={weightStyle}
                        />
                      </label>
                      <label style={{flex: '1 1 120px', minWidth: 0}}>
                        <div style={{fontSize: 10, color: '#6b7280', textTransform: 'uppercase', marginBottom: 2}}>
                          Hanging wt (lb)
                        </div>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          placeholder="—"
                          value={draftVal(r.sheep_id, 'hanging', r.hanging_weight)}
                          disabled={weightDisabled}
                          data-batch-sheep-hanging-weight={r.sheep_id}
                          onChange={(e) => setDraft((p) => ({...p, [draftKey(r.sheep_id, 'hanging')]: e.target.value}))}
                          onBlur={(e) => {
                            saveSheepWeight(r.sheep_id, 'hanging_weight', e.target.value);
                            setDraft((p) => {
                              const x = {...p};
                              delete x[draftKey(r.sheep_id, 'hanging')];
                              return x;
                            });
                          }}
                          style={weightStyle}
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{fontSize: 12, color: '#9ca3af', fontStyle: 'italic'}}>
              No sheep attached yet. Sheep enter this batch only via the Send-to-Processor flag on a sheep weigh-in
              entry.
            </div>
          )}

          {rows.length > 0 && !isComplete && (
            <div style={{fontSize: 11, color: '#6b7280', fontStyle: 'italic', marginTop: 6}}>
              Sheep enter this batch only via the Send-to-Processor flag on a sheep weigh-in entry.
            </div>
          )}

          {canEdit && (
            <div style={{display: 'flex', gap: 8, marginTop: 10}}>
              <span style={{flex: 1}} />
              <button
                type="button"
                onClick={handleDeleteBatch}
                data-sheep-batch-delete={batch.id}
                style={{
                  padding: '6px 14px',
                  borderRadius: 6,
                  border: '1px solid #fca5a5',
                  background: 'white',
                  color: '#b91c1c',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                Delete batch
              </button>
            </div>
          )}
        </div>

        <RecordCollaborationSection
          sb={sb}
          authState={authState}
          entityType="sheep.processing"
          entityId={batch.id}
          entityLabel={entityLabel}
        />
      </div>
    </div>
  );
}

function Stat({label, value, color = '#111827'}) {
  return (
    <div>
      <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase'}}>{label}</div>
      <div style={{fontWeight: 600, color}}>{value}</div>
    </div>
  );
}
