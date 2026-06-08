import React from 'react';
import {useNavigate} from 'react-router-dom';
import {recordSeqNavOptions} from '../lib/recordSequence.js';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import SheepNewWeighInModal from './SheepNewWeighInModal.jsx';
import UsersModal from '../auth/UsersModal.jsx';
import {loadSheepWeighInsCached} from '../lib/sheepCache.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';
import {usePersistentViewState} from '../lib/usePersistentViewState.js';

const FLOCK_LABELS = {rams: 'Rams', ewes: 'Ewes', feeders: 'Feeders'};

const SheepWeighInsView = ({
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
  const [statusFilter, setStatusFilter] = usePersistentViewState('sheep.weighins.statusFilter', 'all');
  const [showNewModal, setShowNewModal] = useState(false);
  const [tagSearch, setTagSearch] = usePersistentViewState('sheep.weighins.tagSearch', '');
  const [notice, setNotice] = useState(null);

  async function loadAll() {
    setLoading(true);
    setNotice(null);
    try {
      const [sR, eAll] = await Promise.all([
        sb
          .from('weigh_in_sessions')
          .select('*')
          .eq('species', 'sheep')
          .order('date', {ascending: false})
          .order('started_at', {ascending: false}),
        loadSheepWeighInsCached(sb, {throwOnError: true}),
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
        message: 'Could not load sheep weigh-in sessions. Please refresh the page. (' + ((e && e.message) || e) + ')',
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function createNewSession(opts) {
    const id = 'wsess-' + String(Date.now()) + Math.random().toString(36).slice(2, 6);
    const rec = {
      id,
      date: opts.date,
      team_member: opts.team_member,
      species: 'sheep',
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

  function handleExportCsv() {
    const columns = [
      {header: 'Date', value: (s) => s.date || ''},
      {header: 'Flock', value: (s) => FLOCK_LABELS[s.herd] || s.herd || ''},
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
    const ok = downloadCsv(csvFilename('sheep-weigh-in-sessions'), rowsToCsv(columns, filtered));
    if (!ok) setNotice({kind: 'error', message: 'CSV export is only available in the browser.'});
  }

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
            <div style={{fontSize: 16, fontWeight: 700, color: '#111827'}}>Sheep Weigh-In Sessions</div>
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
              data-sheep-weighins-export-csv="1"
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
            No weigh-in sessions yet. Click <strong>New Weigh-In</strong> to start one.
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
                          label: (r.date || '') + ' · ' + (FLOCK_LABELS[r.herd] || r.herd || 'sheep'),
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
                    {FLOCK_LABELS[s.herd] || s.herd || 'Unknown flock'}
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
        <SheepNewWeighInModal
          authState={authState}
          onClose={() => setShowNewModal(false)}
          onCreate={createNewSession}
        />
      )}
    </div>
  );
};

export default SheepWeighInsView;
