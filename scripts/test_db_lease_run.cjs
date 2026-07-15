#!/usr/bin/env node
// ============================================================================
// scripts/test_db_lease_run.cjs — GitHub-held TEST database lease wrapper
// ============================================================================
// PROBLEM: GitHub CI serializes its DB-touching jobs through the workflow
// concurrency group wcf-test-db (.github/workflows/ci.yml), but a LOCAL
// Playwright run is invisible to that group. Local and CI runs can therefore
// truncate-and-reseed the same shared TEST database at the same time.
//
// SOLUTION: before running a local TEST-backed command, this wrapper
// dispatches .github/workflows/test-db-lease.yml (workflow_dispatch, same
// wcf-test-db concurrency group, cancel-in-progress: false). GitHub itself
// then arbitrates: while CI holds the group the lease run stays queued and
// the local command WAITS; once the lease run is in_progress, CI runs queue
// behind it. The wrapper only starts the child command after its lease run is
// actually in_progress, monitors that the lease stays held while the child
// runs, and cancels the lease run in finally (cancellation IS the normal
// release; the workflow's bounded sleep is only the crash safety net).
//
// USAGE (command after `--` is required):
//   node scripts/test_db_lease_run.cjs -- npx playwright test tests/processing_calendar.spec.js
//   node scripts/test_db_lease_run.cjs -- npm run test:e2e
//   node scripts/test_db_lease_run.cjs --hold-minutes 45 -- npx playwright test tests/smoke.spec.js
//   npm run test:e2e:leased -- npx playwright test tests/smoke.spec.js
//     (the npm script form supports no wrapper flags before `--`; use the
//      direct node form when you need --hold-minutes / --acquire-minutes / --ref)
//
// FLAGS (before `--`):
//   --hold-minutes <n>     lease auto-expiry passed to the workflow (default 90, workflow clamps 1-120)
//   --acquire-minutes <n>  max minutes to wait for the lease to become in_progress (default 45)
//   --ref <branch>         branch to dispatch the workflow from (default: repo default branch)
//
// EXIT CODES:
//   child's own exit code  child ran to completion under a held lease (pass or fail)
//   2  usage / env-guard / gh-auth failure (nothing dispatched, or dispatch failed)
//   3  lease never acquired: displaced, cancelled, failed, or acquisition timeout
//   4  lease lost while the child was running (child was terminated; results suspect)
//   5  child succeeded but the lease release could NOT be verified — cancel it
//      manually (gh run cancel <id>) or CI stays blocked until the hold expires
//
// FAILURE MODES / ONE-PENDING-RUN SEMANTICS:
//   - GitHub keeps only ONE pending run per concurrency group. A pending
//     lease displaced by a newer queued run completes as 'cancelled' with
//     zero jobs; the wrapper sees "completed before ever in_progress" and
//     fails closed (exit 3) — it never runs the child unleased.
//   - Two local lease requests can never both proceed: the second either
//     waits queued behind the first (starting only after the first releases)
//     or displaces the first pending lease, which then fails closed.
//   - An active CI run means the lease waits its acquisition timeout, not
//     bypasses. An in_progress local lease keeps subsequent CI runs queued.
//   - If lease state polling fails repeatedly while the child runs, the
//     wrapper cannot prove it still owns the DB window and fails closed
//     (kills the child, exit 4).
//   - A timed-out or errored dispatch may still have CREATED the run. The
//     cleanup path polls a bounded window for the uniquely named run, cancels
//     it if it appears, and verifies it reaches a terminal state — warning
//     loudly when that cannot be verified.
//
// SAFETY:
//   - SIGINT/SIGTERM are handled across the ENTIRE lease lifecycle —
//     dispatch, run discovery, queued acquisition, child execution, and
//     release verification. Discovery/acquisition waits are interruptible;
//     a signal unwinds them into the normal finally cleanup (cancel + verify,
//     or the bounded orphan sweep when no run id is known yet). Repeated
//     Ctrl+C does not skip lease cleanup; cleanup itself is time-bounded.
//   - Loads .env.test / .env.test.local (repo root, then the main-worktree
//     fallback like other scripts here) WITHOUT printing any values.
//   - Refuses to run unless WCF_TEST_DATABASE=1 and VITE_SUPABASE_URL does
//     not match the PROD project ref (mirrors tests/setup/assertTestDatabase.js;
//     tests/static/test_db_lease_static.test.js locks the constants together).
//   - Needs no Supabase secrets itself; it only reads the URL and the flag.
//   - Every gh call and the child use spawn with an argument ARRAY and
//     shell: false — no command-string interpolation anywhere.
//
// Unit tests: tests/test_db_lease_run.test.js (DB-free, injected io).
// Static guard: tests/static/test_db_lease_static.test.js.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {spawn, spawnSync} = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_FILE = 'test-db-lease.yml';
const RUN_NAME_PREFIX = 'TEST DB lease ';
// Mirror of tests/setup/assertTestDatabase.js (ESM — not require()-able from
// this CJS script). The static guard asserts the two literals stay identical.
const PROD_PROJECT_REF = 'pzfujbjtayhkdlxiblwe';

