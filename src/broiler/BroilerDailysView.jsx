// Auto-extracted by Phase 2 Round 2 (verbatim). See MIGRATION_PLAN §6.
import React from 'react';
import {getProgramColor} from '../lib/programColors.js';
import {getReadableText} from '../lib/styles.js';
import {useLocation, useNavigate} from 'react-router-dom';
import {recordSeqNavOptions, dailySeqItems} from '../lib/recordSequence.js';
import {S} from '../lib/styles.js';
import {formatBroilerBatchLabel, splitSchooners} from '../lib/broilerBatchMeta.js';
import {checkDailyDuplicate, formatDuplicateError, friendlyDailyDbError} from '../lib/dailyDuplicateCheck.js';
import {softDeleteDailyReport, canDeleteDailyReport, updateDailyReport} from '../lib/dailyReportsApi.js';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {buildBroilerDailyExportColumns} from '../lib/dailyReportExports.js';
import {printRows} from '../lib/printExport.js';
import {listSavedViews, createSavedView, updateSavedView, deleteSavedView} from '../lib/savedViewsApi.js';
import AdminAddReportModal from '../shared/AdminAddReportModal.jsx';
import DailyPhotoThumbnails from '../shared/DailyPhotoThumbnails.jsx';
import OperationalListEmptyState from '../shared/OperationalListEmptyState.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import {DailyCardList, feedLbsVal, tagVal, gritVal, check, mortText, commentText} from '../shared/DailyRecordCards.jsx';
import {LockedTeamMemberField} from '../shared/recordPageControls.jsx';
import {usePersistentViewState} from '../lib/usePersistentViewState.js';
import PoultryDailyPage from './PoultryDailyPage.jsx';

const BROILER_DAILYS_SURFACE_KEY = 'broiler.dailys';
const VALID_BROILER_DAILY_SOURCE_FILTERS = new Set(['all', 'daily', 'addfeed']);

function BroilerDailysRouter(props) {
  const location = useLocation();
  const dailyId = location.pathname.startsWith('/broiler/dailys/')
    ? location.pathname.slice('/broiler/dailys/'.length) || null
    : null;
  if (dailyId) {
    return React.createElement(PoultryDailyPage, {
      sb: props.sb,
      fmt: props.fmt,
      authState: props.authState,
      Header: props.Header,
      batches: props.batches,
    });
  }
  return React.createElement(BroilerDailysHub, props);
}

