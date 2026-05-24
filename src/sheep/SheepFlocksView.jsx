// Sheep flocks view — full parity with CattleHerdsView. Ronnie's request
// 2026-04-23: every functionality matches the cattle herds tab; only
// field names and display data remain distinct.
//
// Key mechanics mirrored from CattleHerdsView:
//   * Top toolbar: search + status filter + sort + bulk import + add.
//   * Flat mode (search / non-active filter) vs tile mode (default).
//   * Inline-editable expanded tile via SheepDetail (no Edit modal).
//   * Outcome flocks (processed/deceased/sold) collapsed at bottom in
//     tile mode, fully searchable via filter.
//   * Navigation stack for dam/sire/lamb click-through.
//   * Add Sheep modal retained only for creating new records.
//   * Tag / age / weight / flock sort options.
import React from 'react';
import UsersModal from '../auth/UsersModal.jsx';
import SheepBulkImport from './SheepBulkImport.jsx';
import SheepDetail from './SheepDetail.jsx';
import SheepCollapsibleOutcomeSections from './SheepCollapsibleOutcomeSections.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';
import {ANIMAL_ICON_KEYS} from '../lib/plannerIcons.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ActivityPanel from '../shared/ActivityPanel.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ActivityModal from '../shared/ActivityModal.jsx';