const EXIT = {
  usage: 2,
  acquireFailed: 3,
  leaseLost: 4,
  releaseUnverified: 5,
};

const DEFAULTS = {
  holdMinutes: 90,
  acquireTimeoutMs: 45 * 60 * 1000,
  appearTimeoutMs: 2 * 60 * 1000,
  releaseTimeoutMs: 3 * 60 * 1000,
  appearPollMs: 3000,
  acquirePollMs: 5000,
  monitorPollMs: 15000,
  monitorMaxConsecutiveErrors: 5,
  ghCallTimeoutMs: 30000,
  orphanSweepTimeoutMs: 30000,
};

class LeaseError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'LeaseError';
    this.exitCode = exitCode;
  }
}

// --- argument parsing -------------------------------------------------------

function parseArgs(argv) {
  const options = {
    holdMinutes: DEFAULTS.holdMinutes,
    acquireTimeoutMs: DEFAULTS.acquireTimeoutMs,
    ref: null,
  };
  const separator = argv.indexOf('--');
  if (separator === -1) {
    throw new LeaseError(
      'Usage: node scripts/test_db_lease_run.cjs [--hold-minutes n] [--acquire-minutes n] [--ref branch] -- <command...>\n' +
        'An explicit command after -- is required.',
      EXIT.usage,
    );
  }
  const flagTokens = argv.slice(0, separator);
  const command = argv.slice(separator + 1);
  if (command.length === 0) {
    throw new LeaseError('No command given after --. Refusing to hold a lease with nothing to run.', EXIT.usage);
  }
  if (command[0].startsWith('--')) {
    throw new LeaseError(
      `Command after -- starts with a flag (${command[0]}). Wrapper flags go BEFORE the --, ` +
        'and the npm script form supports no wrapper flags — use: node scripts/test_db_lease_run.cjs <flags> -- <command...>',
      EXIT.usage,
    );
  }
  for (let i = 0; i < flagTokens.length; i += 1) {
    const flag = flagTokens[i];
    const takeValue = () => {
      const value = flagTokens[i + 1];
      if (value === undefined) throw new LeaseError(`Flag ${flag} needs a value.`, EXIT.usage);
      i += 1;
      return value;
    };
    if (flag === '--hold-minutes') {
      options.holdMinutes = parsePositiveInt(flag, takeValue());
    } else if (flag === '--acquire-minutes') {
      options.acquireTimeoutMs = parsePositiveInt(flag, takeValue()) * 60 * 1000;
    } else if (flag === '--ref') {
      options.ref = takeValue();
    } else {
      throw new LeaseError(`Unknown flag before --: ${flag}`, EXIT.usage);
    }
  }
  return {options, command};
}

function parsePositiveInt(flag, raw) {
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new LeaseError(`Flag ${flag} needs a positive integer, got: ${raw}`, EXIT.usage);
  }
  return Number(raw);
}

// --- TEST env loading + PROD refusal ----------------------------------------