const BroilerDailysHub = ({sb, fmt, Header, authState, batches, pendingEdit, setPendingEdit, refreshDailys}) => {
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
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [fBatch, setFBatch] = usePersistentViewState('broiler.dailys.batchFilter', '');
  const [fTeam, setFTeam] = usePersistentViewState('broiler.dailys.teamFilter', '');
  const [fFrom, setFFrom] = usePersistentViewState('broiler.dailys.fromFilter', '');
  const [fTo, setFTo] = usePersistentViewState('broiler.dailys.toFilter', '');
  const [srcFilter, setSrcFilter] = usePersistentViewState('broiler.dailys.sourceFilter', 'all');
  const EMPTY = {
    date: todayStr(),
    teamMember: '',
    batchLabel: '',
    feedType: 'GROWER',
    feedLbs: '',
    gritLbs: '',
    mortalityCount: '',
    mortalityReason: '',
    groupMoved: true,
    watererChecked: true,
    comments: '',
  };
  const [form, setForm] = useState(EMPTY);
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
  const PAGE = 1000;
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    sb.from('poultry_dailys')
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
        if (pendingEdit?.viewName === 'broilerdailys' && pendingEdit?.id) {
          const rec = (data || []).find((r) => r.id === pendingEdit.id);
          if (rec) {
            openEdit(rec);
            setPendingEdit(null);
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
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  async function loadSavedViews() {
    setSavedViewsLoading(true);
    try {
      const rows = await listSavedViews(sb, BROILER_DAILYS_SURFACE_KEY);
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

  // Auto-load all pages on mount (guarded to prevent duplicate fetches on re-render)
  const pgLoading = React.useRef(false);
  React.useEffect(() => {
    if (hasMore && !pgLoading.current) {
      pgLoading.current = true;
      const next = page + 1;
      sb.from('poultry_dailys')
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

  const [editSource, setEditSource] = useState(null);
  function openEdit(d) {
    setNotice(null);
    setForm({
      date: d.date || todayStr(),
      teamMember: d.team_member || '',
      batchLabel: d.batch_label || '',
      feedType: d.feed_type || 'GROWER',
      feedLbs: d.feed_lbs != null ? d.feed_lbs : '',
      gritLbs: d.grit_lbs != null ? d.grit_lbs : '',
      mortalityCount: d.mortality_count != null ? d.mortality_count : '',
      mortalityReason: d.mortality_reason || '',
      groupMoved: d.group_moved !== false,
      watererChecked: d.waterer_checked !== false,
      comments: d.comments || '',
      photos: Array.isArray(d.photos) ? d.photos : [],
    });
    setEditId(d.id);
    setEditSource(d.source || null);
    setShowForm(true);
  }
  const [showAddModal, setShowAddModal] = useState(false);
  async function save() {
    setNotice(null);
    if (parseInt(form.mortalityCount) > 0 && !(form.mortalityReason || '').trim()) {
      setNotice({kind: 'error', message: 'Mortality reason is required when mortalities are reported.'});
      return;
    }
    const rec = {
      date: form.date,
      team_member: form.teamMember,
      batch_label: form.batchLabel,
      feed_type: form.feedType || 'GROWER',
      feed_lbs: form.feedLbs !== '' ? parseFloat(form.feedLbs) : 0,
      grit_lbs: form.gritLbs !== '' ? parseFloat(form.gritLbs) : 0,
      mortality_count: form.mortalityCount !== '' ? parseInt(form.mortalityCount) : 0,
      mortality_reason: form.mortalityReason || null,
      group_moved: form.groupMoved,
      waterer_checked: form.watererChecked,
      comments: form.comments || null,
    };
    if (editId) {
      updateDailyReport(sb, 'poultry.daily', editId, rec, {entityLabel: rec.date})
        .then(() => {
          refreshDailys && refreshDailys('broiler');
        })
        .catch((e) => {
          setNotice({
            kind: 'error',
            message: 'Save failed: ' + friendlyDailyDbError(e.message || String(e), 'poultry_dailys', rec),
          });
        });
      setRecords((p) => p.map((r) => (r.id === editId ? {...r, ...rec} : r)));
      setShowForm(false);
      setEditId(null);
    } else {
      try {
        const dupe = await checkDailyDuplicate(sb, 'poultry_dailys', rec);
        if (dupe) {
          setNotice({kind: 'error', message: formatDuplicateError('poultry_dailys', rec)});
          return;
        }
      } catch (e) {
        setNotice({kind: 'error', message: e.message || 'Could not verify duplicate report.'});
        return;
      }
      const {data, error} = await sb
        .from('poultry_dailys')
        .insert({...rec, submitted_at: new Date().toISOString()})
        .select()
        .single();
      if (error) {
        setNotice({kind: 'error', message: 'Save failed: ' + friendlyDailyDbError(error, 'poultry_dailys', rec)});
      } else if (data) {
        setRecords((p) => [data, ...p]);
        refreshDailys && refreshDailys('broiler');
      }
      setShowForm(false);
      setEditId(null);
    }
  }
  function del(id) {
    window._wcfConfirmDelete?.('Delete this daily report?', async () => {
      const rec = records.find((r) => r.id === id);
      const label = rec ? rec.date + (rec.batch_label ? ' · ' + rec.batch_label : '') : id;
      await softDeleteDailyReport(sb, 'poultry_dailys', id, label);
      setRecords((p) => p.filter((r) => r.id !== id));
      refreshDailys && refreshDailys('broiler');
      setShowForm(false);
      setEditId(null);
    });
  }

  const batchMeta = batches
    .filter((b) => b.status === 'active')
    .map((b) => ({
      name: b.name,
      schooners: splitSchooners(b.schooner),
      brooder: b.brooder || null,
      brooderOut: b.brooderOut || null,
    }));
  const batchOpts = [...new Set(records.map((r) => r.batch_label).filter(Boolean))].sort();
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

  function broilerDailysViewState() {
    return {
      fBatch: fBatch || '',
      fTeam: fTeam || '',
      fFrom: fFrom || '',
      fTo: fTo || '',
      srcFilter: VALID_BROILER_DAILY_SOURCE_FILTERS.has(srcFilter) ? srcFilter : 'all',
    };
  }

  function applyBroilerDailysSavedView(view) {
    if (!view) return;
    const st = view.view_state || {};
    setFBatch(typeof st.fBatch === 'string' ? st.fBatch : '');
    setFTeam(typeof st.fTeam === 'string' ? st.fTeam : '');
    setFFrom(typeof st.fFrom === 'string' ? st.fFrom : '');
    setFTo(typeof st.fTo === 'string' ? st.fTo : '');
    setSrcFilter(VALID_BROILER_DAILY_SOURCE_FILTERS.has(st.srcFilter) ? st.srcFilter : 'all');
    setSavedViewNotice(null);
  }

  function onSelectSavedView(id) {
    setSelectedViewId(id);
    setSavedViewNotice(null);
    if (!id) return;
    applyBroilerDailysSavedView(savedViews.find((v) => v.id === id));
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
        surfaceKey: BROILER_DAILYS_SURFACE_KEY,
        name,
        visibility: saveViewVisibility,
        viewState: broilerDailysViewState(),
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
      await updateSavedView(sb, selectedView.id, {viewState: broilerDailysViewState()});
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
    const columns = buildBroilerDailyExportColumns();
    const ok = downloadCsv(csvFilename('broiler-dailys'), rowsToCsv(columns, filtered));
    setExportNotice(ok ? '' : 'CSV export is only available in the browser.');
  }

  function handlePrintRows() {
    const columns = buildBroilerDailyExportColumns();
    const ok = printRows({
      title: 'Broiler Dailys',
      subtitle: filtered.length + ' filtered daily reports',
      columns,
      rows: filtered,
    });
    setExportNotice(ok ? '' : 'Print is only available in the browser.');
  }

  const totalFeed = filtered.reduce((s, r) => s + (parseFloat(r.feed_lbs) || 0), 0);
  const totalMort = filtered.reduce((s, r) => s + (parseInt(r.mortality_count) || 0), 0);
  const fi = {
    padding: '6px 10px',
    borderRadius: 10,
    border: '1px solid var(--border-strong)',
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
  const savedViewPrimaryBtnS = {
    ...savedViewGhostBtnS,
    border: `1px solid ${getProgramColor('broiler')}`,
    color: getProgramColor('broiler'),
  };
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
      data-broiler-dailys-loaded={loading || loadError ? 'false' : 'true'}
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
            <div style={{fontSize: 15, fontWeight: 700, color: 'var(--ink)'}}>Daily Reports</div>
            <div style={{fontSize: 12, color: 'var(--ink-muted)', marginTop: 2}}>
              {records.length.toLocaleString()} total
            </div>
          </div>
          <div style={{display: 'flex', gap: 8}}>
            <button
              onClick={() => {
                setNotice(null);
                setShowAddModal(true);
              }}
              style={{
                padding: '10px 16px',
                borderRadius: 10,
                border: 'none',
                background: getProgramColor('broiler'),
                color: getReadableText(getProgramColor('broiler')),
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
            formType="broiler"
            onClose={() => setShowAddModal(false)}
            onSaved={(recs) => {
              setRecords((p) => [...recs, ...p]);
              refreshDailys && refreshDailys('broiler');
            }}
          />
        )}
        {!loadError && (
          <>
            <div
              data-broiler-dailys-saved-views-row
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
                <span style={{fontSize: 12, color: '#b91c1c'}} data-broiler-dailys-saved-views-error>
                  Saved views unavailable. Filters still work.
                </span>
              ) : (
                <>
                  <select
                    data-broiler-dailys-saved-view-select
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
                        data-broiler-dailys-saved-view-update
                        onClick={updateSelectedView}
                        disabled={savedViewBusy}
                        style={savedViewGhostBtnS}
                      >
                        Update to current
                      </button>
                      <button
                        type="button"
                        data-broiler-dailys-saved-view-delete
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
                    data-broiler-dailys-saved-view-save-open
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
                data-broiler-dailys-saved-view-form
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
                  data-broiler-dailys-saved-view-name
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
                    name="saveBroilerDailysViewVisibility"
                    checked={saveViewVisibility === 'private'}
                    onChange={() => setSaveViewVisibility('private')}
                    data-broiler-dailys-saved-view-visibility="private"
                  />
                  Private
                </label>
                <label style={savedViewRadioLabelS}>
                  <input
                    type="radio"
                    name="saveBroilerDailysViewVisibility"
                    checked={saveViewVisibility === 'public'}
                    onChange={() => setSaveViewVisibility('public')}
                    data-broiler-dailys-saved-view-visibility="public"
                  />
                  Public
                </label>
                <button
                  type="button"
                  data-broiler-dailys-saved-view-save
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
          <span style={{fontSize: 12, color: 'var(--ink-muted)'}}>to</span>
          <input type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} style={{...fi, width: 130}} />
          <select value={fBatch} onChange={(e) => setFBatch(e.target.value)} style={fi}>
            <option value="">All groups</option>
            {batchOpts.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <select
            value={fTeam}
            onChange={(e) => setFTeam(e.target.value)}
            style={fi}
            data-broiler-dailys-team-filter="1"
          >
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
              style={{...fi, color: 'var(--ink-muted)', cursor: 'pointer'}}
            >
              Clear
            </button>
          )}
          <div
            style={{
              display: 'flex',
              borderRadius: 10,
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
                    border: srcFilter === o.k ? '1px solid #92400e' : 'none',
                    borderRight: oi < 2 ? '1px solid #d1d5db' : 'none',
                    fontFamily: 'inherit',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    background: 'white',
                    color: srcFilter === o.k ? '#92400e' : 'var(--ink-muted)',
                  }}
                >
                  {o.l}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            data-broiler-dailys-export-csv="1"
            onClick={handleExportCsv}
            disabled={loading || !!loadError}
            style={{
              ...fi,
              color: loading || loadError ? 'var(--ink-faint)' : 'var(--ink)',
              fontWeight: 600,
              cursor: loading || loadError ? 'not-allowed' : 'pointer',
            }}
          >
            Export CSV
          </button>
          <button
            type="button"
            data-broiler-dailys-print="1"
            onClick={handlePrintRows}
            disabled={loading || !!loadError}
            style={{
              ...fi,
              color: loading || loadError ? 'var(--ink-faint)' : 'var(--ink)',
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
            Retry
          </button>
        )}
        <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
        {loading && <div style={{textAlign: 'center', padding: '3rem', color: 'var(--ink-faint)'}}>Loading...</div>}
        <OperationalListEmptyState
          loading={loading}
          loadError={loadError}
          totalCount={records.length}
          filteredCount={filtered.length}
          emptyLabel="No broiler daily reports yet"
        />
        {!loading && !loadError && filtered.length > 0 && (
          <DailyCardList
            program="broiler"
            rows={filtered}
            fmt={fmt}
            maxInitialRows={100}
            onOpen={(d) =>
              navigate('/broiler/dailys/' + d.id, recordSeqNavOptions(dailySeqItems(filtered, 'batch_label')))
            }
            rowAttrs={(d) => ({'data-daily-row': d.id})}
            mapRow={(d) => ({
              name: d.batch_label || '—',
              team: d.team_member || '—',
              source: d.source,
              photos: d.photos,
              vals: {
                feed: feedLbsVal(d.feed_lbs),
                feedTag: d.feed_type ? tagVal(d.feed_type) : '',
                grit: gritVal(d.grit_lbs),
              },
              checks: [check('Moved', d.group_moved !== false), check('Waterer', d.waterer_checked !== false)],
              mort: mortText(d.mortality_count, d.mortality_reason),
              comment: commentText(d.comments),
            })}
          />
        )}
        {hasMore && (
          <div style={{textAlign: 'center', padding: '0.5rem', fontSize: 11, color: 'var(--ink-faint)'}}>
            Loading more records...
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
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                position: 'sticky',
                top: 0,
                background: 'white',
              }}
            >
              <div style={{fontSize: 15, fontWeight: 600, color: '#085041'}}>
                {editId
                  ? editSource === 'add_feed_webform'
                    ? 'Edit Broiler Add Feed Report'
                    : 'Edit Broiler Daily Report'
                  : 'Add Broiler Daily Report'}
              </div>
              <button
                onClick={() => {
                  setNotice(null);
                  setShowForm(false);
                }}
                style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--ink-faint)'}}
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
                <label style={S.label}>Group</label>
                <select value={form.batchLabel} onChange={(e) => setForm((f) => ({...f, batchLabel: e.target.value}))}>
                  <option value="">Select group...</option>
                  {batches
                    .filter((b) => b.status === 'active')
                    .map((b) => (
                      <option key={b.name} value={b.name}>
                        {formatBroilerBatchLabel(b.name, batchMeta)}
                      </option>
                    ))}
                  {batchOpts
                    .filter((b) => !batches.some((bt) => bt.name === b))
                    .map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                </select>
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={S.label}>Feed Type</label>
                <div
                  style={{
                    display: 'flex',
                    borderRadius: 10,
                    overflow: 'hidden',
                    border: '1px solid var(--border-strong)',
                  }}
                >
                  {[
                    {v: 'STARTER', l: 'Starter'},
                    {v: 'GROWER', l: 'Grower'},
                  ].map(({v, l}) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setForm((f) => ({...f, feedType: v}))}
                      style={{
                        flex: 1,
                        padding: '7px 0',
                        border: 'none',
                        fontFamily: 'inherit',
                        fontSize: 12,
                        cursor: 'pointer',
                        background: form.feedType === v ? '#085041' : '#f9fafb',
                        color: form.feedType === v ? 'white' : '#6b7280',
                      }}
                    >
                      {l}
                    </button>
                  ))}
                </div>
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
                  <label style={S.label}>Grit (lbs)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={form.gritLbs || ''}
                    onChange={(e) => setForm((f) => ({...f, gritLbs: e.target.value}))}
                    placeholder="0"
                  />
                </div>
              )}
              {editSource !== 'add_feed_webform' && (
                <div>
                  <label style={S.label}>Mortality count</label>
                  <input
                    type="number"
                    min="0"
                    value={form.mortalityCount || ''}
                    onChange={(e) => setForm((f) => ({...f, mortalityCount: e.target.value}))}
                    placeholder="0"
                  />
                </div>
              )}
              {editSource !== 'add_feed_webform' && parseInt(form.mortalityCount) > 0 && (
                <div>
                  <label style={S.label}>
                    Mortality reason <span style={{color: '#dc2626'}}>*</span>
                  </label>
                  <input
                    value={form.mortalityReason}
                    onChange={(e) => setForm((f) => ({...f, mortalityReason: e.target.value}))}
                  />
                </div>
              )}
              {editSource !== 'add_feed_webform' && (
                <div>
                  <label style={S.label}>Group moved?</label>
                  <div
                    style={{
                      display: 'flex',
                      borderRadius: 10,
                      overflow: 'hidden',
                      border: '1px solid var(--border-strong)',
                    }}
                  >
                    {[
                      {v: true, l: 'Yes'},
                      {v: false, l: 'No'},
                    ].map(({v, l}) => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => setForm((f) => ({...f, groupMoved: v}))}
                        style={{
                          flex: 1,
                          padding: '7px 0',
                          border: 'none',
                          fontFamily: 'inherit',
                          fontSize: 12,
                          cursor: 'pointer',
                          background: form.groupMoved === v ? (v ? '#085041' : '#374151') : '#f9fafb',
                          color: form.groupMoved === v ? 'white' : '#6b7280',
                        }}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {editSource !== 'add_feed_webform' && (
                <div>
                  <label style={S.label}>Waterer checked?</label>
                  <div
                    style={{
                      display: 'flex',
                      borderRadius: 10,
                      overflow: 'hidden',
                      border: '1px solid var(--border-strong)',
                    }}
                  >
                    {[
                      {v: true, l: 'Yes'},
                      {v: false, l: 'No'},
                    ].map(({v, l}) => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => setForm((f) => ({...f, watererChecked: v}))}
                        style={{
                          flex: 1,
                          padding: '7px 0',
                          border: 'none',
                          fontFamily: 'inherit',
                          fontSize: 12,
                          cursor: 'pointer',
                          background: form.watererChecked === v ? (v ? '#085041' : '#374151') : '#f9fafb',
                          color: form.watererChecked === v ? 'white' : '#6b7280',
                        }}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {editSource !== 'add_feed_webform' && (
                <div style={{gridColumn: '1/-1'}}>
                  <label style={S.label}>Comments</label>
                  <textarea
                    value={form.comments}
                    onChange={(e) => setForm((f) => ({...f, comments: e.target.value}))}
                    rows={2}
                    style={{resize: 'vertical'}}
                  />
                </div>
              )}
              <DailyPhotoThumbnails photos={form?.photos} />
            </div>
            <div style={{padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8}}>
              <button onClick={save} style={{...S.btnPrimary, width: 'auto'}}>
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

export default BroilerDailysRouter;
