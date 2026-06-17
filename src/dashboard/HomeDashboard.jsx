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
                const kindBg = {
                  broiler: '#fef9c3',
                  pig: '#eff6ff',
                  layer: '#fffbeb',
                  egg: '#fefce8',
                  cattle: '#fef2f2',
                  sheep: '#f0fdfa',
                };
                const kindIconKey = {
                  broiler: ANIMAL_ICON_KEYS.broiler,
                  pig: ANIMAL_ICON_KEYS.pig,
                  layer: ANIMAL_ICON_KEYS.layer,
                  egg: ANIMAL_ICON_KEYS.egg,
                  cattle: ANIMAL_ICON_KEYS.cattle,
                  sheep: ANIMAL_ICON_KEYS.sheep,
                };
                return dates.map((date, di) => {
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
                        const bg = kindBg[kind] || '#f9fafb';
                        const heading = (typeRecs[0] && typeRecs[0].label) || kind;
                        return (
                          <div key={kind} className="kind-group">
                            <div className="kind-head" style={{color: color}}>
                              <PlannerIcon iconKey={kindIconKey[kind]} size={18} />
                              <span>{heading.toUpperCase()}</span>
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
                                    data-daily-report-tile={r.id}
                                    {...openableProps(() => {
                                      const path = pathForDailyReport(r);
                                      if (path) navigate(path);
                                    })}
                                    style={{
                                      background: shadeBg,
                                      borderRadius: 10,
                                      border: notable ? '1.5px solid #fca5a5' : '1px solid var(--border)',
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
                                        borderRadius: 10,
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
                                            borderRadius: 10,
                                            background: '#f1f5f9',
                                            color: '#475569',
                                            border: '1px solid var(--border)',
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
                                            borderRadius: 10,
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
                                            borderRadius: 10,
                                            fontStyle: 'italic',
                                          }}
                                        >
                                          {'\ud83d\udcac ' + txt}
                                        </span>
                                      );

                                      if (r.kind === 'broiler') {
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
                                              className="admin-daily-row"
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
                                                      borderRadius: 10,
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
                                                style={{
                                                  display: 'flex',
                                                  gap: 6,
                                                  flexWrap: 'wrap',
                                                  alignItems: 'center',
                                                }}
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
                                      if (r.kind === 'layer') {
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
                                              className="admin-daily-row"
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
                                                      borderRadius: 10,
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
                                                style={{
                                                  display: 'flex',
                                                  gap: 6,
                                                  flexWrap: 'wrap',
                                                  alignItems: 'center',
                                                }}
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
                                      if (r.kind === 'pig') {
                                        const hasFeed = parseFloat(d.feed_lbs) > 0,
                                          hasCount = parseInt(d.pig_count) > 0;
                                        const hasVolt =
                                          d.fence_voltage != null && String(d.fence_voltage).trim() !== '';
                                        const voltColor = (v) => (v < 3 ? '#b91c1c' : v < 5 ? '#92400e' : '#065f46');
                                        const hasMort = parseInt(d.mortality_count) > 0;
                                        const issues =
                                          d.issues && String(d.issues).trim().length > 2 ? String(d.issues).trim() : '';
                                        return (
                                          <>
                                            <div
                                              className="admin-daily-row"
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
                                                style={{
                                                  display: 'flex',
                                                  gap: 6,
                                                  flexWrap: 'wrap',
                                                  alignItems: 'center',
                                                }}
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
                                      if (r.kind === 'egg') {
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
                                      if (r.kind === 'cattle') {
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
                                        const hasVolt =
                                          d.fence_voltage != null && String(d.fence_voltage).trim() !== '';
                                        return (
                                          <>
                                            <div
                                              className="admin-daily-row"
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
                                                  borderRadius: 10,
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
                                                style={{
                                                  display: 'flex',
                                                  gap: 6,
                                                  flexWrap: 'wrap',
                                                  alignItems: 'center',
                                                }}
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
                                      if (r.kind === 'sheep') {
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
                                            s +
                                            (f.category === 'hay' && f.unit === 'bale' ? parseFloat(f.qty) || 0 : 0),
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
                                              className="admin-daily-row"
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
                                                  borderRadius: 10,
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
                                                  color: hasVolt
                                                    ? voltColor(parseFloat(d.fence_voltage_kv))
                                                    : '#9ca3af',
                                                  fontWeight: hasVolt ? 600 : 400,
                                                  fontSize: 12,
                                                  whiteSpace: 'nowrap',
                                                }}
                                              >
                                                {hasVolt ? `\u26a1 ${d.fence_voltage_kv} kV` : 'no voltage'}
                                              </span>
                                              <span
                                                style={{
                                                  display: 'flex',
                                                  gap: 6,
                                                  flexWrap: 'wrap',
                                                  alignItems: 'center',
                                                }}
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
          </section>
        )}
      </main>
    </div>
  );
}
