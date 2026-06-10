import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const pageSrc = fs.readFileSync(path.join(ROOT, 'src/broiler/BroilerBatchPage.jsx'), 'utf8');
const listSrc = fs.readFileSync(path.join(ROOT, 'src/broiler/BroilerListView.jsx'), 'utf8');
const formSrc = fs.readFileSync(path.join(ROOT, 'src/broiler/BatchForm.jsx'), 'utf8');
const timelineSrc = fs.readFileSync(path.join(ROOT, 'src/broiler/BroilerTimelineView.jsx'), 'utf8');
const homeSrc = fs.readFileSync(path.join(ROOT, 'src/broiler/BroilerHomeView.jsx'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
const registrySrc = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
const headerSrc = fs.readFileSync(path.join(ROOT, 'src/shared/Header.jsx'), 'utf8');

describe('main.jsx — /broiler/batches/<encoded name> route', () => {
  it('detects isBroilerBatchesSubpath', () => {
    expect(mainSrc).toContain('isBroilerBatchesSubpath');
    expect(mainSrc).toContain("location.pathname.startsWith('/broiler/batches/')");
  });
  it('maps the subpath to the list view', () => {
    expect(mainSrc).toContain("? 'list'");
  });
  it('guards the subpath from view-to-URL clobber', () => {
    expect(mainSrc).toContain("view === 'list' && location.pathname.startsWith('/broiler/batches/')");
  });
  it('top-level showForm branch yields to the record page when URL matches', () => {
    expect(mainSrc).toMatch(
      /if \(showForm && !location\.pathname\.startsWith\('\/broiler\/batches\/'\)\)[\s\S]*?return React\.createElement\(BatchForm/,
    );
  });
  it('passes the form-edit helpers to BroilerListView so the record page form is editable', () => {
    // Hotfix lock: without upd/closeForm/submit/parseProcessorXlsx flowing
    // through BroilerListRouter to BroilerBatchPage → BatchForm, the record
    // page fields are read-only (BatchForm.upd undefined → edits don't stick).
    const listCall = mainSrc.match(/React\.createElement\(BroilerListView,\s*\{[\s\S]*?\}\)/);
    expect(listCall, 'expected BroilerListView render call').not.toBeNull();
    for (const prop of ['upd', 'closeForm', 'submit', 'parseProcessorXlsx', 'openEdit', 'del']) {
      expect(listCall[0]).toContain(prop);
    }
  });
  it('BroilerListRouter forwards its props to BroilerBatchPage', () => {
    expect(listSrc).toMatch(/React\.createElement\(BroilerBatchPage,\s*props\)/);
  });
});

describe('activityRegistry — broiler.batch route by encoded name', () => {
  it('routes broiler.batch to /broiler/batches/<encodeURIComponent(id)>', () => {
    expect(registrySrc).toMatch(
      /BROILER_BATCH[\s\S]*?route:\s*\(id\)\s*=>\s*'\/broiler\/batches\/'\s*\+\s*encodeURIComponent\(id\)/,
    );
  });
  it('routeToView handles /broiler/batches/ subpath', () => {
    expect(registrySrc).toContain("path.startsWith('/broiler/batches/')");
  });
});

describe('Header — direct-route allowlist', () => {
  it('includes /broiler/batches/ in record-page route check', () => {
    expect(headerSrc).toContain("route.startsWith('/broiler/batches/')");
  });
});

describe('BroilerBatchPage — record page structure', () => {
  it('decodes batch name from /broiler/batches/<encodedName>', () => {
    expect(pageSrc).toContain("location.pathname.slice('/broiler/batches/'.length)");
    expect(pageSrc).toContain('decodeURIComponent(encodedName)');
  });
  it('resolves the batch by name in BatchesContext.batches', () => {
    expect(pageSrc).toMatch(/batches[\s\S]*?find\(\(b\)\s*=>\s*\(b\.name \|\| ''\)\s*===\s*batchName\)/);
  });
  it('uses batch.name as the broiler.batch entityId on RecordCollaborationSection', () => {
    expect(pageSrc).toContain('entityType="broiler.batch"');
    expect(pageSrc).toContain('entityId={batch.name}');
    expect(pageSrc).toContain('entityLabel={batch.name}');
  });
  it('does not switch to batch.id for the route identity', () => {
    expect(pageSrc).not.toMatch(/entityId=\{batch\.id\}/);
    expect(pageSrc).not.toMatch(/\/broiler\/batches\/' \+ encodeURIComponent\(batch\.id\)/);
  });
  it('renders the title through the shared RecordTitle', () => {
    // data-record-title now lives in RecordPageShell's RecordTitle.
    expect(pageSrc).toContain('<RecordTitle');
  });
  it('renders RecordCollaborationSection with broiler.batch entityType', () => {
    expect(pageSrc).toContain('RecordCollaborationSection');
    expect(pageSrc).toContain('entityType="broiler.batch"');
  });
  it('does not use ActivityPanel or ActivityModal', () => {
    expect(pageSrc).not.toContain('ActivityPanel');
    expect(pageSrc).not.toContain('ActivityModal');
  });
  it('does not import CommentsSection or RecordActivityLog directly', () => {
    expect(pageSrc).not.toContain("from '../shared/CommentsSection.jsx'");
    expect(pageSrc).not.toContain("from '../shared/RecordActivityLog.jsx'");
  });
  it('has hash-scroll for comment deep-links', () => {
    expect(pageSrc).toContain('location.hash');
    expect(pageSrc).toContain('scrollIntoView');
  });
  it('has back link to /broiler/batches', () => {
    expect(pageSrc).toContain("navigate('/broiler/batches')");
    expect(pageSrc).toContain('Back to Broiler Batches');
  });
  it('has batch-not-found state', () => {
    expect(pageSrc).toContain('Batch not found');
  });
});

describe('BroilerBatchPage — direct URL open does not depend on showForm', () => {
  it('calls openEdit(batch) on mount to populate BatchesContext form state', () => {
    expect(pageSrc).toMatch(/useEffect\([\s\S]*?openEdit\(batch\)/);
  });
  it('mounts BatchForm directly (not via the top-level showForm branch)', () => {
    expect(pageSrc).toMatch(/<BatchForm\b[\s\S]*?embedded/);
  });
  it('passes onClose to BatchForm and renders the shared RecordSequenceNav (no BatchForm prev/next)', () => {
    expect(pageSrc).toContain('onClose={handleClose}');
    expect(pageSrc).not.toContain('onNavigatePrev=');
    expect(pageSrc).not.toContain('onNavigateNext=');
    expect(pageSrc).toContain('<RecordSequenceNav');
    expect(pageSrc).toContain('onNavigate={navigateToBatchId}');
  });
  it('handleClose navigates to /broiler/batches', () => {
    expect(pageSrc).toMatch(/handleClose[\s\S]*?navigate\('\/broiler\/batches'\)/);
  });
  it('navigateToBatchId resolves the seq id to a name and navigates to /broiler/batches/<encoded name>', () => {
    expect(pageSrc).toMatch(/navigateToBatchId[\s\S]*?navigate\('\/broiler\/batches\/' \+ encodeURIComponent/);
  });
  it('does not log record.deleted Activity for hard delete', () => {
    expect(pageSrc).not.toContain("eventType: 'record.deleted'");
  });
});

describe('BroilerBatchPage — showForm cleanup on leave', () => {
  // P1 fix: leaving /broiler/batches/<name> must clear showForm so the
  // top-level if (showForm) ... return BatchForm branch does not capture
  // the next render and render the full-screen modal over the hub.
  it('handleClose clears showForm before navigating', () => {
    expect(pageSrc).toMatch(/handleClose[\s\S]*?setShowForm\(false\)[\s\S]*?navigate\('\/broiler\/batches'\)/);
  });
  it('back link buttons route through handleClose, not bare navigate', () => {
    // Back link/not-found now use the shared RecordBackLink/RecordPageNotFound;
    // both still route through handleClose (which clears showForm) via onBack.
    expect(pageSrc).not.toMatch(/onClick=\{\(\)\s*=>\s*navigate\('\/broiler\/batches'\)\}/);
    expect(pageSrc).toMatch(/onBack=\{handleClose\}/);
  });
  it('unmount effect clears showForm so Header/browser-Back navigation is safe', () => {
    expect(pageSrc).toMatch(/useEffect\([\s\S]*?return\s*\(\)\s*=>\s*\{\s*setShowForm\(false\);\s*\};[\s\S]*?\[\]\)/);
  });
});

describe('BroilerBatchPage — rename survival', () => {
  // P1 fix: editing form.name persists into batches via autosave; the URL
  // still encodes the original name. Pin the resolved batch id so we keep
  // resolving the same record across rename.
  it('pins the resolved batch id with React state', () => {
    expect(pageSrc).toMatch(/pinnedId,\s*setPinnedId/);
  });
  it('resets the pinned id when the URL batch name changes (prev/next nav)', () => {
    expect(pageSrc).toMatch(/setPinnedId\(null\)[\s\S]*?\[batchName\]/);
  });
  it('resolves the batch by pinned id before falling back to name', () => {
    expect(pageSrc).toMatch(/pinnedId[\s\S]*?b\.id === pinnedId[\s\S]*?b\.name \|\| ''\)\s*===\s*batchName/);
  });
  it('updates the pinned id after the initial name lookup so rename survives', () => {
    expect(pageSrc).toMatch(/batch && pinnedId !== batch\.id[\s\S]*?setPinnedId\(batch\.id\)/);
  });
});

describe('BroilerBatchPage — dirty form state does not unmount BatchForm or replay openEdit', () => {
  // Codex P1 follow-up: form.name diverges from batch.name during in-progress
  // edits. The page MUST NOT use form.name === batch.name as the render gate
  // (would unmount BatchForm on the first keystroke) or as the openEdit
  // replay trigger (would clobber keystrokes by re-prefilling).
  it('formReady gates only on editId === batch.id (no form.name comparison)', () => {
    expect(pageSrc).toMatch(/const formReady = editId === batch\.id;/);
    expect(pageSrc).not.toMatch(/formReady[\s\S]*?form\.name[\s\S]*?batch\.name/);
  });
  it('openEdit replay effect early-returns on editId === batch.id only', () => {
    expect(pageSrc).toMatch(/if \(editId === batch\.id\) return;\s*\n\s*openEdit\(batch\)/);
    expect(pageSrc).not.toMatch(
      /if \(editId === batch\.id && \(form\.name \|\| ''\) === \(batch\.name \|\| ''\)\) return/,
    );
  });
  it('openEdit replay effect deps key off batch.id (not the full batch object or batches)', () => {
    expect(pageSrc).toMatch(/openEdit\(batch\);[\s\S]*?\}, \[batch && batch\.id\]\)/);
  });
  it('BroilerBatchPage does not read form.name from BatchesContext for rendering decisions', () => {
    // The destructure should not pull form anymore; only context state the
    // record page actually needs (batches, editId, setShowForm).
    expect(pageSrc).toMatch(/const \{batches, editId, setShowForm\} = useBatches\(\);/);
  });
});

describe('BroilerBatchPage — post-rename URL stays in sync', () => {
  // Codex P1 follow-up: if name changes and persists, the URL must follow
  // so /broiler/batches/<oldName> does not 404 on refresh.
  it('replaces the URL when the persisted batch.name diverges from the URL batchName', () => {
    expect(pageSrc).toMatch(
      /useEffect[\s\S]*?currentName === batchName[\s\S]*?navigate\('\/broiler\/batches\/' \+ encodeURIComponent\(currentName\),\s*\{replace:\s*true\}\)/,
    );
  });
  it('the URL-sync effect keys off batch.name so it only fires when persist completes', () => {
    expect(pageSrc).toMatch(/navigate\([\s\S]*?\{replace:\s*true\}\);[\s\S]*?\}, \[batch && batch\.name\]\)/);
  });
});

describe('submit() returns true/false so closeForm can detect refusals', () => {
  // Codex P1 follow-up: submit must report whether it actually saved so
  // closeForm + handleClose can keep the form open on validation refusal.
  it('submit returns false on blank batch name', () => {
    expect(mainSrc).toMatch(
      /if \(!form\.name\.trim\(\)\)\s*\{[\s\S]*?setFormNotice\(\{[\s\S]*?Please enter a batch name[\s\S]*?\}\);\s*return false;/,
    );
  });
  it('submit returns false on hard conflicts without force', () => {
    expect(mainSrc).toMatch(
      /if \(hardConflicts\.length > 0 && !force\)\s*\{[\s\S]*?setFormNotice\([\s\S]*?\);\s*return false;/,
    );
  });
  it('submit returns true after the successful save path completes', () => {
    expect(mainSrc).toMatch(/setOverride\(false\);\s*\n\s*return true;\s*\n\s*\}/);
  });
});

describe('closeForm() returns submit(false) on the dirty-edit branch', () => {
  // Codex P1 follow-up: when there are unsaved changes, closeForm calls
  // submit(false). Its return value must propagate so callers can detect
  // refusals and keep the form open.
  it('closeForm captures submit(false) and returns ok !== false', () => {
    expect(mainSrc).toMatch(/if \(changed\)\s*\{\s*const ok = submit\(false\);[\s\S]*?return ok !== false;\s*\}/);
  });
  it('closeForm returns true on the no-changes and no-edit branches', () => {
    // The else-after-changed branch.
    expect(mainSrc).toMatch(/setShowForm\(false\);\s*\n\s*return true;\s*\n\s*\}\s*\n\s*setShowForm\(false\);/);
    // The non-edit branch at the bottom of the function.
    expect(mainSrc).toMatch(/\}\s*\n\s*setShowForm\(false\);\s*\n\s*return true;\s*\n\s*\}/);
  });
});

