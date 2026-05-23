// ============================================================================
// AdminAddReportModal — Phase 2.1.4
// ============================================================================
// Admin-side modal that mirrors WebformHub forms (broiler / layer / egg /
// pig / cattle / sheep). Loads the same Supabase webform_config so admin +
// public forms stay in sync.
// ============================================================================
import React from 'react';
import WcfYN from './WcfYN.jsx';
import WcfToggle from './WcfToggle.jsx';
import {wcfSendEmail} from '../lib/email.js';
import {setHousingAnchorFromReport} from '../lib/layerHousing.js';
import {loadRoster, activeNames} from '../lib/teamMembers.js';
import {renderCattleIconLabel} from '../components/CattleIcon.jsx';
import {checkDailyDuplicate, checkInSubmissionDuplicates, formatDuplicateError} from '../lib/dailyDuplicateCheck.js';
const AdminAddReportModal = ({sb, formType, onClose, onSaved}) => {
  const [loadedConfig, setLoadedConfig] = React.useState(null);
  const [broilerGroupsFromDb, setBroilerGroupsFromDb] = React.useState([]);
  const [pigGroupsFromDb, setPigGroupsFromDb] = React.useState([]);
  const [wfSettings, setWfSettings] = React.useState({});
  // {housingName: batchName} — same source as AddFeedWebform / WebformHub.
  // Drives the layer-dailys "Active in batch:" hint when admin picks a layer
  // group. Defaults to {} so a missing config row leaves the badge hidden
  // rather than throwing.
  const [housingBatchMap, setHousingBatchMap] = React.useState({});
  // Master active roster (loaded from webform_config.team_roster, falling
  // back to the legacy team_members string[] inside loadRoster). Per-form
  // filtering retired 2026-04-29 — all forms read this single list.
  const [rosterNames, setRosterNames] = React.useState([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [err, setErr] = React.useState('');
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const genId = () => String(Date.now()) + Math.random().toString(36).slice(2, 6);

  React.useEffect(() => {
    Promise.all([
      sb.from('webform_config').select('data').eq('key', 'full_config').maybeSingle(),
      sb.from('webform_config').select('data').eq('key', 'broiler_groups').maybeSingle(),
      sb.from('webform_config').select('data').eq('key', 'webform_settings').maybeSingle(),
      sb.from('webform_config').select('data').eq('key', 'active_groups').maybeSingle(),
      sb.from('webform_config').select('data').eq('key', 'housing_batch_map').maybeSingle(),
      loadRoster(sb),
    ]).then(([fc, bg, ws, ag, hbm, roster]) => {
      if (fc?.data?.data) setLoadedConfig(fc.data.data);
      if (Array.isArray(bg?.data?.data) && bg.data.data.length > 0) setBroilerGroupsFromDb(bg.data.data);
      if (ws?.data?.data) setWfSettings(ws.data.data);
      if (Array.isArray(ag?.data?.data) && ag.data.data.length > 0) setPigGroupsFromDb(ag.data.data);
      if (hbm?.data?.data) setHousingBatchMap(hbm.data.data);
      if (Array.isArray(roster) && roster.length > 0) setRosterNames(activeNames(roster));
    });
  }, []);

  const cfg = loadedConfig || {};
  const broilerGroups =
    (broilerGroupsFromDb.length > 0 && broilerGroupsFromDb) ||
    (cfg.broilerGroups?.length > 0 && cfg.broilerGroups) ||
    [];
  const layerGroupNames = (cfg.layerGroups || []).filter((g) => g.status === 'active').map((g) => g.name || g);
  const pigGroups = pigGroupsFromDb.length > 0 ? pigGroupsFromDb : [];

  function getFormTeamMembers() {
    // Per-form filtering retired 2026-04-29 — every active master roster
    // member appears for every form. The formId parameter stays in callers'
    // call sites for clarity but is ignored here. Falls back to the legacy
    // full_config.teamMembers mirror if the canonical roster hasn't loaded
    // yet (cold-load race protection).
    if (rosterNames.length > 0) return rosterNames;
    return cfg.teamMembers || [];
  }
  function allowAddGroup(formId) {
    if (wfSettings?.allowAddGroup && formId in wfSettings.allowAddGroup)
      return wfSettings.allowAddGroup[formId] === true;
    const wf = (cfg.webforms || []).find((w) => w.id === formId);
    return wf?.allowAddGroup === true;
  }
  function getField(formId, fieldId) {
    const wf = (cfg.webforms || []).find((w) => w.id === formId);
    if (!wf) return null;
    return (wf.sections || []).flatMap((s) => s.fields || []).find((f) => f.id === fieldId) || null;
  }
  function isEnabled(formId, fieldId) {
    const f = getField(formId, fieldId);
    return f ? f.enabled !== false : true;
  }
  function isRequired(formId, fieldId) {
    const f = getField(formId, fieldId);
    return f ? f.required === true : false;
  }
  function getFieldLabel(formId, fieldId, fallback) {
    const f = getField(formId, fieldId);
    return f?.label || fallback;
  }
  function getFieldOptions(formId, fieldId, fallback) {
    const f = getField(formId, fieldId);
    return f?.options || fallback;
  }
  // Label with optional required star - uses createElement (not JSX) to avoid Babel scope issues
  const lbl = {display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500};
  const reqStar = (formId, fieldId) =>
    isRequired(formId, fieldId) ? React.createElement('span', {style: {color: '#b91c1c'}}, ' *') : null;

  // Shared UI
  const inp = {
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
  const sec = {background: '#f9fafb', borderRadius: 10, padding: '14px', marginBottom: 10, border: '1px solid #e5e7eb'};

  // Form state
  const [bForm, setBForm] = React.useState({
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
  });
  const [extraB, setExtraB] = React.useState([]);
  const [lForm, setLForm] = React.useState({
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
  });
  const [extraL, setExtraL] = React.useState([]);
  const [eForm, setEForm] = React.useState({
    date: todayStr(),
    teamMember: '',
    g1n: '',
    g1c: '',
    g2n: '',
    g2c: '',
    g3n: '',
    g3c: '',
    g4n: '',
    g4c: '',
    dozensOnHand: '',
    comments: '',
  });
  const [pForm, setPForm] = React.useState({
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
  });
  const [extraP, setExtraP] = React.useState([]);
  // Cattle: feeds + minerals are jsonb arrays; feed inputs come from cattle_feed_inputs.
  const [cForm, setCForm] = React.useState({
    date: todayStr(),
    teamMember: '',
    herd: '',
    feeds: [{feedId: '', qty: '', isCreep: false}],
    minerals: [{feedId: '', lbs: ''}],
    fenceVoltage: '',
    waterChecked: true,
    issues: '',
  });
  const [cattleFeedInputs, setCattleFeedInputs] = React.useState([]);
  React.useEffect(() => {
    // Loaded for both cattle and sheep (sheep reuses the master list via herd_scope).
    if (formType !== 'cattle' && formType !== 'sheep') return;
    // Admin "Add Report" is a pure new-record flow (insert, not update), so a
    // load-time client filter is safe and mirrors the public webform pattern.
    // Drop the server-side `status === 'active'` predicate so legacy null/blank
    // rows fall through as eligible, then exclude rows where status is
    // explicitly 'inactive'.
    sb.from('cattle_feed_inputs')
      .select('*')
      .then(({data}) => {
        if (data) setCattleFeedInputs(data.filter((f) => f.status !== 'inactive'));
      });
  }, [formType]);
  // Sheep: cattle-parity shape — feeds + minerals jsonb, matching sheep_dailys
  // after migration 012. Source list is cattleFeedInputs filtered by flock in herd_scope.
  const [sForm, setSForm] = React.useState({
    date: todayStr(),
    teamMember: '',
    flock: '',
    feeds: [{feedId: '', qty: ''}],
    minerals: [{feedId: '', lbs: ''}],
    fenceVoltageKv: '',
    waterersWorking: true,
    comments: '',
  });

  React.useEffect(() => {
    if (layerGroupNames.length > 0 && !eForm.g1n)
      setEForm((f) => ({
        ...f,
        g1n: layerGroupNames[0] || '',
        g2n: layerGroupNames[1] || '',
        g3n: layerGroupNames[2] || '',
        g4n: layerGroupNames[3] || '',
      }));
  }, [layerGroupNames.join(',')]);

  // Submit functions — all include client-generated id matching WebformHub pattern
  async function submitBroiler() {
    if (!bForm.date || !bForm.teamMember || !bForm.batchLabel) {
      setErr('Please fill in all required fields.');
      return;
    }
    // Conditional validation — mirror WebformHub rules
    if (parseFloat(bForm.feedLbs) > 0 && !bForm.feedType) {
      setErr('Feed Type is required when Feed (lbs) is entered.');
      return;
    }
    if (parseInt(bForm.mortalityCount) > 0 && !(bForm.mortalityReason || '').trim()) {
      setErr('Mortality reason is required when mortalities are reported.');
      return;
    }
    for (const eg of extraB.filter((g) => g.batchLabel)) {
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
    setSubmitting(true);
    const base = {
      id: genId(),
      submitted_at: new Date().toISOString(),
      date: bForm.date,
      team_member: bForm.teamMember,
      batch_label: bForm.batchLabel,
      feed_type: bForm.feedType || null,
      feed_lbs: bForm.feedLbs !== '' ? parseFloat(bForm.feedLbs) : null,
      grit_lbs: bForm.gritLbs !== '' ? parseFloat(bForm.gritLbs) : null,
      group_moved: bForm.groupMoved,
      waterer_checked: bForm.watererChecked,
      mortality_count: bForm.mortalityCount !== '' ? parseInt(bForm.mortalityCount) : 0,
      mortality_reason: bForm.mortalityReason || null,
      comments: bForm.comments || null,
    };
    const recs = [
      base,
      ...extraB
        .filter((g) => g.batchLabel)
        .map((g) => ({
          ...base,
          id: genId(),
          batch_label: g.batchLabel,
          feed_type: g.feedType || null,
          feed_lbs: g.feedLbs !== '' ? parseFloat(g.feedLbs) : null,
          grit_lbs: g.gritLbs !== '' ? parseFloat(g.gritLbs) : null,
          group_moved: g.groupMoved !== false,
          waterer_checked: g.watererChecked !== false,
          mortality_count: g.mortalityCount !== '' ? parseInt(g.mortalityCount) : 0,
          mortality_reason: g.mortalityReason || null,
          comments: g.comments || null,
        })),
    ];
    try {
      const inSub = checkInSubmissionDuplicates('poultry_dailys', recs);
      if (inSub) {
        setSubmitting(false);
        setErr(formatDuplicateError('poultry_dailys', inSub));
        return;
      }
      for (const r of recs) {
        const dupe = await checkDailyDuplicate(sb, 'poultry_dailys', r);
        if (dupe) {
          setSubmitting(false);
          setErr(formatDuplicateError('poultry_dailys', r));
          return;
        }
      }
    } catch (e) {
      setSubmitting(false);
      setErr(e.message || 'Could not verify duplicate report.');
      return;
    }
    const {data, error} = await sb.from('poultry_dailys').insert(recs).select();
    setSubmitting(false);
    if (error) {
      setErr('Could not save: ' + error.message);
      return;
    }
    // Check starter feed threshold for each STARTER record (fire-and-forget)
    recs
      .filter((r) => r.feed_type === 'STARTER' && parseFloat(r.feed_lbs) > 0)
      .forEach((r) => {
        wcfSendEmail('starter_feed_check', {batch_label: r.batch_label, feed_lbs: r.feed_lbs});
      });
    if (data) onSaved(data);
    onClose();
  }
  async function submitLayer() {
    if (!lForm.date || !lForm.teamMember || !lForm.batchLabel) {
      setErr('Please fill in all required fields.');
      return;
    }
    // Conditional validation — mirror WebformHub rules
    if (parseFloat(lForm.feedLbs) > 0 && !lForm.feedType) {
      setErr('Feed Type is required when Feed (lbs) is entered.');
      return;
    }
    if (parseInt(lForm.mortalityCount) > 0 && !(lForm.mortalityReason || '').trim()) {
      setErr('Mortality reason is required when mortalities are reported.');
      return;
    }
    for (const eg of extraL.filter((g) => g.batchLabel)) {
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
    setSubmitting(true);
    const base = {
      id: genId(),
      submitted_at: new Date().toISOString(),
      date: lForm.date,
      team_member: lForm.teamMember,
      batch_label: lForm.batchLabel,
      feed_type: lForm.feedType || null,
      feed_lbs: lForm.feedLbs !== '' ? parseFloat(lForm.feedLbs) : null,
      grit_lbs: lForm.gritLbs !== '' ? parseFloat(lForm.gritLbs) : null,
      layer_count: lForm.layerCount !== '' ? parseInt(lForm.layerCount) : null,
      group_moved: lForm.groupMoved,
      waterer_checked: lForm.watererChecked,
      mortality_count: lForm.mortalityCount !== '' ? parseInt(lForm.mortalityCount) : 0,
      mortality_reason: lForm.mortalityReason || null,
      comments: lForm.comments || null,
    };
    const recs = [
      base,
      ...extraL
        .filter((g) => g.batchLabel)
        .map((g) => ({
          ...base,
          id: genId(),
          batch_label: g.batchLabel,
          feed_type: g.feedType || null,
          feed_lbs: g.feedLbs !== '' ? parseFloat(g.feedLbs) : null,
          grit_lbs: g.gritLbs !== '' ? parseFloat(g.gritLbs) : null,
          layer_count: g.layerCount !== '' ? parseInt(g.layerCount) : null,
          group_moved: g.groupMoved !== false,
          waterer_checked: g.watererChecked !== false,
          mortality_count: g.mortalityCount !== '' ? parseInt(g.mortalityCount) : 0,
          mortality_reason: g.mortalityReason || null,
          comments: g.comments || null,
        })),
    ];
    try {
      const inSubL = checkInSubmissionDuplicates('layer_dailys', recs);
      if (inSubL) {
        setSubmitting(false);
        setErr(formatDuplicateError('layer_dailys', inSubL));
        return;
      }
      for (const r of recs) {
        const dupe = await checkDailyDuplicate(sb, 'layer_dailys', r);
        if (dupe) {
          setSubmitting(false);
          setErr(formatDuplicateError('layer_dailys', r));
          return;
        }
      }
    } catch (e) {
      setSubmitting(false);
      setErr(e.message || 'Could not verify duplicate report.');
      return;
    }
    const {data, error} = await sb.from('layer_dailys').insert(recs).select();
    setSubmitting(false);
    if (error) {
      setErr('Could not save: ' + error.message);
      return;
    }
    // Check starter feed threshold for STARTER layer records
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
    if (data) onSaved(data);
    onClose();
  }
  async function submitEgg() {
    if (!eForm.date || !eForm.teamMember) {
      setErr('Please fill in date and team member.');
      return;
    }
    setErr('');
    setSubmitting(true);
    const g1 = eForm.g1c !== '' ? parseInt(eForm.g1c) : 0,
      g2 = eForm.g2c !== '' ? parseInt(eForm.g2c) : 0,
      g3 = eForm.g3c !== '' ? parseInt(eForm.g3c) : 0,
      g4 = eForm.g4c !== '' ? parseInt(eForm.g4c) : 0;
    const rec = {
      id: genId(),
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
      daily_dozen_count: Math.floor((g1 + g2 + g3 + g4) / 12),
      dozens_on_hand: eForm.dozensOnHand !== '' ? parseFloat(eForm.dozensOnHand) : null,
      comments: eForm.comments || null,
    };
    try {
      const dupe = await checkDailyDuplicate(sb, 'egg_dailys', rec);
      if (dupe) {
        setSubmitting(false);
        setErr(formatDuplicateError('egg_dailys', rec));
        return;
      }
    } catch (e) {
      setSubmitting(false);
      setErr(e.message || 'Could not verify duplicate report.');
      return;
    }
    const {data, error} = await sb.from('egg_dailys').insert(rec).select().single();
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
    if (data) onSaved([data]);
    onClose();
  }
  async function submitPig() {
    if (!pForm.date || !pForm.teamMember || !pForm.batchLabel) {
      setErr('Please fill in all required fields.');
      return;
    }
    setErr('');
    setSubmitting(true);
    const base = {
      id: genId(),
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
    };
    const recs = [
      base,
      ...extraP
        .filter((g) => g.batchLabel)
        .map((g) => ({
          ...base,
          id: genId(),
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
        })),
    ];
    try {
      const inSubP = checkInSubmissionDuplicates('pig_dailys', recs);
      if (inSubP) {
        setSubmitting(false);
        setErr(formatDuplicateError('pig_dailys', inSubP));
        return;
      }
      for (const r of recs) {
        const dupe = await checkDailyDuplicate(sb, 'pig_dailys', r);
        if (dupe) {
          setSubmitting(false);
          setErr(formatDuplicateError('pig_dailys', r));
          return;
        }
      }
    } catch (e) {
      setSubmitting(false);
      setErr(e.message || 'Could not verify duplicate report.');
      return;
    }
    const {data, error} = await sb.from('pig_dailys').insert(recs).select();
    setSubmitting(false);
    if (error) {
      setErr('Could not save: ' + error.message);
      return;
    }
    if (data) onSaved(data);
    onClose();
  }

  async function submitCattle() {
    if (!cForm.date || !cForm.teamMember || !cForm.herd) {
      setErr('Date, team member, and herd are required.');
      return;
    }
    setErr('');
    setSubmitting(true);
    const feedsJ = (cForm.feeds || [])
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
          is_creep: !!f.isCreep,
          nutrition_snapshot: {moisture_pct: fi.moisture_pct, nfc_pct: fi.nfc_pct, protein_pct: fi.protein_pct},
        };
      })
      .filter(Boolean);
    const mineralsJ = (cForm.minerals || [])
      .filter((m) => m.feedId && m.lbs !== '' && m.lbs != null)
      .map((m) => {
        const fi = cattleFeedInputs.find((x) => x.id === m.feedId);
        if (!fi) return null;
        return {feed_input_id: fi.id, name: fi.name, lbs: parseFloat(m.lbs) || 0};
      })
      .filter(Boolean);
    const rec = {
      id: genId(),
      submitted_at: new Date().toISOString(),
      date: cForm.date,
      team_member: cForm.teamMember,
      herd: cForm.herd,
      feeds: feedsJ,
      minerals: mineralsJ,
      fence_voltage: cForm.fenceVoltage !== '' ? parseFloat(cForm.fenceVoltage) : null,
      water_checked: cForm.waterChecked,
      mortality_count: 0,
      mortality_reason: null,
      issues: cForm.issues || null,
      source: 'admin_add_report',
    };
    try {
      const dupe = await checkDailyDuplicate(sb, 'cattle_dailys', rec);
      if (dupe) {
        setSubmitting(false);
        setErr(formatDuplicateError('cattle_dailys', rec));
        return;
      }
    } catch (e) {
      setSubmitting(false);
      setErr(e.message || 'Could not verify duplicate report.');
      return;
    }
    const {data, error} = await sb.from('cattle_dailys').insert(rec).select();
    setSubmitting(false);
    if (error) {
      setErr('Could not save: ' + error.message);
      return;
    }
    if (data) onSaved(data);
    onClose();
  }

  async function submitSheep() {
    if (!sForm.date || !sForm.teamMember || !sForm.flock) {
      setErr('Date, team member, and flock are required.');
      return;
    }
    setErr('');
    setSubmitting(true);
    // Shared livestock feed master list — sheep uses cattleFeedInputs with
    // sheep flocks in herd_scope (migration 012 seeds three defaults).
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
    const rec = {
      id: genId(),
      submitted_at: new Date().toISOString(),
      date: sForm.date,
      team_member: sForm.teamMember,
      flock: sForm.flock,
      feeds: feedsJ,
      minerals: mineralsJ,
      fence_voltage_kv: sForm.fenceVoltageKv !== '' ? parseFloat(sForm.fenceVoltageKv) : null,
      waterers_working: !!sForm.waterersWorking,
      mortality_count: 0,
      comments: sForm.comments || null,
      source: 'admin_add_report',
    };
    try {
      const dupe = await checkDailyDuplicate(sb, 'sheep_dailys', rec);
      if (dupe) {
        setSubmitting(false);
        setErr(formatDuplicateError('sheep_dailys', rec));
        return;
      }
    } catch (e) {
      setSubmitting(false);
      setErr(e.message || 'Could not verify duplicate report.');
      return;
    }
    const {data, error} = await sb.from('sheep_dailys').insert(rec).select();
    setSubmitting(false);
    if (error) {
      setErr('Could not save: ' + error.message);
      return;
    }
    if (data) onSaved(data);
    onClose();
  }

  const totalRecs =
    formType === 'broiler'
      ? 1 + extraB.filter((g) => g.batchLabel).length
      : formType === 'layer'
        ? 1 + extraL.filter((g) => g.batchLabel).length
        : formType === 'pig'
          ? 1 + extraP.filter((g) => g.batchLabel).length
          : 1;
  const submitFn =
    formType === 'broiler'
      ? submitBroiler
      : formType === 'layer'
        ? submitLayer
        : formType === 'egg'
          ? submitEgg
          : formType === 'cattle'
            ? submitCattle
            : formType === 'sheep'
              ? submitSheep
              : submitPig;
  const titles = {
    broiler: '🐔 Add Broiler Report',
    layer: '🐓 Add Layer Report',
    egg: '🥚 Add Egg Report',
    pig: '🐷 Add Pig Report',
    cattle: 'Add Cattle Report',
    sheep: '🐑 Add Sheep Report',
  };
  const title = formType === 'cattle' ? renderCattleIconLabel('Add Cattle Report', {size: 20}) : titles[formType];

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,.5)',
        zIndex: 600,
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
          borderRadius: 14,
          width: '100%',
          maxWidth: 520,
          boxShadow: '0 12px 40px rgba(0,0,0,.25)',
          marginTop: 24,
          marginBottom: 24,
        }}
      >
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid #e5e7eb',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            position: 'sticky',
            top: 0,
            background: 'white',
            borderRadius: '14px 14px 0 0',
            zIndex: 1,
          }}
        >
          <div style={{fontSize: 15, fontWeight: 700, color: '#085041'}}>{title}</div>
          <button
            onClick={onClose}
            style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
          >
            ×
          </button>
        </div>
        <div style={{padding: '16px 20px', maxHeight: '76vh', overflowY: 'auto'}}>
          {/* ── BROILER ── */}
          {formType === 'broiler' && (
            <div>
              <div style={sec}>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={lbl}>
                      {getFieldLabel('broiler-dailys', 'date', 'Date')}
                      {reqStar('broiler-dailys', 'date')}
                    </label>
                    <input
                      type="date"
                      value={bForm.date}
                      onChange={(e) => setBForm((f) => ({...f, date: e.target.value}))}
                      style={inp}
                    />
                  </div>
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={lbl}>
                      {getFieldLabel('broiler-dailys', 'team_member', 'Team Member')}
                      {reqStar('broiler-dailys', 'team_member')}
                    </label>
                    <select
                      value={bForm.teamMember}
                      onChange={(e) => setBForm((f) => ({...f, teamMember: e.target.value}))}
                      style={inp}
                    >
                      <option value="">Select...</option>
                      {getFormTeamMembers('broiler-dailys').map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                  {isEnabled('broiler-dailys', 'batch_label') && (
                    <div style={{gridColumn: '1/-1'}}>
                      <label style={lbl}>
                        {getFieldLabel('broiler-dailys', 'batch_label', 'Broiler Group')}
                        {reqStar('broiler-dailys', 'batch_label')}
                      </label>
                      <select
                        value={bForm.batchLabel}
                        onChange={(e) => setBForm((f) => ({...f, batchLabel: e.target.value}))}
                        style={inp}
                      >
                        <option value="">Select batch...</option>
                        {broilerGroups.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {isEnabled('broiler-dailys', 'feed_type') && (
                    <div style={{gridColumn: '1/-1'}}>
                      <label style={lbl}>
                        {getFieldLabel('broiler-dailys', 'feed_type', 'Feed Type')}
                        {reqStar('broiler-dailys', 'feed_type')}
                      </label>
                      <WcfToggle
                        opts={getFieldOptions('broiler-dailys', 'feed_type', ['STARTER', 'GROWER'])}
                        val={bForm.feedType}
                        onChange={(v) => setBForm((f) => ({...f, feedType: v}))}
                      />
                    </div>
                  )}
                  {isEnabled('broiler-dailys', 'feed_lbs') && (
                    <div>
                      <label style={lbl}>
                        {getFieldLabel('broiler-dailys', 'feed_lbs', 'Feed (lbs)')}
                        {reqStar('broiler-dailys', 'feed_lbs')}
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={bForm.feedLbs || ''}
                        onChange={(e) => setBForm((f) => ({...f, feedLbs: e.target.value}))}
                        placeholder="0"
                        style={inp}
                      />
                    </div>
                  )}
                  {isEnabled('broiler-dailys', 'grit_lbs') && (
                    <div>
                      <label style={lbl}>
                        {getFieldLabel('broiler-dailys', 'grit_lbs', 'Grit (lbs)')}
                        {reqStar('broiler-dailys', 'grit_lbs')}
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={bForm.gritLbs || ''}
                        onChange={(e) => setBForm((f) => ({...f, gritLbs: e.target.value}))}
                        placeholder="0"
                        style={inp}
                      />
                    </div>
                  )}
                </div>
              </div>
              {(isEnabled('broiler-dailys', 'group_moved') || isEnabled('broiler-dailys', 'waterer_checked')) && (
                <div style={sec}>
                  <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
                    {isEnabled('broiler-dailys', 'group_moved') && (
                      <div>
                        <label style={lbl}>
                          {getFieldLabel('broiler-dailys', 'group_moved', 'Group moved?')}
                          {reqStar('broiler-dailys', 'group_moved')}
                        </label>
                        <WcfYN val={bForm.groupMoved} onChange={(v) => setBForm((f) => ({...f, groupMoved: v}))} />
                      </div>
                    )}
                    {isEnabled('broiler-dailys', 'waterer_checked') && (
                      <div>
                        <label style={lbl}>
                          {getFieldLabel('broiler-dailys', 'waterer_checked', 'Waterer checked?')}
                          {reqStar('broiler-dailys', 'waterer_checked')}
                        </label>
                        <WcfYN
                          val={bForm.watererChecked}
                          onChange={(v) => setBForm((f) => ({...f, watererChecked: v}))}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}
              {(isEnabled('broiler-dailys', 'mortality_count') || isEnabled('broiler-dailys', 'mortality_reason')) && (
                <div style={sec}>
                  <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                    {isEnabled('broiler-dailys', 'mortality_count') && (
                      <div>
                        <label style={lbl}>
                          {getFieldLabel('broiler-dailys', 'mortality_count', 'Mortalities')}
                          {reqStar('broiler-dailys', 'mortality_count')}
                        </label>
                        <input
                          type="number"
                          min="0"
                          value={bForm.mortalityCount || ''}
                          onChange={(e) => setBForm((f) => ({...f, mortalityCount: e.target.value}))}
                          placeholder="0"
                          style={inp}
                        />
                      </div>
                    )}
                    {isEnabled('broiler-dailys', 'mortality_reason') && parseInt(bForm.mortalityCount) > 0 && (
                      <div>
                        <label style={lbl}>
                          {getFieldLabel('broiler-dailys', 'mortality_reason', 'Reason')}{' '}
                          <span style={{color: '#dc2626'}}>*</span>
                        </label>
                        <input
                          value={bForm.mortalityReason}
                          onChange={(e) => setBForm((f) => ({...f, mortalityReason: e.target.value}))}
                          style={inp}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}
              {isEnabled('broiler-dailys', 'comments') && (
                <div style={sec}>
                  <label style={lbl}>
                    {getFieldLabel('broiler-dailys', 'comments', 'Comments / Issues')}
                    {reqStar('broiler-dailys', 'comments')}
                  </label>
                  <textarea
                    value={bForm.comments}
                    onChange={(e) => setBForm((f) => ({...f, comments: e.target.value}))}
                    rows={3}
                    placeholder="Type 0 if nothing to report"
                    style={{...inp, resize: 'vertical'}}
                  />
                </div>
              )}
              {allowAddGroup('broiler-dailys') && (
                <div>
                  {extraB.map((eg, ei) => (
                    <div key={ei} style={{...sec, border: '2px dashed #a7f3d0'}}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: 8,
                        }}
                      >
                        <div style={{fontSize: 13, fontWeight: 600, color: '#085041'}}>Additional Group {ei + 2}</div>
                        <button
                          type="button"
                          onClick={() => setExtraB((p) => p.filter((_, i) => i !== ei))}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#9ca3af',
                            cursor: 'pointer',
                            fontSize: 18,
                          }}
                        >
                          ×
                        </button>
                      </div>
                      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                        <div style={{gridColumn: '1/-1'}}>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Broiler Group *
                          </label>
                          <select
                            value={eg.batchLabel || ''}
                            onChange={(e) =>
                              setExtraB((p) => p.map((g, i) => (i === ei ? {...g, batchLabel: e.target.value} : g)))
                            }
                            style={inp}
                          >
                            <option value="">Select batch...</option>
                            {broilerGroups.map((b) => (
                              <option key={b} value={b}>
                                {b}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div style={{gridColumn: '1/-1'}}>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Feed Type
                          </label>
                          <WcfToggle
                            opts={getFieldOptions('broiler-dailys', 'feed_type', ['STARTER', 'GROWER'])}
                            val={eg.feedType || ''}
                            onChange={(v) => setExtraB((p) => p.map((g, i) => (i === ei ? {...g, feedType: v} : g)))}
                          />
                        </div>
                        <div>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Feed (lbs)
                          </label>
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={eg.feedLbs || ''}
                            onChange={(e) =>
                              setExtraB((p) => p.map((g, i) => (i === ei ? {...g, feedLbs: e.target.value} : g)))
                            }
                            placeholder="0"
                            style={inp}
                          />
                        </div>
                        <div>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Grit (lbs)
                          </label>
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={eg.gritLbs || ''}
                            onChange={(e) =>
                              setExtraB((p) => p.map((g, i) => (i === ei ? {...g, gritLbs: e.target.value} : g)))
                            }
                            placeholder="0"
                            style={inp}
                          />
                        </div>
                        <div>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Group moved?
                          </label>
                          <WcfYN
                            val={eg.groupMoved !== false}
                            onChange={(v) => setExtraB((p) => p.map((g, i) => (i === ei ? {...g, groupMoved: v} : g)))}
                          />
                        </div>
                        <div>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Waterer checked?
                          </label>
                          <WcfYN
                            val={eg.watererChecked !== false}
                            onChange={(v) =>
                              setExtraB((p) => p.map((g, i) => (i === ei ? {...g, watererChecked: v} : g)))
                            }
                          />
                        </div>
                        <div>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Mortalities
                          </label>
                          <input
                            type="number"
                            min="0"
                            value={eg.mortalityCount || ''}
                            onChange={(e) =>
                              setExtraB((p) => p.map((g, i) => (i === ei ? {...g, mortalityCount: e.target.value} : g)))
                            }
                            placeholder="0"
                            style={inp}
                          />
                        </div>
                        {parseInt(eg.mortalityCount) > 0 && (
                          <div>
                            <label
                              style={{
                                display: 'block',
                                fontSize: 13,
                                color: '#374151',
                                marginBottom: 5,
                                fontWeight: 500,
                              }}
                            >
                              Mortality reason <span style={{color: '#dc2626'}}>*</span>
                            </label>
                            <input
                              value={eg.mortalityReason || ''}
                              onChange={(e) =>
                                setExtraB((p) =>
                                  p.map((g, i) => (i === ei ? {...g, mortalityReason: e.target.value} : g)),
                                )
                              }
                              style={inp}
                            />
                          </div>
                        )}
                        <div style={{gridColumn: '1/-1'}}>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Comments
                          </label>
                          <textarea
                            value={eg.comments || ''}
                            onChange={(e) =>
                              setExtraB((p) => p.map((g, i) => (i === ei ? {...g, comments: e.target.value} : g)))
                            }
                            rows={2}
                            placeholder="Type 0 if nothing to report"
                            style={{...inp, resize: 'vertical'}}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      setExtraB((p) => [
                        ...p,
                        {
                          batchLabel: '',
                          feedType: '',
                          feedLbs: '',
                          gritLbs: '',
                          mortalityCount: '',
                          mortalityReason: '',
                          comments: '',
                          groupMoved: true,
                          watererChecked: true,
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
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      marginBottom: 4,
                    }}
                  >
                    + Add Another Group
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── LAYER ── */}
          {formType === 'layer' && (
            <div>
              <div style={sec}>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={lbl}>
                      {getFieldLabel('layer-dailys', 'date', 'Date')}
                      {reqStar('layer-dailys', 'date')}
                    </label>
                    <input
                      type="date"
                      value={lForm.date}
                      onChange={(e) => setLForm((f) => ({...f, date: e.target.value}))}
                      style={inp}
                    />
                  </div>
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={lbl}>
                      {getFieldLabel('layer-dailys', 'team_member', 'Team Member')}
                      {reqStar('layer-dailys', 'team_member')}
                    </label>
                    <select
                      value={lForm.teamMember}
                      onChange={(e) => setLForm((f) => ({...f, teamMember: e.target.value}))}
                      style={inp}
                    >
                      <option value="">Select...</option>
                      {getFormTeamMembers('layer-dailys').map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                  {isEnabled('layer-dailys', 'batch_label') && (
                    <div style={{gridColumn: '1/-1'}}>
                      <label style={lbl}>
                        {getFieldLabel('layer-dailys', 'batch_label', 'Layer Group')}
                        {reqStar('layer-dailys', 'batch_label')}
                      </label>
                      <select
                        value={lForm.batchLabel}
                        onChange={(e) => setLForm((f) => ({...f, batchLabel: e.target.value}))}
                        style={inp}
                      >
                        <option value="">Select group...</option>
                        {layerGroupNames.map((g) => (
                          <option key={g} value={g}>
                            {g}
                          </option>
                        ))}
                      </select>
                      {lForm.batchLabel && housingBatchMap[lForm.batchLabel] && (
                        <div
                          style={{
                            marginTop: 4,
                            fontSize: 11,
                            color: '#1d4ed8',
                            background: '#eff6ff',
                            border: '1px solid #bfdbfe',
                            borderRadius: 6,
                            padding: '4px 8px',
                          }}
                        >
                          Active in batch: <strong>{housingBatchMap[lForm.batchLabel]}</strong>
                        </div>
                      )}
                    </div>
                  )}
                  {isEnabled('layer-dailys', 'feed_type') && (
                    <div style={{gridColumn: '1/-1'}}>
                      <label style={lbl}>
                        {getFieldLabel('layer-dailys', 'feed_type', 'Feed Type')}
                        {reqStar('layer-dailys', 'feed_type')}
                      </label>
                      <WcfToggle
                        opts={getFieldOptions('layer-dailys', 'feed_type', ['STARTER', 'GROWER', 'LAYER'])}
                        val={lForm.feedType}
                        onChange={(v) => setLForm((f) => ({...f, feedType: v}))}
                      />
                    </div>
                  )}
                  {isEnabled('layer-dailys', 'feed_lbs') && (
                    <div>
                      <label style={lbl}>
                        {getFieldLabel('layer-dailys', 'feed_lbs', 'Feed (lbs)')}
                        {reqStar('layer-dailys', 'feed_lbs')}
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={lForm.feedLbs || ''}
                        onChange={(e) => setLForm((f) => ({...f, feedLbs: e.target.value}))}
                        placeholder="0"
                        style={inp}
                      />
                    </div>
                  )}
                  {isEnabled('layer-dailys', 'grit_lbs') && (
                    <div>
                      <label style={lbl}>
                        {getFieldLabel('layer-dailys', 'grit_lbs', 'Grit (lbs)')}
                        {reqStar('layer-dailys', 'grit_lbs')}
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={lForm.gritLbs || ''}
                        onChange={(e) => setLForm((f) => ({...f, gritLbs: e.target.value}))}
                        placeholder="0"
                        style={inp}
                      />
                    </div>
                  )}
                  {isEnabled('layer-dailys', 'layer_count') && (
                    <div style={{gridColumn: '1/-1'}}>
                      <label style={lbl}>
                        {getFieldLabel('layer-dailys', 'layer_count', 'Hen count')}
                        {reqStar('layer-dailys', 'layer_count')}
                      </label>
                      <input
                        type="number"
                        min="0"
                        value={lForm.layerCount || ''}
                        onChange={(e) => setLForm((f) => ({...f, layerCount: e.target.value}))}
                        placeholder="0"
                        style={inp}
                      />
                    </div>
                  )}
                </div>
              </div>
              {(isEnabled('layer-dailys', 'group_moved') || isEnabled('layer-dailys', 'waterer_checked')) && (
                <div style={sec}>
                  <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
                    {isEnabled('layer-dailys', 'group_moved') && (
                      <div>
                        <label style={lbl}>
                          {getFieldLabel('layer-dailys', 'group_moved', 'Group moved?')}
                          {reqStar('layer-dailys', 'group_moved')}
                        </label>
                        <WcfYN val={lForm.groupMoved} onChange={(v) => setLForm((f) => ({...f, groupMoved: v}))} />
                      </div>
                    )}
                    {isEnabled('layer-dailys', 'waterer_checked') && (
                      <div>
                        <label style={lbl}>
                          {getFieldLabel('layer-dailys', 'waterer_checked', 'Waterer checked?')}
                          {reqStar('layer-dailys', 'waterer_checked')}
                        </label>
                        <WcfYN
                          val={lForm.watererChecked}
                          onChange={(v) => setLForm((f) => ({...f, watererChecked: v}))}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}
              {(isEnabled('layer-dailys', 'mortality_count') || isEnabled('layer-dailys', 'mortality_reason')) && (
                <div style={sec}>
                  <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                    {isEnabled('layer-dailys', 'mortality_count') && (
                      <div>
                        <label style={lbl}>
                          {getFieldLabel('layer-dailys', 'mortality_count', 'Mortalities')}
                          {reqStar('layer-dailys', 'mortality_count')}
                        </label>
                        <input
                          type="number"
                          min="0"
                          value={lForm.mortalityCount || ''}
                          onChange={(e) => setLForm((f) => ({...f, mortalityCount: e.target.value}))}
                          placeholder="0"
                          style={inp}
                        />
                      </div>
                    )}
                    {isEnabled('layer-dailys', 'mortality_reason') && parseInt(lForm.mortalityCount) > 0 && (
                      <div>
                        <label style={lbl}>
                          {getFieldLabel('layer-dailys', 'mortality_reason', 'Reason')}{' '}
                          <span style={{color: '#dc2626'}}>*</span>
                        </label>
                        <input
                          value={lForm.mortalityReason}
                          onChange={(e) => setLForm((f) => ({...f, mortalityReason: e.target.value}))}
                          style={inp}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}
              {isEnabled('layer-dailys', 'comments') && (
                <div style={sec}>
                  <label style={lbl}>
                    {getFieldLabel('layer-dailys', 'comments', 'Comments / Issues')}
                    {reqStar('layer-dailys', 'comments')}
                  </label>
                  <textarea
                    value={lForm.comments}
                    onChange={(e) => setLForm((f) => ({...f, comments: e.target.value}))}
                    rows={3}
                    placeholder="Type 0 if nothing to report"
                    style={{...inp, resize: 'vertical'}}
                  />
                </div>
              )}
              {allowAddGroup('layer-dailys') && (
                <div>
                  {extraL.map((eg, ei) => (
                    <div key={ei} style={{...sec, border: '2px dashed #a7f3d0'}}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: 8,
                        }}
                      >
                        <div style={{fontSize: 13, fontWeight: 600, color: '#78350f'}}>Additional Group {ei + 2}</div>
                        <button
                          type="button"
                          onClick={() => setExtraL((p) => p.filter((_, i) => i !== ei))}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#9ca3af',
                            cursor: 'pointer',
                            fontSize: 18,
                          }}
                        >
                          ×
                        </button>
                      </div>
                      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                        <div style={{gridColumn: '1/-1'}}>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Layer Group *
                          </label>
                          <select
                            value={eg.batchLabel || ''}
                            onChange={(e) =>
                              setExtraL((p) => p.map((g, i) => (i === ei ? {...g, batchLabel: e.target.value} : g)))
                            }
                            style={inp}
                          >
                            <option value="">Select group...</option>
                            {layerGroupNames.map((g) => (
                              <option key={g} value={g}>
                                {g}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Feed (lbs)
                          </label>
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={eg.feedLbs || ''}
                            onChange={(e) =>
                              setExtraL((p) => p.map((g, i) => (i === ei ? {...g, feedLbs: e.target.value} : g)))
                            }
                            placeholder="0"
                            style={inp}
                          />
                        </div>
                        <div>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Grit (lbs)
                          </label>
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={eg.gritLbs || ''}
                            onChange={(e) =>
                              setExtraL((p) => p.map((g, i) => (i === ei ? {...g, gritLbs: e.target.value} : g)))
                            }
                            placeholder="0"
                            style={inp}
                          />
                        </div>
                        <div style={{gridColumn: '1/-1'}}>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Hen count
                          </label>
                          <input
                            type="number"
                            min="0"
                            value={eg.layerCount || ''}
                            onChange={(e) =>
                              setExtraL((p) => p.map((g, i) => (i === ei ? {...g, layerCount: e.target.value} : g)))
                            }
                            placeholder="0"
                            style={inp}
                          />
                        </div>
                        <div>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Group moved?
                          </label>
                          <WcfYN
                            val={eg.groupMoved !== false}
                            onChange={(v) => setExtraL((p) => p.map((g, i) => (i === ei ? {...g, groupMoved: v} : g)))}
                          />
                        </div>
                        <div>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Waterer checked?
                          </label>
                          <WcfYN
                            val={eg.watererChecked !== false}
                            onChange={(v) =>
                              setExtraL((p) => p.map((g, i) => (i === ei ? {...g, watererChecked: v} : g)))
                            }
                          />
                        </div>
                        <div>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Mortalities
                          </label>
                          <input
                            type="number"
                            min="0"
                            value={eg.mortalityCount || ''}
                            onChange={(e) =>
                              setExtraL((p) => p.map((g, i) => (i === ei ? {...g, mortalityCount: e.target.value} : g)))
                            }
                            placeholder="0"
                            style={inp}
                          />
                        </div>
                        {parseInt(eg.mortalityCount) > 0 && (
                          <div>
                            <label
                              style={{
                                display: 'block',
                                fontSize: 13,
                                color: '#374151',
                                marginBottom: 5,
                                fontWeight: 500,
                              }}
                            >
                              Mortality reason <span style={{color: '#dc2626'}}>*</span>
                            </label>
                            <input
                              value={eg.mortalityReason || ''}
                              onChange={(e) =>
                                setExtraL((p) =>
                                  p.map((g, i) => (i === ei ? {...g, mortalityReason: e.target.value} : g)),
                                )
                              }
                              style={inp}
                            />
                          </div>
                        )}
                        <div style={{gridColumn: '1/-1'}}>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Comments
                          </label>
                          <textarea
                            value={eg.comments || ''}
                            onChange={(e) =>
                              setExtraL((p) => p.map((g, i) => (i === ei ? {...g, comments: e.target.value} : g)))
                            }
                            rows={2}
                            placeholder="Type 0 if nothing to report"
                            style={{...inp, resize: 'vertical'}}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      setExtraL((p) => [
                        ...p,
                        {
                          batchLabel: '',
                          feedLbs: '',
                          gritLbs: '',
                          layerCount: '',
                          mortalityCount: '',
                          mortalityReason: '',
                          comments: '',
                          groupMoved: true,
                          watererChecked: true,
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
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      marginBottom: 4,
                    }}
                  >
                    + Add Another Group
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── EGG ── */}
          {formType === 'egg' && (
            <div>
              <div style={sec}>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={lbl}>
                      {getFieldLabel('egg-dailys', 'date', 'Date')}
                      {reqStar('egg-dailys', 'date')}
                    </label>
                    <input
                      type="date"
                      value={eForm.date}
                      onChange={(e) => setEForm((f) => ({...f, date: e.target.value}))}
                      style={inp}
                    />
                  </div>
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={lbl}>
                      {getFieldLabel('egg-dailys', 'team_member', 'Team Member')}
                      {reqStar('egg-dailys', 'team_member')}
                    </label>
                    <select
                      value={eForm.teamMember}
                      onChange={(e) => setEForm((f) => ({...f, teamMember: e.target.value}))}
                      style={inp}
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
              {[1, 2, 3, 4].map((n) => {
                const fid = `group${n}_pair`;
                if (!isEnabled('egg-dailys', fid)) return null;
                return (
                  <div key={n} style={sec}>
                    <div style={{fontSize: 12, fontWeight: 600, color: '#78350f', marginBottom: 8}}>
                      Group {n}
                      {isRequired('egg-dailys', fid) && <span style={{color: '#b91c1c'}}> *</span>}
                    </div>
                    <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                      <div>
                        <label
                          style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                        >
                          Group name
                        </label>
                        <select
                          value={eForm[`g${n}n`]}
                          onChange={(e) => setEForm((f) => ({...f, [`g${n}n`]: e.target.value}))}
                          style={inp}
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
                        <label
                          style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                        >
                          Eggs collected
                        </label>
                        <input
                          type="number"
                          min="0"
                          value={eForm[`g${n}c`]}
                          onChange={(e) => setEForm((f) => ({...f, [`g${n}c`]: e.target.value}))}
                          placeholder="0"
                          style={inp}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
              <div style={sec}>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                  {isEnabled('egg-dailys', 'dozens_on_hand') && (
                    <div style={{gridColumn: '1/-1'}}>
                      <label style={lbl}>
                        {getFieldLabel('egg-dailys', 'dozens_on_hand', 'Dozens on hand')}
                        {reqStar('egg-dailys', 'dozens_on_hand')}
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        value={eForm.dozensOnHand || ''}
                        onChange={(e) => setEForm((f) => ({...f, dozensOnHand: e.target.value}))}
                        style={inp}
                      />
                    </div>
                  )}
                  {isEnabled('egg-dailys', 'comments') && (
                    <div style={{gridColumn: '1/-1'}}>
                      <label style={lbl}>
                        {getFieldLabel('egg-dailys', 'comments', 'Comments / Issues')}
                        {reqStar('egg-dailys', 'comments')}
                      </label>
                      <textarea
                        value={eForm.comments}
                        onChange={(e) => setEForm((f) => ({...f, comments: e.target.value}))}
                        rows={2}
                        placeholder="Type 0 if nothing to report"
                        style={{...inp, resize: 'vertical'}}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── PIG ── */}
          {formType === 'pig' && (
            <div>
              <div style={sec}>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={lbl}>
                      {getFieldLabel('pig-dailys', 'date', 'Date')}
                      {reqStar('pig-dailys', 'date')}
                    </label>
                    <input
                      type="date"
                      value={pForm.date}
                      onChange={(e) => setPForm((f) => ({...f, date: e.target.value}))}
                      style={inp}
                    />
                  </div>
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={lbl}>
                      {getFieldLabel('pig-dailys', 'team_member', 'Team Member')}
                      {reqStar('pig-dailys', 'team_member')}
                    </label>
                    <select
                      value={pForm.teamMember}
                      onChange={(e) => setPForm((f) => ({...f, teamMember: e.target.value}))}
                      style={inp}
                    >
                      <option value="">Select...</option>
                      {getFormTeamMembers('pig-dailys').map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                  {isEnabled('pig-dailys', 'batch_label') && (
                    <div style={{gridColumn: '1/-1'}}>
                      <label style={lbl}>
                        {getFieldLabel('pig-dailys', 'batch_label', 'Pig Group')}
                        {reqStar('pig-dailys', 'batch_label')}
                      </label>
                      <select
                        value={pForm.batchLabel}
                        onChange={(e) => setPForm((f) => ({...f, batchLabel: e.target.value}))}
                        style={inp}
                      >
                        <option value="">Select group...</option>
                        {pigGroups.map((g) => (
                          <option key={g.value || g} value={g.value || g}>
                            {g.label || g}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {isEnabled('pig-dailys', 'pig_count') && (
                    <div>
                      <label style={lbl}>
                        {getFieldLabel('pig-dailys', 'pig_count', '# Pigs in group')}
                        {reqStar('pig-dailys', 'pig_count')}
                      </label>
                      <input
                        type="number"
                        min="0"
                        value={pForm.pigCount || ''}
                        onChange={(e) => setPForm((f) => ({...f, pigCount: e.target.value}))}
                        placeholder="0"
                        style={inp}
                      />
                    </div>
                  )}
                  {isEnabled('pig-dailys', 'feed_lbs') && (
                    <div>
                      <label style={lbl}>
                        {getFieldLabel('pig-dailys', 'feed_lbs', 'Feed given (lbs)')}
                        {reqStar('pig-dailys', 'feed_lbs')}
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={pForm.feedLbs || ''}
                        onChange={(e) => setPForm((f) => ({...f, feedLbs: e.target.value}))}
                        placeholder="0"
                        style={inp}
                      />
                    </div>
                  )}
                  {isEnabled('pig-dailys', 'fence_voltage') && (
                    <div style={{gridColumn: '1/-1'}}>
                      <label style={lbl}>
                        {getFieldLabel('pig-dailys', 'fence_voltage', 'Fence voltage (kV)')}
                        {reqStar('pig-dailys', 'fence_voltage')}
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={pForm.fenceVoltage || ''}
                        onChange={(e) => setPForm((f) => ({...f, fenceVoltage: e.target.value}))}
                        style={inp}
                      />
                    </div>
                  )}
                </div>
              </div>
              {['group_moved', 'nipple_drinker_moved', 'nipple_drinker_working', 'troughs_moved', 'fence_walked'].some(
                (fid) => isEnabled('pig-dailys', fid),
              ) && (
                <div style={sec}>
                  <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
                    {isEnabled('pig-dailys', 'group_moved') && (
                      <div>
                        <label style={lbl}>
                          {getFieldLabel('pig-dailys', 'group_moved', 'Group moved?')}
                          {reqStar('pig-dailys', 'group_moved')}
                        </label>
                        <WcfYN val={pForm.groupMoved} onChange={(v) => setPForm((f) => ({...f, groupMoved: v}))} />
                      </div>
                    )}
                    {isEnabled('pig-dailys', 'nipple_drinker_moved') && (
                      <div>
                        <label style={lbl}>
                          {getFieldLabel('pig-dailys', 'nipple_drinker_moved', 'Nipple drinker moved?')}
                          {reqStar('pig-dailys', 'nipple_drinker_moved')}
                        </label>
                        <WcfYN
                          val={pForm.nippleDrinkerMoved}
                          onChange={(v) => setPForm((f) => ({...f, nippleDrinkerMoved: v}))}
                        />
                      </div>
                    )}
                    {isEnabled('pig-dailys', 'nipple_drinker_working') && (
                      <div>
                        <label style={lbl}>
                          {getFieldLabel('pig-dailys', 'nipple_drinker_working', 'Nipple drinker working?')}
                          {reqStar('pig-dailys', 'nipple_drinker_working')}
                        </label>
                        <WcfYN
                          val={pForm.nippleDrinkerWorking}
                          onChange={(v) => setPForm((f) => ({...f, nippleDrinkerWorking: v}))}
                        />
                      </div>
                    )}
                    {isEnabled('pig-dailys', 'troughs_moved') && (
                      <div>
                        <label style={lbl}>
                          {getFieldLabel('pig-dailys', 'troughs_moved', 'Troughs moved?')}
                          {reqStar('pig-dailys', 'troughs_moved')}
                        </label>
                        <WcfYN val={pForm.troughsMoved} onChange={(v) => setPForm((f) => ({...f, troughsMoved: v}))} />
                      </div>
                    )}
                    {isEnabled('pig-dailys', 'fence_walked') && (
                      <div style={{gridColumn: isEnabled('pig-dailys', 'troughs_moved') ? 'auto' : '1/-1'}}>
                        <label style={lbl}>
                          {getFieldLabel('pig-dailys', 'fence_walked', 'Fence line walked?')}
                          {reqStar('pig-dailys', 'fence_walked')}
                        </label>
                        <WcfYN val={pForm.fenceWalked} onChange={(v) => setPForm((f) => ({...f, fenceWalked: v}))} />
                      </div>
                    )}
                  </div>
                </div>
              )}
              {isEnabled('pig-dailys', 'issues') && (
                <div style={sec}>
                  <label style={lbl}>
                    {getFieldLabel('pig-dailys', 'issues', 'Issues / Notes')}
                    {reqStar('pig-dailys', 'issues')}
                  </label>
                  <textarea
                    value={pForm.issues}
                    onChange={(e) => setPForm((f) => ({...f, issues: e.target.value}))}
                    rows={3}
                    placeholder="Type 0 if nothing to report"
                    style={{...inp, resize: 'vertical'}}
                  />
                </div>
              )}
              {allowAddGroup('pig-dailys') && (
                <div>
                  {extraP.map((eg, ei) => (
                    <div key={ei} style={{...sec, border: '2px dashed #a7f3d0'}}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: 8,
                        }}
                      >
                        <div style={{fontSize: 13, fontWeight: 600, color: '#1e40af'}}>Additional Group {ei + 2}</div>
                        <button
                          type="button"
                          onClick={() => setExtraP((p) => p.filter((_, i) => i !== ei))}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#9ca3af',
                            cursor: 'pointer',
                            fontSize: 18,
                          }}
                        >
                          ×
                        </button>
                      </div>
                      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                        <div style={{gridColumn: '1/-1'}}>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Pig Group *
                          </label>
                          <select
                            value={eg.batchLabel || ''}
                            onChange={(e) =>
                              setExtraP((p) => p.map((g, i) => (i === ei ? {...g, batchLabel: e.target.value} : g)))
                            }
                            style={inp}
                          >
                            <option value="">Select group...</option>
                            {pigGroups.map((g) => (
                              <option key={g.value || g} value={g.value || g}>
                                {g.label || g}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Feed (lbs)
                          </label>
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={eg.feedLbs || ''}
                            onChange={(e) =>
                              setExtraP((p) => p.map((g, i) => (i === ei ? {...g, feedLbs: e.target.value} : g)))
                            }
                            placeholder="0"
                            style={inp}
                          />
                        </div>
                        <div>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            # Pigs
                          </label>
                          <input
                            type="number"
                            min="0"
                            value={eg.pigCount || ''}
                            onChange={(e) =>
                              setExtraP((p) => p.map((g, i) => (i === ei ? {...g, pigCount: e.target.value} : g)))
                            }
                            placeholder="0"
                            style={inp}
                          />
                        </div>
                        <div style={{gridColumn: '1/-1'}}>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Fence voltage (kV)
                          </label>
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={eg.fenceVoltage || ''}
                            onChange={(e) =>
                              setExtraP((p) => p.map((g, i) => (i === ei ? {...g, fenceVoltage: e.target.value} : g)))
                            }
                            style={inp}
                          />
                        </div>
                        <div>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Group moved?
                          </label>
                          <WcfYN
                            val={eg.groupMoved !== false}
                            onChange={(v) => setExtraP((p) => p.map((g, i) => (i === ei ? {...g, groupMoved: v} : g)))}
                          />
                        </div>
                        <div>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Nipple drinker working?
                          </label>
                          <WcfYN
                            val={eg.nippleDrinkerWorking !== false}
                            onChange={(v) =>
                              setExtraP((p) => p.map((g, i) => (i === ei ? {...g, nippleDrinkerWorking: v} : g)))
                            }
                          />
                        </div>
                        <div style={{gridColumn: '1/-1'}}>
                          <label
                            style={{display: 'block', fontSize: 13, color: '#374151', marginBottom: 5, fontWeight: 500}}
                          >
                            Issues
                          </label>
                          <textarea
                            value={eg.issues || ''}
                            onChange={(e) =>
                              setExtraP((p) => p.map((g, i) => (i === ei ? {...g, issues: e.target.value} : g)))
                            }
                            rows={2}
                            placeholder="Type 0 if nothing to report"
                            style={{...inp, resize: 'vertical'}}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      setExtraP((p) => [
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
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      marginBottom: 4,
                    }}
                  >
                    + Add Another Group
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── CATTLE ── */}
          {formType === 'cattle' &&
            (() => {
              const CATTLE_HERDS = [
                {v: 'mommas', l: 'Mommas'},
                {v: 'backgrounders', l: 'Backgrounders'},
                {v: 'finishers', l: 'Finishers'},
                {v: 'bulls', l: 'Bulls'},
              ];
              const herdSel = cForm.herd;
              const feedsForHerd = herdSel
                ? cattleFeedInputs.filter((f) => f.category !== 'mineral' && (f.herd_scope || []).includes(herdSel))
                : [];
              const mineralsAll = cattleFeedInputs.filter((f) => f.category === 'mineral');
              const unitFor = (id) => {
                const fi = cattleFeedInputs.find((x) => x.id === id);
                return fi ? fi.unit : '';
              };
              const showCreep = herdSel === 'mommas';
              const teamOpts = getFormTeamMembers('cattle-dailys');
              return (
                <div>
                  <div style={sec}>
                    <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                      <div style={{gridColumn: '1/-1'}}>
                        <label style={lbl}>
                          {getFieldLabel('cattle-dailys', 'date', 'Date')}
                          {reqStar('cattle-dailys', 'date')}
                        </label>
                        <input
                          type="date"
                          value={cForm.date}
                          onChange={(e) => setCForm((f) => ({...f, date: e.target.value}))}
                          style={inp}
                        />
                      </div>
                      <div style={{gridColumn: '1/-1'}}>
                        <label style={lbl}>
                          {getFieldLabel('cattle-dailys', 'team_member', 'Team Member')}
                          {reqStar('cattle-dailys', 'team_member')}
                        </label>
                        <select
                          value={cForm.teamMember}
                          onChange={(e) => setCForm((f) => ({...f, teamMember: e.target.value}))}
                          style={inp}
                        >
                          <option value="">Select...</option>
                          {teamOpts.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div style={{gridColumn: '1/-1'}}>
                        <label style={lbl}>
                          Cattle Herd <span style={{color: '#b91c1c'}}>*</span>
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
                          style={inp}
                        >
                          <option value="">Select herd...</option>
                          {CATTLE_HERDS.map((h) => (
                            <option key={h.v} value={h.v}>
                              {h.l}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {herdSel && (
                    <div style={sec}>
                      <div style={{fontSize: 13, fontWeight: 600, color: '#991b1b', marginBottom: 10}}>Feed</div>
                      {cForm.feeds.map((row, ri) => (
                        <div
                          key={ri}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '2fr 1fr auto',
                            gap: 8,
                            marginBottom: showCreep ? 4 : 10,
                            alignItems: 'end',
                          }}
                        >
                          <div>
                            {ri === 0 && <label style={{...lbl, fontSize: 12}}>Feed</label>}
                            <select
                              value={row.feedId}
                              onChange={(e) =>
                                setCForm((f) => ({
                                  ...f,
                                  feeds: f.feeds.map((r, i) => (i === ri ? {...r, feedId: e.target.value} : r)),
                                }))
                              }
                              style={{...inp, fontSize: 13, padding: '8px 10px'}}
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
                              <label style={{...lbl, fontSize: 12}}>
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
                              style={{...inp, fontSize: 13, padding: '8px 10px'}}
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
                          {showCreep && row.feedId && (
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
                              {'Creep feed (for calves) \u2014 counts for cost, not Mommas nutrition'}
                            </label>
                          )}
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() =>
                          setCForm((f) => ({...f, feeds: [...f.feeds, {feedId: '', qty: '', isCreep: false}]}))
                        }
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

                  {herdSel && (
                    <div style={sec}>
                      <div style={{fontSize: 13, fontWeight: 600, color: '#991b1b', marginBottom: 10}}>Minerals</div>
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
                            {ri === 0 && <label style={{...lbl, fontSize: 12}}>Mineral</label>}
                            <select
                              value={row.feedId}
                              onChange={(e) =>
                                setCForm((f) => ({
                                  ...f,
                                  minerals: f.minerals.map((r, i) => (i === ri ? {...r, feedId: e.target.value} : r)),
                                }))
                              }
                              style={{...inp, fontSize: 13, padding: '8px 10px'}}
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
                            {ri === 0 && <label style={{...lbl, fontSize: 12}}>Lbs</label>}
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
                              style={{...inp, fontSize: 13, padding: '8px 10px'}}
                            />
                          </div>
                          <div>
                            {ri === 0 && <div style={{fontSize: 12, marginBottom: 4, opacity: 0}}>.</div>}
                            {cForm.minerals.length > 1 ? (
                              <button
                                type="button"
                                onClick={() =>
                                  setCForm((f) => ({...f, minerals: f.minerals.filter((_, i) => i !== ri)}))
                                }
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

                  {herdSel && (
                    <div style={sec}>
                      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
                        <div>
                          <label style={lbl}>Fence Voltage (kV)</label>
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={cForm.fenceVoltage}
                            onChange={(e) => setCForm((f) => ({...f, fenceVoltage: e.target.value}))}
                            placeholder="0.0"
                            style={inp}
                          />
                        </div>
                        <div>
                          <label style={lbl}>Waterers checked?</label>
                          <WcfYN
                            val={cForm.waterChecked}
                            onChange={(v) => setCForm((f) => ({...f, waterChecked: v}))}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {herdSel && (
                    <div style={sec}>
                      <label style={lbl}>Issues / Comments</label>
                      <textarea
                        value={cForm.issues}
                        onChange={(e) => setCForm((f) => ({...f, issues: e.target.value}))}
                        rows={3}
                        placeholder="Type 0 if nothing to report"
                        style={{...inp, resize: 'vertical'}}
                      />
                    </div>
                  )}
                </div>
              );
            })()}

          {/* ── SHEEP ── */}
          {formType === 'sheep' &&
            (() => {
              const SHEEP_FLOCKS = [
                {v: 'rams', l: 'Rams'},
                {v: 'ewes', l: 'Ewes'},
                {v: 'feeders', l: 'Feeders'},
              ];
              const teamOpts = getFormTeamMembers('sheep-dailys');
              return (
                <div>
                  <div style={sec}>
                    <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                      <div style={{gridColumn: '1/-1'}}>
                        <label style={lbl}>
                          {getFieldLabel('sheep-dailys', 'date', 'Date')}
                          {reqStar('sheep-dailys', 'date')}
                        </label>
                        <input
                          type="date"
                          value={sForm.date}
                          onChange={(e) => setSForm((f) => ({...f, date: e.target.value}))}
                          style={inp}
                        />
                      </div>
                      <div style={{gridColumn: '1/-1'}}>
                        <label style={lbl}>
                          {getFieldLabel('sheep-dailys', 'team_member', 'Team Member')}
                          {reqStar('sheep-dailys', 'team_member')}
                        </label>
                        <select
                          value={sForm.teamMember}
                          onChange={(e) => setSForm((f) => ({...f, teamMember: e.target.value}))}
                          style={inp}
                        >
                          <option value="">Select...</option>
                          {teamOpts.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div style={{gridColumn: '1/-1'}}>
                        <label style={lbl}>
                          Flock <span style={{color: '#b91c1c'}}>*</span>
                        </label>
                        <select
                          value={sForm.flock}
                          onChange={(e) => setSForm((f) => ({...f, flock: e.target.value}))}
                          style={inp}
                        >
                          <option value="">Select flock...</option>
                          {SHEEP_FLOCKS.map((f) => (
                            <option key={f.v} value={f.v}>
                              {f.l}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                  {/* Feeds — multi-row picker; mirrors cattle. Filtered to selected flock. */}
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
                        <div style={sec}>
                          <div style={{fontSize: 13, fontWeight: 600, color: '#0f766e', marginBottom: 10}}>Feed</div>
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
                                {ri === 0 && <label style={{...lbl, fontSize: 12}}>Feed Type</label>}
                                <select
                                  value={row.feedId}
                                  onChange={(e) =>
                                    setSForm((f) => ({
                                      ...f,
                                      feeds: f.feeds.map((r, i) => (i === ri ? {...r, feedId: e.target.value} : r)),
                                    }))
                                  }
                                  style={{...inp, fontSize: 13, padding: '8px 10px'}}
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
                                  <label style={{...lbl, fontSize: 12}}>
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
                                  style={{...inp, fontSize: 13, padding: '8px 10px'}}
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

                  {/* Minerals — multi-row picker + pct_eaten per entry. */}
                  {sForm.flock &&
                    (() => {
                      const mineralsForFlock = cattleFeedInputs.filter(
                        (f) => f.category === 'mineral' && (f.herd_scope || []).includes(sForm.flock),
                      );
                      return (
                        <div style={sec}>
                          <div style={{fontSize: 13, fontWeight: 600, color: '#0f766e', marginBottom: 10}}>
                            Minerals
                          </div>
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
                                {ri === 0 && <label style={{...lbl, fontSize: 12}}>Mineral</label>}
                                <select
                                  value={row.feedId}
                                  onChange={(e) =>
                                    setSForm((f) => ({
                                      ...f,
                                      minerals: f.minerals.map((r, i) =>
                                        i === ri ? {...r, feedId: e.target.value} : r,
                                      ),
                                    }))
                                  }
                                  style={{...inp, fontSize: 13, padding: '8px 10px'}}
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
                                {ri === 0 && <label style={{...lbl, fontSize: 12}}>Lbs</label>}
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
                                  style={{...inp, fontSize: 13, padding: '8px 10px'}}
                                />
                              </div>
                              <div>
                                {ri === 0 && <div style={{fontSize: 12, marginBottom: 4, opacity: 0}}>.</div>}
                                {sForm.minerals.length > 1 ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setSForm((f) => ({...f, minerals: f.minerals.filter((_, i) => i !== ri)}))
                                    }
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
                  <div style={sec}>
                    <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
                      {isEnabled('sheep-dailys', 'fence_voltage_kv') && (
                        <div>
                          <label style={lbl}>
                            {getFieldLabel('sheep-dailys', 'fence_voltage_kv', 'Fence Voltage (kV)')}
                            {reqStar('sheep-dailys', 'fence_voltage_kv')}
                          </label>
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={sForm.fenceVoltageKv}
                            onChange={(e) => setSForm((f) => ({...f, fenceVoltageKv: e.target.value}))}
                            placeholder="0.0"
                            style={inp}
                          />
                        </div>
                      )}
                      {isEnabled('sheep-dailys', 'waterers_working') && (
                        <div>
                          <label style={lbl}>
                            {getFieldLabel('sheep-dailys', 'waterers_working', 'Waterers working?')}
                            {reqStar('sheep-dailys', 'waterers_working')}
                          </label>
                          <WcfYN
                            val={sForm.waterersWorking}
                            onChange={(v) => setSForm((f) => ({...f, waterersWorking: v}))}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                  {isEnabled('sheep-dailys', 'comments') && (
                    <div style={sec}>
                      <label style={lbl}>
                        {getFieldLabel('sheep-dailys', 'comments', 'Issues / Comments')}
                        {reqStar('sheep-dailys', 'comments')}
                      </label>
                      <textarea
                        value={sForm.comments}
                        onChange={(e) => setSForm((f) => ({...f, comments: e.target.value}))}
                        rows={3}
                        placeholder="Type 0 if nothing to report"
                        style={{...inp, resize: 'vertical'}}
                      />
                    </div>
                  )}
                </div>
              );
            })()}

          {err && (
            <div
              style={{
                color: '#b91c1c',
                fontSize: 13,
                marginTop: 8,
                padding: '8px 12px',
                background: '#fef2f2',
                borderRadius: 8,
                borderLeft: '3px solid #fca5a5',
              }}
            >
              {err}
            </div>
          )}
          <button
            onClick={submitFn}
            disabled={submitting}
            style={{
              width: '100%',
              marginTop: 14,
              padding: '13px 0',
              border: 'none',
              borderRadius: 10,
              background: '#085041',
              color: 'white',
              fontSize: 14,
              fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.65 : 1,
              fontFamily: 'inherit',
            }}
          >
            {submitting ? 'Saving...' : totalRecs > 1 ? `Save ${totalRecs} Reports` : 'Save Report'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AdminAddReportModal;
