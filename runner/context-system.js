import { normalizeWorkspacePath } from '../storage/db.js';
import { initializeContextStore, getContextStore } from '../storage/contexts.js';

const DEFAULT_CONTEXT_SCOPE = 'workspace';
const DEFAULT_CONTEXT_LIMIT = 10;

export async function createAgentContextSystem(options = {}) {
  await initializeContextStore(options);
  const store = getContextStore(options);
  const defaultBoundary = resolveContextBoundaryDefaults(options);

  return {
    writeItem(input = {}) {
      return store.createContextItem(normalizeContextItemInput(applyContextBoundaryDefaults(input, defaultBoundary)));
    },
    updateItem(input = {}) {
      return store.updateContextItem(normalizeContextItemUpdate(applyContextBoundaryDefaultsToUpdate(input, defaultBoundary)));
    },
    queryItems(query = {}) {
      return store.listContextItems(normalizeContextQuery(applyContextBoundaryDefaults(query, defaultBoundary)));
    },
    getItemState(input = {}) {
      const contextId = normalizeRequiredText(input.contextId, 'Context id');
      return store.getContextItemState(contextId);
    },
    writeSnapshot(input = {}) {
      return store.createContextSnapshot(normalizeContextSnapshotInput(applyContextBoundaryDefaults(input, defaultBoundary)));
    },
    querySnapshots(query = {}) {
      return store.listContextSnapshots(normalizeContextQuery(applyContextBoundaryDefaults(query, defaultBoundary)));
    },
    getSnapshotState(input = {}) {
      const snapshotId = normalizeRequiredText(input.snapshotId, 'Snapshot id');
      return store.getContextSnapshotState(snapshotId);
    }
  };
}

export async function resolveAgentContextSystem(options = {}) {
  if (isContextSystem(options.contextSystem)) {
    return options.contextSystem;
  }

  const contextOptions = normalizeContextOptions(options.context);
  if (!contextOptions) {
    return null;
  }

  if (isContextSystem(options.context)) {
    return options.context;
  }

  if (isContextSystem(contextOptions.system)) {
    return contextOptions.system;
  }

  return createAgentContextSystem({
    dbPath: contextOptions.dbPath || options.dbPath,
    workspacePath: normalizeWorkspacePath(contextOptions.workspacePath ?? options.workspacePath)
  });
}

export function resolveContextIntegrationContext(options = {}) {
  const contextOptions = normalizeContextOptions(options.context);

  return {
    enabled: Boolean(contextOptions),
    scope: normalizeOptionalText(contextOptions?.scope) || normalizeOptionalText(options.scope) || DEFAULT_CONTEXT_SCOPE,
    projectKey: normalizeOptionalText(contextOptions?.projectKey) || normalizeOptionalText(options.projectKey),
    workspacePath: normalizeWorkspacePath(contextOptions?.workspacePath ?? options.workspacePath),
    sessionId: normalizeOptionalText(contextOptions?.sessionId) || normalizeOptionalText(options.sessionId),
    limit: normalizePositiveInteger(contextOptions?.limit ?? options.contextLimit ?? DEFAULT_CONTEXT_LIMIT, 'Context query limit')
  };
}

