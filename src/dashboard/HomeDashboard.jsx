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
import './homeRedesign.css';
import {sb} from '../lib/supabase.js';
import {fmt, fmtS, toISO, addDays, todayISO} from '../lib/dateUtils.js';
import {calcPoultryStatus, computeBroilerOnFarmCounts} from '../lib/broiler.js';
import {calcBreedingTimeline, buildCycleSeqMap, calcCycleStatus, activePigFeederDailyTargets} from '../lib/pig.js';
import {buildMaterialChecklist} from '../lib/equipmentMaterials.js';
import {buildAnimalHistorySnapshot} from '../lib/animalHistory.js';
import {
  buildEquipmentAttention,
  buildMissedDailyReports,
  buildNext30Events,
  foldEquipmentFuelings,
} from './homeAlerts.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';
import {ANIMAL_ICON_KEYS, PLANNER_ICON_KEYS} from '../lib/plannerIcons.js';
import UsersModal from '../auth/UsersModal.jsx';
import {openableProps} from '../shared/openable.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import {
  DailyRecordCard,
  EggSummaryCard,
  feedLbsVal,
  feedListVal,
  gritVal,
  countVal,
  tagVal,
  mutedVal,
  voltageVal,
  check,
  mortText,
  commentText,
} from '../shared/DailyRecordCards.jsx';
import HomeWeatherCard from '../weather/HomeWeatherCard.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {useBatches} from '../contexts/BatchesContext.jsx';
import {usePig} from '../contexts/PigContext.jsx';
import {useLayer} from '../contexts/LayerContext.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';
import {useCattleHome} from '../contexts/CattleHomeContext.jsx';
import {useSheepHome} from '../contexts/SheepHomeContext.jsx';
import {useFeedCosts} from '../contexts/FeedCostsContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';
import {loadProductionSources} from '../lib/productionApi.js';
import {buildProductionModel, homeProductionStats} from '../lib/production.js';

// Daily-report kind → dedicated record-page route. Home "Last 5 Days" tiles
// navigate straight to the record page instead of waking the legacy dailys-hub
// edit modal (the old setPendingEdit + setView path). Egg dailys live under the
// layer program at /layer/eggs.
const DAILY_RECORD_ROUTES = {
  broiler: (id) => '/broiler/dailys/' + id,
  pig: (id) => '/pig/dailys/' + id,
  layer: (id) => '/layer/dailys/' + id,
  egg: (id) => '/layer/eggs/' + id,
  cattle: (id) => '/cattle/dailys/' + id,
  sheep: (id) => '/sheep/dailys/' + id,
};
function pathForDailyReport(r) {
  const build = DAILY_RECORD_ROUTES[r && r.kind];
  return build ? build(r.id) : null;
}

// Herd/flock dot + label for the Home "Last 5 Days" feed — same production
// palette the cattle/sheep list pages use, so a herd's dot is identical on Home
// and on its program page.
const HOME_HERD = {
  labels: {mommas: 'Mommas', backgrounders: 'Backgrounders', finishers: 'Finishers', bulls: 'Bulls'},
  dot: {mommas: '#991b1b', backgrounders: '#9a3412', finishers: '#9f1239', bulls: '#7f1d1d'},
};
const HOME_FLOCK = {
  labels: {rams: 'Rams', ewes: 'Ewes', feeders: 'Feeders'},
  dot: {rams: '#0f766e', ewes: '#86198f', feeders: '#854d0e'},
};
function homeSheepComment(c) {
  const t = c == null ? '' : String(c).trim();
  const low = t.toLowerCase();
  if (!t || ['none', '0', 'n/a', 'na', '-'].includes(low)) return null;
  return commentText(t);
}

