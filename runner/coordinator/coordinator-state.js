import { shouldIncludeWorkflowForHygiene } from '../../storage/data-hygiene.js';
import {
  DEFAULT_LIST_LIMIT,
  getNextReadyStageCandidate,
  getNextReadyStandaloneTaskCandidate,
  normalizeOptionalText,
  resolveBlockedTarget
} from './shared.js';

const HYGIENE_OVERFETCH_MULTIPLIER = 5;
const HYGIENE_MAX_FETCH_LIMIT = 500;

export function createCoordinatorStateReader({ engine, agentStore, workflowStore, chainStore, routingPolicy }) {
  return {
    getCoordinatorState(input = {}) {
      return getCoordinatorState({ input, engine, agentStore, workflowStore, chainStore, routingPolicy });
    }
  };
}

function getCoordinatorState({ input, engine, agentStore, workflowStore, chainStore, routingPolicy }) {
  const agentQuery = input.agentQuery || {};
  const assignmentQuery = input.assignmentQuery || {};
  const handoffQuery = input.handoffQuery || {};
  const agents = agentStore.listAgents({
    status: agentQuery.status,
    role: agentQuery.role,
    limit: agentQuery.limit || DEFAULT_LIST_LIMIT
  }).map((agent) => ({
    ...agent,
    activeAssignmentCount: routingPolicy.getActiveAssignmentCount(agent.agentId)
  }));
  const rawAssignments = listCoordinatorItemsWithWorkflowHygiene({
    listItems: (query) => agentStore.listAssignments(query),
    query: assignmentQuery,
    input,
    workflowStore,
    defaultLimit: DEFAULT_LIST_LIMIT
  });
  const rawHandoffs = listCoordinatorItemsWithWorkflowHygiene({
    listItems: (query) => agentStore.listHandoffs(query),
    query: handoffQuery,
    input,
    workflowStore,
    defaultLimit: DEFAULT_LIST_LIMIT
  });
  const historyContext = createHistoryContext({ workflowStore, chainStore });
  const enrichedAssignments = rawAssignments.map((assignment) => enrichAssignmentHistory(assignment, historyContext));
  const enrichedHandoffs = rawHandoffs.map((handoff) => enrichHandoffHistory(handoff, historyContext));
  const includeHistory = input.includeHistory !== false;
  const assignments = includeHistory
    ? enrichedAssignments
    : enrichedAssignments.filter((assignment) => assignment.historyKind !== 'history');
  const handoffs = includeHistory
    ? enrichedHandoffs
    : enrichedHandoffs.filter((handoff) => handoff.historyKind !== 'history');
  const blockedTarget = resolveBlockedTarget({ input, workflowStore, chainStore });

  const state = {
    agents,
    assignments,
    handoffs,
    historySummary: buildHistorySummary(enrichedAssignments, enrichedHandoffs),
    nextStage: getNextReadyStageCandidate(chainStore, input),
    nextTask: getNextReadyStandaloneTaskCandidate(workflowStore, input),
    blockedTarget,
    recoveryTarget: isRecoverableBlockedTarget(blockedTarget) ? blockedTarget : null
  };

  const workflowId = normalizeOptionalText(input.workflowId);
  if (workflowId) {
    state.workflowState = engine.getWorkflowState({ workflowId });
  }

  const chainId = normalizeOptionalText(input.chainId);
  if (chainId) {
    state.chainState = chainStore.getChainState(chainId, input.chainQuery || {});
  }

  return state;
}

function listCoordinatorItemsWithWorkflowHygiene({ listItems, query, input, workflowStore, defaultLimit }) {
  const visibleLimit = normalizeListLimit(query?.limit, defaultLimit);
  const hygieneQuery = buildCoordinatorHygieneQuery(query, input);
  const fetched = listItems({
    ...hygieneQuery,
    limit: calculateHygieneFetchLimit(visibleLimit)
  });

  return filterItemsByWorkflowHygiene(workflowStore, input, fetched).slice(0, visibleLimit);
}

function buildCoordinatorHygieneQuery(query = {}, input = {}) {
  return {
    ...query,
    includeTestData: query.includeTestData ?? input.includeTestData ?? false,
    includeArchived: query.includeArchived ?? input.includeArchived,
    dataClass: query.dataClass ?? input.dataClass
  };
}

function calculateHygieneFetchLimit(limit) {
  return Math.min(Math.max(limit * HYGIENE_OVERFETCH_MULTIPLIER, limit), HYGIENE_MAX_FETCH_LIMIT);
}

