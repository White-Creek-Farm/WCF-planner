// EquipmentHome — container for /fleet/* routes (logged-in internal,
// post 2026-05-06 rename — was /equipment/*, which now hosts the public
// equipment-checklist hub). Owns sub-routing:
//   /fleet              → Fleet view (default)
//   /fleet/fuel-log     → flat Fuel Log
//   /fleet/<slug>       → per-equipment detail
//
// Mirrors the pattern used by WebformHub for /dailys/* routes. main.jsx
// maps every /fleet/* path to view='equipmentHome' so the browser back
// button can traverse sub-routes without the app snapping to /. Legacy
// /equipment/fleet and /equipment/fuel-log redirect to canonical via the
// alias map; /equipment/<slug> intentionally does NOT redirect — that
// path is now the public equipment-checklist surface.
import React from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import UsersModal from '../auth/UsersModal.jsx';
import EquipmentFleetView from './EquipmentFleetView.jsx';
import EquipmentFuelLogView from './EquipmentFuelLogView.jsx';
import EquipmentDetail from './EquipmentDetail.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordSequenceNav from '../shared/RecordSequenceNav.jsx';
import {recordSeqNavOptions, labeledSeqItems} from '../lib/recordSequence.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';

export default function EquipmentHome({
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
}) {
  const [equipment, setEquipment] = React.useState([]);
  const [fuelings, setFuelings] = React.useState([]);
  const [maintenance, setMaintenance] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(null);
  const [missingSchema, setMissingSchema] = React.useState(false);

  const location = useLocation();
  const navigate = useNavigate();

  // equipment_tech users only see per-equipment tabs. The Fleet / Fuel Log /
  // Materials admin sub-nav buttons are hidden; on the detail page they see
  // Manuals & Videos, upcoming service, and fueling/checklist history but
  // not maintenance events or admin surfaces (gated inside EquipmentDetail).
  const isEquipmentTech = authState?.role === 'equipment_tech';

  // `quiet:true` skips the loading=true flip so callers that reload after a
  // user action (e.g. the meter-status Sync button) can preserve their own
  // inline notice — otherwise the detail page unmounts under the loading
  // spinner and any "Synced" banner disappears before it can be read.
  const loadAll = React.useCallback(
    async ({quiet = false} = {}) => {
      if (!quiet) setLoading(true);
      setLoadError(null);
      try {
        const [eR, fR, mR] = await Promise.all([
          sb.from('equipment').select('*').order('name'),
          sb.from('equipment_fuelings').select('*').order('date', {ascending: false}).limit(5000),
          sb.from('equipment_maintenance_events').select('*').order('event_date', {ascending: false}).limit(500),
        ]);
        // If migration 016 hasn't been applied, the tables won't exist. Show a
        // friendly banner instead of crashing.
        if (eR.error && /does not exist|relation/i.test(eR.error.message || '')) {
          setMissingSchema(true);
          setEquipment([]);
          setFuelings([]);
          setMaintenance([]);
          return;
        }
        if (eR.error) throw new Error('equipment: ' + eR.error.message);
        if (fR.error) throw new Error('equipment_fuelings: ' + fR.error.message);
        if (mR.error) throw new Error('equipment_maintenance_events: ' + mR.error.message);
        setMissingSchema(false);
        setEquipment(eR.data || []);
        setFuelings(fR.data || []);
        setMaintenance(mR.data || []);
      } catch (e) {
        setMissingSchema(false);
        setEquipment([]);
        setFuelings([]);
        setMaintenance([]);
        setLoadError({kind: 'error', message: 'Could not load equipment data: ' + (e?.message || e)});
      } finally {
        setLoading(false);
      }
    },
    [sb],
  );
  React.useEffect(() => {
    loadAll();
  }, [loadAll]);

  const path = location.pathname;
  let subView = 'fleet';
  let detailSlug = null;
  if (path === '/fleet/fuel-log') subView = 'fuel-log';
  else if (path.startsWith('/fleet/')) {
    detailSlug = path.slice('/fleet/'.length);
    subView = 'detail';
  }
  // 2026-05-14: /fleet/materials standalone page retired. The route is
  // aliased to /fleet in src/lib/routes.js (ALIASES_EXACT), so the URL
  // adapter rewrites old bookmarks before this component ever sees them.
  // The Materials Needed surface lives on the home dashboard now.

  const activeEq = detailSlug
    ? equipment.find((e) => e.slug === detailSlug) || equipment.find((e) => e.id === detailSlug)
    : null;
  // Originating fleet order handed through route state; absent on direct links
  // and the equipment-tech quick-pick nav. Fleet routes are keyed by slug.
  const recordSeq = location.state?.recordSeq || null;
  function navigateSeq(slug) {
    navigate('/fleet/' + slug, recordSeqNavOptions(recordSeq));
  }

  const subNavBtn = (active) => ({
    padding: '7px 14px',
    borderRadius: 8,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 12,
    fontWeight: active ? 700 : 500,
    whiteSpace: 'nowrap',
    border: active ? '2px solid #57534e' : '1px solid #d1d5db',
    background: active ? '#57534e' : 'white',
    color: active ? 'white' : '#374151',
  });

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

      {/* Secondary sub-nav within /fleet. equipment_tech users see
          a simplified nav — just a quick-pick list of equipment tiles,
          not the Fleet + Fuel Log admin surfaces. Materials live on the
          home dashboard Materials Needed card; the standalone Materials
          page/tab was retired 2026-05-14. */}
      <div
        style={{
          background: 'white',
          borderBottom: '1px solid #e5e7eb',
          padding: '8px 1.25rem',
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        {!isEquipmentTech && (
          <>
            <button
              onClick={() => navigate('/fleet')}
              style={{...subNavBtn(subView === 'fleet'), display: 'inline-flex', alignItems: 'center', gap: 6}}
            >
              <PlannerIcon iconKey="tractor" size={16} />
              Fleet
            </button>
            <button
              onClick={() => navigate('/fleet/fuel-log')}
              style={{...subNavBtn(subView === 'fuel-log'), display: 'inline-flex', alignItems: 'center', gap: 6}}
            >
              <PlannerIcon iconKey="fueling" size={16} />
              Fuel Log
            </button>
          </>
        )}
        {isEquipmentTech &&
          equipment
            .filter((e) => e.status === 'active')
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((e) => (
              <button
                key={e.id}
                onClick={() => navigate('/fleet/' + e.slug)}
                style={subNavBtn(subView === 'detail' && detailSlug === e.slug)}
              >
                {e.name}
              </button>
            ))}
        {detailSlug && activeEq && !isEquipmentTech && (
          <>
            <span style={{color: '#9ca3af', fontSize: 12}}>{'›'}</span>
            <span
              style={{
                padding: '7px 14px',
                borderRadius: 8,
                background: '#57534e',
                color: 'white',
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              {activeEq.name}
            </span>
          </>
        )}
      </div>

      <div
        style={{padding: '1rem', maxWidth: 1200, margin: '0 auto'}}
        data-equipment-home-loaded={!loading && !loadError && !missingSchema ? 'true' : 'false'}
      >
        {missingSchema && (
          <div
            style={{
              background: '#fff7ed',
              border: '1px solid #fdba74',
              borderRadius: 10,
              padding: '1rem 1.25rem',
              marginBottom: 12,
              color: '#9a3412',
              fontSize: 13,
            }}
          >
            <strong>Equipment schema missing.</strong> Apply <code>supabase-migrations/016_equipment_module.sql</code>{' '}
            in the SQL Editor, then run <code>node scripts/import_equipment.cjs --commit</code> to populate the tables.
            Reload this page once that's done.
          </div>
        )}

        {loading && !missingSchema && (
          <div style={{textAlign: 'center', padding: '3rem', color: '#9ca3af'}}>Loading{'…'}</div>
        )}

        {!loading && !missingSchema && loadError && (
          <div data-equipment-load-error="true">
            <InlineNotice notice={loadError} />
            <button
              type="button"
              onClick={() => loadAll()}
              style={{
                padding: '7px 14px',
                borderRadius: 7,
                border: '1px solid #d1d5db',
                background: 'white',
                color: '#57534e',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !missingSchema && !loadError && subView === 'fleet' && !isEquipmentTech && (
          <EquipmentFleetView
            sb={sb}
            equipment={equipment}
            fuelings={fuelings}
            fmt={fmt}
            onOpen={(slug, items) =>
              navigate(
                '/fleet/' + slug,
                items ? recordSeqNavOptions(labeledSeqItems(items, 'name', 'slug')) : undefined,
              )
            }
            onReload={loadAll}
          />
        )}
        {!loading && !missingSchema && !loadError && subView === 'fleet' && isEquipmentTech && (
          <div
            style={{
              background: 'white',
              border: '1px solid #e5e7eb',
              borderRadius: 12,
              padding: '2rem',
              textAlign: 'center',
              color: '#6b7280',
              fontSize: 13,
            }}
          >
            Pick a piece of equipment above.
          </div>
        )}
        {!loading && !missingSchema && !loadError && subView === 'fuel-log' && !isEquipmentTech && (
          <EquipmentFuelLogView sb={sb} authState={authState} equipment={equipment} fuelings={fuelings} fmt={fmt} />
        )}
        {!loading && !missingSchema && !loadError && subView === 'detail' && activeEq && (
          <>
            <RecordSequenceNav seq={recordSeq} currentId={detailSlug} onNavigate={navigateSeq} />
            <EquipmentDetail
              sb={sb}
              fmt={fmt}
              equipment={activeEq}
              fuelings={fuelings.filter((f) => f.equipment_id === activeEq.id)}
              maintenance={maintenance.filter((m) => m.equipment_id === activeEq.id)}
              authState={authState}
              isEquipmentTech={isEquipmentTech}
              onReload={loadAll}
            />
          </>
        )}
        {!loading && !missingSchema && !loadError && subView === 'detail' && !activeEq && (
          <div
            style={{
              background: 'white',
              border: '1px solid #e5e7eb',
              borderRadius: 12,
              padding: '2rem',
              textAlign: 'center',
              color: '#6b7280',
              fontSize: 13,
            }}
          >
            No equipment with slug <code>{detailSlug}</code>.{' '}
            <a
              onClick={(e) => {
                e.preventDefault();
                navigate('/fleet');
              }}
              href="#"
              style={{color: '#1d4ed8', cursor: 'pointer'}}
            >
              Back to Fleet
            </a>
            .
          </div>
        )}
      </div>
    </div>
  );
}
