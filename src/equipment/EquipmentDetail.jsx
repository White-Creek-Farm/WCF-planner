// EquipmentDetail — the per-equipment page. Sections:
//   1. Header: name / status / serial / current reading / fuel type
//   2. Spec panel (editable inline for admin): fluids / filters / capacities
//   3. Upcoming service calculator (service_intervals + completions)
//   4. Fueling + checklist history (expandable rows)
//   5. Maintenance events (+ Add modal with photo upload)
//   6. Warranty expiration flag when < 60 days out
import React from 'react';
import {useLocation} from 'react-router-dom';
import {
  EQUIPMENT_COLOR,
  WARRANTY_WINDOW_DAYS,
  computeIntervalStatus,
  currentReadingFromFuelings,
  fmtReading,
  daysSince,
  stripPodioHtml,
} from '../lib/equipment.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import EquipmentMeterStatusPanel from './EquipmentMeterStatusPanel.jsx';
import EquipmentMaintenanceModal from './EquipmentMaintenanceModal.jsx';
import ManualsCard from './ManualsCard.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import {RecordPageBody, RecordTitle} from '../shared/RecordPageShell.jsx';
import {LockedTeamMemberField, recordControl, recordTextarea} from '../shared/recordPageControls.jsx';
import {runMutation, recordStatusChange} from '../lib/entityMutations.js';
import {imageAltText} from '../lib/imageAlt.js';

