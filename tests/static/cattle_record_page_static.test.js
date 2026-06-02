import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const herdsView = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleHerdsView.jsx'), 'utf8');
const animalPage = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleAnimalPage.jsx'), 'utf8');
const cowDetail = fs.readFileSync(path.join(ROOT, 'src/cattle/CowDetail.jsx'), 'utf8');
const collapsible = fs.readFileSync(path.join(ROOT, 'src/cattle/CollapsibleOutcomeSections.jsx'), 'utf8');
const mainJsx = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
const registry = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');

describe('CattleHerdsView — no legacy Activity or inline CowDetail', () => {
  it('does not import ActivityPanel', () => {
    expect(herdsView).not.toMatch(/^import ActivityPanel/m);
  });
  it('does not import ActivityModal', () => {
    expect(herdsView).not.toMatch(/^import ActivityModal/m);
  });
  it('does not render CowDetail inline', () => {
    expect(herdsView).not.toMatch(/<CowDetail\b/);
  });
  it('does not have expandedCow state', () => {
    expect(herdsView).not.toContain('setExpandedCow');
  });
  it('does not have cowNavStack state', () => {
    expect(herdsView).not.toContain('cowNavStack');
  });
  it('does not query cattle_comments', () => {
    expect(herdsView).not.toContain("from('cattle_comments')");
  });
  it('navigates to /cattle/herds/<id> on tile click', () => {
    expect(herdsView).toContain("navigate('/cattle/herds/' + c.id");
  });
  it('passes the visible-order sequence through route state on row click (flat + grouped)', () => {
    // Flat mode hands the sortedFlat order; grouped mode hands the per-herd
    // cows order. Both feed RecordSequenceNav on the record page.
    expect(herdsView).toContain('recordSeqNavOptions(sortedFlat)');
    expect(herdsView).toContain('recordSeqNavOptions(cows)');
    expect(herdsView).toContain("from '../lib/recordSequence.js'");
  });
  it('imports CattleAnimalPage for hub routing', () => {
    expect(herdsView).toContain('CattleAnimalPage');
  });
  it('parses /cattle/herds/<id> from URL', () => {
    expect(herdsView).toContain('/cattle/herds/');
  });
  it('passes Header to CattleAnimalPage', () => {
    expect(herdsView).toContain('Header: props.Header');
  });
});

describe('CollapsibleOutcomeSections — no inline CowDetail', () => {
  it('does not render CowDetail JSX', () => {
    expect(collapsible).not.toMatch(/<CowDetail\b/);
  });
  it('does not accept renderCowDetail prop', () => {
    const propsBlock = collapsible.match(/const CollapsibleOutcomeSections = \(\{[\s\S]*?\}\) =>/);
    expect(propsBlock).not.toBeNull();
    expect(propsBlock[0]).not.toContain('renderCowDetail');
  });
  it('accepts onCowClick for navigation', () => {
    expect(collapsible).toContain('onCowClick');
  });
});

describe('CattleAnimalPage — CowDetail remount on navigation', () => {
  it('keys CowDetail by cow.id to force remount', () => {
    expect(animalPage).toContain('key={cow.id}');
  });
  it('resets cow state to null on cattleId change', () => {
    expect(animalPage).toContain('setCow(null)');
  });
  it('resets loading to true on cattleId change', () => {
    expect(animalPage).toContain('setLoading(true)');
  });
});

