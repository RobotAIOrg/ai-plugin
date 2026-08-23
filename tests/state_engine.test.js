const assert = require('node:assert/strict');
const { execFile, execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const enginePath = path.resolve(__dirname, '../skills/i118-order-routine/scripts/state_engine.js');

function createHarness(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'i118-state-engine-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const environment = (overrides = {}) => ({
    ...process.env,
    I118_STATE_DIR: stateDir,
    NODE_ENV: 'test',
    ...overrides,
  });

  return {
    stateDir,
    run: (args, overrides = {}) => JSON.parse(execFileSync(
      process.execPath,
      [enginePath, ...args],
      { encoding: 'utf8', env: environment(overrides) },
    )),
    runFailure: (args, overrides = {}) => {
      const child = spawn(process.execPath, [enginePath, ...args], {
        env: environment(overrides),
      });
      return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });
    },
    runAsync: (args, overrides = {}) => new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [enginePath, ...args],
        { encoding: 'utf8', env: environment(overrides) },
        (error, stdout, stderr) => {
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
            return;
          }
          resolve(JSON.parse(stdout));
        },
      );
    }),
  };
}

function claim(run, orderId, createdAt, organizationId, worker = 'worker-a', overrides = {}) {
  const result = run(['claim', orderId, createdAt, organizationId, worker], overrides);
  assert.equal(result.claimed, true);
  assert.equal(typeof result.claimToken, 'string');
  assert.ok(result.claimToken.length >= 32);
  return result.claimToken;
}

function createLegacyOrganizationState() {
  return {
    lastProcessedOrderId: null,
    lastProcessedCreatedAt: null,
    lastRunAt: null,
    inFlightOrders: {},
    processedOrderIds: [],
    processedOrderCreatedAt: {},
  };
}

test('does not advance an organization cursor past an older in-flight order', (t) => {
  const { run } = createHarness(t);
  const organizationId = 'org-a';

  const olderToken = claim(run, 'older-order', '2026-08-21T12:00:00Z', organizationId, 'worker-a');
  const newerToken = claim(run, 'newer-order', '2026-08-21T12:05:00Z', organizationId, 'worker-b');
  run(['commit', 'newer-order', '2026-08-21T12:05:00Z', organizationId, newerToken]);

  assert.equal(run(['get-filter', organizationId]).startDate, null);
  assert.ok(olderToken);
});

test('advances the cursor through completed newer work once older claims finish', (t) => {
  const { run } = createHarness(t);
  const organizationId = 'org-a';

  const olderToken = claim(run, 'older-order', '2026-08-21T12:00:00Z', organizationId, 'worker-a');
  const newerToken = claim(run, 'newer-order', '2026-08-21T12:05:00Z', organizationId, 'worker-b');
  run(['commit', 'newer-order', '2026-08-21T12:05:00Z', organizationId, newerToken]);
  run(['commit', 'older-order', '2026-08-21T12:00:00Z', organizationId, olderToken]);

  assert.equal(run(['get-filter', organizationId]).startDate, '2026-08-21T12:05:00Z');
});

test('does not advance past older released work until that order is reclaimed and committed', (t) => {
  const { run } = createHarness(t);
  const organizationId = 'org-a';
  const olderToken = claim(run, 'older-order', '2026-08-21T12:00:00Z', organizationId, 'worker-a');
  const newerToken = claim(run, 'newer-order', '2026-08-21T12:05:00Z', organizationId, 'worker-b');

  run(['release', 'older-order', organizationId, olderToken]);
  run(['commit', 'newer-order', '2026-08-21T12:05:00Z', organizationId, newerToken]);
  assert.equal(run(['get-filter', organizationId]).startDate, null);

  const reclaimedToken = claim(run, 'older-order', '2026-08-21T12:00:00Z', organizationId, 'worker-c');
  run(['commit', 'older-order', '2026-08-21T12:00:00Z', organizationId, reclaimedToken]);
  assert.equal(run(['get-filter', organizationId]).startDate, '2026-08-21T12:05:00Z');
});

