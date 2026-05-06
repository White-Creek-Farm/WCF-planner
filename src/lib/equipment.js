// Equipment module constants + helpers. Used by every equipment view +
// the /fueling public webform. Kept free of React + Supabase so it can be
// imported from anywhere including scripts.

export const EQUIPMENT_CATEGORIES = [
  {key: 'tractors', label: 'Tractors', icon: '🚜', color: '#065f46', bg: '#ecfdf5', bd: '#a7f3d0'},
  {key: 'atvs', label: 'ATVs', icon: '🛵', color: '#1e40af', bg: '#eff6ff', bd: '#bfdbfe'},
  {key: 'hijets', label: 'Hijets', icon: '🛻', color: '#92400e', bg: '#fffbeb', bd: '#fde68a'},
  {key: 'mowers', label: 'Mowers', icon: '🌱', color: '#a16207', bg: '#fef9c3', bd: '#fde047'},
  {key: 'skidsteers', label: 'Skidsteers', icon: '🚧', color: '#7f1d1d', bg: '#fef2f2', bd: '#fca5a5'},
  {key: 'forestry', label: 'Forestry', icon: '🌲', color: '#065f46', bg: '#f0fdfa', bd: '#5eead4'},
];

export const CATEGORY_BY_KEY = Object.fromEntries(EQUIPMENT_CATEGORIES.map((c) => [c.key, c]));

// Equipment program color (for nav cards, tabs, etc.). Slate/steel.
export const EQUIPMENT_COLOR = '#57534e';
export const EQUIPMENT_BG = '#fafaf9';
export const EQUIPMENT_BD = '#d6d3d1';

// Threshold in days without a fueling entry before HomeDashboard flags the
// piece of equipment. Ronnie's call 2026-04-23: 14 days.
export const MISSED_FUELING_DAYS = 14;

// Warranty expiring threshold (days).
export const WARRANTY_WINDOW_DAYS = 60;

// Compute the next-due reading for a given interval on an equipment given
// its current reading. Handles the divisor rule: if interval X has been
// implicitly completed because a bigger interval Y (where X | Y) was done
// at the same milestone, the effective "last done" shifts up.
//
// currentReading: int (hours or km on the machine right now)
// intervals: array of {hours_or_km, kind, label}
// completions: array of {interval, kind, completed_at, ...} sorted by completed_at desc
//
// Returns for each interval: {next_due, overdue, completed_at_last, days_since_last}
export function computeIntervalStatus(intervals, completions, currentReading) {
  if (!Array.isArray(intervals) || intervals.length === 0) return [];

  // Defer to aggregateCompletionsByMilestone for the snap + cumulative-partial
  // logic. The same union-of-items rule applies: maintenance split across
  // sessions toward the same milestone counts as one virtual full completion.
  // Completions with a missing reading_at_completion fall back to the current
  // reading (matches prior behavior for legacy data without a snapshot).
  const normalized = (completions || []).map((c) => ({
    ...c,
    reading_at_completion: Number.isFinite(c?.reading_at_completion) ? c.reading_at_completion : currentReading,
  }));
  const {milestoneSatisfied, milestoneSatisfiedRaw} = aggregateCompletionsByMilestone(intervals, normalized);

  return intervals.map((iv) => {
    const key = iv.kind + ':' + iv.hours_or_km;
    const lastM = milestoneSatisfied.get(key) || 0; // already a multiple of iv.hours_or_km
    const lastR = milestoneSatisfiedRaw.get(key) || null;
    const nextDue = lastM > 0 ? lastM + iv.hours_or_km : iv.hours_or_km;
    const overdue = currentReading != null && currentReading > nextDue;
    // Round to 1 decimal to dodge float-subtraction garbage
    // (e.g. 550 - 509.3 producing 40.69999999999999).
    const untilDue = currentReading != null ? Math.round((nextDue - currentReading) * 10) / 10 : null;
    return {
      ...iv,
      last_at_reading: lastR,
      last_satisfied_milestone: lastM > 0 ? lastM : null,
      next_due: nextDue,
      overdue: !!overdue,
      until_due: untilDue,
    };
  });
}