function loadDotEnv(file, env) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[match[1]] === undefined) env[match[1]] = value;
  }
  return true;
}

function loadTestEnv(env, log) {
  // Same lookup order as the apply_test_mig_* scripts: this worktree first,
  // then the main worktree (fresh worktrees do not carry ignored credentials).
  const candidates = [
    path.join(REPO_ROOT, '.env.test'),
    path.join(REPO_ROOT, '.env.test.local'),
    path.join(REPO_ROOT, '..', 'WCF-planner', '.env.test'),
    path.join(REPO_ROOT, '..', 'WCF-planner', '.env.test.local'),
  ];
  for (const file of candidates) {
    if (loadDotEnv(file, env)) log(`Loaded env file: ${file}`);
  }
}

function assertTestEnvSafe(env) {
  if (env.WCF_TEST_DATABASE !== '1') {
    throw new LeaseError(
      'WCF_TEST_DATABASE is not exactly "1". Refusing to lease/run TEST-backed commands. ' +
        'Set WCF_TEST_DATABASE=1 in .env.test.local to acknowledge a non-production Supabase target.',
      EXIT.usage,
    );
  }
  const url = env.VITE_SUPABASE_URL;
  if (typeof url !== 'string' || url.length === 0) {
    throw new LeaseError('VITE_SUPABASE_URL is missing from the TEST environment.', EXIT.usage);
  }
  if (url.includes(PROD_PROJECT_REF)) {
    throw new LeaseError(
      `VITE_SUPABASE_URL matches the PRODUCTION project ref "${PROD_PROJECT_REF}". ` +
        'This wrapper is for the shared TEST database only. Refusing to run.',
      EXIT.usage,
    );
  }
}

// --- lease identity ----------------------------------------------------------

function generateLeaseId(nowMs = Date.now(), randomHex = crypto.randomBytes(6).toString('hex'), pid = process.pid) {
  return `lease-${nowMs}-${randomHex}-${pid}`;
}

// Pure: exactly-one matching run or a hard failure. Zero matches returns null
// (caller keeps polling until its appearance timeout). Identity is the EXACT
// run title RUN_NAME_PREFIX + leaseId — never substring matching, so a lease
// id that happens to be a prefix of another can never claim the wrong run.
function findUniqueLeaseRun(runs, leaseId) {
  const expectedTitle = RUN_NAME_PREFIX + leaseId;
  const matches = (runs || []).filter((run) => run.displayTitle === expectedTitle);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new LeaseError(
      `Found ${matches.length} workflow runs matching lease id ${leaseId}; cannot establish unique ownership.`,
      EXIT.acquireFailed,
    );
  }
  return matches[0];
}

// Signal-driven abort: waits check this each iteration so Ctrl+C during
// dispatch/discovery/acquisition unwinds into the normal finally cleanup
// instead of exiting with a pending lease left behind.
function createAbortFlag() {
  let aborted = false;
  let reason = null;
  return {
    get aborted() {
      return aborted;
    },
    get reason() {
      return reason;
    },
    trigger(r) {
      if (!aborted) {
        aborted = true;
        reason = r;
      }
    },
  };
}

function throwIfAborted(abort) {
  if (abort && abort.aborted) {
    const error = new LeaseError(`Interrupted (${abort.reason}); proceeding to lease cleanup.`, EXIT.usage);
    error.interrupted = true;
    throw error;
  }
}

// --- gh orchestration (io-injected for DB-free unit tests) -------------------
// io = {gh(args) -> {code, stdout, stderr}, sleep(ms), now(), log(msg), warn(msg)}

async function verifyGhAuth(io) {
  const result = await io.gh(['auth', 'status']);
  if (result.code !== 0) {
    throw new LeaseError('GitHub CLI is not authenticated (gh auth status failed). Run: gh auth login', EXIT.usage);
  }
}