test('does not advance past an older expired claim', (t) => {
  const { run, stateDir } = createHarness(t);
  const organizationId = 'org-a';
  claim(run, 'older-order', '2026-08-21T12:00:00Z', organizationId, 'worker-a');
  const newerToken = claim(run, 'newer-order', '2026-08-21T12:05:00Z', organizationId, 'worker-b');

  const statePath = path.join(stateDir, 'order_state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.organizations[organizationId].inFlightOrders['older-order'].expiresAt = '2000-01-01T00:00:00Z';
  fs.writeFileSync(statePath, JSON.stringify(state));

  run(['commit', 'newer-order', '2026-08-21T12:05:00Z', organizationId, newerToken]);
  assert.equal(run(['get-filter', organizationId]).startDate, null);
});

test('keeps order cursor and deduplication state isolated by organization', (t) => {
  const { run } = createHarness(t);

  const token = claim(run, 'order-a', '2026-08-21T12:00:00Z', 'org-a');
  run(['commit', 'order-a', '2026-08-21T12:00:00Z', 'org-a', token]);

  assert.deepEqual(run(['get-filter', 'org-b']), {
    startDate: null,
    organizationId: 'org-b',
    lastProcessedOrderId: null,
    processedOrderIds: [],
    inFlightOrderIds: [],
  });
});

test('replays ledger state without advancing past an unresolved order after snapshot loss', (t) => {
  const { run, stateDir } = createHarness(t);
  const organizationId = 'org-a';

  claim(run, 'older-order', '2026-08-21T12:00:00Z', organizationId, 'worker-a');
  const newerToken = claim(run, 'newer-order', '2026-08-21T12:05:00Z', organizationId, 'worker-b');
  run(['commit', 'newer-order', '2026-08-21T12:05:00Z', organizationId, newerToken]);
  fs.unlinkSync(path.join(stateDir, 'order_state.json'));
  fs.unlinkSync(path.join(stateDir, 'order_state.json.bak'));

  const filter = run(['get-filter', organizationId]);
  assert.equal(filter.startDate, null);
  assert.deepEqual(filter.processedOrderIds, ['newer-order']);
});

test('restores a corrupt primary without overwriting the healthy backup', (t) => {
  const { run, stateDir } = createHarness(t);
  const backup = {
    version: '1.2',
    organizations: {
      'org-a': {
        ...createLegacyOrganizationState(),
        lastProcessedOrderId: 'backed-up-order',
        lastProcessedCreatedAt: '2026-08-21T11:00:00Z',
        processedOrderIds: ['backed-up-order'],
        processedOrderCreatedAt: { 'backed-up-order': '2026-08-21T11:00:00Z' },
      },
    },
  };
  fs.writeFileSync(path.join(stateDir, 'order_state.json'), '{not-json');
  fs.writeFileSync(path.join(stateDir, 'order_state.json.bak'), JSON.stringify(backup));

  assert.deepEqual(run(['get-filter', 'org-a']).processedOrderIds, ['backed-up-order']);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(stateDir, 'order_state.json'), 'utf8')));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(stateDir, 'order_state.json.bak'), 'utf8')));
});

test('reconciles the success ledger when restoring a pre-commit backup', (t) => {
  const { run, stateDir } = createHarness(t);
  const token = claim(run, 'completed-order', '2026-08-21T12:00:00Z', 'org-a');
  run(['commit', 'completed-order', '2026-08-21T12:00:00Z', 'org-a', token]);
  fs.writeFileSync(path.join(stateDir, 'order_state.json'), '{not-json');

  const filter = run(['get-filter', 'org-a']);
  assert.deepEqual(filter.processedOrderIds, ['completed-order']);
  assert.deepEqual(filter.inFlightOrderIds, []);
});

test('recovers a committed order when the process fails after the ledger append', async (t) => {
  const { run, runFailure } = createHarness(t);
  const token = claim(run, 'completed-order', '2026-08-21T12:00:00Z', 'org-a');

  const interrupted = await runFailure([
    'commit',
    'completed-order',
    '2026-08-21T12:00:00Z',
    'org-a',
    token,
  ], { I118_STATE_TEST_FAIL_AFTER_LEDGER: '1' });
  assert.equal(interrupted.status, 1);
  assert.equal(JSON.parse(interrupted.stderr).error, 'simulated_post_ledger_failure');

  const filter = run(['get-filter', 'org-a']);
  assert.deepEqual(filter.processedOrderIds, ['completed-order']);
  assert.deepEqual(filter.inFlightOrderIds, []);
  assert.equal(
    run(['commit', 'completed-order', '2026-08-21T12:00:00Z', 'org-a', token]).alreadyCommitted,
    true,
  );
});

