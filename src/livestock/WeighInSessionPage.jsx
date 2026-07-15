import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordSequenceNav from '../shared/RecordSequenceNav.jsx';
import {recordSeqNavOptions} from '../lib/recordSequence.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
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
import CattleSendToProcessorModal from '../cattle/CattleSendToProcessorModal.jsx';
import SheepSendToProcessorModal from '../sheep/SheepSendToProcessorModal.jsx';
import {loadCattleWeighInsCached, invalidateCattleWeighInsCache} from '../lib/cattleCache.js';
import {loadSheepWeighInsCached, invalidateSheepWeighInsCache} from '../lib/sheepCache.js';
import {detachCattleFromProcessingBatch, detachSheepFromProcessingBatch} from '../lib/processingDetachApi.js';
import {deleteWeighInEntry, deleteWeighInSession} from '../lib/weighInDeleteApi.js';
import {runMutation, recordFieldChange, recordStatusChange, recordActivityEvent} from '../lib/entityMutations.js';
import {buildChanges} from '../lib/activityChangeDiff.js';
import {getProgramColor} from '../lib/programColors.js';
import {
  formatAgeRange,
  formatFeedPerPig,
  formatGroupAdg,
  formatAvgWeight,
  computeRankMatchedPigEntryADG,
} from '../lib/pigForecast.js';
import {pigSendToTrip, pigUndoSend} from '../lib/pigPlannerApi.js';
import PigSendToTripModal from './PigSendToTripModal.jsx';
import {writeBroilerBatchAvg, recomputeBroilerBatchWeekAvg} from '../lib/broiler.js';
import {LockedTeamMemberField, recordControl, recordFieldLabel} from '../shared/recordPageControls.jsx';

const HERD_LABELS = {mommas: 'Mommas', backgrounders: 'Backgrounders', finishers: 'Finishers', bulls: 'Bulls'};
const FLOCK_LABELS = {rams: 'Rams', ewes: 'Ewes', feeders: 'Feeders'};
const SPECIES_BACK = {
  cattle: {path: '/cattle/weighins', label: 'Cattle Weigh-Ins'},
  sheep: {path: '/sheep/weighins', label: 'Sheep Weigh-Ins'},
  pig: {path: '/pig/weighins', label: 'Pig Weigh-Ins'},
  broiler: {path: '/broiler/weighins', label: 'Broiler Weigh-Ins'},
};
const inp = {
  fontSize: 12,
  padding: '4px 8px',
  border: '1px solid var(--border-strong)',
  borderRadius: 10,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};
const BLACKLIST_OPTION_STYLE = {backgroundColor: '#fee2e2', color: '#991b1b', fontWeight: 700};
const WEIGHIN_ENTRY_AUTOSAVE_DELAY_MS = 700;
const WEIGHIN_ENTRY_ACTIVITY_EXCLUDE = [
  'id',
  'session_id',
  'entered_at',
  'reconcile_intent',
  'send_to_processor',
  'target_processing_batch_id',
  'prior_herd_or_flock',
  'sent_to_trip_id',
  'sent_to_group_id',
  'transferred_to_breeding',
  'transfer_breeder_id',
  'feed_allocation_lbs',
];

function sortEntriesByTagAsc(a, b) {
  const at = a && a.tag,
    bt = b && b.tag;
  if (at == null && bt == null) return (a.entered_at || '').localeCompare(b.entered_at || '');
  if (at == null) return 1;
  if (bt == null) return -1;
  const an = parseFloat(at),
    bn = parseFloat(bt);
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
  return String(at).localeCompare(String(bt));
}

function sortPigEntriesByWeightDesc(entries) {
  return [...(entries || [])].sort((a, b) => (parseFloat(b.weight) || 0) - (parseFloat(a.weight) || 0));
}

function entryDraft(e) {
  return {tag: e.tag || '', weight: String(e.weight ?? ''), note: e.note || ''};
}

function formatSignedLbs(value) {
  const n = Math.round(parseFloat(value) || 0);
  return (n > 0 ? '+' : '') + n + ' lb';
}

function daysBetweenDates(priorDate, curDate) {
  if (!priorDate || !curDate) return null;
  const pd = new Date(priorDate + 'T12:00:00');
  const cd = new Date(curDate + 'T12:00:00');
  const days = Math.round((cd - pd) / 86400000);
  return Number.isFinite(days) && days >= 1 ? days : null;
}

function adgLbPerDay(priorWt, priorDate, curWt, curDate) {
  if (priorWt == null || curWt == null || !priorDate || !curDate) return null;
  const days = daysBetweenDates(priorDate, curDate);
  if (days == null) return null;
  const adg = (parseFloat(curWt) - parseFloat(priorWt)) / days;
  return Number.isFinite(adg) ? adg : null;
}

function findAnimalByPriorTag(priorTag, animals) {
  if (!priorTag) return null;
  const pt = String(priorTag).trim();
  const byCurrent = animals.find((c) => c.tag === pt);
  if (byCurrent) return byCurrent;
  const byImport = animals.find(
    (c) => Array.isArray(c.old_tags) && c.old_tags.some((ot) => ot && ot.tag === pt && ot.source === 'import'),
  );
  if (byImport) return byImport;
  const byWeighIn = animals.find(
    (c) => Array.isArray(c.old_tags) && c.old_tags.some((ot) => ot && ot.tag === pt && ot.source === 'weigh_in'),
  );
  return byWeighIn || null;
}