// Map a daily record to the shared DailyRecordCard display model. Mirrors each
// program list view's mapRow so the Home feed and the program pages read the
// same fields the same way.
function buildHomeDailyModel(kind, d) {
  const base = {team: d.team_member || '—', source: d.source, photos: d.photos};
  if (kind === 'broiler') {
    return {
      ...base,
      name: d.batch_label || '—',
      vals: {feed: feedLbsVal(d.feed_lbs), feedTag: d.feed_type ? tagVal(d.feed_type) : '', grit: gritVal(d.grit_lbs)},
      checks: [check('Moved', d.group_moved !== false), check('Waterer', d.waterer_checked !== false)],
      mort: mortText(d.mortality_count, d.mortality_reason),
      comment: commentText(d.comments),
    };
  }
  if (kind === 'layer') {
    return {
      ...base,
      name: d.batch_label || '—',
      vals: {
        feed: feedLbsVal(d.feed_lbs),
        feedTag: d.feed_type ? tagVal(d.feed_type) : '',
        grit: gritVal(d.grit_lbs),
        count: countVal(d.layer_count),
      },
      checks: [check('Moved', d.group_moved !== false), check('Waterer', d.waterer_checked !== false)],
      mort: mortText(d.mortality_count, d.mortality_reason),
      comment: commentText(d.comments),
    };
  }
  if (kind === 'pig') {
    return {
      ...base,
      name: d.batch_label || '—',
      vals: {
        feed: feedLbsVal(d.feed_lbs),
        pigs: parseInt(d.pig_count) > 0 ? d.pig_count + ' pigs' : mutedVal('—'),
        volt: voltageVal(d.fence_voltage),
      },
      checks: [
        check('Moved', d.group_moved !== false),
        check('Nipple', d.nipple_drinker_working !== false),
        check('Fence', d.fence_walked !== false),
      ],
      comment: commentText(d.issues),
    };
  }
  if (kind === 'cattle') {
    return {
      ...base,
      name: HOME_HERD.labels[d.herd] || d.herd || '—',
      dot: HOME_HERD.dot[d.herd] || HOME_HERD.dot.mommas,
      vals: {feed: feedListVal(d.feeds, d.minerals), volt: voltageVal(d.fence_voltage)},
      checks: [check('Water', d.water_checked !== false)],
      mort: mortText(d.mortality_count, d.mortality_reason),
      comment: commentText(d.issues),
    };
  }
  if (kind === 'sheep') {
    return {
      ...base,
      name: HOME_FLOCK.labels[d.flock] || d.flock || '—',
      dot: HOME_FLOCK.dot[d.flock] || HOME_FLOCK.dot.ewes,
      vals: {feed: feedListVal(d.feeds, d.minerals), volt: voltageVal(d.fence_voltage_kv)},
      checks: [check('Water', d.waterers_working !== false)],
      mort: mortText(d.mortality_count, null),
      comment: homeSheepComment(d.comments),
    };
  }
  return {...base, name: d.batch_label || '—', vals: {}, checks: []};
}

// Homepage-redesign inline glyphs (currentColor-driven so the parent class
// controls stroke). Chevron is the lift/tile reveal affordance; Check is the
// filled-circle "all caught up" mark inside .note-ok rows.
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
function Chevron({className}) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
function CheckGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

// Equipment-attention section glyph. Inline SVG (no raster background — the
// planner wrench PNG ships with a baked light-gray box) so it stays flat and
// crisp at any size; color comes from the parent via currentColor.
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
function WrenchGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

// Coming-soon destination for not-yet-built top-level areas (Processing and
// future sections). Rendered as a full in-app page via local
// HomeDashboard state — a real, safe destination, NOT a broken route. Keeps
// the app chrome (Header) and offers an explicit Back to Home.
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
function ComingSoonPage({Header, label, onBack}) {
  return (
    <div className="home theme-crisp home-dashboard">
      <Header />
      <main className="home-col">
        <section className="card" data-coming-soon={label} style={{padding: '44px 28px', textAlign: 'center'}}>
          <div className="section-label" style={{justifyContent: 'center'}}>
            {label}
          </div>
          <div style={{fontSize: 21, fontWeight: 750, letterSpacing: '-0.02em', margin: '10px 0 6px'}}>Coming soon</div>
          <div style={{fontSize: 13.5, color: 'var(--text-muted)', maxWidth: 420, margin: '0 auto 22px'}}>
            This section is being built and will be available in a future update.
          </div>
          <button type="button" className="btn-clear" onClick={onBack}>
            ← Back to Home
          </button>
        </section>
      </main>
    </div>
  );
}