// Does the machine need any service right now? Returns the soonest-overdue
// interval or null.
export function soonestDue(intervals, completions, currentReading, windowHours = 50) {
  const statuses = computeIntervalStatus(intervals, completions, currentReading);
  if (currentReading == null) return null;
  // Priority: overdue first, then within windowHours of next_due.
  const overdue = statuses
    .filter((s) => s.overdue)
    .sort((a, b) => currentReading - a.next_due - (currentReading - b.next_due));
  if (overdue.length > 0) return overdue[0];
  const upcoming = statuses
    .filter((s) => s.until_due != null && s.until_due <= windowHours)
    .sort((a, b) => a.until_due - b.until_due);
  return upcoming[0] || null;
}

// Snap a completion reading to the nearest milestone of the given interval.
// E.g. interval=500, reading=968 → snaps to 1000 (32 away vs 468 away).
// Tie-break favors the previous milestone (treat as late completion of prior).
// This is the math fix for the 2026-04-25 scenario where a 500hr maintenance
// done at 968h was being treated as a 468h-late completion of the 500
// milestone, then immediately flagged as overdue at 1000h. Under snap-to-
// nearest, 968h satisfies the 1000h milestone, next due at 1500h.
function snapToNearestMilestone(reading, interval) {
  if (!Number.isFinite(reading) || reading <= 0) return 0;
  if (!Number.isFinite(interval) || interval <= 0) return 0;
  const fwd = Math.ceil(reading / interval) * interval;
  const back = Math.floor(reading / interval) * interval;
  // Already on a milestone — return it.
  if (fwd === back) return fwd;
  return fwd - reading < reading - back ? fwd : back;
}

// Given the equipment's intervals + fueling history + the reading the team
// just entered, compute which intervals are DUE RIGHT NOW. Ronnie's logic
// (2026-04-23): require the team to enter current reading, then walk back
// through prior fuel-up history to find intervals whose milestones were
// passed but never ticked. Return an array sorted by most-missed first.
//
// Each completion is snapped to the nearest milestone of its interval — that
// becomes the "satisfied milestone". Next due = satisfied + interval. So a
// 500hr done at 968h satisfies the 1000h milestone (closer than 500h),
// scheduling next 500hr at 1500h. A 500hr done at 1100h still snaps to
// 1000 (closer than 1500), scheduling next at 1500h. A 500hr done at
// 750h (exactly midway) snaps to 500h via the conservative tie-break.
export function computeDueIntervals(intervals, completions, currentReading) {
  if (!Array.isArray(intervals) || intervals.length === 0) return [];
  if (!Number.isFinite(Number(currentReading)) || currentReading <= 0) return [];

  // Group ALL completions (full + partial) by (interval, snapped milestone).
  // Within a group, the union of items_completed is what's been done toward
  // that milestone. If the union covers all tasks → virtual full completion.
  // This handles the real-world flow where maintenance spans sessions: e.g.
  // a 500hr partial at 440h (14/16) + a 500hr partial at 444h (the missing
  // 2 of 16, done after parts arrived) = full coverage of the 500h milestone.
  const {milestoneSatisfied, milestoneSatisfiedRaw, partialState} = aggregateCompletionsByMilestone(
    intervals,
    completions,
  );

  const due = [];
  for (const iv of intervals) {
    const key = iv.kind + ':' + iv.hours_or_km;
    // The snapped milestone drives next-due math; the raw reading is for display.
    const lastSnapped = milestoneSatisfied.get(key) || 0;
    const lastRaw = milestoneSatisfiedRaw.get(key) || 0;
    const firstMilestoneAfterLast = lastSnapped > 0 ? lastSnapped + iv.hours_or_km : iv.hours_or_km; // no completion ever — first due at the first milestone
    if (firstMilestoneAfterLast > currentReading) continue;
    const largestMilestoneAtOrBeforeCurrent = Math.floor(currentReading / iv.hours_or_km) * iv.hours_or_km;
    const missedCount = (largestMilestoneAtOrBeforeCurrent - firstMilestoneAfterLast) / iv.hours_or_km + 1;
    // Partial display: the cumulative state of the highest UNSATISFIED milestone.
    const ps = partialState.get(key);
    const lastPartial =
      ps && ps.milestone > lastSnapped
        ? {
            items_done: ps.items_done,
            items_completed: ps.items_completed,
            total: ps.total,
            at_reading: ps.latestSnap,
            team_member: ps.latestTeam,
            milestone: ps.milestone,
          }
        : null;
    due.push({
      ...iv,
      last_done_at: lastRaw > 0 ? lastRaw : null,
      last_done_milestone: lastSnapped > 0 ? lastSnapped : null,
      first_missed_at: firstMilestoneAfterLast,
      current_milestone: largestMilestoneAtOrBeforeCurrent,
      missed_count: missedCount,
      last_partial: lastPartial,
    });
  }

  // Ascending — smallest interval first (50h before 600h before 1200h).
  return due.sort((a, b) => a.hours_or_km - b.hours_or_km);
}