test('rejects structurally invalid primary JSON and restores the healthy backup', (t) => {
  const { run, stateDir } = createHarness(t);
  const backup = {
    version: '1.2',
    organizations: {
      'org-a': {
        ...createLegacyOrganizationState(),
        processedOrderIds: ['backed-up-order'],
        processedOrderCreatedAt: { 'backed-up-order': '2026-08-21T11:00:00Z' },
      },
    },
  };
  fs.writeFileSync(path.join(stateDir, 'order_state.json'), '{}');
  fs.writeFileSync(path.join(stateDir, 'order_state.json.bak'), JSON.stringify(backup));

  assert.deepEqual(run(['get-filter', 'org-a']).processedOrderIds, ['backed-up-order']);
});

test('rejects an invalid nested organization state instead of silently erasing it', (t) => {
  const { run, stateDir } = createHarness(t);
  fs.writeFileSync(path.join(stateDir, 'order_state.json'), JSON.stringify({
    version: '1.3',
    namespace: 'orders',
    organizations: { 'org-a': { processedOrderIds: 'not-an-array' } },
  }));
  fs.writeFileSync(path.join(stateDir, 'order_state.json.bak'), JSON.stringify({
    version: '1.2',
    organizations: {
      'org-a': {
        ...createLegacyOrganizationState(),
        processedOrderIds: ['backed-up-order'],
        processedOrderCreatedAt: { 'backed-up-order': '2026-08-21T11:00:00Z' },
      },
    },
  }));

  assert.deepEqual(run(['get-filter', 'org-a']).processedOrderIds, ['backed-up-order']);
});

test('rejects an incomplete in-flight claim and restores the healthy backup', (t) => {
  const { run, stateDir } = createHarness(t);
  fs.writeFileSync(path.join(stateDir, 'order_state.json'), JSON.stringify({
    version: '1.3',
    namespace: 'orders',
    organizations: { 'org-a': { ...createLegacyOrganizationState(), inFlightOrders: { bad: {} } } },
  }));
  fs.writeFileSync(path.join(stateDir, 'order_state.json.bak'), JSON.stringify({
    version: '1.2',
    organizations: {
      'org-a': {
        ...createLegacyOrganizationState(),
        processedOrderIds: ['backed-up-order'],
        processedOrderCreatedAt: { 'backed-up-order': '2026-08-21T11:00:00Z' },
      },
    },
  }));

  assert.deepEqual(run(['get-filter', 'org-a']).processedOrderIds, ['backed-up-order']);
});

test('accepts a complete tokenless version 1.2 lease for safe migration', (t) => {
  const { run, stateDir } = createHarness(t);
  fs.writeFileSync(path.join(stateDir, 'order_state.json'), JSON.stringify({
    version: '1.2',
    organizations: {
      'org-a': {
        ...createLegacyOrganizationState(),
        inFlightOrders: {
          'legacy-order': {
            claimedBy: 'legacy-worker',
            claimedAt: '2026-08-21T12:00:00Z',
            createdAt: '2026-08-21T11:59:00Z',
            expiresAt: '2026-08-21T12:05:00Z',
          },
        },
      },
    },
  }));

  assert.equal(run(['status', 'org-a']).inFlightOrders['legacy-order'].createdAt, '2026-08-21T11:59:00Z');
});

test('recovers valid ledger entries even when another ledger line is malformed', (t) => {
  const { run, stateDir } = createHarness(t);
  fs.writeFileSync(path.join(stateDir, 'order_history.jsonl'), [
    '{malformed',
    JSON.stringify({
      orderId: 'completed-order',
      organizationId: 'org-a',
      createdAt: '2026-08-21T12:00:00Z',
      processedAt: '2026-08-21T12:01:00Z',
      status: 'success',
    }),
  ].join('\n'));

  assert.deepEqual(run(['get-filter', 'org-a']).processedOrderIds, ['completed-order']);
});

