import {addDays, fmt, toISO} from '../lib/dateUtils.js';
import {calcTimeline} from '../lib/broiler.js';
import {activePigFeederDailyTargets, buildCycleSeqMap, calcBreedingTimeline, cycleLabel} from '../lib/pig.js';
import {computeIntervalStatus, daysSince, latestSaneReading, WARRANTY_WINDOW_DAYS} from '../lib/equipment.js';
import {ANIMAL_ICON_KEYS, PLANNER_ICON_KEYS} from '../lib/plannerIcons.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asClearedSet(value) {
  return value instanceof Set ? value : new Set(asArray(value));
}

export function foldEquipmentFuelings(rows = []) {
  const equipmentCompletions = {};
  const equipmentFuelings = {};
  for (const r of asArray(rows)) {
    if (!equipmentFuelings[r.equipment_id]) equipmentFuelings[r.equipment_id] = [];
    equipmentFuelings[r.equipment_id].push(r);
    const comps = Array.isArray(r.service_intervals_completed) ? r.service_intervals_completed : [];
    if (comps.length > 0) {
      const fallbackReading =
        r.hours_reading != null ? Number(r.hours_reading) : r.km_reading != null ? Number(r.km_reading) : null;
      const normalized = comps.map((c) => ({
        ...c,
        reading_at_completion: c && c.reading_at_completion != null ? Number(c.reading_at_completion) : fallbackReading,
        team_member: c && c.team_member != null ? c.team_member : r.team_member || null,
      }));
      equipmentCompletions[r.equipment_id] = [...(equipmentCompletions[r.equipment_id] || []), ...normalized];
    }
  }
  for (const id in equipmentFuelings) {
    equipmentFuelings[id].sort((a, b) => {
      const ra = a.hours_reading != null ? Number(a.hours_reading) : a.km_reading != null ? Number(a.km_reading) : null;
      const rb = b.hours_reading != null ? Number(b.hours_reading) : b.km_reading != null ? Number(b.km_reading) : null;
      if (ra != null && rb != null && ra !== rb) return rb - ra;
      return String(b.date || '').localeCompare(String(a.date || ''));
    });
  }
  return {equipmentCompletions, equipmentFuelings};
}

export function buildNext30Events({batches, breedingCycles, farrowingRecs, feederGroups, today = new Date()} = {}) {
  const todayDate = today instanceof Date ? today : new Date(today);
  const todayStr = toISO(todayDate);
  const in30 = toISO(addDays(todayDate, 30));
  const weekEvents = [];

  asArray(batches).forEach((b) => {
    const live = calcTimeline(b.hatchDate, b.breed, b.processingDate);
    if (!live) return;
    if (live.brooderIn >= todayStr && live.brooderIn <= in30) {
      weekEvents.push({
        type: 'brooder-in',
        label: `${b.name} enters brooder`,
        date: live.brooderIn,
        color: '#065f46',
        iconKey: ANIMAL_ICON_KEYS.broiler,
      });
    }
    if (live.schoonerIn >= todayStr && live.schoonerIn <= in30) {
      weekEvents.push({
        type: 'schooner-in',
        label: `${b.name} moves to schooner`,
        date: live.schoonerIn,
        color: '#a16207',
        iconKey: ANIMAL_ICON_KEYS.broiler,
      });
    }
    if (b.processingDate >= todayStr && b.processingDate <= in30) {
      weekEvents.push({
        type: 'processing',
        label: `${b.name} processing day`,
        date: b.processingDate,
        color: '#7f1d1d',
        iconKey: ANIMAL_ICON_KEYS.broiler,
      });
    }
    if (b.hatchDate) {
      const wk4date = toISO(addDays(new Date(b.hatchDate + 'T12:00:00'), 28));
      if (wk4date >= todayStr && wk4date <= in30 && !(parseFloat(b.week4Lbs) > 0)) {
        weekEvents.push({
          type: 'wt-4wk',
          label: `${b.name} — record 4-week weights`,
          date: wk4date,
          color: '#854d0e',
          iconKey: PLANNER_ICON_KEYS.weighins,
          reminder: true,
        });
      }
    }
    if (b.hatchDate) {
      const wk6date = toISO(addDays(new Date(b.hatchDate + 'T12:00:00'), 42));
      if (wk6date >= todayStr && wk6date <= in30 && !(parseFloat(b.week6Lbs) > 0)) {
        weekEvents.push({
          type: 'wt-6wk',
          label: `${b.name} — record 6-week weights`,
          date: wk6date,
          color: '#854d0e',
          iconKey: PLANNER_ICON_KEYS.weighins,
          reminder: true,
        });
      }
    }
  });

  const weekSeqMap = buildCycleSeqMap(asArray(breedingCycles));
  asArray(breedingCycles).forEach((c) => {
    const tl = calcBreedingTimeline(c.exposureStart);
    if (!tl) return;
    const lbl = cycleLabel(c, weekSeqMap);
    if (tl.farrowingStart >= todayStr && tl.farrowingStart <= in30) {
      weekEvents.push({
        type: 'farrow-open',
        label: `${lbl} farrowing window opens`,
        date: tl.farrowingStart,
        color: '#1e40af',
        iconKey: ANIMAL_ICON_KEYS.pig,
      });
    }
    if (tl.farrowingEnd >= todayStr && tl.farrowingEnd <= in30) {
      weekEvents.push({
        type: 'farrow-close',
        label: `${lbl} farrowing window closes`,
        date: tl.farrowingEnd,
        color: '#be185d',
        iconKey: ANIMAL_ICON_KEYS.pig,
      });
    }
    if (tl.farrowingStart <= in30 && tl.farrowingEnd >= todayStr) {
      const expected = [...(c.boar1Tags || '').split(/[\n,]+/), ...(c.boar2Tags || '').split(/[\n,]+/)]
        .map((t) => t.trim())
        .filter(Boolean);
      const farrowed = new Set(
        asArray(farrowingRecs)
          .filter((r) => r.group === c.group)
          .map((r) => r.sow.trim()),
      );
      const pending = expected.filter((t) => !farrowed.has(t));
      if (pending.length > 0) {
        const windowActive = tl.farrowingStart <= todayStr;
        weekEvents.push({
          type: 'farrow-due',
          label: `${lbl} sow group farrowing window ${windowActive ? 'active' : 'opens'}`,
          date: tl.farrowingStart,
          subline: windowActive
            ? `Window ${fmt(tl.farrowingStart)}-${fmt(tl.farrowingEnd)}`
            : `Opens ${fmt(tl.farrowingStart)}`,
          color: '#1e40af',
          iconKey: ANIMAL_ICON_KEYS.pig,
        });
      }
    }
  });

  asArray(feederGroups).forEach((g) => {
    const cycle = asArray(breedingCycles).find((c) => c.id === g.cycleId);
    if (!cycle) return;
    const tl = calcBreedingTimeline(cycle.exposureStart);
    if (!tl) return;
    const farrowMid = new Date(tl.farrowingStart + 'T12:00:00');
    const sixMonths = toISO(addDays(farrowMid, 183));
    if (sixMonths >= todayStr && sixMonths <= in30) {
      weekEvents.push({
        type: 'pig-age',
        label: `${g.batchName} hitting ~6 months`,
        date: sixMonths,
        color: '#92400e',
        iconKey: ANIMAL_ICON_KEYS.pig,
      });
    }
  });

  return weekEvents.sort((a, b) => a.date.localeCompare(b.date));
}

