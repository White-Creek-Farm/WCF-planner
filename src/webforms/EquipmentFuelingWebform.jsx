// EquipmentFuelingWebform — per-equipment form rendered at /fueling/<slug>.
// Also handles the /fueling/quick variant: pass equipment=null + the full
// equipment list, and the form adds an equipment-picker at the top.
//
// Writes one equipment_fuelings row. Fuel type is hardcoded per piece
// (not a dropdown). DEF gallons is a separate field shown only when the
// equipment has takes_def=true. Service intervals surface only when they
// are actually due given the reading the team just entered + history.
import React from 'react';
import {computeDueIntervals} from '../lib/equipment.js';
import {todayCentralISO} from '../lib/dateUtils.js';
import {useOfflineRpcSubmit} from '../lib/useOfflineRpcSubmit.js';
import ManualsCard from '../equipment/ManualsCard.jsx';
import LockedSubmitter from './LockedSubmitter.jsx';
import StuckSubmissionsModal from './StuckSubmissionsModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';
import {imageAltText} from '../lib/imageAlt.js';

export default function EquipmentFuelingWebform({sb, equipment, equipmentList, onBack, sessionSubmitter}) {
  // Lane 1 CP1: on the authenticated path the submitter is the signed-in user,
  // locked. No roster dropdown, no per-equipment operator filtering.
  const lockedName = sessionSubmitter?.name || '';
  const isQuick = !equipment;
  const [selectedEq, setSelectedEq] = React.useState(equipment || null);
  const [teamMember, setTeamMember] = React.useState(sessionSubmitter?.name || '');
  const [date, setDate] = React.useState(() => todayCentralISO());
  const [gallons, setGallons] = React.useState('');
  const [defGallons, setDefGallons] = React.useState('');
  const [reading, setReading] = React.useState('');
  const [fillupTicks, setFillupTicks] = React.useState(new Set());
  const [intervalTicks, setIntervalTicks] = React.useState(new Set()); // keys 'kind:value'
  // Per-interval task ticks: Map<'kind:value', Set<taskId>>
  const [taskTicks, setTaskTicks] = React.useState({});
  // Attachment-checklist ticks: Map<'name:kind:value', Set<taskId>>
  const [attachmentTicks, setAttachmentTicks] = React.useState({});
  const [photos, setPhotos] = React.useState([]);
  const [uploadingPhoto, setUploadingPhoto] = React.useState(false);
  const [comments, setComments] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  // 'none' | 'synced' | 'queued' — replaces the prior boolean `done`.
  // synced = RPC landed online. queued = persisted in IDB; replays on
  // online event / 60s tick / next mount.
  const [doneState, setDoneState] = React.useState('none');
  const [stuckOpen, setStuckOpen] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [history, setHistory] = React.useState([]); // prior fuelings on this piece (for due-interval math)

  // Lane H: submit through the parent-aware offline RPC queue. The RPC owns
  // idempotency (csid) + the atomic insert+parent-bump (mig 047). Network /
  // transient failures queue to IndexedDB and replay automatically; 3 failed
  // replays surface in StuckSubmissionsModal.
  const {submit: queueSubmit, stuckRows, retryStuck, discardStuck} = useOfflineRpcSubmit('equipment_fueling');

  // Open the stuck modal automatically the first time we observe stuck rows
  // (mount or after a failed sync pass). Operator can close it; we don't
  // re-open on every render. Mirrors FuelSupply / AddFeed.
  const initialStuckShownRef = React.useRef(false);
  React.useEffect(() => {
    if (stuckRows.length > 0 && !initialStuckShownRef.current) {
      initialStuckShownRef.current = true;
      setStuckOpen(true);
    }
  }, [stuckRows.length]);

  const eq = selectedEq;
  const fuelLabel = eq?.fuel_type === 'gasoline' ? 'Gasoline' : eq?.fuel_type === 'diesel' ? 'Diesel' : 'Fuel';
  const readingLabel = eq?.tracking_unit === 'km' ? 'KM' : 'Hours';

  // The submitter is the signed-in user, not a per-equipment roster choice.
  React.useEffect(() => {
    if (teamMember !== lockedName) setTeamMember(lockedName);
  }, [lockedName, teamMember]);

  // Load this piece's fueling history to compute due intervals.
  React.useEffect(() => {
    if (!eq) {
      setHistory([]);
      return;
    }
    sb.from('equipment_fuelings')
      .select('date,team_member,hours_reading,km_reading,service_intervals_completed,every_fillup_check')
      .eq('equipment_id', eq.id)
      .order('date', {ascending: false})
      .limit(500)
      .then(({data}) => {
        if (data) setHistory(data);
      });
  }, [eq]);

  // Build the completions list with reading_at_completion + team_member baked
  // in for the due-interval math (team_member is surfaced on partial rows so
  // the operator knows who left items unfinished).
  const completions = React.useMemo(() => {
    const out = [];
    for (const h of history) {
      const snap =
        h.hours_reading != null ? Number(h.hours_reading) : h.km_reading != null ? Number(h.km_reading) : null;
      if (snap == null) continue;
      for (const c of h.service_intervals_completed || []) {
        out.push({...c, reading_at_completion: snap, team_member: h.team_member || null});
      }
    }
    return out;
  }, [history]);

  const readingNum = parseFloat(reading);
  const hasReading = Number.isFinite(readingNum) && readingNum > 0;
  const dueIntervals = React.useMemo(() => {
    if (!eq || !hasReading) return [];
    return computeDueIntervals(eq.service_intervals || [], completions, readingNum);
  }, [eq, completions, readingNum, hasReading]);

  // Every-fillup miss streaks. For each every_fillup_items[].id, count
  // consecutive prior fuelings (ordered by reading desc, falling back to
  // date) where the item was NOT in every_fillup_check. As soon as a prior
  // fueling DID tick the item, the streak ends. Time/calendar dates do not
  // factor into the math — this is purely "how many sequential fuelings,
  // most recent first, lacked this item." Display only includes the oldest
  // miss's reading + operator name as context.
  const fillupStreaks = React.useMemo(() => {
    const out = new Map(); // itemId -> {count, oldest:{reading, name, date}}
    if (!eq) return out;
    const items = Array.isArray(eq.every_fillup_items) ? eq.every_fillup_items : [];
    if (items.length === 0) return out;
    // Build prior-fuelings list. Order by reading desc; if reading missing,
    // fall back to date. Newest first.
    const sorted = (history || []).slice().sort((a, b) => {
      const ra = a.hours_reading != null ? Number(a.hours_reading) : a.km_reading != null ? Number(a.km_reading) : null;
      const rb = b.hours_reading != null ? Number(b.hours_reading) : b.km_reading != null ? Number(b.km_reading) : null;
      if (ra != null && rb != null && ra !== rb) return rb - ra;
      return String(b.date || '').localeCompare(String(a.date || ''));
    });
    for (const item of items) {
      let count = 0;
      let oldest = null;
      for (const h of sorted) {
        const ticks = Array.isArray(h.every_fillup_check) ? h.every_fillup_check : [];
        const wasTicked = ticks.some((t) => t && t.id === item.id);
        if (wasTicked) break;
        count++;
        const r =
          h.hours_reading != null ? Number(h.hours_reading) : h.km_reading != null ? Number(h.km_reading) : null;
        oldest = {reading: r, name: h.team_member || null, date: h.date || null};
      }
      if (count > 0) out.set(item.id, {count, oldest});
    }
    return out;
  }, [eq, history]);

  function toggleFillup(id) {
    const next = new Set(fillupTicks);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFillupTicks(next);
  }
  function toggleInterval(kind, value) {
    const k = kind + ':' + value;
    const next = new Set(intervalTicks);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setIntervalTicks(next);
  }
  function toggleTask(intervalKey, taskId) {
    setTaskTicks((prev) => {
      const current = new Set(prev[intervalKey] || []);
      if (current.has(taskId)) current.delete(taskId);
      else current.add(taskId);
      return {...prev, [intervalKey]: current};
    });
  }
  function toggleAttachmentTask(attachmentKey, taskId) {
    setAttachmentTicks((prev) => {
      const current = new Set(prev[attachmentKey] || []);
      if (current.has(taskId)) current.delete(taskId);
      else current.add(taskId);
      return {...prev, [attachmentKey]: current};
    });
  }
  async function uploadPhoto(file) {
    if (!eq) return;
    setUploadingPhoto(true);
    const safe = (file.name || 'photo').replace(/[^a-zA-Z0-9._-]/g, '_');
    const pathInBucket = 'fueling/' + eq.slug + '/' + Date.now() + '-' + safe;
    const {error: upErr} = await sb.storage
      .from('equipment-maintenance-docs')
      .upload(pathInBucket, file, {upsert: false});
    if (upErr) {
      setErr('Photo upload failed: ' + upErr.message);
      setUploadingPhoto(false);
      return;
    }
    const {data: pub} = sb.storage.from('equipment-maintenance-docs').getPublicUrl(pathInBucket);
    setPhotos((p) => [
      ...p,
      {name: file.name, path: pathInBucket, url: pub.publicUrl, uploadedAt: new Date().toISOString()},
    ]);
    setUploadingPhoto(false);
  }
  async function removePhoto(idx) {
    const p = photos[idx];
    if (p && p.path) {
      try {
        await sb.storage.from('equipment-maintenance-docs').remove([p.path]);
      } catch (_e) {
        /* best-effort storage cleanup */
      }
    }
    setPhotos((arr) => arr.filter((_, i) => i !== idx));
  }
  // If the team ticks a big interval, the divisor rule implicitly covers
  // any smaller due interval that divides it. Surface this visually.
  function isImplicitlyCompleted(kind, value) {
    if (!eq) return false;
    if (intervalTicks.has(kind + ':' + value)) return false;
    for (const iv of dueIntervals) {
      if (iv.kind !== kind) continue;
      if (iv.hours_or_km === value) continue;
      if (intervalTicks.has(iv.kind + ':' + iv.hours_or_km) && iv.hours_or_km % value === 0) return true;
    }
    return false;
  }

  async function submit() {
    setErr('');
    if (!eq) {
      setErr('Pick equipment.');
      return;
    }
    if (!teamMember) {
      setErr('Pick a team member.');
      return;
    }
    if (!date) {
      setErr('Date required.');
      return;
    }
    if (!gallons || parseFloat(gallons) <= 0) {
      setErr(fuelLabel + ' gallons required.');
      return;
    }
    // Reading required — the RPC rejects a missing/zero reading and the
    // parent equipment row needs it to advance via the GREATEST update.
    if (!hasReading) {
      setErr('Current ' + readingLabel + ' required.');
      return;
    }

    // Check Oil enforcement: every non-ATV, non-Toro piece must have its
    // oil-check ticked before the submit goes through. "Oil" match is broad
    // so "CHECK OIL" and "CHECK ENGINE OIL LEVEL" both count.
    const exemptFromOil = eq.category === 'atvs' || eq.slug === 'toro';
    if (!exemptFromOil) {
      const items = Array.isArray(eq.every_fillup_items) ? eq.every_fillup_items : [];
      const oilItem = items.find((it) => /oil/i.test(it.label || ''));
      if (oilItem && !fillupTicks.has(oilItem.id)) {
        setErr('"' + oilItem.label + '" must be ticked before submitting.');
        return;
      }
    }
    // Build service_intervals_completed. Each due interval may contribute a
    // completion if either (a) the parent box was ticked, OR (b) any of
    // its sub-tasks were ticked. Record which task ids were ticked so the
    // due-interval math can decide "full vs partial."
    const completed = [];
    const fullyDoneExplicit = new Set(); // intervals that had ALL tasks ticked
    for (const iv of dueIntervals) {
      const key = iv.kind + ':' + iv.hours_or_km;
      const ticks = taskTicks[key] instanceof Set ? taskTicks[key] : new Set();
      const parentTicked = intervalTicks.has(key);
      const tasks = Array.isArray(iv.tasks) ? iv.tasks : [];
      const items = Array.from(ticks);
      const fullyDone = tasks.length === 0 ? parentTicked : tasks.length > 0 && items.length >= tasks.length;
      if (!parentTicked && items.length === 0) continue; // nothing ticked for this interval
      completed.push({
        interval: iv.hours_or_km,
        kind: iv.kind,
        label: iv.label,
        completed_at: date,
        items_completed: items,
        total_tasks: tasks.length,
      });
      if (fullyDone) fullyDoneExplicit.add(key);
    }
    // Divisor rule: a fully-done big interval also counts as fully-done for
    // any smaller interval it divides (e.g. 1000h fully done → 500/250/100
    // also marked done at the same reading).
    for (const key of fullyDoneExplicit) {
      const [kind, vStr] = key.split(':');
      const v = parseInt(vStr, 10);
      for (const iv of eq.service_intervals || []) {
        if (iv.kind !== kind) continue;
        if (iv.hours_or_km === v) continue;
        if (v % iv.hours_or_km !== 0) continue;
        const kk = iv.kind + ':' + iv.hours_or_km;
        if (fullyDoneExplicit.has(kk)) continue;
        const subTasks = Array.isArray(iv.tasks) ? iv.tasks : [];
        completed.push({
          interval: iv.hours_or_km,
          kind: iv.kind,
          label: iv.label,
          completed_at: date,
          auto_from: v,
          items_completed: subTasks.map((t) => t.id),
          total_tasks: subTasks.length,
        });
      }
    }

    // Attachment completions — stored in service_intervals_completed with an
    // attachment_name key so the dashboard can distinguish from main intervals.
    for (const a of eq.attachment_checklists || []) {
      const key = a.name + ':' + a.kind + ':' + a.hours_or_km;
      const ticks = attachmentTicks[key] instanceof Set ? attachmentTicks[key] : new Set();
      if (ticks.size === 0) continue;
      completed.push({
        interval: a.hours_or_km,
        kind: a.kind,
        label: a.label,
        attachment_name: a.name,
        completed_at: date,
        items_completed: Array.from(ticks),
        total_tasks: (a.tasks || []).length,
      });
    }

    const fillup = Array.from(fillupTicks).map((id) => {
      const item = (eq.every_fillup_items || []).find((x) => x.id === id);
      return {id, label: item?.label || id, ok: true};
    });

    const defNum = parseFloat(defGallons);
    // Mig 047 SECURITY DEFINER RPC, reached through useOfflineRpcSubmit. The
    // RPC INSERTs the equipment_fuelings row AND updates
    // equipment.current_<unit> atomically with anon EXECUTE — the prior
    // pattern (synchronous .insert + silent .update on equipment) was broken
    // under prod RLS because anon has no UPDATE policy on equipment; the
    // parent row drifted behind every public submission. The RPC's
    // GREATEST/only-go-forward semantic means a submission can only raise
    // current_<unit> — admin corrections downward still go through the
    // authenticated /fleet detail page.
    //
    // The hook mints a stable client_submission_id + parent id once at
    // submit() entry and persists them, so an offline-queued retry replays
    // byte-identical args (the registry's buildArgs is pure over this
    // payload). We pass the fully-computed record minus identity; the
    // registry stamps id + csid.
    const payload = {
      equipment_id: eq.id,
      date,
      team_member: teamMember,
      fuel_type: eq.fuel_type || null,
      gallons: parseFloat(gallons),
      def_gallons: Number.isFinite(defNum) && defNum > 0 ? defNum : null,
      fuel_cost_per_gal: null,
      hours_reading: eq.tracking_unit === 'hours' ? readingNum : null,
      km_reading: eq.tracking_unit === 'km' ? readingNum : null,
      every_fillup_check: fillup,
      service_intervals_completed: completed,
      photos,
      comments: comments || null,
      source: 'fuel_log_webform',
      podio_source_app: null,
    };
    setSubmitting(true);
    try {
      const result = await queueSubmit(payload);
      setDoneState(result.state);
    } catch (e) {
      // Schema/validation error — useOfflineRpcSubmit throws on PGRST/22*/23*/
      // P0001 instead of silently queuing a deterministically-bad submission.
      setErr('Save failed: ' + (e && e.message ? e.message : String(e)));
    } finally {
      setSubmitting(false);
    }
  }

  const wfBg = {
    minHeight: '100vh',
    background: 'linear-gradient(135deg,#fafaf9 0%,#e7e5e4 100%)',
    padding: '1rem',
    fontFamily: 'inherit',
  };
  const cardS = {
    background: 'white',
    borderRadius: 12,
    padding: '18px 20px',
    marginBottom: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,.08)',
  };
  const inpS = {
    fontFamily: 'inherit',
    fontSize: 14,
    padding: '10px 12px',
    border: '1px solid #d1d5db',
    borderRadius: 8,
    width: '100%',
    outline: 'none',
    background: 'white',
    color: '#111827',
    boxSizing: 'border-box',
  };
  const lblS = {
    display: 'block',
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 5,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  };
  const logoEl = (
    <div style={{textAlign: 'center', marginBottom: 20}}>
      <div
        style={{
          fontSize: 18,
          fontWeight: 800,
          color: '#57534e',
          letterSpacing: -0.3,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <PlannerIcon iconKey="fueling" size={22} />
        <span>WCF Planner</span>
      </div>
      <div style={{fontSize: 12, color: '#6b7280', marginTop: 2}}>Fueling Log</div>
    </div>
  );

  if (doneState !== 'none') {
    const queued = doneState === 'queued';
    return (
      <div style={wfBg}>
        <div
          data-submit-state={doneState}
          style={{maxWidth: 480, margin: '0 auto', paddingTop: '2rem', textAlign: 'center'}}
        >
          {logoEl}
          <div style={{fontSize: 56, marginBottom: 12}}>{queued ? '📡' : '✅'}</div>
          <div style={{fontSize: 20, fontWeight: 700, color: queued ? '#92400e' : '#57534e', marginBottom: 8}}>
            {queued ? 'Saved on this device' : 'Fueling saved'}
          </div>
          <div style={{fontSize: 14, color: '#4b5563', marginBottom: queued ? 12 : 28}}>
            {eq ? eq.name : ''} · {gallons} gal {fuelLabel}
            {defGallons ? ' + ' + defGallons + ' gal DEF' : ''}
          </div>
          {queued && (
            <div
              style={{
                fontSize: 12,
                color: '#78716c',
                marginBottom: 28,
                lineHeight: 1.5,
                background: '#fef3c7',
                border: '1px solid #fde68a',
                borderRadius: 8,
                padding: '8px 12px',
                textAlign: 'left',
              }}
            >
              No connection right now. Your fueling is queued and will sync as soon as the device is back online. The
              equipment reading updates once it syncs.
            </div>
          )}
          <button
            onClick={() => {
              if (isQuick) setSelectedEq(null);
              setDoneState('none');
              setGallons('');
              setDefGallons('');
              setReading('');
              setComments('');
              setFillupTicks(new Set());
              setIntervalTicks(new Set());
            }}
            style={{
              width: '100%',
              padding: 14,
              borderRadius: 10,
              border: 'none',
              background: '#57534e',
              color: 'white',
              fontSize: 15,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              marginBottom: 10,
            }}
          >
            Log Another
          </button>
          <button
            onClick={onBack}
            style={{
              width: '100%',
              padding: 14,
              borderRadius: 10,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#374151',
              fontSize: 15,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Back to Hub
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={wfBg}>
      <div style={{maxWidth: 520, margin: '0 auto', paddingTop: '1rem'}}>
        {logoEl}
        <button
          onClick={onBack}
          style={{
            background: 'none',
            border: 'none',
            color: '#57534e',
            fontSize: 13,
            cursor: 'pointer',
            marginBottom: 12,
            padding: 0,
            fontFamily: 'inherit',
          }}
        >
          {'‹ Back'}
        </button>

        {stuckRows.length > 0 && (
          <button
            onClick={() => setStuckOpen(true)}
            data-stuck-button="1"
            style={{
              width: '100%',
              padding: '10px 14px',
              borderRadius: 10,
              border: '1px solid #fde68a',
              background: '#fef3c7',
              color: '#92400e',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              marginBottom: 12,
              textAlign: 'left',
            }}
          >
            ⚠ {stuckRows.length} unsynced fueling{stuckRows.length === 1 ? '' : 's'} — tap to review
          </button>
        )}

        {/* Header tile: what piece am I fueling? */}
        <div style={cardS}>
          {isQuick && (
            <div style={{marginBottom: 12}}>
              <label style={lblS}>Equipment *</label>
              <select
                value={eq?.id || ''}
                onChange={(e) => {
                  const found = (equipmentList || []).find((x) => x.id === e.target.value);
                  setSelectedEq(found || null);
                }}
                style={inpS}
              >
                <option value="">Select equipment...</option>
                {(equipmentList || []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {eq &&
            !isQuick &&
            (() => {
              const lastFueling = (history || []).find((h) => h.hours_reading != null || h.km_reading != null);
              const lastReadingNum = lastFueling
                ? eq.tracking_unit === 'km'
                  ? lastFueling.km_reading
                  : lastFueling.hours_reading
                : null;
              const lastUnit = eq.tracking_unit === 'km' ? 'km' : 'h';
              const fmtDate = (s) => {
                if (!s) return '';
                const [y, m, d] = String(s).slice(0, 10).split('-');
                return `${m}/${d}/${y.slice(2)}`;
              };
              return (
                <div>
                  <div style={{fontSize: 18, fontWeight: 700, color: '#57534e'}}>{eq.name}</div>
                  <div style={{fontSize: 12, color: '#6b7280', marginTop: 2}}>
                    {eq.fuel_type ? eq.fuel_type.charAt(0).toUpperCase() + eq.fuel_type.slice(1) : ''}
                    {eq.takes_def ? ' + DEF' : ''} · tracks {readingLabel}
                  </div>
                  {lastReadingNum != null && (
                    <div style={{fontSize: 12, color: '#1e40af', marginTop: 6, fontWeight: 600}}>
                      Last reading: {Number(lastReadingNum).toLocaleString()} {lastUnit}
                      {lastFueling.team_member ? ` · ${lastFueling.team_member}` : ''}
                      {lastFueling.date ? ` · ${fmtDate(lastFueling.date)}` : ''}
                    </div>
                  )}
                </div>
              );
            })()}
        </div>

        {/* Top-of-form operator notes (between-fillup maintenance guidance). */}
        {eq && eq.operator_notes && (
          <div style={{...cardS, background: '#fffbeb', borderColor: '#fde68a'}}>
            <div style={{fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 6}}>⚠ Operator note</div>
            <div style={{fontSize: 12, color: '#78716c', whiteSpace: 'pre-wrap', fontStyle: 'italic'}}>
              {eq.operator_notes}
            </div>
          </div>
        )}

        {/* Expandable Manuals & Videos card — reference materials for operators. */}
        <ManualsCard equipment={eq} />

        {/* Date + Team Member on their own rows */}
        <div style={cardS}>
          <div style={{marginBottom: 12}}>
            <label style={lblS}>Date *</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inpS} />
          </div>
          <div>
            <LockedSubmitter name={lockedName} label="Team member" labelStyle={lblS} />
          </div>
        </div>

        {/* Fuel + DEF (per-piece, not a dropdown). */}
        {eq && eq.fuel_type && (
          <div style={cardS}>
            <div style={{marginBottom: 12}}>
              <label style={lblS}>{fuelLabel} gallons *</label>
              <input
                type="number"
                min="0"
                step="0.1"
                value={gallons}
                onChange={(e) => setGallons(e.target.value)}
                placeholder="0"
                style={inpS}
              />
              {eq.fuel_gallons_help && (
                <div
                  style={{
                    fontSize: 11,
                    color: '#78716c',
                    marginTop: 6,
                    fontStyle: 'italic',
                    background: '#fffbeb',
                    border: '1px solid #fde68a',
                    borderRadius: 5,
                    padding: '6px 8px',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {eq.fuel_gallons_help}
                </div>
              )}
            </div>
            {eq.takes_def && (
              <div>
                <label style={lblS}>DEF gallons</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={defGallons}
                  onChange={(e) => setDefGallons(e.target.value)}
                  placeholder="0"
                  style={inpS}
                />
              </div>
            )}
          </div>
        )}

        {/* Reading (hours / km). Required for service-interval math. */}
        {eq && (
          <div style={cardS}>
            <label style={lblS}>{readingLabel} *</label>
            <input
              type="number"
              min="0"
              step="0.1"
              value={reading}
              onChange={(e) => setReading(e.target.value)}
              placeholder={'Current ' + readingLabel.toLowerCase()}
              style={inpS}
            />
            <div style={{fontSize: 11, color: '#9ca3af', marginTop: 6}}>
              Every-fillup and service-interval checklists appear below once you enter this.
            </div>
          </div>
        )}

        {/* Every-fillup checks — hidden until the team enters a reading so
            the checklist section doesn't open before we know what to show. */}
        {eq && hasReading && (eq.every_fillup_items || []).length > 0 && (
          <div style={cardS}>
            <div style={{fontSize: 13, fontWeight: 700, color: '#57534e', marginBottom: eq.every_fillup_help ? 4 : 10}}>
              Every-fillup checks
            </div>
            {eq.every_fillup_help && (
              <div
                style={{
                  fontSize: 12,
                  color: '#78716c',
                  background: '#fffbeb',
                  border: '1px solid #fde68a',
                  borderRadius: 6,
                  padding: '8px 10px',
                  marginBottom: 10,
                  fontStyle: 'italic',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {eq.every_fillup_help}
              </div>
            )}
            <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
              {eq.every_fillup_items.map((item) => {
                // Mark oil-check items as required for non-ATV / non-Toro pieces.
                const isOil = /oil/i.test(item.label || '');
                const exemptFromOil = eq.category === 'atvs' || eq.slug === 'toro';
                const required = isOil && !exemptFromOil;
                const unticked = !fillupTicks.has(item.id);
                const needsAttention = required && unticked;
                const bd = needsAttention ? '#fca5a5' : fillupTicks.has(item.id) ? '#a7f3d0' : '#e5e7eb';
                const bg = needsAttention ? '#fef2f2' : fillupTicks.has(item.id) ? '#ecfdf5' : '#f9fafb';
                const streak = fillupStreaks.get(item.id);
                const unitShort = eq.tracking_unit === 'km' ? 'km' : 'h';
                return (
                  <div key={item.id}>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '10px 12px',
                        borderRadius: 6,
                        background: bg,
                        cursor: 'pointer',
                        border: '1px solid ' + bd,
                        fontSize: 13,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={fillupTicks.has(item.id)}
                        onChange={() => toggleFillup(item.id)}
                        style={{
                          margin: 0,
                          flexShrink: 0,
                          width: 18,
                          height: 18,
                          padding: 0,
                          border: '1px solid #d1d5db',
                        }}
                      />
                      <span
                        style={{
                          color: fillupTicks.has(item.id) ? '#065f46' : needsAttention ? '#b91c1c' : '#374151',
                          fontWeight: fillupTicks.has(item.id) ? 600 : needsAttention ? 600 : 500,
                        }}
                      >
                        {item.label}
                        {required && <span style={{color: '#b91c1c', marginLeft: 4}}>*</span>}
                      </span>
                    </label>
                    {streak && streak.count > 0 && !fillupTicks.has(item.id) && (
                      <div
                        style={{
                          margin: '4px 0 2px 30px',
                          fontSize: 11,
                          color: '#92400e',
                          background: '#fffbeb',
                          border: '1px solid #fde68a',
                          borderRadius: 5,
                          padding: '5px 8px',
                        }}
                      >
                        ⚠{' '}
                        <strong>
                          Not done at last {streak.count} fillup{streak.count === 1 ? '' : 's'}
                        </strong>
                        {streak.oldest && streak.oldest.reading != null && (
                          <>
                            {' '}
                            · oldest {streak.oldest.reading.toLocaleString()}
                            {unitShort}
                          </>
                        )}
                        {streak.oldest && streak.oldest.name && <> by {streak.oldest.name}</>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Service intervals — ONLY those that are due given the reading. */}
        {eq &&
          hasReading &&
          dueIntervals.length > 0 &&
          (() => {
            // Most recent full completion across all due intervals — shown in
            // the blurb so the operator sees where the machine last stood.
            const mostRecentFull = dueIntervals
              .filter((iv) => iv.last_done_at)
              .sort((a, b) => (b.last_done_at || 0) - (a.last_done_at || 0))[0];
            return (
              <div style={cardS}>
                <div style={{fontSize: 13, fontWeight: 700, color: '#991b1b', marginBottom: 4}}>⚠ Service due</div>
                <div style={{fontSize: 11, color: '#6b7280', marginBottom: 12}}>
                  Based on {readingLabel.toLowerCase()} {readingNum.toLocaleString()} + prior completions. Tick any
                  service you performed during this fill.
                  {mostRecentFull && (
                    <>
                      {' '}
                      Last {mostRecentFull.hours_or_km}
                      {mostRecentFull.kind === 'km' ? '-km' : '-hour'} checklist done at{' '}
                      {mostRecentFull.last_done_at.toLocaleString()}
                      {mostRecentFull.kind === 'km' ? 'km' : 'h'}.
                    </>
                  )}
                </div>
                <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
                  {dueIntervals.map((iv) => {
                    const k = iv.kind + ':' + iv.hours_or_km;
                    const explicit = intervalTicks.has(k);
                    const implicit = isImplicitlyCompleted(iv.kind, iv.hours_or_km);
                    const tasks = Array.isArray(iv.tasks) ? iv.tasks : [];
                    const ticks = taskTicks[k] instanceof Set ? taskTicks[k] : new Set();
                    const tickedCount = ticks.size;
                    const allTicked = tasks.length > 0 && tickedCount >= tasks.length;
                    const anyTicked = tickedCount > 0;
                    const done = (tasks.length === 0 ? explicit : allTicked) || implicit;
                    const unitShort = iv.kind === 'km' ? 'km' : 'h';
                    return (
                      <div
                        key={k}
                        style={{
                          borderRadius: 8,
                          background: done ? '#eff6ff' : '#fef2f2',
                          border: '1px solid ' + (done ? '#bfdbfe' : '#fca5a5'),
                          padding: '12px 14px',
                        }}
                      >
                        {/* Header line (always shown) */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 10,
                            marginBottom: tasks.length > 0 ? 8 : 0,
                          }}
                        >
                          {tasks.length === 0 && (
                            <input
                              type="checkbox"
                              checked={explicit}
                              disabled={implicit}
                              onChange={() => toggleInterval(iv.kind, iv.hours_or_km)}
                              style={{
                                margin: '3px 0 0',
                                flexShrink: 0,
                                width: 18,
                                height: 18,
                                padding: 0,
                                border: '1px solid #d1d5db',
                              }}
                            />
                          )}
                          <div style={{flex: 1}}>
                            <div style={{fontWeight: 700, color: done ? '#1e40af' : '#991b1b', fontSize: 14}}>
                              {iv.label}
                            </div>
                            <div style={{fontSize: 11, color: '#6b7280', marginTop: 3}}>
                              {iv.missed_count > 1
                                ? `Missed ${iv.missed_count} times since ${iv.first_missed_at.toLocaleString()}${unitShort}`
                                : `Passed ${iv.first_missed_at.toLocaleString()}${unitShort}`}
                              {iv.last_done_at
                                ? ` · last full done at ${iv.last_done_at.toLocaleString()}${unitShort}`
                                : ' · never fully completed'}
                            </div>
                            {iv.last_partial &&
                              (() => {
                                // Only rendered when no full completion exists after this
                                // partial (filtered in computeDueIntervals). Resolve the
                                // ticked-item IDs against current task labels to show
                                // exactly what was missed and by whom.
                                const doneIds = new Set(iv.last_partial.items_completed || []);
                                const missing = (Array.isArray(iv.tasks) ? iv.tasks : []).filter(
                                  (t) => !doneIds.has(t.id),
                                );
                                const who = iv.last_partial.team_member || 'someone';
                                return (
                                  <div
                                    style={{
                                      fontSize: 11,
                                      color: '#92400e',
                                      marginTop: 4,
                                      background: '#fffbeb',
                                      border: '1px solid #fde68a',
                                      borderRadius: 5,
                                      padding: '5px 8px',
                                    }}
                                  >
                                    <strong>
                                      Partial at {iv.last_partial.at_reading.toLocaleString()}
                                      {unitShort}
                                    </strong>{' '}
                                    by {who} — {iv.last_partial.items_done}/{iv.last_partial.total} done.
                                    {missing.length > 0 && (
                                      <>
                                        {' '}
                                        Missing:{' '}
                                        <span style={{fontStyle: 'italic'}}>
                                          {missing.map((m) => m.label).join(', ')}
                                        </span>
                                      </>
                                    )}
                                  </div>
                                );
                              })()}
                            {tasks.length > 0 && (
                              <div
                                style={{
                                  fontSize: 11,
                                  color: tickedCount > 0 ? '#1e40af' : '#991b1b',
                                  marginTop: 4,
                                  fontWeight: 600,
                                }}
                              >
                                {tickedCount} of {tasks.length} tasks ticked
                                {allTicked ? ' · full completion' : anyTicked ? ' · partial (will remain due)' : ''}
                              </div>
                            )}
                          </div>
                        </div>
                        {/* Field-level help text from Podio (torque specs, gap specs, etc.) */}
                        {iv.help_text && (
                          <div
                            style={{
                              fontSize: 11,
                              color: '#78716c',
                              background: '#fffbeb',
                              border: '1px solid #fde68a',
                              borderRadius: 5,
                              padding: '6px 8px',
                              marginBottom: tasks.length > 0 ? 8 : 0,
                              fontStyle: 'italic',
                              whiteSpace: 'pre-wrap',
                            }}
                          >
                            {iv.help_text}
                          </div>
                        )}
                        {/* Sub-task list (when this interval has tasks) */}
                        {tasks.length > 0 && (
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 4,
                              marginLeft: 0,
                              borderTop: '1px solid ' + (done ? '#bfdbfe' : '#fca5a5'),
                              paddingTop: 8,
                            }}
                          >
                            {tasks.map((t) => {
                              const ticked = ticks.has(t.id);
                              return (
                                <label
                                  key={t.id}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'flex-start',
                                    gap: 8,
                                    padding: '6px 8px',
                                    borderRadius: 5,
                                    background: ticked ? '#dcfce7' : 'white',
                                    cursor: implicit ? 'not-allowed' : 'pointer',
                                    fontSize: 12,
                                    opacity: implicit ? 0.6 : 1,
                                  }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={ticked}
                                    disabled={implicit}
                                    onChange={() => toggleTask(k, t.id)}
                                    style={{
                                      margin: '2px 0 0',
                                      flexShrink: 0,
                                      width: 16,
                                      height: 16,
                                      padding: 0,
                                      border: '1px solid #d1d5db',
                                    }}
                                  />
                                  <span style={{color: ticked ? '#065f46' : '#374151', fontWeight: ticked ? 600 : 500}}>
                                    {t.label}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

        {/* Attachment-specific checklists (Ventrac — Tough Cut / AERO-Vator /
            Landscape Rake). Only shown when this piece has attachments and a
            reading is entered. Tick only the attachment you used. */}
        {eq && hasReading && Array.isArray(eq.attachment_checklists) && eq.attachment_checklists.length > 0 && (
          <div style={cardS}>
            <div style={{fontSize: 13, fontWeight: 700, color: '#57534e', marginBottom: 4}}>
              Attachment-specific checklists
            </div>
            <div style={{fontSize: 11, color: '#6b7280', marginBottom: 12}}>
              Only tick tasks for the attachment you actually used this session.
            </div>
            <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
              {eq.attachment_checklists.map((a) => {
                const key = a.name + ':' + a.kind + ':' + a.hours_or_km;
                const ticks = attachmentTicks[key] instanceof Set ? attachmentTicks[key] : new Set();
                const tasks = Array.isArray(a.tasks) ? a.tasks : [];
                const allTicked = tasks.length > 0 && ticks.size >= tasks.length;
                const anyTicked = ticks.size > 0;
                return (
                  <div
                    key={key}
                    style={{
                      borderRadius: 8,
                      background: allTicked ? '#eff6ff' : anyTicked ? '#fffbeb' : '#fafafa',
                      border: '1px solid ' + (allTicked ? '#bfdbfe' : anyTicked ? '#fde68a' : '#e5e7eb'),
                      padding: '12px 14px',
                    }}
                  >
                    <div style={{fontWeight: 700, color: '#57534e', fontSize: 13, marginBottom: 6}}>
                      {a.name}{' '}
                      <span style={{fontSize: 11, color: '#6b7280', fontWeight: 500}}>
                        · {a.hours_or_km === 0 ? 'Every Use' : a.hours_or_km + (a.kind === 'km' ? 'km' : 'h')}
                      </span>
                    </div>
                    {a.help_text && (
                      <div
                        style={{
                          fontSize: 11,
                          color: '#78716c',
                          background: '#fffbeb',
                          border: '1px solid #fde68a',
                          borderRadius: 5,
                          padding: '6px 8px',
                          marginBottom: 8,
                          fontStyle: 'italic',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {a.help_text}
                      </div>
                    )}
                    {tasks.length > 0 ? (
                      <div style={{display: 'flex', flexDirection: 'column', gap: 4}}>
                        {tasks.map((t) => {
                          const ticked = ticks.has(t.id);
                          return (
                            <label
                              key={t.id}
                              style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 8,
                                padding: '6px 8px',
                                borderRadius: 5,
                                background: ticked ? '#dcfce7' : 'white',
                                cursor: 'pointer',
                                fontSize: 12,
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={ticked}
                                onChange={() => toggleAttachmentTask(key, t.id)}
                                style={{
                                  margin: '2px 0 0',
                                  flexShrink: 0,
                                  width: 16,
                                  height: 16,
                                  padding: 0,
                                  border: '1px solid #d1d5db',
                                }}
                              />
                              <span style={{color: ticked ? '#065f46' : '#374151', fontWeight: ticked ? 600 : 500}}>
                                {t.label}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <div style={{fontSize: 11, color: '#9ca3af', fontStyle: 'italic'}}>No tasks configured.</div>
                    )}
                    {anyTicked && (
                      <div
                        style={{fontSize: 11, color: allTicked ? '#1e40af' : '#92400e', marginTop: 6, fontWeight: 600}}
                      >
                        {ticks.size} of {tasks.length} tasks ticked{allTicked ? ' · full completion' : ''}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Photo upload (always shown when there's a reading — some tasks
            ask for "TAKE PICTURES SHOWING EACH SIDE"). */}
        {eq && hasReading && (
          <div style={cardS}>
            <div style={{fontSize: 13, fontWeight: 700, color: '#57534e', marginBottom: 4}}>Photos</div>
            <div style={{fontSize: 11, color: '#6b7280', marginBottom: 10}}>
              Attach photos of the machine, damage, or anything else the next team member should see.
            </div>
            {photos.length > 0 && (
              <div style={{display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10}}>
                {photos.map((p, i) => (
                  <div key={i} style={{position: 'relative'}}>
                    <img
                      src={p.url}
                      alt={imageAltText(p.name, {fallback: 'Fueling photo', index: i, total: photos.length})}
                      style={{width: 80, height: 80, objectFit: 'cover', borderRadius: 6, border: '1px solid #e5e7eb'}}
                    />
                    <button
                      type="button"
                      onClick={() => removePhoto(i)}
                      style={{
                        position: 'absolute',
                        top: -6,
                        right: -6,
                        width: 22,
                        height: 22,
                        borderRadius: '50%',
                        border: 'none',
                        background: '#b91c1c',
                        color: 'white',
                        cursor: 'pointer',
                        fontSize: 12,
                        lineHeight: 1,
                      }}
                    >
                      {'×'}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={async (e) => {
                const files = Array.from(e.target.files || []);
                for (const f of files) await uploadPhoto(f);
                e.target.value = '';
              }}
              disabled={uploadingPhoto}
              style={{fontSize: 13}}
            />
            {uploadingPhoto && <div style={{fontSize: 11, color: '#9ca3af', marginTop: 6}}>Uploading{'…'}</div>}
          </div>
        )}

        {eq && hasReading && dueIntervals.length === 0 && (eq.service_intervals || []).length > 0 && (
          <div style={{...cardS, border: '1px solid #a7f3d0', background: '#ecfdf5'}}>
            <div style={{fontSize: 13, fontWeight: 600, color: '#065f46'}}>
              ✓ No service due at {readingNum.toLocaleString()} {readingLabel.toLowerCase()}.
            </div>
          </div>
        )}

        <div style={cardS}>
          <label style={lblS}>Comments / issues</label>
          <textarea
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            rows={3}
            placeholder="Anything the next team member should know."
            style={{...inpS, resize: 'vertical'}}
          />
        </div>

        {err && (
          <div
            style={{
              color: '#b91c1c',
              fontSize: 13,
              marginBottom: 10,
              padding: '8px 12px',
              background: '#fef2f2',
              borderRadius: 8,
            }}
          >
            {err}
          </div>
        )}

        <button
          onClick={submit}
          disabled={submitting || !eq}
          style={{
            width: '100%',
            padding: 14,
            borderRadius: 10,
            border: 'none',
            background: submitting || !eq ? '#9ca3af' : '#57534e',
            color: 'white',
            fontSize: 15,
            fontWeight: 700,
            cursor: submitting || !eq ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {submitting ? 'Saving…' : 'Save Fueling'}
        </button>
      </div>

      {stuckOpen && (
        <StuckSubmissionsModal
          rows={stuckRows}
          formLabel="fueling"
          describeRow={(row) => {
            const parent = row.record && row.record.args && row.record.args.parent_in;
            const dateStr = parent ? parent.date : '?';
            const galStr = parent && parent.gallons != null ? `${parent.gallons} gal` : '?';
            const reading =
              parent && parent.hours_reading != null
                ? `${parent.hours_reading} h`
                : parent && parent.km_reading != null
                  ? `${parent.km_reading} km`
                  : '?';
            return `${dateStr} · ${galStr} · ${reading} (not yet sent)`;
          }}
          onRetry={async (csid) => {
            await retryStuck(csid);
          }}
          onDiscard={async (csid) => {
            await discardStuck(csid);
          }}
          onClose={() => setStuckOpen(false)}
        />
      )}
    </div>
  );
}
