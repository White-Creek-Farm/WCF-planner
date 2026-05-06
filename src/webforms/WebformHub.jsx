// Phase 2 Round 5 extraction (verbatim).
import React from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import {setHousingAnchorFromReport} from '../lib/layerHousing.js';
import {wcfSendEmail} from '../lib/email.js';
import {loadRoster, activeNames} from '../lib/teamMembers.js';
import {loadAvailability, availableNamesFor} from '../lib/teamAvailability.js';
import {useWebformsConfig} from '../contexts/WebformsConfigContext.jsx';
import {uploadDailyPhoto, MAX_PHOTOS_PER_REPORT} from '../lib/dailyPhotos.js';
import {newClientSubmissionId} from '../lib/clientSubmissionId.js';
import {useOfflineSubmit} from '../lib/useOfflineSubmit.js';
import DailyPhotoCapture from './DailyPhotoCapture.jsx';
import StuckSubmissionsModal from './StuckSubmissionsModal.jsx';
import AppSetupModal from './AppSetupModal.jsx';
const WebformHub = ({
  sb,
  wfGroups,
  setWfGroups,
  wfTeamMembers,
  setWfTeamMembers,
  layerGroups,
  batches,
  layerBatches,
  layerHousings,
  webformsConfig,
}) => {
  const {useState, useEffect} = React;
  const {wfRoster, setWfRoster, wfAvailability, setWfAvailability} = useWebformsConfig();
  const [loadedConfig, setLoadedConfig] = useState(null); // loaded from Supabase full_config
  const [showAppSetup, setShowAppSetup] = useState(false);
  const [broilerGroupsFromDb, setBroilerGroupsFromDb] = useState([]);
  const [wfSettings, setWfSettings] = useState({});
  const [pigGroupsFromDb, setPigGroupsFromDb] = useState([]);
  const [housingBatchMap, setHousingBatchMap] = useState({});
  useEffect(() => {
    Promise.all([
      sb.from('webform_config').select('data').eq('key', 'full_config').maybeSingle(),
      sb.from('webform_config').select('data').eq('key', 'broiler_groups').maybeSingle(),
      sb.from('webform_config').select('data').eq('key', 'webform_settings').maybeSingle(),
      sb.from('webform_config').select('data').eq('key', 'active_groups').maybeSingle(),
      sb.from('webform_config').select('data').eq('key', 'housing_batch_map').maybeSingle(),
      loadRoster(sb),
      loadAvailability(sb),
    ]).then(([fc, bg, ws, ag, hbm, roster, availability]) => {
      if (fc?.data?.data) setLoadedConfig(fc.data.data);
      if (Array.isArray(bg?.data?.data) && bg.data.data.length > 0) setBroilerGroupsFromDb(bg.data.data);
      if (ws?.data?.data) setWfSettings(ws.data.data);
      if (Array.isArray(ag?.data?.data) && ag.data.data.length > 0) {
        const groups = ag.data.data.map((name) => ({value: name, label: name}));
        setPigGroupsFromDb(groups);
        if (setWfGroups) setWfGroups(groups);
      }
      if (Array.isArray(roster) && roster.length > 0) {
        if (setWfRoster) setWfRoster(roster);
        if (setWfTeamMembers) setWfTeamMembers(activeNames(roster));
      }
      if (availability && setWfAvailability) setWfAvailability(availability);
      if (hbm?.data?.data) setHousingBatchMap(hbm.data.data);
    });
  }, []);
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // URL-driven activeForm: /dailys → selector, /dailys/<sub> → sub-form.
  // setActiveForm(X) pushes a history entry so the browser back button
  // traverses selector ↔ sub-form correctly. main.jsx's URL adapter treats
  // every /dailys/* path as view='webformhub' (see the adapter branch).
  // Legacy /webforms/* aliases redirect to /dailys/* in main.jsx before
  // this component sees pathname.
  const location = useLocation();
  const navigate = useNavigate();
  const SUB_FORMS = ['broiler', 'layer', 'pig', 'cattle', 'egg', 'sheep'];
  const activeForm = (() => {
    const parts = location.pathname.split('/');
    const sub = parts[2];
    return SUB_FORMS.includes(sub) ? sub : null;
  })();
  const setActiveForm = (f) => {
    navigate(f ? `/dailys/${f}` : '/dailys');
  };
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [lastGroup, setLastGroup] = useState('');

  // Broiler form state
  const EMPTY_B = {
    date: todayStr(),
    teamMember: '',
    batchLabel: '',
    feedType: '',
    feedLbs: '',
    gritLbs: '',
    groupMoved: true,
    watererChecked: true,
    mortalityCount: '',
    mortalityReason: '',
    comments: '',
  };
  const [bForm, setBForm] = useState(EMPTY_B);

  // Layer form state
  const EMPTY_L = {
    date: todayStr(),
    teamMember: '',
    batchLabel: '',
    feedType: '',
    feedLbs: '',
    gritLbs: '',
    layerCount: '',
    groupMoved: true,
    watererChecked: true,
    mortalityCount: '',
    mortalityReason: '',
    comments: '',
  };
  const [lForm, setLForm] = useState(EMPTY_L);

  // Pig form state
  const pigGroupList = [];
  const EMPTY_P = {
    date: todayStr(),
    teamMember: '',
    batchLabel: '',
    feedLbs: '',
    pigCount: '',
    groupMoved: true,
    nippleDrinkerMoved: true,
    nippleDrinkerWorking: true,
    troughsMoved: true,
    fenceWalked: true,
    fenceVoltage: '',
    issues: '',
  };
  const [pForm, setPForm] = useState(EMPTY_P);

  // Egg form state
  const activeLayerGroups = (layerGroups || []).filter((g) => g.status === 'active');
  const EMPTY_E = {
    date: todayStr(),
    teamMember: '',
    g1n: activeLayerGroups[0]?.name || '',
    g1c: '',
    g2n: activeLayerGroups[1]?.name || '',
    g2c: '',
    g3n: activeLayerGroups[2]?.name || '',
    g3c: '',
    g4n: activeLayerGroups[3]?.name || '',
    g4c: '',
    dozensOnHand: '',
    comments: '',
  };
  const [eForm, setEForm] = useState(EMPTY_E);

  // Cattle form state + active feeds list
  const [cattleFeedInputs, setCattleFeedInputs] = useState([]);
  const EMPTY_C = {
    date: todayStr(),
    teamMember: '',
    herd: '',
    feeds: [{feedId: '', qty: '', isCreep: false}],
    minerals: [{feedId: '', lbs: ''}],
    fenceVoltage: '',
    waterChecked: true,
    mortalityCount: '',
    mortalityReason: '',
    issues: '',
  };
  const [cForm, setCForm] = useState(EMPTY_C);
  useEffect(() => {
    sb.from('cattle_feed_inputs')
      .select('*')
      .eq('status', 'active')
      .order('category')
      .order('name')
      .then(({data}) => {
        if (data) setCattleFeedInputs(data);
      });
  }, []);

  // Sheep form state — cattle-parity shape (feeds + minerals jsonb). Feed
  // master comes from cattleFeedInputs filtered by sheep herd_scope.
  const EMPTY_S = {
    date: todayStr(),
    teamMember: '',
    flock: '',
    feeds: [{feedId: '', qty: ''}],
    minerals: [{feedId: '', lbs: ''}],
    fenceVoltageKv: '',
    waterersWorking: true,
    comments: '',
  };
  const [sForm, setSForm] = useState(EMPTY_S);

  // CRITICAL: load from Supabase only — props are empty on mobile (no auth)
  const broilerGroups =
    (broilerGroupsFromDb.length > 0 && broilerGroupsFromDb) ||
    (loadedConfig?.broilerGroups?.length > 0 && loadedConfig.broilerGroups) ||
    [];
  // Auto-derived layer dropdown — replaces hand-maintained cfg.layerGroups.
  // Rule: show batch NAME for active batches without housings yet (pre-housing phase),
  // plus all currently-active housing NAMES.
  // Falls back to legacy cfg.layerGroups if the new tables haven't loaded yet.
  const layerGroupNames = (() => {
    const ab = (layerBatches || []).filter((b) => b.status === 'active');
    const ah = (layerHousings || []).filter((h) => h.status === 'active');
    if (ab.length === 0 && ah.length === 0) {
      return loadedConfig?.layerGroups?.filter((g) => g.status === 'active').map((g) => g.name || g) || [];
    }
    const housingNames = ah.map((h) => h.housing_name);
    const batchesWithoutHousing = ab.filter((b) => !ah.some((h) => h.batch_id === b.id));
    return [...batchesWithoutHousing.map((b) => b.name), ...housingNames];
  })();
  // Lookup helper: resolve batch_label → batch_id at submit time so historical
  // attribution stays correct even if a housing gets reassigned later.
  function resolveBatchId(label) {
    if (!label) return null;
    const t = String(label).toLowerCase().trim();
    const byBatch = (layerBatches || []).find(
      (b) =>
        String(b.name || '')
          .toLowerCase()
          .trim() === t,
    );
    if (byBatch) return byBatch.id;
    const byHousing = (layerHousings || []).find(
      (h) =>
        String(h.housing_name || '')
          .toLowerCase()
          .trim() === t,
    );
    return byHousing?.batch_id || null;
  }
  // Per-form team-member availability filters (2026-04-29). The master
  // roster is the single source of truth (wfRoster, loaded via loadRoster).
  // `team_availability.forms[formKey].hiddenIds` narrows the dropdown for
  // each form key — empty / missing entry means everyone visible. The
  // loadedConfig.teamMembers fallback is a defensive path for the
  // mobile cold-load race where roster hasn't populated yet.
  const cfg = loadedConfig || webformsConfig || {};
  const loadedTeamMembers = loadedConfig?.teamMembers || [];
  const getFormTeamMembers = (formKey) => {
    const roster = Array.isArray(wfRoster) ? wfRoster : [];
    if (roster.length > 0) {
      return availableNamesFor(formKey, roster, wfAvailability);
    }
    // Cold-load fallback: legacy mirror or wfTeamMembers prop. Availability
    // can't be applied without ids in this branch — names only.
    const fromProp = wfTeamMembers || [];
    if (fromProp.length > 0) return fromProp;
    return loadedTeamMembers;
  };
  const isEnabled = (formId, fieldId) => {
    const wf = (cfg.webforms || []).find((w) => w.id === formId);
    if (!wf) return true;
    const allFields = (wf.sections || []).flatMap((s) => s.fields || []);
    const f = allFields.find((f) => f.id === fieldId);
    return f ? f.enabled !== false : true;
  };
  const isRequired = (formId, fieldId) => {
    const wf = (cfg.webforms || []).find((w) => w.id === formId);
    if (!wf) return false;
    const allFields = (wf.sections || []).flatMap((s) => s.fields || []);
    const f = allFields.find((f) => f.id === fieldId);
    return f ? f.required === true : false;
  };
  const reqStar = (formId, fieldId) =>
    isRequired(formId, fieldId) ? React.createElement('span', {style: {color: '#dc2626', marginLeft: 2}}, '*') : null;
  // Extra group sections for Add Group feature (array of {batchLabel})
  const [extraBroilerGroups, setExtraBroilerGroups] = useState([]);
  const [extraLayerGroups, setExtraLayerGroups] = useState([]);
  const [extraPigGroups, setExtraPigGroups] = useState([]);

  // Daily-report photos (per program). Files held client-side until submit;
  // uploaded sequentially after required-field validation passes; aborted
  // entirely on any photo failure (locked decision: no partial-photo row
  // insert). Egg dailys excluded — mig 030 omitted egg_dailys.photos.
  const [bPhotos, setBPhotos] = useState([]);
  const [bPhotoStatuses, setBPhotoStatuses] = useState([]);
  const [lPhotos, setLPhotos] = useState([]);
  const [lPhotoStatuses, setLPhotoStatuses] = useState([]);
  const [pPhotos, setPPhotos] = useState([]);
  const [pPhotoStatuses, setPPhotoStatuses] = useState([]);
  const [cPhotos, setCPhotos] = useState([]);
  const [cPhotoStatuses, setCPhotoStatuses] = useState([]);
  const [shPhotos, setShPhotos] = useState([]);
  const [shPhotoStatuses, setShPhotoStatuses] = useState([]);

  // Common photo-upload helper. Validates required fields BEFORE any upload
  // (caller's job, this just runs the upload chain). Returns metadata array
  // on success; throws on first failure so the parent submit aborts.
  async function uploadPhotosOrAbort(formKind, csid, photos, setStatuses) {
    if (!photos || photos.length === 0) return [];
    if (photos.length > MAX_PHOTOS_PER_REPORT) {
      throw new Error(`Up to ${MAX_PHOTOS_PER_REPORT} photos per submission`);
    }
    setStatuses(photos.map(() => 'pending'));
    const meta = [];
    for (let i = 0; i < photos.length; i++) {
      setStatuses((prev) => prev.map((s, j) => (j === i ? 'uploading' : s)));
      try {
        const m = await uploadDailyPhoto(sb, formKind, csid, `photo-${i + 1}`, photos[i]);
        meta.push(m);
        setStatuses((prev) => prev.map((s, j) => (j === i ? 'uploaded' : s)));
      } catch (e) {
        setStatuses((prev) => prev.map((s, j) => (j === i ? 'failed' : s)));
        throw e;
      }
    }
    return meta;
  }
  const allowAddGroup = (formId) => {
    // Check webform_settings key first (most up-to-date from admin panel)
    if (wfSettings?.allowAddGroup && formId in wfSettings.allowAddGroup) {
      return wfSettings.allowAddGroup[formId] === true;
    }
    // Fall back to full_config webforms array
    const wf = (cfg.webforms || []).find((w) => w.id === formId);
    return wf?.allowAddGroup === true;
  };

  // ── Phase 1D-B — WebformHub photo offline queue ────────────────────────
  // Mount one useOfflineSubmit hook per included form-kind. submit handlers
  // call hook.submit(payload) for single-row paths only. Multi-row Add-Group
  // (broiler/pig) stays direct-insert (Codex amendment 4). Layer + egg are
  // OUT of scope for 1D-B (layer's setHousingAnchorFromReport is load-bearing
  // and routes through 1D-C; egg has no photos column per mig 030).
  const broilerHook = useOfflineSubmit('poultry_dailys');
  const pigHook = useOfflineSubmit('pig_dailys');
  const cattleHook = useOfflineSubmit('cattle_dailys');
  const sheepHook = useOfflineSubmit('sheep_dailys');

  // Aggregated stuck rows across the four hooks. Sorted newest-first
  // (created_at desc, retry_count desc tiebreaker per Codex Q4).
  const allStuck = React.useMemo(() => {
    const rows = [...broilerHook.stuckRows, ...pigHook.stuckRows, ...cattleHook.stuckRows, ...sheepHook.stuckRows];
    return rows.slice().sort((a, b) => {
      const tDelta = (b.created_at || 0) - (a.created_at || 0);
      if (tDelta !== 0) return tDelta;
      return (b.retry_count || 0) - (a.retry_count || 0);
    });
  }, [broilerHook.stuckRows, pigHook.stuckRows, cattleHook.stuckRows, sheepHook.stuckRows]);

  // Map form_kind -> hook so retry/discard dispatches to the owning hook.
  const hookByFormKind = {
    poultry_dailys: broilerHook,
    pig_dailys: pigHook,
    cattle_dailys: cattleHook,
    sheep_dailys: sheepHook,
  };

  const [wfStuckOpen, setWfStuckOpen] = useState(false);
  const [doneState, setDoneState] = useState('synced'); // 'synced' | 'queued' | 'stuck'
  const initialStuckShownRef = React.useRef(false);
  useEffect(() => {
    if (allStuck.length > 0 && !initialStuckShownRef.current) {
      initialStuckShownRef.current = true;
      setWfStuckOpen(true);
    }
  }, [allStuck.length]);

  async function retryAnyStuck(csid) {
    const row = allStuck.find((r) => r.csid === csid);
    if (!row) return;
    const hook = hookByFormKind[row.form_kind];
    if (hook) await hook.retryStuck(csid);
  }
  async function discardAnyStuck(csid) {
    const row = allStuck.find((r) => r.csid === csid);
    if (!row) return;
    const hook = hookByFormKind[row.form_kind];
    if (hook) await hook.discardStuck(csid);
  }

  // Lifted stuck-modal element. Codex amendment 1: include {stuckModalEl}
  // in EVERY return branch (done, form selector, broiler, layer, pig,
  // cattle, egg, sheep). Bottom-mount-only would miss most paths.
  const stuckModalEl =
    wfStuckOpen && allStuck.length > 0 ? (
      <StuckSubmissionsModal
        rows={allStuck}
        formLabel="daily report"
        describeRow={(row) => {
          const fk = row.form_kind;
          const rec = row.record || row.payload || {};
          const dateStr = rec.date || '?';
          const who =
            fk === 'poultry_dailys' || fk === 'pig_dailys'
              ? rec.batch_label || '?'
              : fk === 'cattle_dailys'
                ? rec.herd || '?'
                : fk === 'sheep_dailys'
                  ? rec.flock || '?'
                  : '?';
          const pretty =
            fk === 'poultry_dailys'
              ? 'Broiler'
              : fk === 'pig_dailys'
                ? 'Pig'
                : fk === 'cattle_dailys'
                  ? 'Cattle'
                  : fk === 'sheep_dailys'
                    ? 'Sheep'
                    : fk;
          const photoCount = Array.isArray(rec.photos) ? rec.photos.length : 0;
          const photoSuffix = photoCount > 0 ? ` · ${photoCount} photo${photoCount === 1 ? '' : 's'}` : '';
          return `${pretty} · ${who} · ${dateStr}${photoSuffix} (not yet sent)`;
        }}
        onRetry={async (csid) => {
          await retryAnyStuck(csid);
        }}
        onDiscard={async (csid) => {
          await discardAnyStuck(csid);
        }}
        onClose={() => setWfStuckOpen(false)}
      />
    ) : null;

  const inputStyle = {
    fontFamily: 'inherit',
    fontSize: 14,
    padding: '10px 12px',
    border: '1px solid #d1d5db',
    borderRadius: 8,
    width: '100%',
    outline: 'none',
    background: 'white',
    color: '#111827',
    boxSizing: 'border-box',
  };
  const labelStyle = {display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500};
  const sectionStyle = {
    background: 'white',
    borderRadius: 12,
    padding: '16px',
    marginBottom: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,.08)',
  };
  const YN = ({val, onChange}) => (
    <div style={{display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid #d1d5db'}}>
      {[
        {v: true, l: 'Yes'},
        {v: false, l: 'No'},
      ].map(({v, l}) => (
        <button
          key={l}
          type="button"
          onClick={() => onChange(v)}
          style={{
            flex: 1,
            padding: '10px 0',
            border: 'none',
            fontFamily: 'inherit',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            background: val === v ? (v ? '#085041' : '#374151') : 'white',
            color: val === v ? 'white' : '#6b7280',
          }}
        >
          {l}
        </button>
      ))}
    </div>
  );
  const Toggle = ({opts, val, onChange}) => (
    <div style={{display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid #d1d5db'}}>
      {opts.map((o, i) => (
        <React.Fragment key={o}>
          {i > 0 && <div style={{width: 1, background: '#d1d5db', flexShrink: 0}} />}
          <button
            type="button"
            onClick={() => onChange(val === o ? '' : o)}
            style={{
              flex: 1,
              padding: '9px 0',
              border: 'none',
              fontFamily: 'inherit',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              background: val === o ? '#085041' : 'white',
              color: val === o ? 'white' : '#6b7280',
            }}
          >
            {o}
          </button>
        </React.Fragment>
      ))}
    </div>
  );

  // Validate that all required fields (from admin config) have values.
  // Returns an error message string if a required field is missing, or null if all good.
  // formId = 'broiler-dailys' / 'layer-dailys' / 'pig-dailys' / 'egg-dailys'
  // formValues = an object mapping fieldId → current value from the relevant form state
  function validateRequiredFields(formId, formValues) {
    const wf = (cfg.webforms || []).find((w) => w.id === formId);
    if (!wf) return null;
    const allFields = (wf.sections || []).flatMap((s) => s.fields || []);
    const required = allFields.filter((f) => f.required === true && f.enabled !== false);
    for (const f of required) {
      // feed_type is only required when feed_lbs > 0 (conditional rule)
      if (f.id === 'feed_type' && !(parseFloat(formValues['feed_lbs']) > 0)) continue;
      // mortality_reason is only required when mortality_count > 0 (conditional rule)
      if (f.id === 'mortality_reason' && !(parseInt(formValues['mortality_count']) > 0)) continue;
      const v = formValues[f.id];
      // Empty string, null, undefined → missing. Boolean false IS valid (e.g. "Group moved? No").
      const missing = v === '' || v == null || (typeof v === 'string' && v.trim() === '');
      if (missing) {
        return (f.label || f.id) + ' is required.';
      }
    }
    // Mortality reason is always required when mortality_count > 0, regardless of admin config
    if (parseInt(formValues['mortality_count']) > 0) {
      const mr = formValues['mortality_reason'];
      if (!mr || String(mr).trim() === '') return 'Mortality reason is required when mortalities are reported.';
    }
    return null;
  }

  async function submitBroiler() {
    // Hardcoded system field check (always required regardless of config)
    if (!bForm.date || !bForm.teamMember || !bForm.batchLabel) {
      setErr('Please fill in all required fields.');
      return;
    }
    // Config-driven required field check
    const valuesByFieldId = {
      date: bForm.date,
      team_member: bForm.teamMember,
      batch_label: bForm.batchLabel,
      feed_type: bForm.feedType,
      feed_lbs: bForm.feedLbs,
      grit_lbs: bForm.gritLbs,
      group_moved: bForm.groupMoved,
      waterer_checked: bForm.watererChecked,
      mortality_count: bForm.mortalityCount,
      mortality_reason: bForm.mortalityReason,
      comments: bForm.comments,
    };
    const reqErr = validateRequiredFields('broiler-dailys', valuesByFieldId);
    if (reqErr) {
      setErr(reqErr);
      return;
    }
    // Conditional rule: feed_type is required when feed_lbs > 0 (main + each extra group)
    if (parseFloat(bForm.feedLbs) > 0 && !bForm.feedType) {
      setErr('Feed Type is required when Feed (lbs) is entered.');
      return;
    }
    if (parseInt(bForm.mortalityCount) > 0 && !bForm.mortalityReason.trim()) {
      setErr('Mortality reason is required when mortalities are reported.');
      return;
    }
    for (const eg of extraBroilerGroups.filter((g) => g.batchLabel)) {
      if (parseFloat(eg.feedLbs) > 0 && !eg.feedType) {
        setErr('Feed Type is required for ' + eg.batchLabel + ' when Feed (lbs) is entered.');
        return;
      }
      if (parseInt(eg.mortalityCount) > 0 && !(eg.mortalityReason || '').trim()) {
        setErr('Mortality reason is required for ' + eg.batchLabel + ' when mortalities are reported.');
        return;
      }
    }
    setErr('');

    // Photos + Add-Group is a footgun: photos would attach to the primary
    // row only and operators would reasonably expect them to cover the
    // whole submission. Block before any upload until the daily_submissions
    // parent-table/RPC design lands. Mirrors the same constraint we put on
    // Add Feed (parent-submission deferred).
    const extraBroilerCount = extraBroilerGroups.filter((g) => g.batchLabel).length;
    if (bPhotos.length > 0 && extraBroilerCount > 0) {
      setErr(
        'Photos can only be attached when submitting one group at a time. ' +
          'Submit this report without extra groups, or submit each group ' +
          'separately with its own photos.',
      );
      return;
    }

    setSubmitting(true);
    localStorage.setItem('wcf_team', bForm.teamMember);

    const extraCount = extraBroilerGroups.filter((g) => g.batchLabel).length;

    // ── Multi-row Add-Group path (NO photos): preserved direct-insert.
    // Photos + extras is rejected above, so this branch always carries
    // photos: [] across every row. Hook is single-row only.
    if (extraCount > 0) {
      const t0 = Date.now();
      const buildExtraRec = (g, i) => ({
        id: String(t0 + i + 1) + Math.random().toString(36).slice(2, 6),
        client_submission_id: newClientSubmissionId(),
        submitted_at: new Date().toISOString(),
        date: bForm.date,
        team_member: bForm.teamMember,
        batch_label: g.batchLabel,
        feed_type: g.feedType || null,
        feed_lbs: g.feedLbs !== '' ? parseFloat(g.feedLbs) : null,
        grit_lbs: g.gritLbs !== '' ? parseFloat(g.gritLbs) : null,
        group_moved: g.groupMoved !== false,
        waterer_checked: g.watererChecked !== false,
        mortality_count: g.mortalityCount !== '' ? parseInt(g.mortalityCount) : 0,
        mortality_reason: g.mortalityReason || null,
        comments: g.comments || null,
        photos: [],
      });
      const primary = {
        id: String(t0) + Math.random().toString(36).slice(2, 6),
        client_submission_id: newClientSubmissionId(),
        submitted_at: new Date().toISOString(),
        date: bForm.date,
        team_member: bForm.teamMember,
        batch_label: bForm.batchLabel,
        feed_type: bForm.feedType,
        feed_lbs: bForm.feedLbs !== '' ? parseFloat(bForm.feedLbs) : null,
        grit_lbs: bForm.gritLbs !== '' ? parseFloat(bForm.gritLbs) : null,
        group_moved: bForm.groupMoved,
        waterer_checked: bForm.watererChecked,
        mortality_count: bForm.mortalityCount !== '' ? parseInt(bForm.mortalityCount) : 0,
        mortality_reason: bForm.mortalityReason || null,
        comments: bForm.comments || null,
        photos: [],
      };
      const recs = [primary, ...extraBroilerGroups.filter((g) => g.batchLabel).map(buildExtraRec)];
      const {error} = await sb.from('poultry_dailys').insert(recs);
      setSubmitting(false);
      if (error) {
        setErr('Could not save: ' + error.message);
        return;
      }
      // Multi-row email behavior preserved (Codex amendment 4).
      recs
        .filter((r) => r.feed_type === 'STARTER' && parseFloat(r.feed_lbs) > 0)
        .forEach((r) => {
          wcfSendEmail('starter_feed_check', {batch_label: r.batch_label, feed_lbs: r.feed_lbs});
        });
      setLastGroup(bForm.batchLabel);
      setExtraBroilerGroups([]);
      setBPhotos([]);
      setBPhotoStatuses([]);
      setDoneState('synced');
      setDone(true);
      return;
    }

    // ── Single-row path (with or without photos): through the hook.
    // Phase 1D-B Codex amendment 2: queued/stuck DROPS the starter_feed_check
    // email; only state:'synced' fires it. Locked by Playwright negative test.
    setBPhotoStatuses(bPhotos.length > 0 ? bPhotos.map(() => 'pending') : []);
    try {
      const payload = {
        date: bForm.date,
        team_member: bForm.teamMember,
        batch_label: bForm.batchLabel,
        feed_type: bForm.feedType,
        feed_lbs: bForm.feedLbs !== '' ? parseFloat(bForm.feedLbs) : null,
        grit_lbs: bForm.gritLbs !== '' ? parseFloat(bForm.gritLbs) : null,
        group_moved: bForm.groupMoved,
        waterer_checked: bForm.watererChecked,
        mortality_count: bForm.mortalityCount !== '' ? parseInt(bForm.mortalityCount) : 0,
        mortality_reason: bForm.mortalityReason || null,
        comments: bForm.comments || null,
      };
      if (bPhotos.length > 0) payload.photos = bPhotos; // raw File[]; hook compresses + sanitizes
      const result = await broilerHook.submit(payload);
      if (result.state === 'synced') {
        if (payload.feed_type === 'STARTER' && parseFloat(payload.feed_lbs) > 0) {
          wcfSendEmail('starter_feed_check', {batch_label: payload.batch_label, feed_lbs: payload.feed_lbs});
        }
      }
      if (bPhotos.length > 0) {
        const statusFor = result.state === 'synced' ? 'uploaded' : result.state === 'queued' ? 'queued' : 'failed';
        setBPhotoStatuses(bPhotos.map(() => statusFor));
      }
      if (result.state === 'stuck') setWfStuckOpen(true);
      setLastGroup(bForm.batchLabel);
      setExtraBroilerGroups([]);
      setBPhotos([]);
      setDoneState(result.state);
      setDone(true);
    } catch (e) {
      setErr('Could not save: ' + (e?.message || e));
      if (bPhotos.length > 0) setBPhotoStatuses(bPhotos.map(() => 'failed'));
    } finally {
      setSubmitting(false);
    }
  }
  async function submitLayer() {
    if (!lForm.date || !lForm.teamMember || !lForm.batchLabel) {
      setErr('Please fill in all required fields.');
      return;
    }
    const valuesByFieldId = {
      date: lForm.date,
      team_member: lForm.teamMember,
      batch_label: lForm.batchLabel,
      feed_type: lForm.feedType,
      feed_lbs: lForm.feedLbs,
      grit_lbs: lForm.gritLbs,
      layer_count: lForm.layerCount,
      group_moved: lForm.groupMoved,
      waterer_checked: lForm.watererChecked,
      mortality_count: lForm.mortalityCount,
      mortality_reason: lForm.mortalityReason,
      comments: lForm.comments,
    };
    const reqErr = validateRequiredFields('layer-dailys', valuesByFieldId);
    if (reqErr) {
      setErr(reqErr);
      return;
    }
    // Conditional rule: feed_type is required when feed_lbs > 0 (main + each extra group)
    if (parseFloat(lForm.feedLbs) > 0 && !lForm.feedType) {
      setErr('Feed Type is required when Feed (lbs) is entered.');
      return;
    }
    if (parseInt(lForm.mortalityCount) > 0 && !lForm.mortalityReason.trim()) {
      setErr('Mortality reason is required when mortalities are reported.');
      return;
    }
    for (const eg of extraLayerGroups.filter((g) => g.batchLabel)) {
      if (parseFloat(eg.feedLbs) > 0 && !eg.feedType) {
        setErr('Feed Type is required for ' + eg.batchLabel + ' when Feed (lbs) is entered.');
        return;
      }
      if (parseInt(eg.mortalityCount) > 0 && !(eg.mortalityReason || '').trim()) {
        setErr('Mortality reason is required for ' + eg.batchLabel + ' when mortalities are reported.');
        return;
      }
    }
    setErr('');

    // See submitBroiler for why we block photos + extra-groups in v1.
    const extraLayerCount = extraLayerGroups.filter((g) => g.batchLabel).length;
    if (lPhotos.length > 0 && extraLayerCount > 0) {
      setErr(
        'Photos can only be attached when submitting one group at a time. ' +
          'Submit this report without extra groups, or submit each group ' +
          'separately with its own photos.',
      );
      return;
    }

    setSubmitting(true);
    localStorage.setItem('wcf_team', lForm.teamMember);

    const csid = newClientSubmissionId();
    let photoMeta;
    try {
      photoMeta = await uploadPhotosOrAbort('layer_dailys', csid, lPhotos, setLPhotoStatuses);
    } catch (e) {
      setSubmitting(false);
      setErr('Photo upload failed: ' + (e?.message || e) + '. Submission aborted — try again.');
      return;
    }

    const rec = {
      id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
      client_submission_id: csid,
      submitted_at: new Date().toISOString(),
      date: lForm.date,
      team_member: lForm.teamMember,
      batch_label: lForm.batchLabel,
      batch_id: resolveBatchId(lForm.batchLabel),
      feed_type: lForm.feedType,
      feed_lbs: lForm.feedLbs !== '' ? parseFloat(lForm.feedLbs) : null,
      grit_lbs: lForm.gritLbs !== '' ? parseFloat(lForm.gritLbs) : null,
      layer_count: lForm.layerCount !== '' ? parseInt(lForm.layerCount) : null,
      group_moved: lForm.groupMoved,
      waterer_checked: lForm.watererChecked,
      mortality_count: lForm.mortalityCount !== '' ? parseInt(lForm.mortalityCount) : 0,
      mortality_reason: lForm.mortalityReason || null,
      comments: lForm.comments || null,
      photos: photoMeta,
    };
    const recs = [
      rec,
      ...extraLayerGroups
        .filter((g) => g.batchLabel)
        .map((g) => ({
          ...rec,
          id: String(Date.now() + Math.random()) + Math.random().toString(36).slice(2, 6),
          client_submission_id: newClientSubmissionId(),
          batch_label: g.batchLabel,
          batch_id: resolveBatchId(g.batchLabel),
          feed_type: g.feedType || null,
          feed_lbs: g.feedLbs !== '' ? parseFloat(g.feedLbs) : null,
          grit_lbs: g.gritLbs !== '' ? parseFloat(g.gritLbs) : null,
          layer_count: g.layerCount !== '' ? parseInt(g.layerCount) : null,
          group_moved: g.groupMoved !== false,
          waterer_checked: g.watererChecked !== false,
          mortality_count: g.mortalityCount !== '' ? parseInt(g.mortalityCount) : 0,
          mortality_reason: g.mortalityReason || null,
          comments: g.comments || null,
          photos: [],
        })),
    ];
    const {error} = await sb.from('layer_dailys').insert(recs.length === 1 ? recs[0] : recs);
    setSubmitting(false);
    if (error) {
      if (photoMeta.length > 0) {
        console.error(
          '[WebformHub] layer_dailys insert failed AFTER photo upload — orphan storage paths:',
          photoMeta.map((p) => p.path),
        );
      }
      setErr('Could not save: ' + error.message);
      return;
    }
    // Check starter feed threshold for STARTER layer records (same alert as broilers)
    recs
      .filter((r) => r.feed_type === 'STARTER' && parseFloat(r.feed_lbs) > 0)
      .forEach((r) => {
        wcfSendEmail('starter_feed_check', {batch_label: r.batch_label, feed_lbs: r.feed_lbs, table: 'layer_dailys'});
      });
    // Mortality reports do NOT touch current_count (Model X). But if a hen count
    // is provided, it becomes the new verified anchor for that housing.
    for (const r of recs) {
      const lc = parseInt(r.layer_count);
      if (!isNaN(lc) && lc >= 0 && r.batch_label) {
        await setHousingAnchorFromReport(sb, r.batch_label, lc, r.date);
      }
    }
    setLastGroup(lForm.batchLabel);
    setExtraLayerGroups([]);
    setLPhotos([]);
    setLPhotoStatuses([]);
    // Codex review pre-commit: layer's direct-insert path must reset
    // doneState so a prior queued/stuck broiler/pig/cattle/sheep submit
    // doesn't leak its done copy onto layer's success screen in the same
    // mounted hub session.
    setDoneState('synced');
    setDone(true);
  }
  async function submitPig() {
    if (!pForm.date || !pForm.teamMember || !pForm.batchLabel) {
      setErr('Please fill in all required fields.');
      return;
    }
    const valuesByFieldId = {
      date: pForm.date,
      team_member: pForm.teamMember,
      batch_label: pForm.batchLabel,
      feed_lbs: pForm.feedLbs,
      pig_count: pForm.pigCount,
      fence_voltage: pForm.fenceVoltage,
      group_moved: pForm.groupMoved,
      nipple_drinker_moved: pForm.nippleDrinkerMoved,
      nipple_drinker_working: pForm.nippleDrinkerWorking,
      troughs_moved: pForm.troughsMoved,
      fence_walked: pForm.fenceWalked,
      issues: pForm.issues,
    };
    const reqErr = validateRequiredFields('pig-dailys', valuesByFieldId);
    if (reqErr) {
      setErr(reqErr);
      return;
    }
    setErr('');

    // See submitBroiler for why we block photos + extra-groups in v1.
    const extraPigCount = extraPigGroups.filter((g) => g.batchLabel).length;
    if (pPhotos.length > 0 && extraPigCount > 0) {
      setErr(
        'Photos can only be attached when submitting one group at a time. ' +
          'Submit this report without extra groups, or submit each group ' +
          'separately with its own photos.',
      );
      return;
    }

    setSubmitting(true);
    localStorage.setItem('wcf_team', pForm.teamMember);

    const extraCount = extraPigGroups.filter((g) => g.batchLabel).length;

    // ── Multi-row Add-Group path (NO photos): preserved direct-insert.
    if (extraCount > 0) {
      const t0 = Date.now();
      const buildExtraRec = (g, i) => ({
        id: String(t0 + i + 1) + Math.random().toString(36).slice(2, 6),
        client_submission_id: newClientSubmissionId(),
        submitted_at: new Date().toISOString(),
        date: pForm.date,
        team_member: pForm.teamMember,
        batch_label: g.batchLabel,
        batch_id: g.batchLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        feed_lbs: g.feedLbs !== '' ? parseFloat(g.feedLbs) : null,
        pig_count: g.pigCount !== '' ? parseInt(g.pigCount) : null,
        fence_voltage: g.fenceVoltage !== '' ? parseFloat(g.fenceVoltage) : null,
        group_moved: g.groupMoved !== false,
        nipple_drinker_moved: g.nippleDrinkerMoved !== false,
        nipple_drinker_working: g.nippleDrinkerWorking !== false,
        troughs_moved: g.troughsMoved !== false,
        fence_walked: g.fenceWalked !== false,
        issues: g.issues || null,
        photos: [],
      });
      const primary = {
        id: String(t0) + Math.random().toString(36).slice(2, 6),
        client_submission_id: newClientSubmissionId(),
        submitted_at: new Date().toISOString(),
        date: pForm.date,
        team_member: pForm.teamMember,
        batch_label: pForm.batchLabel,
        batch_id: pForm.batchLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        feed_lbs: pForm.feedLbs !== '' ? parseFloat(pForm.feedLbs) : null,
        pig_count: pForm.pigCount !== '' ? parseInt(pForm.pigCount) : null,
        group_moved: pForm.groupMoved,
        nipple_drinker_moved: pForm.nippleDrinkerMoved,
        nipple_drinker_working: pForm.nippleDrinkerWorking,
        troughs_moved: pForm.troughsMoved,
        fence_walked: pForm.fenceWalked,
        fence_voltage: pForm.fenceVoltage !== '' ? parseFloat(pForm.fenceVoltage) : null,
        issues: pForm.issues || null,
        photos: [],
      };
      const recs = [primary, ...extraPigGroups.filter((g) => g.batchLabel).map(buildExtraRec)];
      const {error} = await sb.from('pig_dailys').insert(recs);
      setSubmitting(false);
      if (error) {
        setErr('Could not save: ' + error.message);
        return;
      }
      setLastGroup(pForm.batchLabel);
      setExtraPigGroups([]);
      setPPhotos([]);
      setPPhotoStatuses([]);
      setDoneState('synced');
      setDone(true);
      return;
    }

    // ── Single-row path: through the hook.
    setPPhotoStatuses(pPhotos.length > 0 ? pPhotos.map(() => 'pending') : []);
    try {
      const payload = {
        date: pForm.date,
        team_member: pForm.teamMember,
        batch_id: pForm.batchLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        batch_label: pForm.batchLabel,
        pig_count: pForm.pigCount !== '' ? parseInt(pForm.pigCount) : null,
        feed_lbs: pForm.feedLbs !== '' ? parseFloat(pForm.feedLbs) : null,
        group_moved: pForm.groupMoved,
        nipple_drinker_moved: pForm.nippleDrinkerMoved,
        nipple_drinker_working: pForm.nippleDrinkerWorking,
        troughs_moved: pForm.troughsMoved,
        fence_walked: pForm.fenceWalked,
        fence_voltage: pForm.fenceVoltage !== '' ? parseFloat(pForm.fenceVoltage) : null,
        issues: pForm.issues || null,
      };
      if (pPhotos.length > 0) payload.photos = pPhotos;
      const result = await pigHook.submit(payload);
      if (pPhotos.length > 0) {
        const statusFor = result.state === 'synced' ? 'uploaded' : result.state === 'queued' ? 'queued' : 'failed';
        setPPhotoStatuses(pPhotos.map(() => statusFor));
      }
      if (result.state === 'stuck') setWfStuckOpen(true);
      setLastGroup(pForm.batchLabel);
      setExtraPigGroups([]);
      setPPhotos([]);
      setDoneState(result.state);
      setDone(true);
    } catch (e) {
      setErr('Could not save: ' + (e?.message || e));
      if (pPhotos.length > 0) setPPhotoStatuses(pPhotos.map(() => 'failed'));
    } finally {
      setSubmitting(false);
    }
  }
  async function submitEgg() {
    if (!eForm.date || !eForm.teamMember) {
      setErr('Please fill in date and team member.');
      return;
    }
    // An egg_group field is considered "filled" if either a group name OR an egg count was provided
    const grpFilled = (n, c) => (n && String(n).trim() !== '') || (c !== '' && c != null);
    const valuesByFieldId = {
      date: eForm.date,
      team_member: eForm.teamMember,
      dozens_on_hand: eForm.dozensOnHand,
      comments: eForm.comments,
      group1_pair: grpFilled(eForm.g1n, eForm.g1c) ? 'filled' : '',
      group2_pair: grpFilled(eForm.g2n, eForm.g2c) ? 'filled' : '',
      group3_pair: grpFilled(eForm.g3n, eForm.g3c) ? 'filled' : '',
      group4_pair: grpFilled(eForm.g4n, eForm.g4c) ? 'filled' : '',
    };
    const reqErr = validateRequiredFields('egg-dailys', valuesByFieldId);
    if (reqErr) {
      setErr(reqErr);
      return;
    }
    setErr('');
    setSubmitting(true);
    localStorage.setItem('wcf_team', eForm.teamMember);
    const g1 = eForm.g1c !== '' ? parseInt(eForm.g1c) : 0;
    const g2 = eForm.g2c !== '' ? parseInt(eForm.g2c) : 0;
    const g3 = eForm.g3c !== '' ? parseInt(eForm.g3c) : 0;
    const g4 = eForm.g4c !== '' ? parseInt(eForm.g4c) : 0;
    const daily_dozen_count = Math.floor((g1 + g2 + g3 + g4) / 12);
    const rec = {
      id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
      submitted_at: new Date().toISOString(),
      date: eForm.date,
      team_member: eForm.teamMember,
      group1_name: eForm.g1n || null,
      group1_count: eForm.g1c !== '' ? g1 : null,
      group2_name: eForm.g2n || null,
      group2_count: eForm.g2c !== '' ? g2 : null,
      group3_name: eForm.g3n || null,
      group3_count: eForm.g3c !== '' ? g3 : null,
      group4_name: eForm.g4n || null,
      group4_count: eForm.g4c !== '' ? g4 : null,
      daily_dozen_count,
      dozens_on_hand: eForm.dozensOnHand !== '' ? parseFloat(eForm.dozensOnHand) : null,
      comments: eForm.comments || null,
    };
    const {error} = await sb.from('egg_dailys').insert(rec);
    setSubmitting(false);
    if (error) {
      setErr('Could not save: ' + error.message);
      return;
    }
    // Send egg report email (fire-and-forget)
    wcfSendEmail('egg_report', {
      date: rec.date,
      team_member: rec.team_member,
      dozens_on_hand: rec.dozens_on_hand,
      daily_dozen_count: rec.daily_dozen_count,
    });
    // Codex review pre-commit: same reset reason as submitLayer.
    setDoneState('synced');
    setDone(true);
  }
  async function submitCattle() {
    // Build values-by-field-id so admin-configured "required" toggles are honored.
    // For jsonb arrays (feeds, minerals) we flag 'filled' when at least one row has a qty/lbs.
    const anyFeed = (cForm.feeds || []).some((r) => r.feedId && r.qty !== '' && r.qty != null && parseFloat(r.qty) > 0);
    const anyMineral = (cForm.minerals || []).some(
      (r) => r.feedId && r.lbs !== '' && r.lbs != null && parseFloat(r.lbs) > 0,
    );
    const valuesByFieldId = {
      date: cForm.date,
      team_member: cForm.teamMember,
      herd: cForm.herd,
      feeds: anyFeed ? 'filled' : '',
      minerals: anyMineral ? 'filled' : '',
      fence_voltage: cForm.fenceVoltage,
      water_checked: cForm.waterChecked,
      issues: cForm.issues,
    };
    const reqErr = validateRequiredFields('cattle-dailys', valuesByFieldId);
    if (reqErr) {
      setErr(reqErr);
      return;
    }
    setErr('');
    setSubmitting(true);
    localStorage.setItem('wcf_team', cForm.teamMember);
    // Build feeds jsonb with nutrition snapshots from the feed master list
    const feedsJ = (cForm.feeds || [])
      .filter((f) => f.feedId && f.qty !== '' && f.qty != null)
      .map((f) => {
        const fi = cattleFeedInputs.find((x) => x.id === f.feedId);
        if (!fi) return null;
        const qty = parseFloat(f.qty) || 0;
        const unitWt = parseFloat(fi.unit_weight_lbs) || 1;
        const lbsAsFed = qty * unitWt;
        return {
          feed_input_id: fi.id,
          feed_name: fi.name,
          category: fi.category,
          qty: qty,
          unit: fi.unit,
          lbs_as_fed: Math.round(lbsAsFed * 100) / 100,
          is_creep: !!f.isCreep,
          nutrition_snapshot: {
            moisture_pct: fi.moisture_pct,
            nfc_pct: fi.nfc_pct,
            protein_pct: fi.protein_pct,
          },
        };
      })
      .filter(Boolean);
    const mineralsJ = (cForm.minerals || [])
      .filter((m) => m.feedId && m.lbs !== '' && m.lbs != null)
      .map((m) => {
        const fi = cattleFeedInputs.find((x) => x.id === m.feedId);
        if (!fi) return null;
        return {
          feed_input_id: fi.id,
          name: fi.name,
          lbs: parseFloat(m.lbs) || 0,
        };
      })
      .filter(Boolean);
    setCPhotoStatuses(cPhotos.length > 0 ? cPhotos.map(() => 'pending') : []);
    try {
      const payload = {
        date: cForm.date,
        team_member: cForm.teamMember,
        herd: cForm.herd,
        feedsJ,
        mineralsJ,
        fence_voltage: cForm.fenceVoltage !== '' ? parseFloat(cForm.fenceVoltage) : null,
        water_checked: cForm.waterChecked,
        mortality_count: cForm.mortalityCount !== '' ? parseInt(cForm.mortalityCount) : 0,
        mortality_reason: cForm.mortalityReason || null,
        issues: cForm.issues || null,
      };
      if (cPhotos.length > 0) payload.photos = cPhotos;
      const result = await cattleHook.submit(payload);
      if (cPhotos.length > 0) {
        const statusFor = result.state === 'synced' ? 'uploaded' : result.state === 'queued' ? 'queued' : 'failed';
        setCPhotoStatuses(cPhotos.map(() => statusFor));
      }
      if (result.state === 'stuck') setWfStuckOpen(true);
      setLastGroup(cForm.herd);
      setCPhotos([]);
      setDoneState(result.state);
      setDone(true);
    } catch (e) {
      setErr('Could not save: ' + (e?.message || e));
      if (cPhotos.length > 0) setCPhotoStatuses(cPhotos.map(() => 'failed'));
    } finally {
      setSubmitting(false);
    }
  }
  async function submitSheep() {
    // Hardcoded system fields — always required regardless of admin config
    if (!sForm.date || !sForm.teamMember || !sForm.flock) {
      setErr('Date, team member, and flock are required.');
      return;
    }
    setErr('');
    setSubmitting(true);
    localStorage.setItem('wcf_team', sForm.teamMember);
    // Build feeds jsonb from picker rows — mirrors cattle's shape
    const feedsJ = (sForm.feeds || [])
      .filter((f) => f.feedId && f.qty !== '' && f.qty != null)
      .map((f) => {
        const fi = cattleFeedInputs.find((x) => x.id === f.feedId);
        if (!fi) return null;
        const qty = parseFloat(f.qty) || 0;
        const unitWt = parseFloat(fi.unit_weight_lbs) || 1;
        return {
          feed_input_id: fi.id,
          feed_name: fi.name,
          category: fi.category,
          qty,
          unit: fi.unit,
          lbs_as_fed: Math.round(qty * unitWt * 100) / 100,
          is_creep: false,
        };
      })
      .filter(Boolean);
    const mineralsJ = (sForm.minerals || [])
      .filter((m) => m.feedId && m.lbs !== '' && m.lbs != null)
      .map((m) => {
        const fi = cattleFeedInputs.find((x) => x.id === m.feedId);
        if (!fi) return null;
        return {
          feed_input_id: fi.id,
          name: fi.name,
          lbs: parseFloat(m.lbs),
        };
      })
      .filter(Boolean);
    setShPhotoStatuses(shPhotos.length > 0 ? shPhotos.map(() => 'pending') : []);
    try {
      const payload = {
        date: sForm.date,
        team_member: sForm.teamMember,
        flock: sForm.flock,
        feedsJ,
        mineralsJ,
        fence_voltage_kv: sForm.fenceVoltageKv !== '' ? parseFloat(sForm.fenceVoltageKv) : null,
        waterers_working: !!sForm.waterersWorking,
        mortality_count: 0,
        comments: sForm.comments || null,
      };
      if (shPhotos.length > 0) payload.photos = shPhotos;
      const result = await sheepHook.submit(payload);
      if (shPhotos.length > 0) {
        const statusFor = result.state === 'synced' ? 'uploaded' : result.state === 'queued' ? 'queued' : 'failed';
        setShPhotoStatuses(shPhotos.map(() => statusFor));
      }
      if (result.state === 'stuck') setWfStuckOpen(true);
      setLastGroup({rams: 'Rams', ewes: 'Ewes', feeders: 'Feeders'}[sForm.flock] || sForm.flock);
      setShPhotos([]);
      setDoneState(result.state);
      setDone(true);
    } catch (e) {
      setErr('Could not save: ' + (e?.message || e));
      if (shPhotos.length > 0) setShPhotoStatuses(shPhotos.map(() => 'failed'));
    } finally {
      setSubmitting(false);
    }
  }

  function resetAndAnother() {
    const team = '';
    const today = todayStr();
    if (activeForm === 'broiler') setBForm({...EMPTY_B, date: today, teamMember: team, batchLabel: lastGroup});
    else if (activeForm === 'layer') setLForm({...EMPTY_L, date: today, teamMember: team, batchLabel: lastGroup});
    else if (activeForm === 'pig') setPForm({...EMPTY_P, date: today, teamMember: team, batchLabel: lastGroup});
    else if (activeForm === 'cattle') setCForm({...EMPTY_C, date: today, teamMember: team});
    else if (activeForm === 'sheep')
      setSForm({...EMPTY_S, date: today, teamMember: team, flock: lastGroup ? sForm.flock : ''});
    else setEForm({...EMPTY_E, date: today, teamMember: team});
    setDone(false);
    setDoneState('synced'); // Reset so the next submit's done screen starts clean.
    setErr('');
  }

  // Re-stamp form date to today whenever the user opens a form (handles stale tabs left open overnight).
  // Also resets stale dates that were captured when the WebformHub component first mounted.
  React.useEffect(() => {
    if (!activeForm) return;
    const today = todayStr();
    if (activeForm === 'broiler') setBForm((f) => (f.date === today ? f : {...f, date: today}));
    else if (activeForm === 'layer') setLForm((f) => (f.date === today ? f : {...f, date: today}));
    else if (activeForm === 'pig') setPForm((f) => (f.date === today ? f : {...f, date: today}));
    else if (activeForm === 'egg') setEForm((f) => (f.date === today ? f : {...f, date: today}));
    else if (activeForm === 'cattle') setCForm((f) => (f.date === today ? f : {...f, date: today}));
    else if (activeForm === 'sheep') setSForm((f) => (f.date === today ? f : {...f, date: today}));
  }, [activeForm]);

  const wfBg = {
    minHeight: '100vh',
    background: 'linear-gradient(135deg,#f0fdf4 0%,#ecfdf5 100%)',
    padding: '1rem',
    fontFamily: 'inherit',
  };
  const logo = (
    <div style={{textAlign: 'center', marginBottom: 20}}>
      <div style={{fontSize: 18, fontWeight: 800, color: '#085041', letterSpacing: -0.3}}>🌾 WCF Planner</div>
      <div style={{fontSize: 12, color: '#6b7280', marginTop: 2}}>Daily Report</div>
    </div>
  );

  // Success screen — Phase 1D-B reads doneState ∈ {synced, queued, stuck}
  // for the included form-kinds. Layer + egg + multi-row direct paths set
  // doneState='synced' so existing copy is preserved.
  if (done)
    return (
      <div style={wfBg}>
        <div style={{maxWidth: 480, margin: '0 auto', paddingTop: '2rem', textAlign: 'center'}}>
          {logo}
          <div style={{fontSize: 56, marginBottom: 12}}>
            {doneState === 'queued' ? '📡' : doneState === 'stuck' ? '⚠️' : '✅'}
          </div>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: doneState === 'queued' ? '#92400e' : doneState === 'stuck' ? '#b91c1c' : '#085041',
              marginBottom: 8,
            }}
          >
            {doneState === 'queued'
              ? 'Saved on this device'
              : doneState === 'stuck'
                ? 'Saved on this device — sync needs help'
                : 'Report Submitted!'}
          </div>
          {doneState === 'queued' && (
            <div
              data-submit-state="queued"
              style={{
                fontSize: 13,
                color: '#78716c',
                marginBottom: 22,
                lineHeight: 1.5,
                background: '#fef3c7',
                border: '1px solid #fde68a',
                borderRadius: 8,
                padding: '10px 14px',
                textAlign: 'left',
              }}
            >
              No connection right now. Daily report queued for <strong>{lastGroup}</strong> and will sync as soon as the
              device is back online.
            </div>
          )}
          {doneState === 'stuck' && (
            <div
              data-submit-state="stuck"
              style={{
                fontSize: 13,
                color: '#7f1d1d',
                marginBottom: 22,
                lineHeight: 1.5,
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: 8,
                padding: '10px 14px',
                textAlign: 'left',
              }}
            >
              Your daily report for <strong>{lastGroup}</strong> is saved on this device, but sync hit an error that
              won't fix itself by retrying. Open the stuck submissions panel to retry after a fix or discard.
            </div>
          )}
          {doneState === 'synced' && (
            <div style={{fontSize: 14, color: '#6b7280', marginBottom: 24}}>
              <span data-submit-state="synced" style={{display: 'none'}}>
                synced
              </span>
              {lastGroup ? `${lastGroup} — ` : ''}saved successfully.
            </div>
          )}
          <button
            onClick={resetAndAnother}
            style={{
              padding: '12px 28px',
              borderRadius: 10,
              border: 'none',
              background: '#085041',
              color: 'white',
              fontSize: 15,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              marginBottom: 12,
              width: '100%',
            }}
          >
            Submit Another
          </button>
          <button
            onClick={() => {
              setActiveForm(null);
              setDone(false);
            }}
            style={{
              padding: '12px 28px',
              borderRadius: 10,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#374151',
              fontSize: 15,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              width: '100%',
            }}
          >
            Back to Forms
          </button>
        </div>
        {stuckModalEl}
      </div>
    );

  // Form selector
  if (!activeForm)
    return (
      <div style={wfBg}>
        {showAppSetup && <AppSetupModal onClose={() => setShowAppSetup(false)} />}
        <div style={{maxWidth: 480, margin: '0 auto', paddingTop: '1rem'}}>
          {logo}
          <div style={{display: 'flex', justifyContent: 'center', marginBottom: 12}}>
            <button
              data-app-setup-trigger="1"
              onClick={() => setShowAppSetup(true)}
              style={{
                background: 'white',
                border: '1px solid #cfe6d8',
                borderRadius: 999,
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                color: '#085041',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              📲 App Setup
            </button>
          </div>
          <div style={{fontSize: 13, color: '#6b7280', textAlign: 'center', marginBottom: 20}}>
            Select a report type to fill out
          </div>
          <div
            onClick={function () {
              window.location.hash = '#addfeed';
              window.location.reload();
            }}
            style={{
              background: '#fef3c7',
              borderRadius: 12,
              padding: '16px 18px',
              marginBottom: 10,
              cursor: 'pointer',
              boxShadow: '0 1px 3px rgba(0,0,0,.08)',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              border: '1px solid #fde68a',
            }}
          >
            <div style={{fontSize: 32}}>{'\ud83c\udf3e'}</div>
            <div style={{flex: 1}}>
              <div style={{fontSize: 16, fontWeight: 700, color: '#92400e'}}>Add Feed</div>
              <div style={{fontSize: 12, color: '#92400e', opacity: 0.8}}>Quick log feed added in the field</div>
              <div style={{fontSize: 11, color: '#92400e', opacity: 0.6, marginTop: 2}}>
                {'Pig \u00b7 Broiler \u00b7 Layer \u00b7 Cattle \u00b7 Sheep'}
              </div>
            </div>
            <div style={{color: '#92400e', fontSize: 18}}>{'\u203a'}</div>
          </div>
          <div
            onClick={function () {
              window.location.hash = '#weighins';
              window.location.reload();
            }}
            style={{
              background: '#eff6ff',
              borderRadius: 12,
              padding: '16px 18px',
              marginBottom: 10,
              cursor: 'pointer',
              boxShadow: '0 1px 3px rgba(0,0,0,.08)',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              border: '1px solid #bfdbfe',
            }}
          >
            <div style={{fontSize: 32}}>{'\u2696\ufe0f'}</div>
            <div style={{flex: 1}}>
              <div style={{fontSize: 16, fontWeight: 700, color: '#1e40af'}}>Weigh-Ins</div>
              <div style={{fontSize: 12, color: '#1e40af', opacity: 0.8}}>
                Record weights for cattle, pigs, or broilers
              </div>
              <div style={{fontSize: 11, color: '#1e40af', opacity: 0.6, marginTop: 2}}>
                {'Sessions auto-save \u00b7 resume on any device'}
              </div>
            </div>
            <div style={{color: '#1e40af', fontSize: 18}}>{'\u203a'}</div>
          </div>
          <div
            data-tile="tasks"
            onClick={() => navigate('/dailys/tasks')}
            style={{
              background: '#f0fdfa',
              borderRadius: 12,
              padding: '16px 18px',
              marginBottom: 16,
              cursor: 'pointer',
              boxShadow: '0 1px 3px rgba(0,0,0,.08)',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              border: '1px solid #99f6e4',
            }}
          >
            <div style={{fontSize: 32}}>{'\u2705'}</div>
            <div style={{flex: 1}}>
              <div style={{fontSize: 16, fontWeight: 700, color: '#0f766e'}}>Submit a Task</div>
              <div style={{fontSize: 12, lineHeight: 1.35, color: '#0f766e', opacity: 0.8}}>
                Use this to assign tasks to a Wcf Planner user when there is a repair needed or anything that shouldn't
                be forgotten.
              </div>
            </div>
            <div style={{color: '#0f766e', fontSize: 18}}>{'\u203a'}</div>
          </div>
          {[
            {id: 'broiler', label: '🐔 Broiler Daily Report'},
            {id: 'layer', label: '🐓 Layer Daily Report'},
            {id: 'egg', label: '🥚 Egg Collection Report'},
            {id: 'pig', label: '🐷 Pig Daily Report'},
            {id: 'cattle', label: '🐄 Cattle Daily Report'},
            {id: 'sheep', label: '🐑 Sheep Daily Report'},
          ].map((f) => (
            <div
              key={f.id}
              onClick={() => setActiveForm(f.id)}
              style={{
                background: 'white',
                borderRadius: 12,
                padding: '16px 18px',
                marginBottom: 10,
                cursor: 'pointer',
                boxShadow: '0 1px 3px rgba(0,0,0,.08)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                border: '1px solid #e5e7eb',
              }}
            >
              <div style={{flex: 1, fontSize: 15, fontWeight: 600, color: '#111827'}}>{f.label}</div>
              <div style={{color: '#9ca3af', fontSize: 18}}>›</div>
            </div>
          ))}
        </div>
        {stuckModalEl}
      </div>
    );

  // ── BROILER FORM ──
  if (activeForm === 'broiler')
    return (
      <div style={wfBg}>
        <div style={{maxWidth: 480, margin: '0 auto'}}>
          {logo}
          <button
            onClick={() => setActiveForm(null)}
            style={{
              background: 'none',
              border: 'none',
              color: '#6b7280',
              fontSize: 13,
              cursor: 'pointer',
              marginBottom: 12,
              padding: 0,
              fontFamily: 'inherit',
            }}
          >
            ‹ Back
          </button>
          <div style={{fontSize: 17, fontWeight: 700, color: '#085041', marginBottom: 16}}>🐔 Broiler Daily Report</div>
          <div style={sectionStyle}>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>Date{reqStar('broiler-dailys', 'date')}</label>
                <input
                  type="date"
                  value={bForm.date}
                  onChange={(e) => setBForm((f) => ({...f, date: e.target.value}))}
                  style={inputStyle}
                />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>Team Member{reqStar('broiler-dailys', 'team_member')}</label>
                <select
                  value={bForm.teamMember}
                  onChange={(e) => setBForm((f) => ({...f, teamMember: e.target.value}))}
                  style={inputStyle}
                >
                  <option value="">Select...</option>
                  {getFormTeamMembers('broiler-dailys').map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>Broiler Group{reqStar('broiler-dailys', 'batch_label')}</label>
                <select
                  value={bForm.batchLabel}
                  onChange={(e) => setBForm((f) => ({...f, batchLabel: e.target.value}))}
                  style={inputStyle}
                >
                  <option value="">Select batch...</option>
                  {broilerGroups.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
              {parseFloat(bForm.feedLbs) > 0 && (
                <div style={{gridColumn: '1/-1'}}>
                  <label style={labelStyle}>
                    Feed Type<span style={{color: '#dc2626', marginLeft: 2}}>*</span>
                  </label>
                  <Toggle
                    opts={['STARTER', 'GROWER']}
                    val={bForm.feedType}
                    onChange={(v) => setBForm((f) => ({...f, feedType: v}))}
                  />
                </div>
              )}
              <div>
                <label style={labelStyle}>Feed (lbs){reqStar('broiler-dailys', 'feed_lbs')}</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={bForm.feedLbs || ''}
                  onChange={(e) => setBForm((f) => ({...f, feedLbs: e.target.value}))}
                  placeholder="0"
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>Grit (lbs){reqStar('broiler-dailys', 'grit_lbs')}</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={bForm.gritLbs || ''}
                  onChange={(e) => setBForm((f) => ({...f, gritLbs: e.target.value}))}
                  placeholder="0"
                  style={inputStyle}
                />
              </div>
            </div>
          </div>
          <div style={sectionStyle}>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
              <div>
                <label style={labelStyle}>Group moved?{reqStar('broiler-dailys', 'group_moved')}</label>
                <YN val={bForm.groupMoved} onChange={(v) => setBForm((f) => ({...f, groupMoved: v}))} />
              </div>
              <div>
                <label style={labelStyle}>Waterer checked?{reqStar('broiler-dailys', 'waterer_checked')}</label>
                <YN val={bForm.watererChecked} onChange={(v) => setBForm((f) => ({...f, watererChecked: v}))} />
              </div>
            </div>
          </div>
          <div style={sectionStyle}>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
              <div>
                <label style={labelStyle}>Mortalities{reqStar('broiler-dailys', 'mortality_count')}</label>
                <input
                  type="number"
                  min="0"
                  value={bForm.mortalityCount || ''}
                  onChange={(e) => setBForm((f) => ({...f, mortalityCount: e.target.value}))}
                  placeholder="0"
                  style={inputStyle}
                />
              </div>
              {parseInt(bForm.mortalityCount) > 0 && (
                <div>
                  <label style={labelStyle}>
                    Reason <span style={{color: '#dc2626'}}>*</span>
                  </label>
                  <input
                    value={bForm.mortalityReason}
                    onChange={(e) => setBForm((f) => ({...f, mortalityReason: e.target.value}))}
                    style={inputStyle}
                  />
                </div>
              )}
            </div>
          </div>
          <div style={sectionStyle}>
            <label style={labelStyle}>Comments / Issues{reqStar('broiler-dailys', 'comments')}</label>
            <textarea
              value={bForm.comments}
              onChange={(e) => setBForm((f) => ({...f, comments: e.target.value}))}
              rows={3}
              placeholder="Type 0 if nothing to report"
              style={{...inputStyle, resize: 'vertical'}}
            />
          </div>
          {allowAddGroup('broiler-dailys') && (
            <div>
              {extraBroilerGroups.map((eg, ei) => (
                <div key={ei} style={{...sectionStyle, border: '1px solid #a7f3d0', marginTop: 0}}>
                  <div
                    style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8}}
                  >
                    <div style={{fontSize: 13, fontWeight: 600, color: '#085041'}}>Additional Group {ei + 2}</div>
                    <button
                      type="button"
                      onClick={() => setExtraBroilerGroups((p) => p.filter((_, i) => i !== ei))}
                      style={{background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 18}}
                    >
                      ×
                    </button>
                  </div>
                  <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                    <div style={{gridColumn: '1/-1'}}>
                      <label style={labelStyle}>Broiler Group{reqStar('broiler-dailys', 'batch_label')}</label>
                      <select
                        value={eg.batchLabel || ''}
                        onChange={(e) =>
                          setExtraBroilerGroups((p) =>
                            p.map((g, i) => (i === ei ? {...g, batchLabel: e.target.value} : g)),
                          )
                        }
                        style={inputStyle}
                      >
                        <option value="">Select batch...</option>
                        {broilerGroups.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    </div>
                    {parseFloat(eg.feedLbs) > 0 && (
                      <div style={{gridColumn: '1/-1'}}>
                        <label style={labelStyle}>
                          Feed Type<span style={{color: '#dc2626', marginLeft: 2}}>*</span>
                        </label>
                        <Toggle
                          opts={['STARTER', 'GROWER']}
                          val={eg.feedType || ''}
                          onChange={(v) =>
                            setExtraBroilerGroups((p) => p.map((g, i) => (i === ei ? {...g, feedType: v} : g)))
                          }
                        />
                      </div>
                    )}
                    <div>
                      <label style={labelStyle}>Feed (lbs){reqStar('broiler-dailys', 'feed_lbs')}</label>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={eg.feedLbs || ''}
                        onChange={(e) =>
                          setExtraBroilerGroups((p) =>
                            p.map((g, i) => (i === ei ? {...g, feedLbs: e.target.value} : g)),
                          )
                        }
                        placeholder="0"
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Grit (lbs){reqStar('broiler-dailys', 'grit_lbs')}</label>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={eg.gritLbs || ''}
                        onChange={(e) =>
                          setExtraBroilerGroups((p) =>
                            p.map((g, i) => (i === ei ? {...g, gritLbs: e.target.value} : g)),
                          )
                        }
                        placeholder="0"
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Group moved?{reqStar('broiler-dailys', 'group_moved')}</label>
                      <YN
                        val={eg.groupMoved !== false}
                        onChange={(v) =>
                          setExtraBroilerGroups((p) => p.map((g, i) => (i === ei ? {...g, groupMoved: v} : g)))
                        }
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Waterer checked?{reqStar('broiler-dailys', 'waterer_checked')}</label>
                      <YN
                        val={eg.watererChecked !== false}
                        onChange={(v) =>
                          setExtraBroilerGroups((p) => p.map((g, i) => (i === ei ? {...g, watererChecked: v} : g)))
                        }
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Mortalities{reqStar('broiler-dailys', 'mortality_count')}</label>
                      <input
                        type="number"
                        min="0"
                        value={eg.mortalityCount || ''}
                        onChange={(e) =>
                          setExtraBroilerGroups((p) =>
                            p.map((g, i) => (i === ei ? {...g, mortalityCount: e.target.value} : g)),
                          )
                        }
                        placeholder="0"
                        style={inputStyle}
                      />
                    </div>
                    {parseInt(eg.mortalityCount) > 0 && (
                      <div>
                        <label style={labelStyle}>
                          Mortality reason <span style={{color: '#dc2626'}}>*</span>
                        </label>
                        <input
                          value={eg.mortalityReason || ''}
                          onChange={(e) =>
                            setExtraBroilerGroups((p) =>
                              p.map((g, i) => (i === ei ? {...g, mortalityReason: e.target.value} : g)),
                            )
                          }
                          style={inputStyle}
                        />
                      </div>
                    )}
                    <div style={{gridColumn: '1/-1'}}>
                      <label style={labelStyle}>Comments / Issues{reqStar('broiler-dailys', 'comments')}</label>
                      <textarea
                        value={eg.comments || ''}
                        onChange={(e) =>
                          setExtraBroilerGroups((p) =>
                            p.map((g, i) => (i === ei ? {...g, comments: e.target.value} : g)),
                          )
                        }
                        rows={3}
                        placeholder="Type 0 if nothing to report"
                        style={{...inputStyle, resize: 'vertical'}}
                      />
                    </div>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setExtraBroilerGroups((p) => [
                    ...p,
                    {batchLabel: '', feedLbs: '', gritLbs: '', mortalityCount: '', comments: ''},
                  ])
                }
                style={{
                  width: '100%',
                  padding: 12,
                  borderRadius: 10,
                  border: '2px dashed #fde68a',
                  background: 'transparent',
                  color: '#78350f',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  marginBottom: 12,
                }}
              >
                + Add Another Group
              </button>
            </div>
          )}
          {err && (
            <div
              style={{
                color: '#b91c1c',
                fontSize: 13,
                marginBottom: 10,
                padding: '8px 12px',
                background: '#fef2f2',
                borderRadius: 8,
              }}
            >
              {err}
            </div>
          )}
          <DailyPhotoCapture
            files={bPhotos}
            statuses={bPhotoStatuses}
            onChange={setBPhotos}
            disabled={submitting}
            offlineCapable={true}
          />
          <button
            onClick={submitBroiler}
            disabled={submitting}
            style={{
              width: '100%',
              padding: 14,
              border: 'none',
              borderRadius: 10,
              background: '#085041',
              color: 'white',
              fontSize: 15,
              fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1,
              fontFamily: 'inherit',
              marginBottom: 16,
            }}
          >
            {submitting
              ? `Submitting ${1 + extraBroilerGroups.filter((g) => g.batchLabel).length} report(s)…`
              : 'Submit Report'}
          </button>
        </div>
        {stuckModalEl}
      </div>
    );

  // ── LAYER FORM ──
  if (activeForm === 'layer')
    return (
      <div style={wfBg}>
        <div style={{maxWidth: 480, margin: '0 auto'}}>
          {logo}
          <button
            onClick={() => setActiveForm(null)}
            style={{
              background: 'none',
              border: 'none',
              color: '#6b7280',
              fontSize: 13,
              cursor: 'pointer',
              marginBottom: 12,
              padding: 0,
              fontFamily: 'inherit',
            }}
          >
            ‹ Back
          </button>
          <div style={{fontSize: 17, fontWeight: 700, color: '#78350f', marginBottom: 16}}>🐓 Layer Daily Report</div>
          <div style={sectionStyle}>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>Date{reqStar('layer-dailys', 'date')}</label>
                <input
                  type="date"
                  value={lForm.date}
                  onChange={(e) => setLForm((f) => ({...f, date: e.target.value}))}
                  style={inputStyle}
                />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>Team Member{reqStar('layer-dailys', 'team_member')}</label>
                <select
                  value={lForm.teamMember}
                  onChange={(e) => setLForm((f) => ({...f, teamMember: e.target.value}))}
                  style={inputStyle}
                >
                  <option value="">Select...</option>
                  {getFormTeamMembers('layer-dailys').map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>Layer Group{reqStar('layer-dailys', 'batch_label')}</label>
                <select
                  value={lForm.batchLabel}
                  onChange={(e) => setLForm((f) => ({...f, batchLabel: e.target.value}))}
                  style={inputStyle}
                >
                  <option value="">Select group...</option>
                  {layerGroupNames.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </div>
              {parseFloat(lForm.feedLbs) > 0 && (
                <div style={{gridColumn: '1/-1'}}>
                  <label style={labelStyle}>
                    Feed Type<span style={{color: '#dc2626', marginLeft: 2}}>*</span>
                  </label>
                  <Toggle
                    opts={['LAYER', 'STARTER', 'GROWER']}
                    val={lForm.feedType}
                    onChange={(v) => setLForm((f) => ({...f, feedType: v}))}
                  />
                </div>
              )}
              <div>
                <label style={labelStyle}>Feed (lbs){reqStar('layer-dailys', 'feed_lbs')}</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={lForm.feedLbs || ''}
                  onChange={(e) => setLForm((f) => ({...f, feedLbs: e.target.value}))}
                  placeholder="0"
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>Grit (lbs){reqStar('layer-dailys', 'grit_lbs')}</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={lForm.gritLbs || ''}
                  onChange={(e) => setLForm((f) => ({...f, gritLbs: e.target.value}))}
                  placeholder="0"
                  style={inputStyle}
                />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>Current Hen Count{reqStar('layer-dailys', 'layer_count')}</label>
                <input
                  type="number"
                  min="0"
                  value={lForm.layerCount || ''}
                  onChange={(e) => setLForm((f) => ({...f, layerCount: e.target.value}))}
                  placeholder="0"
                  style={inputStyle}
                />
              </div>
            </div>
          </div>
          <div style={sectionStyle}>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
              <div>
                <label style={labelStyle}>Group moved?{reqStar('layer-dailys', 'group_moved')}</label>
                <YN val={lForm.groupMoved} onChange={(v) => setLForm((f) => ({...f, groupMoved: v}))} />
              </div>
              <div>
                <label style={labelStyle}>Waterer checked?{reqStar('layer-dailys', 'waterer_checked')}</label>
                <YN val={lForm.watererChecked} onChange={(v) => setLForm((f) => ({...f, watererChecked: v}))} />
              </div>
            </div>
          </div>
          <div style={sectionStyle}>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
              <div>
                <label style={labelStyle}>Mortalities{reqStar('layer-dailys', 'mortality_count')}</label>
                <input
                  type="number"
                  min="0"
                  value={lForm.mortalityCount || ''}
                  onChange={(e) => setLForm((f) => ({...f, mortalityCount: e.target.value}))}
                  placeholder="0"
                  style={inputStyle}
                />
              </div>
              {parseInt(lForm.mortalityCount) > 0 && (
                <div>
                  <label style={labelStyle}>
                    Reason <span style={{color: '#dc2626'}}>*</span>
                  </label>
                  <input
                    value={lForm.mortalityReason}
                    onChange={(e) => setLForm((f) => ({...f, mortalityReason: e.target.value}))}
                    style={inputStyle}
                  />
                </div>
              )}
            </div>
          </div>
          <div style={sectionStyle}>
            <label style={labelStyle}>Comments / Issues{reqStar('layer-dailys', 'comments')}</label>
            <textarea
              value={lForm.comments}
              onChange={(e) => setLForm((f) => ({...f, comments: e.target.value}))}
              rows={3}
              placeholder="Type 0 if nothing to report"
              style={{...inputStyle, resize: 'vertical'}}
            />
          </div>
          {allowAddGroup('layer-dailys') && (
            <div>
              {extraLayerGroups.map((eg, ei) => (
                <div key={ei} style={{...sectionStyle, border: '1px solid #fde68a', marginTop: 0}}>
                  <div
                    style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8}}
                  >
                    <div style={{fontSize: 13, fontWeight: 600, color: '#78350f'}}>Additional Group {ei + 2}</div>
                    <button
                      type="button"
                      onClick={() => setExtraLayerGroups((p) => p.filter((_, i) => i !== ei))}
                      style={{background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 18}}
                    >
                      ×
                    </button>
                  </div>
                  <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                    <div style={{gridColumn: '1/-1'}}>
                      <label style={labelStyle}>Layer Group{reqStar('layer-dailys', 'batch_label')}</label>
                      <select
                        value={eg.batchLabel || ''}
                        onChange={(e) =>
                          setExtraLayerGroups((p) =>
                            p.map((g, i) => (i === ei ? {...g, batchLabel: e.target.value} : g)),
                          )
                        }
                        style={inputStyle}
                      >
                        <option value="">Select group...</option>
                        {layerGroupNames.map((g) => (
                          <option key={g} value={g}>
                            {g}
                          </option>
                        ))}
                      </select>
                    </div>
                    {parseFloat(eg.feedLbs) > 0 && (
                      <div style={{gridColumn: '1/-1'}}>
                        <label style={labelStyle}>
                          Feed Type<span style={{color: '#dc2626', marginLeft: 2}}>*</span>
                        </label>
                        <Toggle
                          opts={['LAYER', 'STARTER', 'GROWER']}
                          val={eg.feedType || ''}
                          onChange={(v) =>
                            setExtraLayerGroups((p) => p.map((g, i) => (i === ei ? {...g, feedType: v} : g)))
                          }
                        />
                      </div>
                    )}
                    <div>
                      <label style={labelStyle}>Feed (lbs){reqStar('layer-dailys', 'feed_lbs')}</label>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={eg.feedLbs || ''}
                        onChange={(e) =>
                          setExtraLayerGroups((p) => p.map((g, i) => (i === ei ? {...g, feedLbs: e.target.value} : g)))
                        }
                        placeholder="0"
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Grit (lbs){reqStar('layer-dailys', 'grit_lbs')}</label>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={eg.gritLbs || ''}
                        onChange={(e) =>
                          setExtraLayerGroups((p) => p.map((g, i) => (i === ei ? {...g, gritLbs: e.target.value} : g)))
                        }
                        placeholder="0"
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Hen Count{reqStar('layer-dailys', 'layer_count')}</label>
                      <input
                        type="number"
                        min="0"
                        value={eg.layerCount || ''}
                        onChange={(e) =>
                          setExtraLayerGroups((p) =>
                            p.map((g, i) => (i === ei ? {...g, layerCount: e.target.value} : g)),
                          )
                        }
                        placeholder="0"
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Group moved?{reqStar('layer-dailys', 'group_moved')}</label>
                      <YN
                        val={eg.groupMoved !== false}
                        onChange={(v) =>
                          setExtraLayerGroups((p) => p.map((g, i) => (i === ei ? {...g, groupMoved: v} : g)))
                        }
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Waterer checked?{reqStar('layer-dailys', 'waterer_checked')}</label>
                      <YN
                        val={eg.watererChecked !== false}
                        onChange={(v) =>
                          setExtraLayerGroups((p) => p.map((g, i) => (i === ei ? {...g, watererChecked: v} : g)))
                        }
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Mortalities{reqStar('layer-dailys', 'mortality_count')}</label>
                      <input
                        type="number"
                        min="0"
                        value={eg.mortalityCount || ''}
                        onChange={(e) =>
                          setExtraLayerGroups((p) =>
                            p.map((g, i) => (i === ei ? {...g, mortalityCount: e.target.value} : g)),
                          )
                        }
                        placeholder="0"
                        style={inputStyle}
                      />
                    </div>
                    {parseInt(eg.mortalityCount) > 0 && (
                      <div>
                        <label style={labelStyle}>
                          Mortality reason <span style={{color: '#dc2626'}}>*</span>
                        </label>
                        <input
                          value={eg.mortalityReason || ''}
                          onChange={(e) =>
                            setExtraLayerGroups((p) =>
                              p.map((g, i) => (i === ei ? {...g, mortalityReason: e.target.value} : g)),
                            )
                          }
                          style={inputStyle}
                        />
                      </div>
                    )}
                    <div style={{gridColumn: '1/-1'}}>
                      <label style={labelStyle}>Comments / Issues{reqStar('layer-dailys', 'comments')}</label>
                      <textarea
                        value={eg.comments || ''}
                        onChange={(e) =>
                          setExtraLayerGroups((p) => p.map((g, i) => (i === ei ? {...g, comments: e.target.value} : g)))
                        }
                        rows={3}
                        placeholder="Type 0 if nothing to report"
                        style={{...inputStyle, resize: 'vertical'}}
                      />
                    </div>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setExtraLayerGroups((p) => [
                    ...p,
                    {batchLabel: '', feedLbs: '', gritLbs: '', layerCount: '', mortalityCount: ''},
                  ])
                }
                style={{
                  width: '100%',
                  padding: 12,
                  borderRadius: 10,
                  border: '2px dashed #fde68a',
                  background: 'transparent',
                  color: '#78350f',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  marginBottom: 12,
                }}
              >
                + Add Another Group
              </button>
            </div>
          )}
          {err && (
            <div
              style={{
                color: '#b91c1c',
                fontSize: 13,
                marginBottom: 10,
                padding: '8px 12px',
                background: '#fef2f2',
                borderRadius: 8,
              }}
            >
              {err}
            </div>
          )}
          <DailyPhotoCapture files={lPhotos} statuses={lPhotoStatuses} onChange={setLPhotos} disabled={submitting} />
          <button
            onClick={submitLayer}
            disabled={submitting}
            style={{
              width: '100%',
              padding: 14,
              border: 'none',
              borderRadius: 10,
              background: '#085041',
              color: 'white',
              fontSize: 15,
              fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1,
              fontFamily: 'inherit',
              marginBottom: 16,
            }}
          >
            {submitting
              ? `Submitting ${1 + extraLayerGroups.filter((g) => g.batchLabel).length} report(s)…`
              : 'Submit Report'}
          </button>
        </div>
        {stuckModalEl}
      </div>
    );

  // ── PIG FORM ──
  if (activeForm === 'pig') {
    // CRITICAL: load from Supabase only — props are empty on mobile (no auth)
    const pgGroups = pigGroupsFromDb.length > 0 ? pigGroupsFromDb : wfGroups && wfGroups.length > 0 ? wfGroups : [];
    const pgTeam = getFormTeamMembers('pig-dailys');
    return (
      <div style={wfBg}>
        <div style={{maxWidth: 480, margin: '0 auto'}}>
          {logo}
          <button
            onClick={() => setActiveForm(null)}
            style={{
              background: 'none',
              border: 'none',
              color: '#6b7280',
              fontSize: 13,
              cursor: 'pointer',
              marginBottom: 12,
              padding: 0,
              fontFamily: 'inherit',
            }}
          >
            ‹ Back
          </button>
          <div style={{fontSize: 17, fontWeight: 700, color: '#1e40af', marginBottom: 16}}>🐷 Pig Daily Report</div>
          <div style={sectionStyle}>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>Date{reqStar('pig-dailys', 'date')}</label>
                <input
                  type="date"
                  value={pForm.date}
                  onChange={(e) => setPForm((f) => ({...f, date: e.target.value}))}
                  style={inputStyle}
                />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>Team Member{reqStar('pig-dailys', 'team_member')}</label>
                <select
                  value={pForm.teamMember}
                  onChange={(e) => setPForm((f) => ({...f, teamMember: e.target.value}))}
                  style={inputStyle}
                >
                  <option value="">Select...</option>
                  {pgTeam.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>Pig Group{reqStar('pig-dailys', 'batch_label')}</label>
                <select
                  value={pForm.batchLabel}
                  onChange={(e) => setPForm((f) => ({...f, batchLabel: e.target.value}))}
                  style={inputStyle}
                >
                  <option value="">Select group...</option>
                  {pgGroups.map((g) => (
                    <option key={g.value || g} value={g.value || g}>
                      {g.label || g}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Feed (lbs){reqStar('pig-dailys', 'feed_lbs')}</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={pForm.feedLbs || ''}
                  onChange={(e) => setPForm((f) => ({...f, feedLbs: e.target.value}))}
                  placeholder="0"
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>Pig Count{reqStar('pig-dailys', 'pig_count')}</label>
                <input
                  type="number"
                  min="0"
                  value={pForm.pigCount || ''}
                  onChange={(e) => setPForm((f) => ({...f, pigCount: e.target.value}))}
                  placeholder="0"
                  style={inputStyle}
                />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>Fence Voltage (kV){reqStar('pig-dailys', 'fence_voltage')}</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={pForm.fenceVoltage || ''}
                  onChange={(e) => setPForm((f) => ({...f, fenceVoltage: e.target.value}))}
                  placeholder="0.0"
                  style={inputStyle}
                />
              </div>
            </div>
          </div>
          <div style={sectionStyle}>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
              <div>
                <label style={labelStyle}>Group moved?{reqStar('pig-dailys', 'group_moved')}</label>
                <YN val={pForm.groupMoved} onChange={(v) => setPForm((f) => ({...f, groupMoved: v}))} />
              </div>
              <div>
                <label style={labelStyle}>Nipple drinker moved?{reqStar('pig-dailys', 'nipple_drinker_moved')}</label>
                <YN val={pForm.nippleDrinkerMoved} onChange={(v) => setPForm((f) => ({...f, nippleDrinkerMoved: v}))} />
              </div>
              <div>
                <label style={labelStyle}>
                  Nipple drinker working?{reqStar('pig-dailys', 'nipple_drinker_working')}
                </label>
                <YN
                  val={pForm.nippleDrinkerWorking}
                  onChange={(v) => setPForm((f) => ({...f, nippleDrinkerWorking: v}))}
                />
              </div>
              <div>
                <label style={labelStyle}>Troughs moved?{reqStar('pig-dailys', 'troughs_moved')}</label>
                <YN val={pForm.troughsMoved} onChange={(v) => setPForm((f) => ({...f, troughsMoved: v}))} />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>Fence walked?{reqStar('pig-dailys', 'fence_walked')}</label>
                <YN val={pForm.fenceWalked} onChange={(v) => setPForm((f) => ({...f, fenceWalked: v}))} />
              </div>
            </div>
          </div>
          <div style={sectionStyle}>
            <label style={labelStyle}>Issues / Notes{reqStar('pig-dailys', 'issues')}</label>
            <textarea
              value={pForm.issues}
              onChange={(e) => setPForm((f) => ({...f, issues: e.target.value}))}
              rows={3}
              placeholder="Type 0 if nothing to report"
              style={{...inputStyle, resize: 'vertical'}}
            />
          </div>
          {allowAddGroup('pig-dailys') && (
            <div>
              {extraPigGroups.map((eg, ei) => (
                <div key={ei} style={{...sectionStyle, border: '1px solid #bfdbfe', marginTop: 0}}>
                  <div
                    style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8}}
                  >
                    <div style={{fontSize: 13, fontWeight: 600, color: '#1e40af'}}>Additional Group {ei + 2}</div>
                    <button
                      type="button"
                      onClick={() => setExtraPigGroups((p) => p.filter((_, i) => i !== ei))}
                      style={{background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 18}}
                    >
                      ×
                    </button>
                  </div>
                  <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                    <div style={{gridColumn: '1/-1'}}>
                      <label style={labelStyle}>Pig Group{reqStar('pig-dailys', 'batch_label')}</label>
                      <select
                        value={eg.batchLabel || ''}
                        onChange={(e) =>
                          setExtraPigGroups((p) => p.map((g, i) => (i === ei ? {...g, batchLabel: e.target.value} : g)))
                        }
                        style={inputStyle}
                      >
                        <option value="">Select group...</option>
                        {pgGroups.map((g) => (
                          <option key={g.value || g} value={g.value || g}>
                            {g.label || g}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>Feed (lbs){reqStar('pig-dailys', 'feed_lbs')}</label>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={eg.feedLbs || ''}
                        onChange={(e) =>
                          setExtraPigGroups((p) => p.map((g, i) => (i === ei ? {...g, feedLbs: e.target.value} : g)))
                        }
                        placeholder="0"
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Pig Count{reqStar('pig-dailys', 'pig_count')}</label>
                      <input
                        type="number"
                        min="0"
                        value={eg.pigCount || ''}
                        onChange={(e) =>
                          setExtraPigGroups((p) => p.map((g, i) => (i === ei ? {...g, pigCount: e.target.value} : g)))
                        }
                        placeholder="0"
                        style={inputStyle}
                      />
                    </div>
                    <div style={{gridColumn: '1/-1'}}>
                      <label style={labelStyle}>Fence Voltage (kV){reqStar('pig-dailys', 'fence_voltage')}</label>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={eg.fenceVoltage || ''}
                        onChange={(e) =>
                          setExtraPigGroups((p) =>
                            p.map((g, i) => (i === ei ? {...g, fenceVoltage: e.target.value} : g)),
                          )
                        }
                        placeholder="0.0"
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Group moved?{reqStar('pig-dailys', 'group_moved')}</label>
                      <YN
                        val={eg.groupMoved !== false}
                        onChange={(v) =>
                          setExtraPigGroups((p) => p.map((g, i) => (i === ei ? {...g, groupMoved: v} : g)))
                        }
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>
                        Nipple drinker moved?{reqStar('pig-dailys', 'nipple_drinker_moved')}
                      </label>
                      <YN
                        val={eg.nippleDrinkerMoved !== false}
                        onChange={(v) =>
                          setExtraPigGroups((p) => p.map((g, i) => (i === ei ? {...g, nippleDrinkerMoved: v} : g)))
                        }
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>
                        Nipple drinker working?{reqStar('pig-dailys', 'nipple_drinker_working')}
                      </label>
                      <YN
                        val={eg.nippleDrinkerWorking !== false}
                        onChange={(v) =>
                          setExtraPigGroups((p) => p.map((g, i) => (i === ei ? {...g, nippleDrinkerWorking: v} : g)))
                        }
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Troughs moved?{reqStar('pig-dailys', 'troughs_moved')}</label>
                      <YN
                        val={eg.troughsMoved !== false}
                        onChange={(v) =>
                          setExtraPigGroups((p) => p.map((g, i) => (i === ei ? {...g, troughsMoved: v} : g)))
                        }
                      />
                    </div>
                    <div style={{gridColumn: '1/-1'}}>
                      <label style={labelStyle}>Fence walked?{reqStar('pig-dailys', 'fence_walked')}</label>
                      <YN
                        val={eg.fenceWalked !== false}
                        onChange={(v) =>
                          setExtraPigGroups((p) => p.map((g, i) => (i === ei ? {...g, fenceWalked: v} : g)))
                        }
                      />
                    </div>
                    <div style={{gridColumn: '1/-1'}}>
                      <label style={labelStyle}>Issues / Notes{reqStar('pig-dailys', 'issues')}</label>
                      <textarea
                        value={eg.issues || ''}
                        onChange={(e) =>
                          setExtraPigGroups((p) => p.map((g, i) => (i === ei ? {...g, issues: e.target.value} : g)))
                        }
                        rows={3}
                        placeholder="Type 0 if nothing to report"
                        style={{...inputStyle, resize: 'vertical'}}
                      />
                    </div>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setExtraPigGroups((p) => [
                    ...p,
                    {
                      batchLabel: '',
                      feedLbs: '',
                      pigCount: '',
                      fenceVoltage: '',
                      groupMoved: true,
                      nippleDrinkerMoved: true,
                      nippleDrinkerWorking: true,
                      troughsMoved: true,
                      fenceWalked: true,
                      issues: '',
                    },
                  ])
                }
                style={{
                  width: '100%',
                  padding: 12,
                  borderRadius: 10,
                  border: '2px dashed #fde68a',
                  background: 'transparent',
                  color: '#78350f',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  marginBottom: 12,
                }}
              >
                + Add Another Group
              </button>
            </div>
          )}
          {err && (
            <div
              style={{
                color: '#b91c1c',
                fontSize: 13,
                marginBottom: 10,
                padding: '8px 12px',
                background: '#fef2f2',
                borderRadius: 8,
              }}
            >
              {err}
            </div>
          )}
          <DailyPhotoCapture
            files={pPhotos}
            statuses={pPhotoStatuses}
            onChange={setPPhotos}
            disabled={submitting}
            offlineCapable={true}
          />
          <button
            onClick={submitPig}
            disabled={submitting}
            style={{
              width: '100%',
              padding: 14,
              border: 'none',
              borderRadius: 10,
              background: '#085041',
              color: 'white',
              fontSize: 15,
              fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1,
              fontFamily: 'inherit',
              marginBottom: 16,
            }}
          >
            {submitting
              ? `Submitting ${1 + extraPigGroups.filter((g) => g.batchLabel).length} report(s)…`
              : 'Submit Report'}
          </button>
        </div>
        {stuckModalEl}
      </div>
    );
  }

  // ── CATTLE FORM ──
  if (activeForm === 'cattle') {
    const CATTLE_HERD_OPTS = [
      {v: 'mommas', l: 'Mommas'},
      {v: 'backgrounders', l: 'Backgrounders'},
      {v: 'finishers', l: 'Finishers'},
      {v: 'bulls', l: 'Bulls'},
    ];
    const herdSelected = cForm.herd;
    // Feeds scoped to selected herd, minerals always shown for any herd
    const feedsForHerd = herdSelected
      ? cattleFeedInputs.filter((f) => f.category !== 'mineral' && (f.herd_scope || []).includes(herdSelected))
      : [];
    const mineralsAll = cattleFeedInputs.filter((f) => f.category === 'mineral');
    const unitFor = (feedId) => {
      const fi = cattleFeedInputs.find((x) => x.id === feedId);
      return fi ? fi.unit : '';
    };
    const cgTeam = getFormTeamMembers('cattle-dailys');
    const showCreepToggle = herdSelected === 'mommas';
    return (
      <div style={wfBg}>
        <div style={{maxWidth: 480, margin: '0 auto'}}>
          {logo}
          <button
            onClick={() => setActiveForm(null)}
            style={{
              background: 'none',
              border: 'none',
              color: '#6b7280',
              fontSize: 13,
              cursor: 'pointer',
              marginBottom: 12,
              padding: 0,
              fontFamily: 'inherit',
            }}
          >
            {'\u2039 Back'}
          </button>
          <div style={{fontSize: 17, fontWeight: 700, color: '#991b1b', marginBottom: 16}}>
            {'\ud83d\udc04 Cattle Daily Report'}
          </div>

          {/* Report info */}
          <div style={sectionStyle}>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>
                  Date<span style={{color: '#b91c1c', marginLeft: 2}}>*</span>
                </label>
                <input
                  type="date"
                  value={cForm.date}
                  onChange={(e) => setCForm((f) => ({...f, date: e.target.value}))}
                  style={inputStyle}
                />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>
                  Team Member<span style={{color: '#b91c1c', marginLeft: 2}}>*</span>
                </label>
                <select
                  value={cForm.teamMember}
                  onChange={(e) => setCForm((f) => ({...f, teamMember: e.target.value}))}
                  style={inputStyle}
                >
                  <option value="">Select...</option>
                  {cgTeam.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>
                  Cattle Group<span style={{color: '#b91c1c', marginLeft: 2}}>*</span>
                </label>
                <select
                  value={cForm.herd}
                  onChange={(e) =>
                    setCForm((f) => ({
                      ...f,
                      herd: e.target.value,
                      feeds: [{feedId: '', qty: '', isCreep: false}],
                      minerals: [{feedId: '', lbs: ''}],
                    }))
                  }
                  style={inputStyle}
                >
                  <option value="">Select herd...</option>
                  {CATTLE_HERD_OPTS.map((h) => (
                    <option key={h.v} value={h.v}>
                      {h.l}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Feeds */}
          {herdSelected && (
            <div style={sectionStyle}>
              <div style={{fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10}}>Feed</div>
              {cForm.feeds.map((row, ri) => (
                <div
                  key={ri}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '2fr 1fr auto',
                    gap: 8,
                    marginBottom: showCreepToggle ? 4 : 10,
                    alignItems: 'end',
                  }}
                >
                  <div>
                    {ri === 0 && <label style={{...labelStyle, fontSize: 12}}>Feed Type</label>}
                    <select
                      value={row.feedId}
                      onChange={(e) =>
                        setCForm((f) => ({
                          ...f,
                          feeds: f.feeds.map((r, i) => (i === ri ? {...r, feedId: e.target.value} : r)),
                        }))
                      }
                      style={{...inputStyle, fontSize: 13, padding: '8px 10px'}}
                    >
                      <option value="">Select feed...</option>
                      {feedsForHerd.map((ff) => (
                        <option key={ff.id} value={ff.id}>
                          {ff.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    {ri === 0 && (
                      <label style={{...labelStyle, fontSize: 12}}>
                        {row.feedId ? 'Qty (' + unitFor(row.feedId) + ')' : 'Qty'}
                      </label>
                    )}
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={row.qty}
                      onChange={(e) =>
                        setCForm((f) => ({
                          ...f,
                          feeds: f.feeds.map((r, i) => (i === ri ? {...r, qty: e.target.value} : r)),
                        }))
                      }
                      placeholder="0"
                      style={{...inputStyle, fontSize: 13, padding: '8px 10px'}}
                    />
                  </div>
                  <div>
                    {ri === 0 && <div style={{fontSize: 12, marginBottom: 4, opacity: 0}}>.</div>}
                    {cForm.feeds.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => setCForm((f) => ({...f, feeds: f.feeds.filter((_, i) => i !== ri)}))}
                        style={{
                          padding: '8px 10px',
                          border: '1px solid #d1d5db',
                          borderRadius: 6,
                          background: 'white',
                          color: '#9ca3af',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          fontSize: 14,
                        }}
                      >
                        {'\u00d7'}
                      </button>
                    ) : (
                      <div style={{width: 38}} />
                    )}
                  </div>
                  {showCreepToggle && row.feedId && (
                    <label
                      style={{
                        gridColumn: '1/-1',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 11,
                        color: '#7f1d1d',
                        cursor: 'pointer',
                        marginBottom: 6,
                        userSelect: 'none',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={!!row.isCreep}
                        onChange={(e) =>
                          setCForm((f) => ({
                            ...f,
                            feeds: f.feeds.map((r, i) => (i === ri ? {...r, isCreep: e.target.checked} : r)),
                          }))
                        }
                        style={{cursor: 'pointer'}}
                      />
                      This was creep feed (for calves) {'\u2014'} counts for cost, not Mommas nutrition
                    </label>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => setCForm((f) => ({...f, feeds: [...f.feeds, {feedId: '', qty: '', isCreep: false}]}))}
                style={{
                  width: '100%',
                  padding: 10,
                  borderRadius: 8,
                  border: '2px dashed #fca5a5',
                  background: 'transparent',
                  color: '#991b1b',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  marginTop: 6,
                }}
              >
                + Add Feed
              </button>
            </div>
          )}

          {/* Minerals */}
          {herdSelected && (
            <div style={sectionStyle}>
              <div style={{fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10}}>Minerals</div>
              {cForm.minerals.map((row, ri) => (
                <div
                  key={ri}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '2fr 1fr auto',
                    gap: 8,
                    marginBottom: 10,
                    alignItems: 'end',
                  }}
                >
                  <div>
                    {ri === 0 && <label style={{...labelStyle, fontSize: 12}}>Mineral</label>}
                    <select
                      value={row.feedId}
                      onChange={(e) =>
                        setCForm((f) => ({
                          ...f,
                          minerals: f.minerals.map((r, i) => (i === ri ? {...r, feedId: e.target.value} : r)),
                        }))
                      }
                      style={{...inputStyle, fontSize: 13, padding: '8px 10px'}}
                    >
                      <option value="">Select mineral...</option>
                      {mineralsAll.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    {ri === 0 && <label style={{...labelStyle, fontSize: 12}}>Lbs</label>}
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={row.lbs}
                      onChange={(e) =>
                        setCForm((f) => ({
                          ...f,
                          minerals: f.minerals.map((r, i) => (i === ri ? {...r, lbs: e.target.value} : r)),
                        }))
                      }
                      placeholder="0"
                      style={{...inputStyle, fontSize: 13, padding: '8px 10px'}}
                    />
                  </div>
                  <div>
                    {ri === 0 && <div style={{fontSize: 12, marginBottom: 4, opacity: 0}}>.</div>}
                    {cForm.minerals.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => setCForm((f) => ({...f, minerals: f.minerals.filter((_, i) => i !== ri)}))}
                        style={{
                          padding: '8px 10px',
                          border: '1px solid #d1d5db',
                          borderRadius: 6,
                          background: 'white',
                          color: '#9ca3af',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          fontSize: 14,
                        }}
                      >
                        {'\u00d7'}
                      </button>
                    ) : (
                      <div style={{width: 38}} />
                    )}
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setCForm((f) => ({...f, minerals: [...f.minerals, {feedId: '', lbs: ''}]}))}
                style={{
                  width: '100%',
                  padding: 10,
                  borderRadius: 8,
                  border: '2px dashed #fca5a5',
                  background: 'transparent',
                  color: '#991b1b',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  marginTop: 6,
                }}
              >
                + Add Mineral
              </button>
            </div>
          )}

          {/* Daily checks */}
          {herdSelected && (
            <div style={sectionStyle}>
              <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
                <div>
                  <label style={labelStyle}>Fence Voltage (kV)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={cForm.fenceVoltage}
                    onChange={(e) => setCForm((f) => ({...f, fenceVoltage: e.target.value}))}
                    placeholder="0.0"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Waterers checked?</label>
                  <YN val={cForm.waterChecked} onChange={(v) => setCForm((f) => ({...f, waterChecked: v}))} />
                </div>
              </div>
            </div>
          )}

          {/* Issues */}
          {herdSelected && (
            <div style={sectionStyle}>
              <label style={labelStyle}>Issues / Comments</label>
              <textarea
                value={cForm.issues}
                onChange={(e) => setCForm((f) => ({...f, issues: e.target.value}))}
                rows={3}
                placeholder="Type 0 if nothing to report"
                style={{...inputStyle, resize: 'vertical'}}
              />
            </div>
          )}

          {err && (
            <div
              style={{
                color: '#b91c1c',
                fontSize: 13,
                marginBottom: 10,
                padding: '8px 12px',
                background: '#fef2f2',
                borderRadius: 8,
              }}
            >
              {err}
            </div>
          )}

          <DailyPhotoCapture
            files={cPhotos}
            statuses={cPhotoStatuses}
            onChange={setCPhotos}
            disabled={submitting}
            offlineCapable={true}
          />
          <button
            onClick={submitCattle}
            disabled={submitting || !herdSelected}
            style={{
              width: '100%',
              padding: 14,
              border: 'none',
              borderRadius: 10,
              background: '#991b1b',
              color: 'white',
              fontSize: 15,
              fontWeight: 600,
              cursor: submitting || !herdSelected ? 'not-allowed' : 'pointer',
              opacity: submitting || !herdSelected ? 0.5 : 1,
              fontFamily: 'inherit',
              marginBottom: 16,
            }}
          >
            {submitting ? 'Submitting\u2026' : 'Submit Report'}
          </button>
        </div>
        {stuckModalEl}
      </div>
    );
  }

  // ── EGG FORM ──
  if (activeForm === 'egg')
    return (
      <div style={wfBg}>
        <div style={{maxWidth: 480, margin: '0 auto'}}>
          {logo}
          <button
            onClick={() => setActiveForm(null)}
            style={{
              background: 'none',
              border: 'none',
              color: '#6b7280',
              fontSize: 13,
              cursor: 'pointer',
              marginBottom: 12,
              padding: 0,
              fontFamily: 'inherit',
            }}
          >
            ‹ Back
          </button>
          <div style={{fontSize: 17, fontWeight: 700, color: '#78350f', marginBottom: 16}}>
            🥚 Egg Collection Report
          </div>
          <div style={sectionStyle}>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>Date{reqStar('egg-dailys', 'date')}</label>
                <input
                  type="date"
                  value={eForm.date}
                  onChange={(e) => setEForm((f) => ({...f, date: e.target.value}))}
                  style={inputStyle}
                />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>Team Member{reqStar('egg-dailys', 'team_member')}</label>
                <select
                  value={eForm.teamMember}
                  onChange={(e) => setEForm((f) => ({...f, teamMember: e.target.value}))}
                  style={inputStyle}
                >
                  <option value="">Select...</option>
                  {getFormTeamMembers('egg-dailys').map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div style={sectionStyle}>
            <div style={{fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10}}>
              Egg Collection by Group
            </div>
            {[
              {n: 'g1n', c: 'g1c', label: 'Group 1'},
              {n: 'g2n', c: 'g2c', label: 'Group 2'},
              {n: 'g3n', c: 'g3c', label: 'Group 3'},
              {n: 'g4n', c: 'g4c', label: 'Group 4'},
            ].map(({n, c, label}) => (
              <div key={n} style={{display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8, marginBottom: 10}}>
                <div>
                  <label style={{...labelStyle, fontSize: 12}}>{label} Name</label>
                  <select
                    value={eForm[n]}
                    onChange={(e) => setEForm((f) => ({...f, [n]: e.target.value}))}
                    style={{...inputStyle, fontSize: 13, padding: '8px 10px'}}
                  >
                    <option value="">—</option>
                    {layerGroupNames.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{...labelStyle, fontSize: 12}}>Eggs</label>
                  <input
                    type="number"
                    min="0"
                    value={eForm[c]}
                    onChange={(e) => setEForm((f) => ({...f, [c]: e.target.value}))}
                    placeholder="0"
                    style={{...inputStyle, fontSize: 13, padding: '8px 10px'}}
                  />
                </div>
              </div>
            ))}
          </div>
          <div style={sectionStyle}>
            <label style={labelStyle}>Dozens on Hand{reqStar('egg-dailys', 'dozens_on_hand')}</label>
            <input
              type="number"
              min="0"
              step="0.5"
              value={eForm.dozensOnHand || ''}
              onChange={(e) => setEForm((f) => ({...f, dozensOnHand: e.target.value}))}
              placeholder="0"
              style={inputStyle}
            />
          </div>
          <div style={sectionStyle}>
            <label style={labelStyle}>Comments{reqStar('egg-dailys', 'comments')}</label>
            <textarea
              value={eForm.comments}
              onChange={(e) => setEForm((f) => ({...f, comments: e.target.value}))}
              rows={3}
              placeholder="Type 0 if nothing to report"
              style={{...inputStyle, resize: 'vertical'}}
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
                borderRadius: 8,
              }}
            >
              {err}
            </div>
          )}
          <button
            onClick={submitEgg}
            disabled={submitting}
            style={{
              width: '100%',
              padding: 14,
              border: 'none',
              borderRadius: 10,
              background: '#085041',
              color: 'white',
              fontSize: 15,
              fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1,
              fontFamily: 'inherit',
              marginBottom: 16,
            }}
          >
            {submitting ? 'Submitting…' : 'Submit Report'}
          </button>
        </div>
        {stuckModalEl}
      </div>
    );

  // ── SHEEP FORM ──
  if (activeForm === 'sheep')
    return (
      <div style={wfBg}>
        <div style={{maxWidth: 480, margin: '0 auto'}}>
          {logo}
          <button
            onClick={() => setActiveForm(null)}
            style={{
              background: 'none',
              border: 'none',
              color: '#6b7280',
              fontSize: 13,
              cursor: 'pointer',
              marginBottom: 12,
              padding: 0,
              fontFamily: 'inherit',
            }}
          >
            ‹ Back
          </button>
          <div style={{fontSize: 17, fontWeight: 700, color: '#0f766e', marginBottom: 16}}>🐑 Sheep Daily Report</div>
          <div style={sectionStyle}>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>Date{reqStar('sheep-dailys', 'date')}</label>
                <input
                  type="date"
                  value={sForm.date}
                  onChange={(e) => setSForm((f) => ({...f, date: e.target.value}))}
                  style={inputStyle}
                />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>Team Member{reqStar('sheep-dailys', 'team_member')}</label>
                <select
                  value={sForm.teamMember}
                  onChange={(e) => setSForm((f) => ({...f, teamMember: e.target.value}))}
                  style={inputStyle}
                >
                  <option value="">Select...</option>
                  {getFormTeamMembers('sheep-dailys').map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={labelStyle}>
                  Flock<span style={{color: '#dc2626', marginLeft: 2}}>*</span>
                </label>
                <select
                  value={sForm.flock}
                  onChange={(e) => setSForm((f) => ({...f, flock: e.target.value}))}
                  style={inputStyle}
                >
                  <option value="">Select flock...</option>
                  <option value="rams">Rams</option>
                  <option value="ewes">Ewes</option>
                  <option value="feeders">Feeders</option>
                </select>
              </div>
            </div>
          </div>
          {/* Feeds — multi-row picker; mirrors cattle. Filtered to sheep herd_scope. */}
          {sForm.flock &&
            (() => {
              const feedsForFlock = cattleFeedInputs.filter(
                (f) => f.category !== 'mineral' && (f.herd_scope || []).includes(sForm.flock),
              );
              const unitFor = (id) => {
                const fi = cattleFeedInputs.find((x) => x.id === id);
                return fi ? fi.unit : '';
              };
              return (
                <div style={sectionStyle}>
                  <div style={{fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10}}>Feed</div>
                  {sForm.feeds.map((row, ri) => (
                    <div
                      key={ri}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '2fr 1fr auto',
                        gap: 8,
                        marginBottom: 10,
                        alignItems: 'end',
                      }}
                    >
                      <div>
                        {ri === 0 && <label style={{...labelStyle, fontSize: 12}}>Feed Type</label>}
                        <select
                          value={row.feedId}
                          onChange={(e) =>
                            setSForm((f) => ({
                              ...f,
                              feeds: f.feeds.map((r, i) => (i === ri ? {...r, feedId: e.target.value} : r)),
                            }))
                          }
                          style={{...inputStyle, fontSize: 13, padding: '8px 10px'}}
                        >
                          <option value="">Select feed...</option>
                          {feedsForFlock.map((ff) => (
                            <option key={ff.id} value={ff.id}>
                              {ff.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        {ri === 0 && (
                          <label style={{...labelStyle, fontSize: 12}}>
                            {row.feedId ? 'Qty (' + unitFor(row.feedId) + ')' : 'Qty'}
                          </label>
                        )}
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={row.qty}
                          onChange={(e) =>
                            setSForm((f) => ({
                              ...f,
                              feeds: f.feeds.map((r, i) => (i === ri ? {...r, qty: e.target.value} : r)),
                            }))
                          }
                          placeholder="0"
                          style={{...inputStyle, fontSize: 13, padding: '8px 10px'}}
                        />
                      </div>
                      <div>
                        {ri === 0 && <div style={{fontSize: 12, marginBottom: 4, opacity: 0}}>.</div>}
                        {sForm.feeds.length > 1 ? (
                          <button
                            type="button"
                            onClick={() => setSForm((f) => ({...f, feeds: f.feeds.filter((_, i) => i !== ri)}))}
                            style={{
                              padding: '8px 10px',
                              border: '1px solid #d1d5db',
                              borderRadius: 6,
                              background: 'white',
                              color: '#9ca3af',
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                              fontSize: 14,
                            }}
                          >
                            {'×'}
                          </button>
                        ) : (
                          <div style={{width: 38}} />
                        )}
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setSForm((f) => ({...f, feeds: [...f.feeds, {feedId: '', qty: ''}]}))}
                    style={{
                      width: '100%',
                      padding: 10,
                      borderRadius: 8,
                      border: '2px dashed #5eead4',
                      background: 'transparent',
                      color: '#0f766e',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      marginTop: 6,
                    }}
                  >
                    + Add Feed
                  </button>
                </div>
              );
            })()}

          {/* Minerals — multi-row picker. */}
          {sForm.flock &&
            (() => {
              const mineralsForFlock = cattleFeedInputs.filter(
                (f) => f.category === 'mineral' && (f.herd_scope || []).includes(sForm.flock),
              );
              return (
                <div style={sectionStyle}>
                  <div style={{fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10}}>Minerals</div>
                  {sForm.minerals.map((row, ri) => (
                    <div
                      key={ri}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '2fr 1fr auto',
                        gap: 8,
                        marginBottom: 10,
                        alignItems: 'end',
                      }}
                    >
                      <div>
                        {ri === 0 && <label style={{...labelStyle, fontSize: 12}}>Mineral</label>}
                        <select
                          value={row.feedId}
                          onChange={(e) =>
                            setSForm((f) => ({
                              ...f,
                              minerals: f.minerals.map((r, i) => (i === ri ? {...r, feedId: e.target.value} : r)),
                            }))
                          }
                          style={{...inputStyle, fontSize: 13, padding: '8px 10px'}}
                        >
                          <option value="">Select mineral...</option>
                          {mineralsForFlock.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        {ri === 0 && <label style={{...labelStyle, fontSize: 12}}>Lbs</label>}
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={row.lbs}
                          onChange={(e) =>
                            setSForm((f) => ({
                              ...f,
                              minerals: f.minerals.map((r, i) => (i === ri ? {...r, lbs: e.target.value} : r)),
                            }))
                          }
                          placeholder="0"
                          style={{...inputStyle, fontSize: 13, padding: '8px 10px'}}
                        />
                      </div>
                      <div>
                        {ri === 0 && <div style={{fontSize: 12, marginBottom: 4, opacity: 0}}>.</div>}
                        {sForm.minerals.length > 1 ? (
                          <button
                            type="button"
                            onClick={() => setSForm((f) => ({...f, minerals: f.minerals.filter((_, i) => i !== ri)}))}
                            style={{
                              padding: '8px 10px',
                              border: '1px solid #d1d5db',
                              borderRadius: 6,
                              background: 'white',
                              color: '#9ca3af',
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                              fontSize: 14,
                            }}
                          >
                            {'×'}
                          </button>
                        ) : (
                          <div style={{width: 38}} />
                        )}
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setSForm((f) => ({...f, minerals: [...f.minerals, {feedId: '', lbs: ''}]}))}
                    style={{
                      width: '100%',
                      padding: 10,
                      borderRadius: 8,
                      border: '2px dashed #d8b4fe',
                      background: 'transparent',
                      color: '#6b21a8',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      marginTop: 6,
                    }}
                  >
                    + Add Mineral
                  </button>
                </div>
              );
            })()}
          <div style={sectionStyle}>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
              {isEnabled('sheep-dailys', 'fence_voltage_kv') && (
                <div>
                  <label style={labelStyle}>Fence Voltage (kV){reqStar('sheep-dailys', 'fence_voltage_kv')}</label>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={sForm.fenceVoltageKv || ''}
                    onChange={(e) => setSForm((f) => ({...f, fenceVoltageKv: e.target.value}))}
                    placeholder="0.0"
                    style={inputStyle}
                  />
                </div>
              )}
              {isEnabled('sheep-dailys', 'waterers_working') && (
                <div>
                  <label style={labelStyle}>Waterers working?{reqStar('sheep-dailys', 'waterers_working')}</label>
                  <YN val={sForm.waterersWorking} onChange={(v) => setSForm((f) => ({...f, waterersWorking: v}))} />
                </div>
              )}
            </div>
          </div>
          {isEnabled('sheep-dailys', 'comments') && (
            <div style={sectionStyle}>
              <label style={labelStyle}>Issues / Comments{reqStar('sheep-dailys', 'comments')}</label>
              <textarea
                value={sForm.comments}
                onChange={(e) => setSForm((f) => ({...f, comments: e.target.value}))}
                rows={3}
                placeholder="Type 0 if nothing to report"
                style={{...inputStyle, resize: 'vertical'}}
              />
            </div>
          )}
          {err && (
            <div
              style={{
                color: '#b91c1c',
                fontSize: 13,
                marginBottom: 10,
                padding: '8px 12px',
                background: '#fef2f2',
                borderRadius: 8,
              }}
            >
              {err}
            </div>
          )}
          <DailyPhotoCapture
            files={shPhotos}
            statuses={shPhotoStatuses}
            onChange={setShPhotos}
            disabled={submitting}
            offlineCapable={true}
          />
          <button
            onClick={submitSheep}
            disabled={submitting}
            style={{
              width: '100%',
              padding: 14,
              border: 'none',
              borderRadius: 10,
              background: '#0f766e',
              color: 'white',
              fontSize: 15,
              fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1,
              fontFamily: 'inherit',
              marginBottom: 16,
            }}
          >
            {submitting ? 'Submitting…' : 'Submit Report'}
          </button>
        </div>
        {stuckModalEl}
      </div>
    );
};

export default WebformHub;
