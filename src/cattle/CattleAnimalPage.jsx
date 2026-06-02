import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
import CowDetail from './CowDetail.jsx';
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

export default function CattleAnimalPage({sb, fmt, authState, Header}) {
  const navigate = useNavigate();
  const location = useLocation();
  const cattleId = location.pathname.replace('/cattle/herds/', '');
  const fromCowId = location.state?.fromCowId || null;
  const fromCowTag = location.state?.fromCowTag || null;
  // Originating list order (visible rows) handed through route state. Absent on
  // direct links, notifications, and cow-to-cow click-throughs.
  const recordSeq = location.state?.recordSeq || null;

  const [cow, setCow] = React.useState(null);
  const [cattle, setCattle] = React.useState([]);
  const [weighIns, setWeighIns] = React.useState([]);
  const [calvingRecs, setCalvingRecs] = React.useState([]);
  const [breedOpts, setBreedOpts] = React.useState([]);
  const [originOpts, setOriginOpts] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState(null);
  const [loadError, setLoadError] = React.useState(null);

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    try {
      const [cR, allCattle, wAll, calR, brR, orR] = await Promise.all([
        sb.from('cattle').select('*').eq('id', cattleId).is('deleted_at', null).maybeSingle(),
        sb.from('cattle').select('*').is('deleted_at', null).order('tag'),
        loadCattleWeighInsCached(sb, {throwOnError: true}),
        sb.from('cattle_calving_records').select('*').order('calving_date', {ascending: false}),
        sb.from('cattle_breeds').select('*').order('label'),
        sb.from('cattle_origins').select('*').order('label'),
      ]);
      if (cR.error) throw new Error('cattle: ' + (cR.error.message || cR.error));
      if (allCattle.error) throw new Error('cattle list: ' + (allCattle.error.message || allCattle.error));
      if (calR.error) throw new Error('cattle_calving_records: ' + (calR.error.message || calR.error));
      if (brR.error) throw new Error('cattle_breeds: ' + (brR.error.message || brR.error));
      if (orR.error) throw new Error('cattle_origins: ' + (orR.error.message || orR.error));
      setCow(cR.data || null);
      setCattle(allCattle.data || []);
      setWeighIns(wAll || []);
      setCalvingRecs(calR.data || []);
      setBreedOpts(brR.data || []);
      setOriginOpts(orR.data || []);
    } catch (e) {
      setCow(null);
      setCattle([]);
      setWeighIns([]);
      setCalvingRecs([]);
      setBreedOpts([]);
      setOriginOpts([]);
      setLoadError({
        kind: 'error',
        message: 'Could not load cattle record. Please refresh the page. (' + ((e && e.message) || e) + ')',
      });
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    setCow(null);
    setLoading(true);
    setNotice(null);
    setLoadError(null);
    loadAll();
  }, [cattleId]);

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
    if (newHerd === oldHerd) return;
    setNotice(null);
    const updates = {herd: newHerd};
    if (newHerd === 'deceased' && !cow.death_date) updates.death_date = new Date().toISOString().slice(0, 10);
    if (newHerd === 'sold' && !cow.sale_date) updates.sale_date = new Date().toISOString().slice(0, 10);
    const {error: updateErr} = await sb.from('cattle').update(updates).eq('id', cow.id);
    if (updateErr) {
      setNotice({kind: 'error', message: 'Transfer failed: ' + updateErr.message});
      return;
    }
    const {error: auditErr} = await sb.from('cattle_transfers').insert({
      id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
      cattle_id: cow.id,
      from_herd: oldHerd,
      to_herd: newHerd,
      reason: 'manual',
      team_member: authState && authState.name ? authState.name : null,
    });
    if (auditErr) {
      setNotice({
        kind: 'warning',
        message: 'Cow moved to ' + newHerd + ', but transfer audit row failed: ' + auditErr.message,
      });
    }
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
    window._wcfConfirmDelete(
      'Delete this cow record? Admin/backend recovery is available, but this record will be hidden from active cattle views.',
      async () => {
        try {
          await softDeleteCattleAnimal(sb, cow.id, cow.tag || cow.id);
          navigate('/cattle/herds');
        } catch (e) {
          setNotice({kind: 'error', message: 'Delete failed: ' + (e.message || String(e))});
        }
      },
    );
  }

  function navigateToCow(target) {
    if (!target || !target.id) return;
    navigate('/cattle/herds/' + target.id, {
      state: {fromCowId: cow.id, fromCowTag: cow.tag || cow.id},
    });
  }

  // Prev/Next within the originating list sequence — carry the sequence
  // forward so the neighbor record keeps its controls.
  function navigateSeq(id) {
    navigate('/cattle/herds/' + id, recordSeqNavOptions(recordSeq));
  }

  if (loading) {
    return <RecordPageLoading Header={Header} />;
  }

  if (loadError) {
    return (
      <RecordPageFrame Header={Header}>
        <RecordPageBody>
          <RecordBackLink label="Back to Herds" onBack={() => navigate('/cattle/herds')} />
          <InlineNotice notice={loadError} onDismiss={() => setLoadError(null)} />
        </RecordPageBody>
      </RecordPageFrame>
    );
  }

  if (!cow) {
    return (
      <RecordPageNotFound
        Header={Header}
        backLabel="Back to Herds"
        onBack={() => navigate('/cattle/herds')}
        message="Cattle record not found. It may have been deleted."
      />
    );
  }

  const cowWeighIns = weighIns.filter((w) => {
    const tags = cowTagSet(cow);
    return tags.has(w.tag);
  });

  return (
    <RecordPageFrame Header={Header}>
      <RecordPageBody data-cattle-animal-page="1">
        <RecordBackLink label="Back to Herds" onBack={() => navigate('/cattle/herds')} />

        <RecordSequenceNav seq={recordSeq} currentId={cattleId} onNavigate={navigateSeq} />

        <RecordTitle>{cow.tag ? '#' + cow.tag : 'Untagged animal'}</RecordTitle>

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

        <RecordCollaborationSection
          sb={sb}
          authState={authState}
          entityType="cattle.animal"
          entityId={cow.id}
          entityLabel={cow.tag || cow.id}
        />
      </RecordPageBody>
    </RecordPageFrame>
  );
}