test('keeps lifetime ledger successes deduplicated beyond the 1000-ID snapshot window', (t) => {
  const { run, stateDir } = createHarness(t);
  const entries = Array.from({ length: 2000 }, (_, index) => {
    const number = index + 1;
    return {
      orderId: `order-${number}`,
      organizationId: 'org-a',
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, number)).toISOString(),
      processedAt: new Date(Date.UTC(2026, 0, 1, 1, 0, number)).toISOString(),
      status: 'success',
    };
  });
  const currentWindow = entries.slice(1000);
  fs.writeFileSync(path.join(stateDir, 'order_state.json'), JSON.stringify({
    version: '1.3',
    namespace: 'orders',
    organizations: {
      'org-a': {
        ...createLegacyOrganizationState(),
        processedOrderIds: currentWindow.map((entry) => entry.orderId),
        processedOrderCreatedAt: Object.fromEntries(
          currentWindow.map((entry) => [entry.orderId, entry.createdAt]),
        ),
      },
    },
  }));
  fs.writeFileSync(
    path.join(stateDir, 'order_history.jsonl'),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );

  const firstWindow = run(['get-filter', 'org-a']).processedOrderIds;
  const secondWindow = run(['get-filter', 'org-a']).processedOrderIds;
  assert.deepEqual(secondWindow, firstWindow);
  assert.equal(firstWindow.length, 1000);
  assert.equal(firstWindow.includes('order-1500'), true);
  assert.deepEqual(
    run(['claim', 'order-1500', entries[1499].createdAt, 'org-a', 'worker-a']),
    { claimed: false, reason: 'already_processed' },
  );
});

test('rejects a second active claim even when both processes use the same worker name', (t) => {
  const { run } = createHarness(t);

  claim(run, 'same-order', '2026-08-21T12:00:00Z', 'org-a', 'shared-name');
  assert.deepEqual(
    run(['claim', 'same-order', '2026-08-21T12:00:00Z', 'org-a', 'shared-name']),
    { claimed: false, reason: 'in_flight' },
  );
});

test('allows exactly one of several concurrent same-name processes to claim an order', async (t) => {
  const { runAsync } = createHarness(t);

  const results = await Promise.all(Array.from({ length: 8 }, () => runAsync([
    'claim',
    'contended-order',
    '2026-08-21T12:00:00Z',
    'org-a',
    'shared-name',
  ])));

  assert.equal(results.filter((result) => result.claimed).length, 1);
  assert.equal(results.filter((result) => result.reason === 'in_flight').length, 7);
});

test('serializes concurrent claimers while recovering one dead stale lock', async (t) => {
  const { run, runAsync, stateDir } = createHarness(t);
  const lockPath = path.join(stateDir, 'state.lock');
  fs.writeFileSync(lockPath, JSON.stringify({
    lockToken: 'dead-lock',
    pid: 999999999,
    time: '2000-01-01T00:00:00Z',
  }));
  const oldTime = new Date('2000-01-01T00:00:00Z');
  fs.utimesSync(lockPath, oldTime, oldTime);

  const results = await Promise.all(Array.from({ length: 32 }, (_, index) => runAsync([
    'claim',
    `order-${index}`,
    `2026-08-21T12:${String(index).padStart(2, '0')}:00Z`,
    'org-a',
    `worker-${index}`,
  ])));

  assert.equal(results.filter((result) => result.claimed).length, 32);
  assert.equal(Object.keys(run(['status', 'org-a']).inFlightOrders).length, 32);
});

test('does not evict a live lock holder solely because the lock is old', async (t) => {
  const { runFailure, stateDir } = createHarness(t);
  const lockPath = path.join(stateDir, 'state.lock');
  fs.writeFileSync(lockPath, JSON.stringify({
    lockToken: 'live-lock',
    pid: process.pid,
    time: '2000-01-01T00:00:00Z',
  }));
  const oldTime = new Date('2000-01-01T00:00:00Z');
  fs.utimesSync(lockPath, oldTime, oldTime);

  const result = await runFailure([
    'claim',
    'blocked-order',
    '2026-08-21T12:00:00Z',
    'org-a',
    'worker-a',
  ]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, 'lock_acquisition_timeout');
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).lockToken, 'live-lock');
});