async function dispatchLease(io, {leaseId, holdMinutes, ref}) {
  const args = ['workflow', 'run', WORKFLOW_FILE, '-f', `lease_id=${leaseId}`, '-f', `hold_minutes=${holdMinutes}`];
  if (ref) args.push('--ref', ref);
  const result = await io.gh(args);
  if (result.code !== 0) {
    throw new LeaseError(
      `Failed to dispatch ${WORKFLOW_FILE} (gh exit ${result.code}): ${(result.stderr || '').trim()}`,
      EXIT.usage,
    );
  }
}

async function listLeaseRuns(io) {
  const result = await io.gh([
    'run',
    'list',
    '--workflow',
    WORKFLOW_FILE,
    '--json',
    'databaseId,displayTitle,status,conclusion',
    '--limit',
    '30',
  ]);
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

async function waitForLeaseRun(
  io,
  leaseId,
  {timeoutMs = DEFAULTS.appearTimeoutMs, pollMs = DEFAULTS.appearPollMs, abort} = {},
) {
  const deadline = io.now() + timeoutMs;
  for (;;) {
    throwIfAborted(abort);
    const runs = await listLeaseRuns(io);
    if (runs) {
      const run = findUniqueLeaseRun(runs, leaseId);
      if (run) return run;
    }
    if (io.now() >= deadline) {
      throw new LeaseError(
        `Dispatched lease ${leaseId} but its workflow run never appeared within ${Math.round(timeoutMs / 1000)}s.`,
        EXIT.acquireFailed,
      );
    }
    await io.sleep(pollMs);
  }
}

async function getRunState(io, runId) {
  const result = await io.gh(['run', 'view', String(runId), '--json', 'status,conclusion']);
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

async function waitForAcquisition(
  io,
  runId,
  {timeoutMs = DEFAULTS.acquireTimeoutMs, pollMs = DEFAULTS.acquirePollMs, abort} = {},
) {
  const deadline = io.now() + timeoutMs;
  for (;;) {
    throwIfAborted(abort);
    const state = await getRunState(io, runId);
    if (state) {
      if (state.status === 'in_progress') return;
      if (state.status === 'completed') {
        // Fail closed: the lease ended before we ever held it. With
        // cancel-in-progress: false the usual cause is displacement — GitHub
        // keeps one pending run per concurrency group and a newer queued run
        // cancelled ours (conclusion 'cancelled', zero jobs).
        throw new LeaseError(
          `Lease run ${runId} completed (conclusion: ${state.conclusion || 'unknown'}) before it was ever ` +
            'in_progress — displaced by another queued run, cancelled, or failed. Not running the command unleased.',
          EXIT.acquireFailed,
        );
      }
    }
    if (io.now() >= deadline) {
      throw new LeaseError(
        `Lease run ${runId} did not reach in_progress within ${Math.round(timeoutMs / 60000)} minute(s). ` +
          'CI is likely holding the TEST DB; try again later or raise --acquire-minutes.',
        EXIT.acquireFailed,
      );
    }
    await io.sleep(pollMs);
  }
}

// Polls the lease run while the child runs. Calls onLost(reason) once if the
// run leaves in_progress or its state is unverifiable for too long. Returns a
// handle with stop() and a done promise.
function startLeaseMonitor(
  io,
  runId,
  {pollMs = DEFAULTS.monitorPollMs, maxConsecutiveErrors = DEFAULTS.monitorMaxConsecutiveErrors} = {},
  onLost,
) {
  let stopped = false;
  const done = (async () => {
    let consecutiveErrors = 0;
    for (;;) {
      await io.sleep(pollMs);
      if (stopped) return;
      const state = await getRunState(io, runId);
      if (stopped) return;
      if (!state) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= maxConsecutiveErrors) {
          onLost(`lease state unverifiable after ${consecutiveErrors} consecutive polling failures — failing closed`);
          return;
        }
        continue;
      }
      consecutiveErrors = 0;
      if (state.status !== 'in_progress') {
        onLost(`lease run left in_progress (status: ${state.status}, conclusion: ${state.conclusion || 'none'})`);
        return;
      }
    }
  })();
  return {
    stop() {
      stopped = true;
    },
    done,
  };
}

