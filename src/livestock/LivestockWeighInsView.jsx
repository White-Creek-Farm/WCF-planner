import React from 'react';
import {useNavigate} from 'react-router-dom';
import {recordSeqNavOptions} from '../lib/recordSequence.js';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {printRows} from '../lib/printExport.js';
import {listSavedViews, createSavedView, updateSavedView, deleteSavedView} from '../lib/savedViewsApi.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import AdminNewWeighInModal from '../shared/AdminNewWeighInModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import UsersModal from '../auth/UsersModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';
import InlineNotice from '../shared/InlineNotice.jsx';
import {
  formatAgeRange,
  formatFeedPerPig,
  formatGroupAdg,
  formatAvgWeight,
  findPriorPigWeighInSession,
  computeRankMatchedPigEntryADG,
} from '../lib/pigForecast.js';
import {usePersistentViewState} from '../lib/usePersistentViewState.js';

const WEIGHIN_SESSION_SURFACE_KEYS = {pig: 'pig.weighins', broiler: 'broiler.weighins'};
const VALID_WEIGHIN_STATUS_FILTERS = new Set(['all', 'draft', 'complete']);

const LivestockWeighInsView = ({
  sb,
  fmt,
  // eslint-disable-next-line no-unused-vars -- JSX-only use
  Header,
  authState,
  setView: _setView,
  showUsers,
  setShowUsers,
  allUsers,
  setAllUsers,
  loadUsers,
  species,
}) => {
  const navigate = useNavigate();
  const {useState, useEffect} = React;
  const [sessions, setSessions] = useState([]);
  const [entries, setEntries] = useState({});
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = usePersistentViewState(`${species}.weighins.statusFilter`, 'all');
  const [showNewModal, setShowNewModal] = useState(false);
  const [pigMetricsBySession, setPigMetricsBySession] = useState({});
  const [notice, setNotice] = useState(null);
  const [exportNotice, setExportNotice] = useState('');
  const [savedViews, setSavedViews] = useState([]);
  const [savedViewsError, setSavedViewsError] = useState(null);
  const [savedViewsLoading, setSavedViewsLoading] = useState(true);
  const [selectedViewId, setSelectedViewId] = useState('');
  const [showSaveViewForm, setShowSaveViewForm] = useState(false);
  const [saveViewName, setSaveViewName] = useState('');
  const [saveViewVisibility, setSaveViewVisibility] = useState('private');
  const [savedViewBusy, setSavedViewBusy] = useState(false);
  const [savedViewNotice, setSavedViewNotice] = useState(null);
  const myProfileId = authState?.user?.id || null;

  const speciesLabel = species === 'broiler' ? 'Broiler' : 'Pig';
  const savedViewSurfaceKey = WEIGHIN_SESSION_SURFACE_KEYS[species] || species + '.weighins';

  async function loadAll() {
    setLoading(true);
    setNotice(null);
    try {
      const sR = await sb
        .from('weigh_in_sessions')
        .select('*')
        .eq('species', species)
        .order('date', {ascending: false})
        .order('started_at', {ascending: false});
      if (sR.error) throw new Error('weigh_in_sessions: ' + (sR.error.message || sR.error));

      const sessionRows = sR.data || [];
      setSessions(sessionRows);
      if (sessionRows.length > 0) {
        const ids = sessionRows.map((s) => s.id);
        const eR = await sb.from('weigh_ins').select('*').in('session_id', ids).order('entered_at', {ascending: true});
        if (eR.error) throw new Error('weigh_ins: ' + (eR.error.message || eR.error));
        const m = {};
        (eR.data || []).forEach((e) => {
          if (!m[e.session_id]) m[e.session_id] = [];
          m[e.session_id].push(e);
        });
        setEntries(m);
      } else {
        setEntries({});
      }
    } catch (e) {
      setSessions([]);
      setEntries({});
      setPigMetricsBySession({});
      setNotice({
        kind: 'error',
        message:
          'Could not load ' +
          speciesLabel.toLowerCase() +
          ' weigh-in sessions. Please refresh the page. (' +
          (e.message || e) +
          ')',
      });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    loadAll();
  }, [species]);

  async function loadSavedViews() {
    setSavedViewsLoading(true);
    try {
      const rows = await listSavedViews(sb, savedViewSurfaceKey);
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

  useEffect(() => {
    setSelectedViewId('');
    setSavedViewNotice(null);
    loadSavedViews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedViewSurfaceKey]);

  useEffect(() => {
    if (species !== 'pig' || sessions.length === 0) {
      setPigMetricsBySession({});
      return;
    }
    let cancelled = false;
    Promise.all(
      sessions.map((s) =>
        sb
          .rpc('pig_session_metrics', {session_id_in: s.id})
          .then(({data, error}) => ({
            id: s.id,
            data: error ? {available: false} : data || {available: false},
          }))
          .catch(() => ({id: s.id, data: {available: false}})),
      ),
    ).then((results) => {
      if (cancelled) return;
      const next = {};
      for (const r of results) next[r.id] = r.data;
      setPigMetricsBySession(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [species, sessions, entries]);

  const filtered = sessions.filter((s) => statusFilter === 'all' || s.status === statusFilter);
  const totalEntries = filtered.reduce((s, sess) => s + (entries[sess.id] ? entries[sess.id].length : 0), 0);
  const loadFailed = !!notice;
  const selectedView = savedViews.find((v) => v.id === selectedViewId) || null;
  const selectedViewIsMine = !!(selectedView && myProfileId && selectedView.owner_profile_id === myProfileId);
  const emptyStateKind = sessions.length === 0 ? 'none' : 'filtered';
  const emptyStateMessage =
    emptyStateKind === 'none'
      ? 'No ' + speciesLabel.toLowerCase() + ' weigh-in sessions yet.'
      : 'No ' + speciesLabel.toLowerCase() + ' weigh-in sessions match the current filters.';
  const emptyStateHint =
    emptyStateKind === 'none' ? 'Click New Weigh-In to start one.' : 'Switch back to All to see every session.';

  function livestockWeighInsViewState() {
    return {
      statusFilter: VALID_WEIGHIN_STATUS_FILTERS.has(statusFilter) ? statusFilter : 'all',
    };
  }

  function applyLivestockSavedView(view) {
    if (!view) return;
    const st = view.view_state || {};
    setStatusFilter(VALID_WEIGHIN_STATUS_FILTERS.has(st.statusFilter) ? st.statusFilter : 'all');
    setSavedViewNotice(null);
  }

  function onSelectSavedView(id) {
    setSelectedViewId(id);
    setSavedViewNotice(null);
    if (!id) return;
    applyLivestockSavedView(savedViews.find((v) => v.id === id));
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
        surfaceKey: savedViewSurfaceKey,
        name,
        visibility: saveViewVisibility,
        viewState: livestockWeighInsViewState(),
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
      await updateSavedView(sb, selectedView.id, {viewState: livestockWeighInsViewState()});
      await loadSavedViews();
      setSavedViewNotice({
        kind: 'success',
        message: 'Updated "' + selectedView.name + '" to the current filter.',
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

  function livestockWeighInsExportColumns() {
    return [
      {header: 'Date', value: (s) => s.date || ''},
      {header: 'Species', value: () => speciesLabel},
      {header: 'Batch ID', value: (s) => s.batch_id || ''},
      {header: 'Broiler week', value: (s) => (species === 'broiler' ? s.broiler_week || '' : '')},
      {header: 'Status', value: (s) => s.status || ''},
      {header: 'Team member', value: (s) => s.team_member || ''},
      {header: 'Entry count', value: (s) => (entries[s.id] || []).length},
      {
        header: 'Average weight',
        value: (s) => {
          const sEntries = entries[s.id] || [];
          if (sEntries.length === 0) return '';
          const avg = sEntries.reduce((sum, e) => sum + (parseFloat(e.weight) || 0), 0) / sEntries.length;
          return Math.round(avg * 100) / 100;
        },
      },
      {header: 'Started at', value: (s) => s.started_at || ''},
      {header: 'Session ID', value: (s) => s.id || ''},
    ];
  }

  function handleExportCsv() {
    const columns = livestockWeighInsExportColumns();
    const ok = downloadCsv(csvFilename(species + '-weigh-in-sessions'), rowsToCsv(columns, filtered));
    setExportNotice(ok ? '' : 'CSV export is only available in the browser.');
  }

  function handlePrintRows() {
    const columns = livestockWeighInsExportColumns();
    const ok = printRows({
      title: speciesLabel + ' Weigh-In Sessions',
      subtitle: filtered.length + ' filtered weigh-in sessions',
      columns,
      rows: filtered,
    });
    setExportNotice(ok ? '' : 'Print is only available in the browser.');
  }

  const myViews = savedViews.filter((v) => myProfileId && v.owner_profile_id === myProfileId);
  const publicOtherViews = savedViews.filter(
    (v) => v.visibility === 'public' && !(myProfileId && v.owner_profile_id === myProfileId),
  );
  const savedViewInputS = {
    fontFamily: 'inherit',
    fontSize: 12,
    padding: '6px 10px',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    boxSizing: 'border-box',
    background: 'white',
    color: '#111827',
  };
  const savedViewGhostBtnS = {
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    background: 'white',
    color: '#374151',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  };
  const savedViewPrimaryBtnS = {...savedViewGhostBtnS, border: '1px solid #1e40af', color: '#1e40af'};
  const savedViewRadioLabelS = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    color: '#374151',
    cursor: 'pointer',
  };

  return (
    <div
      style={{minHeight: '100vh', background: '#f1f3f2'}}
      data-weighin-list-loaded={loading || loadFailed ? 'false' : 'true'}
    >
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
      <div style={{padding: '1rem', maxWidth: 1100, margin: '0 auto'}}>
        <InlineNotice notice={notice} />
        {loadFailed && (
          <button
            type="button"
            onClick={loadAll}
            style={{
              padding: '7px 14px',
              borderRadius: 7,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#1e40af',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              marginBottom: 12,
            }}
          >
            Retry
          </button>
        )}
        {!loadFailed && (
          <>
            <div
              data-livestock-weighins-saved-views-row
              style={{
                background: 'white',
                border: '1px solid #e5e7eb',
                borderRadius: 10,
                padding: '10px 14px',
                marginBottom: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <span style={{fontSize: 11, color: '#6b7280', fontWeight: 600}}>Saved views</span>
              {savedViewsError ? (
                <span style={{fontSize: 12, color: '#b91c1c'}} data-livestock-weighins-saved-views-error>
                  Saved views unavailable. Filters still work.
                </span>
              ) : (
                <>
                  <select
                    data-livestock-weighins-saved-view-select
                    value={selectedViewId}
                    disabled={savedViewsLoading}
                    onChange={(e) => onSelectSavedView(e.target.value)}
                    style={{...savedViewInputS, width: 'auto', minWidth: 200}}
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
                        data-livestock-weighins-saved-view-update
                        onClick={updateSelectedView}
                        disabled={savedViewBusy}
                        style={savedViewGhostBtnS}
                      >
                        Update to current
                      </button>
                      <button
                        type="button"
                        data-livestock-weighins-saved-view-delete
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
                    data-livestock-weighins-saved-view-save-open
                    onClick={openSaveViewForm}
                    disabled={savedViewBusy || savedViewsLoading}
                    style={savedViewPrimaryBtnS}
                  >
                    Save current view
                  </button>
                </>
              )}
            </div>
            {showSaveViewForm && (
              <div
                data-livestock-weighins-saved-view-form
                style={{
                  background: 'white',
                  border: '1px solid #bfdbfe',
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
                  data-livestock-weighins-saved-view-name
                  type="text"
                  value={saveViewName}
                  placeholder="View name"
                  onChange={(e) => setSaveViewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitSaveView();
                  }}
                  style={{...savedViewInputS, flex: 1, minWidth: 200}}
                />
                <label style={savedViewRadioLabelS}>
                  <input
                    type="radio"
                    name={'saveLivestockWeighInsViewVisibility-' + species}
                    checked={saveViewVisibility === 'private'}
                    onChange={() => setSaveViewVisibility('private')}
                    data-livestock-weighins-saved-view-visibility="private"
                  />
                  Private
                </label>
                <label style={savedViewRadioLabelS}>
                  <input
                    type="radio"
                    name={'saveLivestockWeighInsViewVisibility-' + species}
                    checked={saveViewVisibility === 'public'}
                    onChange={() => setSaveViewVisibility('public')}
                    data-livestock-weighins-saved-view-visibility="public"
                  />
                  Public
                </label>
                <button
                  type="button"
                  data-livestock-weighins-saved-view-save
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
          </>
        )}
        {exportNotice && <div style={{marginBottom: 14, color: '#b91c1c', fontSize: 12}}>{exportNotice}</div>}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <div>
            <div style={{fontSize: 16, fontWeight: 700, color: '#111827'}}>{speciesLabel} Weigh-In Sessions</div>
            <div style={{fontSize: 12, color: '#6b7280', marginTop: 2}}>
              {filtered.length} sessions {'·'} {totalEntries} total entries
            </div>
          </div>
          <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
            <div style={{display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #d1d5db'}}>
              {[
                {k: 'all', l: 'All'},
                {k: 'draft', l: 'Drafts'},
                {k: 'complete', l: 'Complete'},
              ].map((o, oi) => (
                <button
                  key={o.k}
                  onClick={() => setStatusFilter(o.k)}
                  style={{
                    padding: '5px 10px',
                    border: 'none',
                    borderRight: oi < 2 ? '1px solid #d1d5db' : 'none',
                    fontFamily: 'inherit',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    background: statusFilter === o.k ? '#1e40af' : 'white',
                    color: statusFilter === o.k ? 'white' : '#6b7280',
                  }}
                >
                  {o.l}
                </button>
              ))}
            </div>
            <button
              type="button"
              data-livestock-weighins-export-csv="1"
              onClick={handleExportCsv}
              disabled={loading || loadFailed}
              style={{
                padding: '7px 14px',
                borderRadius: 7,
                border: '1px solid #d1d5db',
                background: loading || loadFailed ? '#f9fafb' : 'white',
                color: loading || loadFailed ? '#9ca3af' : '#374151',
                fontWeight: 600,
                fontSize: 12,
                cursor: loading || loadFailed ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Export CSV
            </button>
            <button
              type="button"
              data-livestock-weighins-print="1"
              onClick={handlePrintRows}
              disabled={loading || loadFailed}
              style={{
                padding: '7px 14px',
                borderRadius: 7,
                border: '1px solid #d1d5db',
                background: loading || loadFailed ? '#f9fafb' : 'white',
                color: loading || loadFailed ? '#9ca3af' : '#374151',
                fontWeight: 600,
                fontSize: 12,
                cursor: loading || loadFailed ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Print
            </button>
            <button
              onClick={() => setShowNewModal(true)}
              style={{
                padding: '7px 14px',
                borderRadius: 7,
                border: 'none',
                background: '#1e40af',
                color: 'white',
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <PlannerIcon iconKey="weighins" size={16} />
              <span>New Weigh-In</span>
            </button>
          </div>
        </div>
        {showNewModal && (
          <AdminNewWeighInModal
            sb={sb}
            species={species}
            authState={authState}
            onClose={() => setShowNewModal(false)}
            onCreated={(rec) => {
              setShowNewModal(false);
              navigate('/weigh-in-sessions/' + rec.id);
            }}
          />
        )}

        {loading && <div style={{textAlign: 'center', padding: '2rem', color: '#9ca3af'}}>Loading{'…'}</div>}
        {!loading && !loadFailed && filtered.length === 0 && (
          <div
            data-weighin-empty-state="1"
            data-weighin-empty-kind={emptyStateKind}
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
            <div style={{fontWeight: 700, color: '#374151', marginBottom: 4}}>{emptyStateMessage}</div>
            <div>{emptyStateHint}</div>
          </div>
        )}

        <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
          {!loadFailed &&
            filtered.map((s) => {
              const sEntries = entries[s.id] || [];
              const avgWeight =
                sEntries.length > 0
                  ? sEntries.reduce((sum, e) => sum + (parseFloat(e.weight) || 0), 0) / sEntries.length
                  : 0;
              const isComplete = s.status === 'complete';
              const priorPigSession = species === 'pig' ? findPriorPigWeighInSession(s, sessions) : null;
              const pigEntryAdgs = priorPigSession
                ? computeRankMatchedPigEntryADG(
                    sEntries,
                    entries[priorPigSession.id] || [],
                    s.date,
                    priorPigSession.date,
                  )
                : [];
              return (
                <div
                  key={s.id}
                  style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden'}}
                >
                  <div
                    data-weighin-session-tile={s.id}
                    onClick={() =>
                      navigate(
                        '/weigh-in-sessions/' + s.id,
                        recordSeqNavOptions(
                          filtered.map((r) => ({id: r.id, label: (r.date || '') + ' · ' + (r.batch_id || species)})),
                        ),
                      )
                    }
                    style={{
                      padding: '10px 16px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      flexWrap: 'wrap',
                    }}
                    className="hoverable-tile"
                  >
                    <span style={{fontSize: 13, fontWeight: 700, color: '#111827', minWidth: 120}}>
                      {s.batch_id || 'Unknown batch'}
                    </span>
                    {species === 'broiler' && s.broiler_week && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: 10,
                          background: '#fef3c7',
                          color: '#92400e',
                        }}
                      >
                        {'WK ' + s.broiler_week}
                      </span>
                    )}
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: 10,
                        background: isComplete ? '#d1fae5' : '#fef3c7',
                        color: isComplete ? '#065f46' : '#92400e',
                        textTransform: 'uppercase',
                      }}
                    >
                      {s.status}
                    </span>
                    <span style={{fontSize: 11, color: '#6b7280'}}>{fmt(s.date)}</span>
                    <span style={{fontSize: 11, color: '#6b7280'}}>{s.team_member}</span>
                    <span style={{fontSize: 11, fontWeight: 600, color: '#1e40af'}}>
                      {sEntries.length} {sEntries.length === 1 ? 'entry' : 'entries'}
                    </span>
                    {species !== 'pig' && avgWeight > 0 && (
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: '#065f46',
                          padding: '2px 10px',
                          borderRadius: 10,
                          background: '#d1fae5',
                        }}
                      >
                        avg {Math.round(avgWeight * 100) / 100} lb
                      </span>
                    )}
                    {species === 'broiler' && avgWeight > 0 && s.broiler_week && (
                      <span style={{fontSize: 10, color: '#6b7280', fontStyle: 'italic'}}>
                        {'→ batch wk' + s.broiler_week + 'Lbs'}
                      </span>
                    )}
                  </div>
                  {species === 'pig' &&
                    sEntries.length > 0 &&
                    pigMetricsBySession[s.id] &&
                    pigMetricsBySession[s.id].available && (
                      <div
                        data-pig-metrics-row={s.id}
                        style={{
                          padding: '8px 16px',
                          borderTop: '1px solid #f3f4f6',
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                          gap: 8,
                          background: '#fafafa',
                        }}
                      >
                        <div data-pig-metric="age">
                          <div style={{fontSize: 9, color: '#6b7280', textTransform: 'uppercase'}}>Age at weigh-in</div>
                          <div style={{fontSize: 12, fontWeight: 700, color: '#111827'}}>
                            {formatAgeRange({
                              minDays: pigMetricsBySession[s.id].age_min_days,
                              maxDays: pigMetricsBySession[s.id].age_max_days,
                              hasActual: pigMetricsBySession[s.id].has_actual_farrowing,
                            })}
                          </div>
                        </div>
                        <div data-pig-metric="feed">
                          <div style={{fontSize: 9, color: '#6b7280', textTransform: 'uppercase'}}>Feed/pig</div>
                          <div style={{fontSize: 12, fontWeight: 700, color: '#111827'}}>
                            {formatFeedPerPig(pigMetricsBySession[s.id].feed_per_pig_lbs)}
                          </div>
                        </div>
                        <div data-pig-metric="adg">
                          <div style={{fontSize: 9, color: '#6b7280', textTransform: 'uppercase'}}>Group ADG</div>
                          <div style={{fontSize: 12, fontWeight: 700, color: '#111827'}}>
                            {formatGroupAdg(pigMetricsBySession[s.id].group_adg_lbs_per_day)}
                          </div>
                        </div>
                        <div data-pig-metric="avg">
                          <div style={{fontSize: 9, color: '#6b7280', textTransform: 'uppercase'}}>Avg weight</div>
                          <div style={{fontSize: 12, fontWeight: 700, color: '#111827'}}>
                            {formatAvgWeight(pigMetricsBySession[s.id].avg_weight_lbs)}
                          </div>
                        </div>
                        {pigEntryAdgs.length > 0 && (
                          <div data-pig-metric="entry-adg" style={{gridColumn: '1 / -1'}}>
                            <div style={{fontSize: 9, color: '#6b7280', textTransform: 'uppercase'}}>
                              Rank-matched pig ADG
                            </div>
                            <div style={{display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 3}}>
                              {pigEntryAdgs.map((m) => (
                                <span
                                  key={m.entryId || m.rank}
                                  title={
                                    'rank ' +
                                    m.rank +
                                    ' vs prior ' +
                                    fmt(m.priorDate) +
                                    ' at ' +
                                    Math.round(m.priorWeightLbs) +
                                    ' lb'
                                  }
                                  style={{
                                    fontSize: 10,
                                    fontWeight: 700,
                                    color: m.adgLbsPerDay >= 0 ? '#065f46' : '#b91c1c',
                                    background: m.adgLbsPerDay >= 0 ? '#ecfdf5' : '#fef2f2',
                                    border: '1px solid ' + (m.adgLbsPerDay >= 0 ? '#a7f3d0' : '#fecaca'),
                                    borderRadius: 5,
                                    padding: '2px 6px',
                                  }}
                                >
                                  {Math.round(m.currentWeightLbs) +
                                    ' lb ' +
                                    (m.adgLbsPerDay >= 0 ? '+' : '') +
                                    m.adgLbsPerDay.toFixed(2) +
                                    ' lb/day'}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
};

export default LivestockWeighInsView;