export default function WeighInSessionPage({sb, fmt, authState, Header}) {
  const navigate = useNavigate();
  const location = useLocation();
  const sessionId = location.pathname.replace('/weigh-in-sessions/', '');
  // Originating list order (visible rows) handed through route state. Absent on
  // direct links and notification/deep-link opens, so the controls hide.
  const recordSeq = location.state?.recordSeq || null;
  function navigateSeq(id) {
    navigate('/weigh-in-sessions/' + id, recordSeqNavOptions(recordSeq));
  }

  const [session, setSession] = React.useState(null);
  const [sEntries, setSEntries] = React.useState([]);
  const [animals, setAnimals] = React.useState([]);
  const [allSessions, setAllSessions] = React.useState([]);
  const [allEntries, setAllEntries] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [accessDenied, setAccessDenied] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  const [entryEdits, setEntryEdits] = React.useState({});
  const entryEditsRef = React.useRef(entryEdits);
  const sEntriesRef = React.useRef(sEntries);
  const sessionRef = React.useRef(session);
  const entryAutosaveTimersRef = React.useRef({});
  const entryAutosaveSeqRef = React.useRef({});
  const [entryAutosave, setEntryAutosave] = React.useState({});
  const [addForm, setAddForm] = React.useState({tag: '', weight: '', note: '', priorTag: ''});
  const [sessionForModal, setSessionForModal] = React.useState(null);
  const [pigMetrics, setPigMetrics] = React.useState(null);
  const [pigPriorSession, setPigPriorSession] = React.useState(null);
  const [feederGroups, setFeederGroups] = React.useState([]);
  const [selectedEntryIds, setSelectedEntryIds] = React.useState(new Set());
  const [openPigNoteEntryIds, setOpenPigNoteEntryIds] = React.useState(new Set());
  const [tripModal, setTripModal] = React.useState(null);
  const [transferModal, setTransferModal] = React.useState(null);
  const [transferForm, setTransferForm] = React.useState({tag: '', group: '1', sex: 'Gilt', birthDate: ''});
  const [transferBusy, setTransferBusy] = React.useState(false);
  const [transferNotice, setTransferNotice] = React.useState(null);
  const [broilerBatchRecs, setBroilerBatchRecs] = React.useState([]);
  const [gridLabels, setGridLabels] = React.useState([]);
  const [gridInputs, setGridInputs] = React.useState([]);
  const [gridNote, setGridNote] = React.useState('');
  const [savingGrid, setSavingGrid] = React.useState(false);
  const [gridErr, setGridErr] = React.useState('');
  const [metaWeek, setMetaWeek] = React.useState(4);
  const [metaBusy, setMetaBusy] = React.useState(false);
  const [metaErr, setMetaErr] = React.useState('');

  function invalidateCache() {
    if (session && session.species === 'sheep') invalidateSheepWeighInsCache();
    else invalidateCattleWeighInsCache();
  }

  function canAccessSpecies(species) {
    if (!species) return false;
    if (!authState || authState === false || !authState.profile) return true;
    if (authState.role === 'admin') return true;
    const list = authState.profile.program_access;
    if (!Array.isArray(list) || list.length === 0) return true;
    return list.includes(species);
  }

  React.useEffect(() => {
    entryEditsRef.current = entryEdits;
  }, [entryEdits]);

  React.useEffect(() => {
    sEntriesRef.current = sEntries;
  }, [sEntries]);

  React.useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  React.useEffect(
    () => () => {
      for (const timer of Object.values(entryAutosaveTimersRef.current)) clearTimeout(timer);
      entryAutosaveTimersRef.current = {};
    },
    [],
  );

  async function loadAll() {
    const {data: sess} = await sb
      .from('weigh_in_sessions')
      .select('id, species, herd, batch_id, date, team_member, status, started_at, completed_at, notes, broiler_week')
      .eq('id', sessionId)
      .single();
    if (sess) setSession(sess);
    const sp = sess ? sess.species : null;
    if (sp !== 'cattle' && sp !== 'sheep' && sp !== 'pig' && sp !== 'broiler') {
      setLoading(false);
      return;
    }
    if (!canAccessSpecies(sp)) {
      setAccessDenied(true);
      setLoading(false);
      return;
    }
    const {data: eData} = await sb.from('weigh_ins').select('*').eq('session_id', sessionId);
    const sorted = sp === 'pig' ? sortPigEntriesByWeightDesc(eData || []) : (eData || []).sort(sortEntriesByTagAsc);
    setSEntries(sorted);
    const edits = {};
    for (const e of sorted) edits[e.id] = entryDraft(e);
    setEntryEdits(edits);
    entryEditsRef.current = edits;
    sEntriesRef.current = sorted;
    if (sp === 'cattle' || sp === 'sheep') {
      const animalQuery =
        sp === 'cattle'
          ? sb.from('cattle').select('*').is('deleted_at', null)
          : sb.from('sheep').select('*').is('deleted_at', null);
      const [aR, sR] = await Promise.all([
        animalQuery,
        sb.from('weigh_in_sessions').select('*').eq('species', sp).order('date', {ascending: false}),
      ]);
      if (aR.data) setAnimals(aR.data);
      if (sR.data) setAllSessions(sR.data);
      const allWI = sp === 'cattle' ? await loadCattleWeighInsCached(sb) : await loadSheepWeighInsCached(sb);
      setAllEntries(allWI || []);
    }
    if (sp === 'pig') {
      let metricsData = null;
      try {
        const {data} = await sb.rpc('pig_session_metrics', {session_id_in: sessionId});
        metricsData = data && data.available !== false ? data : null;
        setPigMetrics(metricsData);
      } catch (_e) {
        setPigMetrics(null);
        metricsData = null;
      }
      if (metricsData && metricsData.prior_session_id && metricsData.prior_session_date) {
        try {
          const {data: priorEntries} = await sb
            .from('weigh_ins')
            .select('*')
            .eq('session_id', metricsData.prior_session_id)
            .order('entered_at', {ascending: true});
          setPigPriorSession({
            id: metricsData.prior_session_id,
            date: metricsData.prior_session_date,
            entries: priorEntries || [],
          });
        } catch (_e) {
          setPigPriorSession(null);
        }
      } else {
        setPigPriorSession(null);
      }
      try {
        const {data: fgData} = await sb.from('app_store').select('data').eq('key', 'ppp-feeders-v1').maybeSingle();
        setFeederGroups(fgData && Array.isArray(fgData.data) ? fgData.data : []);
      } catch (_e) {
        setFeederGroups([]);
      }
    }
    if (sp === 'broiler') {
      const batchR = await sb.from('app_store').select('data').eq('key', 'ppp-v4').maybeSingle();
      setBroilerBatchRecs(batchR && batchR.data && Array.isArray(batchR.data.data) ? batchR.data.data : []);
    }
    setLoading(false);
  }

  React.useEffect(() => {
    setSession(null);
    setLoading(true);
    setNotice(null);
    setAccessDenied(false);
    setPigMetrics(null);
    setPigPriorSession(null);
    setOpenPigNoteEntryIds(new Set());
    loadAll();
  }, [sessionId, authState]);

  React.useEffect(() => {
    if (!loading && location.hash) {
      const anchor = location.hash.slice(1);
      setTimeout(() => {
        const el = document.getElementById(anchor);
        if (el) el.scrollIntoView({behavior: 'smooth', block: 'center'});
      }, 200);
    }
  }, [loading, location.hash]);

  function deriveBroilerLabels(s) {
    if (!s || s.species !== 'broiler') return [];
    const rec = broilerBatchRecs.find((b) => (b.name || '') === s.batch_id);
    const raw = rec && rec.schooner ? String(rec.schooner) : '';
    const parts = raw
      .split('&')
      .map((x) => x.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts : ['(no schooner)'];
  }

  function hydrateBroilerGrid(labels, entries) {
    const grid = Array(labels.length * 15).fill('');
    labels.forEach((label, colIdx) => {
      const colE = entries.filter((e) => (e.tag || '') === label);
      colE.slice(0, 15).forEach((e, i) => {
        grid[colIdx * 15 + i] = String(e.weight);
      });
    });
    return grid;
  }

  React.useEffect(() => {
    if (!session || session.species !== 'broiler' || loading) return;
    const labels = deriveBroilerLabels(session);
    setGridLabels(labels);
    setGridInputs(hydrateBroilerGrid(labels, sEntries));
    setGridNote(session.notes || '');
    setGridErr('');
    const w = Number(session.broiler_week);
    setMetaWeek(w === 4 || w === 6 ? w : 4);
    setMetaErr('');
  }, [session, sEntries, broilerBatchRecs, loading]);

  async function saveBroilerGrid() {
    if (!session || session.species !== 'broiler') return;
    const rows = [];
    for (let i = 0; i < gridInputs.length; i++) {
      const w = gridInputs[i];
      if (w === '' || isNaN(parseFloat(w)) || parseFloat(w) <= 0) continue;
      const colIdx = Math.floor(i / 15);
      const tag = gridLabels[colIdx] ? gridLabels[colIdx] : null;
      rows.push({weight: parseFloat(w), tag});
    }
    setSavingGrid(true);
    setGridErr('');
    const del = await sb.from('weigh_ins').delete().eq('session_id', session.id).is('sent_to_trip_id', null);
    if (del.error) {
      setSavingGrid(false);
      setGridErr('Save failed (clear): ' + del.error.message);
      return false;
    }
    let recs = [];
    if (rows.length > 0) {
      const t0 = Date.now();
      recs = rows.map((r, i) => ({
        id: String(t0 + i) + Math.random().toString(36).slice(2, 6),
        session_id: session.id,
        tag: r.tag,
        weight: r.weight,
        note: null,
        new_tag_flag: false,
      }));
      const ins = await sb.from('weigh_ins').insert(recs);
      if (ins.error) {
        setSavingGrid(false);
        setGridErr('Save failed (insert): ' + ins.error.message);
        return false;
      }
    }
    if (gridNote !== (session.notes || '')) {
      await sb
        .from('weigh_in_sessions')
        .update({notes: gridNote || null})
        .eq('id', session.id);
    }
    const avgStamp = await writeBroilerBatchAvg(sb, session, recs);
    if (!avgStamp.ok) {
      setSavingGrid(false);
      setGridErr('Save partly failed (batch avg): ' + avgStamp.message);
      return false;
    }
    try {
      await recordActivityEvent(sb, {
        entityType: 'weighin.session',
        entityId: session.id,
        eventType: 'field.updated',
        entityLabel: sessionLabel(),
        body: 'Saved broiler grid (' + recs.length + ' entries)',
      });
    } catch (_e) {
      /* best-effort */
    }
    setSavingGrid(false);
    await loadAll();
    return true;
  }

  async function saveBroilerMetadata() {
    if (!session || session.species !== 'broiler') return;
    const oldWeek = Number(session.broiler_week);
    const newWeek = Number(metaWeek);
    if (newWeek !== 4 && newWeek !== 6) {
      setMetaErr('Week must be 4 or 6.');
      return;
    }
    const weekChanged = oldWeek !== newWeek;
    if (!weekChanged) return;

    setMetaBusy(true);
    setMetaErr('');
    const upd = {};
    if (weekChanged) upd.broiler_week = newWeek;
    const r = await sb.from('weigh_in_sessions').update(upd).eq('id', session.id);
    if (r && r.error) {
      setMetaBusy(false);
      setMetaErr('Save failed: ' + r.error.message);
      return;
    }

    if (session.status === 'complete' && weekChanged) {
      const r1 = await recomputeBroilerBatchWeekAvg(sb, session.batch_id, oldWeek, {excludeSessionId: session.id});
      if (!r1.ok) {
        setMetaBusy(false);
        setMetaErr('Save partly failed (old week): ' + r1.message);
        return;
      }
      const eR = await sb.from('weigh_ins').select('weight').eq('session_id', session.id);
      if (eR && eR.error) {
        setMetaBusy(false);
        setMetaErr('Save partly failed (entries read): ' + eR.error.message);
        return;
      }
      const r2 = await writeBroilerBatchAvg(sb, {...session, broiler_week: newWeek}, (eR && eR.data) || []);
      if (!r2.ok) {
        setMetaBusy(false);
        setMetaErr('Save partly failed (new week): ' + r2.message);
        return;
      }
    }
    try {
      const parts = [];
      if (weekChanged) parts.push('week ' + oldWeek + ' → ' + newWeek);
      await recordActivityEvent(sb, {
        entityType: 'weighin.session',
        entityId: session.id,
        eventType: 'field.updated',
        entityLabel: sessionLabel(),
        body: 'Updated metadata: ' + parts.join(', '),
      });
    } catch (_e) {
      /* best-effort */
    }
    setMetaBusy(false);
    await loadAll();
  }

  function computePriors() {
    const byTag = {};
    if (!session) return byTag;
    const earlier = allSessions.filter((o) => {
      if (o.id === session.id) return false;
      if (o.status !== 'complete') return false;
      if (o.herd !== session.herd) return false;
      if ((o.date || '') < (session.date || '')) return true;
      if ((o.date || '') === (session.date || '')) return (o.started_at || '') < (session.started_at || '');
      return false;
    });
    const entriesBySession = {};
    for (const e of allEntries) {
      if (!entriesBySession[e.session_id]) entriesBySession[e.session_id] = [];
      entriesBySession[e.session_id].push(e);
    }
    for (const o of earlier) {
      const es = entriesBySession[o.id] || [];
      for (const e of es) {
        if (!e.tag) continue;
        const existing = byTag[e.tag];
        const sd = o.date;
        if (!existing || sd > existing.date) byTag[e.tag] = {weight: parseFloat(e.weight) || 0, date: sd};
      }
    }
    return byTag;
  }

  function sessionLabel() {
    if (isPig || isBroiler) return (session.date || '') + ' · ' + (session.batch_id || session.species);
    const groupLabels = session.species === 'sheep' ? FLOCK_LABELS : HERD_LABELS;
    return (session.date || '') + ' · ' + (groupLabels[session.herd] || session.herd || session.species);
  }

  async function reopenSession() {
    const wasBroilerComplete = isBroiler && session.status === 'complete';
    const oldWeek = Number(session.broiler_week);
    await runMutation(
      () => sb.from('weigh_in_sessions').update({status: 'draft', completed_at: null}).eq('id', session.id),
      {
        activity: () =>
          recordStatusChange(sb, {
            entityType: 'weighin.session',
            entityId: session.id,
            entityLabel: sessionLabel(),
            from: 'complete',
            to: 'draft',
          }),
      },
    );
    if (wasBroilerComplete && (oldWeek === 4 || oldWeek === 6)) {
      const r2 = await recomputeBroilerBatchWeekAvg(sb, session.batch_id, oldWeek, {excludeSessionId: session.id});
      if (!r2.ok) {
        setNotice({kind: 'error', message: 'Session reopened, but ppp-v4 cleanup failed: ' + r2.message});
        await loadAll();
        return;
      }
    }
    invalidateCache();
    await loadAll();
  }

  async function deleteSession() {
    if (!window._wcfConfirmDelete) return;
    const deleteMsg =
      isPig || isBroiler
        ? 'Delete this weigh-in session and all its entries? This cannot be undone.'
        : 'Delete this weigh-in session and all its entries? Attached animals will be detached and reverted to prior herds where possible.';
    window._wcfConfirmDelete(deleteMsg, async () => {
      const blocked = [];
      if (!isPig && !isBroiler) {
        const batchEntries = sEntries.filter((e) => e.target_processing_batch_id);
        for (const e of batchEntries) {
          const cow = e.tag ? animals.find((c) => c.tag === e.tag) : null;
          if (!cow) {
            blocked.push({tag: e.tag || '?', reason: 'no_cow_for_tag'});
            continue;
          }
          const detachArgs = {
            batchId: e.target_processing_batch_id,
            teamMember: authState && authState.name ? authState.name : null,
          };
          const r =
            session.species === 'sheep'
              ? await detachSheepFromProcessingBatch(sb, {...detachArgs, sheepId: cow.id})
              : await detachCattleFromProcessingBatch(sb, {...detachArgs, cattleId: cow.id});
          if (!r.ok && r.reason !== 'not_in_batch') blocked.push({tag: e.tag || '?', reason: r.reason});
        }
      }
      async function finishDelete() {
        if (isBroiler && session.status === 'complete') {
          const oldWeek = Number(session.broiler_week);
          if (oldWeek === 4 || oldWeek === 6) {
            const r2 = await recomputeBroilerBatchWeekAvg(sb, session.batch_id, oldWeek, {
              excludeSessionId: session.id,
            });
            if (!r2.ok) {
              setNotice({kind: 'error', message: 'Cannot delete: ppp-v4 cleanup failed: ' + r2.message});
              return;
            }
          }
        }
        // Audit-grade transactional delete (migration 101): the session row,
        // its cascaded weigh_ins, the cattle/sheep weigh-in comments, and the
        // record.deleted Activity event all commit in one transaction. The
        // Atomic detach RPCs run first; the "delete anyway?" decision remains
        // user-gated here when an animal cannot be safely restored.
        const r = await deleteWeighInSession(sb, {
          sessionId: session.id,
          entityLabel: sessionLabel(),
          teamMember: authState && authState.name ? authState.name : null,
        });
        if (!r.ok) {
          setNotice({kind: 'error', message: 'Could not delete session: ' + (r.error || r.reason || 'unknown error')});
          return;
        }
        invalidateCache();
        navigate(backInfo.path);
      }
      if (blocked.length > 0) {
        const lines = blocked.map((x) => '#' + x.tag + ' (' + x.reason + ')').join(', ');
        window._wcfConfirmDelete('Some cows could not be auto-reverted: ' + lines + '. Delete anyway?', finishDelete);
        return;
      }
      await finishDelete();
    });
  }

  async function completeSession() {
    if (isBroiler) {
      const gridOk = await saveBroilerGrid();
      if (!gridOk) return;
      const eR = await sb.from('weigh_ins').select('*').eq('session_id', session.id);
      const freshEntries = (eR && eR.data) || [];
      await runMutation(
        () =>
          sb
            .from('weigh_in_sessions')
            .update({status: 'complete', completed_at: new Date().toISOString()})
            .eq('id', session.id),
        {
          activity: () =>
            recordStatusChange(sb, {
              entityType: 'weighin.session',
              entityId: session.id,
              entityLabel: sessionLabel(),
              from: 'draft',
              to: 'complete',
            }),
        },
      );
      const avgStamp = await writeBroilerBatchAvg(sb, {...session, status: 'complete'}, freshEntries);
      if (!avgStamp.ok) {
        setNotice({kind: 'error', message: 'Session completed, but batch avg stamp failed: ' + avgStamp.message});
        await loadAll();
        return;
      }
      await loadAll();
      return;
    }
    const autosaveOk = await flushAllEntryAutosaves();
    if (!autosaveOk) {
      setNotice({kind: 'error', message: 'Fix weigh-in entry save errors before completing this session.'});
      return;
    }
    // Block completion while any entry still carries new_tag_flag — these are
    // unresolved missing/replacement tags that must be reconciled to a known
    // cow first. Mirrors WeighInsWebform's pendingReconciles completion gate.
    const unresolved = (sEntriesRef.current || []).filter((e) => e.new_tag_flag === true);
    if (unresolved.length > 0) {
      setNotice({
        kind: 'error',
        message:
          'Resolve ' +
          unresolved.length +
          ' missing/new ' +
          (unresolved.length === 1 ? 'tag' : 'tags') +
          ' before completing this session.',
      });
      return;
    }
    const canSendToProcessor = session.species === 'sheep' || session.herd === 'finishers';
    if (canSendToProcessor) {
      const flagged = sEntries.filter((e) => e.send_to_processor === true);
      if (flagged.length > 0) {
        setSessionForModal(session);
        return;
      }
    }
    await finalizeComplete();
  }

  async function finalizeComplete() {
    await runMutation(
      () =>
        sb
          .from('weigh_in_sessions')
          .update({status: 'complete', completed_at: new Date().toISOString()})
          .eq('id', session.id),
      {
        activity: () =>
          recordStatusChange(sb, {
            entityType: 'weighin.session',
            entityId: session.id,
            entityLabel: sessionLabel(),
            from: 'draft',
            to: 'complete',
          }),
      },
    );
    invalidateCache();
    await loadAll();
  }

  async function toggleProcessor(e, next) {
    setNotice(null);
    let detached = false;
    if (!next && e.target_processing_batch_id) {
      const cow = e.tag ? animals.find((c) => c.tag === e.tag) : null;
      if (cow) {
        const detachArgs = {
          batchId: e.target_processing_batch_id,
          teamMember: authState && authState.name ? authState.name : null,
        };
        const r =
          session.species === 'sheep'
            ? await detachSheepFromProcessingBatch(sb, {...detachArgs, sheepId: cow.id})
            : await detachCattleFromProcessingBatch(sb, {...detachArgs, cattleId: cow.id});
        if (!r.ok && r.reason !== 'not_in_batch') {
          setNotice({
            kind: 'error',
            message:
              'Cannot clear flag for #' +
              (e.tag || '?') +
              ': ' +
              (r.reason === 'no_prior_herd'
                ? 'no prior herd recorded.'
                : r.reason === 'no_prior_flock'
                  ? 'no prior flock recorded.'
                  : r.reason),
          });
          return;
        }
        detached = r.ok && r.reason === 'detached';
      }
    }
    const activity = () =>
      recordActivityEvent(sb, {
        entityType: 'weighin.session',
        entityId: session.id,
        eventType: 'field.updated',
        entityLabel: sessionLabel(),
        body: (next ? 'Flagged' : 'Unflagged') + ' #' + (e.tag || '?') + ' for processor',
      });
    let result;
    if (detached) {
      // The detach RPC already cleared both weigh-in fields atomically. Do not
      // issue a redundant PATCH that could fail after the detach committed and
      // misreport the completed operation as a UI error. Preserve the separate
      // weighin.session summary event with the same best-effort semantics.
      try {
        await activity();
      } catch (_e) {
        /* best-effort audit trail */
      }
      result = {ok: true};
    } else {
      result = await runMutation(() => sb.from('weigh_ins').update({send_to_processor: !!next}).eq('id', e.id), {
        activity,
      });
    }
    if (!result.ok) {
      setNotice({kind: 'error', message: 'Could not update: ' + (result.error || 'unknown error')});
      return;
    }
    invalidateCache();
    setSEntries((prev) => prev.map((x) => (x.id === e.id ? {...x, send_to_processor: !!next} : x)));
    if (!next && e.target_processing_batch_id) await loadAll();
  }

  function setEntryField(entry, field, value) {
    if (!entry) return;
    const current = entryEditsRef.current[entry.id] || entryDraft(entry);
    const draft = {...current, [field]: value};
    setEntryEdits((prev) => {
      const next = {...prev, [entry.id]: draft};
      entryEditsRef.current = next;
      return next;
    });
    scheduleEntryAutosave(entry.id, draft);
  }

  function setPigEntryField(entry, field, value) {
    setEntryField(entry, field, value);
  }

  function setEntryAutosaveState(entryId, state) {
    setEntryAutosave((prev) => {
      const next = {...prev};
      if (state) next[entryId] = state;
      else delete next[entryId];
      return next;
    });
  }

  function clearEntryAutosaveTimer(entryId) {
    const timer = entryAutosaveTimersRef.current[entryId];
    if (timer) clearTimeout(timer);
    delete entryAutosaveTimersRef.current[entryId];
  }

  function buildEntryDraftSave(entry, draft) {
    const sess = sessionRef.current;
    if (!sess || !entry || !draft || sess.species === 'broiler') return {error: 'Cannot save entry'};
    const newWeight = parseFloat(draft.weight);
    if (!Number.isFinite(newWeight) || newWeight <= 0) return {error: 'Enter weight > 0'};
    const note = (draft.note || '').trim() ? draft.note : null;
    if (sess.species === 'pig') {
      return {updates: {weight: newWeight, note}, labels: {weight: 'Weight', note: 'Note'}};
    }
    const newTag = (draft.tag || '').trim() || null;
    const animalWithTag = newTag ? animals.find((c) => String(c.tag || '') === String(newTag)) : null;
    const newTagFlag = !!(newTag && !animalWithTag);
    return {
      updates: {tag: newTag, weight: newWeight, note, new_tag_flag: newTagFlag},
      labels: {tag: 'Tag', weight: 'Weight', note: 'Note', new_tag_flag: 'New tag'},
    };
  }

  function entryDraftChanged(entry, draft) {
    if (!entry || !draft) return false;
    const save = buildEntryDraftSave(entry, draft);
    if (save.error) return true;
    const updates = save.updates || {};
    if ('weight' in updates && parseFloat(entry.weight) !== updates.weight) return true;
    if ('note' in updates && (entry.note || null) !== (updates.note || null)) return true;
    if ('tag' in updates && (entry.tag || null) !== (updates.tag || null)) return true;
    if ('new_tag_flag' in updates && !!entry.new_tag_flag !== !!updates.new_tag_flag) return true;
    return false;
  }

  function scheduleEntryAutosave(entryId, draft) {
    clearEntryAutosaveTimer(entryId);
    const entry = sEntriesRef.current.find((x) => x.id === entryId);
    if (!entry || isEntryLocked(entry)) return;
    const save = buildEntryDraftSave(entry, draft);
    if (save.error) {
      setEntryAutosaveState(entryId, {status: 'error', message: save.error});
      return;
    }
    if (!entryDraftChanged(entry, draft)) {
      setEntryAutosaveState(entryId, null);
      return;
    }
    const seq = (entryAutosaveSeqRef.current[entryId] || 0) + 1;
    entryAutosaveSeqRef.current[entryId] = seq;
    setEntryAutosaveState(entryId, {status: 'pending', message: 'Autosaving...'});
    entryAutosaveTimersRef.current[entryId] = setTimeout(() => {
      delete entryAutosaveTimersRef.current[entryId];
      void saveEntryDraft(entryId, seq);
    }, WEIGHIN_ENTRY_AUTOSAVE_DELAY_MS);
  }

  async function flushEntryAutosaveNow(entryId) {
    clearEntryAutosaveTimer(entryId);
    return saveEntryDraft(entryId, entryAutosaveSeqRef.current[entryId] || 0);
  }

  function flushEntryAutosave(entryId) {
    void flushEntryAutosaveNow(entryId);
  }

  function flushPigEntryAutosave(entryId) {
    flushEntryAutosave(entryId);
  }

  async function flushAllEntryAutosaves() {
    const results = await Promise.all((sEntriesRef.current || []).map((e) => flushEntryAutosaveNow(e.id)));
    return results.every((ok) => ok !== false);
  }

  async function refreshPigMetrics() {
    const sess = sessionRef.current;
    if (!sess || sess.species !== 'pig') return;
    try {
      const {data} = await sb.rpc('pig_session_metrics', {session_id_in: sess.id});
      setPigMetrics(data && data.available !== false ? data : null);
    } catch (_e) {
      setPigMetrics(null);
    }
  }

  function updateWeighInEntry(entryId, updates) {
    return sb.from('weigh_ins').update(updates).eq('id', entryId);
  }

  async function saveEntryUpdates(entry, updates, labels) {
    return runMutation(() => updateWeighInEntry(entry.id, updates), {
      activity: () => {
        const changes = buildChanges(entry, updates, {
          exclude: WEIGHIN_ENTRY_ACTIVITY_EXCLUDE,
          labels,
        });
        if (changes.length === 0) return;
        return recordFieldChange(sb, {
          entityType: 'weighin.session',
          entityId: sessionRef.current ? sessionRef.current.id : session.id,
          entityLabel: sessionLabel(),
          changes,
        });
      },
    });
  }

  async function saveEntryDraft(entryId, seq = entryAutosaveSeqRef.current[entryId]) {
    const sess = sessionRef.current;
    const entry = sEntriesRef.current.find((x) => x.id === entryId);
    const draft = entryEditsRef.current[entryId] || (entry ? entryDraft(entry) : null);
    if (!sess || sess.species === 'broiler' || !entry || !draft || isEntryLocked(entry)) return true;
    const save = buildEntryDraftSave(entry, draft);
    if (save.error) {
      setEntryAutosaveState(entryId, {status: 'error', message: save.error});
      return false;
    }
    if (!entryDraftChanged(entry, draft)) {
      setEntryAutosaveState(entryId, null);
      return true;
    }
    const {updates, labels} = save;
    setEntryAutosaveState(entryId, {status: 'saving', message: 'Saving...'});
    const result = await saveEntryUpdates(entry, updates, labels);
    if (!result.ok) {
      setEntryAutosaveState(entryId, {status: 'error', message: 'Save failed'});
      return false;
    }
    if (entryAutosaveSeqRef.current[entryId] != null && entryAutosaveSeqRef.current[entryId] !== seq) return true;
    const updated = {...entry, ...updates};
    setSEntries((prev) => {
      const mapped = prev.map((x) => (x.id === entryId ? updated : x));
      const next = sess.species === 'pig' ? sortPigEntriesByWeightDesc(mapped) : mapped.sort(sortEntriesByTagAsc);
      sEntriesRef.current = next;
      return next;
    });
    setEntryEdits((prev) => {
      const next = {...prev, [entryId]: entryDraft(updated)};
      entryEditsRef.current = next;
      return next;
    });
    setEntryAutosaveState(entryId, {status: 'saved', message: 'Saved'});
    if (sess.species === 'pig') void refreshPigMetrics();
    else invalidateCache();
    return true;
  }

  function isEntryLocked(e) {
    if (e.sent_to_trip_id) return true;
    if (e.transferred_to_breeding) return true;
    if (/\[transferred_to_breeding/.test(e.note || '')) return true;
    return false;
  }

  async function deleteEntry(e) {
    if (isEntryLocked(e)) return;
    window._wcfConfirmDelete('Delete this weigh-in entry?', async () => {
      async function finish() {
        // Audit-grade transactional delete (migration 101): the weigh_ins row
        // and its record.deleted Activity event commit in one transaction. The
        // Atomic detach runs before this delete; the "delete anyway?" choice
        // remains user-gated when the RPC cannot safely restore the animal.
        const r = await deleteWeighInEntry(sb, {
          entryId: e.id,
          entityLabel: sessionLabel(),
          teamMember: authState && authState.name ? authState.name : null,
        });
        if (!r.ok) {
          setNotice({kind: 'error', message: 'Could not delete entry: ' + (r.error || r.reason || 'unknown error')});
          return;
        }
        invalidateCache();
        await loadAll();
      }
      if (e.target_processing_batch_id) {
        const cow = e.tag ? animals.find((c) => c.tag === e.tag) : null;
        if (cow) {
          const detachArgs = {
            batchId: e.target_processing_batch_id,
            teamMember: authState && authState.name ? authState.name : null,
          };
          const r =
            session.species === 'sheep'
              ? await detachSheepFromProcessingBatch(sb, {...detachArgs, sheepId: cow.id})
              : await detachCattleFromProcessingBatch(sb, {...detachArgs, cattleId: cow.id});
          if (!r.ok && r.reason !== 'not_in_batch') {
            window._wcfConfirmDelete(
              '#' + (e.tag || '?') + ' could not be auto-reverted (' + r.reason + '). Delete anyway?',
              finish,
            );
            return;
          }
        }
      }
      await finish();
    });
  }

  async function reconcileNewTag(entry, knownCowId) {
    if (!knownCowId) return;
    const cow = animals.find((c) => c.id === knownCowId);
    if (!cow) return;
    const priorTag = cow.tag;
    const newTag = entry.tag;
    const updatedOldTags = (Array.isArray(cow.old_tags) ? cow.old_tags : []).concat([
      {tag: priorTag, changed_at: new Date().toISOString(), source: 'weigh_in'},
    ]);
    const animalTable = session.species === 'sheep' ? 'sheep' : 'cattle';
    await sb.from(animalTable).update({tag: newTag, old_tags: updatedOldTags}).eq('id', knownCowId);
    // Best-effort: also log the tag change on the ANIMAL's own feed (the existing
    // weighin.session event below only scopes the identity change to the session).
    try {
      const animalChanges = buildChanges({tag: priorTag}, {tag: newTag}, {labels: {tag: 'Tag'}});
      if (animalChanges.length) {
        await recordFieldChange(sb, {
          entityType: session.species === 'sheep' ? 'sheep.animal' : 'cattle.animal',
          entityId: knownCowId,
          entityLabel: newTag || priorTag || knownCowId,
          changes: animalChanges,
        });
      }
    } catch (_e) {
      /* best-effort audit trail */
    }
    await sb.from('weigh_ins').update({new_tag_flag: false}).eq('id', entry.id);
    const commentsTable2 = session.species === 'sheep' ? 'sheep_comments' : 'cattle_comments';
    const idCol = session.species === 'sheep' ? 'sheep_id' : 'cattle_id';
    const tagCol = session.species === 'sheep' ? 'sheep_tag' : 'cattle_tag';
    try {
      await sb
        .from(commentsTable2)
        .update({[idCol]: knownCowId, [tagCol]: newTag})
        .eq('reference_id', entry.id);
    } catch (_e) {
      /* soft-fail */
    }
    try {
      await recordActivityEvent(sb, {
        entityType: 'weighin.session',
        entityId: session.id,
        eventType: 'field.updated',
        entityLabel: sessionLabel(),
        body: 'Reconciled new tag #' + newTag + ' → cow #' + priorTag,
      });
    } catch (_e) {
      /* best-effort */
    }
    invalidateCache();
    await loadAll();
  }

  async function addEntry() {
    setNotice(null);
    const tag = (addForm.tag || '').trim() || null;
    const weight = parseFloat(addForm.weight);
    if (!Number.isFinite(weight) || weight <= 0) return;
    const priorTag = (addForm.priorTag || '').trim();
    if (priorTag) {
      if (!tag) {
        setNotice({kind: 'error', message: 'Enter a New tag # for the swap.'});
        return;
      }
      if (priorTag === tag) {
        setNotice({kind: 'error', message: 'Prior tag and new tag cannot be the same.'});
        return;
      }
      const cow = findAnimalByPriorTag(priorTag, animals);
      if (!cow) {
        setNotice({kind: 'error', message: 'No cow found with prior tag #' + priorTag + '.'});
        return;
      }
      const existingAtNewTag = animals.find((c) => c.tag === tag);
      if (existingAtNewTag && existingAtNewTag.id !== cow.id) {
        setNotice({kind: 'error', message: 'Tag #' + tag + ' is already assigned to another cow.'});
        return;
      }
      const existingOldTags = Array.isArray(cow.old_tags) ? cow.old_tags : [];
      const priorTagIndex = existingOldTags.findIndex((oldTag) => String(oldTag && oldTag.tag) === priorTag);
      let updatedOldTags = existingOldTags;
      if (priorTagIndex >= 0) {
        const currentOldTag = existingOldTags[priorTagIndex] || {};
        if (currentOldTag.source !== 'weigh_in') {
          updatedOldTags = existingOldTags.map((oldTag, index) =>
            index === priorTagIndex ? {...oldTag, tag: priorTag, source: 'weigh_in'} : oldTag,
          );
        }
      } else {
        updatedOldTags = existingOldTags.concat([
          {tag: priorTag, changed_at: new Date().toISOString(), source: 'weigh_in'},
        ]);
      }
      const swapTable = session.species === 'sheep' ? 'sheep' : 'cattle';
      const cowNeedsUpdate = cow.tag !== tag || updatedOldTags !== existingOldTags;
      if (cowNeedsUpdate) {
        const cowUpd = await sb.from(swapTable).update({tag, old_tags: updatedOldTags}).eq('id', cow.id);
        if (cowUpd.error) {
          setNotice({kind: 'error', message: 'Tag swap failed: ' + cowUpd.error.message});
          return;
        }
        // Best-effort: log the tag change on the animal's own feed.
        try {
          const swapChanges = buildChanges({tag: priorTag}, {tag}, {labels: {tag: 'Tag'}});
          if (swapChanges.length) {
            await recordFieldChange(sb, {
              entityType: session.species === 'sheep' ? 'sheep.animal' : 'cattle.animal',
              entityId: cow.id,
              entityLabel: tag || priorTag || cow.id,
              changes: swapChanges,
            });
          }
        } catch (_e) {
          /* best-effort audit trail */
        }
      }
      const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
      const {error: insErr} = await sb.from('weigh_ins').insert({
        id,
        session_id: session.id,
        tag,
        weight,
        note: addForm.note || null,
        new_tag_flag: false,
        reconcile_intent: null,
        entered_at: new Date().toISOString(),
      });
      if (insErr) {
        setNotice({kind: 'error', message: 'Add entry failed: ' + insErr.message});
        return;
      }
      try {
        await recordActivityEvent(sb, {
          entityType: 'weighin.session',
          entityId: session.id,
          eventType: 'record.created',
          entityLabel: sessionLabel(),
          body: 'Added entry #' + tag + ' (' + weight + ' lb) — retag from #' + priorTag,
        });
      } catch (_e) {
        /* best-effort */
      }
      invalidateCache();
      setAddForm({tag: '', weight: '', note: '', priorTag: ''});
      await loadAll();
      return;
    }
    const cowWithTag = tag ? animals.find((c) => c.tag === tag) : null;
    const newTagFlag = tag && !cowWithTag;
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    const {error: insErr2} = await sb.from('weigh_ins').insert({
      id,
      session_id: session.id,
      tag,
      weight,
      note: addForm.note || null,
      new_tag_flag: !!newTagFlag,
      entered_at: new Date().toISOString(),
    });
    if (insErr2) {
      setNotice({kind: 'error', message: 'Add entry failed: ' + insErr2.message});
      return;
    }
    try {
      await recordActivityEvent(sb, {
        entityType: 'weighin.session',
        entityId: session.id,
        eventType: 'record.created',
        entityLabel: sessionLabel(),
        body: 'Added entry' + (tag ? ' #' + tag : '') + ' (' + weight + ' lb)',
      });
    } catch (_e) {
      /* best-effort */
    }
    invalidateCache();
    setAddForm({tag: '', weight: '', note: '', priorTag: ''});
    await loadAll();
  }

  // ── Pig send-to-trip ──────────────────────────────────────────────────
  const canManagePigPlannedTrips = !!(authState && (authState.role === 'admin' || authState.role === 'management'));

  function pigBatchLookupKeys(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return [];
    const lower = trimmed.toLowerCase();
    const slug = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return lower === slug ? [lower] : [lower, slug];
  }

  function pigBatchNameMatches(a, b) {
    const bKeys = new Set(pigBatchLookupKeys(b));
    return pigBatchLookupKeys(a).some((key) => bKeys.has(key));
  }

  function resolveBatchAndSub(batchId) {
    if (!batchId) return {parent: null, sub: null};
    for (const g of feederGroups) {
      if (pigBatchNameMatches(g.batchName, batchId)) return {parent: g, sub: null};
      const sub = (g.subBatches || []).find((s) => pigBatchNameMatches(s.name, batchId));
      if (sub) return {parent: g, sub};
    }
    return {parent: null, sub: null};
  }

  function batchFCR(parent) {
    if (!parent) return 3.5;
    if (parent.fcrCached && parent.fcrCached > 0) return parent.fcrCached;
    return 3.5;
  }

  function openTripModal() {
    const selected = sEntries.filter((e) => selectedEntryIds.has(e.id));
    if (selected.length === 0) return;
    setTripModal({session, entries: selected});
  }

  async function sendEntriesToTrip({groupId, sourceSubId, sourceSubSex}) {
    if (!tripModal || !canManagePigPlannedTrips) {
      throw new Error('Permission denied or no active modal.');
    }
    const {entries: selEntries} = tripModal;
    if (!groupId || !sourceSubId || !sourceSubSex || !selEntries || selEntries.length === 0) {
      throw new Error('Missing required send parameters.');
    }
    // ONE transactional SECDEF RPC (mig 176) replaces the former client
    // reconcile + trip mint + weigh_ins stamping + app_store upsert. The modal
    // still PREVIEWS with reconcilePlannedTripsForSend (read-only); the SERVER
    // is authoritative and re-runs the reconcile under a row lock. One
    // locked-spec difference from the preview helper: the target planned
    // trip's id is PROMOTED into processingTrips (its Processing record keeps
    // its identity), so an under-send remainder always moves forward — onto
    // the next planned trip, or a NEW planned trip when no next trip exists
    // (the preview's remainderStayedOnTarget case).
    const result = await pigSendToTrip(sb, {
      groupId,
      subBatchId: sourceSubId,
      sex: sourceSubSex,
      weighInIds: selEntries.map((e) => e.id),
    });
    try {
      await recordActivityEvent(sb, {
        entityType: 'weighin.session',
        entityId: session.id,
        eventType: 'field.updated',
        entityLabel: sessionLabel(),
        body: 'Sent ' + selEntries.length + ' entries to trip ' + result.trip_date,
      });
    } catch (_e) {
      /* best-effort */
    }
    setSelectedEntryIds(new Set());
    setTripModal(null);
    // loadAll re-reads the weigh-in entries AND ppp-feeders-v1 (pig branch),
    // so local state syncs with the server-owned row.
    await loadAll();
  }

  async function undoSendToTrip(entry) {
    if (!entry || !entry.sent_to_trip_id || !entry.sent_to_group_id) return;
    if (!canManagePigPlannedTrips) return;
    // ONE transactional SECDEF RPC (mig 176) replaces the former client trip
    // surgery + app_store upsert + stamp clear: the server decrements the
    // actual trip (count / weight instance / sub-attributions), returns the
    // pig to the planned chain, and clears the entry's stamps in one
    // transaction.
    // When the LAST entry is undone the actual trip reverts to a PLANNED trip
    // with the SAME id, so its Processing record flips back to Planned.
    try {
      await pigUndoSend(sb, entry.id);
    } catch (e) {
      setNotice({kind: 'error', message: 'Undo send failed: ' + (e.message || 'unknown error')});
      return;
    }
    try {
      await recordActivityEvent(sb, {
        entityType: 'weighin.session',
        entityId: session.id,
        eventType: 'field.updated',
        entityLabel: sessionLabel(),
        body: 'Undid send for entry (' + (entry.weight || '?') + ' lb)',
      });
    } catch (_e) {
      /* best-effort */
    }
    await loadAll();
  }

  // ── Pig transfer-to-breeding ────────────────────────────────────────────
  function openTransferModal(entry) {
    setTransferNotice(null);
    setTransferModal({session, entry});
    let bd = '';
    try {
      const sd = new Date((session.date || '') + 'T12:00:00');
      sd.setMonth(sd.getMonth() - 6);
      bd = sd.toISOString().slice(0, 10);
    } catch (_e) {
      /* defensive */
    }
    setTransferForm({tag: '', group: '1', sex: 'Gilt', birthDate: bd});
  }

  async function transferToBreeding() {
    if (!transferModal) return;
    const {session: sess, entry} = transferModal;
    const tag = (transferForm.tag || '').trim();
    setTransferNotice(null);
    if (!tag) {
      setTransferNotice({kind: 'error', message: 'Tag # is required.'});
      return;
    }
    if (!transferForm.group) {
      setTransferNotice({kind: 'error', message: 'Pick a group.'});
      return;
    }
    setTransferBusy(true);
    try {
      const {parent, sub} = resolveBatchAndSub(sess.batch_id);
      if (!parent) {
        setTransferNotice({kind: 'error', message: 'Could not match this session to a feeder batch.'});
        setTransferBusy(false);
        return;
      }
      const fcr = batchFCR(parent);
      const weight = parseFloat(entry.weight) || 0;
      const feedAllocLbs = Math.round(weight * fcr * 10) / 10;
      const breederId = String(Date.now()) + Math.random().toString(36).slice(2, 6);
      const breederRec = {
        id: breederId,
        tag,
        sex: transferForm.sex || 'Gilt',
        group: transferForm.group,
        status: transferForm.sex === 'Boar' ? 'Boar Group' : 'Sow Group',
        breed: '',
        origin: parent.batchName || '',
        birthDate: transferForm.birthDate || '',
        lastWeight: weight,
        purchaseDate: '',
        purchaseAmount: '',
        notes: '',
        archived: false,
        weighins: [{weight, date: sess.date || new Date().toISOString().slice(0, 10)}],
        transferredFromBatch: {
          batchName: parent.batchName,
          subBatchName: sub ? sub.name : null,
          transferDate: new Date().toISOString().slice(0, 10),
          feedAllocationLbs: feedAllocLbs,
          fcrUsed: fcr,
          sourceWeighInId: entry.id,
        },
      };
      const brR = await sb.from('app_store').select('data').eq('key', 'ppp-breeders-v1').maybeSingle();
      if (brR.error) {
        setTransferNotice({kind: 'error', message: 'Could not read breeders registry: ' + brR.error.message});
        setTransferBusy(false);
        return;
      }
      const currentBreeders = brR.data && Array.isArray(brR.data.data) ? brR.data.data : [];
      if (currentBreeders.some((b) => b.transferredFromBatch && b.transferredFromBatch.sourceWeighInId === entry.id)) {
        setTransferNotice({kind: 'warning', message: 'This entry has already been transferred.'});
        setTransferModal(null);
        setTransferBusy(false);
        await loadAll();
        return;
      }
      const {error: brUpsertErr} = await sb
        .from('app_store')
        .upsert({key: 'ppp-breeders-v1', data: [...currentBreeders, breederRec]}, {onConflict: 'key'});
      if (brUpsertErr) {
        setTransferNotice({kind: 'error', message: 'Could not save new breeder: ' + brUpsertErr.message});
        setTransferBusy(false);
        return;
      }
      const updatedFG = feederGroups.map((g) =>
        g.id !== parent.id
          ? g
          : {...g, feedAllocatedToTransfers: (parseFloat(g.feedAllocatedToTransfers) || 0) + feedAllocLbs},
      );
      setFeederGroups(updatedFG);
      const {error: fgUpsertErr} = await sb
        .from('app_store')
        .upsert({key: 'ppp-feeders-v1', data: updatedFG}, {onConflict: 'key'});
      if (fgUpsertErr) {
        setTransferNotice({kind: 'error', message: 'Could not update feeder batch: ' + fgUpsertErr.message});
        setTransferBusy(false);
        return;
      }
      const wi = await sb
        .from('weigh_ins')
        .update({transferred_to_breeding: true, transfer_breeder_id: breederId, feed_allocation_lbs: feedAllocLbs})
        .eq('id', entry.id);
      let stampOk = !wi.error;
      if (wi.error) {
        const noteFallback =
          '[transferred_to_breeding breeder=' +
          breederId +
          ' feed_alloc=' +
          feedAllocLbs +
          ' lb] ' +
          (entry.note || '');
        const {error: noteErr} = await sb.from('weigh_ins').update({note: noteFallback}).eq('id', entry.id);
        stampOk = !noteErr;
      }
      if (!stampOk) {
        setTransferNotice({
          kind: 'warning',
          message:
            'Transfer created breeder #' +
            tag +
            ' and updated counts, but the weigh-in entry could not be stamped. The entry may appear unstamped until the page reloads.',
        });
        setTransferBusy(false);
        return;
      }
      try {
        await recordActivityEvent(sb, {
          entityType: 'weighin.session',
          entityId: session.id,
          eventType: 'field.updated',
          entityLabel: sessionLabel(),
          body: 'Transferred entry (' + weight + ' lb) to breeding as #' + tag,
        });
      } catch (_e) {
        /* best-effort */
      }
      setTransferModal(null);
      setTransferBusy(false);
      await loadAll();
    } catch (e) {
      setTransferNotice({kind: 'error', message: 'Transfer failed: ' + (e.message || 'unknown error')});
      setTransferBusy(false);
    }
  }

  async function undoTransferToBreeding(entry) {
    if (!entry) return;
    setTransferNotice(null);
    const noteMarker = (entry.note || '').match(/\[transferred_to_breeding\s+breeder=([^\s\]]+)\s+feed_alloc=([\d.]+)/);
    const breederId = entry.transfer_breeder_id || (noteMarker ? noteMarker[1] : null);
    let feedAlloc = parseFloat(entry.feed_allocation_lbs);
    if (!Number.isFinite(feedAlloc) || feedAlloc <= 0) feedAlloc = noteMarker ? parseFloat(noteMarker[2]) : 0;
    if (!Number.isFinite(feedAlloc)) feedAlloc = 0;
    if (!entry.transferred_to_breeding && !noteMarker) {
      setTransferNotice({kind: 'warning', message: "This entry doesn't appear to be transferred."});
      return;
    }
    let undoOk = true;
    if (breederId) {
      const brR = await sb.from('app_store').select('data').eq('key', 'ppp-breeders-v1').maybeSingle();
      if (!brR.error) {
        const cur = brR.data && Array.isArray(brR.data.data) ? brR.data.data : [];
        const next = cur.filter((b) => b.id !== breederId);
        if (next.length !== cur.length) {
          const {error: brDelErr} = await sb
            .from('app_store')
            .upsert({key: 'ppp-breeders-v1', data: next}, {onConflict: 'key'});
          if (brDelErr) {
            setTransferNotice({kind: 'error', message: 'Undo failed (breeders): ' + brDelErr.message});
            undoOk = false;
          }
        }
      }
    }
    const {parent} = resolveBatchAndSub(session.batch_id);
    if (parent && undoOk) {
      const updated = feederGroups.map((g) =>
        g.id !== parent.id
          ? g
          : {...g, feedAllocatedToTransfers: Math.max(0, (parseFloat(g.feedAllocatedToTransfers) || 0) - feedAlloc)},
      );
      setFeederGroups(updated);
      const {error: fgDelErr} = await sb
        .from('app_store')
        .upsert({key: 'ppp-feeders-v1', data: updated}, {onConflict: 'key'});
      if (fgDelErr) {
        setTransferNotice({kind: 'error', message: 'Undo failed (feeders): ' + fgDelErr.message});
        undoOk = false;
      }
    }
    if (undoOk) {
      const cleanedNote = (entry.note || '').replace(/^\[transferred_to_breeding[^\]]*\]\s*/, '') || null;
      const {error: clearErr} = await sb
        .from('weigh_ins')
        .update({
          transferred_to_breeding: false,
          transfer_breeder_id: null,
          feed_allocation_lbs: null,
          note: cleanedNote,
        })
        .eq('id', entry.id);
      if (clearErr) {
        setTransferNotice({kind: 'error', message: 'Undo failed (clear stamp): ' + clearErr.message});
        return;
      }
      try {
        await recordActivityEvent(sb, {
          entityType: 'weighin.session',
          entityId: session.id,
          eventType: 'field.updated',
          entityLabel: sessionLabel(),
          body: 'Undid transfer to breeding for entry (' + (entry.weight || '?') + ' lb)',
        });
      } catch (_e) {
        /* best-effort */
      }
    }
    await loadAll();
  }

  if (loading) {
    return <RecordPageLoading Header={Header} />;
  }

  if (accessDenied) {
    return (
      <RecordPageNotFound
        Header={Header}
        data-access-denied="1"
        backLabel="Home"
        onBack={() => navigate('/')}
        message="You do not have access to this program."
      />
    );
  }

  if (!session) {
    return (
      <RecordPageNotFound
        Header={Header}
        backLabel="Back to Weigh-Ins"
        onBack={() => navigate('/')}
        message="Session not found."
      />
    );
  }

  if (
    session.species !== 'cattle' &&
    session.species !== 'sheep' &&
    session.species !== 'pig' &&
    session.species !== 'broiler'
  ) {
    const back = SPECIES_BACK[session.species] || {path: '/', label: 'Home'};
    return (
      <RecordPageNotFound
        Header={Header}
        data-unsupported-species="1"
        backLabel={'Back to ' + back.label}
        onBack={() => navigate(back.path)}
        message={
          session.species.charAt(0).toUpperCase() +
          session.species.slice(1) +
          ' weigh-in session record pages are not yet available. Use the ' +
          back.label +
          ' list view.'
        }
      />
    );
  }

  const isPig = session.species === 'pig';
  const isBroiler = session.species === 'broiler';
  // CP0 WI-2d: this record page is shared across species; its accent follows the
  // session's program (cattle maroon / pig blue / sheep green / broiler gold).
  const accent = getProgramColor(session.species);
  const priors = isPig || isBroiler ? {} : computePriors();
  const curDate = session.date;
  const adgs =
    isPig || isBroiler
      ? []
      : sEntries
          .map((e) => {
            const p = priors[e.tag];
            return p ? adgLbPerDay(p.weight, p.date, e.weight, curDate) : null;
          })
          .filter((a) => a != null);
  const avgAdg = adgs.length > 0 ? adgs.reduce((x, v) => x + v, 0) / adgs.length : null;
  const pigEntryAdgs =
    isPig && pigPriorSession
      ? computeRankMatchedPigEntryADG(sEntries, pigPriorSession.entries, session.date, pigPriorSession.date)
      : [];
  const pigEntryAdgById = Object.fromEntries(pigEntryAdgs.map((m) => [m.entryId, m]).filter(([id]) => id != null));
  const broilerAvg =
    isBroiler && sEntries.length > 0
      ? Math.round((sEntries.reduce((s, e) => s + (parseFloat(e.weight) || 0), 0) / sEntries.length) * 100) / 100
      : null;
  const groupLabelsMap = session.species === 'sheep' ? FLOCK_LABELS : HERD_LABELS;
  const groupName =
    isPig || isBroiler
      ? session.batch_id || session.species
      : groupLabelsMap[session.herd] || session.herd || session.species;
  const entityLabel = (session.date || '') + ' · ' + groupName;
  const backInfo = SPECIES_BACK[session.species] || {path: '/', label: 'Home'};

  // Cattle/sheep remaining pools — scoped to THIS session's herd/flock, mirroring
  // WeighInsWebform.remainingTags/remainingCows. Cattle animals carry .herd, sheep
  // carry .flock; the session stores the group in session.herd for both species.
  // remainingTags = herd cow tags minus tags already weighed this session.
  // remainingCows = the same herd cows as full records (the diminishing reconcile
  // pool). pendingReconciles = entries still flagged new_tag_flag — they block
  // completion until each is reconciled to a known cow.
  const animalGroupField = session.species === 'sheep' ? 'flock' : 'herd';
  const weighedTagSet = new Set(sEntries.map((e) => e.tag).filter(Boolean));
  const herdCows =
    isPig || isBroiler
      ? []
      : animals
          .filter((c) => (c[animalGroupField] || null) === (session.herd || null) && c.tag)
          .sort(
            (a, b) => (parseFloat(a.tag) || 0) - (parseFloat(b.tag) || 0) || (a.tag || '').localeCompare(b.tag || ''),
          );
  const remainingCows = herdCows.filter((c) => !weighedTagSet.has(c.tag));
  const remainingTags = remainingCows.map((c) => c.tag);
  const pendingReconciles = isPig || isBroiler ? [] : sEntries.filter((e) => e.new_tag_flag === true);
  const expectedTags = herdCows.length;

  return (
    <RecordPageFrame Header={Header}>
      <RecordPageBody maxWidth={900} data-weighin-session-record-loaded="true">
        <RecordBackLink label={'Back to ' + backInfo.label} onBack={() => navigate(backInfo.path)} />

        <RecordSequenceNav seq={recordSeq} currentId={sessionId} onNavigate={navigateSeq} />

        <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12}}>
          <RecordTitle fontSize={22} margin={0}>
            {groupName} — {fmt(session.date)}
          </RecordTitle>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 10,
              background: session.status === 'complete' ? '#d1fae5' : '#fef3c7',
              color: session.status === 'complete' ? '#065f46' : '#92400e',
              textTransform: 'uppercase',
            }}
          >
            {session.status}
          </span>
          {session.team_member && <span style={{fontSize: 12, color: 'var(--ink-muted)'}}>{session.team_member}</span>}
          <span style={{fontSize: 12, color: 'var(--ink-muted)'}}>
            {sEntries.length} {sEntries.length === 1 ? 'entry' : 'entries'}
            {!isPig && !isBroiler && expectedTags > 0 ? ' of ' + expectedTags : ''}
          </span>
          {avgAdg != null && (
            <span
              title={adgs.length + ' of ' + sEntries.length + ' entries have a prior weigh-in'}
              style={{
                padding: '3px 10px',
                borderRadius: 999,
                background: avgAdg >= 0 ? '#ecfdf5' : '#fef2f2',
                color: avgAdg >= 0 ? '#065f46' : '#b91c1c',
                border: '1px solid ' + (avgAdg >= 0 ? '#a7f3d0' : '#fecaca'),
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {'avg ADG ' +
                (avgAdg >= 0 ? '+' : '') +
                avgAdg.toFixed(2) +
                ' lb/d (' +
                adgs.length +
                '/' +
                sEntries.length +
                ')'}
            </span>
          )}
          {isPig && pigMetrics && (
            <>
              <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>
                {formatAgeRange({
                  minDays: pigMetrics.age_min_days,
                  maxDays: pigMetrics.age_max_days,
                  hasActual: pigMetrics.has_actual_farrowing,
                })}
              </span>
              <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>
                {formatFeedPerPig(pigMetrics.feed_per_pig_lbs)}
              </span>
              <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>
                {formatGroupAdg(pigMetrics.group_adg_lbs_per_day)}
              </span>
              <span style={{fontSize: 11, fontWeight: 600, color: accent}}>
                {formatAvgWeight(pigMetrics.avg_weight_lbs)}
              </span>
            </>
          )}
          {isBroiler && session.broiler_week && (
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
              {'WK ' + session.broiler_week}
            </span>
          )}
          {isBroiler && broilerAvg != null && (
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
              avg {broilerAvg} lb
            </span>
          )}
        </div>

        {notice && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}

        {isBroiler &&
          (() => {
            const cur = (session.team_member || '').trim();
            const metaDirty = Number(metaWeek) !== Number(session.broiler_week);
            const wkBtnStyle = (active) => ({
              padding: '4px 10px',
              borderRadius: 10,
              border: '1px solid ' + (active ? accent : '#d1d5db'),
              background: active ? accent : 'white',
              color: active ? 'white' : '#374151',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            });
            return (
              <div
                data-testid="broiler-meta-panel"
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 14,
                  padding: '10px 12px',
                  marginBottom: 10,
                  background: 'white',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{fontSize: 11, fontWeight: 700, color: 'var(--ink-muted)', letterSpacing: 0.4}}>
                  {'SESSION METADATA'}
                </div>
                <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
                  <span style={{...recordFieldLabel, minWidth: 90}}>{'Week:'}</span>
                  <button
                    type="button"
                    data-testid="broiler-meta-wk4"
                    onClick={() => setMetaWeek(4)}
                    aria-pressed={Number(metaWeek) === 4}
                    style={wkBtnStyle(Number(metaWeek) === 4)}
                  >
                    {'WK 4'}
                  </button>
                  <button
                    type="button"
                    data-testid="broiler-meta-wk6"
                    onClick={() => setMetaWeek(6)}
                    aria-pressed={Number(metaWeek) === 6}
                    style={wkBtnStyle(Number(metaWeek) === 6)}
                  >
                    {'WK 6'}
                  </button>
                </div>
                <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
                  <span style={{...recordFieldLabel, minWidth: 90}}>{'Team Member:'}</span>
                  {React.createElement(LockedTeamMemberField, {
                    value: cur,
                    label: null,
                    style: {...recordControl, width: 'auto', minWidth: 180},
                  })}
                </div>
                {metaDirty && (
                  <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
                    <button
                      type="button"
                      data-testid="broiler-meta-save"
                      onClick={() => saveBroilerMetadata()}
                      disabled={metaBusy}
                      style={{
                        padding: '4px 12px',
                        borderRadius: 10,
                        border: 'none',
                        background: metaBusy ? '#9ca3af' : accent,
                        color: 'white',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: metaBusy ? 'not-allowed' : 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      {metaBusy ? 'Saving…' : 'Save Metadata'}
                    </button>
                  </div>
                )}
                {metaErr && (
                  <div data-testid="broiler-meta-err" style={{fontSize: 11, color: '#b91c1c'}}>
                    {metaErr}
                  </div>
                )}
              </div>
            );
          })()}

        <div style={{display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap'}}>
          {session.status === 'draft' &&
            (() => {
              // Block completion while any entry still carries new_tag_flag —
              // these unresolved missing/replacement tags must be reconciled to
              // a known cow first (mirrors WeighInsWebform's pendingReconciles
              // gate). The handler-level guard in completeSession is the
              // authoritative block; this just reflects + disables.
              const blockComplete = pendingReconciles.length > 0;
              return (
                <button
                  onClick={completeSession}
                  disabled={blockComplete}
                  data-weighin-complete-blocked={blockComplete ? '1' : '0'}
                  title={
                    blockComplete
                      ? 'Resolve ' +
                        pendingReconciles.length +
                        ' missing/new ' +
                        (pendingReconciles.length === 1 ? 'tag' : 'tags') +
                        ' first'
                      : undefined
                  }
                  style={{
                    padding: '10px 16px',
                    borderRadius: 10,
                    border: '1px solid ' + (blockComplete ? '#9ca3af' : '#047857'),
                    background: blockComplete ? '#9ca3af' : '#047857',
                    color: 'white',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: blockComplete ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {blockComplete
                    ? 'Resolve ' +
                      pendingReconciles.length +
                      ' ' +
                      (pendingReconciles.length === 1 ? 'missing tag' : 'missing tags') +
                      ' first'
                    : '✓ Complete Session'}
                </button>
              );
            })()}
          {session.status === 'complete' && (
            <button
              onClick={reopenSession}
              style={{
                padding: '10px 16px',
                borderRadius: 10,
                border: '1px solid var(--border-strong)',
                background: 'white',
                color: 'var(--brand)',
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Reopen Session
            </button>
          )}
          <button
            onClick={deleteSession}
            style={{
              padding: '10px 16px',
              borderRadius: 10,
              border: '1px solid #fca5a5',
              background: 'white',
              color: '#b91c1c',
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Delete Session
          </button>
          {/* Send-to-Trip stays available on COMPLETED sessions too (5cd008a
              product decision): completing a weigh-in must not strand unsent
              pigs behind a reopen. Entry locking is per-row (sent/transferred),
              not session-status based. */}
          {isPig &&
            (session.status === 'draft' || session.status === 'complete') &&
            canManagePigPlannedTrips &&
            selectedEntryIds.size > 0 && (
              <button
                data-pig-send-bar="1"
                onClick={openTripModal}
                style={{
                  padding: '10px 16px',
                  borderRadius: 10,
                  border: '1px solid #047857',
                  background: '#047857',
                  color: 'white',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Send {selectedEntryIds.size} to Trip
              </button>
            )}
        </div>

        {isBroiler && gridLabels.length > 0 && (
          <div
            data-broiler-grid="1"
            style={{
              background: 'white',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '14px 18px',
              marginBottom: 12,
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(' + gridLabels.length + ', 1fr)',
                gap: 8,
                marginBottom: 10,
              }}
            >
              {gridLabels.map((label, col) => (
                <div key={col}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: '#374151',
                      textAlign: 'center',
                      padding: '4px 0',
                      marginBottom: 4,
                      background: '#eef2ff',
                      borderRadius: 10,
                    }}
                  >
                    {'Schooner ' + label}
                  </div>
                  {Array.from({length: 15}).map((_, row) => {
                    const idx = col * 15 + row;
                    return (
                      <div key={row} style={{display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3}}>
                        <span
                          style={{
                            fontSize: 10,
                            color: 'var(--ink-faint)',
                            minWidth: 18,
                            textAlign: 'right',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {row + 1}
                        </span>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={gridInputs[idx] || ''}
                          onChange={(e) => {
                            const v = e.target.value;
                            setGridInputs((prev) => {
                              const next = prev.slice();
                              next[idx] = v;
                              return next;
                            });
                          }}
                          placeholder="0"
                          style={{
                            fontFamily: 'inherit',
                            fontSize: 13,
                            padding: '6px 8px',
                            border: '1px solid var(--border-strong)',
                            borderRadius: 10,
                            width: '100%',
                            boxSizing: 'border-box',
                            background: 'white',
                            color: 'var(--ink)',
                            outline: 'none',
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <div style={{marginBottom: 10}}>
              <label style={{display: 'block', fontSize: 12, color: 'var(--ink)', marginBottom: 4, fontWeight: 600}}>
                Session note
              </label>
              <textarea
                value={gridNote}
                onChange={(ev) => setGridNote(ev.target.value)}
                rows={2}
                placeholder="Optional"
                style={{
                  fontFamily: 'inherit',
                  fontSize: 13,
                  padding: '6px 8px',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 10,
                  width: '100%',
                  boxSizing: 'border-box',
                  background: 'white',
                  color: 'var(--ink)',
                  outline: 'none',
                  resize: 'vertical',
                }}
              />
            </div>
            {gridErr && (
              <div
                style={{
                  color: '#b91c1c',
                  fontSize: 12,
                  marginBottom: 8,
                  padding: '6px 10px',
                  background: '#fef2f2',
                  borderRadius: 10,
                }}
              >
                {gridErr}
              </div>
            )}
            <button
              onClick={saveBroilerGrid}
              disabled={savingGrid}
              style={{
                padding: '10px 16px',
                borderRadius: 10,
                border: 'none',
                background: savingGrid ? '#9ca3af' : accent,
                color: 'white',
                fontSize: 12,
                fontWeight: 600,
                cursor: savingGrid ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {savingGrid ? 'Saving…' : 'Save Weights'}
            </button>
          </div>
        )}

        {!isBroiler && (
          <div
            data-weighin-entries="1"
            style={{background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 18px'}}
          >
            {sEntries.length === 0 && (
              <div style={{fontSize: 12, color: 'var(--ink-faint)', fontStyle: 'italic', marginBottom: 8}}>
                No entries yet.
              </div>
            )}
            {isPig && sEntries.length > 0 && (
              <div data-weighin-entry-list="1" style={{overflowX: 'auto', marginBottom: 8}}>
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: 12,
                    fontFamily: 'inherit',
                  }}
                >
                  <thead>
                    <tr style={{borderBottom: '1px solid var(--border)', textAlign: 'left'}}>
                      {['Trip', 'Weight', 'Note', 'Prior', 'Days', '+/-', 'ADG', 'Status', ''].map((h, i) => (
                        <th
                          key={i}
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: 'var(--ink-muted)',
                            textTransform: 'uppercase',
                            letterSpacing: 0.4,
                            padding: '4px 6px',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sEntries.map((e) => {
                      const ef = entryEdits[e.id] || entryDraft(e);
                      const isSent = !!e.sent_to_trip_id;
                      const isTransferred = !!(
                        e.transferred_to_breeding || /\[transferred_to_breeding/.test(e.note || '')
                      );
                      const isLocked = isSent || isTransferred;
                      const pigEntryAdg = pigEntryAdgById[e.id];
                      const hasPigNote = String(ef.note || '').trim().length > 0;
                      const showPigNoteInput = hasPigNote || openPigNoteEntryIds.has(e.id);
                      const autosaveState = entryAutosave[e.id];
                      const autosaveTone =
                        autosaveState && autosaveState.status === 'error'
                          ? {color: '#b91c1c', background: '#fef2f2', border: '#fecaca'}
                          : autosaveState && autosaveState.status === 'saved'
                            ? {color: '#065f46', background: '#ecfdf5', border: '#a7f3d0'}
                            : {color: '#6b7280', background: '#f9fafb', border: '#e5e7eb'};
                      // Selectable on draft AND complete sessions (5cd008a):
                      // only sent/transferred rows lock out of send-to-trip.
                      const canSelect =
                        !isLocked &&
                        (session.status === 'draft' || session.status === 'complete') &&
                        canManagePigPlannedTrips;
                      const td = {
                        padding: '4px 6px',
                        verticalAlign: 'top',
                        borderBottom: '1px solid var(--divider)',
                      };
                      const dash = <span style={{fontSize: 10, color: 'var(--ink-faint)'}}>—</span>;
                      return (
                        <tr
                          key={e.id}
                          data-pig-entry-row={e.id}
                          style={{background: isSent ? '#ecfdf5' : isTransferred ? '#eef2ff' : 'white'}}
                        >
                          <td style={{...td, whiteSpace: 'nowrap'}}>
                            {/* Send-to-trip select lives in the leftmost column. Eligible
                                draft rows toggle selectedEntryIds; sent rows show locked
                                checked; transferred/locked rows are disabled. */}
                            <input
                              type="checkbox"
                              data-pig-send-select={canSelect ? '1' : undefined}
                              aria-label="Select for send to trip"
                              checked={isSent || (canSelect && selectedEntryIds.has(e.id))}
                              disabled={!canSelect}
                              onChange={
                                canSelect
                                  ? () =>
                                      setSelectedEntryIds((prev) => {
                                        const n = new Set(prev);
                                        if (n.has(e.id)) n.delete(e.id);
                                        else n.add(e.id);
                                        return n;
                                      })
                                  : undefined
                              }
                            />
                          </td>
                          <td style={td}>
                            {isLocked ? (
                              <span style={{fontWeight: 600, color: accent, whiteSpace: 'nowrap'}}>{e.weight} lb</span>
                            ) : (
                              <input
                                type="number"
                                min="0"
                                step="0.1"
                                placeholder="lb"
                                value={ef.weight}
                                onChange={(ev) => setPigEntryField(e, 'weight', ev.target.value)}
                                onBlur={() => flushPigEntryAutosave(e.id)}
                                style={{...inp, width: 64}}
                              />
                            )}
                          </td>
                          <td style={{...td, minWidth: 120}}>
                            {isLocked ? (
                              e.note ? (
                                <span style={{color: 'var(--ink-muted)'}}>{e.note}</span>
                              ) : (
                                dash
                              )
                            ) : showPigNoteInput ? (
                              <input
                                type="text"
                                placeholder="Note"
                                value={ef.note}
                                onChange={(ev) => setPigEntryField(e, 'note', ev.target.value)}
                                onBlur={() => flushPigEntryAutosave(e.id)}
                                style={{...inp, width: '100%', minWidth: 100}}
                              />
                            ) : (
                              <button
                                type="button"
                                data-pig-entry-add-note={e.id}
                                onClick={() =>
                                  setOpenPigNoteEntryIds((prev) => {
                                    const next = new Set(prev);
                                    next.add(e.id);
                                    return next;
                                  })
                                }
                                style={{
                                  fontSize: 10,
                                  color: 'var(--ink-muted)',
                                  background: 'white',
                                  border: '1px solid var(--border-strong)',
                                  borderRadius: 10,
                                  cursor: 'pointer',
                                  padding: '3px 7px',
                                  fontFamily: 'inherit',
                                }}
                              >
                                + Note
                              </button>
                            )}
                          </td>
                          <td style={{...td, whiteSpace: 'nowrap'}}>
                            {pigEntryAdg ? (
                              <span
                                data-pig-entry-prior={e.id}
                                title={'Prior weigh-in on ' + fmt(pigEntryAdg.priorDate)}
                                style={{fontSize: 10, color: 'var(--ink)'}}
                              >
                                {'Prev ' +
                                  Math.round(pigEntryAdg.priorWeightLbs) +
                                  ' lb · ' +
                                  fmt(pigEntryAdg.priorDate)}
                              </span>
                            ) : (
                              dash
                            )}
                          </td>
                          <td style={{...td, whiteSpace: 'nowrap'}}>
                            {pigEntryAdg ? (
                              <span
                                data-entry-days={e.id}
                                data-pig-entry-days={e.id}
                                title={'Days since last weigh-in'}
                                style={{fontSize: 10, color: 'var(--ink)'}}
                              >
                                {'Days ' + pigEntryAdg.daysBetween}
                              </span>
                            ) : (
                              dash
                            )}
                          </td>
                          <td style={{...td, whiteSpace: 'nowrap'}}>
                            {pigEntryAdg ? (
                              <span
                                data-entry-delta={e.id}
                                data-pig-entry-delta={e.id}
                                title={'Weight change since prior weigh-in'}
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  color: pigEntryAdg.weightDeltaLbs >= 0 ? '#065f46' : '#b91c1c',
                                }}
                              >
                                {'+/- ' + formatSignedLbs(pigEntryAdg.weightDeltaLbs)}
                              </span>
                            ) : (
                              dash
                            )}
                          </td>
                          <td style={{...td, whiteSpace: 'nowrap'}}>
                            {pigEntryAdg ? (
                              <span
                                data-pig-entry-adg={e.id}
                                title={
                                  'rank ' +
                                  pigEntryAdg.rank +
                                  ' vs prior ' +
                                  fmt(pigEntryAdg.priorDate) +
                                  ' at ' +
                                  Math.round(pigEntryAdg.priorWeightLbs) +
                                  ' lb'
                                }
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  color: pigEntryAdg.adgLbsPerDay >= 0 ? '#065f46' : '#b91c1c',
                                }}
                              >
                                {'ADG ' +
                                  (pigEntryAdg.adgLbsPerDay >= 0 ? '+' : '') +
                                  pigEntryAdg.adgLbsPerDay.toFixed(2) +
                                  ' lb/day'}
                              </span>
                            ) : (
                              dash
                            )}
                          </td>
                          <td style={{...td, whiteSpace: 'nowrap'}}>
                            {isSent ? (
                              <span style={{fontSize: 11, fontWeight: 600, color: '#065f46'}}>Sent to trip</span>
                            ) : isTransferred ? (
                              <span style={{fontSize: 11, fontWeight: 600, color: '#3730a3'}}>Transferred</span>
                            ) : (
                              <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>Draft</span>
                            )}
                          </td>
                          <td style={{...td, whiteSpace: 'nowrap', textAlign: 'right'}}>
                            <div
                              style={{
                                display: 'flex',
                                gap: 8,
                                justifyContent: 'flex-end',
                                alignItems: 'center',
                                flexWrap: 'wrap',
                              }}
                            >
                              {autosaveState && !isLocked && (
                                <span
                                  data-entry-autosave={e.id}
                                  data-pig-entry-autosave={e.id}
                                  style={{fontSize: 10, color: autosaveTone.color}}
                                >
                                  {autosaveState.message}
                                </span>
                              )}
                              {isSent && canManagePigPlannedTrips && (
                                <button
                                  onClick={() => undoSendToTrip(e)}
                                  style={{
                                    fontSize: 10,
                                    color: '#b45309',
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    padding: '2px 6px',
                                    fontFamily: 'inherit',
                                  }}
                                >
                                  Undo send
                                </button>
                              )}
                              {isTransferred && (
                                <button
                                  onClick={() => undoTransferToBreeding(e)}
                                  style={{
                                    fontSize: 10,
                                    color: '#b45309',
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    padding: '2px 6px',
                                    fontFamily: 'inherit',
                                  }}
                                >
                                  Undo transfer
                                </button>
                              )}
                              {!isLocked && (
                                <>
                                  <button
                                    onClick={() => openTransferModal(e)}
                                    style={{
                                      fontSize: 10,
                                      color: '#3730a3',
                                      background: 'none',
                                      border: 'none',
                                      cursor: 'pointer',
                                      padding: '2px 6px',
                                      fontFamily: 'inherit',
                                    }}
                                  >
                                    → Breeding
                                  </button>
                                  <button
                                    onClick={() => deleteEntry(e)}
                                    style={{
                                      fontSize: 10,
                                      color: '#b91c1c',
                                      background: 'none',
                                      border: 'none',
                                      cursor: 'pointer',
                                      padding: '2px 6px',
                                      fontFamily: 'inherit',
                                    }}
                                  >
                                    Delete
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {!isPig && sEntries.length > 0 && (
              <div data-weighin-entry-list="1" style={{overflowX: 'auto', marginBottom: 8}}>
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: 12,
                    fontFamily: 'inherit',
                  }}
                >
                  <thead>
                    <tr style={{borderBottom: '1px solid var(--border)', textAlign: 'left'}}>
                      {[
                        'Tag',
                        'Weight',
                        'Note',
                        'Prior',
                        'Days',
                        '+/-',
                        'ADG',
                        session.species === 'sheep' ? 'Flock/Status' : 'Herd/Status',
                        'Time',
                        '',
                      ].map((h, i) => (
                        <th
                          key={i}
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: 'var(--ink-muted)',
                            textTransform: 'uppercase',
                            letterSpacing: 0.4,
                            padding: '4px 6px',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...sEntries].sort(sortEntriesByTagAsc).map((e) => {
                      const ef = entryEdits[e.id] || entryDraft(e);
                      const cow = animals.find((c) => c.tag === e.tag);
                      const prior = priors[e.tag];
                      const adg = prior ? adgLbPerDay(prior.weight, prior.date, e.weight, curDate) : null;
                      const priorDays = prior ? daysBetweenDates(prior.date, curDate) : null;
                      const weightDelta =
                        prior && Number.isFinite(parseFloat(e.weight)) && Number.isFinite(parseFloat(prior.weight))
                          ? parseFloat(e.weight) - parseFloat(prior.weight)
                          : null;
                      const autosaveState = entryAutosave[e.id];
                      const autosaveTone =
                        autosaveState && autosaveState.status === 'error'
                          ? {color: '#b91c1c', background: '#fef2f2', border: '#fecaca'}
                          : autosaveState && autosaveState.status === 'saved'
                            ? {color: '#065f46', background: '#ecfdf5', border: '#a7f3d0'}
                            : {color: '#6b7280', background: '#f9fafb', border: '#e5e7eb'};
                      const showProcessorCol = session.species === 'sheep' || session.herd === 'finishers';
                      const td = {padding: '4px 6px', verticalAlign: 'top', borderBottom: '1px solid var(--divider)'};
                      return (
                        <tr
                          key={e.id}
                          data-entry-tag={e.tag || ''}
                          style={{background: e.send_to_processor ? '#fef2f2' : e.new_tag_flag ? '#fef2f2' : 'white'}}
                        >
                          <td style={td}>
                            <input
                              type="text"
                              placeholder="Tag #"
                              value={ef.tag}
                              onChange={(ev) => setEntryField(e, 'tag', ev.target.value)}
                              onBlur={() => flushEntryAutosave(e.id)}
                              style={{...inp, width: 64}}
                            />
                          </td>
                          <td style={td}>
                            <input
                              type="number"
                              min="0"
                              step="0.1"
                              placeholder="lb"
                              value={ef.weight}
                              onChange={(ev) => setEntryField(e, 'weight', ev.target.value)}
                              onBlur={() => flushEntryAutosave(e.id)}
                              style={{...inp, width: 60}}
                            />
                          </td>
                          <td style={{...td, minWidth: 120}}>
                            <input
                              type="text"
                              placeholder="Note"
                              value={ef.note}
                              onChange={(ev) => setEntryField(e, 'note', ev.target.value)}
                              onBlur={() => flushEntryAutosave(e.id)}
                              style={{...inp, width: '100%', minWidth: 100}}
                            />
                          </td>
                          <td style={{...td, whiteSpace: 'nowrap'}}>
                            {prior ? (
                              <span
                                data-entry-prior={e.id}
                                style={{fontSize: 10, color: 'var(--ink)'}}
                                title={'Prior weigh-in on ' + fmt(prior.date)}
                              >
                                {'Prev ' + Math.round(prior.weight) + ' lb · ' + fmt(prior.date)}
                              </span>
                            ) : (
                              <span style={{fontSize: 10, color: 'var(--ink-faint)'}}>—</span>
                            )}
                          </td>
                          <td style={{...td, whiteSpace: 'nowrap'}}>
                            {priorDays != null ? (
                              <span
                                data-entry-days={e.id}
                                title={'Days since last weigh-in'}
                                style={{fontSize: 10, color: 'var(--ink)'}}
                              >
                                {'Days ' + priorDays}
                              </span>
                            ) : (
                              <span style={{fontSize: 10, color: 'var(--ink-faint)'}}>—</span>
                            )}
                          </td>
                          <td style={{...td, whiteSpace: 'nowrap'}}>
                            {weightDelta != null ? (
                              <span
                                data-entry-delta={e.id}
                                title={'Weight change since prior weigh-in'}
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  padding: '1px 6px',
                                  borderRadius: 999,
                                  background: weightDelta >= 0 ? '#ecfdf5' : '#fef2f2',
                                  color: weightDelta >= 0 ? '#065f46' : '#b91c1c',
                                  border: '1px solid ' + (weightDelta >= 0 ? '#a7f3d0' : '#fecaca'),
                                }}
                              >
                                {'+/- ' + formatSignedLbs(weightDelta)}
                              </span>
                            ) : (
                              <span style={{fontSize: 10, color: 'var(--ink-faint)'}}>—</span>
                            )}
                          </td>
                          <td style={{...td, whiteSpace: 'nowrap'}}>
                            {adg != null ? (
                              <span
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  padding: '1px 6px',
                                  borderRadius: 999,
                                  background: adg >= 0 ? '#ecfdf5' : '#fef2f2',
                                  color: adg >= 0 ? '#065f46' : '#b91c1c',
                                  border: '1px solid ' + (adg >= 0 ? '#a7f3d0' : '#fecaca'),
                                }}
                              >
                                {(adg >= 0 ? '+' : '') + adg.toFixed(2) + ' lb/d'}
                              </span>
                            ) : (
                              <span style={{fontSize: 10, color: 'var(--ink-faint)'}}>—</span>
                            )}
                          </td>
                          <td style={{...td, whiteSpace: 'nowrap'}}>
                            {e.new_tag_flag ? (
                              <span
                                title="Resolve in the reconcile panel below"
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  padding: '1px 6px',
                                  borderRadius: 999,
                                  background: '#fef2f2',
                                  color: '#b91c1c',
                                }}
                              >
                                NEW TAG
                              </span>
                            ) : showProcessorCol && session.status === 'draft' ? (
                              <button
                                onClick={() => toggleProcessor(e, !e.send_to_processor)}
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  padding: '3px 8px',
                                  borderRadius: 10,
                                  border: '1px solid ' + (e.send_to_processor ? '#991b1b' : '#d1d5db'),
                                  background: e.send_to_processor ? '#991b1b' : 'white',
                                  color: e.send_to_processor ? 'white' : '#6b7280',
                                  cursor: 'pointer',
                                  fontFamily: 'inherit',
                                }}
                              >
                                {e.send_to_processor ? '✓ Processor' : '→ Processor'}
                              </button>
                            ) : showProcessorCol && session.status !== 'draft' && e.send_to_processor ? (
                              <span
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  padding: '3px 8px',
                                  borderRadius: 999,
                                  background: '#991b1b',
                                  color: 'white',
                                }}
                              >
                                ✓ Processor
                              </span>
                            ) : cow ? (
                              <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>
                                {groupLabelsMap[cow.herd || cow.flock] || cow.herd || cow.flock}
                              </span>
                            ) : (
                              <span style={{fontSize: 10, color: 'var(--ink-faint)'}}>—</span>
                            )}
                          </td>
                          <td style={{...td, whiteSpace: 'nowrap'}}>
                            <span style={{fontSize: 10, color: 'var(--ink-faint)'}}>
                              {(e.entered_at || '').slice(11, 16)}
                            </span>
                          </td>
                          <td style={{...td, whiteSpace: 'nowrap', textAlign: 'right'}}>
                            <div
                              style={{
                                display: 'flex',
                                gap: 4,
                                justifyContent: 'flex-end',
                                alignItems: 'center',
                                flexWrap: 'wrap',
                              }}
                            >
                              {autosaveState && (
                                <span
                                  data-entry-autosave={e.id}
                                  style={{
                                    fontSize: 10,
                                    color: autosaveTone.color,
                                    background: autosaveTone.background,
                                    border: '1px solid ' + autosaveTone.border,
                                    borderRadius: 999,
                                    padding: '1px 6px',
                                  }}
                                >
                                  {autosaveState.message}
                                </span>
                              )}
                              <button
                                onClick={() => deleteEntry(e)}
                                style={{
                                  fontSize: 10,
                                  color: '#b91c1c',
                                  background: 'none',
                                  border: 'none',
                                  cursor: 'pointer',
                                  padding: '2px 6px',
                                  fontFamily: 'inherit',
                                }}
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {!isPig && pendingReconciles.length > 0 && (
              <div
                data-weighin-reconcile-panel="1"
                style={{
                  marginTop: 8,
                  marginBottom: 8,
                  border: '2px solid #f59e0b',
                  background: '#fffbeb',
                  borderRadius: 14,
                  padding: '8px 10px',
                }}
              >
                <div style={{fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 4}}>
                  {'⚠️ ' +
                    pendingReconciles.length +
                    ' ' +
                    (pendingReconciles.length === 1 ? 'missing tag' : 'missing tags') +
                    ' to reconcile'}
                </div>
                <div style={{fontSize: 11, color: '#92400e', marginBottom: 8}}>
                  Pick which {session.species === 'sheep' ? 'sheep' : 'cow'} each new tag belongs to. Pool narrows as
                  more animals get weighed.
                </div>
                {pendingReconciles.map((e) => (
                  <div
                    key={e.id}
                    style={{
                      padding: '6px 8px',
                      background: 'white',
                      border: '1px solid #fde68a',
                      borderRadius: 10,
                      marginBottom: 6,
                    }}
                  >
                    <div style={{fontSize: 12, fontWeight: 700, color: 'var(--ink)', marginBottom: 4}}>
                      {'New tag #' + (e.tag || '?') + ' · ' + e.weight + ' lb'}
                      {e.note ? (
                        <span style={{fontWeight: 400, color: 'var(--ink-muted)', fontStyle: 'italic'}}>
                          {' · ' + e.note}
                        </span>
                      ) : null}
                    </div>
                    <select
                      data-weighin-reconcile-select={e.id}
                      onChange={(ev) => {
                        if (ev.target.value) reconcileNewTag(e, ev.target.value);
                      }}
                      defaultValue=""
                      style={{
                        fontSize: 12,
                        padding: '4px 8px',
                        border: '1px solid var(--border-strong)',
                        borderRadius: 10,
                        fontFamily: 'inherit',
                        width: '100%',
                        boxSizing: 'border-box',
                      }}
                    >
                      <option value="">{'Reconcile to known cow... (' + remainingCows.length + ' remaining)'}</option>
                      {remainingCows.map((c) => (
                        <option
                          key={c.id}
                          value={c.id}
                          data-breeding-blacklist-option={
                            session.species === 'cattle' && c.breeding_blacklist ? '1' : undefined
                          }
                          style={
                            session.species === 'cattle' && c.breeding_blacklist ? BLACKLIST_OPTION_STYLE : undefined
                          }
                        >
                          {'#' +
                            c.tag +
                            ' (' +
                            (c[animalGroupField] || '?') +
                            ')' +
                            (c.sex ? ' · ' + c.sex : '') +
                            (c.breed ? ' · ' + c.breed : '')}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}

            <div
              style={{
                marginTop: 8,
                background: '#eff6ff',
                border: '1px dashed #bfdbfe',
                borderRadius: 10,
                padding: '8px 10px',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'wrap',
              }}
            >
              <span style={{fontSize: 11, fontWeight: 600, color: accent}}>+ Add entry:</span>
              {!isPig && (
                <>
                  {/* Main workflow: herd-scoped diminishing picker of cows not yet
                      weighed this session. Picking a tag fills the free-text Tag #
                      field below (so swap/new-tag escape hatches keep working). */}
                  {!addForm.priorTag && (
                    <select
                      data-weighin-remaining-picker="1"
                      value=""
                      onChange={(ev) => {
                        if (ev.target.value) setAddForm((f) => ({...f, tag: ev.target.value}));
                      }}
                      style={{...inp, width: 170}}
                    >
                      <option value="">{'Pick tag... (' + remainingTags.length + ' remaining)'}</option>
                      {remainingCows.map((c) => (
                        <option
                          key={c.id}
                          value={c.tag}
                          data-breeding-blacklist-option={
                            session.species === 'cattle' && c.breeding_blacklist ? '1' : undefined
                          }
                          style={
                            session.species === 'cattle' && c.breeding_blacklist ? BLACKLIST_OPTION_STYLE : undefined
                          }
                        >
                          {'#' + c.tag + (c.sex ? ' · ' + c.sex : '')}
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    type="text"
                    placeholder="Prior tag (swap)"
                    value={addForm.priorTag}
                    onChange={(ev) => setAddForm((f) => ({...f, priorTag: ev.target.value}))}
                    style={{...inp, width: 130, background: addForm.priorTag ? '#dbeafe' : 'white'}}
                  />
                  <input
                    type="text"
                    placeholder={addForm.priorTag ? 'New tag #' : 'Tag #'}
                    value={addForm.tag}
                    onChange={(ev) => setAddForm((f) => ({...f, tag: ev.target.value}))}
                    style={{...inp, width: 90}}
                  />
                </>
              )}
              <input
                type="number"
                min="0"
                step="0.1"
                placeholder="lb"
                value={addForm.weight}
                onChange={(ev) => setAddForm((f) => ({...f, weight: ev.target.value}))}
                style={{...inp, width: 70}}
              />
              <input
                type="text"
                placeholder="Note"
                value={addForm.note}
                onChange={(ev) => setAddForm((f) => ({...f, note: ev.target.value}))}
                style={{...inp, flex: 1, minWidth: 100}}
              />
              <button
                onClick={addEntry}
                disabled={!(parseFloat(addForm.weight) > 0)}
                style={{
                  padding: '4px 12px',
                  borderRadius: 10,
                  border: 'none',
                  background: parseFloat(addForm.weight) > 0 ? accent : '#d1d5db',
                  color: 'white',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: parseFloat(addForm.weight) > 0 ? 'pointer' : 'not-allowed',
                  fontFamily: 'inherit',
                }}
              >
                {!isPig && addForm.priorTag ? 'Swap + Add' : 'Add'}
              </button>
            </div>
          </div>
        )}

        <RecordCollaborationSection
          sb={sb}
          authState={authState}
          entityType="weighin.session"
          entityId={session.id}
          entityLabel={entityLabel}
        />
      </RecordPageBody>

      {sessionForModal &&
        session.species === 'sheep' &&
        React.createElement(SheepSendToProcessorModal, {
          sb,
          session: sessionForModal,
          flaggedEntries: sEntries.filter((e) => e.send_to_processor === true),
          sheepList: animals,
          teamMember: (authState && authState.name) || null,
          authState,
          useAttachRpc: true,
          onCancel: () => setSessionForModal(null),
          onConfirmed: async () => {
            setSessionForModal(null);
            await finalizeComplete();
          },
        })}
      {sessionForModal &&
        session.species !== 'sheep' &&
        React.createElement(CattleSendToProcessorModal, {
          sb,
          session: sessionForModal,
          flaggedEntries: sEntries.filter((e) => e.send_to_processor === true),
          cattleList: animals,
          weighIns: allEntries,
          teamMember: (authState && authState.name) || null,
          authState,
          useAttachRpc: true,
          onCancel: () => setSessionForModal(null),
          onConfirmed: async () => {
            setSessionForModal(null);
            await finalizeComplete();
          },
        })}
      {tripModal &&
        React.createElement(PigSendToTripModal, {
          session: tripModal.session,
          selectedEntries: tripModal.entries,
          feederGroups,
          onClose: () => setTripModal(null),
          onConfirm: sendEntriesToTrip,
        })}
      {transferModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,.5)',
            zIndex: 250,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            onClick={(ev) => ev.stopPropagation()}
            style={{
              background: 'white',
              borderRadius: 12,
              padding: 18,
              width: 'min(440px, 96vw)',
              maxHeight: '80vh',
              overflowY: 'auto',
              fontFamily: 'inherit',
            }}
          >
            <h3 style={{margin: '0 0 10px', fontSize: 16, color: 'var(--ink)'}}>Transfer to Breeding</h3>
            <div style={{fontSize: 12, color: 'var(--ink-muted)', marginBottom: 10}}>
              Entry weight: {transferModal.entry.weight} lb
            </div>
            {transferNotice && <InlineNotice notice={transferNotice} onDismiss={() => setTransferNotice(null)} />}
            <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
              <label style={{fontSize: 12, fontWeight: 600}}>
                Tag #{' '}
                <input
                  type="text"
                  value={transferForm.tag}
                  onChange={(ev) => setTransferForm((f) => ({...f, tag: ev.target.value}))}
                  style={{...inp, width: '100%', marginTop: 2}}
                />
              </label>
              <label style={{fontSize: 12, fontWeight: 600}}>
                Sex{' '}
                <select
                  value={transferForm.sex}
                  onChange={(ev) => setTransferForm((f) => ({...f, sex: ev.target.value}))}
                  style={{...inp, width: '100%', marginTop: 2}}
                >
                  <option value="Gilt">Gilt</option>
                  <option value="Boar">Boar</option>
                </select>
              </label>
              <label style={{fontSize: 12, fontWeight: 600}}>
                Group{' '}
                <input
                  type="text"
                  value={transferForm.group}
                  onChange={(ev) => setTransferForm((f) => ({...f, group: ev.target.value}))}
                  style={{...inp, width: '100%', marginTop: 2}}
                />
              </label>
              <label style={{fontSize: 12, fontWeight: 600}}>
                Birth date (est.){' '}
                <input
                  type="date"
                  value={transferForm.birthDate}
                  onChange={(ev) => setTransferForm((f) => ({...f, birthDate: ev.target.value}))}
                  style={{...inp, width: '100%', marginTop: 2}}
                />
              </label>
            </div>
            <div style={{display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12}}>
              <button
                onClick={() => {
                  setTransferModal(null);
                  setTransferNotice(null);
                }}
                disabled={transferBusy}
                style={{
                  padding: '10px 16px',
                  borderRadius: 10,
                  border: '1px solid var(--border-strong)',
                  background: 'white',
                  color: 'var(--ink)',
                  fontSize: 12,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
              <button
                onClick={transferToBreeding}
                disabled={transferBusy}
                style={{
                  padding: '10px 16px',
                  borderRadius: 10,
                  border: 'none',
                  background: '#3730a3',
                  color: 'white',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {transferBusy ? 'Transferring…' : 'Transfer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </RecordPageFrame>
  );
}
