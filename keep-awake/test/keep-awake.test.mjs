// keep-awake pure-helper tests. Dependency-free: node:assert + pass counter.
// Portable: imports the plugin source relative to this test file, so it works
// from the repo, a worktree, or a copied live dir.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import('../index.js');

const ps1 = fs.readFileSync(new URL('../keep-awake.ps1', import.meta.url), 'utf8');

let pass = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
};

const {
  normalizeSessionKey,
  busyAcquire,
  busyEnd,
  remainingCapSeconds,
  canSpawnHelper,
  EXECTIME_DC_FIXED,
  parseExecTimeDc,
  isExecutionTimeoutFixed,
  resolveKeepDisplayOn,
  buildHelperArgs,
  execFixCommands,
  shouldNotifyExecutionFix,
  shouldAutoApplyExecutionFix,
  shouldStallRelease,
  default: plugin,
} = m;

// ---------------------------------------------------------------------------
// Existing checks (1-9).
// ---------------------------------------------------------------------------

ok('1 leak_mismatch: acquire(undefined) then end(real id) leaves empty', () => {
  const busy = new Set();
  busyAcquire(busy, undefined);
  const removed = busyEnd(busy, 'ses_real');
  assert.equal(removed, true);
  assert.equal(busy.size, 0);
});

ok('2 acquire(a), acquire(undefined), end(a) -> 1; end(undefined) -> 0', () => {
  const busy = new Set();
  busyAcquire(busy, 'ses_a');
  busyAcquire(busy, undefined);
  assert.equal(busy.size, 2);
  busyEnd(busy, 'ses_a');
  assert.equal(busy.size, 1);
  busyEnd(busy, undefined);
  assert.equal(busy.size, 0);
});

ok('3 acquire is idempotent', () => {
  const busy = new Set();
  busyAcquire(busy, 'ses_a');
  busyAcquire(busy, 'ses_a');
  assert.equal(busy.size, 1);
  busyEnd(busy, 'ses_a');
  assert.equal(busy.size, 0);
});

ok('4 end with no id removes exactly one entry', () => {
  const busy = new Set(['a', 'b', 'c']);
  assert.equal(busyEnd(busy, undefined), true);
  assert.equal(busy.size, 2);
  const empty = new Set();
  assert.equal(busyEnd(empty, undefined), false);
  assert.equal(empty.size, 0);
});

ok('5 remainingCapSeconds: fresh == max, half ~= half, full <= 0', () => {
  assert.equal(remainingCapSeconds(null, 100, 5000), 100);
  const half = remainingCapSeconds(1000, 100, 51000);
  assert.ok(Math.abs(half - 50) < 1e-9, `half=${half}`);
  assert.ok(remainingCapSeconds(1000, 100, 101000) <= 0);
});

ok('6 canSpawnHelper truth table', () => {
  const base = { proc: null, setupRefs: 1, busyCount: 1, remainingSeconds: 10 };
  assert.equal(canSpawnHelper({ ...base, remainingSeconds: 0 }), false);
  assert.equal(canSpawnHelper({ ...base, remainingSeconds: -5 }), false);
  assert.equal(canSpawnHelper({ ...base, proc: {} }), false);
  assert.equal(canSpawnHelper({ ...base, setupRefs: 0 }), false);
  assert.equal(canSpawnHelper({ ...base, busyCount: 0 }), false);
  assert.equal(canSpawnHelper(base), true);
});

ok('7 import sanity: existing + new exports + default plugin', () => {
  const keys = Object.keys(m);
  for (const k of [
    'normalizeSessionKey', 'busyAcquire', 'busyEnd',
    'remainingCapSeconds', 'canSpawnHelper',
    'EXECTIME_DC_FIXED', 'parseExecTimeDc', 'isExecutionTimeoutFixed',
    'resolveKeepDisplayOn', 'buildHelperArgs', 'execFixCommands',
    'shouldNotifyExecutionFix', 'shouldAutoApplyExecutionFix', 'shouldStallRelease',
    'default',
  ]) {
    assert.ok(keys.includes(k), `missing export ${k} (got: ${keys.join(', ')})`);
  }
  assert.equal(plugin.id, 'keep-awake');
  assert.equal(typeof plugin.setup, 'function');
});

