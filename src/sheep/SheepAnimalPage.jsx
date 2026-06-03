import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
import SheepDetail from './SheepDetail.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';
import RecordSequenceNav from '../shared/RecordSequenceNav.jsx';
import {recordSeqNavOptions} from '../lib/recordSequence.js';
/* eslint-disable no-unused-vars -- shell primitives are used in JSX only */
import {
  RecordPageFrame,
  RecordPageLoading,
  RecordPageNotFound,
  RecordPageBody,
  RecordBackLink,
  RecordTitle,
} from '../shared/RecordPageShell.jsx';
/* eslint-enable no-unused-vars */
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
import {loadSheepWeighInsCached} from '../lib/sheepCache.js';
import {softDeleteSheepAnimal} from '../lib/sheepDeleteApi.js';
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
  const [loadError, setLoadError] = React.useState(null);

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    try {
      const [sR, allR, wAll, lR, brR, orR] = await Promise.all([
        sb.from('sheep').select('*').eq('id', sheepId).is('deleted_at', null).maybeSingle(),
        sb.from('sheep').select('*').is('deleted_at', null).order('tag'),
        loadSheepWeighInsCached(sb, {throwOnError: true}),
        sb.from('sheep_lambing_records').select('*').order('lambing_date', {ascending: false}),
        sb.from('sheep_breeds').select('*').order('label'),
        sb.from('sheep_origins').select('*').order('label'),
      ]);
      if (sR.error) throw new Error('sheep: ' + (sR.error.message || sR.error));
      if (allR.error) throw new Error('sheep list: ' + (allR.error.message || allR.error));
      if (lR.error) throw new Error('sheep_lambing_records: ' + (lR.error.message || lR.error));
      if (brR.error) throw new Error('sheep_breeds: ' + (brR.error.message || brR.error));
      if (orR.error) throw new Error('sheep_origins: ' + (orR.error.message || orR.error));
      setAnimal(sR.data || null);
      setAllSheep(allR.data || []);
      setWeighIns(wAll || []);
      setLambingRecs(lR.data || []);
      setBreedOpts(brR.data || []);
      setOriginOpts(orR.data || []);
    } catch (e) {
      setAnimal(null);
      setAllSheep([]);
      setWeighIns([]);
      setLambingRecs([]);
      setBreedOpts([]);
      setOriginOpts([]);
      setLoadError({
        kind: 'error',
        message: 'Could not load sheep record. Please refresh the page. (' + ((e && e.message) || e) + ')',
      });
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    setAnimal(null);
    setLoading(true);
    setNotice(null);
    setLoadError(null);
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
      'Delete this sheep record? Admin/backend recovery is available, but this record will be hidden from active sheep views.',
      async () => {
        try {
          await softDeleteSheepAnimal(sb, animal.id, animal.tag || animal.id);
          navigate('/sheep/flocks');
        } catch (e) {
          setNotice({kind: 'error', message: 'Delete failed: ' + (e.message || String(e))});
        }
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
    return <RecordPageLoading Header={Header} />;
  }

  if (loadError) {
    return (
      <RecordPageFrame Header={Header}>
        <RecordPageBody data-sheep-animal-load-error="true">
          <RecordBackLink label="Back to Flocks" onBack={() => navigate('/sheep/flocks')} />
          <InlineNotice notice={loadError} />
          <button
            type="button"
            onClick={loadAll}
            style={{
              padding: '7px 14px',
              borderRadius: 7,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#0f766e',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              marginTop: 10,
            }}
          >
            Retry
          </button>
        </RecordPageBody>
      </RecordPageFrame>
    );
  }

  if (!animal) {
    return (
      <RecordPageNotFound
        Header={Header}
        backLabel="Back to Flocks"
        onBack={() => navigate('/sheep/flocks')}
        message="Sheep record not found. It may have been deleted."
      />
    );
  }

  const animalWeighIns = weighIns.filter((w) => {
    const tags = sheepTagSet(animal);
    return tags.has(w.tag);
  });

  return (
    <RecordPageFrame Header={Header}>
      <RecordPageBody data-sheep-animal-page="1">
        <RecordBackLink label="Back to Flocks" onBack={() => navigate('/sheep/flocks')} />

        <RecordSequenceNav seq={recordSeq} currentId={sheepId} onNavigate={navigateSeq} />

        <RecordTitle>{animal.tag ? '#' + animal.tag : 'Untagged animal'}</RecordTitle>

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
          onDelete={authState?.role === 'admin' ? () => deleteSheep() : undefined}
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
      </RecordPageBody>
    </RecordPageFrame>
  );
}