export default function EquipmentDetail({
  sb,
  fmt,
  equipment,
  fuelings,
  maintenance,
  authState,
  isEquipmentTech,
  onReload,
}) {
  const eq = equipment;
  const location = useLocation();
  const reading = eq.tracking_unit === 'km' ? eq.current_km : eq.current_hours;
  const readingLabel = eq.tracking_unit === 'km' ? 'KM' : 'Hours';
  const [expandedFueling, setExpandedFueling] = React.useState(null);
  const [showMaintenanceModal, setShowMaintenanceModal] = React.useState(false);
  const [editingMaintenance, setEditingMaintenance] = React.useState(null);
  // Lightbox: photos array + active index. Null when closed. Drives the
  // full-screen viewer with prev/next/close.
  const [lightbox, setLightbox] = React.useState(null);

  React.useEffect(() => {
    if (location.hash) {
      const anchor = location.hash.slice(1);
      setTimeout(() => {
        const el = document.getElementById(anchor);
        if (el) el.scrollIntoView({behavior: 'smooth', block: 'center'});
      }, 200);
    }
  }, [eq.id, location.hash]);

  // Optimistic local patches for fueling rows — keyed by fueling id. Lets
  // the user toggle checklist items without triggering a full re-fetch
  // (which collapses the expanded row + scrolls the page). DB save happens
  // in the background; on next page load the data is already in sync.
  const [fuelingPatches, setFuelingPatches] = React.useState({});
  // Inline notice for inline-edit save / delete / status failures across
  // the spec panel, fueling rows, interval entries, and the status toggle.
  const [notice, setNotice] = React.useState(null);
  function withPatch(f) {
    const p = fuelingPatches[f.id];
    return p ? {...f, ...p} : f;
  }

  // Keyboard shortcuts for the lightbox.
  React.useEffect(() => {
    if (!lightbox) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setLightbox(null);
      else if (e.key === 'ArrowLeft')
        setLightbox((lb) => (lb ? {...lb, index: (lb.index - 1 + lb.photos.length) % lb.photos.length} : lb));
      else if (e.key === 'ArrowRight')
        setLightbox((lb) => (lb ? {...lb, index: (lb.index + 1) % lb.photos.length} : lb));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  // Debounced inline auto-save: any spec field is live-edited; after 800ms
  // of no typing the field patches to Supabase. Matches the cattle/sheep
  // inline-edit UX.
  const saveTimers = React.useRef({});
  const pendingFieldSaves = React.useRef({});
  function parseQueuedValue(rawValue, parser, {nonNegative = false} = {}) {
    if (parser === 'number') {
      const n = parseFloat(rawValue);
      return Number.isFinite(n) && (!nonNegative || n >= 0) ? n : null;
    }
    return (rawValue || '').trim() || null;
  }

  async function patchEq(fields) {
    setNotice(null);
    const {error} = await sb.from('equipment').update(fields).eq('id', eq.id);
    if (error) {
      setNotice({kind: 'error', message: 'Save failed: ' + error.message});
      return false;
    }
    onReload();
    return true;
  }
  async function flushFieldSave(field) {
    const pending = pendingFieldSaves.current[field];
    if (!pending) return true;
    if (saveTimers.current[field]) clearTimeout(saveTimers.current[field]);
    delete saveTimers.current[field];
    const next = parseQueuedValue(pending.rawValue, pending.parser);
    const ok = await patchEq({[field]: next});
    // Clear the pending edit only after it is durably saved. On failure keep it
    // queued so the next flush (blur/pagehide/unmount) retries instead of
    // silently dropping it. Guard against clobbering a newer queued edit.
    if (ok && pendingFieldSaves.current[field] === pending) delete pendingFieldSaves.current[field];
    return ok;
  }
  function queueFieldSave(field, rawValue, parser) {
    if (saveTimers.current[field]) clearTimeout(saveTimers.current[field]);
    pendingFieldSaves.current[field] = {rawValue, parser};
    saveTimers.current[field] = setTimeout(() => {
      void flushFieldSave(field);
    }, 800);
  }

  // Toggle an every-fillup item on a historical fueling. Optimistic: updates
  // local state immediately and patches the row in the background. No reload,
  // so the expanded row stays open and the page doesn't scroll.
  async function toggleFillupItem(fueling, item) {
    setNotice(null);
    const merged = withPatch(fueling);
    const current = Array.isArray(merged.every_fillup_check) ? merged.every_fillup_check : [];
    const has = current.some((c) => c && c.id === item.id);
    const next = has
      ? current.filter((c) => c && c.id !== item.id)
      : [...current, {id: item.id, label: item.label, ok: true}];
    setFuelingPatches((p) => ({...p, [fueling.id]: {...(p[fueling.id] || {}), every_fillup_check: next}}));
    const {error} = await sb.from('equipment_fuelings').update({every_fillup_check: next}).eq('id', fueling.id);
    if (error) setNotice({kind: 'error', message: 'Save failed: ' + error.message});
  }

  // Delete a single interval entry from a fueling row's
  // service_intervals_completed. Used when an interval was recorded by mistake
  // (e.g. duplicate work logged twice on adjacent fuelings — admin keeps the
  // earlier one and removes the redundant entry from the later row).
  async function deleteIntervalEntry(fueling, intervalIdx) {
    const merged = withPatch(fueling);
    const completed = Array.isArray(merged.service_intervals_completed) ? merged.service_intervals_completed : [];
    const target = completed[intervalIdx];
    if (!target) return;
    const label =
      (target.attachment_name ? target.attachment_name + ' — ' : '') +
      (target.label || target.interval + (target.kind === 'km' ? 'k' : 'h'));
    window._wcfConfirmDelete(
      'Remove the "' +
        label +
        '" entry from this fueling row? This only deletes that one interval entry. Photos, fillup ticks, comments, and other intervals on this row stay intact.',
      async () => {
        setNotice(null);
        const next = completed.filter((_, i) => i !== intervalIdx);
        setFuelingPatches((p) => ({...p, [fueling.id]: {...(p[fueling.id] || {}), service_intervals_completed: next}}));
        const {error} = await sb
          .from('equipment_fuelings')
          .update({service_intervals_completed: next})
          .eq('id', fueling.id);
        if (error) setNotice({kind: 'error', message: 'Save failed: ' + error.message});
      },
    );
  }

  // Toggle a sub-task within a recorded interval completion on a historical
  // fueling. Optimistic update; total_tasks is refreshed from the current
  // equipment config in case admin added/removed tasks since the original
  // submission.
  async function toggleIntervalTask(fueling, intervalIdx, taskId, currentTasks) {
    setNotice(null);
    const merged = withPatch(fueling);
    const completed = Array.isArray(merged.service_intervals_completed) ? merged.service_intervals_completed : [];
    const target = completed[intervalIdx];
    if (!target) return;
    const items = Array.isArray(target.items_completed) ? target.items_completed : [];
    const has = items.includes(taskId);
    const nextItems = has ? items.filter((i) => i !== taskId) : [...items, taskId];
    const totalNow = (currentTasks && currentTasks.length) || target.total_tasks || 0;
    const next = completed.map((c, i) =>
      i === intervalIdx ? {...c, items_completed: nextItems, total_tasks: totalNow} : c,
    );
    setFuelingPatches((p) => ({...p, [fueling.id]: {...(p[fueling.id] || {}), service_intervals_completed: next}}));
    const {error} = await sb
      .from('equipment_fuelings')
      .update({service_intervals_completed: next})
      .eq('id', fueling.id);
    if (error) setNotice({kind: 'error', message: 'Save failed: ' + error.message});
  }

  const sortedFuelings = [...(fuelings || [])].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const totalGallons = sortedFuelings.reduce((s, f) => s + (parseFloat(f.gallons) || 0), 0);

  // Flatten completions for the interval calculator.
  const completions = [];
  for (const f of fuelings) {
    for (const c of f.service_intervals_completed || []) {
      completions.push({
        ...c,
        reading_at_completion: f.hours_reading != null ? f.hours_reading : f.km_reading != null ? f.km_reading : null,
      });
    }
  }
  const intervalStatus = computeIntervalStatus(eq.service_intervals, completions, reading);

  const warrantyDays = eq.warranty_expiration ? daysSince(eq.warranty_expiration) : null;
  const warrantyExpiresSoon = warrantyDays != null && warrantyDays < 0 && warrantyDays > -WARRANTY_WINDOW_DAYS;

  // Per-fueling-row debounced auto-save. Same pattern as the spec panel
  // above, but scoped per fueling row so we can have multiple rows open
  // and editing independently.
  const fuelingTimers = React.useRef({});
  const pendingFuelingSaves = React.useRef({});
  async function syncCurrentReadingFromFuelings() {
    const currentField = eq.tracking_unit === 'km' ? 'current_km' : 'current_hours';
    const {data, error} = await sb
      .from('equipment_fuelings')
      .select('hours_reading,km_reading')
      .eq('equipment_id', eq.id);
    if (error) {
      setNotice({kind: 'error', message: 'Fueling saved, but current reading sync failed: ' + error.message});
      return;
    }
    const nextCurrent = currentReadingFromFuelings(eq, data || []);
    const {error: updateError} = await sb
      .from('equipment')
      .update({[currentField]: nextCurrent})
      .eq('id', eq.id);
    if (updateError) {
      setNotice({kind: 'error', message: 'Fueling saved, but current reading sync failed: ' + updateError.message});
    }
  }

  function fuelingSaveKey(fuelingId, field) {
    return fuelingId + ':' + field;
  }

  async function patchFuelingField(fuelingId, field, rawValue, parser) {
    const next = parseQueuedValue(rawValue, parser, {nonNegative: parser === 'number'});
    const {error} = await sb
      .from('equipment_fuelings')
      .update({[field]: next})
      .eq('id', fuelingId);
    if (error) {
      setNotice({kind: 'error', message: 'Save failed: ' + error.message});
      return false;
    }
    const readingField = eq.tracking_unit === 'km' ? 'km_reading' : 'hours_reading';
    if (field === readingField) await syncCurrentReadingFromFuelings();
    onReload();
    return true;
  }

  async function flushFuelingSave(key) {
    const pending = pendingFuelingSaves.current[key];
    if (!pending) return true;
    if (fuelingTimers.current[key]) clearTimeout(fuelingTimers.current[key]);
    delete fuelingTimers.current[key];
    const ok = await patchFuelingField(pending.fuelingId, pending.field, pending.rawValue, pending.parser);
    // Clear the pending edit only after a durable save; keep it queued on
    // failure so a later flush retries. Guard against a newer queued edit.
    if (ok && pendingFuelingSaves.current[key] === pending) delete pendingFuelingSaves.current[key];
    return ok;
  }

  function flushFuelingFieldSave(fuelingId, field) {
    return flushFuelingSave(fuelingSaveKey(fuelingId, field));
  }

  async function flushAllEquipmentAutosaves() {
    const fieldKeys = Object.keys(pendingFieldSaves.current);
    const fuelingKeys = Object.keys(pendingFuelingSaves.current);
    const results = await Promise.all([
      ...fieldKeys.map((field) => flushFieldSave(field)),
      ...fuelingKeys.map((key) => flushFuelingSave(key)),
    ]);
    return results.every(Boolean);
  }

  // Reliability note: flushes triggered while the page is alive (input blur and
  // visibilitychange) are awaited internally and re-queue on failure, so an edit
  // is not lost there. The pagehide and unmount flushes are necessarily
  // best-effort: the browser does not await async work during unload/teardown,
  // so a save that is still in flight when the document is discarded may not
  // complete. This is an inherent platform limitation, not a missing await —
  // blur/visibilitychange are the reliable paths and cover normal navigation.
  React.useEffect(() => {
    const flush = () => {
      void flushAllEquipmentAutosaves();
    };
    const flushOnVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flushOnVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flushOnVisibility);
      flush();
    };
    // Captures the current equipment record so pending edits flush before the page unmounts or changes equipment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eq.id]);

  function queueFuelingSave(fuelingId, field, rawValue, parser) {
    setNotice(null);
    const key = fuelingSaveKey(fuelingId, field);
    if (fuelingTimers.current[key]) clearTimeout(fuelingTimers.current[key]);
    pendingFuelingSaves.current[key] = {fuelingId, field, rawValue, parser};
    fuelingTimers.current[key] = setTimeout(async () => {
      await flushFuelingSave(key);
    }, 800);
  }
  async function deleteFueling(fuelingId) {
    window._wcfConfirmDelete('Delete this fueling entry? This cannot be undone.', async () => {
      setNotice(null);
      const {error} = await sb.from('equipment_fuelings').delete().eq('id', fuelingId);
      if (error) {
        setNotice({kind: 'error', message: 'Delete failed: ' + error.message});
        return;
      }
      await syncCurrentReadingFromFuelings();
      onReload();
    });
  }
  async function deleteMaintenance(id) {
    window._wcfConfirmDelete('Delete this maintenance event?', async () => {
      await sb.from('equipment_maintenance_events').delete().eq('id', id);
      onReload();
    });
  }

  const sectionTitle = {
    fontSize: 11,
    fontWeight: 700,
    color: '#4b5563',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  };
  const inpS = {
    fontSize: 12,
    padding: '5px 8px',
    border: '1px solid #d1d5db',
    borderRadius: 5,
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  };

  return (
    <RecordPageBody
      maxWidth={1100}
      data-equipment-record-loaded="true"
      style={{display: 'flex', flexDirection: 'column', gap: 16}}
    >
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      {/* Header tile */}
      <div
        style={{background: 'white', border: '2px solid ' + EQUIPMENT_COLOR, borderRadius: 12, padding: '14px 20px'}}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 10}}>
          <RecordTitle fontSize={20} margin="0" style={{color: EQUIPMENT_COLOR}}>
            {eq.name}
          </RecordTitle>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              padding: '2px 10px',
              borderRadius: 10,
              background: eq.status === 'active' ? '#d1fae5' : '#f3f4f6',
              color: eq.status === 'active' ? '#065f46' : '#374151',
              textTransform: 'uppercase',
            }}
          >
            {eq.status}
          </span>
          {eq.serial_number && (
            <span style={{fontSize: 11, color: '#6b7280'}}>
              Serial: <strong>{eq.serial_number}</strong>
            </span>
          )}
          {eq.fuel_type && (
            <span style={{fontSize: 11, color: '#6b7280'}}>
              Fuel: <strong>{eq.fuel_type}</strong>
            </span>
          )}
          <button
            onClick={async () => {
              setNotice(null);
              const prev = eq.status;
              const next = prev === 'sold' ? 'active' : 'sold';
              const result = await runMutation(() => sb.from('equipment').update({status: next}).eq('id', eq.id), {
                activity: () =>
                  recordStatusChange(sb, {
                    entityType: 'equipment.item',
                    entityId: eq.id,
                    entityLabel: eq.name,
                    from: prev,
                    to: next,
                  }),
                onError: (msg) => setNotice({kind: 'error', message: 'Status update failed: ' + msg}),
              });
              if (result.ok) onReload();
            }}
            style={{
              marginLeft: 'auto',
              padding: '5px 12px',
              borderRadius: 6,
              border: '1px solid ' + (eq.status === 'sold' ? '#047857' : '#b45309'),
              background: 'white',
              color: eq.status === 'sold' ? '#047857' : '#92400e',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {eq.status === 'sold' ? '↻ Restore to active' : '↓ Mark sold'}
          </button>
        </div>
        <div
          style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, fontSize: 12}}
        >
          <StatTile
            label={eq.tracking_unit === 'km' ? 'Current KM' : 'Current Hours'}
            value={fmtReading(reading, eq.tracking_unit)}
            color="#111827"
          />
          <StatTile label="Fuel tank" value={eq.fuel_tank_gal ? eq.fuel_tank_gal + ' gal' : '—'} color="#6b7280" />
          {eq.def_tank_gal != null && eq.def_tank_gal > 0 && (
            <StatTile label="DEF tank" value={eq.def_tank_gal + ' gal'} color="#6b7280" />
          )}
          <StatTile label="Fuelings" value={sortedFuelings.length.toLocaleString()} color="#1e40af" />
          <StatTile label="Total gallons" value={Math.round(totalGallons).toLocaleString()} color="#1e40af" />
        </div>
        {warrantyExpiresSoon && (
          <div
            style={{
              marginTop: 10,
              padding: '6px 10px',
              background: '#fffbeb',
              border: '1px solid #fde68a',
              borderRadius: 6,
              fontSize: 12,
              color: '#92400e',
            }}
          >
            ⚠ Warranty expires in <strong>{-warrantyDays} days</strong> ({fmt(eq.warranty_expiration)}).
          </div>
        )}
      </div>

      {/* Manuals & Videos — shown to everyone (including equipment_tech). */}
      <ManualsCard equipment={eq} />

      {/* Meter Status — explains the relationship between equipment.current_*
          and the fuel-log history. The Sync button writes current_hours /
          current_km from the max of remaining fuelings via
          currentReadingFromFuelings, scoped to this eq.id only. Admin-only
          via the equipment_tech guard on the parent page. */}
      {!isEquipmentTech && (
        <EquipmentMeterStatusPanel equipment={eq} fuelings={sortedFuelings} fmt={fmt} onReload={onReload} />
      )}

      {/* Specs & Fluids moved to /admin → Equipment modal (admin-only).
          This page is a read view of the piece itself. */}

      {/* Webform config editing (intervals, tasks, help text, every-fillup,
          attachment checklists) lives in /webforms → Equipment admin tab,
          not here. This page is a read view of the piece itself. */}

      {/* Upcoming service calculator */}
      <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 20px'}}>
        <div style={sectionTitle}>Upcoming Service</div>
        {intervalStatus.length === 0 && (
          <div style={{fontSize: 12, color: '#9ca3af', fontStyle: 'italic'}}>
            No service intervals configured yet. Edit equipment to add.
          </div>
        )}
        {intervalStatus.length > 0 && (
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8}}>
            {intervalStatus
              .slice()
              .sort((a, b) => a.hours_or_km - b.hours_or_km)
              .map((iv) => {
                // Two colors only: red for overdue, amber for upcoming.
                const color = iv.overdue ? '#b91c1c' : '#92400e';
                const bg = iv.overdue ? '#fef2f2' : '#fffbeb';
                const bd = iv.overdue ? '#fca5a5' : '#fde68a';
                const unitChar = iv.kind.charAt(0);
                // Show what was last done on this interval, if anything. The
                // raw reading is when the operator actually did the work; the
                // snapped milestone is which scheduled milestone it satisfied.
                // When they differ (early or late completion) show both for
                // transparency on the next-due math.
                const lastRaw = iv.last_at_reading;
                const lastMilestone = iv.last_satisfied_milestone;
                return (
                  <div
                    key={iv.kind + '-' + iv.hours_or_km}
                    data-interval-tile={iv.kind + '-' + iv.hours_or_km}
                    style={{
                      background: bg,
                      border: '1px solid ' + bd,
                      borderRadius: 8,
                      padding: '8px 10px',
                      fontSize: 11,
                    }}
                  >
                    <div style={{display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6}}>
                      <div style={{fontWeight: 700, color: color, fontSize: 12}}>{iv.label}</div>
                      <div
                        data-interval-size="1"
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          color: color,
                          letterSpacing: 0.3,
                          textTransform: 'uppercase',
                          opacity: 0.85,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Every {iv.hours_or_km.toLocaleString()}
                        {unitChar}
                      </div>
                    </div>
                    <div style={{color: '#6b7280', marginTop: 2}}>
                      Next at{' '}
                      <strong>
                        {iv.next_due.toLocaleString()}
                        {unitChar}
                      </strong>
                    </div>
                    {iv.until_due != null && (
                      <div style={{color: color, fontWeight: 600, marginTop: 2}}>
                        {iv.overdue
                          ? 'OVERDUE by ' + Math.abs(iv.until_due) + unitChar
                          : iv.until_due + unitChar + ' away'}
                      </div>
                    )}
                    {/* Why-due math line — explicit "current X → next at Y"
                        readout so the operator can verify the status without
                        cross-referencing the header tile. */}
                    {reading != null && (
                      <div data-interval-math="1" style={{color: '#6b7280', marginTop: 2, fontSize: 10}}>
                        Current{' '}
                        <strong>
                          {Math.round(reading).toLocaleString()}
                          {unitChar}
                        </strong>{' '}
                        {iv.overdue ? '>' : '→'} next at{' '}
                        <strong>
                          {iv.next_due.toLocaleString()}
                          {unitChar}
                        </strong>
                      </div>
                    )}
                    {lastRaw != null && (
                      <div
                        style={{
                          color: '#6b7280',
                          marginTop: 6,
                          paddingTop: 6,
                          borderTop: '1px solid ' + bd,
                          fontSize: 10,
                        }}
                      >
                        Last done at{' '}
                        <strong>
                          {Math.round(lastRaw).toLocaleString()}
                          {unitChar}
                        </strong>
                        {lastMilestone && Math.round(lastRaw) !== lastMilestone && (
                          <>
                            {' '}
                            · counted as {lastMilestone.toLocaleString()}
                            {unitChar}
                          </>
                        )}
                      </div>
                    )}
                    {lastRaw == null && (
                      <div
                        style={{
                          color: '#9ca3af',
                          marginTop: 6,
                          paddingTop: 6,
                          borderTop: '1px solid ' + bd,
                          fontSize: 10,
                          fontStyle: 'italic',
                        }}
                      >
                        Never completed
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {/* Fueling history */}
      <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 20px'}}>
        <div style={sectionTitle}>Fueling & Checklist History ({sortedFuelings.length})</div>
        {sortedFuelings.length === 0 && (
          <div style={{fontSize: 12, color: '#9ca3af', fontStyle: 'italic'}}>No fueling entries yet.</div>
        )}
        {sortedFuelings.length > 0 && (
          <div style={{border: '1px solid #f3f4f6', borderRadius: 8, overflow: 'hidden'}}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: eq.takes_def ? '90px 110px 80px 80px 100px 1fr' : '90px 110px 80px 100px 1fr',
                gap: '0 14px',
                background: '#f9fafb',
                padding: '6px 12px',
                fontSize: 10,
                fontWeight: 700,
                color: '#6b7280',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              <div>Date</div>
              <div style={{textAlign: 'right'}}>{(eq.fuel_type || 'Fuel').toUpperCase()} GAL</div>
              {eq.takes_def && <div style={{textAlign: 'right'}}>DEF GAL</div>}
              <div style={{textAlign: 'right'}}>{readingLabel}</div>
              <div>Team</div>
              <div>Notes</div>
            </div>
            {sortedFuelings.slice(0, 100).map((rawF) => {
              const f = withPatch(rawF);
              const isExp = expandedFueling === f.id;
              const rdg =
                f.hours_reading != null
                  ? Math.round(f.hours_reading)
                  : f.km_reading != null
                    ? Math.round(f.km_reading)
                    : null;
              // Checklist chips: derived from service_intervals_completed.
              // Each chip shows the interval label + a full/partial indicator.
              // Photo count chip shows when at least one photo is attached.
              const completed = Array.isArray(f.service_intervals_completed) ? f.service_intervals_completed : [];
              const chips = completed.map((c) => {
                const total = c.total_tasks || 0;
                const done = Array.isArray(c.items_completed) ? c.items_completed.length : 0;
                const isFull = total === 0 ? true : done >= total;
                const unitChar = c.kind === 'km' ? 'k' : 'h';
                const label = (c.attachment_name ? c.attachment_name + ' ' : '') + c.interval + unitChar;
                return {label, isFull};
              });
              const photoCount = Array.isArray(f.photos) ? f.photos.length : 0;
              const noteText = stripPodioHtml(f.comments);
              return (
                <div key={f.id} style={{borderTop: '1px solid #f3f4f6'}}>
                  <div
                    onClick={() => setExpandedFueling(isExp ? null : f.id)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: eq.takes_def
                        ? '90px 110px 80px 80px 100px 1fr'
                        : '90px 110px 80px 100px 1fr',
                      gap: '0 14px',
                      padding: '6px 12px',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                    className="hoverable-tile"
                  >
                    <div style={{color: '#111827'}}>{fmt(f.date)}</div>
                    <div style={{textAlign: 'right', color: '#1e40af', fontWeight: 600}}>
                      {f.gallons ? Math.round(f.gallons * 10) / 10 : '—'}
                    </div>
                    {eq.takes_def && (
                      <div style={{textAlign: 'right', color: '#a16207', fontWeight: 600}}>
                        {f.def_gallons ? Math.round(f.def_gallons * 10) / 10 : '—'}
                      </div>
                    )}
                    <div style={{textAlign: 'right', color: '#6b7280'}}>{rdg != null ? rdg.toLocaleString() : '—'}</div>
                    <div style={{color: '#6b7280'}}>{f.team_member || '—'}</div>
                    <div style={{color: '#6b7280', display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden'}}>
                      {chips.map((c, i) => (
                        <span
                          key={i}
                          title={c.isFull ? 'Full completion' : 'Partial — some sub-tasks not ticked'}
                          style={{
                            flexShrink: 0,
                            fontSize: 10,
                            padding: '1px 6px',
                            borderRadius: 3,
                            fontWeight: 700,
                            letterSpacing: 0.3,
                            background: c.isFull ? '#dbeafe' : '#fef3c7',
                            color: c.isFull ? '#1e40af' : '#92400e',
                            border: '1px solid ' + (c.isFull ? '#bfdbfe' : '#fde68a'),
                          }}
                        >
                          {c.label}
                          {c.isFull ? ' ✓' : ' ◐'}
                        </span>
                      ))}
                      {photoCount > 0 && (
                        <span
                          title={photoCount + ' photo' + (photoCount === 1 ? '' : 's')}
                          style={{
                            flexShrink: 0,
                            fontSize: 10,
                            padding: '1px 6px',
                            borderRadius: 3,
                            fontWeight: 700,
                            background: '#f3f4f6',
                            color: '#374151',
                            border: '1px solid #e5e7eb',
                          }}
                        >
                          📷 {photoCount}
                        </span>
                      )}
                      {noteText && (
                        <span
                          style={{
                            fontStyle: 'italic',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            minWidth: 0,
                          }}
                        >
                          {noteText}
                        </span>
                      )}
                      {!noteText && chips.length === 0 && photoCount === 0 && <span>—</span>}
                    </div>
                  </div>
                  {isExp && (
                    <div
                      style={{
                        background: '#fafafa',
                        padding: '12px 14px',
                        borderTop: '1px solid #f3f4f6',
                        fontSize: 11,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          color: '#9ca3af',
                          textTransform: 'uppercase',
                          letterSpacing: 0.4,
                          fontWeight: 600,
                          marginBottom: 8,
                        }}
                      >
                        Edit entry (auto-saves)
                      </div>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                          gap: 8,
                          marginBottom: 10,
                        }}
                      >
                        <div>
                          <div style={{fontSize: 10, color: '#9ca3af'}}>Date</div>
                          <input
                            type="date"
                            defaultValue={f.date || ''}
                            onChange={(e) => queueFuelingSave(f.id, 'date', e.target.value, 'text')}
                            onBlur={() => flushFuelingFieldSave(f.id, 'date')}
                            style={recordControl}
                          />
                        </div>
                        <div>
                          <div style={{fontSize: 10, color: '#9ca3af'}}>Team</div>
                          {React.createElement(LockedTeamMemberField, {
                            value: f.team_member || '',
                            label: null,
                            style: recordControl,
                          })}
                        </div>
                        <div>
                          <div style={{fontSize: 10, color: '#9ca3af'}}>Gallons</div>
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            defaultValue={f.gallons != null ? f.gallons : ''}
                            onChange={(e) => queueFuelingSave(f.id, 'gallons', e.target.value, 'number')}
                            onBlur={() => flushFuelingFieldSave(f.id, 'gallons')}
                            style={recordControl}
                          />
                        </div>
                        {eq.takes_def && (
                          <div>
                            <div style={{fontSize: 10, color: '#9ca3af'}}>DEF gallons</div>
                            <input
                              type="number"
                              min="0"
                              step="0.1"
                              defaultValue={f.def_gallons != null ? f.def_gallons : ''}
                              onChange={(e) => queueFuelingSave(f.id, 'def_gallons', e.target.value, 'number')}
                              onBlur={() => flushFuelingFieldSave(f.id, 'def_gallons')}
                              style={recordControl}
                            />
                          </div>
                        )}
                        <div>
                          <div style={{fontSize: 10, color: '#9ca3af'}}>{readingLabel}</div>
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            defaultValue={eq.tracking_unit === 'km' ? f.km_reading || '' : f.hours_reading || ''}
                            onChange={(e) =>
                              queueFuelingSave(
                                f.id,
                                eq.tracking_unit === 'km' ? 'km_reading' : 'hours_reading',
                                e.target.value,
                                'number',
                              )
                            }
                            onBlur={() =>
                              flushFuelingFieldSave(f.id, eq.tracking_unit === 'km' ? 'km_reading' : 'hours_reading')
                            }
                            style={recordControl}
                          />
                        </div>
                      </div>
                      <div style={{marginBottom: 10}}>
                        <div style={{fontSize: 10, color: '#9ca3af'}}>Comments</div>
                        <textarea
                          defaultValue={stripPodioHtml(f.comments) || ''}
                          onChange={(e) => queueFuelingSave(f.id, 'comments', e.target.value, 'text')}
                          onBlur={() => flushFuelingFieldSave(f.id, 'comments')}
                          rows={2}
                          style={{...recordTextarea, minHeight: 60}}
                        />
                      </div>
                      {(() => {
                        const allFillupItems = Array.isArray(eq.every_fillup_items) ? eq.every_fillup_items : [];
                        const tickedIds = new Set(
                          (Array.isArray(f.every_fillup_check) ? f.every_fillup_check : [])
                            .map((c) => c && c.id)
                            .filter(Boolean),
                        );
                        // Show every configured item, plus any historic ticks for items that have since been removed from the equipment config.
                        const knownIds = new Set(allFillupItems.map((i) => i.id));
                        const orphanTicked = (Array.isArray(f.every_fillup_check) ? f.every_fillup_check : []).filter(
                          (c) => c && c.id && !knownIds.has(c.id),
                        );
                        if (allFillupItems.length === 0 && orphanTicked.length === 0) return null;
                        return (
                          <div style={{marginBottom: 10}}>
                            <div style={{fontSize: 11, fontWeight: 700, color: '#065f46', marginBottom: 4}}>
                              Every fuel fill up checklist{' '}
                              <span style={{color: '#6b7280', fontWeight: 500, fontSize: 10, marginLeft: 6}}>
                                {tickedIds.size}/{allFillupItems.length} ticked · click to toggle
                              </span>
                            </div>
                            <div style={{display: 'flex', flexWrap: 'wrap', gap: 4}}>
                              {allFillupItems.map((item) => {
                                const ticked = tickedIds.has(item.id);
                                return (
                                  <button
                                    key={item.id}
                                    onClick={() => toggleFillupItem(f, item)}
                                    style={{
                                      fontSize: 10,
                                      padding: '3px 8px',
                                      borderRadius: 4,
                                      fontFamily: 'inherit',
                                      cursor: 'pointer',
                                      background: ticked ? '#d1fae5' : 'white',
                                      color: ticked ? '#065f46' : '#9ca3af',
                                      border: '1px solid ' + (ticked ? '#a7f3d0' : '#e5e7eb'),
                                      textDecoration: ticked ? 'none' : 'line-through',
                                    }}
                                  >
                                    {ticked ? '✓ ' : ''}
                                    {item.label}
                                  </button>
                                );
                              })}
                              {orphanTicked.map((c) => (
                                <span
                                  key={c.id}
                                  title="Ticked at the time but item has since been removed from the equipment config"
                                  style={{
                                    fontSize: 10,
                                    padding: '3px 8px',
                                    borderRadius: 4,
                                    background: '#f3f4f6',
                                    color: '#6b7280',
                                    border: '1px dashed #d1d5db',
                                  }}
                                >
                                  ✓ {c.label || c.id} <span style={{fontStyle: 'italic', opacity: 0.7}}>(removed)</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                      {(f.service_intervals_completed || []).length > 0 && (
                        <div style={{marginBottom: 10}}>
                          {f.service_intervals_completed.map((c, i) => {
                            // Resolve to current config so we can show ALL tasks
                            // (ticked + missing) and let admin tick the missing
                            // ones after the fact.
                            const iv = c.attachment_name
                              ? (eq.attachment_checklists || []).find(
                                  (a) =>
                                    a.name === c.attachment_name && a.kind === c.kind && a.hours_or_km === c.interval,
                                )
                              : (eq.service_intervals || []).find(
                                  (x) => x.kind === c.kind && x.hours_or_km === c.interval,
                                );
                            const allTasks = iv && Array.isArray(iv.tasks) ? iv.tasks : [];
                            const items = Array.isArray(c.items_completed) ? c.items_completed : [];
                            const tickedSet = new Set(items);
                            const totalNow = allTasks.length || c.total_tasks || 0;
                            const isFull = totalNow > 0 && items.length >= totalNow;
                            const knownIds = new Set(allTasks.map((t) => t.id));
                            const orphanIds = items.filter((id) => !knownIds.has(id));
                            return (
                              <div
                                key={i}
                                style={{
                                  marginBottom: 8,
                                  padding: '8px 10px',
                                  background: 'white',
                                  border: '1px solid ' + (isFull ? '#bfdbfe' : '#fde68a'),
                                  borderRadius: 6,
                                }}
                              >
                                <div
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 700,
                                    color: isFull ? '#1e40af' : '#92400e',
                                    marginBottom: 4,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                  }}
                                >
                                  <span style={{flex: 1}}>
                                    {c.attachment_name ? c.attachment_name + ' — ' : ''}
                                    {c.label || c.interval + c.kind.charAt(0)}
                                    <span style={{fontSize: 10, fontWeight: 500, marginLeft: 8, color: '#6b7280'}}>
                                      {items.length}/{totalNow} tasks{' '}
                                      {isFull ? '· full' : items.length > 0 ? '· partial' : ''} · click to toggle
                                    </span>
                                  </span>
                                  <button
                                    onClick={() => deleteIntervalEntry(rawF, i)}
                                    title="Remove this interval entry from this fueling row"
                                    style={{
                                      flexShrink: 0,
                                      padding: '2px 8px',
                                      borderRadius: 4,
                                      border: '1px solid #fecaca',
                                      background: 'white',
                                      color: '#b91c1c',
                                      fontSize: 10,
                                      fontFamily: 'inherit',
                                      fontWeight: 600,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    ✕ Remove
                                  </button>
                                </div>
                                {(allTasks.length > 0 || orphanIds.length > 0) && (
                                  <div style={{display: 'flex', flexWrap: 'wrap', gap: 4}}>
                                    {allTasks.map((t) => {
                                      const ticked = tickedSet.has(t.id);
                                      return (
                                        <button
                                          key={t.id}
                                          onClick={() => toggleIntervalTask(f, i, t.id, allTasks)}
                                          style={{
                                            fontSize: 10,
                                            padding: '3px 8px',
                                            borderRadius: 4,
                                            fontFamily: 'inherit',
                                            cursor: 'pointer',
                                            background: ticked ? '#eff6ff' : 'white',
                                            color: ticked ? '#1e40af' : '#9ca3af',
                                            border: '1px solid ' + (ticked ? '#bfdbfe' : '#fde68a'),
                                            textDecoration: ticked ? 'none' : 'line-through',
                                          }}
                                        >
                                          {ticked ? '✓ ' : ''}
                                          {t.label}
                                        </button>
                                      );
                                    })}
                                    {orphanIds.map((id) => (
                                      <span
                                        key={id}
                                        title="Ticked at the time but task has since been removed from the equipment config"
                                        style={{
                                          fontSize: 10,
                                          padding: '3px 8px',
                                          borderRadius: 4,
                                          background: '#f3f4f6',
                                          color: '#6b7280',
                                          border: '1px dashed #d1d5db',
                                        }}
                                      >
                                        ✓ {id} <span style={{fontStyle: 'italic', opacity: 0.7}}>(removed)</span>
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {Array.isArray(f.photos) && f.photos.length > 0 && (
                        <div style={{marginBottom: 10}}>
                          <div style={{fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4}}>
                            Photos ({f.photos.length})
                          </div>
                          <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
                            {f.photos.map((p, i) => (
                              <button
                                key={i}
                                onClick={() => setLightbox({photos: f.photos, index: i})}
                                title={p.name || ''}
                                style={{padding: 0, border: 'none', background: 'transparent', cursor: 'pointer'}}
                              >
                                <img
                                  src={p.url}
                                  alt={imageAltText(p.name, {
                                    fallback: 'Fueling photo',
                                    index: i,
                                    total: f.photos.length,
                                  })}
                                  style={{
                                    width: 90,
                                    height: 90,
                                    objectFit: 'cover',
                                    borderRadius: 6,
                                    border: '1px solid #e5e7eb',
                                    cursor: 'pointer',
                                  }}
                                />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      <div style={{display: 'flex', justifyContent: 'flex-end', marginTop: 8}}>
                        <button
                          onClick={() => deleteFueling(f.id)}
                          style={{
                            padding: '4px 10px',
                            borderRadius: 5,
                            border: '1px solid #fecaca',
                            background: 'white',
                            color: '#b91c1c',
                            fontSize: 11,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          Delete entry
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {sortedFuelings.length > 100 && (
              <div
                style={{
                  padding: '8px 12px',
                  background: '#f9fafb',
                  color: '#9ca3af',
                  fontSize: 11,
                  textAlign: 'center',
                }}
              >
                Showing 100 of {sortedFuelings.length} — use the Fuel Log tab for full history.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Maintenance events (admin only) */}
      {!isEquipmentTech && (
        <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 20px'}}>
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8}}>
            <div style={sectionTitle}>Maintenance Events ({maintenance.length})</div>
            <button
              onClick={() => {
                setEditingMaintenance(null);
                setShowMaintenanceModal(true);
              }}
              style={{
                fontSize: 11,
                color: 'white',
                background: EQUIPMENT_COLOR,
                border: 'none',
                borderRadius: 5,
                padding: '5px 12px',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontWeight: 600,
              }}
            >
              + Add Event
            </button>
          </div>
          {maintenance.length === 0 && (
            <div style={{fontSize: 12, color: '#9ca3af', fontStyle: 'italic'}}>No maintenance events yet.</div>
          )}
          {maintenance.length > 0 && (
            <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
              {maintenance.map((m) => (
                <div
                  key={m.id}
                  style={{background: '#fafafa', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px'}}
                >
                  <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap'}}>
                    <strong style={{fontSize: 13, color: '#111827'}}>{fmt(m.event_date)}</strong>
                    {m.event_type && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '1px 8px',
                          borderRadius: 4,
                          background: '#eff6ff',
                          color: '#1e40af',
                          textTransform: 'uppercase',
                        }}
                      >
                        {m.event_type}
                      </span>
                    )}
                    {m.title && <span style={{fontSize: 12, color: '#374151', fontWeight: 600}}>{m.title}</span>}
                    {m.cost && <span style={{fontSize: 12, color: '#065f46'}}>${Number(m.cost).toLocaleString()}</span>}
                    {m.hours_at_event && (
                      <span style={{fontSize: 11, color: '#6b7280'}}>at {Math.round(m.hours_at_event)}h</span>
                    )}
                    {m.team_member && <span style={{fontSize: 11, color: '#9ca3af'}}>· {m.team_member}</span>}
                    <div style={{marginLeft: 'auto', display: 'flex', gap: 6}}>
                      <button
                        onClick={() => {
                          setEditingMaintenance(m);
                          setShowMaintenanceModal(true);
                        }}
                        style={{
                          fontSize: 11,
                          color: '#1d4ed8',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deleteMaintenance(m.id)}
                        style={{
                          fontSize: 11,
                          color: '#b91c1c',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {m.description && (
                    <div style={{fontSize: 12, color: '#4b5563', whiteSpace: 'pre-wrap'}}>{m.description}</div>
                  )}
                  {Array.isArray(m.photos) && m.photos.length > 0 && (
                    <div style={{marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap'}}>
                      {m.photos.map((p, i) => (
                        <a
                          key={i}
                          href={p.url}
                          target="_blank"
                          rel="noreferrer"
                          title={p.name}
                          style={{display: 'block'}}
                        >
                          <img
                            src={p.url}
                            alt={imageAltText(p.name, {
                              fallback: 'Maintenance event photo',
                              index: i,
                              total: m.photos.length,
                            })}
                            style={{
                              width: 80,
                              height: 80,
                              objectFit: 'cover',
                              borderRadius: 6,
                              border: '1px solid #e5e7eb',
                            }}
                          />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showMaintenanceModal && (
        <EquipmentMaintenanceModal
          sb={sb}
          equipment={eq}
          existing={editingMaintenance}
          authState={authState}
          onClose={() => setShowMaintenanceModal(false)}
          onSaved={() => {
            setShowMaintenanceModal(false);
            onReload();
          }}
        />
      )}

      <RecordCollaborationSection
        sb={sb}
        authState={authState}
        entityType="equipment.item"
        entityId={eq.id}
        entityLabel={eq.name}
        spacing={0}
      />

      {/* Photo lightbox — full-screen viewer with prev/next/close. Esc closes;
          ← → arrow keys navigate; click backdrop to close. */}
      {lightbox &&
        (() => {
          const photos = lightbox.photos || [];
          const cur = photos[lightbox.index] || photos[0];
          if (!cur) {
            setLightbox(null);
            return null;
          }
          const goPrev = (e) => {
            e.stopPropagation();
            setLightbox((lb) => ({...lb, index: (lb.index - 1 + photos.length) % photos.length}));
          };
          const goNext = (e) => {
            e.stopPropagation();
            setLightbox((lb) => ({...lb, index: (lb.index + 1) % photos.length}));
          };
          return (
            <div
              onClick={() => setLightbox(null)}
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,.92)',
                zIndex: 2000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 20,
              }}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setLightbox(null);
                }}
                aria-label="Close"
                style={{
                  position: 'absolute',
                  top: 16,
                  right: 16,
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  border: 'none',
                  background: 'rgba(255,255,255,.15)',
                  color: 'white',
                  fontSize: 22,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                ✕
              </button>
              {photos.length > 1 && (
                <button
                  onClick={goPrev}
                  aria-label="Previous"
                  style={{
                    position: 'absolute',
                    left: 16,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    width: 48,
                    height: 64,
                    borderRadius: 8,
                    border: 'none',
                    background: 'rgba(255,255,255,.12)',
                    color: 'white',
                    fontSize: 28,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  ‹
                </button>
              )}
              <img
                onClick={(e) => e.stopPropagation()}
                src={cur.url}
                alt={imageAltText(cur.name, {fallback: 'Equipment photo', index: lightbox.index, total: photos.length})}
                style={{
                  maxWidth: '100%',
                  maxHeight: 'calc(100vh - 80px)',
                  objectFit: 'contain',
                  borderRadius: 6,
                  boxShadow: '0 10px 40px rgba(0,0,0,.4)',
                }}
              />
              {photos.length > 1 && (
                <button
                  onClick={goNext}
                  aria-label="Next"
                  style={{
                    position: 'absolute',
                    right: 16,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    width: 48,
                    height: 64,
                    borderRadius: 8,
                    border: 'none',
                    background: 'rgba(255,255,255,.12)',
                    color: 'white',
                    fontSize: 28,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  ›
                </button>
              )}
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  bottom: 16,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: 'rgba(0,0,0,.65)',
                  color: 'white',
                  padding: '8px 16px',
                  borderRadius: 8,
                  fontSize: 12,
                  maxWidth: '80%',
                  textAlign: 'center',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{opacity: 0.7}}>
                  {lightbox.index + 1} / {photos.length}
                </span>
                {cur.name && <> · {cur.name}</>}
                {' · '}
                <a
                  href={cur.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{color: '#93c5fd'}}
                  onClick={(e) => e.stopPropagation()}
                >
                  Open in new tab
                </a>
              </div>
            </div>
          );
        })()}
    </RecordPageBody>
  );
}

function StatTile({label, value, color}) {
  return (
    <div>
      <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4}}>{label}</div>
      <div style={{fontSize: 16, fontWeight: 700, color: color}}>{value}</div>
    </div>
  );
}
