// CattleForecastView — flagship visual planning surface for the cattle program.
// Replaces Nick's manual spreadsheet finisher forecast workflow.
//
// Locked behaviors live in src/lib/cattleForecast.js (pure deterministic math).
// This file is UI wiring + read/write through src/lib/cattleForecastApi.js.
//
// Edit-permission tiering (management/admin vs farm_team) is enforced HERE,
// in the UI, per the build packet decision. RLS on the three forecast tables
// is broad-authenticated; the database itself doesn't filter writes by role.
import React from 'react';
import UsersModal from '../auth/UsersModal.jsx';
import CowDetail from './CowDetail.jsx';
import {loadCattleWeighInsCached, invalidateCattleWeighInsCache} from '../lib/cattleCache.js';
import {
  buildForecast,
  monthLabel,
  monthStartMs,
  parseMonthKey,
  formatAdgCalc,
  isHeiferEligibleForInclude,
  projectedWeightAtMonth,
  WATCHLIST_REASONS,
  FORECAST_DISPLAY_WEIGHT_MIN_DEFAULT,
  FORECAST_DISPLAY_WEIGHT_MAX_DEFAULT,
  FORECAST_FALLBACK_ADG_DEFAULT,
  FORECAST_BIRTH_WEIGHT_LB_DEFAULT,
  FORECAST_HORIZON_YEARS_DEFAULT,
} from '../lib/cattleForecast.js';
import {
  loadForecastSettings,
  saveForecastSettings,
  loadHeiferIncludes,
  saveHeiferIncludes,
  loadHidden,
  addHidden,
  removeHidden,
} from '../lib/cattleForecastApi.js';
import {CATTLE_HERD_KEYS, cowTagSet} from '../lib/cattleHerdFilters.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import {runMutation, recordFieldChange, recordActivityEvent} from '../lib/entityMutations.js';
import {buildChanges, countSummary} from '../lib/activityChangeDiff.js';

const CATTLE_EXCLUDE = ['herd', 'processing_batch_id'];
const CATTLE_LABELS = {
  tag: 'Tag',
  sex: 'Sex',
  breed: 'Breed',
  origin: 'Origin',
  birth_date: 'Birth date',
  purchase_date: 'Purchase date',
  purchase_amount: 'Purchase amount',
  dam_tag: 'Dam tag',
  sire_tag: 'Sire tag',
  registration_num: 'Registration #',
  pct_wagyu: '% Wagyu',
  breeding_status: 'Breeding status',
  breeding_blacklist: 'Breeding blacklist',
  sale_date: 'Sale date',
  sale_amount: 'Sale amount',
  death_date: 'Death date',
  death_reason: 'Death reason',
  old_tags: 'Prior tags',
};
const CATTLE_FORMATTERS = {
  old_tags: (v) => countSummary(v, 'prior tag'),
};

const HERD_LABELS = {
  mommas: 'Mommas',
  backgrounders: 'Backgrounders',
  finishers: 'Finishers',
  bulls: 'Bulls',
  processed: 'Processed',
  deceased: 'Deceased',
  sold: 'Sold',
};

const HERD_COLORS = {
  mommas: {bg: '#fef2f2', tx: '#991b1b', bd: '#fca5a5'},
  backgrounders: {bg: '#ffedd5', tx: '#9a3412', bd: '#fdba74'},
  finishers: {bg: '#fff1f2', tx: '#9f1239', bd: '#fda4af'},
  bulls: {bg: '#fee2e2', tx: '#7f1d1d', bd: '#fca5a5'},
  processed: {bg: '#f3f4f6', tx: '#374151', bd: '#d1d5db'},
  deceased: {bg: '#f9fafb', tx: '#6b7280', bd: '#e5e7eb'},
  sold: {bg: '#eff6ff', tx: '#1e40af', bd: '#bfdbfe'},
};

const WATCHLIST_REASON_LABELS = {
  [WATCHLIST_REASONS.NO_WEIGHT_NO_DOB]: 'No weight + no DOB',
  [WATCHLIST_REASONS.NEGATIVE_ADG_NO_FINISH]: 'Negative ADG, no finish month',
  [WATCHLIST_REASONS.NEVER_REACHES_WINDOW]: 'Never reaches display window',
  [WATCHLIST_REASONS.ALREADY_OVER_MAX]: 'Already over max weight',
  [WATCHLIST_REASONS.PROJECTS_PAST_MAX]: 'Projects past max by current month',
  [WATCHLIST_REASONS.ALL_ELIGIBLE_HIDDEN]: 'All eligible months hidden',
};

const inpS = {
  fontSize: 13,
  padding: '7px 10px',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  fontFamily: 'inherit',
  width: '100%',
  boxSizing: 'border-box',
};

const lbl = {fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3, fontWeight: 500};

const tile = {
  background: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  padding: '14px 16px',
};

const sectionHeader = {fontSize: 13, fontWeight: 600, color: '#4b5563', letterSpacing: 0.3, marginBottom: 8};

// Compact age string from birth_date (YYYY-MM-DD) to a target Date.
// Renders as "Xy Ym" (e.g. "2y 4m"), or just "Ym" when under a year, or "—".
// Forecast months always anchor to YYYY-MM-15 via monthStartMs (lib helper).
function ageAt(birthDate, targetMs) {
  if (!birthDate) return '—';
  const birthMs = new Date(String(birthDate) + 'T12:00:00Z').getTime();
  if (!Number.isFinite(birthMs) || !Number.isFinite(targetMs)) return '—';
  const days = Math.floor((targetMs - birthMs) / 86400000);
  if (days < 0) return '—';
  const y = Math.floor(days / 365);
  const m = Math.floor((days % 365) / 30);
  return y > 0 ? y + 'y ' + m + 'm' : m + 'm';
}

