import { resolveDbTarget } from '../storage/db.js';
import { createRuntimeRecoverySelector } from '../storage/db-scope-config.js';
import { POLLUTION_POLICY_VERSION, listPollutionPolicyLayers } from './pollution-policy.js';

const DEFAULT_SCOPE = 'workspace';
const DEFAULT_PROJECT_KEY = 'workflow-closure';
const DATA_CLASSES = new Set(['real', 'test', 'debug', 'unknown']);
const RETENTION_CLASSES = new Set(['keep', 'ephemeral', 'ttl', 'unknown']);

export function resolvePollutionBoundary(input = {}) {
  const normalized = normalizeBoundaryInput(input);
  const db = resolveDbTarget(normalized);
  const projectKey = normalized.projectKey || normalized.dbProfile || db.dbProfile || DEFAULT_PROJECT_KEY;
  const workspacePath = normalized.workspacePath || db.workspacePath || null;
  const sessionId = normalized.sessionId || null;
  const temporary = Boolean(normalized.temporary);
  const dataClass = normalizeDataClass(normalized.dataClass, temporary);
  const retention = normalizeRetention(normalized.retention, temporary, dataClass);
  const generatedBy = normalized.generatedBy || 'pollution-boundary';
  const memory = buildScopedBoundary(normalized.memory, {
    scope: normalized.scope || DEFAULT_SCOPE,
    projectKey,
    workspacePath,
    sessionId,
    limit: normalized.memoryLimit
  });
  const context = buildScopedBoundary(normalized.context, {
    scope: normalized.scope || DEFAULT_SCOPE,
    projectKey,
    workspacePath,
    sessionId,
    limit: normalized.contextLimit
  });
  const workflowHygieneMetadata = {
    dataClass,
    retention,
    generatedBy,
    pollutionBoundary: {
      version: POLLUTION_POLICY_VERSION,
      temporary,
      projectKey,
      dbScopeLabel: db.dbScopeLabel
    }
  };

  return {
    version: POLLUTION_POLICY_VERSION,
    kind: temporary ? 'temporary-task' : 'project-boundary',
    temporary,
    projectKey,
    workspacePath,
    sessionId,
    db: {
      dbPath: db.dbPath,
      dbPathSource: db.dbPathSource,
      dbScopeLabel: db.dbScopeLabel,
      dbProfile: db.dbProfile,
      workspacePath: db.workspacePath,
      workspaceKey: db.workspaceKey,
      recoverySelector: createRuntimeRecoverySelector(db)
    },
    memory,
    context,
    workflowHygieneMetadata,
    artifactPolicy: {
      workspacePath,
      generatedRoot: 'artifacts/workflows',
      cleanable: temporary || dataClass === 'test' || dataClass === 'debug',
      pathBoundary: 'must-stay-within-workspace'
    },
    cleanupPolicy: {
      retention,
      autoCleanCandidates: temporary || retention === 'ephemeral'
        ? ['artifacts', 'storage/test-workspaces']
        : [],
      protectedTargets: ['storage/workspaces', '.claude/worktrees']
    },
    policyLayers: listPollutionPolicyLayers().map((layer) => layer.id)
  };
}

function normalizeBoundaryInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  return {
    ...input,
    dbProfile: normalizeOptionalText(input.dbProfile ?? input.profile),
    dbPath: normalizeOptionalText(input.dbPath),
    workspacePath: normalizeOptionalText(input.workspacePath),
    projectKey: normalizeOptionalText(input.projectKey),
    sessionId: normalizeOptionalText(input.sessionId),
    scope: normalizeOptionalText(input.scope),
    dataClass: normalizeOptionalText(input.dataClass),
    retention: normalizeOptionalText(input.retention),
    generatedBy: normalizeOptionalText(input.generatedBy),
    temporary: input.temporary === true || input.ephemeral === true,
    memoryLimit: normalizeOptionalPositiveInteger(input.memoryLimit),
    contextLimit: normalizeOptionalPositiveInteger(input.contextLimit),
    memory: normalizeOptionalObject(input.memory),
    context: normalizeOptionalObject(input.context)
  };
}

function buildScopedBoundary(value, defaults) {
  const options = normalizeOptionalObject(value) || {};
  return {
    scope: normalizeOptionalText(options.scope) || defaults.scope,
    projectKey: normalizeOptionalText(options.projectKey) || defaults.projectKey,
    workspacePath: normalizeOptionalText(options.workspacePath) || defaults.workspacePath,
    sessionId: normalizeOptionalText(options.sessionId) || defaults.sessionId,
    limit: normalizeOptionalPositiveInteger(options.limit) || defaults.limit || undefined
  };
}

function normalizeDataClass(value, temporary) {
  const text = normalizeOptionalText(value)?.toLowerCase();
  if (text && !DATA_CLASSES.has(text)) {
    throw new Error(`Unsupported dataClass: ${value}`);
  }
  return text || (temporary ? 'test' : 'unknown');
}

function normalizeRetention(value, temporary, dataClass) {
  const text = normalizeOptionalText(value)?.toLowerCase();
  if (text && !RETENTION_CLASSES.has(text)) {
    throw new Error(`Unsupported retention: ${value}`);
  }
  if (text) {
    return text;
  }
  if (temporary || dataClass === 'test' || dataClass === 'debug') {
    return 'ephemeral';
  }
  if (dataClass === 'real') {
    return 'keep';
  }
  return 'unknown';
}

function normalizeOptionalObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalizeOptionalPositiveInteger(value) {
  if (value == null || value === '') {
    return null;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Expected positive integer: ${value}`);
  }
  return number;
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text || null;
}
