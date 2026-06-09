// Auto-extracted by Phase 2 Round 2 (verbatim). See MIGRATION_PLAN §6.
import React from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import {recordSeqNavOptions, dailySeqItems} from '../lib/recordSequence.js';
import {S} from '../lib/styles.js';
import {checkDailyDuplicate, formatDuplicateError, friendlyDailyDbError} from '../lib/dailyDuplicateCheck.js';
import {softDeleteDailyReport, canDeleteDailyReport, updateDailyReport} from '../lib/dailyReportsApi.js';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {buildPigDailyExportColumns} from '../lib/dailyReportExports.js';
import {printRows} from '../lib/printExport.js';
import {listSavedViews, createSavedView, updateSavedView, deleteSavedView} from '../lib/savedViewsApi.js';
import AdminAddReportModal from '../shared/AdminAddReportModal.jsx';
import DailyPhotoChip from '../shared/DailyPhotoChip.jsx';
import DailyPhotoThumbnails from '../shared/DailyPhotoThumbnails.jsx';
import OperationalListEmptyState from '../shared/OperationalListEmptyState.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import {LockedTeamMemberField} from '../shared/recordPageControls.jsx';
import {usePersistentViewState} from '../lib/usePersistentViewState.js';
import PigDailyPage from './PigDailyPage.jsx';

const PIG_DAILYS_SURFACE_KEY = 'pig.dailys';
const VALID_PIG_DAILY_SOURCE_FILTERS = new Set(['all', 'daily', 'addfeed']);

function PigDailysRouter(props) {
  const location = useLocation();
  const dailyId = location.pathname.startsWith('/pig/dailys/')
    ? location.pathname.slice('/pig/dailys/'.length) || null
    : null;
  if (dailyId) {
    return React.createElement(PigDailyPage, {
      sb: props.sb,
      fmt: props.fmt,
      authState: props.authState,
      Header: props.Header,
      feederGroups: props.feederGroups,
    });
  }
  return React.createElement(PigDailysHub, props);
}

