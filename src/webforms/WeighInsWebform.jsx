// Phase 2 Round 5 extraction (verbatim).
//
// 2026-04-30 (mig 035 + Phase 1C-D): pig + broiler FRESH draft session
// creation/save now routes through the parent-aware offline RPC queue
// (`useOfflineRpcSubmit('weigh_in_session_batch')` against the
// submit_weigh_in_session_batch RPC). Cattle/sheep paths and the entire
// completion flow (finalizeSession + stamp_broiler_batch_avg RPC) remain
// online-direct and unchanged. See PROJECT.md §7 mig 035 + 055 entries.
//
// Fresh-vs-DB-backed branching is gated by `sessionIsFresh`:
//   - startNewSession for pig/broiler skips the weigh_in_sessions INSERT;
//     local entries collect in component state until the operator taps
//     Save Draft (pig) / Save Weights (broiler), which fires the RPC.
//   - On state='synced', sessionIsFresh flips false, session.id ← parent_in.id,
//     and entry IDs swap to record.args.entries_in[i].id (deterministic
//     ${parentId}-c${i}). Operator stays on the session screen so the
//     existing online-only Complete path still works.
//   - On state='queued', terminal "Saved on this device" screen.
//   - 23505 from this RPC remains a stuck/schema bug, never success.
import React from 'react';
import {deriveBroilerColumnLabels} from '../lib/broilerBatchMeta.js';
import {openableProps} from '../shared/openable.js';
import {fmt, centralISOFor, todayCentralISO} from '../lib/dateUtils.js';
import {formatAgeRange, formatFeedPerPig, formatGroupAdg, formatAvgWeight} from '../lib/pigForecast.js';
import {useOfflineRpcSubmit} from '../lib/useOfflineRpcSubmit.js';
import {recordActivityEvent, recordFieldChange, recordStatusChange} from '../lib/entityMutations.js';
import {buildChanges} from '../lib/activityChangeDiff.js';
import CattleSendToProcessorModal from '../cattle/CattleSendToProcessorModal.jsx';
import SheepSendToProcessorModal from '../sheep/SheepSendToProcessorModal.jsx';
import {detachCattleFromProcessingBatch, detachSheepFromProcessingBatch} from '../lib/processingDetachApi.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon, {PlannerIconLabel} from '../components/PlannerIcon.jsx';
import {ANIMAL_ICON_KEYS} from '../lib/plannerIcons.js';
import {programDotStyle} from '../lib/programColors.js';
import StuckSubmissionsModal from './StuckSubmissionsModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import DeleteModal from '../shared/DeleteModal.jsx';
import LockedSubmitter from './LockedSubmitter.jsx';