// Internal helper used by both computeDueIntervals and computeIntervalStatus.
// Aggregates completions by (interval, snapped milestone) and decides which
// milestones are satisfied (full or virtual full from cumulative partials).
//
// A "virtual full" happens when the union of items_completed across all
// completions in the same milestone group covers the interval's task count.
// This handles the real-world flow where maintenance is split across multiple
// sessions before the next milestone hits.
//
// Returns:
//   milestoneSatisfied:    Map<kind:value, milestoneNumber>
//   milestoneSatisfiedRaw: Map<kind:value, latestRawReading>
//   partialState:          Map<kind:value, {milestone, latestSnap, latestTeam,
//                                            items_completed, items_done, total}>
function aggregateCompletionsByMilestone(intervals, completions) {
  function isFullCompletion(c) {
    if (!c.total_tasks || c.total_tasks === 0) return true;
    const count = Array.isArray(c.items_completed) ? c.items_completed.length : 0;
    return count >= c.total_tasks;
  }

  // Authoritative task count per interval — uses CURRENT equipment config so
  // historical completions get re-evaluated against today's task list.
  const currentTotals = new Map();
  for (const iv of intervals) {
    currentTotals.set(iv.kind + ':' + iv.hours_or_km, Array.isArray(iv.tasks) ? iv.tasks.length : 0);
  }

  // Group by (kind, interval, snapped milestone).
  const groups = new Map();
  for (const c of completions || []) {
    if (!c || !c.interval || !c.kind) continue;
    const snap = Number.isFinite(c.reading_at_completion) ? c.reading_at_completion : null;
    if (snap == null) continue;
    const milestone = snapToNearestMilestone(snap, c.interval);
    const key = c.kind + ':' + c.interval + ':' + milestone;
    if (!groups.has(key))
      groups.set(key, {
        kind: c.kind,
        interval: c.interval,
        milestone,
        entries: [],
      });
    groups.get(key).entries.push(c);
  }

  const milestoneSatisfied = new Map();
  const milestoneSatisfiedRaw = new Map();
  const partialState = new Map();

  for (const g of groups.values()) {
    const ivKey = g.kind + ':' + g.interval;
    // currentTotals may be 0 for an interval that has no sub-tasks (parent-tick only).
    const total = currentTotals.has(ivKey) ? currentTotals.get(ivKey) : (g.entries[0] && g.entries[0].total_tasks) || 0;

    const allItems = new Set();
    let hasFullEntry = false;
    let latestSnap = 0,
      latestTeam = null;
    for (const e of g.entries) {
      const items = Array.isArray(e.items_completed) ? e.items_completed : [];
      for (const id of items) allItems.add(id);
      if (isFullCompletion(e)) hasFullEntry = true;
      if (e.reading_at_completion > latestSnap) {
        latestSnap = e.reading_at_completion;
        latestTeam = e.team_member || null;
      }
    }

    // For sub-tasks check the union; for parent-tick-only intervals (total=0)
    // a single full entry is enough.
    const isCumulativeFull = hasFullEntry || (total > 0 && allItems.size >= total);

    if (isCumulativeFull) {
      const ex = milestoneSatisfied.get(ivKey);
      if (!ex || g.milestone > ex) {
        milestoneSatisfied.set(ivKey, g.milestone);
        milestoneSatisfiedRaw.set(ivKey, latestSnap);
      }
    } else {
      const ex = partialState.get(ivKey);
      if (!ex || g.milestone > ex.milestone) {
        partialState.set(ivKey, {
          milestone: g.milestone,
          latestSnap,
          latestTeam,
          items_completed: Array.from(allItems),
          items_done: allItems.size,
          total,
        });
      }
    }
  }

  // Divisor rule: a satisfied parent milestone implicitly satisfies any
  // sub-interval that divides it. Cascade the parent's RAW reading to each
  // sub-interval; each sub does its own independent snap.
  for (const ivKey of Array.from(milestoneSatisfied.keys())) {
    const rawOfParent = milestoneSatisfiedRaw.get(ivKey);
    const [kind, vStr] = ivKey.split(':');
    const parentInterval = parseInt(vStr, 10);
    for (const iv of intervals) {
      if (iv.kind !== kind) continue;
      if (iv.hours_or_km === parentInterval) continue;
      if (parentInterval % iv.hours_or_km !== 0) continue;
      const subKey = iv.kind + ':' + iv.hours_or_km;
      const subSnapped = snapToNearestMilestone(rawOfParent, iv.hours_or_km);
      const ex = milestoneSatisfied.get(subKey);
      if (!ex || subSnapped > ex) {
        milestoneSatisfied.set(subKey, subSnapped);
        milestoneSatisfiedRaw.set(subKey, rawOfParent);
      }
    }
  }

  return {milestoneSatisfied, milestoneSatisfiedRaw, partialState};
}

