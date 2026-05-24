// CattleBatchesView — four-section layout introduced with the
// Planned/Scheduled/Active/Processed workflow (mig 054). DB-stored batch
// statuses are now 'active', 'complete', and 'scheduled'. "Planned"
// batches remain virtual/computed by the shared Forecast helper. Once
// a planned batch is scheduled with the processor, a real DB row with
// status='scheduled' moves it into the Scheduled section.
//
// Sections (top→bottom):
//   - Planned                 — virtual, future months, dynamic forecast
//   - Scheduled               — DB rows status='scheduled', date booked
//                               with processor; cattle remain forecast-
//                               eligible until Send-to-Processor promotes
//                               this row to 'active'.
//   - Active                  — DB rows status='active', hanging-weight editor
//   - Processed               — UI label for DB rows status='complete'.
//                               Storage value stays 'complete' to keep
//                               existing RPC and JS comparisons stable.
//
// Active batches are CREATED either by:
//   1) Send-to-Processor promoting a matching scheduled row to 'active'.
//   2) Send-to-Processor inserting fresh when no matching scheduled row
//      exists.
// Scheduled batches do NOT update cattle.herd or
// cattle.processing_batch_id — that move happens only when Send-to-
// Processor flips a scheduled row to active and attaches the actually-
// sent cattle. Auto-flip from active→complete (and reopen back to
// active) is unchanged.
import React from 'react';
import UsersModal from '../auth/UsersModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ActivityPanel from '../shared/ActivityPanel.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ActivityModal from '../shared/ActivityModal.jsx';
import {loadCattleWeighInsCached, invalidateCattleWeighInsCache} from '../lib/cattleCache.js';
import {todayCentralISO} from '../lib/dateUtils.js';
import {detachCowFromBatch} from '../lib/cattleProcessingBatch.js';
import {
  buildForecast,
  batchHasAllHangingWeights,
  batchMissingHangingTags,
  validateRealBatchRename,
} from '../lib/cattleForecast.js';
import {
  loadForecastSettings,
  loadHeiferIncludes,
  loadHidden,
  markBatchComplete,
  reopenBatch,
} from '../lib/cattleForecastApi.js';

// Pick the best stored date when marking a batch complete:
// actual (already stamped by Send-to-Processor) → planned (scheduled
// booking) → today in Central. Returning null would leave the Processed
// section showing no date — hotfix for C-26-02/C-26-03 PROD regression.
function resolveProcessedDate(batch) {
  if (batch && batch.actual_process_date) return batch.actual_process_date;
  if (batch && batch.planned_process_date) return batch.planned_process_date;
  return todayCentralISO();
}

