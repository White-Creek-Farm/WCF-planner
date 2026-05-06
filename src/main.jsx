// ============================================================================
// WCF Planner — main.jsx
// ============================================================================
/* global XLSX */
// parseProcessorXlsx (line ~1386) reads the lazy-loaded SheetJS UMD which
// attaches to window.XLSX via window._wcfLoadXLSX (defined below at the
// "wcf-babel-* purge" block). Same pattern as cattle/sheep bulk-import.
// Phase 1.2 of the Vite migration: app source moved verbatim from the
// <script type="text/jsx-source" id="wcf-app-source"> block in index.html.
// CDN globals (React, ReactDOM, supabase) become ESM imports here. NO logic
// or JSX changes — this is a structural move only. Every line below the
// "BEGIN VERBATIM PORT" marker is byte-identical to lines 212–19342 of the
// pre-migration index.html (backed up at
// ~/OneDrive/Desktop/WCF-planner-backups/index.html.pre-vite-2026-04-19).
// ============================================================================

import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter, useLocation, useNavigate} from 'react-router-dom';
import {VIEW_TO_PATH, PATH_TO_VIEW, HASH_COMPAT, ALIASES_EXACT, ALIASES_PREFIX} from './lib/routes.js';

// Phase 2.0.0: foundation lib helpers extracted from this file. Importing
// here makes them available throughout the verbatim-ported app body without
// any rename or rewiring (the names `sb`, `wcfSendEmail`, `wcfSelectAll`
// are still globals in the module scope).
import {sb} from './lib/supabase.js';
import {wcfSendEmail} from './lib/email.js';
import {wcfSelectAll} from './lib/pagination.js';

// Phase 2.0.1: AuthContext owns the auth-related useState hooks. App() reads
// them via useAuth(); effects + helpers + derived values stay in App.
import {AuthProvider, useAuth} from './contexts/AuthContext.jsx';

// Phase 2.0.2: BatchesContext owns the broiler batch + edit-form hooks.
// EMPTY_FORM is passed in as the form initializer (module-scope here).
import {BatchesProvider, useBatches} from './contexts/BatchesContext.jsx';

// Phase 2.0.3: PigContext owns all pig-scoped useState hooks. INITIAL_FARROWING,
// INITIAL_BREEDERS, and the breedTlStart lazy init are threaded in as props.
import {PigProvider, usePig} from './contexts/PigContext.jsx';

// Phase 2.0.4: LayerContext owns layer-scoped useState hooks.
import {LayerProvider, useLayer} from './contexts/LayerContext.jsx';

// Phase 2.0.5: DailysRecentContext owns the recent-window dailys arrays
// across broiler/pig/layer/egg/cattle/sheep.
import {DailysRecentProvider, useDailysRecent} from './contexts/DailysRecentContext.jsx';

// Phase 2.0.6: five small contexts bundled in one commit.
import {CattleHomeProvider, useCattleHome} from './contexts/CattleHomeContext.jsx';
import {SheepHomeProvider, useSheepHome} from './contexts/SheepHomeContext.jsx';
import {WebformsConfigProvider, useWebformsConfig} from './contexts/WebformsConfigContext.jsx';
import {FeedCostsProvider, useFeedCosts} from './contexts/FeedCostsContext.jsx';
import {UIProvider, useUI} from './contexts/UIContext.jsx';

// Phase 2.1.1: leaf form-input components extracted to src/shared/.
import WcfYN from './shared/WcfYN.jsx';
import WcfToggle from './shared/WcfToggle.jsx';

// Phase 2.1.2: DeleteModal extracted to src/shared/.
import DeleteModal from './shared/DeleteModal.jsx';

// Phase 2.1.3 prep: layer-housing helpers extracted ahead of modal extractions
// so the admin modal + webform hub can import them without a circular dep on
// main.jsx. Verbatim — signatures unchanged.
import {setHousingAnchorFromReport, computeProjectedCount, computeLayerFeedCost} from './lib/layerHousing.js';

// Phase 2.1.4: Admin + livestock + cattle modals extracted verbatim.
import AdminAddReportModal from './shared/AdminAddReportModal.jsx';
import AdminNewWeighInModal from './shared/AdminNewWeighInModal.jsx';
import PigSendToTripModal from './livestock/PigSendToTripModal.jsx';
import CattleNewWeighInModal from './cattle/CattleNewWeighInModal.jsx';

// Phase 2.1.5: SetPasswordScreen + LoginScreen extracted to src/auth/.
import SetPasswordScreen from './auth/SetPasswordScreen.jsx';
import LoginScreen from './auth/LoginScreen.jsx';

// Phase 2 Round 2: single-feature dailys views + cow/sheep detail + bulk imports.
import BroilerDailysView from './broiler/BroilerDailysView.jsx';
import BroilerHomeView from './broiler/BroilerHomeView.jsx';
import BroilerTimelineView from './broiler/BroilerTimelineView.jsx';
import BroilerListView from './broiler/BroilerListView.jsx';
import BroilerFeedView from './broiler/BroilerFeedView.jsx';
import PigsHomeView from './pig/PigsHomeView.jsx';
import BreedingView from './pig/BreedingView.jsx';
import FarrowingView from './pig/FarrowingView.jsx';
import SowsView from './pig/SowsView.jsx';
import PigFeedView from './pig/PigFeedView.jsx';
import PigBatchesView from './pig/PigBatchesView.jsx';
import LayerDailysView from './layer/LayerDailysView.jsx';
import EggDailysView from './layer/EggDailysView.jsx';
import PigDailysView from './pig/PigDailysView.jsx';
import CattleDailysView from './cattle/CattleDailysView.jsx';
import CattleBulkImport from './cattle/CattleBulkImport.jsx';
import SheepBulkImport from './sheep/SheepBulkImport.jsx';
import SheepDetail from './sheep/SheepDetail.jsx';
import SheepDailysView from './sheep/SheepDailysView.jsx';
import SheepWeighInsView from './sheep/SheepWeighInsView.jsx';
import CollapsibleOutcomeSections from './cattle/CollapsibleOutcomeSections.jsx';
import CowDetail from './cattle/CowDetail.jsx';

// Phase 2.3.5/2.3.6 bug-fix: LivestockWeighInsView + CattleWeighInsView
// were accidentally bundled into adjacent modal files in Round 1. Split.
import LivestockWeighInsView from './livestock/LivestockWeighInsView.jsx';
import CattleWeighInsView from './cattle/CattleWeighInsView.jsx';

// Phase 2.3 prep: helpers needed by Round 3 views extracted to src/lib/.
import {loadCattleWeighInsCached, invalidateCattleWeighInsCache} from './lib/cattleCache.js';
import {calcCattleBreedingTimeline, buildCattleCycleSeqMap, cattleCycleLabel} from './lib/cattleBreeding.js';
import {addDays, toISO, fmt, fmtS, todayISO} from './lib/dateUtils.js';
import {S} from './lib/styles.js';
import {DEFAULT_WEBFORMS_CONFIG} from './lib/defaults.js';
import {loadRoster, activeNames as rosterActiveNames} from './lib/teamMembers.js';
import {loadAvailability} from './lib/teamAvailability.js';
// Phase 2 Round 6 prep: broiler helpers lifted to src/lib/broiler.js so the
// BroilerHomeView extraction can import them without a main.jsx circular dep.
import {
  BROODER_DAYS,
  CC_SCHOONER,
  WR_SCHOONER,
  WEEKS_SHOWN,
  LEGACY_BREEDS,
  RESOURCES,
  BREED_STYLE,
  STATUS_STYLE,
  BROODERS,
  SCHOONERS,
  BROODER_CLEANOUT,
  SCHOONER_CLEANOUT,
  overlaps,
  STATUSES,
  ALL_HATCHERIES,
  LEGACY_HATCHERIES,
  getFeedSchedule,
  calcBatchFeed,
  calcBatchFeedForMonth,
  calcLayerFeedForMonth,
  calcTimeline,
  calcPoultryStatus,
  shouldAutoActivateBroilerBatch,
  calcBroilerStatsFromDailys,
  getBatchColor,
  breedLabel,
  isNearHoliday,
  calcTargetHatch,
  suggestHatchDates,
} from './lib/broiler.js';
import {
  BOAR_EXPOSURE_DAYS,
  GESTATION_DAYS,
  WEANING_DAYS,
  GROW_OUT_DAYS,
  PIG_GROUPS,
  BREEDING_STATUSES,
  PIG_GROUP_COLORS,
  PIG_GROUP_TEXT,
  PHASE_LABELS,
  calcBreedingTimeline,
  buildCycleSeqMap,
  cycleLabel,
  calcCycleStatus,
  reconcileFeederGroupsFromBreeders,
} from './lib/pig.js';
import {detectConflicts} from './lib/conflicts.js';
import {buildBroilerPublicMirror} from './lib/broilerBatchMeta.js';
if (typeof window !== 'undefined') {
  window.invalidateCattleWeighInsCache = invalidateCattleWeighInsCache;
}

// Phase 2 Round 3: bigger stateful views + UsersModal.
import UsersModal from './auth/UsersModal.jsx';
import LayersHomeView from './layer/LayersHomeView.jsx';
import LayersView from './layer/LayersView.jsx';
import CattleHomeView from './cattle/CattleHomeView.jsx';
import SheepFlocksView from './sheep/SheepFlocksView.jsx';
import SheepBatchesView from './sheep/SheepBatchesView.jsx';
import SheepHomeView from './sheep/SheepHomeView.jsx';
import CattleHerdsView from './cattle/CattleHerdsView.jsx';
import CattleBreedingView from './cattle/CattleBreedingView.jsx';
import CattleBatchesView from './cattle/CattleBatchesView.jsx';
import CattleForecastView from './cattle/CattleForecastView.jsx';

// Phase 2 Round 4: admin panels.
import FeedCostsPanel from './admin/FeedCostsPanel.jsx';
import FeedCostByMonthPanel from './admin/FeedCostByMonthPanel.jsx';
import LivestockFeedInputsPanel from './admin/LivestockFeedInputsPanel.jsx';
import NutritionTargetsPanel from './admin/NutritionTargetsPanel.jsx';

// Phase 2 Round 5: public webforms (no-auth hash-routed).
import AddFeedWebform from './webforms/AddFeedWebform.jsx';
import WeighInsWebform from './webforms/WeighInsWebform.jsx';
import WebformHub from './webforms/WebformHub.jsx';
import FuelingHub from './webforms/FuelingHub.jsx';
import FuelSupplyWebform from './webforms/FuelSupplyWebform.jsx';
import WebformsAdminView from './webforms/WebformsAdminView.jsx';
import PigDailysWebform from './webforms/PigDailysWebform.jsx';
import AdminTasksView from './admin/AdminTasksView.jsx';
import UnauthorizedRedirect from './shared/UnauthorizedRedirect.jsx';
import TasksWebform from './webforms/TasksWebform.jsx';
import MyTasksView from './auth/MyTasksView.jsx';

// Phase 2 Round 8: equipment placeholder.
import EquipmentHome from './equipment/EquipmentHome.jsx';

// Phase 2 Round 2 tail: LayerBatchesView (deferred from the original Round 2
// push). Now imports once the housing + broiler primitives live in lib/.
import LayerBatchesView from './layer/LayerBatchesView.jsx';

// Phase 2 Round 7: HomeDashboard — the last big inline view. Hook-based
// extraction; reads every data context, takes canAccessProgram +
// VIEW_TO_PROGRAM as props (they still live in App).
import HomeDashboard from './dashboard/HomeDashboard.jsx';

// Phase 2 Round 6 tail: top nav bar + program sub-nav. Pulls view/menu
// state + auth + form-open booleans from their respective contexts; App()
// wraps this in a local Header closure below so every extracted view can
// still receive a zero-arg <Header/> prop (no ripple changes).
import HeaderBase from './shared/Header.jsx';

// Phase 2 Round 6 tail: broiler add/edit modal — the last inline block
// inside App's render body. Hook-based; receives the six operational
// helpers (upd/closeForm/submit/del/openEdit/parseProcessorXlsx/
// confirmDelete/persist) as props from App.
import BatchForm from './broiler/BatchForm.jsx';

// ── ONE-TIME LEGACY BABEL-CACHE CLEANUP ──
// Pre-Vite versions cached compiled JSX in localStorage under wcf-babel-*
// keys (~600 KB per user). With Vite there's no in-browser transpile, so
// these are dead weight. Idempotent purge on every mount; safe to leave
// in forever even after every existing user has reloaded once.
try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith('wcf-babel-')) localStorage.removeItem(k);
  }
} catch (e) {
  /* localStorage disabled — fine */
}

// ── PHASE 3.3 — LEGACY HASH-BOOKMARK COMPAT SHIM ──
// Pre-Phase-3 users may have saved /#weighins, /#addfeed, /#webforms
// URLs in browser bookmarks, Slack links, or printed materials. The
// router only reads pathname, not hash, so we rewrite the URL here
// synchronously BEFORE root.render() runs — otherwise BrowserRouter
// would read pathname='/' and the adapter would snap to home.
//
// The supabase password-recovery hash (/#access_token=...&type=recovery)
// is deliberately NOT rewritten — SetPasswordScreen still parses it
// from window.location.hash for backward compat with the email template.
try {
  const h = window.location.hash;
  if (h && HASH_COMPAT[h]) {
    window.history.replaceState(null, '', HASH_COMPAT[h]);
  }
} catch (e) {
  /* no history API / locked-down browser — skip */
}

// ── MANIFEST HREF SWAP (2026-05-06 public-URL rename) ──
// Two static manifests live in public/: manifest.webmanifest (start_url
// /dailys, the operator daily-reports hub) and manifest-equipment.webmanifest
// (start_url /equipment, the operator equipment/fueling hub). When the user
// is on /equipment* or the legacy /fueling*, link[rel="manifest"] points at
// the equipment manifest so Add to Home Screen and the install banner pick
// up the equipment-hub start_url. Otherwise it points at the default daily
// manifest. The helper runs at module scope (correct href before first
// paint) AND inside an App useEffect keyed on location.pathname (so SPA
// navigation between hubs keeps the link in sync without a full reload).
function applyManifestHref(pathname) {
  try {
    const link = document.querySelector('link[rel="manifest"]');
    if (!link) return;
    const isEquipment = pathname.startsWith('/equipment') || pathname.startsWith('/fueling');
    const next = isEquipment ? '/manifest-equipment.webmanifest' : '/manifest.webmanifest';
    if (link.getAttribute('href') !== next) link.setAttribute('href', next);
  } catch (e) {
    /* no DOM / locked-down browser — skip */
  }
}
applyManifestHref(window.location.pathname);

// ── LAZY LOAD SHEETJS ──
// SheetJS (xlsx) is ~600KB minified and only used when opening processor
// reports / running bulk imports. Defer loading until first use via dynamic
// ESM import. Same window._wcfLoadXLSX API as the pre-Vite CDN-script-tag
// loader so the existing call sites (`await window._wcfLoadXLSX()` followed
// by `XLSX.X`) don't need to change.
window._wcfLoadXLSX = function () {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (window._wcfXLSXPromise) return window._wcfXLSXPromise;
  window._wcfXLSXPromise = import('xlsx').then((m) => {
    window.XLSX = m.default || m;
    return window.XLSX;
  });
  return window._wcfXLSXPromise;
};

// === BEGIN VERBATIM PORT (was index.html lines 212–19342) ===

// (Phase 2.0.0: sb client init + wcfSendEmail + wcfSelectAll definitions
// moved to src/lib/supabase.js, src/lib/email.js, src/lib/pagination.js
// respectively. They're re-imported above as module-scoped names so every
// downstream reference in the verbatim-ported body still resolves.)

// Phase 2.3 prep: cattle cache helpers moved to src/lib/cattleCache.js.

const {useState, useEffect, useCallback} = React;

// ── CONSTANTS ──────────────────────────────────────────────────────────────
// BROODER_CLEANOUT + SCHOONER_CLEANOUT moved to lib/broiler.js (imported above).
const STORAGE_KEY = 'ppp-data-v1';

// Hatchery lists + STATUSES + BROODERS + SCHOONERS moved to lib/broiler.js
// (imported above). CC_HATCHERIES / WR_HATCHERIES were legacy-only refs that
// no live code consumed — dropped.

// ── CATTLE CONSTANTS ──
// Moved to src/lib/cattle.js (Phase 2 finale polish). main.jsx no longer
// consumes them directly — cattleBreeding.js + the views import from lib/
// directly. See CATTLE_DESIGN.md for full module design.

// Given a bull exposure start date, return the full cycle timeline.
// All dates ISO strings. Returns null if start not provided.
// Phase 2.3 prep: cattle breeding helpers moved to src/lib/cattleBreeding.js.

