import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
import CowDetail from './CowDetail.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import CommentsSection from '../shared/CommentsSection.jsx';
import {listActivityEvents, ACTIVITY_CHANGE_EVENT} from '../lib/activityApi.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
import {loadCattleWeighInsCached} from '../lib/cattleCache.js';
import {CATTLE_ALL_HERD_KEYS, CATTLE_HERD_KEYS, cowTagSet} from '../lib/cattleHerdFilters.js';
import {runMutation, recordFieldChange} from '../lib/entityMutations.js';
import {buildChanges, countSummary} from '../lib/activityChangeDiff.js';
import {softDeleteCattleAnimal} from '../lib/cattleDeleteApi.js';

const HERD_LABELS = {
  mommas: 'Mommas',
  backgrounders: 'Backgrounders',
  finishers: 'Finishers',
  bulls: 'Bulls',
  sold: 'Sold',
  deceased: 'Deceased',
  processed: 'Processed',
};
const HERD_COLORS = {
  mommas: {bg: '#fef3c7', tx: '#92400e', bd: '#fcd34d'},
  backgrounders: {bg: '#dbeafe', tx: '#1e40af', bd: '#93c5fd'},
  finishers: {bg: '#d1fae5', tx: '#065f46', bd: '#6ee7b7'},
  bulls: {bg: '#ede9fe', tx: '#5b21b6', bd: '#c4b5fd'},
  sold: {bg: '#f3f4f6', tx: '#6b7280', bd: '#d1d5db'},
  deceased: {bg: '#f3f4f6', tx: '#6b7280', bd: '#d1d5db'},
  processed: {bg: '#f3f4f6', tx: '#6b7280', bd: '#d1d5db'},
};
const CATTLE_EXCLUDE = ['herd', 'processing_batch_id'];
const CATTLE_LABELS = {
  tag: 'Tag',
  sex: 'Sex',
  breed: 'Breed',
  origin: 'Origin',
  birth_date: 'Birth date',
  purchase_date: 'Purchase date',
  purchase_amount: 'Purchase amount',
  dam_tag: 'Dam tag',
  sire_tag: 'Sire tag',
  registration_num: 'Registration #',
  pct_wagyu: '% Wagyu',
  breeding_status: 'Breeding status',
  breeding_blacklist: 'Breeding blacklist',
  sale_date: 'Sale date',
  sale_amount: 'Sale amount',
  death_date: 'Death date',
  death_reason: 'Death reason',
  old_tags: 'Prior tags',
};
const CATTLE_FORMATTERS = {};

function age(birth) {
  if (!birth) return '';
  const b = new Date(birth);
  const now = new Date();
  let y = now.getFullYear() - b.getFullYear();
  let m = now.getMonth() - b.getMonth();
  if (m < 0) {
    y--;
    m += 12;
  }
  if (y > 0) return y + 'y ' + m + 'mo';
  return m + 'mo';
}

