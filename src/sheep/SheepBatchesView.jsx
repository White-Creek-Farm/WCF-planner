// SheepBatchesView — hub + router for sheep processing batches.
//
// Sheep enter a processing batch ONLY through the Send-to-Processor flag
// on a sheep weigh-in entry (any draft session, any flock per §7). The
// hub lists batches as navigation-only summaries; the record page at
// /sheep/batches/<id> owns editing, per-sheep weights, detach, and delete.
// The + New Batch helper creates an empty shell and navigates to the
// record page.
import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
import {recordSeqNavOptions, labeledSeqItems} from '../lib/recordSequence.js';
import UsersModal from '../auth/UsersModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import SheepBatchPage from './SheepBatchPage.jsx';

const SheepBatchesHub = ({sb, fmt, Header, authState, showUsers, setShowUsers, allUsers, setAllUsers, loadUsers}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const {useState, useEffect} = React;
  const role = authState && authState.role;
  const canEdit = role === 'admin' || role === 'management';

  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(null);
  const [notice, setNotice] = useState(null);
  const [creating, setCreating] = useState(false);

  async function loadAll() {
    setLoading(true);
    setNotice(null);
    try {
      const bR = await sb
        .from('sheep_processing_batches')
        .select('*')
        .order('planned_process_date', {ascending: false});
      if (bR.error) throw new Error('sheep_processing_batches: ' + (bR.error.message || bR.error));
      const byDate = (x) => x.actual_process_date || x.planned_process_date || x.created_at || '';
      setBatches((bR.data || []).slice().sort((a, b) => byDate(b).localeCompare(byDate(a))));
    } catch (e) {
      setBatches([]);
      setNotice({
        kind: 'error',
        message: 'Could not load sheep processing batches. Please refresh the page. (' + ((e && e.message) || e) + ')',
      });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pick up a notice handed off via navigation state (e.g. delete report from
  // SheepBatchPage when blocked detaches need surfacing on the hub).
  useEffect(() => {
    if (location.state && location.state.notice) {
      setNotice(location.state.notice);
      navigate(location.pathname, {replace: true, state: null});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openAdd() {
    if (!canEdit) return;
    setNotice(null);
    const yr = new Date().getFullYear().toString().slice(-2);
    const existing = batches
      .filter((b) => b.name && b.name.startsWith('S-' + yr + '-'))
      .map((b) => parseInt(b.name.slice(5)) || 0);
    const next = (Math.max(0, ...existing) + 1).toString().padStart(2, '0');
    setForm({
      name: 'S-' + yr + '-' + next,
      planned_process_date: '',
      status: 'planned',
    });
    setShowForm(true);
  }

  function closeForm() {
    setNotice(null);
    setShowForm(false);
    setForm(null);
  }

  async function saveNewBatch() {
    if (!canEdit || !form) return;
    setNotice(null);
    const name = (form.name || '').trim();
    if (!name) {
      setNotice({kind: 'error', message: 'Batch name required.'});
      return;
    }
    setCreating(true);
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    const row = {
      id,
      name,
      planned_process_date: form.planned_process_date || null,
      actual_process_date: null,
      processing_cost: null,
      notes: null,
      status: form.status || 'planned',
      sheep_detail: [],
      total_live_weight: null,
      total_hanging_weight: null,
    };
    const {error} = await sb.from('sheep_processing_batches').insert(row);
    setCreating(false);
    if (error) {
      setNotice({kind: 'error', message: 'Create failed: ' + error.message});
      return;
    }
    closeForm();
    navigate('/sheep/batches/' + id);
  }

  const planned = batches.filter((b) => (b.status || 'planned') !== 'complete');
  const completed = batches.filter((b) => b.status === 'complete');
  // Combined visible order (planned → complete) for record sequence nav.
  const batchSeqRows = [...planned, ...completed];

  const inpS = {
    fontSize: 13,
    padding: '7px 10px',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  };
  const lbl = {fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3, fontWeight: 500};

  return (
    <div style={{minHeight: '100vh', background: '#f1f3f2'}} data-sheep-batches-loaded={loading ? 'false' : 'true'}>
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
        {!showForm && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}
        <div
          style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12}}
          data-sheep-batches-root
        >
          <div style={{fontSize: 16, fontWeight: 700, color: '#111827'}}>
            Processing Batches{' '}
            <span style={{fontSize: 13, fontWeight: 400, color: '#6b7280'}}>
              {planned.length} planned · {completed.length} complete
            </span>
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={openAdd}
              style={{
                padding: '7px 16px',
                borderRadius: 7,
                border: 'none',
                background: '#0f766e',
                color: 'white',
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              + New Batch
            </button>
          )}
        </div>

        {loading && <div style={{textAlign: 'center', padding: '2rem', color: '#9ca3af'}}>Loading{'…'}</div>}

        {!loading && batches.length === 0 && (
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
            No processing batches yet. Click <strong>+ New Batch</strong> to plan one. Sheep enter this batch only via
            the Send-to-Processor flag on a sheep weigh-in entry.
          </div>
        )}

        {!loading && planned.length > 0 && (
          <div style={{marginTop: 4}}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: '#0f766e',
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                marginBottom: 8,
              }}
            >
              Planned ({planned.length})
            </div>
            <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
              {planned.map((b) => (
                <BatchTile
                  key={b.id}
                  batch={b}
                  fmt={fmt}
                  onOpen={() =>
                    navigate('/sheep/batches/' + b.id, recordSeqNavOptions(labeledSeqItems(batchSeqRows, 'name')))
                  }
                />
              ))}
            </div>
          </div>
        )}

        {!loading && completed.length > 0 && (
          <div style={{marginTop: 14}}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: '#374151',
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                marginBottom: 8,
              }}
            >
              Complete ({completed.length})
            </div>
            <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
              {completed.map((b) => (
                <BatchTile
                  key={b.id}
                  batch={b}
                  fmt={fmt}
                  onOpen={() =>
                    navigate('/sheep/batches/' + b.id, recordSeqNavOptions(labeledSeqItems(batchSeqRows, 'name')))
                  }
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {showForm && form && (
        <div
          onClick={closeForm}
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
            data-sheep-new-batch-modal
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
              }}
            >
              <div style={{fontSize: 15, fontWeight: 600, color: '#0f766e'}}>New Processing Batch</div>
              <button
                type="button"
                onClick={closeForm}
                style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
              >
                {'×'}
              </button>
            </div>
            <div style={{padding: '16px 20px'}}>
              <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
              <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                <div style={{gridColumn: '1/-1'}}>
                  <label style={lbl}>Name *</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({...form, name: e.target.value})}
                    data-sheep-new-batch-name
                    style={inpS}
                  />
                </div>
                <div>
                  <label style={lbl}>Status</label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm({...form, status: e.target.value})}
                    data-sheep-new-batch-status
                    style={inpS}
                  >
                    <option value="planned">Planned</option>
                    <option value="complete">Complete</option>
                  </select>
                </div>
                <div>
                  <label style={lbl}>Planned Process Date</label>
                  <input
                    type="date"
                    value={form.planned_process_date}
                    onChange={(e) => setForm({...form, planned_process_date: e.target.value})}
                    data-sheep-new-batch-planned-date
                    style={inpS}
                  />
                </div>
              </div>
              <div
                style={{
                  marginTop: 12,
                  padding: '10px 12px',
                  background: '#f9fafb',
                  border: '1px solid #e5e7eb',
                  borderRadius: 6,
                  fontSize: 11,
                  color: '#6b7280',
                }}
              >
                Sheep enter this batch only via the Send-to-Processor flag on a sheep weigh-in entry. Create the empty
                batch shell here; sheep attach themselves once they're flagged at the chute.
              </div>
            </div>
            <div style={{padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8}}>
              <button
                type="button"
                onClick={saveNewBatch}
                disabled={creating}
                data-sheep-new-batch-save
                style={{
                  padding: '8px 20px',
                  borderRadius: 7,
                  border: 'none',
                  background: creating ? '#9ca3af' : '#0f766e',
                  color: 'white',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: creating ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Save & open
              </button>
              <button
                type="button"
                onClick={closeForm}
                style={{
                  padding: '8px 16px',
                  borderRadius: 7,
                  border: '1px solid #d1d5db',
                  background: 'white',
                  color: '#6b7280',
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
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

function BatchTile({batch, fmt, onOpen}) {
  const rows = Array.isArray(batch.sheep_detail) ? batch.sheep_detail : [];
  const totalLive = rows.reduce((s, r) => s + (parseFloat(r.live_weight) || 0), 0);
  const totalHang = rows.reduce((s, r) => s + (parseFloat(r.hanging_weight) || 0), 0);
  const yieldPct = totalLive > 0 && totalHang > 0 ? Math.round((totalHang / totalLive) * 1000) / 10 : null;
  const isComplete = batch.status === 'complete';
  return (
    <div
      data-batch-row={batch.id}
      data-batch-name={batch.name}
      data-batch-status={batch.status}
      onClick={onOpen}
      className="hoverable-tile"
      style={{
        background: 'white',
        border: '1px solid #e5e7eb',
        borderRadius: 12,
        padding: '12px 18px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
      }}
    >
      <span style={{fontSize: 14, fontWeight: 700, color: '#111827'}}>{batch.name}</span>
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          padding: '2px 8px',
          borderRadius: 10,
          background: isComplete ? '#374151' : '#0f766e',
          color: 'white',
          textTransform: 'uppercase',
        }}
      >
        {batch.status}
      </span>
      <span style={{fontSize: 11, color: '#6b7280'}}>
        {rows.length} {rows.length === 1 ? 'sheep' : 'sheep'}
      </span>
      {batch.planned_process_date && (
        <span style={{fontSize: 11, color: '#6b7280'}}>planned {fmt(batch.planned_process_date)}</span>
      )}
      {batch.actual_process_date && (
        <span style={{fontSize: 11, color: '#065f46'}}>processed {fmt(batch.actual_process_date)}</span>
      )}
      {yieldPct && <span style={{fontSize: 11, fontWeight: 600, color: '#065f46'}}>{yieldPct + '% yield'}</span>}
    </div>
  );
}

function SheepBatchesRouter(props) {
  const location = useLocation();
  const batchDetailId = location.pathname.startsWith('/sheep/batches/')
    ? location.pathname.slice('/sheep/batches/'.length) || null
    : null;
  if (batchDetailId) {
    return React.createElement(SheepBatchPage, {
      sb: props.sb,
      fmt: props.fmt,
      authState: props.authState,
      Header: props.Header,
    });
  }
  return React.createElement(SheepBatchesHub, props);
}

export default SheepBatchesRouter;