describe('CattleAnimalPage — app header', () => {
  it('accepts Header prop', () => {
    expect(animalPage).toMatch(/CattleAnimalPage\(\{[^}]*Header/);
  });
  it('renders Header through the shared record-page chrome', () => {
    // The literal {Header && <Header />} now lives in RecordPageShell; the page
    // hands Header to the shared frame/loading/not-found primitives.
    expect(animalPage).toContain('RecordPageFrame');
    expect(animalPage).toContain('Header={Header}');
  });
});

describe('CattleAnimalPage — record page structure', () => {
  it('renders RecordCollaborationSection with cattle.animal', () => {
    expect(animalPage).toContain('RecordCollaborationSection');
    expect(animalPage).toContain('entityType="cattle.animal"');
  });
  it('does not import ActivityPanel or ActivityModal', () => {
    expect(animalPage).not.toMatch(/^import ActivityPanel/m);
    expect(animalPage).not.toMatch(/^import ActivityModal/m);
  });
  it('does not have an Activity comment composer', () => {
    expect(animalPage).not.toContain('postActivityComment');
    expect(animalPage).not.toContain('data-activity-compose');
  });
  it('does not import CommentsSection or RecordActivityLog directly', () => {
    expect(animalPage).not.toContain("from '../shared/CommentsSection.jsx'");
    expect(animalPage).not.toContain("from '../shared/RecordActivityLog.jsx'");
  });
  it('does not load cattle_comments', () => {
    expect(animalPage).not.toContain("from('cattle_comments')");
  });
  it('passes hideComments to CowDetail', () => {
    expect(animalPage).toContain('hideComments={true}');
  });
  it('has a back link to /cattle/herds', () => {
    expect(animalPage).toContain("navigate('/cattle/herds')");
  });
  it('handles hash anchors for comment deep-links', () => {
    expect(animalPage).toContain('location.hash');
    expect(animalPage).toContain('scrollIntoView');
  });
});

describe('CattleAnimalPage — record page title', () => {
  it('shows tag as the page title', () => {
    expect(animalPage).toContain("cow.tag ? '#' + cow.tag : 'Untagged animal'");
  });
  it('renders the title through the shared RecordTitle', () => {
    // The data-record-title marker now lives in RecordPageShell's RecordTitle.
    expect(animalPage).toContain('<RecordTitle>');
  });
  it('does not prefix title with Cow/Bull/Steer/Heifer', () => {
    expect(animalPage).not.toMatch(/['"](?:Cow|Bull|Steer|Heifer|Cattle)\s*#/);
  });
});

describe('CattleAnimalPage — record sequence navigation', () => {
  it('renders the shared RecordSequenceNav', () => {
    expect(animalPage).toContain("from '../shared/RecordSequenceNav.jsx'");
    expect(animalPage).toContain('<RecordSequenceNav');
  });
  it('reads the sequence from route state', () => {
    expect(animalPage).toContain('location.state?.recordSeq');
  });
  it('passes currentId + onNavigate to the sequence nav', () => {
    expect(animalPage).toMatch(/<RecordSequenceNav[\s\S]*?currentId=\{cattleId\}[\s\S]*?onNavigate=\{navigateSeq\}/);
  });
  it('navigateSeq carries the sequence forward', () => {
    expect(animalPage).toMatch(
      /navigateSeq[\s\S]*?navigate\('\/cattle\/herds\/' \+ id, recordSeqNavOptions\(recordSeq\)\)/,
    );
  });
  it('cow-to-cow click-through does NOT carry the sequence (controls hide)', () => {
    // navigateToCow passes only fromCowId/fromCowTag — no recordSeq — so the
    // related record renders without sequence controls.
    expect(animalPage).toMatch(/navigateToCow[\s\S]*?state: \{fromCowId: cow\.id, fromCowTag: cow\.tag \|\| cow\.id\}/);
  });
});

describe('CattleAnimalPage — cow-to-cow navigation state', () => {
  it('does not hard-code canNavigateBack={true}', () => {
    expect(animalPage).not.toContain('canNavigateBack={true}');
  });
  it('derives canNavigateBack from location.state.fromCowId', () => {
    expect(animalPage).toContain('fromCowId');
    expect(animalPage).toContain('canNavigateBack={Boolean(fromCowId)}');
  });
  it('passes fromCowTag as backToTag', () => {
    expect(animalPage).toContain('backToTag={fromCowTag}');
  });
  it('navigateToCow passes route state with source cow', () => {
    expect(animalPage).toContain('fromCowId: cow.id');
    expect(animalPage).toContain('fromCowTag: cow.tag');
  });
  it('onNavigateBack navigates to the source cow record page', () => {
    expect(animalPage).toContain("navigate('/cattle/herds/' + fromCowId)");
  });
});

describe('CowDetail — breeding blacklist UI', () => {
  it('uses a shaded row for the blacklist control', () => {
    expect(cowDetail).toContain('data-breeding-blacklist-row');
  });
  it('keeps the label on one line with whiteSpace nowrap', () => {
    expect(cowDetail).toMatch(/breeding.blacklist[\s\S]*?whiteSpace:\s*'nowrap'/);
  });
  it('does not include helper text', () => {
    expect(cowDetail).not.toContain('Do not breed. Record reason in Issues.');
  });
  it('uses boxSizing border-box to prevent overflow', () => {
    expect(cowDetail).toMatch(/data-breeding-blacklist-row[\s\S]*?boxSizing:\s*'border-box'/);
  });
  it('makes the blacklist control a compact label with left-aligned contents', () => {
    expect(cowDetail).toMatch(/<label[\s\S]*?data-breeding-blacklist-row="1"/);
    expect(cowDetail).toMatch(/data-breeding-blacklist-row[\s\S]*?display:\s*'inline-flex'/);
    expect(cowDetail).toMatch(/data-breeding-blacklist-row[\s\S]*?justifyContent:\s*'flex-start'/);
    expect(cowDetail).toMatch(/data-breeding-blacklist-row[\s\S]*?maxWidth:\s*'100%'/);
  });
  it('overrides the global input width on the blacklist checkbox', () => {
    expect(cowDetail).toMatch(/type="checkbox"[\s\S]*?width:\s*14/);
    expect(cowDetail).toMatch(/type="checkbox"[\s\S]*?height:\s*14/);
    expect(cowDetail).toMatch(/type="checkbox"[\s\S]*?flex:\s*'0 0 14px'/);
  });
  it('keeps checkbox before the blacklist text inside the row', () => {
    expect(cowDetail).toMatch(
      /data-breeding-blacklist-row[\s\S]*?<input[\s\S]*?<span[\s\S]*?>\s*Breeding blacklist\s*<\/span>/,
    );
  });
});

describe('CowDetail — lineage editor', () => {
  it('keeps dam tag editable even when populated', () => {
    expect(cowDetail).toMatch(
      /Dam tag #:[\s\S]*?<input[\s\S]*?defaultValue=\{cow\.dam_tag \|\| ''\}[\s\S]*?onBlur=\{patchOnBlur\('dam_tag', 'text'\)\}/,
    );
  });
  it('does not replace populated dam tag with read-only display text', () => {
    expect(cowDetail).not.toContain("<strong>{'#' + cow.dam_tag}</strong>");
  });
  it('keeps dam View link as secondary navigation when the tag matches a cow', () => {
    expect(cowDetail).toMatch(
      /cow\.dam_tag && findByTag\(cow\.dam_tag\)[\s\S]*?<TagLink tag=\{cow\.dam_tag\} prefix="View " \/>/,
    );
  });
});

describe('CowDetail — hideComments prop and Issues wording', () => {
  it('accepts hideComments prop', () => {
    expect(cowDetail).toContain('hideComments');
  });
  it('labels the legacy section as Issues not Comments', () => {
    expect(cowDetail).toContain('>Issues<');
    expect(cowDetail).not.toContain('>Comments Timeline<');
  });
  it('does not say "Add a comment..."', () => {
    expect(cowDetail).not.toContain('Add a comment...');
  });
  it('does not render "Comments Timeline" as user-visible section title', () => {
    expect(cowDetail).not.toContain('>Comments Timeline<');
  });
});

describe('CattleHerdsView — no dead commented imports', () => {
  it('has no commented CowDetail import', () => {
    expect(herdsView).not.toContain('// import CowDetail');
  });
  it('has no commented ActivityPanel import', () => {
    expect(herdsView).not.toContain('// import ActivityPanel');
  });
  it('has no commented ActivityModal import', () => {
    expect(herdsView).not.toContain('// import ActivityModal');
  });
  it('does not reference "comments timeline" in UI text', () => {
    expect(herdsView.toLowerCase()).not.toContain('comments timeline');
  });
});

describe('URL adapter — cattle herds sub-path', () => {
  it('detects /cattle/herds/<id> as a sub-path', () => {
    expect(mainJsx).toContain("location.pathname.startsWith('/cattle/herds/')");
  });
  it('preserves /cattle/herds/<id> in view→URL sync', () => {
    expect(mainJsx).toContain("view === 'cattleherds' && location.pathname.startsWith('/cattle/herds/')");
  });
});

describe('activityRegistry — cattle.animal route', () => {
  it('routes to /cattle/herds/<id> not /cattle/herds', () => {
    expect(registry).toMatch(/route:\s*\(id\)\s*=>\s*'\/cattle\/herds\/'\s*\+\s*id/);
  });
  it('routeToView handles /cattle/herds/<id> paths', () => {
    expect(registry).toContain("path.startsWith('/cattle/herds/')");
  });
  it('resolveNotificationRoute handles comment_mention', () => {
    expect(registry).toContain("type === 'comment_mention'");
    expect(registry).toContain('#comment-');
  });
});

describe('CattleAnimalPage — transfer hardening', () => {
  it('transferCow checks update result before inserting audit row', () => {
    expect(animalPage).toMatch(
      /transferCow[\s\S]*?\{error:\s*updateErr\}[\s\S]*?if \(updateErr\)[\s\S]*?return[\s\S]*?cattle_transfers/,
    );
  });
  it('transferCow has no-op guard when destination matches current herd', () => {
    expect(animalPage).toMatch(/transferCow[\s\S]*?newHerd === oldHerd[\s\S]*?return/);
  });
  it('transferCow surfaces warning when audit insert fails', () => {
    expect(animalPage).toMatch(/auditErr[\s\S]*?setNotice[\s\S]*?warning[\s\S]*?audit/i);
  });
});

describe('CattleAnimalPage - cold-boot readiness', () => {
  const loadAllMatch = animalPage.match(/async function loadAll\(\)[\s\S]*?\n {2}React\.useEffect/);
  const loadAllSrc = loadAllMatch ? loadAllMatch[0] : '';

  it('never strands the cattle animal record page in Loading after a failed boot read', () => {
    expect(loadAllSrc).toContain('try {');
    expect(loadAllSrc).toContain('} catch (e) {');
    expect(loadAllSrc).toMatch(/finally\s*\{[\s\S]*?setLoading\(false\);[\s\S]*?\}/);
  });

  it('keeps missing cattle rows as not-found while surfacing real read failures', () => {
    expect(loadAllSrc).toContain(".eq('id', cattleId).is('deleted_at', null).maybeSingle()");
    expect(loadAllSrc).toContain("throw new Error('cattle: '");
    expect(loadAllSrc).toContain("throw new Error('cattle list: '");
    expect(loadAllSrc).toContain("throw new Error('cattle_calving_records: '");
    expect(loadAllSrc).toContain("throw new Error('cattle_breeds: '");
    expect(loadAllSrc).toContain("throw new Error('cattle_origins: '");
    expect(loadAllSrc).toContain('Could not load cattle record');
  });

  it('uses strict cattle weigh-ins cache and clears stale side state on failure', () => {
    expect(loadAllSrc).toContain('loadCattleWeighInsCached(sb, {throwOnError: true})');
    expect(loadAllSrc).toContain('setCow(null);');
    expect(loadAllSrc).toContain('setCattle([]);');
    expect(loadAllSrc).toContain('setWeighIns([]);');
    expect(loadAllSrc).toContain('setCalvingRecs([]);');
    expect(loadAllSrc).toContain('setBreedOpts([]);');
    expect(loadAllSrc).toContain('setOriginOpts([]);');
    expect(animalPage).toMatch(/if \(loadError\)[\s\S]*?<InlineNotice notice=\{loadError\}/);
  });

  it('keeps the resolved record body marker used by Playwright helpers', () => {
    expect(animalPage).toContain('data-cattle-animal-page="1"');
  });
});
