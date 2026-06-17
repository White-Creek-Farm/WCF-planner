import React from 'react';
import {useNavigate} from 'react-router-dom';
import {recordSeqNavOptions} from '../lib/recordSequence.js';
import {averageEntryWeight, buildLivestockWeighInSessionColumns} from '../lib/weighInSessionExports.js';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {printRows} from '../lib/printExport.js';
import {listSavedViews, createSavedView, updateSavedView, deleteSavedView} from '../lib/savedViewsApi.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import AdminNewWeighInModal from '../shared/AdminNewWeighInModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import DataTable from '../shared/DataTable.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import Badge from '../shared/Badge.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import StatusText from '../shared/StatusText.jsx';
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
const EXTENDED_LIST_CONTROLS_ENABLED = false;

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
  // Compact-list controls are only retained on cattle herds, sheep flocks, and
  // daily views. Pig also keeps its active/complete section split.
  const isPig = species === 'pig';
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
    if (isPig || !EXTENDED_LIST_CONTROLS_ENABLED) {
      // This list has no saved views; never load or render them.
      setSavedViews([]);
      setSavedViewsError(null);
      setSavedViewsLoading(false);
      setSelectedViewId('');
      setSavedViewNotice(null);
      return;
    }
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
  const visibleSessions = EXTENDED_LIST_CONTROLS_ENABLED && !isPig ? filtered : sessions;
  const visibleTotalEntries = visibleSessions.reduce(
    (s, sess) => s + (entries[sess.id] ? entries[sess.id].length : 0),
    0,
  );
  const loadFailed = !!notice;
  const selectedView = savedViews.find((v) => v.id === selectedViewId) || null;
  const selectedViewIsMine = !!(selectedView && myProfileId && selectedView.owner_profile_id === myProfileId);
  const emptyStateKind = sessions.length === 0 ? 'none' : 'filtered';
  // Pig never filters, so its empty state is always the plain "none" copy.
  const emptyStateMessage =
    isPig || emptyStateKind === 'none'
      ? 'No ' + speciesLabel.toLowerCase() + ' weigh-in sessions yet.'
      : 'No ' + speciesLabel.toLowerCase() + ' weigh-in sessions match the current filters.';
  const emptyStateHint =
    isPig || emptyStateKind === 'none'
      ? 'Click New Weigh-In to start one.'
      : 'Switch back to All to see every session.';

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
    return buildLivestockWeighInSessionColumns({
      species,
      speciesLabel,
      entriesBySession: entries,
    });
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
    border: '1px solid var(--border-strong)',
    borderRadius: 10,
    boxSizing: 'border-box',
    background: 'white',
    color: 'var(--ink)',
  };
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
  const savedViewPrimaryBtnS = {...savedViewGhostBtnS, border: '1px solid #1e40af', color: '#1e40af'};
  const savedViewRadioLabelS = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    color: 'var(--ink)',
    cursor: 'pointer',
  };

  return (
    <div
      style={{minHeight: '100vh', background: 'var(--bg-page)'}}
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
              borderRadius: 10,
              border: '1px solid var(--border-strong)',
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
        {EXTENDED_LIST_CONTROLS_ENABLED && !loadFailed && !isPig && (
          <>
            <div
              data-livestock-weighins-saved-views-row
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
            <div style={{fontSize: 16, fontWeight: 700, color: 'var(--ink)'}}>{speciesLabel} Weigh-In Sessions</div>
            <div style={{fontSize: 12, color: 'var(--ink-muted)', marginTop: 2}}>
              {visibleSessions.length} sessions {'·'} {visibleTotalEntries} total entries
            </div>
          </div>
          <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
            {EXTENDED_LIST_CONTROLS_ENABLED && !isPig && (
              <>
                <div
                  style={{
                    display: 'flex',
                    borderRadius: 10,
                    overflow: 'hidden',
                    border: '1px solid var(--border-strong)',
                  }}
                >
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
                        borderRight: oi < 2 ? '1px solid var(--border-strong)' : 'none',
                        fontFamily: 'inherit',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        background: 'white',
                        color: statusFilter === o.k ? '#1e40af' : 'var(--ink-muted)',
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
                    borderRadius: 10,
                    border: '1px solid var(--border-strong)',
                    background: loading || loadFailed ? 'var(--surface-2)' : 'white',
                    color: loading || loadFailed ? 'var(--ink-faint)' : 'var(--ink)',
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
                    borderRadius: 10,
                    border: '1px solid var(--border-strong)',
                    background: loading || loadFailed ? 'var(--surface-2)' : 'white',
                    color: loading || loadFailed ? 'var(--ink-faint)' : 'var(--ink)',
                    fontWeight: 600,
                    fontSize: 12,
                    cursor: loading || loadFailed ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Print
                </button>
              </>
            )}
            <button
              onClick={() => setShowNewModal(true)}
              style={{
                padding: '7px 14px',
                borderRadius: 10,
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

        {loading && <div style={{textAlign: 'center', padding: '2rem', color: 'var(--ink-faint)'}}>Loading{'…'}</div>}
        {!loading && !loadFailed && visibleSessions.length === 0 && (
          <div
            data-weighin-empty-state="1"
            data-weighin-empty-kind={emptyStateKind}
            style={{
              background: 'white',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: '2rem',
              textAlign: 'center',
              color: 'var(--ink-muted)',
              fontSize: 13,
            }}
          >
            <div style={{fontWeight: 700, color: 'var(--ink)', marginBottom: 4}}>{emptyStateMessage}</div>
            <div>{emptyStateHint}</div>
          </div>
        )}

        {!loadFailed &&
          !loading &&
          (isPig ? sessions.length > 0 : filtered.length > 0) &&
          (() => {
            // Each session row carries the same derived facts the old card showed:
            // average entry weight (broiler) and the pig metric/ADG bundle (pig).
            const openSession = (s) =>
              navigate(
                '/weigh-in-sessions/' + s.id,
                recordSeqNavOptions(
                  filtered.map((r) => ({id: r.id, label: (r.date || '') + ' · ' + (r.batch_id || species)})),
                ),
              );

            const columns = [
              {
                key: 'label',
                label: 'Session',
                primary: true,
                render: (s) => {
                  const avgWeight = averageEntryWeight(entries[s.id] || []);
                  return (
                    <span style={{display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
                      {species === 'broiler' && s.broiler_week ? (
                        <Badge variant="warn">{'WK ' + s.broiler_week}</Badge>
                      ) : null}
                      <span>{s.batch_id || 'Unknown batch'}</span>
                      {species === 'broiler' && avgWeight > 0 && s.broiler_week ? (
                        <StatusText tone="muted" style={{fontStyle: 'italic', fontWeight: 400}}>
                          {'→ batch wk' + s.broiler_week + 'Lbs'}
                        </StatusText>
                      ) : null}
                    </span>
                  );
                },
              },
              {
                key: 'status',
                label: 'Status',
                render: (s) => <Badge variant={s.status === 'complete' ? 'ok' : 'warn'}>{s.status}</Badge>,
              },
              {key: 'date', label: 'Date', render: (s) => fmt(s.date)},
              {
                key: 'team',
                label: 'Team',
                render: (s) => s.team_member || <StatusText tone="muted">{'—'}</StatusText>,
              },
              {
                key: 'entries',
                label: 'Entries',
                align: 'right',
                render: (s) => (entries[s.id] || []).length,
              },
            ];

            if (species === 'pig') {
              const metric = (s) => pigMetricsBySession[s.id];
              const hasMetrics = (s) => (entries[s.id] || []).length > 0 && metric(s) && metric(s).available;
              columns.push(
                {
                  key: 'age',
                  label: 'Age at weigh-in',
                  align: 'right',
                  mobilePriority: false,
                  render: (s) =>
                    hasMetrics(s) ? (
                      formatAgeRange({
                        minDays: metric(s).age_min_days,
                        maxDays: metric(s).age_max_days,
                        hasActual: metric(s).has_actual_farrowing,
                      })
                    ) : (
                      <StatusText tone="muted">{'—'}</StatusText>
                    ),
                },
                {
                  key: 'feedPerPig',
                  label: 'Feed/pig',
                  align: 'right',
                  mobilePriority: false,
                  render: (s) =>
                    hasMetrics(s) ? (
                      formatFeedPerPig(metric(s).feed_per_pig_lbs)
                    ) : (
                      <StatusText tone="muted">{'—'}</StatusText>
                    ),
                },
                {
                  key: 'groupAdg',
                  label: 'Group ADG',
                  align: 'right',
                  render: (s) => {
                    if (!hasMetrics(s)) return <StatusText tone="muted">{'—'}</StatusText>;
                    const v = metric(s).group_adg_lbs_per_day;
                    const num = v == null ? null : parseFloat(v);
                    const tone = num == null || !isFinite(num) ? 'muted' : num >= 0 ? 'ok' : 'danger';
                    return <StatusText tone={tone}>{formatGroupAdg(v)}</StatusText>;
                  },
                },
                {
                  key: 'avgWeight',
                  label: 'Avg weight',
                  align: 'right',
                  render: (s) =>
                    hasMetrics(s) ? (
                      formatAvgWeight(metric(s).avg_weight_lbs)
                    ) : (
                      <StatusText tone="muted">{'—'}</StatusText>
                    ),
                },
                {
                  key: 'entryAdg',
                  label: 'Rank-matched pig ADG',
                  mobilePriority: false,
                  render: (s) => {
                    const sEntries = entries[s.id] || [];
                    const priorPigSession = findPriorPigWeighInSession(s, sessions);
                    const pigEntryAdgs = priorPigSession
                      ? computeRankMatchedPigEntryADG(
                          sEntries,
                          entries[priorPigSession.id] || [],
                          s.date,
                          priorPigSession.date,
                        )
                      : [];
                    if (pigEntryAdgs.length === 0) return <StatusText tone="muted">{'—'}</StatusText>;
                    return (
                      <span data-pig-metric="entry-adg" style={{display: 'inline-flex', flexWrap: 'wrap', gap: 4}}>
                        {pigEntryAdgs.map((m) => (
                          <StatusText
                            key={m.entryId || m.rank}
                            tone={m.adgLbsPerDay >= 0 ? 'ok' : 'danger'}
                            title={
                              'rank ' +
                              m.rank +
                              ' vs prior ' +
                              fmt(m.priorDate) +
                              ' at ' +
                              Math.round(m.priorWeightLbs) +
                              ' lb'
                            }
                          >
                            {Math.round(m.currentWeightLbs) +
                              ' lb ' +
                              (m.adgLbsPerDay >= 0 ? '+' : '') +
                              m.adgLbsPerDay.toFixed(2) +
                              ' lb/day'}
                          </StatusText>
                        ))}
                      </span>
                    );
                  },
                },
              );
            } else {
              columns.push({
                key: 'avg',
                label: 'Avg weight',
                align: 'right',
                render: (s) => {
                  const avgWeight = averageEntryWeight(entries[s.id] || []);
                  return avgWeight > 0 ? (
                    <StatusText tone="ok">{'avg ' + Math.round(avgWeight * 100) / 100 + ' lb'}</StatusText>
                  ) : (
                    <StatusText tone="muted">{'—'}</StatusText>
                  );
                },
              });
            }

            const sharedProps = {
              surfaceKey: 'pig-and-shared-weighins-table',
              rowKey: 'id',
              density: 'comfortable',
              columns,
              onRowOpen: openSession,
              rowProps: (s) => ({'data-weighin-session-tile': s.id}),
            };

            if (isPig) {
              const activeRows = sessions.filter((s) => s.status !== 'complete');
              const completeRows = sessions.filter((s) => s.status === 'complete');
              return (
                <DataTable
                  {...sharedProps}
                  sections={[
                    {key: 'active', label: 'Active', rows: activeRows},
                    {key: 'complete', label: 'Complete', rows: completeRows},
                  ]}
                />
              );
            }
            return <DataTable {...sharedProps} rows={filtered} />;
          })()}
      </div>
    </div>
  );
};

export default LivestockWeighInsView;
