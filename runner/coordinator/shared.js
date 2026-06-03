import { isWorkflowVisibleByDefault } from '../../storage/data-hygiene.js';

const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_ASSIGNMENT_LIMIT = 1000;
const DEFAULT_MAX_WORKFLOW_STEPS = 100;
const ACTIVE_AGENT_STATUSES = new Set(['active']);
const ACTIVE_ASSIGNMENT_STATUSES = new Set(['assigned', 'accepted']);
const RELEASABLE_ASSIGNMENT_STATUSES = new Set(['assigned', 'accepted', 'blocked']);

export {
  DEFAULT_LIST_LIMIT,
  DEFAULT_ASSIGNMENT_LIMIT,
  DEFAULT_MAX_WORKFLOW_STEPS,
  ACTIVE_AGENT_STATUSES,
  ACTIVE_ASSIGNMENT_STATUSES,
  RELEASABLE_ASSIGNMENT_STATUSES
};

export function resolveCandidateForAssignment({ input, workflowStore, chainStore }) {
  const explicitTarget = normalizeOptionalText(input.targetType);
  if (explicitTarget === 'stage') {
    return loadSpecificStageCandidate(chainStore, input);
  }

  if (explicitTarget === 'task') {
    return loadSpecificTaskCandidate(workflowStore, input);
  }

  return getNextReadyStageCandidate(chainStore, input)
    || getNextReadyStandaloneTaskCandidate(workflowStore, input);
}

export function resolveBlockedTarget({ input, workflowStore, chainStore }) {
  const targetType = normalizeOptionalText(input.targetType);
  if (targetType === 'stage') {
    return enrichBlockedTargetRecovery(loadBlockedStageCandidate(chainStore, input), workflowStore, chainStore);
  }

  if (targetType === 'task') {
    return loadBlockedTaskCandidate(workflowStore, input);
  }

  return enrichBlockedTargetRecovery(loadBlockedStageCandidate(chainStore, input), workflowStore, chainStore)
    || loadBlockedTaskCandidate(workflowStore, input);
}

export function enrichBlockedTargetRecovery(target, workflowStore, chainStore) {
  if (!target || target.targetType !== 'stage') {
    return target;
  }

  const blockedTask = resolveBlockedStageTask(workflowStore, chainStore, target);
  if (!blockedTask) {
    return target;
  }

  return {
    ...target,
    taskId: target.taskId || blockedTask.taskId,
    attemptCount: blockedTask.attemptCount || 0,
    lastError: blockedTask.lastError || null,
    reasonCode: blockedTask.reasonCode || null,
    recovery: blockedTask.recovery || null,
    updatedAt: blockedTask.updatedAt || target.updatedAt || null,
    task: blockedTask
  };
}

export function getTransientRecoveryStatus(target) {
  const precomputed = target?.recoveryStatus && typeof target.recoveryStatus === 'object' && !Array.isArray(target.recoveryStatus)
    ? target.recoveryStatus
    : null;
  if (precomputed) {
    return precomputed;
  }

  const recovery = target?.recovery && typeof target.recovery === 'object' && !Array.isArray(target.recovery)
    ? target.recovery
    : null;
  if (!recovery || recovery.recoveryClass !== 'transient_upstream') {
    return null;
  }

  const nextEligibleRetryAt = normalizeOptionalText(recovery.nextEligibleRetryAt);
  if (!nextEligibleRetryAt) {
    return {
      phase: 'ready',
      recovery,
      nextEligibleRetryAt: null,
      waitMs: 0
    };
  }

  const nextEligibleAtMs = Date.parse(nextEligibleRetryAt);
  if (!Number.isFinite(nextEligibleAtMs)) {
    return {
      phase: 'ready',
      recovery,
      nextEligibleRetryAt,
      waitMs: 0
    };
  }

  const waitMs = Math.max(nextEligibleAtMs - Date.now(), 0);
  return {
    phase: waitMs > 0 ? 'cooldown' : 'ready',
    recovery,
    nextEligibleRetryAt,
    waitMs
  };
}

