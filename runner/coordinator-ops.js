import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeAgentStore, getAgentStore } from '../storage/agents.js';
import { resolveDbTarget } from '../storage/db.js';

export function buildCoordinatorStateView({ state, data = {}, nextAction, allowedNextCommands } = {}) {
  return {
    agents: Array.isArray(state?.agents) ? state.agents : [],
    assignments: Array.isArray(state?.assignments) ? state.assignments : [],
    handoffs: Array.isArray(state?.handoffs) ? state.handoffs : [],
    nextStage: state?.nextStage || null,
    nextTask: state?.nextTask || null,
    blockedTarget: state?.blockedTarget || null,
    recoveryTarget: state?.recoveryTarget || null,
    workflowState: state?.workflowState || null,
    chainState: state?.chainState || null,
    summary: buildCoordinatorSummary(state),
    nextAction: nextAction || inferNextActionFromCoordinatorState(state),
    allowedNextCommands: Array.isArray(allowedNextCommands)
      ? [...new Set(allowedNextCommands)]
      : getAllowedNextCommandsForCoordinatorState(state),
    ...data
  };
}

export function buildCoordinatorSummary(state) {
  const agents = Array.isArray(state?.agents) ? state.agents : [];
  const assignments = Array.isArray(state?.assignments) ? state.assignments : [];
  const handoffs = Array.isArray(state?.handoffs) ? state.handoffs : [];
  const agentCountsByStatus = countItemsByStatus(agents, ['active', 'inactive', 'archived']);
  const assignmentCountsByStatus = countItemsByStatus(assignments, ['assigned', 'accepted', 'released', 'completed', 'blocked']);
  const nextTarget = state?.nextStage || state?.nextTask || null;
  const recoveryStatus = getRecoveryStatus(state?.recoveryTarget || state?.blockedTarget || null);

  const historySummary = state?.historySummary || {};

  return {
    agentCount: agents.length,
    assignmentCount: assignments.length,
    handoffCount: handoffs.length,
    currentAssignmentCount: historySummary.currentAssignmentCount ?? assignments.filter((item) => item?.historyKind !== 'history').length,
    historyAssignmentCount: historySummary.historyAssignmentCount ?? assignments.filter((item) => item?.historyKind === 'history').length,
    currentHandoffCount: historySummary.currentHandoffCount ?? handoffs.filter((item) => item?.historyKind !== 'history').length,
    historyHandoffCount: historySummary.historyHandoffCount ?? handoffs.filter((item) => item?.historyKind === 'history').length,
    openHandoffCount: handoffs.filter((item) => item.status === 'open' && item?.historyKind !== 'history').length,
    agentCountsByStatus,
    assignmentCountsByStatus,
    nextTargetType: nextTarget?.targetType || null,
    nextTargetId: nextTarget?.targetId || null,
    nextTargetTitle: nextTarget?.title || null,
    recoveryPhase: recoveryStatus?.phase || null,
    recoveryWaitMs: recoveryStatus?.waitMs ?? null,
    recoveryNextEligibleRetryAt: recoveryStatus?.nextEligibleRetryAt || null,
    nextRecommendedCommand: inferNextActionFromCoordinatorState(state)
  };
}

export function getAllowedNextCommandsForCoordinatorState(state) {
  const nextTarget = state?.nextStage || state?.nextTask || null;
  const recoveryStatus = getRecoveryStatus(state?.recoveryTarget || state?.blockedTarget || null);

  if (recoveryStatus?.phase === 'cooldown') {
    return ['get-coordinator-state', 'resume-assigned-work', 'assign-next-work', 'run-next-assignment', 'register-agent'];
  }

  if (nextTarget?.status === 'blocked') {
    return ['get-coordinator-state', 'resume-assigned-work', 'assign-next-work', 'run-next-assignment', 'register-agent'];
  }

  if (nextTarget?.status === 'ready') {
    return ['get-coordinator-state', 'assign-next-work', 'run-next-assignment', 'register-agent'];
  }

  if ((state?.assignments || []).some((assignment) => assignment.status === 'blocked')) {
    return ['get-coordinator-state', 'resume-assigned-work', 'assign-next-work', 'run-next-assignment', 'register-agent'];
  }

  if ((state?.agents || []).length > 0) {
    return ['get-coordinator-state', 'assign-next-work', 'run-next-assignment', 'resume-assigned-work', 'register-agent'];
  }

  return ['register-agent', 'get-coordinator-state'];
}