export function buildMissedDailyReports({
  batches,
  broilerDailys,
  pigDailys,
  layerDailysRecent,
  cattleDailysRecent,
  sheepDailysRecent,
  feederGroups,
  breeders,
  layerGroups,
  cattleForHome,
  sheepForHome,
  missedCleared,
  today = new Date(),
} = {}) {
  const cleared = asClearedSet(missedCleared);
  const todayDate = today instanceof Date ? today : new Date(today);
  const allMissed = [];
  for (let daysBack = 1; daysBack <= 7; daysBack++) {
    const checkDate = toISO(addDays(todayDate, -daysBack));
    const broilerCheck = new Set(
      asArray(broilerDailys)
        .filter((d) => d.date === checkDate)
        .map((d) =>
          (d.batch_label || '')
            .toLowerCase()
            .trim()
            .replace(/^\(processed\)\s*/, ''),
        ),
    );
    const pigCheck = new Set(
      asArray(pigDailys)
        .filter((d) => d.date === checkDate)
        .map((d) => (d.batch_label || '').toLowerCase().trim()),
    );
    const layerCheck = new Set(
      asArray(layerDailysRecent)
        .filter((d) => d.date === checkDate)
        .map((d) => (d.batch_label || '').toLowerCase().trim()),
    );

    asArray(batches)
      .filter((b) => b.status === 'active')
      .forEach((b) => {
        const earliestDate = b.brooderIn || b.hatchDate;
        if (earliestDate && checkDate < earliestDate) return;
        if (b.processingDate && checkDate > b.processingDate) return;
        const key = `${b.id}|${checkDate}`;
        if (!broilerCheck.has((b.name || '').toLowerCase().trim()) && !cleared.has(key)) {
          allMissed.push({key, label: b.name, iconKey: ANIMAL_ICON_KEYS.broiler, type: 'Broiler', date: checkDate});
        }
      });

    activePigFeederDailyTargets(asArray(feederGroups)).forEach((t) => {
      const key = `${t.id}|${checkDate}`;
      if (!pigCheck.has((t.name || '').toLowerCase().trim()) && !cleared.has(key)) {
        allMissed.push({
          key,
          label: t.name,
          iconKey: ANIMAL_ICON_KEYS.pig,
          type: `Pig · ${t.parentBatchName}`,
          date: checkDate,
        });
      }
    });

    const hasActiveSows = asArray(breeders).some((b) => !b.archived && (b.sex === 'Sow' || b.sex === 'Gilt'));
    const hasActiveBoars = asArray(breeders).some((b) => !b.archived && b.sex === 'Boar');
    if (hasActiveSows) {
      const key = `pig-stock-sows|${checkDate}`;
      if (!pigCheck.has('sows') && !cleared.has(key)) {
        allMissed.push({key, label: 'SOWS', iconKey: ANIMAL_ICON_KEYS.pig, type: 'Pig', date: checkDate});
      }
    }
    if (hasActiveBoars) {
      const key = `pig-stock-boars|${checkDate}`;
      if (!pigCheck.has('boars') && !cleared.has(key)) {
        allMissed.push({key, label: 'BOARS', iconKey: ANIMAL_ICON_KEYS.pig, type: 'Pig', date: checkDate});
      }
    }

    asArray(layerGroups)
      .filter((g) => g.status === 'active')
      .forEach((g) => {
        const key = `${g.id}|${checkDate}`;
        if (!layerCheck.has((g.name || '').toLowerCase().trim()) && !cleared.has(key)) {
          allMissed.push({key, label: g.name, iconKey: ANIMAL_ICON_KEYS.layer, type: 'Layer', date: checkDate});
        }
      });

    const cattleCheck = new Set(
      asArray(cattleDailysRecent)
        .filter((d) => d.date === checkDate)
        .map((d) => d.herd),
    );
    ['mommas', 'backgrounders', 'finishers', 'bulls'].forEach((h) => {
      if (!asArray(cattleForHome).some((c) => c.herd === h)) return;
      const key = `cattle-${h}|${checkDate}`;
      if (!cattleCheck.has(h) && !cleared.has(key)) {
        allMissed.push({
          key,
          label: h.charAt(0).toUpperCase() + h.slice(1),
          iconKey: ANIMAL_ICON_KEYS.cattle,
          type: 'Cattle',
          date: checkDate,
        });
      }
    });

    const sheepCheck = new Set(
      asArray(sheepDailysRecent)
        .filter((d) => d.date === checkDate)
        .map((d) => d.flock),
    );
    ['rams', 'ewes', 'feeders'].forEach((f) => {
      if (!asArray(sheepForHome).some((s) => s.flock === f)) return;
      const key = `sheep-${f}|${checkDate}`;
      if (!sheepCheck.has(f) && !cleared.has(key)) {
        allMissed.push({
          key,
          label: f.charAt(0).toUpperCase() + f.slice(1),
          iconKey: ANIMAL_ICON_KEYS.sheep,
          type: 'Sheep',
          date: checkDate,
        });
      }
    });
  }
  return allMissed.sort((a, b) => b.date.localeCompare(a.date));
}

