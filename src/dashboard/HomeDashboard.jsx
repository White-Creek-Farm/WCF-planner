// ============================================================================
// src/dashboard/HomeDashboard.jsx  —  Phase 2 Round 7
// ----------------------------------------------------------------------------
// The home view. Hook-based extraction of the ~540-line inline block that
// used to live inside App() as `if(view==="home") {...}`. Reads every data
// context the app owns (auth, batches, pig, layer, dailysRecent, cattleHome,
// sheepHome, feedCosts, ui) plus a couple of App-scope helpers threaded as
// props (canAccessProgram + VIEW_TO_PROGRAM for the nav-card gate,
// Header/loadUsers for chrome). No behavior changes — the body below is the
// verbatim inline block, unindented by one level.
// ============================================================================
import React from 'react';
import {useNavigate} from 'react-router-dom';
import {sb} from '../lib/supabase.js';
import {fmt, fmtS, toISO, addDays, todayISO} from '../lib/dateUtils.js';
import {calcPoultryStatus, calcBroilerStatsFromDailys, calcTimeline} from '../lib/broiler.js';
import {calcBreedingTimeline, buildCycleSeqMap, cycleLabel, calcCycleStatus} from '../lib/pig.js';
import {computeIntervalStatus, daysSince, latestSaneReading, WARRANTY_WINDOW_DAYS} from '../lib/equipment.js';
import EquipmentCategoryIcon from '../components/EquipmentCategoryIcon.jsx';
import UsersModal from '../auth/UsersModal.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {useBatches} from '../contexts/BatchesContext.jsx';
import {usePig} from '../contexts/PigContext.jsx';
import {useLayer} from '../contexts/LayerContext.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';
import {useCattleHome} from '../contexts/CattleHomeContext.jsx';
import {useSheepHome} from '../contexts/SheepHomeContext.jsx';
import {useFeedCosts} from '../contexts/FeedCostsContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';

