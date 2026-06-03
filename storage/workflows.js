import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { getDb, normalizeWorkspacePath, resolveDbPath, withDbLock } from './db.js';
import { shouldIncludeWorkflowForHygiene } from './data-hygiene.js';
import { buildFailureRecoveryMetadata } from '../runner/retry-policy.js';
import {
  sanitizeAdapterPayloadForPersistence,
  sanitizeRecoveryForPersistence,
  sanitizeRunLogPayloadForPersistence,
  sanitizeTaskOutputSpecsForPersistence
} from '../runner/pollution-gateway.js';


const TASK_STATUSES = new Set(['pending', 'ready', 'doing', 'blocked', 'done', 'skipped']);
const WORKFLOW_STATUSES = new Set(['draft', 'ready', 'doing', 'blocked', 'done']);
const ASSIGNMENT_STATUSES = new Set(['unassigned', 'assigned', 'accepted', 'released']);
const DEFAULT_LEASE_MS = 30_000;
const WORKFLOW_STORE_SCHEMA_VERSION = 6;
const WORKFLOW_COLUMNS = 'workflow_id, goal, instruction, initial_plan_json, status, current_task_id, concurrency_limit, created_at, updated_at';
const WORKFLOW_DEFINITION_COLUMNS = `
  definition_id,
  name,
  description,
  goal,
  instruction,
  plan_json,
  metadata_json,
  concurrency_limit,
  source_workflow_id,
  created_at,
  updated_at
`;
const TASK_COLUMNS = `
  task_id,
  workflow_id,
  title,
  description,
  status,
  sequence_no,
  blocked_reason,
  done_summary,
  plan_task_key,
  owner_agent_id,
  preferred_role,
  required_capabilities_json,
  assignment_status,
  assignment_reason,
  handoff_json,
  contract_json,
  started_at,
  completed_at,
  lease_owner,
  lease_expires_at,
  attempt_count,
  last_error,
  reason_code,
  recovery_json,
  created_at,
  updated_at
`;
const DEPENDENCY_COLUMNS = 'id, workflow_id, predecessor_task_id, successor_task_id, condition_json, created_at';
const RUN_LOG_COLUMNS = 'log_id, workflow_id, task_id, action, message, payload_json, created_at';
const TASK_OUTPUT_COLUMNS = 'output_id, workflow_id, task_id, kind, name, content_text, path, metadata_json, created_at';
const RERUN_COLUMNS = `
  rerun_id,
  workflow_id,
  origin_task_id,
  reason,
  fingerprint,
  operator,
  payload_json,
  affected_task_count,
  affected_task_ids_json,
  created_at
`;
const TASK_REVISION_COLUMNS = `
  revision_id,
  workflow_id,
  task_id,
  rerun_id,
  previous_status,
  previous_done_summary,
  previous_blocked_reason,
  previous_last_error,
  previous_attempt_count,
  previous_handoff_json,
  snapshot_json,
  created_at
`;
const DEFAULT_MAX_SAME_FINGERPRINT_RERUNS = 2;
const DEFAULT_AUDIT_LIMIT = 100;
const TASK_OUTPUT_TRUST_STATES = new Set(['unverified', 'validated', 'failed', 'tainted', 'superseded']);
const TRUSTED_TASK_OUTPUT_STATES = new Set(['validated', 'unverified']);

export async function initializeWorkflowStore(options = {}) {
  const dbPath = resolveDbPath(options);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  return withDbLock(dbPath, () => initializeWorkflowStoreSync(dbPath));
}