// Cancel is the NORMAL release path. Tolerates cancel failing when the run is
// already terminal; then verifies the run actually reaches 'completed' within
// a bounded window. Returns true only when terminal state was observed.
async function releaseLease(io, runId, {timeoutMs = DEFAULTS.releaseTimeoutMs, pollMs = DEFAULTS.acquirePollMs} = {}) {
  await io.gh(['run', 'cancel', String(runId)]);
  const deadline = io.now() + timeoutMs;
  for (;;) {
    const state = await getRunState(io, runId);
    if (state && state.status === 'completed') return true;
    if (io.now() >= deadline) return false;
    await io.sleep(pollMs);
  }
}

// Cleanup for the "dispatched but no run id known" path (dispatch error/
// timeout, signal during discovery, discovery timeout). A gh dispatch that
// errored may still have CREATED the run, and it can take a few seconds to
// appear — so poll a bounded window for the exactly named run; if it appears,
// cancel it and verify it reaches a terminal state. Returns one of:
//   'none-found'  no matching run appeared within the sweep window
//   'cancelled'   run found, cancelled, terminal state verified
//   'unverified'  run found + cancel issued, but terminal state not observed
//   'ambiguous'   more than one exactly matching run (should be impossible)
async function sweepOrphanLease(
  io,
  leaseId,
  {timeoutMs = DEFAULTS.orphanSweepTimeoutMs, pollMs = DEFAULTS.appearPollMs} = {},
) {
  const deadline = io.now() + timeoutMs;
  for (;;) {
    const runs = await listLeaseRuns(io);
    if (runs) {
      let run = null;
      try {
        run = findUniqueLeaseRun(runs, leaseId);
      } catch {
        return 'ambiguous';
      }
      if (run) {
        const verified = await releaseLease(io, run.databaseId);
        return verified ? 'cancelled' : 'unverified';
      }
    }
    if (io.now() >= deadline) return 'none-found';
    await io.sleep(pollMs);
  }
}

// --- child command handling --------------------------------------------------

function childExitFromEvent(code, signal) {
  if (code !== null && code !== undefined) return code;
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}

// Maps the requested command to a spawn(file, argsArray) pair with NO shell.
// On Windows, `npm`/`npx` are .cmd shims that Node refuses to spawn without a
// shell (CVE-2024-27980 hardening), so they are rewritten to run their real
// JS entry (npm-cli.js / npx-cli.js) through the current node executable.
// Arguments are always forwarded verbatim as an array — never joined into a
// command string, so `;`, `&&`, quotes, etc. stay literal argument text.
function resolveChildCommand(command, {platform, env, nodeExecPath, exists} = {}) {
  const plat = platform || process.platform;
  const environment = env || process.env;
  const nodeExe = nodeExecPath || process.execPath;
  const [cmd, ...args] = command;
  if (plat === 'win32' && (cmd === 'npm' || cmd === 'npx')) {
    const cliJs = resolveNpmCliJs(cmd, environment, nodeExe, exists || fs.existsSync);
    return {file: nodeExe, args: [cliJs, ...args]};
  }
  return {file: cmd, args};
}

function resolveNpmCliJs(cmd, env, nodeExe, exists = fs.existsSync) {
  const candidates = [];
  // When this script itself runs under npm (npm run test:e2e:leased),
  // npm_execpath points at npm-cli.js; npx-cli.js is its sibling.
  if (env.npm_execpath) {
    candidates.push(path.join(path.dirname(env.npm_execpath), `${cmd}-cli.js`));
  }
  // Standard Windows Node install layout: npm lives beside node.exe.
  candidates.push(path.join(path.dirname(nodeExe), 'node_modules', 'npm', 'bin', `${cmd}-cli.js`));
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  throw new LeaseError(
    `Cannot locate ${cmd}-cli.js to run "${cmd}" without a shell on Windows. ` +
      'Invoke the wrapper through npm (npm run test:e2e:leased -- ...) or pass a direct executable.',
    EXIT.usage,
  );
}

