import {describe, it, expect} from 'vitest';
import {readFileSync} from 'fs';
import {fileURLToPath} from 'url';
import {dirname, join} from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const runner = readFileSync(join(here, '..', '..', 'scripts', 'dr_restore.cjs'), 'utf8');

function region(text, startMarker, endMarker) {
  const a = text.indexOf(startMarker);
  const b = endMarker ? text.indexOf(endMarker, a + 1) : text.length;
  return text.slice(a, b === -1 ? text.length : b);
}
const idx = (s) => runner.indexOf(s);

describe('source is R2 only; write-focused B2 key never touched', () => {
  it('does not use the B2 writer credential or bucket', () => {
    expect(runner).not.toMatch(/DR_B2_KEY_ID|DR_B2_APPLICATION_KEY|backblazeb2|primary-2026|awsEnvFor\('b2'\)/i);
  });
  it('pins the R2 source through assertR2Source and reads R2 read-only', () => {
    expect(runner).toMatch(/RL\.assertR2Source\(/);
    expect(runner).toMatch(/R2_READ_OPS = Object\.freeze\(\['get-object', 'head-object', 'list-objects-v2'\]\)/);
    for (const op of ['put-object', 'delete-object', 'copy-object', 'delete-bucket'])
      expect(runner).not.toMatch(new RegExp(op));
  });
});

describe('secrets: paths not values, dsn + password registered independently, redaction mandatory', () => {
  it('registers the full DSN and the decoded password separately before any subprocess', () => {
    expect(runner).toMatch(/registerSecret\(cfg\.dsn\)/);
    expect(runner).toMatch(/registerSecret\(out\.dsnPassword\)/);
    // Registration happens in loadRecoveryConfig, which runs before runDbRestore.
    expect(idx('registerSecret(out.dsnPassword)')).toBeLessThan(runner.lastIndexOf('runDbRestore('));
  });
  it('routes all error output through clean() secret redaction', () => {
    expect(runner).toMatch(/const clean = \(t\) => RL\.redactSecrets\(t, SECRET_VALUES\)/);
    expect(runner).toMatch(/function refuse\(msg[^)]*\)\s*\{[\s\S]*clean\(/);
  });
  it('passes the DB password to pg_restore via PGPASSWORD env, never on argv', () => {
    const pa = region(runner, 'function pgRestoreApply', 'function runDbRestore');
    expect(pa).toMatch(/PGPASSWORD: dsnPassword/);
    expect(pa).toMatch(/--dbname/);
    // The argv array itself must carry neither the full DSN nor the password
    // (cfg.dsn is only parsed via new URL(...) to derive host/port/user).
    const argsDecl = pa.slice(pa.indexOf('const args'), pa.indexOf('spawnSync'));
    expect(argsDecl).not.toMatch(/dsnPassword|cfg\.dsn/);
  });
  it('handles the age identity by PATH only and never reads it', () => {
    expect(runner).toMatch(/age-identity/);
    expect(runner).toMatch(/age', \['-d', '-i', ageIdentityPath/);
    expect(runner).not.toMatch(/readFileSync\([^)]*age/i);
  });
});

describe('external secret-file containment is symlink/junction/case safe', () => {
  it('canonicalises repo + supplied paths with realpath and uses pathIsInside', () => {
    expect(runner).toMatch(/fs\.realpathSync/);
    expect(runner).toMatch(/RL\.pathIsInside\(real, REPO_REAL\)/);
    const rp = region(runner, 'function resolveExternalPath', 'function readSecretFile');
    expect(rp).toMatch(/must live OUTSIDE the repository/);
  });
});

describe('generation is explicit — no latest', () => {
  it('pins the generation via requireExplicitGeneration', () => {
    expect(runner).toMatch(/RL\.requireExplicitGeneration\(arg\('generation'/);
  });
});

describe('destination + dual-manifest verification precede any restore', () => {
  it('guards the destination and pins R2 before the DB restore', () => {
    expect(runner).toMatch(/RL\.assertRecoveryDestination\(/);
    expect(idx('loadRecoveryConfig')).toBeLessThan(runner.lastIndexOf('runDbRestore('));
  });
  it('fetches BOTH manifests and requires exact agreement in preflight', () => {
    const pf = region(runner, 'async function runPreflight', 'function statAndHash');
    expect(pf).toMatch(/keys\.dbManifest/);
    expect(pf).toMatch(/keys\.storageManifest/);
    expect(pf).toMatch(/RL\.assertManifestsAgree\(dbManifest, storageManifest\)/);
    expect(pf).toMatch(/RL\.assertSha256\(enc\.sha256, dbManifest\.database\.encrypted_sha256/);
  });
  it('runs preflight before the execute-mode DB restore', () => {
    expect(idx('await runPreflight(')).toBeLessThan(runner.lastIndexOf('runDbRestore('));
  });
});

describe('encrypted-volume confirmation + C:-only plaintext + restricted ACL', () => {
  it('requires the explicit device-encryption confirmation before decryption', () => {
    const dr = region(runner, 'async function runDbRestore', '(async () =>');
    expect(dr).toMatch(/assertEncryptedVolumeVerified\(\)/);
    expect(idx('assertEncryptedVolumeVerified()')).toBeLessThan(idx('streamDecryptToFile('));
    const conf = region(runner, 'function assertEncryptedVolumeVerified', 'function prepareRestoreDir');
    expect(conf).toMatch(/DEVICE ENCRYPTION VERIFIED ON C:/);
  });
  it('confines plaintext to a randomized C: dir and refuses a stale prior run', () => {
    const pd = region(runner, 'function prepareRestoreDir', 'async function runPreflight');
    expect(pd).toMatch(/RL\.assertPlaintextLocation\(/);
    expect(pd).toMatch(/stale restore directory/);
    expect(pd).toMatch(/wcf-restore-/);
  });
  it('removes inheritance and grants only this account + SYSTEM via icacls', () => {
    const pd = region(runner, 'function prepareRestoreDir', 'async function runPreflight');
    expect(pd).toMatch(/icacls/);
    expect(pd).toMatch(/\/inheritance:r/);
    expect(pd).toMatch(/SYSTEM:\(OI\)\(CI\)F/);
  });
});

describe('checksum-before-restore ordering + selective TOC policy', () => {
  it('verifies byte count + sha256 BEFORE building/applying the restore', () => {
    const dr = region(runner, 'async function runDbRestore', '(async () =>');
    expect(dr).toMatch(/RL\.assertByteCount\(bytes, manifest\.database\.dump_bytes/);
    expect(dr).toMatch(/RL\.assertSha256\(sha256, manifest\.database\.dump_sha256/);
    expect(dr.indexOf('assertByteCount')).toBeLessThan(dr.indexOf('buildSelectiveRestoreList'));
    expect(dr.indexOf('buildSelectiveRestoreList')).toBeLessThan(dr.indexOf('pgRestoreApply('));
  });
  it('builds + re-validates the selective list, refusing managed DDL, before connecting', () => {
    const dr = region(runner, 'async function runDbRestore', '(async () =>');
    expect(dr).toMatch(/RL\.buildSelectiveRestoreList\(/);
    expect(dr).toMatch(/validateGeneratedList\(/);
    expect(dr.indexOf('validateGeneratedList(')).toBeLessThan(dr.indexOf('pgRestoreApply('));
    const vg = region(runner, 'function validateGeneratedList', 'function pgRestoreApply');
    expect(vg).toMatch(/MANAGED_SCHEMAS/);
    expect(vg).toMatch(/managed .* DDL/);
  });
});

describe('plaintext cleanup runs on every exit path', () => {
  it('cleans up in a finally and on exit/signals/uncaught', () => {
    const dr = region(runner, 'async function runDbRestore', '(async () =>');
    expect(dr).toMatch(/finally\s*\{[\s\S]*cleanupPlaintext\(dir\)/);
    expect(runner).toMatch(/process\.on\('exit', \(\) => cleanupPlaintext\(ACTIVE_PLAINTEXT_DIR\)\)/);
    expect(runner).toMatch(/for \(const sig of \['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'\]\)/);
    expect(runner).toMatch(/process\.on\('uncaughtException'/);
  });
  it('documents BitLocker as the at-rest guarantee (SSD overwrite not guaranteed)', () => {
    expect(runner).toMatch(/BitLocker/);
    expect(runner).toMatch(/SSD overwrite cannot be guaranteed|overwrite is not\s*\n?\s*\/\/ guaranteed|SSD/);
  });
});

describe('fail-closed tool + Phase-1 posture', () => {
  it('requires aws + age + pg_restore on PATH and installs nothing', () => {
    expect(runner).toMatch(/hasBinary\('aws'\)/);
    expect(runner).toMatch(/hasBinary\('age'\)/);
    expect(runner).toMatch(/hasBinary\('pg_restore'\)/);
    expect(runner).not.toMatch(/apt-get install|winget install|npm install .*aws/);
  });
  it('states the Phase 2 design contract in the header', () => {
    const header = region(runner, '// Disaster-recovery ISOLATED RESTORE runner', "'use strict'");
    expect(header).toMatch(/SELECTIVE/);
    expect(header).toMatch(/never Supabase-managed/i);
    expect(header).toMatch(/Cleanup runs on EVERY exit/);
    expect(header).toMatch(/never (read into this process|read here)|never read/i);
  });
});
