import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// Pig weigh-in metrics + descending-sort lock — commit 3
// ============================================================================
// Per Codex W5: small static lock that the load query stays insertion-order
// (entered_at ASC) while the display sort is weight DESC, and that the
// persisted entries array is not mutated by the sort. Playwright is the main
// behavioral proof; this test is a cheap regression net for the cardinal
// shape changes.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const publicSrc = fs.readFileSync(path.join(ROOT, 'src/webforms/WeighInsWebform.jsx'), 'utf8');
const adminSrc = fs.readFileSync(path.join(ROOT, 'src/livestock/LivestockWeighInsView.jsx'), 'utf8');

describe('Pig weigh-in metrics — public form (commit 3)', () => {
  it('imports the four pig forecast formatters', () => {
    expect(publicSrc).toMatch(
      /import\s*\{\s*formatAgeRange,\s*formatFeedPerPig,\s*formatGroupAdg,\s*formatAvgWeight\s*\}\s*from\s*'\.\.\/lib\/pigForecast\.js'/,
    );
  });

  it('calls pig_session_metrics RPC with session_id_in', () => {
    expect(publicSrc).toMatch(/sb\.rpc\('pig_session_metrics',\s*\{\s*session_id_in:\s*session\.id\s*\}\)/);
  });

  it('gates the metrics block on entries.length >= 1 (Codex W1)', () => {
    expect(publicSrc).toMatch(/species === 'pig' && entries\.length >= 1 && pigMetrics/);
  });

  it('keeps the persisted load query at entered_at ASC', () => {
    expect(publicSrc).toMatch(/\.eq\('session_id', session\.id\)\s*\.order\('entered_at',\s*\{ascending:\s*true\}\)/);
  });

  it('numbers entries from insertion order BEFORE sorting for display (descending by weight)', () => {
    // Stamp _entryNum from the load order, then build a fresh array for
    // the descending sort. Persisted `entries` must not be mutated.
    expect(publicSrc).toMatch(/const numbered = entries\.map\(\(e, i\) => \(\{\.\.\.e, _entryNum: i \+ 1\}\)\)/);
    expect(publicSrc).toMatch(/const displayed = \[\.\.\.numbered\]\.sort/);
    expect(publicSrc).toMatch(/return wb - wa/); // descending weight
    expect(publicSrc).toMatch(/return a\._entryNum - b\._entryNum/); // stable tiebreak
    // The map renders the displayed (sorted) array, not the raw entries.
    expect(publicSrc).toMatch(/\{displayed\.map\(\(e\) => \{/);
    // Display reads e._entryNum (the stamped insertion-order tag), not a
    // post-sort index — keeps the operator's #N memory stable.
    expect(publicSrc).toMatch(/const entryNum = e\._entryNum/);
  });
});

describe('Pig weigh-in metrics — admin LivestockWeighInsView (commit 3)', () => {
  it('imports the same pig forecast formatters as the public form', () => {
    // Pig planned trips lane (Codex) added reconcilePlannedTripsForSend
    // to the same import — match relaxed to "all four formatters present"
    // rather than the exact import-block byte sequence.
    expect(adminSrc).toMatch(/from\s*'\.\.\/lib\/pigForecast\.js'/);
    expect(adminSrc).toMatch(/\bformatAgeRange\b/);
    expect(adminSrc).toMatch(/\bformatFeedPerPig\b/);
    expect(adminSrc).toMatch(/\bformatGroupAdg\b/);
    expect(adminSrc).toMatch(/\bformatAvgWeight\b/);
  });

  it('fans out pig_session_metrics RPC per pig session', () => {
    expect(adminSrc).toMatch(/\.rpc\('pig_session_metrics',\s*\{\s*session_id_in:\s*s\.id\s*\}\)/);
    expect(adminSrc).toMatch(/\.catch\(\(\) => \(\{id: s\.id, data: \{available: false\}\}\)\)/);
  });

  it('renders rank-matched per-entry pig ADG chips when a prior session exists', () => {
    expect(adminSrc).toContain('findPriorPigWeighInSession');
    expect(adminSrc).toContain('computeRankMatchedPigEntryADG');
    expect(adminSrc).toContain('data-pig-metric="entry-adg"');
    expect(adminSrc).toContain('Rank-matched pig ADG');
  });

  it('keeps the persisted load query at entered_at ASC', () => {
    expect(adminSrc).toMatch(/\.in\('session_id',\s*ids\)\s*\.order\('entered_at',\s*\{ascending:\s*true\}\)/);
  });

  it('pig sessions get metric columns; non-pig species get a simple avg-weight column', () => {
    // CP2: pig metrics render as DataTable columns (age / feed-per-pig / group
    // ADG / avg / rank-matched ADG), each gated on metric availability;
    // non-pig species get a single avg-weight column in the else branch.
    expect(adminSrc).toContain("key: 'groupAdg'");
    expect(adminSrc).toContain("key: 'entryAdg'");
    expect(adminSrc).toContain('pigMetricsBySession');
    expect(adminSrc).toMatch(/metric\(s\) && metric\(s\)\.available/);
    expect(adminSrc).toMatch(/else \{[\s\S]*?key: 'avg'/);
    expect(adminSrc).toMatch(/averageEntryWeight/);
  });

  it('pig inline accordion is removed — pig navigates to record page', () => {
    expect(adminSrc).toContain("'/weigh-in-sessions/' + s.id");
    expect(adminSrc).not.toContain('addPigEntry');
    expect(adminSrc).not.toContain('deletePigEntry');
  });

  it('pig send-to-trip and transfer-to-breeding removed from list view', () => {
    expect(adminSrc).not.toContain('PigSendToTripModal');
    expect(adminSrc).not.toContain('sendEntriesToTrip');
    expect(adminSrc).not.toContain('transferToBreeding');
    expect(adminSrc).not.toContain('data-pig-send-bar');
    expect(adminSrc).not.toContain('canManagePigPlannedTrips');
  });
});
