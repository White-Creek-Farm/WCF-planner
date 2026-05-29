import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
import SheepDetail from './SheepDetail.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';
import RecordSequenceNav from '../shared/RecordSequenceNav.jsx';
import {recordSeqNavOptions} from '../lib/recordSequence.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
import {runMutation, recordFieldChange} from '../lib/entityMutations.js';
import {buildChanges, countSummary} from '../lib/activityChangeDiff.js';

const FLOCK_LABELS = {
  rams: 'Rams',
  ewes: 'Ewes',
  feeders: 'Feeders',
  sold: 'Sold',
  deceased: 'Deceased',
  processed: 'Processed',
};
const FLOCK_COLORS = {
  rams: {bg: '#f0fdfa', tx: '#0f766e', bd: '#5eead4'},
  ewes: {bg: '#fdf4ff', tx: '#86198f', bd: '#f0abfc'},
  feeders: {bg: '#fefce8', tx: '#854d0e', bd: '#fde047'},
  sold: {bg: '#f3f4f6', tx: '#6b7280', bd: '#d1d5db'},
  deceased: {bg: '#f3f4f6', tx: '#6b7280', bd: '#d1d5db'},
  processed: {bg: '#f3f4f6', tx: '#6b7280', bd: '#d1d5db'},
};
const ALL_FLOCKS = ['rams', 'ewes', 'feeders', 'processed', 'deceased', 'sold'];
const SHEEP_EXCLUDE = ['flock', 'processing_batch_id'];
const SHEEP_LABELS = {
  tag: 'Tag',
  sex: 'Sex',
  breed: 'Breed',
  origin: 'Origin',
  birth_date: 'Birth date',
  purchase_date: 'Purchase date',
  purchase_amount: 'Purchase amount',
  dam_tag: 'Dam tag',
  dam_reg_num: 'Dam reg #',
  sire_tag: 'Sire tag',
  sire_reg_num: 'Sire reg #',
  registration_num: 'Registration #',
  breeding_status: 'Breeding status',
  breeding_blacklist: 'Breeding blacklist',
  maternal_issue_flag: 'Maternal issue flag',
  maternal_issue_desc: 'Maternal issue description',
  sale_date: 'Sale date',
  sale_amount: 'Sale amount',
  death_date: 'Death date',
  death_reason: 'Death reason',
  old_tags: 'Prior tags',
};
const SHEEP_FORMATTERS = {
  old_tags: (v) => countSummary(v, 'prior tag'),
};

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

