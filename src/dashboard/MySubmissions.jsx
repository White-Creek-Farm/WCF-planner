// ============================================================================
// src/dashboard/MySubmissions.jsx — Lane 1 CP2
// ----------------------------------------------------------------------------
// Light-user surface for editing/deleting their OWN equipment fuelings + fuel
// supplies. Light cannot reach /fleet or the admin fuel log, so this is where
// they correct their own equipment/fuel submissions. Ownership is enforced
// server-side by the SECDEF RPCs (mig 091) — this list filters to the caller's
// own rows for display only. Daily reports are edited on their own record pages
// (reachable via the daily list views), so they are not duplicated here.
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {useAuth} from '../contexts/AuthContext.jsx';
import {fmt} from '../lib/dateUtils.js';
import InlineNotice from '../shared/InlineNotice.jsx';

const cardS = {
  background: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: 10,
  padding: '12px 14px',
  marginBottom: 8,
};
const inpS = {fontSize: 13, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontFamily: 'inherit'};
const btn = (bg, c) => ({
  fontSize: 12,
  fontWeight: 600,
  padding: '5px 10px',
  borderRadius: 6,
  border: '1px solid ' + bg,
  background: bg,
  color: c,
  cursor: 'pointer',
  fontFamily: 'inherit',
});

