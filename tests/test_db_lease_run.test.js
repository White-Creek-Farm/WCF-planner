import {EventEmitter} from 'node:events';
import {describe, it, expect} from 'vitest';
import lease from '../scripts/test_db_lease_run.cjs';

// ============================================================================
// scripts/test_db_lease_run.cjs — DB-free unit tests
// ============================================================================
// Everything here runs against an injected fake `io` (scripted gh responses,
// instant fake-clock sleep). No process is spawned, no workflow is dispatched,
// no database is touched. The fake gh models the one GitHub behavior that
// matters: `run cancel` flips subsequent `run view` responses to
// completed/cancelled, exactly like the real release path.
// ============================================================================

const {
  EXIT,
  LeaseError,
  parseArgs,
  assertTestEnvSafe,
  generateLeaseId,
  findUniqueLeaseRun,
  waitForLeaseRun,
  waitForAcquisition,
  startLeaseMonitor,
  releaseLease,
  childExitFromEvent,
  resolveChildCommand,
  runLeasedCommand,
  resolveExitCode,
  PROD_PROJECT_REF,
} = lease;

const TEST_ENV = {WCF_TEST_DATABASE: '1', VITE_SUPABASE_URL: 'https://testprojectref.supabase.co'};

// Scripted gh + fake clock. viewStates are consumed one per `run view` call;
// when exhausted, viewDefault repeats (undefined viewDefault = gh failure).
// After `run cancel`, `run view` returns afterCancelState (default
// completed/cancelled; pass null to keep the pre-cancel script — models a
// cancel that never lands). listSequence (optional) is consumed one response
// per `run list` call with the last entry repeating — models a run that
// appears only after a delay. onCall (optional) observes every gh call.
function fakeIo({
  authCode = 0,
  dispatchCode = 0,
  listRuns = [],
  listSequence,
  viewStates = [],
  viewDefault,
  cancelCode = 0,
  afterCancelState,
  onCall,
} = {}) {
  const calls = [];
  let clock = 0;
  let cancelled = false;
  const states = [...viewStates];
  const listSeq = listSequence ? [...listSequence] : null;
  return {
    calls,
    cancelledRuns: () => calls.filter((args) => args[0] === 'run' && args[1] === 'cancel'),
    async gh(args) {
      calls.push(args);
      if (onCall) onCall(args);
      const key = `${args[0]} ${args[1]}`;
      if (key === 'auth status') return {code: authCode, stdout: '', stderr: ''};
      if (key === 'workflow run') return {code: dispatchCode, stdout: '', stderr: dispatchCode ? 'dispatch boom' : ''};
      if (key === 'run list') {
        const payload = listSeq ? (listSeq.length > 1 ? listSeq.shift() : listSeq[0]) : listRuns;
        return {code: 0, stdout: JSON.stringify(payload), stderr: ''};
      }
      if (key === 'run cancel') {
        cancelled = true;
        return {code: cancelCode, stdout: '', stderr: ''};
      }
      if (key === 'run view') {
        if (cancelled && afterCancelState !== null) {
          return {
            code: 0,
            stdout: JSON.stringify(afterCancelState || {status: 'completed', conclusion: 'cancelled'}),
            stderr: '',
          };
        }
        const state = states.length > 0 ? states.shift() : viewDefault;
        if (state === undefined) return {code: 1, stdout: '', stderr: 'gh flake'};
        return {code: 0, stdout: JSON.stringify(state), stderr: ''};
      }
      return {code: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}`};
    },
    async sleep(ms) {
      clock += ms;
    },
    now: () => clock,
    log: () => {},
    warn: () => {},
  };
}

// Controllable child stand-in: resolves only when finish()/kill() fires.
function fakeChild({killExitCode = 1} = {}) {
  let resolveExit;
  let started = false;
  let killed = false;
  const exit = new Promise((resolve) => {
    resolveExit = resolve;
  });
  return {
    get started() {
      return started;
    },
    get killed() {
      return killed;
    },
    start() {
      started = true;
      return exit;
    },
    kill() {
      killed = true;
      resolveExit(killExitCode);
    },
    finish(code) {
      resolveExit(code);
    },
  };
}

// Everything in these tests is microtask-driven, so yielding microtasks is
// enough to interleave the orchestration with the test body.
async function until(predicate, maxTicks = 5000) {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('until(): condition never became true');
}

const RUN_LIST = [{databaseId: 42, displayTitle: 'TEST DB lease lease-1-abc-7', status: 'queued', conclusion: null}];

function composedArgs(io, child, overrides = {}) {
  return {
    io,
    options: {holdMinutes: 90, acquireTimeoutMs: 60_000, ref: null},
    leaseId: 'lease-1-abc-7',
    childRunner: child,
    signalTarget: new EventEmitter(),
    ...overrides,
  };
}

describe('parseArgs', () => {
  it('requires an explicit -- separator', () => {
    expect(() => parseArgs(['npx', 'playwright', 'test'])).toThrow(/explicit command after --/);
  });

  it('requires a non-empty command after --', () => {
    expect(() => parseArgs(['--hold-minutes', '30', '--'])).toThrow(/No command given after --/);
  });

  it('rejects wrapper flags placed after -- (npm passthrough ordering trap)', () => {
    expect(() => parseArgs(['--', '--hold-minutes', '30', 'npx'])).toThrow(/BEFORE the --/);
  });

  it('rejects unknown flags and non-integer values', () => {
    expect(() => parseArgs(['--bogus', '--', 'npx'])).toThrow(/Unknown flag/);
    expect(() => parseArgs(['--hold-minutes', 'ninety', '--', 'npx'])).toThrow(/positive integer/);
  });

  it('parses flags and forwards the command tokens verbatim as an array', () => {
    const hostile = 'a && b; rm -rf / "quoted"';
    const {options, command} = parseArgs([
      '--hold-minutes',
      '45',
      '--acquire-minutes',
      '10',
      '--',
      'npx',
      'playwright',
      'test',
      '--grep',
      hostile,
    ]);
    expect(options.holdMinutes).toBe(45);
    expect(options.acquireTimeoutMs).toBe(10 * 60 * 1000);
    // No joining, no quoting, no reinterpretation — the hostile string stays
    // one literal argv entry, which is what makes shell injection impossible.
    expect(command).toEqual(['npx', 'playwright', 'test', '--grep', hostile]);
  });
});

describe('PROD refusal (assertTestEnvSafe)', () => {
  it('refuses without WCF_TEST_DATABASE=1', () => {
    expect(() => assertTestEnvSafe({VITE_SUPABASE_URL: 'https://testprojectref.supabase.co'})).toThrow(
      /WCF_TEST_DATABASE/,
    );
  });

  it('refuses a missing Supabase URL', () => {
    expect(() => assertTestEnvSafe({WCF_TEST_DATABASE: '1'})).toThrow(/VITE_SUPABASE_URL is missing/);
  });

  it('refuses the PROD project ref even with the flag set', () => {
    expect(() =>
      assertTestEnvSafe({WCF_TEST_DATABASE: '1', VITE_SUPABASE_URL: `https://${PROD_PROJECT_REF}.supabase.co`}),
    ).toThrow(/PRODUCTION/);
  });

  it('accepts a TEST target', () => {
    expect(() => assertTestEnvSafe(TEST_ENV)).not.toThrow();
  });
});