test('recovers an abandoned stale lock breaker', (t) => {
  const { run, stateDir } = createHarness(t);
  const breakerPath = path.join(stateDir, 'state.lock.breaker');
  fs.writeFileSync(breakerPath, JSON.stringify({
    breakerToken: 'dead-breaker',
    pid: 999999999,
    time: '2000-01-01T00:00:00Z',
  }));
  const oldTime = new Date('2000-01-01T00:00:00Z');
  fs.utimesSync(breakerPath, oldTime, oldTime);

  assert.equal(
    run(['claim', 'recoverable-order', '2026-08-21T12:00:00Z', 'org-a', 'worker-a']).claimed,
    true,
  );
  assert.equal(fs.existsSync(breakerPath), false);
});

test('does not evict a live stale lock breaker', async (t) => {
  const { runFailure, stateDir } = createHarness(t);
  const breakerPath = path.join(stateDir, 'state.lock.breaker');
  fs.writeFileSync(breakerPath, JSON.stringify({
    breakerToken: 'live-breaker',
    pid: process.pid,
    time: '2000-01-01T00:00:00Z',
  }));
  const oldTime = new Date('2000-01-01T00:00:00Z');
  fs.utimesSync(breakerPath, oldTime, oldTime);

  const result = await runFailure([
    'claim',
    'blocked-order',
    '2026-08-21T12:00:00Z',
    'org-a',
    'worker-a',
  ]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, 'lock_acquisition_timeout');
  assert.equal(JSON.parse(fs.readFileSync(breakerPath, 'utf8')).breakerToken, 'live-breaker');
});

test('requires the active claim token to commit or release', async (t) => {
  const { run, runFailure } = createHarness(t);
  const token = claim(run, 'owned-order', '2026-08-21T12:00:00Z', 'org-a');

  const wrongCommit = await runFailure([
    'commit',
    'owned-order',
    '2026-08-21T12:00:00Z',
    'org-a',
    'wrong-token',
  ]);
  assert.equal(wrongCommit.status, 1);
  assert.equal(JSON.parse(wrongCommit.stderr).error, 'claim_token_mismatch');

  const wrongRelease = await runFailure(['release', 'owned-order', 'org-a', 'wrong-token']);
  assert.equal(wrongRelease.status, 1);
  assert.equal(JSON.parse(wrongRelease.stderr).error, 'claim_token_mismatch');

  assert.equal(run(['release', 'owned-order', 'org-a', token]).released, true);
});

test('fails closed when an ownership command omits its claim token', async (t) => {
  const { run, runFailure } = createHarness(t);
  claim(run, 'owned-order', '2026-08-21T12:00:00Z', 'org-a');

  for (const args of [
    ['commit', 'owned-order', '2026-08-21T12:00:00Z', 'org-a'],
    ['renew', 'owned-order', 'org-a'],
    ['release', 'owned-order', 'org-a'],
  ]) {
    const result = await runFailure(args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error, 'missing_claim_token');
  }
});

test('authenticates idempotent commit retries with the original claim token', async (t) => {
  const { run, runFailure } = createHarness(t);
  const token = claim(run, 'committed-order', '2026-08-21T12:00:00Z', 'org-a');
  run(['commit', 'committed-order', '2026-08-21T12:00:00Z', 'org-a', token]);

  for (const retryToken of [undefined, 'wrong-token']) {
    const args = ['commit', 'committed-order', '2026-08-21T12:00:00Z', 'org-a'];
    if (retryToken) args.push(retryToken);
    const result = await runFailure(args);
    assert.equal(result.status, 1);
    assert.equal(
      JSON.parse(result.stderr).error,
      retryToken ? 'claim_token_mismatch' : 'missing_claim_token',
    );
  }

  assert.equal(
    run(['commit', 'committed-order', '2026-08-21T12:00:00Z', 'org-a', token]).alreadyCommitted,
    true,
  );
});