export default function SheepAnimalPage({sb, fmt, authState, Header}) {
  const navigate = useNavigate();
  const location = useLocation();
  const sheepId = location.pathname.replace('/sheep/flocks/', '');
  const fromSheepId = location.state?.fromSheepId || null;
  const fromSheepTag = location.state?.fromSheepTag || null;
  // Originating list order (visible rows) handed through route state. Absent on
  // direct links, notifications, and sheep-to-sheep click-throughs.
  const recordSeq = location.state?.recordSeq || null;

  const [animal, setAnimal] = React.useState(null);
  const [allSheep, setAllSheep] = React.useState([]);
  const [weighIns, setWeighIns] = React.useState([]);
  const [lambingRecs, setLambingRecs] = React.useState([]);
  const [breedOpts, setBreedOpts] = React.useState([]);
  const [originOpts, setOriginOpts] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState(null);

  async function loadAll() {
    const sessR = await sb.from('weigh_in_sessions').select('id,date,herd').eq('species', 'sheep');
    const sessIds = (sessR.data || []).map((s) => s.id);
    const wR =
      sessIds.length > 0
        ? await sb.from('weigh_ins').select('*').in('session_id', sessIds).order('entered_at', {ascending: false})
        : {data: []};
    const [sR, allR, lR, brR, orR] = await Promise.all([
      sb.from('sheep').select('*').eq('id', sheepId).single(),
      sb.from('sheep').select('*').order('tag'),
      sb.from('sheep_lambing_records').select('*').order('lambing_date', {ascending: false}),
      sb.from('sheep_breeds').select('*').order('label'),
      sb.from('sheep_origins').select('*').order('label'),
    ]);
    if (sR.data) setAnimal(sR.data);
    if (allR.data) setAllSheep(allR.data);
    if (wR.data) setWeighIns(wR.data);
    if (lR.data) setLambingRecs(lR.data);
    if (brR.data) setBreedOpts(brR.data);
    if (orR.data) setOriginOpts(orR.data);
    setLoading(false);
  }

  React.useEffect(() => {
    setAnimal(null);
    setLoading(true);
    setNotice(null);
    loadAll();
  }, [sheepId]);

  React.useEffect(() => {
    if (!loading && location.hash) {
      const anchor = location.hash.slice(1);
      setTimeout(() => {
        const el = document.getElementById(anchor);
        if (el) el.scrollIntoView({behavior: 'smooth', block: 'center'});
      }, 200);
    }
  }, [loading, location.hash]);

  async function patchSheep(fields) {
    if (!animal || !fields) return;
    setNotice(null);
    const result = await runMutation(() => sb.from('sheep').update(fields).eq('id', animal.id), {
      activity: () => {
        const changes = buildChanges(animal, fields, {
          exclude: SHEEP_EXCLUDE,
          labels: SHEEP_LABELS,
          formatters: SHEEP_FORMATTERS,
        });
        if (changes.length === 0) return;
        return recordFieldChange(sb, {
          entityType: 'sheep.animal',
          entityId: animal.id,
          entityLabel: fields.tag || animal.tag || animal.id,
          changes,
        });
      },
      onError: (msg) => setNotice({kind: 'error', message: 'Save failed: ' + msg}),
    });
    if (result.ok) {
      setAnimal((prev) => ({...prev, ...fields}));
      setAllSheep((prev) => prev.map((s) => (s.id === animal.id ? {...s, ...fields} : s)));
    }
  }

  async function transferSheep(newFlock) {
    if (!animal) return;
    const oldFlock = animal.flock;
    if (newFlock === oldFlock) return;
    setNotice(null);
    const updates = {flock: newFlock};
    if (newFlock === 'deceased' && !animal.death_date) updates.death_date = new Date().toISOString().slice(0, 10);
    if (newFlock === 'sold' && !animal.sale_date) updates.sale_date = new Date().toISOString().slice(0, 10);
    const {error: updateErr} = await sb.from('sheep').update(updates).eq('id', animal.id);
    if (updateErr) {
      setNotice({kind: 'error', message: 'Transfer failed: ' + updateErr.message});
      return;
    }
    const {error: auditErr} = await sb.from('sheep_transfers').insert({
      id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
      sheep_id: animal.id,
      from_flock: oldFlock,
      to_flock: newFlock,
      reason: 'manual',
      team_member: authState && authState.name ? authState.name : null,
    });
    if (auditErr) {
      setNotice({
        kind: 'warning',
        message: 'Sheep moved to ' + newFlock + ', but transfer audit row failed: ' + auditErr.message,
      });
    }
    await loadAll();
  }

  async function addLambingRecord(sheepRecord, formData) {
    setNotice(null);
    if (!formData.lambing_date) {
      setNotice({kind: 'error', message: 'Lambing date required.'});
      return false;
    }
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    const rec = {
      id,
      dam_tag: sheepRecord.tag,
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
    await loadAll();
    return true;
  }

  async function deleteLambingRecord(recId) {
    if (!window._wcfConfirmDelete) return;
    window._wcfConfirmDelete('Delete this lambing record?', async () => {
      await sb.from('sheep_lambing_records').delete().eq('id', recId);
      await loadAll();
    });
  }

  async function deleteSheep() {
    if (!animal || !window._wcfConfirmDelete) return;
    window._wcfConfirmDelete(
      'Permanently delete this sheep record? Lambing records, comments, and weigh-ins for this tag remain.',
      async () => {
        await sb.from('sheep').delete().eq('id', animal.id);
        navigate('/sheep/flocks');
      },
    );
  }

  function navigateToSheep(target) {
    if (!target || !target.id) return;
    navigate('/sheep/flocks/' + target.id, {
      state: {fromSheepId: animal.id, fromSheepTag: animal.tag || animal.id},
    });
  }

  // Prev/Next within the originating list sequence — carry the sequence
  // forward so the neighbor record keeps its controls.
  function navigateSeq(id) {
    navigate('/sheep/flocks/' + id, recordSeqNavOptions(recordSeq));
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

  if (loading) {
    return (
      <div style={{minHeight: '100vh', background: '#f1f3f2'}}>
        {Header && <Header />}
        <div style={{padding: 24, textAlign: 'center', color: '#6b7280', fontSize: 14}}>Loading…</div>
      </div>
    );
  }

  if (!animal) {
    return (
      <div style={{minHeight: '100vh', background: '#f1f3f2'}}>
        {Header && <Header />}
        <div style={{padding: 24}}>
          <button
            type="button"
            onClick={() => navigate('/sheep/flocks')}
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
            ← Back to Flocks
          </button>
          <div style={{marginTop: 16, color: '#6b7280', fontSize: 14}}>
            Sheep record not found. It may have been deleted.
          </div>
        </div>
      </div>
    );
  }

  const animalWeighIns = weighIns.filter((w) => {
    const tags = sheepTagSet(animal);
    return tags.has(w.tag);
  });

  return (
    <div style={{minHeight: '100vh', background: '#f1f3f2'}}>
      {Header && <Header />}
      <div data-sheep-animal-page="1" style={{maxWidth: 800, margin: '0 auto', padding: '12px 16px'}}>
        <div style={{marginBottom: 12}}>
          <button
            type="button"
            onClick={() => navigate('/sheep/flocks')}
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
            ← Back to Flocks
          </button>
        </div>

        <RecordSequenceNav seq={recordSeq} currentId={sheepId} onNavigate={navigateSeq} />

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
          {animal.tag ? '#' + animal.tag : 'Untagged animal'}
        </h1>

        {notice && <InlineNotice kind={notice.kind} message={notice.message} onDismiss={() => setNotice(null)} />}

        <SheepDetail
          key={animal.id}
          sheep={animal}
          ageLabel={age(animal.birth_date) || '—'}
          weighIns={animalWeighIns}
          lambing={lambingRecs.filter((r) => r.dam_tag === animal.tag)}
          comments={[]}
          lambs={allSheep.filter((x) => x.dam_tag === animal.tag)}
          dam={allSheep.find((x) => x.tag === animal.dam_tag)}
          sheepList={allSheep}
          fmt={fmt}
          FLOCKS={ALL_FLOCKS}
          FLOCK_LABELS={FLOCK_LABELS}
          FLOCK_COLORS={FLOCK_COLORS}
          onEdit={() => {}}
          onTransfer={(newFlock) => transferSheep(newFlock)}
          onDelete={() => deleteSheep()}
          onComment={null}
          onEditComment={null}
          onDeleteComment={null}
          hideComments={true}
          onAddLambing={(data) => addLambingRecord(animal, data)}
          onDeleteLambing={(id) => deleteLambingRecord(id)}
          onNavigateToSheep={(target) => navigateToSheep(target)}
          onNavigateBack={() => navigate('/sheep/flocks/' + fromSheepId)}
          canNavigateBack={Boolean(fromSheepId)}
          backToTag={fromSheepTag}
          onPatch={(fields) => patchSheep(fields)}
          onClose={() => navigate('/sheep/flocks')}
          originOpts={originOpts}
          breedOpts={breedOpts}
        />

        <RecordCollaborationSection
          sb={sb}
          authState={authState}
          entityType="sheep.animal"
          entityId={animal.id}
          entityLabel={animal.tag || animal.id}
        />
      </div>
    </div>
  );
}