describe('lease id + unique run matching', () => {
  it('generates distinct ids with a stable prefix', () => {
    const a = generateLeaseId(1, 'aaaa', 10);
    const b = generateLeaseId(2, 'bbbb', 10);
    expect(a).toMatch(/^lease-/);
    expect(a).not.toBe(b);
  });

  it('returns null for zero matches so the caller keeps polling', () => {
    expect(findUniqueLeaseRun([{displayTitle: 'TEST DB lease other'}], 'lease-x')).toBeNull();
  });

  it('returns the single matching run', () => {
    const run = findUniqueLeaseRun(RUN_LIST, 'lease-1-abc-7');
    expect(run.databaseId).toBe(42);
  });

  it('fails closed on ambiguous matches', () => {
    const dupes = [{displayTitle: 'TEST DB lease lease-x'}, {displayTitle: 'TEST DB lease lease-x'}];
    expect(() => findUniqueLeaseRun(dupes, 'lease-x')).toThrow(/unique ownership/);
  });

  it('matches by EXACT run title only — substring/superstring/embedded titles are never selected', () => {
    const lookalikes = [
      {databaseId: 1, displayTitle: 'TEST DB lease lease-1-abc-77'}, // our id is a prefix of this one
      {databaseId: 2, displayTitle: 'lease-1-abc-7'}, // bare id without the run-name prefix
      {databaseId: 3, displayTitle: 'X TEST DB lease lease-1-abc-7 Y'}, // id embedded in a longer title
    ];
    expect(findUniqueLeaseRun(lookalikes, 'lease-1-abc-7')).toBeNull();
    const withExact = [...lookalikes, {databaseId: 42, displayTitle: 'TEST DB lease lease-1-abc-7'}];
    expect(findUniqueLeaseRun(withExact, 'lease-1-abc-7').databaseId).toBe(42);
  });

  it('waitForLeaseRun times out (bounded) when the run never appears', async () => {
    const io = fakeIo({listRuns: []});
    await expect(waitForLeaseRun(io, 'lease-x', {timeoutMs: 10_000, pollMs: 3000})).rejects.toThrow(/never appeared/);
  });
});