const INITIAL_BREEDERS = [
  {
    id: 'podio-1',
    tag: '1',
    sex: 'Boar',
    group: '',
    status: 'Boar Group',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2023-01-15',
    lastWeight: '393',
    purchaseDate: '2023-04-15',
    purchaseAmount: '750',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-2',
    tag: '2',
    sex: 'Sow',
    group: '2',
    status: 'Sow Group',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2022-02-01',
    lastWeight: '444',
    purchaseDate: '2022-04-01',
    purchaseAmount: '750',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-3',
    tag: '3',
    sex: 'Sow',
    group: '1',
    status: 'Sow Group',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2023-02-15',
    lastWeight: '285',
    purchaseDate: '2023-04-15',
    purchaseAmount: '750',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-4',
    tag: '4',
    sex: 'Sow',
    group: '',
    status: 'Deceased',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2022-02-01',
    lastWeight: '570',
    purchaseDate: '2022-04-01',
    purchaseAmount: '750',
    notes: '',
    archived: true,
  },
  {
    id: 'podio-5',
    tag: '5',
    sex: 'Sow',
    group: '2',
    status: 'Sow Group',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2022-02-01',
    lastWeight: '644',
    purchaseDate: '2022-04-01',
    purchaseAmount: '750',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-6',
    tag: '6',
    sex: 'Sow',
    group: '1',
    status: 'Sow Group',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2023-02-15',
    lastWeight: '370',
    purchaseDate: '2023-04-15',
    purchaseAmount: '750',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-7',
    tag: '7',
    sex: 'Sow',
    group: '1',
    status: 'Sow Group',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2023-02-15',
    lastWeight: '315',
    purchaseDate: '2023-04-15',
    purchaseAmount: '750',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-8',
    tag: '8',
    sex: 'Sow',
    group: '2',
    status: 'Deceased',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2022-02-01',
    lastWeight: '416',
    purchaseDate: '2022-04-01',
    purchaseAmount: '750',
    notes: '',
    archived: true,
  },
  {
    id: 'podio-9',
    tag: '9',
    sex: 'Sow',
    group: '3',
    status: 'Sow Group',
    breed: 'Duroc/Berkshire Cross',
    origin: 'Born on Farm',
    birthDate: '2023-05-17',
    lastWeight: '374',
    purchaseDate: '',
    purchaseAmount: '',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-10',
    tag: '10',
    sex: 'Sow',
    group: '2',
    status: 'Sow Group',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2022-02-01',
    lastWeight: '610',
    purchaseDate: '2022-04-01',
    purchaseAmount: '750',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-11',
    tag: '11',
    sex: 'Sow',
    group: '3',
    status: 'Sow Group',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2023-02-15',
    lastWeight: '387',
    purchaseDate: '2023-04-15',
    purchaseAmount: '750',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-13',
    tag: '13',
    sex: 'Sow',
    group: '2',
    status: 'Sow Group',
    breed: 'Duroc/Berkshire Cross',
    origin: 'Born on Farm',
    birthDate: '2023-05-17',
    lastWeight: '373',
    purchaseDate: '',
    purchaseAmount: '',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-17',
    tag: '17',
    sex: 'Sow',
    group: '1',
    status: 'Sow Group',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2023-02-15',
    lastWeight: '370',
    purchaseDate: '2023-04-15',
    purchaseAmount: '750',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-18',
    tag: '18',
    sex: 'Sow',
    group: '2',
    status: 'Sow Group',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2023-02-15',
    lastWeight: '462',
    purchaseDate: '2024-04-15',
    purchaseAmount: '750',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-19',
    tag: '19',
    sex: 'Sow',
    group: '2',
    status: 'Sow Group',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2023-03-06',
    lastWeight: '414',
    purchaseDate: '2023-04-15',
    purchaseAmount: '750',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-21',
    tag: '21',
    sex: 'Sow',
    group: '3',
    status: 'Sow Group',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2023-02-15',
    lastWeight: '388',
    purchaseDate: '2023-04-15',
    purchaseAmount: '750',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-22',
    tag: '22',
    sex: 'Sow',
    group: '2',
    status: 'Sow Group',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2023-02-15',
    lastWeight: '395',
    purchaseDate: '2023-04-15',
    purchaseAmount: '750',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-25',
    tag: '25',
    sex: 'Boar',
    group: '',
    status: 'Boar Group',
    breed: 'Duroc/Berkshire Cross',
    origin: 'Born on Farm',
    birthDate: '2023-05-17',
    lastWeight: '396',
    purchaseDate: '',
    purchaseAmount: '',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-27',
    tag: '27',
    sex: 'Sow',
    group: '3',
    status: 'Sow Group',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2023-02-15',
    lastWeight: '377',
    purchaseDate: '2023-04-15',
    purchaseAmount: '750',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-28',
    tag: '28',
    sex: 'Sow',
    group: '3',
    status: 'Sow Group',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2023-02-15',
    lastWeight: '360',
    purchaseDate: '2023-04-15',
    purchaseAmount: '750',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-32',
    tag: '32',
    sex: 'Gilt',
    group: '3',
    status: 'Sow Group',
    breed: 'Duroc/Berkshire Cross',
    origin: 'Born on Farm',
    birthDate: '2024-09-18',
    lastWeight: '',
    purchaseDate: '',
    purchaseAmount: '',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-33',
    tag: '33',
    sex: 'Sow',
    group: '3',
    status: 'Sow Group',
    breed: 'Berkshire',
    origin: 'Born on Farm',
    birthDate: '2024-09-18',
    lastWeight: '',
    purchaseDate: '',
    purchaseAmount: '',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-34',
    tag: '34',
    sex: 'Sow',
    group: '3',
    status: 'Sow Group',
    breed: 'Berkshire',
    origin: 'Born on Farm',
    birthDate: '2024-09-18',
    lastWeight: '',
    purchaseDate: '',
    purchaseAmount: '',
    notes: '',
    archived: false,
  },
  {
    id: 'podio-98',
    tag: '98',
    sex: 'Sow',
    group: '1',
    status: 'Deceased',
    breed: 'Berkshire',
    origin: 'Corey Davis',
    birthDate: '2023-02-15',
    lastWeight: '361',
    purchaseDate: '2023-04-15',
    purchaseAmount: '750',
    notes: '',
    archived: true,
  },
];

// Historical farrowing records imported from Podio export
const INITIAL_FARROWING = [
  {
    id: 'f1',
    sow: '5',
    group: '2',
    farrowingDate: '2025-11-13',
    exposureStart: '2025-07-02',
    exposureEnd: '2025-08-13',
    sire: 'MACHINE',
    motheringQuality: 'excellent',
    demeanor: 'Meanest mom in a good defensive way',
    totalBorn: 11,
    deaths: 3,
    location: 'outside-pen',
    wentWell: 'She aggressively defends her piglets',
    didntGoWell: 'Crushing day 5',
    defects:
      '1 doa, 1 dead within 24 hours, one crushed around day 5. 2 runts, one recovered decently, one is still much smaller than rest of batch at 2.5 months old.\n\nMinor prolapse.',
  },
  {
    id: 'f2',
    sow: '19',
    group: '2',
    farrowingDate: '2025-11-11',
    exposureStart: '2025-07-02',
    exposureEnd: '2025-08-13',
    sire: 'MACHINE',
    motheringQuality: 'excellent',
    demeanor: 'no complaints. Solid mother.',
    totalBorn: 7,
    deaths: 1,
    location: 'outside-pen',
    wentWell: 'no deaths after 24 hours',
    didntGoWell: '',
    defects: '1 newborn death - no defects',
  },
  {
    id: 'f3',
    sow: '2',
    group: '2',
    farrowingDate: '2025-11-04',
    exposureStart: '2025-07-02',
    exposureEnd: '2025-08-13',
    sire: 'MACHINE',
    motheringQuality: 'average',
    demeanor: 'Very very protective',
    totalBorn: 9,
    deaths: 4,
    location: 'outside-pen',
    wentWell: 'Very protective',
    didntGoWell:
      'Wish she picked hut with hay over bush nest. One piglet was killed during commotion with other moms when moved into different farrowing paddock.',
    defects:
      'One DOA, one thought a different mama was hers after 1 day and died, one was crushed after 2 days. Last one is only one you can really blame her for. One was killed about a week later when they were moved into other Paddock by other mom.',
  },
  {
    id: 'f4',
    sow: '13',
    group: '2',
    farrowingDate: '2025-10-29',
    exposureStart: '2025-07-02',
    exposureEnd: '2025-08-13',
    sire: 'MACHINE',
    motheringQuality: 'excellent',
    demeanor: 'Very protective',
    totalBorn: 7,
    deaths: 0,
    location: 'outside-pen',
    wentWell: 'All alive, very protective, made her own nest',
    didntGoWell: '0',
    defects: '0',
  },
  {
    id: 'f5',
    sow: '6',
    group: '1',
    farrowingDate: '2025-08-24',
    exposureStart: '2025-03-24',
    exposureEnd: '2025-05-05',
    sire: 'MACHINE',
    motheringQuality: 'average',
    demeanor: "Doesn't want you in the pen with her",
    totalBorn: 10,
    deaths: 2,
    location: 'inside-hut',
    wentWell: 'Hay bedding seemed an improvement on 0 bedding',
    didntGoWell: 'Silver dog panels are easy for them to move and escape. Also easy for piglets to escape with those',
    defects:
      "One has an extremely large growth on back leg, but currently still alive\n\nOne was crushed by mama\n\nOne was walking on wrists on both back legs, had no chance, couldn't stand after 2 days",
  },
  {
    id: 'f6',
    sow: '17',
    group: '1',
    farrowingDate: '2025-08-18',
    exposureStart: '2025-03-24',
    exposureEnd: '2025-05-05',
    sire: 'AO',
    motheringQuality: 'excellent',
    demeanor: 'Bit a piglet from #3 unprovoked a day before she gave birth',
    totalBorn: 9,
    deaths: 1,
    location: 'outside-pen',
    wentWell: 'High survival rate outside pen',
    didntGoWell: '',
    defects: '0\n\nAO father',
  },
  {
    id: 'f7',
    sow: '98',
    group: '1',
    farrowingDate: '2025-08-11',
    exposureStart: '2025-03-24',
    exposureEnd: '2025-05-05',
    sire: 'MACHINE',
    motheringQuality: 'average',
    demeanor: 'Friendly',
    totalBorn: 11,
    deaths: 7,
    location: 'inside-hut',
    wentWell: 'Put in pen just hours before birth',
    didntGoWell: 'She broke out twice, had to rebuild pen next to her as she was 40 yards away in morning',
    defects: '4 possible doa, 3 crushed after being alive',
  },
  {
    id: 'f8',
    sow: '3',
    group: '1',
    farrowingDate: '2025-08-11',
    exposureStart: '2025-03-24',
    exposureEnd: '2025-05-05',
    sire: 'AO',
    motheringQuality: '',
    demeanor: 'Friendly, no issues',
    totalBorn: 4,
    deaths: 1,
    location: '',
    wentWell: 'put into pen post birth to grow for a few days',
    didntGoWell: 'one piglet was bitten by another sow #17 unprovoked, he shook it off and is doing fine',
    defects: 'possible 1 DOA, small and never seen alive',
  },
  {
    id: 'f9',
    sow: '7',
    group: '1',
    farrowingDate: '2025-08-05',
    exposureStart: '2025-03-24',
    exposureEnd: '2025-05-05',
    sire: 'MACHINE',
    motheringQuality: 'average',
    demeanor: 'Friendly, no issues',
    totalBorn: 10,
    deaths: 4,
    location: 'outside-hut',
    wentWell: '',
    didntGoWell: '',
    defects: '',
  },
  {
    id: 'f10',
    sow: '9',
    group: '3',
    farrowingDate: '2025-07-17',
    exposureStart: '2025-03-24',
    exposureEnd: '2025-05-05',
    sire: 'AO',
    motheringQuality: 'poor',
    demeanor: '',
    totalBorn: 11,
    deaths: 11,
    location: 'outside-pen',
    wentWell: '',
    didntGoWell: 'Better shade paddocks when pregnant, or potentially no summer farrowing',
    defects: 'Premature. Most died immediately, oldest only lasted 2 days',
  },
  {
    id: 'f11',
    sow: '2',
    group: '2',
    farrowingDate: '2024-09-08',
    exposureStart: '',
    exposureEnd: '',
    sire: 'MACHINE',
    motheringQuality: 'average',
    demeanor: 'nightmare to get into farrowing pen',
    totalBorn: 7,
    deaths: 1,
    location: '',
    wentWell: '',
    didntGoWell: "one piglet was crushed by hay under waterer, probably wasn't packed down enough or too much was used",
    defects: '',
  },
  {
    id: 'f12',
    sow: '10',
    group: '2',
    farrowingDate: '2024-07-25',
    exposureStart: '',
    exposureEnd: '',
    sire: 'AO',
    motheringQuality: '',
    demeanor: '',
    totalBorn: 11,
    deaths: 1,
    location: '',
    wentWell: '',
    didntGoWell: '',
    defects: 'one crushed',
  },
  {
    id: 'f13',
    sow: '5',
    group: '2',
    farrowingDate: '2024-07-19',
    exposureStart: '',
    exposureEnd: '',
    sire: '',
    motheringQuality: '',
    demeanor: 'aggressive when getting into pen with her',
    totalBorn: 8,
    deaths: 1,
    location: 'outside-pen',
    wentWell: 'built pen around her after birth',
    didntGoWell: '',
    defects: '0, crushed piglet 3 days after birth',
  },
];

// ── Layer housing count helpers (top-level, no React state) ────────────────
// Model X: current_count is a *verified anchor* set by physical counts (manual
// or via daily report layer_count). Mortality reports do NOT mutate it.
// Projected count is computed at display time from anchor minus mortalities.

// Update housing anchor when a daily report includes a hen count.
// Sets current_count to the new value AND current_count_date to the report date.
// Phase 2.1 prep: setHousingAnchorFromReport + computeProjectedCount + computeLayerFeedCost moved to src/lib/layerHousing.js (imported at top of file).

// ── DATE HELPERS ───────────────────────────────────────────────────────────
// Phase 2.3 prep: date utils moved to src/lib/dateUtils.js.

// ── BUSINESS LOGIC ─────────────────────────────────────────────────────────

// calcTargetHatch + suggestHatchDates + overlaps() moved to lib/broiler.js.
// detectConflicts moved to lib/conflicts.js (imported above).

// ── EMPTY FORM ─────────────────────────────────────────────────────────────
const EMPTY_FORM = {
  name: '',
  breed: 'CC',
  hatchery: 'Meyer Hatchery',
  hatchDate: '',
  birdCount: 750,
  birdCountActual: '',
  brooder: '1',
  schooner: '2&3',
  processingDate: '',
  status: 'planned',
  notes: '',
  // Podio fields
  brooderIn: '',
  brooderOut: '',
  brooderFeedLbs: 0,
  schoonerFeedLbs: 0,
  gritLbs: 0,
  mortalityCumulative: 0,
  week4Lbs: 0,
  week6Lbs: 0,
  perLbStandardCost: 0,
  perLbStarterCost: 0,
  perLbGritCost: 0,
  chickCost: 0,
  totalToProcessor: 0,
  processingCost: 0,
  avgBreastLbs: 0,
  avgThighsLbs: 0,
  avgDressedLbs: 0,
  totalLbsWhole: 0,
  totalLbsCuts: 0,
  documents: [],
};

// ══════════════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════════════

// Shown when the user lands via a password reset / invite link. Supabase has
// already exchanged the recovery token for a session, but we hold them here
// to set their password before they reach the home screen. After update, we
// clear the recovery flag and they continue into the app already signed in.
// Phase 2.1.5: SetPasswordScreen moved to src/auth/SetPasswordScreen.jsx.

// Phase 2.1.5: LoginScreen moved to src/auth/LoginScreen.jsx.;

// Phase 2 Round 5 fix: S styles object moved to src/lib/styles.js.

// ── PERMISSION HELPERS ──────────────────────────────────────
function canEditDailys(role) {
  return ['farm_team', 'management', 'admin'].includes(role);
}
function canDeleteDailys(role) {
  return ['farm_team', 'management', 'admin'].includes(role);
}
function canEditAnything(role) {
  return ['management', 'admin'].includes(role);
}
function canDeleteAnything(role) {
  return role === 'admin';
}

// ── USERS MODAL ── (standalone component — must NOT be nested inside App)
// Phase 2 Round 3: UsersModal moved to C:\Users\Ronni\WCF-planner\src\auth\UsersModal.jsx.

