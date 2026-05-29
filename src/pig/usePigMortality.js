import {useState} from 'react';
import {sb} from '../lib/supabase.js';
import {todayISO} from '../lib/dateUtils.js';

// Pig.batch mortality workflow (CP7 extraction from PigBatchesView). Owns the
// modal/form/busy/expanded state plus the open/save/delete handlers. This is a
// verbatim lift — behavior, persisted shape (feederGroup.pigMortalities written
// to app_store ppp-feeders-v1 via setFeederGroups + the inline upsert), and the
// mortality audit-log semantics are unchanged. The modal + mortality-log JSX
// stay in PigBatchesView and consume the returned values.
//
// Dependencies are passed in explicitly so the hook stays React-context-free:
//   feederGroups / setFeederGroups — the ppp-feeders-v1 source of truth
//   setNotice                      — shared inline notice
//   authState                      — for the team_member stamp
export function usePigMortality({feederGroups, setFeederGroups, setNotice, authState}) {
  const [mortalityModal, setMortalityModal] = useState(null);
  const [mortalityForm, setMortalityForm] = useState({sub_batch_id: '', count: '', comment: ''});
  const [mortalityBusy, setMortalityBusy] = useState(false);
  const [expandedMortality, setExpandedMortality] = useState(null);

  function openMortalityModal(batchId) {
    setNotice(null);
    setMortalityModal({batchId});
    setMortalityForm({sub_batch_id: '', count: '', comment: ''});
  }

  async function saveMortality() {
    if (!mortalityModal) return;
    setNotice(null);
    const count = parseInt(mortalityForm.count);
    if (!Number.isFinite(count) || count <= 0) {
      setNotice({kind: 'error', message: 'Enter a count of 1 or more.'});
      return;
    }
    setMortalityBusy(true);
    const batchId = mortalityModal.batchId;
    const subId = mortalityForm.sub_batch_id || null;
    const target = feederGroups.find((g) => g.id === batchId);
    const subName = subId ? ((target && target.subBatches) || []).find((s) => s.id === subId)?.name || null : null;
    const entry = {
      id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
      date: todayISO(),
      sub_batch_id: subId,
      sub_batch_name: subName,
      count,
      comment: (mortalityForm.comment || '').trim() || null,
      team_member: (authState && authState.user && authState.user.email) || 'unknown',
      created_at: new Date().toISOString(),
    };
    const nb = feederGroups.map((g) =>
      g.id === batchId ? {...g, pigMortalities: [...(g.pigMortalities || []), entry]} : g,
    );
    setFeederGroups(nb);
    try {
      await sb.from('app_store').upsert({key: 'ppp-feeders-v1', data: nb}, {onConflict: 'key'});
    } catch (e) {
      setNotice({kind: 'error', message: 'Save failed: ' + (e.message || 'unknown')});
      setMortalityBusy(false);
      return;
    }
    setMortalityBusy(false);
    setMortalityModal(null);
  }

  async function deleteMortality(batchId, entryId) {
    if (!window._wcfConfirmDelete) return;
    window._wcfConfirmDelete('Delete this mortality entry?', async () => {
      setNotice(null);
      const nb = feederGroups.map((g) =>
        g.id === batchId ? {...g, pigMortalities: (g.pigMortalities || []).filter((m) => m.id !== entryId)} : g,
      );
      setFeederGroups(nb);
      try {
        await sb.from('app_store').upsert({key: 'ppp-feeders-v1', data: nb}, {onConflict: 'key'});
      } catch (e) {
        setNotice({kind: 'error', message: 'Delete failed: ' + (e.message || 'unknown')});
      }
    });
  }

  return {
    mortalityModal,
    setMortalityModal,
    mortalityForm,
    setMortalityForm,
    mortalityBusy,
    expandedMortality,
    setExpandedMortality,
    openMortalityModal,
    saveMortality,
    deleteMortality,
  };
}