export default function HomeDashboard({Header, loadUsers, canAccessProgram, VIEW_TO_PROGRAM}) {
  const {authState, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const {batches} = useBatches();
  const {breedingCycles, farrowingRecs, feederGroups, breeders} = usePig();
  const {layerGroups, layerBatches, layerHousings, allLayerDailys} = useLayer();
  const {broilerDailys, pigDailys, layerDailysRecent, eggDailysRecent, cattleDailysRecent, sheepDailysRecent} =
    useDailysRecent();
  const {cattleForHome} = useCattleHome();
  const {sheepForHome} = useSheepHome();
  const {missedCleared, setMissedCleared} = useFeedCosts();
  const {setView} = useUI();
  const navigate = useNavigate();

  // Coming-soon overlay target for not-yet-built top-level areas (Processing /
  // future sections). null = show the dashboard; a label string =
  // show the in-app coming-soon page. Cleared by its Back button.
  const [comingSoon, setComingSoon] = React.useState(null);
  const productionYear = new Date().getFullYear();
  const [productionSources, setProductionSources] = React.useState(null);
  const [productionLoading, setProductionLoading] = React.useState(true);

  const role = authState?.role;
  const isAdmin = role === 'admin';

  // Equipment data for missed-fueling + EQUIPMENT ATTENTION section. Loaded
  // defensively so the home page still renders if migration 016 isn't in.
  // attachment_checklists is included so the mig-048 Materials card can
  // resolve attachment-based service groups without a second query.
  const [equipment, setEquipment] = React.useState([]);
  const [equipmentCompletions, setEquipmentCompletions] = React.useState({}); // eq.id → [completion {...with reading_at_completion}]
  const [equipmentFuelings, setEquipmentFuelings] = React.useState({}); // eq.id → [{date, team_member, hours_reading, km_reading, every_fillup_check}] sorted reading desc
  // mig 048 — Materials Needed dashboard card. Loaded defensively so the
  // home page still renders if mig 048 isn't applied yet (the missingTables
  // branch falls through to an empty checklist below).
  const [materials, setMaterials] = React.useState([]);
  const [materialClears, setMaterialClears] = React.useState([]);
  const [materialsTablesMissing, setMaterialsTablesMissing] = React.useState(false);
  const [materialsTick, setMaterialsTick] = React.useState(0);
  React.useEffect(() => {
    sb.from('equipment')
      .select(
        'id,slug,name,status,tracking_unit,current_hours,current_km,warranty_expiration,service_intervals,attachment_checklists,every_fillup_items',
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
        const folded = foldEquipmentFuelings(data);
        setEquipmentCompletions(folded.equipmentCompletions);
        setEquipmentFuelings(folded.equipmentFuelings);
      });
  }, []);

  // mig 048 — Materials + clears for the home dashboard card. After the
  // 2026-05-14 retirement of the standalone /fleet/materials page, this
  // card is the only operator-facing surface. Bumping materialsTick
  // triggers a refetch (used after Clear so the row vanishes from the
  // home view immediately).
  React.useEffect(() => {
    let cancelled = false;
    Promise.all([
      sb.from('equipment_service_materials').select('*').eq('active', true),
      sb.from('equipment_material_clears').select('*'),
    ]).then(([matRes, clrRes]) => {
      if (cancelled) return;
      if (matRes.error && /does not exist|relation/i.test(matRes.error.message || '')) {
        setMaterialsTablesMissing(true);
        return;
      }
      // Clears load failure is a defensive guard: if we can't read the
      // clears table (RLS denial, transient error, etc.) we MUST NOT fall
      // back to an empty clears list, because that would resurface
      // previously-cleared materials on the home card. Treat it as if the
      // tables aren't ready and hide the card entirely until a refresh.
      if (clrRes.error) {
        if (/does not exist|relation/i.test(clrRes.error.message || '')) {
          setMaterialsTablesMissing(true);
        } else {
          console.error('equipment_material_clears load:', clrRes.error);
          setMaterials([]);
          setMaterialClears([]);
        }
        return;
      }
      setMaterials(matRes.data || []);
      setMaterialClears(clrRes.data || []);
    });
    return () => {
      cancelled = true;
    };
  }, [materialsTick]);

  React.useEffect(() => {
    let cancelled = false;
    setProductionLoading(true);
    loadProductionSources(sb, {
      fromDate: `${productionYear}-01-01`,
      toDate: `${productionYear}-12-31`,
    })
      .then((loaded) => {
        if (!cancelled) setProductionSources(loaded);
      })
      .catch((error) => {
        console.error('production summary load:', error);
        if (!cancelled) setProductionSources(null);
      })
      .finally(() => {
        if (!cancelled) setProductionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [productionYear]);

  // Auto-status counts for poultry
  const broilerOnFarmCounts = computeBroilerOnFarmCounts(batches, broilerDailys);
  const activeBatches = broilerOnFarmCounts.activeBatches;
  const plannedBatches = batches.filter((b) => calcPoultryStatus(b) === 'planned');
  const processedBatches = batches.filter((b) => calcPoultryStatus(b) === 'processed');
  const broilerOnFarm = broilerOnFarmCounts.onFarmBirds;

  const weekEvents = buildNext30Events({batches, breedingCycles, farrowingRecs, feederGroups});
  const animalSnapshot = React.useMemo(
    () =>
      buildAnimalHistorySnapshot(
        {
          batches,
          broilerDailys,
          layerBatches,
          layerHousings,
          layerDailys: allLayerDailys,
          feederGroups,
          breeders,
          pigDailys,
          cattle: cattleForHome,
          sheep: sheepForHome,
        },
        todayISO(),
      ),
    [
      batches,
      broilerDailys,
      layerBatches,
      layerHousings,
      allLayerDailys,
      feederGroups,
      breeders,
      pigDailys,
      cattleForHome,
      sheepForHome,
    ],
  );

  // Missed daily reports: checks last 7 days, persists until cleared
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
  const allMissed = buildMissedDailyReports({
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
  });

  // Equipment attention: overdue services + every-fillup item streaks + warranty.
  const equipmentAttention = buildEquipmentAttention({
    equipment,
    equipmentFuelings,
    equipmentCompletions,
    missedCleared,
  });

  // mig 048 — Materials Needed dashboard card.
  // After the 2026-05-14 retirement of the standalone /fleet/materials
  // page, this card is the only operator-facing materials surface. The
  // fuelingsBy map gets fed into buildMaterialChecklist alongside the
  // equipment list + materials + clears so the helper can derive next_due
  // via the existing computeIntervalStatus math. Per Codex (lane
  // amendment) Clear is one-material-at-a-time only — no bulk clear.
  const materialsFuelingsBy = React.useMemo(() => {
    const m = new Map();
    for (const eqId of Object.keys(equipmentFuelings || {})) {
      m.set(eqId, equipmentFuelings[eqId]);
    }
    return m;
  }, [equipmentFuelings]);
  const materialsChecklist = React.useMemo(() => {
    if (materialsTablesMissing) return [];
    if (!Array.isArray(equipment) || equipment.length === 0) return [];
    return buildMaterialChecklist({
      equipment,
      fuelingsBy: materialsFuelingsBy,
      materials,
      clears: materialClears,
    });
  }, [equipment, materialsFuelingsBy, materials, materialClears, materialsTablesMissing]);
  const hasActiveEquipment = equipment.some((eq) => eq && eq.status === 'active');
  const activeMaterialsCount = (Array.isArray(materials) ? materials : []).filter((m) => m && m.active).length;
  const showEquipmentMaintenanceCaughtUp = hasActiveEquipment && equipmentAttention.length === 0;
  const showEquipmentMaterialsCaughtUp =
    !materialsTablesMissing && hasActiveEquipment && activeMaterialsCount > 0 && materialsChecklist.length === 0;
  async function clearMaterialOne(material, group) {
    const id = `emc-h-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const row = {
      id,
      material_id: material.id,
      equipment_id: material.equipment_id,
      due_bucket_value: group.due_bucket_value,
      due_bucket_unit: group.due_bucket_unit,
      cleared_at: new Date().toISOString(),
    };
    const {error} = await sb.from('equipment_material_clears').insert(row);
    // Treat unique-key collision as a no-op (already cleared in this bucket).
    if (error && !/duplicate key|23505/i.test(error.message || '')) {
      console.error('clearMaterialOne:', error);
      return;
    }
    setMaterialsTick((n) => n + 1);
  }

  const activeBroilerBatches2 = batches.filter((b) => calcPoultryStatus(b) === 'active');
  // All-clear banner reflects ACTUAL pig daily targets: active feeder
  // sub-batches or non-archived breeders. An active parent feeder group with
  // no active sub-batches is not a daily target, so it no longer counts here.
  const hasAnyActivePig =
    activePigFeederDailyTargets(feederGroups).length > 0 || (breeders || []).some((b) => !b.archived);
  const activeLayerGroups2 = (layerGroups || []).filter((g) => g.status === 'active');
  const productionModel = React.useMemo(() => buildProductionModel(productionSources || {}), [productionSources]);
  const productionStats = React.useMemo(
    () => homeProductionStats(productionModel, productionYear),
    [productionModel, productionYear],
  );

  // ── Admin weekly table data ──
  const fiveDaysAgo = toISO(addDays(new Date(), -5));
  const weekAgo = fiveDaysAgo; // used for admin daily tiles (5 days)
  // Stable kind keys (broiler/pig/layer/egg/cattle/sheep) drive sort order
  // and styling; emoji + label stay separate from the kind so the display
  // layer can swap to PNG icons without touching the data shape. Codex
  // amendment: "🐔 Broiler"-string-keyed lookups were refactored away.
  const allRecentReports = [
    ...broilerDailys
      .filter((d) => d.date >= weekAgo)
      .map((d) => ({id: d.id, view: 'broilerdailys', date: d.date, kind: 'broiler', label: 'Broiler', raw: d})),
    ...pigDailys
      .filter((d) => d.date >= weekAgo)
      .map((d) => ({id: d.id, view: 'pigdailys', date: d.date, kind: 'pig', label: 'Pig', raw: d})),
    ...layerDailysRecent
      .filter((d) => d.date >= weekAgo)
      .map((d) => ({id: d.id, view: 'layerdailys', date: d.date, kind: 'layer', label: 'Layer', raw: d})),
    ...eggDailysRecent
      .filter((d) => d.date >= weekAgo)
      .map((d) => ({id: d.id, view: 'eggdailys', date: d.date, kind: 'egg', label: 'Egg', raw: d})),
    ...cattleDailysRecent
      .filter((d) => d.date >= weekAgo)
      .map((d) => ({id: d.id, view: 'cattledailys', date: d.date, kind: 'cattle', label: 'Cattle', raw: d})),
    ...sheepDailysRecent
      .filter((d) => d.date >= weekAgo)
      .map((d) => ({id: d.id, view: 'sheepdailys', date: d.date, kind: 'sheep', label: 'Sheep', raw: d})),
  ].sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind));

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
        border: '1px solid var(--border)',
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

  if (comingSoon) {
    return <ComingSoonPage Header={Header} label={comingSoon} onBack={() => setComingSoon(null)} />;
  }

  return (
    <div className="home theme-crisp home-dashboard">
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
      <main className="home-col">
        {/* Nav cards — 3 cols × 2 rows on desktop, 2 cols × 3 rows on mobile
            (mobile column swap lives in the HTML <style> block keyed off
            data-home-grid="programs") so the program labels don't clip. */}
        <section className="tiles" data-home-grid="programs">
          {[
            {
              label: 'Broilers',
              iconKey: ANIMAL_ICON_KEYS.broiler,
              iconText: '🐔',
              desc: `${activeBatches.length} active \u00b7 ${broilerOnFarm.toLocaleString()} on farm`,
              view: 'broilerHome',
              color: '#a16207',
              bg: '#fef9c3',
            },
            {
              label: 'Layers',
              iconKey: ANIMAL_ICON_KEYS.layer,
              iconText: '🥚',
              desc: `${(layerGroups || []).filter((g) => g.status === 'active').length} active groups \u00b7 ${(layerGroups || []).filter((g) => g.status === 'active').reduce((s, g) => s + (g.currentCount || 0), 0)} hens`,
              view: 'layersHome',
              coinClass: 'coin-layer',
              color: '#78350f',
              bg: '#fffbeb',
            },
            {
              label: 'Pigs',
              iconKey: ANIMAL_ICON_KEYS.pig,
              iconText: '🐷',
              desc: `${activeCycles.length} cycles \u00b7 ${totalSows} sows \u00b7 ${feederGroups.filter((g) => g.status === 'active').length} batches`,
              view: 'pigsHome',
              color: '#1e40af',
              bg: '#eff6ff',
            },
            {
              label: 'Cattle',
              iconKey: ANIMAL_ICON_KEYS.cattle,
              iconText: null,
              desc: `Mommas \u00b7 backgrounders \u00b7 finishers \u00b7 bulls`,
              view: 'cattleHome',
              color: '#991b1b',
              bg: '#fef2f2',
            },
            {
              label: 'Sheep',
              iconKey: ANIMAL_ICON_KEYS.sheep,
              iconText: '🐑',
              desc: `Hair sheep for meat \u00b7 rams + ewes + feeders`,
              view: 'sheepHome',
              coinClass: 'coin-sheep',
              color: '#0f766e',
              bg: '#f0fdfa',
            },
            {
              label: 'Equipment',
              iconKey: PLANNER_ICON_KEYS.tractor,
              iconText: '🚜',
              desc: `Tractors \u00b7 implements \u00b7 maintenance (coming soon)`,
              view: 'equipmentHome',
              color: '#57534e',
              bg: '#fafaf9',
            },
          ]
            .filter((c) => canAccessProgram(VIEW_TO_PROGRAM[c.view]))
            .map((c) => (
              // Label-only tile per the design reference — no operational
              // subtitle. Routing (setView) + canAccessProgram gating preserved.
              <button key={c.view} type="button" className="tile" onClick={() => setView(c.view)}>
                <span className={'coin' + (c.coinClass ? ' ' + c.coinClass : '')}>
                  <PlannerIcon iconKey={c.iconKey} text={c.iconText} size={34} />
                </span>
                <span className="tile-label">{c.label}</span>
                <Chevron className="tile-go" />
              </button>
            ))}
        </section>

        <div className="field-tools">
          <button type="button" className="card admin-card field-map-card lift" onClick={() => setView('pastureMap')}>
            <span className="admin-ic field-map-ic">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 18 3 21V6l6-3 6 3 6-3v15l-6 3-6-3Z" />
                <path d="M9 3v15" />
                <path d="M15 6v15" />
              </svg>
            </span>
            <span className="admin-title">Pasture Map</span>
            <Chevron className="go" />
          </button>
          {React.createElement(HomeWeatherCard)}
        </div>

        {/* Utility row — Processing + Admin side by side (design composition).
            Processing maps to a not-built top-level section: it is marked
            data-status="not-built" and clicks through to the in-app coming-soon
            page (a real, safe destination — not a broken route). Admin is
            admin-only and routes to the existing Webforms admin. Non-admins see
            Processing full width (no .utility grid). */}
        <div className={isAdmin ? 'utility' : undefined}>
          <button
            type="button"
            className="card admin-card lift"
            data-status="not-built"
            onClick={() => setComingSoon('Processing')}
          >
            <span className="admin-ic">
              <PlannerIcon iconKey={PLANNER_ICON_KEYS.processing} text="🥩" size={28} />
            </span>
            <span className="admin-title">Processing</span>
            <Chevron className="go" />
          </button>
          {isAdmin && (
            <button type="button" className="card admin-card lift" onClick={() => setView('webforms')}>
              <span className="admin-ic">
                <PlannerIcon iconKey={PLANNER_ICON_KEYS.admin} text="⚙️" size={28} />
              </span>
              <span className="admin-title">Admin</span>
              <Chevron className="go" />
            </button>
          )}
        </div>

        {/* ── Animals on Farm ── */}
        {(() => {
          return (
            // Real on-farm counts (kept). The whole card opens the month-by-month
            // Animals on Farm history page. data-home-grid="animals" stays on the
            // row; species use the design dot+label treatment.
            <button type="button" className="card stats lift" onClick={() => setView('animalHistory')}>
              <div className="stats-head">
                <div className="card-label">Animals on Farm</div>
                <Chevron className="go" />
              </div>
              <div className="stat-row" data-home-grid="animals">
                <div className="stat">
                  <div className="stat-n">{animalSnapshot.broilers.toLocaleString()}</div>
                  <div className="stat-l">
                    <span className="sdot sdot-broiler" />
                    Broilers
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-n">{animalSnapshot.layers.toLocaleString()}</div>
                  <div className="stat-l">
                    <span className="sdot sdot-layer" />
                    Layer Hens
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-n">{animalSnapshot.pigs.toLocaleString()}</div>
                  <div className="stat-l">
                    <span className="sdot sdot-pig" />
                    Pigs
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-n">{animalSnapshot.cattle.toLocaleString()}</div>
                  <div className="stat-l">
                    <span className="sdot sdot-cattle" />
                    Cattle
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-n">{animalSnapshot.sheep.toLocaleString()}</div>
                  <div className="stat-l">
                    <span className="sdot sdot-sheep" />
                    Sheep
                  </div>
                </div>
                <div className="stat stat-total">
                  <div className="stat-n">{animalSnapshot.total.toLocaleString()}</div>
                  <div className="stat-l">
                    <span className="sdot sdot-total" />
                    Total
                  </div>
                </div>
              </div>
            </button>
          );
        })()}

        <button type="button" className="card stats lift" onClick={() => setView('production')}>
          <div className="stats-head">
            <div className="card-label">Production - {productionYear}</div>
            <Chevron className="go" />
          </div>
          <div className="stat-row" data-home-grid="production">
            {productionStats.map((stat) => (
              <div className="stat" key={stat.programKey}>
                <div className="stat-n">{productionLoading ? '--' : stat.value}</div>
                <div className="stat-l">
                  <span className={`sdot sdot-${stat.programKey === 'egg' ? 'layer' : stat.programKey}`} />
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
        </button>

        {/* ── Missed Daily Reports ── grouped panel; per-row + Clear-all
              actions preserved (clearMissedEntry / clearAllMissed). */}
        {allMissed.length > 0 && (
          <section className="block">
            <div className="block-head">
              <h2 className="section-label label-danger">Missed Daily Reports</h2>
              <span className="count-pill count-danger">{allMissed.length}</span>
              <button
                type="button"
                className="btn-clear ml-auto"
                onClick={() => clearAllMissed(allMissed.map((m) => m.key))}
              >
                Clear all
              </button>
            </div>
            <ul className="panel">
              {allMissed.map((m) => (
                <li key={m.key} className="litem">
                  <span className="coin coin-sm">
                    <PlannerIcon iconKey={m.iconKey} size={22} />
                  </span>
                  <div className="litem-body">
                    <div className="litem-title">{m.label}</div>
                    <div className="litem-meta">
                      {m.type} · No daily report for {fmt(m.date)}
                    </div>
                  </div>
                  <button type="button" className="btn-clear" onClick={() => clearMissedEntry(m.key)}>
                    Clear
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {allMissed.length === 0 &&
          (activeBroilerBatches2.length > 0 || hasAnyActivePig || activeLayerGroups2.length > 0) && (
            <div className="note note-ok">
              <span className="note-ic">
                <CheckGlyph />
              </span>
              All active batches had daily reports entered for the past 7 days
            </div>
          )}

        {/* ── Equipment Attention ── overdue intervals + every-fillup streaks + warranty.
              NOT manually clearable. Each row auto-clears when its underlying
              state resolves: interval ticked complete on a fueling, every-fillup
              items ticked on next fueling, or warranty_expiration updated. */}
        {equipmentAttention.length > 0 && (
          <section className="block">
            <div className="block-head">
              <span className="head-ic">
                <WrenchGlyph />
              </span>
              <h2 className="section-label">Equipment Attention</h2>
              <span className="count-pill count-danger">{equipmentAttention.length}</span>
            </div>
            <ul className="panel">
              {equipmentAttention.map((a) => {
                const led = a.kind === 'overdue' ? 'led-danger' : 'led-warn';
                const badge = a.kind === 'overdue' ? 'badge-danger' : 'badge-warn';
                // Pastel quantity badge ("10 h overdue" / "6 skipped"), design parity.
                const badgeText = a.pill || (a.kind === 'overdue' ? 'Overdue' : 'Skipped');
                // Warranty-only notices keep the manual Clear; any piece with a
                // service/checklist item is auto-clearing and shows the pill.
                const isClearable = !!a.clearableKey;
                // Group of typed items for this one piece of equipment. Each
                // carries a type chip (Service / Checklist / Warranty) so a
                // 50-hour checklist streak never reads like a duplicate service
                // alert. The notice routes via its primary kind.
                const items = Array.isArray(a.items) ? a.items : [];
                return (
                  <li
                    key={a.key}
                    className="litem eq is-link"
                    data-attention-kind={a.kind}
                    data-equipment-slug={a.slug}
                    {...openableProps(() =>
                      navigate(a.kind === 'fillup_streak' ? '/equipment/' + a.slug : '/fleet/' + a.slug),
                    )}
                  >
                    <span className={'eq-led ' + led} />
                    <div className="litem-body">
                      <div className="litem-title">{a.label}</div>
                      <div className="litem-types">
                        {items.map((it) => (
                          <div className="litem-type-row" key={it.key} data-attention-item-kind={it.kind}>
                            <span className={'type-chip type-' + it.type}>{it.typeLabel}</span>
                            {/* service: service-only meta (quantity is in the pill);
                                checklist/warranty fall back to the full detail. */}
                            <span className="litem-meta">{it.metaLabel || it.detail}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    {isClearable ? (
                      <button
                        type="button"
                        className="btn-clear"
                        onClick={(e) => {
                          e.stopPropagation();
                          clearMissedEntry(a.clearableKey);
                        }}
                      >
                        Clear
                      </button>
                    ) : (
                      <span className={'badge-soft ' + badge}>{badgeText}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {showEquipmentMaintenanceCaughtUp && (
          <div className="note note-ok" data-home-equipment-maintenance-caught-up="1">
            <span className="note-ic">
              <CheckGlyph />
            </span>
            Equipment maintenance is caught up
          </div>
        )}

        {/* ── Materials Needed (mig 048) ── compact rolling-checklist for
              every logged-in role (not admin-gated). Cleared rows vanish
              from the active list (Codex lane amendment 2). One-material-
              at-a-time clear only — no bulk Clear All. This is the
              canonical operator surface for materials after the standalone
              /fleet/materials page was retired 2026-05-14. */}
        {materialsChecklist.length > 0 && (
          <section className="block" data-home-materials-card="1">
            <div className="block-head">
              <h2 className="section-label">Materials Needed</h2>
            </div>
            <div className="panel">
              {materialsChecklist.map((row) => (
                <div key={row.equipment.id} className="mat-eq" data-home-material-equipment={row.equipment.slug}>
                  <div className="mat-eq-name">{row.equipment.name}</div>
                  {row.groups.map((g) => {
                    const labelUnit = g.interval_unit === 'km' ? 'km' : g.interval_unit === 'use' ? '' : 'h';
                    const groupLabel =
                      g.interval_unit === 'use'
                        ? g.attachment_name
                          ? `${g.attachment_name} — Every Use`
                          : 'Every Use'
                        : g.attachment_name
                          ? `${g.attachment_name} — ${g.interval_value}${labelUnit}`
                          : `Every ${g.interval_value}${labelUnit}`;
                    const isOverdue = g.status?.overdue;
                    const dueLabel =
                      g.interval_unit === 'use'
                        ? 'always'
                        : isOverdue
                          ? 'OVERDUE'
                          : `due in ${g.status?.until_due ?? '—'}${labelUnit}`;
                    return (
                      <div key={g.groupKey} className={'mat-group' + (isOverdue ? ' is-overdue' : '')}>
                        <div className="mat-group-head">
                          <span className="mat-group-label">{groupLabel}</span>
                          <span className={'mat-group-due' + (isOverdue ? ' is-overdue' : '')}>{dueLabel}</span>
                        </div>
                        {g.materials.map((m) => (
                          <div key={m.id} className="mat-row" data-home-material-row={m.id}>
                            <span className="mat-name">{m.material_name}</span>
                            {m.qty && (
                              <span className="mat-qty">
                                {m.qty}
                                {m.unit ? ` ${m.unit}` : ''}
                              </span>
                            )}
                            <button
                              type="button"
                              className="btn-clear"
                              onClick={() => clearMaterialOne(m, g)}
                              data-home-material-clear={m.id}
                            >
                              Clear
                            </button>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>
        )}

        {showEquipmentMaterialsCaughtUp && (
          <div className="note note-ok" data-home-materials-caught-up="1">
            <span className="note-ic">
              <CheckGlyph />
            </span>
            Equipment materials are caught up
          </div>
        )}

        {/* ── Admin Weekly Report Table ── */}

        {/* What's happening this week */}
        <section className="block">
          <div className="block-head">
            <h2 className="section-label">Next 30 Days</h2>
          </div>
          {weekEvents.length === 0 ? (
            <div className="card empty-note">Nothing scheduled in the next 30 days</div>
          ) : (
            <ul className="panel">
              {weekEvents.map((e, i) => (
                <li
                  key={i}
                  className={'litem fd' + (e.reminder ? ' is-link' : '')}
                  {...(e.reminder
                    ? openableProps(() => {
                        if (e.type === 'wt-4wk' || e.type === 'wt-6wk') {
                          setView('list');
                        }
                      })
                    : {})}
                >
                  <span className="coin coin-sm">
                    <PlannerIcon iconKey={e.iconKey} size={18} />
                  </span>
                  <div className="litem-body">
                    <div className="litem-title">{e.label}</div>
                    <div className="litem-meta">
                      {e.subline || fmt(e.date)}
                      {e.reminder ? ' · click to open batch' : ''}
                    </div>
                  </div>
                  {e.reminder ? (
                    <span className="badge-soft badge-info">REMINDER</span>
                  ) : (
                    <span className="dot" style={{background: e.color}} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {isAdmin && allRecentReports.length > 0 && (
          <section className="block admin-daily-block">
            <div className="block-head">
              <h2 className="section-label">Last 5 Days — All Daily Reports</h2>
            </div>
            <div className="card admin-daily">
              {(() => {
                // Group by date, then within each date group by animal kind.
                // Lookups (order/colors/bg) key off the stable `kind` string,
                // not an emoji-prefixed display label, so the heading icon
                // can swap to PNG without churning the lookup map.
                const dates = [...new Set(allRecentReports.map((r) => r.date))].sort().reverse();
                const kindOrder = {broiler: 0, pig: 1, layer: 2, egg: 3, cattle: 4, sheep: 5};
                const kindColors = {
                  broiler: '#a16207',
                  pig: '#1e3a8a',
                  layer: '#92400e',
                  egg: '#78350f',
                  cattle: '#991b1b',
                  sheep: '#0f766e',
                };
                const kindIconKey = {
                  broiler: ANIMAL_ICON_KEYS.broiler,
                  pig: ANIMAL_ICON_KEYS.pig,
                  layer: ANIMAL_ICON_KEYS.layer,
                  egg: ANIMAL_ICON_KEYS.egg,
                  cattle: ANIMAL_ICON_KEYS.cattle,
                  sheep: ANIMAL_ICON_KEYS.sheep,
                };
                return dates.map((date) => {
                  const dayRecs = allRecentReports
                    .filter((r) => r.date === date)
                    .sort((a, b) => (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9));
                  const kinds = [...new Set(dayRecs.map((r) => r.kind))];
                  return (
                    <div key={date} className="day-group">
                      <div className="day-head">
                        <span>{fmt(date)}</span>
                        <span className="day-count">
                          {dayRecs.length} report{dayRecs.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      {kinds.map((kind) => {
                        const typeRecs = dayRecs.filter((r) => r.kind === kind);
                        const color = kindColors[kind] || '#374151';
                        const heading = (typeRecs[0] && typeRecs[0].label) || kind;
                        return (
                          <div key={kind} className="kind-group">
                            <div className="kind-head">
                              <PlannerIcon iconKey={kindIconKey[kind]} size={18} />
                              <span className="kind-dot" style={{background: color}} aria-hidden="true" />
                              <span className="kind-name">{heading.toUpperCase()}</span>
                            </div>
                            <div className="drc-stack">
                              {typeRecs.map((r) => {
                                const d = r.raw || {};
                                const open = () => {
                                  const path = pathForDailyReport(r);
                                  if (path) navigate(path);
                                };
                                const attrs = {'data-daily-report-tile': r.id};
                                if (kind === 'egg') {
                                  const total =
                                    (parseInt(d.group1_count) || 0) +
                                    (parseInt(d.group2_count) || 0) +
                                    (parseInt(d.group3_count) || 0) +
                                    (parseInt(d.group4_count) || 0);
                                  const breakdown = [
                                    [d.group1_name, d.group1_count],
                                    [d.group2_name, d.group2_count],
                                    [d.group3_name, d.group3_count],
                                    [d.group4_name, d.group4_count],
                                  ]
                                    .filter(([n, c]) => n && parseInt(c) > 0)
                                    .map(([n, c]) => ({loc: n, n: c}));
                                  return (
                                    <EggSummaryCard
                                      key={r.id}
                                      total={total}
                                      team={d.team_member || '—'}
                                      breakdown={breakdown}
                                      dozens={parseFloat(d.dozens_on_hand) > 0 ? d.dozens_on_hand + ' doz' : null}
                                      comment={commentText(d.comments)}
                                      onOpen={open}
                                      attrs={attrs}
                                    />
                                  );
                                }
                                return (
                                  <DailyRecordCard
                                    key={r.id}
                                    program={kind}
                                    {...buildHomeDailyModel(kind, d)}
                                    onOpen={open}
                                    attrs={attrs}
                                  />
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
          </section>
        )}
      </main>
    </div>
  );
}