// ── ADD FEED WEBFORM ──────────────────────────────────────────────────────────
// Public webform for quick feed logging. Inserts a new row into the appropriate
// *_dailys table with source='add_feed_webform'. No merge, no collision check.
// Admin-configurable: fields can be toggled on/off, marked required, relabeled.
// Supports Add Group (multiple batch+feed entries per submit).
// Phase 2 Round 5: AddFeedWebform moved to C:\Users\Ronni\WCF-planner\src\webforms\AddFeedWebform.jsx.

// writeBroilerBatchAvg moved to lib/broiler.js. Its two callers
// (WeighInsWebform + LivestockWeighInsView) now import it directly.

// ── WEIGH-INS WEBFORM ──────────────────────────────────────────────────────
// Public webform for weigh-in sessions. Three species flows:
//   - Cattle: session-based with autosave + diminishing tag dropdown + new-tag flag
//   - Pig: per-row weights for an active feeder batch (no tag); send-to-trip later
//   - Broiler: 4-week / 6-week weighings, ~15 birds, average auto-fills batch
// All entries persist to weigh_in_sessions + weigh_ins immediately. Phone drop
// recoverable: re-open the form, pick "Resume" on a draft session.
// Phase 2 Round 5: WeighInsWebform moved to C:\Users\Ronni\WCF-planner\src\webforms\WeighInsWebform.jsx.

// Phase 2 Round 5: WebformHub moved to C:\Users\Ronni\WCF-planner\src\webforms\WebformHub.jsx.

// Phase 2 Round 4: FeedCostsPanel moved to C:\Users\Ronni\WCF-planner\src\admin\FeedCostsPanel.jsx.

// ── FEED COST BY MONTH PANEL ────────────────────────────────────────────────
// Admin \u2192 Cost by Month. Aggregates feed spend across programs by month.
// Pig/Broiler/Layer multiply feed_lbs by the per-lb rates in FeedCostsPanel.
// Cattle multiplies each daily's feed-line qty by the matching feed-input
// cost_per_unit from the Livestock Feed Inputs panel.
// Current costs are used for all rows (no per-month historical cost ledger),
// so retroactive price changes affect historical totals.
// Phase 2 Round 4: FeedCostByMonthPanel moved to C:\Users\Ronni\WCF-planner\src\admin\FeedCostByMonthPanel.jsx.

// ── LIVESTOCK FEED INPUTS PANEL ─────────────────────────────────────────────
// Admin → Feed sub-section. Full feed master list with nutrition, costs, herd
// scoping. Reusable for cattle today, sheep later. Autosave on close.
// Test PDF upload + version history is built out separately (Phase 1 step 5).
// Phase 2 Round 4: LivestockFeedInputsPanel moved to C:\Users\Ronni\WCF-planner\src\admin\LivestockFeedInputsPanel.jsx.

// ── NUTRITION TARGETS PANEL ─────────────────────────────────────────────────
// Admin → Feed sub-section. Per-herd DM/CP/NFC target percentages used by the
// dashboard rolling-window comparison and the recommendation engine.
// Phase 2 Round 4: NutritionTargetsPanel moved to C:\Users\Ronni\WCF-planner\src\admin\NutritionTargetsPanel.jsx.

// Phase 2.1.2: DeleteModal moved to src/shared/DeleteModal.jsx.

