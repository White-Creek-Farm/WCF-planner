import React from 'react';
import {useNavigate} from 'react-router-dom';
import {recordSeqNavOptions} from '../lib/recordSequence.js';
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
  const [statusFilter, setStatusFilter] = useState('all');
  const [showNewModal, setShowNewModal] = useState(false);
  const [pigMetricsBySession, setPigMetricsBySession] = useState({});
  const [notice, setNotice] = useState(null);

  const speciesLabel = species === 'broiler' ? 'Broiler' : 'Pig';

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