export default function HomeDashboard({Header, loadUsers, canAccessProgram, VIEW_TO_PROGRAM}) {
  const {authState, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const {batches} = useBatches();
  const {breedingCycles, farrowingRecs, feederGroups} = usePig();
  const {layerGroups, layerHousings} = useLayer();
  const {broilerDailys, pigDailys, layerDailysRecent, eggDailysRecent, cattleDailysRecent, sheepDailysRecent} =
    useDailysRecent();
  const {cattleForHome, cattleOnFarmCount} = useCattleHome();
  const {sheepForHome} = useSheepHome();
  const {missedCleared, setMissedCleared} = useFeedCosts();
  const {setView, setPendingEdit} = useUI();
  const navigate = useNavigate();

  const role = authState?.role;
  const isAdmin = role === 'admin';
  const today = new Date();
  const todayStr = todayISO();
  const in30 = toISO(addDays(today, 30));

  // Equipment data for missed-fueling + EQUIPMENT ATTENTION section. Loaded
  // defensively so the home page still renders if migration 016 isn't in.
  const [equipment, setEquipment] = React.useState([]);
  const [equipmentCompletions, setEquipmentCompletions] = React.useState({}); // eq.id → [completion {...with reading_at_completion}]
  const [equipmentFuelings, setEquipmentFuelings] = React.useState({}); // eq.id → [{date, team_member, hours_reading, km_reading, every_fillup_check}] sorted reading desc
  React.useEffect(() => {
    sb.from('equipment')
      .select(
        'id,slug,name,status,tracking_unit,current_hours,current_km,warranty_expiration,service_intervals,every_fillup_items',
      )
      .eq('status', 'active')
      .then(({data, error}) => {
        if (error || !data) return;
        setEquipment(data);
      });
    sb.from('equipment_fuelings')
      .select('equipment_id,date,team_member,hours_reading,km_reading,service_intervals_completed,every_fillup_check')
      .order('date', {ascending: false})
      .limit(5000)
      .then(({data, error}) => {
        if (error) {
          console.error('equipment_fuelings fetch:', error);
          return;
        }
        if (!data) return;
        const compM = {};
        const fuelM = {};
        for (const r of data) {
          if (!fuelM[r.equipment_id]) fuelM[r.equipment_id] = [];
          fuelM[r.equipment_id].push(r);
          const comps = Array.isArray(r.service_intervals_completed) ? r.service_intervals_completed : [];
          if (comps.length > 0) {
            const fallbackReading =
              r.hours_reading != null ? Number(r.hours_reading) : r.km_reading != null ? Number(r.km_reading) : null;
            const normalized = comps.map((c) => ({
              ...c,
              reading_at_completion:
                c && c.reading_at_completion != null ? Number(c.reading_at_completion) : fallbackReading,
              team_member: c && c.team_member != null ? c.team_member : r.team_member || null,
            }));
            compM[r.equipment_id] = [...(compM[r.equipment_id] || []), ...normalized];
          }
        }
        // Sort each equipment's fuelings by reading desc (date as tiebreaker) — same as the streak feature.
        for (const id in fuelM) {
          fuelM[id].sort((a, b) => {
            const ra =
              a.hours_reading != null ? Number(a.hours_reading) : a.km_reading != null ? Number(a.km_reading) : null;
            const rb =
              b.hours_reading != null ? Number(b.hours_reading) : b.km_reading != null ? Number(b.km_reading) : null;
            if (ra != null && rb != null && ra !== rb) return rb - ra;
            return String(b.date || '').localeCompare(String(a.date || ''));
          });
        }
        setEquipmentCompletions(compM);
        setEquipmentFuelings(fuelM);
      });
  }, []);

  // Auto-status counts for poultry
  const activeBatches = batches.filter((b) => calcPoultryStatus(b) === 'active');
  const plannedBatches = batches.filter((b) => calcPoultryStatus(b) === 'planned');
  const processedBatches = batches.filter((b) => calcPoultryStatus(b) === 'processed');
  const birdsOnFarm = activeBatches.reduce((s, b) => s + (parseInt(b.birdCountActual) || 0), 0);
  const projectedBirds = activeBatches.reduce((s, b) => {
    const stats = calcBroilerStatsFromDailys(b, broilerDailys);
    return s + stats.projectedBirds;
  }, 0);

  // What's happening in the next 30 days
  const weekEvents = [];

  // Poultry events
  batches.forEach((b) => {
    const live = calcTimeline(b.hatchDate, b.breed, b.processingDate);
    if (!live) return;
    if (live.brooderIn >= todayStr && live.brooderIn <= in30)
      weekEvents.push({
        type: 'brooder-in',
        label: `${b.name} enters brooder`,
        date: live.brooderIn,
        color: '#065f46',
        icon: '🐣',
      });
    if (live.schoonerIn >= todayStr && live.schoonerIn <= in30)
      weekEvents.push({
        type: 'schooner-in',
        label: `${b.name} moves to schooner`,
        date: live.schoonerIn,
        color: '#a16207',
        icon: '🐔',
      });
    if (b.processingDate >= todayStr && b.processingDate <= in30)
      weekEvents.push({
        type: 'processing',
        label: `${b.name} processing day`,
        date: b.processingDate,
        color: '#7f1d1d',
        icon: '📅',
      });
    // 4-week weight reminder
    if (b.hatchDate) {
      const wk4date = toISO(addDays(new Date(b.hatchDate + 'T12:00:00'), 28));
      if (wk4date >= todayStr && wk4date <= in30 && !(parseFloat(b.week4Lbs) > 0))
        weekEvents.push({
          type: 'wt-4wk',
          label: `${b.name} — record 4-week weights`,
          date: wk4date,
          color: '#854d0e',
          icon: '⚖️',
          reminder: true,
        });
    }
    // 6-week weight reminder
    if (b.hatchDate) {
      const wk6date = toISO(addDays(new Date(b.hatchDate + 'T12:00:00'), 42));
      if (wk6date >= todayStr && wk6date <= in30 && !(parseFloat(b.week6Lbs) > 0))
        weekEvents.push({
          type: 'wt-6wk',
          label: `${b.name} — record 6-week weights`,
          date: wk6date,
          color: '#854d0e',
          icon: '⚖️',
          reminder: true,
        });
    }
  });

  // Pig events
  const _weekSeqMap = buildCycleSeqMap(breedingCycles);
  breedingCycles.forEach((c) => {
    const tl = calcBreedingTimeline(c.exposureStart);
    if (!tl) return;
    const lbl = cycleLabel(c, _weekSeqMap);
    if (tl.farrowingStart >= todayStr && tl.farrowingStart <= in30)
      weekEvents.push({
        type: 'farrow-open',
        label: `${lbl} farrowing window opens`,
        date: tl.farrowingStart,
        color: '#1e40af',
        icon: '🐷',
      });
    if (tl.farrowingEnd >= todayStr && tl.farrowingEnd <= in30)
      weekEvents.push({
        type: 'farrow-close',
        label: `${lbl} farrowing window closes`,
        date: tl.farrowingEnd,
        color: '#be185d',
        icon: '🐷',
      });
    // Sows due in window
    if (tl.farrowingStart <= in30 && tl.farrowingEnd >= todayStr) {
      const expected = [...(c.boar1Tags || '').split(/[\n,]+/), ...(c.boar2Tags || '').split(/[\n,]+/)]
        .map((t) => t.trim())
        .filter(Boolean);
      const farrowed = new Set(farrowingRecs.filter((r) => r.group === c.group).map((r) => r.sow.trim()));
      const pending = expected.filter((t) => !farrowed.has(t));
      if (pending.length > 0)
        weekEvents.push({
          type: 'farrow-due',
          label: `${pending.length} sow${pending.length > 1 ? 's' : ''} due to farrow (${lbl})`,
          date: tl.farrowingStart,
          color: '#1e40af',
          icon: '🌱',
        });
    }
  });

  // Pig batches hitting 6 months
  feederGroups.forEach((g) => {
    const cycle = breedingCycles.find((c) => c.id === g.cycleId);
    if (!cycle) return;
    const tl = calcBreedingTimeline(cycle.exposureStart);
    if (!tl) return;
    const farrowMid = new Date(tl.farrowingStart + 'T12:00:00');
    const sixMonths = toISO(addDays(farrowMid, 183));
    if (sixMonths >= todayStr && sixMonths <= in30)
      weekEvents.push({
        type: 'pig-age',
        label: `${g.batchName} hitting ~6 months`,
        date: sixMonths,
        color: '#92400e',
        icon: '🐖',
      });
  });

  weekEvents.sort((a, b) => a.date.localeCompare(b.date));

  // ── Missed daily reports — checks last 7 days, persists until cleared ──
  async function clearMissedEntry(key) {
    const newSet = new Set([...missedCleared, key]);
    setMissedCleared(newSet);
    sb.from('app_store')
      .upsert({key: 'ppp-missed-cleared-v1', data: [...newSet]}, {onConflict: 'key'})
      .then(() => {});
  }
  async function clearAllMissed(keys) {
    const newSet = new Set([...missedCleared, ...keys]);
    setMissedCleared(newSet);
    sb.from('app_store')
      .upsert({key: 'ppp-missed-cleared-v1', data: [...newSet]}, {onConflict: 'key'})
      .then(() => {});
  }
  const allMissed = [];
  for (let daysBack = 1; daysBack <= 7; daysBack++) {
    const checkDate = toISO(addDays(new Date(), -daysBack));
    const broilerCheck = new Set(
      broilerDailys
        .filter((d) => d.date === checkDate)
        .map((d) =>
          (d.batch_label || '')
            .toLowerCase()
            .trim()
            .replace(/^\(processed\)\s*/, ''),
        ),
    );
    const pigCheck = new Set(
      pigDailys.filter((d) => d.date === checkDate).map((d) => (d.batch_label || '').toLowerCase().trim()),
    );
    const layerCheck = new Set(
      layerDailysRecent.filter((d) => d.date === checkDate).map((d) => (d.batch_label || '').toLowerCase().trim()),
    );
    // Broilers — only check batches user has explicitly marked active AND only for days the batch was on the farm
    batches
      .filter((b) => b.status === 'active')
      .forEach((b) => {
        // Skip days before the batch arrived (use brooderIn, fall back to hatchDate)
        const earliestDate = b.brooderIn || b.hatchDate;
        if (earliestDate && checkDate < earliestDate) return;
        // Skip days after processing
        if (b.processingDate && checkDate > b.processingDate) return;
        const key = `${b.id}|${checkDate}`;
        if (!broilerCheck.has(b.name.toLowerCase().trim()) && !missedCleared.has(key))
          allMissed.push({key, label: b.name, icon: '🐔', type: 'Broiler', date: checkDate});
      });
    // Pigs — sub-batches if present, main batch otherwise.
    // If the batch HAS sub-batches but none are active (all marked processed),
    // skip entirely — don't fall back to flagging the parent name.
    feederGroups
      .filter((g) => g.status === 'active')
      .forEach((g) => {
        const subs = g.subBatches || [];
        const activeSubs = subs.filter((s) => s.status === 'active');
        if (activeSubs.length > 0) {
          activeSubs.forEach((s) => {
            const key = `${s.id}|${checkDate}`;
            if (!pigCheck.has((s.name || '').toLowerCase().trim()) && !missedCleared.has(key))
              allMissed.push({key, label: s.name, icon: '🐷', type: `Pig · ${g.batchName}`, date: checkDate});
          });
        } else if (subs.length === 0) {
          const key = `${g.id}|${checkDate}`;
          if (!pigCheck.has((g.batchName || '').toLowerCase().trim()) && !missedCleared.has(key))
            allMissed.push({key, label: g.batchName, icon: '🐷', type: 'Pig', date: checkDate});
        }
      });
    // Layers
    (layerGroups || [])
      .filter((g) => g.status === 'active')
      .forEach((g) => {
        const key = `${g.id}|${checkDate}`;
        if (!layerCheck.has((g.name || '').toLowerCase().trim()) && !missedCleared.has(key))
          allMissed.push({key, label: g.name, icon: '🥚', type: 'Layer', date: checkDate});
      });
    // Cattle — flag any active herd that has cattle but no daily report on this date
    const cattleCheck = new Set(cattleDailysRecent.filter((d) => d.date === checkDate).map((d) => d.herd));
    ['mommas', 'backgrounders', 'finishers', 'bulls'].forEach((h) => {
      if (!cattleForHome.some((c) => c.herd === h)) return;
      const key = `cattle-${h}|${checkDate}`;
      if (!cattleCheck.has(h) && !missedCleared.has(key))
        allMissed.push({
          key,
          label: h.charAt(0).toUpperCase() + h.slice(1),
          icon: '🐄',
          type: 'Cattle',
          date: checkDate,
        });
    });
    // Sheep — flag any active flock that has sheep but no daily report on this date
    const sheepCheck = new Set(sheepDailysRecent.filter((d) => d.date === checkDate).map((d) => d.flock));
    ['rams', 'ewes', 'feeders'].forEach((f) => {
      if (!sheepForHome.some((s) => s.flock === f)) return;
      const key = `sheep-${f}|${checkDate}`;
      if (!sheepCheck.has(f) && !missedCleared.has(key))
        allMissed.push({
          key,
          label: f.charAt(0).toUpperCase() + f.slice(1),
          icon: '🐑',
          type: 'Sheep',
          date: checkDate,
        });
    });
  }
  // Sort newest first
  allMissed.sort((a, b) => b.date.localeCompare(a.date));

  // ── Equipment attention: overdue services + every-fillup item streaks +
  // warranty. Equipment maintenance is HOUR/KM-based, not calendar-based —
  // animal daily reports are the calendar/time workflow, equipment is not.
  // So this section deliberately does NOT surface near-due ("upcoming")
  // services or stale-fueling-by-time alerts; both were noisy without
  // signaling action. Only `warranty` is manually clearable (no underlying
  // signal resolves it on its own); the other kinds auto-clear when their
  // state resolves: interval ticked complete on a fueling, every-fillup
  // items ticked on next fueling.
  const equipmentAttention = [];
  equipment.forEach((eq) => {
    const unit = eq.tracking_unit === 'km' ? 'km' : 'hours';
    const unitLabel = unit === 'km' ? 'km' : 'h';
    // Effective reading prefers the latest webform fueling submission when it's
    // ahead of equipment.current_*. Anon UPDATEs to the parent equipment row
    // silently fail in prod under RLS (recon 2026-04-28), so trusting
    // equipment.current_* alone makes overdue calls run against stale data.
    const currentReading = latestSaneReading(eq, equipmentFuelings[eq.id] || []);
    const intervals = Array.isArray(eq.service_intervals) ? eq.service_intervals : [];
    const completions = equipmentCompletions[eq.id] || [];

    // Each overdue interval = its own row so multiples on the same piece
    // all surface. NOT manually clearable — auto-clears when an operator
    // completes the checklist on a fueling (which moves the next-due
    // milestone past the current reading).
    if (Number.isFinite(currentReading) && currentReading > 0 && intervals.length > 0) {
      const statuses = computeIntervalStatus(intervals, completions, currentReading);
      const overdue = statuses.filter((s) => s.overdue).sort((a, b) => a.hours_or_km - b.hours_or_km);
      for (const s of overdue) {
        const over = currentReading - s.next_due;
        const intervalLbl = s.label || s.hours_or_km + unitLabel + ' service';
        equipmentAttention.push({
          key: `equip-overdue-${eq.id}|${s.kind}|${s.hours_or_km}`,
          kind: 'overdue',
          slug: eq.slug,
          label: eq.name,
          detail: `${intervalLbl} · ${Math.round(over).toLocaleString()} ${unitLabel} overdue`,
        });
      }
    }

    // Every-fillup streaks: one row per piece summarizing item-level misses.
    // Mirrors the per-item badges shown on the /fueling/<slug> webform; this
    // is the home-page roll-up so admins/managers see the action queue.
    const fillupItems = Array.isArray(eq.every_fillup_items) ? eq.every_fillup_items : [];
    const fuelings = equipmentFuelings[eq.id] || [];
    if (fillupItems.length > 0 && fuelings.length > 0) {
      const itemsWithStreak = [];
      for (const item of fillupItems) {
        let streak = 0;
        for (const h of fuelings) {
          const ticks = Array.isArray(h.every_fillup_check) ? h.every_fillup_check : [];
          const wasTicked = ticks.some((t) => t && t.id === item.id);
          if (wasTicked) break;
          streak++;
        }
        if (streak > 0) itemsWithStreak.push({label: item.label || item.id, streak});
      }
      if (itemsWithStreak.length > 0) {
        const maxStreak = Math.max(...itemsWithStreak.map((i) => i.streak));
        const sample = itemsWithStreak
          .slice(0, 2)
          .map((i) => i.label)
          .join(', ');
        const more = itemsWithStreak.length > 2 ? ` +${itemsWithStreak.length - 2} more` : '';
        // Auto-clears when next fueling ticks every previously-missed item.
        equipmentAttention.push({
          key: `equip-fillup-${eq.id}|streak${maxStreak}|n${itemsWithStreak.length}`,
          kind: 'fillup_streak',
          slug: eq.slug,
          label: eq.name,
          detail: `${itemsWithStreak.length} fillup item${itemsWithStreak.length === 1 ? '' : 's'} skipped (${maxStreak}× max streak): ${sample}${more}`,
        });
      }
    }

    // Warranty: daysSince returns positive when past, negative when ahead.
    if (eq.warranty_expiration) {
      const d = daysSince(eq.warranty_expiration);
      if (d != null && d >= -WARRANTY_WINDOW_DAYS) {
        let detail;
        if (d > 0) detail = `Warranty expired ${d} day${d === 1 ? '' : 's'} ago`;
        else if (d === 0) detail = 'Warranty expires today';
        else detail = `Warranty expires in ${-d} day${-d === 1 ? '' : 's'}`;
        // Warranty IS manually clearable — no checklist resolves it. Admin
        // dismisses with the Clear button or by updating the warranty date.
        const key = `equip-warranty-${eq.id}|${eq.warranty_expiration}`;
        if (!missedCleared.has(key)) {
          equipmentAttention.push({
            key,
            kind: 'warranty',
            slug: eq.slug,
            label: eq.name,
            detail,
          });
        }
      }
    }
  });
  // Order: overdue → fillup_streak → warranty; alphabetical within each
  // kind. Priority: past-due hour/km service first, then per-fillup
  // checklist hygiene, then warranty (longest horizon).
  const KIND_ORDER = {overdue: 0, fillup_streak: 1, warranty: 2};
  equipmentAttention.sort((a, b) => {
    const ko = (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
    if (ko !== 0) return ko;
    return a.label.localeCompare(b.label);
  });

  const activeBroilerBatches2 = batches.filter((b) => calcPoultryStatus(b) === 'active');
  const activePigBatches2 = feederGroups.filter((g) => g.status === 'active');
  const activeLayerGroups2 = (layerGroups || []).filter((g) => g.status === 'active');

  // ── Admin weekly table data ──
  const fiveDaysAgo = toISO(addDays(new Date(), -5));
  const weekAgo = fiveDaysAgo; // used for admin daily tiles (5 days)
  const allRecentReports = [
    ...broilerDailys
      .filter((d) => d.date >= weekAgo)
      .map((d) => ({id: d.id, view: 'broilerdailys', date: d.date, type: '🐔 Broiler', raw: d})),
    ...pigDailys
      .filter((d) => d.date >= weekAgo)
      .map((d) => ({id: d.id, view: 'pigdailys', date: d.date, type: '🐷 Pig', raw: d})),
    ...layerDailysRecent
      .filter((d) => d.date >= weekAgo)
      .map((d) => ({id: d.id, view: 'layerdailys', date: d.date, type: '🐓 Layer', raw: d})),
    ...eggDailysRecent
      .filter((d) => d.date >= weekAgo)
      .map((d) => ({id: d.id, view: 'eggdailys', date: d.date, type: '🥚 Egg', raw: d})),
    ...cattleDailysRecent
      .filter((d) => d.date >= weekAgo)
      .map((d) => ({id: d.id, view: 'cattledailys', date: d.date, type: '🐄 Cattle', raw: d})),
    ...sheepDailysRecent
      .filter((d) => d.date >= weekAgo)
      .map((d) => ({id: d.id, view: 'sheepdailys', date: d.date, type: '🐑 Sheep', raw: d})),
  ].sort((a, b) => b.date.localeCompare(a.date) || a.type.localeCompare(b.type));

  // Active pig breeding cycles
  const activeCycles = breedingCycles.filter((c) => calcCycleStatus(c) === 'active');
  const totalSows = breedingCycles.reduce((s, c) => s + (parseInt(c.sowCount) || 0), 0);

  // Performance trends
  // Pig farrowing survival per cycle (most recent 5)
  const _homeSeqMap = buildCycleSeqMap(breedingCycles);
  const cycleSurvival = breedingCycles
    .map((c) => {
      const tl = calcBreedingTimeline(c.exposureStart);
      if (!tl) return null;
      const recs = farrowingRecs.filter((r) => {
        if (r.group !== c.group || !r.farrowingDate) return false;
        const rd = new Date(r.farrowingDate + 'T12:00:00');
        return rd >= new Date(tl.farrowingStart + 'T12:00:00') && rd <= addDays(tl.farrowingEnd, 14);
      });
      if (recs.length === 0) return null;
      const born = recs.reduce((s, r) => s + (parseInt(r.totalBorn) || 0), 0);
      const dead = recs.reduce((s, r) => s + (parseInt(r.deaths) || 0), 0);
      const _suf = _homeSeqMap[c.id];
      return {
        label: `G${c.group}${_suf ? ' · ' + _suf : ''} ${fmtS(c.exposureStart)}`,
        survival: born > 0 ? Math.round(((born - dead) / born) * 100) : 0,
        recs: recs.length,
      };
    })
    .filter(Boolean)
    .slice(-5);

  // Pig carcass yield trend
  const yieldData = feederGroups
    .flatMap((g) =>
      (g.processingTrips || []).map((t) => {
        const live = (t.liveWeights || '')
          .split(/[\s,]+/)
          .map((v) => parseFloat(v))
          .filter((v) => !isNaN(v) && v > 0)
          .reduce((a, b) => a + b, 0);
        const hang = parseFloat(t.hangingWeight) || 0;
        return live > 0 && hang > 0
          ? {label: t.date, yld: Math.round((hang / live) * 1000) / 10, batch: g.batchName}
          : null;
      }),
    )
    .filter(Boolean)
    .sort((a, b) => a.label.localeCompare(b.label))
    .slice(-8);

  const statCard = (label, val, color = '#085041', sub = '') => (
    <div
      key={label}
      style={{
        background: 'white',
        border: '1px solid #e5e7eb',
        borderRadius: 12,
        padding: '14px 16px',
        boxShadow: '0 1px 3px rgba(0,0,0,.06)',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          color: '#6b7280',
          textTransform: 'uppercase',
          letterSpacing: 0.8,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{fontSize: 26, fontWeight: 700, color, lineHeight: 1}}>{val}</div>
      {sub && <div style={{fontSize: 11, color: '#9ca3af', marginTop: 3}}>{sub}</div>}
    </div>
  );

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
      <div
        style={{
          padding: '1.25rem',
          maxWidth: 1200,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.5rem',
        }}
      >
        {/* Nav cards — 3 cols × 2 rows fits all 6 programs without bloating the page */}
        <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10}}>
          {[
            {
              label: 'Broilers',
              icon: '🐔',
              desc: `${activeBatches.length} active \u00b7 ${birdsOnFarm.toLocaleString()} on farm`,
              view: 'broilerHome',
              color: '#a16207',
              bg: '#fef9c3',
            },
            {
              label: 'Layers',
              icon: '🥚',
              desc: `${(layerGroups || []).filter((g) => g.status === 'active').length} active groups \u00b7 ${(layerGroups || []).filter((g) => g.status === 'active').reduce((s, g) => s + (g.currentCount || 0), 0)} hens`,
              view: 'layersHome',
              color: '#78350f',
              bg: '#fffbeb',
            },
            {
              label: 'Pigs',
              icon: '🐷',
              desc: `${activeCycles.length} cycles \u00b7 ${totalSows} sows \u00b7 ${feederGroups.filter((g) => g.status === 'active').length} batches`,
              view: 'pigsHome',
              color: '#1e40af',
              bg: '#eff6ff',
            },
            {
              label: 'Cattle',
              icon: '🐄',
              desc: `Mommas \u00b7 backgrounders \u00b7 finishers \u00b7 bulls`,
              view: 'cattleHome',
              color: '#991b1b',
              bg: '#fef2f2',
            },
            {
              label: 'Sheep',
              icon: '🐑',
              desc: `Hair sheep for meat \u00b7 rams + ewes + feeders`,
              view: 'sheepHome',
              color: '#0f766e',
              bg: '#f0fdfa',
            },
            {
              label: 'Equipment',
              icon: '🚜',
              desc: `Tractors \u00b7 implements \u00b7 maintenance (coming soon)`,
              view: 'equipmentHome',
              color: '#57534e',
              bg: '#fafaf9',
            },
          ]
            .filter((c) => canAccessProgram(VIEW_TO_PROGRAM[c.view]))
            .map((c) => (
              <div
                key={c.view}
                onClick={() => setView(c.view)}
                style={{
                  background: c.bg,
                  border: '1px solid #e5e7eb',
                  borderRadius: 12,
                  padding: '16px 18px',
                  cursor: 'pointer',
                  boxShadow: '0 1px 3px rgba(0,0,0,.05)',
                  transition: 'transform .1s',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  minWidth: 0,
                }}
              >
                <div style={{flexShrink: 0, lineHeight: 1}}>
                  <EquipmentCategoryIcon category={c} size={36} />
                </div>
                <div style={{minWidth: 0, flex: 1}}>
                  <div style={{fontSize: 18, fontWeight: 700, color: c.color}}>{c.label}</div>
                </div>
              </div>
            ))}
        </div>

        {/* Webforms Admin card — admin only */}
        {authState?.role === 'admin' && (
          <div
            onClick={() => setView('webforms')}
            style={{
              background: '#fefce8',
              border: '1px solid #fde68a',
              borderRadius: 14,
              padding: '16px 22px',
              cursor: 'pointer',
              boxShadow: '0 2px 6px rgba(0,0,0,.06)',
              display: 'flex',
              alignItems: 'center',
              gap: 16,
            }}
          >
            <div style={{fontSize: 32}}>⚙️</div>
            <div style={{fontSize: 16, fontWeight: 700, color: '#92400e'}}>Admin</div>
            <div style={{marginLeft: 'auto', fontSize: 12, color: '#92400e', fontWeight: 600}}>Manage →</div>
          </div>
        )}

        {/* ── Animals on Farm ── */}
        {(() => {
          const totalHens = (layerHousings || [])
            .filter((h) => h.status === 'active')
            .reduce((s, h) => s + (parseInt(h.current_count) || 0), 0);
          const activeFeederNamesHome = feederGroups
            .filter((g) => g.status === 'active')
            .flatMap((g) => {
              const subs = (g.subBatches || []).filter((s) => s.status === 'active');
              return subs.length > 0
                ? subs.map((s) => (s.name || '').toLowerCase().trim())
                : [(g.batchName || '').toLowerCase().trim()];
            });
          const pigCounts = {};
          [...pigDailys]
            .sort((a, b) => a.date.localeCompare(b.date))
            .forEach((d) => {
              if (d.pig_count > 0 && d.batch_label) {
                const lbl = d.batch_label.toLowerCase().trim();
                if (activeFeederNamesHome.includes(lbl) || lbl === 'sows' || lbl === 'boars')
                  pigCounts[d.batch_label] = parseInt(d.pig_count);
              }
            });
          const totalPigs = Object.values(pigCounts).reduce((s, v) => s + v, 0);
          const sheepOnFarm = (sheepForHome || []).filter(
            (s) => s.flock === 'rams' || s.flock === 'ewes' || s.flock === 'feeders',
          ).length;
          const totalAll = projectedBirds + totalHens + totalPigs + cattleOnFarmCount + sheepOnFarm;
          return (
            <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, padding: '16px 24px'}}>
              <div style={{fontSize: 12, fontWeight: 600, color: '#4b5563', letterSpacing: 0.3, marginBottom: 12}}>
                ANIMALS ON FARM
              </div>
              <div
                style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr 1fr', gap: 16, alignItems: 'center'}}
              >
                <div style={{textAlign: 'center'}}>
                  <div style={{fontSize: 26, fontWeight: 700, color: '#a16207'}}>{projectedBirds.toLocaleString()}</div>
                  <div style={{fontSize: 11, color: '#6b7280', marginTop: 2}}>{'\ud83d\udc14 Broilers'}</div>
                </div>
                <div style={{textAlign: 'center'}}>
                  <div style={{fontSize: 26, fontWeight: 700, color: '#92400e'}}>{totalHens.toLocaleString()}</div>
                  <div style={{fontSize: 11, color: '#6b7280', marginTop: 2}}>{'\ud83d\udc13 Layer Hens'}</div>
                </div>
                <div style={{textAlign: 'center'}}>
                  <div style={{fontSize: 26, fontWeight: 700, color: '#1e40af'}}>{totalPigs.toLocaleString()}</div>
                  <div style={{fontSize: 11, color: '#6b7280', marginTop: 2}}>{'\ud83d\udc37 Pigs'}</div>
                </div>
                <div style={{textAlign: 'center'}}>
                  <div style={{fontSize: 26, fontWeight: 700, color: '#991b1b'}}>
                    {cattleOnFarmCount.toLocaleString()}
                  </div>
                  <div style={{fontSize: 11, color: '#6b7280', marginTop: 2}}>{'\ud83d\udc04 Cattle'}</div>
                </div>
                <div style={{textAlign: 'center'}}>
                  <div style={{fontSize: 26, fontWeight: 700, color: '#0f766e'}}>{sheepOnFarm.toLocaleString()}</div>
                  <div style={{fontSize: 11, color: '#6b7280', marginTop: 2}}>{'\ud83d\udc11 Sheep'}</div>
                </div>
                <div style={{textAlign: 'center', borderLeft: '1px solid #e5e7eb', paddingLeft: 16}}>
                  <div style={{fontSize: 26, fontWeight: 700, color: '#085041'}}>{totalAll.toLocaleString()}</div>
                  <div style={{fontSize: 11, color: '#6b7280', marginTop: 2}}>Total Animals</div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Missed Daily Reports ── */}
        {allMissed.length > 0 && (
          <div>
            <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8}}>
              <div style={{fontSize: 13, fontWeight: 600, color: '#b91c1c', letterSpacing: 0.3}}>
                ⚠ MISSED DAILY REPORTS
              </div>
              <button
                onClick={() => clearAllMissed(allMissed.map((m) => m.key))}
                style={{
                  fontSize: 11,
                  color: '#6b7280',
                  background: 'none',
                  border: '1px solid #d1d5db',
                  borderRadius: 6,
                  padding: '3px 10px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Clear all
              </button>
            </div>
            <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
              {allMissed.map((m) => (
                <div
                  key={m.key}
                  style={{
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: 10,
                    padding: '10px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <span style={{fontSize: 18}}>{m.icon}</span>
                  <div style={{flex: 1}}>
                    <div style={{fontSize: 13, fontWeight: 600, color: '#b91c1c'}}>{m.label}</div>
                    <div style={{fontSize: 11, color: '#9ca3af'}}>
                      {m.type} · No daily report for {fmt(m.date)}
                    </div>
                  </div>
                  <button
                    onClick={() => clearMissedEntry(m.key)}
                    style={{
                      fontSize: 11,
                      color: '#6b7280',
                      background: 'white',
                      border: '1px solid #d1d5db',
                      borderRadius: 6,
                      padding: '3px 10px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      flexShrink: 0,
                    }}
                  >
                    Clear
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {allMissed.length === 0 &&
          (activeBroilerBatches2.length > 0 || activePigBatches2.length > 0 || activeLayerGroups2.length > 0) && (
            <div
              style={{
                background: '#ecfdf5',
                border: '1px solid #a7f3d0',
                borderRadius: 10,
                padding: '10px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <span style={{fontSize: 16}}>✅</span>
              <div style={{fontSize: 12, color: '#065f46', fontWeight: 500}}>
                All active batches had daily reports entered for the past 7 days
              </div>
            </div>
          )}

        {/* ── Equipment Attention ── overdue intervals + every-fillup streaks + warranty.
              NOT manually clearable. Each row auto-clears when its underlying
              state resolves: interval ticked complete on a fueling, every-fillup
              items ticked on next fueling, or warranty_expiration updated. */}
        {equipmentAttention.length > 0 && (
          <div>
            <div style={{fontSize: 13, fontWeight: 600, color: '#92400e', letterSpacing: 0.3, marginBottom: 8}}>
              🔧 EQUIPMENT ATTENTION
            </div>
            <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
              {equipmentAttention.map((a) => {
                const palette =
                  a.kind === 'overdue'
                    ? {bg: '#fef2f2', bd: '#fecaca', tx: '#b91c1c', icon: '🔧'}
                    : a.kind === 'fillup_streak'
                      ? {bg: '#fffbeb', bd: '#fde68a', tx: '#92400e', icon: '⛽'}
                      : {bg: '#fef3c7', bd: '#fcd34d', tx: '#92400e', icon: '🛡'};
                const isClearable = a.kind === 'warranty';
                return (
                  <div
                    key={a.key}
                    data-attention-kind={a.kind}
                    data-equipment-slug={a.slug}
                    onClick={() => navigate(a.kind === 'fillup_streak' ? '/equipment/' + a.slug : '/fleet/' + a.slug)}
                    style={{
                      background: palette.bg,
                      border: '1px solid ' + palette.bd,
                      borderRadius: 10,
                      padding: '10px 16px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{fontSize: 18}}>{palette.icon}</span>
                    <div style={{flex: 1}}>
                      <div style={{fontSize: 13, fontWeight: 600, color: palette.tx}}>{a.label}</div>
                      <div style={{fontSize: 11, color: '#9ca3af'}}>{a.detail}</div>
                    </div>
                    {isClearable && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          clearMissedEntry(a.key);
                        }}
                        style={{
                          fontSize: 11,
                          color: '#6b7280',
                          background: 'white',
                          border: '1px solid #d1d5db',
                          borderRadius: 6,
                          padding: '3px 10px',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          flexShrink: 0,
                        }}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Admin Weekly Report Table ── */}

        {/* What's happening this week */}
        <div>
          <div style={{fontSize: 13, fontWeight: 600, color: '#4b5563', marginBottom: 8, letterSpacing: 0.3}}>
            NEXT 30 DAYS
          </div>
          {weekEvents.length === 0 ? (
            <div
              style={{
                background: 'white',
                border: '1px solid #e5e7eb',
                borderRadius: 12,
                padding: '20px',
                textAlign: 'center',
                color: '#9ca3af',
                fontSize: 13,
              }}
            >
              Nothing scheduled in the next 30 days
            </div>
          ) : (
            <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
              {weekEvents.map((e, i) => (
                <div
                  key={i}
                  onClick={() => {
                    if (e.type === 'wt-4wk' || e.type === 'wt-6wk') {
                      setView('list');
                    }
                  }}
                  style={{
                    background: e.reminder ? '#eff6ff' : 'white',
                    border: e.reminder ? '1px solid #bfdbfe' : '1px solid #e5e7eb',
                    borderRadius: 10,
                    padding: '10px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    boxShadow: '0 1px 3px rgba(0,0,0,.04)',
                    cursor: e.reminder ? 'pointer' : 'default',
                  }}
                >
                  <span style={{fontSize: 18}}>{e.icon}</span>
                  <div style={{flex: 1}}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: e.reminder ? 600 : 500,
                        color: e.reminder ? '#1e40af' : '#111827',
                      }}
                    >
                      {e.label}
                    </div>
                    <div style={{fontSize: 11, color: '#9ca3af'}}>
                      {fmt(e.date)}
                      {e.reminder ? ' · click to open batch' : ''}
                    </div>
                  </div>
                  {e.reminder ? (
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: '#1d4ed8',
                        background: '#dbeafe',
                        padding: '2px 8px',
                        borderRadius: 10,
                      }}
                    >
                      REMINDER
                    </span>
                  ) : (
                    <div style={{width: 8, height: 8, borderRadius: 4, background: e.color, flexShrink: 0}} />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {isAdmin && allRecentReports.length > 0 && (
          <div>
            <div style={{fontSize: 13, fontWeight: 600, color: '#4b5563', marginBottom: 10, letterSpacing: 0.3}}>
              LAST 5 DAYS — ALL DAILY REPORTS
            </div>
            {(() => {
              // Group by date, then within each date group by animal type
              const dates = [...new Set(allRecentReports.map((r) => r.date))].sort().reverse();
              const typeOrder = {
                '🐔 Broiler': 0,
                '🐷 Pig': 1,
                '🐓 Layer': 2,
                '🥚 Layer': 2,
                '🥚 Egg': 3,
                '🐄 Cattle': 4,
                '🐑 Sheep': 5,
              };
              const typeColors = {
                '🐔 Broiler': '#a16207',
                '🐷 Pig': '#1e3a8a',
                '🐓 Layer': '#92400e',
                '🥚 Layer': '#92400e',
                '🥚 Egg': '#78350f',
                '🐄 Cattle': '#991b1b',
                '🐑 Sheep': '#0f766e',
              };
              const typeBg = {
                '🐔 Broiler': '#fef9c3',
                '🐷 Pig': '#eff6ff',
                '🐓 Layer': '#fffbeb',
                '🥚 Layer': '#fffbeb',
                '🥚 Egg': '#fefce8',
                '🐄 Cattle': '#fef2f2',
                '🐑 Sheep': '#f0fdfa',
              };
              return dates.map((date, di) => {
                const dayRecs = allRecentReports
                  .filter((r) => r.date === date)
                  .sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));
                const types = [...new Set(dayRecs.map((r) => r.type))];
                return (
                  <div key={date}>
                    {di > 0 && <div style={{height: 3, background: '#9ca3af', borderRadius: 2, margin: '8px 0'}} />}
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: '#374151',
                        marginBottom: 6,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <span>{fmt(date)}</span>
                      <span style={{fontSize: 11, fontWeight: 400, color: '#9ca3af'}}>
                        {dayRecs.length} report{dayRecs.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                    {types.map((type) => {
                      const typeRecs = dayRecs.filter((r) => r.type === type);
                      const color = typeColors[type] || '#374151';
                      const bg = typeBg[type] || '#f9fafb';
                      return (
                        <div key={type} style={{marginBottom: 10}}>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 700,
                              color: color,
                              letterSpacing: 0.5,
                              marginBottom: 6,
                              paddingLeft: 2,
                            }}
                          >
                            {type.toUpperCase()}
                          </div>
                          <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
                            {typeRecs.map((r, i) => {
                              const d = r.raw || {};
                              const hasMort = parseInt(d.mortality_count) > 0;
                              const hasIssue =
                                (d.issues && String(d.issues).trim().length > 2) ||
                                (d.comments &&
                                  String(d.comments).trim().length > 2 &&
                                  String(d.comments).trim() !== '0');
                              const lowVolt = d.fence_voltage != null && parseFloat(d.fence_voltage) < 3;
                              const notable = hasMort || hasIssue || lowVolt;
                              const dateIdx = di;
                              const shadeBg = dateIdx % 2 === 0 ? 'white' : '#f8fafc';
                              return (
                                <div
                                  key={i}
                                  onClick={() => {
                                    setPendingEdit({id: r.id, viewName: r.view});
                                    setView(r.view);
                                  }}
                                  style={{
                                    background: shadeBg,
                                    borderRadius: 7,
                                    border: notable ? '1.5px solid #fca5a5' : '1px solid #e5e7eb',
                                    padding: '8px 12px',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 4,
                                  }}
                                  className="hoverable-tile"
                                >
                                  {(() => {
                                    const d = r.raw;
                                    // Shared chip styles — match the admin daily-report tiles exactly.
                                    const chipBase = {
                                      fontSize: 10,
                                      fontWeight: 600,
                                      padding: '2px 7px',
                                      borderRadius: 4,
                                    };
                                    const chipYes = (label, ok) => (
                                      <span
                                        style={{
                                          ...chipBase,
                                          background: ok === false ? '#fef2f2' : '#f0fdf4',
                                          color: ok === false ? '#b91c1c' : '#065f46',
                                          border: ok === false ? '1px solid #fecaca' : '1px solid #bbf7d0',
                                        }}
                                      >
                                        {label + ': ' + (ok === false ? 'No' : 'Yes')}
                                      </span>
                                    );
                                    const teamChip = (
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
                                    );
                                    const mortChip = (n, reason) => (
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
                                        {'\ud83d\udc80 ' + n + ' mort.' + (reason ? ' \u2014 ' + reason : '')}
                                      </span>
                                    );
                                    const commentChip = (txt) => (
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
                                        {'\ud83d\udcac ' + txt}
                                      </span>
                                    );

                                    if (r.type === '🐔 Broiler') {
                                      const hasFeed = parseFloat(d.feed_lbs) > 0,
                                        hasGrit = parseFloat(d.grit_lbs) > 0,
                                        hasMort = parseInt(d.mortality_count) > 0;
                                      const comment =
                                        d.comments && String(d.comments).trim().length > 2
                                          ? String(d.comments).trim()
                                          : '';
                                      return (
                                        <>
                                          <div
                                            style={{
                                              display: 'grid',
                                              gridTemplateColumns: '110px 90px 150px 90px 1fr',
                                              alignItems: 'center',
                                              gap: 12,
                                            }}
                                          >
                                            <span
                                              style={{
                                                fontWeight: 700,
                                                color: '#111827',
                                                fontSize: 13,
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                              }}
                                            >
                                              {d.batch_label || '\u2014'}
                                            </span>
                                            {teamChip}
                                            <span
                                              style={{
                                                color: hasFeed ? '#92400e' : '#9ca3af',
                                                fontWeight: hasFeed ? 600 : 400,
                                                fontSize: 12,
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: 4,
                                                overflow: 'hidden',
                                                whiteSpace: 'nowrap',
                                                textOverflow: 'ellipsis',
                                              }}
                                            >
                                              {hasFeed
                                                ? `\ud83c\udf3e ${parseFloat(d.feed_lbs).toLocaleString()} lbs`
                                                : 'no feed'}
                                              {hasFeed && d.feed_type && (
                                                <span
                                                  style={{
                                                    fontSize: 10,
                                                    fontWeight: 700,
                                                    padding: '1px 5px',
                                                    borderRadius: 4,
                                                    background: d.feed_type === 'STARTER' ? '#dbeafe' : '#d1fae5',
                                                    color: d.feed_type === 'STARTER' ? '#1e40af' : '#065f46',
                                                  }}
                                                >
                                                  {d.feed_type}
                                                </span>
                                              )}
                                            </span>
                                            <span
                                              style={{
                                                color: '#374151',
                                                fontSize: 12,
                                                whiteSpace: 'nowrap',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                              }}
                                            >
                                              {hasGrit ? `grit ${parseFloat(d.grit_lbs)} lbs` : 'no grit'}
                                            </span>
                                            <span
                                              style={{display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center'}}
                                            >
                                              {chipYes('Moved', d.group_moved !== false)}
                                              {chipYes('Waterer', d.waterer_checked !== false)}
                                            </span>
                                          </div>
                                          {(hasMort || comment) && (
                                            <div
                                              style={{
                                                display: 'flex',
                                                gap: 8,
                                                flexWrap: 'wrap',
                                                alignItems: 'center',
                                                marginTop: 2,
                                              }}
                                            >
                                              {hasMort && mortChip(d.mortality_count, d.mortality_reason)}
                                              {comment && commentChip(comment)}
                                            </div>
                                          )}
                                        </>
                                      );
                                    }
                                    if (r.type === '🐓 Layer') {
                                      const hasFeed = parseFloat(d.feed_lbs) > 0,
                                        hasGrit = parseFloat(d.grit_lbs) > 0,
                                        hasCount = parseInt(d.layer_count) > 0,
                                        hasMort = parseInt(d.mortality_count) > 0;
                                      const comment =
                                        d.comments && String(d.comments).trim().length > 2
                                          ? String(d.comments).trim()
                                          : '';
                                      return (
                                        <>
                                          <div
                                            style={{
                                              display: 'grid',
                                              gridTemplateColumns: '110px 90px 150px 80px 80px 1fr',
                                              alignItems: 'center',
                                              gap: 12,
                                            }}
                                          >
                                            <span
                                              style={{
                                                fontWeight: 700,
                                                color: '#111827',
                                                fontSize: 13,
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                              }}
                                            >
                                              {d.batch_label || '\u2014'}
                                            </span>
                                            {teamChip}
                                            <span
                                              style={{
                                                color: hasFeed ? '#92400e' : '#9ca3af',
                                                fontWeight: hasFeed ? 600 : 400,
                                                fontSize: 12,
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: 4,
                                                overflow: 'hidden',
                                                whiteSpace: 'nowrap',
                                                textOverflow: 'ellipsis',
                                              }}
                                            >
                                              {hasFeed
                                                ? `\ud83c\udf3e ${parseFloat(d.feed_lbs).toLocaleString()} lbs`
                                                : 'no feed'}
                                              {hasFeed && d.feed_type && (
                                                <span
                                                  style={{
                                                    fontSize: 10,
                                                    fontWeight: 700,
                                                    padding: '1px 5px',
                                                    borderRadius: 4,
                                                    background:
                                                      d.feed_type === 'STARTER'
                                                        ? '#dbeafe'
                                                        : d.feed_type === 'GROWER'
                                                          ? '#d1fae5'
                                                          : '#fef3c7',
                                                    color:
                                                      d.feed_type === 'STARTER'
                                                        ? '#1e40af'
                                                        : d.feed_type === 'GROWER'
                                                          ? '#065f46'
                                                          : '#92400e',
                                                  }}
                                                >
                                                  {d.feed_type}
                                                </span>
                                              )}
                                            </span>
                                            <span style={{color: '#374151', fontSize: 12, whiteSpace: 'nowrap'}}>
                                              {hasGrit ? `grit ${d.grit_lbs} lbs` : 'no grit'}
                                            </span>
                                            <span style={{color: '#374151', fontSize: 12, whiteSpace: 'nowrap'}}>
                                              {hasCount ? `\ud83d\udc14 ${d.layer_count} hens` : 'no count'}
                                            </span>
                                            <span
                                              style={{display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center'}}
                                            >
                                              {chipYes('Moved', d.group_moved !== false)}
                                              {chipYes('Waterer', d.waterer_checked !== false)}
                                            </span>
                                          </div>
                                          {(hasMort || comment) && (
                                            <div
                                              style={{
                                                display: 'flex',
                                                gap: 8,
                                                flexWrap: 'wrap',
                                                alignItems: 'center',
                                                marginTop: 2,
                                              }}
                                            >
                                              {hasMort && mortChip(d.mortality_count, d.mortality_reason)}
                                              {comment && commentChip(comment)}
                                            </div>
                                          )}
                                        </>
                                      );
                                    }
                                    if (r.type === '🐷 Pig') {
                                      const hasFeed = parseFloat(d.feed_lbs) > 0,
                                        hasCount = parseInt(d.pig_count) > 0;
                                      const hasVolt = d.fence_voltage != null && String(d.fence_voltage).trim() !== '';
                                      const voltColor = (v) => (v < 3 ? '#b91c1c' : v < 5 ? '#92400e' : '#065f46');
                                      const hasMort = parseInt(d.mortality_count) > 0;
                                      const issues =
                                        d.issues && String(d.issues).trim().length > 2 ? String(d.issues).trim() : '';
                                      return (
                                        <>
                                          <div
                                            style={{
                                              display: 'grid',
                                              gridTemplateColumns: '110px 90px 130px 80px 80px 1fr',
                                              alignItems: 'center',
                                              gap: 12,
                                            }}
                                          >
                                            <span
                                              style={{
                                                fontWeight: 700,
                                                color: '#111827',
                                                fontSize: 13,
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                              }}
                                            >
                                              {d.batch_label || '\u2014'}
                                            </span>
                                            {teamChip}
                                            <span
                                              style={{
                                                color: hasFeed ? '#92400e' : '#9ca3af',
                                                fontWeight: hasFeed ? 600 : 400,
                                                fontSize: 12,
                                                whiteSpace: 'nowrap',
                                              }}
                                            >
                                              {hasFeed
                                                ? `\ud83c\udf3e ${parseFloat(d.feed_lbs).toLocaleString()} lbs`
                                                : 'no feed'}
                                            </span>
                                            <span style={{color: '#1e40af', fontSize: 12, whiteSpace: 'nowrap'}}>
                                              {hasCount ? `\ud83d\udc37 ${d.pig_count} pigs` : 'no count'}
                                            </span>
                                            <span
                                              style={{
                                                color: hasVolt ? voltColor(parseFloat(d.fence_voltage)) : '#9ca3af',
                                                fontWeight: hasVolt ? 600 : 400,
                                                fontSize: 12,
                                                whiteSpace: 'nowrap',
                                              }}
                                            >
                                              {hasVolt ? `\u26a1 ${d.fence_voltage} kV` : 'no voltage'}
                                            </span>
                                            <span
                                              style={{display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center'}}
                                            >
                                              {chipYes('Moved', d.group_moved !== false)}
                                              {chipYes('Nipple', d.nipple_drinker_working !== false)}
                                              {chipYes('Fence', d.fence_walked !== false)}
                                            </span>
                                          </div>
                                          {(hasMort || issues) && (
                                            <div
                                              style={{
                                                display: 'flex',
                                                gap: 8,
                                                flexWrap: 'wrap',
                                                alignItems: 'center',
                                                marginTop: 2,
                                              }}
                                            >
                                              {hasMort && mortChip(d.mortality_count, d.mortality_reason)}
                                              {issues && commentChip(issues)}
                                            </div>
                                          )}
                                        </>
                                      );
                                    }
                                    if (r.type === '🥚 Egg') {
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
                                      const comment =
                                        d.comments && String(d.comments).trim().length > 2
                                          ? String(d.comments).trim()
                                          : '';
                                      return (
                                        <>
                                          <div
                                            style={{display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap'}}
                                          >
                                            <span
                                              style={{fontWeight: 700, color: '#78350f', fontSize: 13, flexShrink: 0}}
                                            >
                                              {'\ud83e\udd5a ' + total + ' eggs'}
                                            </span>
                                            {teamChip}
                                            {groups.map(([n, c]) => (
                                              <span key={n} style={{color: '#374151', fontSize: 11}}>
                                                {n}: <strong>{c}</strong>
                                              </span>
                                            ))}
                                            {parseFloat(d.dozens_on_hand) > 0 && (
                                              <span style={{color: '#065f46', fontWeight: 600, fontSize: 12}}>
                                                {'\ud83d\udce6 ' + d.dozens_on_hand + ' doz'}
                                              </span>
                                            )}
                                          </div>
                                          {comment && (
                                            <div style={{display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2}}>
                                              {commentChip(comment)}
                                            </div>
                                          )}
                                        </>
                                      );
                                    }
                                    if (r.type === '🐄 Cattle') {
                                      const HERD_LBL = {
                                        mommas: 'Mommas',
                                        backgrounders: 'Backgrounders',
                                        finishers: 'Finishers',
                                        bulls: 'Bulls',
                                      };
                                      const HERD_C = {
                                        mommas: {bg: '#fef2f2', tx: '#991b1b', bd: '#fca5a5'},
                                        backgrounders: {bg: '#ffedd5', tx: '#9a3412', bd: '#fdba74'},
                                        finishers: {bg: '#fff1f2', tx: '#9f1239', bd: '#fda4af'},
                                        bulls: {bg: '#fee2e2', tx: '#7f1d1d', bd: '#fca5a5'},
                                      };
                                      const hc = HERD_C[d.herd] || HERD_C.mommas;
                                      const feedSummary =
                                        Array.isArray(d.feeds) && d.feeds.length > 0
                                          ? d.feeds
                                              .map(
                                                (f) =>
                                                  (f.feed_name || '?') +
                                                  (f.qty
                                                    ? ' ' +
                                                      f.qty +
                                                      ' ' +
                                                      (f.unit || '') +
                                                      (f.is_creep ? ' \ud83c\udf7c' : '')
                                                    : ''),
                                              )
                                              .join(', ')
                                          : '';
                                      const mineralSummary =
                                        Array.isArray(d.minerals) && d.minerals.length > 0
                                          ? d.minerals
                                              .map((m) => (m.name || '?') + (m.lbs ? ' ' + m.lbs + ' lb' : ''))
                                              .join(', ')
                                          : '';
                                      const hasMort = parseInt(d.mortality_count) > 0;
                                      const issues =
                                        d.issues && String(d.issues).trim().length > 2 ? String(d.issues).trim() : '';
                                      const hasVolt = d.fence_voltage != null && String(d.fence_voltage).trim() !== '';
                                      return (
                                        <>
                                          <div
                                            style={{
                                              display: 'grid',
                                              gridTemplateColumns: '120px 90px 90px 1fr',
                                              alignItems: 'center',
                                              gap: 12,
                                            }}
                                          >
                                            <span
                                              style={{
                                                padding: '2px 8px',
                                                borderRadius: 4,
                                                fontSize: 11,
                                                fontWeight: 700,
                                                background: hc.bg,
                                                color: hc.tx,
                                                border: '1px solid ' + hc.bd,
                                                textAlign: 'center',
                                                whiteSpace: 'nowrap',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                              }}
                                            >
                                              {HERD_LBL[d.herd] || d.herd || '\u2014'}
                                            </span>
                                            {teamChip}
                                            <span
                                              style={{
                                                fontSize: 11,
                                                color: hasVolt
                                                  ? parseFloat(d.fence_voltage) < 3
                                                    ? '#b91c1c'
                                                    : parseFloat(d.fence_voltage) < 5
                                                      ? '#92400e'
                                                      : '#065f46'
                                                  : '#9ca3af',
                                                fontWeight: 600,
                                                whiteSpace: 'nowrap',
                                              }}
                                            >
                                              {hasVolt ? '\u26a1 ' + d.fence_voltage + ' kV' : 'no voltage'}
                                            </span>
                                            <span
                                              style={{display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center'}}
                                            >
                                              {chipYes('Water', d.water_checked !== false)}
                                            </span>
                                          </div>
                                          {feedSummary && (
                                            <div style={{fontSize: 11, color: '#92400e'}}>
                                              {'\ud83c\udf3e ' + feedSummary}
                                            </div>
                                          )}
                                          {mineralSummary && (
                                            <div style={{fontSize: 11, color: '#6b21a8'}}>
                                              {'\ud83e\uddc2 ' + mineralSummary}
                                            </div>
                                          )}
                                          {(hasMort || issues) && (
                                            <div
                                              style={{
                                                display: 'flex',
                                                gap: 8,
                                                flexWrap: 'wrap',
                                                alignItems: 'center',
                                                marginTop: 2,
                                              }}
                                            >
                                              {hasMort && mortChip(d.mortality_count, d.mortality_reason)}
                                              {issues && commentChip(issues)}
                                            </div>
                                          )}
                                        </>
                                      );
                                    }
                                    if (r.type === '🐑 Sheep') {
                                      const FLOCK_LBL = {rams: 'Rams', ewes: 'Ewes', feeders: 'Feeders'};
                                      const FLOCK_C = {
                                        rams: {bg: '#f0fdfa', tx: '#0f766e', bd: '#5eead4'},
                                        ewes: {bg: '#fdf4ff', tx: '#86198f', bd: '#f0abfc'},
                                        feeders: {bg: '#fefce8', tx: '#854d0e', bd: '#fde047'},
                                      };
                                      const fc = FLOCK_C[d.flock] || FLOCK_C.ewes;
                                      // Cattle-parity jsonb: feeds[]/minerals[]. Hay bales = hay + bale-unit entries. Alfalfa = any feed with "alfalfa" in its name.
                                      const feedsArr = Array.isArray(d.feeds) ? d.feeds : [];
                                      const bales = feedsArr.reduce(
                                        (s, f) =>
                                          s + (f.category === 'hay' && f.unit === 'bale' ? parseFloat(f.qty) || 0 : 0),
                                        0,
                                      );
                                      // Pellets only — keeps hay-category 'ALFALFA' bales out of the alfalfa-lb chip.
                                      const alfalfaLbs = feedsArr.reduce((s, f) => {
                                        const nm = String(f.feed_name || '').toLowerCase();
                                        return (
                                          s +
                                          (f.category === 'pellet' && nm.includes('alfalfa')
                                            ? parseFloat(f.lbs_as_fed) || 0
                                            : 0)
                                        );
                                      }, 0);
                                      const hasHay = bales > 0;
                                      const hasAlfalfa = alfalfaLbs > 0;
                                      const mineralsArr = Array.isArray(d.minerals) ? d.minerals : [];
                                      const hasMinerals = mineralsArr.length > 0;
                                      const hasMort = (d.mortality_count || 0) > 0;
                                      const rawCmt = d.comments == null ? '' : String(d.comments).trim();
                                      const cmtLow = rawCmt.toLowerCase();
                                      const comment =
                                        rawCmt === '' ||
                                        cmtLow === 'none' ||
                                        cmtLow === '0' ||
                                        cmtLow === 'n/a' ||
                                        cmtLow === 'na' ||
                                        cmtLow === '-'
                                          ? ''
                                          : rawCmt;
                                      const hasVolt = d.fence_voltage_kv != null;
                                      const voltColor = (v) => (v < 2 ? '#b91c1c' : v < 4 ? '#92400e' : '#065f46');
                                      return (
                                        <>
                                          <div
                                            style={{
                                              display: 'grid',
                                              gridTemplateColumns: '120px 90px 90px 90px 90px 1fr',
                                              alignItems: 'center',
                                              gap: 12,
                                            }}
                                          >
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
                                              {FLOCK_LBL[d.flock] || d.flock || '\u2014'}
                                            </span>
                                            {teamChip}
                                            <span
                                              style={{
                                                color: hasHay ? '#92400e' : '#9ca3af',
                                                fontWeight: hasHay ? 600 : 400,
                                                fontSize: 12,
                                                whiteSpace: 'nowrap',
                                              }}
                                            >
                                              {hasHay ? `\ud83c\udf3e ${bales} bales` : 'no hay'}
                                            </span>
                                            <span
                                              style={{
                                                color: hasAlfalfa ? '#92400e' : '#9ca3af',
                                                fontWeight: hasAlfalfa ? 600 : 400,
                                                fontSize: 12,
                                                whiteSpace: 'nowrap',
                                              }}
                                            >
                                              {hasAlfalfa ? `alfalfa ${Math.round(alfalfaLbs)} lb` : 'no alfalfa'}
                                            </span>
                                            <span
                                              style={{
                                                color: hasVolt ? voltColor(parseFloat(d.fence_voltage_kv)) : '#9ca3af',
                                                fontWeight: hasVolt ? 600 : 400,
                                                fontSize: 12,
                                                whiteSpace: 'nowrap',
                                              }}
                                            >
                                              {hasVolt ? `\u26a1 ${d.fence_voltage_kv} kV` : 'no voltage'}
                                            </span>
                                            <span
                                              style={{display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center'}}
                                            >
                                              {hasMinerals && (
                                                <span
                                                  style={{
                                                    ...chipBase,
                                                    background: '#f0fdf4',
                                                    color: '#065f46',
                                                    border: '1px solid #bbf7d0',
                                                  }}
                                                >
                                                  Minerals: Yes
                                                </span>
                                              )}
                                              {chipYes('Waterers', d.waterers_working !== false)}
                                            </span>
                                          </div>
                                          {(hasMort || comment) && (
                                            <div
                                              style={{
                                                display: 'flex',
                                                gap: 8,
                                                flexWrap: 'wrap',
                                                alignItems: 'center',
                                                marginTop: 2,
                                              }}
                                            >
                                              {hasMort && mortChip(d.mortality_count, null)}
                                              {comment && commentChip(comment)}
                                            </div>
                                          )}
                                        </>
                                      );
                                    }
                                    return null;
                                  })()}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              });
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
