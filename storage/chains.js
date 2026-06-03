import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDb, resolveDbPath } from './db.js';

const STAGE_STATUSES = new Set(['pending', 'ready', 'doing', 'blocked', 'done']);
const ASSIGNMENT_STATUSES = new Set(['unassigned', 'assigned', 'accepted', 'released']);
const CHAIN_COLUMNS = 'chain_id, instruction, status, current_stage_id, created_at, updated_at';
const STAGE_COLUMNS = `
  stage_id,
  chain_id,
  title,
  instruction,
  goal,
  plan_json,
  sequence_no,
  status,
  workflow_id,
  blocked_reason,
  done_summary,
  owner_agent_id,
  preferred_role,
  required_capabilities_json,
  assignment_status,
  assignment_reason,
  handoff_json,
  created_at,
  updated_at
`;
const RUN_LOG_COLUMNS = 'log_id, chain_id, stage_id, action, message, payload_json, created_at';
const CHAIN_RERUN_COLUMNS = `
  rerun_id,
  chain_id,
  origin_stage_id,
  origin_workflow_id,
  origin_task_id,
  reason,
  fingerprint,
  operator,
  payload_json,
  affected_stage_count,
  affected_stage_ids_json,
  created_at
`;
const STAGE_REVISION_COLUMNS = `
  revision_id,
  chain_id,
  stage_id,
  rerun_id,
  previous_status,
  previous_workflow_id,
  previous_done_summary,
  previous_blocked_reason,
  previous_handoff_json,
  snapshot_json,
  created_at
`;
const DEFAULT_MAX_SAME_FINGERPRINT_RERUNS = 2;
const DEFAULT_AUDIT_LIMIT = 100;