describe('acquisition', () => {
  it('waits through queued and returns once in_progress', async () => {
    const io = fakeIo({viewStates: [{status: 'queued'}, {status: 'queued'}, {status: 'in_progress'}]});
    await expect(waitForAcquisition(io, 42, {timeoutMs: 60_000, pollMs: 5000})).resolves.toBeUndefined();
    expect(io.now()).toBe(10_000); // two waits, then acquired
  });

  it('fails closed when the pending lease is displaced/cancelled before starting', async () => {
    const io = fakeIo({viewStates: [{status: 'queued'}, {status: 'completed', conclusion: 'cancelled'}]});
    const error = await waitForAcquisition(io, 42, {timeoutMs: 60_000, pollMs: 5000}).catch((e) => e);
    expect(error).toBeInstanceOf(LeaseError);
    expect(error.exitCode).toBe(EXIT.acquireFailed);
    expect(error.message).toMatch(/before it was ever/);
  });

  it('enforces a bounded acquisition timeout while CI holds the slot', async () => {
    const io = fakeIo({viewDefault: {status: 'queued'}});
    const error = await waitForAcquisition(io, 42, {timeoutMs: 20_000, pollMs: 5000}).catch((e) => e);
    expect(error).toBeInstanceOf(LeaseError);
    expect(error.exitCode).toBe(EXIT.acquireFailed);
    expect(error.message).toMatch(/did not reach in_progress/);
  });
});

describe('lease monitor', () => {
  it('reports loss when the run leaves in_progress', async () => {
    const io = fakeIo({viewStates: [{status: 'in_progress'}, {status: 'completed', conclusion: 'failure'}]});
    let lost = null;
    const monitor = startLeaseMonitor(io, 42, {pollMs: 1000, maxConsecutiveErrors: 5}, (reason) => {
      lost = reason;
    });
    await monitor.done;
    expect(lost).toMatch(/left in_progress/);
  });

  it('fails closed when lease state is unverifiable for too long', async () => {
    const io = fakeIo({viewDefault: undefined}); // every poll errors
    let lost = null;
    const monitor = startLeaseMonitor(io, 42, {pollMs: 1000, maxConsecutiveErrors: 3}, (reason) => {
      lost = reason;
    });
    await monitor.done;
    expect(lost).toMatch(/unverifiable/);
  });

  it('stop() ends the loop without reporting loss', async () => {
    const io = fakeIo({viewDefault: {status: 'in_progress'}});
    let lost = null;
    const monitor = startLeaseMonitor(io, 42, {pollMs: 1000, maxConsecutiveErrors: 5}, (reason) => {
      lost = reason;
    });
    monitor.stop();
    await monitor.done;
    expect(lost).toBeNull();
  });
});

