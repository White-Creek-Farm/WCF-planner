import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordSequenceNav from '../shared/RecordSequenceNav.jsx';
import {recordSeqNavOptions} from '../lib/recordSequence.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
import RecordPageLoadError from '../shared/RecordPageLoadError.jsx';
/* eslint-disable no-unused-vars -- shell primitives are used in JSX only */
import {
  RecordPageFrame,
  RecordPageLoading,
  RecordPageNotFound,
  RecordPageBody,
  RecordBackLink,
  RecordTitle,
} from '../shared/RecordPageShell.jsx';
/* eslint-enable no-unused-vars */
import {recordControl, recordFieldLabel} from '../shared/recordPageControls.jsx';
import {detachCattleFromProcessingBatch} from '../lib/processingDetachApi.js';
import {unscheduleCattleProcessingBatch} from '../lib/processingBatchDeleteApi.js';
import {batchHasAllHangingWeights, batchMissingHangingTags, validateRealBatchRename} from '../lib/cattleForecast.js';
import {markBatchComplete, reopenBatch} from '../lib/cattleForecastApi.js';
import {todayCentralISO} from '../lib/dateUtils.js';
import {invalidateCattleWeighInsCache} from '../lib/cattleCache.js';
import {recordStatusChange, recordActivityEvent} from '../lib/entityMutations.js';

function resolveProcessedDate(batch) {
  if (batch && batch.actual_process_date) return batch.actual_process_date;
  if (batch && batch.planned_process_date) return batch.planned_process_date;
  return todayCentralISO();
}