const PigDailysHub = ({
  sb,
  fmt,
  Header,
  authState,
  setPigDailys,
  feederGroups,
  pendingEdit,
  setPendingEdit,
  refreshDailys,
}) => {
  const {useState, useEffect} = React;
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const userRole = authState?.role || '';
  const isLightRole = String(userRole).toLowerCase() === 'light';
  const signedInUser =
    authState && typeof authState === 'object'
      ? authState.name || authState.profile?.name || authState.profile?.full_name || authState.user?.email || ''
      : '';
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [fBatch, setFBatch] = usePersistentViewState('pig.dailys.batchFilter', '');
  const [fTeam, setFTeam] = usePersistentViewState('pig.dailys.teamFilter', '');
  const [fFrom, setFFrom] = usePersistentViewState('pig.dailys.fromFilter', '');
  const [fTo, setFTo] = usePersistentViewState('pig.dailys.toFilter', '');
  const [srcFilter, setSrcFilter] = usePersistentViewState('pig.dailys.sourceFilter', 'all');
  const EMPTY = {
    date: todayStr(),
    teamMember: '',
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
  const [form, setForm] = useState(EMPTY);
  const [notice, setNotice] = useState(null);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
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

  const fromRecords = [...new Set(records.map((d) => d.batch_label).filter(Boolean))].sort();
  const groupList = [
    ...new Set(
      [
        ...feederGroups.map((g) => g.batchName),
        ...feederGroups.flatMap((g) => (g.subBatches || []).map((s) => s.name)),
      ].filter(Boolean),
    ),
  ].sort();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      const all = [];
      const PAGE = 1000;
      let from = 0;
      while (true) {
        const {data, error} = await sb
          .from('pig_dailys')
          .select('*')
          .is('deleted_at', null)
          .order('date', {ascending: false})
          .range(from, from + PAGE - 1);
        if (error) throw new Error('pig_dailys: ' + (error.message || error));
        if (!data || data.length === 0) break;
        all.push(...data);
        if (data.length < PAGE) break;
        from += PAGE;
      }
      if (cancelled) return;
      setRecords(all);
      setPigDailys && setPigDailys(all);
      if (pendingEdit?.viewName === 'pigdailys' && pendingEdit?.id) {
        const rec = all.find((r) => r.id === pendingEdit.id);
        if (rec) {
          openEdit(rec);
          setPendingEdit(null);
        }
      }
      setLoading(false);
    })().catch((e) => {
      if (cancelled) return;
      setRecords([]);
      setPigDailys && setPigDailys([]);
      setLoadError({
        kind: 'error',
        message: 'Could not load daily reports. Please refresh the page. (' + ((e && e.message) || e) + ')',
      });
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloadKey is the user-gated retry trigger.
  }, [reloadKey]);

  async function loadSavedViews() {
    setSavedViewsLoading(true);
    try {
      const rows = await listSavedViews(sb, PIG_DAILYS_SURFACE_KEY);
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

  React.useEffect(() => {
    if (!isLightRole || !signedInUser) return;
    setForm((f) => (f.teamMember ? f : {...f, teamMember: signedInUser}));
  }, [isLightRole, signedInUser]);

  useEffect(() => {
    if (pendingEdit?.viewName === 'pigdailys' && pendingEdit?.id && records.length > 0) {
      const rec = records.find((r) => r.id === pendingEdit.id);
      if (rec) {
        openEdit(rec);
        setPendingEdit(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- openEdit is a local form hydrator; records is the readiness source.
  }, [pendingEdit, records]);

  const navigate = useNavigate();

  const [editSource, setEditSource] = useState(null);
  function updateRecords(updater) {
    setRecords(updater);
    setPigDailys && setPigDailys(updater);
  }
  function openEdit(d) {
    setNotice(null);
    setForm({
      date: d.date || todayStr(),
      teamMember: d.team_member || '',
      batchLabel: d.batch_label || '',
      pigCount: d.pig_count != null ? d.pig_count : '',
      feedLbs: d.feed_lbs != null ? d.feed_lbs : '',
      groupMoved: d.group_moved !== false,
      nippleDrinkerMoved: d.nipple_drinker_moved !== false,
      nippleDrinkerWorking: d.nipple_drinker_working !== false,
      troughsMoved: d.troughs_moved !== false,
      fenceWalked: d.fence_walked !== false,
      fenceVoltage: d.fence_voltage != null ? d.fence_voltage : '',
      issues: d.issues || '',
      photos: Array.isArray(d.photos) ? d.photos : [],
    });
    setEditId(d.id);
    setEditSource(d.source || null);
    setShowForm(true);
  }
  const [showAddModal, setShowAddModal] = useState(false);
  async function save() {
    setNotice(null);
    const matchedGroup = feederGroups.find((g) => g.batchName === form.batchLabel);
    const matchedSub = feederGroups
      .flatMap((g) => (g.subBatches || []).map((s) => ({...s, parentId: g.id})))
      .find((s) => s.name === form.batchLabel);
    // Fall back to slugified label for non-feeder groups (SOWS, BOARS, etc.) — matches WebformHub.submitPig
    const batchId =
      matchedGroup?.id ||
      matchedSub?.parentId ||
      (form.batchLabel ? form.batchLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-') : null);
    const rec = {
      date: form.date,
      team_member: form.teamMember,
      batch_id: batchId,
      batch_label: form.batchLabel,
      pig_count: form.pigCount !== '' ? parseInt(form.pigCount) : null,
      feed_lbs: form.feedLbs !== '' ? parseFloat(form.feedLbs) : null,
      group_moved: form.groupMoved,
      nipple_drinker_moved: form.nippleDrinkerMoved,
      nipple_drinker_working: form.nippleDrinkerWorking,
      troughs_moved: form.troughsMoved,
      fence_walked: form.fenceWalked,
      fence_voltage: form.fenceVoltage !== '' ? parseFloat(form.fenceVoltage) : null,
      issues: form.issues || null,
    };
    if (editId) {
      updateDailyReport(sb, 'pig.daily', editId, rec, {entityLabel: rec.date})
        .then(() => {
          refreshDailys && refreshDailys('pig');
        })
        .catch((e) => {
          setNotice({
            kind: 'error',
            message: 'Save failed: ' + friendlyDailyDbError(e.message || String(e), 'pig_dailys', rec),
          });
        });
      updateRecords((p) => p.map((r) => (r.id === editId ? {...r, ...rec} : r)));
      setShowForm(false);
      setEditId(null);
    } else {
      try {
        const dupe = await checkDailyDuplicate(sb, 'pig_dailys', rec);
        if (dupe) {
          setNotice({kind: 'error', message: formatDuplicateError('pig_dailys', rec)});
          return;
        }
      } catch (e) {
        setNotice({kind: 'error', message: e.message || 'Could not verify duplicate report.'});
        return;
      }
      const {data, error} = await sb
        .from('pig_dailys')
        .insert({...rec, submitted_at: new Date().toISOString()})
        .select()
        .single();
      if (error) {
        setNotice({kind: 'error', message: 'Save failed: ' + friendlyDailyDbError(error, 'pig_dailys', rec)});
      } else if (data) {
        updateRecords((p) => [data, ...p]);
        refreshDailys && refreshDailys('pig');
      }
      setShowForm(false);
      setEditId(null);
    }
  }
  function del(id) {
    window._wcfConfirmDelete?.('Delete this daily report?', async () => {
      const rec = records.find((r) => r.id === id);
      const label = rec ? rec.date + (rec.batch_label ? ' · ' + rec.batch_label : '') : id;
      await softDeleteDailyReport(sb, 'pig_dailys', id, label);
      updateRecords((p) => p.filter((r) => r.id !== id));
      refreshDailys && refreshDailys('pig');
      setShowForm(false);
      setEditId(null);
    });
  }

  const teamOpts = [...new Set(records.map((r) => r.team_member).filter(Boolean))].sort();
  let filtered = records.filter(
    (r) =>
      (!fBatch || r.batch_label === fBatch) &&
      (!fTeam || r.team_member === fTeam) &&
      (!fFrom || r.date >= fFrom) &&
      (!fTo || r.date <= fTo) &&
      (srcFilter === 'all' ||
        (srcFilter === 'daily' && r.source !== 'add_feed_webform') ||
        (srcFilter === 'addfeed' && r.source === 'add_feed_webform')),
  );
  const selectedView = savedViews.find((v) => v.id === selectedViewId) || null;
  const selectedViewIsMine = !!(selectedView && myProfileId && selectedView.owner_profile_id === myProfileId);

  function pigDailysViewState() {
    return {
      fBatch: fBatch || '',
      fTeam: fTeam || '',
      fFrom: fFrom || '',
      fTo: fTo || '',
      srcFilter: VALID_PIG_DAILY_SOURCE_FILTERS.has(srcFilter) ? srcFilter : 'all',
    };
  }

  function applyPigDailysSavedView(view) {
    if (!view) return;
    const st = view.view_state || {};
    setFBatch(typeof st.fBatch === 'string' ? st.fBatch : '');
    setFTeam(typeof st.fTeam === 'string' ? st.fTeam : '');
    setFFrom(typeof st.fFrom === 'string' ? st.fFrom : '');
    setFTo(typeof st.fTo === 'string' ? st.fTo : '');
    setSrcFilter(VALID_PIG_DAILY_SOURCE_FILTERS.has(st.srcFilter) ? st.srcFilter : 'all');
    setSavedViewNotice(null);
  }

  function onSelectSavedView(id) {
    setSelectedViewId(id);
    setSavedViewNotice(null);
    if (!id) return;
    applyPigDailysSavedView(savedViews.find((v) => v.id === id));
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
        surfaceKey: PIG_DAILYS_SURFACE_KEY,
        name,
        visibility: saveViewVisibility,
        viewState: pigDailysViewState(),
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
      await updateSavedView(sb, selectedView.id, {viewState: pigDailysViewState()});
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

  function handleExportCsv() {
    const columns = buildPigDailyExportColumns();
    const ok = downloadCsv(csvFilename('pig-dailys'), rowsToCsv(columns, filtered));
    setExportNotice(ok ? '' : 'CSV export is only available in the browser.');
  }

  function handlePrintRows() {
    const columns = buildPigDailyExportColumns();
    const ok = printRows({
      title: 'Pig Dailys',
      subtitle: filtered.length + ' filtered daily reports',
      columns,
      rows: filtered,
    });
    setExportNotice(ok ? '' : 'Print is only available in the browser.');
  }

  const totalFeed = filtered.reduce((s, r) => s + (parseFloat(r.feed_lbs) || 0), 0);
  const voltColor = (v) => (v == null ? '#9ca3af' : v < 3 ? '#b91c1c' : v < 5 ? '#92400e' : '#065f46');
  const fi = {
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    fontSize: 12,
    fontFamily: 'inherit',
    background: 'white',
    width: 'auto',
  };
  const myViews = savedViews.filter((v) => myProfileId && v.owner_profile_id === myProfileId);
  const publicOtherViews = savedViews.filter(
    (v) => v.visibility === 'public' && !(myProfileId && v.owner_profile_id === myProfileId),
  );
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
  const savedViewPrimaryBtnS = {...savedViewGhostBtnS, border: '1px solid #92400e', color: '#92400e'};
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
      data-pig-dailys-loaded={loading || loadError ? 'false' : 'true'}
    >
      <Header />
      <div style={{padding: '1rem', maxWidth: 1100, margin: '0 auto'}}>
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
            <div style={{fontSize: 15, fontWeight: 700, color: '#111827'}}>Daily Reports</div>
            <div style={{fontSize: 12, color: '#6b7280', marginTop: 2}}>{records.length.toLocaleString()} total</div>
          </div>
          <div style={{display: 'flex', gap: 8}}>
            <button
              onClick={() => {
                setNotice(null);
                setShowAddModal(true);
              }}
              style={{
                padding: '8px 16px',
                borderRadius: 8,
                border: 'none',
                background: '#085041',
                color: 'white',
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              + Add Report
            </button>
          </div>
        </div>
        {showAddModal && (
          <AdminAddReportModal
            sb={sb}
            formType="pig"
            onClose={() => setShowAddModal(false)}
            onSaved={(recs) => {
              updateRecords((p) => [...recs, ...p]);
              refreshDailys && refreshDailys('pig');
            }}
          />
        )}
        {!loadError && (
          <>
            <div
              data-pig-dailys-saved-views-row
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
                <span style={{fontSize: 12, color: '#b91c1c'}} data-pig-dailys-saved-views-error>
                  Saved views unavailable. Filters still work.
                </span>
              ) : (
                <>
                  <select
                    data-pig-dailys-saved-view-select
                    value={selectedViewId}
                    disabled={savedViewsLoading}
                    onChange={(e) => onSelectSavedView(e.target.value)}
                    style={{...fi, minWidth: 200}}
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
                        data-pig-dailys-saved-view-update
                        onClick={updateSelectedView}
                        disabled={savedViewBusy}
                        style={savedViewGhostBtnS}
                      >
                        Update to current
                      </button>
                      <button
                        type="button"
                        data-pig-dailys-saved-view-delete
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
                    data-pig-dailys-saved-view-save-open
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
                data-pig-dailys-saved-view-form
                style={{
                  background: 'white',
                  border: '1px solid #fde68a',
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
                  data-pig-dailys-saved-view-name
                  type="text"
                  value={saveViewName}
                  placeholder="View name"
                  onChange={(e) => setSaveViewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitSaveView();
                  }}
                  style={{...fi, flex: 1, minWidth: 200}}
                />
                <label style={savedViewRadioLabelS}>
                  <input
                    type="radio"
                    name="savePigDailysViewVisibility"
                    checked={saveViewVisibility === 'private'}
                    onChange={() => setSaveViewVisibility('private')}
                    data-pig-dailys-saved-view-visibility="private"
                  />
                  Private
                </label>
                <label style={savedViewRadioLabelS}>
                  <input
                    type="radio"
                    name="savePigDailysViewVisibility"
                    checked={saveViewVisibility === 'public'}
                    onChange={() => setSaveViewVisibility('public')}
                    data-pig-dailys-saved-view-visibility="public"
                  />
                  Public
                </label>
                <button
                  type="button"
                  data-pig-dailys-saved-view-save
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
        <div style={{display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center'}}>
          <input type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} style={{...fi, width: 130}} />
          <span style={{fontSize: 12, color: '#6b7280'}}>to</span>
          <input type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} style={{...fi, width: 130}} />
          <select value={fBatch} onChange={(e) => setFBatch(e.target.value)} style={fi}>
            <option value="">All groups</option>
            {fromRecords.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <select value={fTeam} onChange={(e) => setFTeam(e.target.value)} style={fi} data-pig-dailys-team-filter="1">
            <option value="">All team members</option>
            {teamOpts.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {(fBatch || fTeam || fFrom || fTo || srcFilter !== 'all') && (
            <button
              onClick={() => {
                setFBatch('');
                setFTeam('');
                setFFrom('');
                setFTo('');
                setSrcFilter('all');
              }}
              style={{...fi, color: '#6b7280', cursor: 'pointer'}}
            >
              Clear
            </button>
          )}
          <div
            style={{
              display: 'flex',
              borderRadius: 6,
              overflow: 'hidden',
              border: '1px solid #d1d5db',
              marginLeft: 'auto',
            }}
          >
            {[
              {k: 'all', l: 'All'},
              {k: 'daily', l: 'Daily Reports'},
              {k: 'addfeed', l: '\ud83c\udf3e Add Feed'},
            ].map(function (o, oi) {
              return (
                <button
                  key={o.k}
                  onClick={function () {
                    setSrcFilter(o.k);
                  }}
                  style={{
                    padding: '5px 10px',
                    border: 'none',
                    borderRight: oi < 2 ? '1px solid #d1d5db' : 'none',
                    fontFamily: 'inherit',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    background: srcFilter === o.k ? '#92400e' : 'white',
                    color: srcFilter === o.k ? 'white' : '#6b7280',
                  }}
                >
                  {o.l}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            data-pig-dailys-export-csv="1"
            onClick={handleExportCsv}
            disabled={loading || !!loadError}
            style={{
              ...fi,
              color: loading || loadError ? '#9ca3af' : '#374151',
              fontWeight: 600,
              cursor: loading || loadError ? 'not-allowed' : 'pointer',
            }}
          >
            Export CSV
          </button>
          <button
            type="button"
            data-pig-dailys-print="1"
            onClick={handlePrintRows}
            disabled={loading || !!loadError}
            style={{
              ...fi,
              color: loading || loadError ? '#9ca3af' : '#374151',
              fontWeight: 600,
              cursor: loading || loadError ? 'not-allowed' : 'pointer',
            }}
          >
            Print
          </button>
        </div>
        <InlineNotice notice={loadError} />
        {loadError && (
          <button
            type="button"
            data-daily-list-retry="1"
            onClick={() => setReloadKey((k) => k + 1)}
            style={{
              marginBottom: 12,
              padding: '7px 14px',
              borderRadius: 7,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#374151',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Retry
          </button>
        )}
        <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
        {loading && <div style={{textAlign: 'center', padding: '3rem', color: '#9ca3af'}}>Loading...</div>}
        <OperationalListEmptyState
          loading={loading}
          loadError={loadError}
          totalCount={records.length}
          filteredCount={filtered.length}
          emptyLabel="No pig daily reports yet"
        />
        {!loading && !loadError && filtered.length > 0 && (
          <div style={{display: 'flex', flexDirection: 'column', gap: 4}}>
            {(() => {
              const dates = [...new Set(filtered.map((r) => r.date))];
              return filtered.map((d, i) => {
                const hasFeed = parseFloat(d.feed_lbs) > 0;
                const hasCount = parseInt(d.pig_count) > 0;
                const hasVolt = d.fence_voltage != null && String(d.fence_voltage).trim() !== '';
                const issues = d.issues && String(d.issues).trim().length > 2 ? String(d.issues).trim() : '';
                const notable = issues || (hasVolt && parseFloat(d.fence_voltage) < 3);
                const prevDate = i > 0 ? filtered[i - 1].date : null;
                const showDivider = prevDate && prevDate !== d.date;
                const dateIdx = dates.indexOf(d.date);
                const shadeBg = dateIdx % 2 === 0 ? 'white' : '#f8fafc';
                return (
                  <React.Fragment key={d.id}>
                    {showDivider && (
                      <div style={{height: 2, background: '#9ca3af', margin: '6px 0', borderRadius: 1}} />
                    )}
                    <div
                      data-daily-row={d.id}
                      onClick={() =>
                        navigate('/pig/dailys/' + d.id, recordSeqNavOptions(dailySeqItems(filtered, 'batch_label')))
                      }
                      style={{
                        background: d.source === 'add_feed_webform' ? '#fffbeb' : shadeBg,
                        borderRadius: 8,
                        cursor: 'pointer',
                        border: notable
                          ? '1.5px solid #fca5a5'
                          : d.source === 'add_feed_webform'
                            ? '1px solid #fde68a'
                            : '1px solid #e5e7eb',
                        padding: '8px 14px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                      }}
                      className="hoverable-tile"
                    >
                      <div
                        data-mobile-1col="1"
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '90px 120px 90px 130px 90px 90px 1fr',
                          alignItems: 'center',
                          gap: 12,
                        }}
                      >
                        <span style={{fontSize: 12, color: '#6b7280'}}>{fmt(d.date)}</span>
                        <span style={{display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden'}}>
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
                          {d.source === 'add_feed_webform' && (
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                padding: '1px 6px',
                                borderRadius: 6,
                                background: '#fef3c7',
                                color: '#92400e',
                                border: '1px solid #fde68a',
                                flexShrink: 0,
                              }}
                            >
                              {'\ud83c\udf3e'}
                            </span>
                          )}
                          <DailyPhotoChip photos={d.photos} />
                        </span>
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
                        <span
                          style={{
                            color: hasFeed ? '#92400e' : '#9ca3af',
                            fontWeight: hasFeed ? 600 : 400,
                            fontSize: 12,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {hasFeed ? `\ud83c\udf3e ${parseFloat(d.feed_lbs).toLocaleString()} lbs` : 'no feed'}
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
                        <span style={{display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center'}}>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              padding: '2px 7px',
                              borderRadius: 4,
                              background: d.group_moved === false ? '#fef2f2' : '#f0fdf4',
                              color: d.group_moved === false ? '#b91c1c' : '#065f46',
                              border: d.group_moved === false ? '1px solid #fecaca' : '1px solid #bbf7d0',
                            }}
                          >
                            {'Moved: ' + (d.group_moved === false ? 'No' : 'Yes')}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              padding: '2px 7px',
                              borderRadius: 4,
                              background: d.nipple_drinker_working === false ? '#fef2f2' : '#f0fdf4',
                              color: d.nipple_drinker_working === false ? '#b91c1c' : '#065f46',
                              border: d.nipple_drinker_working === false ? '1px solid #fecaca' : '1px solid #bbf7d0',
                            }}
                          >
                            {'Nipple: ' + (d.nipple_drinker_working === false ? 'No' : 'Yes')}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              padding: '2px 7px',
                              borderRadius: 4,
                              background: d.fence_walked === false ? '#fef2f2' : '#f0fdf4',
                              color: d.fence_walked === false ? '#b91c1c' : '#065f46',
                              border: d.fence_walked === false ? '1px solid #fecaca' : '1px solid #bbf7d0',
                            }}
                          >
                            {'Fence: ' + (d.fence_walked === false ? 'No' : 'Yes')}
                          </span>
                        </span>
                      </div>
                      {issues && (
                        <div
                          style={{
                            fontSize: 11,
                            color: '#92400e',
                            marginTop: 2,
                            padding: '4px 10px',
                            background: '#fffbeb',
                            border: '1px solid #fde68a',
                            borderRadius: 6,
                            fontStyle: 'italic',
                          }}
                        >
                          {'\ud83d\udcac ' + issues}
                        </div>
                      )}
                    </div>
                  </React.Fragment>
                );
              });
            })()}
          </div>
        )}
      </div>
      {showForm && (
        <div
          onClick={() => {
            setNotice(null);
            setShowForm(false);
          }}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,.45)',
            zIndex: 500,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: '1rem',
            overflowY: 'auto',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'white',
              borderRadius: 12,
              width: '100%',
              maxWidth: 480,
              boxShadow: '0 8px 32px rgba(0,0,0,.2)',
              marginTop: 40,
            }}
          >
            <div
              style={{
                padding: '14px 20px',
                borderBottom: '1px solid #e5e7eb',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                position: 'sticky',
                top: 0,
                background: 'white',
              }}
            >
              <div style={{fontSize: 15, fontWeight: 600, color: '#1e40af'}}>
                {editId
                  ? editSource === 'add_feed_webform'
                    ? 'Edit Pig Add Feed Report'
                    : 'Edit Pig Daily Report'
                  : 'Add Pig Daily Report'}
              </div>
              <button
                onClick={() => {
                  setNotice(null);
                  setShowForm(false);
                }}
                style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
              >
                ×
              </button>
            </div>
            <div
              data-mobile-1col="1"
              style={{
                padding: '16px 20px',
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 10,
                maxHeight: '70vh',
                overflowY: 'auto',
              }}
            >
              <div style={{gridColumn: '1/-1'}}>
                <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={S.label}>Date *</label>
                <input type="date" value={form.date} onChange={(e) => setForm((f) => ({...f, date: e.target.value}))} />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                {React.createElement(LockedTeamMemberField, {
                  value: form.teamMember,
                  label: 'Team Member',
                  labelStyle: S.label,
                  style: {maxWidth: '100%'},
                })}
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={S.label}>Pig Group</label>
                <select value={form.batchLabel} onChange={(e) => setForm((f) => ({...f, batchLabel: e.target.value}))}>
                  <option value="">Select group...</option>
                  {groupList.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                  {fromRecords
                    .filter((l) => !groupList.includes(l))
                    .map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label style={S.label}>Feed (lbs)</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={form.feedLbs || ''}
                  onChange={(e) => setForm((f) => ({...f, feedLbs: e.target.value}))}
                  placeholder="0"
                />
              </div>
              {editSource !== 'add_feed_webform' && (
                <div>
                  <label style={S.label}>Pig Count</label>
                  <input
                    type="number"
                    min="0"
                    value={form.pigCount || ''}
                    onChange={(e) => setForm((f) => ({...f, pigCount: e.target.value}))}
                    placeholder="0"
                  />
                </div>
              )}
              {editSource !== 'add_feed_webform' && (
                <div style={{gridColumn: '1/-1'}}>
                  <label style={S.label}>Fence Voltage (kV)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={form.fenceVoltage || ''}
                    onChange={(e) => setForm((f) => ({...f, fenceVoltage: e.target.value}))}
                  />
                </div>
              )}
              {editSource !== 'add_feed_webform' &&
                [
                  ['groupMoved', 'Group moved?'],
                  ['nippleDrinkerMoved', 'Nipple drinker moved?'],
                  ['nippleDrinkerWorking', 'Nipple drinker working?'],
                  ['troughsMoved', 'Troughs moved?'],
                  ['fenceWalked', 'Fence walked?'],
                ].map(([k, l]) => (
                  <div key={k}>
                    <label style={S.label}>{l}</label>
                    <div style={{display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #d1d5db'}}>
                      {[
                        {v: true, lbl: 'Yes'},
                        {v: false, lbl: 'No'},
                      ].map(({v, lbl}) => (
                        <button
                          key={lbl}
                          type="button"
                          onClick={() => setForm((f) => ({...f, [k]: v}))}
                          style={{
                            flex: 1,
                            padding: '7px 0',
                            border: 'none',
                            fontFamily: 'inherit',
                            fontSize: 12,
                            cursor: 'pointer',
                            background: form[k] === v ? (v ? '#085041' : '#374151') : '#f9fafb',
                            color: form[k] === v ? 'white' : '#6b7280',
                          }}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              {editSource !== 'add_feed_webform' && (
                <div style={{gridColumn: '1/-1'}}>
                  <label style={S.label}>Issues / Notes</label>
                  <textarea
                    value={form.issues}
                    onChange={(e) => setForm((f) => ({...f, issues: e.target.value}))}
                    rows={3}
                    style={{resize: 'vertical'}}
                  />
                </div>
              )}
              <DailyPhotoThumbnails photos={form?.photos} />
            </div>
            <div style={{padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8}}>
              <button onClick={save} style={{...S.btnPrimary, width: 'auto', padding: '8px 20px'}}>
                Save
              </button>
              {editId &&
                canDeleteDailyReport(
                  authState,
                  records.find((r) => r.id === editId),
                ) && (
                  <button onClick={() => del(editId)} style={S.btnDanger}>
                    Delete
                  </button>
                )}
              <button
                onClick={() => {
                  setNotice(null);
                  setShowForm(false);
                }}
                style={S.btnGhost}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PigDailysRouter;
