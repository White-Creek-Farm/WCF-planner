// ============================================================================
// src/broiler/BatchForm.jsx  —  Phase 2 Round 6 tail
// ----------------------------------------------------------------------------
// The broiler add/edit modal. The last inline block that lived inside App's
// render body (`if(showForm) return ( ... )`). Hook-based extraction: reads
// auth + batches + dailysRecent + feedCosts from their contexts; every
// operational helper (upd/closeForm/submit/del/openEdit/parseProcessorXlsx/
// confirmDelete/persist) still lives in App and arrives as a prop. Nothing
// in the JSX body changes — derived values (tl, targetHatch, etc.) that
// used to live at App scope are recomputed here since this is the only
// consumer.
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {fmt, toISO, addDays} from '../lib/dateUtils.js';
import {S} from '../lib/styles.js';
import {recordControl, recordTextarea, recordFieldLabel, recordCheckbox} from '../shared/recordPageControls.jsx';
import {
  BROODERS,
  SCHOONERS,
  BROODER_CLEANOUT,
  SCHOONER_CLEANOUT,
  STATUSES,
  ALL_HATCHERIES,
  LEGACY_HATCHERIES,
  LEGACY_BREEDS,
  isNearHoliday,
  calcTargetHatch,
  suggestHatchDates,
  calcTimeline,
  calcBroilerStatsFromDailys,
} from '../lib/broiler.js';
import UsersModal from '../auth/UsersModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {useBatches} from '../contexts/BatchesContext.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';
import {useFeedCosts} from '../contexts/FeedCostsContext.jsx';

const weighInSourcedValueBox = {
  ...recordControl,
  background: '#f9fafb',
  borderColor: '#e5e7eb',
  color: '#374151',
  fontWeight: 600,
  display: 'flex',
  alignItems: 'center',
};

const weighInSourcedHint = {fontSize: 11, color: '#9ca3af', marginTop: 3};

function broilerWeekWeightLabel(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 'Not recorded';
  return Math.round(parsed * 100) / 100 + ' lbs';
}

