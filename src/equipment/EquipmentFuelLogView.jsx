// EquipmentFuelLogView — flat list of every fueling entry across all
// equipment. Filters by equipment, fuel type, date range, team member.
// Matches the "Fuel Log" Podio tab's mental model.
import React from 'react';
import {stripPodioHtml} from '../lib/equipment.js';
import {usePersistentViewState} from '../lib/usePersistentViewState.js';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {printRows} from '../lib/printExport.js';
import {listSavedViews, createSavedView, updateSavedView, deleteSavedView} from '../lib/savedViewsApi.js';

const EQUIPMENT_FUEL_LOG_SURFACE_KEY = 'equipment.fuelLog';
const EXTENDED_LIST_CONTROLS_ENABLED = false;

export default function EquipmentFuelLogView({sb, authState, equipment, fuelings, fmt}) {
  const [eqFilter, setEqFilter] = usePersistentViewState('equipment.fuelLog.equipmentFilter', '');
  const [fuelFilter, setFuelFilter] = usePersistentViewState('equipment.fuelLog.fuelFilter', '');
  const [teamFilter, setTeamFilter] = usePersistentViewState('equipment.fuelLog.teamFilter', '');
  const [fromDate, setFromDate] = usePersistentViewState('equipment.fuelLog.fromDate', '');
  const [toDate, setToDate] = usePersistentViewState('equipment.fuelLog.toDate', '');
  // Browser-only fallback notice for CSV export (no inline-notice system in
  // this view; downloadCsv returns false only in a non-browser context).
  const [exportNotice, setExportNotice] = React.useState('');
  const [savedViews, setSavedViews] = React.useState([]);
  const [savedViewsError, setSavedViewsError] = React.useState(null);
  const [savedViewsLoading, setSavedViewsLoading] = React.useState(true);
  const [selectedViewId, setSelectedViewId] = React.useState('');
  const [showSaveViewForm, setShowSaveViewForm] = React.useState(false);
  const [saveViewName, setSaveViewName] = React.useState('');
  const [saveViewVisibility, setSaveViewVisibility] = React.useState('private');
  const [savedViewBusy, setSavedViewBusy] = React.useState(false);
  const [savedViewNotice, setSavedViewNotice] = React.useState(null);
  const myProfileId = authState?.user?.id || null;

  async function loadSavedViews() {
    setSavedViewsLoading(true);
    try {
      const rows = await listSavedViews(sb, EQUIPMENT_FUEL_LOG_SURFACE_KEY);
      setSavedViews(rows);
      setSavedViewsError(null);
      setSelectedViewId((cur) => (cur && rows.some((r) => r.id === cur) ? cur : ''));
    } catch (e) {
      setSavedViews([]);
      setSavedViewsError(e.message || String(e));
    } finally {
      setSavedViewsLoading(false);
    }
  }

  React.useEffect(() => {
    loadSavedViews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const eqById = React.useMemo(() => Object.fromEntries(equipment.map((e) => [e.id, e])), [equipment]);
  const teamMembers = React.useMemo(() => {
    const set = new Set();
    fuelings.forEach((f) => {
      if (f.team_member) set.add(f.team_member);
    });
    return Array.from(set).sort();
  }, [fuelings]);

  const effectiveEqFilter = EXTENDED_LIST_CONTROLS_ENABLED ? eqFilter : '';
  const effectiveFuelFilter = EXTENDED_LIST_CONTROLS_ENABLED ? fuelFilter : '';
  const effectiveTeamFilter = EXTENDED_LIST_CONTROLS_ENABLED ? teamFilter : '';
  const effectiveFromDate = EXTENDED_LIST_CONTROLS_ENABLED ? fromDate : '';
  const effectiveToDate = EXTENDED_LIST_CONTROLS_ENABLED ? toDate : '';
  const filtered = fuelings.filter((f) => {
    if (effectiveEqFilter && f.equipment_id !== effectiveEqFilter) return false;
    if (effectiveFuelFilter && f.fuel_type !== effectiveFuelFilter) return false;
    if (effectiveTeamFilter && f.team_member !== effectiveTeamFilter) return false;
    if (effectiveFromDate && (f.date || '') < effectiveFromDate) return false;
    if (effectiveToDate && (f.date || '') > effectiveToDate) return false;
    return true;
  });
  const selectedView = savedViews.find((v) => v.id === selectedViewId) || null;
  const selectedViewIsMine = !!(selectedView && myProfileId && selectedView.owner_profile_id === myProfileId);

  function equipmentFuelLogViewState() {
    return {
      eqFilter: eqFilter || '',
      fuelFilter: fuelFilter || '',
      teamFilter: teamFilter || '',
      fromDate: fromDate || '',
      toDate: toDate || '',
    };
  }

  function applyEquipmentFuelLogSavedView(view) {
    if (!view) return;
    const st = view.view_state || {};
    setEqFilter(typeof st.eqFilter === 'string' ? st.eqFilter : '');
    setFuelFilter(typeof st.fuelFilter === 'string' ? st.fuelFilter : '');
    setTeamFilter(typeof st.teamFilter === 'string' ? st.teamFilter : '');
    setFromDate(typeof st.fromDate === 'string' ? st.fromDate : '');
    setToDate(typeof st.toDate === 'string' ? st.toDate : '');
    setSavedViewNotice(null);
  }

  function onSelectSavedView(id) {
    setSelectedViewId(id);
    setSavedViewNotice(null);
    if (!id) return;
    applyEquipmentFuelLogSavedView(savedViews.find((v) => v.id === id));
  }

  function openSaveViewForm() {
    setSaveViewName('');
    setSaveViewVisibility('private');
    setSavedViewNotice(null);
    setShowSaveViewForm(true);
  }

  async function submitSaveView() {
    const name = saveViewName.trim();
    if (!name) {
      setSavedViewNotice({kind: 'error', message: 'Name the view before saving.'});
      return;
    }
    setSavedViewBusy(true);
    try {
      const created = await createSavedView(sb, {
        surfaceKey: EQUIPMENT_FUEL_LOG_SURFACE_KEY,
        name,
        visibility: saveViewVisibility,
        viewState: equipmentFuelLogViewState(),
      });
      setShowSaveViewForm(false);
      setSavedViewNotice({kind: 'success', message: 'Saved view "' + name + '".'});
      await loadSavedViews();
      if (created?.id) setSelectedViewId(created.id);
    } catch (e) {
      setSavedViewNotice({kind: 'error', message: 'Save view failed: ' + (e.message || String(e))});
    } finally {
      setSavedViewBusy(false);
    }
  }

  async function updateSelectedView() {
    if (!selectedView || !selectedViewIsMine) return;
    setSavedViewBusy(true);
    try {
      await updateSavedView(sb, selectedView.id, {viewState: equipmentFuelLogViewState()});
      await loadSavedViews();
      setSavedViewNotice({
        kind: 'success',
        message: 'Updated "' + selectedView.name + '" to the current filters.',
      });
    } catch (e) {
      setSavedViewNotice({kind: 'error', message: 'Update view failed: ' + (e.message || String(e))});
    } finally {
      setSavedViewBusy(false);
    }
  }

  async function proceedDeleteSelectedView(view) {
    setSavedViewBusy(true);
    try {
      await deleteSavedView(sb, view.id);
      setSelectedViewId('');
      await loadSavedViews();
      setSavedViewNotice({kind: 'success', message: 'Deleted saved view "' + view.name + '".'});
    } catch (e) {
      setSavedViewNotice({kind: 'error', message: 'Delete view failed: ' + (e.message || String(e))});
    } finally {
      setSavedViewBusy(false);
    }
  }

  function deleteSelectedView() {
    if (!selectedView || !selectedViewIsMine || !window._wcfConfirmDelete) return;
    window._wcfConfirmDelete('Delete saved view "' + selectedView.name + '"?', () => {
      void proceedDeleteSelectedView(selectedView);
    });
  }

  const totals = {
    count: filtered.length,
    gallons: filtered.reduce((s, f) => s + (parseFloat(f.gallons) || 0), 0),
    def_gallons: filtered.reduce((s, f) => s + (parseFloat(f.def_gallons) || 0), 0),
    cost: filtered.reduce((s, f) => s + (parseFloat(f.gallons) || 0) * (parseFloat(f.fuel_cost_per_gal) || 0), 0),
  };

  // CSV export of the CURRENT filtered rows. Exports ALL filtered rows, not
  // the visible filtered.slice(0, 500) cap — the 500-row cap is a render-only
  // guard. Mechanics (quoting, formula-injection neutralization, browser
  // download) come from the shared csvExport owner.
  function equipmentFuelLogExportColumns() {
    const estCost = (f) => {
      const g = parseFloat(f.gallons) || 0;
      const c = parseFloat(f.fuel_cost_per_gal) || 0;
      return g > 0 && c > 0 ? Math.round(g * c * 100) / 100 : '';
    };
    return [
      {header: 'Date', value: (f) => f.date || ''},
      {header: 'Equipment name', value: (f) => eqById[f.equipment_id]?.name || ''},
      {header: 'Equipment ID', value: (f) => f.equipment_id || ''},
      {header: 'Fuel type', value: (f) => f.fuel_type || ''},
      {header: 'Gallons', value: (f) => f.gallons ?? ''},
      {header: 'DEF gallons', value: (f) => f.def_gallons ?? ''},
      {header: 'Fuel cost per gallon', value: (f) => f.fuel_cost_per_gal ?? ''},
      {header: 'Estimated fuel cost', value: estCost},
      {header: 'Hours reading', value: (f) => f.hours_reading ?? ''},
      {header: 'KM reading', value: (f) => f.km_reading ?? ''},
      {header: 'Team member', value: (f) => f.team_member || ''},
      {header: 'Comments', value: (f) => stripPodioHtml(f.comments) || ''},
      {header: 'Record ID', value: (f) => f.id || ''},
    ];
  }

  function handleExportCsv() {
    const columns = equipmentFuelLogExportColumns();
    const ok = downloadCsv(csvFilename('equipment-fuel-log'), rowsToCsv(columns, filtered));
    setExportNotice(ok ? '' : 'CSV export is only available in the browser.');
  }

  function handlePrintRows() {
    const columns = equipmentFuelLogExportColumns();
    const ok = printRows({
      title: 'Equipment Fuel Log',
      subtitle: filtered.length + ' filtered fuel entries',
      columns,
      rows: filtered,
    });
    setExportNotice(ok ? '' : 'Print is only available in the browser.');
  }

  const inpS = {
    fontSize: 13,
    padding: '7px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 10,
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  };
  const myViews = savedViews.filter((v) => myProfileId && v.owner_profile_id === myProfileId);
  const publicOtherViews = savedViews.filter(
    (v) => v.visibility === 'public' && !(myProfileId && v.owner_profile_id === myProfileId),
  );
  const savedViewGhostBtnS = {
    padding: '6px 12px',
    borderRadius: 10,
    border: '1px solid var(--border-strong)',
    background: 'white',
    color: 'var(--ink)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  };
  const savedViewPrimaryBtnS = {...savedViewGhostBtnS, border: '1px solid #57534e', color: '#57534e'};
  const savedViewRadioLabelS = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    color: 'var(--ink)',
    cursor: 'pointer',
  };

  return (
    <div>
      {EXTENDED_LIST_CONTROLS_ENABLED && (
        <div
          data-equipment-fuel-log-saved-views-row
          style={{
            background: 'white',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '10px 14px',
            marginBottom: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <span style={{fontSize: 11, color: 'var(--ink-muted)', fontWeight: 600}}>Saved views</span>
          {savedViewsError ? (
            <span
              style={{fontSize: 12, color: '#b91c1c', display: 'inline-flex', alignItems: 'center', gap: 8}}
              data-equipment-fuel-log-saved-views-error
            >
              Saved views unavailable. Filters still work.
              <button
                type="button"
                data-equipment-fuel-log-saved-views-retry
                onClick={loadSavedViews}
                disabled={savedViewsLoading}
                style={{
                  fontSize: 11,
                  padding: '3px 10px',
                  borderRadius: 10,
                  border: '1px solid var(--border-strong)',
                  background: 'white',
                  color: 'var(--ink)',
                  cursor: savedViewsLoading ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 600,
                }}
              >
                {savedViewsLoading ? 'Retrying…' : 'Retry'}
              </button>
            </span>
          ) : (
            <>
              <select
                data-equipment-fuel-log-saved-view-select
                value={selectedViewId}
                disabled={savedViewsLoading}
                onChange={(e) => onSelectSavedView(e.target.value)}
                style={{...inpS, width: 'auto', minWidth: 200, fontSize: 12, padding: '6px 10px'}}
              >
                <option value="">{savedViewsLoading ? 'Loading...' : 'Select a saved view'}</option>
                {myViews.length > 0 && (
                  <optgroup label="My views">
                    {myViews.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name + (v.visibility === 'public' ? ' - public' : ' - private')}
                      </option>
                    ))}
                  </optgroup>
                )}
                {publicOtherViews.length > 0 && (
                  <optgroup label="Public views">
                    {publicOtherViews.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              {selectedViewIsMine && (
                <>
                  <button
                    type="button"
                    data-equipment-fuel-log-saved-view-update
                    onClick={updateSelectedView}
                    disabled={savedViewBusy}
                    style={savedViewGhostBtnS}
                  >
                    Update to current
                  </button>
                  <button
                    type="button"
                    data-equipment-fuel-log-saved-view-delete
                    onClick={deleteSelectedView}
                    disabled={savedViewBusy}
                    style={{...savedViewGhostBtnS, color: '#b91c1c', borderColor: '#fecaca'}}
                  >
                    Delete
                  </button>
                </>
              )}
              <span style={{flex: 1}} />
              {savedViewNotice && (
                <span style={{fontSize: 12, color: savedViewNotice.kind === 'success' ? '#065f46' : '#b91c1c'}}>
                  {savedViewNotice.message}
                </span>
              )}
              <button
                type="button"
                data-equipment-fuel-log-saved-view-save-open
                onClick={openSaveViewForm}
                disabled={savedViewBusy || savedViewsLoading}
                style={savedViewPrimaryBtnS}
              >
                Save current view
              </button>
            </>
          )}
        </div>
      )}
      {EXTENDED_LIST_CONTROLS_ENABLED && showSaveViewForm && (
        <div
          data-equipment-fuel-log-saved-view-form
          style={{
            background: 'white',
            border: '1px solid #d6d3d1',
            borderRadius: 10,
            padding: '10px 14px',
            marginBottom: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <input
            data-equipment-fuel-log-saved-view-name
            type="text"
            value={saveViewName}
            placeholder="View name"
            onChange={(e) => setSaveViewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitSaveView();
            }}
            style={{...inpS, flex: 1, minWidth: 200}}
          />
          <label style={savedViewRadioLabelS}>
            <input
              type="radio"
              name="saveEquipmentFuelLogViewVisibility"
              checked={saveViewVisibility === 'private'}
              onChange={() => setSaveViewVisibility('private')}
              data-equipment-fuel-log-saved-view-visibility="private"
            />
            Private
          </label>
          <label style={savedViewRadioLabelS}>
            <input
              type="radio"
              name="saveEquipmentFuelLogViewVisibility"
              checked={saveViewVisibility === 'public'}
              onChange={() => setSaveViewVisibility('public')}
              data-equipment-fuel-log-saved-view-visibility="public"
            />
            Public
          </label>
          <button
            type="button"
            data-equipment-fuel-log-saved-view-save
            onClick={submitSaveView}
            disabled={savedViewBusy}
            style={savedViewPrimaryBtnS}
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setShowSaveViewForm(false)}
            disabled={savedViewBusy}
            style={savedViewGhostBtnS}
          >
            Cancel
          </button>
        </div>
      )}
      {EXTENDED_LIST_CONTROLS_ENABLED && (
        <div
          style={{
            background: 'white',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '12px 16px',
            marginBottom: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <select value={eqFilter} onChange={(e) => setEqFilter(e.target.value)} style={{...inpS, width: 'auto'}}>
            <option value="">All equipment</option>
            {equipment.map((eq) => (
              <option key={eq.id} value={eq.id}>
                {eq.name}
              </option>
            ))}
          </select>
          <select value={fuelFilter} onChange={(e) => setFuelFilter(e.target.value)} style={{...inpS, width: 'auto'}}>
            <option value="">All fuel types</option>
            <option value="diesel">Diesel</option>
            <option value="gasoline">Gasoline</option>
            <option value="def">DEF</option>
          </select>
          <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} style={{...inpS, width: 'auto'}}>
            <option value="">All team members</option>
            {teamMembers.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            style={inpS}
            title="From date"
          />
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={inpS} title="To date" />
          <button
            onClick={() => {
              setEqFilter('');
              setFuelFilter('');
              setTeamFilter('');
              setFromDate('');
              setToDate('');
            }}
            style={{
              padding: '7px 14px',
              borderRadius: 10,
              border: '1px solid var(--border-strong)',
              background: 'white',
              color: 'var(--ink)',
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Clear
          </button>
          <button
            type="button"
            data-equipment-fuel-log-export-csv="1"
            onClick={handleExportCsv}
            style={{
              padding: '7px 14px',
              borderRadius: 10,
              border: '1px solid var(--border-strong)',
              background: 'white',
              color: 'var(--ink)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Export CSV
          </button>
          <button
            type="button"
            data-equipment-fuel-log-print="1"
            onClick={handlePrintRows}
            style={{
              padding: '7px 14px',
              borderRadius: 10,
              border: '1px solid var(--border-strong)',
              background: 'white',
              color: 'var(--ink)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Print
          </button>
        </div>
      )}

      {exportNotice && <div style={{marginBottom: 14, color: '#b91c1c', fontSize: 12}}>{exportNotice}</div>}

      <div
        style={{
          background: 'white',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: '12px 18px',
          marginBottom: 14,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 14,
          fontSize: 11,
        }}
      >
        <div>
          <div style={{color: 'var(--ink-faint)', fontSize: 10, textTransform: 'uppercase'}}>Entries</div>
          <div style={{fontSize: 18, fontWeight: 700, color: 'var(--ink)'}}>{totals.count.toLocaleString()}</div>
        </div>
        <div>
          <div style={{color: 'var(--ink-faint)', fontSize: 10, textTransform: 'uppercase'}}>Gallons</div>
          <div style={{fontSize: 18, fontWeight: 700, color: '#1e40af'}}>
            {Math.round(totals.gallons).toLocaleString()}
          </div>
        </div>
        {totals.def_gallons > 0 && (
          <div>
            <div style={{color: 'var(--ink-faint)', fontSize: 10, textTransform: 'uppercase'}}>DEF Gal</div>
            <div style={{fontSize: 18, fontWeight: 700, color: '#a16207'}}>
              {Math.round(totals.def_gallons).toLocaleString()}
            </div>
          </div>
        )}
        {totals.cost > 0 && (
          <div>
            <div style={{color: 'var(--ink-faint)', fontSize: 10, textTransform: 'uppercase'}}>Cost</div>
            <div style={{fontSize: 18, fontWeight: 700, color: '#065f46'}}>
              ${Math.round(totals.cost).toLocaleString()}
            </div>
          </div>
        )}
      </div>

      <div
        data-mobile-hscroll="1"
        style={{background: 'white', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden'}}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '90px 1fr 90px 70px 60px 80px 110px 1fr',
            columnGap: 14,
            background: 'var(--surface-2)',
            padding: '10px 14px',
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--ink-muted)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            borderBottom: '1px solid var(--border)',
            minWidth: 700,
          }}
        >
          <div>Date</div>
          <div>Equipment</div>
          <div>Fuel</div>
          <div style={{textAlign: 'right'}}>Gal</div>
          <div style={{textAlign: 'right'}}>DEF</div>
          <div style={{textAlign: 'right'}}>Reading</div>
          <div>Team</div>
          <div>Comments</div>
        </div>
        {filtered.length === 0 && (
          <div style={{padding: '2rem', textAlign: 'center', color: 'var(--ink-faint)', fontSize: 13}}>
            No fueling entries match the current filters.
          </div>
        )}
        {filtered.slice(0, 500).map((f, i) => {
          const eq = eqById[f.equipment_id];
          const reading =
            f.hours_reading != null
              ? Math.round(f.hours_reading) + ' h'
              : f.km_reading != null
                ? Math.round(f.km_reading) + ' km'
                : '—';
          return (
            <div
              key={f.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '90px 1fr 90px 70px 60px 80px 110px 1fr',
                columnGap: 14,
                padding: '6px 14px',
                fontSize: 12,
                borderBottom: i < Math.min(500, filtered.length) - 1 ? '1px solid var(--divider)' : 'none',
                fontVariantNumeric: 'tabular-nums',
                minWidth: 700,
              }}
            >
              <div style={{color: 'var(--ink)'}}>{fmt(f.date)}</div>
              <div
                style={{
                  fontWeight: 600,
                  color: 'var(--ink)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {eq ? eq.name : f.equipment_id}
              </div>
              <div style={{color: 'var(--ink-muted)'}}>{f.fuel_type || '—'}</div>
              <div style={{textAlign: 'right', color: '#1e40af', fontWeight: 600}}>
                {f.gallons ? Math.round(f.gallons * 10) / 10 : '—'}
              </div>
              <div style={{textAlign: 'right', color: '#a16207', fontWeight: 600}}>
                {f.def_gallons ? Math.round(f.def_gallons * 10) / 10 : '—'}
              </div>
              <div style={{textAlign: 'right', color: 'var(--ink-muted)'}}>{reading}</div>
              <div style={{color: 'var(--ink-muted)'}}>{f.team_member || '—'}</div>
              <div
                style={{
                  color: 'var(--ink-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontStyle: stripPodioHtml(f.comments) ? 'italic' : 'normal',
                }}
              >
                {stripPodioHtml(f.comments) || '—'}
              </div>
            </div>
          );
        })}
        {filtered.length > 500 && (
          <div
            style={{
              padding: '10px 14px',
              background: 'var(--surface-2)',
              color: 'var(--ink-faint)',
              fontSize: 11,
              textAlign: 'center',
            }}
          >
            Showing first 500 of {filtered.length.toLocaleString()} entries. Narrow the filters to see more.
          </div>
        )}
      </div>
    </div>
  );
}