test('authenticates idempotent retries from the lifetime ledger after snapshot compaction', (t) => {
  const { run, stateDir } = createHarness(t);
  const token = claim(run, 'old-committed-order', '2025-01-01T00:00:00Z', 'org-a');
  run(['commit', 'old-committed-order', '2025-01-01T00:00:00Z', 'org-a', token]);

  const statePath = path.join(stateDir, 'order_state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const organization = state.organizations['org-a'];
  organization.processedOrderIds = [];
  organization.processedOrderCreatedAt = {};
  organization.processedClaimTokenHashes = {};
  fs.writeFileSync(statePath, JSON.stringify(state));

  assert.equal(
    run(['commit', 'old-committed-order', '2025-01-01T00:00:00Z', 'org-a', token]).alreadyCommitted,
    true,
  );
});

test('binds commit to the createdAt stored by the claim', async (t) => {
  const { run, runFailure } = createHarness(t);
  const token = claim(run, 'owned-order', '2026-08-21T12:00:00Z', 'org-a');

  const result = await runFailure([
    'commit',
    'owned-order',
    '2026-08-21T13:00:00Z',
    'org-a',
    token,
  ]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, 'created_at_mismatch');
  assert.deepEqual(run(['get-filter', 'org-a']).processedOrderIds, []);
});

test('renews only the active token-owned lease', async (t) => {
  const { run, runFailure } = createHarness(t);
  const token = claim(run, 'long-order', '2026-08-21T12:00:00Z', 'org-a');
  const before = run(['status', 'org-a']).inFlightOrders['long-order'].expiresAt;

  await new Promise((resolve) => setTimeout(resolve, 10));
  const renewed = run(['renew', 'long-order', 'org-a', token]);
  assert.equal(renewed.renewed, true);
  assert.ok(Date.parse(renewed.expiresAt) > Date.parse(before));

  const wrongRenewal = await runFailure(['renew', 'long-order', 'org-a', 'wrong-token']);
  assert.equal(wrongRenewal.status, 1);
  assert.equal(JSON.parse(wrongRenewal.stderr).error, 'claim_token_mismatch');
});

test('isolates unrelated routines in separate namespaces on the same machine', (t) => {
  const { run, stateDir } = createHarness(t);
  const ordersEnv = { I118_STATE_NAMESPACE: 'orders' };
  const jobsEnv = { I118_STATE_NAMESPACE: 'jobs' };

  const token = claim(run, 'order-a', '2026-08-21T12:00:00Z', 'org-a', 'worker-a', ordersEnv);
  run(['commit', 'order-a', '2026-08-21T12:00:00Z', 'org-a', token], ordersEnv);

  assert.deepEqual(run(['get-filter', 'org-a'], jobsEnv).processedOrderIds, []);
  assert.ok(fs.existsSync(path.join(stateDir, 'order_state.json')));
  assert.ok(fs.existsSync(path.join(stateDir, 'routines', 'jobs')));
});

test('reset removes only the selected organization in the selected namespace', (t) => {
  const { run } = createHarness(t);
  const ordersEnv = { I118_STATE_NAMESPACE: 'orders' };
  const jobsEnv = { I118_STATE_NAMESPACE: 'jobs' };

  for (const [organizationId, environment] of [
    ['org-a', ordersEnv],
    ['org-b', ordersEnv],
    ['org-a', jobsEnv],
  ]) {
    const token = claim(run, `order-${organizationId}-${environment.I118_STATE_NAMESPACE}`, '2026-08-21T12:00:00Z', organizationId, 'worker-a', environment);
    run(['commit', `order-${organizationId}-${environment.I118_STATE_NAMESPACE}`, '2026-08-21T12:00:00Z', organizationId, token], environment);
  }

  assert.deepEqual(run(['reset', 'org-a'], ordersEnv), { reset: true, organizationId: 'org-a' });
  assert.deepEqual(run(['get-filter', 'org-a'], ordersEnv).processedOrderIds, []);
  assert.equal(run(['get-filter', 'org-b'], ordersEnv).processedOrderIds.length, 1);
  assert.equal(run(['get-filter', 'org-a'], jobsEnv).processedOrderIds.length, 1);
});

test('reset remains durable when interrupted after its ledger boundary', async (t) => {
  const { run, runFailure } = createHarness(t);
  const token = claim(run, 'old-order', '2026-08-21T12:00:00Z', 'org-a');
  run(['commit', 'old-order', '2026-08-21T12:00:00Z', 'org-a', token]);

  const interrupted = await runFailure(
    ['reset', 'org-a'],
    { I118_STATE_TEST_FAIL_AFTER_RESET_LEDGER: '1' },
  );
  assert.equal(interrupted.status, 1);
  assert.equal(JSON.parse(interrupted.stderr).error, 'simulated_post_reset_ledger_failure');
  assert.deepEqual(run(['get-filter', 'org-a']).processedOrderIds, []);
});

test('rejects unsafe namespace names instead of allowing path traversal', async (t) => {
  const { runFailure, stateDir } = createHarness(t);

  const result = await runFailure(['get-filter', 'org-a'], { I118_STATE_NAMESPACE: '../escape' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, 'Invalid I118_STATE_NAMESPACE');
  assert.equal(fs.existsSync(path.join(stateDir, '..', 'escape')), false);
});

test('rejects uppercase namespaces to avoid case-insensitive filesystem collisions', async (t) => {
  const { runFailure } = createHarness(t);

  const result = await runFailure(['get-filter', 'org-a'], { I118_STATE_NAMESPACE: 'Jobs' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, 'Invalid I118_STATE_NAMESPACE');
});

test('migrates version 1.2 state without losing processed orders', (t) => {
  const { run, stateDir } = createHarness(t);
  fs.writeFileSync(path.join(stateDir, 'order_state.json'), JSON.stringify({
    version: '1.2',
    organizations: {
      'org-a': {
        lastProcessedOrderId: 'old-order',
        lastProcessedCreatedAt: '2026-08-21T11:00:00Z',
        lastRunAt: '2026-08-21T11:01:00Z',
        inFlightOrders: {},
        processedOrderIds: ['old-order'],
        processedOrderCreatedAt: { 'old-order': '2026-08-21T11:00:00Z' },
      },
    },
  }));

  const token = claim(run, 'new-order', '2026-08-21T12:00:00Z', 'org-a');
  run(['commit', 'new-order', '2026-08-21T12:00:00Z', 'org-a', token]);

  const migrated = JSON.parse(fs.readFileSync(path.join(stateDir, 'order_state.json'), 'utf8'));
  assert.equal(migrated.version, '1.3');
  assert.deepEqual(migrated.organizations['org-a'].processedOrderIds, ['old-order', 'new-order']);
});

test('restricts state directories and credential-bearing files to the current user', (t) => {
  const { run, stateDir } = createHarness(t);
  const token = claim(run, 'order-a', '2026-08-21T12:00:00Z', 'org-a');
  run(['commit', 'order-a', '2026-08-21T12:00:00Z', 'org-a', token]);

  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
  for (const fileName of ['order_state.json', 'order_state.json.bak', 'order_history.jsonl']) {
    assert.equal(fs.statSync(path.join(stateDir, fileName)).mode & 0o777, 0o600);
  }
});

test('restricts nested routine directories and files to the current user', (t) => {
  const { run, stateDir } = createHarness(t);
  const jobsEnv = { I118_STATE_NAMESPACE: 'jobs' };
  const token = claim(run, 'order-a', '2026-08-21T12:00:00Z', 'org-a', 'worker-a', jobsEnv);
  run(['commit', 'order-a', '2026-08-21T12:00:00Z', 'org-a', token], jobsEnv);

  const routineDirectory = path.join(stateDir, 'routines', 'jobs');
  assert.equal(fs.statSync(path.join(stateDir, 'routines')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(routineDirectory).mode & 0o777, 0o700);
  for (const fileName of ['order_state.json', 'order_state.json.bak', 'order_history.jsonl']) {
    assert.equal(fs.statSync(path.join(routineDirectory, fileName)).mode & 0o777, 0o600);
  }
});

test('returns a nonzero JSON error for an unknown command', async (t) => {
  const { runFailure } = createHarness(t);

  const result = await runFailure(['typo-command']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, 'unknown_command');
});
