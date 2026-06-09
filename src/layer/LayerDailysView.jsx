// Auto-extracted by Phase 2 Round 2 (verbatim). See MIGRATION_PLAN §6.
import React from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import {recordSeqNavOptions, dailySeqItems} from '../lib/recordSequence.js';
import {S} from '../lib/styles.js';
import {checkDailyDuplicate, formatDuplicateError, friendlyDailyDbError} from '../lib/dailyDuplicateCheck.js';
import {softDeleteDailyReport, canDeleteDailyReport, updateDailyReport} from '../lib/dailyReportsApi.js';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {buildLayerDailyExportColumns} from '../lib/dailyReportExports.js';
import {printRows} from '../lib/printExport.js';
import {todayCentralISO} from '../lib/dateUtils.js';
import {listSavedViews, createSavedView, updateSavedView, deleteSavedView} from '../lib/savedViewsApi.js';
import AdminAddReportModal from '../shared/AdminAddReportModal.jsx';
import DailyPhotoChip from '../shared/DailyPhotoChip.jsx';
import DailyPhotoThumbnails from '../shared/DailyPhotoThumbnails.jsx';
import OperationalListEmptyState from '../shared/OperationalListEmptyState.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import {LockedTeamMemberField} from '../shared/recordPageControls.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import LayerDailyPage from './LayerDailyPage.jsx';
import {setHousingAnchorFromReport} from '../lib/layerHousing.js';
import {usePersistentViewState} from '../lib/usePersistentViewState.js';
import {buildLayerDailyGroupOptions, resolveLayerDailyBatchId} from './layerDailyGroups.js';

const LAYER_DAILYS_SURFACE_KEY = 'layer.dailys';
const VALID_LAYER_DAILY_SOURCE_FILTERS = new Set(['all', 'daily', 'addfeed']);

function LayerDailysRouter(props) {
  const location = useLocation();
  const dailyId = location.pathname.startsWith('/layer/dailys/')
    ? location.pathname.slice('/layer/dailys/'.length) || null
    : null;
  if (dailyId) {
    return React.createElement(LayerDailyPage, {
      sb: props.sb,
      fmt: props.fmt,
      authState: props.authState,
      Header: props.Header,
      layerGroups: props.layerGroups,
      layerBatches: props.layerBatches,
      layerHousings: props.layerHousings,
    });
  }
  return React.createElement(LayerDailysHub, props);
}