export default function CattleBatchPage({sb, fmt, authState, Header}) {
  const navigate = useNavigate();
  const location = useLocation();

  function logStatus(batchObj, from, to) {
    recordStatusChange(sb, {
      entityType: 'cattle.processing',
      entityId: batchObj.id,
      entityLabel: batchObj.name,
      from,
      to,
    }).catch(() => {});
  }
  function logEvent(batchObj, body) {
    recordActivityEvent(sb, {
      entityType: 'cattle.processing',
      entityId: batchObj.id,
      eventType: 'field.updated',
      entityLabel: batchObj.name,
      body,
    }).catch(() => {});
  }
  const batchId = location.pathname.slice('/cattle/batches/'.length);
  // Originating list order handed through route state; absent on direct links.
  const recordSeq = location.state?.recordSeq || null;
  function navigateSeq(id) {
    navigate('/cattle/batches/' + id, recordSeqNavOptions(recordSeq));
  }

  const [batch, setBatch] = React.useState(null);
  const [allBatches, setAllBatches] = React.useState([]);
  const [cattle, setCattle] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState(null);
  const [loadError, setLoadError] = React.useState(null);
  const [cowDraft, setCowDraft] = React.useState({});
  const [renameDraft, setRenameDraft] = React.useState('');
  const [renameErr, setRenameErr] = React.useState(null);
  const [scheduledDateDraft, setScheduledDateDraft] = React.useState('');
  const [unscheduling, setUnscheduling] = React.useState(false);

  const role = authState && authState.role;
  const canEdit = role === 'admin' || role === 'management';

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    try {
      const [bR, cR, allR] = await Promise.all([
        sb.from('cattle_processing_batches').select('*').eq('id', batchId).maybeSingle(),
        sb.from('cattle').select('*').is('deleted_at', null),
        sb.from('cattle_processing_batches').select('id, name, status'),
      ]);
      if (bR.error) throw new Error('cattle_processing_batches: ' + (bR.error.message || bR.error));
      if (cR.error) throw new Error('cattle: ' + (cR.error.message || cR.error));
      if (allR.error) throw new Error('cattle_processing_batches list: ' + (allR.error.message || allR.error));
      if (bR.data) {
        setBatch(bR.data);
        setRenameDraft(bR.data.name || '');
        setScheduledDateDraft(bR.data.planned_process_date || '');
      } else {
        setBatch(null);
        setRenameDraft('');
        setScheduledDateDraft('');
      }
      setCattle(cR.data || []);
      setAllBatches(allR.data || []);
    } catch (e) {
      setBatch(null);
      setCattle([]);
      setAllBatches([]);
      setRenameDraft('');
      setScheduledDateDraft('');
      setLoadError({
        kind: 'error',
        message: 'Could not load cattle processing batch. Please refresh the page. (' + ((e && e.message) || e) + ')',
      });
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    setBatch(null);
    setLoading(true);
    setNotice(null);
    setLoadError(null);
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

  function cowsDetail() {
    return Array.isArray(batch.cows_detail) ? batch.cows_detail : [];
  }
  function recomputeTotals(rows) {
    const live = rows.reduce((s, r) => s + (parseFloat(r.live_weight) || 0), 0);
    const hang = rows.reduce((s, r) => s + (parseFloat(r.hanging_weight) || 0), 0);
    return {
      total_live_weight: live > 0 ? Math.round(live * 10) / 10 : null,
      total_hanging_weight: hang > 0 ? Math.round(hang * 10) / 10 : null,
    };
  }

  async function saveCowWeight(cattleId, field, value) {
    if (!canEdit || !batch) return;
    setNotice(null);
    const rows = cowsDetail().map((r) =>
      r.cattle_id === cattleId ? {...r, [field]: value === '' || value == null ? null : parseFloat(value)} : r,
    );
    const totals = recomputeTotals(rows);
    const {error} = await sb
      .from('cattle_processing_batches')
      .update({cows_detail: rows, ...totals})
      .eq('id', batch.id);
    if (error) {
      setNotice({kind: 'error', message: 'Weight save failed: ' + error.message});
      return;
    }
    const nextBatch = {...batch, cows_detail: rows, ...totals};
    setBatch(nextBatch);
    if (field === 'hanging_weight' && nextBatch.status === 'active' && batchHasAllHangingWeights(nextBatch)) {
      const processedDate = resolveProcessedDate(nextBatch);
      try {
        await markBatchComplete(sb, batch.id, {processedDate});
        setBatch((prev) => ({...prev, status: 'complete', actual_process_date: processedDate}));
        logStatus(batch, 'active', 'complete');
      } catch (e) {
        setNotice({kind: 'error', message: 'Auto-complete failed: ' + (e.message || e)});
      }
    }
  }

  async function handleMarkComplete() {
    if (!canEdit || !batch) return;
    setNotice(null);
    if (!batchHasAllHangingWeights(batch)) {
      const missing = batchMissingHangingTags(batch);
      setNotice({
        kind: 'error',
        message:
          'Cannot mark complete — these tags are missing hanging weights:\n\n#' +
          missing.join('  #') +
          "\n\nEnter every cow's hanging weight first.",
      });
      return;
    }
    const processedDate = resolveProcessedDate(batch);
    try {
      await markBatchComplete(sb, batch.id, {processedDate});
      setBatch((prev) => ({...prev, status: 'complete', actual_process_date: processedDate}));
      logStatus(batch, 'active', 'complete');
    } catch (e) {
      setNotice({kind: 'error', message: 'Mark complete failed: ' + (e.message || e)});
    }
  }

  async function handleReopen() {
    if (!canEdit || !batch) return;
    setNotice(null);
    try {
      await reopenBatch(sb, batch.id);
      setBatch((prev) => ({...prev, status: 'active'}));
      logStatus(batch, 'complete', 'active');
    } catch (e) {
      setNotice({kind: 'error', message: 'Reopen failed: ' + (e.message || e)});
    }
  }

  async function handleSaveRename() {
    if (!canEdit || !batch) return;
    setNotice(null);
    const proposed = (renameDraft || '').trim();
    if (!proposed || proposed === batch.name) {
      setRenameErr(null);
      return;
    }
    const v = validateRealBatchRename({proposedName: proposed, currentName: batch.name, realBatches: allBatches});
    if (!v.ok) {
      setRenameErr(v.reason);
      return;
    }
    const r = await sb.from('cattle_processing_batches').update({name: proposed}).eq('id', batch.id);
    if (r.error) {
      setRenameErr('db_error');
      setNotice({kind: 'error', message: 'Rename failed: ' + r.error.message});
      return;
    }
    const oldName = batch.name;
    setBatch((prev) => ({...prev, name: proposed}));
    setRenameErr(null);
    logEvent(batch, 'Renamed ' + oldName + ' → ' + proposed);
  }

  async function handleDetach(cow) {
    if (!canEdit || !batch || !cow || !cow.id) return;
    setNotice(null);
    // Atomic detach via SECDEF RPC (migration 081): the RPC reverts the herd,
    // writes the undo transfer audit row, clears the weigh-ins, AND logs the
    // field.updated Activity event in one transaction — so no client logEvent
    // here. Business-rule blocks come back as {ok:false, reason}.
    const r = await detachCattleFromProcessingBatch(sb, {
      cattleId: cow.id,
      batchId: batch.id,
      teamMember: authState && authState.name ? authState.name : null,
    });
    if (!r.ok) {
      const tag = cow.tag || r.tag || '?';
      if (r.reason === 'no_prior_herd') {
        setNotice({
          kind: 'warning',
          message: 'Cannot auto-detach #' + tag + ': no prior herd recorded. Manually move via the Herds tab.',
        });
      } else {
        setNotice({kind: 'error', message: 'Detach failed for #' + tag + ': ' + r.reason});
      }
      return;
    }
    invalidateCattleWeighInsCache();
    await loadAll();
  }

  async function handleUpdateScheduledDate() {
    if (!canEdit || !batch || batch.status !== 'scheduled') return;
    const nextDate = (scheduledDateDraft || '').trim();
    if (!nextDate || !/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) return;
    if (nextDate === batch.planned_process_date) return;
    setNotice(null);
    const r = await sb.from('cattle_processing_batches').update({planned_process_date: nextDate}).eq('id', batch.id);
    if (r.error) {
      setNotice({kind: 'error', message: 'Date update failed: ' + r.error.message});
      return;
    }
    const oldDate = batch.planned_process_date;
    setBatch((prev) => ({...prev, planned_process_date: nextDate}));
    logEvent(batch, 'Scheduled date ' + (oldDate || '(none)') + ' → ' + nextDate);
  }

  async function handleUnschedule() {
    if (!canEdit || !batch || batch.status !== 'scheduled') return;
    setNotice(null);
    // Atomic unschedule via SECDEF RPC (migration 100): deletes the empty
    // scheduled batch, defensively unlinks any cattle, and logs record.deleted
    // in one transaction — replacing the unaudited direct client delete.
    const r = await unscheduleCattleProcessingBatch(sb, {
      batchId: batch.id,
      teamMember: authState && authState.name ? authState.name : null,
    });
    if (!r.ok) {
      setNotice({kind: 'error', message: 'Unschedule failed: ' + (r.reason === 'rpc_error' ? r.error : r.reason)});
      return;
    }
    navigate('/cattle/batches');
  }

  if (loading) {
    return <RecordPageLoading Header={Header} />;
  }

  if (loadError) {
    return (
      <RecordPageLoadError
        Header={Header}
        backLabel="Back to Processing Batches"
        onBack={() => navigate('/cattle/batches')}
        notice={loadError}
        onRetry={loadAll}
        maxWidth={900}
        data-cattle-batch-load-error="true"
      />
    );
  }

  if (!batch) {
    return (
      <RecordPageNotFound
        Header={Header}
        backLabel="Back to Processing Batches"
        onBack={() => navigate('/cattle/batches')}
        message="Batch not found."
      />
    );
  }

  const rows = cowsDetail();
  const totalLive = rows.reduce((s, r) => s + (parseFloat(r.live_weight) || 0), 0);
  const totalHang = rows.reduce((s, r) => s + (parseFloat(r.hanging_weight) || 0), 0);
  const yieldPct = totalLive > 0 && totalHang > 0 ? Math.round((totalHang / totalLive) * 1000) / 10 : null;
  const isComplete = batch.status === 'complete';
  const isScheduled = batch.status === 'scheduled';
  const entityLabel = batch.name || batchId;
  const draftKey = (cid, field) => `${batch.id}|${cid}|${field}`;
  const draftVal = (cid, field, curr) => {
    const k = draftKey(cid, field);
    return cowDraft[k] != null ? cowDraft[k] : curr != null ? String(curr) : '';
  };

  return (
    <RecordPageFrame Header={Header}>
      <RecordPageBody maxWidth={900} data-cattle-batch-record-loaded="true">
        <RecordBackLink label="Back to Processing Batches" onBack={() => navigate('/cattle/batches')} />

        <RecordSequenceNav seq={recordSeq} currentId={batchId} onNavigate={navigateSeq} />

        <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12}}>
          <RecordTitle fontSize={22} margin={0}>
            {batch.name}
          </RecordTitle>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 10,
              background: isComplete ? '#374151' : isScheduled ? '#fef3c7' : '#1d4ed8',
              color: isScheduled ? '#92400e' : 'white',
              textTransform: 'uppercase',
            }}
          >
            {batch.status}
          </span>
          {!isScheduled && (
            <span style={{fontSize: 12, color: '#6b7280'}}>
              {rows.length} {rows.length === 1 ? 'cow' : 'cows'}
            </span>
          )}
          {(batch.actual_process_date || batch.planned_process_date) && (
            <span style={{fontSize: 12, color: '#065f46'}}>
              {isScheduled ? 'scheduled' : 'processed'} {fmt(batch.actual_process_date || batch.planned_process_date)}
            </span>
          )}
          {yieldPct && <span style={{fontSize: 12, fontWeight: 600, color: '#065f46'}}>{yieldPct + '% yield'}</span>}
        </div>

        {notice && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}

        {/* Scheduled batch controls */}
        {isScheduled && canEdit && (
          <div
            style={{
              background: 'white',
              border: '1px solid #e5e7eb',
              borderRadius: 10,
              padding: '14px 18px',
              marginBottom: 12,
            }}
          >
            <div style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10}}>
              {/* Inline editor row: shared control/label styling (CP2); kept
                  inline next to the Unschedule action rather than a full grid
                  row. Save (handleUpdateScheduledDate onBlur) unchanged. */}
              <span style={recordFieldLabel}>Processor date</span>
              <input
                type="date"
                value={scheduledDateDraft}
                onChange={(e) => setScheduledDateDraft(e.target.value)}
                onBlur={handleUpdateScheduledDate}
                data-scheduled-batch-date={batch.id}
                style={{...recordControl, width: 180}}
              />
            </div>
            {!unscheduling ? (
              <button
                type="button"
                onClick={() => setUnscheduling(true)}
                data-scheduled-batch-unschedule={batch.id}
                style={{
                  fontSize: 12,
                  padding: '10px 16px',
                  borderRadius: 6,
                  border: '1px solid #fca5a5',
                  background: 'white',
                  color: '#b91c1c',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Unschedule
              </button>
            ) : (
              <div
                data-scheduled-batch-unschedule-warning={batch.id}
                style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}
              >
                <span style={{fontSize: 12, color: '#b91c1c'}}>Remove this scheduled batch?</span>
                <button
                  type="button"
                  onClick={() => setUnscheduling(false)}
                  data-scheduled-batch-unschedule-cancel={batch.id}
                  style={{
                    fontSize: 11,
                    padding: '4px 10px',
                    borderRadius: 5,
                    border: '1px solid #d1d5db',
                    background: 'white',
                    color: '#374151',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleUnschedule}
                  data-scheduled-batch-unschedule-confirm={batch.id}
                  style={{
                    fontSize: 11,
                    padding: '4px 10px',
                    borderRadius: 5,
                    border: 'none',
                    background: '#b91c1c',
                    color: 'white',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontWeight: 600,
                  }}
                >
                  Confirm unschedule
                </button>
              </div>
            )}
          </div>
        )}

        {/* Active/complete batch workspace */}
        {!isScheduled && (
          <div
            style={{
              background: 'white',
              border: '1px solid #e5e7eb',
              borderRadius: 10,
              padding: '14px 18px',
              marginBottom: 12,
            }}
          >
            {canEdit && (
              <div style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10}}>
                {!isComplete && (
                  <>
                    {/* Inline rename editor: shared control/label styling (CP2);
                        kept inline next to the Complete/Reopen action. Save
                        (handleSaveRename onBlur + validation) unchanged. */}
                    <span style={recordFieldLabel}>Name</span>
                    <input
                      type="text"
                      value={renameDraft}
                      onChange={(e) => {
                        setRenameDraft(e.target.value);
                        setRenameErr(null);
                      }}
                      onBlur={handleSaveRename}
                      data-rename-input={batch.id}
                      style={{...recordControl, width: 160}}
                    />
                    {renameErr && (
                      <span style={{fontSize: 11, color: '#b91c1c'}} data-rename-err={batch.id}>
                        {renameErr === 'format' && 'Use C-YY-NN'}
                        {renameErr === 'duplicate' && 'Name already used'}
                        {renameErr === 'sequence_gap' && 'Would skip a sequence number'}
                        {renameErr === 'new_year_must_start_at_01' && 'New year must start at 01'}
                        {renameErr === 'db_error' && 'Save error'}
                      </span>
                    )}
                  </>
                )}
                <span style={{flex: 1}} />
                {!isComplete ? (
                  <button
                    onClick={handleMarkComplete}
                    data-mark-complete={batch.id}
                    style={{
                      fontSize: 12,
                      padding: '10px 16px',
                      borderRadius: 6,
                      border: 'none',
                      background: '#374151',
                      color: 'white',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontWeight: 600,
                    }}
                  >
                    Mark complete
                  </button>
                ) : (
                  <button
                    onClick={handleReopen}
                    data-reopen={batch.id}
                    style={{
                      fontSize: 12,
                      padding: '10px 16px',
                      borderRadius: 6,
                      border: '1px solid #1d4ed8',
                      background: 'white',
                      color: '#1d4ed8',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontWeight: 600,
                    }}
                  >
                    Reopen to active
                  </button>
                )}
              </div>
            )}

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
              <Stat
                label="Live wt total"
                value={totalLive > 0 ? Math.round(totalLive).toLocaleString() + ' lb' : '—'}
              />
              <Stat label="Hanging wt" value={totalHang > 0 ? Math.round(totalHang).toLocaleString() + ' lb' : '—'} />
              <Stat label="Yield" value={yieldPct ? yieldPct + '%' : '—'} color={yieldPct ? '#065f46' : '#9ca3af'} />
              <Stat label="Cost" value={batch.processing_cost ? '$' + batch.processing_cost.toLocaleString() : '—'} />
            </div>

            {rows.length > 0 && (
              <div style={{display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8}}>
                {rows.map((r) => {
                  const cow = cattle.find((c) => c.id === r.cattle_id);
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
                      key={r.cattle_id}
                      data-batch-cow-row={r.cattle_id}
                      style={{
                        border: '1px solid #f3f4f6',
                        borderRadius: 6,
                        padding: '8px 10px',
                        fontSize: 12,
                      }}
                    >
                      <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4}}>
                        <span style={{fontWeight: 700, color: '#111827', minWidth: 50}}>
                          {'#' + (r.tag || cow?.tag || '?')}
                        </span>
                        <span style={{fontSize: 11, color: '#6b7280'}}>{cow?.breed || '—'}</span>
                        {y && <span style={{fontSize: 11, fontWeight: 600, color: '#065f46'}}>{y + '% yield'}</span>}
                        <span style={{flex: 1}} />
                        {canEdit && !isComplete && (
                          <button
                            onClick={() => handleDetach(cow || {id: r.cattle_id, tag: r.tag})}
                            title="Detach cow from batch (reverts herd)"
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
                            value={draftVal(r.cattle_id, 'live', r.live_weight)}
                            disabled={weightDisabled}
                            data-batch-live-weight={r.cattle_id}
                            onChange={(e) =>
                              setCowDraft((p) => ({...p, [draftKey(r.cattle_id, 'live')]: e.target.value}))
                            }
                            onBlur={(e) => {
                              saveCowWeight(r.cattle_id, 'live_weight', e.target.value);
                              setCowDraft((p) => {
                                const x = {...p};
                                delete x[draftKey(r.cattle_id, 'live')];
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
                            value={draftVal(r.cattle_id, 'hanging', r.hanging_weight)}
                            disabled={weightDisabled}
                            data-batch-hanging-weight={r.cattle_id}
                            onChange={(e) =>
                              setCowDraft((p) => ({...p, [draftKey(r.cattle_id, 'hanging')]: e.target.value}))
                            }
                            onBlur={(e) => {
                              saveCowWeight(r.cattle_id, 'hanging_weight', e.target.value);
                              setCowDraft((p) => {
                                const x = {...p};
                                delete x[draftKey(r.cattle_id, 'hanging')];
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
            )}
            {rows.length === 0 && !isScheduled && (
              <div style={{fontSize: 12, color: '#9ca3af', fontStyle: 'italic'}}>No cows attached yet.</div>
            )}
            {batch.notes && (
              <div style={{marginTop: 6, fontSize: 11, color: '#6b7280', fontStyle: 'italic'}}>{batch.notes}</div>
            )}
          </div>
        )}

        <RecordCollaborationSection
          sb={sb}
          authState={authState}
          entityType="cattle.processing"
          entityId={batch.id}
          entityLabel={entityLabel}
        />
      </RecordPageBody>
    </RecordPageFrame>
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
