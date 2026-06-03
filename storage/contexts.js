import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDb, normalizeWorkspacePath, resolveDbPath } from './db.js';

const CONTEXT_ITEM_COLUMNS = `
  context_id,
  kind,
  scope,
  project_key,
  workspace_path,
  session_id,
  workflow_id,
  task_id,
  chain_id,
  stage_id,
  source_kind,
  source_ref,
  title,
  summary,
  content,
  metadata_json,
  priority,
  created_at,
  updated_at
`;
const CONTEXT_SNAPSHOT_COLUMNS = `
  snapshot_id,
  scope,
  project_key,
  workspace_path,
  session_id,
  workflow_id,
  task_id,
  chain_id,
  stage_id,
  source_kind,
  source_ref,
  title,
  summary,
  content,
  items_json,
  metadata_json,
  created_at
`;

export async function initializeContextStore(options = {}) {
  const dbPath = resolveDbPath(options);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  const database = getDb(dbPath);

  database.exec(`
    CREATE TABLE IF NOT EXISTS context_items (
      context_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      project_key TEXT,
      workspace_path TEXT,
      session_id TEXT,
      workflow_id TEXT,
      task_id TEXT,
      chain_id TEXT,
      stage_id TEXT,
      source_kind TEXT,
      source_ref TEXT,
      title TEXT,
      summary TEXT,
      content TEXT NOT NULL,
      metadata_json TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS context_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      project_key TEXT,
      workspace_path TEXT,
      session_id TEXT,
      workflow_id TEXT,
      task_id TEXT,
      chain_id TEXT,
      stage_id TEXT,
      source_kind TEXT,
      source_ref TEXT,
      title TEXT,
      summary TEXT,
      content TEXT NOT NULL,
      items_json TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    )
  `);

  ensureColumn(database, 'context_items', 'project_key', 'TEXT');
  ensureColumn(database, 'context_items', 'workspace_path', 'TEXT');
  ensureColumn(database, 'context_items', 'session_id', 'TEXT');
  ensureColumn(database, 'context_items', 'workflow_id', 'TEXT');
  ensureColumn(database, 'context_items', 'task_id', 'TEXT');
  ensureColumn(database, 'context_items', 'chain_id', 'TEXT');
  ensureColumn(database, 'context_items', 'stage_id', 'TEXT');
  ensureColumn(database, 'context_items', 'source_kind', 'TEXT');
  ensureColumn(database, 'context_items', 'source_ref', 'TEXT');
  ensureColumn(database, 'context_items', 'title', 'TEXT');
  ensureColumn(database, 'context_items', 'summary', 'TEXT');
  ensureColumn(database, 'context_items', 'metadata_json', 'TEXT');
  ensureColumn(database, 'context_items', 'priority', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'context_items', 'updated_at', 'TEXT');

  ensureColumn(database, 'context_snapshots', 'project_key', 'TEXT');
  ensureColumn(database, 'context_snapshots', 'workspace_path', 'TEXT');
  ensureColumn(database, 'context_snapshots', 'session_id', 'TEXT');
  ensureColumn(database, 'context_snapshots', 'workflow_id', 'TEXT');
  ensureColumn(database, 'context_snapshots', 'task_id', 'TEXT');
  ensureColumn(database, 'context_snapshots', 'chain_id', 'TEXT');
  ensureColumn(database, 'context_snapshots', 'stage_id', 'TEXT');
  ensureColumn(database, 'context_snapshots', 'source_kind', 'TEXT');
  ensureColumn(database, 'context_snapshots', 'source_ref', 'TEXT');
  ensureColumn(database, 'context_snapshots', 'title', 'TEXT');
  ensureColumn(database, 'context_snapshots', 'summary', 'TEXT');
  ensureColumn(database, 'context_snapshots', 'items_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, 'context_snapshots', 'metadata_json', 'TEXT');

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_items_scope_kind_updated
    ON context_items (scope, kind, updated_at DESC)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_items_workflow_task
    ON context_items (workflow_id, task_id, updated_at DESC)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_items_chain_stage
    ON context_items (chain_id, stage_id, updated_at DESC)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_items_source
    ON context_items (source_kind, source_ref, updated_at DESC)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_items_project
    ON context_items (project_key, workspace_path, session_id, updated_at DESC)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_snapshots_scope_created
    ON context_snapshots (scope, created_at DESC)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_snapshots_workflow_task
    ON context_snapshots (workflow_id, task_id, created_at DESC)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_snapshots_chain_stage
    ON context_snapshots (chain_id, stage_id, created_at DESC)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_snapshots_source
    ON context_snapshots (source_kind, source_ref, created_at DESC)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_snapshots_project
    ON context_snapshots (project_key, workspace_path, session_id, created_at DESC)
  `);

  return database;
}

export function getContextStore(options = {}) {
  const database = getDb(resolveDbPath(options));
  const defaultBoundary = resolveContextBoundaryDefaults(options);

  return {
    database,
    createContextItem(input) {
      return createContextItem(database, input);
    },
    updateContextItem(input) {
      return updateContextItem(database, input);
    },
    getContextItem(contextId) {
      return getContextItem(database, contextId);
    },
    listContextItems(query = {}) {
      return listContextItems(database, applyContextBoundaryDefaults(query, defaultBoundary));
    },
    getContextItemState(contextId) {
      return getContextItemState(database, contextId);
    },
    createContextSnapshot(input) {
      return createContextSnapshot(database, input);
    },
    getContextSnapshot(snapshotId) {
      return getContextSnapshot(database, snapshotId);
    },
    listContextSnapshots(query = {}) {
      return listContextSnapshots(database, applyContextBoundaryDefaults(query, defaultBoundary));
    },
    getContextSnapshotState(snapshotId) {
      return getContextSnapshotState(database, snapshotId);
    }
  };
}

function resolveContextBoundaryDefaults(options = {}) {
  const contextOptions = normalizeContextOptions(options.context);

  return {
    scope: normalizeOptionalText(contextOptions?.scope) || normalizeOptionalText(options.scope),
    projectKey: normalizeOptionalText(contextOptions?.projectKey) || normalizeOptionalText(options.projectKey),
    workspacePath: normalizeWorkspacePath(contextOptions?.workspacePath ?? options.workspacePath),
    sessionId: normalizeOptionalText(contextOptions?.sessionId) || normalizeOptionalText(options.sessionId)
  };
}

function applyContextBoundaryDefaults(query, defaultBoundary = {}) {
  if (!query || typeof query !== 'object') {
    return query;
  }

  const output = { ...query };

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

  return output;
}

function createContextItem(database, input = {}) {
  const contextId = normalizeOptionalText(input.contextId) || crypto.randomUUID();
  const kind = normalizeRequiredText(input.kind, 'Context kind');
  const scope = normalizeRequiredText(input.scope, 'Context scope');
  const content = normalizeRequiredText(input.content, 'Context content');
  const now = createTimestamp();

  const existing = database.prepare(`
    SELECT context_id FROM context_items WHERE context_id = ?
  `).get(contextId);
  if (existing) {
    throw new Error(`Context item "${contextId}" already exists.`);
  }

  database.prepare(`
    INSERT INTO context_items (
      context_id,
      kind,
      scope,
      project_key,
      workspace_path,
      session_id,
      workflow_id,
      task_id,
      chain_id,
      stage_id,
      source_kind,
      source_ref,
      title,
      summary,
      content,
      metadata_json,
      priority,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    contextId,
    kind,
    scope,
    normalizeOptionalText(input.projectKey),
    normalizeWorkspacePath(input.workspacePath),
    normalizeOptionalText(input.sessionId),
    normalizeOptionalText(input.workflowId),
    normalizeOptionalText(input.taskId),
    normalizeOptionalText(input.chainId),
    normalizeOptionalText(input.stageId),
    normalizeOptionalText(input.sourceKind),
    normalizeOptionalText(input.sourceRef),
    normalizeOptionalText(input.title),
    normalizeOptionalText(input.summary),
    content,
    stringifyJson(input.metadata),
    normalizeInteger(input.priority, 'priority') || 0,
    now,
    now
  );

  return {
    item: requireContextItem(database, contextId)
  };
}

function updateContextItem(database, input = {}) {
  const contextId = normalizeRequiredText(input.contextId, 'Context id');
  const item = requireContextItem(database, contextId);
  const changes = {};

  if (hasOwn(input, 'kind')) {
    changes.kind = normalizeRequiredText(input.kind, 'Context kind');
  }

  if (hasOwn(input, 'scope')) {
    changes.scope = normalizeRequiredText(input.scope, 'Context scope');
  }

  if (hasOwn(input, 'projectKey')) {
    changes.projectKey = normalizeOptionalText(input.projectKey);
  }

  if (hasOwn(input, 'workspacePath')) {
    changes.workspacePath = normalizeWorkspacePath(input.workspacePath);
  }

  if (hasOwn(input, 'sessionId')) {
    changes.sessionId = normalizeOptionalText(input.sessionId);
  }

  if (hasOwn(input, 'workflowId')) {
    changes.workflowId = normalizeOptionalText(input.workflowId);
  }

  if (hasOwn(input, 'taskId')) {
    changes.taskId = normalizeOptionalText(input.taskId);
  }

  if (hasOwn(input, 'chainId')) {
    changes.chainId = normalizeOptionalText(input.chainId);
  }

  if (hasOwn(input, 'stageId')) {
    changes.stageId = normalizeOptionalText(input.stageId);
  }

  if (hasOwn(input, 'sourceKind')) {
    changes.sourceKind = normalizeOptionalText(input.sourceKind);
  }

  if (hasOwn(input, 'sourceRef')) {
    changes.sourceRef = normalizeOptionalText(input.sourceRef);
  }

  if (hasOwn(input, 'title')) {
    changes.title = normalizeOptionalText(input.title);
  }

  if (hasOwn(input, 'summary')) {
    changes.summary = normalizeOptionalText(input.summary);
  }

  if (hasOwn(input, 'content')) {
    changes.content = normalizeRequiredText(input.content, 'Context content');
  }

  if (hasOwn(input, 'metadata')) {
    changes.metadata = input.metadata ?? null;
  }

  if (hasOwn(input, 'priority')) {
    changes.priority = normalizeInteger(input.priority, 'priority') || 0;
  }

  if (Object.keys(changes).length === 0) {
    throw new Error('At least one context item change is required.');
  }

  const now = createTimestamp();
  const setClauses = ['updated_at = ?'];
  const setParams = [now];

  if (hasOwn(changes, 'kind')) {
    setClauses.push('kind = ?');
    setParams.push(changes.kind);
  }
  if (hasOwn(changes, 'scope')) {
    setClauses.push('scope = ?');
    setParams.push(changes.scope);
  }
  if (hasOwn(changes, 'projectKey')) {
    setClauses.push('project_key = ?');
    setParams.push(changes.projectKey);
  }
  if (hasOwn(changes, 'workspacePath')) {
    setClauses.push('workspace_path = ?');
    setParams.push(changes.workspacePath);
  }
  if (hasOwn(changes, 'sessionId')) {
    setClauses.push('session_id = ?');
    setParams.push(changes.sessionId);
  }
  if (hasOwn(changes, 'workflowId')) {
    setClauses.push('workflow_id = ?');
    setParams.push(changes.workflowId);
  }
  if (hasOwn(changes, 'taskId')) {
    setClauses.push('task_id = ?');
    setParams.push(changes.taskId);
  }
  if (hasOwn(changes, 'chainId')) {
    setClauses.push('chain_id = ?');
    setParams.push(changes.chainId);
  }
  if (hasOwn(changes, 'stageId')) {
    setClauses.push('stage_id = ?');
    setParams.push(changes.stageId);
  }
  if (hasOwn(changes, 'sourceKind')) {
    setClauses.push('source_kind = ?');
    setParams.push(changes.sourceKind);
  }
  if (hasOwn(changes, 'sourceRef')) {
    setClauses.push('source_ref = ?');
    setParams.push(changes.sourceRef);
  }
  if (hasOwn(changes, 'title')) {
    setClauses.push('title = ?');
    setParams.push(changes.title);
  }
  if (hasOwn(changes, 'summary')) {
    setClauses.push('summary = ?');
    setParams.push(changes.summary);
  }
  if (hasOwn(changes, 'content')) {
    setClauses.push('content = ?');
    setParams.push(changes.content);
  }
  if (hasOwn(changes, 'metadata')) {
    setClauses.push('metadata_json = ?');
    setParams.push(stringifyJson(changes.metadata));
  }
  if (hasOwn(changes, 'priority')) {
    setClauses.push('priority = ?');
    setParams.push(changes.priority);
  }

  database.prepare(`
    UPDATE context_items
    SET ${setClauses.join(', ')}
    WHERE context_id = ?
  `).run(...setParams, contextId);

  return {
    item: requireContextItem(database, contextId)
  };
}

function getContextItem(database, contextId) {
  const row = database.prepare(`
    SELECT ${CONTEXT_ITEM_COLUMNS}
    FROM context_items
    WHERE context_id = ?
    LIMIT 1
  `).get(contextId);

  return mapContextItemRow(row);
}

function listContextItems(database, query = {}) {
  const filters = [];
  const params = [];
  const whereClauses = [];
  const limit = normalizeOptionalPositiveInteger(query.limit, 'limit');

  addEqualityFilter(whereClauses, params, filters, query.kind, 'kind', 'kind = ?', 'Context kind');
  addEqualityFilter(whereClauses, params, filters, query.scope, 'scope', 'scope = ?', 'Context scope');
  addEqualityFilter(whereClauses, params, filters, query.projectKey, 'projectKey', 'project_key = ?', 'projectKey');
  addEqualityFilter(whereClauses, params, filters, query.workspacePath, 'workspacePath', 'workspace_path = ?', 'workspacePath', normalizeRequiredWorkspacePath);
  addEqualityFilter(whereClauses, params, filters, query.sessionId, 'sessionId', 'session_id = ?', 'sessionId');
  addEqualityFilter(whereClauses, params, filters, query.workflowId, 'workflowId', 'workflow_id = ?', 'workflowId');
  addEqualityFilter(whereClauses, params, filters, query.taskId, 'taskId', 'task_id = ?', 'taskId');
  addEqualityFilter(whereClauses, params, filters, query.chainId, 'chainId', 'chain_id = ?', 'chainId');
  addEqualityFilter(whereClauses, params, filters, query.stageId, 'stageId', 'stage_id = ?', 'stageId');
  addEqualityFilter(whereClauses, params, filters, query.sourceKind, 'sourceKind', 'source_kind = ?', 'sourceKind');
  addEqualityFilter(whereClauses, params, filters, query.sourceRef, 'sourceRef', 'source_ref = ?', 'sourceRef');

  if (query.minPriority != null) {
    whereClauses.push('priority >= ?');
    params.push(normalizeInteger(query.minPriority, 'minPriority'));
    filters.push('minPriority');
  }

  const countSql = `
    SELECT COUNT(*) AS total
    FROM context_items
    ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
  `;
  const countRow = database.prepare(countSql).get(...params);
  const total = countRow?.total || 0;

  const sql = `
    SELECT ${CONTEXT_ITEM_COLUMNS}
    FROM context_items
    ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
    ORDER BY priority DESC, updated_at DESC, created_at DESC
    ${limit ? 'LIMIT ?' : ''}
  `;
  const rows = database.prepare(sql).all(...(limit ? [...params, limit] : params));

  return {
    items: rows.map(mapContextItemRow),
    query: {
      ...query,
      filters
    },
    total
  };
}

function getContextItemState(database, contextId) {
  return {
    item: requireContextItem(database, contextId)
  };
}

function createContextSnapshot(database, input = {}) {
  const snapshotId = normalizeOptionalText(input.snapshotId) || crypto.randomUUID();
  const scope = normalizeRequiredText(input.scope, 'Context snapshot scope');
  const content = normalizeRequiredText(input.content, 'Context snapshot content');
  const items = normalizeSnapshotItems(input.items);
  const now = createTimestamp();

  database.prepare(`
    INSERT INTO context_snapshots (
      snapshot_id,
      scope,
      project_key,
      workspace_path,
      session_id,
      workflow_id,
      task_id,
      chain_id,
      stage_id,
      source_kind,
      source_ref,
      title,
      summary,
      content,
      items_json,
      metadata_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshotId,
    scope,
    normalizeOptionalText(input.projectKey),
    normalizeWorkspacePath(input.workspacePath),
    normalizeOptionalText(input.sessionId),
    normalizeOptionalText(input.workflowId),
    normalizeOptionalText(input.taskId),
    normalizeOptionalText(input.chainId),
    normalizeOptionalText(input.stageId),
    normalizeOptionalText(input.sourceKind),
    normalizeOptionalText(input.sourceRef),
    normalizeOptionalText(input.title),
    normalizeOptionalText(input.summary),
    content,
    stringifyJson(items) || '[]',
    stringifyJson(input.metadata),
    now
  );

  return {
    snapshot: requireContextSnapshot(database, snapshotId)
  };
}

function getContextSnapshot(database, snapshotId) {
  const row = database.prepare(`
    SELECT ${CONTEXT_SNAPSHOT_COLUMNS}
    FROM context_snapshots
    WHERE snapshot_id = ?
    LIMIT 1
  `).get(snapshotId);

  return mapContextSnapshotRow(row);
}

function listContextSnapshots(database, query = {}) {
  const filters = [];
  const params = [];
  const whereClauses = [];
  const limit = normalizeOptionalPositiveInteger(query.limit, 'limit');

  addEqualityFilter(whereClauses, params, filters, query.scope, 'scope', 'scope = ?', 'Context snapshot scope');
  addEqualityFilter(whereClauses, params, filters, query.projectKey, 'projectKey', 'project_key = ?', 'projectKey');
  addEqualityFilter(whereClauses, params, filters, query.workspacePath, 'workspacePath', 'workspace_path = ?', 'workspacePath', normalizeRequiredWorkspacePath);
  addEqualityFilter(whereClauses, params, filters, query.sessionId, 'sessionId', 'session_id = ?', 'sessionId');
  addEqualityFilter(whereClauses, params, filters, query.workflowId, 'workflowId', 'workflow_id = ?', 'workflowId');
  addEqualityFilter(whereClauses, params, filters, query.taskId, 'taskId', 'task_id = ?', 'taskId');
  addEqualityFilter(whereClauses, params, filters, query.chainId, 'chainId', 'chain_id = ?', 'chainId');
  addEqualityFilter(whereClauses, params, filters, query.stageId, 'stageId', 'stage_id = ?', 'stageId');
  addEqualityFilter(whereClauses, params, filters, query.sourceKind, 'sourceKind', 'source_kind = ?', 'sourceKind');
  addEqualityFilter(whereClauses, params, filters, query.sourceRef, 'sourceRef', 'source_ref = ?', 'sourceRef');

  const countSql = `
    SELECT COUNT(*) AS total
    FROM context_snapshots
    ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
  `;
  const countRow = database.prepare(countSql).get(...params);
  const total = countRow?.total || 0;

  const sql = `
    SELECT ${CONTEXT_SNAPSHOT_COLUMNS}
    FROM context_snapshots
    ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
    ORDER BY created_at DESC
    ${limit ? 'LIMIT ?' : ''}
  `;
  const rows = database.prepare(sql).all(...(limit ? [...params, limit] : params));

  return {
    items: rows.map(mapContextSnapshotRow),
    query: {
      ...query,
      filters
    },
    total
  };
}

function getContextSnapshotState(database, snapshotId) {
  return {
    snapshot: requireContextSnapshot(database, snapshotId)
  };
}

function requireContextItem(database, contextId) {
  const item = getContextItem(database, contextId);
  if (!item) {
    throw new Error('Context item not found.');
  }

  return item;
}

function requireContextSnapshot(database, snapshotId) {
  const snapshot = getContextSnapshot(database, snapshotId);
  if (!snapshot) {
    throw new Error('Context snapshot not found.');
  }

  return snapshot;
}

function mapContextItemRow(row) {
  if (!row) {
    return null;
  }

  return {
    contextId: row.context_id,
    kind: row.kind,
    scope: row.scope,
    projectKey: row.project_key,
    workspacePath: row.workspace_path,
    sessionId: row.session_id,
    workflowId: row.workflow_id,
    taskId: row.task_id,
    chainId: row.chain_id,
    stageId: row.stage_id,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    title: row.title,
    summary: row.summary,
    content: row.content,
    metadata: parseJson(row.metadata_json),
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapContextSnapshotRow(row) {
  if (!row) {
    return null;
  }

  return {
    snapshotId: row.snapshot_id,
    scope: row.scope,
    projectKey: row.project_key,
    workspacePath: row.workspace_path,
    sessionId: row.session_id,
    workflowId: row.workflow_id,
    taskId: row.task_id,
    chainId: row.chain_id,
    stageId: row.stage_id,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    title: row.title,
    summary: row.summary,
    content: row.content,
    items: parseJson(row.items_json) || [],
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at
  };
}

function normalizeSnapshotItems(value) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error('Context snapshot items must be an array.');
  }

  return value.map((item, index) => {
    if (typeof item === 'string') {
      return {
        contextId: normalizeRequiredText(item, `Context snapshot item at index ${index}`)
      };
    }

    if (!item || typeof item !== 'object') {
      throw new Error(`Context snapshot item at index ${index} must be an object.`);
    }

    return {
      contextId: normalizeOptionalText(item.contextId),
      kind: normalizeOptionalText(item.kind),
      title: normalizeOptionalText(item.title),
      summary: normalizeOptionalText(item.summary),
      sourceKind: normalizeOptionalText(item.sourceKind),
      sourceRef: normalizeOptionalText(item.sourceRef),
      priority: normalizeInteger(item.priority, `Context snapshot item priority at index ${index}`),
      metadata: item.metadata ?? null,
      selectedBecause: normalizeOptionalTextArray(item.selectedBecause),
      authority: normalizeOptionalText(item.authority)
    };
  });
}

function normalizeContextOptions(value) {
  if (value == null || value === false) {
    return null;
  }

  if (value === true) {
    return {};
  }

  if (typeof value !== 'object') {
    return null;
  }

  if (value.enabled === false) {
    return null;
  }

  return value;
}

function addEqualityFilter(whereClauses, params, filters, value, filterName, clause, label, normalize = normalizeRequiredText) {
  if (value == null) {
    return;
  }

  whereClauses.push(clause);
  params.push(normalize(value, label));
  filters.push(filterName);
}

function hasColumn(database, tableName, columnName) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some((column) => column.name === columnName);
}

function ensureColumn(database, tableName, columnName, columnDefinition) {
  if (!hasColumn(database, tableName, columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
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

function normalizeRequiredWorkspacePath(value, label) {
  const workspacePath = normalizeWorkspacePath(value);
  if (!workspacePath) {
    throw new Error(`${label} is required.`);
  }

  return workspacePath;
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function normalizeOptionalTextArray(value) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error('Context snapshot selectedBecause must be an array.');
  }

  return value
    .map((item) => normalizeOptionalText(item))
    .filter(Boolean);
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

function normalizeOptionalPositiveInteger(value, label) {
  if (value == null || value === '') {
    return null;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return Math.floor(number);
}

function stringifyJson(value) {
  if (value == null) {
    return null;
  }

  return JSON.stringify(value);
}

function parseJson(value) {
  if (!value) {
    return null;
  }

  return JSON.parse(value);
}

function createTimestamp() {
  return new Date().toISOString();
}