ok('8 normalizeSessionKey sentinel behavior', () => {
  assert.equal(normalizeSessionKey('ses_x'), 'ses_x');
  assert.equal(normalizeSessionKey(''), m.UNKNOWN_KEY);
  assert.equal(normalizeSessionKey(undefined), m.UNKNOWN_KEY);
  assert.equal(normalizeSessionKey(null), m.UNKNOWN_KEY);
  assert.equal(normalizeSessionKey(123), m.UNKNOWN_KEY);
});

ok('9 id-less end is symmetric: removes the sentinel, not a real id', () => {
  const busy = new Set();
  busyAcquire(busy, 'ses_a');
  busyAcquire(busy, '');                    // empty string -> sentinel
  assert.equal(busy.size, 2);
  assert.equal(busyEnd(busy, ''), true);    // must drop the sentinel, keep ses_a
  assert.equal(busy.size, 1);
  assert.ok(busy.has('ses_a'));
  assert.equal(busyEnd(busy, 'ses_a'), true);
  assert.equal(busy.size, 0);
});

// ---------------------------------------------------------------------------
// New checks.
// ---------------------------------------------------------------------------

const EXECTIME_SAMPLE = [
  'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)',
  '  Subgroup GUID: 238c9fa8-0aad-41ed-83f4-97be242c8f20  (SUB_IR)',
  '    Power Setting GUID: 3166bc41-7e98-4e03-b34e-ec0f5f2b218e  (Execution Required power request time-out)',
  '      GUID Alias: EXECTIME',
  '      Minimum Possible Setting: 0x00000000',
  '      Maximum Possible Setting: 0xffffffff',
  '      Possible Settings increment: 0x00000001',
  '      Possible Settings units: Seconds',
  '      Current AC Power Setting Index: 0xffffffff',
  '      Current DC Power Setting Index: 0x0000012c',
  '',
].join('\r\n');

ok('10 parseExecTimeDc reads EXECTIME DC 0x0000012c -> 300', () => {
  assert.equal(parseExecTimeDc(EXECTIME_SAMPLE), 300);
});

ok('11 parseExecTimeDc reads 0xffffffff -> 4294967295', () => {
  const fixed = EXECTIME_SAMPLE.replace('0x0000012c', '0xffffffff');
  assert.equal(parseExecTimeDc(fixed), 4294967295);
  assert.equal(EXECTIME_DC_FIXED, 4294967295);
});

ok('12 parseExecTimeDc supports decimal and returns null when absent', () => {
  const dec = EXECTIME_SAMPLE.replace('0x0000012c', '300');
  assert.equal(parseExecTimeDc(dec), 300);
  assert.equal(parseExecTimeDc('no matching setting here'), null);
  assert.equal(parseExecTimeDc('GUID Alias: EXECTIME\r\n  no index line'), null);
  assert.equal(parseExecTimeDc(undefined), null);
});

ok('13 parseExecTimeDc ignores a later setting\'s DC value', () => {
  const multi = [
    'Power Setting GUID: 3166bc41-7e98-4e03-b34e-ec0f5f2b218e  (timeout)',
    '  GUID Alias: EXECTIME',
    '  Current AC Power Setting Index: 0xffffffff',
    '  Current DC Power Setting Index: 0x0000012c',
    'Power Setting GUID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee  (later)',
    '  GUID Alias: LATER',
    '  Current AC Power Setting Index: 0x00000000',
    '  Current DC Power Setting Index: 0x0000002a',
  ].join('\r\n');
  assert.equal(parseExecTimeDc(multi), 300);
});

ok('14 isExecutionTimeoutFixed truth table', () => {
  assert.equal(isExecutionTimeoutFixed(300), false);
  assert.equal(isExecutionTimeoutFixed(0xffffffff), true);
  assert.equal(isExecutionTimeoutFixed(null), false);
  assert.equal(isExecutionTimeoutFixed(undefined), false);
});

ok('15 resolveKeepDisplayOn truth table', () => {
  assert.equal(resolveKeepDisplayOn({}), false);
  assert.equal(resolveKeepDisplayOn({ keepDisplayOn: false }), false);
  assert.equal(resolveKeepDisplayOn({ keepDisplayOn: true }), true);
  assert.equal(resolveKeepDisplayOn({ mode: 'system' }), false);
  assert.equal(resolveKeepDisplayOn({ mode: 'display' }), true);
  assert.equal(resolveKeepDisplayOn({ mode: 'system', keepDisplayOn: true }), true);
});

