#!/usr/bin/env node
/**
 * i118 Phone Assistant State Engine
 * Zero-dependency state, concurrency locking, and disaster recovery manager.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT_STATE_DIR = process.env.I118_STATE_DIR || path.join(os.homedir(), '.i118', 'plugin');
const STATE_NAMESPACE = process.env.I118_STATE_NAMESPACE || 'orders';
// Lowercase-only names behave consistently on case-sensitive and case-insensitive filesystems.
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

if (!NAMESPACE_PATTERN.test(STATE_NAMESPACE) || STATE_NAMESPACE === '.' || STATE_NAMESPACE === '..') {
  console.error(JSON.stringify({ error: 'Invalid I118_STATE_NAMESPACE' }));
  process.exit(1);
}

// Preserve the existing order routine at ~/.i118/plugin. Additional independent routines are nested below it.
const STATE_DIR = STATE_NAMESPACE === 'orders'
  ? ROOT_STATE_DIR
  : path.join(ROOT_STATE_DIR, 'routines', STATE_NAMESPACE);
const STATE_FILE = path.join(STATE_DIR, 'order_state.json');
const BACKUP_FILE = path.join(STATE_DIR, 'order_state.json.bak');
const LEDGER_FILE = path.join(STATE_DIR, 'order_history.jsonl');
const LOCK_FILE = path.join(STATE_DIR, 'state.lock');
const LOCK_BREAKER_FILE = path.join(STATE_DIR, 'state.lock.breaker');

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_TIMEOUT_MS = 30000;
const LOCK_BREAKER_GRACE_MS = 100;
const CLAIM_TIMEOUT_MS = 300000;
const ROLLING_WINDOW_LIMIT = 1000;
const STATE_VERSION = '1.3';
const LEDGER_SUCCESS_INDEX = Symbol('ledgerSuccessIndex');

class CommandError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function createOrganizationState() {
  return {
    lastProcessedOrderId: null,
    lastProcessedCreatedAt: null,
    lastRunAt: null,
    inFlightOrders: {},
    processedOrderIds: [],
    processedOrderCreatedAt: {},
    processedClaimTokenHashes: {}
  };
}

function createState() {
  return {
    version: STATE_VERSION,
    namespace: STATE_NAMESPACE,
    organizationResetTokens: {},
    organizations: {}
  };
}

function requireOrganizationId(organizationId) {
  if (!organizationId || !organizationId.trim()) {
    throw new CommandError('missing_organization_id');
  }
}

function requireClaimToken(claimToken) {
  if (!claimToken || !claimToken.trim()) {
    throw new CommandError('missing_claim_token');
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateOptionalString(value, fieldName) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}`);
  }
}

function validateStringMap(value, fieldName) {
  if (value === undefined) return;
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
    throw new Error(`Invalid ${fieldName}`);
  }
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidTimestamp(value) {
  return isNonemptyString(value) && !Number.isNaN(Date.parse(value));
}

function validateOrganizationState(state, { allowLegacyClaimTokens = false } = {}) {
  if (!isRecord(state)) throw new Error('Invalid organization state');
  validateOptionalString(state.lastProcessedOrderId, 'lastProcessedOrderId');
  validateOptionalString(state.lastProcessedCreatedAt, 'lastProcessedCreatedAt');
  validateOptionalString(state.lastRunAt, 'lastRunAt');
  if (state.processedOrderIds !== undefined && (
    !Array.isArray(state.processedOrderIds)
    || state.processedOrderIds.some((orderId) => typeof orderId !== 'string')
  )) {
    throw new Error('Invalid processedOrderIds');
  }
  validateStringMap(state.processedOrderCreatedAt, 'processedOrderCreatedAt');
  validateStringMap(state.processedClaimTokenHashes, 'processedClaimTokenHashes');
  if (state.inFlightOrders !== undefined && !isRecord(state.inFlightOrders)) {
    throw new Error('Invalid inFlightOrders');
  }
  for (const claim of Object.values(state.inFlightOrders || {})) {
    if (!isRecord(claim)) throw new Error('Invalid in-flight claim');
    for (const fieldName of ['claimToken', 'claimedBy', 'claimedAt', 'createdAt', 'expiresAt', 'releasedAt', 'status']) {
      validateOptionalString(claim[fieldName], fieldName);
    }
    if (!isValidTimestamp(claim.createdAt)) throw new Error('Invalid claim createdAt');
    if (claim.status === 'pending') {
      if (!isValidTimestamp(claim.releasedAt)) throw new Error('Invalid releasedAt');
      continue;
    }
    if (claim.status !== undefined) throw new Error('Invalid claim status');
    if (!isValidTimestamp(claim.claimedAt) || !isValidTimestamp(claim.expiresAt)) {
      throw new Error('Invalid active claim timestamps');
    }
    if (!allowLegacyClaimTokens && !isNonemptyString(claim.claimToken)) {
      throw new Error('Invalid active claim token');
    }
    if (claim.claimToken !== undefined && !isNonemptyString(claim.claimToken)) {
      throw new Error('Invalid active claim token');
    }
  }
}

function normalizeOrganizationState(state = {}, options = {}) {
  validateOrganizationState(state, options);
  return {
    lastProcessedOrderId: state.lastProcessedOrderId || null,
    lastProcessedCreatedAt: state.lastProcessedCreatedAt || null,
    lastRunAt: state.lastRunAt || null,
    inFlightOrders: state.inFlightOrders && typeof state.inFlightOrders === 'object'
      ? state.inFlightOrders
      : {},
    processedOrderIds: Array.isArray(state.processedOrderIds) ? state.processedOrderIds : [],
    processedOrderCreatedAt: isRecord(state.processedOrderCreatedAt)
      ? state.processedOrderCreatedAt
      : {},
    processedClaimTokenHashes: isRecord(state.processedClaimTokenHashes)
      ? state.processedClaimTokenHashes
      : {}
  };
}

function normalizeState(state) {
  const migrated = createState();

  if (
    state
    && (state.version === '1.2' || state.version === STATE_VERSION)
    && state.organizations
    && typeof state.organizations === 'object'
    && !Array.isArray(state.organizations)
  ) {
    validateStringMap(state.organizationResetTokens, 'organizationResetTokens');
    migrated.organizationResetTokens = state.organizationResetTokens || {};
    for (const [organizationId, organizationState] of Object.entries(state.organizations)) {
      migrated.organizations[organizationId] = normalizeOrganizationState(organizationState, {
        allowLegacyClaimTokens: state.version === '1.2'
      });
    }
    if (state.unscopedLegacyState) {
      migrated.unscopedLegacyState = state.unscopedLegacyState;
    }
    return migrated;
  }

  if (state && state.organizationId) {
    migrated.organizations[state.organizationId] = normalizeOrganizationState(state, { allowLegacyClaimTokens: true });
  } else if (state && (state.lastProcessedOrderId || state.lastProcessedCreatedAt || (state.processedOrderIds || []).length)) {
    // Legacy state without an organization cannot safely be reused.
    migrated.unscopedLegacyState = state;
  }

  if (state && (state.organizationId || state.lastProcessedOrderId || state.lastProcessedCreatedAt || (state.processedOrderIds || []).length)) {
    return migrated;
  }

  throw new Error('Invalid state schema');
}

function getOrganizationState(state, organizationId, create = true) {
  requireOrganizationId(organizationId);
  if (!state.organizations[organizationId] && create) {
    state.organizations[organizationId] = createOrganizationState();
  }
  return state.organizations[organizationId] || createOrganizationState();
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  fs.chmodSync(directory, DIRECTORY_MODE);
}

function hardenExistingFile(fileName) {
  if (fs.existsSync(fileName)) {
    fs.chmodSync(fileName, FILE_MODE);
  }
}

function ensureDir() {
  ensurePrivateDirectory(ROOT_STATE_DIR);
  if (STATE_NAMESPACE !== 'orders') {
    ensurePrivateDirectory(path.join(ROOT_STATE_DIR, 'routines'));
    ensurePrivateDirectory(STATE_DIR);
  }
  for (const fileName of [STATE_FILE, BACKUP_FILE, LEDGER_FILE, LOCK_FILE, LOCK_BREAKER_FILE]) {
    hardenExistingFile(fileName);
  }
}

function writePrivateFile(fileName, data, flag = 'w') {
  fs.writeFileSync(fileName, data, { encoding: 'utf8', flag, mode: FILE_MODE });
  fs.chmodSync(fileName, FILE_MODE);
}

function appendPrivateDurableLine(fileName, line) {
  const fd = fs.openSync(fileName, 'a', FILE_MODE);
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(fileName, FILE_MODE);
}

function waitSynchronously(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function writeExclusiveLockFile(fileName, tokenField, token) {
  const fd = fs.openSync(fileName, 'wx', FILE_MODE);
  try {
    fs.writeSync(fd, JSON.stringify({
      [tokenField]: token,
      pid: process.pid,
      time: new Date().toISOString()
    }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(fileName, FILE_MODE);
}

function writeExclusiveBreakerFile(token) {
  const temporaryFile = `${LOCK_BREAKER_FILE}.${process.pid}.${token}.tmp`;
  try {
    writePrivateFile(temporaryFile, JSON.stringify({
      breakerToken: token,
      pid: process.pid,
      time: new Date().toISOString()
    }), 'wx');
    fs.linkSync(temporaryFile, LOCK_BREAKER_FILE);
    fs.chmodSync(LOCK_BREAKER_FILE, FILE_MODE);
  } finally {
    try { fs.unlinkSync(temporaryFile); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function removeOwnedLockFile(fileName, tokenField, token) {
  if (!token || !fs.existsSync(fileName)) return;
  try {
    const stored = JSON.parse(fs.readFileSync(fileName, 'utf8'));
    if (stored[tokenField] === token) fs.unlinkSync(fileName);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function lockAppearsStale() {
  try {
    return Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_TIMEOUT_MS;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function breakerAppearsStale() {
  try {
    return Date.now() - fs.statSync(LOCK_BREAKER_FILE).mtimeMs > LOCK_TIMEOUT_MS;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function tryRecoverDeadBreaker() {
  if (!breakerAppearsStale()) return;
  let stored = null;
  try { stored = JSON.parse(fs.readFileSync(LOCK_BREAKER_FILE, 'utf8')); } catch (error) {}
  if (stored && isProcessAlive(stored.pid)) return;
  if (typeof stored?.breakerToken !== 'string') return;
  removeOwnedLockFile(LOCK_BREAKER_FILE, 'breakerToken', stored.breakerToken);
}

function tryRecoverDeadStaleLock() {
  const breakerToken = crypto.randomUUID();
  try {
    writeExclusiveBreakerFile(breakerToken);
  } catch (error) {
    if (error.code === 'EEXIST') return;
    throw error;
  }

  try {
    // A contender that acquired just before the breaker appeared sees this file after its own create and backs out.
    waitSynchronously(LOCK_BREAKER_GRACE_MS);
    if (!fs.existsSync(LOCK_FILE)) return;
    const stats = fs.statSync(LOCK_FILE);
    if (Date.now() - stats.mtimeMs <= LOCK_TIMEOUT_MS) return;

    let stored = null;
    try { stored = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch (error) {}
    if (stored && isProcessAlive(stored.pid)) return;

    try { fs.unlinkSync(LOCK_FILE); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  } finally {
    removeOwnedLockFile(LOCK_BREAKER_FILE, 'breakerToken', breakerToken);
  }
}

function acquireLock(maxWaitMs = 5000) {
  ensureDir();
  const startTime = Date.now();
  const lockToken = crypto.randomUUID();

  while (Date.now() - startTime < maxWaitMs) {
    if (fs.existsSync(LOCK_BREAKER_FILE)) {
      tryRecoverDeadBreaker();
      waitSynchronously(50);
      continue;
    }

    try {
      writeExclusiveLockFile(LOCK_FILE, 'lockToken', lockToken);
      if (fs.existsSync(LOCK_BREAKER_FILE)) {
        removeOwnedLockFile(LOCK_FILE, 'lockToken', lockToken);
        waitSynchronously(50);
        continue;
      }
      return lockToken;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (lockAppearsStale()) tryRecoverDeadStaleLock();
      waitSynchronously(50);
    }
  }

  return null;
}

function releaseLock(lockToken) {
  removeOwnedLockFile(LOCK_FILE, 'lockToken', lockToken);
}

function readLedgerEntries() {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  const entries = [];
  const lines = fs.readFileSync(LEDGER_FILE, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.status === 'success') {
        if (
          typeof entry.orderId === 'string'
          && typeof entry.organizationId === 'string'
          && (entry.createdAt === undefined || typeof entry.createdAt === 'string')
          && (entry.claimTokenHash === undefined || typeof entry.claimTokenHash === 'string')
        ) entries.push(entry);
      } else if (
        entry.status === 'reset'
        && typeof entry.organizationId === 'string'
        && typeof entry.resetToken === 'string'
      ) {
        entries.push(entry);
      }
    } catch (error) {}
  }
  return entries;
}

function reconcileLedger(state, entries) {
  let changed = false;
  const ledgerIndex = new Map();
  const organizationIds = new Set(Object.keys(state.organizations || {}));
  const latestResetIndexes = new Map();
  state.organizationResetTokens = state.organizationResetTokens || {};
  for (const [index, entry] of entries.entries()) {
    organizationIds.add(entry.organizationId);
    if (entry.status === 'reset') latestResetIndexes.set(entry.organizationId, index);
  }
  for (const [organizationId, resetIndex] of latestResetIndexes) {
    const resetEntry = entries[resetIndex];
    if (state.organizationResetTokens[organizationId] !== resetEntry.resetToken) {
      delete state.organizations[organizationId];
      state.organizationResetTokens[organizationId] = resetEntry.resetToken;
      changed = true;
    }
  }
  const successEntries = entries.filter((entry, index) => (
    entry.status === 'success'
    && index > (latestResetIndexes.get(entry.organizationId) ?? -1)
  ));
  for (const entry of successEntries) {
    ledgerIndex.set(`${entry.organizationId}\0${entry.orderId}`, entry);
  }

  for (const organizationId of organizationIds) {
    if (
      !state.organizations[organizationId]
      && !successEntries.some((entry) => entry.organizationId === organizationId)
    ) continue;
    const organizationState = getOrganizationState(state, organizationId);
    const candidates = new Map();
    for (const orderId of organizationState.processedOrderIds || []) {
      candidates.set(orderId, {
        orderId,
        createdAt: organizationState.processedOrderCreatedAt?.[orderId] || null,
        claimTokenHash: organizationState.processedClaimTokenHashes?.[orderId] || null
      });
    }
    for (const entry of successEntries) {
      if (entry.organizationId !== organizationId) continue;
      const previous = candidates.get(entry.orderId) || {};
      candidates.set(entry.orderId, {
        orderId: entry.orderId,
        createdAt: entry.createdAt || previous.createdAt || null,
        claimTokenHash: entry.claimTokenHash || previous.claimTokenHash || null
      });
      if (organizationState.inFlightOrders[entry.orderId]) {
        delete organizationState.inFlightOrders[entry.orderId];
        changed = true;
      }
    }

    const retained = [...candidates.values()]
      .sort((first, second) => {
        const firstTime = Date.parse(first.createdAt || '');
        const secondTime = Date.parse(second.createdAt || '');
        const normalizedFirst = Number.isNaN(firstTime) ? Number.NEGATIVE_INFINITY : firstTime;
        const normalizedSecond = Number.isNaN(secondTime) ? Number.NEGATIVE_INFINITY : secondTime;
        return normalizedFirst - normalizedSecond || first.orderId.localeCompare(second.orderId);
      })
      .slice(-ROLLING_WINDOW_LIMIT);
    const processedOrderIds = retained.map((entry) => entry.orderId);
    const processedOrderCreatedAt = Object.fromEntries(
      retained.filter((entry) => entry.createdAt).map((entry) => [entry.orderId, entry.createdAt])
    );
    const processedClaimTokenHashes = Object.fromEntries(
      retained.filter((entry) => entry.claimTokenHash).map((entry) => [entry.orderId, entry.claimTokenHash])
    );
    if (JSON.stringify(organizationState.processedOrderIds) !== JSON.stringify(processedOrderIds)) changed = true;
    if (JSON.stringify(organizationState.processedOrderCreatedAt) !== JSON.stringify(processedOrderCreatedAt)) changed = true;
    if (JSON.stringify(organizationState.processedClaimTokenHashes) !== JSON.stringify(processedClaimTokenHashes)) changed = true;
    organizationState.processedOrderIds = processedOrderIds;
    organizationState.processedOrderCreatedAt = processedOrderCreatedAt;
    organizationState.processedClaimTokenHashes = processedClaimTokenHashes;
  }
  Object.defineProperty(state, LEDGER_SUCCESS_INDEX, { value: ledgerIndex, configurable: true });
  return changed;
}

function getLedgerSuccess(state, organizationId, orderId) {
  return state[LEDGER_SUCCESS_INDEX]?.get(`${organizationId}\0${orderId}`) || null;
}

function hashClaimToken(claimToken) {
  return crypto.createHash('sha256').update(claimToken).digest('hex');
}

function loadStateInternal({ repair = true } = {}) {
  let state = null;
  let source = 'empty';

  if (fs.existsSync(STATE_FILE)) {
    try {
      state = normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
      source = 'primary';
    } catch (error) {}
  }

  if (!state && fs.existsSync(BACKUP_FILE)) {
    try {
      state = normalizeState(JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8')));
      source = 'backup';
    } catch (error) {}
  }

  const ledgerEntries = readLedgerEntries();
  if (!state) {
    state = createState();
    if (ledgerEntries.length > 0) source = 'ledger';
  }
  const reconciled = reconcileLedger(state, ledgerEntries);

  if (repair && (source === 'backup' || source === 'ledger' || reconciled)) {
    saveStateAtomic(state, { backupCurrent: source === 'primary' });
  }

  return state;
}

function saveStateAtomic(state, { backupCurrent = true } = {}) {
  ensureDir();
  state.version = STATE_VERSION;
  state.namespace = STATE_NAMESPACE;

  for (const organizationState of Object.values(state.organizations || {})) {
    if (Array.isArray(organizationState.processedOrderIds) && organizationState.processedOrderIds.length > ROLLING_WINDOW_LIMIT) {
      organizationState.processedOrderIds = organizationState.processedOrderIds.slice(-ROLLING_WINDOW_LIMIT);
    }
    if (organizationState.processedOrderCreatedAt && typeof organizationState.processedOrderCreatedAt === 'object') {
      const retainedOrderIds = new Set(organizationState.processedOrderIds || []);
      organizationState.processedOrderCreatedAt = Object.fromEntries(
        Object.entries(organizationState.processedOrderCreatedAt)
          .filter(([orderId]) => retainedOrderIds.has(orderId))
      );
    }
    if (organizationState.processedClaimTokenHashes && typeof organizationState.processedClaimTokenHashes === 'object') {
      const retainedOrderIds = new Set(organizationState.processedOrderIds || []);
      organizationState.processedClaimTokenHashes = Object.fromEntries(
        Object.entries(organizationState.processedClaimTokenHashes)
          .filter(([orderId]) => retainedOrderIds.has(orderId))
      );
    }
  }

  if (backupCurrent && fs.existsSync(STATE_FILE)) {
    try {
      fs.copyFileSync(STATE_FILE, BACKUP_FILE);
      fs.chmodSync(BACKUP_FILE, FILE_MODE);
    } catch (error) {}
  }

  const temporaryFile = `${STATE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writePrivateFile(temporaryFile, JSON.stringify(state, null, 2), 'wx');
    fs.renameSync(temporaryFile, STATE_FILE);
    fs.chmodSync(STATE_FILE, FILE_MODE);
  } finally {
    if (fs.existsSync(temporaryFile)) {
      try { fs.unlinkSync(temporaryFile); } catch (error) {}
    }
  }
}

function isClaimActive(claim, now = Date.now()) {
  return Boolean(claim && claim.expiresAt && Date.parse(claim.expiresAt) > now);
}

function assertOwnedActiveClaim(state, orderId, claimToken) {
  requireClaimToken(claimToken);
  const claim = (state.inFlightOrders || {})[orderId];
  if (!claim) throw new CommandError('claim_not_found');
  if (!isClaimActive(claim)) throw new CommandError('claim_expired');
  if (!claim.claimToken || claim.claimToken !== claimToken) {
    throw new CommandError('claim_token_mismatch');
  }
  return claim;
}

function runWithLock(operation) {
  const lockToken = acquireLock();
  if (!lockToken) throw new CommandError('lock_acquisition_timeout');
  try {
    return operation();
  } finally {
    releaseLock(lockToken);
  }
}

function cmdGetFilter(organizationId) {
  requireOrganizationId(organizationId);
  runWithLock(() => {
    const state = getOrganizationState(loadStateInternal(), organizationId, false);
    const now = Date.now();
    const activeInFlight = [];

    for (const [id, claim] of Object.entries(state.inFlightOrders || {})) {
      if (isClaimActive(claim, now)) activeInFlight.push(id);
    }

    console.log(JSON.stringify({
      startDate: state.lastProcessedCreatedAt || null,
      organizationId,
      lastProcessedOrderId: state.lastProcessedOrderId || null,
      processedOrderIds: state.processedOrderIds || [],
      inFlightOrderIds: activeInFlight
    }));
  });
}

function cmdClaim(orderId, createdAt, organizationId, workerName) {
  if (!orderId || !createdAt) throw new CommandError('missing_order_id_or_created_at');
  requireOrganizationId(organizationId);

  runWithLock(() => {
    const rootState = loadStateInternal();
    const state = getOrganizationState(rootState, organizationId);
    const now = Date.now();

    if ((state.processedOrderIds || []).includes(orderId) || getLedgerSuccess(rootState, organizationId, orderId)) {
      console.log(JSON.stringify({ claimed: false, reason: 'already_processed' }));
      return;
    }

    const existingClaim = (state.inFlightOrders || {})[orderId];
    if (isClaimActive(existingClaim, now)) {
      console.log(JSON.stringify({ claimed: false, reason: 'in_flight' }));
      return;
    }

    const claimToken = crypto.randomUUID();
    const claimedBy = workerName || `${os.hostname()}:${process.pid}`;
    state.inFlightOrders = state.inFlightOrders || {};
    state.inFlightOrders[orderId] = {
      claimToken,
      claimedBy,
      claimedAt: new Date(now).toISOString(),
      createdAt,
      expiresAt: new Date(now + CLAIM_TIMEOUT_MS).toISOString()
    };

    saveStateAtomic(rootState);
    console.log(JSON.stringify({ claimed: true, orderId, agent: claimedBy, claimToken }));
  });
}

function isNewerTimestamp(candidate, current) {
  if (!candidate) return false;
  if (!current) return true;
  const candidateMs = Date.parse(candidate);
  const currentMs = Date.parse(current);
  if (Number.isNaN(candidateMs) || Number.isNaN(currentMs)) return candidate > current;
  return candidateMs > currentMs;
}

function timestampsMatch(first, second) {
  const firstMs = Date.parse(first);
  const secondMs = Date.parse(second);
  if (Number.isNaN(firstMs) || Number.isNaN(secondMs)) return first === second;
  return firstMs === secondMs;
}

function hasUnresolvedOrderAtOrBefore(state, candidate) {
  const candidateMs = Date.parse(candidate);
  return Object.values(state.inFlightOrders || {}).some((claim) => {
    if (!claim.createdAt) return true;
    const claimMs = Date.parse(claim.createdAt);
    if (Number.isNaN(candidateMs) || Number.isNaN(claimMs)) return claim.createdAt <= candidate;
    return claimMs <= candidateMs;
  });
}

function advanceCursorThroughProcessedOrders(state) {
  let latestOrderId = null;
  let latestCreatedAt = null;
  for (const [orderId, createdAt] of Object.entries(state.processedOrderCreatedAt || {})) {
    if (isNewerTimestamp(createdAt, latestCreatedAt)) {
      latestOrderId = orderId;
      latestCreatedAt = createdAt;
    }
  }

  if (
    latestCreatedAt
    && isNewerTimestamp(latestCreatedAt, state.lastProcessedCreatedAt)
    && !hasUnresolvedOrderAtOrBefore(state, latestCreatedAt)
  ) {
    state.lastProcessedOrderId = latestOrderId;
    state.lastProcessedCreatedAt = latestCreatedAt;
  }
}

function cmdCommit(orderId, createdAt, organizationId, claimToken) {
  if (!orderId || !createdAt) throw new CommandError('missing_order_id_or_created_at');
  requireOrganizationId(organizationId);
  requireClaimToken(claimToken);

  runWithLock(() => {
    const rootState = loadStateInternal();
    const state = getOrganizationState(rootState, organizationId);
    const ledgerSuccess = getLedgerSuccess(rootState, organizationId, orderId);
    if ((state.processedOrderIds || []).includes(orderId) || ledgerSuccess) {
      const storedCreatedAt = (state.processedOrderCreatedAt || {})[orderId] || ledgerSuccess?.createdAt;
      if (storedCreatedAt && !timestampsMatch(createdAt, storedCreatedAt)) {
        throw new CommandError('created_at_mismatch');
      }
      const storedClaimTokenHash = (state.processedClaimTokenHashes || {})[orderId]
        || ledgerSuccess?.claimTokenHash;
      if (!storedClaimTokenHash || storedClaimTokenHash !== hashClaimToken(claimToken)) {
        throw new CommandError('claim_token_mismatch');
      }
      console.log(JSON.stringify({
        committed: true,
        alreadyCommitted: true,
        orderId,
        lastProcessedCreatedAt: state.lastProcessedCreatedAt
      }));
      return;
    }

    const claim = assertOwnedActiveClaim(state, orderId, claimToken);
    if (!timestampsMatch(createdAt, claim.createdAt)) throw new CommandError('created_at_mismatch');
    const committedCreatedAt = claim.createdAt;
    const nowIso = new Date().toISOString();

    appendPrivateDurableLine(LEDGER_FILE, `${JSON.stringify({
      orderId,
      organizationId,
      createdAt: committedCreatedAt,
      processedAt: nowIso,
      claimTokenHash: hashClaimToken(claimToken),
      status: 'success'
    })}\n`);

    if (process.env.NODE_ENV === 'test' && process.env.I118_STATE_TEST_FAIL_AFTER_LEDGER === '1') {
      throw new CommandError('simulated_post_ledger_failure');
    }

    state.processedOrderIds = state.processedOrderIds || [];
    if (!state.processedOrderIds.includes(orderId)) state.processedOrderIds.push(orderId);
    state.processedOrderCreatedAt = state.processedOrderCreatedAt || {};
    state.processedOrderCreatedAt[orderId] = committedCreatedAt;
    state.processedClaimTokenHashes = state.processedClaimTokenHashes || {};
    state.processedClaimTokenHashes[orderId] = hashClaimToken(claimToken);
    delete state.inFlightOrders[orderId];

    advanceCursorThroughProcessedOrders(state);
    state.lastRunAt = nowIso;
    saveStateAtomic(rootState);

    console.log(JSON.stringify({
      committed: true,
      orderId,
      lastProcessedCreatedAt: state.lastProcessedCreatedAt
    }));
  });
}

function cmdRenew(orderId, organizationId, claimToken) {
  if (!orderId) throw new CommandError('missing_order_id');
  requireOrganizationId(organizationId);

  runWithLock(() => {
    const rootState = loadStateInternal();
    const state = getOrganizationState(rootState, organizationId);
    const claim = assertOwnedActiveClaim(state, orderId, claimToken);
    claim.expiresAt = new Date(Date.now() + CLAIM_TIMEOUT_MS).toISOString();
    saveStateAtomic(rootState);
    console.log(JSON.stringify({ renewed: true, orderId, expiresAt: claim.expiresAt }));
  });
}

function cmdRelease(orderId, organizationId, claimToken) {
  if (!orderId) throw new CommandError('missing_order_id');
  requireOrganizationId(organizationId);

  runWithLock(() => {
    const rootState = loadStateInternal();
    const state = getOrganizationState(rootState, organizationId);
    const claim = assertOwnedActiveClaim(state, orderId, claimToken);
    state.inFlightOrders[orderId] = {
      createdAt: claim.createdAt,
      releasedAt: new Date().toISOString(),
      status: 'pending'
    };
    saveStateAtomic(rootState);
    console.log(JSON.stringify({ released: true, orderId }));
  });
}

function cmdStatus(organizationId) {
  requireOrganizationId(organizationId);
  runWithLock(() => {
    console.log(JSON.stringify(getOrganizationState(loadStateInternal(), organizationId, false), null, 2));
  });
}

function cmdReset(organizationId) {
  requireOrganizationId(organizationId);
  runWithLock(() => {
    const rootState = loadStateInternal();
    const resetToken = crypto.randomUUID();
    appendPrivateDurableLine(LEDGER_FILE, `${JSON.stringify({
      organizationId,
      resetAt: new Date().toISOString(),
      resetToken,
      status: 'reset'
    })}\n`);
    if (process.env.NODE_ENV === 'test' && process.env.I118_STATE_TEST_FAIL_AFTER_RESET_LEDGER === '1') {
      throw new CommandError('simulated_post_reset_ledger_failure');
    }
    rootState.organizationResetTokens = rootState.organizationResetTokens || {};
    rootState.organizationResetTokens[organizationId] = resetToken;
    delete rootState.organizations[organizationId];
    saveStateAtomic(rootState);
    console.log(JSON.stringify({ reset: true, organizationId }));
  });
}

function printUsage() {
  console.log(
    'Usage: state_engine.js <get-filter|claim|renew|commit|release|status|reset> ...\n'
    + 'Set I118_STATE_NAMESPACE to isolate an independent routine; orders is the backward-compatible default.'
  );
}

function main() {
  ensureDir();
  const [,, command, ...args] = process.argv;
  switch (command) {
    case 'get-filter':
      cmdGetFilter(args[0]);
      break;
    case 'claim':
      cmdClaim(args[0], args[1], args[2], args[3]);
      break;
    case 'renew':
      cmdRenew(args[0], args[1], args[2]);
      break;
    case 'commit':
      cmdCommit(args[0], args[1], args[2], args[3]);
      break;
    case 'release':
      cmdRelease(args[0], args[1], args[2]);
      break;
    case 'status':
      cmdStatus(args[0]);
      break;
    case 'reset':
      cmdReset(args[0]);
      break;
    default:
      printUsage();
      throw new CommandError('unknown_command');
  }
}

try {
  main();
} catch (error) {
  const code = error instanceof CommandError ? error.code : 'state_engine_failure';
  console.error(JSON.stringify({ error: code }));
  process.exitCode = 1;
}
