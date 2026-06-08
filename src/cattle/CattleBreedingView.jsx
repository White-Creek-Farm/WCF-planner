// Phase 2 Round 3 extraction (verbatim).
import React from 'react';
import UsersModal from '../auth/UsersModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import {calcCattleBreedingTimeline, buildCattleCycleSeqMap, cattleCycleLabel} from '../lib/cattleBreeding.js';
import {upsertCattleBreedingCycle, deleteCattleBreedingCycle} from '../lib/cattleBreedingCycleApi.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';
const CattleBreedingView = ({
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
  const {useState, useEffect} = React;
  const [cycles, setCycles] = useState([]);
  const [calving, setCalving] = useState([]);
  const [cattle, setCattle] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(null);
  const [notice, setNotice] = useState(null);

  async function loadAll() {
    const [cR, calR, ctR] = await Promise.all([
      sb.from('cattle_breeding_cycles').select('*').order('bull_exposure_start', {ascending: false}),
      sb.from('cattle_calving_records').select('*'),
      sb.from('cattle').select('id,tag,herd').is('deleted_at', null),
    ]);
    if (cR.data) setCycles(cR.data);
    if (calR.data) setCalving(calR.data);
    if (ctR.data) setCattle(ctR.data);
    setLoading(false);
  }
  useEffect(() => {
    loadAll();
  }, []);

  const seqMap = buildCattleCycleSeqMap(cycles);

  function openAdd() {
    setNotice(null);
    setForm({
      herd: 'mommas',
      bull_exposure_start: new Date().toISOString().slice(0, 10),
      bull_tags: '',
      cow_tags: '',
      notes: '',
    });
    setEditId(null);
    setShowForm(true);
  }
  function openEdit(c) {
    setNotice(null);
    setForm({
      herd: c.herd || 'mommas',
      bull_exposure_start: c.bull_exposure_start,
      bull_tags: c.bull_tags || '',
      cow_tags: c.cow_tags || '',
      notes: c.notes || '',
    });
    setEditId(c.id);
    setShowForm(true);
  }

  async function saveCycle() {
    setNotice(null);
    if (!form.bull_exposure_start) {
      setNotice({kind: 'error', message: 'Bull exposure start date is required.'});
      return;
    }
    const rec = {
      herd: form.herd,
      bull_exposure_start: form.bull_exposure_start,
      bull_tags: form.bull_tags || null,
      cow_tags: form.cow_tags || null,
      notes: form.notes || null,
    };
    try {
      await upsertCattleBreedingCycle(sb, {id: editId || null, ...rec});
      await loadAll();
      setShowForm(false);
      setEditId(null);
      setForm(null);
    } catch (e) {
      setNotice({kind: 'error', message: 'Save failed: ' + (e.message || String(e))});
    }
  }
  async function deleteCycle(id) {
    if (!window._wcfConfirmDelete) return;
    window._wcfConfirmDelete('Delete this breeding cycle?', async () => {
      setNotice(null);
      try {
        await deleteCattleBreedingCycle(sb, id);
        await loadAll();
        setShowForm(false);
        setEditId(null);
        setForm(null);
      } catch (e) {
        setNotice({kind: 'error', message: 'Delete failed: ' + (e.message || String(e))});
      }
    });
  }

  function cycleStatus(c, tl) {
    if (!tl) return 'planned';
    const today = new Date().toISOString().slice(0, 10);
    if (today < c.bull_exposure_start) return 'planned';
    if (today <= tl.exposureEnd) return 'exposure';
    if (today < tl.calvingStart) return 'pregcheck';
    if (today <= tl.calvingEnd) return 'calving';
    if (today <= tl.weaningDate) return 'nursing';
    return 'complete';
  }
  const STATUS_COLORS = {
    planned: '#6b7280',
    exposure: '#1d4ed8',
    pregcheck: '#7c3aed',
    calving: '#991b1b',
    nursing: '#ea580c',
    complete: '#374151',
  };

  function outstandingCows(c) {
    const expectedTags = (c.cow_tags || '')
      .split(/[\n,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (expectedTags.length === 0) return [];
    const farrowed = new Set(
      calving
        .filter(
          (r) =>
            r.cycle_id === c.id ||
            (r.dam_tag &&
              expectedTags.includes(r.dam_tag) &&
              r.calving_date &&
              c.bull_exposure_start &&
              new Date(r.calving_date) >= new Date(c.bull_exposure_start)),
        )
        .map((r) => r.dam_tag),
    );
    return expectedTags.filter((t) => !farrowed.has(t));
  }

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
    <div style={{minHeight: '100vh', background: '#f1f3f2'}}>
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
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12}}>
          <div style={{fontSize: 16, fontWeight: 700, color: '#111827'}}>
            Breeding Cycles <span style={{fontSize: 13, fontWeight: 400, color: '#6b7280'}}>({cycles.length})</span>
          </div>
          <button
            onClick={openAdd}
            style={{
              padding: '7px 16px',
              borderRadius: 7,
              border: 'none',
              background: '#991b1b',
              color: 'white',
              fontWeight: 600,
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            + New Cycle
          </button>
        </div>

        {loading && <div style={{textAlign: 'center', padding: '2rem', color: '#9ca3af'}}>Loading{'\u2026'}</div>}
        {!loading && cycles.length === 0 && (
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
            No breeding cycles yet. Click <strong>+ New Cycle</strong> to record one.
          </div>
        )}

        <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
          {cycles.map((c) => {
            const tl = calcCattleBreedingTimeline(c.bull_exposure_start);
            const status = cycleStatus(c, tl);
            const sc = STATUS_COLORS[status];
            const outstanding = outstandingCows(c);
            const cowList = (c.cow_tags || '')
              .split(/[\n,]+/)
              .map((t) => t.trim())
              .filter(Boolean);
            const bullList = (c.bull_tags || '')
              .split(/[\n,]+/)
              .map((t) => t.trim())
              .filter(Boolean);
            return (
              <div
                key={c.id}
                style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 18px'}}
              >
                <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap'}}>
                  <span style={{fontSize: 14, fontWeight: 700, color: '#111827'}}>{cattleCycleLabel(c, seqMap)}</span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 10,
                      background: sc,
                      color: 'white',
                      textTransform: 'uppercase',
                    }}
                  >
                    {status}
                  </span>
                  <span style={{fontSize: 11, color: '#6b7280'}}>
                    {cowList.length} {cowList.length === 1 ? 'cow' : 'cows'}{' '}
                    {bullList.length > 0 ? '\u00b7 bulls: ' + bullList.join(', ') : ''}
                  </span>
                  <button
                    onClick={() => openEdit(c)}
                    style={{
                      marginLeft: 'auto',
                      fontSize: 11,
                      color: '#1d4ed8',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    Edit
                  </button>
                </div>
                {tl && (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                      gap: 8,
                      fontSize: 11,
                      color: '#4b5563',
                    }}
                  >
                    <div>
                      <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase'}}>Bull Exposure</div>
                      <div style={{fontWeight: 600}}>
                        {fmt(c.bull_exposure_start)} {'\u2014'} {fmt(tl.exposureEnd)}
                      </div>
                    </div>
                    <div>
                      <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase'}}>Preg Check</div>
                      <div style={{fontWeight: 600}}>{fmt(tl.pregCheckDate)}</div>
                    </div>
                    <div>
                      <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase'}}>Calving Window</div>
                      <div style={{fontWeight: 600}}>
                        {fmt(tl.calvingStart)} {'\u2014'} {fmt(tl.calvingEnd)}
                      </div>
                    </div>
                    <div>
                      <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase'}}>Wean By</div>
                      <div style={{fontWeight: 600}}>{fmt(tl.weaningDate)}</div>
                    </div>
                  </div>
                )}
                {outstanding.length > 0 && (
                  <div
                    style={{
                      marginTop: 10,
                      padding: '8px 12px',
                      background: '#fef2f2',
                      border: '1px solid #fecaca',
                      borderRadius: 8,
                    }}
                  >
                    <div style={{fontSize: 11, fontWeight: 700, color: '#991b1b', marginBottom: 4}}>
                      {'\u26a0 Outstanding cows (' + outstanding.length + ')'}
                    </div>
                    <div style={{fontSize: 11, color: '#7f1d1d'}}>{outstanding.map((t) => '#' + t).join(', ')}</div>
                  </div>
                )}
                {c.notes && (
                  <div style={{marginTop: 8, fontSize: 11, color: '#6b7280', fontStyle: 'italic'}}>{c.notes}</div>
                )}
              </div>
            );
          })}
        </div>

        {/* cattle.breeding workflow Activity stream (entity_id cattle-breeding),
            populated by the audited upsert/delete cycle RPCs (mig 094). Audit
            only — comments are not a breeding-workflow surface. */}
        <div data-cattle-breeding-activity style={{marginTop: 16}}>
          <RecordCollaborationSection
            sb={sb}
            authState={authState}
            entityType="cattle.breeding"
            entityId="cattle-breeding"
            entityLabel="Cattle Breeding"
            activityLimit={100}
            showComments={false}
          />
        </div>
      </div>

      {/* Cycle form modal */}
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
                {editId ? 'Edit Cycle' : 'New Breeding Cycle'}
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
            <div style={{padding: '16px 20px'}}>
              <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
              <div style={{marginBottom: 10}}>
                <label style={lbl}>Bull Exposure Start *</label>
                <input
                  type="date"
                  value={form.bull_exposure_start}
                  onChange={(e) => setForm({...form, bull_exposure_start: e.target.value})}
                  style={inpS}
                />
                <div style={{fontSize: 11, color: '#9ca3af', marginTop: 3}}>
                  All other dates auto-compute: 65d exposure {'\u2192'} 30d preg check {'\u2192'} 9mo gestation{' '}
                  {'\u2192'} 65d calving {'\u2192'} 7mo nursing.
                </div>
              </div>
              <div style={{marginBottom: 10}}>
                <label style={lbl}>Bull tag(s)</label>
                <input
                  value={form.bull_tags}
                  onChange={(e) => setForm({...form, bull_tags: e.target.value})}
                  placeholder="comma or newline separated"
                  style={inpS}
                />
              </div>
              <div style={{marginBottom: 10}}>
                <label style={lbl}>Cow tags in cycle</label>
                <textarea
                  value={form.cow_tags}
                  onChange={(e) => setForm({...form, cow_tags: e.target.value})}
                  placeholder="One per line or comma-separated"
                  rows={5}
                  style={{...inpS, fontFamily: 'monospace'}}
                />
                <div style={{fontSize: 11, color: '#085041', marginTop: 3}}>
                  {
                    (form.cow_tags || '')
                      .split(/[\n,]+/)
                      .map((t) => t.trim())
                      .filter(Boolean).length
                  }{' '}
                  cows
                </div>
              </div>
              <div style={{marginBottom: 10}}>
                <label style={lbl}>Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({...form, notes: e.target.value})}
                  rows={2}
                  style={{...inpS, resize: 'vertical'}}
                />
              </div>
            </div>
            <div style={{padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8}}>
              <button
                onClick={saveCycle}
                style={{
                  padding: '8px 20px',
                  borderRadius: 7,
                  border: 'none',
                  background: '#991b1b',
                  color: 'white',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Save
              </button>
              {editId && (
                <button
                  onClick={() => deleteCycle(editId)}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 7,
                    border: '1px solid #F09595',
                    background: 'white',
                    color: '#b91c1c',
                    fontSize: 13,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
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

export default CattleBreedingView;