describe('release', () => {
  it('cancels and verifies the run reached a terminal state', async () => {
    const io = fakeIo({viewDefault: {status: 'in_progress'}});
    await expect(releaseLease(io, 42, {timeoutMs: 30_000, pollMs: 5000})).resolves.toBe(true);
    expect(io.cancelledRuns()).toHaveLength(1);
  });

  it('returns false (bounded) when terminal state can never be verified', async () => {
    const io = fakeIo({viewDefault: undefined, afterCancelState: null});
    await expect(releaseLease(io, 42, {timeoutMs: 20_000, pollMs: 5000})).resolves.toBe(false);
  });
});

describe('runLeasedCommand (composed)', () => {
  it('success path: acquires, runs child, preserves exit 0, releases + verifies', async () => {
    const io = fakeIo({
      listRuns: RUN_LIST,
      viewStates: [{status: 'in_progress'}],
      viewDefault: {status: 'in_progress'},
    });
    const child = fakeChild();
    const promise = runLeasedCommand(composedArgs(io, child));
    await until(() => child.started);
    child.finish(0);
    const result = await promise;
    expect(result.failure).toBeNull();
    expect(result.childExitCode).toBe(0);
    expect(result.leaseLost).toBe(false);
    expect(result.releaseVerified).toBe(true);
    expect(io.cancelledRuns()).toHaveLength(1);
    expect(resolveExitCode(result)).toBe(0);
  });

  it('failing child: preserves the child exit code and still releases', async () => {
    const io = fakeIo({
      listRuns: RUN_LIST,
      viewStates: [{status: 'in_progress'}],
      viewDefault: {status: 'in_progress'},
    });
    const child = fakeChild();
    const promise = runLeasedCommand(composedArgs(io, child));
    await until(() => child.started);
    child.finish(7);
    const result = await promise;
    expect(result.childExitCode).toBe(7);
    expect(io.cancelledRuns()).toHaveLength(1);
    expect(resolveExitCode(result)).toBe(7);
  });

  it('lease lost mid-run: kills the child, exits leaseLost, still releases', async () => {
    const io = fakeIo({
      listRuns: RUN_LIST,
      viewStates: [{status: 'in_progress'}, {status: 'completed', conclusion: 'failure'}],
    });
    const child = fakeChild({killExitCode: 1});
    const result = await runLeasedCommand(composedArgs(io, child));
    expect(child.killed).toBe(true);
    expect(result.leaseLost).toBe(true);
    expect(result.leaseLostReason).toMatch(/left in_progress/);
    expect(io.cancelledRuns()).toHaveLength(1);
    expect(resolveExitCode(result)).toBe(EXIT.leaseLost);
  });

  it('displaced pending lease: fails closed, never starts the child, still cleans up', async () => {
    const io = fakeIo({
      listRuns: RUN_LIST,
      viewStates: [{status: 'queued'}, {status: 'completed', conclusion: 'cancelled'}],
    });
    const child = fakeChild();
    const result = await runLeasedCommand(composedArgs(io, child));
    expect(child.started).toBe(false);
    expect(result.failure).toBeInstanceOf(LeaseError);
    expect(result.failure.exitCode).toBe(EXIT.acquireFailed);
    expect(io.cancelledRuns()).toHaveLength(1); // release of the dead run is still attempted
    expect(resolveExitCode(result)).toBe(EXIT.acquireFailed);
  });

  it('dispatch failure with no run ever appearing: bounded sweep polls, then reports none-found', async () => {
    const io = fakeIo({dispatchCode: 1});
    const child = fakeChild();
    const result = await runLeasedCommand(composedArgs(io, child));
    expect(child.started).toBe(false);
    expect(result.failure).toBeInstanceOf(LeaseError);
    expect(result.failure.message).toMatch(/Failed to dispatch/);
    expect(result.orphanSweep).toBe('none-found');
    const listCalls = io.calls.filter((args) => args[0] === 'run' && args[1] === 'list');
    expect(listCalls.length).toBeGreaterThan(1); // POLLED the window, not a one-shot scan
    expect(io.cancelledRuns()).toHaveLength(0);
  });

  it('dispatch error whose run appears seconds later: sweep discovers, cancels, and verifies it', async () => {
    // gh workflow run errored/timed out but HAD created the run — it shows up
    // on the third list poll. The sweep must find it, cancel it, and verify
    // it reached a terminal state so it can never acquire TEST unattended.
    const io = fakeIo({dispatchCode: 1, listSequence: [[], [], RUN_LIST]});
    const child = fakeChild();
    const result = await runLeasedCommand(composedArgs(io, child));
    expect(child.started).toBe(false);
    expect(result.failure.message).toMatch(/Failed to dispatch/);
    expect(result.orphanSweep).toBe('cancelled');
    expect(io.cancelledRuns()).toHaveLength(1);
  });

  it('SIGINT while waiting for the run to appear: interruptible wait, cleanup sweep still runs', async () => {
    const signalTarget = new EventEmitter();
    const io = fakeIo({listRuns: []}); // dispatched fine, run never appears
    const child = fakeChild();
    const promise = runLeasedCommand(composedArgs(io, child, {signalTarget}));
    await until(() => io.calls.some((args) => args[0] === 'workflow' && args[1] === 'run'));
    signalTarget.emit('SIGINT');
    const result = await promise;
    expect(child.started).toBe(false);
    expect(result.signal).toBe('SIGINT');
    expect(result.failure).toBeNull(); // a signal unwind is cleanup, not a failure
    expect(result.orphanSweep).toBe('none-found'); // the finally cleanup still swept
    expect(signalTarget.listenerCount('SIGINT')).toBe(0); // uninstalled only after cleanup
  });

  it('SIGTERM while queued awaiting acquisition: cancels the pending run and verifies release', async () => {
    const signalTarget = new EventEmitter();
    const io = fakeIo({listRuns: RUN_LIST, viewDefault: {status: 'queued'}});
    const child = fakeChild();
    const promise = runLeasedCommand(composedArgs(io, child, {signalTarget}));
    await until(() => io.calls.some((args) => args[0] === 'run' && args[1] === 'view'));
    signalTarget.emit('SIGTERM');
    const result = await promise;
    expect(child.started).toBe(false);
    expect(result.signal).toBe('SIGTERM');
    expect(result.runId).toBe(42);
    expect(result.failure).toBeNull();
    expect(io.cancelledRuns()).toHaveLength(1);
    expect(result.releaseVerified).toBe(true);
  });

  it('signal handlers stay installed through release verification and are removed after', async () => {
    const signalTarget = new EventEmitter();
    const listenerCounts = [];
    const io = fakeIo({
      listRuns: RUN_LIST,
      viewStates: [{status: 'in_progress'}],
      viewDefault: {status: 'in_progress'},
      onCall: (args) => {
        if (args[0] === 'run' && (args[1] === 'cancel' || args[1] === 'view')) {
          listenerCounts.push({key: `${args[0]} ${args[1]}`, count: signalTarget.listenerCount('SIGINT')});
        }
      },
    });
    const child = fakeChild();
    const promise = runLeasedCommand(composedArgs(io, child, {signalTarget}));
    await until(() => child.started);
    child.finish(0);
    const result = await promise;
    expect(result.releaseVerified).toBe(true);
    const cancelIndex = listenerCounts.findIndex((entry) => entry.key === 'run cancel');
    expect(cancelIndex).toBeGreaterThan(-1);
    // Still handling signals at the moment of cancellation AND at the
    // terminal-state verification poll that follows it...
    expect(listenerCounts[cancelIndex].count).toBe(1);
    const verifyPoll = listenerCounts.slice(cancelIndex + 1).find((entry) => entry.key === 'run view');
    expect(verifyPoll).toBeDefined();
    expect(verifyPoll.count).toBe(1);
    // ...and only uninstalled once cleanup has fully completed.
    expect(signalTarget.listenerCount('SIGINT')).toBe(0);
  });

  it('unauthenticated gh fails before dispatching anything', async () => {
    const io = fakeIo({authCode: 1});
    const child = fakeChild();
    const result = await runLeasedCommand(composedArgs(io, child));
    expect(result.failure.message).toMatch(/gh auth login/);
    const dispatches = io.calls.filter((args) => args[0] === 'workflow');
    expect(dispatches).toHaveLength(0);
  });

  it('SIGINT: kills the child, records the signal, and still releases the lease', async () => {
    const io = fakeIo({
      listRuns: RUN_LIST,
      viewStates: [{status: 'in_progress'}],
      viewDefault: {status: 'in_progress'},
    });
    const child = fakeChild({killExitCode: 130});
    const signalTarget = new EventEmitter();
    const promise = runLeasedCommand(composedArgs(io, child, {signalTarget}));
    await until(() => child.started);
    signalTarget.emit('SIGINT');
    const result = await promise;
    expect(child.killed).toBe(true);
    expect(result.signal).toBe('SIGINT');
    expect(io.cancelledRuns()).toHaveLength(1);
  });

  it('wrapper failure while starting the child still releases the lease', async () => {
    const io = fakeIo({
      listRuns: RUN_LIST,
      viewStates: [{status: 'in_progress'}],
      viewDefault: {status: 'in_progress'},
    });
    const child = {
      start: () => Promise.reject(new Error('spawn ENOENT')),
      kill: () => {},
    };
    const result = await runLeasedCommand(composedArgs(io, child));
    expect(result.failure).toBeInstanceOf(LeaseError);
    expect(io.cancelledRuns()).toHaveLength(1);
  });
});

