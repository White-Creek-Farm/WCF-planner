// Auto-extracted by Phase 2 Round 2 (verbatim). See MIGRATION_PLAN §6.
import React from 'react';
import {getProgramColor} from '../lib/programColors.js';
import {getReadableText} from '../lib/styles.js';
import {useLocation, useNavigate} from 'react-router-dom';
import {recordSeqNavOptions, dailySeqItems} from '../lib/recordSequence.js';
import {S} from '../lib/styles.js';
import {checkDailyDuplicate, formatDuplicateError, friendlyDailyDbError} from '../lib/dailyDuplicateCheck.js';
import {softDeleteDailyReport, canDeleteDailyReport, updateDailyReport} from '../lib/dailyReportsApi.js';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {buildEggDailyExportColumns} from '../lib/dailyReportExports.js';
import {printRows} from '../lib/printExport.js';
import {todayCentralISO} from '../lib/dateUtils.js';
import {listSavedViews, createSavedView, updateSavedView, deleteSavedView} from '../lib/savedViewsApi.js';
import AdminAddReportModal from '../shared/AdminAddReportModal.jsx';
import OperationalListEmptyState from '../shared/OperationalListEmptyState.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import {DailyCardList, commentText} from '../shared/DailyRecordCards.jsx';
import {LockedTeamMemberField} from '../shared/recordPageControls.jsx';
import {usePersistentViewState} from '../lib/usePersistentViewState.js';

import EggDailyPage from './EggDailyPage.jsx';

const EGG_DAILYS_SURFACE_KEY = 'layer.eggs';

function EggDailysRouter(props) {
  const location = useLocation();
  const dailyId = location.pathname.startsWith('/layer/eggs/')
    ? location.pathname.slice('/layer/eggs/'.length) || null
    : null;
  if (dailyId) {
    return React.createElement(EggDailyPage, {
      sb: props.sb,
      fmt: props.fmt,
      authState: props.authState,
      Header: props.Header,
    });
  }
  return React.createElement(EggDailysHub, props);
}