export function upsertContextItemBySource(contextSystem, input = {}) {
  if (!contextSystem) {
    return null;
  }

  const scope = normalizeRequiredText(input.scope, 'Context scope');
  const sourceKind = normalizeRequiredText(input.sourceKind, 'Context sourceKind');
  const sourceRef = normalizeRequiredText(input.sourceRef, 'Context sourceRef');
  const workspacePath = normalizeWorkspacePath(input.workspacePath);
  const query = {
    scope,
    sourceKind,
    sourceRef,
    limit: 1
  };

  if (input.projectKey != null) {
    query.projectKey = normalizeRequiredText(input.projectKey, 'projectKey');
  }

  if (workspacePath != null) {
    query.workspacePath = workspacePath;
  }

  if (input.sessionId != null) {
    query.sessionId = normalizeRequiredText(input.sessionId, 'sessionId');
  }

  if (input.workflowId != null) {
    query.workflowId = normalizeRequiredText(input.workflowId, 'workflowId');
  }

  if (input.taskId != null) {
    query.taskId = normalizeRequiredText(input.taskId, 'taskId');
  }

  if (input.chainId != null) {
    query.chainId = normalizeRequiredText(input.chainId, 'chainId');
  }

  if (input.stageId != null) {
    query.stageId = normalizeRequiredText(input.stageId, 'stageId');
  }

  const existing = contextSystem.queryItems(query).items[0] || null;

  if (existing) {
    return contextSystem.updateItem({
      contextId: existing.contextId,
      kind: normalizeRequiredText(input.kind, 'Context kind'),
      scope,
      projectKey: normalizeOptionalText(input.projectKey),
      workspacePath,
      sessionId: normalizeOptionalText(input.sessionId),
      workflowId: normalizeOptionalText(input.workflowId),
      taskId: normalizeOptionalText(input.taskId),
      chainId: normalizeOptionalText(input.chainId),
      stageId: normalizeOptionalText(input.stageId),
      sourceKind,
      sourceRef,
      title: normalizeOptionalText(input.title),
      summary: normalizeOptionalText(input.summary),
      content: normalizeRequiredText(input.content, 'Context content'),
      metadata: input.metadata ?? null,
      priority: input.priority == null ? undefined : normalizeInteger(input.priority, 'priority')
    });
  }

  return contextSystem.writeItem({
    kind: normalizeRequiredText(input.kind, 'Context kind'),
    scope,
    projectKey: normalizeOptionalText(input.projectKey),
    workspacePath,
    sessionId: normalizeOptionalText(input.sessionId),
    workflowId: normalizeOptionalText(input.workflowId),
    taskId: normalizeOptionalText(input.taskId),
    chainId: normalizeOptionalText(input.chainId),
    stageId: normalizeOptionalText(input.stageId),
    sourceKind,
    sourceRef,
    title: normalizeOptionalText(input.title),
    summary: normalizeOptionalText(input.summary),
    content: normalizeRequiredText(input.content, 'Context content'),
    metadata: input.metadata ?? null,
    priority: input.priority == null ? undefined : normalizeInteger(input.priority, 'priority')
  });
}


function resolveContextBoundaryDefaults(options = {}) {
  const contextOptions = normalizeContextOptions(options.context);

  return {
    scope: normalizeOptionalText(contextOptions?.scope) || normalizeOptionalText(options.scope) || DEFAULT_CONTEXT_SCOPE,
    projectKey: normalizeOptionalText(contextOptions?.projectKey) || normalizeOptionalText(options.projectKey),
    workspacePath: normalizeWorkspacePath(contextOptions?.workspacePath ?? options.workspacePath),
    sessionId: normalizeOptionalText(contextOptions?.sessionId) || normalizeOptionalText(options.sessionId),
    workflowId: normalizeOptionalText(contextOptions?.workflowId) || normalizeOptionalText(options.workflowId),
    taskId: normalizeOptionalText(contextOptions?.taskId) || normalizeOptionalText(options.taskId),
    chainId: normalizeOptionalText(contextOptions?.chainId) || normalizeOptionalText(options.chainId),
    stageId: normalizeOptionalText(contextOptions?.stageId) || normalizeOptionalText(options.stageId)
  };
}

function applyContextBoundaryDefaults(input, defaultBoundary) {
  return applyBoundaryDefaults(input, defaultBoundary);
}

function applyContextBoundaryDefaultsToUpdate(input, defaultBoundary) {
  return applyBoundaryDefaults(input, defaultBoundary);
}