describe('exit-code mapping', () => {
  const base = {failure: null, leaseLost: false, childExitCode: 0, releaseVerified: true};

  it('preserves the child exit code', () => {
    expect(resolveExitCode({...base, childExitCode: 0})).toBe(0);
    expect(resolveExitCode({...base, childExitCode: 7})).toBe(7);
  });

  it('acquire failures map to the acquire exit code', () => {
    expect(resolveExitCode({...base, failure: new LeaseError('x', EXIT.acquireFailed)})).toBe(EXIT.acquireFailed);
  });

  it('lease loss overrides the child exit code', () => {
    expect(resolveExitCode({...base, leaseLost: true, childExitCode: 0})).toBe(EXIT.leaseLost);
  });

  it('a green child with an unverified release is loud, a red child keeps its own code', () => {
    expect(resolveExitCode({...base, releaseVerified: false})).toBe(EXIT.releaseUnverified);
    expect(resolveExitCode({...base, childExitCode: 7, releaseVerified: false})).toBe(7);
  });

  it('signal deaths map to conventional exit codes', () => {
    expect(childExitFromEvent(null, 'SIGINT')).toBe(130);
    expect(childExitFromEvent(null, 'SIGTERM')).toBe(143);
    expect(childExitFromEvent(3, null)).toBe(3);
    expect(childExitFromEvent(null, 'SIGKILL')).toBe(1);
  });
});