function App() {
  // ── AUTH & LOADING STATE ──
  // Phase 2.0.1: these hooks live in AuthContext. See src/contexts/AuthContext.jsx
  // for the pwRecovery URL-hash initializer and other state defaults. Effects
  // (auth listener, visibility refresh, access-gate redirect), helpers
  // (loadUser, loadAllData, canAccessProgram), and derived values remain here.
  const {
    authState,
    setAuthState,
    pwRecovery,
    setPwRecovery,
    dataLoaded,
    setDataLoaded,
    saveStatus,
    setSaveStatus,
    showUsers,
    setShowUsers,
    allUsers,
    setAllUsers,
    inviteEmail,
    setInviteEmail,
    inviteRole,
    setInviteRole,
    inviteMsg,
    setInviteMsg,
  } = useAuth();

  // Phase 2.0.2: broiler batch + edit-form hooks live in BatchesContext.
  const {
    batches,
    setBatches,
    showForm,
    setShowForm,
    editId,
    setEditId,
    form,
    setForm,
    originalForm,
    setOriginalForm,
    conflicts,
    setConflicts,
    tooltip,
    setTooltip,
    override,
    setOverride,
    showLegacy,
    setShowLegacy,
    parsedProcessor,
    setParsedProcessor,
    docUploading,
    setDocUploading,
    deleteConfirm,
    setDeleteConfirm,
  } = useBatches();

  // Phase 2.0.3: pig-scoped hooks live in PigContext.
  const {
    pigData,
    setPigData,
    breedingCycles,
    setBreedingCycles,
    farrowingRecs,
    setFarrowingRecs,
    boarNames,
    setBoarNames,
    breedTlStart,
    setBreedTlStart,
    showBreedForm,
    setShowBreedForm,
    editBreedId,
    setEditBreedId,
    breedForm,
    setBreedForm,
    showFarrowForm,
    setShowFarrowForm,
    editFarrowId,
    setEditFarrowId,
    farrowForm,
    setFarrowForm,
    farrowFilter,
    setFarrowFilter,
    feederGroups,
    setFeederGroups,
    showFeederForm,
    setShowFeederForm,
    editFeederId,
    setEditFeederId,
    feederForm,
    setFeederForm,
    originalFeederForm,
    setOriginalFeederForm,
    activeTripBatchId,
    setActiveTripBatchId,
    tripForm,
    setTripForm,
    editTripId,
    setEditTripId,
    sowSearch,
    setSowSearch,
    expandedSow,
    setExpandedSow,
    archivedSows,
    setArchivedSows,
    breeders,
    setBreeders,
    breedOptions,
    setBreedOptions,
    originOptions,
    setOriginOptions,
    showBreederForm,
    setShowBreederForm,
    editBreederId,
    setEditBreederId,
    breederForm,
    setBreederForm,
  } = usePig();

  // Phase 2.0.4: layer-scoped hooks live in LayerContext.
  const {
    layerGroups,
    setLayerGroups,
    layerBatches,
    setLayerBatches,
    layerHousings,
    setLayerHousings,
    allLayerDailys,
    setAllLayerDailys,
    allEggDailys,
    setAllEggDailys,
    layerDashPeriod,
    setLayerDashPeriod,
    retHomeDashPeriod,
    setRetHomeDashPeriod,
  } = useLayer();

  // Phase 2.0.5: recent-window dailys arrays live in DailysRecentContext.
  const {
    broilerDailys,
    setBroilerDailys,
    pigDailys,
    setPigDailys,
    layerDailysRecent,
    setLayerDailysRecent,
    eggDailysRecent,
    setEggDailysRecent,
    cattleDailysRecent,
    setCattleDailysRecent,
    sheepDailysRecent,
    setSheepDailysRecent,
  } = useDailysRecent();

  // Phase 2.0.6 — small bundled contexts.
  const {cattleForHome, setCattleForHome, cattleOnFarmCount, setCattleOnFarmCount} = useCattleHome();
  const {sheepForHome, setSheepForHome} = useSheepHome();
  const {
    wfGroups,
    setWfGroups,
    wfRoster,
    setWfRoster,
    wfAvailability,
    setWfAvailability,
    wfTeamMembers,
    setWfTeamMembers,
    webformsConfig,
    setWebformsConfig,
  } = useWebformsConfig();
  const {feedCosts, setFeedCosts, broilerNotes, setBroilerNotes, missedCleared, setMissedCleared} = useFeedCosts();
  const {view, setView, pendingEdit, setPendingEdit, showAllComparison, setShowAllComparison, showMenu, setShowMenu} =
    useUI();

  // Permission helpers — role-based access
  // farm_team: edit+delete own dailys only
  // management: edit anything, delete dailys only
  // admin: full access
  const role = authState?.role;
  const isAdmin = role === 'admin';
  const isMgmt = role === 'management' || role === 'admin';
  const isFarmTeam = role === 'farm_team';
  const canEditAll = isMgmt; // management + admin can edit anything
  const canDeleteDailys = isMgmt || isFarmTeam; // all roles can delete dailys
  const canDeleteAll = isAdmin; // only admin can delete batches, groups, etc.

  // Phase 3.2: URL ↔ view adapter. The existing `view` state machine stays
  // the primary API — setView('X') still works from every component. These
  // effects mirror `view` into the URL and read URL → view on mount +
  // back/forward button. No changes required at any setView call site.
  //
  // Infinite-loop guard: syncingFromUrl flag distinguishes URL-driven view
  // changes (skip the view→URL effect) from code-driven view changes
  // (do push a URL entry so the back button works).
  const location = useLocation();
  const navigate = useNavigate();
  const syncingFromUrl = React.useRef(false);
  useEffect(() => {
    // 2026-05-06 alias resolution — legacy public paths redirect to canonical.
    // /webforms* → /dailys*, /fueling* → /equipment*, /equipment/fleet →
    // /fleet, /equipment/fuel-log → /fleet/fuel-log. Use react-router
    // navigate({replace:true}) so the address bar updates AND react-router's
    // own location state stays in sync (raw history.replaceState would skip
    // react-router and break popstate handling).
    const exactAlias = ALIASES_EXACT[location.pathname];
    if (exactAlias) {
      syncingFromUrl.current = true;
      navigate(exactAlias + location.search + location.hash, {replace: true});
      return;
    }
    let prefixAlias = null;
    for (const [oldPrefix, newPrefix] of ALIASES_PREFIX) {
      if (location.pathname.startsWith(oldPrefix)) {
        prefixAlias = newPrefix + location.pathname.slice(oldPrefix.length);
        break;
      }
    }
    if (prefixAlias) {
      syncingFromUrl.current = true;
      navigate(prefixAlias + location.search + location.hash, {replace: true});
      return;
    }

    // WebformHub owns its own sub-routing under /dailys/<form>. Treat any
    // such path as view='webformhub' so the browser back button can traverse
    // selector ↔ sub-form boundaries without the app snapping to home.
    //
    // EXCEPT for paths that have an explicit PATH_TO_VIEW entry — those
    // are dedicated top-level views that happen to live under /dailys/.
    // Currently: /dailys/tasks → 'tasksWebform' (C3). The exact-match
    // PATH_TO_VIEW lookup beats the generic subpath fallback so the
    // dedicated component mounts instead of WebformHub trying to render
    // it as an internal sub-form.
    const exactPathView = PATH_TO_VIEW[location.pathname];
    const isWebformSubpath = !exactPathView && location.pathname.startsWith('/dailys/');
    const isEquipmentSubpath =
      !exactPathView && (location.pathname.startsWith('/fleet/') || location.pathname === '/fleet');
    const isFuelingSubpath =
      !exactPathView && (location.pathname.startsWith('/equipment/') || location.pathname === '/equipment');
    const viewFromUrl = isWebformSubpath
      ? 'webformhub'
      : isEquipmentSubpath
        ? 'equipmentHome'
        : isFuelingSubpath
          ? 'fuelingHub'
          : exactPathView;
    if (viewFromUrl && viewFromUrl !== view) {
      syncingFromUrl.current = true;
      setView(viewFromUrl);
    } else if (!viewFromUrl) {
      // Unknown path — snap to home + replaceState so back button doesn't
      // revisit the dead URL. The hash-compat shim (Phase 3.3) handles
      // legacy /#weighins etc. before this effect sees the pathname.
      //
      // Preserve location.hash on the fallback: a URL like
      // /garbage#access_token=...&type=recovery would otherwise lose its
      // hash, breaking supabase's password-recovery flow. SetPasswordScreen
      // reads window.location.hash directly, so surviving to / with the
      // hash intact lets the recovery listener fire normally.
      syncingFromUrl.current = true;
      setView('home');
      navigate({pathname: '/', hash: location.hash}, {replace: true});
    }
  }, [location.pathname]);

  // Keep link[rel="manifest"] in sync with the active hub on SPA navigation.
  // The module-scope shim above sets the link before first paint; this
  // effect handles transitions between hubs without a full reload (e.g.
  // navigating from /dailys to /equipment via the Header buttons).
  useEffect(() => {
    applyManifestHref(location.pathname);
  }, [location.pathname]);

  useEffect(() => {
    if (syncingFromUrl.current) {
      syncingFromUrl.current = false;
      return;
    }
    // Don't clobber /dailys/<form> sub-paths — WebformHub owns them.
    if (view === 'webformhub' && location.pathname.startsWith('/dailys/')) return;
    // Don't clobber /fleet/<slug> sub-paths — EquipmentHome owns them.
    if (view === 'equipmentHome' && location.pathname.startsWith('/fleet/')) return;
    // Don't clobber /equipment/<slug> sub-paths — FuelingHub owns them.
    if (view === 'fuelingHub' && location.pathname.startsWith('/equipment/')) return;
    const pathFromView = VIEW_TO_PATH[view];
    if (pathFromView && pathFromView !== location.pathname) {
      navigate(pathFromView);
    }
  }, [view]);

  const autoSaveTimer = React.useRef(null);
  const pigAutoSaveTimer = React.useRef(null);
  const subAutoSaveTimer = React.useRef(null);
  const tripAutoSaveTimer = React.useRef(null);
  const breedAutoSaveTimer = React.useRef(null);
  const [leaderboardExpanded, setLeaderboardExpanded] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showArchBatches, setShowArchBatches] = useState(false);
  const [feedOrders, setFeedOrders] = useState({pig: {}, starter: {}, grower: {}, layerfeed: {}});
  const [pigFeedInventory, setPigFeedInventory] = useState(null); // {count, date} or null
  const [pigFeedExpandedMonths, setPigFeedExpandedMonths] = useState(new Set());
  const [poultryFeedInventory, setPoultryFeedInventory] = useState(null); // {starter:{count,date}, grower:{count,date}, layer:{count,date}}
  const [poultryFeedExpandedMonths, setPoultryFeedExpandedMonths] = useState(new Set());
  const [adminTab, setAdminTab] = useState('webforms'); // 'webforms' | 'feedcosts'
  // wfForm/wfSubmitting/wfDone/wfErr/wfGroupName moved into
  // src/webforms/PigDailysWebform.jsx as internal state — App no longer
  // needs them; they were only ever read by the extracted webform.
  const [wfView, setWfView] = useState('list'); // list | edit-webform | edit-field
  const [editWfId, setEditWfId] = useState(null);
  const [editFieldId, setEditFieldId] = useState(null);
  const [wfFieldForm, setWfFieldForm] = useState({label: '', type: 'text', required: false, options: []});
  const [newTeamMember, setNewTeamMember] = useState('');
  // Webforms admin state — must live at App top-level (React hooks rules)
  const [addingTo, setAddingTo] = useState(null);
  const [editFldLbl, setEditFldLbl] = useState(null);
  const [editFldVal, setEditFldVal] = useState('');
  const [editSecIdx, setEditSecIdx] = useState(null);
  const [editSecVal, setEditSecVal] = useState('');
  const [newOpt, setNewOpt] = useState('');
  const [showSubForm, setShowSubForm] = useState(null); // batchId or null
  const [subForm, setSubForm] = useState({name: '', giltCount: 0, boarCount: 0, originalPigCount: 0, notes: ''});
  const [editSubId, setEditSubId] = useState(null);
  const [collapsedBatches, setCollapsedBatches] = useState(new Set());
  const [collapsedMonths, setCollapsedMonths] = useState(() => {
    // Auto-collapse past months on init
    const s = new Set();
    const now = new Date();
    const thisYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    // We'll populate this in the feed view
    return s;
  });
  const [pigNotes, setPigNotes] = useState('');
  const [layerNotes, setLayerNotes] = useState('');
  const [dailysFilter, setDailysFilter] = useState({batchId: 'all', dateFrom: '', dateTo: ''});
  const [showDailyForm, setShowDailyForm] = useState(false);
  const [editDailyId, setEditDailyId] = useState(null);
  const EMPTY_DAILY = {
    date: '',
    teamMember: '',
    batchId: '',
    batchLabel: '',
    pigCount: '',
    feedLbs: '',
    groupMoved: true,
    nippleDrinkerMoved: true,
    nippleDrinkerWorking: true,
    troughsMoved: true,
    fenceWalked: true,
    fenceVoltage: '',
    issues: '',
  };
  const [dailyForm, setDailyForm] = useState(() => {
    const d = new Date();
    return {
      ...{
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        teamMember: '',
        batchId: '',
        batchLabel: '',
        pigCount: '',
        feedLbs: '',
        groupMoved: true,
        nippleDrinkerMoved: true,
        nippleDrinkerWorking: true,
        troughsMoved: true,
        fenceWalked: true,
        fenceVoltage: '',
        issues: '',
      },
    };
  });

  // ── AUTH LISTENER & DATA LOADING ──
  // Load webform config (anon, no auth needed) — team roster + active groups.
  // Reads canonical team_roster first; loadRoster falls back to legacy
  // team_members string[] when the canonical key is missing. setWfRoster
  // also updates the derived wfTeamMembers active-name list for back-compat
  // consumers (PigDailysWebform etc.) during the team-member cleanup.
  useEffect(() => {
    if (view !== 'webform' && view !== 'webformhub') return;
    Promise.all([
      loadRoster(sb),
      loadAvailability(sb),
      sb.from('webform_config').select('data').eq('key', 'active_groups').maybeSingle(),
    ]).then(([roster, availability, agRes]) => {
      if (Array.isArray(roster) && roster.length > 0) setWfRoster(roster);
      if (availability) setWfAvailability(availability);
      if (!agRes.error && Array.isArray(agRes.data?.data)) {
        const groups = agRes.data.data.map((name) => ({value: name, label: name}));
        setWfGroups(groups);
      }
    });
  }, [view]);

  // Load cattle count for Home page Animals on Farm tile
  useEffect(() => {
    if (!authState) return;
    sb.from('cattle')
      .select('*', {count: 'exact', head: true})
      .in('herd', ['mommas', 'backgrounders', 'finishers', 'bulls'])
      .then(({count}) => {
        if (count != null) setCattleOnFarmCount(count);
      })
      .catch(() => {});
  }, [authState]);

  // Load broiler dailys after auth is confirmed — same pattern as BroilerDailysView
  useEffect(() => {
    if (!authState) return;
    // Load all broiler dailys (paginated) for batch calculations
    (async () => {
      let all = [],
        from = 0;
      while (true) {
        const {data} = await sb
          .from('poultry_dailys')
          .select('*')
          .order('date', {ascending: false})
          .order('submitted_at', {ascending: false})
          .range(from, from + 999);
        if (!data || data.length === 0) break;
        all = [...all, ...data];
        if (data.length < 1000) break;
        from += 1000;
      }
      if (all.length > 0) setBroilerDailys(all);
    })();
    // Load layer + egg dailys (45 days) for home page & dashboard calculations
    const cutoff = toISO(addDays(new Date(), -45));
    sb.from('layer_dailys')
      .select('*')
      .gte('date', cutoff)
      .order('date', {ascending: false})
      .then(({data}) => {
        if (data) setLayerDailysRecent(data);
      });
    sb.from('egg_dailys')
      .select('*')
      .gte('date', cutoff)
      .order('date', {ascending: false})
      .then(({data}) => {
        if (data) setEggDailysRecent(data);
      });
    // Cattle + sheep dailys (last 14 days) — drives missed-report check + Last 5 Days tiles on home
    const cutoff14 = toISO(addDays(new Date(), -14));
    sb.from('cattle_dailys')
      .select('*')
      .gte('date', cutoff14)
      .order('date', {ascending: false})
      .then(({data}) => {
        if (data) setCattleDailysRecent(data);
      });
    sb.from('sheep_dailys')
      .select('*')
      .gte('date', cutoff14)
      .order('date', {ascending: false})
      .then(({data}) => {
        if (data) setSheepDailysRecent(data);
      });
    // Lightweight cattle + sheep directory (id + flock/herd only) for the missed-report active-flock check
    sb.from('cattle')
      .select('id,herd')
      .then(({data}) => {
        if (data) setCattleForHome(data);
      });
    sb.from('sheep')
      .select('id,flock')
      .then(({data}) => {
        if (data) setSheepForHome(data);
      });
    // Full paginated fetch for layer dashboard period comparisons
    (async () => {
      const fetchAll = async (table) => {
        const PAGE = 1000;
        let all = [],
          off = 0;
        while (true) {
          const {data} = await sb
            .from(table)
            .select('*')
            .order('date', {ascending: false})
            .range(off, off + PAGE - 1);
          if (!data || data.length === 0) break;
          all = all.concat(data);
          if (data.length < PAGE) break;
          off += PAGE;
        }
        return all;
      };
      const [ld, ed] = await Promise.all([fetchAll('layer_dailys'), fetchAll('egg_dailys')]);
      setAllLayerDailys(ld);
      setAllEggDailys(ed);
    })();
  }, [authState]);

  // refreshDailys('broiler' | 'layer' | 'egg' | 'pig' | 'all') — re-fetches the cached
  // App-level dailys arrays so dashboards reflect inline edits without sign-out/in.
  // Passed as a prop to all four DailysView components so their save() can call it.
  async function refreshDailys(kind) {
    const want = (k) => kind === 'all' || kind === k;
    if (want('broiler')) {
      let all = [],
        from = 0;
      while (true) {
        const {data} = await sb
          .from('poultry_dailys')
          .select('*')
          .order('date', {ascending: false})
          .order('submitted_at', {ascending: false})
          .range(from, from + 999);
        if (!data || data.length === 0) break;
        all = [...all, ...data];
        if (data.length < 1000) break;
        from += 1000;
      }
      setBroilerDailys(all);
    }
    const cutoff = toISO(addDays(new Date(), -45));
    if (want('layer')) {
      const {data} = await sb.from('layer_dailys').select('*').gte('date', cutoff).order('date', {ascending: false});
      if (data) setLayerDailysRecent(data);
      const fetchAll = async () => {
        const PAGE = 1000;
        let all = [],
          off = 0;
        while (true) {
          const {data} = await sb
            .from('layer_dailys')
            .select('*')
            .order('date', {ascending: false})
            .range(off, off + PAGE - 1);
          if (!data || data.length === 0) break;
          all = all.concat(data);
          if (data.length < PAGE) break;
          off += PAGE;
        }
        return all;
      };
      setAllLayerDailys(await fetchAll());
    }
    if (want('egg')) {
      const {data} = await sb.from('egg_dailys').select('*').gte('date', cutoff).order('date', {ascending: false});
      if (data) setEggDailysRecent(data);
      const fetchAll = async () => {
        const PAGE = 1000;
        let all = [],
          off = 0;
        while (true) {
          const {data} = await sb
            .from('egg_dailys')
            .select('*')
            .order('date', {ascending: false})
            .range(off, off + PAGE - 1);
          if (!data || data.length === 0) break;
          all = all.concat(data);
          if (data.length < PAGE) break;
          off += PAGE;
        }
        return all;
      };
      setAllEggDailys(await fetchAll());
    }
    if (want('pig')) {
      const {data} = await sb.from('pig_dailys').select('*').order('date', {ascending: false});
      if (data) setPigDailys(data);
    }
  }

  // Guard: unknown views fall back to home (must be unconditional)
  const VALID_VIEWS = [
    'home',
    'broilerHome',
    'pigsHome',
    'layersHome',
    'timeline',
    'list',
    'feed',
    'pigfeed',
    'pigs',
    'breeding',
    'pigbatches',
    'farrowing',
    'sows',
    'webforms',
    'adminTasks',
    'myTasks',
    'webformhub',
    'tasksWebform',
    'webform',
    'broilerdailys',
    'pigdailys',
    'layers',
    'layerbatches',
    'layerdailys',
    'eggdailys',
    'addfeed',
    'weighins',
    'cattleHome',
    'cattleherds',
    'cattledailys',
    'cattleweighins',
    'cattlebreeding',
    'cattleforecast',
    'cattlebatches',
    'broilerweighins',
    'pigweighins',
    'sheepHome',
    'sheepflocks',
    'sheepbatches',
    'sheepdailys',
    'sheepweighins',
    'equipmentHome',
    'fuelingHub',
    'fuelSupply',
  ];
  useEffect(() => {
    if (view && !VALID_VIEWS.includes(view)) setView('home');
  }, [view]);

  // Per-program access. profiles.program_access is null/empty = full access,
  // or a list like ['cattle','broiler']. Admins always bypass the check.
  // Maps every program-specific view to its program key. Views not in the
  // map (home, webforms, weighins, etc.) are always accessible.
  const VIEW_TO_PROGRAM = {
    broilerHome: 'broiler',
    timeline: 'broiler',
    list: 'broiler',
    feed: 'broiler',
    broilerdailys: 'broiler',
    broilerweighins: 'broiler',
    layersHome: 'layer',
    layerbatches: 'layer',
    layerdailys: 'layer',
    eggdailys: 'layer',
    layers: 'layer',
    pigsHome: 'pig',
    breeding: 'pig',
    farrowing: 'pig',
    sows: 'pig',
    pigbatches: 'pig',
    pigs: 'pig',
    pigfeed: 'pig',
    pigdailys: 'pig',
    pigweighins: 'pig',
    cattleHome: 'cattle',
    cattleherds: 'cattle',
    cattledailys: 'cattle',
    cattleweighins: 'cattle',
    cattlebreeding: 'cattle',
    cattleforecast: 'cattle',
    cattlebatches: 'cattle',
    sheepHome: 'sheep',
    sheepflocks: 'sheep',
    sheepbatches: 'sheep',
    sheepdailys: 'sheep',
    sheepweighins: 'sheep',
    equipmentHome: 'equipment',
  };
  function canAccessProgram(prog) {
    if (!prog) return true;
    if (!authState || authState === false || !authState.profile) return true;
    if (authState.role === 'admin') return true;
    const list = authState.profile.program_access;
    if (!Array.isArray(list) || list.length === 0) return true;
    return list.includes(prog);
  }
  // Redirect to home if user lands on a program view they don't have access to.
  useEffect(() => {
    const prog = VIEW_TO_PROGRAM[view];
    if (prog && !canAccessProgram(prog)) setView('home');
  }, [view, authState]);

  useEffect(() => {
    // Safety timeout — if auth hasn't resolved in 6s, show login
    const authTimeout = setTimeout(() => {
      setAuthState((prev) => (prev === null ? false : prev));
    }, 6000);

    // Use getUser() instead of getSession() to avoid storage lock issues
    sb.auth
      .getUser()
      .then(async ({data: {user}, error}) => {
        clearTimeout(authTimeout);
        if (user && !error) {
          await loadUser(user);
        } else {
          setAuthState(false);
        }
      })
      .catch(() => {
        clearTimeout(authTimeout);
        setAuthState(false);
      });

    const {
      data: {subscription},
    } = sb.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT') {
        setAuthState(false);
        setDataLoaded(false);
        setPwRecovery(false);
      }
      // Password-reset / invite link landed — hold the user on SetPasswordScreen
      // until they pick a password, then continue them into the app.
      if (event === 'PASSWORD_RECOVERY') {
        setPwRecovery(true);
      }
      // Handle SIGNED_IN only when on login screen (authState===false), not on page-load token refresh
      if (event === 'SIGNED_IN' && session?.user) {
        setAuthState((prev) => {
          if (prev === false) loadUser(session.user);
          return prev;
        });
      }
    });
    return () => {
      subscription.unsubscribe();
      clearTimeout(authTimeout);
    };
  }, []);

  // Refresh Supabase session when tab becomes visible (prevents stale session after backgrounding)
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === 'visible' && authState && authState.user) {
        sb.auth
          .getUser()
          .then(function (res) {
            if (res.error) {
              console.warn('Session expired, signing out');
              sb.auth.signOut();
            }
          })
          .catch(function () {});
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return function () {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [authState]);

  async function loadUser(user) {
    try {
      // Race the profile fetch against a 5s timeout
      const profilePromise = sb.from('profiles').select('*').eq('id', user.id).single();
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000));
      const {data: profile} = await Promise.race([profilePromise, timeoutPromise]).catch(() => ({data: null}));
      // DEV-only role override for Playwright role-tier coverage. The
      // production bundle tree-shakes this `import.meta.env.DEV` branch
      // entirely; no prod surface exists. Spec sets
      // localStorage.setItem('wcf-test-role-override', 'farm_team') before
      // navigation; the override applies for the rest of that page session.
      let resolvedRole = profile?.role || 'farm_team';
      if (import.meta.env.DEV) {
        try {
          const override = window.localStorage.getItem('wcf-test-role-override');
          if (override && ['admin', 'management', 'farm_team', 'inactive'].includes(override)) {
            resolvedRole = override;
          }
        } catch {
          /* localStorage may be unavailable in some sandboxes */
        }
      }
      setAuthState({user, role: resolvedRole, profile, name: profile?.full_name || user.email});
      await loadAllData();
    } catch (e) {
      console.error('loadUser error:', e);
      setAuthState({user, role: 'admin', name: user.email});
      setDataLoaded(true);
    }
  }

  async function loadAllData() {
    try {
      const {data, error} = await sb.from('app_store').select('*');
      if (!error && data) {
        const store = {};
        data.forEach((row) => (store[row.key] = row.data));
        if (store['ppp-v4']) {
          // Migrate: archived → processed, brooderIn=hatchDate → hatchDate+1, FR breed for B-24-02..B-25-01
          let changed = false;
          const frBatchNames = ['B-24-02', 'B-24-03', 'B-24-04', 'B-25-01'];
          const loadedFeedCosts = {starter: 0, grower: 0, layer: 0, pig: 0, grit: 0, ...store['ppp-feed-costs-v1']};
          const migrated = store['ppp-v4'].map((b) => {
            let nb = b;
            if (b.status === 'archived') {
              nb = {...nb, status: 'processed'};
              changed = true;
            }
            // Hotfix 2026-05-05: planned broiler batches become active on
            // hatch day without requiring an edit/save. Persist it so the
            // active-only public weigh-in mirror sees the batch too.
            if (shouldAutoActivateBroilerBatch(nb)) {
              nb = {...nb, status: 'active'};
              if (!nb.perLbStarterCost || !nb.perLbStandardCost) {
                nb.perLbStarterCost = loadedFeedCosts.starter || 0;
                nb.perLbStandardCost = loadedFeedCosts.grower || 0;
                nb.perLbGritCost = loadedFeedCosts.grit || 0;
              }
              changed = true;
            }
            // Fix brooderIn if it equals hatchDate (was same-day, should be +1)
            if (b.status !== 'processed' && b.hatchDate && b.brooderIn === b.hatchDate) {
              try {
                const newBrooderIn = toISO(addDays(new Date(b.hatchDate + 'T12:00:00'), 1));
                nb = {...nb, brooderIn: newBrooderIn};
                changed = true;
              } catch (_e) {
                /* defensive parse on legacy hatchDate */
              }
            }
            // Hard-code Freedom Ranger breed/hatchery for legacy B-24-02..B-25-01 batches
            const nameUpper = String(nb.name || '').toUpperCase();
            if (frBatchNames.includes(nameUpper)) {
              if (nb.breed !== 'FR') {
                nb = {...nb, breed: 'FR'};
                changed = true;
              }
              if (nb.hatchery !== 'Freedom Ranger Hatchery') {
                nb = {...nb, hatchery: 'Freedom Ranger Hatchery'};
                changed = true;
              }
            }
            // Hard-code legacy hatchery names for two early-2025 batches
            // (Ronnie ran these from non-standard hatcheries before the
            // dropdown was canonicalized).
            if (nameUpper === 'B-25-02' && nb.hatchery !== 'VALLEY FARMS') {
              nb = {...nb, hatchery: 'VALLEY FARMS'};
              changed = true;
            }
            if (nameUpper === 'B-25-03' && nb.hatchery !== 'CREDO FARMS') {
              nb = {...nb, hatchery: 'CREDO FARMS'};
              changed = true;
            }
            return nb;
          });
          store['ppp-v4'] = migrated;
          setBatches(migrated);
          if (changed) {
            sb.from('app_store')
              .upsert({key: 'ppp-v4', data: migrated}, {onConflict: 'key'})
              .then(() => {});
          }
        }
        if (store['ppp-pigs-v1']) setPigData(store['ppp-pigs-v1']);
        if (store['ppp-breeding-v1']) setBreedingCycles(store['ppp-breeding-v1']);
        if (store['ppp-farrowing-v1']) setFarrowingRecs(store['ppp-farrowing-v1'] || INITIAL_FARROWING);
        if (store['ppp-boars-v1']) setBoarNames(store['ppp-boars-v1']);
        if (store['ppp-feeders-v1']) {
          // Reconcile sub-batch counts against parent. Repairs data left in
          // an inconsistent state by the old (now-removed) Transfer-to-
          // Breeding mutation path. Persists once if anything changed.
          const fr = reconcileFeederGroupsFromBreeders(store['ppp-feeders-v1']);
          setFeederGroups(fr.groups);
          if (fr.changed)
            sb.from('app_store')
              .upsert({key: 'ppp-feeders-v1', data: fr.groups}, {onConflict: 'key'})
              .then(() => {});
        }
        if (store['ppp-feed-costs-v1'])
          setFeedCosts({starter: 0, grower: 0, layer: 0, pig: 0, grit: 0, ...store['ppp-feed-costs-v1']});
        if (store['ppp-archived-sows-v1']) setArchivedSows(store['ppp-archived-sows-v1'] || []);
        if (store['ppp-breeders-v1'])
          setBreeders(store['ppp-breeders-v1'].length > 0 ? store['ppp-breeders-v1'] : INITIAL_BREEDERS);
        else setBreeders(INITIAL_BREEDERS);
        if (store['ppp-breed-options-v1']) setBreedOptions(store['ppp-breed-options-v1']);
        if (store['ppp-origin-options-v1']) setOriginOptions(store['ppp-origin-options-v1']);
        if (store['ppp-pigs-v1']) setPigData(store['ppp-pigs-v1']);
        if (store['ppp-webforms-v1']) {
          // Inject Add Feed webform entry if not already present
          var wfCfg = store['ppp-webforms-v1'];
          if (
            !(wfCfg.webforms || []).find(function (w) {
              return w.id === 'add-feed-webform';
            })
          ) {
            wfCfg = {
              ...wfCfg,
              webforms: [
                ...(wfCfg.webforms || []),
                {
                  id: 'add-feed-webform',
                  teamMembers: [],
                  name: 'Add Feed Webform',
                  description: 'Quick feed logging for pig, broiler, and layer programs',
                  table: 'multiple',
                  allowAddGroup: false,
                  sections: [
                    {
                      id: 's-info',
                      title: 'Report Info',
                      system: true,
                      fields: [
                        {id: 'date', label: 'Date', type: 'date', required: true, system: true, enabled: true},
                        {
                          id: 'team_member',
                          label: 'Team Member',
                          type: 'team_picker',
                          required: false,
                          system: false,
                          enabled: true,
                        },
                      ],
                    },
                    {
                      id: 's-feed',
                      title: 'Feed',
                      system: false,
                      fields: [
                        {
                          id: 'batch_label',
                          label: 'Batch / Group',
                          type: 'group_picker',
                          required: true,
                          system: true,
                          enabled: true,
                        },
                        {
                          id: 'feed_type',
                          label: 'Feed Type',
                          type: 'button_toggle',
                          options: ['STARTER', 'GROWER', 'LAYER'],
                          required: true,
                          system: false,
                          enabled: true,
                        },
                        {
                          id: 'feed_lbs',
                          label: 'Feed (lbs)',
                          type: 'number',
                          required: true,
                          system: false,
                          enabled: true,
                        },
                      ],
                    },
                  ],
                },
              ],
            };
          }
          // Inject Cattle Daily webform entry if not already present (config may pre-date the cattle module)
          if (
            !(wfCfg.webforms || []).find(function (w) {
              return w.id === 'cattle-dailys';
            })
          ) {
            wfCfg = {
              ...wfCfg,
              webforms: [
                ...(wfCfg.webforms || []),
                {
                  id: 'cattle-dailys',
                  teamMembers: [],
                  name: 'Cattle Daily Report',
                  description: 'Daily care report for cattle herds',
                  table: 'cattle_dailys',
                  allowAddGroup: false,
                  sections: [
                    {
                      id: 's-info',
                      title: 'Report Info',
                      system: true,
                      fields: [
                        {id: 'date', label: 'Date', type: 'date', required: true, system: true, enabled: true},
                        {
                          id: 'team_member',
                          label: 'Team Member',
                          type: 'team_picker',
                          required: true,
                          system: true,
                          enabled: true,
                        },
                      ],
                    },
                    {
                      id: 's-herd',
                      title: 'Cattle Herd',
                      system: true,
                      fields: [
                        {
                          id: 'herd',
                          label: 'Herd (mommas/backgrounders/finishers/bulls)',
                          type: 'herd_picker',
                          required: true,
                          system: true,
                          enabled: true,
                        },
                      ],
                    },
                    {
                      id: 's-feeds',
                      title: 'Feeds & Minerals',
                      system: true,
                      fields: [
                        {
                          id: 'feeds',
                          label: 'Feeds (multi-line, with creep toggle)',
                          type: 'feed_lines',
                          required: false,
                          system: true,
                          enabled: true,
                        },
                        {
                          id: 'minerals',
                          label: 'Minerals (multi-line)',
                          type: 'mineral_lines',
                          required: false,
                          system: true,
                          enabled: true,
                        },
                      ],
                    },
                    {
                      id: 's-checks',
                      title: 'Daily Checks',
                      system: false,
                      fields: [
                        {
                          id: 'fence_voltage',
                          label: 'Fence voltage (kV)',
                          type: 'number',
                          required: false,
                          system: false,
                          enabled: true,
                        },
                        {
                          id: 'water_checked',
                          label: 'Water source checked?',
                          type: 'yes_no',
                          required: false,
                          system: false,
                          enabled: true,
                        },
                      ],
                    },
                    {
                      id: 's-comments',
                      title: 'Comments',
                      system: false,
                      fields: [
                        {
                          id: 'issues',
                          label: 'Comments / Issues',
                          type: 'textarea',
                          required: false,
                          system: false,
                          enabled: true,
                        },
                      ],
                    },
                  ],
                },
              ],
            };
          }
          // Inject Sheep Daily webform entry if not already present (config may pre-date the sheep module)
          if (
            !(wfCfg.webforms || []).find(function (w) {
              return w.id === 'sheep-dailys';
            })
          ) {
            wfCfg = {
              ...wfCfg,
              webforms: [
                ...(wfCfg.webforms || []),
                {
                  id: 'sheep-dailys',
                  teamMembers: [],
                  name: 'Sheep Daily Report',
                  description: 'Daily care report for sheep flocks',
                  table: 'sheep_dailys',
                  allowAddGroup: false,
                  sections: [
                    {
                      id: 's-info',
                      title: 'Report Info',
                      system: true,
                      fields: [
                        {id: 'date', label: 'Date', type: 'date', required: true, system: true, enabled: true},
                        {
                          id: 'team_member',
                          label: 'Team Member',
                          type: 'team_picker',
                          required: true,
                          system: true,
                          enabled: true,
                        },
                      ],
                    },
                    {
                      id: 's-flock',
                      title: 'Sheep Flock',
                      system: true,
                      fields: [
                        {
                          id: 'flock',
                          label: 'Flock (rams/ewes/feeders)',
                          type: 'flock_picker',
                          required: true,
                          system: true,
                          enabled: true,
                        },
                      ],
                    },
                    {
                      id: 's-feeds',
                      title: 'Feeds & Minerals',
                      system: true,
                      fields: [
                        {
                          id: 'feeds',
                          label: 'Feeds (multi-line)',
                          type: 'feed_lines',
                          required: false,
                          system: true,
                          enabled: true,
                        },
                        {
                          id: 'minerals',
                          label: 'Minerals (multi-line, with % eaten)',
                          type: 'mineral_lines',
                          required: false,
                          system: true,
                          enabled: true,
                        },
                      ],
                    },
                    {
                      id: 's-checks',
                      title: 'Daily Checks',
                      system: false,
                      fields: [
                        {
                          id: 'fence_voltage_kv',
                          label: 'Fence Voltage (kV)',
                          type: 'number',
                          required: false,
                          system: false,
                          enabled: true,
                        },
                        {
                          id: 'waterers_working',
                          label: 'Waterers working?',
                          type: 'yes_no',
                          required: false,
                          system: false,
                          enabled: true,
                        },
                      ],
                    },
                    {
                      id: 's-mortality',
                      title: 'Mortality',
                      system: false,
                      fields: [
                        {
                          id: 'mortality_count',
                          label: 'Mortality count',
                          type: 'number',
                          required: false,
                          system: false,
                          enabled: true,
                        },
                      ],
                    },
                    {
                      id: 's-comments',
                      title: 'Comments',
                      system: false,
                      fields: [
                        {
                          id: 'comments',
                          label: 'Comments / Issues',
                          type: 'textarea',
                          required: false,
                          system: false,
                          enabled: true,
                        },
                      ],
                    },
                  ],
                },
              ],
            };
          }
          // Inject Weigh-Ins webform entry if not already present (config pre-dates
          // per-species team-member lists). Shape-only entry: no sections — the
          // admin editor surfaces a custom per-species editor instead.
          if (
            !(wfCfg.webforms || []).find(function (w) {
              return w.id === 'weighins-webform';
            })
          ) {
            wfCfg = {
              ...wfCfg,
              webforms: [
                ...(wfCfg.webforms || []),
                {
                  id: 'weighins-webform',
                  name: 'Weigh-Ins',
                  description: 'Per-species weigh-in sessions (Cattle / Sheep / Pig / Broiler)',
                  table: 'weigh_ins',
                  allowAddGroup: false,
                  teamMembers: [],
                  sections: [],
                },
              ],
            };
          }
          // Per-species team-member back-fill (`teamMembersBySpecies`) was
          // retired 2026-04-29 with the team-member master list cleanup.
          // Existing configs may still carry the field; it's ignored at
          // runtime — WeighInsWebform reads the master roster directly.
          // Cattle-only: strip s-mortality section from any previously-saved config
          // (mortality is handled via the cow record now, not the webform).
          wfCfg = {
            ...wfCfg,
            webforms: (wfCfg.webforms || []).map(function (w) {
              if (w.id !== 'cattle-dailys') return w;
              return {
                ...w,
                sections: (w.sections || []).filter(function (s) {
                  return s.id !== 's-mortality';
                }),
              };
            }),
          };
          setWebformsConfig(wfCfg);
          // Roster — canonical team_roster (legacy team_members fallback inside
          // loadRoster). Sets both wfRoster and the derived wfTeamMembers
          // active-name list. Roster is the source of truth for logged-in
          // admin views; the per-webform `teamMembers` field on each form
          // is no longer the source we read.
          loadRoster(sb).then((roster) => {
            if (Array.isArray(roster) && roster.length > 0) setWfRoster(roster);
          });
          loadAvailability(sb).then((availability) => {
            if (availability) setWfAvailability(availability);
          });
        }
        if (store['ppp-layer-groups-v1']) setLayerGroups(store['ppp-layer-groups-v1']);
        if (store['ppp-missed-cleared-v1']) setMissedCleared(new Set(store['ppp-missed-cleared-v1'] || []));
        if (store['ppp-feed-orders-v1']) setFeedOrders(store['ppp-feed-orders-v1']);
        if (store['ppp-pig-feed-inventory-v1']) setPigFeedInventory(store['ppp-pig-feed-inventory-v1']);
        if (store['ppp-poultry-feed-inventory-v1']) setPoultryFeedInventory(store['ppp-poultry-feed-inventory-v1']);
        if (store['ppp-broiler-notes-v1']) setBroilerNotes(store['ppp-broiler-notes-v1'] || '');
        if (store['ppp-pig-notes-v1']) setPigNotes(store['ppp-pig-notes-v1'] || '');
        if (store['ppp-layer-notes-v1']) setLayerNotes(store['ppp-layer-notes-v1'] || '');
        // Load layer batches and housings from dedicated tables, THEN sync webform config
        var lbPromise = sb.from('layer_batches').select('*').order('name');
        var lhPromise = sb.from('layer_housings').select('*').order('start_date');
        Promise.all([lbPromise, lhPromise]).then(function (results) {
          var lbData = results[0].data || [];
          var lhData2 = results[1].data || [];
          setLayerBatches(lbData);
          setLayerHousings(lhData2);
          // Now sync webform config with actual layer data available
          syncWebformConfig(
            store['ppp-webforms-v1'] || null,
            store['ppp-feeders-v1'] || null,
            store['ppp-v4'] || [],
            store['ppp-layer-groups-v1'] || [],
            lhData2,
          );
        });
        // Sync broiler groups + per-batch schooner metadata to webform_config
        // for anon webform access. Both keys are derived from the same filtered
        // list (status === 'active') via buildBroilerPublicMirror so they
        // cannot drift. The public broiler weigh-in form reads
        // broiler_batch_meta to build column labels — anon never reads
        // app_store directly. See src/lib/broilerBatchMeta.js.
        {
          const {groups: bGroups, meta: bMeta} = buildBroilerPublicMirror(store['ppp-v4'] || []);
          Promise.all([
            sb.from('webform_config').upsert({key: 'broiler_groups', data: bGroups}, {onConflict: 'key'}),
            sb.from('webform_config').upsert({key: 'broiler_batch_meta', data: bMeta}, {onConflict: 'key'}),
          ]).then(() => {});
        }
      } else if (!error) {
        // No data yet - init farrowing with historical records
        setFarrowingRecs(INITIAL_FARROWING);
      }
      // Load pig_dailys (paginated) and poultry_dailys in parallel. Both previously
      // ran serially, blocking the app on every cold start — see PROJECT.md §14.5 #3.
      const pigDailysPromise = (async () => {
        let allDailys = [];
        let from = 0;
        const pageSize = 1000;
        while (true) {
          const {data: page, error: pageErr} = await sb
            .from('pig_dailys')
            .select('*')
            .order('date', {ascending: false})
            .range(from, from + pageSize - 1);
          if (pageErr || !page || page.length === 0) break;
          allDailys = [...allDailys, ...page];
          if (page.length < pageSize) break;
          from += pageSize;
        }
        return allDailys;
      })().catch((e) => {
        console.warn('pig_dailys load error:', e.message);
        return [];
      });
      const poultryDailysPromise = sb
        .from('poultry_dailys')
        .select('*')
        .order('date', {ascending: false})
        .order('submitted_at', {ascending: false})
        .limit(2000)
        .then(({data, error}) => {
          if (error) {
            console.warn('poultry_dailys load error:', error.message);
            return [];
          }
          return data || [];
        })
        .catch((e) => {
          console.warn('poultry_dailys load error:', e.message);
          return [];
        });
      const [pigDailysRows, poultryDailysRows] = await Promise.all([pigDailysPromise, poultryDailysPromise]);
      if (pigDailysRows) setPigDailys(pigDailysRows);
      setBroilerDailys(poultryDailysRows);
      const labels = [...new Set(poultryDailysRows.map((d) => d.batch_label).filter(Boolean))].sort();
      console.log(`[WCF] broilerDailys: ${poultryDailysRows.length} records, labels:`, labels);
      setDataLoaded(true);
    } catch (e) {
      console.error('loadAllData error:', e);
      setDataLoaded(true);
    }
  }

  async function loadUsers() {
    const {data, error} = await sb.from('profiles').select('*').order('created_at');
    if (data) setAllUsers(data);
    else if (error) console.error('loadUsers error:', error);
  }

  async function saveFeedCosts(costs) {
    setFeedCosts(costs);
    await sbSave('ppp-feed-costs-v1', costs);
    // Update only ACTIVE broiler batches with new costs.
    // - Planned: stay blank until status flips to active (handled in upd() / status change path)
    // - Processed: never touched (preserves historical rates at time of processing)
    const activeBroiler = batches.filter((b) => b.status === 'active');
    if (activeBroiler.length > 0) {
      const updated = batches.map((b) => {
        if (b.status !== 'active') return b;
        return {...b, perLbStarterCost: costs.starter, perLbStandardCost: costs.grower, perLbGritCost: costs.grit || 0};
      });
      setBatches(updated);
      sbSave('ppp-v4', updated);
    }
    // Update active pig batches
    const activeF = feederGroups.filter((g) => g.status === 'active');
    if (activeF.length > 0) {
      const updatedF = feederGroups.map((g) => (g.status !== 'active' ? g : {...g, perLbFeedCost: costs.pig}));
      setFeederGroups(updatedF);
      sbSave('ppp-feeders-v1', updatedF);
    }
    // Update active layer groups (legacy old system)
    const activeLG = layerGroups.filter((g) => g.status === 'active');
    if (activeLG.length > 0) {
      const updatedLG = layerGroups.map((g) => (g.status !== 'active' ? g : {...g, perLbFeedCost: costs.layer}));
      persistLayerGroups(updatedLG);
    }
    // Update active layer batches (new system) — push 3 frozen rates
    // Skip the Retirement Home pseudo-batch
    const activeLBs = (layerBatches || []).filter((b) => b.status === 'active');
    if (activeLBs.length > 0) {
      const updatedLB = await Promise.all(
        activeLBs.map(async (b) => {
          const upd = {
            per_lb_starter_cost: costs.starter,
            per_lb_grower_cost: costs.grower,
            per_lb_layer_cost: costs.layer,
          };
          await sb.from('layer_batches').update(upd).eq('id', b.id);
          return {...b, ...upd};
        }),
      );
      // Merge updates back into local state
      setLayerBatches((prev) =>
        prev.map((b) => {
          const u = updatedLB.find((x) => x.id === b.id);
          return u ? u : b;
        }),
      );
    }
  }

  async function sbSave(key, value) {
    setSaveStatus('saving');
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const savePromise = sb
          .from('app_store')
          .upsert({key, data: value, updated_at: new Date().toISOString()}, {onConflict: 'key'});
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000));
        const {error} = await Promise.race([savePromise, timeoutPromise]);
        if (error) throw error;
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus(''), 2500);
        return; // success
      } catch (e) {
        lastError = e;
        console.warn(`sbSave attempt ${attempt} failed for key ${key}:`, e.message);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt)); // wait before retry
      }
    }
    // All 3 attempts failed
    console.error('sbSave failed after 3 attempts:', lastError);
    setSaveStatus('error');
    setTimeout(() => setSaveStatus(''), 4000);
  }

  async function signOut() {
    await sb.auth.signOut();
  }

  function persist(nb) {
    sbSave('ppp-v4', nb);
  }
  function persistBreeding(nb) {
    sbSave('ppp-breeding-v1', nb);
  }
  function persistFarrowing(nb) {
    sbSave('ppp-farrowing-v1', nb);
  }
  function persistBoars(nb) {
    sbSave('ppp-boars-v1', nb);
  }
  function persistFeeders(nb) {
    setFeederGroups(nb);
    sbSave('ppp-feeders-v1', nb);
    syncWebformConfig(null, nb, batches, layerGroups, layerHousings);
  }
  function persistLayerGroups(nb) {
    setLayerGroups(nb);
    sbSave('ppp-layer-groups-v1', nb);
    // Sync active layer group names to webform_config for anon access
    const activeNames = nb.filter((g) => g.status === 'active').map((g) => g.name);
    sb.from('webform_config')
      .upsert({key: 'layer_groups', value: {groups: activeNames}}, {onConflict: 'key'})
      .then(() => {});
    syncWebformConfig(null, null, batches, nb, layerHousings);
  }
  function persistLayerHousings(nb) {
    // When housings change, re-sync webform so batch name vs housing name logic updates
    setLayerHousings(nb);
    syncWebformConfig(null, null, batches, layerGroups, nb);
  }
  function persistWebforms(nb) {
    setWebformsConfig(nb);
    sbSave('ppp-webforms-v1', nb);
    syncWebformConfig(nb, null, batches, layerGroups, layerHousings);
    // Sync allowAddGroup to webform_settings key for anon access
    const allowAddGroup = {};
    (nb.webforms || []).forEach((wf) => {
      allowAddGroup[wf.id] = !!wf.allowAddGroup;
    });
    sb.from('webform_config')
      .upsert({key: 'webform_settings', data: {allowAddGroup}}, {onConflict: 'key'})
      .then(() => {});
  }
  function persistFeedersAndSync(nb) {
    setFeederGroups(nb);
    sbSave('ppp-feeders-v1', nb);
    // Sync active groups to webform_config for anon access
    syncWebformConfig(null, null, batches, nb, layerHousings);
  }
  async function syncWebformConfig(wfConfig, feeders, batchData, lgData, lhData) {
    try {
      // Normalize: strip s-mortality from the cattle webform before sync.
      // Mortality is handled via the cow record, not the daily webform.
      function normalizeWebforms(webforms) {
        return (webforms || []).map(function (w) {
          if (w.id !== 'cattle-dailys') return w;
          return {
            ...w,
            sections: (w.sections || []).filter(function (s) {
              return s.id !== 's-mortality';
            }),
          };
        });
      }
      const rawCfg = wfConfig || webformsConfig;
      const cfg = {...rawCfg, webforms: normalizeWebforms(rawCfg.webforms)};
      const fgs = feeders || feederGroups;
      const pigGroups = [
        'SOWS',
        'BOARS',
        ...fgs.flatMap((g) =>
          g.subBatches && g.subBatches.length > 0
            ? g.subBatches.filter((s) => s.status === 'active').map((s) => s.name)
            : g.status === 'active'
              ? [g.batchName]
              : [],
        ),
      ];
      // Team-member master roster lives in webform_config.team_roster
      // (canonical) + webform_config.team_members (legacy active-name
      // mirror). saveRoster on the central admin editor writes both. This
      // syncWebformConfig path no longer touches either — it neither
      // derives a union from per-webform `teamMembers` nor writes the
      // legacy mirror, so admin saves elsewhere don't churn the roster.
      //
      // Retired alongside:
      //   - per_form_team_members  (per-form filtering eliminated)
      //   - weighins_team_members  (per-species filtering eliminated;
      //                             every active member selectable for
      //                             every species)
      // Use explicit batchData param to avoid stale closure — batches state may not be set yet
      const batchList = batchData || batches || [];
      // Public broiler mirror — single source of truth for the dropdown list AND
      // per-batch schooner column labels read by the public weigh-in form. Same
      // filter (status === 'active') applied by buildBroilerPublicMirror so
      // groups + meta cannot drift.
      const {groups: broilerGroupList, meta: broilerBatchMeta} = buildBroilerPublicMirror(batchList);
      // Use explicit lgData param to avoid stale closure
      const lgList = lgData || layerGroups || [];
      // Layer batch names only appear on webform when the batch has NO active housings yet
      // (i.e. still in brooder/schooner phase). Once housings are active, the housing
      // names (already in lgList as layer groups) are the correct webform options.
      const activeLbNames = (layerBatches || [])
        .filter((b) => {
          if (b.status !== 'active' || b.name === 'Retirement Home') return false;
          const housings = lhData || layerHousings || [];
          const hasActiveHousing = housings.some((h) => h.batch_id === b.id && h.status === 'active');
          return !hasActiveHousing;
        })
        .map((b) => ({id: b.id, name: b.name, status: 'active'}));
      const lgListWithBatches = [...lgList, ...activeLbNames.filter((lb) => !lgList.find((g) => g.name === lb.name))];
      // allowAddGroup per form
      const allowAddGroup = {};
      (cfg.webforms || []).forEach((wf) => {
        allowAddGroup[wf.id] = !!wf.allowAddGroup;
      });
      await Promise.all([
        sb.from('webform_config').upsert({key: 'active_groups', data: pigGroups}, {onConflict: 'key'}),
        sb.from('webform_config').upsert({key: 'broiler_groups', data: broilerGroupList}, {onConflict: 'key'}),
        sb.from('webform_config').upsert({key: 'broiler_batch_meta', data: broilerBatchMeta}, {onConflict: 'key'}),
        sb.from('webform_config').upsert({key: 'webform_settings', data: {allowAddGroup}}, {onConflict: 'key'}),
        // Push housing→batch mapping for webform info display
        sb.from('webform_config').upsert(
          {
            key: 'housing_batch_map',
            data: Object.fromEntries(
              (lhData || layerHousings || [])
                .filter((h) => h.status === 'active')
                .map((h) => {
                  const b = (layerBatches || []).find((lb) => lb.id === h.batch_id);
                  return [h.housing_name, b ? b.name : null];
                })
                .filter(([, v]) => v),
            ),
          },
          {onConflict: 'key'},
        ),
        // Push full form config for anon access — include layer batch names as selectable groups
        sb.from('webform_config').upsert(
          {
            key: 'full_config',
            data: {
              webforms: cfg.webforms,
              teamMembers: cfg.teamMembers,
              broilerGroups: broilerGroupList,
              layerGroups: lgListWithBatches,
            },
          },
          {onConflict: 'key'},
        ),
      ]);
    } catch (e) {
      console.warn('syncWebformConfig error:', e.message);
    }
  }

  async function persistDaily(record) {
    try {
      await sb.from('pig_dailys').upsert(record, {onConflict: 'id'});
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(''), 2500);
    } catch (e) {
      console.error('persistDaily error:', e);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus(''), 4000);
    }
  }
  async function deleteDaily(id) {
    try {
      await sb.from('pig_dailys').delete().eq('id', id);
      setPigDailys((prev) => prev.filter((d) => d.id !== id));
    } catch (e) {
      alert('Could not delete record: ' + e.message);
    }
  }
  function persistArchived(nb) {
    sbSave('ppp-archived-sows-v1', nb);
  }
  function persistBreeders(nb) {
    sbSave('ppp-breeders-v1', nb);
  }
  function persistBreedOptions(nb) {
    sbSave('ppp-breed-options-v1', nb);
  }
  function persistOriginOptions(nb) {
    sbSave('ppp-origin-options-v1', nb);
  }
  function persistPigData(nb) {
    sbSave('ppp-pigs-v1', nb);
  }

  // Form field update
  function upd(k, v) {
    const f = {...form, [k]: v};
    if (k === 'breed') {
      // Hatchery is decoupled from breed — any hatchery can supply any breed now.
      // (Previously locked WR to Freedom Ranger Hatchery; that's no longer enforced.)
    }
    if (k === 'schooner') f.birdCount = v === '1' ? 650 : 750;
    // When hatchDate changes, default brooderIn to hatchDate + 1 if blank OR if brooderIn matches hatchDate
    // (i.e., was previously auto-filled as same day). User can still manually override.
    if (k === 'hatchDate' && v) {
      try {
        if (!f.brooderIn || f.brooderIn === '' || f.brooderIn === form.hatchDate || f.brooderIn === v) {
          f.brooderIn = toISO(addDays(new Date(v + 'T12:00:00'), 1));
        }
      } catch (e) {
        /* ignore parse errors */
      }
    }
    setForm(f);
    try {
      setConflicts(detectConflicts(f, batches, layerBatches, editId));
    } catch (e) {
      console.warn('detectConflicts failed on field change:', e);
      setConflicts([]);
    }
    setOverride(false);
    // Debounced auto-save: 1.5s after last keystroke
    if (editId) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = setTimeout(() => {
        const tl = calcTimeline(f.hatchDate, f.breed, f.processingDate);
        // Parse numeric form fields back to numbers before persisting (form state holds raw strings during typing)
        const numFields = [
          'birdCount',
          'birdCountActual',
          'brooderFeedLbs',
          'schoonerFeedLbs',
          'gritLbs',
          'mortalityCumulative',
          'week4Lbs',
          'week6Lbs',
          'perLbStandardCost',
          'perLbStarterCost',
          'perLbGritCost',
          'totalToProcessor',
          'processingCost',
          'avgBreastLbs',
          'avgThighsLbs',
          'avgDressedLbs',
          'totalLbsWhole',
          'totalLbsCuts',
        ];
        const fNum = {...f};
        for (const k of numFields) {
          const v = fNum[k];
          fNum[k] = v === '' || v == null ? 0 : parseFloat(v) || 0;
        }
        const computedStatus = calcPoultryStatus({...fNum, ...tl});
        // When a batch is active and has no rates yet (e.g. just transitioned from planned),
        // stamp the current global admin feed cost rates onto it.
        if (computedStatus === 'active' && (!fNum.perLbStarterCost || !fNum.perLbStandardCost)) {
          fNum.perLbStarterCost = feedCosts.starter || 0;
          fNum.perLbStandardCost = feedCosts.grower || 0;
          fNum.perLbGritCost = feedCosts.grit || 0;
        }
        const batch = {id: editId, ...fNum, ...tl, status: computedStatus};
        const nb = batches.map((b) => (b.id === editId ? batch : b));
        nb.sort((a, b) => (a.hatchDate || '').localeCompare(b.hatchDate || ''));
        setBatches(nb);
        persist(nb);
        setOriginalForm(f);
      }, 1500);
    }
  }

  function openAdd() {
    setForm(EMPTY_FORM);
    setEditId(null);
    setConflicts([]);
    setOverride(false);
    setShowLegacy(false);
    setOriginalForm(EMPTY_FORM);
    setShowForm(true);
  }
  function openEdit(b) {
    const isB24 = /^b-24-/i.test(b.name);
    let brooderFeedLbs = b.brooderFeedLbs || 0;
    let schoonerFeedLbs = b.schoonerFeedLbs || 0;
    let gritLbs = b.gritLbs || 0;
    let mortalityCumulative = b.mortalityCumulative || 0;
    if (!isB24 && broilerDailys.length > 0) {
      const bd = broilerDailys.filter(
        (d) =>
          (d.batch_label || '')
            .toLowerCase()
            .trim()
            .replace(/^\(processed\)\s*/, '')
            .trim() === b.name.toLowerCase().trim(),
      );
      if (bd.length > 0) {
        brooderFeedLbs = Math.round(
          bd.filter((d) => d.feed_type === 'STARTER').reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0),
        );
        schoonerFeedLbs = Math.round(
          bd.filter((d) => d.feed_type === 'GROWER').reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0),
        );
        gritLbs = Math.round(bd.reduce((s, d) => s + (parseFloat(d.grit_lbs) || 0), 0));
        mortalityCumulative = bd.reduce((s, d) => s + (parseInt(d.mortality_count) || 0), 0);
      }
    }
    // Default Date In Brooder to hatchDate + 1 if blank (per "default fill, user can override" rule)
    let brooderIn = b.brooderIn || '';
    if (!brooderIn && b.hatchDate) {
      brooderIn = toISO(addDays(new Date(b.hatchDate + 'T12:00:00'), 1));
    }
    setForm({
      name: b.name,
      breed: b.breed || '',
      hatchery: b.hatchery || '',
      hatchDate: b.hatchDate || '',
      birdCount: b.birdCount || 750,
      birdCountActual: b.birdCountActual || '',
      brooder: b.brooder || '1',
      schooner: b.schooner || '2&3',
      processingDate: b.processingDate || '',
      status: b.status || 'planned',
      notes: b.notes || '',
      brooderIn,
      brooderOut: b.brooderOut || '',
      brooderFeedLbs,
      schoonerFeedLbs,
      gritLbs,
      mortalityCumulative,
      week4Lbs: b.week4Lbs || 0,
      week6Lbs: b.week6Lbs || 0,
      perLbStandardCost: b.perLbStandardCost || 0,
      perLbStarterCost: b.perLbStarterCost || 0,
      perLbGritCost: b.perLbGritCost || 0,
      chickCost: b.chickCost || 0,
      totalToProcessor: b.totalToProcessor || 0,
      processingCost: b.processingCost || 0,
      avgBreastLbs: b.avgBreastLbs || 0,
      avgThighsLbs: b.avgThighsLbs || 0,
      avgDressedLbs: b.avgDressedLbs || 0,
      totalLbsWhole: b.totalLbsWhole || 0,
      totalLbsCuts: b.totalLbsCuts || 0,
      documents: b.documents || [],
    });
    const snap = {
      name: b.name,
      breed: b.breed || '',
      hatchery: b.hatchery || '',
      hatchDate: b.hatchDate || '',
      birdCount: b.birdCount || 750,
      birdCountActual: b.birdCountActual || '',
      brooder: b.brooder || '1',
      schooner: b.schooner || '2&3',
      processingDate: b.processingDate || '',
      status: b.status || 'planned',
      notes: b.notes || '',
      brooderIn,
      brooderOut: b.brooderOut || '',
      brooderFeedLbs: b.brooderFeedLbs || 0,
      schoonerFeedLbs: b.schoonerFeedLbs || 0,
      gritLbs: b.gritLbs || 0,
      mortalityCumulative: b.mortalityCumulative || 0,
      week4Lbs: b.week4Lbs || 0,
      week6Lbs: b.week6Lbs || 0,
      perLbStandardCost: b.perLbStandardCost || 0,
      perLbStarterCost: b.perLbStarterCost || 0,
      perLbGritCost: b.perLbGritCost || 0,
      chickCost: b.chickCost || 0,
      totalToProcessor: b.totalToProcessor || 0,
      processingCost: b.processingCost || 0,
      avgBreastLbs: b.avgBreastLbs || 0,
      avgThighsLbs: b.avgThighsLbs || 0,
      avgDressedLbs: b.avgDressedLbs || 0,
      totalLbsWhole: b.totalLbsWhole || 0,
      totalLbsCuts: b.totalLbsCuts || 0,
    };
    setOriginalForm(snap);
    // Auto-enable Show Legacy if editing a batch that already has a legacy breed or hatchery selected,
    // so the user can actually see the saved value in the dropdown.
    const hasLegacyBreed = LEGACY_BREEDS.some((lb) => lb.code === b.breed);
    const hasLegacyHatchery = LEGACY_HATCHERIES.includes(b.hatchery);
    setShowLegacy(hasLegacyBreed || hasLegacyHatchery);
    // Compute existing conflicts on open so already-conflicting batches show their warnings immediately.
    // Wrapped in try/catch so a malformed batch record can never block the form from opening.
    setEditId(b.id);
    try {
      setConflicts(
        detectConflicts(
          {
            name: b.name,
            breed: b.breed || '',
            hatchDate: b.hatchDate || '',
            brooder: b.brooder || '1',
            schooner: b.schooner || '2&3',
            processingDate: b.processingDate || '',
          },
          batches,
          layerBatches,
          b.id,
        ),
      );
    } catch (e) {
      console.warn('detectConflicts failed on openEdit:', e);
      setConflicts([]);
    }
    setOverride(false);
    setShowForm(true);
  }

  async function parseProcessorXlsx(file) {
    try {
      // Lazy-load SheetJS on first use (saves ~900KB on every page load for users who don't import xlsx)
      if (typeof XLSX === 'undefined') {
        try {
          await window._wcfLoadXLSX();
        } catch (e) {
          alert('Could not load Excel parser. Check your internet connection and try again.');
          return;
        }
      }
      const buf = await file.arrayBuffer();
      const wb2 = XLSX.read(buf, {type: 'array', cellDates: false});
      let parsed = null;
      // Wings are a sellable cut — only neck/feet/back are scrap-style
      // categories that should be left out of the cuts total.
      const excluded = ['neck', 'feet', 'back', 'grand total'];

      // Map an aggregated {label: {total, count, label}} dict into the parsed
      // shape (avgDressed/avgBreast/avgThigh/totalLbsWhole/totalLbsCuts).
      // Used by both raw-format and pivot-format paths.
      function aggToParsed(agg, fileName) {
        const out = {fileName};
        let cuts = 0;
        for (const key of Object.keys(agg)) {
          const a = agg[key];
          const avgWt = a.count > 0 ? a.total / a.count : 0;
          if (key.includes('whole chicken')) {
            if (avgWt > 0) out.avgDressed = Math.round(avgWt * 100) / 100;
            if (a.total > 0) out.totalLbsWhole = Math.round(a.total * 10) / 10;
          }
          if (key.includes('breast') && avgWt > 0) out.avgBreast = Math.round(avgWt * 100) / 100;
          if (key.includes('thigh') && avgWt > 0) out.avgThigh = Math.round(avgWt * 100) / 100;
          if (
            key !== 'grand total' &&
            !excluded.some((e) => key.includes(e)) &&
            !key.includes('whole chicken') &&
            a.total > 0
          ) {
            cuts += a.total;
          }
        }
        if (cuts > 0) out.totalLbsCuts = Math.round(cuts * 10) / 10;
        return out;
      }

      for (const sheetName of wb2.SheetNames) {
        const ws = wb2.Sheets[sheetName];
        if (!ws || !ws['!ref']) continue;

        // Build a cell value map: address -> value
        const cv = {};
        Object.keys(ws).forEach((addr) => {
          if (addr[0] === '!') return;
          cv[addr] = ws[addr].v;
        });
        const range = XLSX.utils.decode_range(ws['!ref']);

        // ── PATH 1: Raw per-package format (Sonny's standard layout).
        // Header within first 5 rows containing "Description" + "Weight"
        // columns; one data row per package.
        let descCol = -1,
          weightCol = -1,
          hRowRaw = -1;
        for (let r = range.s.r; r <= Math.min(range.s.r + 5, range.e.r); r++) {
          for (let c = range.s.c; c <= range.e.c; c++) {
            const v = String(cv[XLSX.utils.encode_cell({r, c})] || '')
              .trim()
              .toLowerCase();
            if (v === 'description') {
              descCol = c;
              hRowRaw = r;
            }
            if (hRowRaw === r && v === 'weight') weightCol = c;
          }
          if (descCol >= 0 && weightCol >= 0) break;
        }
        if (descCol >= 0 && weightCol >= 0) {
          const agg = {};
          for (let r = hRowRaw + 1; r <= range.e.r; r++) {
            const desc = String(cv[XLSX.utils.encode_cell({r, c: descCol})] || '').trim();
            const wt = parseFloat(cv[XLSX.utils.encode_cell({r, c: weightCol})]);
            if (!desc || !isFinite(wt) || wt <= 0) continue;
            const key = desc.toLowerCase();
            if (!agg[key]) agg[key] = {total: 0, count: 0, label: desc};
            agg[key].total += wt;
            agg[key].count += 1;
          }
          if (Object.keys(agg).length > 0) {
            parsed = aggToParsed(agg, file.name);
            if (Object.keys(parsed).length > 1) break;
          }
        }

        // ── PATH 2: Pivot summary fallback ("Row Labels"/"Total Weight"/etc).
        let labelCol = -1,
          totalWtCol = -1,
          countCol = -1,
          avgWtCol = -1,
          hRow = -1;
        for (let r = range.s.r; r <= Math.min(range.s.r + 5, range.e.r); r++) {
          for (let c = range.s.c; c <= range.e.c; c++) {
            const v = String(cv[XLSX.utils.encode_cell({r, c})] || '')
              .trim()
              .toLowerCase();
            if (v === 'row labels') {
              labelCol = c;
              hRow = r;
            }
            if (hRow === r && v === 'total weight') totalWtCol = c;
            if (hRow === r && v === 'count of packages') countCol = c;
            if (hRow === r && v === 'average weight') avgWtCol = c;
          }
          if (labelCol >= 0 && avgWtCol >= 0) break;
        }
        if (labelCol < 0 || avgWtCol < 0) continue;
        const agg2 = {};
        for (let r = hRow + 1; r <= range.e.r; r++) {
          const labelVal = cv[XLSX.utils.encode_cell({r, c: labelCol})];
          if (!labelVal) continue;
          const label = String(labelVal).trim();
          if (!label) continue;
          const totalWt = parseFloat(cv[XLSX.utils.encode_cell({r, c: labelCol + 1})]);
          const count = parseInt(cv[XLSX.utils.encode_cell({r, c: labelCol + 2})]);
          if (!isFinite(totalWt) || totalWt <= 0) continue;
          agg2[label.toLowerCase()] = {total: totalWt, count: isFinite(count) && count > 0 ? count : 1, label};
        }
        if (Object.keys(agg2).length > 0) {
          parsed = aggToParsed(agg2, file.name);
          if (Object.keys(parsed).length > 1) break;
        }
      }

      if (parsed && Object.keys(parsed).length > 1) {
        setParsedProcessor(parsed);
      } else {
        alert(
          "Couldn't find processor data in " +
            file.name +
            '.\n\nThe parser looks for either:\n  • A raw per-package sheet with "Description" and "Weight" columns (Sonny\'s standard format), or\n  • A pivot summary with "Row Labels" / "Total Weight" / "Average Weight" columns.\n\nThe file was uploaded as an attachment.',
        );
      }
    } catch (e) {
      console.warn('Processor parse error:', e);
      alert('Excel parse error: ' + (e.message || 'Unknown error'));
    }
  }

  function confirmDelete(message, onConfirm) {
    setDeleteConfirm({message, onConfirm});
  }
  // Expose globally so child components can use without prop drilling
  React.useEffect(() => {
    window._wcfConfirmDelete = confirmDelete;
  }, []);

  function closeForm() {
    clearTimeout(autoSaveTimer.current);
    if (editId && originalForm) {
      const keys = [
        'name',
        'breed',
        'hatchery',
        'hatchDate',
        'birdCount',
        'birdCountActual',
        'brooder',
        'schooner',
        'processingDate',
        'status',
        'notes',
        'brooderIn',
        'brooderOut',
        'brooderFeedLbs',
        'schoonerFeedLbs',
        'gritLbs',
        'mortalityCumulative',
        'week4Lbs',
        'week6Lbs',
        'perLbStandardCost',
        'perLbStarterCost',
        'perLbGritCost',
        'totalToProcessor',
        'processingCost',
        'avgBreastLbs',
        'avgThighsLbs',
        'avgDressedLbs',
        'totalLbsWhole',
        'totalLbsCuts',
      ];
      const changed = keys.some((k) => String(form[k] || '') !== String(originalForm[k] || ''));
      if (changed) submit(false);
      else setShowForm(false);
    } else {
      setShowForm(false);
    }
  }

  function submit(force) {
    if (!form.name.trim()) {
      alert('Please enter a batch name.');
      return;
    }
    // Block on hard conflicts unless force=true. Soft (layer) conflicts always pass.
    const hardConflicts = (conflicts || []).filter((c) => !c.soft);
    if (hardConflicts.length > 0 && !force) {
      alert('There are scheduling conflicts. Use the Override & Save Anyway button if you really want to save.');
      return;
    }
    const tl = calcTimeline(form.hatchDate, form.breed, form.processingDate);
    // Parse numeric form fields back to numbers (form state holds raw strings during typing)
    const numFields = [
      'birdCount',
      'birdCountActual',
      'brooderFeedLbs',
      'schoonerFeedLbs',
      'gritLbs',
      'mortalityCumulative',
      'week4Lbs',
      'week6Lbs',
      'perLbStandardCost',
      'perLbStarterCost',
      'perLbGritCost',
      'totalToProcessor',
      'processingCost',
      'avgBreastLbs',
      'avgThighsLbs',
      'avgDressedLbs',
      'totalLbsWhole',
      'totalLbsCuts',
    ];
    const formNum = {...form};
    for (const k of numFields) {
      const v = formNum[k];
      formNum[k] = v === '' || v == null ? 0 : parseFloat(v) || 0;
    }
    const computedStatus = calcPoultryStatus({...formNum, ...tl});
    // When a batch is active and has no rates yet (e.g. just transitioned from planned),
    // stamp the current global admin feed cost rates onto it.
    if (computedStatus === 'active' && (!formNum.perLbStarterCost || !formNum.perLbStandardCost)) {
      formNum.perLbStarterCost = feedCosts.starter || 0;
      formNum.perLbStandardCost = feedCosts.grower || 0;
      formNum.perLbGritCost = feedCosts.grit || 0;
    }
    // conflictOverride auto-clears when there's no longer a hard conflict.
    // The flag was sticky before — it stayed true after dates were edited
    // to resolve the conflict, leaving stale ⚠ warnings on processed batches.
    const stillConflicting = hardConflicts.length > 0;
    const batch = {
      id: editId || String(Date.now()),
      ...formNum,
      ...tl,
      status: computedStatus,
      conflictOverride: stillConflicting ? force || form.conflictOverride || false : false,
    };
    const nb = editId ? batches.map((b) => (b.id === editId ? batch : b)) : [...batches, batch];
    nb.sort((a, b) => (a.hatchDate || '').localeCompare(b.hatchDate || ''));
    setBatches(nb);
    persist(nb);
    setOriginalForm(null);
    setShowForm(false);
    setOverride(false);
  }

  function del(id) {
    confirmDelete('Delete this batch? This cannot be undone.', () => {
      const nb = batches.filter((b) => b.id !== id);
      setBatches(nb);
      persist(nb);
    });
  }

  // Timeline-helper derived values (tlS/tlE/totalDays/pct/wkHdrs) + BatchForm
  // derived values (tl/targetHatch/hatchSuggestions/hatchWarn/procWarn/
  // hatcheries) + dead `counts` reducer removed — the timeline ones were only
  // consumed by the extracted BroilerTimelineView (which recomputes its own),
  // the form ones by the soon-to-be-extracted BatchForm (same treatment),
  // and `counts` had no consumers at all after the home extraction.

  // ── HEADER ──
  // Phase 2 Round 6 tail: body moved to src/shared/Header.jsx. This local
  // closure threads App-only props (form-open booleans, App helpers, the
  // built-up DeleteConfirmModal) into the imported HeaderBase so that every
  // extracted view can keep calling <Header/> as a zero-arg prop.
  const Header = () =>
    React.createElement(HeaderBase, {
      showDailyForm,
      signOut,
      loadUsers,
      DeleteConfirmModal,
    });

  // ── DELETE CONFIRM MODAL ── (proper component so useState is never conditional)
  const DeleteConfirmModal = deleteConfirm
    ? React.createElement(DeleteModal, {
        msg: deleteConfirm.message,
        onConfirm: deleteConfirm.onConfirm,
        onCancel: () => setDeleteConfirm(null),
      })
    : null;

  // ── WEBFORM BYPASS — no auth required ──
  if (view === 'webform') return React.createElement(PigDailysWebform);
  if (view === 'addfeed') return React.createElement(AddFeedWebform, {sb});
  if (view === 'weighins') return React.createElement(WeighInsWebform, {sb});
  if (view === 'tasksWebform') return React.createElement(TasksWebform, {sb});
  if (view === 'webformhub')
    return React.createElement(WebformHub, {
      sb,
      wfGroups,
      setWfGroups,
      wfTeamMembers,
      setWfTeamMembers,
      layerGroups,
      batches,
      layerBatches,
      layerHousings,
      webformsConfig,
    });
  if (view === 'fuelingHub') return React.createElement(FuelingHub, {sb});
  if (view === 'fuelSupply') return React.createElement(FuelSupplyWebform, {sb});

  // ── AUTH GATES ──
  // SetPasswordScreen comes first: a recovery / invite link gives the user a
  // valid session, so authState would otherwise jump straight to home.
  if (pwRecovery)
    return (
      <SetPasswordScreen
        prefilledEmail={authState && authState.user ? authState.user.email : null}
        onDone={() => setPwRecovery(false)}
      />
    );
  if (authState === null)
    return (
      <div
        style={{
          minHeight: '100vh',
          background: '#085041',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{color: 'white', fontSize: 16, opacity: 0.8}}>Loading...</div>
      </div>
    );
  if (authState === false) return <LoginScreen />;
  if (!dataLoaded)
    return (
      <div
        style={{
          minHeight: '100vh',
          background: '#085041',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{color: 'white', fontSize: 16, opacity: 0.8}}>Loading your farm data...</div>
      </div>
    );

  // \u2500\u2500 HOME DASHBOARD \u2500\u2500
  if (view === 'home')
    return React.createElement(HomeDashboard, {Header, loadUsers, canAccessProgram, VIEW_TO_PROGRAM});

  // ── FORM ──
  // Phase 2 Round 6 tail: body moved to src/broiler/BatchForm.jsx. Every
  // form-state piece lives in BatchesContext; every operational helper
  // stays in App() and is threaded as a prop.
  if (showForm)
    return React.createElement(BatchForm, {
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
    });

  // ── BROILER HOME DASHBOARD ──
  if (view === 'broilerHome') return React.createElement(BroilerHomeView, {Header, loadUsers});

  // ── TIMELINE VIEW ──
  if (view === 'timeline') return React.createElement(BroilerTimelineView, {Header, loadUsers, openEdit});

  if (view === 'broilerdailys')
    return React.createElement(BroilerDailysView, {
      sb,
      fmt,
      Header,
      authState,
      pendingEdit,
      setPendingEdit,
      refreshDailys,
    });
  if (view === 'pigdailys')
    return React.createElement(PigDailysView, {
      sb,
      fmt,
      Header,
      authState,
      pigDailys,
      setPigDailys,
      feederGroups,
      pendingEdit,
      setPendingEdit,
      refreshDailys,
    });
  if (view === 'cattledailys')
    return React.createElement(CattleDailysView, {
      sb,
      fmt,
      Header,
      authState,
      pendingEdit,
      setPendingEdit,
      refreshDailys,
    });
  if (view === 'cattleHome')
    return React.createElement(CattleHomeView, {
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
    });
  if (view === 'cattleherds')
    return React.createElement(CattleHerdsView, {
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
      pendingEdit,
      setPendingEdit,
    });
  if (view === 'cattlebreeding')
    return React.createElement(CattleBreedingView, {
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
    });
  if (view === 'cattleforecast')
    return React.createElement(CattleForecastView, {
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
    });
  if (view === 'cattlebatches')
    return React.createElement(CattleBatchesView, {
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
    });
  if (view === 'cattleweighins')
    return React.createElement(CattleWeighInsView, {
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
    });
  if (view === 'broilerweighins')
    return React.createElement(LivestockWeighInsView, {
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
      species: 'broiler',
    });
  if (view === 'pigweighins')
    return React.createElement(LivestockWeighInsView, {
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
      species: 'pig',
    });
  if (view === 'sheepHome')
    return React.createElement(SheepHomeView, {
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
    });
  if (view === 'sheepflocks')
    return React.createElement(SheepFlocksView, {
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
      pendingEdit,
      setPendingEdit,
    });
  if (view === 'sheepbatches')
    return React.createElement(SheepBatchesView, {
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
    });
  if (view === 'sheepdailys')
    return React.createElement(SheepDailysView, {
      sb,
      fmt,
      Header,
      authState,
      pendingEdit,
      setPendingEdit,
      refreshDailys,
    });
  if (view === 'sheepweighins')
    return React.createElement(SheepWeighInsView, {
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
    });
  if (view === 'equipmentHome')
    return React.createElement(EquipmentHome, {
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
    });

  // ── LIST VIEW ──
  if (view === 'list')
    return React.createElement(BroilerListView, {
      Header,
      loadUsers,
      openAdd,
      openEdit,
      persist,
      del,
      confirmDelete,
      canDeleteAnything,
    });

  // ── POULTRY FEED VIEW ──
  if (view === 'feed')
    return React.createElement(BroilerFeedView, {
      Header,
      feedOrders,
      setFeedOrders,
      poultryFeedInventory,
      setPoultryFeedInventory,
      poultryFeedExpandedMonths,
      setPoultryFeedExpandedMonths,
      collapsedBatches,
      setCollapsedBatches,
      sbSave,
    });

  // ── PIG FEED VIEW ──
  if (view === 'pigs')
    return React.createElement(PigFeedView, {
      Header,
      loadUsers,
      feedOrders,
      setFeedOrders,
      pigFeedInventory,
      setPigFeedInventory,
      pigFeedExpandedMonths,
      setPigFeedExpandedMonths,
      sbSave,
    });
  // ── BREEDING GANTT VIEW ──

  // ── PIGS HOME DASHBOARD ──
  if (view === 'pigsHome') return React.createElement(PigsHomeView, {Header, loadUsers});

  if (view === 'breeding')
    return React.createElement(BreedingView, {Header, loadUsers, persistBreeding, breedAutoSaveTimer, confirmDelete});

  // ── PIG BATCHES VIEW ──
  if (view === 'pigbatches')
    return React.createElement(PigBatchesView, {
      Header,
      loadUsers,
      persistFeeders,
      confirmDelete,
      pigAutoSaveTimer,
      subAutoSaveTimer,
      tripAutoSaveTimer,
      showSubForm,
      setShowSubForm,
      subForm,
      setSubForm,
      editSubId,
      setEditSubId,
      collapsedBatches,
      setCollapsedBatches,
      collapsedMonths,
      setCollapsedMonths,
      showArchBatches,
      setShowArchBatches,
    });

  // ── ADMIN TASKS CENTER (C1) ──
  // Component-level guard: non-admin → setView('home') in UnauthorizedRedirect.
  // Header dropdown gating alone is not enough; a non-admin pasting
  // /admin/tasks into the URL bar must not see admin UI even momentarily.
  if (view === 'adminTasks')
    return React.createElement(
      UnauthorizedRedirect,
      {authState, setView, requireAdmin: true, fallbackView: 'home'},
      React.createElement(AdminTasksView, {Header, sb, allUsers, loadUsers, setView}),
    );

  // ── MY TASKS (C2) ──
  // Auth-gated (any role); requireAdmin: false. Unauthenticated users
  // get redirected home where LoginScreen renders.
  if (view === 'myTasks')
    return React.createElement(
      UnauthorizedRedirect,
      {authState, setView, requireAdmin: false, fallbackView: 'home'},
      React.createElement(MyTasksView, {Header, sb, authState}),
    );

  // ── WEBFORMS ADMIN VIEW ──
  if (view === 'webforms')
    return React.createElement(WebformsAdminView, {
      Header,
      loadUsers,
      persistWebforms,
      saveFeedCosts,
      confirmDelete,
      adminTab,
      setAdminTab,
      wfView,
      setWfView,
      editWfId,
      setEditWfId,
      editFieldId,
      setEditFieldId,
      wfFieldForm,
      setWfFieldForm,
      newTeamMember,
      setNewTeamMember,
      addingTo,
      setAddingTo,
      editFldLbl,
      setEditFldLbl,
      editFldVal,
      setEditFldVal,
      editSecIdx,
      setEditSecIdx,
      editSecVal,
      setEditSecVal,
      newOpt,
      setNewOpt,
    });

  // ── PIG DAILY WEBFORM (public, no auth) ──
  // renderWebform moved to src/webforms/PigDailysWebform.jsx;
  // routed above in the webform bypass block as <PigDailysWebform/>.

  // Resolve sire for a farrowing record from breeding cycle data.
  // Checks which cycle the farrowing belongs to (by date window),
  // then checks if the sow tag is in boar1Tags or boar2Tags to determine the sire.
  // Falls back to the manually entered r.sire for unlinked historical records.
  function resolveSire(rec) {
    if (!rec || !rec.sow) return null;
    var sowTag = rec.sow.trim();
    for (var ci = 0; ci < breedingCycles.length; ci++) {
      var c = breedingCycles[ci];
      var tl = calcBreedingTimeline(c.exposureStart);
      if (!tl) continue;
      if (!rec.farrowingDate) continue;
      var rd = new Date(rec.farrowingDate + 'T12:00:00');
      if (rd < new Date(tl.farrowingStart + 'T12:00:00') || rd > addDays(new Date(tl.farrowingEnd + 'T12:00:00'), 14))
        continue;
      var b1Tags = (c.boar1Tags || '')
        .split(/[\n,]+/)
        .map(function (t) {
          return t.trim();
        })
        .filter(Boolean);
      var b2Tags = (c.boar2Tags || '')
        .split(/[\n,]+/)
        .map(function (t) {
          return t.trim();
        })
        .filter(Boolean);
      if (b1Tags.includes(sowTag)) return c.boar1Name || boarNames.boar1;
      if (b2Tags.includes(sowTag)) return c.boar2Name || boarNames.boar2;
    }
    // No cycle match — return null (Unknown), not the hardcoded r.sire
    return null;
  }

  // ── FARROWING RECORDS VIEW ──
  if (view === 'farrowing')
    return React.createElement(FarrowingView, {Header, loadUsers, persistFarrowing, confirmDelete, resolveSire});

  // ── BREEDING PIGS TAB ──
  if (view === 'sows')
    return React.createElement(SowsView, {
      Header,
      loadUsers,
      persistBreeders,
      persistBreedOptions,
      persistOriginOptions,
      confirmDelete,
      resolveSire,
      leaderboardExpanded,
      setLeaderboardExpanded,
      showArchived,
      setShowArchived,
    });

  // ── LAYERS HOME DASHBOARD (Phase 4) ──
  if (view === 'layersHome') return React.createElement(LayersHomeView, {Header, loadUsers});

  if (view === 'layers')
    return React.createElement(LayersView, {
      sb,
      layerGroups,
      persistLayerGroups,
      fmt,
      Header,
      layerBatches,
      layerHousings,
    });
  if (view === 'layerbatches')
    return React.createElement(LayerBatchesView, {
      sb,
      layerGroups,
      layerBatches,
      setLayerBatches,
      layerHousings,
      setLayerHousings: persistLayerHousings,
      batches,
      fmt,
      Header,
      authState,
      feedCosts,
      setView,
      pendingEdit,
      setPendingEdit,
      confirmDelete,
    });
  if (view === 'layerdailys')
    return React.createElement(LayerDailysView, {
      sb,
      fmt,
      Header,
      authState,
      layerGroups,
      pendingEdit,
      setPendingEdit,
      refreshDailys,
    });
  if (view === 'eggdailys')
    return React.createElement(EggDailysView, {
      sb,
      fmt,
      Header,
      authState,
      layerGroups,
      pendingEdit,
      setPendingEdit,
      refreshDailys,
    });

  // ── Cattle views ──
  // cattledailys is fully built; others are placeholder stubs until Phase 1 steps 10-13 land.
  // Unknown view - return null safely
  return null;
}

// Phase 2.1.1: WcfYN + WcfToggle moved to src/shared/ — imported at top of file.

// ── ADMIN ADD REPORT MODAL ──
// Mirrors WebformHub forms. Loads same Supabase config so Admin panel drives both.
// Phase 2.1.4: AdminAddReportModal moved to src/shared/AdminAddReportModal.jsx.
// ── BROILER DAILYS VIEW ──
// Phase 2 Round 2: BroilerDailysView moved to C:\Users\Ronni\WCF-planner\src\broiler\BroilerDailysView.jsx.

// ── LAYERS VIEW ──
// ── LAYER BATCHES VIEW ──
// Phase 2 Round 2 tail: LayerBatchesView moved to C:\Users\Ronni\WCF-planner\src\layer\LayerBatchesView.jsx.

// Phase 2 Round 3: LayersView moved to C:\Users\Ronni\WCF-planner\src\layer\LayersView.jsx.

// ── LAYER DAILYS VIEW ──
// Phase 2 Round 2: LayerDailysView moved to C:\Users\Ronni\WCF-planner\src\layer\LayerDailysView.jsx.

// ── EGG DAILYS VIEW ──
// Phase 2 Round 2: EggDailysView moved to C:\Users\Ronni\WCF-planner\src\layer\EggDailysView.jsx.

// ── PIG DAILYS VIEW ──
// Phase 2 Round 2: PigDailysView moved to C:\Users\Ronni\WCF-planner\src\pig\PigDailysView.jsx.

// ── CATTLE DAILYS VIEW ─────────────────────────────────────────────────────
// Admin list of cattle_dailys records with filters, edit, delete.
// Parallels PigDailysView / LayerDailysView pattern.
// Phase 2 Round 2: CattleDailysView moved to C:\Users\Ronni\WCF-planner\src\cattle\CattleDailysView.jsx.

// ── CATTLE HOME DASHBOARD ───────────────────────────────────────────────────
// Stats tiles + per-herd live weight / cow units / mortality.
// Phase 2 Round 3: CattleHomeView moved to C:\Users\Ronni\WCF-planner\src\cattle\CattleHomeView.jsx.

// ── CATTLE BULK IMPORT ─────────────────────────────────────────────────────
// Self-serve cattle uploader. User downloads a fixed-shape xlsx template,
// fills it (or has Claude pre-seed it), uploads it back, previews per-row,
// and commits. Per row: inserts a cattle row, plus optional calving record
// (last_calve_date), optional comment (comment), optional receiving weigh-in
// (receiving_weight). Auto-creates new breeds/origins as needed.
// Phase 2 Round 2: CattleBulkImport moved to C:\Users\Ronni\WCF-planner\src\cattle\CattleBulkImport.jsx.

// ── SHEEP BULK IMPORT ──────────────────────────────────────────────────────
// Same shape as CattleBulkImport but adapted to sheep schema (no pct_wagyu,
// flock instead of herd, lambing instead of calving, sex enum is
// ewe/ram/wether). Auto-creates new breeds/origins on commit.
// Phase 2 Round 2: SheepBulkImport moved to C:\Users\Ronni\WCF-planner\src\sheep\SheepBulkImport.jsx.

// ── SHEEP DETAIL PANEL ─────────────────────────────────────────────────────
// Inline expansion under a sheep row. Slimmer than CowDetail — Phase 1 keeps
// the essentials: identity, lineage tags, weight history table, lambing
// history, comments timeline. Charts + nav stack are Phase 2.
// Phase 2 Round 2: SheepDetail moved to C:\Users\Ronni\WCF-planner\src\sheep\SheepDetail.jsx.

// ── SHEEP FLOCKS VIEW ──────────────────────────────────────────────────────
// Mirror of CattleHerdsView with sheep terminology (flock/ewe/ram/wether,
// lambing instead of calving). Phase 1 covers: directory + flat/tile modes,
// add/edit/delete, transfer, inline detail, bulk import.
// Phase 2 Round 3: SheepFlocksView moved to C:\Users\Ronni\WCF-planner\src\sheep\SheepFlocksView.jsx.

// ── SHEEP HOME DASHBOARD ───────────────────────────────────────────────────
// Top stats + per-flock count tiles + rolling-window card with sheep-specific
// MetricsGrid (bales of hay, alfalfa lbs, mineral compliance %, fence
// voltage avg, mortality, report days). Period toggle 30/90/120 days.
// Phase 1 has no nutrition targets, so target % cells are skipped.
// Phase 2 Round 3: SheepHomeView moved to C:\Users\Ronni\WCF-planner\src\sheep\SheepHomeView.jsx.

// ── SHEEP DAILYS VIEW (admin entry) ────────────────────────────────────────
// Add/edit daily reports for sheep. Sheep-specific fields: bales of hay,
// alfalfa lbs, minerals given + % eaten, fence voltage kV, waterers working.
// Phase 2 Round 2: SheepDailysView moved to C:\Users\Ronni\WCF-planner\src\sheep\SheepDailysView.jsx.

// ── SHEEP WEIGH-INS VIEW (admin) ───────────────────────────────────────────
// Session-based weigh-ins on the shared weigh_in_sessions / weigh_ins tables
// with species='sheep'. Phase 1: list sessions, expand to entries, create
// session, add/edit/delete entries. Retag flow deferred to Phase 2.
// Phase 2 Round 2: SheepWeighInsView moved to C:\Users\Ronni\WCF-planner\src\sheep\SheepWeighInsView.jsx.

// ── CATTLE HERDS VIEW (merged with Directory) ──────────────────────────────
// Single tab combining per-herd tiles + global search/filter across all cattle.
// Add/edit/transfer/delete happen here. Cow detail expands inline with weigh
// history, calving history (Mommas), comments timeline.
// Phase 2 Round 3: CattleHerdsView moved to C:\Users\Ronni\WCF-planner\src\cattle\CattleHerdsView.jsx.

// Helper component — outcome (Processed/Deceased/Sold) sections collapsed at bottom of Herds view
// Phase 2 Round 2: CollapsibleOutcomeSections moved to C:\Users\Ronni\WCF-planner\src\cattle\CollapsibleOutcomeSections.jsx.

// Helper component — cow detail body shown when expanded inside the herd tile
// Phase 2 Round 2: CowDetail moved to C:\Users\Ronni\WCF-planner\src\cattle\CowDetail.jsx.

// ── CATTLE BREEDING VIEW ────────────────────────────────────────────────────
// Lists breeding cycles with computed dates, status, outstanding cows.
// Phase 2 Round 3: CattleBreedingView moved to C:\Users\Ronni\WCF-planner\src\cattle\CattleBreedingView.jsx.

// ── CATTLE PROCESSING BATCHES VIEW ─────────────────────────────────────────
// Lists processing batches (C-26-01 etc.) with cow lists and yield data.
// Phase 2 Round 3: CattleBatchesView moved to C:\Users\Ronni\WCF-planner\src\cattle\CattleBatchesView.jsx.

// ── CATTLE WEIGH-INS VIEW ───────────────────────────────────────────────────
// Authenticated review of past weigh-in sessions. Drill into a session to see
// individual entries. Highlights new-tag flags for admin reconciliation.
// Modal that creates a new draft weigh_in_sessions row from inside the admin
// LivestockWeighInsView (broiler + pig only). Mirrors the AdminAddReportModal
// pattern -- no navigate-away. After insert, the parent loadAll-then-expand
// hook drops the user straight into the in-tile grid for that fresh session.
// Phase 2.1.4: AdminNewWeighInModal moved to C:\Users\Ronni\WCF-planner\src\shared\AdminNewWeighInModal.jsx.

// Modal for "Send to Trip" — pick a feeder group + existing trip or create new.
// Totally stateless wrt Supabase; just collects inputs and hands them back.
// Phase 2.1.4: PigSendToTripModal moved to C:\Users\Ronni\WCF-planner\src\livestock\PigSendToTripModal.jsx.

// Modal: start a new cattle weigh-in session inline (no webform nav).
// Phase 2.1.4: CattleNewWeighInModal moved to src/cattle/CattleNewWeighInModal.jsx.

// === END VERBATIM PORT ===

// Render. Reuse-existing-root guard from the old bootstrap (prevented double
// createRoot on Babel cache retry) is no longer needed under Vite — there's
// no eval+retry path that could re-execute this module.
const root = createRoot(document.getElementById('root'));
const breedTlStartInit = () => {
  const d = new Date();
  d.setMonth(d.getMonth() - 2);
  d.setDate(1);
  return toISO(d);
};

// Phase 3.2: BrowserRouter wraps the provider tree so App (and any
// extracted view, if it ever wants to) can use useLocation/useNavigate.
// The view ↔ URL sync lives inside App via useViewUrlSync() below.
root.render(
  <BrowserRouter>
    <AuthProvider>
      <BatchesProvider formInit={EMPTY_FORM}>
        <PigProvider
          initialFarrowing={INITIAL_FARROWING}
          initialBreeders={INITIAL_BREEDERS}
          breedTlStartInit={breedTlStartInit}
        >
          <LayerProvider>
            <DailysRecentProvider>
              <CattleHomeProvider>
                <SheepHomeProvider>
                  <WebformsConfigProvider configInit={DEFAULT_WEBFORMS_CONFIG}>
                    <FeedCostsProvider>
                      <UIProvider>
                        <App />
                      </UIProvider>
                    </FeedCostsProvider>
                  </WebformsConfigProvider>
                </SheepHomeProvider>
              </CattleHomeProvider>
            </DailysRecentProvider>
          </LayerProvider>
        </PigProvider>
      </BatchesProvider>
    </AuthProvider>
  </BrowserRouter>,
);

// Fade out the static boot loader after React's first paint. Two RAFs to
// ensure the first frame containing real React content is on screen before
// the spinner disappears (matches the original bootstrap's fadeOutLoader).
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const loader = document.getElementById('wcf-boot-loader');
    if (loader) {
      loader.classList.add('fade-out');
      setTimeout(() => {
        if (loader.parentNode) loader.parentNode.removeChild(loader);
      }, 350);
    }
  });
});
