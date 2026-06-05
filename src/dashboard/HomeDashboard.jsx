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
import {fmt, fmtS, toISO, addDays} from '../lib/dateUtils.js';
import {calcPoultryStatus, computeBroilerOnFarmCounts} from '../lib/broiler.js';
import {calcBreedingTimeline, buildCycleSeqMap, calcCycleStatus, activePigFeederDailyTargets} from '../lib/pig.js';
import {buildMaterialChecklist} from '../lib/equipmentMaterials.js';
import {
  buildEquipmentAttention,
  buildMissedDailyReports,
  buildNext30Events,
  foldEquipmentFuelings,
} from './homeAlerts.js';
import {renderCattleIconLabel} from '../components/CattleIcon.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';
import {ANIMAL_ICON_KEYS, PLANNER_ICON_KEYS} from '../lib/plannerIcons.js';
import UsersModal from '../auth/UsersModal.jsx';
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
import {computeHousingDisplayCount} from '../lib/layerHousing.js';

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

export default function HomeDashboard({Header, loadUsers, canAccessProgram, VIEW_TO_PROGRAM}) {
  const {authState, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const {batches} = useBatches();
  const {breedingCycles, farrowingRecs, feederGroups, breeders} = usePig();
  const {layerGroups, layerHousings, allLayerDailys} = useLayer();
  const {broilerDailys, pigDailys, layerDailysRecent, eggDailysRecent, cattleDailysRecent, sheepDailysRecent} =
    useDailysRecent();
  const {cattleForHome, cattleOnFarmCount} = useCattleHome();
  const {sheepForHome} = useSheepHome();
  const {missedCleared, setMissedCleared} = useFeedCosts();
  const {setView} = useUI();
  const navigate = useNavigate();

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

  // Auto-status counts for poultry
  const broilerOnFarmCounts = computeBroilerOnFarmCounts(batches, broilerDailys);
  const activeBatches = broilerOnFarmCounts.activeBatches;
  const plannedBatches = batches.filter((b) => calcPoultryStatus(b) === 'planned');
  const processedBatches = batches.filter((b) => calcPoultryStatus(b) === 'processed');
  const broilerOnFarm = broilerOnFarmCounts.onFarmBirds;

  const weekEvents = buildNext30Events({batches, breedingCycles, farrowingRecs, feederGroups});

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
        {/* Nav cards — 3 cols × 2 rows on desktop, 2 cols × 3 rows on mobile
            (mobile column swap lives in the HTML <style> block keyed off
            data-home-grid="programs") so the program labels don't clip. */}
        <div data-home-grid="programs" style={{display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10}}>
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
                  <PlannerIcon iconKey={c.iconKey} text={c.iconText} size={36} />
                </div>
                <div style={{minWidth: 0, flex: 1}}>
                  <div style={{fontSize: 18, fontWeight: 700, color: c.color}}>{c.label}</div>
                </div>
              </div>
            ))}
        </div>

        {React.createElement(HomeWeatherCard)}

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
            .reduce((s, h) => s + computeHousingDisplayCount(h, allLayerDailys), 0);
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
          const totalAll = broilerOnFarm + totalHens + totalPigs + cattleOnFarmCount + sheepOnFarm;
          return (
            <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, padding: '16px 24px'}}>
              <div style={{fontSize: 12, fontWeight: 600, color: '#4b5563', letterSpacing: 0.3, marginBottom: 12}}>
                ANIMALS ON FARM
              </div>
              <div
                data-home-grid="animals"
                style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr 1fr', gap: 16, alignItems: 'center'}}
              >
                <div style={{textAlign: 'center'}}>
                  <div style={{fontSize: 26, fontWeight: 700, color: '#a16207'}}>{broilerOnFarm.toLocaleString()}</div>
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
                  <div style={{fontSize: 11, color: '#6b7280', marginTop: 2}}>
                    {renderCattleIconLabel('Cattle', {size: 16})}
                  </div>
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
                  <PlannerIcon iconKey={m.iconKey} size={22} />
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
          (activeBroilerBatches2.length > 0 || hasAnyActivePig || activeLayerGroups2.length > 0) && (
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
              <PlannerIcon iconKey="checkmark" size={16} />
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

        {/* ── Materials Needed (mig 048) ── compact rolling-checklist for
              every logged-in role (not admin-gated). Cleared rows vanish
              from the active list (Codex lane amendment 2). One-material-
              at-a-time clear only — no bulk Clear All. This is the
              canonical operator surface for materials after the standalone
              /fleet/materials page was retired 2026-05-14. */}
        {materialsChecklist.length > 0 && (
          <div data-home-materials-card="1">
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 10,
                marginBottom: 8,
              }}
            >
              <div style={{fontSize: 13, fontWeight: 600, color: '#92400e', letterSpacing: 0.3}}>
                🧰 MATERIALS NEEDED
              </div>
            </div>
            <div
              style={{
                background: 'white',
                border: '1px solid #fde68a',
                borderRadius: 10,
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              {materialsChecklist.map((row) => (
                <div key={row.equipment.id} data-home-material-equipment={row.equipment.slug}>
                  <div style={{fontSize: 12, fontWeight: 700, color: '#111827', marginBottom: 4}}>
                    {row.equipment.name}
                  </div>
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
                      <div
                        key={g.groupKey}
                        style={{
                          marginBottom: 6,
                          paddingLeft: 8,
                          borderLeft: '2px solid ' + (isOverdue ? '#fecaca' : '#fde68a'),
                        }}
                      >
                        <div style={{display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2}}>
                          <span style={{fontSize: 11, fontWeight: 700, color: '#374151'}}>{groupLabel}</span>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: isOverdue ? 700 : 500,
                              color: isOverdue ? '#b91c1c' : '#6b7280',
                            }}
                          >
                            {dueLabel}
                          </span>
                        </div>
                        {g.materials.map((m) => (
                          <div
                            key={m.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '2px 0',
                              fontSize: 12,
                            }}
                            data-home-material-row={m.id}
                          >
                            <span style={{flex: 1, color: '#111827'}}>{m.material_name}</span>
                            {m.qty && (
                              <span style={{fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap'}}>
                                {m.qty}
                                {m.unit ? ` ${m.unit}` : ''}
                              </span>
                            )}
                            <button
                              onClick={() => clearMaterialOne(m, g)}
                              style={{
                                fontSize: 11,
                                color: '#6b7280',
                                background: 'white',
                                border: '1px solid #d1d5db',
                                borderRadius: 6,
                                padding: '2px 10px',
                                cursor: 'pointer',
                                fontFamily: 'inherit',
                                flexShrink: 0,
                              }}
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
                  <PlannerIcon iconKey={e.iconKey} size={18} />
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
                      {e.subline || fmt(e.date)}
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
                    {kinds.map((kind) => {
                      const typeRecs = dayRecs.filter((r) => r.kind === kind);
                      const color = kindColors[kind] || '#374151';
                      const bg = kindBg[kind] || '#f9fafb';
                      const heading = (typeRecs[0] && typeRecs[0].label) || kind;
                      return (
                        <div key={kind} style={{marginBottom: 10}}>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 700,
                              color: color,
                              letterSpacing: 0.5,
                              marginBottom: 6,
                              paddingLeft: 2,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                            }}
                          >
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
                                  onClick={() => {
                                    const path = pathForDailyReport(r);
                                    if (path) navigate(path);
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
                                    if (r.kind === 'pig') {
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
