import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { DB_PATH_SOURCES, getDbScopeLabel } from './db-scope-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultDbFileName = 'workflow-closure.db';
const defaultDbRoot = path.join(__dirname, 'workspaces');
const defaultProfileDbRoot = path.join(defaultDbRoot, 'profiles');
const defaultDbPath = path.join(__dirname, defaultDbFileName);
const dbRegistry = new Map();
const dbLockDepthRegistry = new Map();

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLockOwnerPid(lockFile) {
  try {
    const text = fs.readFileSync(lockFile, 'utf8').trim();
    if (!/^\d+$/.test(text)) {
      return null;
    }

    const pid = Number(text);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function tryClearStaleFileLock(lockFile) {
  const pid = readLockOwnerPid(lockFile);
  if (pid == null || pid === process.pid || isProcessAlive(pid)) {
    return false;
  }

  try {
    fs.unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire a cross-process advisory lock using atomic file creation.
 * Returns true on success, false on timeout.
 */
function acquireFileLock(lockFile, timeoutMs = 30000) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o666);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch {
      tryClearStaleFileLock(lockFile);
      const elapsed = Date.now() - start;
      const delay = Math.min(50 + Math.floor(Math.random() * 30), elapsed > 10000 ? 200 : 100);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
  return false;
}

function releaseFileLock(lockFile) {
  try {
    fs.unlinkSync(lockFile);
  } catch {
    // Ignore
  }
}

export function normalizeWorkspacePath(workspacePath) {
  const text = normalizeOptionalText(workspacePath);
  if (!text) {
    return null;
  }

  let resolvedPath = path.normalize(path.resolve(text));
  const root = path.parse(resolvedPath).root;

  while (resolvedPath.length > root.length && /[\\/]$/.test(resolvedPath)) {
    resolvedPath = resolvedPath.slice(0, -1);
  }

  return process.platform === 'win32'
    ? resolvedPath.toLowerCase()
    : resolvedPath;
}

export function resolveWorkspaceIdentity(input = {}) {
  const options = normalizeDbResolutionInput(input);
  const canonicalWorkspacePath = normalizeWorkspacePath(options.workspacePath);

  if (!canonicalWorkspacePath) {
    return {
      workspacePath: null,
      canonicalWorkspacePath: null,
      workspaceKey: null
    };
  }

  return {
    workspacePath: canonicalWorkspacePath,
    canonicalWorkspacePath,
    workspaceKey: createWorkspaceKey(canonicalWorkspacePath)
  };
}

/**
 * Execute a function with cross-process write locking.
 * This ensures only one process writes to the database at a time,
 * preventing "database is locked" errors in multi-agent scenarios.
 */
export async function withDbLock(dbPathOrOptions, fn, timeoutMs = 30000) {
  const resolvedPath = resolveDbPath(dbPathOrOptions);
  const currentDepth = dbLockDepthRegistry.get(resolvedPath) || 0;

  if (currentDepth > 0) {
    dbLockDepthRegistry.set(resolvedPath, currentDepth + 1);
    try {
      return await fn(getDb(resolvedPath));
    } finally {
      const nextDepth = (dbLockDepthRegistry.get(resolvedPath) || 1) - 1;
      if (nextDepth <= 0) {
        dbLockDepthRegistry.delete(resolvedPath);
      } else {
        dbLockDepthRegistry.set(resolvedPath, nextDepth);
      }
    }
  }

  const lockFile = resolvedPath + '.lock';

  if (!acquireFileLock(lockFile, timeoutMs)) {
    throw new Error(`Timeout waiting for database lock on ${resolvedPath}. Another agent may be holding it.`);
  }

  dbLockDepthRegistry.set(resolvedPath, 1);
  try {
    return await fn(getDb(resolvedPath));
  } finally {
    const nextDepth = (dbLockDepthRegistry.get(resolvedPath) || 1) - 1;
    if (nextDepth <= 0) {
      dbLockDepthRegistry.delete(resolvedPath);
    } else {
      dbLockDepthRegistry.set(resolvedPath, nextDepth);
    }
    releaseFileLock(lockFile);
  }
}

export function getDb(dbPathOrOptions = defaultDbPath) {
  const resolvedPath = resolveDbPath(dbPathOrOptions);

  if (!dbRegistry.has(resolvedPath)) {
    const db = new Database(resolvedPath);
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    try {
      db.pragma('journal_mode = WAL');
    } catch (error) {
      if (!/database is locked/i.test(String(error))) {
        throw error;
      }
    }
    dbRegistry.set(resolvedPath, db);
  }

  return dbRegistry.get(resolvedPath);
}

export function closeDb(dbPath) {
  if (dbPath) {
    const resolvedPath = resolveDbPath(dbPath);
    const db = dbRegistry.get(resolvedPath);
    if (db) {
      db.close();
      dbRegistry.delete(resolvedPath);
    }
    return;
  }

  for (const db of dbRegistry.values()) {
    db.close();
  }
  dbRegistry.clear();
}

export function resolveDbPath(options = {}) {
  return resolveDbTarget(options).dbPath;
}

export function resolveDbTarget(options = {}) {
  const input = normalizeDbResolutionInput(options);
  const explicitDbPath = normalizeOptionalText(input.dbPath);
  const dbProfile = resolveDbProfile(input);
  const workspaceIdentity = resolveWorkspaceIdentity(input);
  let dbPath;
  let dbPathSource;

  if (explicitDbPath) {
    dbPath = path.resolve(explicitDbPath);
    dbPathSource = DB_PATH_SOURCES.explicit;
  } else if (dbProfile) {
    dbPath = resolveDbProfilePath(dbProfile);
    dbPathSource = DB_PATH_SOURCES.profile;
  } else if (workspaceIdentity.workspaceKey) {
    dbPath = path.resolve(path.join(defaultDbRoot, workspaceIdentity.workspaceKey, defaultDbFileName));
    dbPathSource = DB_PATH_SOURCES.workspace;
  } else {
    dbPath = path.resolve(defaultDbPath);
    dbPathSource = DB_PATH_SOURCES.default;
  }

  return {
    dbPath,
    dbPathSource,
    dbScopeLabel: getDbScopeLabel(dbPathSource),
    dbProfile,
    workspacePath: workspaceIdentity.workspacePath,
    canonicalWorkspacePath: workspaceIdentity.canonicalWorkspacePath,
    workspaceKey: workspaceIdentity.workspaceKey
  };
}

export function resolveDbProfile(input = {}) {
  const options = normalizeDbResolutionInput(input);
  const profile = normalizeOptionalText(options.dbProfile) || normalizeOptionalText(options.profile);
  if (!profile) {
    return null;
  }

  return normalizeDbProfileName(profile);
}

export function resolveDbProfilePath(profileName) {
  return path.resolve(path.join(defaultProfileDbRoot, normalizeDbProfileName(profileName), defaultDbFileName));
}

export function getDefaultDbPath(options = {}) {
  return resolveDbTarget({ ...normalizeDbResolutionInput(options), dbProfile: null, profile: null, dbPath: null }).dbPath;
}

function normalizeDbResolutionInput(value) {
  if (typeof value === 'string') {
    return { dbPath: value };
  }

  if (value && typeof value === 'object') {
    return value;
  }

  return {};
}

function normalizeDbProfileName(value) {
  const text = normalizeOptionalText(value);
  if (!text) {
    throw new Error('dbProfile is required.');
  }

  const profile = text.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile)) {
    throw new Error('dbProfile must start with a letter or number and contain only letters, numbers, dots, underscores, or dashes.');
  }

  if (profile.includes('..')) {
    throw new Error('dbProfile cannot contain consecutive dots.');
  }

  return profile;
}

function createWorkspaceKey(canonicalWorkspacePath) {
  const workspaceName = path.basename(canonicalWorkspacePath) || 'workspace';
  const hash = crypto.createHash('sha256').update(canonicalWorkspacePath).digest('hex').slice(0, 16);
  return `${slugifyWorkspaceName(workspaceName)}-${hash}`;
}

function slugifyWorkspaceName(value) {
  const text = normalizeOptionalText(value);
  if (!text) {
    return 'workspace';
  }

  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'workspace';
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}