ok('16 buildHelperArgs passes -Display/-MutexName/-File/-ParentPid/-MaxSeconds', () => {
  const base = {
    helperPath: 'C:/x/keep-awake.ps1',
    parentPid: 1234,
    maxSeconds: 60,
    keepDisplayOn: true,
    mutexName: 'M1',
  };
  const on = buildHelperArgs(base);
  for (const tok of ['-File', 'C:/x/keep-awake.ps1', '-ParentPid', '1234', '-MaxSeconds', '60', '-Display', 'on', '-MutexName', 'M1']) {
    assert.ok(on.includes(tok), `missing ${tok}: ${JSON.stringify(on)}`);
  }
  const off = buildHelperArgs({ ...base, keepDisplayOn: false });
  assert.equal(off[off.indexOf('-Display') + 1], 'off');
  const noMutex = buildHelperArgs({ ...base, mutexName: '' });
  assert.ok(!noMutex.includes('-MutexName'));
});

ok('17 execFixCommands apply/revert text', () => {
  const { apply, revert } = execFixCommands();
  assert.ok(apply.includes('EXECTIME 0xffffffff'), apply);
  assert.ok(apply.includes('/setactive SCHEME_CURRENT'), apply);
  assert.ok(revert.includes('EXECTIME 0x12c'), revert);
  assert.ok(revert.includes('/setactive SCHEME_CURRENT'), revert);
});

ok('18 shouldNotifyExecutionFix / shouldAutoApplyExecutionFix truth table', () => {
  const unfixed = 300;
  const fixed = 0xffffffff;
  // unfixed + detect + first-run
  assert.equal(shouldNotifyExecutionFix({ state: null, dcValue: unfixed, setupMode: 'detect' }), true);
  assert.equal(shouldAutoApplyExecutionFix({ state: null, dcValue: unfixed, setupMode: 'detect' }), false);
  // apply => both true
  assert.equal(shouldNotifyExecutionFix({ state: null, dcValue: unfixed, setupMode: 'apply' }), true);
  assert.equal(shouldAutoApplyExecutionFix({ state: null, dcValue: unfixed, setupMode: 'apply' }), true);
  // fixed => false
  assert.equal(shouldNotifyExecutionFix({ state: null, dcValue: fixed, setupMode: 'detect' }), false);
  assert.equal(shouldAutoApplyExecutionFix({ state: null, dcValue: fixed, setupMode: 'apply' }), false);
  // already notified => false
  const notified = { execFix: { notifiedAt: 1 } };
  assert.equal(shouldNotifyExecutionFix({ state: notified, dcValue: unfixed, setupMode: 'detect' }), false);
  assert.equal(shouldAutoApplyExecutionFix({ state: notified, dcValue: unfixed, setupMode: 'apply' }), false);
  // off => false
  assert.equal(shouldNotifyExecutionFix({ state: null, dcValue: unfixed, setupMode: 'off' }), false);
  assert.equal(shouldAutoApplyExecutionFix({ state: null, dcValue: unfixed, setupMode: 'off' }), false);
  // null dc => false
  assert.equal(shouldNotifyExecutionFix({ state: null, dcValue: null, setupMode: 'detect' }), false);
  assert.equal(shouldAutoApplyExecutionFix({ state: null, dcValue: null, setupMode: 'apply' }), false);
});

ok('19 shouldStallRelease truth table', () => {
  // silent beyond threshold -> true
  assert.equal(shouldStallRelease({ busyCount: 1, lastEventAt: 0, nowMs: 1810 * 1000, stallSeconds: 1800 }), true);
  // recent -> false
  assert.equal(shouldStallRelease({ busyCount: 1, lastEventAt: 0, nowMs: 1000, stallSeconds: 1800 }), false);
  // exactly at threshold is not yet a stall
  assert.equal(shouldStallRelease({ busyCount: 1, lastEventAt: 0, nowMs: 1800 * 1000, stallSeconds: 1800 }), false);
  // disabled -> false
  assert.equal(shouldStallRelease({ busyCount: 1, lastEventAt: 0, nowMs: 999999999, stallSeconds: 0 }), false);
  // not busy -> false
  assert.equal(shouldStallRelease({ busyCount: 0, lastEventAt: 0, nowMs: 999999999, stallSeconds: 1800 }), false);
  // no known last event -> false
  assert.equal(shouldStallRelease({ busyCount: 1, lastEventAt: null, nowMs: 999999999, stallSeconds: 1800 }), false);
});