export function buildEquipmentAttention({equipment, equipmentFuelings, equipmentCompletions, missedCleared} = {}) {
  const cleared = asClearedSet(missedCleared);
  const equipmentAttention = [];
  asArray(equipment).forEach((eq) => {
    const unit = eq.tracking_unit === 'km' ? 'km' : 'hours';
    const unitLabel = unit === 'km' ? 'km' : 'h';
    const currentReading = latestSaneReading(eq, (equipmentFuelings || {})[eq.id] || []);
    const intervals = Array.isArray(eq.service_intervals) ? eq.service_intervals : [];
    const completions = (equipmentCompletions || {})[eq.id] || [];

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

    const fillupItems = Array.isArray(eq.every_fillup_items) ? eq.every_fillup_items : [];
    const fuelings = (equipmentFuelings || {})[eq.id] || [];
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
        equipmentAttention.push({
          key: `equip-fillup-${eq.id}|streak${maxStreak}|n${itemsWithStreak.length}`,
          kind: 'fillup_streak',
          slug: eq.slug,
          label: eq.name,
          detail: `${itemsWithStreak.length} fillup item${itemsWithStreak.length === 1 ? '' : 's'} skipped (${maxStreak}× max streak): ${sample}${more}`,
        });
      }
    }

    if (eq.warranty_expiration) {
      const d = daysSince(eq.warranty_expiration);
      if (d != null && d >= -WARRANTY_WINDOW_DAYS) {
        let detail;
        if (d > 0) detail = `Warranty expired ${d} day${d === 1 ? '' : 's'} ago`;
        else if (d === 0) detail = 'Warranty expires today';
        else detail = `Warranty expires in ${-d} day${-d === 1 ? '' : 's'}`;
        const key = `equip-warranty-${eq.id}|${eq.warranty_expiration}`;
        if (!cleared.has(key)) {
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

  const kindOrder = {overdue: 0, fillup_streak: 1, warranty: 2};
  return equipmentAttention.sort((a, b) => {
    const ko = (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9);
    if (ko !== 0) return ko;
    return a.label.localeCompare(b.label);
  });
}
