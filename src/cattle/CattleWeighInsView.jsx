import React from 'react';
import {useNavigate} from 'react-router-dom';
import {recordSeqNavOptions} from '../lib/recordSequence.js';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {printRows} from '../lib/printExport.js';
import {listSavedViews, createSavedView, updateSavedView, deleteSavedView} from '../lib/savedViewsApi.js';
import CattleNewWeighInModal from './CattleNewWeighInModal.jsx';
import UsersModal from '../auth/UsersModal.jsx';
import {loadCattleWeighInsCached} from '../lib/cattleCache.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';
import {usePersistentViewState} from '../lib/usePersistentViewState.js';

const HERD_LABELS = {mommas: 'Mommas', backgrounders: 'Backgrounders', finishers: 'Finishers', bulls: 'Bulls'};
const CATTLE_WEIGHINS_SURFACE_KEY = 'cattle.weighins';
const VALID_WEIGHIN_STATUS_FILTERS = new Set(['all', 'draft', 'complete']);

const CattleWeighInsView = ({
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
  const navigate = useNavigate();
  const {useState, useEffect} = React;
  const [sessions, setSessions] = useState([]);
  const [entries, setEntries] = useState({});
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = usePersistentViewState('cattle.weighins.statusFilter', 'all');
  const [showNewModal, setShowNewModal] = useState(false);
  const [tagSearch, setTagSearch] = usePersistentViewState('cattle.weighins.tagSearch', '');
  const [notice, setNotice] = useState(null);
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

  async function loadAll() {
    setLoading(true);
    setNotice(null);
    try {
      const [sR, eAll] = await Promise.all([
        sb
          .from('weigh_in_sessions')
          .select('*')
          .eq('species', 'cattle')
          .order('date', {ascending: false})
          .order('started_at', {ascending: false}),
        loadCattleWeighInsCached(sb, {throwOnError: true}),
      ]);
      if (sR.error) throw new Error('weigh_in_sessions: ' + (sR.error.message || sR.error));
      setSessions(sR.data || []);
      const m = {};
      (eAll || []).forEach((e) => {
        if (!m[e.session_id]) m[e.session_id] = [];
        m[e.session_id].push(e);
      });
      setEntries(m);
    } catch (e) {
      setSessions([]);
      setEntries({});
      setNotice({
        kind: 'error',
        message: 'Could not load cattle weigh-in sessions. Please refresh the page. (' + ((e && e.message) || e) + ')',
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function loadSavedViews() {
    setSavedViewsLoading(true);
    try {
      const rows = await listSavedViews(sb, CATTLE_WEIGHINS_SURFACE_KEY);
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
    loadSavedViews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createNewSession(opts) {
    const id = 'wsess-' + String(Date.now()) + Math.random().toString(36).slice(2, 6);
    const rec = {
      id,
      date: opts.date,
      team_member: opts.team_member,
      species: 'cattle',
      herd: opts.herd,
      status: 'draft',
      started_at: new Date().toISOString(),
    };
    await sb.from('weigh_in_sessions').insert(rec);
    setShowNewModal(false);
    navigate('/weigh-in-sessions/' + id);
  }

  const tagQ = tagSearch.trim().toLowerCase();
  const entryMatchesTag = (e) => !tagQ || (e.tag || '').toLowerCase().includes(tagQ);
  const statusFiltered = sessions.filter((s) => statusFilter === 'all' || s.status === statusFilter);
  const filtered = tagQ ? statusFiltered.filter((s) => (entries[s.id] || []).some(entryMatchesTag)) : statusFiltered;
  const totalEntries = filtered.reduce((s, sess) => s + (entries[sess.id] || []).length, 0);
  const matchedSessionCount = tagQ ? filtered.length : null;
  const loadFailed = !!notice;
  const selectedView = savedViews.find((v) => v.id === selectedViewId) || null;
  const selectedViewIsMine = !!(selectedView && myProfileId && selectedView.owner_profile_id === myProfileId);
  const emptyStateKind = sessions.length === 0 ? 'none' : 'filtered';
  const emptyStateMessage =
    emptyStateKind === 'none'
      ? 'No cattle weigh-in sessions yet.'
      : tagQ
        ? 'No cattle weigh-in sessions match #' + tagSearch + '.'
        : 'No cattle weigh-in sessions match the current filters.';
  const emptyStateHint =
    emptyStateKind === 'none'
      ? 'Click New Weigh-In to start one.'
      : tagQ
        ? 'Clear the tag search or switch back to All.'
        : 'Switch back to All to see every session.';

  function cattleWeighInsViewState() {
    return {
      statusFilter: VALID_WEIGHIN_STATUS_FILTERS.has(statusFilter) ? statusFilter : 'all',
      tagSearch: tagSearch || '',
    };
  }

  function applyCattleSavedView(view) {
    if (!view) return;
    const st = view.view_state || {};
    setStatusFilter(VALID_WEIGHIN_STATUS_FILTERS.has(st.statusFilter) ? st.statusFilter : 'all');
    setTagSearch(typeof st.tagSearch === 'string' ? st.tagSearch : '');
    setSavedViewNotice(null);
  }

  function onSelectSavedView(id) {
    setSelectedViewId(id);
    setSavedViewNotice(null);
    if (!id) return;
    applyCattleSavedView(savedViews.find((v) => v.id === id));
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
        surfaceKey: CATTLE_WEIGHINS_SURFACE_KEY,
        name,
        visibility: saveViewVisibility,
        viewState: cattleWeighInsViewState(),
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
      await updateSavedView(sb, selectedView.id, {viewState: cattleWeighInsViewState()});
      await loadSavedViews();
      setSavedViewNotice({
        kind: 'success',
        message: 'Updated "' + selectedView.name + '" to the current filter/search.',
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

  // CSV export of the CURRENT result set (status filter + tag search applied).
  // Exports `filtered`, not raw `sessions`. Mirrors SheepWeighInsView. Session
  // counts come from entries[s.id]; matching-tag count only when a tag search
  // is active. Mechanics via the shared csvExport owner.
  function cattleWeighInsExportColumns() {
    return [
      {header: 'Date', value: (s) => s.date || ''},
      {header: 'Herd', value: (s) => HERD_LABELS[s.herd] || s.herd || ''},
      {header: 'Status', value: (s) => s.status || ''},
      {header: 'Team member', value: (s) => s.team_member || ''},
      {header: 'Entry count', value: (s) => (entries[s.id] || []).length},
      {
        header: 'Matching tag entries',
        value: (s) => (tagQ ? (entries[s.id] || []).filter(entryMatchesTag).length : ''),
      },
      {header: 'New tag count', value: (s) => (entries[s.id] || []).filter((e) => e.new_tag_flag).length},
      {header: 'Started at', value: (s) => s.started_at || ''},
      {header: 'Session ID', value: (s) => s.id || ''},
    ];
  }

  function handleExportCsv() {
    const columns = cattleWeighInsExportColumns();
    const ok = downloadCsv(csvFilename('cattle-weigh-in-sessions'), rowsToCsv(columns, filtered));
    if (!ok) setNotice({kind: 'error', message: 'CSV export is only available in the browser.'});
  }

  function handlePrintRows() {
    const columns = cattleWeighInsExportColumns();
    const ok = printRows({
      title: 'Cattle Weigh-In Sessions',
      subtitle: filtered.length + ' filtered weigh-in sessions',
      columns,
      rows: filtered,
    });
    if (!ok) setNotice({kind: 'error', message: 'Print is only available in the browser.'});
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
              data-cattle-weighins-saved-views-row
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
                <span style={{fontSize: 12, color: '#b91c1c'}} data-cattle-weighins-saved-views-error>
                  Saved views unavailable. Filters still work.
                </span>
              ) : (
                <>
                  <select
                    data-cattle-weighins-saved-view-select
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
                        data-cattle-weighins-saved-view-update
                        onClick={updateSelectedView}
                        disabled={savedViewBusy}
                        style={savedViewGhostBtnS}
                      >
                        Update to current
                      </button>
                      <button
                        type="button"
                        data-cattle-weighins-saved-view-delete
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
                    data-cattle-weighins-saved-view-save-open
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
                data-cattle-weighins-saved-view-form
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
                  data-cattle-weighins-saved-view-name
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
                    name="saveCattleWeighInsViewVisibility"
                    checked={saveViewVisibility === 'private'}
                    onChange={() => setSaveViewVisibility('private')}
                    data-cattle-weighins-saved-view-visibility="private"
                  />
                  Private
                </label>
                <label style={savedViewRadioLabelS}>
                  <input
                    type="radio"
                    name="saveCattleWeighInsViewVisibility"
                    checked={saveViewVisibility === 'public'}
                    onChange={() => setSaveViewVisibility('public')}
                    data-cattle-weighins-saved-view-visibility="public"
                  />
                  Public
                </label>
                <button
                  type="button"
                  data-cattle-weighins-saved-view-save
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
            <div style={{fontSize: 16, fontWeight: 700, color: '#111827'}}>Cattle Weigh-In Sessions</div>
            <div style={{fontSize: 12, color: '#6b7280', marginTop: 2}}>
              {tagQ ? (
                <span>
                  Search <strong>{'#' + tagSearch}</strong>: {matchedSessionCount} session
                  {matchedSessionCount === 1 ? '' : 's'}
                </span>
              ) : (
                <span>
                  {filtered.length} sessions {'·'} {totalEntries} total entries
                </span>
              )}
            </div>
          </div>
          <div style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
            <div style={{position: 'relative'}}>
              <input
                type="search"
                value={tagSearch}
                onChange={(e) => setTagSearch(e.target.value)}
                placeholder="Search by tag #..."
                style={{
                  fontFamily: 'inherit',
                  fontSize: 12,
                  padding: '6px 28px 6px 10px',
                  border: '1px solid #d1d5db',
                  borderRadius: 6,
                  width: 160,
                  boxSizing: 'border-box',
                  background: 'white',
                  color: '#111827',
                  outline: 'none',
                }}
              />
              {tagSearch && (
                <button
                  type="button"
                  onClick={() => setTagSearch('')}
                  title="Clear search"
                  style={{
                    position: 'absolute',
                    right: 4,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    fontSize: 16,
                    lineHeight: 1,
                    color: '#9ca3af',
                    cursor: 'pointer',
                    padding: '2px 6px',
                    fontFamily: 'inherit',
                  }}
                >
                  {'×'}
                </button>
              )}
            </div>
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
              data-cattle-weighins-export-csv="1"
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
              data-cattle-weighins-print="1"
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
              data-new-weighin-button="1"
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
              const sEntriesAll = entries[s.id] || [];
              const countLabel = tagQ
                ? sEntriesAll.filter(entryMatchesTag).length + ' of ' + sEntriesAll.length + ' match'
                : sEntriesAll.length + ' ' + (sEntriesAll.length === 1 ? 'entry' : 'entries');
              const newTagCount = sEntriesAll.filter((e) => e.new_tag_flag).length;
              return (
                <div
                  key={s.id}
                  data-weighin-session-tile={s.id}
                  onClick={() =>
                    navigate(
                      '/weigh-in-sessions/' + s.id,
                      recordSeqNavOptions(
                        filtered.map((r) => ({
                          id: r.id,
                          label: (r.date || '') + ' · ' + (HERD_LABELS[r.herd] || r.herd || 'cattle'),
                        })),
                      ),
                    )
                  }
                  className="hoverable-tile"
                  style={{
                    background: 'white',
                    border: '1px solid #e5e7eb',
                    borderRadius: 10,
                    padding: '10px 16px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <span style={{fontSize: 13, fontWeight: 700, color: '#111827', minWidth: 120}}>
                    {HERD_LABELS[s.herd] || s.herd || 'Unknown herd'}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 10,
                      background: s.status === 'complete' ? '#d1fae5' : '#fef3c7',
                      color: s.status === 'complete' ? '#065f46' : '#92400e',
                      textTransform: 'uppercase',
                    }}
                  >
                    {s.status}
                  </span>
                  <span style={{fontSize: 11, color: '#6b7280'}}>{fmt(s.date)}</span>
                  <span style={{fontSize: 11, color: '#6b7280'}}>{s.team_member}</span>
                  <span style={{fontSize: 11, fontWeight: 600, color: tagQ ? '#065f46' : '#1e40af'}}>{countLabel}</span>
                  {newTagCount > 0 && !tagQ && (
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: '#fef2f2',
                        color: '#b91c1c',
                      }}
                    >
                      {newTagCount + ' new tags'}
                    </span>
                  )}
                </div>
              );
            })}
        </div>
      </div>
      {showNewModal && (
        <CattleNewWeighInModal
          authState={authState}
          onClose={() => setShowNewModal(false)}
          onCreate={createNewSession}
        />
      )}
    </div>
  );
};

export default CattleWeighInsView;