function normalizeListLimit(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function filterItemsByWorkflowHygiene(workflowStore, input, items) {
  return items.filter((item) => {
    if (!item?.workflowId) {
      return true;
    }

    const workflow = workflowStore.getWorkflow(item.workflowId);
    return !workflow || shouldIncludeWorkflowForHygiene(workflow, input);
  });
}

function createHistoryContext({ workflowStore, chainStore }) {
  return {
    workflowStore,
    chainStore,
    workflows: new Map(),
    workflowTasks: new Map(),
    chainStates: new Map()
  };
}

function enrichAssignmentHistory(assignment, context) {
  const target = resolveAssignmentTarget(assignment, context);
  const classification = classifyAssignmentHistory(assignment, target);
  return {
    ...assignment,
    targetStatus: target?.status || null,
    targetWorkflowStatus: target?.workflowStatus || null,
    historyKind: classification.historyKind,
    historyReason: classification.historyReason
  };
}

function enrichHandoffHistory(handoff, context) {
  const target = resolveHandoffTarget(handoff, context);
  const classification = classifyHandoffHistory(handoff, target);
  return {
    ...handoff,
    targetStatus: target?.status || null,
    targetWorkflowStatus: target?.workflowStatus || null,
    historyKind: classification.historyKind,
    historyReason: classification.historyReason
  };
}

function classifyHandoffHistory(handoff, target) {
  if (handoff?.status !== 'open') {
    return { historyKind: 'history', historyReason: `handoff_${handoff?.status || 'closed'}` };
  }

  if (isTerminalTargetStatus(target?.status) || isTerminalTargetStatus(target?.workflowStatus)) {
    return { historyKind: 'history', historyReason: 'handoff_target_finished' };
  }

  return { historyKind: 'current', historyReason: 'handoff_open' };
}

function classifyAssignmentHistory(assignment, target) {
  if (assignment?.status === 'assigned' || assignment?.status === 'accepted') {
    return { historyKind: 'current', historyReason: 'active_assignment' };
  }

  if (assignment?.status === 'completed' || assignment?.status === 'released') {
    return { historyKind: 'history', historyReason: `assignment_${assignment.status}` };
  }

  if (assignment?.status === 'blocked') {
    if (isTerminalTargetStatus(target?.status) || isTerminalTargetStatus(target?.workflowStatus)) {
      return { historyKind: 'history', historyReason: 'blocked_target_finished' };
    }

    return { historyKind: 'current', historyReason: 'blocked_target_open' };
  }

  return { historyKind: 'current', historyReason: 'unknown_assignment_status' };
}

function resolveAssignmentTarget(assignment, context) {
  if (assignment?.targetType === 'task') {
    return resolveWorkflowTaskTarget(assignment.workflowId, assignment.targetId, context);
  }

  if (assignment?.targetType === 'stage') {
    return resolveChainStageTarget(assignment.chainId, assignment.targetId, context);
  }

  return resolveWorkflowTarget(assignment?.workflowId, context);
}

function resolveHandoffTarget(handoff, context) {
  if (handoff?.sourceType === 'task') {
    return resolveWorkflowTaskTarget(handoff.workflowId, handoff.sourceId, context);
  }

  if (handoff?.sourceType === 'stage') {
    return resolveChainStageTarget(handoff.chainId, handoff.sourceId, context);
  }

  return resolveWorkflowTarget(handoff?.workflowId, context);
}

function resolveWorkflowTaskTarget(workflowId, taskId, context) {
  const workflow = getCachedWorkflow(workflowId, context);
  const task = getCachedWorkflowTasks(workflowId, context).find((item) => item?.taskId === taskId) || null;
  return {
    status: task?.status || null,
    workflowStatus: workflow?.status || null
  };
}

function resolveWorkflowTarget(workflowId, context) {
  const workflow = getCachedWorkflow(workflowId, context);
  return {
    status: workflow?.status || null,
    workflowStatus: workflow?.status || null
  };
}

function resolveChainStageTarget(chainId, stageId, context) {
  const chainState = getCachedChainState(chainId, context);
  const stage = (chainState?.stages || []).find((item) => item?.stageId === stageId) || null;
  return {
    status: stage?.status || null,
    workflowStatus: chainState?.status || null
  };
}

function getCachedWorkflow(workflowId, context) {
  const normalizedWorkflowId = normalizeOptionalText(workflowId);
  if (!normalizedWorkflowId) {
    return null;
  }

  if (!context.workflows.has(normalizedWorkflowId)) {
    context.workflows.set(normalizedWorkflowId, context.workflowStore.getWorkflow(normalizedWorkflowId));
  }

  return context.workflows.get(normalizedWorkflowId);
}

function getCachedWorkflowTasks(workflowId, context) {
  const normalizedWorkflowId = normalizeOptionalText(workflowId);
  if (!normalizedWorkflowId) {
    return [];
  }

  if (!context.workflowTasks.has(normalizedWorkflowId)) {
    context.workflowTasks.set(normalizedWorkflowId, context.workflowStore.listWorkflowTasks(normalizedWorkflowId));
  }

  return context.workflowTasks.get(normalizedWorkflowId);
}

function getCachedChainState(chainId, context) {
  const normalizedChainId = normalizeOptionalText(chainId);
  if (!normalizedChainId) {
    return null;
  }

  if (!context.chainStates.has(normalizedChainId)) {
    context.chainStates.set(normalizedChainId, context.chainStore.getChainState(normalizedChainId, { includeRunLogs: false }));
  }

  return context.chainStates.get(normalizedChainId);
}

function isRecoverableBlockedTarget(target) {
  return getRecoveryStatus(target) !== null;
}

function getRecoveryStatus(target) {
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

function isTerminalTargetStatus(status) {
  return ['done', 'completed', 'cancelled', 'canceled', 'failed', 'skipped'].includes(normalizeOptionalText(status));
}

function buildHistorySummary(assignments, handoffs) {
  return {
    currentAssignmentCount: assignments.filter((assignment) => assignment?.historyKind !== 'history').length,
    historyAssignmentCount: assignments.filter((assignment) => assignment?.historyKind === 'history').length,
    currentHandoffCount: handoffs.filter((handoff) => handoff?.historyKind !== 'history').length,
    historyHandoffCount: handoffs.filter((handoff) => handoff?.historyKind === 'history').length
  };
}