ok('20 keep-awake.ps1 uses Display=0 and the 0x80000003 fallback', () => {
  assert.ok(ps1.includes('$PowerRequestDisplayRequired = 0'), 'Display must be 0');
  assert.ok(!ps1.includes('$PowerRequestDisplayRequired = 2'), 'Display must not be 2 (AwayMode)');
  assert.ok(!/\$PowerRequestDisplayRequired\s*=\s*2\b/.test(ps1), 'Display must not be assigned 2');
  assert.ok(ps1.includes('2147483651') || ps1.includes('0x80000003'), 'display fallback flag');
  assert.ok(!/PowerSetRequest\([^)]*,\s*2\s*\)/.test(ps1), 'must not PowerSetRequest type 2');
});

// ---------------------------------------------------------------------------
// Check 21 (async): a hot reload into an existing process must re-resolve cfg.
// setupRefs is already 1 (as after a V2 hot reload), and the shared state has
// the OLD cfg shape (no keepDisplayOn/setupMode/stateFile). The old
// `if (setupRefs === 1)` gate would have left those stale; setup() must now
// rebuild cfg from the passed options every time.
// ---------------------------------------------------------------------------
const HOT_RELOAD_STATE_KEY = Symbol.for('opencode.keep-awake.state.v1');
const originalHotReloadState = globalThis[HOT_RELOAD_STATE_KEY];
const originalStateFileEnv = process.env.KEEP_AWAKE_STATE_FILE;
const tmpStateFile = path.join(os.tmpdir(), `keep-awake-test-${process.pid}-${Date.now()}.json`);

try {
  // Never let the test touch the real user state file.
  process.env.KEEP_AWAKE_STATE_FILE = tmpStateFile;

  globalThis[HOT_RELOAD_STATE_KEY] = {
    cfg: { releaseDelayMs: 1500, maxSeconds: 43200, debug: false },
    busy: new Set(),
    awakeSince: null,
    capWarned: false,
    proc: null,
    ready: false,
    releaseTimer: null,
    cleanupTimer: null,
    setupRefs: 1,
    controller: null,
  };

  const ctx = {
    options: { keepDisplayOn: false, setupMode: 'off' },
    event: {
      subscribe({ signal } = {}) {
        return {
          [Symbol.asyncIterator]() {
            return {
              // Never yields; settles (rejects) only when the signal aborts.
              next() {
                return new Promise((_resolve, reject) => {
                  if (signal) {
                    if (signal.aborted) { reject(new Error('aborted')); return; }
                    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                  }
                });
              },
              return() { return Promise.resolve({ done: true, value: undefined }); },
            };
          },
        };
      },
    },
  };

  const cleanup = await plugin.setup(ctx);
  const S = globalThis[HOT_RELOAD_STATE_KEY];

  // Proves the new field came from options, not stale/missing config.
  assert.equal(S.cfg.keepDisplayOn, false);
  assert.equal(S.cfg.setupMode, 'off');
  assert.equal(typeof S.cfg.stateFile, 'string');
  assert.equal(S.setupChecked, true);

  if (typeof cleanup === 'function') cleanup();

  pass++;
  console.log('PASS 21 hot_reload_resolves_cfg_from_new_options');
} catch (err) {
  console.error(`FAIL 21 hot_reload_resolves_cfg_from_new_options: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
} finally {
  // Restore the pre-test global state and env var; drop any temp state file.
  if (originalHotReloadState === undefined) delete globalThis[HOT_RELOAD_STATE_KEY];
  else globalThis[HOT_RELOAD_STATE_KEY] = originalHotReloadState;
  if (originalStateFileEnv === undefined) delete process.env.KEEP_AWAKE_STATE_FILE;
  else process.env.KEEP_AWAKE_STATE_FILE = originalStateFileEnv;
  try { fs.rmSync(tmpStateFile, { force: true }); } catch { /* ignore */ }
}

console.log(`\n${pass} checks passed`);
if (process.exitCode) console.error('SOME CHECKS FAILED');