export default function BatchForm({
  Header,
  loadUsers,
  upd,
  closeForm,
  submit,
  del,
  openEdit,
  parseProcessorXlsx,
  confirmDelete,
  persist,
  // Optional close override for record-page mode. When provided, the close
  // handlers route through this instead of the closeForm+setShowForm dance —
  // keeps the URL the source of truth on BroilerBatchPage. Prev/Next is owned
  // by the shared RecordSequenceNav on the record page, not BatchForm.
  onClose,
  // When true, parent (BroilerBatchPage) already renders Header and supplies
  // its own page chrome; BatchForm skips its own Header render and drops the
  // semi-transparent modal-overlay background so the form sits flush in the
  // record-page layout.
  embedded = false,
}) {
  const {authState, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const {
    batches,
    setBatches,
    editId,
    form,
    setForm,
    conflicts,
    showLegacy,
    setShowLegacy,
    parsedProcessor,
    setParsedProcessor,
    docUploading,
    setDocUploading,
    formNotice,
    setFormNotice,
  } = useBatches();
  const {broilerDailys} = useDailysRecent();
  const {feedCosts} = useFeedCosts();

  // Derived values (were at App scope; only this component consumed them).
  const tl = calcTimeline(form.hatchDate, form.breed, form.processingDate);
  const targetHatch = calcTargetHatch(form.processingDate, form.breed);
  const hatchSuggestions = suggestHatchDates(targetHatch);
  const hatchWarn = isNearHoliday(form.hatchDate);
  const procWarn = form.processingDate && isNearHoliday(form.processingDate);
  // Legacy hatcheries appended only when admin toggles "Show legacy" on a
  // processed batch.
  const hatcheries =
    form.status === 'processed' && showLegacy ? [...ALL_HATCHERIES, '__SEP__', ...LEGACY_HATCHERIES] : ALL_HATCHERIES;

  return (
    <div>
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
      {!embedded && <Header />}
      <div
        style={{
          background: embedded ? 'transparent' : 'rgba(0,0,0,.45)',
          minHeight: embedded ? 'auto' : '100vh',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          padding: embedded ? '0' : '1.5rem 1rem',
        }}
        className="no-print"
      >
        <div
          style={{
            background: 'white',
            borderRadius: 12,
            width: '100%',
            maxWidth: 806,
            border: '1px solid #e5e7eb',
            marginBottom: '2rem',
          }}
        >
          {/* Sticky header: title + batch name + close */}
          <div
            style={{
              padding: '12px 20px',
              borderBottom: '1px solid #e5e7eb',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              position: 'sticky',
              top: 0,
              background: 'white',
              zIndex: 10,
              boxShadow: '0 1px 4px rgba(0,0,0,.06)',
            }}
          >
            <div style={{display: 'flex', alignItems: 'center', gap: 10, minWidth: 0}}>
              <div style={{fontSize: 13, fontWeight: 500, color: '#9ca3af', flexShrink: 0}}>
                {editId ? 'Edit Batch' : 'Add New Batch'}
              </div>
              {form.name && (
                <div
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: '#085041',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {form.name}
                </div>
              )}
            </div>
            <button
              onClick={() => {
                if (typeof onClose === 'function') onClose();
                else closeForm();
              }}
              style={{
                background: 'none',
                border: 'none',
                fontSize: 22,
                cursor: 'pointer',
                color: '#999',
                lineHeight: 1,
                flexShrink: 0,
              }}
            >
              ×
            </button>
          </div>

          <div style={{padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12}}>
            {/* Conflict alert — only shown while the batch can still be
                rescheduled. Once a batch is processed the scheduling is
                history and the warning has nothing actionable to do. */}
            {conflicts.length > 0 &&
              form.status !== 'processed' &&
              (() => {
                const hard = conflicts.filter((c) => !c.soft);
                const soft = conflicts.filter((c) => c.soft);
                const hasHard = hard.length > 0;
                return (
                  <div
                    style={{
                      background: hasHard ? '#fef2f2' : '#fffbeb',
                      border: '1px solid ' + (hasHard ? '#F09595' : '#fde68a'),
                      borderRadius: 10,
                      padding: '10px 14px',
                    }}
                  >
                    {hasHard && (
                      <>
                        <div style={{color: '#791F1F', fontWeight: 600, fontSize: 13, marginBottom: 4}}>
                          {'\u26a0 Scheduling conflict detected:'}
                        </div>
                        {hard.map((c, i) => (
                          <div key={'h' + i} style={{color: '#b91c1c', fontSize: 12, marginTop: 3}}>
                            {'\u2022 ' + c.message}
                          </div>
                        ))}
                      </>
                    )}
                    {soft.length > 0 && (
                      <div
                        style={{
                          marginTop: hasHard ? 10 : 0,
                          paddingTop: hasHard ? 10 : 0,
                          borderTop: hasHard ? '1px solid #F09595' : 'none',
                        }}
                      >
                        <div style={{color: '#92400e', fontWeight: 600, fontSize: 13, marginBottom: 4}}>
                          {'\u26a0 Layer batch overlap (soft warning, save will go through):'}
                        </div>
                        {soft.map((c, i) => (
                          <div key={'s' + i} style={{color: '#92400e', fontSize: 12, marginTop: 3}}>
                            {'\u2022 ' + c.message}
                          </div>
                        ))}
                      </div>
                    )}
                    {hasHard && (
                      <div
                        style={{
                          marginTop: 10,
                          paddingTop: 10,
                          borderTop: '1px solid #F09595',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          flexWrap: 'wrap',
                        }}
                      >
                        <div style={{fontSize: 12, color: '#791F1F', flex: 1}}>
                          You can override and save anyway if you know what you're doing (e.g. staggered timing, special
                          arrangement).
                        </div>
                        <button
                          onClick={() => submit(true)}
                          style={{
                            padding: '6px 14px',
                            borderRadius: 8,
                            border: 'none',
                            background: '#A32D2D',
                            color: 'white',
                            fontWeight: 600,
                            fontSize: 12,
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          Override &amp; Save Anyway
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}
            {/* Step 1 — Processing date + hatch suggestions */}
            <div style={{background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 10, padding: '10px 14px'}}>
              <div style={{color: '#083d30', fontWeight: 600, fontSize: 12, marginBottom: 8}}>
                Step 1 — Enter your target processing date
              </div>
              <div
                data-mobile-1col="1"
                style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 8}}
              >
                <div>
                  <label style={{...recordFieldLabel, color: '#085041'}}>Breed</label>
                  <select style={recordControl} value={form.breed} onChange={(e) => upd('breed', e.target.value)}>
                    <option value="CC">Cornish Cross {'\u2014'} 7 weeks</option>
                    <option value="WR">White Ranger {'\u2014'} 8 weeks</option>
                    {form.status === 'processed' && showLegacy && (
                      <>
                        <option disabled value="__sep__">
                          {'\u2500\u2500\u2500 Legacy \u2500\u2500\u2500'}
                        </option>
                        {LEGACY_BREEDS.map((lb) => (
                          <option key={lb.code} value={lb.code}>
                            {lb.label} (legacy)
                          </option>
                        ))}
                      </>
                    )}
                  </select>
                  {form.status === 'processed' && (
                    <button
                      type="button"
                      onClick={() => setShowLegacy((s) => !s)}
                      style={{
                        marginTop: 5,
                        padding: '3px 9px',
                        borderRadius: 5,
                        border: '1px solid ' + (showLegacy ? '#92400e' : '#d1d5db'),
                        background: showLegacy ? '#fffbeb' : 'white',
                        color: showLegacy ? '#92400e' : '#6b7280',
                        fontSize: 10,
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      {showLegacy ? '\u2713 Showing legacy options' : '+ Show legacy options'}
                    </button>
                  )}
                </div>
                <div>
                  <label style={{...recordFieldLabel, color: '#085041'}}>Processing date</label>
                  <input
                    style={recordControl}
                    type="date"
                    value={form.processingDate}
                    onChange={(e) => upd('processingDate', e.target.value)}
                  />
                  {procWarn && (
                    <div style={{fontSize: 11, color: '#92400e', marginTop: 3}}>
                      {'\u26a0 Within 1 day of a major holiday'}
                    </div>
                  )}
                </div>
              </div>

              {/* Hatch suggestions — hidden once a hatch date is locked in. */}
              {targetHatch && !form.hatchDate && (
                <div style={{borderTop: '1px solid #97C459', paddingTop: 8}}>
                  <div style={{fontSize: 11, color: '#085041', marginBottom: 5, fontWeight: 600}}>
                    Suggested hatch dates to check with hatchery (target: {fmt(targetHatch)}):
                  </div>
                  <div style={{display: 'flex', gap: 5, flexWrap: 'wrap'}}>
                    {hatchSuggestions.map((s) => (
                      <button
                        key={s.iso}
                        onClick={() => upd('hatchDate', s.iso)}
                        style={{
                          padding: '4px 10px',
                          borderRadius: 5,
                          fontSize: 11,
                          cursor: 'pointer',
                          fontWeight: 500,
                          border: '1px solid #085041',
                          background: form.hatchDate === s.iso ? '#085041' : s.offset === 0 ? '#1D9E75' : '#EAF3DE',
                          color: form.hatchDate === s.iso ? 'white' : s.offset === 0 ? 'white' : '#3B6D11',
                        }}
                      >
                        {s.day} {s.label}
                        {s.offset === 0
                          ? ' (exact)'
                          : s.offset < 0
                            ? ` (${Math.abs(s.offset)}d early)`
                            : ` (${s.offset}d late)`}
                      </button>
                    ))}
                  </div>
                  <div style={{fontSize: 11, color: '#5a8a3a', marginTop: 5}}>
                    Click a date or type one below once confirmed with hatchery
                  </div>
                </div>
              )}
            </div>
            {/* Step 2 — Hatch date confirmed + full timeline */}
            <div style={{background: '#f0f7ff', border: '1px solid #B5D4F4', borderRadius: 10, padding: '10px 14px'}}>
              <div style={{color: '#1d4ed8', fontWeight: 600, fontSize: 12, marginBottom: 8}}>
                Step 2 — Confirm hatch date with hatchery
              </div>
              <div>
                <label style={{...recordFieldLabel, color: '#1d4ed8'}}>Confirmed hatch date</label>
                <input
                  style={recordControl}
                  type="date"
                  value={form.hatchDate}
                  onChange={(e) => upd('hatchDate', e.target.value)}
                />
                {hatchWarn && (
                  <div style={{fontSize: 11, color: '#92400e', marginTop: 3}}>⚠ Within 1 day of a major holiday</div>
                )}
              </div>
              {tl && (
                <div
                  data-mobile-1col="1"
                  style={{
                    marginTop: 8,
                    borderTop: '1px solid #B5D4F4',
                    paddingTop: 8,
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '3px 12px',
                    fontSize: 12,
                    color: '#1d4ed8',
                  }}
                >
                  <div>
                    Brooder in: <strong>{fmt(tl.brooderIn)}</strong>
                  </div>
                  <div>
                    Brooder out: <strong>{fmt(tl.brooderOut)}</strong>
                    <span style={{opacity: 0.6}}> +{BROODER_CLEANOUT}d</span>
                  </div>
                  <div>
                    Schooner in: <strong>{fmt(tl.schoonerIn)}</strong>
                  </div>
                  <div>
                    Schooner out: <strong>{fmt(tl.schoonerOut)}</strong>
                    <span style={{opacity: 0.6}}> +{SCHOONER_CLEANOUT}d</span>
                  </div>
                </div>
              )}
            </div>
            {/* Batch details */}
            <div>
              <label style={recordFieldLabel}>Batch name</label>
              <input
                style={recordControl}
                value={form.name}
                onChange={(e) => upd('name', e.target.value)}
                placeholder="e.g. 26-01 CC BROILERS"
              />
            </div>
            <div data-mobile-1col="1" style={S.fieldGroup}>
              <div>
                <label style={recordFieldLabel}>Hatchery</label>
                <select style={recordControl} value={form.hatchery} onChange={(e) => upd('hatchery', e.target.value)}>
                  {hatcheries.map((h) =>
                    h === '__SEP__' ? (
                      <option key="sep" disabled value="__sep__">
                        {'\u2500\u2500\u2500 Legacy \u2500\u2500\u2500'}
                      </option>
                    ) : (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ),
                  )}
                </select>
              </div>
              <div>
                <label style={recordFieldLabel}>Birds ordered</label>
                <input
                  style={recordControl}
                  type="number"
                  value={form.birdCount || ''}
                  onChange={(e) => upd('birdCount', e.target.value)}
                />
                <div style={{fontSize: 11, color: '#9ca3af', marginTop: 3}}>Standard 750 · Schooner 1 solo: 650</div>
              </div>
              <div>
                <label style={recordFieldLabel}>Birds arrived</label>
                <input
                  style={recordControl}
                  type="number"
                  value={form.birdCountActual || ''}
                  onChange={(e) => upd('birdCountActual', e.target.value)}
                  placeholder="Enter actual count"
                />
                <div style={{fontSize: 11, color: '#9ca3af', marginTop: 3}}>
                  Actual day-1 count after hatchery overship. Enter manually — never auto-fills from ordered.
                </div>
              </div>
              <div>
                <label style={recordFieldLabel}>Chick purchase cost ($)</label>
                <input
                  style={recordControl}
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.chickCost || ''}
                  onChange={(e) => upd('chickCost', e.target.value)}
                  placeholder="Total paid to hatchery"
                />
                <div style={{fontSize: 11, color: '#9ca3af', marginTop: 3}}>
                  Total paid to the hatchery for this batch's chicks. Rolls into Total Cost.
                </div>
              </div>

              <div>
                <label style={recordFieldLabel}>Brooder assigned</label>
                <select style={recordControl} value={form.brooder} onChange={(e) => upd('brooder', e.target.value)}>
                  {BROODERS.map((b) => (
                    <option key={b} value={b}>
                      Brooder {b} — max 750 birds
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={recordFieldLabel}>Schooner assigned</label>
                <select style={recordControl} value={form.schooner} onChange={(e) => upd('schooner', e.target.value)}>
                  {SCHOONERS.map((s) => (
                    <option key={s} value={s}>
                      Schooner {s}
                      {s === '1' ? ' (solo / 650 birds)' : ' (pair)'}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={recordFieldLabel}>Status</label>
                <select style={recordControl} value={form.status} onChange={(e) => upd('status', e.target.value)}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label style={recordFieldLabel}>Notes</label>
              <textarea
                style={recordTextarea}
                value={form.notes}
                onChange={(e) => upd('notes', e.target.value)}
                rows={2}
                placeholder="Farm team, transporter, distribution notes…"
              />
            </div>
            {/* ── Brooder / Schooner Counts ── */}
            <div style={{gridColumn: '1/-1', borderTop: '1px solid #e5e7eb', paddingTop: 12, marginTop: 4}}>
              <div style={{fontSize: 11, fontWeight: 700, color: '#9ca3af', letterSpacing: 0.5, marginBottom: 8}}>
                BROODER & SCHOONER
              </div>
              <div data-mobile-1col="1" style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10}}>
                <div>
                  <label style={recordFieldLabel}>Date In Brooder</label>
                  <input
                    style={recordControl}
                    type="date"
                    value={form.brooderIn}
                    onChange={(e) => upd('brooderIn', e.target.value)}
                  />
                  <div style={{fontSize: 11, color: '#9ca3af', marginTop: 3}}>Defaults to hatch date + 1 day</div>
                </div>
                <div>
                  <label style={recordFieldLabel}>Date Out of Brooder</label>
                  <input
                    style={recordControl}
                    type="date"
                    value={form.brooderOut}
                    onChange={(e) => upd('brooderOut', e.target.value)}
                  />
                </div>
                <div>
                  <label style={recordFieldLabel}>4-Week Weight (lbs)</label>
                  <div data-broiler-week4-weight-readonly="1" style={weighInSourcedValueBox}>
                    {broilerWeekWeightLabel(form.week4Lbs)}
                  </div>
                  <div style={weighInSourcedHint}>Pulled from completed Week 4 weigh-ins.</div>
                </div>
                <div>
                  <label style={recordFieldLabel}>6-Week Weight (lbs)</label>
                  <div data-broiler-week6-weight-readonly="1" style={weighInSourcedValueBox}>
                    {broilerWeekWeightLabel(form.week6Lbs)}
                  </div>
                  <div style={weighInSourcedHint}>Pulled from completed Week 6 weigh-ins.</div>
                </div>
                {(() => {
                  const stats = calcBroilerStatsFromDailys(form, broilerDailys);
                  if (stats.legacy) {
                    return (
                      <div>
                        <label style={recordFieldLabel}>Mortality Cumulative</label>
                        <input
                          style={recordControl}
                          type="number"
                          min="0"
                          value={form.mortalityCumulative || ''}
                          onChange={(e) => upd('mortalityCumulative', e.target.value)}
                        />
                      </div>
                    );
                  }
                  return (
                    <div>
                      <label style={recordFieldLabel}>Mortality (from daily reports)</label>
                      <div
                        style={{
                          padding: '8px 11px',
                          background: '#f9fafb',
                          border: '1px solid #e5e7eb',
                          borderRadius: 6,
                          fontSize: 13,
                          fontWeight: 600,
                          color: stats.mortality > 0 ? '#b91c1c' : '#9ca3af',
                        }}
                      >
                        {stats.mortality.toLocaleString()}
                        {stats.mortPct > 0 ? (
                          <span style={{fontWeight: 400, color: '#9ca3af', marginLeft: 6}}>
                            ({stats.mortPct.toFixed(1)}%)
                          </span>
                        ) : null}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
            {/* ── Feed ── */}
            <div style={{gridColumn: '1/-1', borderTop: '1px solid #e5e7eb', paddingTop: 12}}>
              <div style={{fontSize: 11, fontWeight: 700, color: '#9ca3af', letterSpacing: 0.5, marginBottom: 8}}>
                FEED & GRIT
              </div>
              {editId &&
                !/^b-24-/i.test(form.name) &&
                (() => {
                  const bd = broilerDailys.filter(
                    (d) =>
                      (d.batch_label || '')
                        .toLowerCase()
                        .trim()
                        .replace(/^\(processed\)\s*/, '')
                        .trim() === form.name.toLowerCase().trim(),
                  );
                  const allLabels = [...new Set(broilerDailys.map((d) => d.batch_label).filter(Boolean))].sort();
                  if (broilerDailys.length === 0)
                    return (
                      <div
                        style={{
                          fontSize: 11,
                          color: '#b91c1c',
                          background: '#fef2f2',
                          border: '1px solid #fecaca',
                          borderRadius: 6,
                          padding: '5px 10px',
                          marginBottom: 8,
                        }}
                      >
                        ⚠ Daily records not loaded yet — try closing and reopening this form.
                      </div>
                    );
                  if (bd.length === 0)
                    return (
                      <div
                        style={{
                          fontSize: 11,
                          color: '#b91c1c',
                          background: '#fef2f2',
                          border: '1px solid #fecaca',
                          borderRadius: 6,
                          padding: '5px 10px',
                          marginBottom: 8,
                        }}
                      >
                        ⚠ No daily reports found matching "{form.name}". Labels in DB:{' '}
                        {allLabels.filter((l) => l.toLowerCase().includes('26-0')).join(', ') || 'none found'}
                      </div>
                    );
                  return (
                    <div
                      style={{
                        fontSize: 11,
                        color: '#085041',
                        background: '#ecfdf5',
                        border: '1px solid #a7f3d0',
                        borderRadius: 6,
                        padding: '5px 10px',
                        marginBottom: 8,
                      }}
                    >
                      🌾 Auto-filled from {bd.length} daily reports. Edit only to correct errors.
                    </div>
                  );
                })()}
              {(() => {
                const stats = calcBroilerStatsFromDailys(form, broilerDailys);
                if (stats.legacy) {
                  // Legacy B-24-* batches: keep editable fields (no daily reports exist)
                  return (
                    <div data-mobile-1col="1" style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10}}>
                      <div>
                        <label style={recordFieldLabel}>Brooder Feed (lbs)</label>
                        <input
                          style={recordControl}
                          type="number"
                          min="0"
                          value={form.brooderFeedLbs || ''}
                          onChange={(e) => upd('brooderFeedLbs', e.target.value)}
                        />
                      </div>
                      <div>
                        <label style={recordFieldLabel}>Schooner Feed (lbs)</label>
                        <input
                          style={recordControl}
                          type="number"
                          min="0"
                          value={form.schoonerFeedLbs || ''}
                          onChange={(e) => upd('schoonerFeedLbs', e.target.value)}
                        />
                      </div>
                      <div>
                        <label style={recordFieldLabel}>Grit (lbs)</label>
                        <input
                          style={recordControl}
                          type="number"
                          min="0"
                          value={form.gritLbs || ''}
                          onChange={(e) => upd('gritLbs', e.target.value)}
                        />
                      </div>
                    </div>
                  );
                }
                // Modern batches: read-only display sourced live from daily reports
                const ro = (label, val, suffix) => (
                  <div>
                    <label style={recordFieldLabel}>
                      {label} <span style={{fontWeight: 400, color: '#9ca3af'}}>(from daily reports)</span>
                    </label>
                    <div
                      style={{
                        padding: '8px 11px',
                        background: '#f9fafb',
                        border: '1px solid #e5e7eb',
                        borderRadius: 6,
                        fontSize: 13,
                        fontWeight: 600,
                        color: val > 0 ? '#085041' : '#9ca3af',
                      }}
                    >
                      {val > 0 ? val.toLocaleString() + suffix : '\u2014'}
                    </div>
                  </div>
                );
                return (
                  <div data-mobile-1col="1" style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10}}>
                    {ro('Starter Feed', stats.starterFeed, ' lbs')}
                    {ro('Grower Feed', stats.growerFeed, ' lbs')}
                    {ro('Grit', stats.gritLbs, ' lbs')}
                  </div>
                );
              })()}
              {/* FEED COST RATES (read-only — set in Admin → Feed Costs, propagated to all active broiler batches) */}
              <div style={{gridColumn: '1/-1', borderTop: '1px solid #e5e7eb', paddingTop: 10, marginTop: 10}}>
                <div style={{fontSize: 11, fontWeight: 700, color: '#4b5563', letterSpacing: 0.5, marginBottom: 6}}>
                  {'\ud83d\udcb0 FEED COST RATES'}{' '}
                  <span style={{fontWeight: 400, color: '#9ca3af'}}>
                    {'(locked \u2014 set in Admin \u203a Feed Costs)'}
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 16,
                    fontSize: 12,
                    color: '#374151',
                    padding: '8px 12px',
                    background: '#f9fafb',
                    borderRadius: 8,
                    border: '1px solid #e5e7eb',
                    flexWrap: 'wrap',
                  }}
                >
                  <span>
                    Starter:{' '}
                    <strong>
                      {form.perLbStarterCost !== '' && form.perLbStarterCost != null
                        ? '$' + parseFloat(form.perLbStarterCost).toFixed(3) + '/lb'
                        : '\u2014'}
                    </strong>
                  </span>
                  <span>
                    Grower (Standard):{' '}
                    <strong>
                      {form.perLbStandardCost !== '' && form.perLbStandardCost != null
                        ? '$' + parseFloat(form.perLbStandardCost).toFixed(3) + '/lb'
                        : '\u2014'}
                    </strong>
                  </span>
                  <span>
                    Grit:{' '}
                    <strong>
                      {form.perLbGritCost !== '' && form.perLbGritCost != null
                        ? '$' + parseFloat(form.perLbGritCost).toFixed(3) + '/lb'
                        : '\u2014'}
                    </strong>
                  </span>
                </div>
              </div>
            </div>
            {/* ── Processing ── */}
            <div style={{gridColumn: '1/-1', borderTop: '1px solid #e5e7eb', paddingTop: 12}}>
              <div style={{fontSize: 11, fontWeight: 700, color: '#9ca3af', letterSpacing: 0.5, marginBottom: 8}}>
                PROCESSING
              </div>
              <div data-mobile-1col="1" style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                <div>
                  <label style={recordFieldLabel}>Birds to Processor</label>
                  <input
                    style={recordControl}
                    type="number"
                    min="0"
                    value={form.totalToProcessor || ''}
                    onChange={(e) => upd('totalToProcessor', e.target.value)}
                  />
                </div>
                <div>
                  <label style={recordFieldLabel}>Processing Cost ($)</label>
                  <input
                    style={recordControl}
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.processingCost || ''}
                    onChange={(e) => upd('processingCost', e.target.value)}
                  />
                </div>
                <div>
                  <label style={recordFieldLabel}>Feed per Bird (lbs)</label>
                  <div
                    style={{
                      padding: '8px 10px',
                      background: '#f9fafb',
                      border: '1px solid #e5e7eb',
                      borderRadius: 6,
                      fontSize: 13,
                      fontWeight: 600,
                      color: (() => {
                        const tf = (parseFloat(form.brooderFeedLbs) || 0) + (parseFloat(form.schoonerFeedLbs) || 0);
                        const p = parseFloat(form.totalToProcessor) || 0;
                        return tf > 0 && p > 0 ? '#085041' : '#9ca3af';
                      })(),
                    }}
                  >
                    {(() => {
                      const tf = (parseFloat(form.brooderFeedLbs) || 0) + (parseFloat(form.schoonerFeedLbs) || 0);
                      const p = parseFloat(form.totalToProcessor) || 0;
                      return tf > 0 && p > 0
                        ? (tf / p).toFixed(1) + ' lbs/bird'
                        : '\u2014 (enter feed totals + birds to processor)';
                    })()}
                  </div>
                </div>
                <div>
                  <label style={recordFieldLabel}>Avg Breast (lbs)</label>
                  <input
                    style={recordControl}
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.avgBreastLbs || ''}
                    onChange={(e) => upd('avgBreastLbs', e.target.value)}
                  />
                </div>
                <div>
                  <label style={recordFieldLabel}>Avg Thighs (lbs)</label>
                  <input
                    style={recordControl}
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.avgThighsLbs || ''}
                    onChange={(e) => upd('avgThighsLbs', e.target.value)}
                  />
                </div>
                <div style={{gridColumn: '1/-1'}}>
                  <label style={recordFieldLabel}>Avg Dressed Bird (lbs)</label>
                  <input
                    style={recordControl}
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.avgDressedLbs || ''}
                    onChange={(e) => upd('avgDressedLbs', e.target.value)}
                  />
                </div>
              </div>
            </div>
            <div style={{gridColumn: '1/-1', borderTop: '1px solid #e5e7eb', paddingTop: 12}}>
              <div style={{fontSize: 11, fontWeight: 700, color: '#9ca3af', letterSpacing: 0.5, marginBottom: 8}}>
                PRODUCTION TOTALS
              </div>
              <div data-mobile-1col="1" style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                <div>
                  <label style={recordFieldLabel}>Total Lbs — Whole Birds</label>
                  <input
                    style={recordControl}
                    type="number"
                    min="0"
                    step="0.1"
                    value={form.totalLbsWhole || ''}
                    onChange={(e) => upd('totalLbsWhole', e.target.value)}
                  />
                </div>
                <div>
                  <label style={recordFieldLabel}>Total Lbs — Cuts</label>
                  <input
                    style={recordControl}
                    type="number"
                    min="0"
                    step="0.1"
                    value={form.totalLbsCuts || ''}
                    onChange={(e) => upd('totalLbsCuts', e.target.value)}
                  />
                </div>
              </div>
            </div>
            {/* ── Documents ── */}
            {editId && (
              <div style={{gridColumn: '1/-1', borderTop: '1px solid #e5e7eb', paddingTop: 12}}>
                <div style={{fontSize: 11, fontWeight: 700, color: '#9ca3af', letterSpacing: 0.5, marginBottom: 8}}>
                  DOCUMENTS
                </div>

                {/* Processor Excel parse confirmation panel */}
                {parsedProcessor && (
                  <div
                    style={{
                      background: '#eff6ff',
                      border: '1px solid #bfdbfe',
                      borderRadius: 10,
                      padding: '12px 14px',
                      marginBottom: 12,
                    }}
                  >
                    <div style={{fontSize: 12, fontWeight: 700, color: '#1e40af', marginBottom: 8}}>
                      📊 Processor data found in <em>{parsedProcessor.fileName}</em> — select fields to apply:
                    </div>
                    {[
                      {
                        key: 'avgDressed',
                        label: 'Avg Dressed Wt (lbs)',
                        val: parsedProcessor.avgDressed,
                        fmt: (v) => v,
                      },
                      {key: 'avgBreast', label: 'Avg Breast (lbs)', val: parsedProcessor.avgBreast, fmt: (v) => v},
                      {key: 'avgThigh', label: 'Avg Thigh (lbs)', val: parsedProcessor.avgThigh, fmt: (v) => v},
                      {
                        key: 'totalLbsWhole',
                        label: 'Total Lbs — Whole',
                        val: parsedProcessor.totalLbsWhole,
                        fmt: (v) => (v != null ? Math.round(v) + ' lbs' : null),
                      },
                      {
                        key: 'totalLbsCuts',
                        label: 'Total Lbs — Cuts',
                        val: parsedProcessor.totalLbsCuts,
                        fmt: (v) => (v != null ? Math.round(v) + ' lbs' : null),
                      },
                    ]
                      .filter((f) => f.val != null)
                      .map((f) => (
                        <label
                          key={f.key}
                          style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer'}}
                        >
                          <input type="checkbox" defaultChecked={true} id={`pp_${f.key}`} style={recordCheckbox} />
                          <span style={{fontSize: 12, color: '#1e40af', minWidth: 160}}>{f.label}</span>
                          <span style={{fontSize: 12, fontWeight: 700, color: '#111827'}}>{f.fmt(f.val)}</span>
                        </label>
                      ))}
                    <div style={{display: 'flex', gap: 8, marginTop: 10}}>
                      <button
                        onClick={() => {
                          const updates = {};
                          [
                            {key: 'avgDressed', formKey: 'avgDressedLbs'},
                            {key: 'avgBreast', formKey: 'avgBreastLbs'},
                            {key: 'avgThigh', formKey: 'avgThighsLbs'},
                            {key: 'totalLbsWhole', formKey: 'totalLbsWhole'},
                            {key: 'totalLbsCuts', formKey: 'totalLbsCuts'},
                          ].forEach(({key, formKey}) => {
                            const cb = document.getElementById(`pp_${key}`);
                            if (cb && cb.checked && parsedProcessor[key] != null)
                              updates[formKey] = parsedProcessor[key];
                          });
                          setForm((f) => ({...f, ...updates}));
                          setParsedProcessor(null);
                        }}
                        style={{
                          padding: '6px 16px',
                          borderRadius: 7,
                          border: 'none',
                          background: '#085041',
                          color: 'white',
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Apply Selected
                      </button>
                      <button
                        onClick={() => {
                          const updates = {};
                          [
                            {key: 'avgDressed', formKey: 'avgDressedLbs'},
                            {key: 'avgBreast', formKey: 'avgBreastLbs'},
                            {key: 'avgThigh', formKey: 'avgThighsLbs'},
                            {key: 'totalLbsWhole', formKey: 'totalLbsWhole'},
                            {key: 'totalLbsCuts', formKey: 'totalLbsCuts'},
                          ].forEach(({key, formKey}) => {
                            if (parsedProcessor[key] != null) updates[formKey] = parsedProcessor[key];
                          });
                          setForm((f) => ({...f, ...updates}));
                          setParsedProcessor(null);
                        }}
                        style={{
                          padding: '6px 16px',
                          borderRadius: 7,
                          border: '1px solid #085041',
                          background: 'white',
                          color: '#085041',
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Apply All
                      </button>
                      <button
                        onClick={() => setParsedProcessor(null)}
                        style={{
                          padding: '6px 12px',
                          borderRadius: 7,
                          border: '1px solid #d1d5db',
                          background: 'white',
                          color: '#6b7280',
                          fontSize: 12,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}

                <InlineNotice notice={formNotice} onDismiss={() => setFormNotice(null)} />

                {/* Drop zone */}
                <label
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.currentTarget.style.background = '#ecfdf5';
                    e.currentTarget.style.borderColor = '#085041';
                  }}
                  onDragLeave={(e) => {
                    e.currentTarget.style.background = '#f8fafc';
                    e.currentTarget.style.borderColor = '#d1d5db';
                  }}
                  onDrop={async (e) => {
                    e.preventDefault();
                    e.currentTarget.style.background = '#f8fafc';
                    e.currentTarget.style.borderColor = '#d1d5db';
                    setFormNotice(null);
                    const files = Array.from(e.dataTransfer.files).filter((f) => /\.(pdf|xlsx|xls|csv)$/i.test(f.name));
                    if (!files.length) {
                      setFormNotice({kind: 'error', message: 'Only PDF, Excel, and CSV files are supported.'});
                      return;
                    }
                    setDocUploading(true);
                    const errors = [];
                    for (const file of files) {
                      if (file.size > 20 * 1024 * 1024) {
                        errors.push(file.name + ' is over 20 MB and was skipped.');
                        continue;
                      }
                      if (/\.xlsx?$/i.test(file.name)) await parseProcessorXlsx(file);
                      try {
                        const path = `broiler-batches/${editId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
                        const {error: upErr} = await sb.storage
                          .from('batch-documents')
                          .upload(path, file, {cacheControl: '3600', upsert: false});
                        if (upErr) throw upErr;
                        const {data: urlData} = sb.storage.from('batch-documents').getPublicUrl(path);
                        const doc = {
                          name: file.name,
                          path,
                          url: urlData.publicUrl,
                          size: file.size,
                          uploadedAt: new Date().toISOString(),
                        };
                        setForm((f) => {
                          const newDocs = [...(f.documents || []), doc];
                          const nb = batches.map((b) => (b.id === editId ? {...b, documents: newDocs} : b));
                          setBatches(nb);
                          persist(nb);
                          return {...f, documents: newDocs};
                        });
                      } catch (err) {
                        errors.push('Upload failed for ' + file.name + ': ' + (err.message || 'Unknown error'));
                      }
                    }
                    setDocUploading(false);
                    if (errors.length) setFormNotice({kind: 'error', message: errors.join('\n')});
                  }}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    padding: '20px',
                    background: '#f8fafc',
                    border: '2px dashed #d1d5db',
                    borderRadius: 10,
                    cursor: docUploading ? 'not-allowed' : 'pointer',
                    marginBottom: 10,
                    transition: 'all .15s',
                  }}
                >
                  <span style={{fontSize: 28}}>{docUploading ? '⏳' : '📎'}</span>
                  <div style={{fontSize: 12, fontWeight: 600, color: '#374151'}}>
                    {docUploading ? 'Uploading…' : 'Drop files here'}
                  </div>
                  <div style={{fontSize: 11, color: '#9ca3af'}}>
                    PDF, Excel, CSV · click to browse · Excel files scanned for processor data
                  </div>
                  <input
                    type="file"
                    accept=".pdf,.xlsx,.xls,.csv"
                    multiple
                    style={{display: 'none'}}
                    disabled={docUploading}
                    onChange={async (e) => {
                      const files = Array.from(e.target.files || []);
                      if (!files.length) return;
                      setFormNotice(null);
                      setDocUploading(true);
                      const errors = [];
                      for (const file of files) {
                        if (!/\.(pdf|xlsx|xls|csv)$/i.test(file.name)) {
                          errors.push(file.name + ' is not a supported file type and was skipped.');
                          continue;
                        }
                        if (file.size > 20 * 1024 * 1024) {
                          errors.push(file.name + ' is over 20 MB and was skipped.');
                          continue;
                        }
                        if (/\.xlsx?$/i.test(file.name)) await parseProcessorXlsx(file);
                        try {
                          const path = `broiler-batches/${editId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
                          const {error: upErr} = await sb.storage
                            .from('batch-documents')
                            .upload(path, file, {cacheControl: '3600', upsert: false});
                          if (upErr) throw upErr;
                          const {data: urlData} = sb.storage.from('batch-documents').getPublicUrl(path);
                          const doc = {
                            name: file.name,
                            path,
                            url: urlData.publicUrl,
                            size: file.size,
                            uploadedAt: new Date().toISOString(),
                          };
                          setForm((f) => {
                            const newDocs = [...(f.documents || []), doc];
                            const nb = batches.map((b) => (b.id === editId ? {...b, documents: newDocs} : b));
                            setBatches(nb);
                            persist(nb);
                            return {...f, documents: newDocs};
                          });
                        } catch (err) {
                          errors.push('Upload failed for ' + file.name + ': ' + (err.message || 'Unknown error'));
                        }
                      }
                      setDocUploading(false);
                      e.target.value = '';
                      if (errors.length) setFormNotice({kind: 'error', message: errors.join('\n')});
                    }}
                  />
                </label>
                {(form.documents || []).length === 0 && (
                  <div style={{fontSize: 12, color: '#9ca3af', fontStyle: 'italic'}}>No documents attached yet</div>
                )}
                {(form.documents || []).map((doc, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 10px',
                      background: '#f8fafc',
                      border: '1px solid #e5e7eb',
                      borderRadius: 7,
                      marginBottom: 6,
                    }}
                  >
                    {(() => {
                      const ext = (doc.name || '').split('.').pop().toLowerCase();
                      const ico = ext === 'pdf' ? '📄' : ext === 'csv' ? '📊' : '📗';
                      return <span style={{fontSize: 18, flexShrink: 0}}>{ico}</span>;
                    })()}
                    <div style={{flex: 1, minWidth: 0}}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: '#111827',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {doc.name}
                      </div>
                      <div style={{fontSize: 10, color: '#9ca3af'}}>
                        {doc.size ? Math.round(doc.size / 1024) + ' KB' : ''}
                        {doc.uploadedAt ? ' · ' + fmt(doc.uploadedAt) : ''}
                      </div>
                    </div>
                    <a
                      href={doc.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{fontSize: 11, color: '#1d4ed8', fontWeight: 600, textDecoration: 'none', flexShrink: 0}}
                    >
                      View
                    </a>
                    <button
                      onClick={() =>
                        confirmDelete('Remove this document? It cannot be recovered.', async () => {
                          try {
                            await sb.storage.from('batch-documents').remove([doc.path]);
                          } catch (_e) {
                            /* best-effort storage cleanup */
                          }
                          const newDocs = (form.documents || []).filter((_, j) => j !== i);
                          setForm((f) => ({...f, documents: newDocs}));
                          const nb = batches.map((b) => (b.id === editId ? {...b, documents: newDocs} : b));
                          setBatches(nb);
                          persist(nb);
                        })
                      }
                      style={{
                        fontSize: 11,
                        color: '#b91c1c',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}{' '}
          </div>

          <div
            style={{
              padding: '12px 20px',
              borderTop: '1px solid #e5e7eb',
              display: 'flex',
              gap: 8,
              alignItems: 'center',
            }}
          >
            {editId ? (
              <button
                style={S.btnDanger}
                onClick={() => {
                  del(editId);
                  if (typeof onClose === 'function') onClose();
                  else closeForm();
                }}
              >
                Delete
              </button>
            ) : (
              <button onClick={() => submit(false)} style={{...S.btnPrimary, background: '#085041', cursor: 'pointer'}}>
                Add batch
              </button>
            )}
            <button
              style={S.btnGhost}
              onClick={() => {
                if (typeof onClose === 'function') onClose();
                else closeForm();
              }}
            >
              Close
            </button>
            {editId && <div style={{marginLeft: 'auto', fontSize: 11, color: '#9ca3af'}}>Auto-saves as you type</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