export function getNextReadyStageCandidate(chainStore, input = {}) {
  const chainId = normalizeOptionalText(input.chainId);
  const stageId = normalizeOptionalText(input.stageId);
  const whereClauses = [
    "stage.status = 'ready'",
    "stage.assignment_status IN ('unassigned', 'released')",
    'chain.current_stage_id = stage.stage_id'
  ];
  const params = [];

  if (chainId) {
    whereClauses.push('stage.chain_id = ?');
    params.push(chainId);
  }

  if (stageId) {
    whereClauses.push('stage.stage_id = ?');
    params.push(stageId);
  }

  const row = chainStore.database.prepare(`
    SELECT stage.chain_id, stage.stage_id
    FROM workflow_chain_stages stage
    JOIN workflow_chains chain ON chain.chain_id = stage.chain_id
    WHERE ${whereClauses.join('\n      AND ')}
    ORDER BY stage.created_at ASC, stage.sequence_no ASC, stage.stage_id ASC
    LIMIT 1
  `).get(...params);

  if (!row) {
    return null;
  }

  const chain = chainStore.getChain(row.chain_id);
  const stage = chainStore.getChainStage(row.chain_id, row.stage_id);
  return buildStageCandidate(chain, stage);
}

export function getNextReadyStandaloneTaskCandidate(workflowStore, input = {}) {
  const workflowId = normalizeOptionalText(input.workflowId);
  const taskId = normalizeOptionalText(input.taskId);
  const whereClauses = [
    "task.status = 'ready'",
    "task.assignment_status IN ('unassigned', 'released')",
    'workflow.current_task_id = task.task_id',
    `NOT EXISTS (
      SELECT 1
      FROM workflow_chain_stages stage
      WHERE stage.workflow_id = task.workflow_id
    )`
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

  const rows = workflowStore.database.prepare(`
    SELECT task.workflow_id, task.task_id
    FROM workflow_tasks task
    JOIN workflows workflow ON workflow.workflow_id = task.workflow_id
    WHERE ${whereClauses.join('\n      AND ')}
    ORDER BY task.created_at ASC, task.sequence_no ASC, task.task_id ASC
    LIMIT ?
  `).all(...params, workflowId || taskId ? 1 : 20);

  for (const row of rows) {
    const workflow = workflowStore.getWorkflow(row.workflow_id);
    if (!workflowId && !taskId && !isWorkflowVisibleByDefault(workflow)) {
      continue;
    }

    const task = workflowStore.listWorkflowTasks(row.workflow_id).find((item) => item.taskId === row.task_id);
    return buildTaskCandidate(task, workflow);
  }

  return null;
}

export function loadSpecificStageCandidate(chainStore, input = {}) {
  const chainId = normalizeRequiredText(input.chainId, 'Chain id');
  const stageId = normalizeRequiredText(input.stageId, 'Stage id');
  const chain = chainStore.getChain(chainId);
  const stage = chainStore.getChainStage(chainId, stageId);
  if (!stage) {
    throw new Error(`Stage not found: ${stageId}`);
  }
  if (stage.status !== 'ready') {
    throw new Error(`Stage ${stageId} is not ready.`);
  }
  return buildStageCandidate(chain, stage);
}

export function loadSpecificTaskCandidate(workflowStore, input = {}) {
  const workflowId = normalizeRequiredText(input.workflowId, 'Workflow id');
  const taskId = normalizeRequiredText(input.taskId, 'Task id');
  const workflow = workflowStore.getWorkflow(workflowId);
  const task = workflowStore.listWorkflowTasks(workflowId).find((item) => item.taskId === taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  if (task.status !== 'ready') {
    throw new Error(`Task ${taskId} is not ready.`);
  }
  return buildTaskCandidate(task, workflow);
}

export function loadBlockedStageCandidate(chainStore, input = {}) {
  const chainId = normalizeOptionalText(input.chainId);
  const stageId = normalizeOptionalText(input.stageId);
  const whereClauses = [
    "stage.status = 'blocked'",
    'chain.current_stage_id = stage.stage_id'
  ];
  const params = [];

  if (chainId) {
    whereClauses.push('stage.chain_id = ?');
    params.push(chainId);
  }

  if (stageId) {
    whereClauses.push('stage.stage_id = ?');
    params.push(stageId);
  }

  const row = chainStore.database.prepare(`
    SELECT stage.chain_id, stage.stage_id
    FROM workflow_chain_stages stage
    JOIN workflow_chains chain ON chain.chain_id = stage.chain_id
    WHERE ${whereClauses.join('\n      AND ')}
    ORDER BY stage.updated_at ASC, stage.sequence_no ASC, stage.stage_id ASC
    LIMIT 1
  `).get(...params);

  if (!row) {
    return null;
  }

  const chain = chainStore.getChain(row.chain_id);
  const stage = chainStore.getChainStage(row.chain_id, row.stage_id);
  return buildStageCandidate(chain, stage);
}

export function loadBlockedTaskCandidate(workflowStore, input = {}) {
  const workflowId = normalizeOptionalText(input.workflowId);
  const taskId = normalizeOptionalText(input.taskId);
  const whereClauses = [
    "task.status = 'blocked'",
    `NOT EXISTS (
      SELECT 1
      FROM workflow_chain_stages stage
      WHERE stage.workflow_id = task.workflow_id
    )`
  ];
  const params = [];

  if (workflowId) {
    whereClauses.push('task.workflow_id = ?');
    params.push(workflowId);
  }

  if (taskId) {
    whereClauses.push('task.task_id = ?');
    params.push(taskId);
  } else {
    whereClauses.push(`NOT EXISTS (
      SELECT 1
      FROM workflow_tasks downstream
      WHERE downstream.workflow_id = task.workflow_id
        AND downstream.sequence_no > task.sequence_no
        AND downstream.status != 'pending'
    )`);
  }

  const row = workflowStore.database.prepare(`
    SELECT task.workflow_id, task.task_id
    FROM workflow_tasks task
    WHERE ${whereClauses.join('\n      AND ')}
    ORDER BY task.updated_at ASC, task.sequence_no ASC, task.task_id ASC
    LIMIT 1
  `).get(...params);

  if (!row) {
    return null;
  }

  const workflow = workflowStore.getWorkflow(row.workflow_id);
  const task = workflowStore.listWorkflowTasks(row.workflow_id).find((item) => item.taskId === row.task_id);
  return buildTaskCandidate(task, workflow);
}

export function loadAssignmentTarget({ assignment, workflowStore, chainStore }) {
  if (assignment.targetType === 'stage') {
    const chain = chainStore.getChain(assignment.chainId);
    const stage = chainStore.getChainStage(assignment.chainId, assignment.targetId);
    return stage
      ? buildStageCandidate(chain, stage, { taskId: resolveStageAssignmentTaskId(assignment) })
      : null;
  }

  const workflow = workflowStore.getWorkflow(assignment.workflowId);
  const task = workflowStore.listWorkflowTasks(assignment.workflowId).find((item) => item.taskId === assignment.targetId);
  return task ? buildTaskCandidate(task, workflow) : null;
}

function resolveStageAssignmentTaskId(assignment) {
  const payload = assignment?.payload && typeof assignment.payload === 'object' && !Array.isArray(assignment.payload)
    ? assignment.payload
    : null;

  return normalizeOptionalText(payload?.taskId)
    || normalizeOptionalText(payload?.resumedTaskId)
    || null;
}

function resolveBlockedStageTask(workflowStore, chainStore, target) {
  const chainId = normalizeOptionalText(target?.chainId);
  const stageId = normalizeOptionalText(target?.stageId);
  if (!chainId || !stageId) {
    return null;
  }

  const chainState = chainStore.getChainState(chainId, { includeRunLogs: false });
  const stage = Array.isArray(chainState?.stages)
    ? chainState.stages.find((item) => item?.stageId === stageId)
    : null;
  const workflowId = normalizeOptionalText(stage?.workflowId || target?.workflowId);
  if (!workflowId) {
    return null;
  }

  const workflowState = workflowStore.getWorkflowState(workflowId);
  const tasks = Array.isArray(workflowState?.tasks) ? workflowState.tasks : [];
  const explicitTaskId = normalizeOptionalText(target?.taskId);
  if (explicitTaskId) {
    return tasks.find((item) => item?.taskId === explicitTaskId) || null;
  }

  return tasks.find((item) => item?.status === 'blocked') || null;
}

export function updateTargetAssignment({ candidate, ownerAgentId, assignmentStatus, assignmentReason, workflowStore, chainStore, action, message, payload = {} }) {
  if (candidate.targetType === 'stage') {
    chainStore.advanceChainStage({
      chainId: candidate.chainId,
      stageId: candidate.stageId,
      status: candidate.status,
      workflowId: candidate.workflowId,
      blockedReason: candidate.blockedReason,
      doneSummary: candidate.doneSummary,
      ownerAgentId,
      preferredRole: candidate.preferredRole,
      requiredCapabilities: candidate.requiredCapabilities,
      assignmentStatus,
      assignmentReason,
      handoff: candidate.handoff,
      action,
      message,
      payload
    });
    return;
  }

  workflowStore.advanceTaskStatus({
    workflowId: candidate.workflowId,
    taskId: candidate.taskId,
    status: candidate.status,
    blockedReason: candidate.blockedReason,
    doneSummary: candidate.doneSummary,
    ownerAgentId,
    preferredRole: candidate.preferredRole,
    requiredCapabilities: candidate.requiredCapabilities,
    assignmentStatus,
    assignmentReason,
    handoff: candidate.handoff,
    attemptCount: candidate.attemptCount,
    lastError: candidate.lastError,
    reasonCode: candidate.reasonCode,
    recovery: candidate.recovery,
    action,
    message,
    payload
  });
}

export function buildTaskCandidate(task, workflow = null) {
  if (!task) {
    return null;
  }

  return {
    targetType: 'task',
    targetId: task.taskId,
    taskId: task.taskId,
    workflowId: task.workflowId,
    chainId: null,
    stageId: null,
    title: task.title,
    status: task.status,
    blockedReason: task.blockedReason,
    doneSummary: task.doneSummary,
    ownerAgentId: task.ownerAgentId,
    preferredRole: task.preferredRole,
    requiredCapabilities: normalizeStringArray(task.requiredCapabilities),
    assignmentStatus: task.assignmentStatus,
    assignmentReason: task.assignmentReason,
    handoff: normalizeStructuredHandoff(task.handoff),
    attemptCount: task.attemptCount || 0,
    lastError: task.lastError || null,
    reasonCode: task.reasonCode || null,
    recovery: task.recovery || null,
    updatedAt: task.updatedAt || null,
    workflow: workflow || null,
    task
  };
}

export function buildStageCandidate(chain, stage, overrides = {}) {
  if (!stage) {
    return null;
  }

  const taskId = normalizeOptionalText(overrides.taskId);

  return {
    targetType: 'stage',
    targetId: stage.stageId,
    taskId,
    workflowId: stage.workflowId || null,
    chainId: stage.chainId,
    stageId: stage.stageId,
    title: stage.title,
    status: stage.status,
    blockedReason: stage.blockedReason,
    doneSummary: stage.doneSummary,
    ownerAgentId: stage.ownerAgentId,
    preferredRole: stage.preferredRole,
    requiredCapabilities: normalizeStringArray(stage.requiredCapabilities),
    assignmentStatus: stage.assignmentStatus,
    assignmentReason: stage.assignmentReason,
    handoff: normalizeStructuredHandoff(stage.handoff),
    chain: chain || null,
    stage
  };
}

export function getLatestAssignmentForTarget(agentStore, target) {
  const assignments = agentStore.listAssignments({
    targetType: target.targetType,
    targetId: target.targetId,
    limit: DEFAULT_ASSIGNMENT_LIMIT
  });

  return assignments.length > 0 ? assignments[assignments.length - 1] : null;
}

export function retargetOpenHandoffs({ agentStore, candidate, agentId }) {
  const handoffQuery = {
    status: 'open',
    limit: DEFAULT_LIST_LIMIT
  };

  if (candidate.targetType === 'stage') {
    handoffQuery.chainId = candidate.chainId;
    handoffQuery.stageId = candidate.stageId;
  } else {
    handoffQuery.workflowId = candidate.workflowId;
    handoffQuery.sourceType = 'task';
    handoffQuery.sourceId = candidate.taskId;
  }

  const handoffs = agentStore.listHandoffs(handoffQuery);

  for (const handoff of handoffs) {
    if (handoff.toAgentId && handoff.toAgentId !== agentId) {
      continue;
    }

    agentStore.updateHandoff({
      handoffId: handoff.handoffId,
      toAgentId: agentId
    });
  }
}

export function buildAssignmentReason(candidate, agent) {
  const requiredCapabilities = normalizeStringArray(candidate.requiredCapabilities);
  const capabilityText = requiredCapabilities.length > 0
    ? ` capabilities=${requiredCapabilities.join(', ')}`
    : '';
  const roleText = agent.role ? ` by role ${agent.role}` : ' by capabilities/runtime availability';
  return `Matched ${candidate.targetType} "${candidate.title}" to agent "${agent.agentId}"${roleText}.${capabilityText}`;
}

export function resolveRuntimeAdapter({ input, agent, runtimeAdapters, resolver }) {
  if (input?.adapter) {
    return input.adapter;
  }

  if (runtimeAdapters.has(agent.agentId)) {
    return runtimeAdapters.get(agent.agentId);
  }

  if (typeof resolver === 'function') {
    return resolver(agent);
  }

  return null;
}

export function normalizeRuntimeAdapters(value) {
  if (value instanceof Map) {
    return new Map(value);
  }

  if (!value || typeof value !== 'object') {
    return new Map();
  }

  return new Map(Object.entries(value));
}

export function normalizeResumeMode(value) {
  const mode = normalizeOptionalText(value) || 'auto';
  if (mode === 'auto' || mode === 'resume' || mode === 'reassign') {
    return mode;
  }

  throw new Error(`Unsupported resume mode: ${mode}`);
}

export function normalizePositiveInteger(value, fallback, label) {
  if (value == null) {
    return fallback;
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return number;
}

export function normalizeRequiredText(value, label) {
  const text = normalizeOptionalText(value);
  if (!text) {
    throw new Error(`${label} is required.`);
  }

  return text;
}

export function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

export function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeOptionalText(item))
    .filter(Boolean);
}

export function mergeStringArrays(...values) {
  const merged = [];
  const seen = new Set();

  for (const value of values) {
    for (const item of normalizeStringArray(value)) {
      if (seen.has(item)) {
        continue;
      }
      seen.add(item);
      merged.push(item);
    }
  }

  return merged;
}

export function normalizeStructuredHandoff(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const handoff = {
    summary: normalizeOptionalText(value.summary),
    artifacts: normalizeStringArray(value.artifacts),
    decisions: normalizeStringArray(value.decisions),
    openQuestions: normalizeStringArray(value.openQuestions),
    risks: normalizeStringArray(value.risks),
    recommendedNextRole: normalizeOptionalText(value.recommendedNextRole)
  };

  return handoff.summary
    || handoff.artifacts.length > 0
    || handoff.decisions.length > 0
    || handoff.openQuestions.length > 0
    || handoff.risks.length > 0
    || handoff.recommendedNextRole
    ? handoff
    : null;
}

export function structuredHandoffsEqual(left, right) {
  return JSON.stringify(normalizeStructuredHandoff(left)) === JSON.stringify(normalizeStructuredHandoff(right));
}