export async function initializeChainStore(options = {}) {
  const dbPath = resolveDbPath(options);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  const database = getDb(dbPath);

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_chains (
      chain_id TEXT PRIMARY KEY,
      instruction TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      current_stage_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_chain_stages (
      stage_id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL,
      title TEXT NOT NULL,
      instruction TEXT NOT NULL,
      goal TEXT,
      plan_json TEXT,
      sequence_no INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      workflow_id TEXT,
      blocked_reason TEXT,
      done_summary TEXT,
      owner_agent_id TEXT,
      preferred_role TEXT,
      required_capabilities_json TEXT,
      assignment_status TEXT NOT NULL DEFAULT 'unassigned',
      assignment_reason TEXT,
      handoff_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (chain_id, sequence_no),
      FOREIGN KEY (chain_id) REFERENCES workflow_chains (chain_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_chain_reruns (
      rerun_id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL,
      origin_stage_id TEXT NOT NULL,
      origin_workflow_id TEXT,
      origin_task_id TEXT,
      reason TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      operator TEXT,
      payload_json TEXT,
      affected_stage_count INTEGER NOT NULL DEFAULT 0,
      affected_stage_ids_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (chain_id) REFERENCES workflow_chains (chain_id) ON DELETE CASCADE,
      FOREIGN KEY (origin_stage_id) REFERENCES workflow_chain_stages (stage_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_chain_stage_revisions (
      revision_id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      rerun_id TEXT NOT NULL,
      previous_status TEXT,
      previous_workflow_id TEXT,
      previous_done_summary TEXT,
      previous_blocked_reason TEXT,
      previous_handoff_json TEXT,
      snapshot_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (chain_id) REFERENCES workflow_chains (chain_id) ON DELETE CASCADE,
      FOREIGN KEY (stage_id) REFERENCES workflow_chain_stages (stage_id) ON DELETE CASCADE,
      FOREIGN KEY (rerun_id) REFERENCES workflow_chain_reruns (rerun_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_chain_run_logs (
      log_id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL,
      stage_id TEXT,
      action TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (chain_id) REFERENCES workflow_chains (chain_id) ON DELETE CASCADE,
      FOREIGN KEY (stage_id) REFERENCES workflow_chain_stages (stage_id) ON DELETE CASCADE
    )
  `);

  ensureColumn(database, 'workflow_chain_reruns', 'origin_workflow_id', 'TEXT');
  ensureColumn(database, 'workflow_chain_reruns', 'origin_task_id', 'TEXT');
  ensureColumn(database, 'workflow_chain_reruns', 'payload_json', 'TEXT');
  ensureColumn(database, 'workflow_chain_reruns', 'affected_stage_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'workflow_chain_reruns', 'affected_stage_ids_json', 'TEXT');
  ensureColumn(database, 'workflow_chain_stage_revisions', 'previous_workflow_id', 'TEXT');
  ensureColumn(database, 'workflow_chain_stage_revisions', 'previous_handoff_json', 'TEXT');
  ensureColumn(database, 'workflow_chain_stage_revisions', 'snapshot_json', 'TEXT');

  ensureColumn(database, 'workflow_chain_stages', 'goal', 'TEXT');
  ensureColumn(database, 'workflow_chain_stages', 'plan_json', 'TEXT');
  ensureColumn(database, 'workflow_chain_stages', 'workflow_id', 'TEXT');
  ensureColumn(database, 'workflow_chain_stages', 'blocked_reason', 'TEXT');
  ensureColumn(database, 'workflow_chain_stages', 'done_summary', 'TEXT');
  ensureColumn(database, 'workflow_chain_stages', 'owner_agent_id', 'TEXT');
  ensureColumn(database, 'workflow_chain_stages', 'preferred_role', 'TEXT');
  ensureColumn(database, 'workflow_chain_stages', 'required_capabilities_json', 'TEXT');
  ensureColumn(database, 'workflow_chain_stages', 'assignment_status', "TEXT NOT NULL DEFAULT 'unassigned'");
  ensureColumn(database, 'workflow_chain_stages', 'assignment_reason', 'TEXT');
  ensureColumn(database, 'workflow_chain_stages', 'handoff_json', 'TEXT');
  ensureColumn(database, 'workflow_chain_stages', 'started_at', 'TEXT');
  ensureColumn(database, 'workflow_chain_stages', 'completed_at', 'TEXT');
  ensureColumn(database, 'workflow_chain_stages', 'lease_owner', 'TEXT');
  ensureColumn(database, 'workflow_chain_stages', 'lease_expires_at', 'TEXT');
  ensureColumn(database, 'workflow_chain_stages', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'workflow_chain_stages', 'last_error', 'TEXT');
  ensureColumn(database, 'workflow_chain_run_logs', 'stage_id', 'TEXT');
  ensureColumn(database, 'workflow_chain_run_logs', 'payload_json', 'TEXT');

  database.exec(`
    UPDATE workflow_chain_stages
    SET assignment_status = 'unassigned'
    WHERE assignment_status IS NULL
       OR TRIM(assignment_status) = ''
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_chains_status
    ON workflow_chains (status, updated_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_chain_stages_chain_sequence
    ON workflow_chain_stages (chain_id, sequence_no, created_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_chain_stages_chain_status
    ON workflow_chain_stages (chain_id, status, sequence_no)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_chain_stages_assignment
    ON workflow_chain_stages (assignment_status, owner_agent_id, preferred_role, chain_id)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_chain_run_logs_chain_created
    ON workflow_chain_run_logs (chain_id, created_at)
  `);

  return database;
}

export function getChainStore(options = {}) {
  const database = getDb(resolveDbPath(options));

  return {
    database,
    createChain(input) {
      return createChain(database, input);
    },
    getChain(chainId) {
      return getChain(database, chainId);
    },
    getChainStage(chainId, stageId) {
      return getChainStage(database, chainId, stageId);
    },
    listChainStages(chainId) {
      return listChainStages(database, chainId);
    },
    listChainRunLogs(chainId, query = {}) {
      return listChainRunLogs(database, chainId, query);
    },
    listChainReruns(chainId, query = {}) {
      return listChainReruns(database, chainId, query);
    },
    listStageRevisions(input = {}) {
      return listStageRevisions(database, input);
    },
    addChainRunLog(input) {
      return addChainRunLog(database, input);
    },
    advanceChainStage(input) {
      return advanceChainStage(database, input);
    },
    restartChainFromStage(input) {
      return restartChainFromStage(database, input);
    },
    getNextStage(chainId) {
      return getNextStage(database, chainId);
    },
    getChainState(chainId, query = {}) {
      return getChainState(database, chainId, query);
    },
    refreshChain(chainId) {
      return refreshChainStateSync(database, chainId);
    }
  };
}

function listChainReruns(database, chainId, query = {}) {
  requireChain(database, chainId);
  const limit = Number.isInteger(query.limit) && query.limit > 0 ? query.limit : DEFAULT_AUDIT_LIMIT;

  return database.prepare(`
    SELECT ${CHAIN_RERUN_COLUMNS}
    FROM workflow_chain_reruns
    WHERE chain_id = ?
    ORDER BY created_at DESC, rerun_id DESC
    LIMIT ?
  `).all(chainId, limit).map(mapChainRerunRow);
}

function listStageRevisions(database, input = {}) {
  const chain = requireChain(database, input.chainId);
  const stageId = normalizeOptionalText(input.stageId);
  const rerunId = normalizeOptionalText(input.rerunId);
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : DEFAULT_AUDIT_LIMIT;
  const whereClauses = ['chain_id = ?'];
  const params = [chain.chainId];

  if (stageId) {
    requireStage(database, chain.chainId, stageId);
    whereClauses.push('stage_id = ?');
    params.push(stageId);
  }

  if (rerunId) {
    whereClauses.push('rerun_id = ?');
    params.push(rerunId);
  }

  params.push(limit);

  return database.prepare(`
    SELECT ${STAGE_REVISION_COLUMNS}
    FROM workflow_chain_stage_revisions
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY created_at DESC, revision_id DESC
    LIMIT ?
  `).all(...params).map(mapStageRevisionRow);
}

function restartChainFromStage(database, input = {}) {
  const chain = requireChain(database, input.chainId);
  const originStageId = String(input.stageId || '').trim();
  const reason = normalizeOptionalText(input.reason);
  const operator = normalizeOptionalText(input.operator);
  const payload = input.payload ?? null;
  const originTaskId = normalizeOptionalText(input.originTaskId);
  const maxSameFingerprintReruns = normalizeMaxSameFingerprintReruns(input.maxSameFingerprintReruns);

  if (!originStageId) {
    throw new Error('Stage id is required.');
  }

  if (!reason) {
    throw new Error('Rerun reason is required.');
  }

  const restart = database.transaction(() => {
    const originStage = requireStage(database, chain.chainId, originStageId);
    if (originStage.status === 'doing') {
      throw new Error('Cannot restart a stage that is currently doing.');
    }

    ensureStageReadyForExecution(database, chain.chainId, originStage.stageId);

    const fingerprint = normalizeOptionalText(input.fingerprint) || createRerunFingerprint(reason);
    const existingCount = countMatchingChainReruns(database, {
      chainId: chain.chainId,
      stageId: originStage.stageId,
      fingerprint
    });

    if (existingCount >= maxSameFingerprintReruns) {
      throw new Error(`Rerun budget exceeded for fingerprint "${fingerprint}".`);
    }

    const descendantStageIds = listDescendantStageIdsSync(database, chain.chainId, originStage.stageId);
    const affectedStageIds = [originStage.stageId, ...descendantStageIds];
    const affectedStages = affectedStageIds.map((stageId) => requireStage(database, chain.chainId, stageId));
    const now = createTimestamp();
    const rerunId = crypto.randomUUID();

    insertChainRerunSync(database, {
      rerunId,
      chainId: chain.chainId,
      originStageId: originStage.stageId,
      originWorkflowId: originStage.workflowId,
      originTaskId,
      reason,
      fingerprint,
      operator,
      payload,
      affectedStageIds,
      createdAt: now
    });

    for (const stage of affectedStages) {
      insertStageRevisionSync(database, {
        revisionId: crypto.randomUUID(),
        chainId: chain.chainId,
        stageId: stage.stageId,
        rerunId,
        stage,
        createdAt: now
      });
    }

    database.prepare(`
      UPDATE workflow_chain_stages
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
        last_error = NULL,
        updated_at = ?
      WHERE chain_id = ?
        AND stage_id = ?
    `).run(now, chain.chainId, originStage.stageId);

    if (descendantStageIds.length > 0) {
      const placeholders = descendantStageIds.map(() => '?').join(', ');
      database.prepare(`
        UPDATE workflow_chain_stages
        SET
          status = 'pending',
          workflow_id = NULL,
          blocked_reason = NULL,
          done_summary = NULL,
          handoff_json = NULL,
          started_at = NULL,
          completed_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          attempt_count = 0,
          last_error = NULL,
          updated_at = ?
        WHERE chain_id = ?
          AND stage_id IN (${placeholders})
      `).run(now, chain.chainId, ...descendantStageIds);
    }

    insertChainRunLogSync(database, {
      chainId: chain.chainId,
      stageId: originStage.stageId,
      action: 'chain_stage_rerun_requested',
      message: `Restarted chain from stage "${originStage.title}".`,
      payload: {
        rerunId,
        reason,
        fingerprint,
        operator,
        payload,
        originTaskId,
        affectedStageIds,
        descendantStageIds,
        previousStatus: originStage.status,
        workflowId: originStage.workflowId
      },
      createdAt: now
    });

    for (const stage of affectedStages) {
      if (stage.stageId === originStage.stageId) {
        continue;
      }

      insertChainRunLogSync(database, {
        chainId: chain.chainId,
        stageId: stage.stageId,
        action: 'chain_stage_invalidated_by_rerun',
        message: `Invalidated stage "${stage.title}" because an upstream stage will rerun.`,
        payload: {
          rerunId,
          originStageId: originStage.stageId,
          originStageTitle: originStage.title,
          reason,
          fingerprint,
          previousStatus: stage.status,
          previousWorkflowId: stage.workflowId
        },
        createdAt: now
      });
    }

    insertChainRunLogSync(database, {
      chainId: chain.chainId,
      action: 'chain_rerun_created',
      message: `Created rerun from origin stage "${originStage.title}" affecting ${affectedStageIds.length} stages.`,
      payload: {
        rerunId,
        originStageId: originStage.stageId,
        originTaskId,
        fingerprint,
        reason,
        operator,
        payload,
        affectedStageIds
      },
      createdAt: now
    });

    const state = refreshChainStateSync(database, chain.chainId, now);
    return {
      rerun: requireChainRerun(database, rerunId),
      chain: state.chain,
      stage: requireStage(database, chain.chainId, originStage.stageId),
      descendants: descendantStageIds.map((stageId) => requireStage(database, chain.chainId, stageId)),
      nextStage: state.nextStage,
      state: getChainStateSync(database, chain.chainId)
    };
  });

  return restart();
}

function createChain(database, input = {}) {
  const chainId = input.chainId || crypto.randomUUID();
  const instruction = String(input.instruction || '').trim();
  const stages = Array.isArray(input.stages) ? input.stages : [];

  if (!instruction) {
    throw new Error('Chain instruction is required.');
  }

  if (stages.length === 0) {
    throw new Error('At least one chain stage is required.');
  }

  const seenStageIds = new Set();
  for (let index = 0; index < stages.length; index += 1) {
    const stageId = stages[index]?.stageId;
    if (stageId) {
      if (seenStageIds.has(stageId)) {
        throw new Error(`Duplicate stageId "${stageId}" at index ${index}.`);
      }
      seenStageIds.add(stageId);
    }
  }

  const insertChain = database.transaction(() => {
    const now = createTimestamp();

    database.prepare(`
      INSERT INTO workflow_chains (
        chain_id,
        instruction,
        status,
        current_stage_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(chainId, instruction, 'draft', null, now, now);

    for (let index = 0; index < stages.length; index += 1) {
      const stageInput = stages[index] || {};
      const stageId = stageInput.stageId || crypto.randomUUID();
      const title = String(stageInput.title || '').trim();
      const stageInstruction = String(stageInput.instruction || '').trim();

      if (!title) {
        throw new Error(`Stage title is required at index ${index}.`);
      }

      if (!stageInstruction) {
        throw new Error(`Stage instruction is required at index ${index}.`);
      }

      database.prepare(`
        INSERT INTO workflow_chain_stages (
          stage_id,
          chain_id,
          title,
          instruction,
          goal,
          plan_json,
          sequence_no,
          status,
          workflow_id,
          blocked_reason,
          done_summary,
          owner_agent_id,
          preferred_role,
          required_capabilities_json,
          assignment_status,
          assignment_reason,
          handoff_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        stageId,
        chainId,
        title,
        stageInstruction,
        normalizeOptionalText(stageInput.goal),
        stringifyJson(stageInput.plan),
        index,
        index === 0 ? 'ready' : 'pending',
        null,
        null,
        null,
        normalizeOptionalText(stageInput.ownerAgentId),
        normalizeOptionalText(stageInput.preferredRole),
        stringifyJson(normalizeOptionalStringArray(stageInput.requiredCapabilities)),
        normalizeAssignmentStatus(stageInput.assignmentStatus || 'unassigned'),
        normalizeOptionalText(stageInput.assignmentReason),
        stringifyJson(stageInput.handoff),
        now,
        now
      );
    }

    insertChainRunLogSync(database, {
      chainId,
      action: 'chain_created',
      message: 'Created workflow chain.',
      payload: {
        stageCount: stages.length
      },
      createdAt: now
    });

    return refreshChainStateSync(database, chainId, now);
  });

  return insertChain();
}

function getChain(database, chainId) {
  const row = database.prepare(`
    SELECT ${CHAIN_COLUMNS}
    FROM workflow_chains
    WHERE chain_id = ?
    LIMIT 1
  `).get(chainId);

  return mapChainRow(row);
}

function getChainStage(database, chainId, stageId) {
  requireChain(database, chainId);

  const row = database.prepare(`
    SELECT ${STAGE_COLUMNS}
    FROM workflow_chain_stages
    WHERE chain_id = ?
      AND stage_id = ?
    LIMIT 1
  `).get(chainId, stageId);

  return mapStageRow(row);
}

function listChainStages(database, chainId) {
  return database.prepare(`
    SELECT ${STAGE_COLUMNS}
    FROM workflow_chain_stages
    WHERE chain_id = ?
    ORDER BY sequence_no ASC, created_at ASC, stage_id ASC
  `).all(chainId).map(mapStageRow);
}

function listChainRunLogs(database, chainId, query = {}) {
  const limit = Number.isInteger(query.limit) && query.limit > 0 ? query.limit : 100;

  return database.prepare(`
    SELECT ${RUN_LOG_COLUMNS}
    FROM workflow_chain_run_logs
    WHERE chain_id = ?
    ORDER BY created_at ASC, log_id ASC
    LIMIT ?
  `).all(chainId, limit).map(mapRunLogRow);
}

function addChainRunLog(database, input = {}) {
  const chain = requireChain(database, input.chainId);
  const stageId = normalizeOptionalText(input.stageId);
  const action = String(input.action || '').trim();
  const message = String(input.message || '').trim();

  if (!action) {
    throw new Error('Chain run log action is required.');
  }

  if (!message) {
    throw new Error('Chain run log message is required.');
  }

  if (stageId) {
    requireStage(database, chain.chainId, stageId);
  }

  return insertChainRunLogSync(database, {
    chainId: chain.chainId,
    stageId,
    action,
    message,
    payload: input.payload,
    createdAt: input.createdAt
  });
}

function advanceChainStage(database, input = {}) {
  const chain = requireChain(database, input.chainId);
  const stageId = String(input.stageId || '').trim();
  const nextStatus = String(input.status || '').trim();

  if (!stageId) {
    throw new Error('Stage id is required.');
  }

  assertStageStatus(nextStatus);

  const applyStatusChange = database.transaction(() => {
    const stage = requireStage(database, chain.chainId, stageId);
    const now = createTimestamp();

    if (nextStatus === 'ready' || nextStatus === 'doing' || nextStatus === 'done') {
      ensureStageReadyForExecution(database, chain.chainId, stage.stageId);
    }

    if (nextStatus === 'doing') {
      ensureNoOtherDoingStage(database, chain.chainId, stage.stageId);
    }

    const nextWorkflowId = input.workflowId !== undefined
      ? normalizeOptionalText(input.workflowId)
      : stage.workflowId;
    const nextBlockedReason = nextStatus === 'blocked'
      ? normalizeOptionalText(input.blockedReason) || stage.blockedReason || 'Stage is blocked by an unresolved dependency or constraint.'
      : null;
    const nextDoneSummary = nextStatus === 'done'
      ? normalizeOptionalText(input.doneSummary) || stage.doneSummary || null
      : null;
    const nextOwnerAgentId = input.ownerAgentId !== undefined
      ? normalizeOptionalText(input.ownerAgentId)
      : stage.ownerAgentId;
    const nextPreferredRole = input.preferredRole !== undefined
      ? normalizeOptionalText(input.preferredRole)
      : stage.preferredRole;
    const nextRequiredCapabilities = input.requiredCapabilities !== undefined
      ? normalizeOptionalStringArray(input.requiredCapabilities)
      : stage.requiredCapabilities;
    const nextAssignmentStatus = input.assignmentStatus !== undefined
      ? normalizeAssignmentStatus(input.assignmentStatus)
      : stage.assignmentStatus;
    const nextAssignmentReason = input.assignmentReason !== undefined
      ? normalizeOptionalText(input.assignmentReason)
      : stage.assignmentReason;
    const nextHandoff = input.handoff !== undefined
      ? input.handoff
      : stage.handoff;

    database.prepare(`
      UPDATE workflow_chain_stages
      SET
        status = ?,
        workflow_id = ?,
        blocked_reason = ?,
        done_summary = ?,
        owner_agent_id = ?,
        preferred_role = ?,
        required_capabilities_json = ?,
        assignment_status = ?,
        assignment_reason = ?,
        handoff_json = ?,
        updated_at = ?
      WHERE stage_id = ?
        AND chain_id = ?
    `).run(
      nextStatus,
      nextWorkflowId,
      nextBlockedReason,
      nextDoneSummary,
      nextOwnerAgentId,
      nextPreferredRole,
      stringifyJson(nextRequiredCapabilities),
      nextAssignmentStatus,
      nextAssignmentReason,
      stringifyJson(nextHandoff),
      now,
      stage.stageId,
      chain.chainId
    );

    insertChainRunLogSync(database, {
      chainId: chain.chainId,
      stageId: stage.stageId,
      action: input.action || 'chain_stage_status_changed',
      message: input.message || `Stage "${stage.title}" moved to ${nextStatus}.`,
      payload: input.payload || {
        previousStatus: stage.status,
        nextStatus,
        workflowId: nextWorkflowId,
        blockedReason: nextBlockedReason,
        doneSummary: nextDoneSummary,
        ownerAgentId: nextOwnerAgentId,
        preferredRole: nextPreferredRole,
        requiredCapabilities: nextRequiredCapabilities,
        assignmentStatus: nextAssignmentStatus,
        assignmentReason: nextAssignmentReason,
        handoff: nextHandoff
      },
      createdAt: now
    });

    const state = refreshChainStateSync(database, chain.chainId, now);
    return {
      stage: requireStage(database, chain.chainId, stage.stageId),
      chain: state.chain,
      nextStage: state.nextStage
    };
  });

  return applyStatusChange();
}

function getNextStage(database, chainId) {
  requireChain(database, chainId);
  return getNextStageSync(database, chainId);
}

function getChainState(database, chainId, query = {}) {
  return getChainStateSync(database, chainId, query);
}

function getChainStateSync(database, chainId, query = {}) {
  const chain = requireChain(database, chainId);
  const stages = listChainStages(database, chainId);
  const nextStage = getNextStageSync(database, chainId);
  const state = {
    chain,
    stages,
    nextStage
  };

  if (query.includeRunLogs !== false) {
    state.runLogs = listChainRunLogs(database, chainId, query);
  }

  return state;
}

function refreshChainStateSync(database, chainId, timestamp = createTimestamp()) {
  requireChain(database, chainId);
  ensureNoMultipleDoingStages(database, chainId);
  syncPendingAndReadyStages(database, chainId, timestamp);
  ensureNoMultipleDoingStages(database, chainId);
  ensureNoMultipleReadyStages(database, chainId);

  const summary = database.prepare(`
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_count,
      SUM(CASE WHEN status = 'doing' THEN 1 ELSE 0 END) AS doing_count,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_count,
      SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked_count
    FROM workflow_chain_stages
    WHERE chain_id = ?
  `).get(chainId);

  const totalCount = summary.total_count || 0;
  const doneCount = summary.done_count || 0;
  const doingCount = summary.doing_count || 0;
  const readyCount = summary.ready_count || 0;
  const blockedCount = summary.blocked_count || 0;

  let nextChainStatus = 'draft';
  if (totalCount === 0) {
    nextChainStatus = 'draft';
  } else if (doneCount === totalCount) {
    nextChainStatus = 'done';
  } else if (doingCount > 0) {
    nextChainStatus = 'doing';
  } else if (readyCount > 0) {
    nextChainStatus = 'ready';
  } else if (blockedCount > 0) {
    nextChainStatus = 'blocked';
  } else {
    nextChainStatus = 'draft';
  }

  const nextStage = getNextStageSync(database, chainId);
  database.prepare(`
    UPDATE workflow_chains
    SET status = ?, current_stage_id = ?, updated_at = ?
    WHERE chain_id = ?
  `).run(nextChainStatus, nextStage?.stageId || null, timestamp, chainId);

  return getChainStateSync(database, chainId, { includeRunLogs: false });
}

function syncPendingAndReadyStages(database, chainId, timestamp) {
  database.transaction(() => {
    database.prepare(`
      UPDATE workflow_chain_stages
      SET status = 'ready', updated_at = ?
      WHERE chain_id = ?
        AND status = 'pending'
        AND NOT EXISTS (
          SELECT 1
          FROM workflow_chain_stages predecessor
          WHERE predecessor.chain_id = workflow_chain_stages.chain_id
            AND predecessor.sequence_no < workflow_chain_stages.sequence_no
            AND predecessor.status != 'done'
        )
    `).run(timestamp, chainId);

    database.prepare(`
      UPDATE workflow_chain_stages
      SET status = 'pending', updated_at = ?
      WHERE chain_id = ?
        AND status = 'ready'
        AND EXISTS (
          SELECT 1
          FROM workflow_chain_stages predecessor
          WHERE predecessor.chain_id = workflow_chain_stages.chain_id
            AND predecessor.sequence_no < workflow_chain_stages.sequence_no
            AND predecessor.status != 'done'
        )
    `).run(timestamp, chainId);
  })();
}

function ensureStageReadyForExecution(database, chainId, stageId) {
  requireStage(database, chainId, stageId);

  const blockedStage = database.prepare(`
    SELECT predecessor.stage_id
    FROM workflow_chain_stages stage
    JOIN workflow_chain_stages predecessor
      ON predecessor.chain_id = stage.chain_id
     AND predecessor.sequence_no < stage.sequence_no
    WHERE stage.chain_id = ?
      AND stage.stage_id = ?
      AND predecessor.status != 'done'
    LIMIT 1
  `).get(chainId, stageId);

  if (blockedStage) {
    throw new Error('Stage still has unfinished predecessors.');
  }
}

function ensureNoOtherDoingStage(database, chainId, stageId) {
  const row = database.prepare(`
    SELECT stage_id
    FROM workflow_chain_stages
    WHERE chain_id = ?
      AND status = 'doing'
      AND stage_id != ?
    LIMIT 1
  `).get(chainId, stageId);

  if (row) {
    throw new Error('Only one stage can be doing in the same chain.');
  }
}

function ensureNoMultipleDoingStages(database, chainId) {
  const row = database.prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_chain_stages
    WHERE chain_id = ?
      AND status = 'doing'
  `).get(chainId);

  if ((row?.count || 0) > 1) {
    throw new Error('Chain has multiple doing stages.');
  }
}

function ensureNoMultipleReadyStages(database, chainId) {
  const row = database.prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_chain_stages
    WHERE chain_id = ?
      AND status = 'ready'
  `).get(chainId);

  if ((row?.count || 0) > 1) {
    throw new Error('Chain has multiple ready stages.');
  }
}

function getNextStageSync(database, chainId) {
  const row = database.prepare(`
    SELECT ${STAGE_COLUMNS}
    FROM workflow_chain_stages
    WHERE chain_id = ?
      AND status IN ('doing', 'ready', 'blocked')
    ORDER BY CASE status
      WHEN 'doing' THEN 0
      WHEN 'ready' THEN 1
      ELSE 2
    END, sequence_no ASC, created_at ASC, stage_id ASC
    LIMIT 1
  `).get(chainId);

  return mapStageRow(row);
}

function requireChain(database, chainId) {
  const chain = getChain(database, chainId);
  if (!chain) {
    throw new Error('Chain not found.');
  }

  return chain;
}

function requireStage(database, chainId, stageId) {
  const stage = getChainStage(database, chainId, stageId);
  if (!stage) {
    throw new Error('Chain stage not found.');
  }

  return stage;
}

function insertChainRunLogSync(database, input = {}) {
  const logId = input.logId || crypto.randomUUID();

  database.prepare(`
    INSERT INTO workflow_chain_run_logs (
      log_id,
      chain_id,
      stage_id,
      action,
      message,
      payload_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    logId,
    input.chainId,
    input.stageId || null,
    input.action,
    input.message,
    stringifyJson(input.payload),
    input.createdAt || createTimestamp()
  );

  const row = database.prepare(`
    SELECT ${RUN_LOG_COLUMNS}
    FROM workflow_chain_run_logs
    WHERE log_id = ?
    LIMIT 1
  `).get(logId);

  return mapRunLogRow(row);
}

function mapChainRerunRow(row) {
  if (!row) {
    return null;
  }

  return {
    rerunId: row.rerun_id,
    chainId: row.chain_id,
    originStageId: row.origin_stage_id,
    originWorkflowId: row.origin_workflow_id,
    originTaskId: row.origin_task_id,
    reason: row.reason,
    fingerprint: row.fingerprint,
    operator: row.operator,
    payload: parseJson(row.payload_json),
    affectedStageCount: Number.isInteger(row.affected_stage_count) ? row.affected_stage_count : Number(row.affected_stage_count || 0),
    affectedStageIds: parseJson(row.affected_stage_ids_json) || [],
    createdAt: row.created_at
  };
}

function mapStageRevisionRow(row) {
  if (!row) {
    return null;
  }

  return {
    revisionId: row.revision_id,
    chainId: row.chain_id,
    stageId: row.stage_id,
    rerunId: row.rerun_id,
    previousStatus: row.previous_status,
    previousWorkflowId: row.previous_workflow_id,
    previousDoneSummary: row.previous_done_summary,
    previousBlockedReason: row.previous_blocked_reason,
    previousHandoff: parseJson(row.previous_handoff_json),
    snapshot: parseJson(row.snapshot_json),
    createdAt: row.created_at
  };
}

function requireChainRerun(database, rerunId) {
  const row = database.prepare(`
    SELECT ${CHAIN_RERUN_COLUMNS}
    FROM workflow_chain_reruns
    WHERE rerun_id = ?
    LIMIT 1
  `).get(rerunId);

  const rerun = mapChainRerunRow(row);
  if (!rerun) {
    throw new Error('Chain rerun not found.');
  }

  return rerun;
}

function listDescendantStageIdsSync(database, chainId, originStageId) {
  const originStage = requireStage(database, chainId, originStageId);
  return database.prepare(`
    SELECT stage_id
    FROM workflow_chain_stages
    WHERE chain_id = ?
      AND sequence_no > ?
    ORDER BY sequence_no ASC, created_at ASC, stage_id ASC
  `).all(chainId, originStage.sequence).map((row) => row.stage_id);
}

function insertChainRerunSync(database, input = {}) {
  database.prepare(`
    INSERT INTO workflow_chain_reruns (
      rerun_id,
      chain_id,
      origin_stage_id,
      origin_workflow_id,
      origin_task_id,
      reason,
      fingerprint,
      operator,
      payload_json,
      affected_stage_count,
      affected_stage_ids_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.rerunId,
    input.chainId,
    input.originStageId,
    input.originWorkflowId || null,
    input.originTaskId || null,
    input.reason,
    input.fingerprint,
    input.operator || null,
    stringifyJson(input.payload),
    Array.isArray(input.affectedStageIds) ? input.affectedStageIds.length : 0,
    stringifyJson(input.affectedStageIds || []),
    input.createdAt || createTimestamp()
  );

  return requireChainRerun(database, input.rerunId);
}

function insertStageRevisionSync(database, input = {}) {
  const stage = input.stage;
  database.prepare(`
    INSERT INTO workflow_chain_stage_revisions (
      revision_id,
      chain_id,
      stage_id,
      rerun_id,
      previous_status,
      previous_workflow_id,
      previous_done_summary,
      previous_blocked_reason,
      previous_handoff_json,
      snapshot_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.revisionId,
    input.chainId,
    input.stageId,
    input.rerunId,
    stage.status,
    stage.workflowId,
    stage.doneSummary,
    stage.blockedReason,
    stringifyJson(stage.handoff),
    stringifyJson(stage),
    input.createdAt || createTimestamp()
  );
}

function countMatchingChainReruns(database, input = {}) {
  const row = database.prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_chain_reruns
    WHERE chain_id = ?
      AND origin_stage_id = ?
      AND fingerprint = ?
  `).get(input.chainId, input.stageId, input.fingerprint);

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

function mapChainRow(row) {
  if (!row) {
    return null;
  }

  return {
    chainId: row.chain_id,
    instruction: row.instruction,
    status: row.status,
    currentStageId: row.current_stage_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapStageRow(row) {
  if (!row) {
    return null;
  }

  return {
    stageId: row.stage_id,
    chainId: row.chain_id,
    title: row.title,
    instruction: row.instruction,
    goal: row.goal,
    plan: parseJson(row.plan_json),
    sequence: row.sequence_no,
    status: row.status,
    workflowId: row.workflow_id,
    blockedReason: row.blocked_reason,
    doneSummary: row.done_summary,
    ownerAgentId: row.owner_agent_id,
    preferredRole: row.preferred_role,
    requiredCapabilities: parseJson(row.required_capabilities_json) || [],
    assignmentStatus: row.assignment_status || 'unassigned',
    assignmentReason: row.assignment_reason,
    handoff: parseJson(row.handoff_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRunLogRow(row) {
  if (!row) {
    return null;
  }

  return {
    logId: row.log_id,
    chainId: row.chain_id,
    stageId: row.stage_id,
    action: row.action,
    message: row.message,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at
  };
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

function assertStageStatus(status) {
  if (!STAGE_STATUSES.has(status)) {
    throw new Error(`Unsupported chain stage status: ${status}`);
  }
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