const CattleBatchesView = ({
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
  const {useState, useEffect, useMemo} = React;
  const role = authState && authState.role;
  const canEdit = role === 'admin' || role === 'management';

  const [batches, setBatches] = useState([]);
  const [cattle, setCattle] = useState([]);
  const [weighIns, setWeighIns] = useState([]);
  const [calvingRecs, setCalvingRecs] = useState([]);
  const [forecastSettings, setForecastSettings] = useState(null);
  const [heiferIncludes, setHeiferIncludes] = useState(new Set());
  const [hidden, setHidden] = useState([]);
  const [loading, setLoading] = useState(true);

  const [cowDraft, setCowDraft] = useState({});
  const [expandedBatchId, setExpandedBatchId] = useState(null);
  const [showPlanned, setShowPlanned] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [renameDraft, setRenameDraft] = useState({}); // batchId → string
  const [renameErr, setRenameErr] = useState({}); // batchId → reason
  // Local date drafts when scheduling a virtual batch (keyed by virtual
  // batch name) or editing a scheduled row's planned_process_date
  // (keyed by row id).
  const [scheduleDateDraft, setScheduleDateDraft] = useState({});
  const [scheduledDateDraft, setScheduledDateDraft] = useState({}); // scheduled row id → ISO date
  const [unschedulingBatchId, setUnschedulingBatchId] = useState(null);
  // Inline notice for the row-level actions in this view (auto-complete,
  // reopen, mark-complete, rename, detach, schedule/unschedule, date
  // update). Each action handler clears at entry and writes on error.
  const [notice, setNotice] = useState(null);
  const [activityTarget, setActivityTarget] = useState(null);

  React.useEffect(() => {
    function onEntityDeepLink() {
      const dl = window._wcfEntityDeepLink;
      if (!dl || dl.entityType !== 'cattle.processing') return;
      const b = batches.find((x) => x.id === dl.entityId);
      if (b) {
        window._wcfEntityDeepLink = null;
        setActivityTarget({entityType: 'cattle.processing', entityId: b.id, entityLabel: b.name});
      }
    }
    onEntityDeepLink();
    window.addEventListener('wcf-entity-deep-link', onEntityDeepLink);
    return () => window.removeEventListener('wcf-entity-deep-link', onEntityDeepLink);
  }, [batches]);

  async function loadAll() {
    const [bR, cR, wAll, calR, settings, inc, hid] = await Promise.all([
      sb.from('cattle_processing_batches').select('*').order('actual_process_date', {ascending: false}),
      sb.from('cattle').select('*'),
      loadCattleWeighInsCached(sb),
      sb.from('cattle_calving_records').select('*'),
      loadForecastSettings(sb),
      loadHeiferIncludes(sb),
      loadHidden(sb),
    ]);
    if (bR.data) {
      const byDate = (x) => x.actual_process_date || x.planned_process_date || x.created_at || '';
      setBatches(bR.data.slice().sort((a, b) => byDate(b).localeCompare(byDate(a))));
    }
    if (cR.data) setCattle(cR.data);
    setWeighIns(wAll || []);
    if (calR.data) setCalvingRecs(calR.data);
    setForecastSettings(settings);
    setHeiferIncludes(inc);
    setHidden(hid);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compute the forecast once with split realBatches / scheduledBatches.
  // Scheduled rows reserve their batch name + date but do NOT remove
  // cattle from forecast eligibility — animals stay dynamic until
  // Send-to-Processor promotes the scheduled row to active.
  const forecast = useMemo(() => {
    if (!forecastSettings) return null;
    const realBatchesOnly = batches.filter((b) => b.status === 'active' || b.status === 'complete');
    const scheduledBatchesOnly = batches.filter((b) => b.status === 'scheduled');
    return buildForecast({
      cattle,
      weighIns,
      settings: forecastSettings,
      includes: heiferIncludes,
      hidden,
      realBatches: realBatchesOnly,
      scheduledBatches: scheduledBatchesOnly,
      todayMs: Date.now(),
    });
  }, [cattle, weighIns, forecastSettings, heiferIncludes, hidden, batches]);

  // Virtual planned batches (next 12 months, excluding any already
  // scheduled — buildForecast handles that suppression).
  const virtualPlanned = useMemo(() => {
    if (!forecast) return [];
    const nowYm = new Date().toISOString().slice(0, 7);
    const limitMs = Date.now() + 365 * 86400000;
    const limitYm = new Date(limitMs).toISOString().slice(0, 7);
    return forecast.virtualBatches.filter((vb) => vb.monthKey >= nowYm && vb.monthKey <= limitYm);
  }, [forecast]);

  // Enriched scheduled batches, sorted chronologically by their
  // planned_process_date.
  const scheduledList = useMemo(() => {
    if (!forecast) return [];
    return forecast.scheduledBatches
      .slice()
      .sort((a, b) => (a.planned_process_date || '').localeCompare(b.planned_process_date || ''));
  }, [forecast]);

  function cowsDetailOf(b) {
    return Array.isArray(b.cows_detail) ? b.cows_detail : [];
  }
  function recomputeTotals(rows) {
    const live = rows.reduce((s, r) => s + (parseFloat(r.live_weight) || 0), 0);
    const hang = rows.reduce((s, r) => s + (parseFloat(r.hanging_weight) || 0), 0);
    return {
      total_live_weight: live > 0 ? Math.round(live * 10) / 10 : null,
      total_hanging_weight: hang > 0 ? Math.round(hang * 10) / 10 : null,
    };
  }
  async function saveCowWeight(batch, cattleId, field, value) {
    if (!canEdit) return;
    setNotice(null);
    const rows = cowsDetailOf(batch).map((r) =>
      r.cattle_id === cattleId ? {...r, [field]: value === '' || value == null ? null : parseFloat(value)} : r,
    );
    const totals = recomputeTotals(rows);
    await sb
      .from('cattle_processing_batches')
      .update({cows_detail: rows, ...totals})
      .eq('id', batch.id);
    const nextBatch = {...batch, cows_detail: rows, ...totals};
    setBatches((prev) => prev.map((b) => (b.id === batch.id ? nextBatch : b)));
    // Auto-flip to complete if every cow has hanging_weight > 0.
    if (field === 'hanging_weight' && nextBatch.status === 'active' && batchHasAllHangingWeights(nextBatch)) {
      const processedDate = resolveProcessedDate(nextBatch);
      try {
        await markBatchComplete(sb, batch.id, {processedDate});
        setBatches((prev) =>
          prev.map((b) =>
            b.id === batch.id ? {...nextBatch, status: 'complete', actual_process_date: processedDate} : b,
          ),
        );
      } catch (e) {
        setNotice({kind: 'error', message: 'Auto-complete failed: ' + (e.message || e)});
      }
    }
  }
  async function reopenComplete(batch) {
    if (!canEdit) return;
    setNotice(null);
    try {
      await reopenBatch(sb, batch.id);
      setBatches((prev) => prev.map((b) => (b.id === batch.id ? {...b, status: 'active'} : b)));
    } catch (e) {
      setNotice({kind: 'error', message: 'Reopen failed: ' + (e.message || e)});
    }
  }
  async function markCompleteClick(batch) {
    if (!canEdit) return;
    setNotice(null);
    if (!batchHasAllHangingWeights(batch)) {
      const missing = batchMissingHangingTags(batch);
      setNotice({
        kind: 'error',
        message:
          'Cannot mark complete — these tags are missing hanging weights:\n\n#' +
          missing.join('  #') +
          '\n\nEnter every cow’s hanging weight first.',
      });
      return;
    }
    const processedDate = resolveProcessedDate(batch);
    try {
      await markBatchComplete(sb, batch.id, {processedDate});
      setBatches((prev) =>
        prev.map((b) => (b.id === batch.id ? {...b, status: 'complete', actual_process_date: processedDate} : b)),
      );
    } catch (e) {
      setNotice({kind: 'error', message: 'Mark complete failed: ' + (e.message || e)});
    }
  }
  async function saveRename(batch) {
    if (!canEdit) return;
    setNotice(null);
    const proposed = (renameDraft[batch.id] || '').trim();
    if (!proposed || proposed === batch.name) {
      setRenameErr((p) => ({...p, [batch.id]: null}));
      setRenameDraft((p) => {
        const x = {...p};
        delete x[batch.id];
        return x;
      });
      return;
    }
    const v = validateRealBatchRename({proposedName: proposed, currentName: batch.name, realBatches: batches});
    if (!v.ok) {
      setRenameErr((p) => ({...p, [batch.id]: v.reason}));
      return;
    }
    const r = await sb.from('cattle_processing_batches').update({name: proposed}).eq('id', batch.id);
    if (r.error) {
      setRenameErr((p) => ({...p, [batch.id]: 'db_error'}));
      setNotice({kind: 'error', message: 'Rename failed: ' + r.error.message});
      return;
    }
    setBatches((prev) => prev.map((b) => (b.id === batch.id ? {...b, name: proposed} : b)));
    setRenameErr((p) => ({...p, [batch.id]: null}));
    setRenameDraft((p) => {
      const x = {...p};
      delete x[batch.id];
      return x;
    });
  }
  async function detachCowAndReport(batch, cow) {
    if (!canEdit) return;
    if (!cow || !cow.id) return;
    setNotice(null);
    const r = await detachCowFromBatch(sb, cow.id, batch.id, {
      teamMember: authState && authState.name ? authState.name : null,
    });
    if (!r.ok) {
      const tag = cow.tag || r.cow?.tag || '?';
      if (r.reason === 'no_prior_herd') {
        setNotice({
          kind: 'warning',
          message: 'Cannot auto-detach #' + tag + ': no prior herd recorded. Manually move via the Herds tab.',
        });
      } else {
        setNotice({
          kind: 'error',
          message: 'Detach failed for #' + tag + ': ' + r.reason + (r.error ? ' — ' + r.error : ''),
        });
      }
    }
    invalidateCattleWeighInsCache();
    await loadAll();
  }

  // ── Scheduled batch handlers (mig 054) ──────────────────────────────────
  // Inserting a scheduled row reserves the virtual batch's name + processor
  // date but never updates cattle.herd or cattle.processing_batch_id —
  // cattle stay forecast-eligible. Unschedule removes the row; the matching
  // virtual batch reappears under Planned on the next build.
  async function scheduleVirtualBatch(vb) {
    if (!canEdit) return;
    setNotice(null);
    const date = (scheduleDateDraft[vb.name] || '').trim();
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setNotice({kind: 'error', message: 'Pick a processor date (YYYY-MM-DD) before scheduling.'});
      return;
    }
    const rowId = 'cpb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const row = {
      id: rowId,
      name: vb.name,
      planned_process_date: date,
      status: 'scheduled',
      cows_detail: [],
      documents: [],
    };
    const r = await sb.from('cattle_processing_batches').insert(row).select().single();
    if (r.error) {
      setNotice({kind: 'error', message: 'Schedule failed: ' + r.error.message});
      return;
    }
    setBatches((prev) => [r.data, ...prev]);
    setScheduleDateDraft((prev) => {
      const x = {...prev};
      delete x[vb.name];
      return x;
    });
  }
  async function updateScheduledDate(batchId, nextDate) {
    if (!canEdit) return;
    if (!nextDate || !/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) return;
    const target = batches.find((b) => b.id === batchId);
    if (!target || target.status !== 'scheduled') return;
    setNotice(null);
    const r = await sb.from('cattle_processing_batches').update({planned_process_date: nextDate}).eq('id', batchId);
    if (r.error) {
      setNotice({kind: 'error', message: 'Date update failed: ' + r.error.message});
      return;
    }
    setBatches((prev) => prev.map((b) => (b.id === batchId ? {...b, planned_process_date: nextDate} : b)));
  }
  async function unscheduleBatch(batchId) {
    if (!canEdit) return;
    const target = batches.find((b) => b.id === batchId);
    // Defense in depth — only scheduled rows can be unscheduled. Active
    // or complete rows must never lose their cows_detail through this path.
    if (!target || target.status !== 'scheduled') {
      setUnschedulingBatchId(null);
      return;
    }
    setNotice(null);
    const r = await sb.from('cattle_processing_batches').delete().eq('id', batchId);
    if (r.error) {
      setNotice({kind: 'error', message: 'Unschedule failed: ' + r.error.message});
      return;
    }
    setBatches((prev) => prev.filter((b) => b.id !== batchId));
    setUnschedulingBatchId(null);
  }

  const active = batches.filter((b) => b.status === 'active');
  const completed = batches.filter((b) => b.status === 'complete');

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
        <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12}}>
          <div style={{fontSize: 16, fontWeight: 700, color: '#111827'}} data-cattle-batches-root>
            Processing Batches{' '}
            <span style={{fontSize: 13, fontWeight: 400, color: '#6b7280'}}>
              {scheduledList.length} scheduled · {active.length} active · {completed.length} processed
            </span>
          </div>
          {!canEdit && (
            <span
              style={{
                fontSize: 11,
                padding: '3px 8px',
                background: '#eff6ff',
                border: '1px solid #bfdbfe',
                borderRadius: 6,
                color: '#1e40af',
                fontWeight: 600,
              }}
            >
              READ-ONLY
            </span>
          )}
        </div>

        {loading && <div style={{textAlign: 'center', padding: '2rem', color: '#9ca3af'}}>Loading{'…'}</div>}

        {/* Show Planned Batches (virtual, top, collapsed) */}
        {!loading && (
          <CollapsibleSection
            label="Show Planned Batches"
            count={virtualPlanned.length}
            expanded={showPlanned}
            onToggle={() => setShowPlanned((v) => !v)}
            color="#fef2f2"
            border="#fca5a5"
            text="#991b1b"
            dataKey="planned"
          >
            {virtualPlanned.length === 0 ? (
              <div style={{padding: '0.75rem', color: '#9ca3af', fontSize: 12, fontStyle: 'italic'}}>
                No planned batches in the next 12 months — the forecast has no eligible cattle landing in the display
                window.
              </div>
            ) : (
              <div style={{display: 'flex', flexDirection: 'column', gap: 6, padding: '0.5rem 0.75rem'}}>
                {virtualPlanned.map((vb) => (
                  <div
                    key={vb.name}
                    data-virtual-batch={vb.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      flexWrap: 'wrap',
                      padding: '8px 10px',
                      background: 'white',
                      border: '1px dashed #fca5a5',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  >
                    <strong style={{color: '#991b1b'}}>{vb.name}</strong>
                    <span style={{color: '#6b7280'}}>{vb.label}</span>
                    <span
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        background: '#fef2f2',
                        color: '#991b1b',
                        border: '1px solid #fca5a5',
                        borderRadius: 4,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                      }}
                    >
                      Planned
                    </span>
                    <span style={{color: '#6b7280'}}>
                      {vb.animalIds.length} {vb.animalIds.length === 1 ? 'cow' : 'cows'}
                    </span>
                    {vb.projectedTotalLbs > 0 && (
                      <span style={{color: '#065f46', fontWeight: 600}}>
                        {Math.round(vb.projectedTotalLbs).toLocaleString()} lb projected
                      </span>
                    )}
                    <span style={{flex: 1}} />
                    {canEdit ? (
                      <span style={{display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap'}}>
                        <input
                          data-virtual-batch-schedule-date={vb.name}
                          type="date"
                          value={scheduleDateDraft[vb.name] || ''}
                          onChange={(e) => setScheduleDateDraft((prev) => ({...prev, [vb.name]: e.target.value}))}
                          style={{
                            fontSize: 11,
                            padding: '3px 6px',
                            border: '1px solid #d1d5db',
                            borderRadius: 5,
                            fontFamily: 'inherit',
                          }}
                          title="Processor date for this batch"
                        />
                        <button
                          data-virtual-batch-schedule={vb.name}
                          onClick={() => scheduleVirtualBatch(vb)}
                          disabled={!scheduleDateDraft[vb.name]}
                          style={{
                            fontSize: 11,
                            padding: '4px 10px',
                            borderRadius: 5,
                            border: 'none',
                            background: scheduleDateDraft[vb.name] ? '#085041' : '#9ca3af',
                            color: 'white',
                            cursor: scheduleDateDraft[vb.name] ? 'pointer' : 'not-allowed',
                            fontFamily: 'inherit',
                            fontWeight: 600,
                          }}
                        >
                          Schedule
                        </button>
                      </span>
                    ) : (
                      <span style={{fontSize: 11, color: '#9ca3af', fontStyle: 'italic'}}>
                        Created when sent to processor at WeighIns
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CollapsibleSection>
        )}

        {/* Scheduled batches — date booked with processor, cattle remain
            forecast-eligible until Send-to-Processor promotes the row. */}
        {!loading && scheduledList.length > 0 && (
          <div style={{marginTop: 12}} data-scheduled-section>
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: '#92400e',
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                marginBottom: 8,
              }}
            >
              Scheduled ({scheduledList.length})
            </div>
            <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
              {scheduledList.map((sb2) => {
                const isUnsched = unschedulingBatchId === sb2.id;
                const dateValue =
                  scheduledDateDraft[sb2.id] != null ? scheduledDateDraft[sb2.id] : sb2.planned_process_date || '';
                return (
                  <div
                    key={sb2.id}
                    data-scheduled-batch={sb2.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      flexWrap: 'wrap',
                      padding: '8px 10px',
                      background: 'white',
                      border: '1px solid #fde68a',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  >
                    <strong style={{color: '#92400e'}}>{sb2.name}</strong>
                    <span
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        background: '#fffbeb',
                        color: '#92400e',
                        border: '1px solid #fde68a',
                        borderRadius: 4,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                      }}
                    >
                      Scheduled
                    </span>
                    <span style={{color: '#6b7280'}}>
                      {sb2.animalIds.length} {sb2.animalIds.length === 1 ? 'cow' : 'cows'} forecast
                    </span>
                    {sb2.projectedTotalLbs > 0 && (
                      <span style={{color: '#065f46', fontWeight: 600}}>
                        {Math.round(sb2.projectedTotalLbs).toLocaleString()} lb projected
                      </span>
                    )}
                    {canEdit ? (
                      <span style={{display: 'inline-flex', alignItems: 'center', gap: 6}}>
                        <input
                          data-scheduled-batch-date={sb2.name}
                          type="date"
                          value={dateValue}
                          onChange={(e) => setScheduledDateDraft((prev) => ({...prev, [sb2.id]: e.target.value}))}
                          onBlur={(e) => {
                            const next = e.target.value;
                            if (next && next !== sb2.planned_process_date) updateScheduledDate(sb2.id, next);
                          }}
                          style={{
                            fontSize: 11,
                            padding: '3px 6px',
                            border: '1px solid #d1d5db',
                            borderRadius: 5,
                            fontFamily: 'inherit',
                          }}
                          title="Processor date (saves on blur)"
                        />
                      </span>
                    ) : (
                      <span style={{color: '#6b7280'}}>
                        {sb2.planned_process_date ? fmt(sb2.planned_process_date) : '—'}
                      </span>
                    )}
                    <span style={{flex: 1}} />
                    <span style={{fontSize: 11, color: '#9ca3af', fontStyle: 'italic'}}>
                      Cattle remain forecast-backed until sent from WeighIns
                    </span>
                    {canEdit && !isUnsched && (
                      <button
                        data-scheduled-batch-unschedule={sb2.name}
                        onClick={() => setUnschedulingBatchId(sb2.id)}
                        style={{
                          fontSize: 11,
                          padding: '3px 10px',
                          borderRadius: 5,
                          border: '1px solid #fde68a',
                          background: 'white',
                          color: '#92400e',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                        title="Remove the scheduled date booking (cattle keep their herd)"
                      >
                        Unschedule
                      </button>
                    )}
                    {canEdit && isUnsched && (
                      <span
                        data-scheduled-batch-unschedule-warning={sb2.name}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          flexBasis: '100%',
                          padding: '6px 8px',
                          background: '#fef3c7',
                          border: '1px solid #fde68a',
                          borderRadius: 6,
                          color: '#78350f',
                          fontSize: 11,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{flex: '1 1 100%'}}>
                          Unscheduling will remove this date booking. Cattle stay in their herds and reappear under
                          Planned. Only do this if you have rescheduled or cancelled with the processor.
                        </span>
                        <button
                          data-scheduled-batch-unschedule-cancel={sb2.name}
                          onClick={() => setUnschedulingBatchId(null)}
                          style={{
                            fontSize: 11,
                            padding: '3px 10px',
                            borderRadius: 5,
                            border: '1px solid #d1d5db',
                            background: 'white',
                            color: '#4b5563',
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          data-scheduled-batch-unschedule-confirm={sb2.name}
                          onClick={() => unscheduleBatch(sb2.id)}
                          style={{
                            fontSize: 11,
                            padding: '3px 10px',
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
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Active batches (default visible, middle) */}
        {!loading && (
          <div style={{marginTop: 12}}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: '#1d4ed8',
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                marginBottom: 8,
              }}
            >
              Active ({active.length})
            </div>
            {active.length === 0 ? (
              <div
                style={{
                  background: 'white',
                  border: '1px solid #e5e7eb',
                  borderRadius: 12,
                  padding: '1.25rem',
                  textAlign: 'center',
                  color: '#6b7280',
                  fontSize: 13,
                }}
              >
                No active batches. Cattle enter an active batch only via the Send-to-Processor flag on a finishers
                weigh-in session.
              </div>
            ) : (
              <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
                {active.map((b) => (
                  <BatchTile
                    key={b.id}
                    batch={b}
                    cattle={cattle}
                    cowDraft={cowDraft}
                    setCowDraft={setCowDraft}
                    saveCowWeight={saveCowWeight}
                    detach={detachCowAndReport}
                    onMarkComplete={() => markCompleteClick(b)}
                    onReopen={() => reopenComplete(b)}
                    canEdit={canEdit}
                    expanded={expandedBatchId === b.id}
                    onToggle={() => setExpandedBatchId(expandedBatchId === b.id ? null : b.id)}
                    fmt={fmt}
                    renameDraft={renameDraft}
                    setRenameDraft={setRenameDraft}
                    renameErr={renameErr[b.id]}
                    onSaveRename={() => saveRename(b)}
                    sb={sb}
                    authState={authState}
                    onActivityClick={setActivityTarget}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Processed batches (collapsed, bottom). UI label is "Processed";
            DB storage value stays 'complete' to keep RPC + JS comparisons
            stable. */}
        {!loading && (
          <div style={{marginTop: 14}}>
            <CollapsibleSection
              label="Show Processed Batches"
              count={completed.length}
              expanded={showCompleted}
              onToggle={() => setShowCompleted((v) => !v)}
              color="#f3f4f6"
              border="#d1d5db"
              text="#374151"
              dataKey="processed"
            >
              {completed.length === 0 ? (
                <div style={{padding: '0.75rem', color: '#9ca3af', fontSize: 12, fontStyle: 'italic'}}>
                  No processed batches yet.
                </div>
              ) : (
                <div style={{display: 'flex', flexDirection: 'column', gap: 10, padding: '0.5rem 0'}}>
                  {completed.map((b) => (
                    <BatchTile
                      key={b.id}
                      batch={b}
                      cattle={cattle}
                      cowDraft={cowDraft}
                      setCowDraft={setCowDraft}
                      saveCowWeight={saveCowWeight}
                      detach={detachCowAndReport}
                      onMarkComplete={() => markCompleteClick(b)}
                      onReopen={() => reopenComplete(b)}
                      canEdit={canEdit}
                      expanded={expandedBatchId === b.id}
                      onToggle={() => setExpandedBatchId(expandedBatchId === b.id ? null : b.id)}
                      fmt={fmt}
                      renameDraft={renameDraft}
                      setRenameDraft={setRenameDraft}
                      renameErr={renameErr[b.id]}
                      onSaveRename={() => saveRename(b)}
                      sb={sb}
                      authState={authState}
                      onActivityClick={setActivityTarget}
                    />
                  ))}
                </div>
              )}
            </CollapsibleSection>
          </div>
        )}
      </div>
      {React.createElement(ActivityModal, {
        sb,
        authState,
        target: activityTarget,
        onClose: () => setActivityTarget(null),
      })}
    </div>
  );
};

function CollapsibleSection({label, count, expanded, onToggle, color, border, text, children, dataKey}) {
  return (
    <div
      style={{
        background: 'white',
        border: '1px solid #e5e7eb',
        borderRadius: 12,
        overflow: 'hidden',
        marginBottom: 0,
      }}
      data-batches-section={dataKey}
    >
      <div
        onClick={onToggle}
        style={{
          padding: '12px 16px',
          background: color,
          borderBottom: expanded ? '1px solid ' + border : 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          cursor: 'pointer',
        }}
      >
        <span style={{fontSize: 12, color: text}}>{expanded ? '▼' : '▶'}</span>
        <span style={{fontSize: 13, fontWeight: 700, color: text}}>{label}</span>
        <span style={{fontSize: 11, color: text, opacity: 0.7}}>({count})</span>
      </div>
      {expanded && children}
    </div>
  );
}

function BatchTile({
  batch,
  cattle,
  cowDraft,
  setCowDraft,
  saveCowWeight,
  detach,
  onMarkComplete,
  onReopen,
  canEdit,
  expanded,
  onToggle,
  fmt,
  renameDraft,
  setRenameDraft,
  renameErr,
  onSaveRename,
  sb,
  authState,
  onActivityClick,
}) {
  const rows = Array.isArray(batch.cows_detail) ? batch.cows_detail : [];
  const totalLive = rows.reduce((s, r) => s + (parseFloat(r.live_weight) || 0), 0);
  const totalHang = rows.reduce((s, r) => s + (parseFloat(r.hanging_weight) || 0), 0);
  const yieldPct = totalLive > 0 && totalHang > 0 ? Math.round((totalHang / totalLive) * 1000) / 10 : null;
  const isComplete = batch.status === 'complete';
  const draftKey = (cid, field) => `${batch.id}|${cid}|${field}`;
  const draftVal = (cid, field, curr) => {
    const k = draftKey(cid, field);
    return cowDraft[k] != null ? cowDraft[k] : curr != null ? String(curr) : '';
  };
  return (
    <div
      style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden'}}
      data-batch-row={batch.id}
      data-batch-name={batch.name}
      data-batch-status={batch.status}
    >
      <div
        onClick={onToggle}
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
        <span style={{fontSize: 11, color: '#9ca3af'}}>{expanded ? '▼' : '▶'}</span>
        <span style={{fontSize: 14, fontWeight: 700, color: '#111827'}}>{batch.name}</span>
        {sb &&
          React.createElement(
            'span',
            {onClick: (e) => e.stopPropagation(), 'data-activity-surface': 'cattle.processing'},
            React.createElement(ActivityPanel, {
              sb,
              authState,
              entityType: 'cattle.processing',
              entityId: batch.id,
              entityLabel: batch.name,
              mode: 'compact',
              onCompactClick: onActivityClick,
            }),
          )}
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 10,
            background: isComplete ? '#374151' : '#1d4ed8',
            color: 'white',
            textTransform: 'uppercase',
          }}
        >
          {batch.status}
        </span>
        <span style={{fontSize: 11, color: '#6b7280'}}>
          {rows.length} {rows.length === 1 ? 'cow' : 'cows'}
        </span>
        {isComplete
          ? (batch.actual_process_date || batch.planned_process_date) && (
              <span style={{fontSize: 11, color: '#065f46'}}>
                processed {fmt(batch.actual_process_date || batch.planned_process_date)}
              </span>
            )
          : batch.actual_process_date && (
              <span style={{fontSize: 11, color: '#065f46'}}>processed {fmt(batch.actual_process_date)}</span>
            )}
        {yieldPct && <span style={{fontSize: 11, fontWeight: 600, color: '#065f46'}}>{yieldPct + '% yield'}</span>}
      </div>
      {expanded && (
        <div style={{borderTop: '1px solid #f3f4f6', padding: '14px 18px', background: '#fafafa'}}>
          {/* Rename + Mark complete / Reopen controls (management/admin only) */}
          {canEdit && (
            <div style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10}}>
              <label style={{fontSize: 11, color: '#6b7280', fontWeight: 600}}>Name:</label>
              <input
                type="text"
                value={renameDraft[batch.id] != null ? renameDraft[batch.id] : batch.name}
                onChange={(e) => setRenameDraft((p) => ({...p, [batch.id]: e.target.value}))}
                data-rename-input={batch.id}
                style={{
                  fontSize: 13,
                  padding: '5px 9px',
                  border: '1px solid #d1d5db',
                  borderRadius: 5,
                  fontFamily: 'inherit',
                  width: 130,
                }}
              />
              <button
                onClick={onSaveRename}
                data-save-rename={batch.id}
                style={{
                  fontSize: 11,
                  padding: '5px 11px',
                  borderRadius: 5,
                  border: '1px solid #d1d5db',
                  background: 'white',
                  color: '#374151',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 600,
                }}
              >
                Save name
              </button>
              {renameErr && (
                <span style={{fontSize: 11, color: '#b91c1c'}} data-rename-err={batch.id}>
                  {renameErr === 'format' && 'Use C-YY-NN'}
                  {renameErr === 'duplicate' && 'Name already used'}
                  {renameErr === 'sequence_gap' && 'Would skip a sequence number'}
                  {renameErr === 'new_year_must_start_at_01' && 'New year must start at 01'}
                  {renameErr === 'db_error' && 'Save error'}
                </span>
              )}
              <span style={{flex: 1}} />
              {!isComplete ? (
                <button
                  onClick={onMarkComplete}
                  data-mark-complete={batch.id}
                  style={{
                    fontSize: 12,
                    padding: '6px 14px',
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
                  onClick={onReopen}
                  data-reopen={batch.id}
                  style={{
                    fontSize: 12,
                    padding: '6px 14px',
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
          {/* Stat row */}
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
                const cow = cattle.find((c) => c.id === r.cattle_id);
                const lv = parseFloat(r.live_weight);
                const hw = parseFloat(r.hanging_weight);
                const y = lv > 0 && hw > 0 ? Math.round((hw / lv) * 1000) / 10 : null;
                return (
                  <div
                    key={r.cattle_id}
                    data-batch-cow-row={r.cattle_id}
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
                    <div style={{fontWeight: 700, color: '#111827'}}>{'#' + (r.tag || cow?.tag || '?')}</div>
                    <div style={{fontSize: 11, color: '#6b7280'}}>{cow?.breed || '—'}</div>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      placeholder={'—'}
                      value={draftVal(r.cattle_id, 'live', r.live_weight)}
                      disabled={!canEdit}
                      data-batch-live-weight={r.cattle_id}
                      onChange={(e) => setCowDraft((p) => ({...p, [draftKey(r.cattle_id, 'live')]: e.target.value}))}
                      onBlur={(e) => {
                        saveCowWeight(batch, r.cattle_id, 'live_weight', e.target.value);
                        setCowDraft((p) => {
                          const x = {...p};
                          delete x[draftKey(r.cattle_id, 'live')];
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
                        background: canEdit ? 'white' : '#f9fafb',
                      }}
                    />
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      placeholder={'—'}
                      value={draftVal(r.cattle_id, 'hanging', r.hanging_weight)}
                      disabled={!canEdit}
                      data-batch-hanging-weight={r.cattle_id}
                      onChange={(e) => setCowDraft((p) => ({...p, [draftKey(r.cattle_id, 'hanging')]: e.target.value}))}
                      onBlur={(e) => {
                        saveCowWeight(batch, r.cattle_id, 'hanging_weight', e.target.value);
                        setCowDraft((p) => {
                          const x = {...p};
                          delete x[draftKey(r.cattle_id, 'hanging')];
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
                        background: canEdit ? 'white' : '#f9fafb',
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
                    {canEdit ? (
                      <button
                        onClick={() => detach(batch, cow || {id: r.cattle_id, tag: r.tag})}
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
                        {'×'}
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {batch.notes && (
            <div style={{marginTop: 6, fontSize: 11, color: '#6b7280', fontStyle: 'italic'}}>{batch.notes}</div>
          )}
        </div>
      )}
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

export default CattleBatchesView;