export default function MySubmissions({Header}) {
  const {authState} = useAuth();
  const uid = (authState && authState !== false && authState.user && authState.user.id) || null;
  const [fuelings, setFuelings] = React.useState([]);
  const [supplies, setSupplies] = React.useState([]);
  const [loadError, setLoadError] = React.useState(null);
  const [loaded, setLoaded] = React.useState(false);
  const [editing, setEditing] = React.useState(null); // {kind, id, ...fields}
  const [notice, setNotice] = React.useState(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    Promise.all([
      sb
        .from('equipment_fuelings')
        .select('id,equipment_id,date,gallons,fuel_type,hours_reading,km_reading,comments,owner_profile_id')
        .eq('owner_profile_id', uid)
        .order('date', {ascending: false})
        .limit(200),
      sb
        .from('fuel_supplies')
        .select('id,date,gallons,fuel_type,destination,notes,owner_profile_id')
        .eq('owner_profile_id', uid)
        .order('date', {ascending: false})
        .limit(200),
    ])
      .then(([f, s]) => {
        if (cancelled) return;
        if (f.error || s.error) {
          setLoadError((f.error || s.error).message || 'Load failed');
          setFuelings([]);
          setSupplies([]);
        } else {
          setFuelings(f.data || []);
          setSupplies(s.data || []);
        }
        setLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e.message || String(e));
        setFuelings([]);
        setSupplies([]);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [uid, reloadKey]);

  async function saveEdit() {
    if (!editing) return;
    setNotice(null);
    try {
      if (editing.kind === 'fueling') {
        await sb.rpc('update_equipment_fueling', {
          p_id: editing.id,
          p_patch: {date: editing.date, gallons: numOrNull(editing.gallons), comments: editing.comments || null},
        });
      } else {
        await sb.rpc('update_fuel_supply', {
          p_id: editing.id,
          p_patch: {date: editing.date, gallons: numOrNull(editing.gallons), notes: editing.notes || null},
        });
      }
      setEditing(null);
      setNotice({kind: 'success', message: 'Saved.'});
      setReloadKey((k) => k + 1);
    } catch (e) {
      setNotice({kind: 'error', message: 'Save failed: ' + (e.message || String(e))});
    }
  }

  function del(kind, id) {
    if (!window._wcfConfirmDelete) return;
    window._wcfConfirmDelete(
      'Delete this ' + (kind === 'fueling' ? 'fueling' : 'fuel supply') + ' entry?',
      async () => {
        setNotice(null);
        try {
          await sb.rpc(kind === 'fueling' ? 'delete_equipment_fueling' : 'delete_fuel_supply', {p_id: id});
          setNotice({kind: 'success', message: 'Deleted.'});
          setReloadKey((k) => k + 1);
        } catch (e) {
          setNotice({kind: 'error', message: 'Delete failed: ' + (e.message || String(e))});
        }
      },
    );
  }

  function row(kind, r) {
    const isEd = editing && editing.kind === kind && editing.id === r.id;
    const sub = kind === 'fueling' ? r.comments : r.notes;
    return (
      <div key={r.id} style={cardS} data-my-submission={kind}>
        {isEd ? (
          <div style={{display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center'}}>
            <input
              type="date"
              value={editing.date || ''}
              onChange={(e) => setEditing({...editing, date: e.target.value})}
              style={inpS}
            />
            <input
              type="number"
              placeholder="gallons"
              value={editing.gallons ?? ''}
              onChange={(e) => setEditing({...editing, gallons: e.target.value})}
              style={{...inpS, width: 90}}
            />
            <input
              placeholder={kind === 'fueling' ? 'comments' : 'notes'}
              value={(kind === 'fueling' ? editing.comments : editing.notes) || ''}
              onChange={(e) =>
                setEditing(
                  kind === 'fueling' ? {...editing, comments: e.target.value} : {...editing, notes: e.target.value},
                )
              }
              style={{...inpS, flex: 1, minWidth: 120}}
            />
            <button onClick={saveEdit} style={btn('#085041', 'white')}>
              Save
            </button>
            <button onClick={() => setEditing(null)} style={btn('white', '#374151')}>
              Cancel
            </button>
          </div>
        ) : (
          <div style={{display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap'}}>
            <span style={{fontWeight: 600, fontSize: 13}}>{fmt(r.date)}</span>
            <span style={{fontSize: 13, color: '#374151'}}>{r.gallons != null ? r.gallons + ' gal' : '—'}</span>
            {kind === 'fueling' && r.equipment_id && (
              <span style={{fontSize: 12, color: '#6b7280'}}>{r.equipment_id}</span>
            )}
            {kind === 'supply' && r.destination && (
              <span style={{fontSize: 12, color: '#6b7280'}}>{r.destination}</span>
            )}
            {sub && <span style={{fontSize: 12, color: '#6b7280', flex: 1, minWidth: 80}}>{sub}</span>}
            <button
              onClick={() =>
                setEditing({
                  kind,
                  id: r.id,
                  date: r.date,
                  gallons: r.gallons,
                  comments: r.comments,
                  notes: r.notes,
                })
              }
              style={{...btn('white', '#1d4ed8'), marginLeft: 'auto'}}
            >
              Edit
            </button>
            <button onClick={() => del(kind, r.id)} style={btn('#fef2f2', '#b91c1c')}>
              Delete
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-my-submissions="1"
      data-my-submissions-loaded={loaded && !loadError ? 'true' : 'false'}
      style={{minHeight: '100vh', background: '#f1f3f2'}}
    >
      <Header />
      <div style={{padding: '1.25rem', maxWidth: 760, margin: '0 auto'}}>
        <div style={{fontSize: 20, fontWeight: 800, color: '#111827', marginBottom: 4}}>My Submissions</div>
        <div style={{fontSize: 13, color: '#6b7280', marginBottom: 16}}>
          Equipment fuelings and fuel supplies you submitted. You can edit or delete only your own entries.
        </div>
        {notice && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}
        {loadError && (
          <div data-my-submissions-load-error="true">
            <InlineNotice notice={{kind: 'error', message: 'Could not load: ' + loadError}} />
            <button
              type="button"
              data-my-submissions-retry="1"
              onClick={() => setReloadKey((k) => k + 1)}
              style={btn('white', '#1d4ed8')}
            >
              Retry
            </button>
          </div>
        )}

        {!loadError && (
          <div style={{fontSize: 13, fontWeight: 700, color: '#57534e', margin: '12px 0 6px'}}>
            🚜 Equipment fuelings ({fuelings.length})
          </div>
        )}
        {!loadError && loaded && fuelings.length === 0 && <div style={{fontSize: 12, color: '#9ca3af'}}>None yet.</div>}
        {!loadError && fuelings.map((r) => row('fueling', r))}

        {!loadError && (
          <div style={{fontSize: 13, fontWeight: 700, color: '#92400e', margin: '18px 0 6px'}}>
            ⛽ Fuel supplies ({supplies.length})
          </div>
        )}
        {!loadError && loaded && supplies.length === 0 && <div style={{fontSize: 12, color: '#9ca3af'}}>None yet.</div>}
        {!loadError && supplies.map((r) => row('supply', r))}
      </div>
    </div>
  );
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