const LayerDailysHub = ({
  sb,
  fmt,
  Header,
  authState,
  layerGroups,
  layerBatches = [],
  layerHousings = [],
  pendingEdit,
  setPendingEdit,
  refreshDailys,
}) => {
  const {useState, useEffect} = React;
  const todayStr = todayCentralISO;
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [fGroup, setFGroup] = usePersistentViewState('layer.dailys.groupFilter', '');
  const [fTeam, setFTeam] = usePersistentViewState('layer.dailys.teamFilter', '');
  const [fFrom, setFFrom] = usePersistentViewState('layer.dailys.fromFilter', '');
  const [fTo, setFTo] = usePersistentViewState('layer.dailys.toFilter', '');
  const [srcFilter, setSrcFilter] = usePersistentViewState('layer.dailys.sourceFilter', 'all');
  const EMPTY = {
    date: todayStr(),
    teamMember: '',
    batchLabel: '',
    feedType: 'LAYER',
    feedLbs: '',
    gritLbs: '',
    layerCount: '',
    groupMoved: true,
    watererChecked: true,
    mortalityCount: '',
    mortalityReason: '',
    comments: '',
  };
  const [form, setForm] = useState(EMPTY);
  const [notice, setNotice] = useState(null);
  const [exportNotice, setExportNotice] = useState('');
  const [loadError, setLoadError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
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
  const navigate = useNavigate();

  const PAGE = 1000;
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    sb.from('layer_dailys')
      .select('*')
      .is('deleted_at', null)
      .order('date', {ascending: false})
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
        if (pendingEdit?.viewName === 'layerdailys' && pendingEdit?.id) {
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
      const rows = await listSavedViews(sb, LAYER_DAILYS_SURFACE_KEY);
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

  // Auto-load all pages on mount (guarded to prevent duplicate fetches on re-render)
  const pgLoading = React.useRef(false);
  React.useEffect(() => {
    if (hasMore && !pgLoading.current) {
      pgLoading.current = true;
      const next = page + 1;
      sb.from('layer_dailys')
        .select('*')
        .is('deleted_at', null)
        .order('date', {ascending: false})
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

  const [editSource, setEditSource] = useState(null);
  function openEdit(d) {
    setNotice(null);
    setForm({
      date: d.date || todayStr(),
      teamMember: d.team_member || '',
      batchLabel: d.batch_label || '',
      feedType: d.feed_type || 'LAYER',
      feedLbs: d.feed_lbs != null ? d.feed_lbs : '',
      gritLbs: d.grit_lbs != null ? d.grit_lbs : '',
      layerCount: d.layer_count != null ? d.layer_count : '',
      groupMoved: d.group_moved !== false,
      watererChecked: d.waterer_checked !== false,
      mortalityCount: d.mortality_count != null ? d.mortality_count : '',
      mortalityReason: d.mortality_reason || '',
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
    const existingRecord = editId ? records.find((r) => r.id === editId) : null;
    const batchId =
      existingRecord && form.batchLabel === existingRecord.batch_label
        ? existingRecord.batch_id ||
          resolveLayerDailyBatchId(form.batchLabel, {layerGroups, layerBatches, layerHousings})
        : resolveLayerDailyBatchId(form.batchLabel, {layerGroups, layerBatches, layerHousings});
    const rec = {
      date: form.date,
      team_member: form.teamMember,
      batch_label: form.batchLabel,
      batch_id: batchId,
      feed_type: form.feedType || 'LAYER',
      feed_lbs: form.feedLbs !== '' ? parseFloat(form.feedLbs) : 0,
      grit_lbs: form.gritLbs !== '' ? parseFloat(form.gritLbs) : 0,
      layer_count: form.layerCount !== '' ? parseInt(form.layerCount) : null,
      group_moved: form.groupMoved,
      waterer_checked: form.watererChecked,
      mortality_count: form.mortalityCount !== '' ? parseInt(form.mortalityCount) : 0,
      mortality_reason: form.mortalityReason || null,
      comments: form.comments || null,
    };
    if (editId) {
      try {
        await updateDailyReport(sb, 'layer.daily', editId, rec, {entityLabel: rec.date});
      } catch (e) {
        setNotice({
          kind: 'error',
          message: 'Save failed: ' + friendlyDailyDbError(e.message || String(e), 'layer_dailys', rec),
        });
        return;
      }
      setRecords((p) => p.map((r) => (r.id === editId ? {...r, ...rec} : r)));
      // Model X: hen count is the anchor. If this edit has a hen count, update the housing anchor.
      // Mortality changes don't touch current_count (projected math handles them at display time).
      const lc = parseInt(rec.layer_count);
      if (!isNaN(lc) && lc >= 0 && rec.batch_label) {
        const result = await setHousingAnchorFromReport(sb, rec.batch_label, lc, rec.date);
        if (!result || !result.ok) {
          if (result && result.reason === 'ambiguous-batch') {
            setNotice({
              kind: 'warning',
              message:
                'Hen count saved on the report, but the housing anchor was NOT updated.\n\nThe batch "' +
                result.batchName +
                '" has multiple active housings (' +
                result.housingNames.join(', ') +
                '). Please go to Layers \u203a Housings and set the count manually on the correct housing.',
            });
          } else if (result && result.reason === 'no-match') {
            setNotice({
              kind: 'warning',
              message:
                'Hen count saved on the report, but no matching housing was found for "' +
                rec.batch_label +
                '". Please update the housing count manually if needed.',
            });
          }
        }
      }
      refreshDailys && refreshDailys('layer');
      setShowForm(false);
      setEditId(null);
    } else {
      try {
        const dupe = await checkDailyDuplicate(sb, 'layer_dailys', rec);
        if (dupe) {
          setNotice({kind: 'error', message: formatDuplicateError('layer_dailys', rec)});
          return;
        }
      } catch (e) {
        setNotice({kind: 'error', message: e.message || 'Could not verify duplicate report.'});
        return;
      }
      const {data, error} = await sb
        .from('layer_dailys')
        .insert({...rec, submitted_at: new Date().toISOString()})
        .select()
        .single();
      if (error) {
        setNotice({kind: 'error', message: 'Save failed: ' + friendlyDailyDbError(error, 'layer_dailys', rec)});
        return;
      }
      if (data) {
        setRecords((p) => [data, ...p]);
      }
      // Hen count → update housing anchor
      const lc = parseInt(rec.layer_count);
      if (!isNaN(lc) && lc >= 0 && rec.batch_label) {
        const result = await setHousingAnchorFromReport(sb, rec.batch_label, lc, rec.date);
        if (!result || !result.ok) {
          if (result && result.reason === 'ambiguous-batch') {
            setNotice({
              kind: 'warning',
              message:
                'Hen count saved on the report, but the housing anchor was NOT updated.\n\nThe batch "' +
                result.batchName +
                '" has multiple active housings (' +
                result.housingNames.join(', ') +
                '). Please go to Layers \u203a Housings and set the count manually on the correct housing.',
            });
          } else if (result && result.reason === 'no-match') {
            setNotice({
              kind: 'warning',
              message:
                'Hen count saved on the report, but no matching housing was found for "' +
                rec.batch_label +
                '". Please update the housing count manually if needed.',
            });
          }
        }
      }
      refreshDailys && refreshDailys('layer');
      setShowForm(false);
      setEditId(null);
    }
  }
  function del(id) {
    window._wcfConfirmDelete?.('Delete this daily report?', async () => {
      // Note: deleting a report does NOT roll back the housing anchor automatically
      // because anchors might have been overwritten by later reports. If the user needs
      // to correct an anchor, they should submit a new report with the corrected count.
      const rec = records.find((r) => r.id === id);
      const label = rec ? rec.date + (rec.batch_label ? ' · ' + rec.batch_label : '') : id;
      await softDeleteDailyReport(sb, 'layer_dailys', id, label);
      setRecords((p) => p.filter((r) => r.id !== id));
      refreshDailys && refreshDailys('layer');
      setShowForm(false);
      setEditId(null);
    });
  }

  const groupOpts = buildLayerDailyGroupOptions({
    layerGroups,
    layerBatches,
    layerHousings,
    currentLabel: form.batchLabel,
  });
  const allGroups = [...new Set(records.map((r) => r.batch_label).filter(Boolean))].sort();
  const teamOpts = [...new Set(records.map((r) => r.team_member).filter(Boolean))].sort();
  const filtered = records.filter(
    (r) =>
      (!fGroup || r.batch_label === fGroup) &&
      (!fTeam || r.team_member === fTeam) &&
      (!fFrom || r.date >= fFrom) &&
      (!fTo || r.date <= fTo) &&
      (srcFilter === 'all' ||
        (srcFilter === 'daily' && r.source !== 'add_feed_webform') ||
        (srcFilter === 'addfeed' && r.source === 'add_feed_webform')),
  );
  const selectedView = savedViews.find((v) => v.id === selectedViewId) || null;
  const selectedViewIsMine = !!(selectedView && myProfileId && selectedView.owner_profile_id === myProfileId);

  function layerDailysViewState() {
    return {
      fGroup: fGroup || '',
      fTeam: fTeam || '',
      fFrom: fFrom || '',
      fTo: fTo || '',
      srcFilter: VALID_LAYER_DAILY_SOURCE_FILTERS.has(srcFilter) ? srcFilter : 'all',
    };
  }

  function applyLayerDailysSavedView(view) {
    if (!view) return;
    const st = view.view_state || {};
    setFGroup(typeof st.fGroup === 'string' ? st.fGroup : '');
    setFTeam(typeof st.fTeam === 'string' ? st.fTeam : '');
    setFFrom(typeof st.fFrom === 'string' ? st.fFrom : '');
    setFTo(typeof st.fTo === 'string' ? st.fTo : '');
    setSrcFilter(VALID_LAYER_DAILY_SOURCE_FILTERS.has(st.srcFilter) ? st.srcFilter : 'all');
    setSavedViewNotice(null);
  }

  function onSelectSavedView(id) {
    setSelectedViewId(id);
    setSavedViewNotice(null);
    if (!id) return;
    applyLayerDailysSavedView(savedViews.find((v) => v.id === id));
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
        surfaceKey: LAYER_DAILYS_SURFACE_KEY,
        name,
        visibility: saveViewVisibility,
        viewState: layerDailysViewState(),
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
      await updateSavedView(sb, selectedView.id, {viewState: layerDailysViewState()});
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
    const columns = buildLayerDailyExportColumns();
    const ok = downloadCsv(csvFilename('layer-dailys'), rowsToCsv(columns, filtered));
    setExportNotice(ok ? '' : 'CSV export is only available in the browser.');
  }

  function handlePrintRows() {
    const columns = buildLayerDailyExportColumns();
    const ok = printRows({
      title: 'Layer Dailys',
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
    ...fi,
    color: '#374151',
    fontWeight: 600,
    cursor: 'pointer',
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
      data-layer-dailys-loaded={loading || loadError ? 'false' : 'true'}
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
          <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
            <button
              type="button"
              data-layer-dailys-export-csv="1"
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
              data-layer-dailys-print="1"
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
        {exportNotice && <div style={{marginBottom: 14, color: '#b91c1c', fontSize: 12}}>{exportNotice}</div>}
        {showAddModal && (
          <AdminAddReportModal
            sb={sb}
            formType="layer"
            onClose={() => setShowAddModal(false)}
            onSaved={(recs) => {
              setRecords((p) => [...recs, ...p]);
              refreshDailys && refreshDailys('layer');
            }}
          />
        )}
        {!loadError && (
          <>
            <div
              data-layer-dailys-saved-views-row
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
                <span style={{fontSize: 12, color: '#b91c1c'}} data-layer-dailys-saved-views-error>
                  Saved views unavailable. Filters still work.
                </span>
              ) : (
                <>
                  <select
                    data-layer-dailys-saved-view-select
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
                        data-layer-dailys-saved-view-update
                        onClick={updateSelectedView}
                        disabled={savedViewBusy}
                        style={savedViewGhostBtnS}
                      >
                        Update to current
                      </button>
                      <button
                        type="button"
                        data-layer-dailys-saved-view-delete
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
                    data-layer-dailys-saved-view-save-open
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
                data-layer-dailys-saved-view-form
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
                  data-layer-dailys-saved-view-name
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
                    name="saveLayerDailysViewVisibility"
                    checked={saveViewVisibility === 'private'}
                    onChange={() => setSaveViewVisibility('private')}
                    data-layer-dailys-saved-view-visibility="private"
                  />
                  Private
                </label>
                <label style={savedViewRadioLabelS}>
                  <input
                    type="radio"
                    name="saveLayerDailysViewVisibility"
                    checked={saveViewVisibility === 'public'}
                    onChange={() => setSaveViewVisibility('public')}
                    data-layer-dailys-saved-view-visibility="public"
                  />
                  Public
                </label>
                <button
                  type="button"
                  data-layer-dailys-saved-view-save
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
        <div style={{display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center'}}>
          <input type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} style={{...fi, width: 130}} />
          <span style={{fontSize: 12, color: '#6b7280'}}>to</span>
          <input type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} style={{...fi, width: 130}} />
          <select value={fGroup} onChange={(e) => setFGroup(e.target.value)} style={fi}>
            <option value="">All groups</option>
            {allGroups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          <select data-layer-dailys-team-filter="1" value={fTeam} onChange={(e) => setFTeam(e.target.value)} style={fi}>
            <option value="">All team members</option>
            {teamOpts.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {(fGroup || fTeam || fFrom || fTo || srcFilter !== 'all') && (
            <button
              onClick={() => {
                setFGroup('');
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
          emptyLabel="No layer daily reports yet"
        />
        {!loading && !loadError && filtered.length > 0 && (
          <div style={{display: 'flex', flexDirection: 'column', gap: 4}}>
            {(() => {
              const dates = [...new Set(filtered.map((r) => r.date))];
              return filtered.map((d, i) => {
                const hasMort = parseInt(d.mortality_count) > 0;
                const hasFeed = parseFloat(d.feed_lbs) > 0;
                const hasGrit = parseFloat(d.grit_lbs) > 0;
                const hasCount = parseInt(d.layer_count) > 0;
                const comment = d.comments && String(d.comments).trim().length > 2 ? String(d.comments).trim() : '';
                const notable = hasMort || comment;
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
                        navigate('/layer/dailys/' + d.id, recordSeqNavOptions(dailySeqItems(filtered, 'batch_label')))
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
                          gridTemplateColumns: '90px 130px 90px 150px 90px 90px 1fr',
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
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            overflow: 'hidden',
                            whiteSpace: 'nowrap',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {hasFeed ? `\ud83c\udf3e ${parseFloat(d.feed_lbs).toLocaleString()} lbs` : 'no feed'}
                          {hasFeed && d.feed_type && (
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                padding: '1px 5px',
                                borderRadius: 4,
                                background:
                                  d.feed_type === 'STARTER'
                                    ? '#dbeafe'
                                    : d.feed_type === 'GROWER'
                                      ? '#d1fae5'
                                      : '#fef3c7',
                                color:
                                  d.feed_type === 'STARTER'
                                    ? '#1e40af'
                                    : d.feed_type === 'GROWER'
                                      ? '#065f46'
                                      : '#92400e',
                              }}
                            >
                              {d.feed_type}
                            </span>
                          )}
                        </span>
                        <span
                          style={{
                            color: '#374151',
                            fontSize: 12,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {hasGrit ? `grit ${parseFloat(d.grit_lbs)} lbs` : 'no grit'}
                        </span>
                        <span style={{color: '#374151', fontSize: 12, whiteSpace: 'nowrap'}}>
                          {hasCount ? `\ud83d\udc14 ${d.layer_count} hens` : 'no count'}
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
                              background: d.waterer_checked === false ? '#fef2f2' : '#f0fdf4',
                              color: d.waterer_checked === false ? '#b91c1c' : '#065f46',
                              border: d.waterer_checked === false ? '1px solid #fecaca' : '1px solid #bbf7d0',
                            }}
                          >
                            {'Waterer: ' + (d.waterer_checked === false ? 'No' : 'Yes')}
                          </span>
                        </span>
                      </div>
                      {(hasMort || comment) && (
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
                          {comment && (
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
                              {'\ud83d\udcac ' + comment}
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
                borderBottom: '1px solid #e5e7eb',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                position: 'sticky',
                top: 0,
                background: 'white',
              }}
            >
              <div style={{fontSize: 15, fontWeight: 600, color: '#78350f'}}>
                {editId
                  ? editSource === 'add_feed_webform'
                    ? 'Edit Layer Add Feed Report'
                    : 'Edit Layer Daily Report'
                  : 'Add Layer Daily Report'}
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
                <label style={S.label}>Group</label>
                <select value={form.batchLabel} onChange={(e) => setForm((f) => ({...f, batchLabel: e.target.value}))}>
                  <option value="">Select group...</option>
                  {groupOpts.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                  {allGroups
                    .filter((g) => !groupOpts.includes(g))
                    .map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                </select>
              </div>
              {editSource === 'add_feed_webform' && (
                <div style={{gridColumn: '1/-1'}}>
                  <label style={S.label}>Feed Type</label>
                  <div style={{display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #d1d5db'}}>
                    {['STARTER', 'GROWER', 'LAYER'].map(function (ft, fi) {
                      return (
                        <button
                          key={ft}
                          type="button"
                          onClick={function () {
                            setForm(function (f) {
                              return {...f, feedType: f.feedType === ft ? '' : ft};
                            });
                          }}
                          style={{
                            flex: 1,
                            padding: '7px 0',
                            border: 'none',
                            borderRight: fi < 2 ? '1px solid #d1d5db' : 'none',
                            fontFamily: 'inherit',
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: 'pointer',
                            background: form.feedType === ft ? '#92400e' : '#f9fafb',
                            color: form.feedType === ft ? 'white' : '#6b7280',
                          }}
                        >
                          {ft}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
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
                  <label style={S.label}>Hen Count</label>
                  <input
                    type="number"
                    min="0"
                    value={form.layerCount || ''}
                    onChange={(e) => setForm((f) => ({...f, layerCount: e.target.value}))}
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
                <div style={{gridColumn: '1/-1'}}>
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
                  <div style={{display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #d1d5db'}}>
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
                  <div style={{display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #d1d5db'}}>
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

export default LayerDailysRouter;