export function getAllowedNextCommandsForCoordinatorResult(result, state) {
  if (result?.status === 'assigned') {
    return ['get-coordinator-state', 'assign-next-work', 'run-next-assignment', 'resume-assigned-work'];
  }

  if (result?.status === 'reassigned' || result?.status === 'resumed') {
    return ['get-coordinator-state', 'assign-next-work', 'run-next-assignment', 'resume-assigned-work'];
  }

  if (result?.status === 'cooldown') {
    return ['get-coordinator-state', 'resume-assigned-work', 'assign-next-work', 'run-next-assignment', 'register-agent'];
  }

  if (result?.status === 'blocked') {
    return ['get-coordinator-state', 'resume-assigned-work', 'assign-next-work', 'run-next-assignment', 'register-agent'];
  }

  if (result?.status === 'done') {
    return getAllowedNextCommandsForCoordinatorState(state);
  }

  if (result?.status === 'idle' && result?.reason === 'no_available_agent') {
    return ['register-agent', 'get-coordinator-state', 'assign-next-work', 'run-next-assignment'];
  }

  if (result?.status === 'idle' && result?.reason === 'no_ready_work') {
    return ['get-coordinator-state', 'assign-next-work', 'run-next-assignment', 'register-agent'];
  }

  if (result?.status === 'idle' && result?.reason === 'no_blocked_work') {
    return getAllowedNextCommandsForCoordinatorState(state);
  }

  return getAllowedNextCommandsForCoordinatorState(state);
}

export function inferNextActionFromCoordinatorState(state) {
  const nextTarget = state?.nextStage || state?.nextTask || null;
  const recoveryStatus = getRecoveryStatus(state?.recoveryTarget || state?.blockedTarget || null);

  if (recoveryStatus?.phase === 'cooldown') {
    return 'wait_for_recovery';
  }

  if (recoveryStatus?.phase === 'ready') {
    return 'resume_assigned_work';
  }

  if (nextTarget?.status === 'blocked' || (state?.assignments || []).some((assignment) => assignment.status === 'blocked')) {
    return 'resume_assigned_work';
  }

  if (nextTarget?.status === 'ready') {
    return 'assign_next_work';
  }

  if ((state?.agents || []).length === 0) {
    return 'register_agent';
  }

  return 'inspect_coordinator_state';
}

export function inferNextActionFromCoordinatorResult(result, state) {
  if (result?.status === 'assigned') {
    return 'assignment_prepared';
  }

  if (result?.status === 'reassigned') {
    return 'assignment_reassigned';
  }

  if (result?.status === 'resumed') {
    return 'resume_prepared';
  }

  if (result?.status === 'cooldown') {
    return 'wait_for_recovery';
  }

  if (result?.status === 'done') {
    return inferNextActionFromCoordinatorState(state);
  }

  if (result?.status === 'blocked') {
    const recoveryStatus = getRecoveryStatus(result?.target || state?.recoveryTarget || state?.blockedTarget || null);
    return recoveryStatus?.phase === 'cooldown' ? 'wait_for_recovery' : 'resume_assigned_work';
  }

  if (result?.status === 'idle' && result?.reason === 'no_blocked_work') {
    return inferNextActionFromCoordinatorState(state);
  }

  if (result?.status === 'idle' && result?.reason === 'no_available_agent') {
    return 'register_agent';
  }

  if (result?.status === 'idle' && result?.reason === 'no_ready_work') {
    return 'inspect_coordinator_state';
  }

  return inferNextActionFromCoordinatorState(state);
}

