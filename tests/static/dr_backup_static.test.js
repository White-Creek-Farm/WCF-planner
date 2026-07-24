import {describe, it, expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level safety guards for the DR backup runner. These are intentionally
// brittle: each one locks a property whose loss would be silent and dangerous
// (a readable PROD dump on disk, a leaked DSN, a half-configured upload). If a
// legitimate change trips one of these, update the guard in the same lane and
// say why.
const RUNNER = path.join(process.cwd(), 'scripts', 'dr_backup.cjs');
const LAYOUT = path.join(process.cwd(), 'scripts', 'lib', 'dr_layout.cjs');
const ORCH = path.join(process.cwd(), 'scripts', 'lib', 'dr_orchestrate.cjs');
const src = fs.readFileSync(RUNNER, 'utf8');
const layoutSrc = fs.readFileSync(LAYOUT, 'utf8');
// The upload ordering/retry/concurrency logic lives in the orchestration module
// and is proven behaviorally in tests/dr_orchestrate.test.js. These source
// guards over it are defence in depth, not the primary proof.
const orchSrc = fs.readFileSync(ORCH, 'utf8');

/**
 * Slice the source between two anchors, FAILING if either anchor is missing.
 * A plain indexOf that returns -1 would yield an empty string and make the
 * caller's assertion pass vacuously — a guard that silently stops guarding.
 */
function region(text, startAnchor, endAnchor) {
  const a = text.indexOf(startAnchor);
  const b = text.indexOf(endAnchor);
  expect(a, `anchor not found (guard is stale): ${startAnchor}`).toBeGreaterThan(-1);
  expect(b, `anchor not found (guard is stale): ${endAnchor}`).toBeGreaterThan(a);
  return text.slice(a, b);
}

describe('plaintext never reaches disk', () => {
  it('never passes an output-file flag to pg_dump', () => {
    // `-f <path>` or `--file=` would write a READABLE dump containing
    // auth.users emails and password hashes. The whole design forbids it.
    const call = region(src, "'pg_dump',", 'dump.stderr');
    expect(call).not.toMatch(/'-f'/);
    expect(call).not.toMatch(/--file/);
  });

  it('pipes pg_dump stdout directly into age rather than an intermediate file', () => {
    expect(src).toMatch(/dump\.stdout\.pipe\(enc\.stdin\)/);
  });

  it('only ever creates a write stream for the ciphertext path', () => {
    const writes = [...src.matchAll(/createWriteStream\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(writes).toEqual(['encPath']);
  });

  it('discards rather than stores the dump when no recipient is configured', () => {
    expect(src).toMatch(/dump\.stdout\.resume\(\)/);
  });

  it('does not spawn pg_dump through a shell, which could leak the DSN to a log', () => {
    expect(src).not.toMatch(/shell:\s*true/);
    expect(src).not.toMatch(/\bexec\(/);
  });
});

describe('pipeline integrity', () => {
  it('checks the pg_dump exit code, not only age', () => {
    // A pg_dump that dies partway still yields a VALID age file wrapping a
    // TRUNCATED dump, and age exits 0. Trusting age alone ships corrupt backups.
    expect(src).toMatch(/pg_dump exited/);
    expect(src).toMatch(/age exited/);
  });

  it('rejects an empty dump or empty ciphertext', () => {
    expect(src).toMatch(/plainBytes === 0/);
    expect(src).toMatch(/encBytes === 0/);
  });

  it('hashes both the plaintext stream and the ciphertext for the manifest', () => {
    expect(src).toMatch(/plainHash\.update/);
    expect(src).toMatch(/encHash\.update/);
  });
});

describe('cancellation cleanup', () => {
  // A real SIGTERM during development left a complete 2.3 MB PROD dump on disk,
  // because Node does not run finally blocks on signal death. CI cancellation
  // would do the same. Cleanup must be registered on exit AND on signals.
  it('registers cleanup on every terminating signal', () => {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
      expect(src).toContain(`'${sig}'`);
    }
  });

  it('registers cleanup on exit and on uncaughtException', () => {
    expect(src).toMatch(/process\.on\('exit',\s*cleanup\)/);
    expect(src).toMatch(/process\.on\('uncaughtException'/);
  });

  it('makes cleanup idempotent so double invocation cannot throw', () => {
    const c = region(orchSrc, 'function createCleanup', 'async function runPool');
    expect(c).toMatch(/if \(cleaned\) return;/);
  });

  it('still calls cleanup from the normal finally path', () => {
    expect(src).toMatch(/finally \{\s*cleanup\(\);/);
  });
});

describe('secret redaction', () => {
  it('builds a redaction list from every credential the runner holds', () => {
    for (const name of ['DR_B2_APPLICATION_KEY', 'DR_B2_KEY_ID', 'DR_R2_SECRET_ACCESS_KEY', 'DR_R2_ACCESS_KEY_ID']) {
      expect(src).toContain(name);
    }
    expect(src).toMatch(/const SECRETS = \[/);
  });

  it('routes child-process failures through redaction before printing', () => {
    // psql and the AWS CLI both echo credentials/endpoints on failure.
    expect(src).toMatch(/console\.error\(clean\(/);
    expect(src).toMatch(/clean\(e\.stderr\?\.toString\(\)/);
  });

  it('never prints error text or stderr without redacting it first', () => {
    // Refusal messages that print only literal config NAMES are fine. What must
    // never happen is emitting a caught error's message or a child's stderr raw,
    // because those carry the DSN and provider credentials.
    const prints = [...src.matchAll(/console\.error\(([\s\S]*?)\);\n/g)].map((m) => m[1]);
    const leaky = prints.filter((p) => /\.message|\.stderr/.test(p) && !/clean\(/.test(p));
    expect(leaky).toEqual([]);
  });

  it('redacts longest-first so a short secret cannot unmask a longer one', () => {
    expect(layoutSrc).toMatch(/sort\(\(a, b\) => b\.length - a\.length\)/);
  });
});

describe('execute mode is fail-closed', () => {
  it('defaults to dry run and requires an explicit --execute flag', () => {
    expect(src).toMatch(/const execute = flag\('execute'\)/);
    expect(src).toMatch(/DRY RUN \(uploads nothing\)/);
  });

  it('refuses execute unless EVERY provider value is present', () => {
    // A partial config could upload to one provider only — a single point of
    // failure that still reports success.
    expect(src).toMatch(/missingExecuteConfig\(process\.env\)/);
    expect(src).toMatch(/requires complete provider configuration/);
  });

  it('refuses execute without an S3-compatible client', () => {
    expect(src).toMatch(/needs the AWS CLI \(S3-compatible client\)/);
  });

  it('prints missing configuration by NAME only', () => {
    expect(src).toMatch(/names only; no value is ever printed/);
  });

  it('requires an explicit --env target with no default', () => {
    expect(src).toMatch(/no default target/);
  });
});

describe('provider write contract', () => {
  it('applies governance retention to B2 objects only', () => {
    expect(src).toMatch(/--object-lock-mode/);
    expect(src).toMatch(/GOVERNANCE/);
    expect(src).toMatch(/--object-lock-retain-until-date/);
    const putBody = region(src, 'function putObject', 'let exitCode');
    // The lock flags must sit inside the B2-only branch.
    expect(putBody).toMatch(/if \(isB2\) \{[\s\S]*--object-lock-mode/);
  });

  it('sends a Content-MD5 with B2 object-lock puts, which B2 requires', () => {
    // B2 rejects a Put Object that carries Object Lock parameters unless it also
    // has a Content-MD5 or x-amz-checksum-* header (InvalidRequest), and the
    // shared when_required checksum mode does not add one. The B2-only branch must
    // supply an explicit Content-MD5, before the object-lock flags.
    const putBody = region(src, 'function putObject', 'let exitCode');
    expect(putBody).toMatch(/if \(isB2\) \{[\s\S]*--content-md5[\s\S]*--object-lock-mode/);
    expect(putBody).toMatch(/createHash\('md5'\)/);
  });

  it('derives retention from the key rather than hardcoding one duration', () => {
    expect(src).toMatch(/retainUntilForKey\(key, new Date\(\)\)/);
  });

  it('never issues a delete, and needs no bypass capability', () => {
    // The B2 writer key deliberately lacks deleteFiles and bypassGovernance.
    expect(src).not.toMatch(/delete-object/);
    expect(src).not.toMatch(/delete-objects/);
    expect(src).not.toMatch(/BypassGovernanceRetention/);
    expect(src).not.toMatch(/bypass-governance/);
    expect(src).not.toMatch(/'rm'/);
  });

  it('works around R2 rejecting the AWS CLI default checksum', () => {
    expect(src).toMatch(/AWS_REQUEST_CHECKSUM_CALCULATION/);
  });

  it('passes credentials by environment, never on the command line', () => {
    // Command-line args are visible in process listings.
    expect(src).not.toMatch(/--access-key/);
    expect(src).not.toMatch(/--secret-key/);
    expect(src).toMatch(/AWS_ACCESS_KEY_ID:/);
  });
});

describe('manifest integrity', () => {
  it('records vault secrets by NAME and never by value', () => {
    expect(src).toMatch(/vault_secret_names/);
    expect(src).not.toMatch(/vault_secret_values/);
    expect(src).toMatch(/select name from vault\.secrets/);
  });

  it('stores only the public half of the encryption keypair', () => {
    expect(src).toMatch(/age_recipient/);
    expect(src).not.toMatch(/AGE-SECRET-KEY/);
  });

  it('records what a restore does NOT bring back', () => {
    expect(src).toMatch(/not_backed_up/);
    expect(src).toMatch(/cron_jobs/);
    expect(src).toMatch(/extensions/);
  });

  it('carries checksums for both plaintext and ciphertext', () => {
    expect(src).toMatch(/dump_sha256/);
    expect(src).toMatch(/encrypted_sha256/);
  });
});

describe('manifest never advances on partial failure', () => {
  it('separates payload, storage bodies, and manifests in the orchestration plan', () => {
    // The runner hands the orchestrator distinct payload/storageChanged/
    // manifests arrays; the manifest is both the authoritative record AND the
    // next run's diff input, so it must publish only after everything else.
    expect(src).toMatch(/payload,\s*\n\s*storageChanged:/);
    expect(src).toMatch(/manifests,/);
  });

  it('feeds an empty storage set to the orchestrator for a database-only run', () => {
    expect(src).toMatch(/storageChanged: databaseOnly \? \[\] : diff\.changed/);
  });

  it('sets a nonzero exit code when the orchestration result is not ok', () => {
    const exec = region(src, 'const res = await O.orchestrateUpload', '[4/4]');
    expect(exec).toMatch(/exitCode = 1/);
  });
});

describe('database-only runs cannot masquerade as complete backups', () => {
  it('refuses a full execute whose storage-source credential is incomplete', () => {
    expect(src).toMatch(/storage objects need transfer but the Supabase/);
    expect(src).toMatch(/pass --database-only to deliberately accept/);
  });

  it('records coverage in the manifest so a restorer need not read prose', () => {
    expect(src).toMatch(/coverage: databaseOnly \? 'database-only' : 'database-and-storage'/);
  });

  it('states plainly in output that files are not protected', () => {
    expect(src).toMatch(/files are NOT backed up|files NOT protected/);
  });
});

describe('retention contract is stated as immutability, not expiry', () => {
  it('does not claim an enforced generation count anywhere in the runner', () => {
    // The phrase may appear only inside an explicit do-NOT-claim warning.
    const lines = src.split(/\r?\n/).filter((l) => /48 hourly/.test(l));
    for (const l of lines) expect(l).toMatch(/not|Do not/);
    expect(src).toMatch(/stored INDEFINITELY/);
  });

  it('records the indefinite physical-retention fact in the manifest', () => {
    expect(src).toMatch(/physical_retention: L\.PHYSICAL_RETENTION/);
  });

  it('layout module declares indefinite physical retention with no enforced caps', () => {
    expect(layoutSrc).toMatch(/policy: 'indefinite'/);
    expect(layoutSrc).toMatch(/enforcedGenerationCaps: null/);
  });

  it('uses immutability wording rather than retention wording in the plan output', () => {
    expect(src).toMatch(/immutable \$\{L\.minImmutableDaysForKey\(p\.key\)\}d GOVERNANCE/);
  });
});

describe('provider preflight is non-destructive', () => {
  it('never issues a put, delete, or any write during preflight', () => {
    const pre = region(src, 'function runPreflight', 'function spawnTracked');
    expect(pre).not.toMatch(/put-object/);
    expect(pre).not.toMatch(/delete/);
    expect(pre).toMatch(/head-bucket/);
  });

  it('routes every preflight call through the read-only helper', () => {
    const pre = region(src, 'function runPreflight', 'function spawnTracked');
    const calls = [...pre.matchAll(/aws[A-Za-z]*\(/g)].map((m) => m[0]);
    expect(new Set(calls)).toEqual(new Set(['awsRead(']));
  });

  it('probes B2 with head-bucket, not account-level list-buckets or object listing', () => {
    // The B2 key holds listBuckets/writeFiles/writeFileRetentions only and is
    // bucket-scoped. B2 maps S3 ListBuckets to the account-level
    // listAllBucketNames capability, which this key lacks, so ListBuckets returns
    // "not entitled". HeadBucket on the specific bucket is satisfied by
    // listBuckets and is the correct read-only credential/bucket proof.
    const pre = region(src, 'function runPreflight', 'function spawnTracked');
    expect(pre).not.toMatch(/awsRead\('b2', \['list-buckets/);
    expect(pre).not.toMatch(/awsRead\('b2', \['list-objects/);
    expect(pre).toMatch(/awsRead\('b2', \['head-bucket/);
  });

  it('runs before the expensive dump so mistakes surface in seconds', () => {
    expect(src.indexOf('if (preflight)')).toBeLessThan(src.indexOf('await dumpAndEncrypt('));
  });

  it('is honest about what preflight CANNOT prove', () => {
    expect(src).toMatch(/CANNOT be verified before the first write/);
    expect(src).toMatch(/B2 writability/);
  });

  it('requires complete configuration just like execute', () => {
    expect(src).toMatch(/if \(execute \|\| preflight\)/);
  });
});

describe('TEST target is refused, not silently mis-connected', () => {
  // WCF_TEST_DATABASE is a boolean safety flag (=1), NOT a DSN. An earlier
  // version read it as a connection string, which would have built the literal
  // connection string "1". TEST has no PostgreSQL DSN at all -- the repo reaches
  // it through the Supabase client and exec_sql -- so pg_dump cannot target it.
  it('refuses --env=test explicitly', () => {
    expect(src).toMatch(/refusing: --env=test is not supported/);
    expect(src).toMatch(/TEST has no PostgreSQL DSN/);
  });

  it('never reads WCF_TEST_DATABASE as a connection string', () => {
    expect(src).not.toMatch(/DB_URL\s*=.*WCF_TEST_DATABASE/);
    expect(src).not.toMatch(/process\.env\.WCF_TEST_DATABASE\s*;/);
  });

  it('explains that the flag is not a DSN, so the next reader does not retry it', () => {
    expect(src).toMatch(/safety flag/);
  });

  it('loads only the PROD env file', () => {
    const loads = [...src.matchAll(/loadDotEnv\(path\.join\(root, ([^)]*)\)\)/g)].map((m) => m[1]);
    expect(loads).toEqual(["'.env.prod.local'"]);
  });
});

describe('storage body transfer: streaming, no staging', () => {
  it('pipes the source read straight into the destination write', () => {
    expect(src).toMatch(/src\.stdout\.pipe\(dest\.stdin\)/);
  });

  it('never writes an object body to disk', () => {
    // Only the ciphertext dump may ever hit a write stream.
    const writes = [...src.matchAll(/createWriteStream\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(writes).toEqual(['encPath']);
    const t = region(src, 'function streamOneObject', 'function supabaseEndpoint');
    expect(t).not.toMatch(/createWriteStream|writeFileSync|\.pipe\(fs\./);
  });

  it('asserts download-only BEFORE spawning anything', () => {
    const t = region(src, 'function streamOneObject', 'function supabaseEndpoint');
    expect(t.indexOf('assertSupabaseDownloadOnly')).toBeGreaterThan(-1);
    expect(t.indexOf('assertSupabaseDownloadOnly')).toBeLessThan(t.indexOf('spawnTracked'));
  });

  it('checks BOTH child exit codes, not just the destination', () => {
    const t = region(src, 'function streamOneObject', 'function supabaseEndpoint');
    expect(t).toMatch(/source read exited/);
    expect(t).toMatch(/dest write exited/);
  });

  it('runs two passes, one per provider, with distinct key layouts', () => {
    const t = region(orchSrc, 'async function orchestrateUpload', 'Phase 3');
    expect(t).toMatch(/for \(const provider of \['b2', 'r2'\]\)/);
    expect(t).toMatch(/L\.storageObjectKey\(provider, obj\.bucket, obj\.path, runId\)/);
  });

  it('sets B2 retention after upload, because s3 cp cannot carry lock headers', () => {
    expect(src).toMatch(/put-object-retention/);
    const t = region(orchSrc, 'async function orchestrateUpload', 'Phase 3');
    expect(t).toMatch(/ops\.setB2Retention/);
    // A failed retention set must fail the object, not be ignored.
    expect(t).toMatch(/throw new Error\(`retention/);
  });

  it('passes storage credentials by environment, never on a command line', () => {
    const t = region(src, 'function supabaseEnv', 'function streamOneObject');
    expect(t).toMatch(/AWS_ACCESS_KEY_ID:/);
    expect(t).not.toMatch(/--access-key|--secret/);
  });

  it('adds the storage credential to the redaction list', () => {
    expect(src).toMatch(/DR_STORAGE_S3_SECRET_ACCESS_KEY,/);
    expect(src).toMatch(/DR_STORAGE_S3_ACCESS_KEY_ID,/);
  });
});

describe('bounded concurrency and retry (orchestration module)', () => {
  it('bounds in-flight transfers to the declared concurrency', () => {
    const pool = region(orchSrc, 'async function runPool', 'async function withRetry');
    expect(pool).toMatch(/Math\.min\(limit, items\.length\)/);
  });

  it('retries a bounded number of times then fails terminally', () => {
    const r = region(orchSrc, 'async function withRetry', 'async function orchestrateUpload');
    expect(r).toMatch(/attempt <= attempts/);
    expect(r).toMatch(/failed after \$\{attempts\} attempts/);
    expect(r).toMatch(/L\.backoffMs\(attempt\)/);
  });

  it('does not retry forever or swallow the terminal error', () => {
    const r = region(orchSrc, 'async function withRetry', 'async function orchestrateUpload');
    expect(r).toMatch(/throw new Error/);
    expect(r).not.toMatch(/while \(true\)/);
  });
});

describe('cancellation terminates children', () => {
  it('tracks spawned children through the shared registry', () => {
    expect(src).toMatch(/const childRegistry = O\.createChildRegistry\(\)/);
    expect(src).toMatch(/function spawnTracked/);
    expect(src).toMatch(/childRegistry\.track\(spawn\(/);
  });

  it('the registry kills every tracked child with SIGKILL', () => {
    const reg = region(orchSrc, 'function createChildRegistry', 'function createCleanup');
    expect(reg).toMatch(/killAll\(signal = 'SIGKILL'\)/);
    expect(reg).toMatch(/c\.kill\(signal\)/);
  });

  it('spawns transfer children through the tracked helper, not raw spawn', () => {
    const t = region(src, 'function streamOneObject', 'function supabaseEndpoint');
    expect(t).toMatch(/spawnTracked\(/);
    expect(t).not.toMatch(/[^d]\bspawn\('aws'/);
  });

  it('cleanup kills children BEFORE removing files (createCleanup ordering)', () => {
    const c = region(orchSrc, 'function createCleanup', 'async function runPool');
    expect(c.indexOf('killChildren()')).toBeGreaterThan(-1);
    expect(c.indexOf('killChildren()')).toBeLessThan(c.indexOf('removeWorkDir()'));
    // and the runner wires kill -> childRegistry.killAll
    expect(src).toMatch(/killChildren: \(\) => childRegistry\.killAll\(\)/);
  });
});

describe('partial transfer must not advance the baseline (orchestration module)', () => {
  it('publishes manifests strictly after payload and storage phases', () => {
    // Phase order in source: payload -> storage -> manifests.
    expect(orchSrc.indexOf('Phase 1')).toBeLessThan(orchSrc.indexOf('Phase 2'));
    expect(orchSrc.indexOf('Phase 2')).toBeLessThan(orchSrc.indexOf('Phase 3'));
  });

  it('returns without publishing manifests on a storage failure', () => {
    const t = region(orchSrc, 'Phase 2', 'Phase 3');
    expect(t).toMatch(/manifestsUploaded: false/);
    expect(t).toMatch(/failedAt: 'storage'/);
  });

  it('increments transferred only after BOTH providers succeed', () => {
    const t = region(orchSrc, 'async function orchestrateUpload', 'Phase 3');
    // transferred++ sits after the provider loop closes, with a comment saying so.
    expect(t).toMatch(/One provider succeeding must never count[\s\S]*?transferred\+\+;/);
  });

  it('the runner treats a non-ok orchestration result as a failed run', () => {
    expect(src).toMatch(/if \(res\.ok\) \{[\s\S]*?\} else \{[\s\S]*?exitCode = 1/);
    expect(src).toMatch(/ABORT at \$\{res\.failedAt\}/);
  });
});

describe('row-level-security flag is prohibited', () => {
  it('never passes --enable-row-security to pg_dump', () => {
    // That flag turns a loud RLS failure into a SILENT partial dump.
    expect(src).not.toMatch(/--enable-row-security/);
    expect(src).not.toMatch(/enable_row_security/);
  });
});

describe('execute proceed/refuse is delegated to the pure decision function', () => {
  // The wrong-boolean bug that once blocked every full execute lived in a
  // hand-rolled condition. The rule now lives in L.decideExecution, which is
  // tested behaviorally (tests/dr_layout.test.js). These guards only prove the
  // runner delegates to it and acts on the result.
  it('computes the decision via L.decideExecution with the live inputs', () => {
    expect(src).toMatch(/L\.decideExecution\(\{/);
    expect(src).toMatch(/mode: execute \? 'execute' : 'dry-run'/);
    expect(src).toMatch(/changedCount: diff\.changed\.length/);
  });

  it('refuses only on the decision, naming the missing source vars', () => {
    const guard = region(src, "decision.phase === 'refuse'", 'incremental:');
    expect(guard).toMatch(/decision\.missing\.join/);
    expect(guard).toMatch(/process\.exit\(2\)/);
  });

  it('carries no stale claim that body upload is unimplemented', () => {
    expect(src).not.toMatch(/body upload is not implemented|BODIES are not transferred yet/);
  });
});
