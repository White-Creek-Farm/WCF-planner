// BroilerBatchPage — URL-driven record page for one broiler batch.
//
// Routes:
//   /broiler/batches/<encodedBatchName>
//
// Identity: batch.name (preserves existing Activity entityId contract).
//
// Mounts BatchForm in embedded mode: the parent renders Header + back link +
// data-record-title, and BatchForm renders its form body without its own
// Header or full-screen overlay. RecordCollaborationSection is mounted
// below. Direct URL open does not depend on showForm already being true —
// the page calls openEdit(batch) on mount to populate BatchesContext form
// state, and main.jsx skips the top-level showForm branch when the URL
// matches /broiler/batches/<id>.
import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
import {sb} from '../lib/supabase.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordSequenceNav from '../shared/RecordSequenceNav.jsx';
import {recordSeqNavOptions} from '../lib/recordSequence.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import BatchForm from './BatchForm.jsx';
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
import {useBatches} from '../contexts/BatchesContext.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';

export default function BroilerBatchPage({
  Header,
  loadUsers,
  upd,
  closeForm,
  submit,
  del,
  openEdit,
  parseProcessorXlsx,
  confirmDelete,
  persist,
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const {batches, editId, setShowForm} = useBatches();
  const {authState, dataLoaded} = useAuth();

  const encodedName = location.pathname.slice('/broiler/batches/'.length);
  const batchName = (() => {
    try {
      return decodeURIComponent(encodedName);
    } catch (_e) {
      return encodedName;
    }
  })();

  // Pin the resolved batch by id after the initial name lookup so the page
  // survives a name edit (rename autosaves into batches; URL still encodes
  // the original name). Reset whenever the URL batch name changes so
  // navigating between records via prev/next still works.
  const [pinnedId, setPinnedId] = React.useState(null);
  React.useEffect(() => {
    setPinnedId(null);
  }, [batchName]);

  const batch = React.useMemo(() => {
    const list = batches || [];
    if (pinnedId) {
      const byId = list.find((b) => b.id === pinnedId);
      if (byId) return byId;
    }
    return list.find((b) => (b.name || '') === batchName) || null;
  }, [batches, batchName, pinnedId]);

  React.useEffect(() => {
    if (batch && pinnedId !== batch.id) setPinnedId(batch.id);
  }, [batch, pinnedId]);

  // Populate BatchesContext form state from the URL-resolved batch on mount
  // and whenever the URL batch identity changes. Once editId matches the
  // resolved batch.id, treat the form as dirty-tolerant: subsequent
  // divergence of form.name from batch.name is normal in-progress edits,
  // not a signal to replay openEdit. Replaying would clobber the user's
  // keystrokes (Codex P1 fix).
  React.useEffect(() => {
    if (!batch) return;
    if (editId === batch.id) return;
    openEdit(batch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch && batch.id]);

  // If batches finishes loading and the URL batch is gone, ensure showForm
  // is false so the top-level guard doesn't get tripped by stale state.
  React.useEffect(() => {
    if (!batch && Array.isArray(batches) && batches.length > 0) {
      setShowForm(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch, batches]);

  // After a name rename autosaves into batches, batch.name diverges from
  // the URL-encoded batchName. Update the URL silently so /broiler/batches/
  // <oldName> doesn't 404 on refresh.
  React.useEffect(() => {
    if (!batch) return;
    const currentName = batch.name || '';
    if (!currentName) return;
    if (currentName === batchName) return;
    navigate('/broiler/batches/' + encodeURIComponent(currentName), {replace: true});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch && batch.name]);

  // Unmount cleanup: leaving the record route (Header nav, browser Back,
  // anything that swaps BroilerBatchPage out) must clear showForm so the
  // top-level if (showForm) guard does not capture the next render with the
  // full-screen BatchForm.
  React.useEffect(() => {
    return () => {
      setShowForm(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (location.hash) {
      const anchor = location.hash.slice(1);
      setTimeout(() => {
        const el = document.getElementById(anchor);
        if (el) el.scrollIntoView({behavior: 'smooth', block: 'center'});
      }, 200);
    }
  }, [location.hash, batch]);

  function handleClose() {
    // closeForm may refuse (blank name / hard conflict without override) —
    // in that case it returns false, keeps the form open, and surfaces a
    // formNotice. Do not navigate away or clear showForm; the user must
    // resolve the validation stop first.
    const ok = closeForm();
    if (ok === false) return;
    setShowForm(false);
    navigate('/broiler/batches');
  }

  // Prev/Next now flows through the shared RecordSequenceNav. The visible-order
  // sequence (batch ids + names) is carried in route state; resolve the target
  // id to its current name before routing, and carry the sequence forward.
  const recordSeq = location.state?.recordSeq;
  function navigateToBatchId(id) {
    const target = (batches || []).find((b) => b.id === id);
    if (!target || !target.name) return;
    navigate('/broiler/batches/' + encodeURIComponent(target.name), recordSeqNavOptions(recordSeq));
  }

  if (!Array.isArray(batches) || (!dataLoaded && batches.length === 0)) {
    return <RecordPageLoading Header={Header} />;
  }

  if (!batch) {
    return (
      <RecordPageNotFound
        Header={Header}
        backLabel="Back to Broiler Batches"
        onBack={handleClose}
        message="Batch not found."
      />
    );
  }

  // Wait for context form state to catch up to the URL batch before mounting
  // BatchForm. openEdit fires above; the next render has editId === batch.id.
  // Do NOT gate on form.name matching batch.name — dirty in-progress edits
  // are normal and must not unmount the form (Codex P1 fix).
  const formReady = editId === batch.id;

  return (
    <RecordPageFrame Header={Header}>
      <RecordPageBody maxWidth={1100} data-broiler-batch-record-loaded="true">
        <RecordBackLink label="Back to Broiler Batches" onBack={handleClose} />

        <RecordSequenceNav seq={recordSeq} currentId={batch.id} onNavigate={navigateToBatchId} />

        <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12}}>
          <RecordTitle fontSize={22} margin={0}>
            {batch.name}
          </RecordTitle>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 10,
              background: batch.status === 'processed' ? '#374151' : batch.status === 'active' ? '#1d4ed8' : '#fde68a',
              color: batch.status === 'planned' ? '#92400e' : 'white',
              textTransform: 'uppercase',
            }}
          >
            {batch.status}
          </span>
          {batch.breed && <span style={{fontSize: 12, color: '#6b7280'}}>Breed: {batch.breed}</span>}
          {batch.hatchery && <span style={{fontSize: 12, color: '#6b7280'}}>Hatchery: {batch.hatchery}</span>}
        </div>

        {formReady && (
          <BatchForm
            Header={Header}
            loadUsers={loadUsers}
            upd={upd}
            closeForm={closeForm}
            submit={submit}
            del={del}
            openEdit={openEdit}
            parseProcessorXlsx={parseProcessorXlsx}
            confirmDelete={confirmDelete}
            persist={persist}
            onClose={handleClose}
            embedded
          />
        )}

        <RecordCollaborationSection
          sb={sb}
          authState={authState}
          entityType="broiler.batch"
          entityId={batch.name}
          entityLabel={batch.name}
        />
      </RecordPageBody>
    </RecordPageFrame>
  );
}
