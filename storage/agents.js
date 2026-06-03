import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDb, resolveDbPath } from './db.js';
import { shouldIncludeWorkflowForHygiene } from './data-hygiene.js';

const AGENT_STATUSES = new Set(['active', 'inactive', 'archived']);
const ASSIGNMENT_STATUSES = new Set(['assigned', 'accepted', 'released', 'completed', 'blocked']);
const ACTIVE_ASSIGNMENT_STATUSES = ['assigned', 'accepted'];
const HANDOFF_STATUSES = new Set(['open', 'consumed', 'archived']);
const TARGET_TYPES = new Set(['task', 'stage']);
const SOURCE_TYPES = new Set(['task', 'stage']);
const AGENT_COLUMNS = `
  agent_id,
  name,
  role,
  capabilities_json,
  visibility_json,
  adapter_module,
  max_concurrency,
  status,
  created_at,
  updated_at
`;
const ASSIGNMENT_COLUMNS = `
  assignment_id,
  target_type,
  target_id,
  workflow_id,
  chain_id,
  stage_id,
  agent_id,
  status,
  reason,
  payload_json,
  created_at,
  updated_at
`;
const HANDOFF_COLUMNS = `
  handoff_id,
  from_agent_id,
  to_agent_id,
  source_type,
  source_id,
  workflow_id,
  chain_id,
  stage_id,
  summary,
  artifacts_json,
  artifact_refs_json,
  decisions_json,
  open_questions_json,
  risks_json,
  recommended_next_role,
  status,
  created_at,
  updated_at
`;
const HYGIENE_OVERFETCH_MULTIPLIER = 5;
const HYGIENE_MAX_FETCH_LIMIT = 500;