export default function CattleAnimalPage({sb, fmt, authState}) {
  const navigate = useNavigate();
  const location = useLocation();
  const cattleId = location.pathname.replace('/cattle/herds/', '');
  const fromCowId = location.state?.fromCowId || null;
  const fromCowTag = location.state?.fromCowTag || null;

  const [cow, setCow] = React.useState(null);
  const [cattle, setCattle] = React.useState([]);
  const [weighIns, setWeighIns] = React.useState([]);
  const [calvingRecs, setCalvingRecs] = React.useState([]);
  const [breedOpts, setBreedOpts] = React.useState([]);
  const [originOpts, setOriginOpts] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState(null);
  const [activityExpanded, setActivityExpanded] = React.useState(false);
  const [activityEvents, setActivityEvents] = React.useState([]);
  const [activityCount, setActivityCount] = React.useState(0);

  async function loadAll() {
    const [cR, allCattle, wAll, calR, brR, orR] = await Promise.all([
      sb.from('cattle').select('*').eq('id', cattleId).is('deleted_at', null).single(),
      sb.from('cattle').select('*').is('deleted_at', null).order('tag'),
      loadCattleWeighInsCached(sb),
      sb.from('cattle_calving_records').select('*').order('calving_date', {ascending: false}),
      sb.from('cattle_breeds').select('*').order('label'),
      sb.from('cattle_origins').select('*').order('label'),
    ]);
    if (cR.data) setCow(cR.data);
    if (allCattle.data) setCattle(allCattle.data);
    setWeighIns(wAll);
    if (calR.data) setCalvingRecs(calR.data);
    if (brR.data) setBreedOpts(brR.data);
    if (orR.data) setOriginOpts(orR.data);
    setLoading(false);
  }

  React.useEffect(() => {
    setCow(null);
    setLoading(true);
    setNotice(null);
    setActivityExpanded(false);
    setActivityEvents([]);
    setActivityCount(0);
    loadAll();
  }, [cattleId]);

  React.useEffect(() => {
    if (!activityExpanded || !cow) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listActivityEvents(sb, 'cattle.animal', cow.id, {limit: 50});
        if (cancelled) return;
        const auditOnly = (rows || []).filter((e) => e.event_type !== 'comment.posted');
        setActivityEvents(auditOnly);
        setActivityCount(auditOnly.filter((e) => !e.deleted_at).length);
      } catch (_e) {
        /* soft-fail */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activityExpanded, cow?.id]);

  React.useEffect(() => {
    if (!cow) return;
    listActivityEvents(sb, 'cattle.animal', cow.id, {limit: 50}).then((rows) => {
      const auditOnly = (rows || []).filter((e) => e.event_type !== 'comment.posted');
      setActivityCount(auditOnly.filter((e) => !e.deleted_at).length);
    });
  }, [cow?.id]);

  React.useEffect(() => {
    function onActivityChange() {
      if (!cow || !activityExpanded) return;
      listActivityEvents(sb, 'cattle.animal', cow.id, {limit: 50}).then((rows) => {
        const auditOnly = (rows || []).filter((e) => e.event_type !== 'comment.posted');
        setActivityEvents(auditOnly);
        setActivityCount(auditOnly.filter((e) => !e.deleted_at).length);
      });
    }
    window.addEventListener(ACTIVITY_CHANGE_EVENT, onActivityChange);
    return () => window.removeEventListener(ACTIVITY_CHANGE_EVENT, onActivityChange);
  }, [cow?.id, activityExpanded]);

  React.useEffect(() => {
    if (!loading && location.hash) {
      const anchor = location.hash.slice(1);
      setTimeout(() => {
        const el = document.getElementById(anchor);
        if (el) el.scrollIntoView({behavior: 'smooth', block: 'center'});
      }, 200);
    }
  }, [loading, location.hash]);

  async function patchCow(fields) {
    if (!cow || !fields) return;
    setNotice(null);
    const result = await runMutation(() => sb.from('cattle').update(fields).eq('id', cow.id), {
      activity: () => {
        const changes = buildChanges(cow, fields, {
          exclude: CATTLE_EXCLUDE,
          labels: CATTLE_LABELS,
          formatters: CATTLE_FORMATTERS,
        });
        if (changes.length === 0) return;
        return recordFieldChange(sb, {
          entityType: 'cattle.animal',
          entityId: cow.id,
          entityLabel: fields.tag || cow.tag || cow.id,
          changes,
        });
      },
      onError: (msg) => setNotice({kind: 'error', message: 'Save failed: ' + msg}),
    });
    if (result.ok) {
      setCow((prev) => ({...prev, ...fields}));
      setCattle((prev) => prev.map((c) => (c.id === cow.id ? {...c, ...fields} : c)));
    }
  }

  async function transferCow(newHerd) {
    if (!cow) return;
    const oldHerd = cow.herd;
    const updates = {herd: newHerd};
    if (newHerd === 'deceased' && !cow.death_date) updates.death_date = new Date().toISOString().slice(0, 10);
    if (newHerd === 'sold' && !cow.sale_date) updates.sale_date = new Date().toISOString().slice(0, 10);
    await sb.from('cattle').update(updates).eq('id', cow.id);
    await sb.from('cattle_transfers').insert({
      id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
      cattle_id: cow.id,
      from_herd: oldHerd,
      to_herd: newHerd,
      reason: 'manual',
      team_member: authState && authState.name ? authState.name : null,
    });
    await loadAll();
  }

  async function addCalvingRecord(cowRecord, formData) {
    setNotice(null);
    if (!formData.calving_date) {
      setNotice({kind: 'error', message: 'Calving date required.'});
      return false;
    }
    if (formData.complications_flag && !(formData.complications_desc || '').trim()) {
      setNotice({kind: 'error', message: 'Complications description required when complications flag is set.'});
      return false;
    }
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    const rec = {
      id,
      dam_tag: cowRecord.tag,
      calving_date: formData.calving_date,
      calf_tag: formData.calf_tag || null,
      sire_tag: formData.sire_tag || null,
      total_born: parseInt(formData.total_born) || 0,
      deaths: parseInt(formData.deaths) || 0,
      complications_flag: !!formData.complications_flag,
      complications_desc: formData.complications_desc || null,
      notes: formData.notes || null,
    };
    const {error} = await sb.from('cattle_calving_records').insert(rec);
    if (error) {
      setNotice({kind: 'error', message: 'Save failed: ' + error.message});
      return false;
    }
    await loadAll();
    return true;
  }

  async function deleteCalvingRecord(recId) {
    if (!window._wcfConfirmDelete) return;
    window._wcfConfirmDelete('Delete this calving record?', async () => {
      await sb.from('cattle_calving_records').delete().eq('id', recId);
      await loadAll();
    });
  }

  async function deleteCow() {
    if (!cow || !window._wcfConfirmDelete) return;
    window._wcfConfirmDelete('Delete this cow record? The record can be restored from Recently Deleted.', async () => {
      try {
        await softDeleteCattleAnimal(sb, cow.id, cow.tag || cow.id);
        navigate('/cattle/herds');
      } catch (e) {
        setNotice({kind: 'error', message: 'Delete failed: ' + (e.message || String(e))});
      }
    });
  }

  function navigateToCow(target) {
    if (!target || !target.id) return;
    navigate('/cattle/herds/' + target.id, {
      state: {fromCowId: cow.id, fromCowTag: cow.tag || cow.id},
    });
  }

  if (loading) {
    return <div style={{padding: 24, textAlign: 'center', color: '#6b7280', fontSize: 14}}>Loading…</div>;
  }

  if (!cow) {
    return (
      <div style={{padding: 24}}>
        <button
          type="button"
          onClick={() => navigate('/cattle/herds')}
          style={{
            background: 'none',
            border: 'none',
            color: '#1d4ed8',
            cursor: 'pointer',
            fontSize: 14,
            fontFamily: 'inherit',
            padding: 0,
          }}
        >
          ← Back to Herds
        </button>
        <div style={{marginTop: 16, color: '#6b7280', fontSize: 14}}>
          Cattle record not found. It may have been deleted.
        </div>
      </div>
    );
  }

  const cowWeighIns = weighIns.filter((w) => {
    const tags = cowTagSet(cow);
    return tags.has(w.tag);
  });

  return (
    <div data-cattle-animal-page="1" style={{maxWidth: 800, margin: '0 auto', padding: '12px 16px'}}>
      <div style={{marginBottom: 12}}>
        <button
          type="button"
          onClick={() => navigate('/cattle/herds')}
          style={{
            background: 'none',
            border: 'none',
            color: '#1d4ed8',
            cursor: 'pointer',
            fontSize: 14,
            fontFamily: 'inherit',
            padding: 0,
            fontWeight: 500,
          }}
        >
          ← Back to Herds
        </button>
      </div>

      <h1
        data-record-title="1"
        style={{
          fontSize: 28,
          fontWeight: 700,
          color: '#111827',
          margin: '0 0 12px',
          lineHeight: 1.2,
        }}
      >
        {cow.tag ? '#' + cow.tag : 'Untagged animal'}
      </h1>

      {notice && <InlineNotice kind={notice.kind} message={notice.message} onDismiss={() => setNotice(null)} />}

      <CowDetail
        key={cow.id}
        cow={cow}
        ageLabel={age(cow.birth_date) || '—'}
        weighIns={cowWeighIns}
        calving={calvingRecs.filter((r) => r.dam_tag === cow.tag)}
        comments={[]}
        calves={cattle.filter((x) => x.dam_tag === cow.tag)}
        dam={cattle.find((x) => x.tag === cow.dam_tag)}
        cattleList={cattle}
        fmt={fmt}
        HERDS={CATTLE_ALL_HERD_KEYS}
        HERD_LABELS={HERD_LABELS}
        HERD_COLORS={HERD_COLORS}
        onEdit={() => {}}
        onTransfer={(newHerd) => transferCow(newHerd)}
        onDelete={authState?.role === 'admin' ? () => deleteCow() : undefined}
        onComment={null}
        onEditComment={null}
        onDeleteComment={null}
        hideComments={true}
        onAddCalving={(data) => addCalvingRecord(cow, data)}
        onDeleteCalving={(id) => deleteCalvingRecord(id)}
        onNavigateToCow={(target) => navigateToCow(target)}
        onNavigateBack={() => navigate('/cattle/herds/' + fromCowId)}
        canNavigateBack={Boolean(fromCowId)}
        backToTag={fromCowTag}
        onPatch={(fields) => patchCow(fields)}
        onClose={() => navigate('/cattle/herds')}
        originOpts={originOpts}
        breedOpts={breedOpts}
      />

      <div style={{marginTop: 16}}>
        <CommentsSection
          sb={sb}
          authState={authState}
          entityType="cattle.animal"
          entityId={cow.id}
          entityLabel={cow.tag || cow.id}
        />
      </div>

      <div style={{marginTop: 16}}>
        <button
          type="button"
          data-activity-log-toggle="1"
          onClick={() => setActivityExpanded((p) => !p)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'white',
            border: '1px solid #e5e7eb',
            borderRadius: 10,
            padding: '10px 14px',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 600,
            color: '#374151',
            fontFamily: 'inherit',
            width: '100%',
            textAlign: 'left',
          }}
        >
          <span style={{fontSize: 10}}>{activityExpanded ? '▼' : '▶'}</span>
          Activity log ({activityCount})
        </button>
        {activityExpanded && (
          <div
            data-activity-audit-log="1"
            style={{
              background: 'white',
              border: '1px solid #e5e7eb',
              borderTop: 'none',
              borderRadius: '0 0 10px 10px',
              padding: 14,
            }}
          >
            {activityEvents.length === 0 && <div style={{fontSize: 12.5, color: '#6b7280'}}>No audit events yet.</div>}
            {activityEvents.map((ev) => (
              <div key={ev.id} style={{padding: '6px 0', borderBottom: '1px solid #f3f4f6', fontSize: 12}}>
                <span style={{fontWeight: 700, color: '#111827', fontSize: 12.5}}>
                  {ev.actor_display_name || (ev.actor_profile_id ? 'Unknown user' : 'System')}
                </span>{' '}
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: '#e0f2fe',
                    color: '#075985',
                  }}
                >
                  {ev.event_type.replace('.', ' ')}
                </span>
                {' · '}
                <span style={{color: '#6b7280'}}>
                  {(() => {
                    try {
                      const d = new Date(ev.created_at);
                      const diff = (Date.now() - d.getTime()) / 1000;
                      if (diff < 60) return 'just now';
                      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
                      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
                      return d.toLocaleString();
                    } catch (_e) {
                      return ev.created_at;
                    }
                  })()}
                </span>
                {ev.body && <div style={{color: '#374151', marginTop: 2}}>{ev.body}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
