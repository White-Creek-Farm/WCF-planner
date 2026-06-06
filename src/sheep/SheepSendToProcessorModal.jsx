// SheepSendToProcessorModal — mirror of CattleSendToProcessorModal.
// Pops up when a sheep weigh-in session is being completed and at least
// one entry has send_to_processor=true. Gate is intentionally looser than
// cattle's finishers-only — any draft session, any flock per §7. User
// picks an existing planned processing batch OR creates a new one; on
// confirm, the flagged entries' sheep are attached to the batch
// (live_weight from this session's entries), moved to the 'processed'
// flock, and a sheep_transfers row logged per sheep.
//
// Batch status stays 'planned' — the actual processing event happens
// later at the processor and is marked complete from the Batches tab.
import React from 'react';
import {createProcessingBatch, attachEntriesToBatch} from '../lib/sheepProcessingBatch.js';
import {attachSheepToProcessingBatch} from '../lib/processingAttachApi.js';

export default function SheepSendToProcessorModal({
  sb,
  session,
  flaggedEntries,
  sheepList,
  teamMember,
  authState,
  useAttachRpc = false,
  onCancel,
  onConfirmed,
}) {
  const role = authState && authState.role;
  const canSend = !useAttachRpc || role === 'admin' || role === 'management';
  const [plannedBatches, setPlannedBatches] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [mode, setMode] = React.useState('existing'); // 'existing' | 'new'
  const [batchId, setBatchId] = React.useState('');
  const [newName, setNewName] = React.useState('');
  const [newPlannedDate, setNewPlannedDate] = React.useState(
    (session && session.date) || new Date().toISOString().slice(0, 10),
  );
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    sb.from('sheep_processing_batches')
      .select('*')
      .eq('status', 'planned')
      .is('actual_process_date', null)
      .order('planned_process_date', {ascending: true, nullsFirst: false})
      .then(({data, error}) => {
        if (cancelled) return;
        if (error) {
          setErr('Could not load planned batches: ' + error.message);
          setLoading(false);
          return;
        }
        const rows = data || [];
        setPlannedBatches(rows);
        if (rows.length === 0) setMode('new');
        const yr = new Date().getFullYear().toString().slice(-2);
        const existingNums = rows.map((b) =>
          (b.name || '').startsWith('S-' + yr + '-') ? parseInt(b.name.slice(5)) || 0 : 0,
        );
        const next = (Math.max(0, ...existingNums) + 1).toString().padStart(2, '0');
        setNewName('S-' + yr + '-' + next);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sb]);

  const totalWeight = flaggedEntries.reduce((s, e) => s + (parseFloat(e.weight) || 0), 0);

  async function go() {
    setErr('');
    if (mode === 'existing' && !batchId) {
      setErr('Pick a planned batch or switch to + New.');
      return;
    }
    if (mode === 'new' && !newName.trim()) {
      setErr('Name the new batch.');
      return;
    }
    if (!canSend) {
      setErr('Send-to-Processor is restricted to management/admin.');
      return;
    }
    setBusy(true);
    try {
      let batch;
      let attached;
      let skipped;
      if (useAttachRpc) {
        if (mode === 'existing') {
          batch = plannedBatches.find((b) => b.id === batchId);
          if (!batch) throw new Error('Selected batch not found.');
        }
        const result = await attachSheepToProcessingBatch(sb, {
          sessionId: session && session.id,
          entryIds: flaggedEntries.map((e) => e.id).filter(Boolean),
          targetBatchId: mode === 'existing' ? batchId : null,
          batchName: mode === 'new' ? newName : null,
          plannedDate: mode === 'new' ? newPlannedDate : null,
          teamMember,
        });
        batch = result.batch;
        attached = result.attached || [];
        skipped = result.skipped || [];
      } else if (mode === 'existing') {
        batch = plannedBatches.find((b) => b.id === batchId);
        if (!batch) throw new Error('Selected batch not found.');
      } else {
        batch = await createProcessingBatch(sb, {name: newName, plannedDate: newPlannedDate});
      }
      if (!useAttachRpc) {
        const result = await attachEntriesToBatch(sb, {
          batch,
          entries: flaggedEntries,
          sheepList,
          teamMember,
        });
        attached = result.attached;
        skipped = result.skipped;
      }
      onConfirmed({batch, attached, skipped});
    } catch (e) {
      setErr(e.message || 'Could not attach to batch.');
      setBusy(false);
    }
  }

  const lblS = {display: 'block', fontSize: 12, color: '#374151', marginBottom: 4, fontWeight: 600};
  const inpS = {
    fontFamily: 'inherit',
    fontSize: 13,
    padding: '8px 10px',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    width: '100%',
    boxSizing: 'border-box',
    background: 'white',
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.45)',
        zIndex: 500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          background: 'white',
          borderRadius: 12,
          maxWidth: 480,
          width: '100%',
          padding: '18px 20px',
          boxShadow: '0 12px 40px rgba(0,0,0,.25)',
        }}
      >
        <div style={{fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 6}}>
          {'🚩 Send ' + flaggedEntries.length + ' sheep to processor'}
        </div>
        <div style={{fontSize: 11, color: '#6b7280', marginBottom: 14}}>
          {'Total live weight: ' +
            Math.round(totalWeight).toLocaleString() +
            ' lb. These sheep will move to the Processed flock and attach to the batch. The batch stays ‘planned’ until you mark it complete from the Batches tab.'}
        </div>

        {loading && (
          <div style={{padding: '20px 0', textAlign: 'center', color: '#9ca3af', fontSize: 12}}>
            Loading planned batches{'…'}
          </div>
        )}

        {!loading && (
          <div style={{marginBottom: 10}}>
            <div style={{display: 'flex', gap: 6, marginBottom: 8}}>
              <button
                type="button"
                onClick={() => setMode('existing')}
                disabled={plannedBatches.length === 0}
                style={{
                  flex: 1,
                  padding: '7px 10px',
                  borderRadius: 6,
                  border: '1px solid ' + (mode === 'existing' ? '#0f766e' : '#d1d5db'),
                  background: mode === 'existing' ? '#0f766e' : 'white',
                  color: mode === 'existing' ? 'white' : plannedBatches.length === 0 ? '#d1d5db' : '#374151',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: plannedBatches.length === 0 ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {'Existing planned (' + plannedBatches.length + ')'}
              </button>
              <button
                type="button"
                onClick={() => setMode('new')}
                style={{
                  flex: 1,
                  padding: '7px 10px',
                  borderRadius: 6,
                  border: '1px solid ' + (mode === 'new' ? '#0f766e' : '#d1d5db'),
                  background: mode === 'new' ? '#0f766e' : 'white',
                  color: mode === 'new' ? 'white' : '#374151',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                + New batch
              </button>
            </div>

            {mode === 'existing' && (
              <select value={batchId} onChange={(e) => setBatchId(e.target.value)} style={inpS}>
                <option value="">Select planned batch{'…'}</option>
                {plannedBatches.map((b) => {
                  const n = Array.isArray(b.sheep_detail) ? b.sheep_detail.length : 0;
                  const when = b.planned_process_date ? ' · planned ' + b.planned_process_date : '';
                  return (
                    <option key={b.id} value={b.id}>
                      {b.name + when + ' · ' + n + (n === 1 ? ' sheep' : ' sheep')}
                    </option>
                  );
                })}
              </select>
            )}

            {mode === 'new' && (
              <div style={{display: 'flex', gap: 8}}>
                <div style={{flex: 1}}>
                  <label style={lblS}>Batch name *</label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="S-26-01"
                    style={inpS}
                  />
                </div>
                <div style={{width: 140}}>
                  <label style={lblS}>Planned date</label>
                  <input
                    type="date"
                    value={newPlannedDate}
                    onChange={(e) => setNewPlannedDate(e.target.value)}
                    style={inpS}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {err && (
          <div
            style={{
              color: '#b91c1c',
              fontSize: 12,
              marginBottom: 10,
              padding: '6px 10px',
              background: '#fef2f2',
              borderRadius: 6,
            }}
          >
            {err}
          </div>
        )}

        <div style={{display: 'flex', gap: 8, justifyContent: 'flex-end'}}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: '8px 14px',
              borderRadius: 7,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#374151',
              fontWeight: 600,
              fontSize: 12,
              cursor: busy ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            onClick={go}
            disabled={
              busy || loading || !canSend || (mode === 'existing' && !batchId) || (mode === 'new' && !newName.trim())
            }
            style={{
              padding: '8px 16px',
              borderRadius: 7,
              border: 'none',
              background:
                busy || loading || !canSend || (mode === 'existing' && !batchId) || (mode === 'new' && !newName.trim())
                  ? '#9ca3af'
                  : '#0f766e',
              color: 'white',
              fontWeight: 700,
              fontSize: 12,
              cursor:
                busy || loading || !canSend || (mode === 'existing' && !batchId) || (mode === 'new' && !newName.trim())
                  ? 'not-allowed'
                  : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {busy ? 'Attaching…' : 'Send to processor'}
          </button>
        </div>
      </div>
    </div>
  );
}
