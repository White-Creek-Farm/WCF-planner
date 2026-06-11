// Phase 2 Round 3 extraction (verbatim).
import React from 'react';
import {openableProps} from '../shared/openable.js';
import {S} from '../lib/styles.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';

const LayersView = ({sb, layerGroups, persistLayerGroups, fmt, Header, layerBatches, layerHousings}) => {
  const {useState, useEffect, useRef} = React;
  const EMPTY_LG = {
    name: '',
    status: 'active',
    house: '',
    startDate: '',
    originalCount: '',
    currentCount: '',
    lastCountDate: '',
    feedLbs: '',
    gritLbs: '',
    totalEggs: '',
    perLbFeedCost: '',
    perLbGritCost: '',
    notes: '',
  };
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_LG);
  const [originalForm, setOriginalForm] = useState(null);
  const [notice, setNotice] = useState(null);
  const layerAutoSaveTimer = useRef(null);
  const [recentDailys, setRecentDailys] = useState([]);
  const sorted = [...layerGroups].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', undefined, {numeric: true}),
  );

  useEffect(() => {
    sb.from('layer_dailys')
      .select('batch_label,feed_lbs,grit_lbs,layer_count,date,team_member,comments,mortality_count')
      .is('deleted_at', null)
      .order('date', {ascending: false})
      .limit(200)
      .then(({data}) => {
        if (data) setRecentDailys(data);
      });
  }, []);

  function updLayer(k, v) {
    const f = {...form, [k]: v};
    setForm(f);
    if (editId) {
      clearTimeout(layerAutoSaveTimer.current);
      layerAutoSaveTimer.current = setTimeout(() => {
        const grp = {
          ...f,
          id: editId,
          originalCount: parseInt(f.originalCount) || 0,
          currentCount: parseInt(f.currentCount) || 0,
          feedLbs: parseFloat(f.feedLbs) || 0,
          gritLbs: parseFloat(f.gritLbs) || 0,
          totalEggs: parseFloat(f.totalEggs) || 0,
          perLbFeedCost: parseFloat(f.perLbFeedCost) || 0,
          perLbGritCost: parseFloat(f.perLbGritCost) || 0,
        };
        persistLayerGroups(layerGroups.map((g) => (g.id === editId ? grp : g)));
        setOriginalForm(f);
      }, 1500);
    }
  }

  function closeLayerForm() {
    clearTimeout(layerAutoSaveTimer.current);
    setNotice(null);
    if (editId && originalForm) {
      const LAYER_KEYS = [
        'name',
        'status',
        'house',
        'startDate',
        'originalCount',
        'currentCount',
        'lastCountDate',
        'feedLbs',
        'gritLbs',
        'totalEggs',
        'perLbFeedCost',
        'perLbGritCost',
        'notes',
      ];
      const changed = LAYER_KEYS.some((k) => String(form[k] || '') !== String(originalForm[k] || ''));
      if (changed) {
        const grp = {
          ...form,
          id: editId,
          originalCount: parseInt(form.originalCount) || 0,
          currentCount: parseInt(form.currentCount) || 0,
          feedLbs: parseFloat(form.feedLbs) || 0,
          gritLbs: parseFloat(form.gritLbs) || 0,
          totalEggs: parseFloat(form.totalEggs) || 0,
          perLbFeedCost: parseFloat(form.perLbFeedCost) || 0,
          perLbGritCost: parseFloat(form.perLbGritCost) || 0,
        };
        persistLayerGroups(layerGroups.map((g) => (g.id === editId ? grp : g)));
      }
    }
    setShowForm(false);
    setEditId(null);
    setOriginalForm(null);
  }

  function save() {
    setNotice(null);
    const grp = {
      ...form,
      id: editId || Date.now().toString(),
      originalCount: parseInt(form.originalCount) || 0,
      currentCount: parseInt(form.currentCount) || 0,
      feedLbs: parseFloat(form.feedLbs) || 0,
      gritLbs: parseFloat(form.gritLbs) || 0,
      totalEggs: parseFloat(form.totalEggs) || 0,
      perLbFeedCost: parseFloat(form.perLbFeedCost) || 0,
      perLbGritCost: parseFloat(form.perLbGritCost) || 0,
    };
    if (!grp.name.trim()) {
      setNotice({kind: 'error', message: 'Group name is required.'});
      return;
    }
    persistLayerGroups(editId ? layerGroups.map((g) => (g.id === editId ? grp : g)) : [...layerGroups, grp]);
    setShowForm(false);
    setEditId(null);
    setForm(EMPTY_LG);
    setOriginalForm(null);
  }
  function openEdit(g) {
    setNotice(null);
    const f = {
      ...EMPTY_LG,
      ...g,
      originalCount: g.originalCount || '',
      currentCount: g.currentCount || '',
      feedLbs: g.feedLbs || '',
      gritLbs: g.gritLbs || '',
      totalEggs: g.totalEggs || '',
      perLbFeedCost: g.perLbFeedCost || '',
      perLbGritCost: g.perLbGritCost || '',
    };
    setForm(f);
    setOriginalForm(f);
    setEditId(g.id);
    setShowForm(true);
  }

  const active = layerGroups.filter((g) => g.status === 'active');
  const retired = layerGroups.filter((g) => g.status !== 'active');

  const Card = ({g}) => {
    const gDailys = recentDailys.filter((d) => d.batch_label === g.name).slice(0, 3);
    const lastFeed = gDailys[0]?.feed_lbs;
    const lastCount = gDailys[0]?.layer_count;
    const recentMort = gDailys.reduce((s, d) => s + (parseInt(d.mortality_count) || 0), 0);
    // Find which batch occupies this housing
    const occupyingHousing = (layerHousings || []).find((h) => h.housing_name === g.name && h.status === 'active');
    const occupyingBatch = occupyingHousing
      ? (layerBatches || []).find((b) => b.id === occupyingHousing.batch_id)
      : null;
    return (
      <div
        {...openableProps(() => openEdit(g))}
        style={{
          background: 'white',
          border: '1px solid #e5e7eb',
          borderRadius: 12,
          padding: '14px 18px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 20,
        }}
        className="hoverable-tile"
      >
        <div style={{minWidth: 220, flexShrink: 0}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4}}>
            <div style={{fontSize: 14, fontWeight: 700, color: '#111827'}}>{g.name}</div>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 10,
                background: g.status === 'active' ? '#d1fae5' : '#f3f4f6',
                color: g.status === 'active' ? '#065f46' : '#6b7280',
                textTransform: 'uppercase',
              }}
            >
              {g.status}
            </span>
          </div>
          {occupyingBatch && (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                background: '#fffbeb',
                border: '1px solid #fde68a',
                borderRadius: 6,
                padding: '2px 8px',
                fontSize: 11,
                fontWeight: 700,
                color: '#92400e',
                marginBottom: 4,
              }}
            >
              📦 {occupyingBatch.name}
              {occupyingHousing.current_count ? ' · ' + occupyingHousing.current_count + ' hens' : ''}
            </div>
          )}
          {g.notes && <div style={{fontSize: 11, color: '#6b7280'}}>{g.notes}</div>}
        </div>
        <div style={{display: 'flex', gap: 24, flex: 1, flexWrap: 'wrap'}}>
          {[
            ['Current hens', g.currentCount || g.originalCount || '—'],
            ['House', g.house || '—'],
            ['Start date', g.startDate ? fmt(g.startDate) : '—'],
            ['Feed/lb cost', g.perLbFeedCost > 0 ? '$' + g.perLbFeedCost : '—'],
          ].map(([l, v]) => (
            <div key={l}>
              <div style={{fontSize: 10, color: '#9ca3af', marginBottom: 1}}>{l}</div>
              <div style={{fontWeight: 600, color: '#374151', fontSize: 12}}>{v}</div>
            </div>
          ))}
        </div>
        {gDailys.length > 0 && (
          <div style={{borderLeft: '1px solid #e5e7eb', paddingLeft: 16, flexShrink: 0, fontSize: 11}}>
            <div style={{color: '#6b7280', marginBottom: 3}}>Last: {fmt(gDailys[0].date)}</div>
            <div style={{display: 'flex', gap: 8}}>
              {lastFeed > 0 && <span style={{color: '#92400e', fontWeight: 600}}>🌾 {lastFeed} lbs</span>}
              {lastCount > 0 && <span style={{color: '#374151'}}>🐔 {lastCount}</span>}
              {recentMort > 0 && <span style={{color: '#b91c1c', fontWeight: 600}}>💀 {recentMort}</span>}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{minHeight: '100vh', background: '#f1f3f2'}}>
      <Header />
      <div style={{padding: '1rem', maxWidth: 1100, margin: '0 auto'}}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16}}>
          <div style={{fontSize: 20, fontWeight: 700, color: '#111827'}}>
            Layer Groups{' '}
            <span style={{fontSize: 13, fontWeight: 400, color: '#6b7280'}}>
              {active.length} active · {retired.length} retired
            </span>
          </div>
          <button
            onClick={() => {
              setNotice(null);
              setForm(EMPTY_LG);
              setEditId(null);
              setShowForm(true);
            }}
            style={{
              padding: '7px 18px',
              borderRadius: 8,
              border: 'none',
              background: '#085041',
              color: 'white',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            + Add Group
          </button>
        </div>
        {active.length > 0 && (
          <div style={{marginBottom: 8, fontSize: 12, fontWeight: 600, color: '#4b5563', letterSpacing: 0.3}}>
            ACTIVE GROUPS
          </div>
        )}
        <div style={{display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24}}>
          {active.map((g) => (
            <Card key={g.id} g={g} />
          ))}
        </div>
        {retired.length > 0 && (
          <>
            <div style={{marginBottom: 8, fontSize: 12, fontWeight: 600, color: '#4b5563', letterSpacing: 0.3}}>
              RETIRED GROUPS
            </div>
            <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
              {retired.map((g) => (
                <Card key={g.id} g={g} />
              ))}
            </div>
          </>
        )}
        {layerGroups.length === 0 && (
          <div style={{textAlign: 'center', padding: '3rem', color: '#9ca3af', fontSize: 13}}>No layer groups yet.</div>
        )}
      </div>
      {showForm && (
        <div
          onClick={closeLayerForm}
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
                position: 'sticky',
                top: 0,
                background: 'white',
              }}
            >
              <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                <div style={{fontSize: 15, fontWeight: 600, color: '#78350f'}}>
                  {editId ? 'Edit Layer Group' : 'New Layer Group'}
                </div>
                {editId && <div style={{marginLeft: 8, fontSize: 11, color: '#9ca3af'}}>Auto-saves as you type</div>}
                {editId &&
                  (() => {
                    const idx = sorted.findIndex((g) => g.id === editId);
                    const prev = idx > 0 ? sorted[idx - 1] : null;
                    const next = idx < sorted.length - 1 ? sorted[idx + 1] : null;
                    const ns = (on) => ({
                      padding: '3px 10px',
                      borderRadius: 6,
                      border: '1px solid #d1d5db',
                      background: on ? 'white' : '#f9fafb',
                      color: on ? '#374151' : '#d1d5db',
                      cursor: on ? 'pointer' : 'default',
                      fontSize: 11,
                      fontWeight: 600,
                      fontFamily: 'inherit',
                    });
                    return (
                      <div style={{display: 'flex', gap: 4, alignItems: 'center'}}>
                        <button
                          disabled={!prev}
                          style={ns(!!prev)}
                          onClick={() => {
                            if (prev) {
                              closeLayerForm();
                              setTimeout(() => {
                                const f = {
                                  ...EMPTY_LG,
                                  ...prev,
                                  originalCount: prev.originalCount || '',
                                  currentCount: prev.currentCount || '',
                                  feedLbs: prev.feedLbs || '',
                                  gritLbs: prev.gritLbs || '',
                                  totalEggs: prev.totalEggs || '',
                                  perLbFeedCost: prev.perLbFeedCost || '',
                                  perLbGritCost: prev.perLbGritCost || '',
                                };
                                setForm(f);
                                setOriginalForm(f);
                                setEditId(prev.id);
                                setShowForm(true);
                              }, 50);
                            }
                          }}
                        >
                          {'\u2039 ' + (prev ? prev.name : '\u2014')}
                        </button>
                        <span style={{fontSize: 10, color: '#9ca3af'}}>
                          {idx + 1}/{sorted.length}
                        </span>
                        <button
                          disabled={!next}
                          style={ns(!!next)}
                          onClick={() => {
                            if (next) {
                              closeLayerForm();
                              setTimeout(() => {
                                const f = {
                                  ...EMPTY_LG,
                                  ...next,
                                  originalCount: next.originalCount || '',
                                  currentCount: next.currentCount || '',
                                  feedLbs: next.feedLbs || '',
                                  gritLbs: next.gritLbs || '',
                                  totalEggs: next.totalEggs || '',
                                  perLbFeedCost: next.perLbFeedCost || '',
                                  perLbGritCost: next.perLbGritCost || '',
                                };
                                setForm(f);
                                setOriginalForm(f);
                                setEditId(next.id);
                                setShowForm(true);
                              }, 50);
                            }
                          }}
                        >
                          {(next ? next.name : '\u2014') + ' \u203a'}
                        </button>
                      </div>
                    );
                  })()}
              </div>
              <button
                onClick={closeLayerForm}
                style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
              >
                ×
              </button>
            </div>
            <div
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
                <label style={S.label}>Group Name *</label>
                <input
                  value={form.name}
                  onChange={(e) => updLayer('name', e.target.value)}
                  placeholder="e.g. Eggmobile #2 - 2026"
                />
              </div>
              <div>
                <label style={S.label}>Status</label>
                <select value={form.status} onChange={(e) => updLayer('status', e.target.value)}>
                  <option value="active">Active</option>
                  <option value="retired">Retired</option>
                </select>
              </div>
              <div>
                <label style={S.label}>House / Location</label>
                <input value={form.house} onChange={(e) => updLayer('house', e.target.value)} />
              </div>
              <div>
                <label style={S.label}>Start Date</label>
                <input type="date" value={form.startDate} onChange={(e) => updLayer('startDate', e.target.value)} />
              </div>
              <div>
                <label style={S.label}>Original Count</label>
                <input
                  type="number"
                  min="0"
                  value={form.originalCount || ''}
                  onChange={(e) => updLayer('originalCount', e.target.value)}
                />
              </div>
              <div>
                <label style={S.label}>Current Count</label>
                <input
                  type="number"
                  min="0"
                  value={form.currentCount || ''}
                  onChange={(e) => updLayer('currentCount', e.target.value)}
                />
              </div>
              <div>
                <label style={S.label}>Last Count Date</label>
                <input
                  type="date"
                  value={form.lastCountDate}
                  onChange={(e) => updLayer('lastCountDate', e.target.value)}
                />
              </div>
              <div>
                <label style={S.label}>Total Eggs</label>
                <input
                  type="number"
                  min="0"
                  value={form.totalEggs || ''}
                  onChange={(e) => updLayer('totalEggs', e.target.value)}
                />
              </div>
              <div>
                <label style={S.label}>Total Feed Used (lbs)</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={form.feedLbs || ''}
                  onChange={(e) => updLayer('feedLbs', e.target.value)}
                />
              </div>
              <div>
                <label style={S.label}>Per Lb Feed Cost ($)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.perLbFeedCost || ''}
                  onChange={(e) => updLayer('perLbFeedCost', e.target.value)}
                />
              </div>
              <div>
                <label style={S.label}>Total Grit Used (lbs)</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={form.gritLbs || ''}
                  onChange={(e) => updLayer('gritLbs', e.target.value)}
                />
              </div>
              <div>
                <label style={S.label}>Per Lb Grit Cost ($)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.perLbGritCost || ''}
                  onChange={(e) => updLayer('perLbGritCost', e.target.value)}
                />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={S.label}>Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => updLayer('notes', e.target.value)}
                  rows={3}
                  style={{resize: 'vertical'}}
                />
              </div>
            </div>
            <div style={{padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8}}>
              {editId ? (
                <button onClick={closeLayerForm} style={{...S.btnPrimary, width: 'auto', padding: '8px 20px'}}>
                  Done
                </button>
              ) : (
                <button onClick={save} style={{...S.btnPrimary, width: 'auto', padding: '8px 20px'}}>
                  Add group
                </button>
              )}
              <button onClick={closeLayerForm} style={S.btnGhost}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LayersView;