function createChildRunner(command, env) {
  let child = null;
  let killRequested = false;
  const start = () =>
    new Promise((resolve, reject) => {
      let resolved;
      try {
        resolved = resolveChildCommand(command);
      } catch (error) {
        reject(error);
        return;
      }
      child = spawn(resolved.file, resolved.args, {
        cwd: REPO_ROOT,
        env,
        stdio: 'inherit',
        shell: false,
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve(childExitFromEvent(code, signal)));
      if (killRequested) killChildTree(child);
    });
  const kill = () => {
    killRequested = true;
    if (child) killChildTree(child);
  };
  return {start, kill};
}

function killChildTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // npm/npx/playwright spawn process trees; /T takes the whole tree down.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {stdio: 'ignore', shell: false});
  } else {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 10000).unref();
  }
}

function installSignalHandlers(proc, handler) {
  const signals = ['SIGINT', 'SIGTERM'];
  const listeners = signals.map((signal) => {
    const listener = () => handler(signal);
    proc.on(signal, listener);
    return {signal, listener};
  });
  return () => {
    for (const {signal, listener} of listeners) proc.removeListener(signal, listener);
  };
}

// --- top-level orchestration --------------------------------------------------

// Returns a result object; resolveExitCode() maps it to the process exit code.
// childRunner = {start() -> Promise<exitCode>, kill()} is injected so unit
// tests never spawn real processes.
//
// Signal handlers are installed BEFORE dispatch and removed only AFTER
// release/sweep verification, so a Ctrl+C at any lifecycle point — dispatch,
// run discovery, queued acquisition, child execution, release — unwinds
// through the same finally cleanup instead of leaving a pending lease that
// could later acquire TEST and hold it unattended.
async function runLeasedCommand({io, options, leaseId, childRunner, signalTarget}) {
  const result = {
    leaseId,
    runId: null,
    childExitCode: null,
    leaseLost: false,
    leaseLostReason: null,
    releaseVerified: null,
    orphanSweep: null,
    failure: null,
    signal: null,
  };
  const abort = createAbortFlag();
  const uninstallSignals = installSignalHandlers(signalTarget || process, (signal) => {
    if (!result.signal) result.signal = signal;
    io.warn(`Received ${signal}; stopping and cleaning up the lease (this is time-bounded — do not force-kill)...`);
    abort.trigger(`signal ${signal}`);
    childRunner.kill();
  });
  let dispatched = false;
  try {
    await verifyGhAuth(io);
    throwIfAborted(abort);
    io.log(`Dispatching TEST DB lease ${leaseId} (hold up to ${options.holdMinutes} min)...`);
    // Marked before the attempt on purpose: a gh call that errors AFTER
    // actually creating the run must still get the orphan sweep in finally.
    dispatched = true;
    await dispatchLease(io, {leaseId, holdMinutes: options.holdMinutes, ref: options.ref});
    const run = await waitForLeaseRun(io, leaseId, {abort});
    result.runId = run.databaseId;
    io.log(`Lease run ${run.databaseId} found; waiting for it to hold the wcf-test-db slot (CI runs go first)...`);
    await waitForAcquisition(io, run.databaseId, {timeoutMs: options.acquireTimeoutMs, abort});
    throwIfAborted(abort);
    io.log(`Lease ${leaseId} ACQUIRED (run ${run.databaseId} in_progress). Starting command...`);

    const monitor = startLeaseMonitor(io, run.databaseId, {}, (reason) => {
      result.leaseLost = true;
      result.leaseLostReason = reason;
      io.warn(`LEASE LOST while the command was running: ${reason}. Terminating the command.`);
      childRunner.kill();
    });
    try {
      result.childExitCode = await childRunner.start();
    } finally {
      monitor.stop();
    }
  } catch (error) {
    if (error && error.interrupted) {
      // Signal-initiated unwind: not a failure. result.signal is already set
      // and the finally block below still cancels/sweeps the lease.
    } else {
      result.failure = error instanceof LeaseError ? error : new LeaseError(String(error && error.message), EXIT.usage);
    }
  } finally {
    try {
      if (result.runId !== null) {
        io.log(`Releasing lease ${leaseId} (cancelling run ${result.runId})...`);
        result.releaseVerified = await releaseLease(io, result.runId);
        if (result.releaseVerified) {
          io.log('Lease released; run reached a terminal state.');
        } else {
          io.warn(
            `Could NOT verify lease run ${result.runId} reached a terminal state. ` +
              `Cancel it manually (gh run cancel ${result.runId}) or CI stays blocked until the hold expires.`,
          );
        }
      } else if (dispatched) {
        io.log(`No run id known for lease ${leaseId}; sweeping for an orphan run before exiting...`);
        result.orphanSweep = await sweepOrphanLease(io, leaseId);
        if (result.orphanSweep === 'cancelled') {
          io.log('Orphan lease run found, cancelled, and verified terminal.');
        } else if (result.orphanSweep === 'none-found') {
          io.log('No orphan lease run appeared within the sweep window; nothing to cancel.');
        } else {
          io.warn(
            `Orphan sweep for lease ${leaseId} ended '${result.orphanSweep}' — verify manually with: ` +
              `gh run list --workflow ${WORKFLOW_FILE}`,
          );
        }
      }
    } finally {
      // Removed only here, so signals stay handled through release/sweep
      // verification (a Ctrl+C during cleanup must not skip it).
      uninstallSignals();
    }
  }
  return result;
}

