// Phase 2 Round 4 extraction (verbatim).
import React from 'react';
import {openableProps} from '../shared/openable.js';
import {renderCattleIconLabel} from '../components/CattleIcon.jsx';
import {buildChanges, countSummary} from '../lib/activityChangeDiff.js';
import {recordActivityEvent} from '../lib/entityMutations.js';
import {deleteFeedInput} from '../lib/feedInputDeleteApi.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';

const FEED_GRID_COLUMNS = '2fr 80px 80px 70px 60px 60px 70px 120px';
const FEED_ACTIVITY_ENTITY = {
  entityType: 'cattle.forecast',
  entityId: 'cattle-forecast',
  entityLabel: 'Cattle Forecast',
};
const FEED_CHANGE_LABELS = {
  name: 'Name',
  category: 'Category',
  unit: 'Unit',
  unit_weight_lbs: 'Unit weight',
  cost_per_unit: 'Cost per unit',
  freight_per_truck: 'Freight per truck',
  units_per_truck: 'Units per truck',
  moisture_pct: 'Moisture',
  nfc_pct: 'NFC',
  protein_pct: 'Crude protein',
  status: 'Status',
  herd_scope: 'Herd / flock scope',
  notes: 'Notes',
};
const FEED_TEST_CHANGE_LABELS = {
  effective_date: 'Effective date',
  moisture_pct: 'Moisture',
  nfc_pct: 'NFC',
  protein_pct: 'Crude protein',
  bale_weight_lbs: 'Bale weight',
  pdf_file_name: 'PDF',
  notes: 'Notes',
};

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function integerOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function formatNumber(value) {
  if (value == null || value === '') return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? String(n) : String(value);
}

function formatMoney(value) {
  if (value == null || value === '') return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? '$' + n.toFixed(2) : String(value);
}

function formatPercent(value) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return value == null || value === '' ? null : String(value);
  return String(n) + '%';
}

function formatPounds(value) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return value == null || value === '' ? null : String(value);
  return String(n) + ' lb';
}

function formatList(value) {
  const values = Array.isArray(value) ? value : [];
  if (values.length === 0) return null;
  return countSummary(values, 'entry') + ': ' + values.join(', ');
}

function feedLabel(feed) {
  return (feed && feed.name) || 'Unnamed feed';
}

function buildFeedRecord(feedData, id) {
  const rec = {
    name: (feedData.name || '').trim(),
    category: feedData.category,
    unit: feedData.unit,
    unit_weight_lbs: numberOrNull(feedData.unit_weight_lbs),
    cost_per_unit: numberOrNull(feedData.cost_per_unit),
    freight_per_truck: numberOrNull(feedData.freight_per_truck),
    units_per_truck: integerOrNull(feedData.units_per_truck),
    moisture_pct: numberOrNull(feedData.moisture_pct),
    nfc_pct: numberOrNull(feedData.nfc_pct),
    protein_pct: numberOrNull(feedData.protein_pct),
    status: feedData.status || 'active',
    herd_scope: feedData.herd_scope || [],
    notes: feedData.notes || null,
  };
  if (id) rec.id = id;
  return rec;
}

const FEED_CHANGE_FORMATTERS = {
  unit_weight_lbs: formatPounds,
  cost_per_unit: formatMoney,
  freight_per_truck: formatMoney,
  units_per_truck: formatNumber,
  moisture_pct: formatPercent,
  nfc_pct: formatPercent,
  protein_pct: formatPercent,
  herd_scope: formatList,
};
const FEED_TEST_CHANGE_FORMATTERS = {
  moisture_pct: formatPercent,
  nfc_pct: formatPercent,
  protein_pct: formatPercent,
  bale_weight_lbs: formatPounds,
};