const EggDailysHub = ({sb, fmt, Header, authState, layerGroups, pendingEdit, setPendingEdit, refreshDailys}) => {
  const {useState, useEffect} = React;
  const todayStr = todayCentralISO;
  const activeGroups = (layerGroups || []).filter((g) => g.status === 'active');
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [fTeam, setFTeam] = usePersistentViewState('layer.eggs.teamFilter', '');
  const [fFrom, setFFrom] = usePersistentViewState('layer.eggs.fromFilter', '');
  const [fTo, setFTo] = usePersistentViewState('layer.eggs.toFilter', '');
  const EMPTY = {
    date: todayStr(),
    teamMember: '',
    group1Name: activeGroups[0]?.name || '',
    group1Count: '',
    group2Name: activeGroups[1]?.name || '',
    group2Count: '',
    group3Name: activeGroups[2]?.name || '',
    group3Count: '',
    group4Name: activeGroups[3]?.name || '',
    group4Count: '',
    dozensOnHand: '',
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
    sb.from('egg_dailys')
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
            message: 'Could not load egg reports. Please refresh the page. (' + (error.message || error) + ')',
          });
          setLoading(false);
          return;
        }
        setRecords(data || []);
        setHasMore((data || []).length === PAGE);
        if (pendingEdit?.viewName === 'eggdailys' && pendingEdit?.id) {
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
          message: 'Could not load egg reports. Please refresh the page. (' + ((e && e.message) || e) + ')',
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
      const rows = await listSavedViews(sb, EGG_DAILYS_SURFACE_KEY);
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
      sb.from('egg_dailys')
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

  function openEdit(d) {
    setNotice(null);
    setForm({
      date: d.date || todayStr(),
      teamMember: d.team_member || '',
      group1Name: d.group1_name || '',
      group1Count: d.group1_count != null ? d.group1_count : '',
      group2Name: d.group2_name || '',
      group2Count: d.group2_count != null ? d.group2_count : '',
      group3Name: d.group3_name || '',
      group3Count: d.group3_count != null ? d.group3_count : '',
      group4Name: d.group4_name || '',
      group4Count: d.group4_count != null ? d.group4_count : '',
      dozensOnHand: d.dozens_on_hand != null ? d.dozens_on_hand : '',
      comments: d.comments || '',
    });
    setEditId(d.id);
    setShowForm(true);
  }
  const [showAddModal, setShowAddModal] = useState(false);
  async function save() {
    setNotice(null);
    const g1 = form.group1Count !== '' ? parseInt(form.group1Count) : 0;
    const g2 = form.group2Count !== '' ? parseInt(form.group2Count) : 0;
    const g3 = form.group3Count !== '' ? parseInt(form.group3Count) : 0;
    const g4 = form.group4Count !== '' ? parseInt(form.group4Count) : 0;
    const totalEggs = (g1 || 0) + (g2 || 0) + (g3 || 0) + (g4 || 0);
    const rec = {
      date: form.date,
      team_member: form.teamMember,
      group1_name: form.group1Name || null,
      group1_count: form.group1Count !== '' ? g1 : null,
      group2_name: form.group2Name || null,
      group2_count: form.group2Count !== '' ? g2 : null,
      group3_name: form.group3Name || null,
      group3_count: form.group3Count !== '' ? g3 : null,
      group4_name: form.group4Name || null,
      group4_count: form.group4Count !== '' ? g4 : null,
      daily_dozen_count: Math.floor(totalEggs / 12),
      dozens_on_hand: form.dozensOnHand !== '' ? parseFloat(form.dozensOnHand) : null,
      comments: form.comments || null,
    };
    if (editId) {
      updateDailyReport(sb, 'egg.daily', editId, rec, {entityLabel: rec.date})
        .then(() => {
          refreshDailys && refreshDailys('egg');
        })
        .catch((e) => {
          setNotice({
            kind: 'error',
            message: 'Save failed: ' + friendlyDailyDbError(e.message || String(e), 'egg_dailys', rec),
          });
        });
      setRecords((p) => p.map((r) => (r.id === editId ? {...r, ...rec} : r)));
      setShowForm(false);
      setEditId(null);
    } else {
      try {
        const dupe = await checkDailyDuplicate(sb, 'egg_dailys', rec);
        if (dupe) {
          setNotice({kind: 'error', message: formatDuplicateError('egg_dailys', rec)});
          return;
        }
      } catch (e) {
        setNotice({kind: 'error', message: e.message || 'Could not verify duplicate report.'});
        return;
      }
      const {data, error} = await sb
        .from('egg_dailys')
        .insert({...rec, submitted_at: new Date().toISOString()})
        .select()
        .single();
      if (error) {
        setNotice({kind: 'error', message: 'Save failed: ' + friendlyDailyDbError(error, 'egg_dailys', rec)});
      } else if (data) {
        setRecords((p) => [data, ...p]);
        refreshDailys && refreshDailys('egg');
      }
      setShowForm(false);
      setEditId(null);
    }
  }
  function del(id) {
    window._wcfConfirmDelete?.('Delete this daily report?', async () => {
      const rec = records.find((r) => r.id === id);
      await softDeleteDailyReport(sb, 'egg_dailys', id, rec ? rec.date : id);
      setRecords((p) => p.filter((r) => r.id !== id));
      refreshDailys && refreshDailys('egg');
      setShowForm(false);
      setEditId(null);
    });
  }

  const teamOpts = [...new Set(records.map((r) => r.team_member).filter(Boolean))].sort();
  const filtered = records.filter(
    (r) => (!fTeam || r.team_member === fTeam) && (!fFrom || r.date >= fFrom) && (!fTo || r.date <= fTo),
  );
  const totalEggs = filtered.reduce(
    (s, r) =>
      s +
      (parseInt(r.group1_count) || 0) +
      (parseInt(r.group2_count) || 0) +
      (parseInt(r.group3_count) || 0) +
      (parseInt(r.group4_count) || 0),
    0,
  );
  const selectedView = savedViews.find((v) => v.id === selectedViewId) || null;
  const selectedViewIsMine = !!(selectedView && myProfileId && selectedView.owner_profile_id === myProfileId);

  function eggDailysViewState() {
    return {
      fTeam: fTeam || '',
      fFrom: fFrom || '',
      fTo: fTo || '',
    };
  }

  function applyEggDailysSavedView(view) {
    if (!view) return;
    const st = view.view_state || {};
    setFTeam(typeof st.fTeam === 'string' ? st.fTeam : '');
    setFFrom(typeof st.fFrom === 'string' ? st.fFrom : '');
    setFTo(typeof st.fTo === 'string' ? st.fTo : '');
    setSavedViewNotice(null);
  }

  function onSelectSavedView(id) {
    setSelectedViewId(id);
    setSavedViewNotice(null);
    if (!id) return;
    applyEggDailysSavedView(savedViews.find((v) => v.id === id));
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
        surfaceKey: EGG_DAILYS_SURFACE_KEY,
        name,
        visibility: saveViewVisibility,
        viewState: eggDailysViewState(),
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
      await updateSavedView(sb, selectedView.id, {viewState: eggDailysViewState()});
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
    const columns = buildEggDailyExportColumns();
    const ok = downloadCsv(csvFilename('egg-dailys'), rowsToCsv(columns, filtered));
    setExportNotice(ok ? '' : 'CSV export is only available in the browser.');
  }

  function handlePrintRows() {
    const columns = buildEggDailyExportColumns();
    const ok = printRows({
      title: 'Egg Dailys',
      subtitle: filtered.length + ' filtered egg reports',
      columns,
      rows: filtered,
    });
    setExportNotice(ok ? '' : 'Print is only available in the browser.');
  }

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
    ...fi,
    color: 'var(--ink)',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
  const savedViewPrimaryBtnS = {
    ...savedViewGhostBtnS,
    border: `1px solid ${getProgramColor('layer')}`,
    color: getProgramColor('layer'),
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
      data-egg-dailys-loaded={loading || loadError ? 'false' : 'true'}
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
          <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
            <button
              type="button"
              data-egg-dailys-export-csv="1"
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
              data-egg-dailys-print="1"
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
            <button
              onClick={() => {
                setNotice(null);
                setShowAddModal(true);
              }}
              style={{
                padding: '10px 16px',
                borderRadius: 10,
                border: 'none',
                background: getProgramColor('layer'),
                color: getReadableText(getProgramColor('layer')),
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
            formType="egg"
            onClose={() => setShowAddModal(false)}
            onSaved={(recs) => {
              setRecords((p) => [...recs, ...p]);
              refreshDailys && refreshDailys('egg');
            }}
          />
        )}
        {!loadError && (
          <>
            <div
              data-egg-dailys-saved-views-row
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
                <span style={{fontSize: 12, color: '#b91c1c'}} data-egg-dailys-saved-views-error>
                  Saved views unavailable. Filters still work.
                </span>
              ) : (
                <>
                  <select
                    data-egg-dailys-saved-view-select
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
                        data-egg-dailys-saved-view-update
                        onClick={updateSelectedView}
                        disabled={savedViewBusy}
                        style={savedViewGhostBtnS}
                      >
                        Update to current
                      </button>
                      <button
                        type="button"
                        data-egg-dailys-saved-view-delete
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
                    data-egg-dailys-saved-view-save-open
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
                data-egg-dailys-saved-view-form
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
                  data-egg-dailys-saved-view-name
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
                    name="saveEggDailysViewVisibility"
                    checked={saveViewVisibility === 'private'}
                    onChange={() => setSaveViewVisibility('private')}
                    data-egg-dailys-saved-view-visibility="private"
                  />
                  Private
                </label>
                <label style={savedViewRadioLabelS}>
                  <input
                    type="radio"
                    name="saveEggDailysViewVisibility"
                    checked={saveViewVisibility === 'public'}
                    onChange={() => setSaveViewVisibility('public')}
                    data-egg-dailys-saved-view-visibility="public"
                  />
                  Public
                </label>
                <button
                  type="button"
                  data-egg-dailys-saved-view-save
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
          <span style={{fontSize: 12, color: 'var(--ink-muted)'}}>to</span>
          <input type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} style={{...fi, width: 130}} />
          <select data-egg-dailys-team-filter="1" value={fTeam} onChange={(e) => setFTeam(e.target.value)} style={fi}>
            <option value="">All team members</option>
            {teamOpts.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {(fTeam || fFrom || fTo) && (
            <button
              onClick={() => {
                setFTeam('');
                setFFrom('');
                setFTo('');
              }}
              style={{...fi, color: 'var(--ink-muted)', cursor: 'pointer'}}
            >
              Clear
            </button>
          )}
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
          emptyLabel="No egg reports yet"
          filteredLabel="No egg reports match the current filters"
        />
        {!loading && !loadError && filtered.length > 0 && (
          <DailyCardList
            program="egg"
            rows={filtered}
            fmt={fmt}
            maxInitialRows={100}
            onOpen={(d) => navigate('/layer/eggs/' + d.id, recordSeqNavOptions(dailySeqItems(filtered, null)))}
            rowAttrs={(d) => ({'data-daily-row': d.id})}
            mapRow={(d) => {
              const total =
                (parseInt(d.group1_count) || 0) +
                (parseInt(d.group2_count) || 0) +
                (parseInt(d.group3_count) || 0) +
                (parseInt(d.group4_count) || 0);
              const breakdown = [
                [d.group1_name, d.group1_count],
                [d.group2_name, d.group2_count],
                [d.group3_name, d.group3_count],
                [d.group4_name, d.group4_count],
              ]
                .filter(([n, c]) => n && parseInt(c) > 0)
                .map(([n, c]) => ({loc: n, n: c}));
              return {
                total,
                team: d.team_member || '—',
                breakdown,
                dozens: parseFloat(d.dozens_on_hand) > 0 ? d.dozens_on_hand + ' doz' : null,
                comment: commentText(d.comments),
              };
            }}
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
              <div style={{fontSize: 15, fontWeight: 600, color: '#78350f'}}>{editId ? 'Edit' : 'Add'} Egg Report</div>
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
              {[1, 2, 3, 4].map((n) => (
                <React.Fragment key={n}>
                  <div>
                    <label style={S.label}>Group {n}</label>
                    <select
                      value={form[`group${n}Name`]}
                      onChange={(e) => setForm((f) => ({...f, [`group${n}Name`]: e.target.value}))}
                    >
                      <option value="">—</option>
                      {activeGroups.map((g) => (
                        <option key={g.name} value={g.name}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={S.label}>Eggs</label>
                    <input
                      type="number"
                      min="0"
                      value={form[`group${n}Count`]}
                      onChange={(e) => setForm((f) => ({...f, [`group${n}Count`]: e.target.value}))}
                      placeholder="0"
                    />
                  </div>
                </React.Fragment>
              ))}
              <div style={{gridColumn: '1/-1'}}>
                <label style={S.label}>Dozens on Hand</label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={form.dozensOnHand || ''}
                  onChange={(e) => setForm((f) => ({...f, dozensOnHand: e.target.value}))}
                />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={S.label}>Collected Today (calculated)</label>
                <div
                  style={{
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    padding: '8px 12px',
                    fontSize: 14,
                    fontWeight: 700,
                    color: '#78350f',
                  }}
                >
                  {(() => {
                    const g1 = form.group1Count !== '' ? parseInt(form.group1Count) || 0 : 0;
                    const g2 = form.group2Count !== '' ? parseInt(form.group2Count) || 0 : 0;
                    const g3 = form.group3Count !== '' ? parseInt(form.group3Count) || 0 : 0;
                    const g4 = form.group4Count !== '' ? parseInt(form.group4Count) || 0 : 0;
                    const total = g1 + g2 + g3 + g4;
                    return total + ' eggs \u00b7 ' + Math.floor(total / 12) + ' dozen';
                  })()}
                </div>
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={S.label}>Comments</label>
                <textarea
                  value={form.comments}
                  onChange={(e) => setForm((f) => ({...f, comments: e.target.value}))}
                  rows={2}
                  style={{resize: 'vertical'}}
                />
              </div>
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

export default EggDailysRouter;