export async function initializeAgentStore(options = {}) {
  const dbPath = resolveDbPath(options);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  const database = getDb(dbPath);

  database.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      capabilities_json TEXT,
      visibility_json TEXT,
      adapter_module TEXT,
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_assignments (
      assignment_id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      workflow_id TEXT,
      chain_id TEXT,
      stage_id TEXT,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agents (agent_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_handoffs (
      handoff_id TEXT PRIMARY KEY,
      from_agent_id TEXT,
      to_agent_id TEXT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      workflow_id TEXT,
      chain_id TEXT,
      stage_id TEXT,
      summary TEXT NOT NULL,
      artifacts_json TEXT,
      artifact_refs_json TEXT,
      decisions_json TEXT,
      open_questions_json TEXT,
      risks_json TEXT,
      recommended_next_role TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (from_agent_id) REFERENCES agents (agent_id) ON DELETE SET NULL,
      FOREIGN KEY (to_agent_id) REFERENCES agents (agent_id) ON DELETE SET NULL
    )
  `);

  ensureColumn(database, 'agents', 'capabilities_json', 'TEXT');
  ensureColumn(database, 'agents', 'visibility_json', 'TEXT');
  ensureColumn(database, 'agents', 'adapter_module', 'TEXT');
  ensureColumn(database, 'agents', 'max_concurrency', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(database, 'agents', 'status', "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(database, 'agent_assignments', 'workflow_id', 'TEXT');
  ensureColumn(database, 'agent_assignments', 'chain_id', 'TEXT');
  ensureColumn(database, 'agent_assignments', 'stage_id', 'TEXT');
  ensureColumn(database, 'agent_assignments', 'reason', 'TEXT');
  ensureColumn(database, 'agent_assignments', 'payload_json', 'TEXT');
  ensureColumn(database, 'agent_handoffs', 'workflow_id', 'TEXT');
  ensureColumn(database, 'agent_handoffs', 'chain_id', 'TEXT');
  ensureColumn(database, 'agent_handoffs', 'stage_id', 'TEXT');
  ensureColumn(database, 'agent_handoffs', 'artifacts_json', 'TEXT');
  ensureColumn(database, 'agent_handoffs', 'artifact_refs_json', 'TEXT');
  ensureColumn(database, 'agent_handoffs', 'decisions_json', 'TEXT');
  ensureColumn(database, 'agent_handoffs', 'open_questions_json', 'TEXT');
  ensureColumn(database, 'agent_handoffs', 'risks_json', 'TEXT');
  ensureColumn(database, 'agent_handoffs', 'recommended_next_role', 'TEXT');
  ensureColumn(database, 'agent_handoffs', 'status', "TEXT NOT NULL DEFAULT 'open'");

  database.exec(`
    UPDATE agents
    SET status = 'active'
    WHERE status IS NULL
       OR TRIM(status) = ''
  `);

  database.exec(`
    UPDATE agent_handoffs
    SET status = 'open'
    WHERE status IS NULL
       OR TRIM(status) = ''
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_agents_role_status
    ON agents (role, status, updated_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_assignments_agent_status
    ON agent_assignments (agent_id, status, updated_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_assignments_target
    ON agent_assignments (target_type, target_id, created_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_handoffs_source
    ON agent_handoffs (source_type, source_id, created_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_handoffs_target
    ON agent_handoffs (to_agent_id, status, created_at)
  `);

  return database;
}

export function getAgentStore(options = {}) {
  const database = getDb(resolveDbPath(options));

  return {
    database,
    registerAgent(input) {
      return registerAgent(database, input);
    },
    getAgent(agentId) {
      return getAgent(database, agentId);
    },
    listAgents(query = {}) {
      return listAgents(database, query);
    },
    updateAgent(input) {
      return updateAgent(database, input);
    },
    createAssignment(input) {
      return createAssignment(database, input);
    },
    getAssignment(assignmentId) {
      return getAssignment(database, assignmentId);
    },
    getLatestActiveAssignmentForTarget(input = {}) {
      return getLatestActiveAssignmentForTarget(database, input);
    },
    getLatestAssignmentForTarget(input = {}) {
      return getLatestAssignmentForTarget(database, input);
    },
    listAssignments(query = {}) {
      return listAssignments(database, query);
    },
    updateAssignment(input) {
      return updateAssignment(database, input);
    },
    createHandoff(input) {
      return createHandoff(database, input);
    },
    getHandoff(handoffId) {
      return getHandoff(database, handoffId);
    },
    listHandoffs(query = {}) {
      return listHandoffs(database, query);
    },
    updateHandoff(input) {
      return updateHandoff(database, input);
    }
  };
}

function registerAgent(database, input = {}) {
  const agentId = input.agentId || crypto.randomUUID();
  const name = normalizeRequiredText(input.name, 'Agent name');
  const role = normalizeOptionalText(input.role) || '';
  const capabilities = normalizeOptionalStringArray(input.capabilities);
  const visibility = normalizeOptionalObject(input.visibility, 'Agent visibility');
  const adapterModule = normalizeOptionalText(input.adapterModule);
  const maxConcurrency = normalizePositiveInteger(input.maxConcurrency, 'Agent maxConcurrency') || 1;
  const status = normalizeAgentStatus(input.status || 'active');

  const insertAgent = database.transaction(() => {
    const now = createTimestamp();

    database.prepare(`
      INSERT INTO agents (
        agent_id,
        name,
        role,
        capabilities_json,
        visibility_json,
        adapter_module,
        max_concurrency,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agentId,
      name,
      role,
      stringifyJson(capabilities),
      stringifyJson(visibility),
      adapterModule,
      maxConcurrency,
      status,
      now,
      now
    );

    return requireAgent(database, agentId);
  });

  return insertAgent();
}

function getAgent(database, agentId) {
  const row = database.prepare(`
    SELECT ${AGENT_COLUMNS}
    FROM agents
    WHERE agent_id = ?
    LIMIT 1
  `).get(agentId);

  return mapAgentRow(row);
}

function listAgents(database, query = {}) {
  const whereClauses = [];
  const params = [];
  const role = normalizeOptionalText(query.role);
  const status = query.status == null ? null : normalizeAgentStatus(query.status);
  const limit = normalizePositiveInteger(query.limit, 'Agent list limit') || 100;

  if (role) {
    whereClauses.push('role = ?');
    params.push(role);
  }

  if (status) {
    whereClauses.push('status = ?');
    params.push(status);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  return database.prepare(`
    SELECT ${AGENT_COLUMNS}
    FROM agents
    ${whereSql}
    ORDER BY updated_at DESC, created_at DESC, agent_id ASC
    LIMIT ?
  `).all(...params, limit).map(mapAgentRow);
}

function updateAgent(database, input = {}) {
  const agentId = normalizeRequiredText(input.agentId, 'Agent id');

  const applyUpdate = database.transaction(() => {
    const agent = requireAgent(database, agentId);
    const now = createTimestamp();
    const nextName = input.name !== undefined ? normalizeRequiredText(input.name, 'Agent name') : agent.name;
    const nextRole = input.role !== undefined ? (normalizeOptionalText(input.role) || '') : agent.role;
    const nextCapabilities = input.capabilities !== undefined ? normalizeOptionalStringArray(input.capabilities) : agent.capabilities;
    const nextVisibility = input.visibility !== undefined ? normalizeOptionalObject(input.visibility, 'Agent visibility') : agent.visibility;
    const nextAdapterModule = input.adapterModule !== undefined
      ? normalizeOptionalText(input.adapterModule)
      : agent.adapterModule;
    const nextMaxConcurrency = input.maxConcurrency !== undefined
      ? normalizePositiveInteger(input.maxConcurrency, 'Agent maxConcurrency')
      : agent.maxConcurrency;
    const nextStatus = input.status !== undefined
      ? normalizeAgentStatus(input.status)
      : agent.status;

    database.prepare(`
      UPDATE agents
      SET
        name = ?,
        role = ?,
        capabilities_json = ?,
        visibility_json = ?,
        adapter_module = ?,
        max_concurrency = ?,
        status = ?,
        updated_at = ?
      WHERE agent_id = ?
    `).run(
      nextName,
      nextRole,
      stringifyJson(nextCapabilities),
      stringifyJson(nextVisibility),
      nextAdapterModule,
      nextMaxConcurrency,
      nextStatus,
      now,
      agentId
    );

    return requireAgent(database, agentId);
  });

  return applyUpdate();
}

function createAssignment(database, input = {}) {
  const assignmentId = input.assignmentId || crypto.randomUUID();
  const targetType = normalizeTargetType(input.targetType, 'Assignment target type');
  const targetId = normalizeRequiredText(input.targetId, 'Assignment target id');
  const agent = requireAgent(database, normalizeRequiredText(input.agentId, 'Assignment agent id'));
  const status = normalizeAssignmentStatus(input.status || 'assigned');

  const insertAssignment = database.transaction(() => {
    const now = createTimestamp();

    if (input.workflowId) {
      const workflow = database.prepare(`
        SELECT workflow_id FROM workflows WHERE workflow_id = ?
      `).get(input.workflowId);
      if (!workflow) {
        throw new Error(`Workflow "${input.workflowId}" not found.`);
      }
    }

    if (input.chainId) {
      const chain = database.prepare(`
        SELECT chain_id FROM workflow_chains WHERE chain_id = ?
      `).get(input.chainId);
      if (!chain) {
        throw new Error(`Chain "${input.chainId}" not found.`);
      }
    }

    if (input.stageId) {
      const stage = database.prepare(`
        SELECT stage_id FROM workflow_chain_stages WHERE stage_id = ?
      `).get(input.stageId);
      if (!stage) {
        throw new Error(`Stage "${input.stageId}" not found.`);
      }
    }

    database.prepare(`
      INSERT INTO agent_assignments (
        assignment_id,
        target_type,
        target_id,
        workflow_id,
        chain_id,
        stage_id,
        agent_id,
        status,
        reason,
        payload_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      assignmentId,
      targetType,
      targetId,
      normalizeOptionalText(input.workflowId),
      normalizeOptionalText(input.chainId),
      normalizeOptionalText(input.stageId),
      agent.agentId,
      status,
      normalizeOptionalText(input.reason),
      stringifyJson(input.payload),
      now,
      now
    );

    return requireAssignment(database, assignmentId);
  });

  return insertAssignment();
}

function getAssignment(database, assignmentId) {
  const row = database.prepare(`
    SELECT ${ASSIGNMENT_COLUMNS}
    FROM agent_assignments
    WHERE assignment_id = ?
    LIMIT 1
  `).get(assignmentId);

  return mapAssignmentRow(row);
}

function getLatestActiveAssignmentForTarget(database, input = {}) {
  const targetType = normalizeTargetType(input.targetType, 'Assignment target type');
  const targetId = normalizeRequiredText(input.targetId, 'Assignment target id');

  const placeholders = ACTIVE_ASSIGNMENT_STATUSES.map(() => '?').join(', ');
  const row = database.prepare(`
    SELECT ${ASSIGNMENT_COLUMNS}
    FROM agent_assignments
    WHERE target_type = ?
      AND target_id = ?
      AND status IN (${placeholders})
    ORDER BY created_at DESC, assignment_id DESC
    LIMIT 1
  `).get(targetType, targetId, ...ACTIVE_ASSIGNMENT_STATUSES);

  return mapAssignmentRow(row);
}

function getLatestAssignmentForTarget(database, input = {}) {
  const targetType = normalizeTargetType(input.targetType, 'Assignment target type');
  const targetId = normalizeRequiredText(input.targetId, 'Assignment target id');
  const workflowId = normalizeOptionalText(input.workflowId);
  const chainId = normalizeOptionalText(input.chainId);
  const stageId = normalizeOptionalText(input.stageId);
  const whereClauses = [
    'target_type = ?',
    'target_id = ?'
  ];
  const params = [targetType, targetId];

  if (workflowId) {
    whereClauses.push('workflow_id = ?');
    params.push(workflowId);
  }

  if (chainId) {
    whereClauses.push('chain_id = ?');
    params.push(chainId);
  }

  if (stageId) {
    whereClauses.push('stage_id = ?');
    params.push(stageId);
  }

  const row = database.prepare(`
    SELECT ${ASSIGNMENT_COLUMNS}
    FROM agent_assignments
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY created_at DESC, assignment_id DESC
    LIMIT 1
  `).get(...params);

  return mapAssignmentRow(row);
}

function listAssignments(database, query = {}) {
  const whereClauses = [];
  const params = [];
  const targetType = query.targetType == null ? null : normalizeTargetType(query.targetType, 'Assignment target type');
  const targetId = normalizeOptionalText(query.targetId);
  const workflowId = normalizeOptionalText(query.workflowId);
  const chainId = normalizeOptionalText(query.chainId);
  const stageId = normalizeOptionalText(query.stageId);
  const agentId = normalizeOptionalText(query.agentId);
  const status = query.status == null ? null : normalizeAssignmentStatus(query.status);
  const limit = normalizePositiveInteger(query.limit, 'Assignment list limit') || 100;

  if (targetType) {
    whereClauses.push('target_type = ?');
    params.push(targetType);
  }

  if (targetId) {
    whereClauses.push('target_id = ?');
    params.push(targetId);
  }

  if (workflowId) {
    whereClauses.push('workflow_id = ?');
    params.push(workflowId);
  }

  if (chainId) {
    whereClauses.push('chain_id = ?');
    params.push(chainId);
  }

  if (stageId) {
    whereClauses.push('stage_id = ?');
    params.push(stageId);
  }

  if (agentId) {
    whereClauses.push('agent_id = ?');
    params.push(agentId);
  }

  if (status) {
    whereClauses.push('status = ?');
    params.push(status);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const useHygieneFilter = shouldUseWorkflowHygieneFilter(query);
  const sqlLimit = useHygieneFilter ? calculateHygieneFetchLimit(limit) : limit;
  const rows = database.prepare(`
    SELECT ${ASSIGNMENT_COLUMNS}
    FROM agent_assignments
    ${whereSql}
    ORDER BY created_at ASC, assignment_id ASC
    LIMIT ?
  `).all(...params, sqlLimit).map(mapAssignmentRow);

  if (!useHygieneFilter) {
    return rows;
  }

  return filterItemsByWorkflowHygiene(database, rows, query).slice(0, limit);
}

function updateAssignment(database, input = {}) {
  const assignmentId = normalizeRequiredText(input.assignmentId, 'Assignment id');

  const applyUpdate = database.transaction(() => {
    const assignment = requireAssignment(database, assignmentId);
    const now = createTimestamp();
    const nextStatus = input.status !== undefined
      ? normalizeAssignmentStatus(input.status)
      : assignment.status;
    const nextReason = input.reason !== undefined
      ? normalizeOptionalText(input.reason)
      : assignment.reason;
    const nextPayload = input.payload !== undefined
      ? input.payload
      : assignment.payload;
    const nextAgentId = input.agentId !== undefined
      ? requireAgent(database, normalizeRequiredText(input.agentId, 'Assignment agent id')).agentId
      : assignment.agentId;

    database.prepare(`
      UPDATE agent_assignments
      SET
        agent_id = ?,
        status = ?,
        reason = ?,
        payload_json = ?,
        updated_at = ?
      WHERE assignment_id = ?
    `).run(
      nextAgentId,
      nextStatus,
      nextReason,
      stringifyJson(nextPayload),
      now,
      assignmentId
    );

    return requireAssignment(database, assignmentId);
  });

  return applyUpdate();
}

function createHandoff(database, input = {}) {
  const handoffId = input.handoffId || crypto.randomUUID();
  const sourceType = normalizeSourceType(input.sourceType, 'Handoff source type');
  const sourceId = normalizeRequiredText(input.sourceId, 'Handoff source id');
  const summary = normalizeRequiredText(input.summary, 'Handoff summary');
  const fromAgentId = input.fromAgentId == null ? null : requireAgent(database, normalizeRequiredText(input.fromAgentId, 'Handoff from agent id')).agentId;
  const toAgentId = input.toAgentId == null ? null : requireAgent(database, normalizeRequiredText(input.toAgentId, 'Handoff to agent id')).agentId;
  const status = normalizeHandoffStatus(input.status || 'open');
  const artifactRefs = normalizeOptionalArtifactRefArray(input.artifactRefs);

  const insertHandoff = database.transaction(() => {
    const now = createTimestamp();

    database.prepare(`
      INSERT INTO agent_handoffs (
        handoff_id,
        from_agent_id,
        to_agent_id,
        source_type,
        source_id,
        workflow_id,
        chain_id,
        stage_id,
        summary,
        artifacts_json,
        artifact_refs_json,
        decisions_json,
        open_questions_json,
        risks_json,
        recommended_next_role,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      handoffId,
      fromAgentId,
      toAgentId,
      sourceType,
      sourceId,
      normalizeOptionalText(input.workflowId),
      normalizeOptionalText(input.chainId),
      normalizeOptionalText(input.stageId),
      summary,
      stringifyJson(normalizeOptionalStringArray(input.artifacts)),
      stringifyJson(artifactRefs),
      stringifyJson(normalizeOptionalStringArray(input.decisions)),
      stringifyJson(normalizeOptionalStringArray(input.openQuestions)),
      stringifyJson(normalizeOptionalStringArray(input.risks)),
      normalizeOptionalText(input.recommendedNextRole),
      status,
      now,
      now
    );

    return requireHandoff(database, handoffId);
  });

  return insertHandoff();
}

function getHandoff(database, handoffId) {
  const row = database.prepare(`
    SELECT ${HANDOFF_COLUMNS}
    FROM agent_handoffs
    WHERE handoff_id = ?
    LIMIT 1
  `).get(handoffId);

  return mapHandoffRow(row);
}

function listHandoffs(database, query = {}) {
  const whereClauses = [];
  const params = [];
  const sourceType = query.sourceType == null ? null : normalizeSourceType(query.sourceType, 'Handoff source type');
  const sourceId = normalizeOptionalText(query.sourceId);
  const workflowId = normalizeOptionalText(query.workflowId);
  const chainId = normalizeOptionalText(query.chainId);
  const stageId = normalizeOptionalText(query.stageId);
  const toAgentId = normalizeOptionalText(query.toAgentId);
  const fromAgentId = normalizeOptionalText(query.fromAgentId);
  const status = query.status == null ? null : normalizeHandoffStatus(query.status);
  const limit = normalizePositiveInteger(query.limit, 'Handoff list limit') || 100;

  if (sourceType) {
    whereClauses.push('source_type = ?');
    params.push(sourceType);
  }

  if (sourceId) {
    whereClauses.push('source_id = ?');
    params.push(sourceId);
  }

  if (workflowId) {
    whereClauses.push('workflow_id = ?');
    params.push(workflowId);
  }

  if (chainId) {
    whereClauses.push('chain_id = ?');
    params.push(chainId);
  }

  if (stageId) {
    whereClauses.push('stage_id = ?');
    params.push(stageId);
  }

  if (toAgentId) {
    whereClauses.push('to_agent_id = ?');
    params.push(toAgentId);
  }

  if (fromAgentId) {
    whereClauses.push('from_agent_id = ?');
    params.push(fromAgentId);
  }

  if (status) {
    whereClauses.push('status = ?');
    params.push(status);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const useHygieneFilter = shouldUseWorkflowHygieneFilter(query);
  const sqlLimit = useHygieneFilter ? calculateHygieneFetchLimit(limit) : limit;
  const rows = database.prepare(`
    SELECT ${HANDOFF_COLUMNS}
    FROM agent_handoffs
    ${whereSql}
    ORDER BY created_at ASC, handoff_id ASC
    LIMIT ?
  `).all(...params, sqlLimit).map(mapHandoffRow);

  if (!useHygieneFilter) {
    return rows;
  }

  return filterItemsByWorkflowHygiene(database, rows, query).slice(0, limit);
}

function updateHandoff(database, input = {}) {
  const handoffId = normalizeRequiredText(input.handoffId, 'Handoff id');

  const applyUpdate = database.transaction(() => {
    const handoff = requireHandoff(database, handoffId);
    const now = createTimestamp();
    const nextToAgentId = input.toAgentId !== undefined
      ? (input.toAgentId == null ? null : requireAgent(database, normalizeRequiredText(input.toAgentId, 'Handoff to agent id')).agentId)
      : handoff.toAgentId;
    const nextStatus = input.status !== undefined
      ? normalizeHandoffStatus(input.status)
      : handoff.status;
    const nextSummary = input.summary !== undefined
      ? normalizeRequiredText(input.summary, 'Handoff summary')
      : handoff.summary;
    const nextArtifacts = input.artifacts !== undefined
      ? normalizeOptionalStringArray(input.artifacts)
      : handoff.artifacts;
    const nextArtifactRefs = input.artifactRefs !== undefined
      ? normalizeOptionalArtifactRefArray(input.artifactRefs)
      : handoff.artifactRefs;
    const nextDecisions = input.decisions !== undefined
      ? normalizeOptionalStringArray(input.decisions)
      : handoff.decisions;
    const nextOpenQuestions = input.openQuestions !== undefined
      ? normalizeOptionalStringArray(input.openQuestions)
      : handoff.openQuestions;
    const nextRisks = input.risks !== undefined
      ? normalizeOptionalStringArray(input.risks)
      : handoff.risks;
    const nextRecommendedNextRole = input.recommendedNextRole !== undefined
      ? normalizeOptionalText(input.recommendedNextRole)
      : handoff.recommendedNextRole;

    database.prepare(`
      UPDATE agent_handoffs
      SET
        to_agent_id = ?,
        summary = ?,
        artifacts_json = ?,
        artifact_refs_json = ?,
        decisions_json = ?,
        open_questions_json = ?,
        risks_json = ?,
        recommended_next_role = ?,
        status = ?,
        updated_at = ?
      WHERE handoff_id = ?
    `).run(
      nextToAgentId,
      nextSummary,
      stringifyJson(nextArtifacts),
      stringifyJson(nextArtifactRefs),
      stringifyJson(nextDecisions),
      stringifyJson(nextOpenQuestions),
      stringifyJson(nextRisks),
      nextRecommendedNextRole,
      nextStatus,
      now,
      handoffId
    );

    return requireHandoff(database, handoffId);
  });

  return applyUpdate();
}

function requireAgent(database, agentId) {
  const agent = getAgent(database, agentId);
  if (!agent) {
    throw new Error('Agent not found.');
  }

  return agent;
}

function requireAssignment(database, assignmentId) {
  const assignment = getAssignment(database, assignmentId);
  if (!assignment) {
    throw new Error('Assignment not found.');
  }

  return assignment;
}

function requireHandoff(database, handoffId) {
  const handoff = getHandoff(database, handoffId);
  if (!handoff) {
    throw new Error('Handoff not found.');
  }

  return handoff;
}

function mapAgentRow(row) {
  if (!row) {
    return null;
  }

  return {
    agentId: row.agent_id,
    name: row.name,
    role: normalizeOptionalText(row.role),
    capabilities: parseJson(row.capabilities_json) || [],
    visibility: parseJson(row.visibility_json),
    adapterModule: row.adapter_module,
    maxConcurrency: Number.isInteger(row.max_concurrency) ? row.max_concurrency : Number(row.max_concurrency || 1),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapAssignmentRow(row) {
  if (!row) {
    return null;
  }

  return {
    assignmentId: row.assignment_id,
    targetType: row.target_type,
    targetId: row.target_id,
    workflowId: row.workflow_id,
    chainId: row.chain_id,
    stageId: row.stage_id,
    agentId: row.agent_id,
    status: row.status,
    reason: row.reason,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapHandoffRow(row) {
  if (!row) {
    return null;
  }

  const artifactRefs = parseJson(row.artifact_refs_json);

  return {
    handoffId: row.handoff_id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    workflowId: row.workflow_id,
    chainId: row.chain_id,
    stageId: row.stage_id,
    summary: row.summary,
    artifacts: parseJson(row.artifacts_json) || [],
    artifactRefs: Array.isArray(artifactRefs) ? artifactRefs : [],
    decisions: parseJson(row.decisions_json) || [],
    openQuestions: parseJson(row.open_questions_json) || [],
    risks: parseJson(row.risks_json) || [],
    recommendedNextRole: row.recommended_next_role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function hasColumn(database, tableName, columnName) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some((column) => column.name === columnName);
}

function shouldUseWorkflowHygieneFilter(query = {}) {
  return query.includeTestData === false
    || query.includeTestData === true
    || query.includeArchived === false
    || query.includeArchived === true
    || Boolean(normalizeOptionalText(query.dataClass));
}

function calculateHygieneFetchLimit(limit) {
  return Math.min(Math.max(limit * HYGIENE_OVERFETCH_MULTIPLIER, limit), HYGIENE_MAX_FETCH_LIMIT);
}

function filterItemsByWorkflowHygiene(database, items, query) {
  const workflows = new Map();
  return items.filter((item) => {
    if (!item?.workflowId) {
      return true;
    }

    if (!workflows.has(item.workflowId)) {
      workflows.set(item.workflowId, getWorkflowForHygiene(database, item.workflowId));
    }

    const workflow = workflows.get(item.workflowId);
    return !workflow || shouldIncludeWorkflowForHygiene(workflow, query);
  });
}

function getWorkflowForHygiene(database, workflowId) {
  const row = database.prepare(`
    SELECT workflow_id, goal, instruction, initial_plan_json, status, current_task_id, concurrency_limit, created_at, updated_at
    FROM workflows
    WHERE workflow_id = ?
    LIMIT 1
  `).get(workflowId);

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
    concurrencyLimit: Number.isInteger(row.concurrency_limit) ? row.concurrency_limit : Number(row.concurrency_limit || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function ensureColumn(database, tableName, columnName, columnDefinition) {
  if (!hasColumn(database, tableName, columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
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

function stringifyJson(value) {
  return value == null ? null : JSON.stringify(value);
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

function normalizePositiveInteger(value, label) {
  if (value == null) {
    return null;
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return number;
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

function normalizeOptionalArtifactRefArray(value) {
  if (value == null) {
    return null;
  }

  if (!Array.isArray(value)) {
    throw new Error('Expected an artifact ref array.');
  }

  const normalized = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const text = normalizeOptionalText(item);
      if (text) {
        normalized.push(text);
      }
      continue;
    }

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Artifact refs must be strings or objects.');
    }

    const artifactRef = normalizeOptionalText(item.artifactRef);
    const outputId = normalizeOptionalText(item.outputId);
    const name = normalizeOptionalText(item.name);
    const kind = normalizeOptionalText(item.kind);
    const path = normalizeOptionalText(item.path);
    const storageStatus = normalizeOptionalText(item.storageStatus);
    const relativePath = normalizeOptionalText(item.relativePath);
    const workspacePath = normalizeOptionalText(item.workspacePath);

    if (!artifactRef && !outputId && !path) {
      throw new Error('Artifact ref objects must include artifactRef, outputId, or path.');
    }

    normalized.push({
      artifactRef,
      outputId,
      name,
      kind,
      path,
      storageStatus,
      relativePath,
      workspacePath
    });
  }

  return normalized;
}

function normalizeOptionalObject(value, label) {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

function normalizeAgentStatus(value) {
  const status = normalizeRequiredText(value, 'Agent status');
  if (!AGENT_STATUSES.has(status)) {
    throw new Error(`Unsupported agent status: ${status}`);
  }

  return status;
}

function normalizeAssignmentStatus(value) {
  const status = normalizeRequiredText(value, 'Assignment status');
  if (!ASSIGNMENT_STATUSES.has(status)) {
    throw new Error(`Unsupported assignment status: ${status}`);
  }

  return status;
}

function normalizeHandoffStatus(value) {
  const status = normalizeRequiredText(value, 'Handoff status');
  if (!HANDOFF_STATUSES.has(status)) {
    throw new Error(`Unsupported handoff status: ${status}`);
  }

  return status;
}

function normalizeTargetType(value, label) {
  const type = normalizeRequiredText(value, label);
  if (!TARGET_TYPES.has(type)) {
    throw new Error(`Unsupported target type: ${type}`);
  }

  return type;
}

function normalizeSourceType(value, label) {
  const type = normalizeRequiredText(value, label);
  if (!SOURCE_TYPES.has(type)) {
    throw new Error(`Unsupported source type: ${type}`);
  }

  return type;
}

function createTimestamp() {
  return new Date().toISOString();
}
