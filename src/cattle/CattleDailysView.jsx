// Auto-extracted by Phase 2 Round 2 (verbatim). See MIGRATION_PLAN §6.
import React from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import {recordSeqNavOptions, dailySeqItems} from '../lib/recordSequence.js';
import {S} from '../lib/styles.js';
import {softDeleteDailyReport, canDeleteDailyReport, updateDailyReport} from '../lib/dailyReportsApi.js';
import {friendlyDailyDbError} from '../lib/dailyDuplicateCheck.js';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {buildCattleDailyExportColumns} from '../lib/dailyReportExports.js';
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
import CattleDailyPage from './CattleDailyPage.jsx';

const CATTLE_DAILYS_SURFACE_KEY = 'cattle.dailys';
const VALID_CATTLE_DAILY_SOURCE_FILTERS = new Set(['all', 'daily', 'addfeed']);

function CattleDailysRouter(props) {
  const location = useLocation();
  const dailyId = location.pathname.startsWith('/cattle/dailys/')
    ? location.pathname.slice('/cattle/dailys/'.length) || null
    : null;
  if (dailyId) {
    return React.createElement(CattleDailyPage, {
      sb: props.sb,
      fmt: props.fmt,
      authState: props.authState,
      Header: props.Header,
    });
  }
  return React.createElement(CattleDailysHub, props);
}

