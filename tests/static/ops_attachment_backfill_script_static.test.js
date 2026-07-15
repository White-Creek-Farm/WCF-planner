import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static contract for the CC#7 ordinary-attachment operator script. The script
// is the ONLY sanctioned caller of the deployed processing-asana-sync
// attachment actions from an operator shell, so its safety envelope is locked:
// two reachable actions, typed write confirmation, lifecycle sign-out in a
// finally path, and no secret/token/URL leakage in output.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'scripts/ops_processing_attachment_backfill.cjs'), 'utf8');

describe('ops attachment script — action surface', () => {
  it('allows exactly the two attachment actions and nothing else', () => {
    expect(src).toContain("new Set(['attachment_dry_run', 'attachment_backfill'])");
    expect(src).toMatch(/if \(!ALLOWED_ACTIONS\.has\(ACTION\)\)/);
    // No other Edge action name is reachable or even mentioned as a value.
    for (const forbidden of [
      "'sync_once'",
      "'sync_since'",
      "'sync_comments'",
      "'sync_comment_media'",
      "'sync_artifacts'",
      "'sync_activity'",
      "'sync_review_queue'",
      "'import_templates'",
      "'import_templates_dry_run'",
      "'sync_planner_to_processing'",
      "'destination_audit'",
    ]) {
      expect(src).not.toContain(forbidden);
    }
    // The default action is the read-only dry run.
    expect(src).toContain("args.action || 'attachment_dry_run'");
    // Exactly one Edge invocation, with exactly the requested action.
    expect(src.match(/functions\/v1/g)).toHaveLength(1);
    expect(src).toContain("JSON.stringify({mode: 'admin', action: ACTION})");
  });

  it('requires the typed second confirmation for the backfill write', () => {
    expect(src).toMatch(/ACTION === 'attachment_backfill' && \(args\.confirm \|\| ''\) !== 'attachment_backfill'/);
  });

  it('requires an explicit --env with TEST refusing the PROD ref', () => {
    expect(src).toContain("if (ENV !== 'test' && ENV !== 'prod') usageFail");
    expect(src).toContain("process.env.WCF_TEST_DATABASE !== '1' || url.includes(PROD_REF)");
  });
});

describe('ops attachment script — session lifecycle', () => {
  it('signs the temporary session out inside a finally covering every post-auth outcome', () => {
    // Anchor on the lifecycle block, not fetchJson's internal try/finally.
    const lifecycleStart = src.indexOf('// Everything after authentication runs under a finally');
    expect(lifecycleStart).toBeGreaterThan(-1);
    const tryIdx = src.indexOf('try {', lifecycleStart);
    const finallyIdx = src.indexOf('} finally {', tryIdx);
    expect(tryIdx).toBeGreaterThan(-1);
    expect(finallyIdx).toBeGreaterThan(tryIdx);
    // The admin preflight and the single Edge invocation are inside the try.
    const tryBody = src.slice(tryIdx, finallyIdx);
    expect(tryBody).toContain('rpc/is_admin');
    expect(tryBody).toContain('functions/v1');
    // The sign-out call is inside the finally, best-effort, status-word only.
    const finallyBody = src.slice(finallyIdx);
    expect(finallyBody).toContain('signoutUrl');
    expect(finallyBody).toContain("method: 'POST'");
    expect(finallyBody).toMatch(/session sign-out: \$\{signedOut\}/);
    expect(finallyBody).toContain("'failed (non-fatal)'");
  });
});

describe('ops attachment script — no secret output', () => {
  it('never prints tokens, keys, magic-link material, or raw URLs', () => {
    // Every console output line is inspected: none may interpolate a secret-
    // bearing variable.
    const outputCalls = src.match(/console\.(log|error)\([^;]*\);/g) || [];
    expect(outputCalls.length).toBeGreaterThan(0);
    for (const call of outputCalls) {
      expect(call).not.toMatch(/accessToken|serviceKey|anonKey|tokenHash|emailOtp|action_link|refresh_token|password/);
    }
    // Emails are masked before printing.
    expect(src).toContain('maskEmail(adminEmail)');
    // Server error text is sanitized (JWT / token-query / storage-URL redaction)
    // and truncated before printing.
    expect(src).toMatch(/\[REDACTED-JWT\]/);
    expect(src).toMatch(/\[REDACTED-STORAGE-URL\]/);
    expect(src).toContain('sanitize(body.error)');
    expect(src).toContain('sanitize(fn.text)');
    // Only whitelisted count fields from the Edge payload are ever echoed.
    expect(src).toMatch(/const COUNT_KEYS = \[/);
    expect(src).toContain('if (payload[k] !== undefined) counts[k] = payload[k];');
  });

  it('preserves nonzero exit on error/partial responses', () => {
    expect(src).toMatch(
      /counts\.errors === 'number'\) && counts\.errors > 0|counts\.errors === 'number' && counts\.errors > 0/,
    );
    expect(src).toContain('counts.bucketReady === false');
    expect(src).toContain('process.exitCode = 1');
  });
});