const WeighInsWebform = ({sb, sessionSubmitter}) => {
  // Lane 1 CP1: on the authenticated path the submitter is the signed-in user,
  // locked. The roster dropdown is replaced by the signed-in identity.
  const lockedName = sessionSubmitter?.name || '';
  const [stage, setStage] = React.useState('species'); // 'species' | 'select' | 'session' | 'done'
  const [species, setSpecies] = React.useState('');
  const [date, setDate] = React.useState('');
  const [teamMember, setTeamMember] = React.useState(sessionSubmitter?.name || '');
  // Submitter selection is retired: weigh-ins are stamped with the signed-in
  // user, not a roster or per-species team-member dropdown.
  // Draft + session state
  const [drafts, setDrafts] = React.useState([]);
  const [session, setSession] = React.useState(null); // current session row
  const [entries, setEntries] = React.useState([]); // weigh_ins for current session
  // Cattle
  const [cattleHerd, setCattleHerd] = React.useState('');
  const [cattleList, setCattleList] = React.useState([]);
  // Sheep — parallel to cattle (per-sheep weigh-in with session autosave)
  const [sheepFlock, setSheepFlock] = React.useState('');
  const [sheepList, setSheepList] = React.useState([]);
  // Prior-weight lookup: tag → {weight, date} from most-recent COMPLETED session
  // of this species, excluding today and the current session. Used to show
  // "prior weight" in the dropdown, compute ADG per entry, and aggregate a
  // session-average ADG. Loaded when species is picked (and when session changes).
  const [priorByTag, setPriorByTag] = React.useState({});
  const [tagInput, setTagInput] = React.useState('');
  const [weightInput, setWeightInput] = React.useState('');
  const [noteInput, setNoteInput] = React.useState('');
  // Cattle entry mode: 'normal' = pick existing tag from herd dropdown,
  //                    'new_cow' = staff is creating a brand-new cow inline (sex+tag),
  //                    'replacement' = existing cow with a swapped tag — flagged
  //                                    until someone reconciles it to a known cow.
  const [entryMode, setEntryMode] = React.useState('normal');
  const [newCowSex, setNewCowSex] = React.useState('cow');
  const [newCowBirthDate, setNewCowBirthDate] = React.useState('');
  // Prior tag is only for Swap Tag, where an existing cow is being retagged.
  const [priorTagInput, setPriorTagInput] = React.useState('');
  // Pig/broiler grid: 30 weight slots (2 cols x 15 rows), single session note
  const [weightInputs, setWeightInputs] = React.useState(Array(30).fill(''));
  // Pig / Broiler
  const [pigBatches, setPigBatches] = React.useState([]);
  const [broilerBatches, setBroilerBatches] = React.useState([]);
  // Public broiler schooner mirror — Array<{name, schooners: string[]}>.
  // Sourced from webform_config.broiler_batch_meta only. The admin-side
  // weigh-ins view has its own authenticated read of the canonical batch
  // store; the public form never touches it (anon RLS).
  const [broilerBatchMeta, setBroilerBatchMeta] = React.useState([]);
  // Readiness marker for the mirror above. startNewSession refuses a broiler
  // start until schooner labels resolve, so the select stage must expose when
  // that read has settled (data-weighins-broiler-meta-loaded) for deterministic
  // waits instead of racing the fetch.
  const [broilerBatchMetaLoaded, setBroilerBatchMetaLoaded] = React.useState(false);
  const [pigBatchId, setPigBatchId] = React.useState('');
  const [broilerBatchId, setBroilerBatchId] = React.useState('');
  const [broilerBatchLabel, setBroilerBatchLabel] = React.useState('');
  const [broilerWeek, setBroilerWeek] = React.useState(4);
  // Per-column labels (broiler: schooner names; pig: ['1','2']). Computed at session-start.
  const [columnLabels, setColumnLabels] = React.useState(['1', '2']);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  // Inline edit of a Recent-entries row (cattle/sheep/pig). editingEntryId =
  // the weigh_ins row being edited; editDraft holds the pending changes.
  // Cattle/sheep edits mirror the entry surface: tag, missing-tag flag, weight,
  // and note. Pig edits remain weight/note only because pig entries are tagless.
  const [editingEntryId, setEditingEntryId] = React.useState(null);
  const [editDraft, setEditDraft] = React.useState({tag: '', weight: '', note: '', newTagFlag: false});
  // Send-to-processor modal shown at Complete time when a cattle finishers
  // session has at least one send_to_processor=true entry.
  const [showProcessorModal, setShowProcessorModal] = React.useState(false);

  // Phase 1C-D — fresh-session branching for pig + broiler.
  //   sessionIsFresh: true  → pre-RPC, local-only state. startNewSession
  //                           for pig/broiler does NOT INSERT.
  //   sessionIsFresh: false → DB-backed (resumed OR post-synced fresh).
  //                           saveEntry / saveBatch use today's direct paths.
  // Cattle/sheep skip the fresh branch entirely (sessionIsFresh stays false
  // for them — they direct-INSERT in startNewSession as before).
  const [sessionIsFresh, setSessionIsFresh] = React.useState(false);
  // Terminal "Saved on this device" screen state — set only on RPC queued
  // outcome. Synced + DB-backed completion uses the existing 'done' stage.
  const [doneState, setDoneState] = React.useState('none'); // 'none' | 'queued'
  // Hidden marker for Playwright assertions: 'synced' once a fresh session
  // has been converted to DB-backed via online RPC success.
  const [lastSubmitOutcome, setLastSubmitOutcome] = React.useState(null);
  // Stuck submission modal state.
  const [stuckOpen, setStuckOpen] = React.useState(false);

  // Local typed-delete confirmation modal. The App-scoped window._wcfConfirmDelete
  // helper is not mounted on the public webform, so destructive flows here use
  // a local state machine with the same DeleteModal UI. confirmDelete(message)
  // returns a Promise that resolves true on typed confirm and false on cancel
  // (Escape, Cancel button, or close) — never hangs.
  const [deleteConfirmState, setDeleteConfirmState] = React.useState(null);
  function confirmDelete(message) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      setDeleteConfirmState({
        message,
        onConfirm: () => settle(true),
        onCancel: () => {
          settle(false);
          setDeleteConfirmState(null);
        },
      });
    });
  }

  // Pig session metrics from the public-safe pig_session_metrics RPC
  // (mig 049). Anon scope returns aggregates only for status='draft' pig
  // sessions; this form is the canonical anon caller. Null until the
  // first RPC response lands; refreshed when entries change so live
  // weighed_count + avg + ADG stay accurate.
  const [pigMetrics, setPigMetrics] = React.useState(null);

  // Offline RPC queue hook — pig/broiler fresh draft session creation.
  const {
    submit: submitDraftSession,
    stuckRows,
    retryStuck,
    discardStuck,
  } = useOfflineRpcSubmit('weigh_in_session_batch');

  // Auto-open stuck modal once on mount or first appearance of stuck rows.
  // Mirrors AddFeedWebform's pattern.
  const initialStuckShownRef = React.useRef(false);
  React.useEffect(() => {
    if (stuckRows.length > 0 && !initialStuckShownRef.current) {
      initialStuckShownRef.current = true;
      setStuckOpen(true);
    }
  }, [stuckRows.length]);

  // Monotonic counter for local-only entry IDs in pig fresh-collection.
  // `entries.length` would collide on delete-middle-then-add (Codex review v3
  // #1) and break React keys + edit/delete targeting.
  const localIdCounterRef = React.useRef(0);

  React.useEffect(() => {
    setDate(todayCentralISO());
  }, []);

  // Keep the submitter pinned to the signed-in identity. New sessions +
  // per-entry rows carry the authenticated user, not a roster selection.
  React.useEffect(() => {
    if (teamMember !== lockedName) setTeamMember(lockedName);
  }, [lockedName, teamMember]);

  // When species picked, prefetch what's needed
  React.useEffect(() => {
    if (!species) return;
    setErr('');
    if (species === 'cattle') {
      sb.from('cattle')
        .select('id, tag, herd, birth_date, sex, breed, old_tags, breeding_blacklist')
        .is('deleted_at', null)
        .then(({data}) => {
          if (data) setCattleList(data);
        });
    } else if (species === 'sheep') {
      sb.from('sheep')
        .select('id, tag, flock, birth_date, sex, breed, old_tags')
        .is('deleted_at', null)
        .then(({data}) => {
          if (data) setSheepList(data);
        });
    } else if (species === 'pig') {
      sb.from('webform_config')
        .select('data')
        .eq('key', 'active_groups')
        .maybeSingle()
        .then(({data}) => {
          if (data && Array.isArray(data.data)) {
            // filter out SOWS/BOARS — pig weigh-ins are for feeder batches only
            setPigBatches(data.data.filter((n) => n && n.toUpperCase() !== 'SOWS' && n.toUpperCase() !== 'BOARS'));
          }
        });
    } else if (species === 'broiler') {
      sb.from('webform_config')
        .select('data')
        .eq('key', 'broiler_groups')
        .maybeSingle()
        .then(({data}) => {
          if (data && Array.isArray(data.data)) setBroilerBatches(data.data);
        });
      // Load the public broiler schooner mirror so we can resolve column
      // labels at session-start. Sourced from webform_config.broiler_batch_meta
      // (mirrored by admin-app load + syncWebformConfig). The previous direct
      // read of the canonical batch store was anon-blocked under prod RLS
      // and silently produced "(no schooner)" fallbacks.
      // Fail closed across retries: clear the previous mirror before each
      // read so a failed refresh cannot reuse stale schooner metadata and
      // let Start Session proceed on outdated columns.
      setBroilerBatchMeta([]);
      setBroilerBatchMetaLoaded(false);
      sb.from('webform_config')
        .select('data')
        .eq('key', 'broiler_batch_meta')
        .maybeSingle()
        .then(({data}) => {
          if (data && Array.isArray(data.data)) setBroilerBatchMeta(data.data);
        })
        .catch(() => {
          // Marker means "the request settled", not "valid metadata exists".
          // A failed read keeps broilerBatchMeta empty, so startNewSession
          // still fails closed with the no-schooners message.
        })
        .finally(() => setBroilerBatchMetaLoaded(true));
    }
    // Look for existing draft sessions in the last 7 days
    const cutoff = centralISOFor(new Date(Date.now() - 7 * 86400000));
    sb.from('weigh_in_sessions')
      .select('*')
      .eq('species', species)
      .eq('status', 'draft')
      .gte('date', cutoff)
      .order('started_at', {ascending: false})
      .then(({data}) => {
        if (data) setDrafts(data);
      });
    // Build priorByTag: most recent COMPLETED weigh-in per tag for this
    // species, excluding today. Powers the dropdown's prior-weight column,
    // per-entry ADG, and session-average ADG.
    const today = todayCentralISO();
    sb.from('weigh_in_sessions')
      .select('id, date')
      .eq('species', species)
      .eq('status', 'complete')
      .lt('date', today)
      .order('date', {ascending: false})
      .then(({data: sessions}) => {
        const sessionById = {};
        (sessions || []).forEach((s) => {
          sessionById[s.id] = s;
        });
        const sessIds = (sessions || []).map((s) => s.id);
        if (sessIds.length === 0) {
          setPriorByTag({});
          return;
        }
        sb.from('weigh_ins')
          .select('tag, weight, session_id')
          .in('session_id', sessIds)
          .then(({data: wis}) => {
            const byTag = {};
            (wis || []).forEach((w) => {
              if (!w.tag) return;
              const sd = sessionById[w.session_id]?.date;
              if (!sd) return;
              const existing = byTag[w.tag];
              if (!existing || sd > existing.date) byTag[w.tag] = {weight: parseFloat(w.weight) || 0, date: sd};
            });
            setPriorByTag(byTag);
          });
      });
  }, [species]);

  // Sort cattle/sheep entries by tag # ascending (numeric where possible,
  // locale fallback). Tagless entries sink by insertion time. Drives the
  // Recent-entries + Going-to-processor rendering so teams see rows in
  // ear-tag order as they weigh.
  function sortEntriesByTagAsc(a, b) {
    const at = a && a.tag,
      bt = b && b.tag;
    if (at == null && bt == null) return (a.id || '').localeCompare(b.id || '');
    if (at == null) return 1;
    if (bt == null) return -1;
    const an = parseFloat(at),
      bn = parseFloat(bt);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
    return String(at).localeCompare(String(bt));
  }
  // ── Age / ADG helpers ─────────────────────────────────────────────────────
  // Age in years+months from a birth date string ('YYYY-MM-DD') to a reference
  // date. Returns '2y 3m' / '5m' / '—' (null birth → dash).
  function ageYM(birth, asOf) {
    if (!birth) return '—';
    const b = new Date(birth + 'T12:00:00');
    const a = asOf ? new Date(asOf + 'T12:00:00') : new Date();
    const ms = a - b;
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const days = Math.floor(ms / 86400000);
    const y = Math.floor(days / 365);
    const m = Math.floor((days % 365) / 30);
    return y > 0 ? y + 'y ' + m + 'm' : m + 'm';
  }
  // ADG (lb/day) between a prior weigh-in and today's. Null if either side missing
  // or if the interval is < 1 day (same-day priors excluded upstream anyway).
  function adgLbPerDay(priorWt, priorDate, curWt, curDate) {
    if (priorWt == null || curWt == null || !priorDate || !curDate) return null;
    const pd = new Date(priorDate + 'T12:00:00');
    const cd = new Date(curDate + 'T12:00:00');
    const days = Math.round((cd - pd) / 86400000);
    if (!Number.isFinite(days) || days < 1) return null;
    const adg = (parseFloat(curWt) - parseFloat(priorWt)) / days;
    return Number.isFinite(adg) ? adg : null;
  }
  // Format an animal directory row for the tag dropdown: '#101 · cow · 2y 3m · 850 lb'.
  // Missing birth → age '—'; missing prior weight → 'new'.
  function formatAnimalOption(animal, sessionDate) {
    const tag = animal.tag || '?';
    const sex = animal.sex ? ' \u00b7 ' + animal.sex : '';
    const age = ageYM(animal.birth_date, sessionDate);
    const prior = priorByTag[tag];
    const priorStr = prior ? Math.round(prior.weight) + ' lb' : 'new';
    return '#' + tag + sex + ' \u00b7 ' + age + ' \u00b7 ' + priorStr;
  }

  function findDirectoryAnimalByTag(tag) {
    const t = String(tag || '').trim();
    if (!t) return null;
    if (species === 'cattle') return cattleList.find((c) => c.herd === cattleHerd && String(c.tag || '') === t) || null;
    if (species === 'sheep') return sheepList.find((s) => s.flock === sheepFlock && String(s.tag || '') === t) || null;
    return null;
  }

  function entryTagUsedByAnotherEntry(tag, entryId) {
    const t = String(tag || '').trim();
    if (!t) return false;
    return entries.some((e) => e.id !== entryId && String(e.tag || '') === t);
  }

  function buildEditableTagOptions(entry) {
    if (species !== 'cattle' && species !== 'sheep') return [];
    const rows =
      species === 'cattle'
        ? cattleList.filter((c) => c.herd === cattleHerd && c.tag)
        : sheepList.filter((s) => s.flock === sheepFlock && s.tag);
    const byTag = new Map();
    rows.forEach((animal) => {
      const tag = String(animal.tag || '');
      if (!tag) return;
      if (entryTagUsedByAnotherEntry(tag, entry.id) && tag !== String(entry.tag || '')) return;
      byTag.set(tag, animal);
    });
    return Array.from(byTag.values()).sort((a, b) => sortEntriesByTagAsc({tag: a.tag}, {tag: b.tag}));
  }

  // Load entries when session is set, and (for broiler/pig) hydrate the grid
  // so previously-saved weights show up in the input cells they came from.
  // Phase 1C-D: skip the DB query when session.id is undefined (fresh
  // pig/broiler session pre-RPC). Local entries[] are managed in component
  // state until Save Draft / Save Weights fires the RPC.
  React.useEffect(() => {
    if (!session) {
      setEntries([]);
      return;
    }
    if (!session.id) {
      // Fresh pre-submit pig/broiler — entries are local-only.
      return;
    }
    // Reset to [] first so the grid hydration effect doesn't briefly mix
    // the previous session's entries with the new session's columnLabels.
    setEntries([]);
    sb.from('weigh_ins')
      .select('*')
      .eq('session_id', session.id)
      .order('entered_at', {ascending: true})
      .then(({data}) => {
        if (data) setEntries(data);
      });
  }, [session]);

  // Pig metrics RPC (mig 049). Public form's only consumer.
  //   Gates:
  //     species === 'pig'                    — pig-only metric block
  //     session && session.id && !fresh      — DB-backed session exists
  //     entries.length >= 1                  — Codex W1 lock: no metrics
  //                                            block before the first
  //                                            entry exists
  //   Re-fires when entries.length changes so weighed_count + avg + ADG
  //   stay live as the operator weighs additional pigs.
  React.useEffect(() => {
    if (species !== 'pig' || !session || !session.id || sessionIsFresh || entries.length < 1) {
      setPigMetrics(null);
      return;
    }
    let cancelled = false;
    sb.rpc('pig_session_metrics', {session_id_in: session.id}).then(({data, error}) => {
      if (cancelled) return;
      if (error) {
        console.warn('pig_session_metrics rpc error:', error.message || error);
        setPigMetrics({available: false});
        return;
      }
      setPigMetrics(data || {available: false});
    });
    return () => {
      cancelled = true;
    };
    // sb is a stable prop from the parent; established pattern in this file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [species, session, sessionIsFresh, entries.length]);

  // Hydrate the broiler grid from saved entries whenever entries OR
  // columnLabels change. Each entry's tag is the schooner name and lands
  // in that schooner's column, top-down in save order.
  React.useEffect(() => {
    if (!session) return;
    if (session.species !== 'broiler') return;
    if (!columnLabels || columnLabels.length === 0) return;
    var grid = Array(columnLabels.length * 15).fill('');
    columnLabels.forEach(function (label, colIdx) {
      var colEntries = entries.filter(function (e) {
        return (e.tag || '') === label;
      });
      colEntries.slice(0, 15).forEach(function (e, i) {
        grid[colIdx * 15 + i] = String(e.weight);
      });
    });
    setWeightInputs(grid);
  }, [entries, columnLabels, session]);

  // Resolve the column labels for a given session.
  //   broiler → schooner labels from the public mirror (no fallback —
  //             empty array means admin hasn't assigned schooners and the
  //             caller MUST block startNewSession / resumeSession).
  //   pig     → fixed ['1','2'].
  //   cattle/sheep → ignored downstream (per-entry list, not a grid).
  function deriveColumnLabels(sp, batchId) {
    if (sp === 'broiler') return deriveBroilerColumnLabels(broilerBatchMeta, batchId);
    if (sp === 'pig') return ['1', '2'];
    return [];
  }
  async function startNewSession(extra) {
    if (!teamMember) {
      setErr('Please pick a team member.');
      return;
    }
    setErr('');
    setLastSubmitOutcome(null);
    const startedAt = new Date().toISOString();
    const rec = {
      // id is left undefined for pig/broiler fresh sessions — the parentId
      // is minted by the RPC hook at submit() time. Cattle/sheep mint it
      // client-side and INSERT immediately (today's behavior).
      id: undefined,
      date,
      team_member: teamMember,
      species,
      status: 'draft',
      started_at: startedAt,
      ...extra,
    };

    // Phase 1C-D — pig/broiler fresh sessions skip the DB INSERT. The
    // weigh_in_sessions row only lands at RPC-submit time (synced) or
    // via queue replay (queued). startNewSession only transitions UI.
    if (species === 'pig' || species === 'broiler') {
      if (species === 'broiler') {
        const labels = deriveColumnLabels(species, extra && extra.batch_id);
        if (labels.length === 0) {
          setErr('This batch has no schooners assigned. Ask admin to set schooners on the batch before weighing.');
          return;
        }
        setColumnLabels(labels);
        setWeightInputs(Array(labels.length * 15).fill(''));
      }
      setSessionIsFresh(true);
      setSession(rec);
      setEntries([]);
      setStage('session');
      return;
    }

    // Cattle / sheep — today's direct INSERT path, unchanged.
    setBusy(true);
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    const dbRec = {
      id,
      date,
      team_member: teamMember,
      species,
      status: 'draft',
      ...extra,
    };
    const {error} = await sb.from('weigh_in_sessions').insert(dbRec);
    setBusy(false);
    if (error) {
      setErr('Could not start session: ' + error.message);
      return;
    }
    setSession(dbRec);
    setSessionIsFresh(false);
    setEntries([]);
    setStage('session');
  }
  async function resumeSession(s) {
    setSession(s);
    // Resumed sessions are always DB-backed — every direct-DB path
    // (saveEntry, saveBatch direct, deleteEntry, finalizeSession) is valid.
    setSessionIsFresh(false);
    setLastSubmitOutcome(null);
    // The submitter stays the signed-in user; a resumed draft's original
    // starter does not override the locked identity.
    if (s.notes) setNoteInput(s.notes);
    // Restore the herd/flock selection so the remaining-tags list
    // populates correctly on resume (it filters by cattleHerd / sheepFlock).
    if (s.species === 'cattle' && s.herd) setCattleHerd(s.herd);
    if (s.species === 'sheep' && s.herd) setSheepFlock(s.herd);
    if (s.species === 'broiler') {
      const labels = deriveColumnLabels(s.species, s.batch_id);
      if (labels.length === 0) {
        setErr('This batch has no schooners assigned. Ask admin to set schooners on the batch before weighing.');
        return;
      }
      setColumnLabels(labels);
      setWeightInputs(Array(labels.length * 15).fill(''));
    }
    setStage('session');
  }
  async function completeSession() {
    if (!session) return;
    // Cattle finishers: if anyone ticked "-> Processor" on any entry, pop
    // the batch modal before flipping the session status. The modal attaches
    // the flagged cows to the chosen batch, moves them to the processed herd,
    // then calls finalizeSession() to finish the normal complete flow.
    if (species === 'cattle' && session.herd === 'finishers') {
      const flagged = entries.filter((e) => e.send_to_processor === true);
      if (flagged.length > 0) {
        setShowProcessorModal(true);
        return;
      }
    }
    if (species === 'sheep') {
      // Looser than cattle's finishers-only gate (per Ronnie 2026-04-27):
      // any sheep session with flagged entries opens the modal regardless
      // of flock — handles rams / ewes / feeders / null-herd imports.
      const flagged = entries.filter((e) => e.send_to_processor === true);
      if (flagged.length > 0) {
        setShowProcessorModal(true);
        return;
      }
    }
    await finalizeSession();
  }
  async function finalizeSession() {
    if (!session) return;
    // Broiler still uses the grid -> flush any pending edits to DB before
    // flipping status. Pigs now save per-entry, so nothing to batch-flush.
    if (species === 'broiler') {
      const ok = await saveBatch();
      if (!ok) return;
    }
    setBusy(true);
    const completedAt = new Date().toISOString();
    const compUp = await sb
      .from('weigh_in_sessions')
      .update({status: 'complete', completed_at: completedAt})
      .eq('id', session.id);
    if (compUp && compUp.error) {
      setBusy(false);
      setErr('Complete failed: ' + compUp.error.message);
      return;
    }
    // Best-effort: log the completion on the weighin.session feed (the RPC stamps
    // the submitter as actor). Mirrors the authenticated WeighInSessionPage.
    try {
      await recordStatusChange(sb, {
        entityType: 'weighin.session',
        entityId: session.id,
        entityLabel:
          (species || session.species || 'weigh-in') + ' · ' + (session.herd || session.flock || session.date || ''),
        from: 'draft',
        to: 'complete',
      });
    } catch (_e) {
      /* best-effort audit trail */
    }
    if (species === 'broiler') {
      // Server-side stamp of week4Lbs / week6Lbs on the matching broiler
      // batch row. The public form cannot reach the admin batch store under
      // anon RLS, so we route through stamp_broiler_batch_avg (SECURITY
      // DEFINER) -- see supabase-migrations/055.
      const stamp = await sb.rpc('stamp_broiler_batch_avg', {session_id_in: session.id});
      if (stamp && stamp.error) {
        setBusy(false);
        setErr('Batch avg stamp failed: ' + stamp.error.message);
        return;
      }
      // applied:false (no entries / batch row missing) is a benign no-op
      // -- log to console but do not block the operator.
      if (stamp && stamp.data && stamp.data.applied === false) {
        // eslint-disable-next-line no-console
        console.warn('stamp_broiler_batch_avg no-op:', stamp.data.reason);
      }
    }
    setBusy(false);
    setStage('done');
  }
  // Toggle the send_to_processor flag on an individual entry. Finishers-only
  // in the UI; no herd gate here so the admin tab can override if needed.
  // Clearing the flag on an already-attached entry triggers a detach so the
  // batch.cows_detail and cow.processing_batch_id stay in sync. Detach uses
  // the prior_herd_or_flock fallback hierarchy and surfaces any block reason.
  async function toggleProcessor(entry, next) {
    let detached = false;
    if (!next && entry.target_processing_batch_id && species === 'cattle') {
      const cow = entry.tag ? cattleList.find((c) => c.tag === entry.tag) : null;
      if (cow) {
        const r = await detachCattleFromProcessingBatch(sb, {
          cattleId: cow.id,
          batchId: entry.target_processing_batch_id,
          teamMember: teamMember || null,
        });
        if (!r.ok && r.reason !== 'not_in_batch') {
          setErr(
            'Cannot clear flag for #' +
              (entry.tag || '?') +
              ': ' +
              (r.reason === 'no_prior_herd'
                ? 'no prior herd recorded — manually move via admin if needed'
                : r.reason + (r.error ? ' — ' + r.error : '')),
          );
          return;
        }
        detached = r.ok && r.reason === 'detached';
      }
    }
    if (!next && entry.target_processing_batch_id && species === 'sheep') {
      const sh = entry.tag ? sheepList.find((s) => s.tag === entry.tag) : null;
      if (sh) {
        const r = await detachSheepFromProcessingBatch(sb, {
          sheepId: sh.id,
          batchId: entry.target_processing_batch_id,
          teamMember: teamMember || null,
        });
        if (!r.ok && r.reason !== 'not_in_batch') {
          setErr(
            'Cannot clear flag for #' +
              (entry.tag || '?') +
              ': ' +
              (r.reason === 'no_prior_flock'
                ? 'no prior flock recorded — manually move via admin if needed'
                : r.reason + (r.error ? ' — ' + r.error : '')),
          );
          return;
        }
        detached = r.ok && r.reason === 'detached';
      }
    }
    if (!detached) {
      const {error} = await sb.from('weigh_ins').update({send_to_processor: !!next}).eq('id', entry.id);
      if (error) {
        setErr('Could not update: ' + error.message);
        return;
      }
    }
    setEntries((prev) =>
      prev.map((e) =>
        e.id === entry.id
          ? {
              ...e,
              send_to_processor: !!next,
              target_processing_batch_id: detached ? null : e.target_processing_batch_id,
            }
          : e,
      ),
    );
  }
  // Find a cow by prior tag, walking through current tag → import old_tags →
  // weigh_in old_tags, in that order (per the retag spec from Ronnie).
  function findCowByPriorTag(priorTag) {
    if (!priorTag) return null;
    const pt = String(priorTag).trim();
    const byCurrent = cattleList.find((c) => c.tag === pt);
    if (byCurrent) return byCurrent;
    const byImport = cattleList.find(
      (c) => Array.isArray(c.old_tags) && c.old_tags.some((ot) => ot && ot.tag === pt && ot.source === 'import'),
    );
    if (byImport) return byImport;
    const byWeighIn = cattleList.find(
      (c) => Array.isArray(c.old_tags) && c.old_tags.some((ot) => ot && ot.tag === pt && ot.source === 'weigh_in'),
    );
    return byWeighIn || null;
  }
  // Cattle entry modes:
  //   'normal'      — pick existing tag, weigh in
  //   'new_cow'     — create a fresh cattle row in the session's herd (for
  //                   never-tagged calves etc). No prior tag is captured here.
  //   'replacement' — flag the entry; reconcile to a known cow later
  //                   (when we don't know which cow lost its tag yet).
  //   'retag'       — NEW: retag a known cow on the spot. Caller supplies
  //                   priorTag (her current or prior tag). System swaps her
  //                   tag to the new one + appends an old_tags entry. Useful
  //                   for bulk retag of a 20-head buy where reconciling
  //                   after the fact would be a nightmare.
  async function saveEntry({tag, weight, note, mode, sex, priorTag, birthDate}) {
    if (!session) return;
    if (!weight || parseFloat(weight) <= 0) {
      setErr('Weight is required.');
      return;
    }
    // Phase 1C-D — pig fresh-collection: push to local entries[] only;
    // no DB write. RPC fires later via Save Draft button. Local IDs use a
    // monotonic ref so delete-middle-then-add never collides on a key.
    if (species === 'pig' && sessionIsFresh) {
      setErr('');
      const localId = 'local-' + localIdCounterRef.current++;
      const rec = {
        id: localId,
        session_id: undefined, // not yet in DB
        tag: null,
        weight: parseFloat(weight),
        note: note || null,
        new_tag_flag: false,
        entered_at: new Date().toISOString(),
      };
      setEntries((prev) => [...prev, rec]);
      setTagInput('');
      setWeightInput('');
      setNoteInput('');
      return;
    }
    // Pigs don't wear tags — entries save with tag=null. Everything else
    // requires a tag.
    if (!tag && species !== 'pig') {
      setErr('Tag is required.');
      return;
    }
    if (mode === 'new_cow') {
      if (!sex) {
        setErr('Pick sex for the new cow.');
        return;
      }
      if (cattleList.find((c) => c.tag === tag)) {
        setErr('Tag #' + tag + ' already exists in the directory.');
        return;
      }
    }
    let retagCow = null;
    if (mode === 'retag') {
      if (!priorTag || !priorTag.trim()) {
        setErr('Prior tag is required for a retag.');
        return;
      }
      if (priorTag.trim() === tag.trim()) {
        setErr('Prior tag and new tag cannot be the same.');
        return;
      }
      retagCow = findCowByPriorTag(priorTag);
      if (!retagCow) {
        setErr('No cow found with prior tag #' + priorTag + '. Check the number or use + Missing Tag instead.');
        return;
      }
      const existingAtNewTag = cattleList.find((c) => c.tag === tag.trim());
      if (existingAtNewTag && existingAtNewTag.id !== retagCow.id) {
        setErr('Tag #' + tag + ' is already assigned to another cow.');
        return;
      }
    }
    setErr('');
    setBusy(true);
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    const herd = (session && session.herd) || cattleHerd || null;
    // For new_cow: create the cattle row first so the weigh-in references a real cow.
    if (mode === 'new_cow' && herd) {
      const cowId = String(Date.now() + 1) + Math.random().toString(36).slice(2, 6);
      const cowRec = {
        id: cowId,
        tag: tag,
        herd: herd,
        sex: sex,
        birth_date: birthDate || null,
        old_tags: [],
      };
      const cowIns = await sb.from('cattle').insert(cowRec);
      if (cowIns.error) {
        setBusy(false);
        setErr('Could not create cow: ' + cowIns.error.message);
        return;
      }
      // Best-effort record.created on the new cow's feed (webform is login-gated,
      // so the RPC stamps the submitter as actor). Never blocks the create.
      try {
        await recordActivityEvent(sb, {
          entityType: 'cattle.animal',
          entityId: cowId,
          eventType: 'record.created',
          entityLabel: '#' + tag,
          body: 'Added cattle animal #' + tag + ' (' + (sex || 'unknown sex') + ', herd ' + herd + ')',
          payload: {record: 'cattle.animal', tag: tag, sex: sex, herd: herd, birth_date: birthDate || null},
        });
      } catch (_e) {
        /* best-effort audit trail */
      }
      // Reflect locally so subsequent dropdowns/list immediately include the new cow.
      setCattleList((prev) => prev.concat([cowRec]));
    }
    // For retag: swap the known cow's tag on the spot + stamp old_tags with the
    // prior WCF tag. This is a weigh-in tag history event, not a purchase tag.
    if (mode === 'retag' && retagCow) {
      const existingOldTags = Array.isArray(retagCow.old_tags) ? retagCow.old_tags : [];
      const priorTagIndex = existingOldTags.findIndex((oldTag) => String(oldTag && oldTag.tag) === priorTag.trim());
      let updatedOldTags = existingOldTags;
      if (priorTagIndex >= 0) {
        const currentOldTag = existingOldTags[priorTagIndex] || {};
        if (currentOldTag.source !== 'weigh_in') {
          updatedOldTags = existingOldTags.map((oldTag, index) =>
            index === priorTagIndex ? {...oldTag, tag: priorTag.trim(), source: 'weigh_in'} : oldTag,
          );
        }
      } else {
        updatedOldTags = existingOldTags.concat([
          {tag: priorTag.trim(), changed_at: new Date().toISOString(), source: 'weigh_in'},
        ]);
      }
      const cowNeedsUpdate = retagCow.tag !== tag.trim() || updatedOldTags !== existingOldTags;
      if (cowNeedsUpdate) {
        const cowUpd = await sb
          .from('cattle')
          .update({tag: tag.trim(), old_tags: updatedOldTags})
          .eq('id', retagCow.id);
        if (cowUpd.error) {
          setBusy(false);
          setErr('Could not retag cow: ' + cowUpd.error.message);
          return;
        }
        // Best-effort: log the tag change on the cow's own feed.
        try {
          const retagChanges = buildChanges({tag: priorTag.trim()}, {tag: tag.trim()}, {labels: {tag: 'Tag'}});
          if (retagChanges.length) {
            await recordFieldChange(sb, {
              entityType: 'cattle.animal',
              entityId: retagCow.id,
              entityLabel: tag.trim() || retagCow.id,
              changes: retagChanges,
            });
          }
        } catch (_e) {
          /* best-effort audit trail */
        }
        setCattleList((prev) =>
          prev.map((c) => (c.id === retagCow.id ? {...c, tag: tag.trim(), old_tags: updatedOldTags} : c)),
        );
      }
    }
    const rec = {
      id,
      session_id: session.id,
      tag: tag || null,
      weight: parseFloat(weight),
      note: note || null,
      new_tag_flag: mode === 'replacement',
      reconcile_intent: mode === 'replacement' ? 'replacement' : mode === 'new_cow' ? 'new_cow' : null,
    };
    const {error} = await sb.from('weigh_ins').insert(rec);
    if (error) {
      setBusy(false);
      setErr('Save failed: ' + error.message);
      return;
    }
    // Auto-publish a comment if this is cattle and a note was provided.
    // For 'replacement' mode the cow won't be known yet — comment is tagged
    // by tag string only and will get its cattle_id reconciled later.
    if (species === 'cattle' && note && note.trim() && tag) {
      // For retag we already know the cow (we just updated her).
      const cow = mode === 'retag' ? retagCow : cattleList.find((c) => c.tag === tag);
      try {
        await sb.from('cattle_comments').insert({
          id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
          cattle_id: cow ? cow.id : null,
          cattle_tag: tag,
          comment: note.trim(),
          team_member: teamMember || null,
          source: 'weigh_in',
          reference_id: id,
        });
      } catch (e) {
        /* table may not exist yet — silently skip */
      }
    }
    setEntries((prev) => [...prev, rec]);
    setTagInput('');
    setWeightInput('');
    setNoteInput('');
    setEntryMode('normal');
    setNewCowSex('cow');
    setNewCowBirthDate('');
    setPriorTagInput('');
    setBusy(false);
  }
  // Reconcile a flagged Replacement-Tag entry to a known cow:
  //   * Swap the cow's tag to the entry's new tag
  //   * Append the cow's PRIOR tag to cattle.old_tags with today's date
  //   * Clear new_tag_flag on the weigh-in entry (the entry's tag stays the new tag)
  // Mirrored by the admin reconcile UI in CattleWeighInsView so behavior is identical.
  async function reconcileEntryToCow(entry, cowId) {
    if (!entry || !cowId) return;
    const cow = cattleList.find((c) => c.id === cowId);
    if (!cow) {
      setErr('Cow not found.');
      return;
    }
    setErr('');
    setBusy(true);
    const priorTag = cow.tag;
    const newTag = entry.tag;
    // Reconciled after entry → labeled "Retag" (source='weigh_in').
    const updatedOldTags = (Array.isArray(cow.old_tags) ? cow.old_tags : []).concat([
      {tag: priorTag, changed_at: new Date().toISOString(), source: 'weigh_in'},
    ]);
    const cowUpd = await sb.from('cattle').update({tag: newTag, old_tags: updatedOldTags}).eq('id', cowId);
    if (cowUpd.error) {
      setBusy(false);
      setErr('Could not swap tag: ' + cowUpd.error.message);
      return;
    }
    // Best-effort: log the tag change on the cow's own feed.
    try {
      const reconcileChanges = buildChanges({tag: priorTag}, {tag: newTag}, {labels: {tag: 'Tag'}});
      if (reconcileChanges.length) {
        await recordFieldChange(sb, {
          entityType: 'cattle.animal',
          entityId: cowId,
          entityLabel: newTag || cowId,
          changes: reconcileChanges,
        });
      }
    } catch (_e) {
      /* best-effort audit trail */
    }
    const wiUpd = await sb.from('weigh_ins').update({new_tag_flag: false}).eq('id', entry.id);
    if (wiUpd.error) {
      setBusy(false);
      setErr('Could not clear flag: ' + wiUpd.error.message);
      return;
    }
    // Reflect locally so the dropdown narrows and the gate updates immediately.
    setCattleList((prev) => prev.map((c) => (c.id === cowId ? {...c, tag: newTag, old_tags: updatedOldTags} : c)));
    setEntries((prev) => prev.map((e) => (e.id === entry.id ? {...e, new_tag_flag: false} : e)));
    // Best-effort: stitch the cattle_id onto any pre-existing comment for this entry.
    try {
      await sb.from('cattle_comments').update({cattle_id: cowId, cattle_tag: newTag}).eq('reference_id', entry.id);
    } catch (e) {
      /* table may not exist yet */
    }
    setBusy(false);
  }
  function startEditEntry(entry) {
    setEditingEntryId(entry.id);
    setEditDraft({
      tag: entry.tag || '',
      weight: String(entry.weight ?? ''),
      note: entry.note || '',
      newTagFlag: !!entry.new_tag_flag,
    });
    setErr('');
  }
  async function saveEditEntry(entry) {
    const w = parseFloat(editDraft.weight);
    if (!Number.isFinite(w) || w <= 0) {
      setErr('Weight must be greater than 0.');
      return;
    }
    setErr('');
    const newNote = (editDraft.note || '').trim();
    const newTag = (editDraft.tag || '').trim();
    const editingTaggedAnimal = species === 'cattle' || species === 'sheep';
    const editNewTagFlag = species === 'cattle' && !!editDraft.newTagFlag;
    let updates = {weight: w, note: newNote || null};

    if (editingTaggedAnimal) {
      if (!newTag) {
        setErr('Tag is required.');
        return;
      }
      if (entryTagUsedByAnotherEntry(newTag, entry.id)) {
        setErr('Tag #' + newTag + ' is already weighed in this session.');
        return;
      }
      if (entry.target_processing_batch_id && newTag !== String(entry.tag || '')) {
        setErr('This entry is already attached to a processing batch. Remove that first before changing tag.');
        return;
      }
      const animal = findDirectoryAnimalByTag(newTag);
      if (species === 'sheep' && !animal) {
        setErr('Pick a sheep from this flock.');
        return;
      }
      if (species === 'cattle') {
        if (editNewTagFlag && animal) {
          setErr('Tag #' + newTag + ' is already assigned to a cow. Use existing tag instead of Missing Tag.');
          return;
        }
        if (!editNewTagFlag && !animal) {
          setErr('Pick an existing cow or mark this as Missing Tag.');
          return;
        }
      }
      let nextReconcileIntent = null;
      if (editNewTagFlag) nextReconcileIntent = 'replacement';
      else if (entry.reconcile_intent === 'new_cow' && newTag === String(entry.tag || '')) {
        nextReconcileIntent = 'new_cow';
      }
      updates = {
        tag: newTag,
        weight: w,
        note: newNote || null,
        new_tag_flag: editNewTagFlag,
        reconcile_intent: nextReconcileIntent,
      };
    }

    // Phase 1C-D — pig fresh: edit local entries[] only, no DB call. Locks
    // offline edit-before-Save-Draft (Codex review v3 #1).
    if (species === 'pig' && sessionIsFresh) {
      setEntries((prev) => prev.map((e) => (e.id === entry.id ? {...e, weight: w, note: newNote || null} : e)));
      setEditingEntryId(null);
      return;
    }

    setBusy(true);
    const {error} = await sb.from('weigh_ins').update(updates).eq('id', entry.id);
    if (error) {
      setBusy(false);
      setErr('Save failed: ' + error.message);
      return;
    }
    // Cattle: keep cattle_comments in sync with the entry's note. Delete any
    // prior comment, then re-insert if the new note is non-empty. Keeps the
    // cow's timeline accurate if a team member fat-fingers a note.
    if (species === 'cattle' && newTag) {
      try {
        await sb.from('cattle_comments').delete().eq('source', 'weigh_in').eq('reference_id', entry.id);
        if (newNote) {
          const cow = cattleList.find((c) => c.tag === newTag);
          await sb.from('cattle_comments').insert({
            id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
            cattle_id: cow ? cow.id : null,
            cattle_tag: newTag,
            comment: newNote,
            team_member: teamMember || null,
            source: 'weigh_in',
            reference_id: entry.id,
          });
        }
      } catch (e) {
        /* table may not exist yet */
      }
    }
    setEntries((prev) =>
      prev.map((e) => (e.id === entry.id ? {...e, ...updates, note: newNote || null, weight: w} : e)),
    );
    setEditingEntryId(null);
    setBusy(false);
  }
  async function deleteEntry(entry) {
    // This login-gated webform does not mount the App-scoped
    // _wcfConfirmDelete helper, so destructive flows use the local typed-
    // confirm modal wired through confirmDelete() above.
    if (!(await confirmDelete('Delete this entry? This cannot be undone.'))) return;

    // Phase 1C-D — pig fresh: drop from local entries[] only, no DB call.
    // Locks offline delete-before-Save-Draft (Codex review v3 #1).
    if (species === 'pig' && sessionIsFresh) {
      setEntries((prev) => prev.filter((e) => e.id !== entry.id));
      if (editingEntryId === entry.id) setEditingEntryId(null);
      return;
    }

    setBusy(true);
    // If this entry attached a cow/sheep to a processing batch, detach first
    // so batch detail rows and animal.processing_batch_id stay consistent.
    if (species === 'cattle' && entry.target_processing_batch_id) {
      const cow = entry.tag ? cattleList.find((c) => c.tag === entry.tag) : null;
      if (cow) {
        const r = await detachCattleFromProcessingBatch(sb, {
          cattleId: cow.id,
          batchId: entry.target_processing_batch_id,
          teamMember: teamMember || null,
        });
        if (!r.ok && r.reason !== 'not_in_batch') {
          const proceed = await confirmDelete(
            'Cow #' + (entry.tag || '?') + ' could not be auto-reverted (' + r.reason + '). Delete anyway?',
          );
          if (!proceed) {
            setBusy(false);
            return;
          }
        }
      }
    }
    if (species === 'sheep' && entry.target_processing_batch_id) {
      const sh = entry.tag ? sheepList.find((s) => s.tag === entry.tag) : null;
      if (sh) {
        const r = await detachSheepFromProcessingBatch(sb, {
          sheepId: sh.id,
          batchId: entry.target_processing_batch_id,
          teamMember: teamMember || null,
        });
        if (!r.ok && r.reason !== 'not_in_batch') {
          const proceed = await confirmDelete(
            'Sheep #' + (entry.tag || '?') + ' could not be auto-reverted (' + r.reason + '). Delete anyway?',
          );
          if (!proceed) {
            setBusy(false);
            return;
          }
        }
      }
    }
    // Cattle / sheep: clean up the linked comment before dropping the weigh-in.
    if (species === 'cattle') {
      try {
        await sb.from('cattle_comments').delete().eq('source', 'weigh_in').eq('reference_id', entry.id);
      } catch (e) {
        console.warn('cattle_comments weigh-in-delete cascade failed:', e);
      }
    }
    if (species === 'sheep') {
      try {
        await sb.from('sheep_comments').delete().eq('source', 'weigh_in').eq('reference_id', entry.id);
      } catch (e) {
        console.warn('sheep_comments weigh-in-delete cascade failed:', e);
      }
    }
    const {error} = await sb.from('weigh_ins').delete().eq('id', entry.id);
    if (error) {
      setBusy(false);
      setErr('Delete failed: ' + error.message);
      return;
    }
    setEntries((prev) => prev.filter((e) => e.id !== entry.id));
    if (editingEntryId === entry.id) setEditingEntryId(null);
    setBusy(false);
  }
  // Pig/broiler: the grid is the source of truth for the session.
  // Save = wipe existing weigh_ins for this session, then re-insert from the
  // current grid state. Lets users edit/clear filled cells in place without
  // creating duplicates. Empty cells are simply not written.
  // Returns true on success, false on error (caller can chain Complete safely).
  async function saveBatch() {
    if (!session) return false;
    var rows = [];
    for (var i = 0; i < weightInputs.length; i++) {
      var w = weightInputs[i];
      if (w === '' || isNaN(parseFloat(w)) || parseFloat(w) <= 0) continue;
      var colIdx = Math.floor(i / 15);
      var schooner = species === 'broiler' && columnLabels[colIdx] ? columnLabels[colIdx] : null;
      rows.push({weight: parseFloat(w), schooner: schooner});
    }
    setErr('');

    // Phase 1C-D — broiler fresh: route the whole grid through the offline
    // RPC. v1 RPC contract is status='draft' + species='broiler' allowlist
    // + broiler_week ∈ {4, 6} + non-empty entries. We pre-validate so the
    // operator gets clean inline errors instead of a 400 round-trip.
    if (species === 'broiler' && sessionIsFresh) {
      if (rows.length === 0) {
        setErr('Fill in at least one weight before saving.');
        return false;
      }
      if (broilerWeek !== 4 && broilerWeek !== 6) {
        setErr('Week must be 4 or 6.');
        return false;
      }
      setBusy(true);
      const stampNow = new Date().toISOString();
      const payloadEntries = rows.map((r) => ({
        weight: r.weight,
        tag: r.schooner,
        note: null,
        new_tag_flag: false,
        entered_at: stampNow,
      }));
      const trimmedNote = noteInput && noteInput.trim() ? noteInput.trim() : undefined;
      const payload = {
        species: 'broiler',
        date: session.date,
        team_member: session.team_member,
        batch_id: session.batch_id ?? null,
        broiler_week: broilerWeek,
        started_at: session.started_at,
        notes: trimmedNote,
        entries: payloadEntries,
      };
      try {
        const result = await submitDraftSession(payload);
        if (result.state === 'synced') {
          // Codex review #1 — convert fresh → DB-backed in place. Stay on
          // the grid so the existing online-only Complete path still works.
          const newId = result.record.args.parent_in.id;
          const newEntries = result.record.args.entries_in.map((e) => ({
            id: e.id,
            session_id: newId,
            tag: e.tag,
            weight: e.weight,
            note: e.note,
            new_tag_flag: !!e.new_tag_flag,
            entered_at: e.entered_at,
          }));
          setSession((prev) => ({...prev, id: newId}));
          setEntries(newEntries);
          setSessionIsFresh(false);
          setLastSubmitOutcome('synced');
          setBusy(false);
          return true;
        }
        if (result.state === 'queued') {
          // Codex review #2 — terminal screen reserved for queued only.
          setDoneState('queued');
          setBusy(false);
          return false;
        }
      } catch (e) {
        // Schema/validation throw from useOfflineRpcSubmit (PGRST/22*/23*/P0001).
        // Surface inline; do NOT enqueue.
        setErr('Could not save: ' + (e && e.message ? e.message : String(e)));
        setBusy(false);
        return false;
      }
      setBusy(false);
      return false;
    }

    setBusy(true);
    var del = await sb.from('weigh_ins').delete().eq('session_id', session.id);
    if (del.error) {
      setBusy(false);
      setErr('Save failed (clear): ' + del.error.message);
      return false;
    }
    var recs = [];
    if (rows.length > 0) {
      var t0 = Date.now();
      recs = rows.map(function (r, i) {
        return {
          id: String(t0 + i) + Math.random().toString(36).slice(2, 6),
          session_id: session.id,
          tag: r.schooner,
          weight: r.weight,
          note: null,
          new_tag_flag: false,
        };
      });
      var ins = await sb.from('weigh_ins').insert(recs);
      if (ins.error) {
        setBusy(false);
        setErr('Save failed (insert): ' + ins.error.message);
        return false;
      }
    }
    const sessionNote = noteInput && noteInput.trim() ? noteInput.trim() : null;
    const noteUp = await sb.from('weigh_in_sessions').update({notes: sessionNote}).eq('id', session.id);
    if (noteUp.error) {
      setBusy(false);
      setErr('Save failed (note): ' + noteUp.error.message);
      return false;
    }
    setEntries(recs);
    // No batch-avg write here -- saveBatch only runs while status='draft',
    // and stamp_broiler_batch_avg requires status='complete' to fire.
    setBusy(false);
    return true;
  }

  // Phase 1C-D — pig fresh-collection submit. Collects local entries[] into
  // one RPC call (parent + N atomic). On synced: converts fresh → DB-backed
  // in place so the existing online Complete path still works (Codex #1+#2).
  // On queued: terminal screen. On schema throw: inline error.
  async function saveDraftViaRpc() {
    if (!session) return;
    if (entries.length === 0) {
      setErr('Add at least one entry before saving the draft.');
      return;
    }
    setErr('');
    setBusy(true);
    const payloadEntries = entries.map((e) => ({
      weight: parseFloat(e.weight),
      tag: e.tag ?? null,
      note: e.note ?? null,
      new_tag_flag: !!e.new_tag_flag,
      entered_at: e.entered_at,
    }));
    const trimmedNote = noteInput && noteInput.trim() ? noteInput.trim() : undefined;
    const payload = {
      species,
      date: session.date,
      team_member: session.team_member,
      batch_id: session.batch_id ?? null,
      started_at: session.started_at,
      notes: trimmedNote,
      entries: payloadEntries,
    };
    try {
      const result = await submitDraftSession(payload);
      if (result.state === 'synced') {
        const newId = result.record.args.parent_in.id;
        setSession((prev) => ({...prev, id: newId}));
        setEntries((prev) =>
          prev.map((local, i) => ({
            ...local,
            id: result.record.args.entries_in[i].id,
            session_id: newId,
          })),
        );
        setSessionIsFresh(false);
        setLastSubmitOutcome('synced');
        setBusy(false);
        return;
      }
      if (result.state === 'queued') {
        setDoneState('queued');
        setBusy(false);
        return;
      }
    } catch (e) {
      setErr('Could not save: ' + (e && e.message ? e.message : String(e)));
      setBusy(false);
    }
  }

  // Cattle: list of remaining tags (sorted asc, weighed already removed)
  // Sheep parallel: tags in the selected flock not yet weighed this session.
  const sheepRemainingTags = (() => {
    if (species !== 'sheep' || !sheepFlock) return [];
    const weighed = new Set(entries.map((e) => e.tag).filter(Boolean));
    return sheepList.filter((s) => s.flock === sheepFlock && s.tag && !weighed.has(s.tag)).map((s) => s.tag);
  })();
  const sheepExpectedTags =
    species === 'sheep' && sheepFlock ? sheepList.filter((s) => s.flock === sheepFlock && s.tag).length : 0;

  const remainingTags = (() => {
    if (species !== 'cattle' || !cattleHerd) return [];
    const weighed = new Set(entries.map((e) => e.tag).filter(Boolean));
    return cattleList
      .filter((c) => c.herd === cattleHerd && c.tag && !weighed.has(c.tag))
      .map((c) => c.tag)
      .sort((a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0) || (a || '').localeCompare(b || ''));
  })();
  // Cows still un-accounted-for in this session (full records, not just tags) —
  // used as the diminishing dropdown when reconciling Replacement Tag entries.
  const remainingCows = (() => {
    if (species !== 'cattle' || !cattleHerd) return [];
    const weighed = new Set(entries.map((e) => e.tag).filter(Boolean));
    return cattleList
      .filter((c) => c.herd === cattleHerd && c.tag && !weighed.has(c.tag))
      .sort((a, b) => (parseFloat(a.tag) || 0) - (parseFloat(b.tag) || 0) || (a.tag || '').localeCompare(b.tag || ''));
  })();
  const pendingReconciles = entries.filter((e) => e.new_tag_flag === true);
  const expectedTags =
    species === 'cattle' && cattleHerd ? cattleList.filter((c) => c.herd === cattleHerd && c.tag).length : 0;
  const selectedCattle =
    species === 'cattle' && cattleHerd && tagInput
      ? cattleList.find((c) => c.herd === cattleHerd && c.tag === tagInput)
      : null;
  const selectedCattleIsBlacklisted = !!(selectedCattle && selectedCattle.breeding_blacklist);

  const wfBg = {
    minHeight: '100vh',
    background: 'var(--bg-page)',
    padding: '1rem',
    fontFamily: 'inherit',
  };
  const cardS = {
    background: 'white',
    borderRadius: 12,
    padding: '20px',
    marginBottom: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,.08)',
  };
  const inpS = {
    fontFamily: 'inherit',
    fontSize: 14,
    padding: '10px 12px',
    border: '1px solid var(--border-strong)',
    borderRadius: 10,
    width: '100%',
    outline: 'none',
    background: 'white',
    color: 'var(--ink)',
    boxSizing: 'border-box',
  };
  const blacklistOptionS = {backgroundColor: '#fee2e2', color: '#991b1b', fontWeight: 700};
  const blacklistSelectS = {
    backgroundColor: '#fee2e2',
    color: '#991b1b',
    border: '1px solid #f87171',
    fontWeight: 700,
  };
  const lblS = {display: 'block', fontSize: 13, color: 'var(--ink)', marginBottom: 5, fontWeight: 500};
  const logoEl = (
    <div style={{textAlign: 'center', marginBottom: 20}}>
      <div
        style={{
          fontSize: 18,
          fontWeight: 800,
          color: 'var(--ink)',
          letterSpacing: -0.3,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <PlannerIcon iconKey="weighins" size={22} />
        <span>WCF Planner</span>
      </div>
      <div style={{fontSize: 12, color: 'var(--ink-muted)', marginTop: 2}}>Weigh-Ins</div>
    </div>
  );

  // Phase 1C-D — stuck submission modal must surface on EVERY screen, not
  // only the session screen. Operator may land on /weighins at the species
  // picker with stuck rows from a prior offline session and never reach
  // the session screen if they don't start a new one. (Codex review v3 #2.)
  const stuckModalEl =
    stuckOpen && stuckRows.length > 0 ? (
      <StuckSubmissionsModal
        rows={stuckRows}
        formLabel="weigh-in draft session"
        describeRow={(row) => {
          const a = row && row.record && row.record.args;
          const sp = a && a.parent_in && a.parent_in.species;
          const bid = a && a.parent_in && a.parent_in.batch_id;
          const n = a && a.entries_in ? a.entries_in.length : 0;
          return `${sp || '?'} · ${bid || '?'} · ${n} ${n === 1 ? 'entry' : 'entries'} (not yet sent)`;
        }}
        onRetry={async (csid) => {
          await retryStuck(csid);
        }}
        onDiscard={async (csid) => {
          await discardStuck(csid);
        }}
        onClose={() => setStuckOpen(false)}
      />
    ) : null;

  // Typed-delete confirmation modal — rendered on every stage alongside the
  // stuck-submissions modal so destructive flows can resolve from any screen
  // the form is currently on.
  const deleteConfirmEl = deleteConfirmState ? (
    <DeleteModal
      msg={deleteConfirmState.message}
      onConfirm={deleteConfirmState.onConfirm}
      onCancel={deleteConfirmState.onCancel}
    />
  ) : null;

  // ── QUEUED-OFFLINE TERMINAL SCREEN (Phase 1C-D) ──
  // Set when the RPC submit returned state='queued'. Mirrors AddFeedWebform's
  // synced/queued copy — operator's draft is captured on-device and will
  // replay on next online event / 60s tick / next mount.
  if (doneState === 'queued')
    return (
      <div style={wfBg}>
        <div style={{maxWidth: 480, margin: '0 auto', paddingTop: '2rem', textAlign: 'center'}}>
          {logoEl}
          <div style={{fontSize: 56, marginBottom: 12}}>{'📡'}</div>
          <div style={{fontSize: 20, fontWeight: 700, color: '#92400e', marginBottom: 8}}>Saved on this device</div>
          <div
            data-submit-state="queued"
            style={{
              fontSize: 12,
              color: '#78716c',
              marginBottom: 12,
              lineHeight: 1.5,
              background: '#fef3c7',
              border: '1px solid #fde68a',
              borderRadius: 10,
              padding: '8px 12px',
              textAlign: 'left',
            }}
          >
            No connection right now. Your draft is queued and will sync as soon as the device is back online.
          </div>
          <div style={{fontSize: 14, color: 'var(--ink-muted)', marginBottom: 28, lineHeight: 1.6}}>
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'} captured.
          </div>
          {species !== 'broiler' && (
            <button
              onClick={() => {
                setStage('species');
                setSpecies('');
                setSession(null);
                setEntries([]);
                setSessionIsFresh(false);
                setDoneState('none');
                setLastSubmitOutcome(null);
                setCattleHerd('');
                setPigBatchId('');
                setBroilerBatchId('');
                setBroilerBatchLabel('');
                setNoteInput('');
                setWeightInputs(Array(30).fill(''));
              }}
              style={{
                width: '100%',
                padding: 14,
                borderRadius: 10,
                border: 'none',
                background: '#085041',
                color: 'white',
                fontSize: 15,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
                marginBottom: 10,
              }}
            >
              New Weigh-In
            </button>
          )}
          <button
            onClick={() => {
              window.location.hash = '#webforms';
              window.location.reload();
            }}
            style={{
              width: '100%',
              padding: 14,
              borderRadius: 10,
              border: '1px solid var(--border-strong)',
              background: 'white',
              color: 'var(--ink)',
              fontSize: 15,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Back to Forms
          </button>
        </div>
        {stuckModalEl}
        {deleteConfirmEl}
      </div>
    );

  // ── DONE SCREEN ──
  if (stage === 'done')
    return (
      <div style={wfBg}>
        <div style={{maxWidth: 480, margin: '0 auto', paddingTop: '2rem', textAlign: 'center'}}>
          {logoEl}
          <div style={{fontSize: 56, marginBottom: 12}}>{'\u2705'}</div>
          <div style={{fontSize: 20, fontWeight: 700, color: 'var(--ink)', marginBottom: 8}}>Session Complete</div>
          <div style={{fontSize: 14, color: 'var(--ink-muted)', marginBottom: 28, lineHeight: 1.6}}>
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'} saved.
            {species === 'cattle' && cattleHerd && expectedTags > 0 && entries.length < expectedTags && (
              <div style={{marginTop: 8, color: '#92400e'}}>
                {expectedTags - entries.length + ' tags in this herd were not weighed.'}
              </div>
            )}
          </div>
          {species !== 'broiler' && (
            <button
              onClick={() => {
                setStage('species');
                setSpecies('');
                setSession(null);
                setEntries([]);
                setSessionIsFresh(false);
                setDoneState('none');
                setLastSubmitOutcome(null);
                setCattleHerd('');
                setPigBatchId('');
                setBroilerBatchId('');
                setBroilerBatchLabel('');
              }}
              style={{
                width: '100%',
                padding: 14,
                borderRadius: 10,
                border: 'none',
                background: '#085041',
                color: 'white',
                fontSize: 15,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
                marginBottom: 10,
              }}
            >
              New Weigh-In
            </button>
          )}
          <button
            onClick={() => {
              window.location.hash = '#webforms';
              window.location.reload();
            }}
            style={{
              width: '100%',
              padding: 14,
              borderRadius: 10,
              border: '1px solid var(--border-strong)',
              background: 'white',
              color: 'var(--ink)',
              fontSize: 15,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Back to Forms
          </button>
        </div>
        {stuckModalEl}
        {deleteConfirmEl}
      </div>
    );

  // ── SPECIES PICKER ──
  if (stage === 'species')
    return (
      <div style={wfBg}>
        <div style={{maxWidth: 480, margin: '0 auto', paddingTop: '1rem'}}>
          {logoEl}
          <div style={{fontSize: 13, color: 'var(--ink-muted)', textAlign: 'center', marginBottom: 20}}>
            Pick what you{'\u2019'}re weighing
          </div>
          {[
            {
              key: 'cattle',
              iconKey: ANIMAL_ICON_KEYS.cattle,
              label: 'Cattle',
              desc: 'Per-cow weigh-in with session autosave',
            },
            {
              key: 'sheep',
              iconKey: ANIMAL_ICON_KEYS.sheep,
              label: 'Sheep',
              desc: 'Per-sheep weigh-in with session autosave',
            },
            {
              key: 'pig',
              iconKey: ANIMAL_ICON_KEYS.pig,
              label: 'Pig',
              desc: 'Feeder batch \u2014 weigh several pigs at once',
            },
            {
              key: 'broiler',
              iconKey: ANIMAL_ICON_KEYS.broiler,
              label: 'Broiler',
              desc: '4-week or 6-week weighings, ~15 birds',
            },
          ].map((s) => (
            // F049: species cards are white with a gray border. Identity is shown
            // by the species icon + a small program dot beside the black title \u2014
            // no colored headings, desc text, chevron, or tinted border.
            <div
              key={s.key}
              {...openableProps(() => {
                setSpecies(s.key);
                setStage('select');
              })}
              className="hoverable-tile"
              style={{
                background: 'white',
                borderRadius: 12,
                padding: '18px 20px',
                marginBottom: 10,
                cursor: 'pointer',
                boxShadow: '0 1px 3px rgba(0,0,0,.08)',
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                border: '1px solid var(--border)',
              }}
            >
              <PlannerIcon iconKey={s.iconKey} size={32} />
              <div style={{flex: 1}}>
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 16,
                    fontWeight: 700,
                    color: 'var(--text-primary)',
                  }}
                >
                  <span style={programDotStyle(s.key)} />
                  {s.label}
                </div>
                <div style={{fontSize: 12, color: 'var(--ink-muted)'}}>{s.desc}</div>
              </div>
              <div style={{color: 'var(--ink-faint)', fontSize: 18}}>{'\u203a'}</div>
            </div>
          ))}
          <div style={{textAlign: 'center', marginTop: 16}}>
            <button
              onClick={() => {
                window.location.hash = '#webforms';
                window.location.reload();
              }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--ink-muted)',
                fontSize: 13,
                cursor: 'pointer',
                fontFamily: 'inherit',
                textDecoration: 'underline',
              }}
            >
              {'\u2190 Back to Daily Reports'}
            </button>
          </div>
        </div>
        {stuckModalEl}
        {deleteConfirmEl}
      </div>
    );

  // ── SETUP / RESUME SCREEN — shown for all species ──
  if (stage === 'select')
    return (
      <div style={wfBg}>
        <div style={{maxWidth: 480, margin: '0 auto', paddingTop: '1rem'}}>
          {logoEl}
          <button
            onClick={() => {
              setStage('species');
              setSpecies('');
            }}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--ink-muted)',
              fontSize: 13,
              cursor: 'pointer',
              marginBottom: 12,
              padding: 0,
              fontFamily: 'inherit',
            }}
          >
            {'\u2039 Back'}
          </button>
          <PlannerIconLabel
            iconKey={
              species === 'cattle'
                ? ANIMAL_ICON_KEYS.cattle
                : species === 'sheep'
                  ? ANIMAL_ICON_KEYS.sheep
                  : species === 'pig'
                    ? ANIMAL_ICON_KEYS.pig
                    : ANIMAL_ICON_KEYS.broiler
            }
            size={20}
            gap={8}
            style={{fontSize: 17, fontWeight: 700, color: 'var(--ink)', marginBottom: 16}}
          >
            {species === 'cattle' ? 'Cattle' : species === 'sheep' ? 'Sheep' : species === 'pig' ? 'Pig' : 'Broiler'}{' '}
            Weigh-In
          </PlannerIconLabel>

          {drafts.length > 0 && (
            <div style={cardS}>
              <div style={{fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 8}}>
                Resume a draft session
              </div>
              {drafts.map((d) => (
                <div
                  key={d.id}
                  {...openableProps(() => resumeSession(d))}
                  style={{
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    padding: '10px 12px',
                    marginBottom: 6,
                    cursor: 'pointer',
                  }}
                  className="hoverable-tile"
                >
                  <div style={{fontSize: 13, fontWeight: 600, color: 'var(--ink)'}}>
                    {d.species === 'cattle' || d.species === 'sheep'
                      ? d.herd || '?'
                      : d.species === 'broiler'
                        ? (d.batch_id || '?') + (d.broiler_week ? ' \u00b7 wk ' + d.broiler_week : '')
                        : d.batch_id || '?'}
                  </div>
                  <div style={{fontSize: 11, color: 'var(--ink-muted)'}}>
                    {fmt(d.date)} {'\u00b7'} {d.team_member} {'\u00b7'} started {(d.started_at || '').slice(11, 16)}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={cardS}>
            <div style={{fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 8}}>Start a new session</div>
            <div style={{marginBottom: 10}}>
              <label style={lblS}>Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inpS} />
            </div>
            <div style={{marginBottom: 10}}>
              <LockedSubmitter name={lockedName} label="Team member" labelStyle={lblS} />
            </div>

            {species === 'cattle' && (
              <React.Fragment>
                <div style={{marginBottom: 10}}>
                  <label style={lblS} htmlFor="weighins-cattle-herd">
                    Herd *
                  </label>
                  <select
                    id="weighins-cattle-herd"
                    value={cattleHerd}
                    onChange={(e) => setCattleHerd(e.target.value)}
                    style={inpS}
                  >
                    <option value="">Select herd...</option>
                    <option value="mommas">Mommas</option>
                    <option value="backgrounders">Backgrounders</option>
                    <option value="finishers">Finishers</option>
                    <option value="bulls">Bulls</option>
                  </select>
                  {cattleHerd && expectedTags > 0 && (
                    <div style={{fontSize: 11, color: 'var(--ink-muted)', marginTop: 4}}>
                      {expectedTags + ' cows in this herd to weigh'}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => startNewSession({herd: cattleHerd})}
                  disabled={busy || !teamMember || !cattleHerd}
                  style={{
                    width: '100%',
                    padding: 13,
                    borderRadius: 10,
                    border: 'none',
                    background: busy || !teamMember || !cattleHerd ? '#9ca3af' : '#085041',
                    color: 'white',
                    fontSize: 15,
                    fontWeight: 600,
                    cursor: busy || !teamMember || !cattleHerd ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {busy ? 'Starting\u2026' : 'Start Session'}
                </button>
              </React.Fragment>
            )}

            {species === 'pig' && (
              <React.Fragment>
                <div style={{marginBottom: 10}}>
                  <label style={lblS} htmlFor="weighins-pig-batch">
                    Pig Batch *
                  </label>
                  <select
                    id="weighins-pig-batch"
                    value={pigBatchId}
                    onChange={(e) => setPigBatchId(e.target.value)}
                    style={inpS}
                  >
                    <option value="">Select batch...</option>
                    {pigBatches.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={() => startNewSession({batch_id: pigBatchId})}
                  disabled={busy || !teamMember || !pigBatchId}
                  style={{
                    width: '100%',
                    padding: 13,
                    borderRadius: 10,
                    border: 'none',
                    background: busy || !teamMember || !pigBatchId ? '#9ca3af' : '#085041',
                    color: 'white',
                    fontSize: 15,
                    fontWeight: 600,
                    cursor: busy || !teamMember || !pigBatchId ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {busy ? 'Starting\u2026' : 'Start Session'}
                </button>
              </React.Fragment>
            )}

            {species === 'broiler' && (
              <React.Fragment>
                <div
                  style={{marginBottom: 10}}
                  data-weighins-broiler-meta-loaded={broilerBatchMetaLoaded ? '1' : undefined}
                >
                  <label style={lblS} htmlFor="weighins-broiler-batch">
                    Broiler Batch *
                  </label>
                  <select
                    id="weighins-broiler-batch"
                    value={broilerBatchLabel}
                    onChange={(e) => {
                      setBroilerBatchLabel(e.target.value);
                      setBroilerBatchId(e.target.value);
                    }}
                    style={inpS}
                  >
                    <option value="">Select batch...</option>
                    {broilerBatches.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{marginBottom: 10}}>
                  <label style={lblS}>Week *</label>
                  <div
                    style={{
                      display: 'flex',
                      borderRadius: 10,
                      overflow: 'hidden',
                      border: '1px solid var(--border-strong)',
                    }}
                  >
                    {[4, 6].map((w) => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => setBroilerWeek(w)}
                        style={{
                          flex: 1,
                          padding: '10px 0',
                          border: broilerWeek === w ? '1px solid var(--brand)' : '1px solid var(--border-strong)',
                          fontFamily: 'inherit',
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: 'pointer',
                          background: 'white',
                          color: broilerWeek === w ? 'var(--brand)' : 'var(--ink-muted)',
                        }}
                      >
                        {'Week ' + w}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => startNewSession({batch_id: broilerBatchLabel, broiler_week: broilerWeek})}
                  disabled={busy || !teamMember || !broilerBatchLabel}
                  style={{
                    width: '100%',
                    padding: 13,
                    borderRadius: 10,
                    border: 'none',
                    background: busy || !teamMember || !broilerBatchLabel ? '#9ca3af' : '#085041',
                    color: 'white',
                    fontSize: 15,
                    fontWeight: 600,
                    cursor: busy || !teamMember || !broilerBatchLabel ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {busy ? 'Starting\u2026' : 'Start Session'}
                </button>
              </React.Fragment>
            )}

            {species === 'sheep' && (
              <React.Fragment>
                <div style={{marginBottom: 10}}>
                  <label style={lblS} htmlFor="weighins-sheep-flock">
                    Flock *
                  </label>
                  <select
                    id="weighins-sheep-flock"
                    value={sheepFlock}
                    onChange={(e) => setSheepFlock(e.target.value)}
                    style={inpS}
                  >
                    <option value="">Select flock...</option>
                    <option value="rams">Rams</option>
                    <option value="ewes">Ewes</option>
                    <option value="feeders">Feeders</option>
                  </select>
                  {sheepFlock && sheepExpectedTags > 0 && (
                    <div style={{fontSize: 11, color: 'var(--ink-muted)', marginTop: 4}}>
                      {sheepExpectedTags + ' sheep in this flock to weigh'}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => startNewSession({herd: sheepFlock})}
                  disabled={busy || !teamMember || !sheepFlock}
                  style={{
                    width: '100%',
                    padding: 13,
                    borderRadius: 10,
                    border: 'none',
                    background: busy || !teamMember || !sheepFlock ? '#9ca3af' : '#085041',
                    color: 'white',
                    fontSize: 15,
                    fontWeight: 600,
                    cursor: busy || !teamMember || !sheepFlock ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {busy ? 'Starting\u2026' : 'Start Session'}
                </button>
              </React.Fragment>
            )}

            {err && (
              <div
                style={{
                  color: '#b91c1c',
                  fontSize: 13,
                  marginTop: 10,
                  padding: '8px 12px',
                  background: '#fef2f2',
                  borderRadius: 10,
                }}
              >
                {err}
              </div>
            )}
          </div>
        </div>
        {stuckModalEl}
        {deleteConfirmEl}
      </div>
    );

  // ── SESSION SCREEN — adding entries ──
  if (stage === 'session' && session)
    return (
      <div style={wfBg}>
        <div style={{maxWidth: 640, margin: '0 auto', paddingTop: '1rem'}}>
          {logoEl}
          <div style={cardS}>
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10}}>
              <div>
                <div style={{fontSize: 14, fontWeight: 700, color: 'var(--ink)'}}>
                  {species === 'cattle' || species === 'sheep'
                    ? session.herd || '?'
                    : species === 'broiler'
                      ? (session.batch_id || '?') + ' \u00b7 wk ' + session.broiler_week
                      : session.batch_id || '?'}
                </div>
                <div style={{fontSize: 11, color: 'var(--ink-muted)'}}>
                  {fmt(session.date)} {'\u00b7'} {session.team_member}
                </div>
              </div>
              <div style={{textAlign: 'right'}}>
                <div style={{fontSize: 18, fontWeight: 700, color: 'var(--ink)'}}>{entries.length}</div>
                <div style={{fontSize: 10, color: 'var(--ink-muted)'}}>
                  {species === 'cattle'
                    ? 'of ' + expectedTags
                    : species === 'sheep'
                      ? 'of ' + sheepExpectedTags
                      : 'entries'}
                </div>
              </div>
            </div>
          </div>

          {species === 'cattle' && (
            <div style={cardS}>
              {entryMode === 'normal' && (
                <React.Fragment>
                  <div style={{marginBottom: 10}}>
                    <label style={lblS}>Tag #</label>
                    <select
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      style={selectedCattleIsBlacklisted ? {...inpS, ...blacklistSelectS} : inpS}
                      data-selected-breeding-blacklist={selectedCattleIsBlacklisted ? '1' : undefined}
                    >
                      <option value="">Select tag... ({remainingTags.length} remaining)</option>
                      {remainingTags.map((t) => {
                        const cow = cattleList.find((c) => c.tag === t && c.herd === cattleHerd);
                        return (
                          <option
                            key={t}
                            value={t}
                            data-breeding-blacklist-option={cow && cow.breeding_blacklist ? '1' : undefined}
                            style={cow && cow.breeding_blacklist ? blacklistOptionS : undefined}
                          >
                            {cow ? formatAnimalOption(cow, session && session.date) : '#' + t}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  <div style={{display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap'}}>
                    <button
                      type="button"
                      onClick={() => {
                        setEntryMode('new_cow');
                        setTagInput('');
                        setNewCowSex('cow');
                        setNewCowBirthDate('');
                        setPriorTagInput('');
                      }}
                      style={{
                        // WI-2d: these three tag-mode triggers share one neutral
                        // secondary style — dashed gray border, black ink — instead
                        // of ad-hoc per-mode green/blue/amber.
                        flex: '1 1 120px',
                        padding: 8,
                        borderRadius: 10,
                        border: '1px dashed var(--border-strong)',
                        background: 'transparent',
                        color: 'var(--ink)',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      + New Cow
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        // Swap Tag requires an existing cow to swap. If no tag
                        // is picked in the dropdown, warn and bail instead of
                        // entering retag mode with a blank prior tag.
                        if (!tagInput) {
                          setErr('Pick a cow from the tag dropdown above first, then click Swap Tag.');
                          return;
                        }
                        const selected = tagInput;
                        setEntryMode('retag');
                        setNewCowBirthDate('');
                        setPriorTagInput(selected);
                        setTagInput('');
                      }}
                      style={{
                        flex: '1 1 120px',
                        padding: 8,
                        borderRadius: 10,
                        border: '1px dashed var(--border-strong)',
                        background: 'transparent',
                        color: 'var(--ink)',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: tagInput ? 'pointer' : 'not-allowed',
                        fontFamily: 'inherit',
                        opacity: tagInput ? 1 : 0.5,
                      }}
                    >
                      {'\u21bb Swap Tag'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEntryMode('replacement');
                        setTagInput('');
                        setNewCowBirthDate('');
                        setPriorTagInput('');
                      }}
                      style={{
                        flex: '1 1 120px',
                        padding: 8,
                        borderRadius: 10,
                        border: '1px dashed var(--border-strong)',
                        background: 'transparent',
                        color: 'var(--ink)',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      + Missing Tag
                    </button>
                  </div>
                </React.Fragment>
              )}
              {entryMode === 'new_cow' && (
                <div
                  style={{
                    marginBottom: 10,
                    padding: 10,
                    background: 'white',
                    borderRadius: 10,
                    // WI-2c: drop the colored left-border accent; uniform gray border.
                    border: '1px solid var(--border)',
                  }}
                >
                  <div
                    style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6}}
                  >
                    <div style={{fontSize: 11, fontWeight: 700, color: 'var(--text-primary)'}}>
                      {'\u2795 New Cow'}
                      <span style={{fontWeight: 400, color: 'var(--ink)'}}>
                        {' \u00b7 will be created in ' + (cattleHerd || 'this herd')}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setEntryMode('normal');
                        setTagInput('');
                        setNewCowBirthDate('');
                        setPriorTagInput('');
                        setErr('');
                      }}
                      style={{
                        padding: '3px 9px',
                        borderRadius: 10,
                        border: '1px solid #6b7280',
                        background: 'white',
                        color: 'var(--ink)',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      {'\u2715 Cancel'}
                    </button>
                  </div>
                  <div style={{marginBottom: 8}}>
                    <label style={lblS}>New tag # *</label>
                    <input
                      type="text"
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      placeholder="e.g. 99"
                      style={inpS}
                    />
                  </div>
                  <div style={{marginBottom: 8}}>
                    <label style={lblS}>Sex *</label>
                    <div
                      style={{
                        display: 'flex',
                        borderRadius: 10,
                        overflow: 'hidden',
                        border: '1px solid var(--border-strong)',
                      }}
                    >
                      {['cow', 'heifer', 'bull', 'steer'].map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setNewCowSex(s)}
                          style={{
                            flex: 1,
                            padding: '8px 0',
                            border: newCowSex === s ? '1px solid var(--brand)' : '1px solid var(--border-strong)',
                            fontFamily: 'inherit',
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: 'pointer',
                            background: 'white',
                            color: newCowSex === s ? 'var(--brand)' : 'var(--ink-muted)',
                            textTransform: 'capitalize',
                          }}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={{marginBottom: 8}}>
                    <label style={lblS}>
                      DOB <span style={{fontSize: 10, color: 'var(--ink-faint)'}}>(optional)</span>
                    </label>
                    <input
                      type="date"
                      value={newCowBirthDate}
                      onChange={(e) => setNewCowBirthDate(e.target.value)}
                      style={inpS}
                    />
                  </div>
                </div>
              )}
              {entryMode === 'retag' && (
                <div
                  style={{
                    marginBottom: 10,
                    padding: 10,
                    background: 'white',
                    borderRadius: 10,
                    // WI-2c: drop the colored left-border accent; uniform gray border.
                    border: '1px solid var(--border)',
                  }}
                >
                  <div
                    style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6}}
                  >
                    <div style={{fontSize: 11, fontWeight: 700, color: 'var(--text-primary)'}}>
                      {'\u21bb Swap Tag'}
                      <span style={{fontWeight: 400, color: 'var(--ink)'}}>
                        {' \u00b7 swap a known cow\u2019s tag on the spot'}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setEntryMode('normal');
                        setTagInput('');
                        setNewCowBirthDate('');
                        setPriorTagInput('');
                        setErr('');
                      }}
                      style={{
                        padding: '3px 9px',
                        borderRadius: 10,
                        border: '1px solid #6b7280',
                        background: 'white',
                        color: 'var(--ink)',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      {'\u2715 Cancel'}
                    </button>
                  </div>
                  <div style={{marginBottom: 8}}>
                    <label style={lblS}>
                      Prior tag # *
                      <span style={{fontSize: 10, color: 'var(--ink-faint)', fontWeight: 400}}>
                        {' \u00b7 selling-farm or older WCF tag'}
                      </span>
                    </label>
                    <input
                      type="text"
                      value={priorTagInput}
                      onChange={(e) => setPriorTagInput(e.target.value)}
                      placeholder="e.g. 59"
                      style={inpS}
                    />
                  </div>
                  <div style={{marginBottom: 0}}>
                    <label style={lblS}>New tag # *</label>
                    <input
                      type="text"
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      placeholder="e.g. 354"
                      style={inpS}
                    />
                  </div>
                </div>
              )}
              {entryMode === 'replacement' && (
                <div
                  style={{
                    marginBottom: 10,
                    padding: 10,
                    background: 'white',
                    borderRadius: 10,
                    // WI-2c: drop the colored left-border accent; uniform gray border.
                    border: '1px solid var(--border)',
                  }}
                >
                  <div
                    style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6}}
                  >
                    <div style={{fontSize: 11, fontWeight: 700, color: 'var(--text-primary)'}}>
                      {'\u26a0\ufe0f Missing Tag'}
                      <span style={{fontWeight: 400, color: 'var(--ink)'}}>
                        {' \u00b7 reconcile later if cow is unknown now'}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setEntryMode('normal');
                        setTagInput('');
                        setNewCowBirthDate('');
                        setErr('');
                      }}
                      style={{
                        padding: '3px 9px',
                        borderRadius: 10,
                        border: '1px solid #6b7280',
                        background: 'white',
                        color: 'var(--ink)',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      {'\u2715 Cancel'}
                    </button>
                  </div>
                  <label style={lblS}>New tag # *</label>
                  <input
                    type="text"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    placeholder="e.g. 99"
                    style={inpS}
                  />
                </div>
              )}
              <div style={{marginBottom: 10}}>
                <label style={lblS}>Weight (lbs) *</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={weightInput}
                  onChange={(e) => setWeightInput(e.target.value)}
                  placeholder="0"
                  style={inpS}
                />
              </div>
              <div style={{marginBottom: 10}}>
                <label style={lblS}>
                  Note{' '}
                  <span style={{fontSize: 10, color: 'var(--ink-faint)'}}>
                    (saves to cow{'\u2019'}s comment timeline)
                  </span>
                </label>
                <textarea
                  value={noteInput}
                  onChange={(e) => setNoteInput(e.target.value)}
                  rows={2}
                  placeholder="Optional"
                  style={{...inpS, resize: 'vertical'}}
                />
              </div>
              {err && (
                <div
                  style={{
                    color: '#b91c1c',
                    fontSize: 13,
                    marginBottom: 10,
                    padding: '8px 12px',
                    background: '#fef2f2',
                    borderRadius: 10,
                  }}
                >
                  {err}
                </div>
              )}
              <button
                onClick={() =>
                  saveEntry({
                    tag: tagInput,
                    weight: weightInput,
                    note: noteInput,
                    mode: entryMode,
                    sex: newCowSex,
                    birthDate: newCowBirthDate,
                    priorTag: priorTagInput,
                  })
                }
                disabled={busy || !tagInput || !weightInput}
                style={{
                  width: '100%',
                  padding: 13,
                  borderRadius: 10,
                  border: 'none',
                  background: busy || !tagInput || !weightInput ? '#9ca3af' : '#085041',
                  color: 'white',
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: busy || !tagInput || !weightInput ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {busy ? 'Saving\u2026' : 'Save Entry'}
              </button>
            </div>
          )}

          {species === 'sheep' && (
            <div style={cardS}>
              <div style={{marginBottom: 10}}>
                <label style={lblS}>Tag #</label>
                <select value={tagInput} onChange={(e) => setTagInput(e.target.value)} style={inpS}>
                  <option value="">Select tag... ({sheepRemainingTags.length} remaining)</option>
                  {sheepRemainingTags.map((t) => {
                    const sh = sheepList.find((s) => s.tag === t && s.flock === sheepFlock);
                    return (
                      <option key={t} value={t}>
                        {sh ? formatAnimalOption(sh, session && session.date) : '#' + t}
                      </option>
                    );
                  })}
                </select>
              </div>
              <div style={{marginBottom: 10}}>
                <label style={lblS}>Weight (lbs) *</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={weightInput}
                  onChange={(e) => setWeightInput(e.target.value)}
                  placeholder="0"
                  style={inpS}
                />
              </div>
              <div style={{marginBottom: 10}}>
                <label style={lblS}>
                  Note <span style={{fontSize: 10, color: 'var(--ink-faint)'}}>(saves to sheep comment timeline)</span>
                </label>
                <textarea
                  value={noteInput}
                  onChange={(e) => setNoteInput(e.target.value)}
                  rows={2}
                  placeholder="Optional"
                  style={{...inpS, resize: 'vertical'}}
                />
              </div>
              {err && (
                <div
                  style={{
                    color: '#b91c1c',
                    fontSize: 13,
                    marginBottom: 10,
                    padding: '8px 12px',
                    background: '#fef2f2',
                    borderRadius: 10,
                  }}
                >
                  {err}
                </div>
              )}
              <button
                onClick={() => saveEntry({tag: tagInput, weight: weightInput, note: noteInput, mode: 'normal'})}
                disabled={busy || !tagInput || !weightInput}
                style={{
                  width: '100%',
                  padding: 13,
                  borderRadius: 10,
                  border: 'none',
                  background: busy || !tagInput || !weightInput ? '#9ca3af' : '#085041',
                  color: 'white',
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: busy || !tagInput || !weightInput ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {busy ? 'Saving\u2026' : 'Save Entry'}
              </button>
            </div>
          )}

          {species === 'pig' && (
            <div style={cardS}>
              <div style={{marginBottom: 10}}>
                <label style={lblS}>Weight (lbs) *</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={weightInput}
                  onChange={(e) => setWeightInput(e.target.value)}
                  placeholder="0"
                  style={inpS}
                />
              </div>
              <div style={{marginBottom: 10}}>
                <label style={lblS}>
                  Note <span style={{fontSize: 10, color: 'var(--ink-faint)'}}>(optional)</span>
                </label>
                <textarea
                  value={noteInput}
                  onChange={(e) => setNoteInput(e.target.value)}
                  rows={2}
                  placeholder="Optional"
                  style={{...inpS, resize: 'vertical'}}
                />
              </div>
              {err && (
                <div
                  style={{
                    color: '#b91c1c',
                    fontSize: 13,
                    marginBottom: 10,
                    padding: '8px 12px',
                    background: '#fef2f2',
                    borderRadius: 10,
                  }}
                >
                  {err}
                </div>
              )}
              {sessionIsFresh && (
                <div style={{fontSize: 11, color: '#78716c', marginBottom: 8, fontStyle: 'italic'}}>
                  Saving on this device — submit at the end with Save Draft.
                </div>
              )}
              <button
                onClick={() => saveEntry({tag: null, weight: weightInput, note: noteInput, mode: 'normal'})}
                disabled={busy || !weightInput}
                style={{
                  width: '100%',
                  padding: 13,
                  borderRadius: 10,
                  border: 'none',
                  background: busy || !weightInput ? '#9ca3af' : '#085041',
                  color: 'white',
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: busy || !weightInput ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {busy ? 'Saving…' : sessionIsFresh ? 'Add Entry' : 'Save Entry'}
              </button>
            </div>
          )}

          {species === 'broiler' && (
            <div style={cardS}>
              <label style={lblS}>Bird weights (lbs)</label>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(' + columnLabels.length + ', 1fr)',
                  gap: 8,
                  marginBottom: 12,
                }}
              >
                {columnLabels.map((label, col) => (
                  <div key={col}>
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: 'var(--ink)',
                        textAlign: 'center',
                        padding: '4px 0',
                        marginBottom: 4,
                        background: 'var(--surface-2)',
                        borderRadius: 10,
                      }}
                    >
                      {species === 'broiler' ? 'Schooner ' + label : 'Col ' + label}
                    </div>
                    {Array.from({length: 15}).map((_, row) => {
                      var idx = col * 15 + row;
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
                            value={weightInputs[idx] || ''}
                            onChange={(e) => {
                              var v = e.target.value;
                              setWeightInputs(function (prev) {
                                var next = prev.slice();
                                next[idx] = v;
                                return next;
                              });
                            }}
                            placeholder="0"
                            style={{...inpS, padding: '6px 8px', fontSize: 13}}
                          />
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
              <div style={{marginBottom: 10}}>
                <label style={lblS}>
                  Session note{' '}
                  <span style={{fontSize: 10, color: 'var(--ink-faint)'}}>(one note for this whole session)</span>
                </label>
                <textarea
                  value={noteInput}
                  onChange={(e) => setNoteInput(e.target.value)}
                  rows={2}
                  placeholder="Optional"
                  style={{...inpS, resize: 'vertical'}}
                />
              </div>
              {err && (
                <div
                  style={{
                    color: '#b91c1c',
                    fontSize: 13,
                    marginBottom: 10,
                    padding: '8px 12px',
                    background: '#fef2f2',
                    borderRadius: 10,
                  }}
                >
                  {err}
                </div>
              )}
              <button
                onClick={saveBatch}
                disabled={busy}
                style={{
                  width: '100%',
                  padding: 13,
                  borderRadius: 10,
                  border: 'none',
                  background: busy ? '#9ca3af' : '#085041',
                  color: 'white',
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: busy ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {busy ? 'Saving\u2026' : 'Save Weights'}
              </button>
            </div>
          )}

          {/* Pig session metrics (mig 049 RPC). Codex W1: only render once
            entries.length >= 1. Gates inside the effect mirror the same
            condition; available=false (RPC error or scope-closed) renders
            a single "Metrics unavailable" line instead of the four-metric
            grid. */}
          {species === 'pig' && entries.length >= 1 && pigMetrics && (
            <div style={cardS}>
              <div style={{fontSize: 12, fontWeight: 700, color: 'var(--ink-muted)', marginBottom: 8}}>
                Session metrics
              </div>
              {pigMetrics.available ? (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                    gap: 8,
                  }}
                >
                  <div data-pig-metric="age">
                    <div style={{fontSize: 10, color: 'var(--ink-muted)', textTransform: 'uppercase'}}>
                      Age at weigh-in
                    </div>
                    <div style={{fontSize: 14, fontWeight: 700, color: 'var(--ink)'}}>
                      {formatAgeRange({
                        minDays: pigMetrics.age_min_days,
                        maxDays: pigMetrics.age_max_days,
                        hasActual: pigMetrics.has_actual_farrowing,
                      })}
                    </div>
                  </div>
                  <div data-pig-metric="feed">
                    <div style={{fontSize: 10, color: 'var(--ink-muted)', textTransform: 'uppercase'}}>Feed/pig</div>
                    <div style={{fontSize: 14, fontWeight: 700, color: 'var(--ink)'}}>
                      {formatFeedPerPig(pigMetrics.feed_per_pig_lbs)}
                    </div>
                  </div>
                  <div data-pig-metric="adg">
                    <div style={{fontSize: 10, color: 'var(--ink-muted)', textTransform: 'uppercase'}}>Group ADG</div>
                    <div style={{fontSize: 14, fontWeight: 700, color: 'var(--ink)'}}>
                      {formatGroupAdg(pigMetrics.group_adg_lbs_per_day)}
                    </div>
                  </div>
                  <div data-pig-metric="avg">
                    <div style={{fontSize: 10, color: 'var(--ink-muted)', textTransform: 'uppercase'}}>Avg weight</div>
                    <div style={{fontSize: 14, fontWeight: 700, color: 'var(--ink)'}}>
                      {formatAvgWeight(pigMetrics.avg_weight_lbs)}
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{fontSize: 12, color: 'var(--ink-muted)', fontStyle: 'italic'}}>Metrics unavailable</div>
              )}
            </div>
          )}

          {/* Recent entries (pig) — no tag / age / ADG, just numbered weights.
            Entry # = insertion order (assigned BEFORE the descending-by-weight
            sort so #1 stays the first-entered pig). Display order is weight
            descending; ties break by lower #N for stable visual ordering.
            All entries are rendered (no slice cap) — the operator needs the
            full session count visible mid-weigh. Delete/edit pins by id, not
            index, so list-length is purely a render concern. */}
          {species === 'pig' &&
            entries.length > 0 &&
            (() => {
              const numbered = entries.map((e, i) => ({...e, _entryNum: i + 1}));
              const displayed = [...numbered].sort((a, b) => {
                const wa = parseFloat(a.weight) || 0;
                const wb = parseFloat(b.weight) || 0;
                if (wa !== wb) return wb - wa;
                return a._entryNum - b._entryNum;
              });
              return (
                <div style={cardS}>
                  <div style={{fontSize: 12, fontWeight: 700, color: 'var(--ink-muted)', marginBottom: 8}}>
                    {'Recent entries (' + entries.length + ')'}
                  </div>
                  {displayed.map((e) => {
                    const entryNum = e._entryNum;
                    const isEditing = editingEntryId === e.id;
                    if (isEditing)
                      return (
                        <div
                          key={e.id}
                          style={{
                            padding: '8px 0',
                            borderBottom: '1px solid var(--divider)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                          }}
                        >
                          <div style={{display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap'}}>
                            <span style={{fontWeight: 700, color: 'var(--ink)', minWidth: 40, fontSize: 12}}>
                              #{entryNum}
                            </span>
                            <input
                              type="number"
                              min="0"
                              step="0.1"
                              value={editDraft.weight}
                              onChange={(ev) => setEditDraft((d) => ({...d, weight: ev.target.value}))}
                              placeholder="lb"
                              style={{
                                fontSize: 13,
                                padding: '6px 10px',
                                border: '1px solid var(--border-strong)',
                                borderRadius: 10,
                                fontFamily: 'inherit',
                                width: 90,
                              }}
                            />
                            <input
                              type="text"
                              value={editDraft.note}
                              onChange={(ev) => setEditDraft((d) => ({...d, note: ev.target.value}))}
                              placeholder="Note (optional)"
                              style={{
                                fontSize: 13,
                                padding: '6px 10px',
                                border: '1px solid var(--border-strong)',
                                borderRadius: 10,
                                fontFamily: 'inherit',
                                flex: 1,
                                minWidth: 100,
                              }}
                            />
                          </div>
                          <div style={{display: 'flex', gap: 6, justifyContent: 'flex-end'}}>
                            <button
                              onClick={() => setEditingEntryId(null)}
                              style={{
                                padding: '5px 12px',
                                borderRadius: 10,
                                border: '1px solid var(--border-strong)',
                                background: 'white',
                                color: 'var(--ink-muted)',
                                fontSize: 12,
                                cursor: 'pointer',
                                fontFamily: 'inherit',
                              }}
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => saveEditEntry(e)}
                              disabled={busy || !(parseFloat(editDraft.weight) > 0)}
                              style={{
                                padding: '5px 14px',
                                borderRadius: 10,
                                border: 'none',
                                background: busy || !(parseFloat(editDraft.weight) > 0) ? '#9ca3af' : '#085041',
                                color: 'white',
                                fontSize: 12,
                                fontWeight: 600,
                                cursor: busy || !(parseFloat(editDraft.weight) > 0) ? 'not-allowed' : 'pointer',
                                fontFamily: 'inherit',
                              }}
                            >
                              {busy ? 'Saving…' : 'Save'}
                            </button>
                          </div>
                        </div>
                      );
                    return (
                      <div
                        key={e.id}
                        style={{
                          padding: '6px 0',
                          borderBottom: '1px solid var(--divider)',
                          fontSize: 12,
                          display: 'flex',
                          gap: 10,
                          alignItems: 'center',
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{fontWeight: 700, color: 'var(--ink)', minWidth: 40}}>#{entryNum}</span>
                        <span style={{color: 'var(--ink-faint)'}}>{'·'}</span>
                        <span style={{fontWeight: 600, color: 'var(--ink)'}}>{e.weight} lb</span>
                        {e.note && (
                          <>
                            <span style={{color: 'var(--ink-faint)'}}>{'·'}</span>
                            <span style={{fontSize: 11, color: 'var(--ink-muted)', fontStyle: 'italic'}}>{e.note}</span>
                          </>
                        )}
                        <div style={{marginLeft: 'auto', display: 'flex', gap: 4}}>
                          <button
                            onClick={() => startEditEntry(e)}
                            style={{
                              fontSize: 11,
                              color: 'var(--brand)',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              padding: '2px 6px',
                              fontFamily: 'inherit',
                            }}
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => deleteEntry(e)}
                            style={{
                              fontSize: 11,
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
                      </div>
                    );
                  })}
                </div>
              );
            })()}

          {/* Recent entries — cattle + sheep. Each row shows tag, age,
            prior weight, current weight, and ADG (when a prior exists).
            Cattle finisher sessions split flagged (-> Processor) entries
            out to their own 'Going to processor' section below. */}
          {(species === 'cattle' || species === 'sheep') &&
            entries.length > 0 &&
            (() => {
              const directory = species === 'cattle' ? cattleList : sheepList;
              const curDate = (session && session.date) || todayCentralISO();
              const isFinishers = species === 'cattle' && session && session.herd === 'finishers';
              // Sheep gate is loosened: any sheep session can flag entries
              // (rams / ewes / feeders / null). Ronnie 2026-04-27.
              const isFeeders = species === 'sheep' && !!session;
              const showProcessorBtn = isFinishers || isFeeders;
              const recentEntryGridS = {
                display: 'grid',
                gridTemplateColumns: '64px 54px minmax(82px, 1fr) 72px 88px minmax(0, 86px) 92px',
                columnGap: 8,
                rowGap: 3,
                alignItems: 'center',
                width: '100%',
              };
              const recentEntryCellS = {
                minWidth: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              };
              const renderRow = (e, highlight) => {
                const animal = directory.find((a) => a.tag === e.tag);
                const isBlacklisted = species === 'cattle' && !!(animal && animal.breeding_blacklist);
                const age = ageYM(animal ? animal.birth_date : null, curDate);
                const prior = priorByTag[e.tag];
                const adg = prior ? adgLbPerDay(prior.weight, prior.date, e.weight, curDate) : null;
                const isEditing = editingEntryId === e.id;
                const editRequiresTag = species === 'cattle' || species === 'sheep';
                const editSaveDisabled =
                  busy || !(parseFloat(editDraft.weight) > 0) || (editRequiresTag && !(editDraft.tag || '').trim());
                if (isEditing)
                  return (
                    <div
                      key={e.id}
                      data-public-weighin-entry-edit="1"
                      data-breeding-blacklist-recent-entry={isBlacklisted ? '1' : undefined}
                      style={{
                        padding: isBlacklisted ? '8px 8px' : '8px 0',
                        borderBottom: '1px solid var(--divider)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                        background: isBlacklisted ? '#fef2f2' : 'transparent',
                        borderLeft: isBlacklisted ? '3px solid #dc2626' : 'none',
                        borderRadius: isBlacklisted ? 6 : 0,
                        boxSizing: 'border-box',
                      }}
                    >
                      <div style={{marginBottom: 2}}>
                        <label style={{...lblS, fontSize: 12}}>Tag #</label>
                        {species === 'cattle' && editDraft.newTagFlag ? (
                          <input
                            data-public-weighin-edit-tag="1"
                            type="text"
                            value={editDraft.tag}
                            onChange={(ev) => setEditDraft((d) => ({...d, tag: ev.target.value}))}
                            placeholder="New/missing tag #"
                            style={{
                              ...inpS,
                              fontSize: 12,
                              padding: '7px 10px',
                              border: '1px solid #f59e0b',
                              background: '#fffbeb',
                            }}
                          />
                        ) : (
                          <select
                            data-public-weighin-edit-tag="1"
                            value={editDraft.tag}
                            onChange={(ev) => setEditDraft((d) => ({...d, tag: ev.target.value}))}
                            style={{
                              ...inpS,
                              fontSize: 12,
                              padding: '7px 10px',
                              ...(species === 'cattle' &&
                              findDirectoryAnimalByTag(editDraft.tag) &&
                              findDirectoryAnimalByTag(editDraft.tag).breeding_blacklist
                                ? blacklistSelectS
                                : {}),
                            }}
                          >
                            <option value="">Select tag...</option>
                            {buildEditableTagOptions(e).map((optionAnimal) => (
                              <option
                                key={optionAnimal.id || optionAnimal.tag}
                                value={optionAnimal.tag}
                                data-breeding-blacklist-option={optionAnimal.breeding_blacklist ? '1' : undefined}
                                style={optionAnimal.breeding_blacklist ? blacklistOptionS : undefined}
                              >
                                {formatAnimalOption(optionAnimal, session && session.date)}
                              </option>
                            ))}
                          </select>
                        )}
                        {species === 'cattle' && (
                          <div style={{display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap'}}>
                            <button
                              type="button"
                              onClick={() => setEditDraft((d) => ({...d, newTagFlag: false}))}
                              data-public-weighin-edit-existing-tag="1"
                              style={{
                                flex: '1 1 120px',
                                padding: '6px 8px',
                                borderRadius: 10,
                                border: '1px solid var(--border-strong)',
                                background: editDraft.newTagFlag ? 'white' : '#ecfdf5',
                                color: '#065f46',
                                fontSize: 11,
                                fontWeight: 700,
                                cursor: 'pointer',
                                fontFamily: 'inherit',
                              }}
                            >
                              Use existing tag
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditDraft((d) => ({...d, newTagFlag: true}))}
                              data-public-weighin-edit-missing-tag="1"
                              style={{
                                flex: '1 1 120px',
                                padding: '6px 8px',
                                borderRadius: 10,
                                border: '1px dashed #b45309',
                                background: editDraft.newTagFlag ? '#fffbeb' : 'white',
                                color: '#92400e',
                                fontSize: 11,
                                fontWeight: 700,
                                cursor: 'pointer',
                                fontFamily: 'inherit',
                              }}
                            >
                              Missing Tag
                            </button>
                          </div>
                        )}
                      </div>
                      <div style={{display: 'grid', gridTemplateColumns: 'minmax(0, 120px) minmax(0, 1fr)', gap: 8}}>
                        <div>
                          <label style={{...lblS, fontSize: 12}}>Weight (lbs) *</label>
                          <input
                            data-public-weighin-edit-weight="1"
                            type="number"
                            min="0"
                            step="0.1"
                            value={editDraft.weight}
                            onChange={(ev) => setEditDraft((d) => ({...d, weight: ev.target.value}))}
                            placeholder="0"
                            style={{...inpS, fontSize: 12, padding: '7px 10px'}}
                          />
                        </div>
                        <div>
                          <label style={{...lblS, fontSize: 12}}>Note</label>
                          <textarea
                            data-public-weighin-edit-note="1"
                            value={editDraft.note}
                            onChange={(ev) => setEditDraft((d) => ({...d, note: ev.target.value}))}
                            rows={2}
                            placeholder="Optional"
                            style={{...inpS, fontSize: 12, padding: '7px 10px', resize: 'vertical'}}
                          />
                        </div>
                      </div>
                      <div style={{display: 'flex', gap: 6, justifyContent: 'flex-end'}}>
                        <button
                          onClick={() => setEditingEntryId(null)}
                          style={{
                            padding: '5px 12px',
                            borderRadius: 10,
                            border: '1px solid var(--border-strong)',
                            background: 'white',
                            color: 'var(--ink-muted)',
                            fontSize: 12,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => saveEditEntry(e)}
                          disabled={editSaveDisabled}
                          style={{
                            padding: '5px 14px',
                            borderRadius: 10,
                            border: 'none',
                            background: editSaveDisabled ? '#9ca3af' : '#085041',
                            color: 'white',
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: editSaveDisabled ? 'not-allowed' : 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          {busy ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  );
                return (
                  <div
                    key={e.id}
                    data-breeding-blacklist-recent-entry={isBlacklisted ? '1' : undefined}
                    style={{
                      padding: isBlacklisted ? '6px 8px' : '6px 0',
                      borderBottom: '1px solid var(--divider)',
                      fontSize: 12,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                      background: isBlacklisted ? '#fef2f2' : highlight ? '#fff7ed' : 'transparent',
                      borderLeft: isBlacklisted ? '3px solid #dc2626' : 'none',
                      borderRadius: isBlacklisted ? 6 : 0,
                      boxSizing: 'border-box',
                    }}
                  >
                    <div data-public-weighin-recent-entry-grid="1" style={recentEntryGridS}>
                      <span
                        style={{...recentEntryCellS, fontWeight: 700, color: isBlacklisted ? '#991b1b' : 'var(--ink)'}}
                      >
                        {e.tag ? '#' + e.tag : '\u2014'}
                      </span>
                      <span style={{...recentEntryCellS, fontSize: 11, color: 'var(--ink-muted)'}}>{age}</span>
                      <span style={{...recentEntryCellS, fontSize: 11, color: 'var(--ink-muted)'}}>
                        {prior ? 'prior ' + Math.round(prior.weight) + ' lb' : 'no prior'}
                      </span>
                      <span style={{...recentEntryCellS, fontWeight: 600, color: 'var(--ink)'}}>{e.weight} lb</span>
                      <span style={recentEntryCellS}>
                        {adg != null ? (
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              padding: '1px 6px',
                              borderRadius: 10,
                              background: adg >= 0 ? '#ecfdf5' : '#fef2f2',
                              color: adg >= 0 ? '#065f46' : '#b91c1c',
                              border: '1px solid ' + (adg >= 0 ? '#a7f3d0' : '#fecaca'),
                            }}
                          >
                            {(adg >= 0 ? '+' : '') + adg.toFixed(2) + ' lb/d'}
                          </span>
                        ) : (
                          <span aria-hidden="true" />
                        )}
                      </span>
                      <span style={recentEntryCellS}>
                        {e.new_tag_flag ? (
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 700,
                              padding: '1px 5px',
                              borderRadius: 10,
                              background: '#fef2f2',
                              color: '#b91c1c',
                            }}
                          >
                            NEW TAG
                          </span>
                        ) : showProcessorBtn ? (
                          <button
                            onClick={() => toggleProcessor(e, !e.send_to_processor)}
                            title={
                              e.send_to_processor
                                ? 'Remove from processor run'
                                : 'Send this ' + (isFeeders ? 'sheep' : 'cow') + ' to the processor on session Complete'
                            }
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              padding: '3px 8px',
                              borderRadius: 10,
                              border: '1px solid ' + (e.send_to_processor ? '#991b1b' : 'var(--border-strong)'),
                              background: e.send_to_processor ? '#991b1b' : 'white',
                              color: e.send_to_processor ? 'white' : '#6b7280',
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                            }}
                          >
                            {e.send_to_processor ? '\u2713 Processor' : '\u2192 Processor'}
                          </button>
                        ) : (
                          <span aria-hidden="true" />
                        )}
                      </span>
                      <div
                        style={{
                          ...recentEntryCellS,
                          display: 'flex',
                          gap: 4,
                          alignItems: 'center',
                          justifyContent: 'flex-end',
                        }}
                      >
                        <button
                          onClick={() => startEditEntry(e)}
                          style={{
                            fontSize: 11,
                            color: 'var(--brand)',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: '2px 6px',
                            fontFamily: 'inherit',
                          }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => deleteEntry(e)}
                          style={{
                            fontSize: 11,
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
                    </div>
                    {e.note && (
                      <div
                        style={{
                          marginLeft: 0,
                          fontSize: 11,
                          color: 'var(--ink-muted)',
                          fontStyle: 'italic',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {e.note}
                      </div>
                    )}
                  </div>
                );
              };
              const unflagged = entries
                .filter((e) => !e.send_to_processor)
                .slice()
                .sort(sortEntriesByTagAsc);
              const flagged = entries
                .filter((e) => e.send_to_processor === true)
                .slice()
                .sort(sortEntriesByTagAsc);
              return (
                <React.Fragment>
                  <div style={cardS}>
                    <div style={{fontSize: 12, fontWeight: 700, color: 'var(--ink-muted)', marginBottom: 8}}>
                      {'Recent entries (' + unflagged.length + ')'}
                    </div>
                    {unflagged.length === 0 && (
                      <div style={{fontSize: 11, color: 'var(--ink-faint)', fontStyle: 'italic'}}>
                        All entries have been flagged for the processor. See below.
                      </div>
                    )}
                    {unflagged.map((e) => renderRow(e, false))}
                  </div>
                  {showProcessorBtn && flagged.length > 0 && (
                    // WI-5: genuine danger notice — standardized to danger tokens
                    // with a 1px gray border (no 2px colored ledger border).
                    <div style={{...cardS, border: '1px solid var(--border)', background: 'var(--danger-soft)'}}>
                      <div style={{fontSize: 12, fontWeight: 700, color: 'var(--danger)', marginBottom: 4}}>
                        {'🚩 Going to processor (' + flagged.length + ')'}
                      </div>
                      <div style={{fontSize: 11, color: 'var(--danger)', marginBottom: 8}}>
                        {'These ' +
                          (isFeeders ? 'sheep' : 'cows') +
                          ' will be attached to a processing batch and moved to the Processed ' +
                          (isFeeders ? 'flock' : 'herd') +
                          ' when you hit Complete. Still count toward the session’s avg ADG.'}
                      </div>
                      {flagged.map((e) => renderRow(e, true))}
                    </div>
                  )}
                </React.Fragment>
              );
            })()}

          {species === 'cattle' && pendingReconciles.length > 0 && (
            // WI-5: genuine warn notice (unmatched/missing tags) \u2014 standardized to
            // warn tokens with a 1px gray border.
            <div style={{...cardS, border: '1px solid var(--border)', background: 'var(--warn-soft)'}}>
              <div style={{fontSize: 13, fontWeight: 700, color: 'var(--warn-ink)', marginBottom: 6}}>
                {'\u26a0\ufe0f ' +
                  pendingReconciles.length +
                  ' ' +
                  (pendingReconciles.length === 1 ? 'missing tag' : 'missing tags') +
                  ' to reconcile'}
              </div>
              <div style={{fontSize: 11, color: 'var(--warn-ink)', marginBottom: 10}}>
                Pick which cow each new tag belongs to. Pool narrows as more cows get weighed.
              </div>
              {pendingReconciles.map((e) => (
                <div
                  key={e.id}
                  style={{
                    padding: '8px 10px',
                    background: 'white',
                    border: '1px solid #fde68a',
                    borderRadius: 10,
                    marginBottom: 6,
                  }}
                >
                  <div style={{fontSize: 12, fontWeight: 700, color: 'var(--ink)', marginBottom: 5}}>
                    {'New tag #' + e.tag + ' \u00b7 ' + e.weight + ' lb'}
                    {e.note ? (
                      <span style={{fontWeight: 400, color: 'var(--ink-muted)', fontStyle: 'italic'}}>
                        {' \u00b7 ' + e.note}
                      </span>
                    ) : null}
                  </div>
                  <select
                    onChange={(ev) => {
                      if (ev.target.value) reconcileEntryToCow(e, ev.target.value);
                    }}
                    defaultValue=""
                    disabled={busy}
                    style={{...inpS, fontSize: 12, padding: '7px 10px'}}
                  >
                    <option value="">{'Which cow is this? (' + remainingCows.length + ' remaining)'}</option>
                    {remainingCows.map((c) => (
                      <option
                        key={c.id}
                        value={c.id}
                        data-breeding-blacklist-option={c.breeding_blacklist ? '1' : undefined}
                        style={c.breeding_blacklist ? blacklistOptionS : undefined}
                      >
                        {formatAnimalOption(c, session && session.date) + (c.breed ? ' \u00b7 ' + c.breed : '')}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
          {entries.length > 0 &&
            (() => {
              let avgAdgStr = '';
              if (species === 'cattle' || species === 'sheep') {
                const curDate = (session && session.date) || todayCentralISO();
                const adgs = entries
                  .map((e) => {
                    const prior = priorByTag[e.tag];
                    return prior ? adgLbPerDay(prior.weight, prior.date, e.weight, curDate) : null;
                  })
                  .filter((a) => a != null);
                if (adgs.length > 0) {
                  const avg = adgs.reduce((s, v) => s + v, 0) / adgs.length;
                  avgAdgStr =
                    ' \u00b7 avg ADG ' +
                    (avg >= 0 ? '+' : '') +
                    avg.toFixed(2) +
                    ' lb/d (' +
                    adgs.length +
                    ' of ' +
                    entries.length +
                    ')';
                }
              }
              return (
                <div
                  style={{
                    padding: '8px 12px',
                    background: '#ecfdf5',
                    border: '1px solid #a7f3d0',
                    borderRadius: 10,
                    fontSize: 12,
                    color: '#065f46',
                    marginTop: 8,
                    marginBottom: 6,
                    textAlign: 'center',
                    fontWeight: 600,
                  }}
                >
                  {entries.length + ' ' + (entries.length === 1 ? 'entry' : 'entries') + ' saved'}
                  {species === 'broiler' || species === 'pig'
                    ? ' \u00b7 avg ' +
                      Math.round(
                        (entries.reduce(function (s, e) {
                          return s + (parseFloat(e.weight) || 0);
                        }, 0) /
                          entries.length) *
                          100,
                      ) /
                        100 +
                      ' lb'
                    : ''}
                  {avgAdgStr}
                </div>
              );
            })()}
          {(() => {
            var filledCount =
              species === 'broiler'
                ? weightInputs.filter(function (w) {
                    return w !== '' && !isNaN(parseFloat(w)) && parseFloat(w) > 0;
                  }).length
                : entries.length;
            // Phase 1C-D \u2014 pig fresh-collection: bottom button becomes
            // "Save Draft" instead of "Complete." Broiler fresh doesn't
            // get a bottom button at all (the per-grid Save Weights
            // button at line ~1860 is the only fresh action; once synced,
            // sessionIsFresh flips false and the regular Complete button
            // appears here).
            if (sessionIsFresh && species === 'pig') {
              var pigDisabled = busy || filledCount === 0;
              return (
                <button
                  onClick={saveDraftViaRpc}
                  disabled={pigDisabled}
                  style={{
                    width: '100%',
                    padding: 14,
                    borderRadius: 10,
                    border: 'none',
                    background: pigDisabled ? '#9ca3af' : '#085041',
                    color: 'white',
                    fontSize: 15,
                    fontWeight: 700,
                    cursor: pigDisabled ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                    marginTop: 6,
                  }}
                >
                  {busy
                    ? 'Saving\u2026'
                    : 'Save Draft (' + filledCount + ' ' + (filledCount === 1 ? 'entry' : 'entries') + ')'}
                </button>
              );
            }
            if (sessionIsFresh && species === 'broiler') {
              return null;
            }
            var isEmpty = filledCount === 0;
            var hasPending = pendingReconciles.length > 0;
            var disabled = busy || isEmpty || hasPending;
            var label = busy
              ? 'Completing\u2026'
              : hasPending
                ? 'Resolve ' +
                  pendingReconciles.length +
                  ' reconcile' +
                  (pendingReconciles.length === 1 ? '' : 's') +
                  ' first'
                : '\u2713 Complete Weigh-In (' + filledCount + ' ' + (filledCount === 1 ? 'entry' : 'entries') + ')';
            return (
              <button
                onClick={completeSession}
                disabled={disabled}
                style={{
                  width: '100%',
                  padding: 14,
                  borderRadius: 10,
                  border: 'none',
                  background: disabled ? '#9ca3af' : '#085041',
                  color: 'white',
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  marginTop: 6,
                }}
              >
                {label}
              </button>
            );
          })()}
        </div>
        {showProcessorModal && species === 'cattle' && (
          <CattleSendToProcessorModal
            sb={sb}
            session={session}
            flaggedEntries={entries.filter((e) => e.send_to_processor === true)}
            cattleList={cattleList}
            weighIns={[]}
            teamMember={teamMember}
            authState={null}
            onCancel={() => setShowProcessorModal(false)}
            onConfirmed={async () => {
              setShowProcessorModal(false);
              await finalizeSession();
            }}
          />
        )}
        {showProcessorModal && species === 'sheep' && (
          <SheepSendToProcessorModal
            sb={sb}
            session={session}
            flaggedEntries={entries.filter((e) => e.send_to_processor === true)}
            sheepList={sheepList}
            teamMember={teamMember}
            onCancel={() => setShowProcessorModal(false)}
            onConfirmed={async () => {
              setShowProcessorModal(false);
              await finalizeSession();
            }}
          />
        )}
        {/* Phase 1C-D — synced marker (Codex #1: fresh→DB-backed conversion lock) */}
        {!sessionIsFresh && lastSubmitOutcome === 'synced' && (
          <div data-submit-state="synced" style={{display: 'none'}}>
            synced
          </div>
        )}
        {stuckModalEl}
        {deleteConfirmEl}
      </div>
    );

  return null;
};

export default WeighInsWebform;