function resolveExitCode(result) {
  if (result.failure) return result.failure.exitCode || EXIT.usage;
  if (result.leaseLost) return EXIT.leaseLost;
  const child = result.childExitCode === null ? 1 : result.childExitCode;
  if (child === 0 && result.releaseVerified === false) return EXIT.releaseUnverified;
  return child;
}

// --- real io -------------------------------------------------------------------

function realIo() {
  return {
    gh(args) {
      return new Promise((resolve) => {
        const proc = spawn('gh', args, {
          cwd: REPO_ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        proc.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        const timer = setTimeout(() => proc.kill(), DEFAULTS.ghCallTimeoutMs);
        timer.unref();
        proc.on('error', (error) => {
          clearTimeout(timer);
          resolve({code: 127, stdout, stderr: String(error.message)});
        });
        proc.on('close', (code) => {
          clearTimeout(timer);
          resolve({code: code === null ? 1 : code, stdout, stderr});
        });
      });
    },
    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    now: () => Date.now(),
    log: (msg) => console.log(`[test-db-lease] ${msg}`),
    warn: (msg) => console.error(`[test-db-lease] ${msg}`),
  };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[test-db-lease] ${error.message}`);
    process.exit(error.exitCode || EXIT.usage);
  }
  const io = realIo();
  try {
    loadTestEnv(process.env, io.log);
    assertTestEnvSafe(process.env);
  } catch (error) {
    io.warn(error.message);
    process.exit(error.exitCode || EXIT.usage);
  }
  const leaseId = generateLeaseId();
  const childRunner = createChildRunner(parsed.command, process.env);
  const result = await runLeasedCommand({io, options: parsed.options, leaseId, childRunner});
  if (result.failure) io.warn(result.failure.message);
  if (result.leaseLost) {
    io.warn('Command was terminated because the lease was lost; treat any partial results as suspect.');
  }
  if (result.signal) {
    process.exit(result.signal === 'SIGINT' ? 130 : 143);
  }
  process.exit(resolveExitCode(result));
}

module.exports = {
  EXIT,
  DEFAULTS,
  LeaseError,
  PROD_PROJECT_REF,
  RUN_NAME_PREFIX,
  WORKFLOW_FILE,
  parseArgs,
  loadDotEnv,
  assertTestEnvSafe,
  generateLeaseId,
  findUniqueLeaseRun,
  createAbortFlag,
  verifyGhAuth,
  dispatchLease,
  waitForLeaseRun,
  waitForAcquisition,
  startLeaseMonitor,
  releaseLease,
  sweepOrphanLease,
  childExitFromEvent,
  resolveChildCommand,
  resolveNpmCliJs,
  installSignalHandlers,
  runLeasedCommand,
  resolveExitCode,
};

if (require.main === module) {
  main();
}