const CattleDailysHub = ({sb, fmt, Header, authState, pendingEdit, setPendingEdit, refreshDailys}) => {
  const {useState, useEffect} = React;
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const [records, setRecords] = useState([]);
  const [feedInputs, setFeedInputs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editId, setEditId] = useState(null);
  const [editSource, setEditSource] = useState(null);
  const [form, setForm] = useState(null);
  const [notice, setNotice] = useState(null);
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
  const [fHerd, setFHerd] = usePersistentViewState('cattle.dailys.herdFilter', '');
  const [fTeam, setFTeam] = usePersistentViewState('cattle.dailys.teamFilter', '');
  const [fFrom, setFFrom] = usePersistentViewState('cattle.dailys.fromFilter', '');
  const [fTo, setFTo] = usePersistentViewState('cattle.dailys.toFilter', '');
  const [srcFilter, setSrcFilter] = usePersistentViewState('cattle.dailys.sourceFilter', 'all');

  const HERDS = ['mommas', 'backgrounders', 'finishers', 'bulls', 'processed', 'deceased', 'sold'];
  const HERD_LABELS = {
    mommas: 'Mommas',
    backgrounders: 'Backgrounders',
    finishers: 'Finishers',
    bulls: 'Bulls',
    processed: 'Processed',
    deceased: 'Deceased',
    sold: 'Sold',
  };
  const HERD_COLORS = {
    mommas: {bg: '#fef2f2', tx: '#991b1b', bd: '#fca5a5'},
    backgrounders: {bg: '#ffedd5', tx: '#9a3412', bd: '#fdba74'},
    finishers: {bg: '#fff1f2', tx: '#9f1239', bd: '#fda4af'},
    bulls: {bg: '#fee2e2', tx: '#7f1d1d', bd: '#fca5a5'},
    processed: {bg: '#f3f4f6', tx: '#374151', bd: '#d1d5db'},
    deceased: {bg: '#f9fafb', tx: '#6b7280', bd: '#e5e7eb'},
    sold: {bg: '#eff6ff', tx: '#1e40af', bd: '#bfdbfe'},
  };

  const PAGE = 1000;
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    sb.from('cattle_dailys')
      .select('*')
      .is('deleted_at', null)
      .order('date', {ascending: false})
      .order('submitted_at', {ascending: false})
      .range(0, PAGE - 1)
      .then(({data, error}) => {
        if (cancelled) return;
        if (error) {
          setRecords([]);
          setHasMore(false);
          setLoadError({
            kind: 'error',
            message: 'Could not load daily reports. Please refresh the page. (' + (error.message || error) + ')',
          });
          setLoading(false);
          return;
        }
        setRecords(data || []);
        setHasMore((data || []).length === PAGE);
        if (pendingEdit && pendingEdit.viewName === 'cattledailys' && pendingEdit.id) {
          const r = (data || []).find((x) => x.id === pendingEdit.id);
          if (r) {
            openEdit(r);
            setPendingEdit && setPendingEdit(null);
          }
        }
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setRecords([]);
        setHasMore(false);
        setLoadError({
          kind: 'error',
          message: 'Could not load daily reports. Please refresh the page. (' + ((e && e.message) || e) + ')',
        });
        setLoading(false);
      });
    sb.from('cattle_feed_inputs')
      .select('*')
      .order('category')
      .order('name')
      .then(({data}) => {
        if (!cancelled && data) setFeedInputs(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  async function loadSavedViews() {
    setSavedViewsLoading(true);
    try {
      const rows = await listSavedViews(sb, CATTLE_DAILYS_SURFACE_KEY);
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

  const pgLoading = React.useRef(false);
  React.useEffect(() => {
    if (hasMore && !pgLoading.current) {
      pgLoading.current = true;
      const next = page + 1;
      sb.from('cattle_dailys')
        .select('*')
        .is('deleted_at', null)
        .order('date', {ascending: false})
        .order('submitted_at', {ascending: false})
        .range(next * PAGE, (next + 1) * PAGE - 1)
        .then(({data}) => {
          pgLoading.current = false;
          if (data) {
            setRecords((r) => {
              const ids = new Set(r.map((x) => x.id));
              return [...r, ...data.filter((x) => !ids.has(x.id))];
            });
            setHasMore(data.length === PAGE);
            setPage(next);
          }
        });
    }
  }, [hasMore, page]);

  const navigate = useNavigate();

  function openEdit(d) {
    setNotice(null);
    setForm({
      date: d.date || todayStr(),
      teamMember: d.team_member || '',
      herd: d.herd || '',
      feeds:
        Array.isArray(d.feeds) && d.feeds.length > 0
          ? d.feeds.map((f) => ({
              feedId: f.feed_input_id || '',
              qty: f.qty != null ? String(f.qty) : '',
              isCreep: !!f.is_creep,
            }))
          : [{feedId: '', qty: '', isCreep: false}],
      minerals:
        Array.isArray(d.minerals) && d.minerals.length > 0
          ? d.minerals.map((m) => ({feedId: m.feed_input_id || '', lbs: m.lbs != null ? String(m.lbs) : ''}))
          : [{feedId: '', lbs: ''}],
      fenceVoltage: d.fence_voltage != null ? String(d.fence_voltage) : '',
      waterChecked: d.water_checked !== false,
      mortalityCount: d.mortality_count != null ? String(d.mortality_count) : '',
      mortalityReason: d.mortality_reason || '',
      issues: d.issues || '',
      // Read-only in v1 — saveEdit does not write photos back.
      photos: Array.isArray(d.photos) ? d.photos : [],
    });
    setEditId(d.id);
    setEditSource(d.source || null);
    setShowForm(true);
  }

  async function saveEdit() {
    setNotice(null);
    if (!form.date || !form.teamMember || !form.herd) {
      setNotice({kind: 'error', message: 'Date, team member, and herd are required.'});
      return;
    }
    if (parseInt(form.mortalityCount) > 0 && !(form.mortalityReason || '').trim()) {
      setNotice({kind: 'error', message: 'Mortality reason is required when mortalities are reported.'});
      return;
    }
    // Build feeds/minerals jsonb with updated nutrition snapshots
    const feedsJ = (form.feeds || [])
      .filter((r) => r.feedId && r.qty !== '' && r.qty != null)
      .map((r) => {
        const fi = feedInputs.find((x) => x.id === r.feedId);
        if (!fi) return null;
        const qty = parseFloat(r.qty) || 0;
        const unitWt = parseFloat(fi.unit_weight_lbs) || 1;
        return {
          feed_input_id: fi.id,
          feed_name: fi.name,
          category: fi.category,
          qty: qty,
          unit: fi.unit,
          lbs_as_fed: Math.round(qty * unitWt * 100) / 100,
          is_creep: !!r.isCreep,
          nutrition_snapshot: {moisture_pct: fi.moisture_pct, nfc_pct: fi.nfc_pct, protein_pct: fi.protein_pct},
        };
      })
      .filter(Boolean);
    const mineralsJ = (form.minerals || [])
      .filter((m) => m.feedId && m.lbs !== '' && m.lbs != null)
      .map((m) => {
        const fi = feedInputs.find((x) => x.id === m.feedId);
        if (!fi) return null;
        return {feed_input_id: fi.id, name: fi.name, lbs: parseFloat(m.lbs) || 0};
      })
      .filter(Boolean);
    const rec = {
      date: form.date,
      team_member: form.teamMember,
      herd: form.herd,
      feeds: feedsJ,
      minerals: mineralsJ,
      fence_voltage: form.fenceVoltage !== '' ? parseFloat(form.fenceVoltage) : null,
      water_checked: form.waterChecked,
      mortality_count: form.mortalityCount !== '' ? parseInt(form.mortalityCount) : 0,
      mortality_reason: form.mortalityReason || null,
      issues: form.issues || null,
    };
    try {
      await updateDailyReport(sb, 'cattle.daily', editId, rec, {entityLabel: rec.date});
    } catch (e) {
      setNotice({
        kind: 'error',
        message: 'Save failed: ' + friendlyDailyDbError(e.message || String(e), 'cattle_dailys', rec),
      });
      return;
    }
    setRecords((p) => p.map((r) => (r.id === editId ? {...r, ...rec} : r)));
    refreshDailys && refreshDailys('cattle');
    setShowForm(false);
    setEditId(null);
    setForm(null);
  }

  function del(id) {
    if (!window._wcfConfirmDelete) return;
    window._wcfConfirmDelete('Delete this daily report?', async () => {
      const rec = records.find((r) => r.id === id);
      const label = rec ? rec.date + (rec.herd ? ' · ' + rec.herd : '') : id;
      await softDeleteDailyReport(sb, 'cattle_dailys', id, label);
      setRecords((p) => p.filter((r) => r.id !== id));
      refreshDailys && refreshDailys('cattle');
      setShowForm(false);
      setEditId(null);
      setForm(null);
    });
  }

  const filtered = records.filter(
    (r) =>
      (!fHerd || r.herd === fHerd) &&
      (!fTeam || r.team_member === fTeam) &&
      (!fFrom || r.date >= fFrom) &&
      (!fTo || r.date <= fTo) &&
      (srcFilter === 'all' ||
        (srcFilter === 'daily' && r.source !== 'add_feed_webform') ||
        (srcFilter === 'addfeed' && r.source === 'add_feed_webform')),
  );
  const teamOpts = [...new Set(records.map((r) => r.team_member).filter(Boolean))].sort();
  const selectedView = savedViews.find((v) => v.id === selectedViewId) || null;
  const selectedViewIsMine = !!(selectedView && myProfileId && selectedView.owner_profile_id === myProfileId);

  function cattleDailysViewState() {
    return {
      fHerd: fHerd || '',
      fTeam: fTeam || '',
      fFrom: fFrom || '',
      fTo: fTo || '',
      srcFilter: VALID_CATTLE_DAILY_SOURCE_FILTERS.has(srcFilter) ? srcFilter : 'all',
    };
  }

  function applyCattleDailysSavedView(view) {
    if (!view) return;
    const st = view.view_state || {};
    setFHerd(typeof st.fHerd === 'string' ? st.fHerd : '');
    setFTeam(typeof st.fTeam === 'string' ? st.fTeam : '');
    setFFrom(typeof st.fFrom === 'string' ? st.fFrom : '');
    setFTo(typeof st.fTo === 'string' ? st.fTo : '');
    setSrcFilter(VALID_CATTLE_DAILY_SOURCE_FILTERS.has(st.srcFilter) ? st.srcFilter : 'all');
    setSavedViewNotice(null);
  }

  function onSelectSavedView(id) {
    setSelectedViewId(id);
    setSavedViewNotice(null);
    if (!id) return;
    applyCattleDailysSavedView(savedViews.find((v) => v.id === id));
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
        surfaceKey: CATTLE_DAILYS_SURFACE_KEY,
        name,
        visibility: saveViewVisibility,
        viewState: cattleDailysViewState(),
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
      await updateSavedView(sb, selectedView.id, {viewState: cattleDailysViewState()});
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
    const columns = buildCattleDailyExportColumns({herdLabels: HERD_LABELS});
    const ok = downloadCsv(csvFilename('cattle-dailys'), rowsToCsv(columns, filtered));
    setExportNotice(ok ? '' : 'CSV export is only available in the browser.');
  }

  function handlePrintRows() {
    const columns = buildCattleDailyExportColumns({herdLabels: HERD_LABELS});
    const ok = printRows({
      title: 'Cattle Dailys',
      subtitle: filtered.length + ' filtered daily reports',
      columns,
      rows: filtered,
    });
    setExportNotice(ok ? '' : 'Print is only available in the browser.');
  }

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
  const savedViewPrimaryBtnS = {...savedViewGhostBtnS, border: '1px solid #991b1b', color: '#991b1b'};
  const savedViewRadioLabelS = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    color: '#374151',
    cursor: 'pointer',
  };

  // Summary metrics for filtered view
  const totalMort = filtered.reduce((s, r) => s + (parseInt(r.mortality_count) || 0), 0);
  const totalFeedLbs = filtered.reduce(
    (s, r) => s + (Array.isArray(r.feeds) ? r.feeds.reduce((ss, f) => ss + (parseFloat(f.lbs_as_fed) || 0), 0) : 0),
    0,
  );

  return (
    <div
      style={{minHeight: '100vh', background: '#f1f3f2'}}
      data-cattle-dailys-loaded={loading || loadError ? 'false' : 'true'}
    >
      <Header />
      <div style={{padding: '1rem', maxWidth: 1200, margin: '0 auto'}}>
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
                background: '#991b1b',
                color: 'white',
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              + New Report
            </button>
          </div>
        </div>
        {showAddModal && (
          <AdminAddReportModal
            sb={sb}
            formType="cattle"
            onClose={() => setShowAddModal(false)}
            onSaved={(recs) => {
              setRecords((p) => [...(Array.isArray(recs) ? recs : [recs]), ...p]);
              refreshDailys && refreshDailys('cattle');
            }}
          />
        )}

        {!loadError && (
          <>
            <div
              data-cattle-dailys-saved-views-row
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
                <span style={{fontSize: 12, color: '#b91c1c'}} data-cattle-dailys-saved-views-error>
                  Saved views unavailable. Filters still work.
                </span>
              ) : (
                <>
                  <select
                    data-cattle-dailys-saved-view-select
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
                        data-cattle-dailys-saved-view-update
                        onClick={updateSelectedView}
                        disabled={savedViewBusy}
                        style={savedViewGhostBtnS}
                      >
                        Update to current
                      </button>
                      <button
                        type="button"
                        data-cattle-dailys-saved-view-delete
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
                    data-cattle-dailys-saved-view-save-open
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
                data-cattle-dailys-saved-view-form
                style={{
                  background: 'white',
                  border: '1px solid #fecaca',
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
                  data-cattle-dailys-saved-view-name
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
                    name="saveCattleDailysViewVisibility"
                    checked={saveViewVisibility === 'private'}
                    onChange={() => setSaveViewVisibility('private')}
                    data-cattle-dailys-saved-view-visibility="private"
                  />
                  Private
                </label>
                <label style={savedViewRadioLabelS}>
                  <input
                    type="radio"
                    name="saveCattleDailysViewVisibility"
                    checked={saveViewVisibility === 'public'}
                    onChange={() => setSaveViewVisibility('public')}
                    data-cattle-dailys-saved-view-visibility="public"
                  />
                  Public
                </label>
                <button
                  type="button"
                  data-cattle-dailys-saved-view-save
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

        {/* Filters */}
        <div style={{display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center'}}>
          <input type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} style={{...fi, width: 130}} />
          <span style={{fontSize: 12, color: '#6b7280'}}>to</span>
          <input type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} style={{...fi, width: 130}} />
          <select value={fHerd} onChange={(e) => setFHerd(e.target.value)} style={fi}>
            <option value="">All herds</option>
            {HERDS.map((h) => (
              <option key={h} value={h}>
                {HERD_LABELS[h]}
              </option>
            ))}
          </select>
          <select
            value={fTeam}
            onChange={(e) => setFTeam(e.target.value)}
            style={fi}
            data-cattle-dailys-team-filter="1"
          >
            <option value="">All team</option>
            {teamOpts.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {(fHerd || fTeam || fFrom || fTo || srcFilter !== 'all') && (
            <button
              onClick={() => {
                setFHerd('');
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
            ].map((o, oi) => (
              <button
                key={o.k}
                onClick={() => setSrcFilter(o.k)}
                style={{
                  padding: '5px 10px',
                  border: 'none',
                  borderRight: oi < 2 ? '1px solid #d1d5db' : 'none',
                  fontFamily: 'inherit',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: srcFilter === o.k ? '#991b1b' : 'white',
                  color: srcFilter === o.k ? 'white' : '#6b7280',
                }}
              >
                {o.l}
              </button>
            ))}
          </div>
          <button
            type="button"
            data-cattle-dailys-export-csv="1"
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
            data-cattle-dailys-print="1"
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
        {loading && <div style={{textAlign: 'center', padding: '3rem', color: '#9ca3af'}}>Loading{'\u2026'}</div>}
        <OperationalListEmptyState
          loading={loading}
          loadError={loadError}
          totalCount={records.length}
          filteredCount={filtered.length}
          emptyLabel="No cattle daily reports yet"
        />
        {!loading && !loadError && filtered.length > 0 && (
          <div style={{display: 'flex', flexDirection: 'column', gap: 4}}>
            {(() => {
              const dates = [...new Set(filtered.map((r) => r.date))];
              return filtered.map((d, i) => {
                const hasMort = parseInt(d.mortality_count) > 0;
                const issues = d.issues && String(d.issues).trim().length > 2 ? String(d.issues).trim() : '';
                const notable = hasMort || issues;
                const prevDate = i > 0 ? filtered[i - 1].date : null;
                const showDivider = prevDate && prevDate !== d.date;
                const dateIdx = dates.indexOf(d.date);
                const shadeBg = dateIdx % 2 === 0 ? 'white' : '#f8fafc';
                const hc = HERD_COLORS[d.herd] || HERD_COLORS.mommas;
                const feedSummary =
                  Array.isArray(d.feeds) && d.feeds.length > 0
                    ? d.feeds
                        .map(
                          (f) =>
                            (f.feed_name || '?') +
                            (f.qty ? ' ' + f.qty + ' ' + (f.unit || '') + (f.is_creep ? ' \ud83c\udf7c' : '') : ''),
                        )
                        .join(', ')
                    : '';
                const mineralSummary =
                  Array.isArray(d.minerals) && d.minerals.length > 0
                    ? d.minerals.map((m) => (m.name || '?') + (m.lbs ? ' ' + m.lbs + ' lb' : '')).join(', ')
                    : '';
                return (
                  <React.Fragment key={d.id}>
                    {showDivider && (
                      <div style={{height: 2, background: '#9ca3af', margin: '6px 0', borderRadius: 1}} />
                    )}
                    <div
                      data-daily-row={d.id}
                      onClick={() =>
                        navigate('/cattle/dailys/' + d.id, recordSeqNavOptions(dailySeqItems(filtered, 'herd')))
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
                          gridTemplateColumns: '90px 120px 90px 90px 1fr',
                          alignItems: 'center',
                          gap: 12,
                        }}
                      >
                        <span style={{fontSize: 12, color: '#6b7280'}}>{fmt(d.date)}</span>
                        <span style={{display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden'}}>
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
                            {HERD_LABELS[d.herd] || d.herd}
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
                            fontSize: 11,
                            color:
                              d.fence_voltage != null
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
                          {d.fence_voltage != null ? '\u26a1 ' + d.fence_voltage + ' kV' : 'no voltage'}
                        </span>
                        <span style={{display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center'}}>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              padding: '2px 7px',
                              borderRadius: 4,
                              background: d.water_checked === false ? '#fef2f2' : '#f0fdf4',
                              color: d.water_checked === false ? '#b91c1c' : '#065f46',
                              border: d.water_checked === false ? '1px solid #fecaca' : '1px solid #bbf7d0',
                            }}
                          >
                            {'Water: ' + (d.water_checked === false ? 'No' : 'Yes')}
                          </span>
                        </span>
                      </div>
                      {feedSummary && (
                        <div style={{fontSize: 11, color: '#92400e'}}>{'\ud83c\udf3e ' + feedSummary}</div>
                      )}
                      {mineralSummary && (
                        <div style={{fontSize: 11, color: '#6b21a8'}}>{'\ud83e\uddc2 ' + mineralSummary}</div>
                      )}
                      {(hasMort || issues) && (
                        <div style={{display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 2}}>
                          {hasMort && (
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
                              {'\ud83d\udc80 ' +
                                d.mortality_count +
                                ' mort.' +
                                (d.mortality_reason ? ' \u2014 ' + d.mortality_reason : '')}
                            </span>
                          )}
                          {issues && (
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
                              {'\ud83d\udcac ' + issues}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </React.Fragment>
                );
              });
            })()}
          </div>
        )}
        {hasMore && (
          <div style={{textAlign: 'center', padding: '0.5rem', fontSize: 11, color: '#9ca3af'}}>
            Loading more records{'\u2026'}
          </div>
        )}
      </div>

      {/* Edit modal */}
      {showForm && form && (
        <div
          onClick={() => {
            setNotice(null);
            setShowForm(false);
            setEditId(null);
            setForm(null);
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
              maxWidth: 520,
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
              }}
            >
              <div style={{fontSize: 15, fontWeight: 600, color: '#991b1b'}}>
                {editSource === 'add_feed_webform' ? 'Edit Cattle Add Feed Report' : 'Edit Cattle Daily Report'}
              </div>
              <button
                onClick={() => {
                  setNotice(null);
                  setShowForm(false);
                  setEditId(null);
                  setForm(null);
                }}
                style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
              >
                {'\u00d7'}
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
                <input type="date" value={form.date} onChange={(e) => setForm({...form, date: e.target.value})} />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                {React.createElement(LockedTeamMemberField, {
                  value: form.teamMember,
                  label: 'Team Member *',
                  labelStyle: S.label,
                  style: {maxWidth: '100%'},
                })}
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={S.label}>Herd *</label>
                <select value={form.herd} onChange={(e) => setForm({...form, herd: e.target.value})}>
                  <option value="">Select herd...</option>
                  {HERDS.map((h) => (
                    <option key={h} value={h}>
                      {HERD_LABELS[h]}
                    </option>
                  ))}
                </select>
              </div>

              {/* Feeds */}
              <div style={{gridColumn: '1/-1', borderTop: '1px solid #e5e7eb', paddingTop: 10}}>
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6}}>
                  <span style={{fontSize: 11, fontWeight: 700, color: '#4b5563', letterSpacing: 0.5}}>FEEDS</span>
                  <button
                    type="button"
                    onClick={() =>
                      setForm({...form, feeds: [...(form.feeds || []), {feedId: '', qty: '', isCreep: false}]})
                    }
                    style={{
                      fontSize: 11,
                      color: '#991b1b',
                      background: 'none',
                      border: '1px solid #fca5a5',
                      borderRadius: 5,
                      padding: '3px 8px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    + Add
                  </button>
                </div>
                {form.feeds.map((r, ri) => {
                  // Selection list excludes inactive inputs (status === 'inactive'); legacy
                  // null/blank status falls through as eligible. feedInputs itself stays
                  // unfiltered so the save-time .find() lookups above and the fiRow
                  // placeholder lookup below still resolve historical rows that already
                  // reference an inactive feed.
                  const feedsForHerd = feedInputs.filter(
                    (f) =>
                      f.status !== 'inactive' &&
                      f.category !== 'mineral' &&
                      (!form.herd || (f.herd_scope || []).includes(form.herd)),
                  );
                  const fiRow = feedInputs.find((x) => x.id === r.feedId);
                  // Editing a historical row whose feedId now points at an
                  // inactive feed: surface it as a disabled "(inactive)"
                  // option so the dropdown shows what was stored without
                  // letting the operator pick inactives for new rows.
                  const showHistoricalInactive =
                    fiRow && fiRow.status === 'inactive' && !feedsForHerd.some((f) => f.id === fiRow.id);
                  return (
                    <div
                      key={ri}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '2fr 1fr auto',
                        gap: 6,
                        marginBottom: 6,
                        alignItems: 'center',
                      }}
                    >
                      <select
                        value={r.feedId}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            feeds: form.feeds.map((x, i) => (i === ri ? {...x, feedId: e.target.value} : x)),
                          })
                        }
                      >
                        <option value="">Select feed...</option>
                        {showHistoricalInactive && (
                          <option value={fiRow.id} disabled>
                            {fiRow.name} (inactive)
                          </option>
                        )}
                        {feedsForHerd.map((ff) => (
                          <option key={ff.id} value={ff.id}>
                            {ff.name}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={r.qty}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            feeds: form.feeds.map((x, i) => (i === ri ? {...x, qty: e.target.value} : x)),
                          })
                        }
                        placeholder={fiRow ? fiRow.unit : 'qty'}
                      />
                      <button
                        type="button"
                        onClick={() => setForm({...form, feeds: form.feeds.filter((_, i) => i !== ri)})}
                        style={{
                          padding: '4px 8px',
                          border: '1px solid #d1d5db',
                          borderRadius: 5,
                          background: 'white',
                          color: '#9ca3af',
                          cursor: 'pointer',
                        }}
                      >
                        {'\u00d7'}
                      </button>
                      {form.herd === 'mommas' && r.feedId && (
                        <label
                          style={{
                            gridColumn: '1/-1',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            fontSize: 11,
                            color: '#7f1d1d',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={!!r.isCreep}
                            onChange={(e) =>
                              setForm({
                                ...form,
                                feeds: form.feeds.map((x, i) => (i === ri ? {...x, isCreep: e.target.checked} : x)),
                              })
                            }
                          />
                          Creep feed (excluded from Mommas nutrition)
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Minerals */}
              <div style={{gridColumn: '1/-1', borderTop: '1px solid #e5e7eb', paddingTop: 10}}>
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6}}>
                  <span style={{fontSize: 11, fontWeight: 700, color: '#4b5563', letterSpacing: 0.5}}>MINERALS</span>
                  <button
                    type="button"
                    onClick={() => setForm({...form, minerals: [...(form.minerals || []), {feedId: '', lbs: ''}]})}
                    style={{
                      fontSize: 11,
                      color: '#6b21a8',
                      background: 'none',
                      border: '1px solid #d8b4fe',
                      borderRadius: 5,
                      padding: '3px 8px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    + Add
                  </button>
                </div>
                {form.minerals.map((r, ri) => {
                  // Same selection-vs-history split as the feed dropdown above:
                  // inactive minerals are excluded from new selections but stay
                  // resolvable via the historical .find() lookups.
                  const minerals = feedInputs.filter((f) => f.status !== 'inactive' && f.category === 'mineral');
                  const miRow = feedInputs.find((x) => x.id === r.feedId);
                  const showHistoricalInactiveMineral =
                    miRow && miRow.status === 'inactive' && !minerals.some((m) => m.id === miRow.id);
                  return (
                    <div
                      key={ri}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '2fr 1fr auto',
                        gap: 6,
                        marginBottom: 6,
                        alignItems: 'center',
                      }}
                    >
                      <select
                        value={r.feedId}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            minerals: form.minerals.map((x, i) => (i === ri ? {...x, feedId: e.target.value} : x)),
                          })
                        }
                      >
                        <option value="">Select mineral...</option>
                        {showHistoricalInactiveMineral && (
                          <option value={miRow.id} disabled>
                            {miRow.name} (inactive)
                          </option>
                        )}
                        {minerals.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={r.lbs}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            minerals: form.minerals.map((x, i) => (i === ri ? {...x, lbs: e.target.value} : x)),
                          })
                        }
                        placeholder="lbs"
                      />
                      <button
                        type="button"
                        onClick={() => setForm({...form, minerals: form.minerals.filter((_, i) => i !== ri)})}
                        style={{
                          padding: '4px 8px',
                          border: '1px solid #d1d5db',
                          borderRadius: 5,
                          background: 'white',
                          color: '#9ca3af',
                          cursor: 'pointer',
                        }}
                      >
                        {'\u00d7'}
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Daily checks + mortality + issues — hide for add_feed source */}
              {editSource !== 'add_feed_webform' && (
                <React.Fragment>
                  <div>
                    <label style={S.label}>Fence Voltage (kV)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={form.fenceVoltage}
                      onChange={(e) => setForm({...form, fenceVoltage: e.target.value})}
                    />
                  </div>
                  <div>
                    <label style={S.label}>Waterers checked?</label>
                    <div style={{display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #d1d5db'}}>
                      {[
                        {v: true, l: 'Yes'},
                        {v: false, l: 'No'},
                      ].map(({v, l}) => (
                        <button
                          key={l}
                          type="button"
                          onClick={() => setForm({...form, waterChecked: v})}
                          style={{
                            flex: 1,
                            padding: '7px 0',
                            border: 'none',
                            fontFamily: 'inherit',
                            fontSize: 12,
                            cursor: 'pointer',
                            background: form.waterChecked === v ? (v ? '#085041' : '#374151') : '#f9fafb',
                            color: form.waterChecked === v ? 'white' : '#6b7280',
                          }}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label style={S.label}>Mortality count</label>
                    <input
                      type="number"
                      min="0"
                      value={form.mortalityCount}
                      onChange={(e) => setForm({...form, mortalityCount: e.target.value})}
                      placeholder="0"
                    />
                  </div>
                  {parseInt(form.mortalityCount) > 0 && (
                    <div>
                      <label style={S.label}>Mortality reason *</label>
                      <input
                        value={form.mortalityReason}
                        onChange={(e) => setForm({...form, mortalityReason: e.target.value})}
                      />
                    </div>
                  )}
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={S.label}>Issues / Comments</label>
                    <textarea
                      value={form.issues}
                      onChange={(e) => setForm({...form, issues: e.target.value})}
                      rows={3}
                      style={{resize: 'vertical'}}
                    />
                  </div>
                </React.Fragment>
              )}
              <DailyPhotoThumbnails photos={form?.photos} />
            </div>
            <div style={{padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8}}>
              <button onClick={saveEdit} style={{...S.btnPrimary, width: 'auto', padding: '8px 20px'}}>
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
                  setEditId(null);
                  setForm(null);
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

export default CattleDailysRouter;