function applyBoundaryDefaults(input, defaultBoundary = {}) {
  if (!input || typeof input !== 'object') {
    return input;
  }

  const output = { ...input };

  if (!hasOwn(output, 'scope') && defaultBoundary.scope != null) {
    output.scope = defaultBoundary.scope;
  }

  if (!hasOwn(output, 'projectKey') && defaultBoundary.projectKey != null) {
    output.projectKey = defaultBoundary.projectKey;
  }

  if (!hasOwn(output, 'workspacePath') && defaultBoundary.workspacePath != null) {
    output.workspacePath = defaultBoundary.workspacePath;
  }

  if (!hasOwn(output, 'sessionId') && defaultBoundary.sessionId != null) {
    output.sessionId = defaultBoundary.sessionId;
  }

  if (!hasOwn(output, 'workflowId') && defaultBoundary.workflowId != null) {
    output.workflowId = defaultBoundary.workflowId;
  }

  if (!hasOwn(output, 'taskId') && defaultBoundary.taskId != null) {
    output.taskId = defaultBoundary.taskId;
  }

  if (!hasOwn(output, 'chainId') && defaultBoundary.chainId != null) {
    output.chainId = defaultBoundary.chainId;
  }

  if (!hasOwn(output, 'stageId') && defaultBoundary.stageId != null) {
    output.stageId = defaultBoundary.stageId;
  }

  return output;
}

function normalizeContextItemInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Context item input is required.');
  }

  return {
    contextId: normalizeOptionalText(input.contextId),
    kind: normalizeRequiredText(input.kind, 'Context kind'),
    scope: normalizeRequiredText(input.scope, 'Context scope'),
    projectKey: normalizeOptionalText(input.projectKey),
    workspacePath: normalizeWorkspacePath(input.workspacePath),
    sessionId: normalizeOptionalText(input.sessionId),
    workflowId: normalizeOptionalText(input.workflowId),
    taskId: normalizeOptionalText(input.taskId),
    chainId: normalizeOptionalText(input.chainId),
    stageId: normalizeOptionalText(input.stageId),
    sourceKind: normalizeOptionalText(input.sourceKind),
    sourceRef: normalizeOptionalText(input.sourceRef),
    title: normalizeOptionalText(input.title),
    summary: normalizeOptionalText(input.summary),
    content: normalizeRequiredText(input.content, 'Context content'),
    metadata: input.metadata ?? null,
    priority: input.priority == null ? undefined : normalizeInteger(input.priority, 'priority')
  };
}

function normalizeContextItemUpdate(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Context item update input is required.');
  }

  const output = {
    contextId: normalizeRequiredText(input.contextId, 'Context id')
  };

  if (hasOwn(input, 'kind')) {
    output.kind = normalizeRequiredText(input.kind, 'Context kind');
  }

  if (hasOwn(input, 'scope')) {
    output.scope = normalizeRequiredText(input.scope, 'Context scope');
  }

  if (hasOwn(input, 'projectKey')) {
    output.projectKey = normalizeOptionalText(input.projectKey);
  }

  if (hasOwn(input, 'workspacePath')) {
    output.workspacePath = normalizeWorkspacePath(input.workspacePath);
  }

  if (hasOwn(input, 'sessionId')) {
    output.sessionId = normalizeOptionalText(input.sessionId);
  }

  if (hasOwn(input, 'workflowId')) {
    output.workflowId = normalizeOptionalText(input.workflowId);
  }

  if (hasOwn(input, 'taskId')) {
    output.taskId = normalizeOptionalText(input.taskId);
  }

  if (hasOwn(input, 'chainId')) {
    output.chainId = normalizeOptionalText(input.chainId);
  }

  if (hasOwn(input, 'stageId')) {
    output.stageId = normalizeOptionalText(input.stageId);
  }

  if (hasOwn(input, 'sourceKind')) {
    output.sourceKind = normalizeOptionalText(input.sourceKind);
  }

  if (hasOwn(input, 'sourceRef')) {
    output.sourceRef = normalizeOptionalText(input.sourceRef);
  }

  if (hasOwn(input, 'title')) {
    output.title = normalizeOptionalText(input.title);
  }

  if (hasOwn(input, 'summary')) {
    output.summary = normalizeOptionalText(input.summary);
  }

  if (hasOwn(input, 'content')) {
    output.content = normalizeRequiredText(input.content, 'Context content');
  }

  if (hasOwn(input, 'metadata')) {
    output.metadata = input.metadata ?? null;
  }

  if (hasOwn(input, 'priority')) {
    output.priority = normalizeInteger(input.priority, 'priority');
  }

  return output;
}

function normalizeContextSnapshotInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Context snapshot input is required.');
  }

  return {
    snapshotId: normalizeOptionalText(input.snapshotId),
    scope: normalizeRequiredText(input.scope, 'Context snapshot scope'),
    projectKey: normalizeOptionalText(input.projectKey),
    workspacePath: normalizeWorkspacePath(input.workspacePath),
    sessionId: normalizeOptionalText(input.sessionId),
    workflowId: normalizeOptionalText(input.workflowId),
    taskId: normalizeOptionalText(input.taskId),
    chainId: normalizeOptionalText(input.chainId),
    stageId: normalizeOptionalText(input.stageId),
    sourceKind: normalizeOptionalText(input.sourceKind),
    sourceRef: normalizeOptionalText(input.sourceRef),
    title: normalizeOptionalText(input.title),
    summary: normalizeOptionalText(input.summary),
    content: normalizeRequiredText(input.content, 'Context snapshot content'),
    items: Array.isArray(input.items) ? input.items : [],
    metadata: input.metadata ?? null
  };
}

function normalizeContextQuery(query) {
  if (query == null) {
    return {};
  }

  if (typeof query !== 'object') {
    throw new Error('Context query must be an object.');
  }

  const output = {};

  if (hasOwn(query, 'kind')) {
    output.kind = normalizeOptionalText(query.kind);
  }

  if (hasOwn(query, 'scope')) {
    output.scope = normalizeOptionalText(query.scope);
  }

  if (hasOwn(query, 'projectKey')) {
    output.projectKey = normalizeOptionalText(query.projectKey);
  }

  if (hasOwn(query, 'workspacePath')) {
    output.workspacePath = normalizeWorkspacePath(query.workspacePath);
  }

  if (hasOwn(query, 'sessionId')) {
    output.sessionId = normalizeOptionalText(query.sessionId);
  }

  if (hasOwn(query, 'workflowId')) {
    output.workflowId = normalizeOptionalText(query.workflowId);
  }

  if (hasOwn(query, 'taskId')) {
    output.taskId = normalizeOptionalText(query.taskId);
  }

  if (hasOwn(query, 'chainId')) {
    output.chainId = normalizeOptionalText(query.chainId);
  }

  if (hasOwn(query, 'stageId')) {
    output.stageId = normalizeOptionalText(query.stageId);
  }

  if (hasOwn(query, 'sourceKind')) {
    output.sourceKind = normalizeOptionalText(query.sourceKind);
  }

  if (hasOwn(query, 'sourceRef')) {
    output.sourceRef = normalizeOptionalText(query.sourceRef);
  }

  if (hasOwn(query, 'limit')) {
    output.limit = normalizePositiveInteger(query.limit, 'Context query limit');
  }

  if (hasOwn(query, 'minPriority')) {
    output.minPriority = normalizeInteger(query.minPriority, 'minPriority');
  }

  return output;
}

function normalizeContextOptions(value) {
  if (!value) {
    return null;
  }

  if (isContextSystem(value)) {
    return { system: value };
  }

  if (value !== Object(value)) {
    throw new Error('Context options must be an object.');
  }

  return value;
}

function isContextSystem(value) {
  return Boolean(value
    && typeof value.writeItem === 'function'
    && typeof value.updateItem === 'function'
    && typeof value.queryItems === 'function'
    && typeof value.writeSnapshot === 'function');
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeRequiredText(value, label) {
  const text = normalizeOptionalText(value);
  if (!text) {
    throw new Error(`${label} is required.`);
  }

  return text;
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function normalizeInteger(value, label) {
  if (value == null || value === '') {
    return null;
  }

  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new Error(`${label} must be an integer.`);
  }

  return number;
}

function normalizePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return Math.floor(number);
}