describe('child command resolution (no shell, args verbatim)', () => {
  it('passes non-npm commands through untouched on any platform', () => {
    const {file, args} = resolveChildCommand(['node', 'somescript.js', 'a && b'], {platform: 'linux'});
    expect(file).toBe('node');
    expect(args).toEqual(['somescript.js', 'a && b']);
  });

  it('passes npm through untouched on POSIX (plain executable there)', () => {
    const {file, args} = resolveChildCommand(['npm', 'run', 'test:e2e'], {platform: 'linux'});
    expect(file).toBe('npm');
    expect(args).toEqual(['run', 'test:e2e']);
  });

  it('rewrites npm/npx on Windows to the node executable + real cli.js (no .cmd, no shell)', () => {
    const {file, args} = resolveChildCommand(['npx', 'playwright', 'test', '--grep', 'a;b'], {
      platform: 'win32',
      env: {npm_execpath: 'C:\\nvm\\npm\\bin\\npm-cli.js'},
      nodeExecPath: 'C:\\nvm\\node.exe',
      exists: (candidate) => candidate.endsWith('npx-cli.js'),
    });
    expect(file).toBe('C:\\nvm\\node.exe');
    expect(args[0]).toMatch(/npx-cli\.js$/);
    expect(args.slice(1)).toEqual(['playwright', 'test', '--grep', 'a;b']);
  });

  it('fails with guidance when the npm cli entry cannot be located on Windows', () => {
    expect(() =>
      resolveChildCommand(['npm', 'run', 'x'], {
        platform: 'win32',
        env: {},
        nodeExecPath: 'C:\\nowhere\\node.exe',
        exists: () => false,
      }),
    ).toThrow(/Cannot locate npm-cli\.js/);
  });
});