const CattleForecastView = ({
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

  // Role gate — UI-only.
  const role = authState && authState.role;
  const canEdit = role === 'admin' || role === 'management';

  // Loaded state.
  const [cattle, setCattle] = useState([]);
  const [weighIns, setWeighIns] = useState([]);
  const [calvingRecs, setCalvingRecs] = useState([]);
  const [comments, setComments] = useState([]);
  const [breedOpts, setBreedOpts] = useState([]);
  const [originOpts, setOriginOpts] = useState([]);
  const [realBatches, setRealBatches] = useState([]);
  const [settings, setSettings] = useState(null);
  // settingsDraft is what the editable controls bind to. settings (above)
  // is what buildForecast actually consumes — only swapped on Save Settings.
  const [settingsDraft, setSettingsDraft] = useState(null);
  const [includes, setIncludes] = useState(new Set());
  const [hidden, setHidden] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Inline notice for forecast settings save / hide-state update / heifer
  // selection save errors. Cleared at the start of each action handler.
  const [notice, setNotice] = useState(null);
  const [yearFilter, setYearFilter] = useState(null); // null = current year by default
  const [monthFilter, setMonthFilter] = useState(null);
  const [showHeiferModal, setShowHeiferModal] = useState(false);
  // Tag search — client-side filter applied across planned rows, hidden
  // rows, actual-batch rows, and Attention rows. Empty string = show all.
  const [tagSearch, setTagSearch] = useState('');
  const tagSearchTrim = tagSearch.trim().toLowerCase();
  // Predicate every renderable row uses. Matches against current cow.tag
  // PLUS retag-aware prior tags via cowTagSet so old tag numbers still find
  // the cow. For actual-batch rows the cow record may have been re-herded
  // already; cowRow may be missing — fall back to the cows_detail tag.
  function tagMatch({cow, cowRow, tag}) {
    if (!tagSearchTrim) return true;
    const candidates = [];
    if (cow) {
      for (const t of cowTagSet(cow)) candidates.push(String(t).toLowerCase());
    }
    if (cowRow && cowRow !== cow) {
      for (const t of cowTagSet(cowRow)) candidates.push(String(t).toLowerCase());
    }
    if (tag) candidates.push(String(tag).toLowerCase());
    return candidates.some((c) => c.includes(tagSearchTrim));
  }

  // Fetch every forecast input in one round. Throws if any of the
  // throw-on-error loaders (settings/heifer/hidden) fails OR any direct read
  // returns a PostgREST response error, so callers can retry or surface the
  // failure instead of silently rendering empty.
  async function fetchForecastInputs() {
    const [cR, wAll, calR, comR, brR, orR, bR, s, inc, hid] = await Promise.all([
      sb.from('cattle').select('*').is('deleted_at', null).order('tag'),
      // throwOnError: a raced/errored cold-boot weigh-ins read surfaces as a
      // thrown Error here (routed through the mount effect's bounded retry +
      // recoverable notice) instead of silently caching [] and poisoning the
      // forecast with 0 finish candidates. A genuinely weigh-in-less farm still
      // resolves to [] without throwing.
      loadCattleWeighInsCached(sb, {throwOnError: true}),
      sb.from('cattle_calving_records').select('*').order('calving_date', {ascending: false}),
      sb.from('cattle_comments').select('*').order('created_at', {ascending: false}),
      sb.from('cattle_breeds').select('*').order('label'),
      sb.from('cattle_origins').select('*').order('label'),
      sb.from('cattle_processing_batches').select('*').order('actual_process_date', {ascending: false}),
      loadForecastSettings(sb),
      loadHeiferIncludes(sb),
      loadHidden(sb),
    ]);
    // Direct PostgREST reads return {data, error} instead of throwing. Surface
    // any response error as a thrown Error so a cold-boot RLS/network/PostgREST
    // failure routes through the same bounded retry + recoverable-notice path
    // as the throwing loaders — rather than landing as a null `data` the caller
    // mistakes for an empty farm. A null error with an empty array stays a
    // legit empty farm (no throw), preserving the bounded retry-then-settle.
    const directReads = [
      ['cattle', cR],
      ['cattle_calving_records', calR],
      ['cattle_comments', comR],
      ['cattle_breeds', brR],
      ['cattle_origins', orR],
      ['cattle_processing_batches', bR],
    ];
    for (const [label, r] of directReads) {
      if (r && r.error) throw new Error('fetchForecastInputs ' + label + ': ' + (r.error.message || r.error));
    }
    return {cR, wAll, calR, comR, brR, orR, bR, s, inc, hid};
  }

  // Commit a fetched payload to state. setLoading(false) here is the single
  // honest "forecast load resolved" boundary the page renders behind.
  function applyForecastInputs(p) {
    if (p.cR.data) setCattle(p.cR.data);
    setWeighIns(p.wAll || []);
    if (p.calR.data) setCalvingRecs(p.calR.data);
    if (p.comR.data) setComments(p.comR.data);
    if (p.brR.data) setBreedOpts(p.brR.data);
    if (p.orR.data) setOriginOpts(p.orR.data);
    if (p.bR.data) setRealBatches(p.bR.data);
    setSettings(p.s);
    setSettingsDraft(p.s);
    setIncludes(p.inc);
    setHidden(p.hid);
    setLoading(false);
  }

  // Single-shot reload used by the Include Heifers modal after a CowDetail
  // save. User-initiated refresh of an already-loaded page — no cold-boot
  // recovery needed here.
  async function loadAll() {
    applyForecastInputs(await fetchForecastInputs());
  }

  // Mount load WITH bounded cold-boot recovery. The forecast loads its inputs
  // once on mount; a raced/transient cold-boot read can resolve with an empty
  // `cattle` spine (→ 0 finish candidates) or one of the throw-on-error
  // loaders can reject (→ stranded "Loading…" forever). Both self-heal here:
  //  - empty core read: keep the spinner up, drop any poisoned weigh-in cache,
  //    re-fetch after a short backoff (a genuinely empty farm settles empty
  //    after the bounded retries — small one-time cost, no infinite loop).
  //  - thrown read: retry on the same bounded schedule, then settle into a
  //    recoverable error notice so the page never strands on Loading.
  useEffect(() => {
    let cancelled = false;
    const RETRY_BACKOFFS_MS = [350, 800];
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const payload = await fetchForecastInputs();
          if (cancelled) return;
          const coreEmpty = !(payload.cR.data && payload.cR.data.length > 0);
          // CP2: cattle present but weigh-ins came back empty is the poisoned
          // cold-boot symptom (→ 0 finish candidates until reload). Retry it on
          // the same bounded schedule; a genuinely weigh-in-less farm settles
          // empty after the retries — small one-time cost, no infinite loop.
          const weighInsSuspectEmpty = !coreEmpty && !(payload.wAll && payload.wAll.length > 0);
          if ((coreEmpty || weighInsSuspectEmpty) && attempt < RETRY_BACKOFFS_MS.length) {
            // Suspicious cold-boot empty read — re-fetch fresh (clear the
            // weigh-in cache so a co-raced empty cache can't pin us empty).
            invalidateCattleWeighInsCache();
            await delay(RETRY_BACKOFFS_MS[attempt]);
            if (cancelled) return;
            continue;
          }
          applyForecastInputs(payload);
          return;
        } catch (e) {
          if (cancelled) return;
          if (attempt < RETRY_BACKOFFS_MS.length) {
            invalidateCattleWeighInsCache();
            await delay(RETRY_BACKOFFS_MS[attempt]);
            if (cancelled) return;
            continue;
          }
          // Exhausted — never strand on Loading. Surface a recoverable error.
          console.error('CattleForecast load failed after retries:', e);
          setLoading(false);
          setNotice({
            kind: 'error',
            message: 'Could not load forecast data. Please refresh the page. (' + (e.message || e) + ')',
          });
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Mount-once cold-boot recovery; stable closures over sb/setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initial year filter = current year
  useEffect(() => {
    if (yearFilter == null && !loading) {
      setYearFilter(new Date().getUTCFullYear());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // Build forecast on every relevant input change. Heavy but tractable
  // (n cattle ~500, n months ~48 → ~24k iterations).
  const forecast = useMemo(() => {
    if (!settings) return null;
    // Split scheduled rows out of realBatches so buildForecast can
    // suppress matching virtual batches and reserve their names. mig 054
    // added 'scheduled' as a valid status; until that migration runs,
    // this filter is a no-op (no scheduled rows exist).
    const realActiveOrComplete = (realBatches || []).filter((b) => b.status === 'active' || b.status === 'complete');
    const scheduledOnly = (realBatches || []).filter((b) => b.status === 'scheduled');
    return buildForecast({
      cattle,
      weighIns,
      settings,
      includes,
      hidden,
      realBatches: realActiveOrComplete,
      scheduledBatches: scheduledOnly,
      todayMs: Date.now(),
    });
  }, [cattle, weighIns, settings, includes, hidden, realBatches]);
  const summaryYear = new Date().getUTCFullYear();

  // ── settings panel handlers ────────────────────────────────────────────────
  function patchDraft(patch) {
    setSettingsDraft((prev) => ({...(prev || {}), ...patch}));
  }
  async function saveSettingsClick() {
    if (!canEdit) return;
    setNotice(null);
    setSavingSettings(true);
    try {
      await saveForecastSettings(sb, settingsDraft, {updatedBy: authState?.name || authState?.user?.email || null});
      setSettings(settingsDraft);
    } catch (e) {
      setNotice({kind: 'error', message: 'Could not save Forecast settings: ' + (e.message || e)});
    } finally {
      setSavingSettings(false);
    }
  }
  function discardSettingsDraft() {
    setSettingsDraft(settings);
  }

  // ── hide/unhide ────────────────────────────────────────────────────────────
  // Best-effort Activity audit for a forecast month hide/unhide. Scoped to the
  // cattle forecast workflow table (entity_type cattle.forecast, singleton
  // entity_id 'cattle-forecast') — NOT the cattle.animal record — so the audit
  // lives with the forecast workflow in the global Activity log instead of
  // cluttering a cow's record page. Logged ONLY after the hide/unhide table
  // write succeeds; a failure here never rolls back the write or surfaces a
  // product error.
  async function recordForecastHiddenActivity(cattleId, monthKey, nowHidden) {
    try {
      const cow = cowsById.get(cattleId);
      const cowLabel = cow && cow.tag ? '#' + cow.tag : cattleId;
      const month = monthLabel(monthKey);
      const from = nowHidden ? 'visible' : 'hidden';
      const to = nowHidden ? 'hidden' : 'visible';
      await recordActivityEvent(sb, {
        entityType: 'cattle.forecast',
        entityId: 'cattle-forecast',
        eventType: 'status.changed',
        entityLabel: 'Cattle Forecast',
        body: 'Forecast month ' + month + ' for ' + cowLabel + ' changed ' + from + ' → ' + to,
        payload: {
          cattle_id: cattleId,
          cattle_label: cowLabel,
          month_key: monthKey,
          field: 'forecast_month_visibility',
          from,
          to,
        },
      });
    } catch (e) {
      // Swallow — the hide/unhide already succeeded; do not surface noisy errors.
      console.warn('forecast hide/unhide Activity log failed:', e && e.message ? e.message : e);
    }
  }

  async function toggleHidden(cattleId, monthKey, currentlyHidden) {
    if (!canEdit) return;
    setNotice(null);
    const teamMember = authState?.name || authState?.user?.email || null;
    try {
      if (currentlyHidden) {
        await removeHidden(sb, {cattleId, monthKey});
        setHidden((prev) => prev.filter((h) => !(h.cattle_id === cattleId && h.month_key === monthKey)));
      } else {
        await addHidden(sb, {cattleId, monthKey, hiddenBy: teamMember});
        setHidden((prev) => [...prev, {cattle_id: cattleId, month_key: monthKey, hidden_by: teamMember}]);
      }
    } catch (e) {
      setNotice({kind: 'error', message: 'Could not update hide state: ' + (e.message || e)});
      return;
    }
    // Audit only after the write above succeeded; best-effort (self-catching).
    await recordForecastHiddenActivity(cattleId, monthKey, !currentlyHidden);
  }

  // ── heifer-modal save ─────────────────────────────────────────────────────
  async function saveHeiferIncludesAndClose(nextSet) {
    if (!canEdit) {
      setShowHeiferModal(false);
      return;
    }
    setNotice(null);
    try {
      await saveHeiferIncludes(sb, nextSet, {includedBy: authState?.name || authState?.user?.email || null});
      setIncludes(new Set(nextSet));
    } catch (e) {
      setNotice({kind: 'error', message: 'Could not save heifer selections: ' + (e.message || e)});
      return;
    }
    setShowHeiferModal(false);
  }

  // ── year / month filter UX ────────────────────────────────────────────────
  const yearsInView = useMemo(() => {
    if (!forecast) return [];
    const ys = new Set();
    for (const b of forecast.monthBuckets) ys.add(b.year);
    // Past actual years from real batches (so we can show historical context).
    for (const rb of realBatches || []) {
      const dt = rb.actual_process_date || rb.planned_process_date;
      if (!dt) continue;
      const y = parseInt(String(dt).slice(0, 4), 10);
      if (Number.isFinite(y)) ys.add(y);
    }
    return [...ys].sort((a, b) => a - b);
  }, [forecast, realBatches]);

  const filteredMonthBuckets = useMemo(() => {
    if (!forecast) return [];
    return forecast.monthBuckets.filter((b) => (yearFilter == null ? true : b.year === yearFilter));
  }, [forecast, yearFilter]);

  // Past actual batches grouped by year for the historical year view.
  const actualBatchesByYear = useMemo(() => {
    const map = new Map();
    for (const rb of realBatches || []) {
      const dt = rb.actual_process_date || rb.planned_process_date;
      if (!dt) continue;
      const y = parseInt(String(dt).slice(0, 4), 10);
      if (!Number.isFinite(y)) continue;
      if (!map.has(y)) map.set(y, []);
      map.get(y).push(rb);
    }
    return map;
  }, [realBatches]);

  // Tag → cow (for showing tags in summary panels).
  const cowsById = useMemo(() => new Map(cattle.map((c) => [c.id, c])), [cattle]);

  // ── render ─────────────────────────────────────────────────────────────────
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
          gap: '1.25rem',
        }}
      >
        <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
        {/* Title + actions */}
        <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}} data-cattle-forecast-root>
          <div style={{fontSize: 20, fontWeight: 700, color: '#111827'}}>Cattle Forecast</div>
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
              data-forecast-readonly
            >
              READ-ONLY
            </span>
          )}
          <span style={{flex: 1}} />
          {canEdit && (
            <button
              onClick={() => setShowHeiferModal(true)}
              data-include-heifers-btn
              style={{
                padding: '7px 14px',
                borderRadius: 7,
                border: '1px solid #991b1b',
                background: 'white',
                color: '#991b1b',
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
              }}
            >
              Include Momma Herd Heifers
              {includes.size > 0 && (
                <span
                  style={{
                    marginLeft: 6,
                    padding: '1px 7px',
                    borderRadius: 10,
                    background: '#991b1b',
                    color: 'white',
                    fontSize: 11,
                  }}
                >
                  {includes.size}
                </span>
              )}
            </button>
          )}
          <button
            onClick={() => setShowSettings((v) => !v)}
            style={{
              padding: '7px 14px',
              borderRadius: 7,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#374151',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {showSettings ? 'Hide settings' : 'Settings'}
          </button>
        </div>

        {/* ── Tag search (client-side filter across all rows) ────────── */}
        {!loading && forecast && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 0',
            }}
          >
            <input
              type="text"
              value={tagSearch}
              onChange={(e) => setTagSearch(e.target.value)}
              placeholder="Search by tag #…"
              data-forecast-tag-search
              style={{
                fontSize: 13,
                padding: '7px 10px',
                border: '1px solid #d1d5db',
                borderRadius: 6,
                fontFamily: 'inherit',
                width: '100%',
                maxWidth: 320,
                boxSizing: 'border-box',
              }}
            />
            {tagSearch && (
              <button
                type="button"
                onClick={() => setTagSearch('')}
                data-forecast-tag-search-clear
                style={{
                  fontSize: 11,
                  padding: '6px 10px',
                  borderRadius: 5,
                  border: '1px solid #d1d5db',
                  background: 'white',
                  color: '#6b7280',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Clear
              </button>
            )}
          </div>
        )}

        {loading && <div style={{textAlign: 'center', padding: '3rem', color: '#9ca3af'}}>Loading{'…'}</div>}

        {!loading && forecast && (
          <>
            {/* ── All-years summary strip ─────────────────────────────── */}
            <div data-forecast-summary-strip>
              <div style={sectionHeader}>SUMMARY</div>
              <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10}}>
                <SummaryTile
                  label="Eligible cattle"
                  value={forecast.summary.totalEligible.toLocaleString()}
                  sub={forecast.summary.finishCandidates + ' finish candidates on farm'}
                />
                <SummaryTile
                  label={String(summaryYear)}
                  value={forecast.summary.readyThisYear.toLocaleString()}
                  color="#991b1b"
                  labelStrong
                />
                <SummaryTile
                  label={String(summaryYear + 1)}
                  value={forecast.summary.readyNextYear.toLocaleString()}
                  labelStrong
                />
                <SummaryTile
                  label={String(summaryYear + 2)}
                  value={forecast.summary.readyTwoYears.toLocaleString()}
                  labelStrong
                />
                <SummaryTile
                  label={String(summaryYear + 3)}
                  value={forecast.summary.readyThreeYears.toLocaleString()}
                  labelStrong
                />
                <SummaryTile
                  label="Watchlist"
                  value={forecast.summary.watchlistCount.toLocaleString()}
                  color={forecast.summary.watchlistCount > 0 ? '#92400e' : '#374151'}
                />
              </div>
            </div>

            {/* ── Next Processor Batch panel ──────────────────────────── */}
            <div style={{...tile, borderLeft: '4px solid #991b1b'}} data-next-processor-panel>
              <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
                <span
                  style={{
                    fontSize: 11,
                    color: '#6b7280',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  Next Processor Batch
                </span>
                {forecast.nextProcessorBatch ? (
                  <>
                    <span
                      data-next-processor-month
                      style={{
                        fontSize: 14,
                        padding: '4px 12px',
                        background: '#991b1b',
                        color: 'white',
                        borderRadius: 6,
                        fontWeight: 700,
                      }}
                    >
                      {forecast.nextProcessorBatch.label} · {forecast.nextProcessorBatch.animalIds.length}{' '}
                      {forecast.nextProcessorBatch.animalIds.length === 1 ? 'cow' : 'cows'}
                    </span>
                    <span style={{fontSize: 13, color: '#6b7280'}}>{forecast.nextProcessorBatch.name}</span>
                    {forecast.nextProcessorBatch.projectedTotalLbs > 0 && (
                      <span style={{fontSize: 12, color: '#065f46', fontWeight: 600}}>
                        {Math.round(forecast.nextProcessorBatch.projectedTotalLbs).toLocaleString()} lb projected
                      </span>
                    )}
                  </>
                ) : (
                  <span style={{fontSize: 13, color: '#6b7280', fontStyle: 'italic'}}>
                    No planned batch — no eligible cattle land in the display window.
                  </span>
                )}
              </div>
              {forecast.nextProcessorBatch && forecast.nextProcessorBatch.animalIds.length > 0 && (
                <div style={{marginTop: 10}}>
                  <div
                    style={{
                      fontSize: 10,
                      color: '#9ca3af',
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                      marginBottom: 4,
                    }}
                  >
                    Allowed tags (Send-to-Processor must match this set)
                  </div>
                  <div style={{display: 'flex', gap: 6, flexWrap: 'wrap'}} data-next-processor-tags>
                    {[...forecast.nextProcessorBatch.allowedTagSet].sort().map((tag) => (
                      <span
                        key={tag}
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          padding: '3px 9px',
                          borderRadius: 999,
                          background: '#fef2f2',
                          color: '#991b1b',
                          border: '1px solid #fca5a5',
                        }}
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* ── Settings panel (collapsible; read-only for farm_team) ── */}
            {showSettings && settingsDraft && (
              <div style={tile} data-forecast-settings-panel>
                <div style={sectionHeader}>SETTINGS</div>
                {!canEdit && (
                  <div
                    style={{
                      fontSize: 11,
                      color: '#1e40af',
                      background: '#eff6ff',
                      border: '1px solid #bfdbfe',
                      borderRadius: 6,
                      padding: '6px 10px',
                      marginBottom: 10,
                    }}
                  >
                    Read-only view. Management or admin can edit forecast settings.
                  </div>
                )}
                <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10}}>
                  <NumField
                    label="Display weight min (lb)"
                    value={settingsDraft.displayMin}
                    disabled={!canEdit}
                    onChange={(v) => patchDraft({displayMin: v})}
                  />
                  <NumField
                    label="Display weight max (lb)"
                    value={settingsDraft.displayMax}
                    disabled={!canEdit}
                    onChange={(v) => patchDraft({displayMax: v})}
                  />
                  <NumField
                    label="Fallback ADG (lb/day)"
                    value={settingsDraft.fallbackAdg}
                    step="0.01"
                    disabled={!canEdit}
                    onChange={(v) => patchDraft({fallbackAdg: v})}
                  />
                  <NumField
                    label="Birth weight (lb)"
                    value={settingsDraft.birthWeight}
                    disabled={!canEdit}
                    onChange={(v) => patchDraft({birthWeight: v})}
                  />
                  <NumField
                    label="Horizon (years)"
                    value={settingsDraft.horizonYears}
                    min="1"
                    max="5"
                    disabled={!canEdit}
                    onChange={(v) => patchDraft({horizonYears: v})}
                  />
                  <NumField
                    label="Monthly capacity (optional)"
                    value={settingsDraft.monthlyCapacity}
                    disabled={!canEdit}
                    onChange={(v) => patchDraft({monthlyCapacity: v})}
                  />
                </div>
                {canEdit && (
                  <div style={{display: 'flex', gap: 8, marginTop: 12, alignItems: 'center'}}>
                    <button
                      onClick={saveSettingsClick}
                      disabled={savingSettings}
                      data-save-settings-btn
                      style={{
                        padding: '7px 16px',
                        borderRadius: 7,
                        border: 'none',
                        background: '#991b1b',
                        color: 'white',
                        fontWeight: 600,
                        fontSize: 12,
                        cursor: savingSettings ? 'not-allowed' : 'pointer',
                        fontFamily: 'inherit',
                        opacity: savingSettings ? 0.6 : 1,
                      }}
                    >
                      {savingSettings ? 'Saving…' : 'Save Settings'}
                    </button>
                    <button
                      onClick={discardSettingsDraft}
                      style={{
                        padding: '7px 14px',
                        borderRadius: 7,
                        border: '1px solid #d1d5db',
                        background: 'white',
                        color: '#6b7280',
                        fontSize: 12,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      Discard
                    </button>
                    <span style={{fontSize: 11, color: '#9ca3af', fontStyle: 'italic'}}>
                      Settings edits don't recompute the forecast until saved.
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* ── Attention section (always-rendered; empty state when none).
                Lifted above the year selector + month tiles so an operator
                can spot tag-#241-style anomalies without scrolling. */}
            <AttentionSection
              rows={forecast.watchlist}
              canEdit={canEdit}
              onToggleHidden={toggleHidden}
              fmt={fmt}
              tagMatch={tagMatch}
            />

            {/* ── Year selector ───────────────────────────────────────── */}
            {yearsInView.length > 0 && (
              <div style={{display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap'}}>
                <span style={{fontSize: 11, color: '#6b7280', fontWeight: 600, marginRight: 4}}>YEAR</span>
                {yearsInView.map((y) => (
                  <button
                    key={y}
                    onClick={() => {
                      setYearFilter(y);
                      setMonthFilter(null);
                    }}
                    data-year-button={y}
                    style={{
                      padding: '5px 12px',
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 600,
                      border: yearFilter === y ? '1px solid #991b1b' : '1px solid #d1d5db',
                      background: yearFilter === y ? '#fef2f2' : 'white',
                      color: yearFilter === y ? '#991b1b' : '#374151',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {y}
                  </button>
                ))}
              </div>
            )}

            {/* ── Visual main chart: projected head count by month ────── */}
            {filteredMonthBuckets.length > 0 && (
              <ForecastChart buckets={filteredMonthBuckets} actualBatches={actualBatchesByYear.get(yearFilter) || []} />
            )}

            {/* ── Month buckets (assigned visible cattle) ─────────────── */}
            <div data-forecast-month-buckets>
              <div style={sectionHeader}>MONTHS</div>
              <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
                {filteredMonthBuckets.map((b) => (
                  <MonthBucketTile
                    key={b.monthKey}
                    bucket={b}
                    forecast={forecast}
                    cowsById={cowsById}
                    canEdit={canEdit}
                    onToggleHidden={toggleHidden}
                    monthFilter={monthFilter}
                    setMonthFilter={setMonthFilter}
                    fmt={fmt}
                    tagMatch={tagMatch}
                  />
                ))}
              </div>
            </div>

            {/* ── Past actuals — historical actual batches for context ── */}
            {yearFilter != null && actualBatchesByYear.has(yearFilter) && (
              <PastActuals batches={actualBatchesByYear.get(yearFilter)} fmt={fmt} />
            )}
          </>
        )}
      </div>

      {/* Include Momma Herd Heifers modal */}
      {showHeiferModal && (
        <IncludeHeifersModal
          cattle={cattle}
          weighIns={weighIns}
          calvingRecs={calvingRecs}
          comments={comments}
          breedOpts={breedOpts}
          originOpts={originOpts}
          fmt={fmt}
          authState={authState}
          initialIncludes={includes}
          canEdit={canEdit}
          onConfirm={saveHeiferIncludesAndClose}
          onClose={() => setShowHeiferModal(false)}
          sb={sb}
          reload={loadAll}
        />
      )}
    </div>
  );
};

// ── small UI subcomponents ────────────────────────────────────────────────────

function SummaryTile({label, value, sub, color = '#991b1b', labelStrong = false}) {
  return (
    <div style={tile}>
      <div
        data-summary-tile-label={label}
        style={{
          fontSize: 10,
          color: '#9ca3af',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginBottom: 4,
          fontWeight: labelStrong ? 800 : 600,
        }}
      >
        {label}
      </div>
      <div style={{fontSize: 22, fontWeight: 700, color, lineHeight: 1}}>{value}</div>
      {sub && <div style={{fontSize: 11, color: '#9ca3af', marginTop: 3}}>{sub}</div>}
    </div>
  );
}

function NumField({label, value, onChange, disabled, step = '1', min, max}) {
  return (
    <div>
      <label style={lbl}>{label}</label>
      <input
        type="number"
        value={value == null ? '' : value}
        step={step}
        min={min}
        max={max}
        disabled={!!disabled}
        onChange={(e) => onChange(e.target.value === '' ? null : parseFloat(e.target.value))}
        style={{...inpS, background: disabled ? '#f9fafb' : 'white'}}
      />
    </div>
  );
}

function ForecastChart({buckets, actualBatches}) {
  // Simple inline SVG bar chart — projected head count per month for the
  // selected year. Keeps deps zero (no chart library).
  const max = Math.max(1, ...buckets.map((b) => b.count));
  // Max also informed by actual batches for visual scale across both.
  const actualByMonth = new Map();
  for (const rb of actualBatches || []) {
    const dt = rb.actual_process_date || rb.planned_process_date;
    if (!dt) continue;
    const k = String(dt).slice(0, 7);
    actualByMonth.set(k, (actualByMonth.get(k) || 0) + (Array.isArray(rb.cows_detail) ? rb.cows_detail.length : 0));
  }
  const allCounts = [...buckets.map((b) => b.count), ...actualByMonth.values()];
  const yMax = Math.max(1, ...allCounts);
  const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const cellWidth = 70;
  const cellHeight = 140;
  const totalWidth = cellWidth * buckets.length + 30;
  return (
    <div style={tile}>
      <div style={sectionHeader}>PROJECTED HEAD COUNT BY MONTH</div>
      <div style={{overflowX: 'auto'}} data-forecast-chart>
        <svg width={Math.max(totalWidth, 600)} height={cellHeight + 60} style={{display: 'block'}}>
          {/* y-axis baseline */}
          <line x1="20" y1={cellHeight + 20} x2={totalWidth + 10} y2={cellHeight + 20} stroke="#e5e7eb" />
          {buckets.map((b, i) => {
            const x = 30 + i * cellWidth;
            const month = parseMonthKey(b.monthKey).month;
            const projHeight = (b.count / yMax) * cellHeight;
            const actualCount = actualByMonth.get(b.monthKey) || 0;
            const actualHeight = (actualCount / yMax) * cellHeight;
            return (
              <g key={b.monthKey}>
                {/* Projected bar (lighter) */}
                {b.count > 0 && (
                  <rect
                    x={x}
                    y={cellHeight + 20 - projHeight}
                    width={cellWidth - 18}
                    height={projHeight}
                    fill="#fda4af"
                    stroke="#9f1239"
                    strokeWidth="1"
                    data-chart-projected={b.monthKey}
                  >
                    <title>{`${b.label}: ${b.count} projected`}</title>
                  </rect>
                )}
                {/* Actual bar (overlays, darker, narrower) */}
                {actualCount > 0 && (
                  <rect
                    x={x + 6}
                    y={cellHeight + 20 - actualHeight}
                    width={cellWidth - 30}
                    height={actualHeight}
                    fill="#7f1d1d"
                    data-chart-actual={b.monthKey}
                  >
                    <title>{`${b.label}: ${actualCount} actual`}</title>
                  </rect>
                )}
                {/* Count label above bar */}
                {b.count > 0 && (
                  <text
                    x={x + (cellWidth - 18) / 2}
                    y={cellHeight + 20 - projHeight - 4}
                    textAnchor="middle"
                    fontSize="10"
                    fill="#7f1d1d"
                    fontWeight="600"
                  >
                    {b.count}
                  </text>
                )}
                {/* Month label below */}
                <text x={x + (cellWidth - 18) / 2} y={cellHeight + 38} textAnchor="middle" fontSize="11" fill="#6b7280">
                  {labels[month - 1]}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div style={{display: 'flex', gap: 14, marginTop: 6, fontSize: 11, color: '#6b7280'}}>
        <LegendSwatch color="#fda4af" border="#9f1239" label="Projected (planned)" />
        <LegendSwatch color="#7f1d1d" label="Actual (sent to processor)" />
      </div>
    </div>
  );
}

function LegendSwatch({color, border, label}) {
  return (
    <span style={{display: 'inline-flex', alignItems: 'center', gap: 6}}>
      <span
        style={{
          display: 'inline-block',
          width: 12,
          height: 12,
          background: color,
          border: border ? '1px solid ' + border : 'none',
          borderRadius: 2,
        }}
      />
      {label}
    </span>
  );
}

function MonthBucketTile({
  bucket,
  forecast,
  cowsById,
  canEdit,
  onToggleHidden,
  monthFilter,
  setMonthFilter,
  fmt,
  tagMatch,
}) {
  const {useState} = React;
  // Default-expand current and future months. Past months stay collapsed
  // unless explicitly clicked.
  const nowYm = new Date().toISOString().slice(0, 7);
  const isCurrentOrFuture = bucket.monthKey >= nowYm;
  const [expanded, setExpanded] = useState(monthFilter === bucket.monthKey || isCurrentOrFuture);
  const isFiltered = monthFilter === bucket.monthKey;
  const plannedCount = bucket.count;
  const hiddenHereOnly = (bucket.hiddenAnimalIds || []).filter((cid) => !bucket.animalIds.includes(cid));
  const actualBatches = bucket.actualBatches || [];
  // Active = sent to processor, hanging weights pending. Active still
  // counts as "processed" for display per Codex 2026-05-04.
  const processedCount = actualBatches.reduce(
    (s, rb) => s + (Array.isArray(rb.cows_detail) ? rb.cows_detail.length : 0),
    0,
  );
  return (
    <div
      style={{
        background: 'white',
        border: '1px solid ' + (isFiltered ? '#991b1b' : '#e5e7eb'),
        borderRadius: 12,
        overflow: 'hidden',
      }}
      data-month-bucket={bucket.monthKey}
    >
      <div
        onClick={() => {
          setExpanded((v) => !v);
          setMonthFilter(isFiltered ? null : bucket.monthKey);
        }}
        style={{
          padding: '12px 18px',
          background: isFiltered ? '#fef2f2' : '#fafafa',
          borderBottom: expanded ? '1px solid #f3f4f6' : 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          cursor: 'pointer',
        }}
      >
        <span style={{fontSize: 12, color: '#9ca3af'}}>{expanded ? '▼' : '▶'}</span>
        <span style={{fontSize: 14, fontWeight: 700, color: '#111827'}}>{bucket.label}</span>
        {/* Pill 1: planned forecast count. Suppressed when this month
            ONLY has actual batches — operators don't want to see "0 cows
            planned" on a month that's fully processed. */}
        {(plannedCount > 0 || (plannedCount === 0 && processedCount === 0)) && (
          <span
            data-month-planned-count
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 999,
              background: plannedCount > 0 ? '#fef2f2' : '#f3f4f6',
              color: plannedCount > 0 ? '#991b1b' : '#6b7280',
              fontWeight: 600,
            }}
          >
            {plannedCount} {plannedCount === 1 ? 'cow' : 'cows'} planned
          </span>
        )}
        {/* Pill 2: actual processed count (sum of cows_detail across the
            month's active + complete batches). Active counts as processed
            for display purposes per Codex 2026-05-04. */}
        {processedCount > 0 && (
          <span
            data-month-processed-count
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 999,
              background: '#eff6ff',
              color: '#1e40af',
              fontWeight: 600,
            }}
          >
            {processedCount} {processedCount === 1 ? 'cow' : 'cows'} processed
          </span>
        )}
        {bucket.projectedTotalLbs > 0 && (
          <span style={{fontSize: 11, color: '#065f46', fontWeight: 600}}>
            {Math.round(bucket.projectedTotalLbs).toLocaleString()} lb projected
          </span>
        )}
        {bucket.overCapacity && (
          <span
            style={{
              fontSize: 10,
              padding: '1px 7px',
              borderRadius: 4,
              background: '#fef2f2',
              color: '#b91c1c',
              fontWeight: 700,
              textTransform: 'uppercase',
            }}
          >
            Over capacity
          </span>
        )}
      </div>
      {expanded && (
        <div style={{padding: '12px 18px'}}>
          {/* Actual active/complete batches that landed in this month. */}
          {actualBatches.length > 0 && (
            <div style={{marginBottom: 10}}>
              <div
                style={{
                  fontSize: 10,
                  color: '#1e40af',
                  textTransform: 'uppercase',
                  fontWeight: 700,
                  letterSpacing: 0.4,
                  marginBottom: 4,
                }}
              >
                Actual batches
              </div>
              <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
                {actualBatches.map((rb) => {
                  const cows = Array.isArray(rb.cows_detail) ? rb.cows_detail : [];
                  return (
                    <div
                      key={rb.id}
                      data-actual-batch={rb.id}
                      style={{
                        background: rb.status === 'complete' ? '#f9fafb' : '#fef2f2',
                        border: '1px solid ' + (rb.status === 'complete' ? '#d1d5db' : '#fca5a5'),
                        borderRadius: 6,
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '6px 10px',
                          fontSize: 12,
                          flexWrap: 'wrap',
                          borderBottom: cows.length > 0 ? '1px solid rgba(0,0,0,.05)' : 'none',
                        }}
                      >
                        <strong>{rb.name}</strong>
                        <span
                          style={{
                            fontSize: 10,
                            padding: '1px 6px',
                            background: rb.status === 'complete' ? '#374151' : '#1d4ed8',
                            color: 'white',
                            borderRadius: 4,
                            fontWeight: 700,
                            textTransform: 'uppercase',
                          }}
                        >
                          {rb.status}
                        </span>
                        <span style={{color: '#6b7280'}}>
                          {cows.length} {cows.length === 1 ? 'cow' : 'cows'}
                        </span>
                        {(rb.actual_process_date || rb.planned_process_date) && (
                          <span style={{color: '#6b7280'}}>
                            {fmt ? fmt(rb.actual_process_date || rb.planned_process_date) : rb.actual_process_date}
                          </span>
                        )}
                      </div>
                      {/* Per-cow rows under the batch — actuals show who was
                          processed and weights only. ADG Calc is a forecast
                          concept and intentionally absent here per Codex
                          2026-05-04 polish. */}
                      {cows.length > 0 && (
                        <table
                          style={{width: '100%', borderCollapse: 'collapse', fontSize: 11}}
                          data-actual-batch-table={rb.id}
                        >
                          <thead>
                            <tr
                              style={{
                                textAlign: 'left',
                                color: '#9ca3af',
                                fontSize: 10,
                                textTransform: 'uppercase',
                                letterSpacing: 0.4,
                                background: 'rgba(0,0,0,.02)',
                              }}
                            >
                              <th style={{padding: '3px 8px'}}>Tag</th>
                              <th style={{padding: '3px 8px'}}>Sex</th>
                              <th style={{padding: '3px 8px'}}>Herd</th>
                              <th style={{padding: '3px 8px'}}>Age</th>
                              <th style={{padding: '3px 8px', textAlign: 'right'}}>Live</th>
                              <th style={{padding: '3px 8px', textAlign: 'right'}}>Hanging</th>
                            </tr>
                          </thead>
                          <tbody>
                            {cows.map((c) => {
                              const cowRow = cowsById.get(c.cattle_id);
                              const live = parseFloat(c.live_weight);
                              const hang = parseFloat(c.hanging_weight);
                              if (!tagMatch({tag: c.tag, cowRow})) return null;
                              const procDateStr = rb.actual_process_date || rb.planned_process_date;
                              const procMs = procDateStr ? new Date(String(procDateStr) + 'T12:00:00Z').getTime() : NaN;
                              const ageAtProc = ageAt(cowRow?.birth_date, procMs);
                              return (
                                <tr
                                  key={c.cattle_id}
                                  data-actual-batch-row={c.cattle_id}
                                  style={{borderTop: '1px solid rgba(0,0,0,.04)'}}
                                >
                                  <td style={{padding: '3px 8px', fontWeight: 700, color: '#111827'}}>
                                    #{c.tag || cowRow?.tag || '?'}
                                  </td>
                                  <td style={{padding: '3px 8px', color: '#6b7280'}}>{cowRow?.sex || '—'}</td>
                                  <td style={{padding: '3px 8px', color: '#6b7280'}}>
                                    {cowRow ? HERD_LABELS[cowRow.herd] || cowRow.herd : '—'}
                                  </td>
                                  <td
                                    data-actual-batch-row-age={c.cattle_id}
                                    style={{padding: '3px 8px', color: '#6b7280', fontVariantNumeric: 'tabular-nums'}}
                                  >
                                    {ageAtProc}
                                  </td>
                                  <td style={{padding: '3px 8px', textAlign: 'right', color: '#111827'}}>
                                    {Number.isFinite(live) && live > 0
                                      ? Math.round(live).toLocaleString() + ' lb'
                                      : '—'}
                                  </td>
                                  <td style={{padding: '3px 8px', textAlign: 'right', color: '#065f46'}}>
                                    {Number.isFinite(hang) && hang > 0
                                      ? Math.round(hang).toLocaleString() + ' lb'
                                      : '—'}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Planned (forecast) cattle assigned to this month + any hidden-here rows. */}
          {bucket.animalIds.length === 0 && hiddenHereOnly.length === 0 && actualBatches.length === 0 && (
            <div style={{fontSize: 12, color: '#9ca3af', fontStyle: 'italic'}}>No projected cattle this month.</div>
          )}
          {(bucket.animalIds.length > 0 || hiddenHereOnly.length > 0) && (
            <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 12}} data-month-bucket-table>
              <thead>
                <tr
                  style={{
                    textAlign: 'left',
                    color: '#9ca3af',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  <th style={{padding: '4px 8px'}}>Tag</th>
                  <th style={{padding: '4px 8px'}}>Sex</th>
                  <th style={{padding: '4px 8px'}}>Herd</th>
                  <th style={{padding: '4px 8px'}}>Origin</th>
                  <th style={{padding: '4px 8px'}}>Age</th>
                  <th style={{padding: '4px 8px', textAlign: 'right'}}>Latest</th>
                  <th style={{padding: '4px 8px', textAlign: 'right'}}>Projected</th>
                  <th style={{padding: '4px 8px'}}>ADG Calc</th>
                  <th style={{padding: '4px 8px', textAlign: 'right'}}>Action</th>
                </tr>
              </thead>
              <tbody>
                {/* Assigned rows */}
                {bucket.animalIds.map((cid) => {
                  const cow = cowsById.get(cid);
                  if (!cow) return null;
                  if (!tagMatch({cow})) return null;
                  const row = forecast.animalRows.find((r) => r.cow.id === cid);
                  const ageInMonth = ageAt(cow.birth_date, monthStartMs(bucket.monthKey));
                  return (
                    <tr key={cid} data-month-row={cid} style={{borderTop: '1px solid #f3f4f6'}}>
                      <td style={{padding: '6px 8px', fontWeight: 700, color: '#111827'}}>#{cow.tag || '?'}</td>
                      <td style={{padding: '6px 8px', color: '#6b7280'}}>{cow.sex || '—'}</td>
                      <td style={{padding: '6px 8px', color: '#6b7280'}}>{HERD_LABELS[cow.herd] || cow.herd}</td>
                      <td data-month-row-origin={cid} style={{padding: '6px 8px', color: '#6b7280'}}>
                        {cow.origin || '—'}
                      </td>
                      <td
                        data-month-row-age={cid}
                        style={{padding: '6px 8px', color: '#6b7280', fontVariantNumeric: 'tabular-nums'}}
                      >
                        {ageInMonth}
                      </td>
                      <td style={{padding: '6px 8px', textAlign: 'right', color: '#111827'}}>
                        {row?.latest
                          ? Math.round(row.latest.weight).toLocaleString() +
                            ' lb' +
                            (row.latest.date && fmt ? ' · ' + fmt(String(row.latest.date).slice(0, 10)) : '')
                          : '—'}
                      </td>
                      <td style={{padding: '6px 8px', textAlign: 'right', color: '#065f46', fontWeight: 600}}>
                        {row?.projectedWeightAtReady
                          ? Math.round(row.projectedWeightAtReady).toLocaleString() + ' lb'
                          : '—'}
                      </td>
                      <td style={{padding: '6px 8px', color: '#6b7280', fontSize: 11}}>
                        {formatAdgCalc(row)}
                        {row?.negativeAdg && (
                          <span style={{color: '#b91c1c', fontWeight: 700, marginLeft: 4}}>(neg)</span>
                        )}
                      </td>
                      <td style={{padding: '6px 8px', textAlign: 'right'}}>
                        {canEdit ? (
                          <button
                            onClick={() => onToggleHidden(cid, bucket.monthKey, false)}
                            data-toggle-hide={cid}
                            style={{
                              fontSize: 11,
                              padding: '3px 8px',
                              borderRadius: 5,
                              border: '1px solid #fecaca',
                              background: '#fef2f2',
                              color: '#b91c1c',
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                              fontWeight: 600,
                            }}
                          >
                            Hide
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {/* Hidden-here rows — ALWAYS rendered, muted, with Unhide. */}
                {hiddenHereOnly.map((cid) => {
                  const cow = cowsById.get(cid);
                  if (!cow) return null;
                  if (!tagMatch({cow})) return null;
                  const row = forecast.animalRows.find((r) => r.cow.id === cid);
                  // Projected weight for THIS hide month — operator wants to
                  // see what she'd weigh if sent in this month, even though
                  // she's excluded from the totals (Codex 2026-05-04 #3).
                  const hideMonthProjected =
                    row &&
                    Number.isFinite(row.anchorWeight) &&
                    Number.isFinite(row.anchorMs) &&
                    Number.isFinite(row.adg)
                      ? projectedWeightAtMonth({
                          anchorWeight: row.anchorWeight,
                          anchorMs: row.anchorMs,
                          targetMonthKey: bucket.monthKey,
                          adg: row.adg,
                        })
                      : null;
                  const hiddenAgeInMonth = ageAt(cow.birth_date, monthStartMs(bucket.monthKey));
                  return (
                    <tr
                      key={'hidden-' + cid}
                      data-month-hidden-row={cid}
                      style={{borderTop: '1px solid #f3f4f6', opacity: 0.55, background: '#fafafa'}}
                    >
                      <td style={{padding: '6px 8px', fontWeight: 700, color: '#111827'}}>#{cow.tag || '?'}</td>
                      <td style={{padding: '6px 8px', color: '#6b7280'}}>{cow.sex || '—'}</td>
                      <td style={{padding: '6px 8px', color: '#6b7280'}}>{HERD_LABELS[cow.herd] || cow.herd}</td>
                      <td data-month-hidden-row-origin={cid} style={{padding: '6px 8px', color: '#9ca3af'}}>
                        {cow.origin || '—'}
                      </td>
                      <td
                        data-month-hidden-row-age={cid}
                        style={{padding: '6px 8px', color: '#9ca3af', fontVariantNumeric: 'tabular-nums'}}
                      >
                        {hiddenAgeInMonth}
                      </td>
                      <td style={{padding: '6px 8px', textAlign: 'right', color: '#9ca3af'}}>
                        {row?.latest ? Math.round(row.latest.weight).toLocaleString() + ' lb' : '—'}
                      </td>
                      <td
                        data-hidden-projected={cid}
                        style={{padding: '6px 8px', textAlign: 'right', color: '#9ca3af'}}
                      >
                        {hideMonthProjected != null && Number.isFinite(hideMonthProjected) ? (
                          <>
                            {Math.round(hideMonthProjected).toLocaleString() + ' lb'}
                            {row?.readyMonth && row.readyMonth !== bucket.monthKey && (
                              <span style={{display: 'block', fontSize: 10, fontStyle: 'italic'}}>
                                rolled to {monthLabel(row.readyMonth)}
                              </span>
                            )}
                          </>
                        ) : row?.readyMonth ? (
                          'rolled to ' + monthLabel(row.readyMonth)
                        ) : (
                          'no eligible month'
                        )}
                      </td>
                      <td style={{padding: '6px 8px', color: '#9ca3af', fontSize: 11, fontStyle: 'italic'}}>
                        hidden here
                      </td>
                      <td style={{padding: '6px 8px', textAlign: 'right'}}>
                        {canEdit ? (
                          <button
                            onClick={() => onToggleHidden(cid, bucket.monthKey, true)}
                            data-toggle-unhide={cid}
                            style={{
                              fontSize: 11,
                              padding: '3px 8px',
                              borderRadius: 5,
                              border: '1px solid #bfdbfe',
                              background: '#eff6ff',
                              color: '#1e40af',
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                              fontWeight: 600,
                            }}
                          >
                            Unhide
                          </button>
                        ) : (
                          <span style={{fontSize: 10, color: '#9ca3af'}}>hidden</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function AttentionSection({rows, canEdit, onToggleHidden, fmt, tagMatch}) {
  const visible = (rows || []).filter((r) => (tagMatch ? tagMatch({cow: r.cow}) : true));
  if (visible.length === 0) {
    return (
      <div style={tile} data-forecast-attention data-forecast-watchlist>
        <div style={sectionHeader}>NEEDS ATTENTION</div>
        <div data-attention-empty style={{fontSize: 12, color: '#6b7280', fontStyle: 'italic', padding: '4px 0'}}>
          {rows && rows.length > 0 ? 'No matching attention rows.' : 'No cattle need attention.'}
        </div>
      </div>
    );
  }
  return (
    <div style={tile} data-forecast-attention data-forecast-watchlist>
      <div style={sectionHeader}>
        NEEDS ATTENTION
        <span style={{fontWeight: 400, color: '#9ca3af', marginLeft: 6}}>({visible.length})</span>
      </div>
      <div style={{fontSize: 11, color: '#6b7280', marginBottom: 8}}>
        Cattle that don't land cleanly in a planned month. Each row shows the latest weight, ADG, and why the cow didn't
        get a planned month — adjust the underlying data (weigh-in, DOB) or unhide a month to bring her back.
      </div>
      <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 12}}>
        <thead>
          <tr
            style={{textAlign: 'left', color: '#9ca3af', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5}}
          >
            <th style={{padding: '4px 8px'}}>Tag</th>
            <th style={{padding: '4px 8px'}}>Herd</th>
            <th style={{padding: '4px 8px', textAlign: 'right'}}>Latest</th>
            <th style={{padding: '4px 8px'}}>ADG Calc</th>
            <th style={{padding: '4px 8px'}}>Reason</th>
            <th style={{padding: '4px 8px'}}>Hidden months</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <tr key={r.cow.id} data-watchlist-row={r.cow.id} style={{borderTop: '1px solid #f3f4f6'}}>
              <td style={{padding: '6px 8px', fontWeight: 700, color: '#111827'}}>#{r.cow.tag || '?'}</td>
              <td style={{padding: '6px 8px', color: '#6b7280'}}>{HERD_LABELS[r.cow.herd] || r.cow.herd}</td>
              <td style={{padding: '6px 8px', textAlign: 'right', color: '#111827'}}>
                {r.latest
                  ? Math.round(r.latest.weight).toLocaleString() +
                    ' lb' +
                    (r.latest.date
                      ? ' · ' + (fmt ? fmt(String(r.latest.date).slice(0, 10)) : String(r.latest.date).slice(0, 10))
                      : '')
                  : r.cow.birth_date
                    ? 'no weigh-in · DOB ' + r.cow.birth_date
                    : 'no weigh-in · no DOB'}
              </td>
              <td style={{padding: '6px 8px', color: '#6b7280', fontSize: 11}}>{formatAdgCalc(r)}</td>
              <td style={{padding: '6px 8px', color: '#92400e', fontSize: 11}}>
                {r.watchlistReasons.length > 0
                  ? r.watchlistReasons.map((x) => WATCHLIST_REASON_LABELS[x] || x).join(', ')
                  : r.readyMonth
                    ? 'projected ready ' + monthLabel(r.readyMonth)
                    : 'no eligible month'}
              </td>
              <td style={{padding: '6px 8px', fontSize: 11}}>
                {r.hiddenInMonths && r.hiddenInMonths.length > 0 ? (
                  <span style={{display: 'flex', gap: 4, flexWrap: 'wrap'}}>
                    {r.hiddenInMonths.map((mk) => (
                      <span
                        key={mk}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          padding: '1px 6px',
                          borderRadius: 4,
                          background: '#eff6ff',
                          color: '#1e40af',
                          fontSize: 10,
                          fontWeight: 600,
                        }}
                      >
                        {monthLabel(mk)}
                        {canEdit && (
                          <button
                            onClick={() => onToggleHidden(r.cow.id, mk, true)}
                            data-watchlist-unhide={r.cow.id + '|' + mk}
                            title={'Unhide ' + monthLabel(mk)}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: '#1e40af',
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                              fontSize: 11,
                              padding: 0,
                              marginLeft: 2,
                              fontWeight: 700,
                            }}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span style={{color: '#9ca3af'}}>—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PastActuals({batches, fmt}) {
  if (!batches || batches.length === 0) return null;
  return (
    <div style={tile} data-forecast-past-actuals>
      <div style={sectionHeader}>PAST ACTUAL BATCHES</div>
      <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
        {batches.map((rb) => {
          const cows = Array.isArray(rb.cows_detail) ? rb.cows_detail : [];
          return (
            <div
              key={rb.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '6px 8px',
                background: rb.status === 'complete' ? '#f9fafb' : '#fef2f2',
                borderRadius: 6,
                fontSize: 12,
              }}
            >
              <strong>{rb.name}</strong>
              <span
                style={{
                  fontSize: 10,
                  padding: '1px 6px',
                  background: rb.status === 'complete' ? '#374151' : '#1d4ed8',
                  color: 'white',
                  borderRadius: 4,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                }}
              >
                {rb.status}
              </span>
              <span style={{color: '#6b7280'}}>
                {cows.length} {cows.length === 1 ? 'cow' : 'cows'}
              </span>
              <span style={{color: '#6b7280'}}>{fmt(rb.actual_process_date || rb.planned_process_date)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── IncludeHeifersModal ───────────────────────────────────────────────────────
function IncludeHeifersModal({
  cattle,
  weighIns,
  calvingRecs,
  comments,
  breedOpts,
  originOpts,
  fmt,
  authState,
  initialIncludes,
  canEdit,
  onConfirm,
  onClose,
  sb,
  reload,
}) {
  const {useState, useMemo} = React;
  // Filter + sort momma-herd heifers for the include modal.
  //  - Filter: isHeiferEligibleForInclude removes pregnant heifers and
  //    heifers older than 15 months. No-DOB heifers stay visible per Ronnie's
  //    instruction.
  //  - Sort: youngest first by birth_date desc; no-DOB rows sink to the
  //    bottom. Tie-break on tag (numeric when both are ints, else string).
  const todayMs = useMemo(() => Date.now(), []);
  const heifers = useMemo(() => {
    const list = cattle.filter((c) => isHeiferEligibleForInclude(c, todayMs));
    const tagKey = (c) => {
      const t = String(c.tag || '');
      const n = parseInt(t, 10);
      return Number.isFinite(n) && String(n) === t ? n : Number.POSITIVE_INFINITY;
    };
    return list.slice().sort((a, b) => {
      const aHas = !!a.birth_date;
      const bHas = !!b.birth_date;
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;
      if (aHas && bHas) {
        const cmp = String(b.birth_date).localeCompare(String(a.birth_date));
        if (cmp !== 0) return cmp;
      }
      const an = tagKey(a);
      const bn = tagKey(b);
      if (an !== bn) return an - bn;
      return String(a.tag || '').localeCompare(String(b.tag || ''));
    });
  }, [cattle, todayMs]);
  // Stale-include guard at the modal level. cattle_forecast_heifer_includes
  // can carry IDs that point at heifers who are now ineligible (pregnant,
  // over 15 months, or auto-promoted to cow on calving via mig 044). Those
  // rows must NOT count as "selected" in the modal — and on Confirm
  // Selections the diff-based save in cattleForecastApi.saveHeiferIncludes
  // will then DELETE them from the DB because they're no longer in the
  // staged set. This is the modal-side prune; buildForecast also has a
  // helper-level guard so stale rows can never leak into the forecast even
  // if Ronnie never opens the modal.
  const eligibleHeiferIds = useMemo(() => new Set(heifers.map((h) => h.id)), [heifers]);
  const initialEligibleIncludes = useMemo(() => {
    const out = new Set();
    for (const id of initialIncludes || []) if (eligibleHeiferIds.has(id)) out.add(id);
    return out;
  }, [initialIncludes, eligibleHeiferIds]);
  const [staged, setStaged] = useState(() => new Set(initialEligibleIncludes));
  const pendingAddCount = useMemo(
    () => [...staged].filter((id) => !initialEligibleIncludes.has(id)).length,
    [staged, initialEligibleIncludes],
  );
  const pendingRemoveCount = useMemo(
    () => [...initialEligibleIncludes].filter((id) => !staged.has(id)).length,
    [staged, initialEligibleIncludes],
  );
  // Mid-flight prune: if `cattle` reloads while the modal is open and a
  // staged heifer becomes ineligible (newly pregnant, aged out, or
  // auto-promoted to cow on calving), drop her from the staged set so
  // Confirm can't re-write her ID into the DB. patchCow inside the row's
  // CowDetail triggers a parent reload which re-flows the cattle prop down
  // and re-runs this effect.
  React.useEffect(() => {
    setStaged((prev) => {
      let changed = false;
      const next = new Set();
      for (const id of prev) {
        if (eligibleHeiferIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [eligibleHeiferIds]);
  const [expandedId, setExpandedId] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [modalNotice, setModalNotice] = useState(null);

  function toggle(id) {
    if (!canEdit) return;
    setStaged((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function patchCow(cowId, fields) {
    if (!cowId || !fields) return;
    setModalNotice(null);
    const cow = cattle.find((c) => c.id === cowId);
    const result = await runMutation(() => sb.from('cattle').update(fields).eq('id', cowId), {
      activity: () => {
        const changes = buildChanges(cow, fields, {
          exclude: CATTLE_EXCLUDE,
          labels: CATTLE_LABELS,
          formatters: CATTLE_FORMATTERS,
        });
        if (changes.length === 0) return;
        return recordFieldChange(sb, {
          entityType: 'cattle.animal',
          entityId: cowId,
          entityLabel: fields.tag || cow?.tag || cowId,
          changes,
        });
      },
      onError: (msg) => setModalNotice({kind: 'error', message: 'Save failed: ' + msg}),
    });
    if (!result.ok) return;
    if (reload) await reload();
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,.45)',
        zIndex: 500,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '1rem',
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white',
          borderRadius: 12,
          width: '100%',
          maxWidth: 920,
          boxShadow: '0 8px 32px rgba(0,0,0,.2)',
          marginTop: 40,
        }}
        data-include-heifers-modal
      >
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid #e5e7eb',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{fontSize: 15, fontWeight: 600, color: '#991b1b'}}>Include Momma Herd Heifers</div>
          <button
            onClick={onClose}
            style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
          >
            {'×'}
          </button>
        </div>
        <div style={{padding: '8px 20px 0'}}>
          <InlineNotice notice={modalNotice} onDismiss={() => setModalNotice(null)} />
        </div>
        <div style={{padding: '8px 20px 4px', fontSize: 11, color: '#6b7280'}} data-heifer-include-help>
          {heifers.length} heifer{heifers.length === 1 ? '' : 's'} currently in mommas. Checked heifers are included in
          the forecast using global ADG. Uncheck an included heifer to remove her when you{' '}
          <strong>Confirm Selections</strong>. Eligible heifers stay listed so they can be included again later.
        </div>
        <div style={{padding: '12px 20px 0', maxHeight: '60vh', overflowY: 'auto'}}>
          {heifers.length === 0 ? (
            <div style={{fontSize: 12, color: '#9ca3af', fontStyle: 'italic', padding: '1rem 0'}}>
              No heifers currently classified in the mommas herd.
            </div>
          ) : (
            heifers.map((h) => {
              const checked = staged.has(h.id);
              const wasIncluded = initialEligibleIncludes.has(h.id);
              const pendingAdd = checked && !wasIncluded;
              const pendingRemove = wasIncluded && !checked;
              const inclusionState = pendingRemove
                ? 'will-remove'
                : pendingAdd
                  ? 'will-include'
                  : checked
                    ? 'included'
                    : 'excluded';
              const badge = pendingRemove
                ? {label: 'Will remove', bg: '#f3f4f6', color: '#4b5563', border: '#d1d5db'}
                : pendingAdd
                  ? {label: 'Will include', bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe'}
                  : checked
                    ? {label: 'Included', bg: '#ecfdf5', color: '#065f46', border: '#a7f3d0'}
                    : {label: 'Excluded', bg: '#f9fafb', color: '#6b7280', border: '#e5e7eb'};
              const isExpanded = expandedId === h.id;
              const cTags = cowTagSet(h);
              const cowWeighIns = weighIns.filter((w) => cTags.has(String(w.tag)));
              // Latest weigh-in (retag-aware via cowTagSet); show weight + date
              // directly in the row so admin doesn't have to expand Details.
              const latestWi = cowWeighIns
                .slice()
                .sort((a, b) => (b.entered_at || '').localeCompare(a.entered_at || ''))[0];
              const latestWeight = latestWi ? parseFloat(latestWi.weight) : null;
              const latestDate = latestWi ? String(latestWi.entered_at || latestWi.date || '').slice(0, 10) : null;
              // Age from DOB (years + months). Quiet dash if missing.
              let ageStr = '—';
              if (h.birth_date) {
                const ms = Date.now() - new Date(h.birth_date + 'T12:00:00Z').getTime();
                const days = Math.floor(ms / 86400000);
                if (days >= 0) {
                  const y = Math.floor(days / 365);
                  const m = Math.floor((days % 365) / 30);
                  ageStr = y > 0 ? y + 'y ' + m + 'm' : m + 'm';
                }
              }
              const cowCalving = calvingRecs.filter((r) => r.dam_tag === h.tag);
              const cowComments = comments
                .filter((cm) => cm.cattle_id === h.id || cm.cattle_tag === h.tag)
                .slice(0, 20);
              return (
                <div
                  key={h.id}
                  data-heifer-row={h.id}
                  data-heifer-inclusion-state={inclusionState}
                  style={{
                    border: '1px solid ' + badge.border,
                    borderRadius: 8,
                    marginBottom: 8,
                    overflow: 'hidden',
                    background: pendingRemove ? '#f9fafb' : checked ? '#f8fffb' : 'white',
                    opacity: pendingRemove ? 0.72 : 1,
                  }}
                >
                  <div
                    onClick={() => setExpandedId(isExpanded ? null : h.id)}
                    style={{
                      padding: '8px 12px',
                      display: 'grid',
                      gridTemplateColumns: '24px 70px 60px 150px 90px 110px 112px',
                      alignItems: 'center',
                      gap: 10,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!canEdit}
                      onChange={() => toggle(h.id)}
                      onClick={(e) => e.stopPropagation()}
                      data-heifer-checkbox={h.id}
                    />
                    <span style={{fontWeight: 700, fontSize: 13, color: '#111827'}}>#{h.tag || '?'}</span>
                    <span
                      data-heifer-age={h.id}
                      style={{fontSize: 11, color: '#6b7280', fontVariantNumeric: 'tabular-nums'}}
                    >
                      {ageStr}
                    </span>
                    <span
                      data-heifer-latest-weight={h.id}
                      style={{
                        fontSize: 11,
                        color: latestWeight ? '#065f46' : '#9ca3af',
                        fontWeight: latestWeight ? 600 : 400,
                      }}
                    >
                      {latestWeight ? Math.round(latestWeight).toLocaleString() + ' lb' : 'no weigh-in'}
                      {latestDate && fmt ? ' · ' + fmt(latestDate) : ''}
                    </span>
                    <span style={{fontSize: 11, color: '#6b7280'}}>{h.breed || '—'}</span>
                    <span style={{fontSize: 11, color: '#6b7280'}}>{h.origin || '—'}</span>
                    <span
                      data-heifer-inclusion-badge={h.id}
                      style={{
                        fontSize: 10,
                        padding: '2px 7px',
                        borderRadius: 999,
                        background: badge.bg,
                        color: badge.color,
                        border: '1px solid ' + badge.border,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        justifySelf: 'end',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {badge.label}
                    </span>
                  </div>
                  {isExpanded && (
                    <CowDetail
                      cow={h}
                      ageLabel={ageStr}
                      weighIns={cowWeighIns}
                      calving={cowCalving}
                      comments={cowComments}
                      calves={cattle.filter((x) => x.dam_tag === h.tag)}
                      dam={cattle.find((x) => x.tag === h.dam_tag)}
                      cattleList={cattle}
                      fmt={fmt}
                      HERDS={[...CATTLE_HERD_KEYS]}
                      HERD_LABELS={HERD_LABELS}
                      HERD_COLORS={HERD_COLORS}
                      onEdit={() => {}}
                      onTransfer={() => {}}
                      onDelete={() => {}}
                      onComment={() => {}}
                      onEditComment={() => {}}
                      onDeleteComment={() => {}}
                      onAddCalving={() => {}}
                      onDeleteCalving={() => {}}
                      onNavigateToCow={() => {}}
                      onNavigateBack={() => setExpandedId(null)}
                      canNavigateBack={false}
                      backToTag={null}
                      onPatch={(fields) => patchCow(h.id, fields)}
                      onClose={() => setExpandedId(null)}
                      originOpts={originOpts}
                      breedOpts={breedOpts}
                    />
                  )}
                </div>
              );
            })
          )}
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
          <span style={{fontSize: 11, color: '#6b7280'}} data-heifer-include-footer>
            {staged.size} selected after confirm
            {pendingAddCount > 0 && (
              <span style={{marginLeft: 6, color: '#1d4ed8', fontStyle: 'italic'}}>+{pendingAddCount} add pending</span>
            )}
            {pendingRemoveCount > 0 && (
              <span style={{marginLeft: 6, color: '#92400e', fontStyle: 'italic'}}>
                -{pendingRemoveCount} remove pending
              </span>
            )}
          </span>
          <span style={{flex: 1}} />
          {canEdit && (
            <button
              onClick={async () => {
                setConfirming(true);
                // Defensive sanitize at save time: even if useEffect hasn't
                // fired yet (race during a reload), only persist staged IDs
                // that are CURRENTLY eligible. Pairs with the buildForecast
                // helper-level guard so a stale row can't sneak into either
                // the DB or the forecast totals.
                const sanitized = new Set();
                for (const id of staged) if (eligibleHeiferIds.has(id)) sanitized.add(id);
                await onConfirm(sanitized);
                setConfirming(false);
              }}
              disabled={confirming}
              data-confirm-heifers-btn
              style={{
                padding: '7px 16px',
                borderRadius: 7,
                border: 'none',
                background: '#991b1b',
                color: 'white',
                fontWeight: 600,
                fontSize: 12,
                cursor: confirming ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
                opacity: confirming ? 0.6 : 1,
              }}
            >
              {confirming ? 'Saving…' : 'Confirm Selections'}
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              padding: '7px 14px',
              borderRadius: 7,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#6b7280',
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {canEdit ? 'Cancel' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default CattleForecastView;
