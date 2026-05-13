import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'src/admin/LivestockFeedInputsPanel.jsx'), 'utf8');
const webformHubSrc = fs.readFileSync(path.join(ROOT, 'src/webforms/WebformHub.jsx'), 'utf8');
const addFeedWebformSrc = fs.readFileSync(path.join(ROOT, 'src/webforms/AddFeedWebform.jsx'), 'utf8');

describe('LivestockFeedInputsPanel active/inactive feed visibility', () => {
  it('labels the admin panel as Cattle & Sheep Inputs', () => {
    expect(src).toMatch(/'Cattle & Sheep Inputs '/);
    expect(src).not.toMatch(/'Livestock Feed Inputs '/);
  });

  it('opens the master feed panel by default so active feeds are immediately visible', () => {
    expect(src).toMatch(/const \[expanded, setExpanded\] = React\.useState\(true\);/);
    expect(src).not.toMatch(/const \[expanded, setExpanded\] = React\.useState\(false\);/);
  });

  it('keeps the inactive feed section collapsed by default', () => {
    expect(src).toMatch(/const \[showInactiveFeeds, setShowInactiveFeeds\] = React\.useState\(false\);/);
    expect(src).toMatch(/data-feed-inputs-inactive-state=\{showInactiveFeeds \? 'expanded' : 'collapsed'\}/);
  });

  it('splits filtered feeds into active and inactive status buckets', () => {
    expect(src).toMatch(/const activeFeeds = filteredFeeds\.filter\(\(f\) => f\.status !== 'inactive'\);/);
    expect(src).toMatch(/const inactiveFeeds = filteredFeeds\.filter\(\(f\) => f\.status === 'inactive'\);/);
  });

  it('renders active rows directly and inactive rows only behind the inactive toggle', () => {
    expect(src).toMatch(/data-feed-inputs-section="active"/);
    expect(src).toMatch(/Active feeds \(\{activeFeeds\.length\}\)/);
    expect(src).toMatch(/renderFeedTable\(activeFeeds, 'active'\)/);
    expect(src).toMatch(/data-feed-inputs-inactive-toggle="1"/);
    expect(src).toMatch(
      /showInactiveFeeds &&\s*\(\s*<div style=\{\{marginTop: 8\}\}>\{renderFeedTable\(inactiveFeeds, 'inactive'\)\}<\/div>/,
    );
    expect(src).not.toMatch(/renderFeedTable\(filteredFeeds/);
  });

  it('keeps edit autosave debounced instead of saving on every keystroke', () => {
    const updStart = src.indexOf('function upd(k, v)');
    const updEnd = src.indexOf('function toggleHerdScope', updStart);
    expect(updStart).toBeGreaterThan(-1);
    expect(updEnd).toBeGreaterThan(updStart);
    const updBody = src.slice(updStart, updEnd);

    expect(updBody).toMatch(/if \(editingId\)/);
    expect(updBody).toMatch(/clearTimeout\(autoSaveTimer\.current\)/);
    expect(updBody).toMatch(/autoSaveTimer\.current = setTimeout\(\(\) => saveFeed\(next, editingId\), 1500\);/);
  });

  it('saves pending feed edits when the modal closes', () => {
    const closeStart = src.indexOf('async function closeForm()');
    const closeEnd = src.indexOf('function cancelForm()', closeStart);
    expect(closeStart).toBeGreaterThan(-1);
    expect(closeEnd).toBeGreaterThan(closeStart);
    const closeBody = src.slice(closeStart, closeEnd);

    expect(closeBody).toMatch(/clearTimeout\(autoSaveTimer\.current\)/);
    expect(closeBody).toMatch(/const changed = JSON\.stringify\(form\) !== JSON\.stringify\(originalForm\);/);
    expect(closeBody).toMatch(/if \(changed\) await saveFeed\(form, editingId\);/);
    expect(closeBody).toMatch(/await saveFeed\(form, null\);/);
  });

  it('maps inactive status to cattle and sheep public webform dropdowns', () => {
    for (const formSrc of [webformHubSrc, addFeedWebformSrc]) {
      expect(formSrc).toMatch(/from\('cattle_feed_inputs'\)/);
      expect(formSrc).toMatch(/setCattleFeedInputs\([\s\S]*?\.filter\([\s\S]*?f\.status !== 'inactive'/);
      expect(formSrc).not.toMatch(/\.eq\('status', 'active'\)/);
    }
  });
});