function getRecoveryStatus(target) {
  const recovery = target?.recovery && typeof target.recovery === 'object' && !Array.isArray(target.recovery)
    ? target.recovery
    : null;
  if (!recovery || recovery.recoveryClass !== 'transient_upstream') {
    return null;
  }

  const nextEligibleRetryAt = getOptionalText(recovery.nextEligibleRetryAt);
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

export function buildSharedRuntimeOptions(args = {}) {
  const requestedWorkspacePath = getOptionalText(args.workspacePath) || process.cwd();
  const dbTarget = resolveDbTarget({
    dbPath: getOptionalText(args.dbPath) || undefined,
    dbProfile: getOptionalText(args.dbProfile) || getOptionalText(args.profile) || undefined,
    workspacePath: requestedWorkspacePath
  });
  const baseOptions = buildRuntimeDbMetadata(dbTarget);

  return {
    ...baseOptions,
    context: {
      ...baseOptions
    },
    memory: {
      ...baseOptions
    }
  };
}

function buildRuntimeDbMetadata(dbTarget) {
  return {
    dbPath: dbTarget.dbPath,
    dbPathSource: dbTarget.dbPathSource,
    dbScopeLabel: dbTarget.dbScopeLabel,
    dbProfile: dbTarget.dbProfile,
    workspacePath: dbTarget.workspacePath,
    workspaceKey: dbTarget.workspaceKey
  };
}

export async function buildCoordinatorRuntimeOptions(args = {}, runtimeOptions = buildSharedRuntimeOptions(args)) {
  const options = {
    ...runtimeOptions,
    context: runtimeOptions.context ? { ...runtimeOptions.context } : runtimeOptions.context,
    memory: runtimeOptions.memory ? { ...runtimeOptions.memory } : runtimeOptions.memory
  };
  applyRunnerTimeoutRuntimeOptions(args, options);
  const { dbPath } = options;
  const commandAdapterModule = getOptionalText(args.adapterModule);
  const requestedAgentId = getOptionalText(args.agentId);
  const adapterCache = new Map();

  async function resolveModuleAdapter(modulePath) {
    const normalizedPath = getOptionalText(modulePath);
    if (!normalizedPath) {
      return null;
    }

    if (!adapterCache.has(normalizedPath)) {
      adapterCache.set(normalizedPath, await loadLocalAdapterModule(normalizedPath, 'adapterModule'));
    }

    return adapterCache.get(normalizedPath);
  }

  const commandAdapter = await resolveModuleAdapter(commandAdapterModule);

  if (dbPath) {
    await initializeAgentStore({ dbPath });
    const agentStore = getAgentStore({ dbPath });
    const agents = agentStore.listAgents({ limit: 1000 });

    for (const agent of agents) {
      if (getOptionalText(agent.adapterModule)) {
        await resolveModuleAdapter(agent.adapterModule);
      }
    }
  }

  return {
    ...options,
    resolveAgentAdapter(agent) {
      if (!agent) {
        return null;
      }

      if (commandAdapter) {
        if (requestedAgentId && agent.agentId === requestedAgentId) {
          return commandAdapter;
        }

        if (commandAdapterModule && agent.adapterModule && path.resolve(agent.adapterModule).toLowerCase() === path.resolve(commandAdapterModule).toLowerCase()) {
          return commandAdapter;
        }
      }

      const agentAdapterModule = getOptionalText(agent.adapterModule);
      if (!agentAdapterModule) {
        return null;
      }

      return adapterCache.get(agentAdapterModule) || null;
    }
  };
}

export function buildCoordinatorStateInput(args = {}) {
  const includeTestData = getOptionalBoolean(args.includeTestData, 'includeTestData');
  const includeHistory = getOptionalBoolean(args.includeHistory, 'includeHistory');

  return {
    ...(getOptionalText(args.workflowId) ? { workflowId: getOptionalText(args.workflowId) } : {}),
    ...(getOptionalText(args.chainId) ? { chainId: getOptionalText(args.chainId) } : {}),
    ...(getOptionalText(args.taskId) ? { taskId: getOptionalText(args.taskId) } : {}),
    ...(getOptionalText(args.stageId) ? { stageId: getOptionalText(args.stageId) } : {}),
    ...(includeTestData == null ? {} : { includeTestData }),
    ...(includeHistory == null ? {} : { includeHistory }),
    agentQuery: buildAgentQuery(args),
    assignmentQuery: buildAssignmentQuery(args),
    handoffQuery: buildHandoffQuery(args),
    chainQuery: buildChainStateQuery(args)
  };
}

export function buildCoordinatorAssignmentInput(args = {}) {
  const targetType = getOptionalText(args.targetType);

  return {
    ...(targetType ? { targetType } : {}),
    ...(getOptionalText(args.workflowId) ? { workflowId: getOptionalText(args.workflowId) } : {}),
    ...(getOptionalText(args.chainId) ? { chainId: getOptionalText(args.chainId) } : {}),
    ...(getOptionalText(args.taskId) ? { taskId: getOptionalText(args.taskId) } : {}),
    ...(getOptionalText(args.stageId) ? { stageId: getOptionalText(args.stageId) } : {}),
    ...(getOptionalText(args.agentId) ? { agentId: getOptionalText(args.agentId) } : {}),
    ...(getOptionalText(args.reason) ? { reason: getOptionalText(args.reason) } : {})
  };
}

export function buildCoordinatorExecutionInput(args = {}) {
  const assignmentInput = buildCoordinatorAssignmentInput(args);
  const assignmentId = getOptionalText(args.assignmentId);
  const maxStages = getOptionalNumber(args.maxStages, 'maxStages');
  const maxWorkflowSteps = getOptionalNumber(args.maxWorkflowSteps, 'maxWorkflowSteps');
  const maxTaskRetries = getOptionalNumber(args.maxTaskRetries, 'maxTaskRetries');
  const taskExecutionTimeoutMs = getOptionalNumber(args.taskExecutionTimeoutMs, 'taskExecutionTimeoutMs');

  return {
    ...(assignmentId ? { assignmentId } : {}),
    ...assignmentInput,
    ...(maxStages == null ? {} : { maxStages }),
    ...(maxWorkflowSteps == null ? {} : { maxWorkflowSteps }),
    ...(maxTaskRetries == null ? {} : { maxTaskRetries }),
    ...(taskExecutionTimeoutMs == null ? {} : { taskExecutionTimeoutMs })
  };
}

export function buildCoordinatorResumeInput(args = {}) {
  const targetType = getOptionalText(args.targetType);
  const mode = getOptionalText(args.mode);
  const runNow = getOptionalBoolean(args.runNow, 'runNow');
  const maxStages = getOptionalNumber(args.maxStages, 'maxStages');
  const maxWorkflowSteps = getOptionalNumber(args.maxWorkflowSteps, 'maxWorkflowSteps');
  const maxTaskRetries = getOptionalNumber(args.maxTaskRetries, 'maxTaskRetries');
  const taskExecutionTimeoutMs = getOptionalNumber(args.taskExecutionTimeoutMs, 'taskExecutionTimeoutMs');

  return {
    ...(getOptionalText(args.assignmentId) ? { assignmentId: getOptionalText(args.assignmentId) } : {}),
    ...(targetType ? { targetType } : {}),
    ...(getOptionalText(args.workflowId) ? { workflowId: getOptionalText(args.workflowId) } : {}),
    ...(getOptionalText(args.chainId) ? { chainId: getOptionalText(args.chainId) } : {}),
    ...(getOptionalText(args.taskId) ? { taskId: getOptionalText(args.taskId) } : {}),
    ...(getOptionalText(args.stageId) ? { stageId: getOptionalText(args.stageId) } : {}),
    ...(getOptionalText(args.agentId) ? { agentId: getOptionalText(args.agentId) } : {}),
    ...(mode ? { mode } : {}),
    ...(runNow == null ? {} : { runNow }),
    ...(getOptionalText(args.message) ? { message: getOptionalText(args.message) } : {}),
    ...(args.payload == null ? {} : { payload: getOptionalObject(args.payload, 'payload') }),
    ...(getOptionalText(args.reason) ? { reason: getOptionalText(args.reason) } : {}),
    ...(maxStages == null ? {} : { maxStages }),
    ...(maxWorkflowSteps == null ? {} : { maxWorkflowSteps }),
    ...(maxTaskRetries == null ? {} : { maxTaskRetries }),
    ...(taskExecutionTimeoutMs == null ? {} : { taskExecutionTimeoutMs })
  };
}

export async function loadLocalAdapterModule(modulePath, label = 'adapterModule') {
  const value = await loadLocalModuleValue(modulePath, label);
  if (value === undefined) {
    return undefined;
  }

  if (value && typeof value === 'object' && typeof value.run === 'function') {
    return value;
  }

  if (typeof value === 'function') {
    return value;
  }

  throw new Error(`${label} must export a function or an object with a run() method.`);
}

async function loadLocalModuleValue(modulePath, label) {
  const normalizedModulePath = getOptionalText(modulePath);
  if (!normalizedModulePath) {
    return undefined;
  }

  const resolvedPath = path.resolve(normalizedModulePath);
  const cwd = process.cwd();

  if (!resolvedPath.startsWith(cwd + path.sep) && resolvedPath !== cwd) {
    throw new Error(`${label} path must be within the current working directory.`);
  }

  try {
    await fs.access(resolvedPath);
  } catch {
    throw new Error(`${label} not found: ${resolvedPath}`);
  }

  const imported = await import(pathToFileURL(resolvedPath).href);
  return imported?.default ?? imported;
}

function buildChainStateQuery(args = {}) {
  const includeRunLogs = getOptionalBoolean(args.includeRunLogs, 'includeRunLogs');
  const limit = getOptionalNumber(args.limit, 'limit');
  const offset = getOptionalNumber(args.offset, 'offset');

  return {
    ...(includeRunLogs == null ? {} : { includeRunLogs }),
    ...(limit == null ? {} : { limit }),
    ...(offset == null ? {} : { offset })
  };
}

function buildAgentQuery(args = {}) {
  const role = getOptionalText(args.role);
  const status = getOptionalText(args.status);
  const limit = getOptionalNumber(args.limit, 'limit');

  return {
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
    ...(limit == null ? {} : { limit })
  };
}

function buildAssignmentQuery(args = {}) {
  const targetType = getOptionalText(args.assignmentTargetType) || getOptionalText(args.targetType) || inferTargetTypeFromArgs(args);
  const targetId = getOptionalText(args.assignmentTargetId) || getOptionalText(args.targetId) || inferTargetIdFromArgs(args, targetType);
  const status = getOptionalText(args.assignmentStatus);
  const agentId = getOptionalText(args.assignmentAgentId) || getOptionalText(args.agentId);
  const workflowId = getOptionalText(args.assignmentWorkflowId) || getOptionalText(args.workflowId);
  const chainId = getOptionalText(args.assignmentChainId) || getOptionalText(args.chainId);
  const stageId = getOptionalText(args.assignmentStageId) || getOptionalText(args.stageId);
  const limit = getOptionalNumber(args.assignmentLimit, 'assignmentLimit') ?? getOptionalNumber(args.limit, 'limit');

  return {
    ...(targetType ? { targetType } : {}),
    ...(targetId ? { targetId } : {}),
    ...(workflowId ? { workflowId } : {}),
    ...(chainId ? { chainId } : {}),
    ...(stageId ? { stageId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(status ? { status } : {}),
    ...(limit == null ? {} : { limit })
  };
}

function buildHandoffQuery(args = {}) {
  const sourceType = getOptionalText(args.sourceType) || inferTargetTypeFromArgs(args);
  const sourceId = getOptionalText(args.sourceId) || inferTargetIdFromArgs(args, sourceType);
  const workflowId = getOptionalText(args.handoffWorkflowId) || getOptionalText(args.workflowId);
  const chainId = getOptionalText(args.handoffChainId) || getOptionalText(args.chainId);
  const stageId = getOptionalText(args.handoffStageId) || getOptionalText(args.stageId);
  const toAgentId = getOptionalText(args.toAgentId);
  const fromAgentId = getOptionalText(args.fromAgentId);
  const status = getOptionalText(args.handoffStatus);
  const limit = getOptionalNumber(args.handoffLimit, 'handoffLimit') ?? getOptionalNumber(args.limit, 'limit');

  return {
    ...(sourceType ? { sourceType } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(workflowId ? { workflowId } : {}),
    ...(chainId ? { chainId } : {}),
    ...(stageId ? { stageId } : {}),
    ...(toAgentId ? { toAgentId } : {}),
    ...(fromAgentId ? { fromAgentId } : {}),
    ...(status ? { status } : {}),
    ...(limit == null ? {} : { limit })
  };
}

function inferTargetTypeFromArgs(args = {}) {
  if (getOptionalText(args.stageId)) {
    return 'stage';
  }

  if (getOptionalText(args.taskId)) {
    return 'task';
  }

  return null;
}

function inferTargetIdFromArgs(args = {}, targetType) {
  if (targetType === 'stage') {
    return getOptionalText(args.stageId);
  }

  if (targetType === 'task') {
    return getOptionalText(args.taskId);
  }

  return null;
}

function applyRunnerTimeoutRuntimeOptions(args = {}, options = {}) {
  const maxTaskRetries = getOptionalNumber(args.maxTaskRetries, 'maxTaskRetries');
  if (maxTaskRetries != null) {
    options.maxTaskRetries = maxTaskRetries;
  }

  const taskExecutionTimeoutMs = getOptionalNumber(args.taskExecutionTimeoutMs, 'taskExecutionTimeoutMs');
  if (taskExecutionTimeoutMs != null) {
    options.taskExecutionTimeoutMs = taskExecutionTimeoutMs;
  }

  const timeoutSweepMaxExecutionMs = getOptionalNumber(args.timeoutSweepMaxExecutionMs, 'timeoutSweepMaxExecutionMs');
  if (timeoutSweepMaxExecutionMs != null) {
    options.timeoutSweepMaxExecutionMs = timeoutSweepMaxExecutionMs;
  }

  const timeoutSweepStalledMs = getOptionalNumber(args.timeoutSweepStalledMs, 'timeoutSweepStalledMs');
  if (timeoutSweepStalledMs != null) {
    options.timeoutSweepStalledMs = timeoutSweepStalledMs;
  }

  const timeoutSweepMaxAttempts = getOptionalNumber(args.timeoutSweepMaxAttempts, 'timeoutSweepMaxAttempts');
  if (timeoutSweepMaxAttempts != null) {
    options.timeoutSweepMaxAttempts = timeoutSweepMaxAttempts;
  }

  const timeoutSweepIntervalMs = getOptionalNumber(args.timeoutSweepIntervalMs, 'timeoutSweepIntervalMs');
  if (timeoutSweepIntervalMs != null) {
    options.timeoutSweepIntervalMs = timeoutSweepIntervalMs;
  }

  const timeoutSweepReason = getOptionalText(args.timeoutSweepReason);
  if (timeoutSweepReason) {
    options.timeoutSweepReason = timeoutSweepReason;
  }

  return options;
}

function countItemsByStatus(items, allowedStatuses) {
  const counts = Object.fromEntries(allowedStatuses.map((status) => [status, 0]));

  for (const item of items) {
    if (item?.status != null && counts[item.status] != null) {
      counts[item.status] += 1;
    }
  }

  return counts;
}

function getOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function getOptionalNumber(value, label) {
  if (value == null || value === '') {
    return null;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${label} must be a number.`);
  }

  return number;
}

function getOptionalBoolean(value, label) {
  if (value == null || value === '') {
    return null;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`${label} must be a boolean.`);
}

function getOptionalObject(value, label) {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      throw new Error(`${label} must be a JSON object.`);
    }
    throw new Error(`${label} must be a JSON object.`);
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  throw new Error(`${label} must be an object.`);
}