describe('Broiler batch cold-boot readiness markers', () => {
  it('record page consumes dataLoaded so a genuinely empty loaded batch context reaches not-found, not infinite loading', () => {
    expect(pageSrc).toMatch(/const \{authState, dataLoaded\} = useAuth\(\);/);
    expect(pageSrc).toMatch(/!Array\.isArray\(batches\) \|\| \(!dataLoaded && batches\.length === 0\)/);
  });

  it('record page exposes data-broiler-batch-record-loaded only on the resolved record body', () => {
    expect(pageSrc).toMatch(/<RecordPageBody[^>]*data-broiler-batch-record-loaded="true"/);
  });

  it('hub drives the data-broiler-batches-loaded marker from real boot readiness (dataLoaded)', () => {
    expect(listSrc).toContain("data-broiler-batches-loaded={dataLoaded ? 'true' : 'false'}");
    expect(listSrc).not.toContain('data-broiler-batches-loaded="true"');
  });
});

describe('BroilerBatchPage.handleClose guards navigation on closeForm refusal', () => {
  // Codex P1 follow-up: handleClose must not navigate or clear showForm
  // when closeForm refused (blank name / hard conflict without override).
  it('handleClose checks closeForm() !== false before doing anything else', () => {
    expect(pageSrc).toMatch(
      /function handleClose\(\)\s*\{[\s\S]*?const ok = closeForm\(\);[\s\S]*?if \(ok === false\) return;[\s\S]*?setShowForm\(false\);[\s\S]*?navigate\('\/broiler\/batches'\);/,
    );
  });
  it('handleClose does not call setShowForm(false) before checking closeForm result', () => {
    // The setShowForm(false) call must follow the if (ok === false) return guard.
    expect(pageSrc).not.toMatch(/function handleClose\(\)\s*\{\s*\n\s*setShowForm\(false\);/);
    expect(pageSrc).not.toMatch(/function handleClose\(\)\s*\{\s*\n\s*closeForm\(\);\s*\n\s*setShowForm\(false\);/);
  });
  it('handleClose does not navigate before checking closeForm result', () => {
    expect(pageSrc).not.toMatch(
      /function handleClose\(\)[\s\S]*?navigate\('\/broiler\/batches'\)[\s\S]*?closeForm\(\)/,
    );
    expect(pageSrc).not.toMatch(/closeForm\(\);\s*\n\s*setShowForm\(false\);\s*\n\s*navigate\('\/broiler\/batches'\)/);
  });
});

describe('BatchForm — sticky X uses onClose override', () => {
  // P2 fix: the sticky header X must route through onClose when provided.
  it('sticky X calls onClose when provided, falling back to closeForm', () => {
    expect(formSrc).toMatch(/×[\s\S]{0,200}/);
    // Both the bottom Close button and the sticky X share the same shape.
    const onClosePattern = /typeof onClose === 'function'[\s\S]*?onClose\(\)[\s\S]*?closeForm\(\)/g;
    const matches = formSrc.match(onClosePattern) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
  it('sticky X no longer uses bare onClick={closeForm}', () => {
    // Allow Delete button's `del(editId); closeForm();` shape, but the
    // sticky X should not directly bind closeForm as the onClick handler.
    expect(formSrc).not.toMatch(/onClick=\{closeForm\}/);
  });
});

describe('BatchForm — embedded mode + record-page overrides', () => {
  it('accepts an optional onClose prop (record-page close override)', () => {
    expect(formSrc).toContain('onClose,');
  });
  it('no longer ships its own prev/next side navigation', () => {
    // Prev/Next is owned by the shared RecordSequenceNav on the record page.
    expect(formSrc).not.toContain('onNavigatePrev');
    expect(formSrc).not.toContain('onNavigateNext');
    expect(formSrc).not.toContain('data-batchform-side-nav');
  });
  it('accepts embedded prop that defaults to false', () => {
    expect(formSrc).toMatch(/embedded\s*=\s*false/);
  });
  it('skips its own Header render when embedded', () => {
    expect(formSrc).toMatch(/\{!embedded && <Header \/>\}/);
  });
  it('drops the modal overlay background when embedded', () => {
    expect(formSrc).toContain("embedded ? 'transparent' : 'rgba(0,0,0,.45)'");
  });
  it('Close button calls onClose when provided, else closeForm', () => {
    expect(formSrc).toMatch(/typeof onClose === 'function'[\s\S]*?onClose\(\)[\s\S]*?closeForm\(\)/);
  });
  it('renders 4-week and 6-week broiler weights as read-only weigh-in sourced values', () => {
    expect(formSrc).toContain('data-broiler-week4-weight-readonly="1"');
    expect(formSrc).toContain('data-broiler-week6-weight-readonly="1"');
    expect(formSrc).toContain('broilerWeekWeightLabel(form.week4Lbs)');
    expect(formSrc).toContain('broilerWeekWeightLabel(form.week6Lbs)');
    expect(formSrc).toContain('Pulled from completed Week 4 weigh-ins.');
    expect(formSrc).toContain('Pulled from completed Week 6 weigh-ins.');
    expect(formSrc).not.toContain("upd('week4Lbs'");
    expect(formSrc).not.toContain("upd('week6Lbs'");
  });
});

describe('BroilerListView — navigation-only hub + router', () => {
  it('exports BroilerListRouter that delegates to BroilerBatchPage on the subpath', () => {
    expect(listSrc).toContain('BroilerListRouter');
    expect(listSrc).toContain('BroilerBatchPage');
    expect(listSrc).toContain("location.pathname.startsWith('/broiler/batches/')");
  });
  it('hub click handlers navigate to /broiler/batches/<encoded name>', () => {
    expect(listSrc).toContain('broilerBatchHref');
    expect(listSrc).toContain("'/broiler/batches/' + encodeURIComponent(");
    // openBatch now threads the section's visible order for prev/next.
    expect(listSrc).toContain('openBatch(b, activeRows)');
    expect(listSrc).toContain('recordSeqNavOptions(labeledSeqItems(seqRows');
  });
  it('no longer imports or renders ActivityPanel or ActivityModal', () => {
    expect(listSrc).not.toContain('ActivityPanel');
    expect(listSrc).not.toContain('ActivityModal');
  });
  it('no longer listens for wcf-entity-deep-link', () => {
    expect(listSrc).not.toContain('wcf-entity-deep-link');
  });
  it('hub no longer holds activityTarget state', () => {
    expect(listSrc).not.toContain('setActivityTarget');
  });
});

describe('BroilerTimelineView — bar clicks navigate to record page', () => {
  it('clicking a timeline bar navigates to /broiler/batches/<encoded name>', () => {
    expect(timelineSrc).toContain('openBroilerBatch');
    expect(timelineSrc).toContain("navigate('/broiler/batches/' + encodeURIComponent(b.name))");
  });
});

describe('BroilerHomeView — active dashboard tiles open the batch record page', () => {
  it("active batch tiles navigate to the record page via the canonical mechanism (not setView('list'))", () => {
    // Tile onClick must route to /broiler/batches/<encoded name> via
    // react-router useNavigate, mirroring BroilerListView/BroilerTimelineView.
    expect(homeSrc).toContain("import {useNavigate} from 'react-router-dom'");
    expect(homeSrc).toContain('openBroilerBatch');
    expect(homeSrc).toContain("navigate('/broiler/batches/' + encodeURIComponent(b.name))");
    expect(homeSrc).toContain('onClick={() => openBroilerBatch(b)}');
    // The active-batch tile must no longer fall back to the hub list view.
    expect(homeSrc).not.toContain("onClick={() => setView('list')}");
  });
});

describe('BroilerListView — Batch Comparison Hatchery column', () => {
  it('Hatchery header appears immediately after Breed in the Batch Comparison table', () => {
    // The header array literal lists Breed then Hatchery then Time on Farm.
    expect(listSrc).toMatch(/'Batch',\s*'Breed',\s*'Hatchery',\s*'Time on Farm',/);
  });
  it('renders a matching Hatchery body cell from b.hatchery after the Breed cell', () => {
    // The breed badge cell is immediately followed by the hatchery cell, then
    // the time-on-farm cell — keeps header/body columns aligned.
    expect(listSrc).toMatch(/\{cell\(b\.hatchery \|\| null\)\}\s*\{cell\(timeOnFarm\)\}/);
  });
});

describe('BroilerHomeView — Lbs Produced trend selects the latest 9 processed batches', () => {
  it('lbsTrend takes the latest 9 (slice(-9)) of processed batches, oldest-left to newest-right', () => {
    // procBr is processed-only (status === 'processed'); the trend sorts
    // processing date ascending (oldest-left) then keeps the latest 9.
    expect(homeSrc).toMatch(
      /lbsTrend = \[\.\.\.procBr\][\s\S]*?\.sort\(\(a, b\) => a\.processingDate\.localeCompare\(b\.processingDate\)\)[\s\S]*?\.slice\(-9\)/,
    );
    expect(homeSrc).not.toContain('.slice(-10)');
  });
});