const LivestockFeedInputsPanel = ({sb}) => {
  const [feeds, setFeeds] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [expanded, setExpanded] = React.useState(true);
  const [categoryFilter, setCategoryFilter] = React.useState('all');
  const [showInactiveFeeds, setShowInactiveFeeds] = React.useState(false);
  const [showForm, setShowForm] = React.useState(false);
  const [editingId, setEditingId] = React.useState(null);
  const [form, setForm] = React.useState(null);
  const [originalForm, setOriginalForm] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const autoSaveTimer = React.useRef(null);
  // Test history state
  const [feedTests, setFeedTests] = React.useState([]);
  const [showTestForm, setShowTestForm] = React.useState(false);
  const [testForm, setTestForm] = React.useState(null);
  const [editingTestId, setEditingTestId] = React.useState(null);
  const [uploadingTest, setUploadingTest] = React.useState(false);
  // Two inline notices: `notice` covers feed save / delete failures
  // (rendered both on the main panel and inside the feed edit form so
  // it is visible on whichever surface fired); `testNotice` covers test
  // upload / save / validation failures and renders inside the test
  // sub-form where the action happened.
  const [notice, setNotice] = React.useState(null);
  const [testNotice, setTestNotice] = React.useState(null);

  const EMPTY_FEED = {
    id: '',
    name: '',
    category: 'hay',
    unit: 'bale',
    unit_weight_lbs: '',
    cost_per_unit: '',
    freight_per_truck: '',
    units_per_truck: '',
    moisture_pct: '',
    nfc_pct: '',
    protein_pct: '',
    status: 'active',
    herd_scope: ['mommas', 'backgrounders', 'finishers', 'bulls'],
    notes: '',
  };
  const CATEGORIES = [
    {v: 'hay', l: 'Hay', color: '#065f46', bg: '#ecfdf5'},
    {v: 'pellet', l: 'Pellet', color: '#92400e', bg: '#fef3c7'},
    {v: 'liquid', l: 'Liquid', color: '#1e40af', bg: '#dbeafe'},
    {v: 'mineral', l: 'Mineral', color: '#6b21a8', bg: '#f3e8ff'},
    {v: 'other', l: 'Other', color: '#374151', bg: '#f3f4f6'},
  ];
  const UNITS = ['bale', 'lb', 'tub', 'bag'];
  const HERD_SCOPE_OPTIONS = [
    {v: 'mommas', l: 'Mommas'},
    {v: 'backgrounders', l: 'Backgrounders'},
    {v: 'finishers', l: 'Finishers'},
    {v: 'bulls', l: 'Bulls'},
    {v: 'rams', l: 'Rams'},
    {v: 'ewes', l: 'Ewes'},
    {v: 'feeders', l: 'Feeders'},
  ];

  async function loadFeeds() {
    const {data, error} = await sb.from('cattle_feed_inputs').select('*').order('category').order('name');
    if (!error && data) setFeeds(data);
    setLoading(false);
  }
  React.useEffect(() => {
    loadFeeds();
  }, []);

  function landedPerLb(f) {
    const cost = parseFloat(f.cost_per_unit) || 0;
    const freight = parseFloat(f.freight_per_truck) || 0;
    const units = parseFloat(f.units_per_truck) || 0;
    const wt = parseFloat(f.unit_weight_lbs) || 0;
    if (wt <= 0) return null;
    if (cost === 0 && freight === 0) return null;
    const perUnit = cost + (units > 0 ? freight / units : 0);
    return perUnit / wt;
  }

  // Best-effort by default (logs to console and swallows). Pass surfaceErrors:true
  // to RE-THROW the failure so a caller can surface a warning to the operator
  // instead of silently losing the audit (used by the test-delete path so a
  // failed record.deleted is visible — see deleteTest).
  async function recordFeedInputActivity({eventType, body, payload, surfaceErrors = false}) {
    try {
      await recordActivityEvent(sb, {
        ...FEED_ACTIVITY_ENTITY,
        eventType,
        body,
        payload,
      });
    } catch (e) {
      console.warn('feed input Activity log failed:', e && e.message ? e.message : e);
      if (surfaceErrors) throw e;
    }
  }

  async function recordFeedInputSavedActivity(previousFeed, nextFeed, {created = false, action = null} = {}) {
    const changes = buildChanges(previousFeed, nextFeed, {
      exclude: ['id'],
      labels: FEED_CHANGE_LABELS,
      formatters: FEED_CHANGE_FORMATTERS,
    });
    if (!created && changes.length === 0) return;
    const feedName = feedLabel(nextFeed || previousFeed);
    const feedAction = action || (created ? 'created' : 'updated');
    await recordFeedInputActivity({
      eventType: created ? 'record.created' : 'field.updated',
      body: created
        ? 'Feed input ' + feedName + ' added'
        : 'Feed input ' + feedName + ' updated: ' + countSummary(changes, 'field'),
      payload: {
        feed_input_action: feedAction,
        feed_input_id: (nextFeed && nextFeed.id) || (previousFeed && previousFeed.id),
        feed_name: feedName,
        changes,
      },
    });
  }

  // Retained for any FUTURE non-RPC feed-input delete path. The permanent-delete
  // path (deleteFeedPermanently) now routes through delete_feed_input (mig 108),
  // which writes the record.deleted Activity in the same transaction, so this
  // best-effort client helper is no longer called there.
  // eslint-disable-next-line no-unused-vars -- kept for non-RPC delete paths (mig 108)
  async function recordFeedInputDeletedActivity(feed) {
    if (!feed) return;
    await recordFeedInputActivity({
      eventType: 'record.deleted',
      body: 'Feed input ' + feedLabel(feed) + ' deleted',
      payload: {
        feed_input_action: 'deleted',
        feed_input_id: feed.id,
        feed_name: feedLabel(feed),
      },
    });
  }

  async function recordFeedTestSavedActivity(feed, previousTest, nextTest, {created = false} = {}) {
    const changes = buildChanges(previousTest, nextTest, {
      exclude: ['id', 'feed_input_id', 'pdf_path'],
      labels: FEED_TEST_CHANGE_LABELS,
      formatters: FEED_TEST_CHANGE_FORMATTERS,
    });
    if (!created && changes.length === 0) return;
    const feedName = feedLabel(feed);
    const dateLabel = nextTest.effective_date || 'unknown date';
    await recordFeedInputActivity({
      eventType: created ? 'record.created' : 'field.updated',
      body: created
        ? 'Feed test for ' + feedName + ' added (' + dateLabel + ')'
        : 'Feed test for ' + feedName + ' updated (' + dateLabel + '): ' + countSummary(changes, 'field'),
      payload: {
        feed_test_action: created ? 'created' : 'updated',
        feed_input_id: nextTest.feed_input_id,
        feed_name: feedName,
        feed_test_id: nextTest.id,
        effective_date: nextTest.effective_date || null,
        changes,
      },
    });
  }

  async function recordFeedTestDeletedActivity(feed, test) {
    if (!test) return;
    const feedName = feedLabel(feed);
    await recordFeedInputActivity({
      eventType: 'record.deleted',
      body: 'Feed test for ' + feedName + ' deleted (' + (test.effective_date || 'unknown date') + ')',
      payload: {
        feed_test_action: 'deleted',
        feed_input_id: test.feed_input_id || (feed && feed.id),
        feed_name: feedName,
        feed_test_id: test.id,
        effective_date: test.effective_date || null,
      },
      // Surface a failed test-delete audit to the caller (deleteTest) so it can
      // warn the operator rather than silently losing the record.deleted event.
      surfaceErrors: true,
    });
  }

  function openAdd() {
    setNotice(null);
    setForm({...EMPTY_FEED});
    setOriginalForm({...EMPTY_FEED});
    setEditingId(null);
    setShowForm(true);
  }
  function openEdit(feed) {
    setNotice(null);
    const f = {
      ...EMPTY_FEED,
      ...feed,
      unit_weight_lbs: feed.unit_weight_lbs != null ? String(feed.unit_weight_lbs) : '',
      cost_per_unit: feed.cost_per_unit != null ? String(feed.cost_per_unit) : '',
      freight_per_truck: feed.freight_per_truck != null ? String(feed.freight_per_truck) : '',
      units_per_truck: feed.units_per_truck != null ? String(feed.units_per_truck) : '',
      moisture_pct: feed.moisture_pct != null ? String(feed.moisture_pct) : '',
      nfc_pct: feed.nfc_pct != null ? String(feed.nfc_pct) : '',
      protein_pct: feed.protein_pct != null ? String(feed.protein_pct) : '',
      herd_scope: feed.herd_scope || [],
      notes: feed.notes || '',
    };
    setForm(f);
    setOriginalForm({...f});
    setEditingId(feed.id);
    setShowForm(true);
    loadTests(feed.id);
  }

  async function loadTests(feedId) {
    if (!feedId) {
      setFeedTests([]);
      return;
    }
    const {data} = await sb
      .from('cattle_feed_tests')
      .select('*')
      .eq('feed_input_id', feedId)
      .order('effective_date', {ascending: false});
    setFeedTests(data || []);
  }
  function openTestForm() {
    setTestNotice(null);
    const today = new Date().toISOString().slice(0, 10);
    setTestForm({
      effective_date: today,
      moisture_pct: '',
      nfc_pct: '',
      protein_pct: '',
      bale_weight_lbs: '',
      notes: '',
      file: null,
    });
    setEditingTestId(null);
    setShowTestForm(true);
  }
  function openEditTest(t) {
    setTestNotice(null);
    setTestForm({
      effective_date: t.effective_date || '',
      moisture_pct: t.moisture_pct != null ? String(t.moisture_pct) : '',
      nfc_pct: t.nfc_pct != null ? String(t.nfc_pct) : '',
      protein_pct: t.protein_pct != null ? String(t.protein_pct) : '',
      bale_weight_lbs: t.bale_weight_lbs != null ? String(t.bale_weight_lbs) : '',
      notes: t.notes || '',
      file: null,
      existingPdfPath: t.pdf_path || null,
      existingPdfName: t.pdf_file_name || null,
    });
    setEditingTestId(t.id);
    setShowTestForm(true);
  }
  // Open the edit modal AND the upload form in one click (used by the card's quick "Upload Test" button)
  function openUploadForFeed(feed) {
    openEdit(feed);
    setTestNotice(null);
    const today = new Date().toISOString().slice(0, 10);
    setTestForm({
      effective_date: today,
      moisture_pct: '',
      nfc_pct: '',
      protein_pct: '',
      bale_weight_lbs: '',
      notes: '',
      file: null,
    });
    setEditingTestId(null);
    setShowTestForm(true);
  }
  async function saveTest() {
    if (!testForm || !editingId) return;
    setTestNotice(null);
    if (!testForm.effective_date) {
      setTestNotice({kind: 'error', message: 'Effective date is required.'});
      return;
    }
    setUploadingTest(true);
    let pdfPath = testForm.existingPdfPath || null;
    let pdfFileName = testForm.existingPdfName || null;
    // If a new file was provided, upload it (and if editing, remove the old one after successful upload)
    if (testForm.file) {
      const file = testForm.file;
      if (file.size > 20 * 1024 * 1024) {
        setTestNotice({kind: 'error', message: 'PDF exceeds 20 MB limit.'});
        setUploadingTest(false);
        return;
      }
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = editingId + '/' + Date.now() + '-' + safeName;
      const {error: upErr} = await sb.storage
        .from('cattle-feed-pdfs')
        .upload(path, file, {cacheControl: '3600', upsert: false});
      if (upErr) {
        setTestNotice({kind: 'error', message: 'Upload failed: ' + upErr.message});
        setUploadingTest(false);
        return;
      }
      // Remove the old PDF if this is an edit and there was a previous file
      if (editingTestId && testForm.existingPdfPath) {
        try {
          await sb.storage.from('cattle-feed-pdfs').remove([testForm.existingPdfPath]);
        } catch (_e) {
          /* best-effort storage cleanup */
        }
      }
      pdfPath = path;
      pdfFileName = file.name;
    }
    const payload = {
      effective_date: testForm.effective_date,
      moisture_pct: testForm.moisture_pct !== '' ? parseFloat(testForm.moisture_pct) : null,
      nfc_pct: testForm.nfc_pct !== '' ? parseFloat(testForm.nfc_pct) : null,
      protein_pct: testForm.protein_pct !== '' ? parseFloat(testForm.protein_pct) : null,
      bale_weight_lbs: testForm.bale_weight_lbs !== '' ? parseFloat(testForm.bale_weight_lbs) : null,
      pdf_path: pdfPath,
      pdf_file_name: pdfFileName,
      notes: testForm.notes || null,
    };
    const currentFeed =
      feeds.find((f) => f.id === editingId) ||
      (form ? buildFeedRecord(form, editingId) : {id: editingId, name: editingId});
    const previousTest = editingTestId ? feedTests.find((t) => t.id === editingTestId) : null;
    let rec;
    if (editingTestId) {
      const {error} = await sb.from('cattle_feed_tests').update(payload).eq('id', editingTestId);
      if (error) {
        setTestNotice({kind: 'error', message: 'Could not save test: ' + error.message});
        setUploadingTest(false);
        return;
      }
      rec = {...payload, id: editingTestId, feed_input_id: editingId};
    } else {
      const testId = String(Date.now()) + Math.random().toString(36).slice(2, 6);
      rec = {id: testId, feed_input_id: editingId, ...payload};
      const {error} = await sb.from('cattle_feed_tests').insert(rec);
      if (error) {
        setTestNotice({kind: 'error', message: 'Could not save test: ' + error.message});
        setUploadingTest(false);
        return;
      }
    }
    await recordFeedTestSavedActivity(currentFeed, previousTest, rec, {created: !editingTestId});
    // Re-sync parent feed's nutrition values if the freshly saved test is now the most recent
    const others = feedTests.filter((t) => t.id !== rec.id);
    const all = [rec, ...others].sort((a, b) => (b.effective_date || '').localeCompare(a.effective_date || ''));
    if (all[0].id === rec.id) {
      const feedUpdate = {};
      if (rec.moisture_pct != null) feedUpdate.moisture_pct = rec.moisture_pct;
      if (rec.nfc_pct != null) feedUpdate.nfc_pct = rec.nfc_pct;
      if (rec.protein_pct != null) feedUpdate.protein_pct = rec.protein_pct;
      if (rec.bale_weight_lbs != null) feedUpdate.unit_weight_lbs = rec.bale_weight_lbs;
      if (Object.keys(feedUpdate).length > 0) {
        const {error: feedUpdateError} = await sb.from('cattle_feed_inputs').update(feedUpdate).eq('id', editingId);
        if (!feedUpdateError) {
          await recordFeedInputSavedActivity(
            currentFeed,
            {...currentFeed, ...feedUpdate},
            {action: 'synced_from_feed_test'},
          );
          const refreshed = {...form};
          if (rec.moisture_pct != null) refreshed.moisture_pct = String(rec.moisture_pct);
          if (rec.nfc_pct != null) refreshed.nfc_pct = String(rec.nfc_pct);
          if (rec.protein_pct != null) refreshed.protein_pct = String(rec.protein_pct);
          if (rec.bale_weight_lbs != null) refreshed.unit_weight_lbs = String(rec.bale_weight_lbs);
          setForm(refreshed);
          setOriginalForm(refreshed);
        } else {
          console.warn('feed nutrition sync failed:', feedUpdateError.message || feedUpdateError);
        }
      }
    }
    await loadTests(editingId);
    await loadFeeds();
    setShowTestForm(false);
    setTestForm(null);
    setEditingTestId(null);
    setUploadingTest(false);
  }
  async function deleteTest(testId, pdfPath) {
    if (!window._wcfConfirmDelete) return;
    window._wcfConfirmDelete('Delete this test result? PDF will also be removed. This cannot be undone.', async () => {
      setTestNotice(null);
      const currentFeed =
        feeds.find((f) => f.id === editingId) ||
        (form ? buildFeedRecord(form, editingId) : {id: editingId, name: editingId});
      const test = feedTests.find((t) => t.id === testId);
      // Delete the DB row FIRST so a failed delete never orphan-removes the PDF.
      const {error} = await sb.from('cattle_feed_tests').delete().eq('id', testId);
      if (error) {
        setTestNotice({kind: 'error', message: 'Could not delete test: ' + error.message});
        return;
      }
      // Row gone: surface (don't silently swallow) a record.deleted Activity
      // failure as a warning so the operator knows the audit didn't land, while
      // still proceeding with the (already-successful) row delete + PDF cleanup.
      try {
        await recordFeedTestDeletedActivity(currentFeed, test);
      } catch (e) {
        setTestNotice({
          kind: 'warning',
          message: 'Test deleted, but the activity log entry failed to record: ' + (e && e.message ? e.message : e),
        });
      }
      // Best-effort storage cleanup AFTER the row delete succeeds.
      if (pdfPath) {
        try {
          await sb.storage.from('cattle-feed-pdfs').remove([pdfPath]);
        } catch (_e) {
          /* best-effort storage cleanup */
        }
      }
      await loadTests(editingId);
    });
  }
  // Permanent delete of the feed itself — cascades to tests and PDFs.
  // Historical cattle_dailys snapshots remain intact (jsonb values, not FK).
  //
  // Routed through the transactional SECDEF RPC delete_feed_input (migration
  // 108): the RPC deletes the cattle_feed_inputs root, cascades the child
  // cattle_feed_tests via the feed_input_id ON DELETE CASCADE FK, and writes the
  // ONE record.deleted Activity event in the same transaction — so the audit is
  // guaranteed and we no longer call the best-effort client
  // recordFeedInputDeletedActivity here. The storage PDF bulk-removal stays a
  // best-effort client step AFTER the RPC succeeds, so a failed/blocked delete
  // never orphan-removes the children's PDFs.
  async function deleteFeedPermanently(id) {
    if (!window._wcfConfirmDelete) return;
    window._wcfConfirmDelete(
      'Permanently delete this feed? All historical test results and PDFs will be removed. Daily reports already submitted keep their snapshot values. This cannot be undone.',
      async () => {
        setNotice(null);
        // Collect the children's PDF paths BEFORE the delete so we can sweep
        // storage after the RPC removes the rows (the RPC + cascade clear the DB
        // rows; the PDFs live in storage and are cleaned up best-effort here).
        const {data: tests} = await sb.from('cattle_feed_tests').select('pdf_path').eq('feed_input_id', id);
        const pdfPaths = (tests || []).map((t) => t.pdf_path).filter(Boolean);
        const result = await deleteFeedInput(sb, id);
        if (!result || !result.ok) {
          const reason = result && result.reason ? result.reason : 'unknown';
          const detail = result && result.error ? ': ' + result.error : ' (' + reason + ')';
          setNotice({kind: 'error', message: 'Could not delete' + detail});
          return;
        }
        // RPC succeeded (root + tests gone, Activity logged in-txn). Sweep the
        // children's PDFs best-effort.
        if (pdfPaths.length > 0) {
          try {
            await sb.storage.from('cattle-feed-pdfs').remove(pdfPaths);
          } catch (_e) {
            /* best-effort storage cleanup */
          }
        }
        await loadFeeds();
        cancelForm();
      },
    );
  }

  function upd(k, v) {
    const next = {...form, [k]: v};
    setForm(next);
    if (editingId) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = setTimeout(() => saveFeed(next, editingId), 1500);
    }
  }
  function toggleHerdScope(herd) {
    const scope = form.herd_scope || [];
    const next = scope.includes(herd) ? scope.filter((h) => h !== herd) : [...scope, herd];
    upd('herd_scope', next);
  }

  async function saveFeed(feedData, id, {recordActivity = false, previousFeed = null} = {}) {
    setNotice(null);
    setSaving(true);
    const rec = buildFeedRecord(feedData, id);
    if (!id) {
      if (!rec.name) {
        setSaving(false);
        setNotice({kind: 'error', message: 'Feed name is required.'});
        return null;
      }
      rec.id = rec.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      if (!rec.id) {
        setSaving(false);
        setNotice({kind: 'error', message: 'Feed name must contain letters or numbers.'});
        return null;
      }
    }
    const {error} = await sb.from('cattle_feed_inputs').upsert(rec, {onConflict: 'id'});
    if (error) {
      setSaving(false);
      setNotice({kind: 'error', message: 'Could not save: ' + error.message});
      return null;
    }
    setSaving(false);
    if (recordActivity) {
      await recordFeedInputSavedActivity(previousFeed || null, rec, {created: !id});
    }
    await loadFeeds();
    if (!id) setEditingId(rec.id);
    return rec.id;
  }

  async function closeForm() {
    clearTimeout(autoSaveTimer.current);
    setNotice(null);
    setTestNotice(null);
    if (editingId && form && originalForm) {
      const changed = JSON.stringify(form) !== JSON.stringify(originalForm);
      if (changed) {
        await saveFeed(form, editingId, {
          recordActivity: true,
          previousFeed: buildFeedRecord(originalForm, editingId),
        });
      }
    } else if (!editingId && form && form.name && form.name.trim()) {
      await saveFeed(form, null, {recordActivity: true});
    }
    setShowForm(false);
    setEditingId(null);
    setForm(null);
    setOriginalForm(null);
  }
  function cancelForm() {
    clearTimeout(autoSaveTimer.current);
    setNotice(null);
    setTestNotice(null);
    setShowForm(false);
    setEditingId(null);
    setForm(null);
    setOriginalForm(null);
  }
  // (old Mark Inactive helper removed — replaced by deleteFeedPermanently below)

  const filteredFeeds = categoryFilter === 'all' ? feeds : feeds.filter((f) => f.category === categoryFilter);
  const activeFeeds = filteredFeeds.filter((f) => f.status !== 'inactive');
  const inactiveFeeds = filteredFeeds.filter((f) => f.status === 'inactive');
  const catMeta = (c) => CATEGORIES.find((x) => x.v === c) || CATEGORIES[4];

  const inpS = {
    fontSize: 13,
    padding: '7px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 6,
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  };
  const lbl = {fontSize: 11, color: 'var(--ink-muted)', display: 'block', marginBottom: 3, fontWeight: 500};

  function renderFeedTable(rows, section) {
    return (
      <div
        data-feed-inputs-table={section}
        style={{border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden'}}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: FEED_GRID_COLUMNS,
            gap: 0,
            background: 'var(--surface-2)',
            borderBottom: '1px solid var(--border)',
            padding: '6px 10px',
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--ink-muted)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          <span>Name</span>
          <span>Category</span>
          <span style={{textAlign: 'right'}}>Unit / wt</span>
          <span style={{textAlign: 'right'}}>DM</span>
          <span style={{textAlign: 'right'}}>Moist</span>
          <span style={{textAlign: 'right'}}>P% / NFC%</span>
          <span style={{textAlign: 'right'}}>Landed $/lb</span>
          <span style={{textAlign: 'right'}}>Actions</span>
        </div>
        {rows.map((f, i) => {
          const cat = catMeta(f.category);
          const lpl = landedPerLb(f);
          const inactive = f.status === 'inactive';
          const wt = parseFloat(f.unit_weight_lbs);
          const mp = parseFloat(f.moisture_pct);
          const dm =
            Number.isFinite(wt) && wt > 0 && Number.isFinite(mp) && mp >= 0 && mp < 100 ? wt * (1 - mp / 100) : null;
          return (
            <div
              key={f.id}
              data-feed-input-row={f.id}
              data-feed-input-status={inactive ? 'inactive' : 'active'}
              {...openableProps(() => openEdit(f))}
              style={{
                display: 'grid',
                gridTemplateColumns: FEED_GRID_COLUMNS,
                gap: 0,
                padding: '8px 10px',
                fontSize: 12,
                alignItems: 'center',
                borderBottom: i < rows.length - 1 ? '1px solid var(--divider)' : 'none',
                cursor: 'pointer',
                background: i % 2 ? '#fafafa' : 'white',
                opacity: inactive ? 0.55 : 1,
              }}
              className="hoverable-tile"
            >
              <span
                style={{
                  fontWeight: 700,
                  color: 'var(--ink)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {f.name}
                {inactive && (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      padding: '1px 5px',
                      borderRadius: 3,
                      background: '#fef2f2',
                      color: '#b91c1c',
                      fontWeight: 700,
                    }}
                  >
                    INACTIVE
                  </span>
                )}
              </span>
              <span
                style={{
                  fontSize: 10,
                  padding: '1px 6px',
                  borderRadius: 3,
                  background: cat.bg,
                  color: cat.color,
                  fontWeight: 700,
                  textAlign: 'center',
                  textTransform: 'uppercase',
                  justifySelf: 'start',
                }}
              >
                {cat.l}
              </span>
              <span style={{textAlign: 'right', color: 'var(--ink)'}}>
                {f.unit}
                {f.unit_weight_lbs ? ' \u00b7 ' + f.unit_weight_lbs + ' lb' : ''}
              </span>
              <span
                style={{
                  textAlign: 'right',
                  color: dm != null ? '#065f46' : 'var(--ink-faint)',
                  fontWeight: dm != null ? 600 : 400,
                }}
              >
                {dm != null ? Math.round(dm * 10) / 10 + ' lb' : '\u2014'}
              </span>
              <span style={{textAlign: 'right', color: 'var(--ink-muted)'}}>
                {f.moisture_pct != null ? f.moisture_pct + '%' : '\u2014'}
              </span>
              <span style={{textAlign: 'right', color: 'var(--ink-muted)'}}>
                {f.protein_pct != null || f.nfc_pct != null
                  ? (f.protein_pct ?? '\u2014') + '/' + (f.nfc_pct ?? '\u2014')
                  : '\u2014'}
              </span>
              <span
                style={{textAlign: 'right', color: lpl ? '#065f46' : 'var(--ink-faint)', fontWeight: lpl ? 600 : 400}}
              >
                {lpl != null ? '$' + lpl.toFixed(3) : '\u2014'}
              </span>
              <span style={{display: 'flex', gap: 4, justifyContent: 'flex-end'}}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openUploadForFeed(f);
                  }}
                  style={{
                    padding: '3px 8px',
                    borderRadius: 5,
                    border: '1px solid #085041',
                    background: 'white',
                    color: '#085041',
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {'\ud83d\udcce'}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openEdit(f);
                  }}
                  style={{
                    padding: '3px 8px',
                    borderRadius: 5,
                    border: '1px solid var(--border-strong)',
                    background: 'white',
                    color: 'var(--ink-muted)',
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Edit
                </button>
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{marginTop: 16}}>
      <div style={{background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '20px'}}>
        <div
          {...openableProps(() => setExpanded(!expanded))}
          className="hoverable-tile"
          style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', gap: 10}}
        >
          <div style={{display: 'flex', alignItems: 'center', gap: 8, flex: 1}}>
            <span style={{fontSize: 12, color: 'var(--ink-muted)'}}>{expanded ? '\u25bc' : '\u25b6'}</span>
            <div>
              <div style={{fontSize: 15, fontWeight: 700, color: 'var(--ink)'}}>
                {'Cattle & Sheep Inputs '}
                <span style={{fontSize: 12, fontWeight: 400, color: 'var(--ink-muted)'}}>
                  {'(' + feeds.length + ')'}
                </span>
              </div>
              {!expanded && (
                <div style={{fontSize: 11, color: 'var(--ink-faint)', marginTop: 2}}>
                  Click to expand the master feed list.
                </div>
              )}
            </div>
          </div>
          {expanded && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                openAdd();
              }}
              style={{
                padding: '7px 16px',
                borderRadius: 7,
                border: 'none',
                background: '#085041',
                color: 'white',
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
              }}
            >
              + Add Feed
            </button>
          )}
        </div>

        {expanded && (
          <>
            <div style={{fontSize: 12, color: 'var(--ink-muted)', marginTop: 8}}>
              Master list of every cattle and sheep hay, pellet, liquid, mineral, and supplement used on-farm. Nutrition
              values are snapshotted onto daily reports at submit time {'\u2014'} editing an input here doesn{'\u2019'}t
              rewrite historical reports.
            </div>
            {!showForm && (
              <div style={{marginTop: 10}}>
                <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
              </div>
            )}
            <div style={{height: 1, background: 'var(--border)', margin: '14px 0'}} />

            {/* Filter chips */}
            <div style={{display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap'}}>
              {[{v: 'all', l: 'All'}, ...CATEGORIES].map((c) => {
                const active = categoryFilter === c.v;
                const count = c.v === 'all' ? feeds.length : feeds.filter((f) => f.category === c.v).length;
                return (
                  <button
                    key={c.v}
                    onClick={() => setCategoryFilter(c.v)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 14,
                      border: '1px solid ' + (active ? 'var(--brand)' : 'var(--border-strong)'),
                      background: 'white',
                      color: active ? 'var(--brand)' : 'var(--ink-muted)',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {c.l} {count > 0 && <span style={{opacity: 0.7, marginLeft: 4}}>({count})</span>}
                  </button>
                );
              })}
            </div>

            {loading && (
              <div style={{textAlign: 'center', padding: '1.5rem', color: 'var(--ink-faint)', fontSize: 13}}>
                Loading feeds{'\u2026'}
              </div>
            )}
            {!loading && filteredFeeds.length === 0 && (
              <div style={{textAlign: 'center', padding: '1.5rem', color: 'var(--ink-faint)', fontSize: 13}}>
                No feeds in this category.
              </div>
            )}

            {/* Active feeds stay visible; inactive feeds stay tucked away until needed. */}
            {!loading && filteredFeeds.length > 0 && (
              <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
                <div data-feed-inputs-section="active">
                  <div style={{fontSize: 12, fontWeight: 700, color: '#065f46', marginBottom: 6}}>
                    Active feeds ({activeFeeds.length})
                  </div>
                  {activeFeeds.length > 0 ? (
                    renderFeedTable(activeFeeds, 'active')
                  ) : (
                    <div
                      data-feed-inputs-empty-active="1"
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        padding: '12px',
                        fontSize: 12,
                        color: 'var(--ink-faint)',
                      }}
                    >
                      No active feeds in this category.
                    </div>
                  )}
                </div>

                {inactiveFeeds.length > 0 && (
                  <div data-feed-inputs-section="inactive">
                    <button
                      type="button"
                      data-feed-inputs-inactive-toggle="1"
                      data-feed-inputs-inactive-state={showInactiveFeeds ? 'expanded' : 'collapsed'}
                      onClick={() => setShowInactiveFeeds((v) => !v)}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '9px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                        background: 'var(--surface-2)',
                        color: 'var(--ink)',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        fontSize: 12,
                        fontWeight: 700,
                        textAlign: 'left',
                      }}
                    >
                      <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>
                        {showInactiveFeeds ? '\u25bc' : '\u25b6'}
                      </span>
                      <span>Inactive feeds ({inactiveFeeds.length})</span>
                    </button>
                    {showInactiveFeeds && (
                      <div style={{marginTop: 8}}>{renderFeedTable(inactiveFeeds, 'inactive')}</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Add/Edit modal */}
      {showForm && form && (
        <div
          onClick={closeForm}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,.45)',
            zIndex: 500,
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
              borderRadius: 12,
              width: '100%',
              maxWidth: 560,
              boxShadow: '0 8px 32px rgba(0,0,0,.2)',
              marginTop: 40,
            }}
          >
            <div
              style={{
                padding: '14px 20px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div style={{fontSize: 15, fontWeight: 600, color: '#085041'}}>
                {editingId ? 'Edit Feed' : 'New Feed'}
                {editingId && (
                  <span style={{fontSize: 11, fontWeight: 400, color: 'var(--ink-faint)', marginLeft: 8}}>
                    Auto-saves as you type
                  </span>
                )}
              </div>
              <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                {saving && <span style={{fontSize: 11, color: 'var(--ink-faint)'}}>{'Saving\u2026'}</span>}
                <button
                  onClick={cancelForm}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: 22,
                    cursor: 'pointer',
                    color: 'var(--ink-faint)',
                  }}
                >
                  {'\u00d7'}
                </button>
              </div>
            </div>
            <div
              style={{
                padding: '16px 20px',
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 10,
                maxHeight: '70vh',
                overflowY: 'auto',
              }}
            >
              <div style={{gridColumn: '1/-1'}}>
                <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
              </div>
              {/* Identity */}
              <div style={{gridColumn: '1/-1'}}>
                <label style={lbl}>Name *</label>
                <input
                  value={form.name}
                  onChange={(e) => upd('name', e.target.value)}
                  placeholder="e.g. Rye Baleage"
                  style={inpS}
                />
                {!editingId && form.name && (
                  <div style={{fontSize: 10, color: 'var(--ink-faint)', marginTop: 2}}>
                    ID:{' '}
                    {form.name
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-|-$/g, '')}
                  </div>
                )}
              </div>
              <div>
                <label style={lbl}>Category *</label>
                <select value={form.category} onChange={(e) => upd('category', e.target.value)} style={inpS}>
                  {CATEGORIES.map((c) => (
                    <option key={c.v} value={c.v}>
                      {c.l}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={lbl}>Unit *</label>
                <select value={form.unit} onChange={(e) => upd('unit', e.target.value)} style={inpS}>
                  {UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={lbl}>Unit weight (lbs, as-fed)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.unit_weight_lbs}
                  onChange={(e) => upd('unit_weight_lbs', e.target.value)}
                  placeholder="e.g. 1500 for a hay bale"
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>DM per unit (computed)</label>
                {(() => {
                  const wt = parseFloat(form.unit_weight_lbs);
                  const mp = parseFloat(form.moisture_pct);
                  const dm =
                    Number.isFinite(wt) && wt > 0 && Number.isFinite(mp) && mp >= 0 && mp < 100
                      ? wt * (1 - mp / 100)
                      : null;
                  return (
                    <div
                      style={{
                        padding: '7px 10px',
                        background: 'var(--surface-2)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        fontSize: 13,
                        fontWeight: 700,
                        color: dm != null ? '#065f46' : 'var(--ink-faint)',
                      }}
                    >
                      {dm != null ? Math.round(dm * 10) / 10 + ' lbs DM' : '\u2014'}
                    </div>
                  );
                })()}
              </div>

              {/* Cost section */}
              <div style={{gridColumn: '1/-1', borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4}}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: 'var(--ink-muted)',
                    letterSpacing: 0.5,
                    marginBottom: 8,
                  }}
                >
                  {'\ud83d\udcb0 LANDED COST'}
                </div>
              </div>
              <div>
                <label style={lbl}>Cost per unit ($)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.cost_per_unit}
                  onChange={(e) => upd('cost_per_unit', e.target.value)}
                  placeholder="0.00"
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Freight per truck ($)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.freight_per_truck}
                  onChange={(e) => upd('freight_per_truck', e.target.value)}
                  placeholder="0.00"
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Units per truck</label>
                <input
                  type="number"
                  min="0"
                  value={form.units_per_truck}
                  onChange={(e) => upd('units_per_truck', e.target.value)}
                  placeholder="e.g. 3"
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Landed $/lb (computed)</label>
                <div
                  style={{
                    padding: '7px 10px',
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    fontSize: 13,
                    fontWeight: 700,
                    color: landedPerLb(form) ? '#065f46' : 'var(--ink-faint)',
                  }}
                >
                  {landedPerLb(form) != null ? '$' + landedPerLb(form).toFixed(4) + ' / lb' : '\u2014'}
                </div>
              </div>

              {/* Nutrition */}
              <div style={{gridColumn: '1/-1', borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4}}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: 'var(--ink-muted)',
                    letterSpacing: 0.5,
                    marginBottom: 4,
                  }}
                >
                  {'\ud83e\uddea NUTRITION'}{' '}
                  <span style={{fontWeight: 400, color: 'var(--ink-faint)'}}>
                    (manual entry for now; test PDF upload in next build step)
                  </span>
                </div>
              </div>
              <div>
                <label style={lbl}>Moisture %</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={form.moisture_pct}
                  onChange={(e) => upd('moisture_pct', e.target.value)}
                  placeholder="0.0"
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>NFC % DM</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={form.nfc_pct}
                  onChange={(e) => upd('nfc_pct', e.target.value)}
                  placeholder="0.0"
                  style={inpS}
                />
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={lbl}>Crude Protein % DM</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={form.protein_pct}
                  onChange={(e) => upd('protein_pct', e.target.value)}
                  placeholder="0.0"
                  style={inpS}
                />
              </div>

              {/* Test history — only for existing feeds */}
              {editingId && (
                <div style={{gridColumn: '1/-1', borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4}}>
                  <div
                    style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8}}
                  >
                    <div style={{fontSize: 11, fontWeight: 700, color: 'var(--ink-muted)', letterSpacing: 0.5}}>
                      {'\ud83d\udcc4 TEST RESULTS'}{' '}
                      <span style={{fontWeight: 400, color: 'var(--ink-faint)'}}>({feedTests.length} on file)</span>
                    </div>
                    {!showTestForm && (
                      <button
                        type="button"
                        onClick={openTestForm}
                        style={{
                          padding: '4px 10px',
                          borderRadius: 6,
                          border: '1px solid #085041',
                          background: 'white',
                          color: '#085041',
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        + Upload New Test
                      </button>
                    )}
                  </div>

                  {showTestForm && testForm && (
                    <div
                      style={{
                        background: '#f0f7ff',
                        border: '1px solid #bfdbfe',
                        borderRadius: 8,
                        padding: '12px 14px',
                        marginBottom: 10,
                      }}
                    >
                      <div style={{fontSize: 12, fontWeight: 600, color: '#1e40af', marginBottom: 8}}>
                        {editingTestId ? 'Edit Test Result' : 'New Test Result'}
                      </div>
                      <InlineNotice notice={testNotice} onDismiss={() => setTestNotice(null)} />
                      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8}}>
                        <div>
                          <label style={lbl}>Effective Date *</label>
                          <input
                            type="date"
                            value={testForm.effective_date}
                            onChange={(e) => setTestForm({...testForm, effective_date: e.target.value})}
                            style={inpS}
                          />
                        </div>
                        <div>
                          <label style={lbl}>Bale weight (lbs)</label>
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={testForm.bale_weight_lbs}
                            onChange={(e) => setTestForm({...testForm, bale_weight_lbs: e.target.value})}
                            placeholder="hay only"
                            style={inpS}
                          />
                        </div>
                        <div>
                          <label style={lbl}>Moisture %</label>
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="0.1"
                            value={testForm.moisture_pct}
                            onChange={(e) => setTestForm({...testForm, moisture_pct: e.target.value})}
                            style={inpS}
                          />
                        </div>
                        <div>
                          <label style={lbl}>NFC % DM</label>
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="0.1"
                            value={testForm.nfc_pct}
                            onChange={(e) => setTestForm({...testForm, nfc_pct: e.target.value})}
                            style={inpS}
                          />
                        </div>
                        <div style={{gridColumn: '1/-1'}}>
                          <label style={lbl}>Crude Protein % DM</label>
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="0.1"
                            value={testForm.protein_pct}
                            onChange={(e) => setTestForm({...testForm, protein_pct: e.target.value})}
                            style={inpS}
                          />
                        </div>
                        <div style={{gridColumn: '1/-1'}}>
                          <label style={lbl}>
                            PDF{' '}
                            {editingTestId && testForm.existingPdfName
                              ? '(leave blank to keep current)'
                              : '(optional, max 20 MB)'}
                          </label>
                          {editingTestId && testForm.existingPdfName && (
                            <div style={{fontSize: 11, color: '#065f46', marginBottom: 4}}>
                              Current: {testForm.existingPdfName}
                            </div>
                          )}
                          <input
                            type="file"
                            accept=".pdf"
                            onChange={(e) =>
                              setTestForm({...testForm, file: (e.target.files && e.target.files[0]) || null})
                            }
                            style={{fontSize: 12, fontFamily: 'inherit'}}
                          />
                        </div>
                        <div style={{gridColumn: '1/-1'}}>
                          <label style={lbl}>Notes</label>
                          <input
                            type="text"
                            value={testForm.notes}
                            onChange={(e) => setTestForm({...testForm, notes: e.target.value})}
                            placeholder="Optional"
                            style={inpS}
                          />
                        </div>
                      </div>
                      <div style={{display: 'flex', gap: 6}}>
                        <button
                          type="button"
                          onClick={saveTest}
                          disabled={uploadingTest}
                          style={{
                            padding: '6px 14px',
                            borderRadius: 6,
                            border: 'none',
                            background: '#085041',
                            color: 'white',
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: uploadingTest ? 'not-allowed' : 'pointer',
                            opacity: uploadingTest ? 0.6 : 1,
                            fontFamily: 'inherit',
                          }}
                        >
                          {uploadingTest ? (editingTestId ? 'Saving\u2026' : 'Uploading\u2026') : 'Save Test'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setTestNotice(null);
                            setShowTestForm(false);
                            setTestForm(null);
                            setEditingTestId(null);
                          }}
                          style={{
                            padding: '6px 12px',
                            borderRadius: 6,
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
                      </div>
                    </div>
                  )}

                  {feedTests.length === 0 && !showTestForm && (
                    <div style={{fontSize: 12, color: 'var(--ink-faint)', fontStyle: 'italic', padding: '4px 0'}}>
                      No test results on file.
                    </div>
                  )}
                  {feedTests.map((t) => {
                    const pdfUrl = t.pdf_path
                      ? sb.storage.from('cattle-feed-pdfs').getPublicUrl(t.pdf_path).data.publicUrl
                      : null;
                    const isLatest = feedTests.length > 0 && feedTests[0].id === t.id;
                    return (
                      <div
                        key={t.id}
                        style={{
                          background: isLatest ? '#ecfdf5' : 'var(--surface-2)',
                          border: '1px solid ' + (isLatest ? '#a7f3d0' : 'var(--border)'),
                          borderRadius: 8,
                          padding: '8px 12px',
                          marginBottom: 6,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{fontSize: 11, fontWeight: 700, color: 'var(--ink)', minWidth: 100}}>
                          {t.effective_date || 'Unknown date'}
                        </span>
                        {isLatest && (
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 700,
                              color: '#065f46',
                              background: '#d1fae5',
                              padding: '1px 6px',
                              borderRadius: 4,
                              letterSpacing: 0.4,
                            }}
                          >
                            CURRENT
                          </span>
                        )}
                        {t.moisture_pct != null && (
                          <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>Moist {t.moisture_pct}%</span>
                        )}
                        {t.nfc_pct != null && (
                          <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>NFC {t.nfc_pct}% DM</span>
                        )}
                        {t.protein_pct != null && (
                          <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>CP {t.protein_pct}% DM</span>
                        )}
                        {t.bale_weight_lbs != null && (
                          <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>Bale {t.bale_weight_lbs} lb</span>
                        )}
                        {pdfUrl && (
                          <a
                            href={pdfUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{fontSize: 11, color: 'var(--brand)', fontWeight: 600, textDecoration: 'none'}}
                          >
                            View PDF
                          </a>
                        )}
                        <div style={{marginLeft: 'auto', display: 'flex', gap: 10}}>
                          <button
                            type="button"
                            onClick={() => openEditTest(t)}
                            style={{
                              fontSize: 11,
                              color: 'var(--brand)',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteTest(t.id, t.pdf_path)}
                            style={{
                              fontSize: 11,
                              color: '#b91c1c',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
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
              )}

              {/* Herd scope */}
              <div style={{gridColumn: '1/-1', borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4}}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: 'var(--ink-muted)',
                    letterSpacing: 0.5,
                    marginBottom: 8,
                  }}
                >
                  {renderCattleIconLabel('HERD / FLOCK SCOPE', {size: 16})}{' '}
                  <span style={{fontWeight: 400, color: 'var(--ink-faint)'}}>
                    (which herds/flocks see this in webform dropdowns)
                  </span>
                </div>
                <div style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>
                  {HERD_SCOPE_OPTIONS.map((h) => {
                    const on = (form.herd_scope || []).includes(h.v);
                    return (
                      <button
                        key={h.v}
                        type="button"
                        onClick={() => toggleHerdScope(h.v)}
                        style={{
                          padding: '6px 14px',
                          borderRadius: 7,
                          border: '1px solid ' + (on ? '#085041' : 'var(--border-strong)'),
                          background: on ? '#ecfdf5' : 'white',
                          color: on ? '#085041' : 'var(--ink-muted)',
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        {on ? '\u2713 ' : ''}
                        {h.l}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Status + notes */}
              <div style={{gridColumn: '1/-1', borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4}}>
                <label style={lbl}>Status</label>
                <select
                  value={form.status}
                  onChange={(e) => upd('status', e.target.value)}
                  style={{...inpS, maxWidth: 160}}
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
              <div style={{gridColumn: '1/-1'}}>
                <label style={lbl}>Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => upd('notes', e.target.value)}
                  rows={2}
                  style={{...inpS, resize: 'vertical'}}
                />
              </div>
            </div>
            <div style={{padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8}}>
              {!editingId && (
                <button
                  onClick={closeForm}
                  style={{
                    padding: '8px 20px',
                    borderRadius: 7,
                    border: 'none',
                    background: '#085041',
                    color: 'white',
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Add Feed
                </button>
              )}
              {editingId && (
                <button
                  onClick={() => deleteFeedPermanently(editingId)}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 7,
                    border: '1px solid #F09595',
                    background: 'white',
                    color: '#b91c1c',
                    fontSize: 13,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Delete Feed
                </button>
              )}
              <button
                onClick={cancelForm}
                style={{
                  padding: '8px 16px',
                  borderRadius: 7,
                  border: '1px solid var(--border-strong)',
                  background: 'white',
                  color: 'var(--ink-muted)',
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LivestockFeedInputsPanel;