// Strip Podio HTML tags (and trivial "None" placeholder) from comment text.
// Podio stored comments as rendered HTML like "<p>None</p>" or "<p>Did not
// do checklist</p>"; we want clean plain text in the UI.
export function stripPodioHtml(s) {
  if (s == null) return null;
  const clean = String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || clean.toLowerCase() === 'none' || clean === 'N/A' || clean.toLowerCase() === 'n/a') return null;
  return clean;
}

// Days since an ISO date. Returns null for falsy/invalid input.
export function daysSince(iso) {
  if (!iso) return null;
  const t = new Date((iso + '').slice(0, 10) + 'T12:00:00').getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

// Pretty-print a reading with unit. 1234 hours → "1,234 h"; 5000 km → "5,000 km".
export function fmtReading(value, unit) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Math.round(value).toLocaleString() + ' ' + (unit === 'km' ? 'km' : 'h');
}

// Derive an effective current reading for an equipment row. Originally a
// drift-compensation helper: anon-context updates to equipment.current_*
// from the public fueling webform were silently failing under prod RLS
// (recon 2026-04-28), and HomeDashboard's overdue-interval math was running
// against stale parent rows. Mig 047 (submit_equipment_fueling SECURITY
// DEFINER RPC, 2026-05-06) fixes the write path AND ships a one-shot
// reconciliation; new submissions correctly bump equipment.current_*. The
// helper stays in place as defensive fallback — historical pre-mig-047
// rows + any future caller that bypasses the RPC are still tolerated by
// this read-side derivation.
//
// Rule:
//   1. Pick the latest fueling by date for this piece.
//   2. If that fueling's reading (in the equipment's tracking unit) is
//      strictly greater than equipment.current_*, use it.
//   3. Otherwise fall back to equipment.current_* (admin-controlled value
//      stays authoritative when it's ahead of any anon submission, e.g.
//      after a manual reading correction).
//   4. No fuelings → equipment.current_*.
//
// Fuelings array shape: each entry has {date, hours_reading?, km_reading?}.
// Order is irrelevant — helper picks the max-date row internally.
export function latestSaneReading(eq, fuelings) {
  const unit = eq?.tracking_unit === 'km' ? 'km' : 'hours';
  const readingCol = unit === 'km' ? 'km_reading' : 'hours_reading';
  const currentCol = unit === 'km' ? 'current_km' : 'current_hours';
  const currentReading = Number(eq?.[currentCol]);
  if (!Array.isArray(fuelings) || fuelings.length === 0) return currentReading;
  const latest = fuelings.reduce((m, f) => (!m || (f?.date || '') > (m?.date || '') ? f : m), null);
  const latestReading = Number(latest?.[readingCol]);
  // When equipment.current_* is blank (null/undefined), Number() returns NaN.
  // Without the !isFinite-current check we'd return NaN even though we have a
  // valid latest fueling reading. Treat blank current_* as "no admin floor"
  // and let the latest fueling reading stand.
  if (Number.isFinite(latestReading) && (!Number.isFinite(currentReading) || latestReading > currentReading)) {
    return latestReading;
  }
  return currentReading;
}