const SheepFlocksView = ({
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
  pendingEdit,
  setPendingEdit,
}) => {
  const {useState, useEffect} = React;
  const [sheep, setSheep] = useState([]);
  const [weighIns, setWeighIns] = useState([]);
  const [lambingRecs, setLambingRecs] = useState([]);
  const [comments, setComments] = useState([]);
  // Inline notice for save / patch / lambing validation failures.
  // Cleared on each action entry + when opening the Add Sheep form so a
  // prior row's error never shadows the next flow.
  const [notice, setNotice] = useState(null);
  const [breedOpts, setBreedOpts] = useState([]);
  const [originOpts, setOriginOpts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activityTarget, setActivityTarget] = useState(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [sortBy, setSortBy] = useState('tag-asc');
  const [showAddForm, setShowAddForm] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [expandedSheep, setExpandedSheep] = useState(null);
  const [expandedFlocks, setExpandedFlocks] = useState({});
  const [sheepNavStack, setSheepNavStack] = useState([]);

  const FLOCKS = ['rams', 'ewes', 'feeders'];
  const OUTCOMES = ['processed', 'deceased', 'sold'];
  const ALL_FLOCKS = [...FLOCKS, ...OUTCOMES];
  const FLOCK_LABELS = {
    rams: 'Rams',
    ewes: 'Ewes',
    feeders: 'Feeders',
    processed: 'Processed',
    deceased: 'Deceased',
    sold: 'Sold',
  };
  const FLOCK_COLORS = {
    rams: {bg: '#f0fdfa', tx: '#0f766e', bd: '#5eead4'},
    ewes: {bg: '#fdf4ff', tx: '#86198f', bd: '#f0abfc'},
    feeders: {bg: '#fefce8', tx: '#854d0e', bd: '#fde047'},
    processed: {bg: '#f3f4f6', tx: '#374151', bd: '#d1d5db'},
    deceased: {bg: '#f9fafb', tx: '#6b7280', bd: '#e5e7eb'},
    sold: {bg: '#eff6ff', tx: '#1e40af', bd: '#bfdbfe'},
  };

  const EMPTY_SHEEP = {
    tag: '',
    sex: 'ewe',
    flock: 'ewes',
    breed: '',
    breeding_blacklist: false,
    origin: '',
    birth_date: '',
    purchase_date: '',
    purchase_amount: '',
    dam_tag: '',
    dam_reg_num: '',
    sire_tag: '',
    sire_reg_num: '',
    registration_num: '',
    breeding_status: '',
    maternal_issue_flag: false,
    maternal_issue_desc: '',
    sale_date: '',
    sale_amount: '',
    death_date: '',
    death_reason: '',
    old_tags: [],
  };

  async function loadAll() {
    const sessR = await sb.from('weigh_in_sessions').select('id,date,herd').eq('species', 'sheep');
    const sessIds = (sessR.data || []).map((s) => s.id);
    const wR =
      sessIds.length > 0
        ? await sb.from('weigh_ins').select('*').in('session_id', sessIds).order('entered_at', {ascending: false})
        : {data: []};
    const [sR, lR, cR, brR, orR] = await Promise.all([
      sb.from('sheep').select('*').order('tag'),
      sb.from('sheep_lambing_records').select('*').order('lambing_date', {ascending: false}),
      sb.from('sheep_comments').select('*').order('created_at', {ascending: false}),
      sb.from('sheep_breeds').select('*').order('label'),
      sb.from('sheep_origins').select('*').order('label'),
    ]);
    if (sR.data) setSheep(sR.data);
    if (wR.data) setWeighIns(wR.data);
    if (lR.data) setLambingRecs(lR.data);
    if (cR.data) setComments(cR.data);
    if (brR.data) setBreedOpts(brR.data);
    if (orR.data) setOriginOpts(orR.data);
    setLoading(false);
  }
  useEffect(() => {
    loadAll();
  }, []);

  function age(birth) {
    if (!birth) return null;
    const days = Math.floor((Date.now() - new Date(birth + 'T12:00:00').getTime()) / 86400000);
    if (days < 0) return null;
    const y = Math.floor(days / 365),
      m = Math.floor((days % 365) / 30);
    if (y > 0) return y + 'y ' + m + 'm';
    return m + 'm';
  }
  function sheepTagSet(s) {
    const set = new Set();
    if (s && s.tag) set.add(s.tag);
    if (s && Array.isArray(s.old_tags)) {
      for (const ot of s.old_tags) {
        if (!ot || !ot.tag) continue;
        if (ot.source === 'import') continue;
        set.add(ot.tag);
      }
    }
    return set;
  }
  function lastWeight(s) {
    const tags = sheepTagSet(s);
    if (tags.size === 0) return null;
    const w = weighIns.find((x) => tags.has(x.tag));
    return w ? parseFloat(w.weight) : null;
  }
  function lastLambing(tag) {
    if (!tag) return null;
    return lambingRecs.find((r) => r.dam_tag === tag);
  }
  function lambCount(tag) {
    return sheep.filter((s) => s.dam_tag === tag).length;
  }

  function navigateToSheep(target, fromSheepId) {
    if (!target || !target.id) return;
    if (fromSheepId && fromSheepId !== target.id) setSheepNavStack((s) => [...s, fromSheepId]);
    if (FLOCKS.includes(target.flock)) {
      setSearch('');
      setStatusFilter('active');
      setExpandedFlocks((prev) => ({...prev, [target.flock]: true}));
    } else {
      setSearch('');
      setStatusFilter(target.flock);
    }
    setExpandedSheep(target.id);
    setTimeout(() => {
      const el = document.getElementById('sheep-' + target.id);
      if (el) el.scrollIntoView({behavior: 'smooth', block: 'center'});
    }, 80);
  }
  function navigateBack() {
    if (sheepNavStack.length === 0) {
      setExpandedSheep(null);
      return;
    }
    const prevId = sheepNavStack[sheepNavStack.length - 1];
    const prev = sheep.find((s) => s.id === prevId);
    setSheepNavStack((s) => s.slice(0, -1));
    if (prev) {
      if (FLOCKS.includes(prev.flock)) {
        setStatusFilter('active');
        setExpandedFlocks((p) => ({...p, [prev.flock]: true}));
      } else {
        setStatusFilter(prev.flock);
      }
      setExpandedSheep(prev.id);
      setTimeout(() => {
        const el = document.getElementById('sheep-' + prev.id);
        if (el) el.scrollIntoView({behavior: 'smooth', block: 'center'});
      }, 80);
    } else {
      setExpandedSheep(null);
    }
  }

  const filtered = sheep.filter((s) => {
    const searching = !!search;
    if (!searching && statusFilter === 'active' && !FLOCKS.includes(s.flock)) return false;
    if (statusFilter !== 'all' && statusFilter !== 'active' && s.flock !== statusFilter) return false;
    if (searching) {
      const q = search.toLowerCase().trim();
      const fields = [s.tag, s.dam_tag, s.sire_tag, s.breed, s.origin].map((x) => (x || '').toLowerCase());
      if (!fields.some((f) => f.includes(q))) return false;
    }
    return true;
  });
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'tag-asc')
      return (parseFloat(a.tag) || 0) - (parseFloat(b.tag) || 0) || (a.tag || '').localeCompare(b.tag || '');
    if (sortBy === 'tag-desc')
      return (parseFloat(b.tag) || 0) - (parseFloat(a.tag) || 0) || (b.tag || '').localeCompare(a.tag || '');
    if (sortBy === 'age-asc') return (a.birth_date || '9999').localeCompare(b.birth_date || '9999');
    if (sortBy === 'age-desc') return (b.birth_date || '').localeCompare(a.birth_date || '');
    if (sortBy === 'weight-desc') return (lastWeight(b) || 0) - (lastWeight(a) || 0);
    if (sortBy === 'weight-asc') return (lastWeight(a) || 0) - (lastWeight(b) || 0);
    return 0;
  });

  function openAdd() {
    setNotice(null);
    setForm({...EMPTY_SHEEP});
    setShowAddForm(true);
  }
  async function saveSheep() {
    setNotice(null);
    if (!form.tag.trim()) {
      window._wcfConfirm(
        'Save sheep without a tag?',
        () => {
          void proceedSaveSheep();
        },
        'Save',
      );
      return;
    }
    await proceedSaveSheep();
  }
  async function proceedSaveSheep() {
    setSaving(true);
    const isEwe = form.sex === 'ewe';
    const rec = {
      tag: form.tag.trim() || null,
      sex: form.sex,
      flock: form.flock,
      breed: form.breed || null,
      breeding_blacklist: !!form.breeding_blacklist,
      origin: form.origin || null,
      birth_date: form.birth_date || null,
      purchase_date: form.purchase_date || null,
      purchase_amount: form.purchase_amount !== '' ? parseFloat(form.purchase_amount) : null,
      dam_tag: form.dam_tag || null,
      dam_reg_num: form.dam_reg_num || null,
      sire_tag: form.sire_tag || null,
      sire_reg_num: form.sire_reg_num || null,
      registration_num: form.registration_num || null,
      breeding_status: isEwe ? form.breeding_status || null : null,
      maternal_issue_flag: !!form.maternal_issue_flag,
      maternal_issue_desc: form.maternal_issue_desc || null,
      sale_date: form.sale_date || null,
      sale_amount: form.sale_amount !== '' ? parseFloat(form.sale_amount) : null,
      death_date: form.death_date || null,
      death_reason: form.death_reason || null,
      old_tags: Array.isArray(form.old_tags) ? form.old_tags : [],
    };
    const newId = (rec.tag ? 's-' + rec.tag : 's-' + Date.now()) + '-' + Math.random().toString(36).slice(2, 5);
    const {error} = await sb.from('sheep').insert({id: newId, ...rec});
    if (error) {
      setNotice({kind: 'error', message: 'Save failed: ' + error.message});
      setSaving(false);
      return;
    }
    setSaving(false);
    await loadAll();
    setShowAddForm(false);
    setForm(null);
  }
  async function patchSheep(sheepId, fields) {
    if (!sheepId || !fields) return;
    setNotice(null);
    const {error} = await sb.from('sheep').update(fields).eq('id', sheepId);
    if (error) {
      setNotice({kind: 'error', message: 'Save failed: ' + error.message});
      return;
    }
    setSheep((prev) => prev.map((s) => (s.id === sheepId ? {...s, ...fields} : s)));
  }
  async function deleteSheep(id) {
    window._wcfConfirmDelete(
      'Permanently delete this sheep record? Lambing records, comments, and weigh-ins for this tag remain.',
      async () => {
        await sb.from('sheep').delete().eq('id', id);
        await loadAll();
        setShowAddForm(false);
        setForm(null);
        setExpandedSheep(null);
      },
    );
  }
  async function transferSheep(id, newFlock) {
    const s = sheep.find((x) => x.id === id);
    if (!s) return;
    const oldFlock = s.flock;
    const updates = {flock: newFlock};
    if (newFlock === 'deceased' && !s.death_date) updates.death_date = new Date().toISOString().slice(0, 10);
    if (newFlock === 'sold' && !s.sale_date) updates.sale_date = new Date().toISOString().slice(0, 10);
    await sb.from('sheep').update(updates).eq('id', id);
    // Append to sheep_transfers audit log (mirrors cattle_transfers writes
    // in CattleHerdsView.transferCow). Tolerated if the table is missing
    // on legacy schemas.
    try {
      await sb.from('sheep_transfers').insert({
        id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
        sheep_id: id,
        from_flock: oldFlock,
        to_flock: newFlock,
        reason: 'manual',
        team_member: authState && authState.name ? authState.name : null,
      });
    } catch (e) {
      /* table only exists post-migration-029 */
    }
    await loadAll();
  }
  async function addQuickComment(sheepId, sheepTag, text) {
    if (!text.trim()) return;
    await sb.from('sheep_comments').insert({
      id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
      sheep_id: sheepId,
      sheep_tag: sheepTag,
      comment: text.trim(),
      team_member: authState && authState.name ? authState.name : null,
      source: 'manual',
    });
    await loadAll();
  }
  async function editComment(id, newText) {
    if (!newText.trim()) return;
    await sb.from('sheep_comments').update({comment: newText.trim()}).eq('id', id);
    await loadAll();
  }
  async function deleteComment(id) {
    window._wcfConfirmDelete('Delete this comment?', async () => {
      await sb.from('sheep_comments').delete().eq('id', id);
      await loadAll();
    });
  }
  async function addLambingRecord(s, formData) {
    setNotice(null);
    if (!formData.lambing_date) {
      setNotice({kind: 'error', message: 'Lambing date required.'});
      return false;
    }
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    const rec = {
      id,
      dam_tag: s.tag,
      lambing_date: formData.lambing_date,
      total_born: parseInt(formData.total_born) || 0,
      deaths: parseInt(formData.deaths) || 0,
      complications_flag: !!formData.complications_flag,
      complications_desc: formData.complications_desc || null,
      notes: formData.notes || null,
    };
    const {error} = await sb.from('sheep_lambing_records').insert(rec);
    if (error) {
      setNotice({kind: 'error', message: 'Save failed: ' + error.message});
      return false;
    }
    try {
      const note =
        rec.total_born +
        ' born' +
        (rec.deaths > 0 ? ', ' + rec.deaths + ' died' : '') +
        (rec.complications_flag ? ' [complications: ' + rec.complications_desc + ']' : '');
      await sb.from('sheep_comments').insert({
        id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
        sheep_id: s.id,
        sheep_tag: s.tag,
        comment: note,
        team_member: authState && authState.name ? authState.name : null,
        source: 'lambing',
        reference_id: id,
      });
    } catch (e) {
      console.warn('sheep_comments lambing insert failed:', e);
    }
    await loadAll();
    return true;
  }
  async function deleteLambingRecord(recId) {
    window._wcfConfirmDelete('Delete this lambing record?', async () => {
      await sb.from('sheep_lambing_records').delete().eq('id', recId);
      try {
        await sb.from('sheep_comments').delete().eq('reference_id', recId);
      } catch (e) {
        console.warn('sheep_comments lambing-delete cascade failed:', e);
      }
      await loadAll();
    });
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
  const isFlatMode = search || statusFilter !== 'active';

  const renderDetail = (s) => {
    const sTags = sheepTagSet(s);
    const sWeighIns = weighIns.filter((w) => sTags.has(w.tag));
    const sLambing = lambingRecs.filter((r) => r.dam_tag === s.tag);
    const sComments = comments.filter((cm) => cm.sheep_id === s.id || cm.sheep_tag === s.tag).slice(0, 20);
    return (
      <SheepDetail
        sheep={s}
        ageLabel={age(s.birth_date) || '—'}
        weighIns={sWeighIns}
        lambing={sLambing}
        comments={sComments}
        lambs={sheep.filter((x) => x.dam_tag === s.tag)}
        dam={sheep.find((x) => x.tag === s.dam_tag)}
        sheepList={sheep}
        fmt={fmt}
        FLOCKS={ALL_FLOCKS}
        FLOCK_LABELS={FLOCK_LABELS}
        FLOCK_COLORS={FLOCK_COLORS}
        onTransfer={(newFlock) => transferSheep(s.id, newFlock)}
        onDelete={() => deleteSheep(s.id)}
        onComment={(text) => addQuickComment(s.id, s.tag, text)}
        onEditComment={editComment}
        onDeleteComment={deleteComment}
        onAddLambing={(data) => addLambingRecord(s, data)}
        onDeleteLambing={(id) => deleteLambingRecord(id)}
        onNavigateToSheep={(target) => navigateToSheep(target, s.id)}
        onNavigateBack={navigateBack}
        canNavigateBack={sheepNavStack.length > 0}
        backToTag={
          sheepNavStack.length > 0
            ? (sheep.find((x) => x.id === sheepNavStack[sheepNavStack.length - 1]) || {}).tag
            : null
        }
        onPatch={(fields) => patchSheep(s.id, fields)}
        onClose={() => setExpandedSheep(null)}
        originOpts={originOpts}
        breedOpts={breedOpts}
      />
    );
  };

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
      <div style={{padding: '1rem', maxWidth: 1200, margin: '0 auto'}}>
        {!showAddForm && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}
        {/* Top toolbar */}
        <div
          style={{
            background: 'white',
            border: '1px solid #e5e7eb',
            borderRadius: 10,
            padding: '12px 16px',
            marginBottom: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={'Search tag, dam, sire, breed, origin…'}
            style={{...inpS, flex: 1, minWidth: 200}}
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{...inpS, width: 'auto'}}
          >
            <option value="active">All Active Flocks</option>
            <option value="all">All (including outcomes)</option>
            <option disabled>{'───'}</option>
            {FLOCKS.map((f) => (
              <option key={f} value={f}>
                {FLOCK_LABELS[f]}
              </option>
            ))}
            <option disabled>{'───'}</option>
            {OUTCOMES.map((f) => (
              <option key={f} value={f}>
                {FLOCK_LABELS[f]}
              </option>
            ))}
          </select>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{...inpS, width: 'auto'}}>
            <option value="tag-asc">Tag {'↑'}</option>
            <option value="tag-desc">Tag {'↓'}</option>
            <option value="age-asc">Age (youngest first)</option>
            <option value="age-desc">Age (oldest first)</option>
            <option value="weight-desc">Weight {'↓'}</option>
            <option value="weight-asc">Weight {'↑'}</option>
          </select>
          <button
            onClick={() => setShowBulkImport(true)}
            style={{
              padding: '7px 14px',
              borderRadius: 7,
              border: '1px solid #0f766e',
              background: 'white',
              color: '#0f766e',
              fontWeight: 600,
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
            }}
          >
            📥 Bulk Import
          </button>
          <button
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
              whiteSpace: 'nowrap',
            }}
          >
            + Add Sheep
          </button>
        </div>

        {showBulkImport && (
          <SheepBulkImport
            sb={sb}
            breedOpts={breedOpts}
            originOpts={originOpts}
            existingSheep={sheep}
            onClose={() => setShowBulkImport(false)}
            onComplete={loadAll}
          />
        )}

        {loading && <div style={{textAlign: 'center', padding: '3rem', color: '#9ca3af'}}>Loading{'…'}</div>}
        {!loading && sheep.length === 0 && (
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
            No sheep records yet. Click <strong>+ Add Sheep</strong> or <strong>Bulk Import</strong>.
          </div>
        )}

        {/* FLAT MODE — search or non-active filter */}
        {!loading && isFlatMode && sheep.length > 0 && (
          <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden'}}>
            <div
              style={{
                padding: '10px 16px',
                borderBottom: '1px solid #e5e7eb',
                background: '#f9fafb',
                fontSize: 12,
                fontWeight: 600,
                color: '#4b5563',
              }}
            >
              {sorted.length} sheep match
            </div>
            {sorted.length === 0 && (
              <div style={{padding: '2rem', textAlign: 'center', color: '#9ca3af', fontSize: 13}}>
                No sheep match the current filter.
              </div>
            )}
            {sorted.map((s, i) => {
              const fc = FLOCK_COLORS[s.flock] || FLOCK_COLORS.ewes;
              const lw = lastWeight(s);
              const isExpanded = expandedSheep === s.id;
              return (
                <div
                  key={s.id}
                  id={'sheep-' + s.id}
                  style={{borderBottom: i < sorted.length - 1 ? '1px solid #f3f4f6' : 'none'}}
                >
                  {!isExpanded && (
                    <div
                      onClick={() => setExpandedSheep(s.id)}
                      style={{
                        padding: '10px 16px 10px 0',
                        display: 'grid',
                        gridTemplateColumns: '48px 16px 70px 110px 60px 180px 70px 90px 1fr',
                        alignItems: 'center',
                        gap: 10,
                        cursor: 'pointer',
                        background: s.breeding_blacklist ? '#fecaca' : 'white',
                      }}
                      className="hoverable-tile"
                    >
                      <span
                        style={{
                          fontSize: 11,
                          color: '#9ca3af',
                          fontVariantNumeric: 'tabular-nums',
                          alignSelf: 'stretch',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'flex-end',
                          paddingRight: 10,
                          paddingLeft: 8,
                          marginTop: -10,
                          marginBottom: -10,
                          borderRight: '1px solid #d1d5db',
                          fontWeight: 600,
                        }}
                      >
                        {i + 1}
                      </span>
                      <span style={{fontSize: 11, color: '#9ca3af'}}>{'▶'}</span>
                      <span
                        style={{
                          fontWeight: 700,
                          fontSize: 13,
                          color: '#111827',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        {s.tag ? '#' + s.tag : '(no tag)'}
                        <span onClick={(e) => e.stopPropagation()} data-activity-surface="sheep.animal">
                          {React.createElement(ActivityPanel, {
                            sb,
                            authState,
                            entityType: 'sheep.animal',
                            entityId: s.id,
                            entityLabel: s.tag || s.id,
                            mode: 'compact',
                            onCompactClick: setActivityTarget,
                          })}
                        </span>
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          padding: '2px 8px',
                          borderRadius: 4,
                          background: fc.bg,
                          color: fc.tx,
                          border: '1px solid ' + fc.bd,
                          fontWeight: 600,
                          textAlign: 'center',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {FLOCK_LABELS[s.flock]}
                      </span>
                      <span style={{fontSize: 11, color: '#6b7280'}}>{s.sex || '—'}</span>
                      <span
                        style={{
                          fontSize: 11,
                          color: '#6b7280',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {s.breed || '—'}
                      </span>
                      <span style={{fontSize: 11, color: '#6b7280'}}>{age(s.birth_date) || '—'}</span>
                      <span style={{fontSize: 11, color: lw ? '#065f46' : '#9ca3af', fontWeight: lw ? 600 : 400}}>
                        {lw ? lw.toLocaleString() + ' lb' : 'no weigh-in'}
                      </span>
                      <span style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
                        {s.dam_tag && <span style={{fontSize: 11, color: '#9ca3af'}}>{'dam #' + s.dam_tag}</span>}
                        {s.maternal_issue_flag && (
                          <span
                            style={{
                              fontSize: 10,
                              padding: '1px 6px',
                              borderRadius: 4,
                              background: '#fef2f2',
                              color: '#b91c1c',
                              fontWeight: 600,
                            }}
                          >
                            MATERNAL ISSUE
                          </span>
                        )}
                        {s.breeding_blacklist && (
                          <span
                            style={{
                              fontSize: 10,
                              padding: '1px 6px',
                              borderRadius: 4,
                              background: '#fef2f2',
                              color: '#b91c1c',
                              fontWeight: 600,
                            }}
                          >
                            BLACKLIST
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                  {isExpanded && renderDetail(s)}
                </div>
              );
            })}
          </div>
        )}

        {/* TILE MODE — default view */}
        {!loading && !isFlatMode && sheep.length > 0 && (
          <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
            {FLOCKS.map((f) => {
              const flockSheep = sorted.filter((s) => s.flock === f);
              const fc = FLOCK_COLORS[f];
              const open = !!expandedFlocks[f];
              return (
                <div
                  key={f}
                  style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden'}}
                >
                  <div
                    onClick={() => setExpandedFlocks({...expandedFlocks, [f]: !open})}
                    style={{
                      padding: '12px 18px',
                      background: fc.bg,
                      borderBottom: open ? '1px solid ' + fc.bd : 'none',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{fontSize: 12, color: fc.tx}}>{open ? '▼' : '▶'}</span>
                    <span
                      style={{
                        fontSize: 15,
                        fontWeight: 700,
                        color: fc.tx,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <PlannerIcon iconKey={ANIMAL_ICON_KEYS.sheep} size={18} />
                      <span>{FLOCK_LABELS[f]}</span>
                    </span>
                    <span style={{fontSize: 12, color: fc.tx, opacity: 0.8}}>
                      {flockSheep.length} {flockSheep.length === 1 ? 'sheep' : 'sheep'}
                    </span>
                  </div>
                  {open && flockSheep.length === 0 && (
                    <div style={{padding: '1rem 18px', color: '#9ca3af', fontSize: 12, fontStyle: 'italic'}}>
                      No sheep in this flock yet.
                    </div>
                  )}
                  {open &&
                    flockSheep.map((s, idx) => {
                      const lw = lastWeight(s);
                      const ll = lastLambing(s.tag);
                      const lc = lambCount(s.tag);
                      const isExpanded = expandedSheep === s.id;
                      return (
                        <div key={s.id} id={'sheep-' + s.id} style={{borderBottom: '1px solid #f3f4f6'}}>
                          {!isExpanded && (
                            <div
                              onClick={() => setExpandedSheep(s.id)}
                              style={{
                                padding: '10px 18px 10px 0',
                                display: 'grid',
                                gridTemplateColumns: '48px 16px 70px 60px 180px 70px 90px 1fr',
                                alignItems: 'center',
                                gap: 10,
                                cursor: 'pointer',
                                background: s.breeding_blacklist ? '#fecaca' : 'transparent',
                              }}
                              className="hoverable-tile"
                            >
                              <span
                                style={{
                                  fontSize: 11,
                                  color: '#9ca3af',
                                  fontVariantNumeric: 'tabular-nums',
                                  alignSelf: 'stretch',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'flex-end',
                                  paddingRight: 10,
                                  paddingLeft: 8,
                                  marginTop: -10,
                                  marginBottom: -10,
                                  borderRight: '1px solid #d1d5db',
                                  fontWeight: 600,
                                }}
                              >
                                {idx + 1}
                              </span>
                              <span style={{fontSize: 11, color: '#9ca3af'}}>{'▶'}</span>
                              <span
                                style={{
                                  fontWeight: 700,
                                  fontSize: 13,
                                  color: '#111827',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 4,
                                }}
                              >
                                {s.tag ? '#' + s.tag : '(no tag)'}
                                <span onClick={(e) => e.stopPropagation()} data-activity-surface="sheep.animal">
                                  {React.createElement(ActivityPanel, {
                                    sb,
                                    authState,
                                    entityType: 'sheep.animal',
                                    entityId: s.id,
                                    entityLabel: s.tag || s.id,
                                    mode: 'compact',
                                    onCompactClick: setActivityTarget,
                                  })}
                                </span>
                              </span>
                              <span style={{fontSize: 11, color: '#6b7280'}}>{s.sex || '—'}</span>
                              <span
                                style={{
                                  fontSize: 11,
                                  color: '#6b7280',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {s.breed || '—'}
                              </span>
                              <span style={{fontSize: 11, color: '#6b7280'}}>{age(s.birth_date) || '—'}</span>
                              <span
                                style={{fontSize: 11, color: lw ? '#065f46' : '#9ca3af', fontWeight: lw ? 600 : 400}}
                              >
                                {lw ? lw.toLocaleString() + ' lb' : '—'}
                              </span>
                              <span style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
                                {f === 'ewes' && lc > 0 && (
                                  <span style={{fontSize: 11, color: '#0f766e', fontWeight: 600}}>
                                    {lc + ' ' + (lc === 1 ? 'lamb' : 'lambs')}
                                  </span>
                                )}
                                {f === 'ewes' && ll && (
                                  <span style={{fontSize: 11, color: '#9ca3af'}}>
                                    {'last lambed ' + fmt(ll.lambing_date)}
                                  </span>
                                )}
                                {s.maternal_issue_flag && (
                                  <span
                                    style={{
                                      fontSize: 10,
                                      padding: '1px 6px',
                                      borderRadius: 4,
                                      background: '#fef2f2',
                                      color: '#b91c1c',
                                      fontWeight: 600,
                                    }}
                                  >
                                    MATERNAL
                                  </span>
                                )}
                                {s.breeding_blacklist && (
                                  <span
                                    style={{
                                      fontSize: 10,
                                      padding: '1px 6px',
                                      borderRadius: 4,
                                      background: '#fef2f2',
                                      color: '#b91c1c',
                                      fontWeight: 600,
                                    }}
                                  >
                                    BLACKLIST
                                  </span>
                                )}
                              </span>
                            </div>
                          )}
                          {isExpanded && renderDetail(s)}
                        </div>
                      );
                    })}
                </div>
              );
            })}
            {/* Outcome flocks shown collapsed at the bottom */}
            <SheepCollapsibleOutcomeSections
              sheep={sheep}
              FLOCK_COLORS={FLOCK_COLORS}
              FLOCK_LABELS={FLOCK_LABELS}
              OUTCOMES={OUTCOMES}
              fmt={fmt}
              setStatusFilter={setStatusFilter}
              expandedSheep={expandedSheep}
              setExpandedSheep={setExpandedSheep}
              renderSheepDetail={renderDetail}
            />
          </div>
        )}
      </div>

      {/* Add Sheep modal (kept for creating new records only) */}
      {showAddForm && form && (
        <div
          onClick={() => {
            setNotice(null);
            setShowAddForm(false);
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
              maxWidth: 640,
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
              <div style={{fontSize: 15, fontWeight: 600, color: '#0f766e'}}>Add Sheep</div>
              <button
                onClick={() => {
                  setNotice(null);
                  setShowAddForm(false);
                  setForm(null);
                }}
                style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
              >
                {'×'}
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
              <div>
                <label style={lbl}>Tag #</label>
                <input
                  value={form.tag}
                  onChange={(e) => setForm({...form, tag: e.target.value})}
                  placeholder="Required (or blank for unweaned lamb)"
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Sex</label>
                <select value={form.sex} onChange={(e) => setForm({...form, sex: e.target.value})} style={inpS}>
                  <option value="ewe">Ewe</option>
                  <option value="ram">Ram</option>
                  <option value="wether">Wether</option>
                  <option value="lamb">Lamb</option>
                </select>
              </div>
              <div>
                <label style={lbl}>Flock *</label>
                <select value={form.flock} onChange={(e) => setForm({...form, flock: e.target.value})} style={inpS}>
                  {ALL_FLOCKS.map((f) => (
                    <option key={f} value={f}>
                      {FLOCK_LABELS[f]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={lbl}>Breed</label>
                <select
                  value={form.breed || ''}
                  onChange={(e) => setForm({...form, breed: e.target.value})}
                  style={inpS}
                >
                  <option value="">{'— select —'}</option>
                  {breedOpts.map((b) => (
                    <option key={b.id} value={b.label}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={lbl}>Origin</label>
                <select
                  value={form.origin || ''}
                  onChange={(e) => setForm({...form, origin: e.target.value})}
                  style={inpS}
                >
                  <option value="">{'— select —'}</option>
                  {originOpts.map((o) => (
                    <option key={o.id} value={o.label}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={lbl}>Registration #</label>
                <input
                  value={form.registration_num}
                  onChange={(e) => setForm({...form, registration_num: e.target.value})}
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Birth Date</label>
                <input
                  type="date"
                  value={form.birth_date}
                  onChange={(e) => setForm({...form, birth_date: e.target.value})}
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Purchase Date</label>
                <input
                  type="date"
                  value={form.purchase_date}
                  onChange={(e) => setForm({...form, purchase_date: e.target.value})}
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Purchase Amount ($)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.purchase_amount}
                  onChange={(e) => setForm({...form, purchase_amount: e.target.value})}
                  style={inpS}
                />
              </div>
              <div></div>
              <div>
                <label style={lbl}>Dam Tag</label>
                <input
                  value={form.dam_tag}
                  onChange={(e) => setForm({...form, dam_tag: e.target.value})}
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Dam Reg #</label>
                <input
                  value={form.dam_reg_num}
                  onChange={(e) => setForm({...form, dam_reg_num: e.target.value})}
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Sire Tag</label>
                <input
                  value={form.sire_tag}
                  onChange={(e) => setForm({...form, sire_tag: e.target.value})}
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Sire Reg #</label>
                <input
                  value={form.sire_reg_num}
                  onChange={(e) => setForm({...form, sire_reg_num: e.target.value})}
                  style={inpS}
                />
              </div>
              {form.sex === 'ewe' && (
                <div style={{gridColumn: '1/-1'}}>
                  <label style={lbl}>Breeding Status</label>
                  <select
                    value={form.breeding_status}
                    onChange={(e) => setForm({...form, breeding_status: e.target.value})}
                    style={inpS}
                  >
                    <option value="">{'— not set —'}</option>
                    <option value="Open">Open</option>
                    <option value="Pregnant">Pregnant</option>
                    <option value="N/A">N/A</option>
                  </select>
                </div>
              )}
            </div>
            <div
              style={{
                padding: '12px 20px',
                borderTop: '1px solid #e5e7eb',
                display: 'flex',
                gap: 8,
                justifyContent: 'flex-end',
              }}
            >
              <button
                onClick={() => {
                  setShowAddForm(false);
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
              <button
                onClick={saveSheep}
                disabled={saving}
                style={{
                  padding: '8px 20px',
                  borderRadius: 7,
                  border: 'none',
                  background: '#0f766e',
                  color: 'white',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? 'Saving…' : 'Add Sheep'}
              </button>
            </div>
          </div>
        </div>
      )}
      {React.createElement(ActivityModal, {
        sb,
        authState,
        target: activityTarget,
        onClose: () => setActivityTarget(null),
      })}
    </div>
  );
};

export default SheepFlocksView;