function initializeWorkflowStoreSync(dbPath) {
  const database = getDb(dbPath);

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      workflow_id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      instruction TEXT NOT NULL,
      initial_plan_json TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      current_task_id TEXT,
      concurrency_limit INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_definitions (
      definition_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      goal TEXT NOT NULL,
      instruction TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      metadata_json TEXT,
      concurrency_limit INTEGER NOT NULL DEFAULT 1,
      source_workflow_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (source_workflow_id) REFERENCES workflows (workflow_id) ON DELETE SET NULL
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_tasks (
      task_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      sequence_no INTEGER NOT NULL,
      blocked_reason TEXT,
      done_summary TEXT,
      plan_task_key TEXT,
      owner_agent_id TEXT,
      preferred_role TEXT,
      required_capabilities_json TEXT,
      assignment_status TEXT NOT NULL DEFAULT 'unassigned',
      assignment_reason TEXT,
      handoff_json TEXT,
      contract_json TEXT,
      started_at TEXT,
      completed_at TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      reason_code TEXT,
      recovery_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workflow_id) REFERENCES workflows (workflow_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      predecessor_task_id TEXT NOT NULL,
      successor_task_id TEXT NOT NULL,
      condition_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (workflow_id, predecessor_task_id, successor_task_id),
      FOREIGN KEY (workflow_id) REFERENCES workflows (workflow_id) ON DELETE CASCADE,
      FOREIGN KEY (predecessor_task_id) REFERENCES workflow_tasks (task_id) ON DELETE CASCADE,
      FOREIGN KEY (successor_task_id) REFERENCES workflow_tasks (task_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_run_logs (
      log_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      task_id TEXT,
      action TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workflow_id) REFERENCES workflows (workflow_id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES workflow_tasks (task_id) ON DELETE SET NULL
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_task_outputs (
      output_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT,
      content_text TEXT,
      path TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workflow_id) REFERENCES workflows (workflow_id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES workflow_tasks (task_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_reruns (
      rerun_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      origin_task_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      operator TEXT,
      payload_json TEXT,
      affected_task_count INTEGER NOT NULL DEFAULT 0,
      affected_task_ids_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workflow_id) REFERENCES workflows (workflow_id) ON DELETE CASCADE,
      FOREIGN KEY (origin_task_id) REFERENCES workflow_tasks (task_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_task_revisions (
      revision_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      rerun_id TEXT NOT NULL,
      previous_status TEXT NOT NULL,
      previous_done_summary TEXT,
      previous_blocked_reason TEXT,
      previous_last_error TEXT,
      previous_attempt_count INTEGER NOT NULL DEFAULT 0,
      previous_handoff_json TEXT,
      snapshot_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workflow_id) REFERENCES workflows (workflow_id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES workflow_tasks (task_id) ON DELETE CASCADE,
      FOREIGN KEY (rerun_id) REFERENCES workflow_reruns (rerun_id) ON DELETE CASCADE
    )
  `);

  ensureColumn(database, 'workflows', 'initial_plan_json', 'TEXT');
  ensureColumn(database, 'workflows', 'current_task_id', 'TEXT');
  ensureColumn(database, 'workflows', 'concurrency_limit', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(database, 'workflow_tasks', 'blocked_reason', 'TEXT');
  ensureColumn(database, 'workflow_tasks', 'done_summary', 'TEXT');
  ensureColumn(database, 'workflow_tasks', 'plan_task_key', 'TEXT');
  ensureColumn(database, 'workflow_tasks', 'started_at', 'TEXT');
  ensureColumn(database, 'workflow_tasks', 'completed_at', 'TEXT');
  ensureColumn(database, 'workflow_tasks', 'lease_owner', 'TEXT');
  ensureColumn(database, 'workflow_tasks', 'lease_expires_at', 'TEXT');
  ensureColumn(database, 'workflow_tasks', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'workflow_tasks', 'last_error', 'TEXT');
  ensureColumn(database, 'workflow_tasks', 'owner_agent_id', 'TEXT');
  ensureColumn(database, 'workflow_tasks', 'preferred_role', 'TEXT');
  ensureColumn(database, 'workflow_tasks', 'required_capabilities_json', 'TEXT');
  ensureColumn(database, 'workflow_tasks', 'assignment_status', "TEXT NOT NULL DEFAULT 'unassigned'");
  ensureColumn(database, 'workflow_tasks', 'assignment_reason', 'TEXT');
  ensureColumn(database, 'workflow_tasks', 'handoff_json', 'TEXT');
  ensureColumn(database, 'workflow_tasks', 'contract_json', 'TEXT');
  ensureColumn(database, 'workflow_tasks', 'reason_code', 'TEXT');
  ensureColumn(database, 'workflow_tasks', 'recovery_json', 'TEXT');
  ensureColumn(database, 'workflow_dependencies', 'condition_json', 'TEXT');
  ensureColumn(database, 'workflow_run_logs', 'task_id', 'TEXT');
  ensureColumn(database, 'workflow_run_logs', 'payload_json', 'TEXT');

  database.exec(`
    UPDATE workflow_tasks
    SET assignment_status = 'unassigned'
    WHERE assignment_status IS NULL
       OR TRIM(assignment_status) = ''
  `);

  database.exec(`
    UPDATE workflow_tasks
    SET attempt_count = 0
    WHERE attempt_count IS NULL
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_definitions_name_updated
    ON workflow_definitions (name, updated_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_definitions_source_workflow
    ON workflow_definitions (source_workflow_id, updated_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflows_status
    ON workflows (status, updated_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_tasks_workflow_sequence
    ON workflow_tasks (workflow_id, sequence_no, created_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_tasks_workflow_status
    ON workflow_tasks (workflow_id, status, sequence_no)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_tasks_lease
    ON workflow_tasks (status, lease_expires_at, workflow_id)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_tasks_status_sequence_created
    ON workflow_tasks (status, sequence_no, created_at, task_id)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_tasks_assignment
    ON workflow_tasks (assignment_status, owner_agent_id, preferred_role, workflow_id)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_dependencies_successor
    ON workflow_dependencies (workflow_id, successor_task_id)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_dependencies_predecessor
    ON workflow_dependencies (workflow_id, predecessor_task_id)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_run_logs_workflow_created
    ON workflow_run_logs (workflow_id, created_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_task_outputs_task_created
    ON workflow_task_outputs (workflow_id, task_id, created_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_task_outputs_kind_created
    ON workflow_task_outputs (workflow_id, kind, created_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_reruns_workflow_created
    ON workflow_reruns (workflow_id, created_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_reruns_origin_fingerprint
    ON workflow_reruns (workflow_id, origin_task_id, fingerprint, created_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_task_revisions_workflow_task_created
    ON workflow_task_revisions (workflow_id, task_id, created_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_task_revisions_rerun
    ON workflow_task_revisions (rerun_id, created_at)
  `);

  database.pragma(`user_version = ${WORKFLOW_STORE_SCHEMA_VERSION}`);

  return database;
}

export function getWorkflowStore(options = {}) {
  const database = getDb(resolveDbPath(options));

  return {
    database,
    createWorkflow(input) {
      return createWorkflow(database, input);
    },
    getWorkflow(workflowId) {
      return getWorkflow(database, workflowId);
    },
    listWorkflows(query = {}) {
      return listWorkflows(database, query);
    },
    createWorkflowDefinition(input = {}) {
      return createWorkflowDefinition(database, input);
    },
    getWorkflowDefinition(definitionId) {
      return getWorkflowDefinition(database, definitionId);
    },
    listWorkflowDefinitions(query = {}) {
      return listWorkflowDefinitions(database, query);
    },
    createWorkflowFromDefinition(input = {}) {
      return createWorkflowFromDefinition(database, input);
    },
    listWorkflowTasks(workflowId) {
      return listWorkflowTasks(database, workflowId);
    },
    listWorkflowDependencies(workflowId) {
      return listWorkflowDependencies(database, workflowId);
    },
    listWorkflowRunLogs(workflowId, query = {}) {
      return listWorkflowRunLogs(database, workflowId, query);
    },
    listWorkflowReruns(workflowId, query = {}) {
      return listWorkflowReruns(database, workflowId, query);
    },
    listTaskRevisions(input = {}) {
      return listTaskRevisions(database, input);
    },
    addTaskOutput(input = {}) {
      return addTaskOutput(database, input);
    },
    listTaskOutputs(input = {}) {
      return listTaskOutputs(database, input);
    },
    filterTaskOutputsByTrust(input = {}) {
      return filterTaskOutputsByTrust(input.outputs || [], input);
    },
    isTrustedTaskOutput(output) {
      return isTrustedTaskOutput(output);
    },
    listDescendantTaskIds(input = {}) {
      return listDescendantTaskIds(database, input);
    },
    addRunLog(input) {
      return addRunLog(database, input);
    },
    addTask(input) {
      return addTask(database, input);
    },
    addDependency(input) {
      return addDependency(database, input);
    },
    advanceTaskStatus(input) {
      return advanceTaskStatus(database, input);
    },
    restartFromTask(input) {
      return restartFromTask(database, input);
    },
    claimNextReadyTask(input) {
      return claimNextReadyTask(database, input);
    },
    peekNextReadyTask(input) {
      return peekNextReadyTask(database, input);
    },
    recoverSession(input) {
      return recoverSession(database, input);
    },
    heartbeatTaskLease(input) {
      return heartbeatTaskLease(database, input);
    },
    releaseExpiredTaskLeases(input = {}) {
      return releaseExpiredTaskLeases(database, input);
    },
    sweepTimedOutTasks(input = {}) {
      return sweepTimedOutTasks(database, input);
    },
    getNextTask(workflowId) {
      return getNextTask(database, workflowId);
    },
    getWorkflowState(workflowId, query = {}) {
      return getWorkflowState(database, workflowId, query);
    },
    refreshWorkflow(workflowId) {
      return refreshWorkflowStateSync(database, workflowId);
    }
  };
}

function createWorkflowDefinition(database, input = {}) {
  const definitionId = input.definitionId || crypto.randomUUID();
  const name = normalizeRequiredText(input.name, 'Workflow definition name is required.');
  const description = normalizeOptionalText(input.description);
  const goal = normalizeRequiredText(input.goal, 'Workflow definition goal is required.');
  const instruction = normalizeRequiredText(input.instruction, 'Workflow definition instruction is required.');
  const plan = normalizeRequiredObject(input.plan, 'Workflow definition plan is required.');
  const metadata = normalizeOptionalObject(input.metadata, 'Workflow definition metadata must be an object when provided.');
  const concurrencyLimit = normalizeConcurrencyLimit(input.concurrencyLimit);
  const sourceWorkflowId = normalizeOptionalText(input.sourceWorkflowId);
  const createdAt = input.createdAt || createTimestamp();
  const updatedAt = input.updatedAt || createdAt;

  if (sourceWorkflowId) {
    requireWorkflow(database, sourceWorkflowId);
  }

  database.prepare(`
    INSERT INTO workflow_definitions (
      definition_id,
      name,
      description,
      goal,
      instruction,
      plan_json,
      metadata_json,
      concurrency_limit,
      source_workflow_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    definitionId,
    name,
    description,
    goal,
    instruction,
    stringifyJson(plan),
    stringifyJson(metadata),
    concurrencyLimit,
    sourceWorkflowId,
    createdAt,
    updatedAt
  );

  return getWorkflowDefinition(database, definitionId);
}

function getWorkflowDefinition(database, definitionId) {
  const row = database.prepare(`
    SELECT ${WORKFLOW_DEFINITION_COLUMNS}
    FROM workflow_definitions
    WHERE definition_id = ?
    LIMIT 1
  `).get(definitionId);

  return mapWorkflowDefinitionRow(row);
}

function listWorkflowDefinitions(database, query = {}) {
  const limit = normalizeListLimit(query.limit, 100);
  const search = normalizeOptionalText(query.search);
  const sourceWorkflowId = normalizeOptionalText(query.sourceWorkflowId);
  const whereClauses = [];
  const params = [];

  if (search) {
    whereClauses.push('(name LIKE ? OR description LIKE ? OR goal LIKE ? OR instruction LIKE ?)');
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern, pattern);
  }

  if (sourceWorkflowId) {
    requireWorkflow(database, sourceWorkflowId);
    whereClauses.push('source_workflow_id = ?');
    params.push(sourceWorkflowId);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  return database.prepare(`
    SELECT ${WORKFLOW_DEFINITION_COLUMNS}
    FROM workflow_definitions
    ${whereSql}
    ORDER BY updated_at DESC, created_at DESC, definition_id ASC
    LIMIT ?
  `).all(...params, limit).map(mapWorkflowDefinitionRow);
}

function createWorkflowFromDefinition(database, input = {}) {
  const definition = requireWorkflowDefinition(database, input.definitionId);
  const workflowId = normalizeOptionalText(input.workflowId) || crypto.randomUUID();
  const goal = normalizeOptionalText(input.goal) || definition.goal;
  const instruction = normalizeOptionalText(input.instruction) || definition.instruction;
  const concurrencyLimit = input.concurrencyLimit == null
    ? definition.concurrencyLimit
    : normalizeConcurrencyLimit(input.concurrencyLimit);
  const status = input.status || 'draft';
  const createdAt = input.createdAt || createTimestamp();
  const updatedAt = input.updatedAt || createdAt;

  assertWorkflowStatus(status);

  database.prepare(`
    INSERT INTO workflows (
      workflow_id,
      goal,
      instruction,
      initial_plan_json,
      status,
      current_task_id,
      concurrency_limit,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workflowId,
    goal,
    instruction,
    stringifyJson(definition.plan),
    status,
    normalizeOptionalText(input.currentTaskId),
    concurrencyLimit,
    createdAt,
    updatedAt
  );

  return {
    workflow: getWorkflow(database, workflowId),
    definition
  };
}

function createWorkflow(database, input = {}) {
  const workflowId = input.workflowId || crypto.randomUUID();
  const goal = String(input.goal || '').trim();
  const instruction = String(input.instruction || '').trim();
  const status = input.status || 'draft';

  if (!goal) {
    throw new Error('Workflow goal is required.');
  }

  if (!instruction) {
    throw new Error('Workflow instruction is required.');
  }

  assertWorkflowStatus(status);

  const concurrencyLimit = normalizeConcurrencyLimit(input.concurrencyLimit);
  const now = createTimestamp();
  database.prepare(`
    INSERT INTO workflows (
      workflow_id,
      goal,
      instruction,
      initial_plan_json,
      status,
      current_task_id,
      concurrency_limit,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workflowId,
    goal,
    instruction,
    stringifyJson(input.initialPlan),
    status,
    input.currentTaskId || null,
    concurrencyLimit,
    now,
    now
  );

  return getWorkflow(database, workflowId);
}

function getWorkflow(database, workflowId) {
  const row = database.prepare(`
    SELECT ${WORKFLOW_COLUMNS}
    FROM workflows
    WHERE workflow_id = ?
    LIMIT 1
  `).get(workflowId);

  return mapWorkflowRow(row);
}

function listWorkflows(database, query = {}) {
  const whereClauses = [];
  const params = [];
  const status = normalizeOptionalText(query.status);
  const activeOnly = query.activeOnly === true;
  const limit = normalizeListLimit(query.limit, 100);
  const useHygieneFilter = query.includeTestData === false
    || query.includeTestData === true
    || query.includeArchived === false
    || query.includeArchived === true
    || Boolean(normalizeOptionalText(query.dataClass));
  const sqlLimit = useHygieneFilter ? Math.max(limit * 5, limit) : limit;

  if (status) {
    assertWorkflowStatus(status);
    whereClauses.push('status = ?');
    params.push(status);
  }

  if (activeOnly) {
    whereClauses.push("status != 'done'");
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const workflows = database.prepare(`
    SELECT ${WORKFLOW_COLUMNS}
    FROM workflows
    ${whereSql}
    ORDER BY updated_at DESC, created_at DESC, workflow_id ASC
    LIMIT ?
  `).all(...params, sqlLimit).map(mapWorkflowRow);

  if (!useHygieneFilter) {
    return workflows;
  }

  return workflows
    .filter((workflow) => shouldIncludeWorkflowForHygiene(workflow, query))
    .slice(0, limit);
}

function listWorkflowTasks(database, workflowId) {
  return database.prepare(`
    SELECT ${TASK_COLUMNS}
    FROM workflow_tasks
    WHERE workflow_id = ?
    ORDER BY sequence_no ASC, created_at ASC, task_id ASC
  `).all(workflowId).map(mapTaskRow);
}

function listWorkflowDependencies(database, workflowId) {
  return database.prepare(`
    SELECT ${DEPENDENCY_COLUMNS}
    FROM workflow_dependencies
    WHERE workflow_id = ?
    ORDER BY id ASC
  `).all(workflowId).map(mapDependencyRow);
}

function listWorkflowRunLogs(database, workflowId, query = {}) {
  const limit = Number.isInteger(query.limit) && query.limit > 0 ? query.limit : 100;

  return database.prepare(`
    SELECT ${RUN_LOG_COLUMNS}
    FROM workflow_run_logs
    WHERE workflow_id = ?
    ORDER BY created_at ASC, log_id ASC
    LIMIT ?
  `).all(workflowId, limit).map(mapRunLogRow);
}

function listWorkflowReruns(database, workflowId, query = {}) {
  requireWorkflow(database, workflowId);
  const limit = Number.isInteger(query.limit) && query.limit > 0 ? query.limit : DEFAULT_AUDIT_LIMIT;

  return database.prepare(`
    SELECT ${RERUN_COLUMNS}
    FROM workflow_reruns
    WHERE workflow_id = ?
    ORDER BY created_at DESC, rerun_id DESC
    LIMIT ?
  `).all(workflowId, limit).map(mapRerunRow);
}

function listTaskRevisions(database, input = {}) {
  const workflow = requireWorkflow(database, input.workflowId);
  const taskId = normalizeOptionalText(input.taskId);
  const rerunId = normalizeOptionalText(input.rerunId);
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : DEFAULT_AUDIT_LIMIT;
  const whereClauses = ['workflow_id = ?'];
  const params = [workflow.workflowId];

  if (taskId) {
    requireTask(database, workflow.workflowId, taskId);
    whereClauses.push('task_id = ?');
    params.push(taskId);
  }

  if (rerunId) {
    whereClauses.push('rerun_id = ?');
    params.push(rerunId);
  }

  params.push(limit);

  return database.prepare(`
    SELECT ${TASK_REVISION_COLUMNS}
    FROM workflow_task_revisions
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY created_at DESC, revision_id DESC
    LIMIT ?
  `).all(...params).map(mapTaskRevisionRow);
}

function addTaskOutput(database, input = {}) {
  const workflow = requireWorkflow(database, input.workflowId);
  const task = requireTask(database, workflow.workflowId, input.taskId);
  return insertTaskOutputForTaskSync(database, workflow.workflowId, task.taskId, input);
}

function insertTaskOutputForTaskSync(database, workflowId, taskId, input = {}) {
  const kind = normalizeOptionalText(input.kind);

  if (!kind) {
    throw new Error('Task output kind is required.');
  }

  const outputId = input.outputId || crypto.randomUUID();
  const outputName = normalizeOptionalText(input.name);
  const outputPath = normalizeOptionalText(input.path);
  const content = input.content == null ? null : String(input.content);
  const inputMetadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? { ...input.metadata }
    : {};
  const workspacePath = input.workspacePath ?? inputMetadata.workspacePath;
  const effectivePath = resolveTaskOutputStoragePath({
    outputId,
    workflowId,
    taskId,
    kind,
    name: outputName,
    path: outputPath,
    workspacePath,
    content
  });
  const artifactMaterialization = materializeTaskOutputArtifactSync({
    path: effectivePath,
    content,
    workspacePath
  });
  const outputMetadata = artifactMaterialization?.metadata
    ? {
        ...inputMetadata,
        ...artifactMaterialization.metadata
      }
    : inputMetadata;

  return insertTaskOutputSync(database, {
    outputId,
    workflowId,
    taskId,
    kind,
    name: outputName,
    content,
    path: effectivePath,
    metadata: normalizeTaskOutputMetadata({
      kind,
      path: effectivePath,
      metadata: outputMetadata,
      workflowId,
      taskId,
      workspacePath
    }),
    createdAt: input.createdAt
  });
}

function insertTaskOutputsForTaskSync(database, workflowId, taskId, outputs, context = {}) {
  if (!Array.isArray(outputs)) {
    return [];
  }

  const sanitizedOutputs = sanitizeTaskOutputSpecsForPersistence(outputs, context);
  return sanitizedOutputs
    .filter((output) => output && typeof output === 'object' && !Array.isArray(output))
    .map((output) => insertTaskOutputForTaskSync(database, workflowId, taskId, output));
}

function resolveTaskOutputStoragePath(input = {}) {
  const explicitPath = normalizeOptionalText(input.path);
  if (explicitPath) {
    return explicitPath;
  }

  const workspacePath = normalizeWorkspacePath(input.workspacePath);
  if (!workspacePath || input.content == null) {
    return null;
  }

  const directory = resolveTaskOutputStorageDirectory(input.kind);
  const fileStem = normalizeTaskOutputFileStem(input.name || input.kind);
  return normalizeRelativePath(`artifacts/workflows/${input.workflowId}/${input.taskId}/${directory}/${fileStem}-${input.outputId}.txt`);
}

function resolveTaskOutputStorageDirectory(kind) {
  switch (kind) {
    case 'result':
    case 'summary':
      return 'results';
    case 'artifact':
      return 'artifacts';
    case 'decision':
      return 'decisions';
    case 'error':
      return 'errors';
    case 'handoff':
      return 'handoffs';
    case 'validation-result':
      return 'validation';
    default:
      return 'outputs';
  }
}

function normalizeTaskOutputFileStem(value) {
  const text = normalizeOptionalText(value)?.toLowerCase() || 'output';
  const normalized = text
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'output';
}

function materializeTaskOutputArtifactSync(input = {}) {
  const outputPath = normalizeOptionalText(input.path);

  if (!outputPath) {
    return null;
  }

  const content = input.content == null ? null : String(input.content);
  const pathMetadata = normalizeTaskOutputPathMetadata(outputPath, input.workspacePath);

  if (pathMetadata.pathEscapesWorkspace) {
    throw new Error(`Task output path must stay within workspace: ${outputPath}`);
  }

  if (!pathMetadata.workspacePath || !pathMetadata.relativePath || content == null) {
    return {
      status: 'skipped',
      artifactRef: null,
      metadata: {
        storageStatus: 'skipped',
        storageReason: !pathMetadata.workspacePath
          ? 'missing_workspace_path'
          : content == null
            ? 'missing_content'
            : 'invalid_target_path'
      }
    };
  }

  const artifactPath = path.resolve(pathMetadata.workspacePath, pathMetadata.relativePath);
  fsSync.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fsSync.writeFileSync(artifactPath, content, 'utf8');

  const artifactRef = `file:${pathMetadata.relativePath}`;
  return {
    status: 'written',
    artifactRef,
    metadata: {
      artifactRef,
      storageStatus: 'written',
      relativePath: pathMetadata.relativePath,
      workspacePath: pathMetadata.workspacePath
    }
  };
}

function listTaskOutputs(database, input = {}) {
  const workflow = requireWorkflow(database, input.workflowId);
  const taskId = normalizeOptionalText(input.taskId);
  const kind = normalizeOptionalText(input.kind);
  const name = normalizeOptionalText(input.name);
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : DEFAULT_AUDIT_LIMIT;
  const whereClauses = ['workflow_id = ?'];
  const params = [workflow.workflowId];

  if (taskId) {
    requireTask(database, workflow.workflowId, taskId);
    whereClauses.push('task_id = ?');
    params.push(taskId);
  }

  if (kind) {
    whereClauses.push('kind = ?');
    params.push(kind);
  }

  if (name) {
    whereClauses.push('name = ?');
    params.push(name);
  }

  params.push(limit);

  return database.prepare(`
    SELECT ${TASK_OUTPUT_COLUMNS}
    FROM workflow_task_outputs
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY created_at DESC, output_id DESC
    LIMIT ?
  `).all(...params).map(mapTaskOutputRow);
}

function listDescendantTaskIds(database, input = {}) {
  const workflow = requireWorkflow(database, input.workflowId);
  requireTask(database, workflow.workflowId, input.taskId);
  return listDescendantTaskIdsSync(database, workflow.workflowId, input.taskId);
}

function listDescendantTaskIdsSync(database, workflowId, originTaskId) {
  const dependencies = listWorkflowDependencies(database, workflowId);
  const successorsByTaskId = new Map();

  for (const dependency of dependencies) {
    const successorIds = successorsByTaskId.get(dependency.predecessorTaskId) || [];
    successorIds.push(dependency.successorTaskId);
    successorsByTaskId.set(dependency.predecessorTaskId, successorIds);
  }

  const descendantIds = [];
  const queue = [...(successorsByTaskId.get(originTaskId) || [])];
  const visited = new Set(queue);

  while (queue.length > 0) {
    const currentTaskId = queue.shift();
    descendantIds.push(currentTaskId);

    for (const successorTaskId of successorsByTaskId.get(currentTaskId) || []) {
      if (!visited.has(successorTaskId)) {
        visited.add(successorTaskId);
        queue.push(successorTaskId);
      }
    }
  }

  return descendantIds;
}

function addRunLog(database, input = {}) {
  const workflow = requireWorkflow(database, input.workflowId);
  const taskId = input.taskId || null;
  const action = String(input.action || '').trim();
  const message = String(input.message || '').trim();

  if (!action) {
    throw new Error('Run log action is required.');
  }

  if (!message) {
    throw new Error('Run log message is required.');
  }

  if (taskId) {
    requireTask(database, workflow.workflowId, taskId);
  }

  return insertRunLogSync(database, {
    workflowId: workflow.workflowId,
    taskId,
    action,
    message,
    payload: input.payload,
    createdAt: input.createdAt
  });
}

function addTask(database, input = {}) {
  const workflow = requireWorkflow(database, input.workflowId);
  const taskId = input.taskId || crypto.randomUUID();
  const title = String(input.title || '').trim();
  const description = input.description == null ? null : String(input.description);
  const status = input.status || 'pending';

  if (!title) {
    throw new Error('Task title is required.');
  }

  assertTaskStatus(status);

  const insertTask = database.transaction(() => {
    const now = createTimestamp();
    const sequence = Number.isInteger(input.sequence)
      ? input.sequence
      : getNextSequence(database, workflow.workflowId);
    const nextRecovery = normalizeTaskRecovery(input.recovery);

    if (status === 'doing') {
      ensureWorkflowDoingCapacity(database, workflow.workflowId, taskId);
      ensureTaskReadyForExecution(database, workflow.workflowId, taskId, { allowMissingTask: true });
    }

    if (status === 'done') {
      ensureTaskReadyForExecution(database, workflow.workflowId, taskId, { allowMissingTask: true });
    }

    database.prepare(`
      INSERT INTO workflow_tasks (
        task_id,
        workflow_id,
        title,
        description,
        status,
        sequence_no,
        blocked_reason,
        done_summary,
        plan_task_key,
        owner_agent_id,
        preferred_role,
        required_capabilities_json,
        assignment_status,
        assignment_reason,
        handoff_json,
        contract_json,
        started_at,
        completed_at,
        lease_owner,
        lease_expires_at,
        attempt_count,
        last_error,
        reason_code,
        recovery_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      workflow.workflowId,
      title,
      description,
      status,
      sequence,
      status === 'blocked' ? normalizeOptionalText(input.blockedReason) : null,
      status === 'done' ? normalizeOptionalText(input.doneSummary) : null,
      normalizeOptionalText(input.planTaskKey),
      status === 'skipped' ? null : normalizeOptionalText(input.ownerAgentId),
      status === 'skipped' ? null : normalizeOptionalText(input.preferredRole),
      stringifyJson(status === 'skipped' ? null : normalizeOptionalStringArray(input.requiredCapabilities)),
      status === 'skipped' ? 'unassigned' : normalizeAssignmentStatus(input.assignmentStatus || 'unassigned'),
      status === 'skipped' ? null : normalizeOptionalText(input.assignmentReason),
      stringifyJson(status === 'skipped' ? null : input.handoff),
      stringifyJson(status === 'skipped' ? null : normalizeTaskContract(input.contract)),
      status === 'doing' || status === 'done' ? now : null,
      status === 'done' || status === 'skipped' ? now : null,
      status === 'doing' ? normalizeOptionalText(input.leaseOwner) : null,
      status === 'doing' ? normalizeOptionalText(input.leaseExpiresAt) : null,
      Number.isInteger(input.attemptCount) && input.attemptCount >= 0 ? input.attemptCount : 0,
      normalizeOptionalText(input.lastError),
      normalizeOptionalText(input.reasonCode),
      stringifyJson(status === 'skipped' ? null : nextRecovery),
      now,
      now
    );

    refreshWorkflowStateSync(database, workflow.workflowId, now);
    return requireTask(database, workflow.workflowId, taskId);
  });

  return insertTask.immediate();
}

function addDependency(database, input = {}) {
  const workflow = requireWorkflow(database, input.workflowId);
  const predecessor = requireTask(database, workflow.workflowId, input.predecessorTaskId);
  const successor = requireTask(database, workflow.workflowId, input.successorTaskId);
  const condition = normalizeDependencyCondition(input.condition);

  if (predecessor.taskId === successor.taskId) {
    throw new Error('A task cannot depend on itself.');
  }

  const insertDependency = database.transaction(() => {
    const now = createTimestamp();
    assertDependencyDoesNotCreateCycle(database, workflow.workflowId, predecessor.taskId, successor.taskId);

    database.prepare(`
      INSERT INTO workflow_dependencies (
        workflow_id,
        predecessor_task_id,
        successor_task_id,
        condition_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(workflow.workflowId, predecessor.taskId, successor.taskId, stringifyJson(condition), now);

    refreshWorkflowStateSync(database, workflow.workflowId, now);

    const row = database.prepare(`
      SELECT ${DEPENDENCY_COLUMNS}
      FROM workflow_dependencies
      WHERE workflow_id = ?
        AND predecessor_task_id = ?
        AND successor_task_id = ?
      LIMIT 1
    `).get(workflow.workflowId, predecessor.taskId, successor.taskId);

    return mapDependencyRow(row);
  });

  return insertDependency.immediate();
}

function assertDependencyDoesNotCreateCycle(database, workflowId, predecessorTaskId, successorTaskId) {
  const dependencies = listWorkflowDependencies(database, workflowId);
  const successorsByTaskId = new Map();

  for (const dependency of dependencies) {
    const successorIds = successorsByTaskId.get(dependency.predecessorTaskId) || [];
    successorIds.push(dependency.successorTaskId);
    successorsByTaskId.set(dependency.predecessorTaskId, successorIds);
  }

  const queue = [successorTaskId];
  const visited = new Set(queue);
  const previousByTaskId = new Map();

  while (queue.length > 0) {
    const currentTaskId = queue.shift();
    if (currentTaskId === predecessorTaskId) {
      const cyclePath = [predecessorTaskId];
      let pathTaskId = predecessorTaskId;

      while (previousByTaskId.has(pathTaskId)) {
        pathTaskId = previousByTaskId.get(pathTaskId);
        cyclePath.unshift(pathTaskId);
      }

      cyclePath.push(successorTaskId);
      throw new Error(`Cyclic dependency detected: ${cyclePath.join(' -> ')}`);
    }

    for (const nextTaskId of successorsByTaskId.get(currentTaskId) || []) {
      if (!visited.has(nextTaskId)) {
        visited.add(nextTaskId);
        previousByTaskId.set(nextTaskId, currentTaskId);
        queue.push(nextTaskId);
      }
    }
  }
}

function advanceTaskStatus(database, input = {}) {
  const workflow = requireWorkflow(database, input.workflowId);
  const taskId = String(input.taskId || '').trim();
  const nextStatus = String(input.status || '').trim();

  if (!taskId) {
    throw new Error('Task id is required.');
  }

  assertTaskStatus(nextStatus);

  const applyStatusChange = database.transaction(() => {
    const task = requireTask(database, workflow.workflowId, taskId);
    const now = createTimestamp();
    const isStatusUnchanged = task.status === nextStatus;

    if (!isStatusUnchanged) {
      assertValidStatusTransition(task.status, nextStatus);
    }

    if (nextStatus === 'doing') {
      ensureWorkflowDoingCapacity(database, workflow.workflowId, task.taskId);
      ensureTaskReadyForExecution(database, workflow.workflowId, task.taskId);
    }

    if (!isStatusUnchanged && (nextStatus === 'ready' || nextStatus === 'done')) {
      ensureTaskReadyForExecution(database, workflow.workflowId, task.taskId);
    }

    const expectedLeaseOwner = input.expectedLeaseOwner !== undefined
      ? normalizeOptionalText(input.expectedLeaseOwner)
      : null;
    const requiresDoingLeaseOwner = task.status === 'doing'
      && Boolean(task.leaseOwner)
      && nextStatus !== 'doing';

    if (requiresDoingLeaseOwner && !expectedLeaseOwner) {
      throw new Error('Leased doing tasks require the current leaseOwner to change status.');
    }

    if (expectedLeaseOwner && task.leaseOwner !== expectedLeaseOwner) {
      throw new Error('Task lease is no longer owned by the expected runner.');
    }

    if (expectedLeaseOwner && task.status !== 'doing') {
      throw new Error('Task is no longer doing under the expected runner lease.');
    }

    const nextBlockedReason = nextStatus === 'blocked'
      ? normalizeOptionalText(input.blockedReason) || task.blockedReason || 'Blocked by an unresolved dependency or constraint.'
      : null;

    const nextDoneSummary = nextStatus === 'done'
      ? normalizeOptionalText(input.doneSummary) || task.doneSummary || null
      : null;

    const nextStartedAt = nextStatus === 'doing' || nextStatus === 'done'
      ? task.startedAt || now
      : nextStatus === 'skipped'
        ? null
        : nextStatus === 'ready'
          ? null
          : task.startedAt;

    const nextCompletedAt = nextStatus === 'done' || nextStatus === 'skipped' ? now : null;
    const nextLeaseOwner = nextStatus === 'doing'
      ? normalizeOptionalText(input.leaseOwner) || task.leaseOwner || null
      : null;
    const nextLeaseExpiresAt = nextStatus === 'doing'
      ? normalizeOptionalText(input.leaseExpiresAt) || task.leaseExpiresAt || null
      : null;
    const nextAttemptCount = Number.isInteger(input.attemptCount) && input.attemptCount >= 0
      ? input.attemptCount
      : task.attemptCount;
    const nextLastError = input.lastError !== undefined
      ? normalizeOptionalText(input.lastError)
      : (nextStatus === 'blocked' || nextStatus === 'ready' || nextStatus === 'skipped')
        ? task.lastError
        : null;

    const nextReasonCode = input.reasonCode !== undefined
      ? normalizeOptionalText(input.reasonCode)
      : nextStatus === 'done'
        ? null
        : task.reasonCode;
    const sanitizedPayload = sanitizeAdvanceTaskPayloadForPersistence(input.payload);
    const rawNextRecovery = input.recovery !== undefined
      ? normalizeTaskRecovery(input.recovery)
      : nextStatus === 'blocked' || nextStatus === 'ready' || nextStatus === 'skipped'
        ? task.recovery
        : null;
    const nextRecovery = sanitizeRecoveryForPersistence(rawNextRecovery, {
      error: input.lastError,
      adapterPayload: sanitizedPayload
    });

    const nextOwnerAgentId = input.ownerAgentId !== undefined
      ? normalizeOptionalText(input.ownerAgentId)
      : nextStatus === 'skipped'
        ? null
        : task.ownerAgentId;
    const nextPreferredRole = input.preferredRole !== undefined
      ? normalizeOptionalText(input.preferredRole)
      : nextStatus === 'skipped'
        ? null
        : task.preferredRole;
    const nextRequiredCapabilities = input.requiredCapabilities !== undefined
      ? normalizeOptionalStringArray(input.requiredCapabilities)
      : nextStatus === 'skipped'
        ? null
        : task.requiredCapabilities;
    const nextAssignmentStatus = input.assignmentStatus !== undefined
      ? normalizeAssignmentStatus(input.assignmentStatus)
      : nextStatus === 'skipped'
        ? 'unassigned'
        : task.assignmentStatus;
    const nextAssignmentReason = input.assignmentReason !== undefined
      ? normalizeOptionalText(input.assignmentReason)
      : nextStatus === 'skipped'
        ? null
        : task.assignmentReason;
    const nextHandoff = input.handoff !== undefined
      ? input.handoff
      : nextStatus === 'skipped'
        ? null
        : task.handoff;
    const nextContract = input.contract !== undefined
      ? normalizeTaskContract(input.contract)
      : nextStatus === 'skipped'
        ? null
        : task.contract;
    const assignmentFieldsChanged = nextOwnerAgentId !== task.ownerAgentId
      || nextPreferredRole !== task.preferredRole
      || stringifyJson(nextRequiredCapabilities) !== stringifyJson(task.requiredCapabilities)
      || nextAssignmentStatus !== task.assignmentStatus
      || nextAssignmentReason !== task.assignmentReason
      || stringifyJson(nextHandoff) !== stringifyJson(task.handoff)
      || stringifyJson(nextContract) !== stringifyJson(task.contract);
    const nonAssignmentFieldsChanged = nextBlockedReason !== task.blockedReason
      || nextDoneSummary !== task.doneSummary
      || nextStartedAt !== task.startedAt
      || nextCompletedAt !== task.completedAt
      || nextLeaseOwner !== task.leaseOwner
      || nextLeaseExpiresAt !== task.leaseExpiresAt
      || nextAttemptCount !== task.attemptCount
      || nextLastError !== task.lastError
      || nextReasonCode !== task.reasonCode
      || stringifyJson(nextRecovery) !== stringifyJson(task.recovery);
    const canUseAssignmentFastPath = isStatusUnchanged && !nonAssignmentFieldsChanged;

    database.prepare(`
      UPDATE workflow_tasks
      SET
        status = ?,
        blocked_reason = ?,
        done_summary = ?,
        owner_agent_id = ?,
        preferred_role = ?,
        required_capabilities_json = ?,
        assignment_status = ?,
        assignment_reason = ?,
        handoff_json = ?,
        contract_json = ?,
        started_at = ?,
        completed_at = ?,
        lease_owner = ?,
        lease_expires_at = ?,
        attempt_count = ?,
        last_error = ?,
        reason_code = ?,
        recovery_json = ?,
        updated_at = ?
      WHERE task_id = ?
        AND workflow_id = ?
    `).run(
      nextStatus,
      nextBlockedReason,
      nextDoneSummary,
      nextOwnerAgentId,
      nextPreferredRole,
      stringifyJson(nextRequiredCapabilities),
      nextAssignmentStatus,
      nextAssignmentReason,
      stringifyJson(nextHandoff),
      stringifyJson(nextContract),
      nextStartedAt,
      nextCompletedAt,
      nextLeaseOwner,
      nextLeaseExpiresAt,
      nextAttemptCount,
      nextLastError,
      nextReasonCode,
      stringifyJson(nextRecovery),
      now,
      task.taskId,
      workflow.workflowId
    );

    const insertedTaskOutputs = insertTaskOutputsForTaskSync(database, workflow.workflowId, task.taskId, input.taskOutputs, {
      payload: sanitizedPayload,
      adapterPayload: sanitizedPayload
    });
    const runLogPayload = sanitizedPayload
      ? {
          ...sanitizedPayload,
          taskOutputs: insertedTaskOutputs
        }
      : {
          previousStatus: task.status,
          nextStatus,
          blockedReason: nextBlockedReason,
          doneSummary: nextDoneSummary,
          ownerAgentId: nextOwnerAgentId,
          preferredRole: nextPreferredRole,
          requiredCapabilities: nextRequiredCapabilities,
          assignmentStatus: nextAssignmentStatus,
          assignmentReason: nextAssignmentReason,
          handoff: nextHandoff,
          contract: nextContract,
          leaseOwner: nextLeaseOwner,
          leaseExpiresAt: nextLeaseExpiresAt,
          attemptCount: nextAttemptCount,
          lastError: nextLastError,
          reasonCode: nextReasonCode,
          recovery: nextRecovery,
          taskOutputs: insertedTaskOutputs
        };

    insertRunLogSync(database, {
      workflowId: workflow.workflowId,
      taskId: task.taskId,
      action: input.action || 'task_status_changed',
      message: input.message || `Task "${task.title}" moved to ${nextStatus}.`,
      payload: runLogPayload,
      createdAt: now
    });

    if (canUseAssignmentFastPath) {
      const refreshedWorkflow = requireWorkflow(database, workflow.workflowId);
      return {
        task: requireTask(database, workflow.workflowId, task.taskId),
        workflow: refreshedWorkflow,
        nextTask: getNextTaskSync(database, workflow.workflowId),
        taskOutputs: insertedTaskOutputs
      };
    }

    const hasFailedValidationTaskOutput = insertedTaskOutputs.some((output) => output.kind === 'validation-result' && output.metadata?.trustState === 'failed');
    const canUseLightRefresh = !hasFailedValidationTaskOutput
      && !isStatusUnchanged
      && ((task.status === 'doing' && nextStatus === 'blocked')
        || (task.status === 'doing' && nextStatus === 'ready'));

    const refreshed = canUseLightRefresh
      ? refreshWorkflowMetadataSync(database, workflow.workflowId, now)
      : refreshWorkflowStateSync(database, workflow.workflowId, now);

    return {
      task: requireTask(database, workflow.workflowId, task.taskId),
      workflow: refreshed.workflow,
      nextTask: refreshed.nextTask,
      taskOutputs: insertedTaskOutputs
    };
  });

  return applyStatusChange.immediate();
}

function restartFromTask(database, input = {}) {
  const workflow = requireWorkflow(database, input.workflowId);
  const originTaskId = String(input.taskId || '').trim();
  const reason = normalizeOptionalText(input.reason);
  const operator = normalizeOptionalText(input.operator);
  const payload = input.payload ?? null;
  const maxSameFingerprintReruns = normalizeMaxSameFingerprintReruns(input.maxSameFingerprintReruns);

  if (!originTaskId) {
    throw new Error('Task id is required.');
  }

  if (!reason) {
    throw new Error('Rerun reason is required.');
  }

  const restart = database.transaction(() => {
    const originTask = requireTask(database, workflow.workflowId, originTaskId);
    if (originTask.status === 'doing') {
      throw new Error('Cannot restart a task that is currently doing.');
    }

    ensureTaskReadyForExecution(database, workflow.workflowId, originTask.taskId);

    const fingerprint = normalizeOptionalText(input.fingerprint) || createRerunFingerprint(reason);
    const existingCount = countMatchingReruns(database, {
      workflowId: workflow.workflowId,
      taskId: originTask.taskId,
      fingerprint
    });

    if (existingCount >= maxSameFingerprintReruns) {
      throw new Error(`Rerun budget exceeded for fingerprint "${fingerprint}".`);
    }

    const descendantTaskIds = listDescendantTaskIdsSync(database, workflow.workflowId, originTask.taskId);
    const affectedTaskIds = [originTask.taskId, ...descendantTaskIds];
    const affectedTasks = affectedTaskIds.map((taskId) => requireTask(database, workflow.workflowId, taskId));
    const now = createTimestamp();
    const rerunId = crypto.randomUUID();

    insertWorkflowRerunSync(database, {
      rerunId,
      workflowId: workflow.workflowId,
      originTaskId: originTask.taskId,
      reason,
      fingerprint,
      operator,
      payload,
      affectedTaskIds,
      createdAt: now
    });

    for (const task of affectedTasks) {
      insertTaskRevisionSync(database, {
        revisionId: crypto.randomUUID(),
        workflowId: workflow.workflowId,
        taskId: task.taskId,
        rerunId,
        task,
        createdAt: now
      });
    }

    database.prepare(`
      UPDATE workflow_tasks
      SET
        status = 'ready',
        blocked_reason = NULL,
        done_summary = NULL,
        handoff_json = NULL,
        started_at = NULL,
        completed_at = NULL,
        lease_owner = NULL,
        lease_expires_at = NULL,
        attempt_count = 0,
        last_error = ?,
        reason_code = NULL,
        recovery_json = NULL,
        owner_agent_id = NULL,
        preferred_role = NULL,
        required_capabilities_json = NULL,
        assignment_status = 'unassigned',
        assignment_reason = NULL,
        updated_at = ?
      WHERE workflow_id = ?
        AND task_id = ?
    `).run(reason, now, workflow.workflowId, originTask.taskId);

    if (descendantTaskIds.length > 0) {
      const descendantReason = `Invalidated by rerun from task "${originTask.title}": ${reason}`;
      const placeholders = descendantTaskIds.map(() => '?').join(', ');
      database.prepare(`
        UPDATE workflow_tasks
        SET
          status = 'pending',
          blocked_reason = NULL,
          done_summary = NULL,
          handoff_json = NULL,
          started_at = NULL,
          completed_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          attempt_count = 0,
          last_error = ?,
          reason_code = NULL,
          recovery_json = NULL,
          owner_agent_id = NULL,
          preferred_role = NULL,
          required_capabilities_json = NULL,
          assignment_status = 'unassigned',
          assignment_reason = NULL,
          updated_at = ?
        WHERE workflow_id = ?
          AND task_id IN (${placeholders})
      `).run(descendantReason, now, workflow.workflowId, ...descendantTaskIds);
    }

    insertRunLogSync(database, {
      workflowId: workflow.workflowId,
      taskId: originTask.taskId,
      action: 'task_rerun_requested',
      message: `Restarted workflow from task "${originTask.title}".`,
      payload: {
        rerunId,
        reason,
        fingerprint,
        operator,
        payload,
        affectedTaskIds,
        descendantTaskIds,
        previousStatus: originTask.status
      },
      createdAt: now
    });

    for (const task of affectedTasks) {
      if (task.taskId === originTask.taskId) {
        continue;
      }

      insertRunLogSync(database, {
        workflowId: workflow.workflowId,
        taskId: task.taskId,
        action: 'task_invalidated_by_rerun',
        message: `Invalidated task "${task.title}" because an upstream task will rerun.`,
        payload: {
          rerunId,
          originTaskId: originTask.taskId,
          originTaskTitle: originTask.title,
          reason,
          fingerprint,
          previousStatus: task.status
        },
        createdAt: now
      });
    }

    insertRunLogSync(database, {
      workflowId: workflow.workflowId,
      action: 'workflow_rerun_created',
      message: `Created rerun from origin task "${originTask.title}" affecting ${affectedTaskIds.length} tasks.`,
      payload: {
        rerunId,
        originTaskId: originTask.taskId,
        fingerprint,
        reason,
        operator,
        payload,
        affectedTaskIds
      },
      createdAt: now
    });

    const state = refreshWorkflowStateSync(database, workflow.workflowId, now);
    return {
      rerun: requireRerun(database, rerunId),
      workflow: state.workflow,
      task: requireTask(database, workflow.workflowId, originTask.taskId),
      descendants: descendantTaskIds.map((taskId) => requireTask(database, workflow.workflowId, taskId)),
      nextTask: state.nextTask,
      state: getWorkflowStateSync(database, workflow.workflowId)
    };
  });

  return restart.immediate();
}

function claimNextReadyTask(database, input = {}) {
  const leaseOwner = normalizeLeaseOwner(input.leaseOwner);
  const leaseMs = normalizeLeaseMs(input.leaseMs);
  const skipExpiredLeaseSweep = input.skipExpiredLeaseSweep === true;

  const claimTask = database.transaction(() => {
    if (!skipExpiredLeaseSweep) {
      releaseExpiredTaskLeasesSync(database, input);
    }

    const candidate = selectNextReadyTaskCandidate(database, input);
    if (!candidate) {
      return null;
    }

    ensureWorkflowDoingCapacity(database, candidate.workflowId, candidate.taskId);
    ensureTaskReadyForExecution(database, candidate.workflowId, candidate.taskId);

    const now = createTimestamp();
    const leaseExpiresAt = createFutureTimestamp(leaseMs, now);

    const updateResult = database.prepare(`
      UPDATE workflow_tasks
      SET
        status = 'doing',
        blocked_reason = NULL,
        started_at = COALESCE(started_at, ?),
        lease_owner = ?,
        lease_expires_at = ?,
        attempt_count = COALESCE(attempt_count, 0) + 1,
        last_error = ?,
        updated_at = ?
      WHERE task_id = ?
        AND workflow_id = ?
        AND status = 'ready'
        AND (
          SELECT COUNT(*)
          FROM workflow_tasks other
          WHERE other.workflow_id = workflow_tasks.workflow_id
            AND other.status = 'doing'
            AND other.task_id != workflow_tasks.task_id
        ) < COALESCE((
          SELECT workflow.concurrency_limit
          FROM workflows workflow
          WHERE workflow.workflow_id = workflow_tasks.workflow_id
        ), 1)
    `).run(
      now,
      leaseOwner,
      leaseExpiresAt,
      candidate.lastError,
      now,
      candidate.taskId,
      candidate.workflowId
    );

    if (updateResult.changes === 0) {
      return null;
    }

    insertRunLogSync(database, {
      workflowId: candidate.workflowId,
      taskId: candidate.taskId,
      action: 'task_claimed',
      message: `Claimed task "${candidate.title}" for runner execution.`,
      payload: {
        leaseOwner,
        leaseExpiresAt,
        previousStatus: candidate.status,
        ownerAgentId: candidate.ownerAgentId,
        preferredRole: candidate.preferredRole,
        assignmentStatus: candidate.assignmentStatus
      },
      createdAt: now
    });

    const refreshed = refreshWorkflowMetadataSync(database, candidate.workflowId, now);
    return {
      task: requireTask(database, candidate.workflowId, candidate.taskId),
      workflow: refreshed.workflow,
      nextTask: refreshed.nextTask,
      leaseOwner,
      leaseExpiresAt
    };
  });

  return claimTask.immediate();
}

function peekNextReadyTask(database, input = {}) {
  const candidate = selectNextReadyTaskCandidate(database, input);
  if (!candidate) {
    return null;
  }

  ensureWorkflowDoingCapacity(database, candidate.workflowId, candidate.taskId);
  ensureTaskReadyForExecution(database, candidate.workflowId, candidate.taskId);

  return {
    task: candidate,
    workflow: requireWorkflow(database, candidate.workflowId),
    nextTask: getNextTaskSync(database, candidate.workflowId),
    leaseOwner: null,
    leaseExpiresAt: null
  };
}

function selectNextReadyTaskCandidate(database, input = {}) {
  const workflowId = normalizeOptionalText(input.workflowId);
  const taskId = normalizeOptionalText(input.taskId);
  const ownerAgentId = normalizeOptionalText(input.ownerAgentId);
  const preferredRole = normalizeOptionalText(input.preferredRole);
  const assignmentStatus = input.assignmentStatus == null
    ? null
    : normalizeAssignmentStatus(input.assignmentStatus);

  const whereClauses = [
    "task.status = 'ready'",
    `(
      SELECT COUNT(*)
      FROM workflow_tasks other
      WHERE other.workflow_id = task.workflow_id
        AND other.status = 'doing'
    ) < COALESCE((
      SELECT workflow.concurrency_limit
      FROM workflows workflow
      WHERE workflow.workflow_id = task.workflow_id
    ), 1)`
  ];
  const params = [];

  if (workflowId) {
    whereClauses.push('task.workflow_id = ?');
    params.push(workflowId);
  }

  if (taskId) {
    whereClauses.push('task.task_id = ?');
    params.push(taskId);
  }

  if (ownerAgentId) {
    whereClauses.push('task.owner_agent_id = ?');
    params.push(ownerAgentId);
  }

  if (preferredRole) {
    whereClauses.push('task.preferred_role = ?');
    params.push(preferredRole);
  }

  if (assignmentStatus) {
    whereClauses.push('task.assignment_status = ?');
    params.push(assignmentStatus);
  }

  const row = database.prepare(`
    SELECT ${TASK_COLUMNS}
    FROM workflow_tasks task
    WHERE ${whereClauses.join('\n      AND ')}
    ORDER BY task.sequence_no ASC, task.created_at ASC, task.task_id ASC
    LIMIT 1
  `).get(...params);

  return mapTaskRow(row);
}

function recoverSession(database, input = {}) {
  const workflowId = normalizeOptionalText(input.workflowId);
  const leaseOwner = normalizeLeaseOwner(input.leaseOwner);
  const leaseMs = normalizeLeaseMs(input.leaseMs);
  const ownerAgentId = normalizeOptionalText(input.ownerAgentId);
  const preferredRole = normalizeOptionalText(input.preferredRole);
  const assignmentStatus = input.assignmentStatus == null
    ? null
    : normalizeAssignmentStatus(input.assignmentStatus);
  const now = normalizeOptionalText(input.now) || createTimestamp();
  const reason = normalizeOptionalText(input.reason) || 'Recovering worker session released expired task lease.';

  const recover = database.transaction(() => {
    const releasedTasks = releaseExpiredTaskLeasesSync(database, {
      workflowId,
      now,
      reason
    });

    const whereClauses = [
      "status = 'doing'",
      'lease_owner = ?',
      'lease_expires_at IS NOT NULL',
      'lease_expires_at > ?'
    ];
    const params = [leaseOwner, now];

    if (workflowId) {
      whereClauses.push('workflow_id = ?');
      params.push(workflowId);
    }

    const ownedTask = mapTaskRow(database.prepare(`
      SELECT ${TASK_COLUMNS}
      FROM workflow_tasks
      WHERE ${whereClauses.join('\n        AND ')}
      ORDER BY updated_at DESC, started_at DESC, task_id ASC
      LIMIT 1
    `).get(...params));

    if (ownedTask) {
      const leaseExpiresAt = createFutureTimestamp(leaseMs, now);
      const updateResult = database.prepare(`
        UPDATE workflow_tasks
        SET lease_expires_at = ?, updated_at = ?
        WHERE workflow_id = ?
          AND task_id = ?
          AND status = 'doing'
          AND lease_owner = ?
      `).run(leaseExpiresAt, now, ownedTask.workflowId, ownedTask.taskId, leaseOwner);

      if (updateResult.changes === 0) {
        throw new Error('Task lease was taken over by another runner during recovery.');
      }

      insertRunLogSync(database, {
        workflowId: ownedTask.workflowId,
        taskId: ownedTask.taskId,
        action: 'task_session_recovered',
        message: `Recovered session for task "${ownedTask.title}".`,
        payload: {
          leaseOwner,
          leaseExpiresAt,
          previousLeaseExpiresAt: ownedTask.leaseExpiresAt
        },
        createdAt: now
      });

      const refreshed = refreshWorkflowMetadataSync(database, ownedTask.workflowId, now);
      return {
        mode: 'continued',
        task: requireTask(database, ownedTask.workflowId, ownedTask.taskId),
        workflow: refreshed.workflow,
        nextTask: refreshed.nextTask,
        leaseOwner,
        leaseExpiresAt,
        releasedTasks
      };
    }

    const claimed = claimNextReadyTask(database, {
      workflowId,
      leaseOwner,
      leaseMs,
      now,
      reason,
      ownerAgentId,
      preferredRole,
      assignmentStatus,
      skipExpiredLeaseSweep: true
    });

    if (claimed) {
      return {
        mode: 'claimed',
        ...claimed,
        releasedTasks
      };
    }

    return {
      mode: 'idle',
      workflow: workflowId ? requireWorkflow(database, workflowId) : null,
      task: null,
      nextTask: workflowId ? getNextTaskSync(database, workflowId) : null,
      leaseOwner,
      leaseExpiresAt: null,
      releasedTasks
    };
  });

  return recover.immediate();
}

function heartbeatTaskLease(database, input = {}) {
  const workflowId = String(input.workflowId || '').trim();
  const taskId = String(input.taskId || '').trim();
  const leaseOwner = normalizeLeaseOwner(input.leaseOwner);
  const leaseMs = normalizeLeaseMs(input.leaseMs);

  if (!workflowId) {
    throw new Error('Workflow id is required.');
  }

  if (!taskId) {
    throw new Error('Task id is required.');
  }

  const heartbeat = database.transaction(() => {
    const task = requireTask(database, workflowId, taskId);
    if (task.status !== 'doing') {
      throw new Error('Only doing tasks can refresh a lease.');
    }

    if (task.leaseOwner && task.leaseOwner !== leaseOwner) {
      throw new Error('Task lease is owned by another runner.');
    }

    if (!task.leaseOwner) {
      throw new Error('Task has no lease owner. Claim the task before heartbeating.');
    }

    const now = createTimestamp();
    const leaseExpiresAt = createFutureTimestamp(leaseMs, now);

    const updateResult = database.prepare(`
      UPDATE workflow_tasks
      SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE workflow_id = ?
        AND task_id = ?
        AND lease_owner = ?
    `).run(leaseOwner, leaseExpiresAt, now, workflowId, taskId, leaseOwner);

    if (updateResult.changes === 0) {
      throw new Error('Task lease was taken over by another runner during heartbeat.');
    }

    return requireTask(database, workflowId, taskId);
  });

  return heartbeat.immediate();
}

function releaseExpiredTaskLeases(database, input = {}) {
  const releaseLeases = database.transaction(() => {
    const releasedTasks = releaseExpiredTaskLeasesSync(database, input);
    return {
      releasedTaskCount: releasedTasks.length,
      tasks: releasedTasks
    };
  });

  return releaseLeases.immediate();
}

function sweepTimedOutTasks(database, input = {}) {
  const sweep = database.transaction(() => {
    const result = sweepTimedOutTasksSync(database, input);
    return {
      releasedTaskCount: result.released.length,
      blockedTaskCount: result.blocked.length,
      released: result.released,
      blocked: result.blocked,
      tasks: [...result.released, ...result.blocked]
    };
  });

  return sweep.immediate();
}

function getNextTask(database, workflowId) {
  requireWorkflow(database, workflowId);
  return getNextTaskSync(database, workflowId);
}

function getWorkflowState(database, workflowId, query = {}) {
  return getWorkflowStateSync(database, workflowId, query);
}

function getWorkflowStateSync(database, workflowId, query = {}) {
  const workflow = query.workflow || requireWorkflow(database, workflowId);
  const tasks = listWorkflowTasks(database, workflowId);
  const dependencies = listWorkflowDependencies(database, workflowId);
  const nextTask = query.nextTask === undefined
    ? getNextTaskSync(database, workflowId)
    : query.nextTask;
  const state = {
    workflow,
    tasks,
    dependencies,
    nextTask
  };

  if (query.includeRunLogs !== false) {
    state.runLogs = listWorkflowRunLogs(database, workflowId, query);
  }

  return state;
}

function refreshWorkflowStateSync(database, workflowId, timestamp = createTimestamp()) {
  requireWorkflow(database, workflowId);
  ensureWorkflowWithinDoingCapacity(database, workflowId);
  syncPendingAndReadyTasks(database, workflowId, timestamp);
  ensureWorkflowWithinDoingCapacity(database, workflowId);

  const refreshed = refreshWorkflowMetadataSync(database, workflowId, timestamp);
  return getWorkflowStateSync(database, workflowId, {
    includeRunLogs: false,
    workflow: refreshed.workflow,
    nextTask: refreshed.nextTask
  });
}

function refreshWorkflowMetadataSync(database, workflowId, timestamp = createTimestamp()) {
  requireWorkflow(database, workflowId);

  const summary = database.prepare(`
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_count,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count,
      SUM(CASE WHEN status = 'doing' THEN 1 ELSE 0 END) AS doing_count,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_count
    FROM workflow_tasks
    WHERE workflow_id = ?
  `).get(workflowId);

  const totalCount = summary.total_count || 0;
  const doneCount = summary.done_count || 0;
  const skippedCount = summary.skipped_count || 0;
  const doingCount = summary.doing_count || 0;
  const readyCount = summary.ready_count || 0;

  let nextWorkflowStatus = 'draft';
  if (totalCount === 0) {
    nextWorkflowStatus = 'draft';
  } else if (doingCount > 0) {
    nextWorkflowStatus = 'doing';
  } else if (readyCount > 0) {
    nextWorkflowStatus = 'ready';
  } else if (doneCount > 0 && doneCount + skippedCount === totalCount) {
    nextWorkflowStatus = 'done';
  } else {
    nextWorkflowStatus = 'blocked';
  }

  const nextTask = getNextTaskSync(database, workflowId);
  database.prepare(`
    UPDATE workflows
    SET status = ?, current_task_id = ?, updated_at = ?
    WHERE workflow_id = ?
  `).run(nextWorkflowStatus, nextTask?.taskId || null, timestamp, workflowId);

  return {
    workflow: requireWorkflow(database, workflowId),
    nextTask
  };
}

function syncPendingAndReadyTasks(database, workflowId, timestamp) {
  database.transaction(() => {
    const tasks = database.prepare(`
      SELECT ${TASK_COLUMNS}
      FROM workflow_tasks
      WHERE workflow_id = ?
        AND status IN ('pending', 'ready')
      ORDER BY sequence_no ASC, created_at ASC, task_id ASC
    `).all(workflowId).map(mapTaskRow);

    for (const task of tasks) {
      const blockedDependency = getBlockedDependency(database, workflowId, task.taskId);
      if (!blockedDependency && task.status === 'pending') {
        database.prepare(`
          UPDATE workflow_tasks
          SET status = 'ready', updated_at = ?
          WHERE workflow_id = ?
            AND task_id = ?
            AND status = 'pending'
        `).run(timestamp, workflowId, task.taskId);
      } else if (blockedDependency?.reasonCode === 'dependency_condition_not_met') {
        database.prepare(`
          UPDATE workflow_tasks
          SET
            status = 'skipped',
            blocked_reason = NULL,
            done_summary = NULL,
            owner_agent_id = NULL,
            preferred_role = NULL,
            required_capabilities_json = NULL,
            assignment_status = 'unassigned',
            assignment_reason = NULL,
            handoff_json = NULL,
            contract_json = NULL,
            started_at = NULL,
            completed_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = ?,
            reason_code = 'dependency_condition_not_met',
            updated_at = ?
          WHERE workflow_id = ?
            AND task_id = ?
            AND status IN ('pending', 'ready')
        `).run(
          timestamp,
          'Skipped because dependency condition evaluated false.',
          timestamp,
          workflowId,
          task.taskId
        );

        insertRunLogSync(database, {
          workflowId,
          taskId: task.taskId,
          action: 'task_skipped_by_dependency_condition',
          message: `Skipped task "${task.title}" because dependency condition evaluated false.`,
          payload: {
            predecessorTaskId: blockedDependency.predecessorTaskId,
            successorTaskId: blockedDependency.successorTaskId,
            dependencyId: blockedDependency.id,
            condition: blockedDependency.condition,
            reasonCode: blockedDependency.reasonCode
          },
          createdAt: timestamp
        });
      } else if (blockedDependency && task.status === 'ready') {
        database.prepare(`
          UPDATE workflow_tasks
          SET status = 'pending', updated_at = ?
          WHERE workflow_id = ?
            AND task_id = ?
            AND status = 'ready'
        `).run(timestamp, workflowId, task.taskId);
      }
    }
  })();
}

function ensureWorkflowDoingCapacity(database, workflowId, taskId = null) {
  const workflow = requireWorkflow(database, workflowId);
  const params = [workflowId];
  let taskFilter = '';

  if (taskId) {
    taskFilter = 'AND task_id != ?';
    params.push(taskId);
  }

  const row = database.prepare(`
    SELECT COUNT(*) AS doing_count
    FROM workflow_tasks
    WHERE workflow_id = ?
      AND status = 'doing'
      ${taskFilter}
  `).get(...params);

  if ((row?.doing_count || 0) >= workflow.concurrencyLimit) {
    throw new Error(`Workflow doing task capacity exceeded. concurrencyLimit=${workflow.concurrencyLimit}`);
  }
}

function ensureWorkflowWithinDoingCapacity(database, workflowId) {
  const workflow = requireWorkflow(database, workflowId);
  const row = database.prepare(`
    SELECT COUNT(*) AS doing_count
    FROM workflow_tasks
    WHERE workflow_id = ?
      AND status = 'doing'
  `).get(workflowId);

  if ((row?.doing_count || 0) > workflow.concurrencyLimit) {
    throw new Error(`Workflow has more doing tasks than allowed. concurrencyLimit=${workflow.concurrencyLimit}`);
  }
}

function ensureTaskReadyForExecution(database, workflowId, taskId, options = {}) {
  if (!options.allowMissingTask) {
    requireTask(database, workflowId, taskId);
  }

  const blockedDependency = getBlockedDependency(database, workflowId, taskId);

  if (!blockedDependency) {
    return;
  }

  if (blockedDependency.reasonCode === 'dependency_condition_not_met') {
    throw new Error(`Task dependency condition is not met. Predecessor "${blockedDependency.predecessorTaskId}" is done but its output condition evaluated false.`);
  }

  throw new Error(`Task still has unfinished dependencies. Predecessor "${blockedDependency.predecessorTaskId}" is not done.`);
}

function getBlockedDependency(database, workflowId, taskId) {
  const rows = database.prepare(`
    SELECT
      dependency.id,
      dependency.workflow_id,
      dependency.predecessor_task_id,
      dependency.successor_task_id,
      dependency.condition_json,
      dependency.created_at,
      predecessor.status AS predecessor_status
    FROM workflow_dependencies dependency
    JOIN workflow_tasks predecessor
      ON predecessor.task_id = dependency.predecessor_task_id
    WHERE dependency.workflow_id = ?
      AND dependency.successor_task_id = ?
    ORDER BY dependency.id ASC
  `).all(workflowId, taskId);

  for (const row of rows) {
    const dependency = mapDependencyRow(row);
    if (row.predecessor_status !== 'done') {
      if (
        row.predecessor_status === 'blocked'
        && isFailedValidationResultCondition(dependency.condition)
        && evaluateDependencyCondition(database, workflowId, dependency.predecessorTaskId, dependency.condition)
      ) {
        continue;
      }

      return {
        ...dependency,
        reasonCode: 'dependency_not_done'
      };
    }

    if (!evaluateDependencyCondition(database, workflowId, dependency.predecessorTaskId, dependency.condition)) {
      return {
        ...dependency,
        reasonCode: 'dependency_condition_not_met'
      };
    }
  }

  return null;
}

function isFailedValidationResultCondition(condition) {
  return condition?.outputKind === 'validation-result'
    && condition?.path === 'metadata.trustState'
    && condition?.operator === 'equals'
    && condition?.value === 'failed';
}

function evaluateDependencyCondition(database, workflowId, predecessorTaskId, condition) {
  if (!condition) {
    return true;
  }

  const outputs = listConditionCandidateOutputs(database, workflowId, predecessorTaskId, condition);
  if (outputs.length === 0) {
    return false;
  }

  const resolved = condition.path
    ? resolveOutputPath(outputs[0], condition.path)
    : { exists: true, value: outputs[0] };

  if (condition.operator === 'exists') {
    return resolved.exists && resolved.value != null;
  }

  if (!resolved.exists) {
    return false;
  }

  return compareConditionValue(resolved.value, condition.operator, condition.value);
}

function listConditionCandidateOutputs(database, workflowId, predecessorTaskId, condition) {
  const whereClauses = ['workflow_id = ?', 'task_id = ?'];
  const params = [workflowId, predecessorTaskId];

  if (condition.outputKind) {
    whereClauses.push('kind = ?');
    params.push(condition.outputKind);
  }

  if (condition.outputName) {
    whereClauses.push('name = ?');
    params.push(condition.outputName);
  }

  return database.prepare(`
    SELECT ${TASK_OUTPUT_COLUMNS}
    FROM workflow_task_outputs
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY created_at DESC, output_id DESC
    LIMIT 1
  `).all(...params).map(mapTaskOutputRow);
}

function resolveOutputPath(output, outputPath) {
  const parts = String(outputPath).split('.').filter(Boolean);
  let current = output;

  for (const part of parts) {
    if (current == null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
      return { exists: false, value: undefined };
    }

    current = current[part];
  }

  return { exists: true, value: current };
}

function compareConditionValue(actual, operator, expected) {
  if (operator === 'equals') {
    return areConditionValuesEqual(actual, expected);
  }

  if (operator === 'notEquals') {
    return !areConditionValuesEqual(actual, expected);
  }

  if (operator === 'includes') {
    if (Array.isArray(actual)) {
      return actual.some((item) => areConditionValuesEqual(item, expected));
    }

    if (typeof actual === 'string') {
      return actual.includes(String(expected));
    }

    return false;
  }

  throw new Error(`Unsupported dependency condition operator: ${operator}`);
}

function areConditionValuesEqual(left, right) {
  if (Object.is(left, right)) {
    return true;
  }

  if (left == null || right == null) {
    return false;
  }

  if (typeof left === 'object' || typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  return String(left) === String(right);
}

function releaseExpiredTaskLeasesSync(database, input = {}) {
  const now = normalizeOptionalText(input.now) || createTimestamp();
  const workflowId = normalizeOptionalText(input.workflowId);
  const reason = normalizeOptionalText(input.reason) || 'Task lease expired before completion.';
  const refreshedWorkflows = new Set();

  const releasedTasks = database.transaction(() => {
    const whereClauses = [
      "status = 'doing'",
      'lease_expires_at IS NOT NULL',
      'lease_expires_at <= ?'
    ];
    const params = [now];

    if (workflowId) {
      whereClauses.push('workflow_id = ?');
      params.push(workflowId);
    }

    const tasks = database.prepare(`
      SELECT ${TASK_COLUMNS}
      FROM workflow_tasks
      WHERE ${whereClauses.join('\n      AND ')}
      ORDER BY lease_expires_at ASC, updated_at ASC, task_id ASC
    `).all(...params).map(mapTaskRow);

    for (const task of tasks) {
      database.prepare(`
        UPDATE workflow_tasks
        SET
          status = 'ready',
          blocked_reason = NULL,
          started_at = NULL,
          owner_agent_id = NULL,
          assignment_status = CASE
            WHEN assignment_status IN ('assigned', 'accepted') THEN 'released'
            ELSE assignment_status
          END,
          assignment_reason = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = ?,
          reason_code = NULL,
          recovery_json = NULL,
          updated_at = ?
        WHERE workflow_id = ?
          AND task_id = ?
          AND status = 'doing'
          AND lease_expires_at <= ?
      `).run(reason, reason, now, task.workflowId, task.taskId, now);

      insertRunLogSync(database, {
        workflowId: task.workflowId,
        taskId: task.taskId,
        action: 'task_lease_released',
        message: `Released expired lease for task "${task.title}".`,
        payload: {
          previousLeaseOwner: task.leaseOwner,
          previousLeaseExpiresAt: task.leaseExpiresAt,
          previousAttemptCount: task.attemptCount,
          attemptCount: task.attemptCount,
          lastError: reason
        },
        createdAt: now
      });

      refreshedWorkflows.add(task.workflowId);
    }

    return tasks;
  }).immediate();

  for (const workflowId of refreshedWorkflows) {
    refreshWorkflowMetadataSync(database, workflowId, now);
  }

  return releasedTasks.map((task) => requireTask(database, task.workflowId, task.taskId));
}

function sweepTimedOutTasksSync(database, input = {}) {
  const now = normalizeOptionalText(input.now) || createTimestamp();
  const workflowId = normalizeOptionalText(input.workflowId);
  const defaultTimeoutPolicy = {
    executionTimeoutMs: normalizeOptionalNumber(input.maxExecutionMs),
    stalledTimeoutMs: normalizeOptionalNumber(input.stalledMs),
    maxAttempts: normalizeOptionalNumber(input.maxAttempts),
    timeoutReason: normalizeOptionalText(input.reason) || 'Task exceeded execution policy.'
  };

  const released = [];
  const blocked = [];
  const refreshedWorkflows = new Set();

  database.transaction(() => {
    const whereClauses = ["status = 'doing'"];
    const params = [];

    if (workflowId) {
      whereClauses.push('workflow_id = ?');
      params.push(workflowId);
    }

    const timedOutTasks = database.prepare(`
      SELECT ${TASK_COLUMNS}
      FROM workflow_tasks
      WHERE ${whereClauses.join('\n      AND ')}
      ORDER BY updated_at ASC, started_at ASC, task_id ASC
    `).all(...params)
      .map(mapTaskRow)
      .map((task) => {
        const timeout = resolveTaskTimeoutKind(task, {
          now,
          policy: resolveEffectiveTaskTimeoutPolicy(task, defaultTimeoutPolicy)
        });
        return timeout.kind ? { task, timeout } : null;
      })
      .filter(Boolean);

    for (const { task, timeout } of timedOutTasks) {
      const attemptCount = Number.isInteger(task.attemptCount) && task.attemptCount >= 0 ? task.attemptCount : 0;
      const shouldBlock = timeout.maxAttempts != null && attemptCount >= timeout.maxAttempts;
      const reasonCode = timeout.kind === 'stalled' ? 'runner_execution_stalled' : 'runner_execution_timeout';
      const lastError = `${timeout.reason} (${timeout.kind}; attempt ${attemptCount}${timeout.maxAttempts != null ? `/${timeout.maxAttempts}` : ''}).`;
      const nextStatus = shouldBlock ? 'blocked' : 'ready';
      const assignmentReason = shouldBlock ? task.assignmentReason : lastError;
      const recovery = buildFailureRecoveryMetadata({
        reasonCode,
        retryable: !shouldBlock,
        retryAction: shouldBlock ? null : 'task_timeout_retry_scheduled_by_runner',
        failureType: timeout.kind === 'stalled' ? 'stalled' : 'timeout',
        attemptCount,
        maxTaskRetries: timeout.maxAttempts,
        maxAttempts: timeout.maxAttempts,
        error: lastError,
        extra: {
          timeoutKind: timeout.kind,
          timeoutMs: timeout.timeoutMs
        }
      });

      database.prepare(`
        UPDATE workflow_tasks
        SET
          status = ?,
          blocked_reason = ?,
          started_at = CASE WHEN ? = 'ready' THEN NULL ELSE started_at END,
          owner_agent_id = CASE WHEN ? = 'ready' THEN NULL ELSE owner_agent_id END,
          assignment_status = CASE
            WHEN ? = 'ready' AND assignment_status IN ('assigned', 'accepted') THEN 'released'
            ELSE assignment_status
          END,
          assignment_reason = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = ?,
          reason_code = ?,
          recovery_json = ?,
          updated_at = ?
        WHERE workflow_id = ?
          AND task_id = ?
          AND status = 'doing'
      `).run(
        nextStatus,
        shouldBlock ? lastError : null,
        nextStatus,
        nextStatus,
        nextStatus,
        assignmentReason,
        lastError,
        reasonCode,
        stringifyJson(recovery),
        now,
        task.workflowId,
        task.taskId
      );

      insertRunLogSync(database, {
        workflowId: task.workflowId,
        taskId: task.taskId,
        action: shouldBlock ? 'task_timeout_blocked' : 'task_timeout_released',
        message: shouldBlock
          ? `Blocked timed-out task "${task.title}".`
          : `Released timed-out task "${task.title}" for retry.`,
        payload: {
          previousLeaseOwner: task.leaseOwner,
          previousLeaseExpiresAt: task.leaseExpiresAt,
          timeoutKind: timeout.kind,
          timeoutMs: timeout.timeoutMs,
          attemptCount,
          maxAttempts: timeout.maxAttempts,
          lastError,
          reasonCode,
          trustState: 'failed',
          recoveryOnly: true
        },
        createdAt: now
      });

      const updatedTask = requireTask(database, task.workflowId, task.taskId);
      if (shouldBlock) {
        blocked.push(updatedTask);
      } else {
        released.push(updatedTask);
      }
      refreshedWorkflows.add(task.workflowId);
    }

    for (const workflowId of refreshedWorkflows) {
      refreshWorkflowMetadataSync(database, workflowId, now);
    }
  }).immediate();

  return { released, blocked };
}

function resolveTaskTimeoutKind(task, { now, policy } = {}) {
  const timeoutCutoff = policy?.executionTimeoutMs ? createPastTimestamp(policy.executionTimeoutMs, now) : null;
  if (timeoutCutoff && task.startedAt && task.startedAt <= timeoutCutoff) {
    return {
      kind: 'timeout',
      timeoutMs: policy.executionTimeoutMs,
      maxAttempts: policy.maxAttempts,
      reason: policy.timeoutReason
    };
  }

  const stalledCutoff = policy?.stalledTimeoutMs ? createPastTimestamp(policy.stalledTimeoutMs, now) : null;
  if (stalledCutoff && task.updatedAt && task.updatedAt <= stalledCutoff) {
    return {
      kind: 'stalled',
      timeoutMs: policy.stalledTimeoutMs,
      maxAttempts: policy.maxAttempts,
      reason: policy.timeoutReason
    };
  }

  return {
    kind: null,
    timeoutMs: null,
    maxAttempts: policy?.maxAttempts ?? null,
    reason: policy?.timeoutReason || 'Task exceeded execution policy.'
  };
}

function resolveEffectiveTaskTimeoutPolicy(task, defaults = {}) {
  const contract = task?.contract && typeof task.contract === 'object' && !Array.isArray(task.contract)
    ? task.contract
    : null;

  return {
    executionTimeoutMs: contract?.executionTimeoutMs ?? defaults.executionTimeoutMs ?? null,
    stalledTimeoutMs: contract?.stalledTimeoutMs ?? defaults.stalledTimeoutMs ?? null,
    maxAttempts: contract?.maxTimeoutAttempts ?? defaults.maxAttempts ?? null,
    timeoutReason: contract?.timeoutReason || defaults.timeoutReason || 'Task exceeded execution policy.'
  };
}

function getNextTaskSync(database, workflowId) {
  const row = database.prepare(`
    SELECT ${TASK_COLUMNS}
    FROM workflow_tasks
    WHERE workflow_id = ?
      AND status IN ('doing', 'ready')
    ORDER BY CASE status WHEN 'doing' THEN 0 ELSE 1 END, sequence_no ASC, created_at ASC, task_id ASC
    LIMIT 1
  `).get(workflowId);

  return mapTaskRow(row);
}

function getNextSequence(database, workflowId) {
  const row = database.prepare(`
    SELECT COALESCE(MAX(sequence_no), -1) AS max_sequence
    FROM workflow_tasks
    WHERE workflow_id = ?
  `).get(workflowId);

  return (row?.max_sequence ?? -1) + 1;
}

function requireWorkflow(database, workflowId) {
  const normalizedWorkflowId = normalizeRequiredText(workflowId, 'Workflow id is required.');
  const workflow = getWorkflow(database, normalizedWorkflowId);
  if (!workflow) {
    throw new Error('Workflow not found.');
  }

  return workflow;
}

function requireWorkflowDefinition(database, definitionId) {
  const normalizedDefinitionId = normalizeRequiredText(definitionId, 'Workflow definitionId is required.');
  const definition = getWorkflowDefinition(database, normalizedDefinitionId);
  if (!definition) {
    throw new Error('Workflow definition not found.');
  }

  return definition;
}

function requireTask(database, workflowId, taskId) {
  const row = database.prepare(`
    SELECT ${TASK_COLUMNS}
    FROM workflow_tasks
    WHERE workflow_id = ?
      AND task_id = ?
    LIMIT 1
  `).get(workflowId, taskId);

  const task = mapTaskRow(row);
  if (!task) {
    throw new Error('Task not found.');
  }

  return task;
}

function insertRunLogSync(database, input = {}) {
  const logId = input.logId || crypto.randomUUID();
  const payload = sanitizeRunLogPayloadForPersistence(input.payload, { payload: input.payload });
  const payloadJson = stringifyJson(payload);
  const createdAt = input.createdAt || createTimestamp();
  database.prepare(`
    INSERT INTO workflow_run_logs (
      log_id,
      workflow_id,
      task_id,
      action,
      message,
      payload_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    logId,
    input.workflowId,
    input.taskId || null,
    input.action,
    input.message,
    payloadJson,
    createdAt
  );

  return mapRunLogRow({
    log_id: logId,
    workflow_id: input.workflowId,
    task_id: input.taskId || null,
    action: input.action,
    message: input.message,
    payload_json: payloadJson,
    created_at: createdAt
  });
}

function insertTaskOutputSync(database, input = {}) {
  const outputId = input.outputId || crypto.randomUUID();
  const metadataJson = stringifyJson(input.metadata);
  const createdAt = input.createdAt || createTimestamp();

  database.prepare(`
    INSERT INTO workflow_task_outputs (
      output_id,
      workflow_id,
      task_id,
      kind,
      name,
      content_text,
      path,
      metadata_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    outputId,
    input.workflowId,
    input.taskId,
    input.kind,
    input.name || null,
    input.content == null ? null : String(input.content),
    input.path || null,
    metadataJson,
    createdAt
  );

  return mapTaskOutputRow({
    output_id: outputId,
    workflow_id: input.workflowId,
    task_id: input.taskId,
    kind: input.kind,
    name: input.name || null,
    content_text: input.content == null ? null : String(input.content),
    path: input.path || null,
    metadata_json: metadataJson,
    created_at: createdAt
  });
}

function mapWorkflowRow(row) {
  if (!row) {
    return null;
  }

  return {
    workflowId: row.workflow_id,
    goal: row.goal,
    instruction: row.instruction,
    initialPlan: parseJson(row.initial_plan_json),
    status: row.status,
    currentTaskId: row.current_task_id,
    concurrencyLimit: normalizeConcurrencyLimit(row.concurrency_limit),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapWorkflowDefinitionRow(row) {
  if (!row) {
    return null;
  }

  return {
    definitionId: row.definition_id,
    name: row.name,
    description: row.description,
    goal: row.goal,
    instruction: row.instruction,
    plan: parseJson(row.plan_json),
    metadata: parseJson(row.metadata_json),
    concurrencyLimit: normalizeConcurrencyLimit(row.concurrency_limit),
    sourceWorkflowId: row.source_workflow_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapTaskRow(row) {
  if (!row) {
    return null;
  }

  return {
    taskId: row.task_id,
    workflowId: row.workflow_id,
    title: row.title,
    description: row.description,
    status: row.status,
    sequence: row.sequence_no,
    blockedReason: row.blocked_reason,
    doneSummary: row.done_summary,
    planTaskKey: row.plan_task_key,
    ownerAgentId: row.owner_agent_id,
    preferredRole: row.preferred_role,
    requiredCapabilities: parseJson(row.required_capabilities_json) || [],
    assignmentStatus: row.assignment_status || 'unassigned',
    assignmentReason: row.assignment_reason,
    handoff: parseJson(row.handoff_json),
    contract: normalizeTaskContract(parseJson(row.contract_json)),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    attemptCount: Number.isInteger(row.attempt_count) ? row.attempt_count : Number(row.attempt_count || 0),
    lastError: row.last_error,
    reasonCode: row.reason_code,
    recovery: normalizeTaskRecovery(parseJson(row.recovery_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapDependencyRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    workflowId: row.workflow_id,
    predecessorTaskId: row.predecessor_task_id,
    successorTaskId: row.successor_task_id,
    condition: parseJson(row.condition_json),
    createdAt: row.created_at
  };
}

function mapRunLogRow(row) {
  if (!row) {
    return null;
  }

  return {
    logId: row.log_id,
    workflowId: row.workflow_id,
    taskId: row.task_id,
    action: row.action,
    message: row.message,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at
  };
}

function filterTaskOutputsByTrust(outputs, input = {}) {
  const trustStates = normalizeTaskOutputTrustStates(input.trustStates);
  const includeUnverified = input.includeUnverified !== false;

  if (!trustStates && includeUnverified) {
    return {
      outputs,
      filteredCount: 0
    };
  }

  const allowedStates = trustStates || new Set(['validated']);
  if (includeUnverified) {
    allowedStates.add('unverified');
  }

  const filteredOutputs = outputs.filter((output) => allowedStates.has(getTaskOutputTrustState(output)));
  return {
    outputs: filteredOutputs,
    filteredCount: outputs.length - filteredOutputs.length
  };
}

function normalizeTaskOutputTrustStates(value) {
  if (value == null) {
    return null;
  }

  const values = Array.isArray(value) ? value : [value];
  const states = values
    .map((item) => normalizeOptionalText(item))
    .filter((item) => TASK_OUTPUT_TRUST_STATES.has(item));

  return states.length > 0 ? new Set(states) : null;
}

function getTaskOutputTrustState(output) {
  const trustState = normalizeOptionalText(output?.metadata?.trustState);
  return TASK_OUTPUT_TRUST_STATES.has(trustState) ? trustState : 'unverified';
}

function isTrustedTaskOutput(output) {
  return TRUSTED_TASK_OUTPUT_STATES.has(getTaskOutputTrustState(output));
}

function mapTaskOutputRow(row) {
  if (!row) {
    return null;
  }

  return {
    outputId: row.output_id,
    workflowId: row.workflow_id,
    taskId: row.task_id,
    kind: row.kind,
    name: row.name,
    content: row.content_text,
    path: row.path,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at
  };
}

function mapRerunRow(row) {
  if (!row) {
    return null;
  }

  return {
    rerunId: row.rerun_id,
    workflowId: row.workflow_id,
    originTaskId: row.origin_task_id,
    reason: row.reason,
    fingerprint: row.fingerprint,
    operator: row.operator,
    payload: parseJson(row.payload_json),
    affectedTaskCount: Number.isInteger(row.affected_task_count) ? row.affected_task_count : Number(row.affected_task_count || 0),
    affectedTaskIds: parseJson(row.affected_task_ids_json) || [],
    createdAt: row.created_at
  };
}

function mapTaskRevisionRow(row) {
  if (!row) {
    return null;
  }

  return {
    revisionId: row.revision_id,
    workflowId: row.workflow_id,
    taskId: row.task_id,
    rerunId: row.rerun_id,
    previousStatus: row.previous_status,
    previousDoneSummary: row.previous_done_summary,
    previousBlockedReason: row.previous_blocked_reason,
    previousLastError: row.previous_last_error,
    previousAttemptCount: Number.isInteger(row.previous_attempt_count) ? row.previous_attempt_count : Number(row.previous_attempt_count || 0),
    previousHandoff: parseJson(row.previous_handoff_json),
    snapshot: parseJson(row.snapshot_json),
    createdAt: row.created_at
  };
}

function requireRerun(database, rerunId) {
  const row = database.prepare(`
    SELECT ${RERUN_COLUMNS}
    FROM workflow_reruns
    WHERE rerun_id = ?
    LIMIT 1
  `).get(rerunId);

  const rerun = mapRerunRow(row);
  if (!rerun) {
    throw new Error('Workflow rerun not found.');
  }

  return rerun;
}

function insertWorkflowRerunSync(database, input = {}) {
  database.prepare(`
    INSERT INTO workflow_reruns (
      rerun_id,
      workflow_id,
      origin_task_id,
      reason,
      fingerprint,
      operator,
      payload_json,
      affected_task_count,
      affected_task_ids_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.rerunId,
    input.workflowId,
    input.originTaskId,
    input.reason,
    input.fingerprint,
    input.operator || null,
    stringifyJson(input.payload),
    Array.isArray(input.affectedTaskIds) ? input.affectedTaskIds.length : 0,
    stringifyJson(input.affectedTaskIds || []),
    input.createdAt || createTimestamp()
  );

  return requireRerun(database, input.rerunId);
}

function insertTaskRevisionSync(database, input = {}) {
  const task = input.task;
  database.prepare(`
    INSERT INTO workflow_task_revisions (
      revision_id,
      workflow_id,
      task_id,
      rerun_id,
      previous_status,
      previous_done_summary,
      previous_blocked_reason,
      previous_last_error,
      previous_attempt_count,
      previous_handoff_json,
      snapshot_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.revisionId,
    input.workflowId,
    input.taskId,
    input.rerunId,
    task.status,
    task.doneSummary,
    task.blockedReason,
    task.lastError,
    task.attemptCount,
    stringifyJson(task.handoff),
    stringifyJson(task),
    input.createdAt || createTimestamp()
  );
}

function countMatchingReruns(database, input = {}) {
  const row = database.prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_reruns
    WHERE workflow_id = ?
      AND origin_task_id = ?
      AND fingerprint = ?
  `).get(input.workflowId, input.taskId, input.fingerprint);

  return Number(row?.count || 0);
}

function normalizeMaxSameFingerprintReruns(value) {
  if (value == null) {
    return DEFAULT_MAX_SAME_FINGERPRINT_RERUNS;
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error('maxSameFingerprintReruns must be a non-negative integer.');
  }

  return number;
}

function createRerunFingerprint(reason) {
  const normalizedReason = normalizeOptionalText(reason)?.toLowerCase() || 'rerun';
  return normalizedReason.replace(/\s+/g, ' ').slice(0, 160);
}
function getWorkflowStoreSchemaVersion(database) {
  const row = database.prepare('PRAGMA user_version').get();
  return Number(row?.user_version || 0);
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

function assertTaskStatus(status) {
  if (!TASK_STATUSES.has(status)) {
    throw new Error(`Unsupported task status: ${status}`);
  }
}

function assertWorkflowStatus(status) {
  if (!WORKFLOW_STATUSES.has(status)) {
    throw new Error(`Unsupported workflow status: ${status}`);
  }
}

const VALID_STATUS_TRANSITIONS = {
  pending: ['ready', 'skipped'],
  ready: ['doing', 'blocked', 'skipped'],
  doing: ['ready', 'blocked', 'done'],
  blocked: ['ready'],
  done: ['ready'],
  skipped: ['ready']
};

function assertValidStatusTransition(fromStatus, toStatus) {
  if (fromStatus === toStatus) {
    return;
  }
  const allowed = VALID_STATUS_TRANSITIONS[fromStatus];
  if (!allowed || !allowed.includes(toStatus)) {
    throw new Error(`Invalid status transition from "${fromStatus}" to "${toStatus}". Allowed from "${fromStatus}": ${allowed?.join(', ') || 'none'}.`);
  }
}

function normalizeLeaseOwner(value) {
  const leaseOwner = normalizeOptionalText(value);
  if (!leaseOwner) {
    throw new Error('Lease owner is required.');
  }

  return leaseOwner;
}

function normalizeAssignmentStatus(value) {
  const assignmentStatus = normalizeOptionalText(value) || 'unassigned';
  if (!ASSIGNMENT_STATUSES.has(assignmentStatus)) {
    throw new Error(`Unsupported assignment status: ${assignmentStatus}`);
  }

  return assignmentStatus;
}

function normalizeOptionalStringArray(value) {
  if (value == null) {
    return null;
  }

  if (!Array.isArray(value)) {
    throw new Error('Expected a string array.');
  }

  const normalized = value
    .map((item) => normalizeOptionalText(item))
    .filter(Boolean);

  return normalized.length > 0 ? normalized : [];
}

function normalizeTaskRecovery(value) {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Task recovery must be an object when provided.');
  }

  return buildFailureRecoveryMetadata(value);
}

function normalizeTaskContract(value) {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Task contract must be an object when provided.');
  }

  const contract = {
    successCriteria: normalizeOptionalStringArray(value.successCriteria) || [],
    requiredArtifacts: normalizeOptionalStringArray(value.requiredArtifacts) || [],
    forbiddenActions: normalizeOptionalStringArray(value.forbiddenActions) || [],
    assumptionsPolicy: normalizeTaskAssumptionsPolicy(value.assumptionsPolicy),
    validationCommands: normalizeValidationCommands(value.validationCommands),
    executionTimeoutMs: normalizeOptionalNumber(value.executionTimeoutMs),
    stalledTimeoutMs: normalizeOptionalNumber(value.stalledTimeoutMs),
    maxTimeoutAttempts: normalizeOptionalNumber(value.maxTimeoutAttempts),
    timeoutReason: normalizeOptionalText(value.timeoutReason)
  };

  return contract.successCriteria.length > 0
    || contract.requiredArtifacts.length > 0
    || contract.forbiddenActions.length > 0
    || contract.assumptionsPolicy
    || contract.validationCommands.length > 0
    || contract.executionTimeoutMs != null
    || contract.stalledTimeoutMs != null
    || contract.maxTimeoutAttempts != null
    || contract.timeoutReason
    ? contract
    : null;
}

function normalizeValidationCommands(value) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error('validationCommands must be an array when provided.');
  }

  return value.map((item) => normalizeValidationCommand(item));
}

function normalizeValidationCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Validation command must be an object when provided.');
  }

  const command = normalizeOptionalText(value.command);
  if (!command) {
    throw new Error('Validation command requires command.');
  }

  return {
    id: normalizeOptionalText(value.id),
    command,
    args: normalizeOptionalStringArray(value.args) || [],
    script: normalizeOptionalText(value.script),
    cwd: normalizeOptionalText(value.cwd),
    required: value.required !== false,
    timeoutMs: normalizeOptionalNumber(value.timeoutMs),
    reason: normalizeOptionalText(value.reason)
  };
}

function normalizeOptionalNumber(value) {
  if (value == null) {
    return null;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error('Expected a non-negative number.');
  }

  return Math.floor(number);
}

function normalizeTaskAssumptionsPolicy(value) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return null;
  }

  if (normalized !== 'block_on_missing_information' && normalized !== 'allow_reasonable_assumptions') {
    throw new Error(`Unsupported task assumptions policy: ${normalized}`);
  }

  return normalized;
}

function normalizeConcurrencyLimit(value) {
  if (value == null) {
    return 1;
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error('Workflow concurrencyLimit must be a positive integer.');
  }

  return number;
}

function normalizeListLimit(value, defaultValue) {
  if (value == null) {
    return defaultValue;
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error('List limit must be a positive integer.');
  }

  return number;
}

function normalizeLeaseMs(value) {
  if (value == null) {
    return DEFAULT_LEASE_MS;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error('Lease duration must be a positive number.');
  }

  return Math.floor(number);
}

function normalizeDependencyCondition(value) {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Dependency condition must be an object.');
  }

  const operator = normalizeOptionalText(value.operator) || 'exists';
  if (!['exists', 'equals', 'notEquals', 'includes'].includes(operator)) {
    throw new Error(`Unsupported dependency condition operator: ${operator}`);
  }

  const condition = {
    outputKind: normalizeOptionalText(value.outputKind),
    outputName: normalizeOptionalText(value.outputName),
    path: normalizeOptionalText(value.path),
    operator
  };

  if (operator !== 'exists') {
    condition.value = value.value;
  }

  return condition;
}

function normalizeTaskOutputMetadata(input = {}) {
  const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? { ...input.metadata }
    : {};
  const pathMetadata = normalizeTaskOutputPathMetadata(input.path, input.workspacePath ?? metadata.workspacePath);

  if (input.workflowId && metadata.workflowId == null) {
    metadata.workflowId = input.workflowId;
  }

  if (input.taskId && metadata.producedByTaskId == null) {
    metadata.producedByTaskId = input.taskId;
  }

  if (pathMetadata.workspacePath && metadata.workspacePath == null) {
    metadata.workspacePath = pathMetadata.workspacePath;
  }

  if (pathMetadata.relativePath && metadata.relativePath == null) {
    metadata.relativePath = pathMetadata.relativePath;
  }

  if (pathMetadata.pathEscapesWorkspace && metadata.pathEscapesWorkspace == null) {
    metadata.pathEscapesWorkspace = true;
  }

  metadata.trustState = normalizeTaskOutputTrustState({
    kind: input.kind,
    metadata,
    pathEscapesWorkspace: pathMetadata.pathEscapesWorkspace
  });

  return metadata;
}

function normalizeTaskOutputTrustState(input = {}) {
  if (input.pathEscapesWorkspace) {
    return 'tainted';
  }

  const explicit = normalizeOptionalText(input.metadata?.trustState);
  if (TASK_OUTPUT_TRUST_STATES.has(explicit)) {
    return explicit;
  }

  if (input.kind === 'validation-result') {
    return validationResultsPassed(input.metadata) ? 'validated' : 'failed';
  }

  return 'unverified';
}

function validationResultsPassed(metadata = {}) {
  if (metadata.status === 'passed' || metadata.status === 'validated') {
    return true;
  }

  if (metadata.status === 'failed' || metadata.status === 'blocked') {
    return false;
  }

  const results = Array.isArray(metadata.validationResults)
    ? metadata.validationResults
    : Array.isArray(metadata.results)
      ? metadata.results
      : [];

  return results.length > 0 && results.every((result) => {
    if (!result?.required) {
      return true;
    }
    return result.exitCode === 0 && !result.timedOut;
  });
}

function normalizeTaskOutputPathMetadata(outputPath, workspacePath) {
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  const normalizedOutputPath = normalizeOptionalText(outputPath);

  if (!normalizedWorkspacePath || !normalizedOutputPath) {
    return {
      workspacePath: normalizedWorkspacePath,
      relativePath: null,
      pathEscapesWorkspace: false
    };
  }

  if (!path.isAbsolute(normalizedOutputPath)) {
    return {
      workspacePath: normalizedWorkspacePath,
      relativePath: normalizeRelativePath(normalizedOutputPath),
      pathEscapesWorkspace: false
    };
  }

  const canonicalOutputPath = normalizeWorkspacePath(normalizedOutputPath);
  const relativePath = path.relative(normalizedWorkspacePath, canonicalOutputPath);
  const pathEscapesWorkspace = relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);

  return {
    workspacePath: normalizedWorkspacePath,
    relativePath: pathEscapesWorkspace ? null : normalizeRelativePath(relativePath),
    pathEscapesWorkspace
  };
}

function normalizeRelativePath(value) {
  return normalizeOptionalText(value)?.replace(/\\/g, '/') || null;
}

function parseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sanitizeAdvanceTaskPayloadForPersistence(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload ?? null;
  }

  const sanitizedAdapterPayload = sanitizeAdapterPayloadForPersistence(payload.adapterPayload ?? payload, { payload: payload.adapterPayload ?? payload });
  if (payload.adapterPayload) {
    return {
      ...payload,
      adapterPayload: sanitizedAdapterPayload
    };
  }

  return sanitizedAdapterPayload;
}

function stringifyJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function normalizeRequiredText(value, errorMessage) {
  const text = normalizeOptionalText(value);
  if (!text) {
    throw new Error(errorMessage);
  }

  return text;
}

function normalizeRequiredObject(value, errorMessage) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorMessage);
  }

  return value;
}

function normalizeOptionalObject(value, errorMessage) {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorMessage);
  }

  return value;
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function createTimestamp() {
  return new Date().toISOString();
}

function createPastTimestamp(durationMs, fromTimestamp = createTimestamp()) {
  const baseTime = new Date(fromTimestamp).getTime();
  return new Date(baseTime - durationMs).toISOString();
}

function createFutureTimestamp(durationMs, fromTimestamp = createTimestamp()) {
  const baseTime = new Date(fromTimestamp).getTime();
  return new Date(baseTime + durationMs).toISOString();
}
